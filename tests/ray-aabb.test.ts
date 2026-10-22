import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Ray, Vector3 } from 'three';
import init, { ray_aabb_intervals } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('batched ray candidates agree with Three.js box intersections', () => {
  const bounds = new Float32Array(512 * 6);
  for (let i = 0; i < 512; i++) {
    const size = 0.1 + (i % 9) * 0.2, center = [Math.sin(i) * 5, Math.cos(i * 0.7) * 5, Math.sin(i * 0.31) * 5];
    bounds.set([...center.map((value) => value - size), ...center.map((value) => value + size)], i * 6);
  }
  let hits = 0, misses = 0;
  for (const origin of [new Float32Array([0, 0, 0]), new Float32Array([0, 0, 8])]) {
    for (const direction of [[0, 0, -1], [1, 0, 0], [0.3, -0.7, -0.4], [-0.3, 0.7, 0.4]]) {
      const d = new Float32Array(direction), ray = new Ray(new Vector3().fromArray(origin), new Vector3().fromArray(d));
      const result = ray_aabb_intervals(origin, d, bounds, 0, Infinity);
      const axis = Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : 2;
      for (let i = 0; i < 512; i++) {
        const box = new Box3(new Vector3().fromArray(bounds, i * 6), new Vector3().fromArray(bounds, i * 6 + 3));
        const point = ray.intersectBox(box, new Vector3());
        if (!point) {
          assert.deepEqual(Array.from(result.slice(i * 2, i * 2 + 2)), [-1, -1]); misses++;
        } else {
          assert.ok(result[i * 2] >= 0 && result[i * 2 + 1] >= result[i * 2]);
          const t = (point.getComponent(axis) - origin[axis]) / d[axis];
          const measured = box.containsPoint(ray.origin) ? result[i * 2 + 1] : result[i * 2];
          assert.ok(Math.abs(measured - t) < 1e-12 * Math.max(1, t));
          if (box.containsPoint(ray.origin)) assert.equal(result[i * 2], 0);
          hits++;
        }
      }
    }
  }
  assert.ok(hits > 20 && misses > 100);
});

// Exact f64 values in units of 2^-1074, including every possible f32 input.
function units(value: number): bigint {
  const bytes = new DataView(new ArrayBuffer(8)); bytes.setFloat64(0, value);
  const bits = bytes.getBigUint64(0), exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  const magnitude = exponent ? (fraction + (1n << 52n)) << BigInt(exponent - 1) : fraction;
  return bits >> 63n ? -magnitude : magnitude;
}

test('ray intervals enclose exact rational intersections across extreme scales', () => {
  for (const scale of [-149, -120, -1, 0, 80, 120]) {
    for (const speed of [-149, -120, -1, 0, 80, 120]) {
      for (const sign of [-1, 1]) {
        const size = 2 ** scale, bounds = new Float32Array([size, 0, 0, size * 1.5, 0, 0]);
        const origin = new Float32Array([sign > 0 ? -size * 0.5 : size * 2, 0, 0]);
        const direction = new Float32Array([sign * 2 ** speed, 0, 0]);
        const result = ray_aabb_intervals(origin, direction, bounds, 0, Infinity);
        assert.ok(result.every(Number.isFinite) && result[0] >= 0 && result[1] >= result[0]);
        const divisor = units(Math.abs(direction[0]));
        const near = sign > 0 ? units(bounds[0]) - units(origin[0]) : units(origin[0]) - units(bounds[3]);
        const far = sign > 0 ? units(bounds[3]) - units(origin[0]) : units(origin[0]) - units(bounds[0]);
        assert.ok(units(result[0]) * divisor <= near << 1074n, `near ${scale}/${speed}/${sign}`);
        assert.ok(units(result[1]) * divisor >= far << 1074n, `far ${scale}/${speed}/${sign}`);
      }
    }
  }
});

test('ray batches reject malformed input atomically and return owned f64 intervals', () => {
  const origin = new Float32Array([0, 0, 0]), direction = new Float32Array([1, -0, 0]);
  const bounds = new Float32Array([1, -1, -1, 2, 1, 1, -2, -1, -1, -1, 1, 1]);
  const before = bounds.slice(), result = ray_aabb_intervals(origin, direction, bounds, 1.25, 1.75);
  assert.ok(result instanceof Float64Array);
  assert.deepEqual(Array.from(result), [1.25, 1.75, -1, -1]);
  const invalid = bounds.slice(); invalid[6] = NaN;
  assert.throws(() => ray_aabb_intervals(origin, direction, invalid, 0, Infinity), /query 1/);
  assert.throws(() => ray_aabb_intervals(origin, direction, bounds, NaN, Infinity), /finite ray/);
  assert.throws(() => ray_aabb_intervals(origin, new Float32Array(3), bounds, 0, Infinity), /nonzero/);
  assert.deepEqual(bounds, before);
  bounds.fill(10);
  assert.deepEqual(Array.from(result), [1.25, 1.75, -1, -1]);
  assert.equal(ray_aabb_intervals(origin, direction, new Float32Array(), 0, Infinity).length, 0);
});
