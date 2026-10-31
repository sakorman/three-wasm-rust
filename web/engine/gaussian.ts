import {
  gaussian_clip_depth_support_indices,
  gaussian_depth_order,
  gaussian_filter_screen_covariances,
  gaussian_halfspace_clip_coefficients,
  gaussian_project_covariances,
  gaussian_screen_bounds,
  gaussian_tile_bins,
  gaussian_viewport_indices,
  gaussian_visible_indices,
} from '../../pkg/three_wasm_rust.js';
import { copyGaussianRasterTiles } from './gaussianTiles.ts';

export interface GaussianRasterCamera {
  focalX: number;
  focalY: number;
  principalX: number;
  principalY: number;
  near: number;
  far: number;
  width: number;
  height: number;
}

export interface GaussianClipPlane {
  normal: Float32Array;
  offset: number;
}

export interface GaussianRasterPreparationOptions {
  centers: Float32Array;
  covariances: Float32Array;
  opacities: Float32Array;
  /** Optional non-negative linear RGB triples aligned with `centers`. Defaults to white. */
  colors?: Float32Array;
  cutoff: number;
  camera: GaussianRasterCamera;
  filterVariance?: number;
  clipPlane?: GaussianClipPlane;
  tileSize?: number;
}

export interface GaussianRasterTiles {
  tileSize: number;
  columns: number;
  rows: number;
  /** Offset table followed by local IDs, unique within each tile but reusable across tiles. */
  packed: Uint32Array;
}

export interface PreparedGaussianRaster {
  /** Original source IDs, ordered from far to near. */
  originalIds: Uint32Array;
  screenCenters: Float32Array;
  screenCovariances: Float32Array;
  opacities: Float32Array;
  /** Non-negative linear RGB triples aligned with `originalIds`. */
  colors: Float32Array;
  depths: Float32Array;
  halfExtents: Float32Array;
  /** Optional `[kx, ky, h]` clip coefficients aligned with `originalIds`. */
  clipCoefficients?: Float32Array;
  tiles?: GaussianRasterTiles;
}

/** Number of f32 values in one GPU-ready Gaussian vertex record. */
export const GAUSSIAN_RASTER_UPLOAD_STRIDE = 15;

export interface PackedGaussianRasterUpload {
  /**
   * Per-Gaussian f32 records:
   * `[centerX, centerY, halfWidth, halfHeight, conicXX, conicXY, conicYY,
   *   opacity, clipX, clipY, clipH, clipEnabled, red, green, blue]`.
   */
  splatData: Float32Array;
  /** Source IDs aligned with `splatData` records. */
  originalIds: Uint32Array;
  /** Independent tile data whose references index `splatData` records. */
  tiles?: GaussianRasterTiles;
}

function gather(values: Float32Array, stride: number, indices: Uint32Array): Float32Array {
  const result = new Float32Array(indices.length * stride);
  for (let output = 0; output < indices.length; output++) {
    const inputOffset = indices[output] * stride;
    result.set(values.subarray(inputOffset, inputOffset + stride), output * stride);
  }
  return result;
}

function localIndices(length: number): Uint32Array {
  return Uint32Array.from({ length }, (_, index) => index);
}

function checkInputShape({ centers, covariances, opacities, colors }: GaussianRasterPreparationOptions): void {
  if (centers.length % 3 !== 0 || covariances.length !== centers.length * 2 || opacities.length !== centers.length / 3) {
    throw new Error('Gaussian centers, covariances and opacities must have matching xyz, six-value and scalar lengths');
  }
  if (colors && colors.length !== centers.length) throw new Error('Gaussian colors must use one RGB triple per center');
}

function checkedColors(colors: Float32Array | undefined, length: number): Float32Array {
  if (!colors) return new Float32Array(length).fill(1);
  for (let index = 0; index < colors.length; index++) {
    if (!Number.isFinite(colors[index]) || colors[index] < 0) {
      throw new Error(`Gaussian color must be finite and non-negative at component ${index}`);
    }
  }
  return colors;
}

function checkTileSize(tileSize: number | undefined, camera: GaussianRasterCamera): void {
  if (tileSize === undefined) return;
  if (!Number.isSafeInteger(tileSize) || tileSize <= 0) throw new Error('Gaussian tile size must be a positive safe integer');
  if (!Number.isSafeInteger(camera.width) || !Number.isSafeInteger(camera.height) || camera.width <= 0 || camera.height <= 0) {
    throw new Error('Gaussian tiled preparation requires positive integer viewport dimensions');
  }
}

