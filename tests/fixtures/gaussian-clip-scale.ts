import { filteredClipScene } from './gaussian-filtered-clip.ts';

export const clipScales = [2 ** -40, 2 ** -20, 2 ** -10, 1, 2 ** 10, 2 ** 40];
export const clipNormals = [[0, 0, -1], [1, 0, 0], [.6, 0, -.8]];

/** Change world units while retaining the same projected Gaussian and clipping plane. */
export function clipScaleScene(scale: number, normal: number[], filterVariance: number) {
  const scene = filteredClipScene(filterVariance, normal, 2 * normal[2] - .0625);
  scene.centers = scene.centers.map(value => value * scale);
  scene.covariances = scene.covariances.map(value => value * scale * scale);
  scene.camera.near *= scale;
  scene.camera.far *= scale;
  scene.clipPlane!.offset *= scale;
  return scene;
}
