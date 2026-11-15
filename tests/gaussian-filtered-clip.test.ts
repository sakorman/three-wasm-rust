import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init from '../pkg/three_wasm_rust.js';
import { gaussian_filtered_halfspace_clip_coefficients, gaussian_halfspace_clip_coefficients, prepareGaussianRaster } from '../web/engine/index.ts';
import { filteredClipReference, filteredClipScene, normalCdf } from './fixtures/gaussian-filtered-clip.ts';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('zero filter preserves standalone clipping and invalid filter inputs are rejected', () => {
  const input = filteredClipScene(0), { normal, offset } = input.clipPlane!;
  const args = [input.centers, input.covariances, input.camera.focalX, input.camera.focalY, normal, offset] as const;
  const reference = gaussian_halfspace_clip_coefficients(...args);
  assert.deepEqual(gaussian_filtered_halfspace_clip_coefficients(...args, 0), reference);
  assert.deepEqual(prepareGaussianRaster(input).clipCoefficients, reference);
  for (const variance of [-1, NaN, Infinity]) assert.throws(() => gaussian_filtered_halfspace_clip_coefficients(...args, variance));
});

test('filtered clipping agrees with direct convolution of the restricted Gaussian', () => {
  for (const variance of [.25, 1, 4]) {
    for (const [normal, offset] of [[[1, 0, 0], .0625], [[0, -1, 0], -.125], [[.6, .8, 0], 0]] as const) {
      const input = filteredClipScene(variance, [...normal], offset), prepared = prepareGaussianRaster(input);
      const [kx, ky, h] = prepared.clipCoefficients!;
      for (const dx of [-2, -1, 0, 1, 2]) for (const dy of [-2, -1, 0, 1, 2]) {
        const alpha = prepared.opacities[0] * Math.exp(-(dx * dx + dy * dy) / (2 * prepared.screenCovariances[0]))
          * normalCdf(-kx * dx - ky * dy + h);
        const reference = filteredClipReference(dx, dy, variance, input.clipPlane!.normal, offset);
        assert.ok(Math.abs(alpha - reference) < 3e-6, JSON.stringify({ variance, normal, offset, dx, dy, alpha, reference }));
      }
    }
  }
});