function checkFinite(value: number, label: string, index: number): void {
  if (!Number.isFinite(value)) throw new Error(`Gaussian ${label} must be finite at index ${index}`);
}

function finiteF32(value: number, label: string, index: number): number {
  checkFinite(value, label, index);
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new Error(`Gaussian ${label} exceeds f32 range at index ${index}`);
  return rounded;
}

/**
 * Prepare one camera view for a Gaussian raster pass without allocating GPU resources.
 *
 * The returned arrays use one compact local order. `originalIds` maps that order back
 * to source attributes, and tile references index the compact arrays rather than the
 * source arrays. Call `init()` before this function so the WASM exports are ready.
 */
export function prepareGaussianRaster(options: GaussianRasterPreparationOptions): PreparedGaussianRaster {
  checkInputShape(options);
  checkTileSize(options.tileSize, options.camera);
  const { centers, covariances, opacities, cutoff, camera, clipPlane } = options;
  const colors = checkedColors(options.colors, centers.length);
  const filterVariance = options.filterVariance ?? 0;
  const visible = gaussian_visible_indices(opacities, cutoff);
  const supported = gaussian_clip_depth_support_indices(
    centers, covariances, opacities, visible, cutoff, camera.near, camera.far,
  );
  const candidateCenters = gather(centers, 3, supported);
  const candidateCovariances = gather(covariances, 6, supported);
  const candidateOpacities = gather(opacities, 1, supported);
  const projected = gaussian_project_covariances(
    candidateCenters, candidateCovariances,
    camera.focalX, camera.focalY, camera.principalX, camera.principalY,
  );
  const screenCenters = new Float32Array(supported.length * 2);
  const depths = new Float32Array(supported.length);
  const screenCovariances = new Float32Array(supported.length * 3);
  for (let index = 0; index < supported.length; index++) {
    const projectedOffset = index * 6;
    screenCenters.set(projected.subarray(projectedOffset, projectedOffset + 2), index * 2);
    depths[index] = projected[projectedOffset + 2];
    screenCovariances.set(projected.subarray(projectedOffset + 3, projectedOffset + 6), index * 3);
  }
  const filtered = gaussian_filter_screen_covariances(screenCovariances, candidateOpacities, filterVariance);
  const filteredCovariances = new Float32Array(supported.length * 3);
  const filteredOpacities = new Float32Array(supported.length);
  for (let index = 0; index < supported.length; index++) {
    const filteredOffset = index * 4;
    filteredCovariances.set(filtered.subarray(filteredOffset, filteredOffset + 3), index * 3);
    filteredOpacities[index] = filtered[filteredOffset + 3];
  }
  const halfExtents = gaussian_screen_bounds(filteredCovariances, filteredOpacities, cutoff);
  const viewport = gaussian_viewport_indices(
    screenCenters, halfExtents, localIndices(supported.length), camera.width, camera.height,
  );
  const order = gaussian_depth_order(depths, viewport);
  const clipCoefficients = clipPlane
    ? gaussian_halfspace_clip_coefficients(
      candidateCenters, candidateCovariances, camera.focalX, camera.focalY, clipPlane.normal, clipPlane.offset,
    )
    : undefined;
  const prepared: PreparedGaussianRaster = {
    originalIds: Uint32Array.from(order, index => supported[index]),
    screenCenters: gather(screenCenters, 2, order),
    screenCovariances: gather(filteredCovariances, 3, order),
    opacities: gather(filteredOpacities, 1, order),
    colors: gather(colors, 3, order),
    depths: gather(depths, 1, order),
    halfExtents: gather(halfExtents, 2, order),
    ...(clipCoefficients && { clipCoefficients: gather(clipCoefficients, 3, order) }),
  };
  if (options.tileSize !== undefined) {
    const columns = Math.ceil(camera.width / options.tileSize);
    const rows = Math.ceil(camera.height / options.tileSize);
    prepared.tiles = {
      tileSize: options.tileSize,
      columns,
      rows,
      packed: gaussian_tile_bins(
        prepared.screenCenters, prepared.halfExtents, localIndices(prepared.originalIds.length),
        camera.width, camera.height, options.tileSize,
      ),
    };
  }
  return prepared;
}

