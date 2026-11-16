import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_filtered_halfspace_clip_coefficients } from '../pkg/three_wasm_rust.js';
import { prepareGaussianRaster } from '../web/engine/gaussian.ts';
import { clipNormals, clipScales, clipScaleScene } from './fixtures/gaussian-clip-scale.ts';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('clip coefficients preserve world-unit changes, including a degenerate screen-aligned plane', () => {
  const coefficients = (scale: number, normal: number[], filter: number) => {
    const scene = clipScaleScene(scale, normal, filter);
    return gaussian_filtered_halfspace_clip_coefficients(scene.centers, scene.covariances,
      scene.camera.focalX, scene.camera.focalY, scene.clipPlane!.normal, scene.clipPlane!.offset, filter);
  };
  for (const normal of clipNormals) for (const filter of [0, .25, 1]) {
    const reference = coefficients(1, normal, filter);
    for (const scale of clipScales) {
      const actual = coefficients(scale, normal, filter);
      assert.ok(actual.every(Number.isFinite));
      assert.deepEqual(actual, reference, JSON.stringify({ scale, normal, filter }));
    }
  }
  // The z marginal keeps Phi(-0.5), independent of world units and screen blur.
  for (const scale of clipScales) assert.deepEqual(Array.from(coefficients(scale, [0, 0, -1], 0)), [0, 0, -.5]);
});

test('prepared clipping preserves the projected view under a change of world units', () => {
  for (const normal of clipNormals) for (const filter of [0, .25, 1]) {
    const reference = prepareGaussianRaster(clipScaleScene(1, normal, filter));
    for (const scale of clipScales) {
      const actual = prepareGaussianRaster(clipScaleScene(scale, normal, filter));
      assert.deepEqual({ ...actual, depths: undefined }, { ...reference, depths: undefined });
      assert.equal(actual.depths[0], reference.depths[0] * scale);
    }
  }
});
