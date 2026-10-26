import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_clip_depth_indices, gaussian_clip_depth_support_indices } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('support-depth clipping retains near and far crossing Gaussians in candidate order', () => {
  const cutoff = Math.fround(1 / 255);
  const centers = new Float32Array([0, 0, 0.8, 0, 0, 4.4, 0, 0, 1, 0, 0, 0.9, 0, 0, 2]);
  const covariance = new Float32Array([
    .01, 0, 0, .01, 0, .04, .01, 0, 0, .01, 0, .09, .01, 0, 0, .01, 0, .04,
    .01, 0, 0, .01, 0, .04, .01, 0, 0, .01, 0, .04,
  ]);
  const opacity = new Float32Array([1, 1, cutoff, cutoff, cutoff * .5]);
  const candidates = new Uint32Array([4, 1, 3, 0, 2]);
  const actual = gaussian_clip_depth_support_indices(centers, covariance, opacity, candidates, cutoff, 1, 4);
  assert.deepEqual(Array.from(actual), [1, 0, 2]);
  assert.deepEqual(Array.from(gaussian_clip_depth_indices(
    new Float32Array([.8, 4.4, 1, .9, 2]), new Uint32Array([1, 3, 0, 2]), 1, 4,
  )), [2]);
  centers.fill(0); covariance.fill(0); opacity.fill(0); candidates.fill(0);
  assert.deepEqual(Array.from(actual), [1, 0, 2]);
});

test('support-depth clipping contains analytical intersections over 4097 finite f32 Gaussians', () => {
  const count = 4097, cutoff = Math.fround(1 / 255), near = 64, far = 128;
  const centers = new Float32Array(count * 3), covariance = new Float32Array(count * 6), opacity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const sx = 2 ** ((i % 7) - 5), sy = 2 ** ((i % 11) - 6), sz = 2 ** ((i % 9) - 7);
    const l10 = .2 * sy, l20 = -.3 * sz, l21 = .1 * sz;
    covariance.set([sx * sx, sx * l10, sx * l20, l10 * l10 + sy * sy,
      l10 * l20 + sy * l21, l20 * l20 + l21 * l21 + sz * sz], i * 6);
    opacity[i] = [cutoff, .02, .1, .4, 1, cutoff * .5][i % 6];
    const zz = covariance[i * 6 + 5], alpha = opacity[i];
    const radius = alpha > cutoff ? Math.sqrt(2 * zz * Math.log(alpha / cutoff)) : 0;
    const position = [near - radius, near - radius * 1.01, near + radius * .5,
      far + radius, far + radius * 1.01, 96][i % 6];
    centers.set([Math.fround((i % 13) - 6), Math.fround((i % 17) - 8), Math.fround(position)], i * 3);
  }
  const candidates = Uint32Array.from({ length: count }, (_, i) => count - i - 1);
  const expected = Array.from(candidates).filter(id => {
    const alpha = opacity[id];
    if (alpha < cutoff) return false;
    const radius = alpha === cutoff ? 0 : Math.sqrt(2 * covariance[id * 6 + 5] * Math.log(alpha / cutoff));
    const z = centers[id * 3 + 2];
    return z - radius <= far && z + radius >= near;
  });
  const actual = Array.from(gaussian_clip_depth_support_indices(centers, covariance, opacity, candidates, cutoff, near, far));
  const retained = new Set(actual);
  for (const id of expected) assert.ok(retained.has(id), `lost ${id}`);
  assert.ok(expected.length > count * .3);
  assert.deepEqual(actual, Array.from(candidates).filter(id => retained.has(id)));
});

test('support-depth clipping rejects invalid complete batches without partial output', () => {
  const centers = new Float32Array([0, 0, 2, 0, 0, 2]);
  const covariance = new Float32Array([1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1]);
  const opacity = new Float32Array([1, 1]);
  assert.throws(() => gaussian_clip_depth_support_indices(centers, covariance, opacity, new Uint32Array([0, 0]), .01, 1, 4), /duplicate/);
  assert.throws(() => gaussian_clip_depth_support_indices(centers, covariance, opacity, new Uint32Array([2]), .01, 1, 4), /out of range/);
  assert.throws(() => gaussian_clip_depth_support_indices(centers, covariance, new Float32Array([1, NaN]), new Uint32Array([0]), .01, 1, 4), /opacity/);
  assert.throws(() => gaussian_clip_depth_support_indices(new Float32Array([0, 0, 2, 0, 0, 0]), covariance, opacity, new Uint32Array([0]), .01, 1, 4), /depth/);
  assert.throws(() => gaussian_clip_depth_support_indices(centers, covariance, opacity, new Uint32Array(), .01, 1, NaN), /near/);
});