/**
 * Convert compact prepared arrays into one interleaved buffer for a Gaussian draw pass.
 *
 * The inverse screen covariance is computed from the f32 covariance returned by
 * preparation and must remain positive definite after f32 rounding. Every output is copied
 * so later source edits cannot change an upload already queued for WebGL.
 */
export function packGaussianRasterUpload(prepared: PreparedGaussianRaster): PackedGaussianRasterUpload {
  const count = prepared.originalIds.length;
  if (prepared.screenCenters.length !== count * 2 || prepared.screenCovariances.length !== count * 3
    || prepared.opacities.length !== count || prepared.colors.length !== count * 3
    || prepared.depths.length !== count || prepared.halfExtents.length !== count * 2) {
    throw new Error('Prepared Gaussian arrays have inconsistent lengths');
  }
  const clipCoefficients = prepared.clipCoefficients;
  if (clipCoefficients && clipCoefficients.length !== count * 3) throw new Error('Prepared Gaussian clip coefficients have inconsistent length');
  const result = new Float32Array(count * GAUSSIAN_RASTER_UPLOAD_STRIDE);
  const seenOriginalIds = new Set<number>();
  for (let index = 0; index < count; index++) {
    const sourceId = prepared.originalIds[index];
    if (seenOriginalIds.has(sourceId)) throw new Error('Prepared Gaussian original IDs must be unique');
    seenOriginalIds.add(sourceId);
    const centerOffset = index * 2, covarianceOffset = index * 3, record = index * GAUSSIAN_RASTER_UPLOAD_STRIDE;
    const centerX = prepared.screenCenters[centerOffset], centerY = prepared.screenCenters[centerOffset + 1];
    const halfWidth = prepared.halfExtents[centerOffset], halfHeight = prepared.halfExtents[centerOffset + 1];
    const xx = prepared.screenCovariances[covarianceOffset], xy = prepared.screenCovariances[covarianceOffset + 1], yy = prepared.screenCovariances[covarianceOffset + 2];
    const opacity = prepared.opacities[index], depth = prepared.depths[index];
    checkFinite(centerX, 'screen center', index); checkFinite(centerY, 'screen center', index);
    checkFinite(halfWidth, 'half extent', index); checkFinite(halfHeight, 'half extent', index);
    checkFinite(opacity, 'opacity', index); checkFinite(depth, 'depth', index);
    if (halfWidth < 0 || halfHeight < 0 || opacity < 0 || opacity > 1) throw new Error(`Invalid prepared Gaussian extent or opacity at index ${index}`);
    const determinant = xx * yy - xy * xy;
    if (!Number.isFinite(determinant) || xx <= 0 || yy <= 0 || determinant <= 0) {
      throw new Error(`Prepared Gaussian covariance is not positive definite at index ${index}`);
    }
    const conicXX = finiteF32(yy / determinant, 'conic', index);
    const conicXY = finiteF32(-xy / determinant, 'conic', index);
    const conicYY = finiteF32(xx / determinant, 'conic', index);
    if (conicXX <= 0 || conicYY <= 0 || conicXX * conicYY - conicXY * conicXY <= 0) {
      throw new Error(`Gaussian conic is not positive definite after f32 rounding at index ${index}`);
    }
    result.set([centerX, centerY, halfWidth, halfHeight, conicXX, conicXY, conicYY, opacity], record);
    if (clipCoefficients) {
      const clipOffset = index * 3;
      const clipX = clipCoefficients[clipOffset], clipY = clipCoefficients[clipOffset + 1], clipH = clipCoefficients[clipOffset + 2];
      checkFinite(clipX, 'clip coefficient', index); checkFinite(clipY, 'clip coefficient', index); checkFinite(clipH, 'clip coefficient', index);
      result.set([clipX, clipY, clipH, 1], record + 8);
    }
    const colorOffset = index * 3;
    const red = finiteF32(prepared.colors[colorOffset], 'color', index);
    const green = finiteF32(prepared.colors[colorOffset + 1], 'color', index);
    const blue = finiteF32(prepared.colors[colorOffset + 2], 'color', index);
    if (red < 0 || green < 0 || blue < 0) throw new Error(`Gaussian color must be non-negative at index ${index}`);
    result.set([red, green, blue], record + 12);
  }
  return {
    splatData: result,
    originalIds: prepared.originalIds.slice(),
    ...(prepared.tiles && { tiles: copyGaussianRasterTiles(prepared.tiles, count) }),
  };
}
