import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_pack_half_extents } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

function halfToFloat(value: number): number {
  const sign = value & 0x8000 ? -1 : 1, exponent = (value >> 10) & 31, fraction = value & 1023;
  if (!exponent) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

test('half extent packing preserves ordered pairs within binary16 precision', () => {
  const input = new Float32Array([0, 0.5, 1, 2, 65504, 0, 1 / 3, 7.25]);
  const packed = gaussian_pack_half_extents(input);
  const decoded: number[] = [];
  for (const value of packed) decoded.push(halfToFloat(value & 0xffff), halfToFloat(value >>> 16));
  assert.deepEqual(decoded.slice(0, 6), [0, 0.5, 1, 2, 65504, 0]);
  assert.ok(Math.abs(decoded[6] - 1 / 3) < 0.001);
  assert.equal(decoded[7], 7.25);
  input.fill(0);
  assert.equal(decoded[3], 2);
});

test('half extent packing rejects nonfinite, negative, oversized and odd input', () => {
  for (const value of [NaN, Infinity, -1, 65505]) assert.throws(() => gaussian_pack_half_extents(new Float32Array([value, 1])), /extent/);
  assert.throws(() => gaussian_pack_half_extents(new Float32Array([1])), /pairs/);
  assert.deepEqual(Array.from(gaussian_pack_half_extents(new Float32Array())), []);
});
