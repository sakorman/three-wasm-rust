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
  /** Offset table followed by local IDs into the other prepared arrays. */
  packed: Uint32Array;
}

export interface PreparedGaussianRaster {
  /** Original source IDs, ordered from far to near. */
  originalIds: Uint32Array;
  screenCenters: Float32Array;
  screenCovariances: Float32Array;
  opacities: Float32Array;
  depths: Float32Array;
  halfExtents: Float32Array;
  /** Optional `[kx, ky, h]` clip coefficients aligned with `originalIds`. */
  clipCoefficients?: Float32Array;
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

function checkInputShape({ centers, covariances, opacities }: GaussianRasterPreparationOptions): void {
  if (centers.length % 3 !== 0 || covariances.length !== centers.length * 2 || opacities.length !== centers.length / 3) {
    throw new Error('Gaussian centers, covariances and opacities must have matching xyz, six-value and scalar lengths');
  }
}

function checkTileSize(tileSize: number | undefined, camera: GaussianRasterCamera): void {
  if (tileSize === undefined) return;
  if (!Number.isSafeInteger(tileSize) || tileSize <= 0) throw new Error('Gaussian tile size must be a positive safe integer');
  if (!Number.isSafeInteger(camera.width) || !Number.isSafeInteger(camera.height) || camera.width <= 0 || camera.height <= 0) {
    throw new Error('Gaussian tiled preparation requires positive integer viewport dimensions');
  }
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
