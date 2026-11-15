import type { GaussianRasterPreparationOptions } from '../../web/engine/gaussian.ts';

export function filteredClipScene(filterVariance: number, normal = [1, 0, 0], offset = .0625): GaussianRasterPreparationOptions {
  return {
    centers: new Float32Array([0, 0, 2]),
    covariances: new Float32Array([1 / 64, 0, 0, 1 / 64, 0, 1 / 64]),
    opacities: new Float32Array([.8]), cutoff: .001, filterVariance, tileSize: 8,
    camera: { focalX: 16, focalY: 16, principalX: 16.5, principalY: 16.5, near: .1, far: 10, width: 32, height: 32 },
    clipPlane: { normal: new Float32Array(normal), offset },
  };
}

function integrate(fn: (x: number) => number, lower: number, upper: number): number {
  const count = 512, step = (upper - lower) / count;
  let sum = fn(lower) + fn(upper);
  for (let i = 1; i < count; i++) sum += (i % 2 ? 4 : 2) * fn(lower + i * step);
  return sum * step / 3;
}

export function normalCdf(value: number): number {
  if (value <= -10) return 0;
  if (value >= 10) return 1;
  return integrate(x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI), -12, value);
}

/** Integrate the clipped unit screen Gaussian against a normalized blur kernel.
 * The tangent integral is separable; the normal integral is numerical, with no CDF coefficients.
 */
export function filteredClipReference(dx: number, dy: number, variance: number, normal: Float32Array, offset: number): number {
  const length = Math.hypot(normal[0], normal[1]);
  const nx = normal[0] / length, ny = normal[1] / length;
  const a = nx * dx + ny * dy, b = -ny * dx + nx * dy, limit = 8 * offset / length;
  const opacity = Math.fround(.8);
  if (variance === 0) return opacity * Math.exp(-(a * a + b * b) / 2) * (a < limit ? 1 : a > limit ? 0 : .5);
  const alongNormal = integrate(u => Math.exp(-u * u / 2 - (a - u) ** 2 / (2 * variance))
    / Math.sqrt(2 * Math.PI * variance), -12, limit);
  return opacity * alongNormal * Math.exp(-b * b / (2 * (1 + variance))) / Math.sqrt(1 + variance);
}
