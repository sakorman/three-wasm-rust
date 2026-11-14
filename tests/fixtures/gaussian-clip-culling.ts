import type { GaussianRasterPreparationOptions } from '../../web/engine/gaussian.ts';

/** Two visible splats interleaved with finite offscreen splats whose clip coefficients overflow. */
export function clipCullingScene(ids: number[] = [0, 1, 2, 3]): GaussianRasterPreparationOptions {
  const centers = [[1e35, 0, 2], [0, 0, 2], [-1e35, 0, 2], [.08, 0, 4]];
  const thin = [1e-32, 0, 0, 1e-32, 0, 1e-38], regular = [.04, 0, 0, .04, 0, .04];
  const covariances = [thin, regular, thin, regular];
  const colors = [[1, 0, 0], [0, 1, 0], [1, 0, 1], [0, 0, 1]];
  return {
    centers: new Float32Array(ids.flatMap(id => centers[id])),
    covariances: new Float32Array(ids.flatMap(id => covariances[id])),
    opacities: new Float32Array(ids.map(() => .5)),
    colors: new Float32Array(ids.flatMap(id => colors[id])),
    cutoff: .01, tileSize: 16,
    camera: { focalX: 32, focalY: 32, principalX: 16.5, principalY: 16.5, near: .1, far: 10, width: 32, height: 32 },
    clipPlane: { normal: new Float32Array([1, 0, 0]), offset: 0 },
  };
}
