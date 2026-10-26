import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_viewport_indices } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('viewport filtering retains touching bounds in candidate order and owns its result', () => {
  const centers = new Float32Array([-1, 2, 5, 2, 2, -1, 2, 5, -2, 2, 6, 2, 2, -2, 2, 6, 2, 2, 2, 2]);
  const extents = new Float32Array(20).fill(1); extents[18] = -0;
  const candidates = new Uint32Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  const before = [centers.slice(), extents.slice(), candidates.slice()];
  const visible = gaussian_viewport_indices(centers, extents, candidates, 4, 4);
  assert.ok(visible instanceof Uint32Array);
  assert.deepEqual(Array.from(visible), [8, 3, 2, 1, 0]);
  assert.deepEqual([centers, extents, candidates], before);
  centers.fill(99); extents.fill(0); candidates.fill(0);
  assert.deepEqual(Array.from(visible), [8, 3, 2, 1, 0]);
  assert.equal(gaussian_viewport_indices(new Float32Array(), new Float32Array(), new Uint32Array(), 1, 1).length, 0);
  assert.equal(gaussian_viewport_indices(centers, extents, new Uint32Array([0]), 1, 1).length, 0);
});

test('viewport filtering never excludes exact intersections across the finite f32 range', () => {
  const n = 4097, centers = new Float32Array(n * 2), extents = new Float32Array(n * 2);
  const centerBits = new Uint32Array(centers.buffer), extentBits = new Uint32Array(extents.buffer);
  let state = 12345;
  for (let i = 0; i < centers.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    centerBits[i] = ((state & 0x807fffff) | (((state >>> 23) % 255) << 23)) >>> 0;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    extentBits[i] = (state & 0x7fffff) | (((state >>> 23) % 255) << 23);
  }
  const scratch = new Float32Array(1), raw = new Uint32Array(scratch.buffer);
  // Exact integer multiples of the smallest f32 value, 2^-149.
  const units = (value: number) => {
    scratch[0] = value; const bits = raw[0], exponent = (bits >>> 23) & 255;
    const mantissa = BigInt((bits & 0x7fffff) | (exponent ? 0x800000 : 0));
    return (bits >>> 31 ? -mantissa : mantissa) << BigInt(Math.max(0, exponent - 1));
  };
  const candidates = Uint32Array.from({ length: n }, (_, i) => n - 1 - i);
  for (const dimensions of [[256, 192], [2 ** -149, 2 ** -149], [2 ** 127, 2 ** 127]]) {
    const limits = dimensions.map(units);
    const exact = Array.from(candidates).filter(id => [0, 1].every(axis => {
      const center = units(centers[id * 2 + axis]), extent = units(extents[id * 2 + axis]);
      return extent > 0n && center + extent >= 0n && center - extent <= limits[axis];
    }));
    const result = Array.from(gaussian_viewport_indices(centers, extents, candidates, ...dimensions as [number, number]));
    const retained = new Set(result);
    for (const id of exact) assert.ok(retained.has(id), `lost exact intersection ${id}`);
    assert.deepEqual(result, Array.from(candidates).filter(id => retained.has(id)));
    assert.ok(result.length > 100 && result.length < n);
  }
});

test('viewport filtering rejects invalid inputs even outside the candidate list', () => {
  const centers = new Float32Array([1, 1, 2, 2]), extents = new Float32Array([1, 1, 1, 1]);
  for (const invalid of [0, -1, NaN, Infinity]) {
    assert.throws(() => gaussian_viewport_indices(centers, extents, new Uint32Array(), invalid, 4), /dimensions/);
    assert.throws(() => gaussian_viewport_indices(centers, extents, new Uint32Array(), 4, invalid), /dimensions/);
  }
  for (const invalid of [-1, NaN, Infinity]) {
    const bad = extents.slice(); bad[3] = invalid;
    assert.throws(() => gaussian_viewport_indices(centers, bad, new Uint32Array([0]), 4, 4), /half extents/);
  }
  const badCenter = centers.slice(); badCenter[3] = NaN;
  assert.throws(() => gaussian_viewport_indices(badCenter, extents, new Uint32Array([0]), 4, 4), /centers/);
  assert.throws(() => gaussian_viewport_indices(centers.slice(1), extents, new Uint32Array(), 4, 4), /paired/);
  assert.throws(() => gaussian_viewport_indices(centers, extents.slice(2), new Uint32Array(), 4, 4), /paired/);
  assert.throws(() => gaussian_viewport_indices(centers, extents, new Uint32Array([0, 0]), 4, 4), /duplicate/);
  assert.throws(() => gaussian_viewport_indices(centers, extents, new Uint32Array([2]), 4, 4), /out of range/);
  assert.throws(() => gaussian_viewport_indices(centers, extents, new Uint32Array([0, 1, 0]), 4, 4), /candidates/);
  assert.deepEqual(Array.from(gaussian_viewport_indices(centers, extents, new Uint32Array([1, 0]), 4, 4)), [1, 0]);
});
