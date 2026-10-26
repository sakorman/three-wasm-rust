import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_filter_screen_covariances, gaussian_screen_bounds } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

const relative = (actual: number, expected: number, tolerance = 2e-6) =>
  Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));

test('screen filter preserves zero variance and compensates a filtered covariance', () => {
  const covariance = new Float32Array([4, 1, 9]);
  const opacity = new Float32Array([0.5]);
  assert.deepEqual(Array.from(gaussian_filter_screen_covariances(covariance, opacity, 0)), [4, 1, 9, 0.5]);
  const filtered = gaussian_filter_screen_covariances(covariance, opacity, 1);
  assert.deepEqual(Array.from(filtered.slice(0, 3)), [5, 1, 10]);
  const before = opacity[0] * Math.sqrt(4 * 9 - 1);
  const after = filtered[3] * Math.sqrt(filtered[0] * filtered[2] - filtered[1] ** 2);
  assert.ok(filtered[3] < opacity[0]);
  assert.ok(relative(after, before));
  covariance.fill(0); opacity.fill(0);
  assert.deepEqual(Array.from(filtered), [5, 1, 10, filtered[3]]);
});

test('screen filter agrees with f32 output covariance and preserves determinant-weighted opacity', () => {
  const count = 4097;
  const covariance = new Float32Array(count * 3);
  const opacity = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const sx = 2 ** ((index % 9) - 4), sy = 2 ** ((index % 7) - 3);
    const l10 = (index % 5 - 2) * sy * .2;
    covariance.set([sx * sx, sx * l10, l10 * l10 + sy * sy], index * 3);
    opacity[index] = [0, .001, .05, .2, .75, 1][index % 6];
  }
  for (const variance of [0, Math.fround(2 ** -12), Math.fround(.3), 64]) {
    const filtered = gaussian_filter_screen_covariances(covariance, opacity, variance);
    for (let index = 0; index < count; index++) {
      const offset = index * 3, output = index * 4;
      const [xx, xy, yy] = covariance.slice(offset, offset + 3);
      const expectedXX = Math.fround(xx + variance), expectedYY = Math.fround(yy + variance);
      assert.equal(filtered[output], expectedXX);
      assert.equal(filtered[output + 1], xy);
      assert.equal(filtered[output + 2], expectedYY);
      const originalArea = Math.sqrt(xx * yy - xy * xy);
      const filteredArea = Math.sqrt(expectedXX * expectedYY - xy * xy);
      const expectedOpacity = Math.fround(opacity[index] * originalArea / filteredArea);
      assert.ok(relative(filtered[output + 3], expectedOpacity, 3e-7));
      assert.ok(filtered[output + 3] >= 0 && filtered[output + 3] <= opacity[index]);
      assert.ok(relative(filtered[output + 3] * filteredArea, opacity[index] * originalArea));
    }
  }
});

test('screen filter output feeds bounds and rejects invalid complete batches', () => {
  const covariance = new Float32Array([16, 3, 9, 4, -1, 2]);
  const opacity = new Float32Array([.4, 1]);
  const filtered = gaussian_filter_screen_covariances(covariance, opacity, .3);
  const filteredCovariance = new Float32Array(opacity.length * 3);
  for (let index = 0; index < opacity.length; index++)
    filteredCovariance.set(filtered.slice(index * 4, index * 4 + 3), index * 3);
  const filteredOpacity = new Float32Array(Array.from({ length: opacity.length }, (_, index) => filtered[index * 4 + 3]));
  const bounds = gaussian_screen_bounds(filteredCovariance, filteredOpacity, Math.fround(1 / 255));
  assert.equal(bounds.length, 4);
  assert.ok(bounds.every(value => value > 0));
  const original = covariance.slice();
  for (const variance of [-1, NaN, Infinity])
    assert.throws(() => gaussian_filter_screen_covariances(covariance, opacity, variance), /variance/);
  assert.throws(() => gaussian_filter_screen_covariances(new Float32Array([1, 0, 1, 1, 2, 1]), opacity, .3), /splat 1/);
  assert.throws(() => gaussian_filter_screen_covariances(covariance, new Float32Array([.4, NaN]), .3), /splat 1/);
  assert.deepEqual(covariance, original);
});
