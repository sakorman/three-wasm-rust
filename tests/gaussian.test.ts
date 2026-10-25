import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_screen_bounds, gaussian_visible_indices, gaussian_project_covariances } from '../pkg/three_wasm_rust.js';

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

test('3D covariance projection matches the perspective Jacobian in pixel space', () => {
  const centers = new Float32Array([2, 3, 10, -1, 0.5, 4]);
  const covariances = new Float32Array([
    1, 0.2, 0.1, 4, 0.3, 9,
    0.5, -0.1, 0.05, 0.75, 0.02, 0.9,
  ]);
  const actual = gaussian_project_covariances(centers, covariances, 100, 200, 320, 240);
  assert.deepEqual(Array.from(actual.slice(0, 3)), [340, 300, 10]);
  assert.ok(Math.abs(actual[3] - 132) < 1e-5);
  assert.ok(Math.abs(actual[4] - 130) < 1e-5);
  assert.ok(Math.abs(actual[5] - 1852) < 1e-5);
  assert.equal(actual[6], 295);
  assert.equal(actual[7], 265);
  assert.equal(actual[8], 4);
  assert.ok(actual[9] > 0 && actual[11] > 0);
});

test('3D covariance projection validates the whole batch before returning', () => {
  const centers = new Float32Array([0, 0, 2, 0, 0, -1]);
  const covariances = new Float32Array([1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1]);
  assert.throws(() => gaussian_project_covariances(centers, covariances, 1, 1, 0, 0), /splat 1/);
  assert.throws(() => gaussian_project_covariances(new Float32Array([0, 0]), new Float32Array(), 1, 1, 0, 0), /centers/);
  assert.throws(() => gaussian_project_covariances(new Float32Array([0, 0, 1]), new Float32Array([1, 0, 0, 1, 0, 1]), 0, 1, 0, 0), /intrinsics/);
});

test('visible index compaction is stable and agrees with zero support bounds', () => {
  const cutoff = Math.fround(1 / 255), below = new Float32Array([cutoff]);
  new Uint32Array(below.buffer)[0]--;
  const opacities = new Float32Array([0, below[0], cutoff, 0.2, 1]);
  const before = opacities.slice(), indices = gaussian_visible_indices(opacities, cutoff);
  assert.ok(indices instanceof Uint32Array);
  assert.deepEqual(Array.from(indices), [2, 3, 4]);
  assert.deepEqual(opacities, before);
  const bounds = gaussian_screen_bounds(new Float32Array(Array.from(opacities, () => [1, 0, 1]).flat()), opacities, cutoff);
  for (let i = 0; i < opacities.length; i++) assert.equal(bounds[i * 2] > 0, opacities[i] >= cutoff);
  opacities.fill(0);
  assert.deepEqual(Array.from(indices), [2, 3, 4]);
  assert.equal(gaussian_visible_indices(new Float32Array(), cutoff).length, 0);
  assert.equal(gaussian_visible_indices(opacities, cutoff).length, 0);
  assert.deepEqual(Array.from(gaussian_visible_indices(new Float32Array([1, 1, 1]), 1)), [0, 1, 2]);
  const many = Float32Array.from({ length: 65537 }, (_, i) => i % 3 === 0 ? 0 : 0.5);
  assert.deepEqual(Array.from(gaussian_visible_indices(many, cutoff)), Array.from(many.keys()).filter((i) => i % 3 !== 0));
  for (const invalid of [NaN, Infinity, -0.1, 1.1])
    assert.throws(() => gaussian_visible_indices(new Float32Array([1, invalid]), cutoff), /opacities/);
  for (const invalid of [0, -1, 2, NaN, Infinity])
    assert.throws(() => gaussian_visible_indices(before, invalid), /cutoff/);
});
