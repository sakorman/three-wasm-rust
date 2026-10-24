import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_depth_order, gaussian_visible_indices } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('Gaussian radix order matches stable JS sorting over a compacted candidate list', () => {
  const n = 65537, depths = new Float32Array(n), opacities = new Float32Array(n);
  const bits = new Uint32Array(depths.buffer);
  let state = 12345;
  for (let i = 0; i < n; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bits[i] = ((state & 0x807fffff) | (((state >>> 23) % 255) << 23)) >>> 0;
    if (i % 5 === 0) depths[i] = 3;
    opacities[i] = i % 3 === 0 ? 0 : 0.5;
  }
  const candidates = gaussian_visible_indices(opacities, 1 / 255).reverse();
  const beforeDepths = depths.slice(), beforeCandidates = candidates.slice();
  const expected = Array.from(candidates).sort((a, b) => depths[b] - depths[a]);
  const actual = gaussian_depth_order(depths, candidates);
  assert.ok(actual instanceof Uint32Array);
  assert.deepEqual(Array.from(actual), expected);
  assert.deepEqual(depths, beforeDepths); assert.deepEqual(candidates, beforeCandidates);
  candidates.fill(0); depths.fill(0);
  assert.deepEqual(Array.from(actual), expected);
});

test('Gaussian sorting retains adjacent f32 depths, signed zeros, ties and subsets', () => {
  const depths = new Float32Array(10), bits = new Uint32Array(depths.buffer);
  bits.set([0xff7fffff, 0xbf800000, 0x80000001, 0x80000000, 0, 1, 0x3f7fffff, 0x3f800000, 0x3f800001, 0x7f7fffff]);
  const indices = new Uint32Array([0, 1, 2, 4, 3, 5, 6, 7, 8, 9]);
  assert.deepEqual(Array.from(gaussian_depth_order(depths, indices)), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  assert.deepEqual(Array.from(gaussian_depth_order(new Float32Array([2, 1, 2, 99]), new Uint32Array([2, 1, 0]))), [2, 0, 1]);
  assert.deepEqual(Array.from(gaussian_depth_order(depths, new Uint32Array([3, 4]))), [3, 4]);
  assert.equal(gaussian_depth_order(depths, new Uint32Array()).length, 0);
  assert.equal(gaussian_depth_order(new Float32Array(), new Uint32Array()).length, 0);
});

test('Gaussian sorting rejects invalid candidates and depths before returning an order', () => {
  const depths = new Float32Array([1, 2, 3]);
  const duplicate = new Uint32Array([2, 1, 2]);
  assert.throws(() => gaussian_depth_order(depths, duplicate), /duplicate/);
  assert.deepEqual(Array.from(duplicate), [2, 1, 2]);
  assert.throws(() => gaussian_depth_order(depths, new Uint32Array([3])), /out of range/);
  assert.throws(() => gaussian_depth_order(depths, new Uint32Array([0, 1, 2, 0])), /candidates/);
  for (const invalid of [NaN, Infinity, -Infinity])
    assert.throws(() => gaussian_depth_order(new Float32Array([1, invalid]), new Uint32Array([0])), /finite/);
  assert.deepEqual(Array.from(depths), [1, 2, 3]);
  assert.deepEqual(Array.from(gaussian_depth_order(depths, new Uint32Array([1]))), [1]);
});
