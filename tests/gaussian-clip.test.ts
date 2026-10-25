import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_clip_depth_indices, gaussian_visible_indices, gaussian_depth_order } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('depth clipping preserves original IDs, inclusive f32 boundaries and signed-zero exclusion', () => {
  const depths = new Float32Array(9);
  new Uint32Array(depths.buffer).set([0xbf800000, 0x80000000, 0, 1, 0x3f7fffff, 0x3f800000, 0x40000000, 0x40000001, 0x7f7fffff]);
  const candidates = new Uint32Array([8, 6, 3, 5, 4, 7, 0, 2, 1]);
  assert.deepEqual(Array.from(gaussian_clip_depth_indices(depths, candidates, 1, 2)), [6, 5]);
  assert.deepEqual(Array.from(gaussian_clip_depth_indices(depths, candidates, 1, Infinity)), [8, 6, 5, 7]);
  assert.deepEqual(Array.from(gaussian_clip_depth_indices(depths, candidates, 1, 1)), [5]);
  assert.deepEqual(Array.from(gaussian_clip_depth_indices(depths, candidates, 2 ** -149, 2 ** -149)), [3]);
  assert.equal(gaussian_clip_depth_indices(depths, new Uint32Array(), 1, 2).length, 0);
  assert.equal(gaussian_clip_depth_indices(new Float32Array(), new Uint32Array(), 1, 2).length, 0);
  assert.equal(gaussian_clip_depth_indices(depths, new Uint32Array([0, 1, 2]), 1, 2).length, 0);
});

test('opacity filtering, depth clipping and sorting agree with JS over 65537 splats', () => {
  const depths = new Float32Array(65537), opacities = new Float32Array(depths.length);
  let state = 12345;
  const bits = new Uint32Array(depths.buffer);
  for (let i = 0; i < depths.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bits[i] = ((state & 0x807fffff) | (((state >>> 23) % 255) << 23)) >>> 0;
    if (i % 5 === 0) depths[i] = 2;
    opacities[i] = i % 3 === 0 ? 0 : 0.5;
  }
  const candidates = gaussian_visible_indices(opacities, 1 / 255).reverse();
  const originalDepths = depths.slice(), originalCandidates = candidates.slice();
  const expected = Array.from(candidates).filter(id => depths[id] >= 1 && depths[id] <= 4);
  const clipped = gaussian_clip_depth_indices(depths, candidates, 1, 4);
  assert.ok(clipped instanceof Uint32Array);
  assert.deepEqual(Array.from(clipped), expected);
  assert.ok(clipped.length > 1000 && clipped.length < candidates.length);
  assert.deepEqual(Array.from(gaussian_depth_order(depths, clipped)), [...expected].sort((a, b) => depths[b] - depths[a]));
  assert.deepEqual(depths, originalDepths); assert.deepEqual(candidates, originalCandidates);
  depths.fill(0); candidates.fill(0);
  assert.deepEqual(Array.from(clipped), expected);
});

test('depth clipping rejects invalid ranges, depths and candidates before returning', () => {
  const depths = new Float32Array([-1, 2, 3]), candidates = new Uint32Array([0, 0]);
  for (const [near, far] of [[0, 1], [-0, 1], [-1, 1], [2, 1], [Infinity, Infinity], [NaN, 1], [1, NaN], [1, -Infinity]])
    assert.throws(() => gaussian_clip_depth_indices(depths, new Uint32Array(), near, far), /near/);
  assert.throws(() => gaussian_clip_depth_indices(depths, candidates, 1, 4), /duplicate/);
  assert.throws(() => gaussian_clip_depth_indices(depths, new Uint32Array([3]), 1, 4), /out of range/);
  assert.throws(() => gaussian_clip_depth_indices(depths, new Uint32Array([0, 1, 2, 0]), 1, 4), /candidates/);
  for (const invalid of [NaN, Infinity, -Infinity])
    assert.throws(() => gaussian_clip_depth_indices(new Float32Array([2, invalid]), new Uint32Array([0]), 1, 4), /finite/);
  assert.throws(() => gaussian_clip_depth_indices(new Float32Array(1_000_001), new Uint32Array(), 1, 4), /1000000/);
  assert.deepEqual(Array.from(depths), [-1, 2, 3]); assert.deepEqual(Array.from(candidates), [0, 0]);
  assert.deepEqual(Array.from(gaussian_clip_depth_indices(depths, new Uint32Array([2, 1, 0]), 1, 4)), [2, 1]);
});
