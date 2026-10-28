import { GAUSSIAN_RASTER_UPLOAD_STRIDE } from './gaussian.ts';
import type { PackedGaussianRasterUpload, GaussianRasterTiles } from './gaussian.ts';
import type { ContextLifecycle } from './ContextLifecycle.ts';

export interface GaussianUploadBufferSnapshot {
  recordCount: number;
  splatBuffer: WebGLBuffer;
  splatBytes: number;
  splatCapacityBytes: number;
  tileBuffer?: WebGLBuffer;
  tileBytes: number;
  tileCapacityBytes: number;
}

export interface GaussianUploadTileLayout {
  tileSize: number;
  columns: number;
  rows: number;
  referenceCount: number;
}

function cloneTiles(tiles: GaussianRasterTiles, recordCount: number): GaussianRasterTiles {
  if (!Number.isSafeInteger(tiles.tileSize) || tiles.tileSize <= 0
    || !Number.isSafeInteger(tiles.columns) || tiles.columns <= 0
    || !Number.isSafeInteger(tiles.rows) || tiles.rows <= 0) {
    throw new Error('Gaussian tile metadata must use positive safe integers');
  }
  const tileCount = tiles.columns * tiles.rows;
  if (!Number.isSafeInteger(tileCount) || tiles.packed.length < tileCount + 1 || tiles.packed[0] !== 0) {
    throw new Error('Gaussian tile offsets are malformed');
  }
  const referenceStart = tileCount + 1;
  const referenceCount = tiles.packed.length - referenceStart;
  if (tiles.packed[tileCount] !== referenceCount) throw new Error('Gaussian tile offsets must end at the reference count');
  for (let index = 0; index < tileCount; index++) {
    if (tiles.packed[index] > tiles.packed[index + 1]) throw new Error('Gaussian tile offsets must be monotonic');
  }
  for (let index = referenceStart; index < tiles.packed.length; index++) {
    if (tiles.packed[index] >= recordCount) throw new Error('Gaussian tile reference is out of range');
  }
  return { tileSize: tiles.tileSize, columns: tiles.columns, rows: tiles.rows, packed: tiles.packed.slice() };
}

function cloneUpload(upload: PackedGaussianRasterUpload): PackedGaussianRasterUpload {
  const recordCount = upload.originalIds.length;
  if (upload.splatData.length !== recordCount * GAUSSIAN_RASTER_UPLOAD_STRIDE) {
    throw new Error('Gaussian upload records have inconsistent lengths');
  }
  const seenOriginalIds = new Set<number>();
  for (let index = 0; index < recordCount; index++) {
    const record = index * GAUSSIAN_RASTER_UPLOAD_STRIDE;
    const originalId = upload.originalIds[index];
    if (seenOriginalIds.has(originalId)) throw new Error('Gaussian upload original IDs must be unique');
    seenOriginalIds.add(originalId);
    for (let component = 0; component < GAUSSIAN_RASTER_UPLOAD_STRIDE; component++) {
      if (!Number.isFinite(upload.splatData[record + component])) {
        throw new Error(`Gaussian upload data must be finite at record ${index}`);
      }
    }
    const halfWidth = upload.splatData[record + 2], halfHeight = upload.splatData[record + 3];
    const conicXX = upload.splatData[record + 4], conicXY = upload.splatData[record + 5], conicYY = upload.splatData[record + 6];
    const opacity = upload.splatData[record + 7], clipEnabled = upload.splatData[record + 11];
    if (halfWidth < 0 || halfHeight < 0 || opacity < 0 || opacity > 1) {
      throw new Error(`Gaussian upload extent or opacity is invalid at record ${index}`);
    }
    if (conicXX <= 0 || conicYY <= 0 || conicXX * conicYY - conicXY * conicXY <= 0) {
      throw new Error(`Gaussian upload conic is not positive definite at record ${index}`);
    }
    if (clipEnabled !== 0 && clipEnabled !== 1) throw new Error(`Gaussian upload clip flag is invalid at record ${index}`);
  }
  return {
    splatData: upload.splatData.slice(),
    originalIds: upload.originalIds.slice(),
    ...(upload.tiles && { tiles: cloneTiles(upload.tiles, recordCount) }),
  };
}

/**
 * Owns reusable WebGL buffers for one prepared Gaussian view.
 *
 * CPU data is copied so a WebGL context restore can recreate handles without relying on
 * caller-owned arrays. This class only uploads buffers; shaders, VAOs and draw calls stay
 * with the renderer that consumes the snapshot.
 */
