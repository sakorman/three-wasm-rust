import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_screen_bounds } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('Gaussian screen bounds contain threshold ellipses across covariance and opacity scales', () => {
  const cutoff = Math.fround(1 / 255);
  for (const sx of [0.01, 1, 20]) for (const sy of [0.03, 2, 40]) for (const rho of [-0.9, 0, 0.9]) {
    const covariance = new Float32Array([sx * sx, rho * sx * sy, sy * sy]);
    for (const opacity of [cutoff, Math.fround(0.01), Math.fround(0.2), 1]) {
      const bounds = gaussian_screen_bounds(covariance, new Float32Array([opacity]), cutoff);
      const radius = Math.sqrt(2 * Math.log(opacity / cutoff));
      const a = Math.sqrt(covariance[0]), b = covariance[1] / a, c = Math.sqrt(covariance[2] - b * b);
      for (let i = 0; i < 64; i++) {
        const theta = i * Math.PI / 32;
        assert.ok(Math.abs(radius * a * Math.cos(theta)) + 0.5 <= bounds[0]);
        assert.ok(Math.abs(radius * (b * Math.cos(theta) + c * Math.sin(theta))) + 0.5 <= bounds[1]);
      }
      [covariance[0], covariance[2]].forEach((variance, axis) => {
        const expected = Math.sqrt(variance) * radius + 0.5;
        assert.ok(bounds[axis] >= expected && bounds[axis] - expected <= 1e-5 * Math.max(1, expected));
      });
    }
  }
});

test('lower opacity reduces bounds while retaining equal-cutoff pixel centers', () => {
  const cutoff = Math.fround(1 / 255), opacity = new Float32Array([1, 0.2, 0.01, cutoff, 0.001, 0]);
  const covariance = new Float32Array(Array.from(opacity, () => [16, 3, 9]).flat());
  const result = gaussian_screen_bounds(covariance, opacity, cutoff);
  for (let i = 1; i < 4; i++) assert.ok(result[i * 2] < result[(i - 1) * 2]);
  assert.deepEqual(Array.from(result.slice(6)), [0.5, 0.5, 0, 0, 0, 0]);
  const original = result.slice(); opacity.fill(0); covariance.fill(0);
  assert.deepEqual(result, original);
  assert.equal(gaussian_screen_bounds(new Float32Array(), new Float32Array(), cutoff).length, 0);
});

test('invalid Gaussian batches leave input data unchanged and reject invisible invalid covariance', () => {
  const covariance = new Float32Array([1, 0, 1, 1, 2, 1]), opacity = new Float32Array([1, 0]);
  const before = covariance.slice();
  assert.throws(() => gaussian_screen_bounds(covariance, opacity, 1 / 255), /splat 1/);
  assert.deepEqual(covariance, before);
  assert.throws(() => gaussian_screen_bounds(new Float32Array([1, 0]), new Float32Array([1]), 1 / 255), /three covariance/);
  assert.throws(() => gaussian_screen_bounds(new Float32Array([1, 0, 1]), new Float32Array([NaN]), 1 / 255), /splat 0/);
  assert.throws(() => gaussian_screen_bounds(new Float32Array([1, 0, 1]), new Float32Array([1]), 0), /cutoff/);
});
