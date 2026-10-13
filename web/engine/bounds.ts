import type { EngineScene } from './types.ts';

/** Validate before allocating a canvas context or GPU resources. */
export function validateBounds(data: Pick<EngineScene, 'meshNodes' | 'radii' | 'centers'>): void {
  if (
    data.radii.length !== data.meshNodes.length ||
    data.radii.some((radius) => !Number.isFinite(radius) || radius < 0) ||
    (data.centers !== undefined &&
      (data.centers.length !== data.meshNodes.length * 3 ||
        data.centers.some((value) => !Number.isFinite(value))))
  )
    throw new Error('Invalid bounding spheres');
}