export class GaussianUploadBuffers {
  private source: PackedGaussianRasterUpload | undefined;
  private splatBuffer: WebGLBuffer | undefined;
  private tileBuffer: WebGLBuffer | undefined;
  private splatCapacityBytes = 0;
  private tileCapacityBytes = 0;
  private currentError: unknown;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly context: ContextLifecycle,
  ) {
    if (context.gl !== gl) throw new Error('Gaussian upload buffers require the lifecycle WebGL context');
    this.unsubscribe = context.subscribe(() => this.onContextStateChange());
  }

  get error(): unknown {
    return this.currentError;
  }

  get recordCount(): number {
    return this.source?.originalIds.length ?? 0;
  }

  /** Store a checked copy and upload immediately when the WebGL context is available. */
  update(upload: PackedGaussianRasterUpload): void {
    if (this.disposed || this.context.state === 'disposed') throw new Error('Gaussian upload buffers are disposed');
    this.source = cloneUpload(upload);
    this.currentError = undefined;
    if (this.context.ready) {
      try {
        this.createOrUpdate();
      } catch (error) {
        this.currentError = error;
        this.deleteHandles();
        throw error;
      }
    }
  }

  /** Current GPU handles. Returns undefined while lost, failed, empty or disposed. */
  snapshot(): GaussianUploadBufferSnapshot | undefined {
    if (!this.context.ready || this.currentError || !this.source || !this.splatBuffer) return undefined;
    return {
      recordCount: this.source.originalIds.length,
      splatBuffer: this.splatBuffer,
      splatBytes: this.source.splatData.byteLength,
      splatCapacityBytes: this.splatCapacityBytes,
      ...(this.tileBuffer && { tileBuffer: this.tileBuffer }),
      tileBytes: this.source.tiles?.packed.byteLength ?? 0,
      tileCapacityBytes: this.tileCapacityBytes,
    };
  }

  /** Tile metadata without exposing the internal offset/reference array. */
  tileLayout(): GaussianUploadTileLayout | undefined {
    const tiles = this.source?.tiles;
    if (!tiles) return undefined;
    const tileCount = tiles.columns * tiles.rows;
    return {
      tileSize: tiles.tileSize,
      columns: tiles.columns,
      rows: tiles.rows,
      referenceCount: tiles.packed.length - tileCount - 1,
    };
  }

  /** Iterates local IDs in their stored row-major tile order without sharing CPU storage. */
  forEachTileReference(callback: (column: number, row: number, tileSize: number, localId: number) => void): void {
    const tiles = this.source?.tiles;
    if (!tiles) throw new Error('Gaussian upload has no tile data');
    const tileCount = tiles.columns * tiles.rows;
    const referenceStart = tileCount + 1;
    for (let tile = 0; tile < tileCount; tile++) {
      const column = tile % tiles.columns, row = Math.floor(tile / tiles.columns);
      for (let reference = tiles.packed[tile]; reference < tiles.packed[tile + 1]; reference++) {
        callback(column, row, tiles.tileSize, tiles.packed[referenceStart + reference]);
      }
    }
  }

  private readonly onContextStateChange = (): void => {
    if (this.disposed || !this.context.ready) {
      this.clearHandles();
      return;
    }
    if (!this.source) return;
    try {
      this.createOrUpdate();
      this.currentError = undefined;
    } catch (error) {
      this.currentError = error;
      this.deleteHandles();
    }
  };

  private createOrUpdate(): void {
    this.context.assertReady();
    const previousArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const previousElementBuffer = this.gl.getParameter(this.gl.ELEMENT_ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    try {
      if (!this.source) return;
      this.splatBuffer ??= this.allocateBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.splatBuffer);
      this.splatCapacityBytes = this.upload(this.gl.ARRAY_BUFFER, this.source.splatData, this.splatCapacityBytes);
      if (this.source.tiles) {
        this.tileBuffer ??= this.allocateBuffer();
        this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.tileBuffer);
        this.tileCapacityBytes = this.upload(this.gl.ELEMENT_ARRAY_BUFFER, this.source.tiles.packed, this.tileCapacityBytes);
      } else if (this.tileBuffer) {
        this.gl.deleteBuffer(this.tileBuffer);
        this.tileBuffer = undefined;
        this.tileCapacityBytes = 0;
      }
    } finally {
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, previousArrayBuffer);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, previousElementBuffer);
    }
  }

  private allocateBuffer(): WebGLBuffer {
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error('Gaussian upload buffer allocation failed');
    return buffer;
  }

  private upload(target: number, data: Float32Array | Uint32Array, capacityBytes: number): number {
    let expectedCapacity = capacityBytes;
    if (data.byteLength > capacityBytes) {
      this.gl.bufferData(target, data, this.gl.DYNAMIC_DRAW);
      expectedCapacity = data.byteLength;
    } else if (capacityBytes === 0) {
      this.gl.bufferData(target, data.byteLength, this.gl.DYNAMIC_DRAW);
      expectedCapacity = 0;
    } else if (data.byteLength) {
      this.gl.bufferSubData(target, 0, data);
    }
    const actualCapacity = this.gl.getBufferParameter(target, this.gl.BUFFER_SIZE);
    if (!Number.isSafeInteger(actualCapacity) || actualCapacity !== expectedCapacity) {
      throw new Error('Gaussian upload buffer storage allocation failed');
    }
    return expectedCapacity;
  }

  private clearHandles(): void {
    this.splatBuffer = undefined;
    this.tileBuffer = undefined;
    this.splatCapacityBytes = 0;
    this.tileCapacityBytes = 0;
  }

  private deleteHandles(): void {
    if (!this.gl.isContextLost()) {
      if (this.splatBuffer) this.gl.deleteBuffer(this.splatBuffer);
      if (this.tileBuffer) this.gl.deleteBuffer(this.tileBuffer);
    }
    this.clearHandles();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.deleteHandles();
    this.source = undefined;
    this.currentError = undefined;
  }
}
