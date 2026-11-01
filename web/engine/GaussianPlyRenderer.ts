import type { ContextLifecycle } from './ContextLifecycle.ts';
import { GaussianRasterRenderer } from './GaussianRasterRenderer.ts';
import { parseGaussianSplatPly, prepareGaussianPlyForThreeCamera } from './GaussianPly.ts';
import { packGaussianRasterUpload } from './gaussian.ts';
import type { GaussianPlySource, GaussianPlyThreeCameraOptions } from './GaussianPly.ts';
import type { GaussianUploadResourceStats } from './GaussianUploadBuffers.ts';

export interface GaussianPlyRenderOptions extends Omit<GaussianPlyThreeCameraOptions, 'source'> {
  /** Disable the prepared CDF clip without rebuilding the view. Defaults to true. */
  applyClip?: boolean;
}

export interface GaussianPlyFrameStats {
  /** True when this frame prepared and uploaded a new camera view. */
  viewUpdated: boolean;
  recordCount: number;
  /** Submitted splat references; tiled draws can submit one record more than once. */
  submittedReferences: number;
}

export interface GaussianPlyResourceStats {
  sourceCount: number;
  /** Decoded model attributes retained by this owner, excluding the original PLY bytes. */
  sourceBytes: number;
  upload: GaussianUploadResourceStats;
}

function viewKey(options: GaussianPlyRenderOptions): number[] {
  const { camera, modelToWorld, threeWorldToView, threeCameraWorldPosition, clipPlane, tileSize } = options;
  if (modelToWorld.length !== 16 || threeWorldToView.length !== 16 || threeCameraWorldPosition.length !== 3
    || (clipPlane && clipPlane.normal.length !== 3)) throw new Error('Gaussian PLY camera arrays have invalid lengths');
  if (!Number.isSafeInteger(camera.width) || camera.width <= 0 || !Number.isSafeInteger(camera.height) || camera.height <= 0) {
    throw new Error('Gaussian PLY viewport must use positive safe integers');
  }
  if (tileSize !== undefined && (!Number.isSafeInteger(tileSize) || tileSize <= 0)) {
    throw new Error('Gaussian PLY tile size must be a positive safe integer');
  }
  return [
    ...modelToWorld, ...threeWorldToView, ...threeCameraWorldPosition,
    camera.focalX, camera.focalY, camera.principalX, camera.principalY,
    camera.near, camera.far, camera.width, camera.height,
    options.cutoff, options.filterVariance ?? 0, tileSize ?? 0,
    ...(clipPlane ? [1, ...clipPlane.normal, clipPlane.offset] : [0]),
  ];
}

/** Own one decoded PLY and reuse its prepared GPU view while model/camera inputs are unchanged. */
export class GaussianPlyRenderer {
  private readonly raster: GaussianRasterRenderer;
  private source: GaussianPlySource | undefined;
  private key: number[] | undefined;
  private disposed = false;

  constructor(readonly gl: WebGL2RenderingContext, readonly context: ContextLifecycle) {
    this.raster = new GaussianRasterRenderer(gl, context);
  }

  get ready(): boolean {
    return !this.disposed && this.source !== undefined && this.raster.ready;
  }

  get error(): unknown {
    return this.raster.error;
  }

  /** Decode before replacing the active model. Invalid files leave the current view intact. */
  loadPly(buffer: ArrayBuffer): void {
    this.assertActive();
    const source = parseGaussianSplatPly(buffer);
    this.raster.clear();
    this.source = source;
    this.key = undefined;
  }

  /** Draw into the caller's target without clearing it or changing the loaded model. */
  render(options: GaussianPlyRenderOptions): GaussianPlyFrameStats {
    this.assertActive();
    this.context.assertReady();
    if (!this.source) throw new Error('Gaussian PLY model is not loaded');
    const key = viewKey(options);
    const previousKey = this.key;
    const viewUpdated = !previousKey || key.length !== previousKey.length
      || key.some((value, index) => value !== previousKey[index]) || !this.raster.snapshot();
    if (viewUpdated) {
      const upload = packGaussianRasterUpload(prepareGaussianPlyForThreeCamera({ ...options, source: this.source }));
      // A failed upload retains its new recovery copy. Never reuse the old key after it.
      this.key = undefined;
      this.raster.update(upload);
      this.key = key;
    }
    const draw = { width: options.camera.width, height: options.camera.height, cutoff: options.cutoff, applyClip: options.applyClip };
    const recordCount = this.raster.uploads.recordCount;
    let submittedReferences = recordCount;
    if (options.tileSize !== undefined) submittedReferences = this.raster.drawTiles(draw);
    else this.raster.draw(draw);
    return { viewUpdated, recordCount, submittedReferences };
  }

  resourceStats(): GaussianPlyResourceStats {
    const source = this.source;
    return {
      sourceCount: source?.opacities.length ?? 0,
      sourceBytes: source ? source.centers.byteLength + source.covariances.byteLength + source.opacities.byteLength
        + source.colors.byteLength + source.shCoefficients.byteLength : 0,
      upload: this.raster.resourceStats(),
    };
  }

  clear(): void {
    this.assertActive();
    this.raster.clear();
    this.source = undefined;
    this.key = undefined;
  }

  private assertActive(): void {
    if (this.disposed || this.context.state === 'disposed') throw new Error('Gaussian PLY renderer is disposed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.raster.dispose();
    this.source = undefined;
    this.key = undefined;
  }
}
