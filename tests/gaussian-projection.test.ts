import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_project_covariances, gaussian_screen_bounds } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('projection rejects zero, singular and indefinite f32 results at the original batch index', () => {
  const covariance = new Float32Array([1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1]);
  const original = covariance.slice();
  const saved = gaussian_project_covariances(new Float32Array([0, 0, 1]), covariance.slice(0, 6), 1, 1, 0, 0);
  for (const center of [[0, 0, 1e30], [1e5, 1e5, 1], [1e5, 100001, 1]]) {
    const centers = new Float32Array([0, 0, 1, ...center]), before = centers.slice();
    assert.throws(() => gaussian_project_covariances(centers, covariance, 1, 1, 0, 0),
      /projected Gaussian covariance is not positive definite in f32 at splat 1/);
    assert.deepEqual(centers, before);
    assert.deepEqual(covariance, original);
  }
  const recovered = gaussian_project_covariances(new Float32Array([0, 0, 2]), covariance.slice(0, 6), 1, 1, 0, 0);
  assert.deepEqual(Array.from(recovered), [0, 0, 2, 0.25, 0, 0.25]);
  assert.deepEqual(Array.from(saved), [0, 0, 1, 1, 0, 1]);
});

test('projection keeps subnormal and large positive f32 covariances usable by screen bounds', () => {
  for (const [z, variance, expected] of [[2 ** 74, 0.5, 2 ** -149], [1, 2 ** 127, 2 ** 127]]) {
    const projected = gaussian_project_covariances(new Float32Array([0, 0, z]),
      new Float32Array([variance, 0, 0, variance, 0, variance]), 1, 1, 0, 0);
    assert.deepEqual(Array.from(projected.slice(3)), [expected, 0, expected]);
    const bounds = gaussian_screen_bounds(projected.slice(3), new Float32Array([1]), 1 / 255);
    assert.ok(bounds.every(value => Number.isFinite(value) && value > 0));
  }
  assert.throws(() => gaussian_project_covariances(new Float32Array([0, 0, 1]),
    new Float32Array([2 ** 127, 0, 0, 2 ** 127, 0, 1]), 2, 2, 0, 0), /exceeds f32 range/);
});

test('projection agrees with finite differences of the pinhole map across 128 anisotropic inputs', () => {
  const centers: number[] = [], covariances: number[] = [];
  for (let i = 0; i < 128; i++) {
    const z = 2 ** ((i % 17) - 8);
    centers.push(z * Math.sin(i) * 0.7, z * Math.cos(i * 0.3) * 0.5, z);
    const scale = 2 ** ((i % 13) - 6);
    const l = [[scale, 0, 0], [0.2 * scale, 2 * scale, 0], [-0.3 * scale, 0.4 * scale, 0.5 * scale]];
    const covariance = l.map(row => l.map(other => row.reduce((sum, value, k) => sum + value * other[k], 0)));
    covariances.push(covariance[0][0], covariance[0][1], covariance[0][2], covariance[1][1], covariance[1][2], covariance[2][2]);
  }
  const xyz = new Float32Array(centers), sigma = new Float32Array(covariances);
  const actual = gaussian_project_covariances(xyz, sigma, 120, 180, 128, 96);
  const screenCovariances: number[] = [];
  const project = (v: number[]) => [120 * v[0] / v[2] + 128, 180 * v[1] / v[2] + 96];
  for (let i = 0; i < 128; i++) {
    const center = Array.from(xyz.slice(i * 3, i * 3 + 3)), step = center[2] * 1e-4;
    const derivatives = [0, 1, 2].map(axis => {
      const plus = [...center], minus = [...center]; plus[axis] += step; minus[axis] -= step;
      return project(plus).map((value, row) => (value - project(minus)[row]) / (2 * step));
    });
    const [xx, xy, xz, yy, yz, zz] = sigma.slice(i * 6, i * 6 + 6);
    const covariance = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
    const expected = [[0, 0], [0, 1], [1, 1]].map(([row, col]) =>
      covariance.reduce((sum, values, a) => sum + values.reduce((subtotal, value, b) =>
        subtotal + derivatives[a][row] * value * derivatives[b][col], 0), 0));
    const actualCovariance = actual.slice(i * 6 + 3, i * 6 + 6);
    actualCovariance.forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) <=
      3e-6 * Math.max(Math.abs(expected[axis]), Math.sqrt(expected[0] * expected[2]) * 1e-3), `${i}/${axis}`));
    project(center).forEach((value, axis) => assert.equal(actual[i * 6 + axis], Math.fround(value)));
    assert.equal(actual[i * 6 + 2], center[2]);
    screenCovariances.push(...actualCovariance);
  }
  assert.equal(gaussian_screen_bounds(new Float32Array(screenCovariances), new Float32Array(128).fill(1), 1 / 255).length, 256);
});
