import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_halfspace_clip_coefficients } from '../pkg/three_wasm_rust.js';
import { prepareGaussianRaster, packGaussianRasterUpload } from '../web/engine/index.ts';
import { clipCullingScene } from './fixtures/gaussian-clip-culling.ts';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('clip preparation excludes offscreen coefficients and preserves compact source order', () => {
  const input = clipCullingScene(), saved = input.centers.slice();
  assert.deepEqual([...prepareGaussianRaster({ ...input, clipPlane: undefined }).originalIds], [3, 1]);
  // The standalone helper still rejects an unrepresentable coefficient; only invisible work is skipped.
  assert.throws(() => gaussian_halfspace_clip_coefficients(input.centers, input.covariances, 32, 32,
    input.clipPlane!.normal, 0), /clip coefficient exceeds f32 range/);
  const actual = prepareGaussianRaster(input), reference = prepareGaussianRaster(clipCullingScene([3, 1]));
  assert.deepEqual([...actual.originalIds], [3, 1]);
  assert.deepEqual(actual.clipCoefficients, reference.clipCoefficients);
  assert.deepEqual(packGaussianRasterUpload(actual).splatData, packGaussianRasterUpload(reference).splatData);
  assert.deepEqual(actual.tiles, reference.tiles);
  assert.deepEqual(input.centers, saved);
});

test('empty clipped views still validate planes and all source geometry', () => {
  const input = clipCullingScene([0, 2]);
  const empty = prepareGaussianRaster(input);
  assert.equal(empty.originalIds.length, 0);
  assert.equal(empty.clipCoefficients?.length, 0);
  assert.equal(packGaussianRasterUpload(empty).splatData.length, 0);
  for (const normal of [new Float32Array(3), new Float32Array([NaN, 0, 1]), new Float32Array(2)]) {
    assert.throws(() => prepareGaussianRaster({ ...input, clipPlane: { normal, offset: 0 } }), /plane/);
  }
  assert.throws(() => prepareGaussianRaster({ ...input, clipPlane: { normal: new Float32Array([1, 0, 0]), offset: Infinity } }), /plane/);
  input.covariances[0] = -1;
  assert.throws(() => prepareGaussianRaster(input), /covariance/);
  const visible = clipCullingScene([1]);
  visible.clipPlane!.offset = 3e38;
  assert.throws(() => prepareGaussianRaster(visible), /clip coefficient exceeds f32 range/);
});
