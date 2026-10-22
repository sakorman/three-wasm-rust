import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ray, Vector3, Triangle } from 'three';
import init, { ray_triangle_hits, ray_aabb_intervals } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('indexed triangle batches match Three.js intersections and barycentric coordinates', () => {
  const positions = new Float32Array(256 * 9), indices = new Uint32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = Math.sin(i * 0.31) * 2, y = Math.cos(i * 0.17) * 2, z = Math.sin(i * 0.7);
    positions.set([x - 0.9, y - 0.7, z, x + 0.8, y - 0.6, z + Math.sin(i) * 0.2,
      x, y + 0.9, z + Math.cos(i) * 0.3], i * 9);
    indices.set(i % 2 ? [i * 3, i * 3 + 2, i * 3 + 1] : [i * 3, i * 3 + 1, i * 3 + 2], i * 3);
  }
  let hits = 0, misses = 0;
  for (const direction of [[0, 0, -1], [0.1, -0.1, -1], [-0.2, 0.2, -2]]) {
    for (const culling of [false, true]) {
      const origin = new Float32Array([0, 0, 5]), d = new Float32Array(direction);
      const results = ray_triangle_hits(origin, d, positions, indices, 0, Infinity, culling);
      const ray = new Ray(new Vector3().fromArray(origin), new Vector3().fromArray(d));
      for (let i = 0; i < 256; i++) {
        const vertices = Array.from(indices.slice(i * 3, i * 3 + 3), (index) => new Vector3().fromArray(positions, index * 3));
        const point = ray.intersectTriangle(vertices[0], vertices[1], vertices[2], culling, new Vector3());
        const actual = results.slice(i * 4, i * 4 + 4);
        if (!point) { assert.deepEqual(Array.from(actual), [-1, 0, 0, 0]); misses++; continue; }
        const expectedT = (point.z - origin[2]) / d[2];
        assert.ok(Math.abs(actual[0] - expectedT) < 1e-12);
        const bary = Triangle.getBarycoord(point, ...vertices as [Vector3, Vector3, Vector3], new Vector3())!;
        bary.toArray().forEach((value, axis) => assert.ok(Math.abs(actual[axis + 1] - value) < 1e-12));
        const reconstructed = vertices.reduce((sum, vertex, axis) => sum.addScaledVector(vertex, actual[axis + 1]), new Vector3());
        assert.ok(reconstructed.distanceTo(point) < 1e-12);
        assert.ok(Math.abs(actual[1] + actual[2] + actual[3] - 1) < 1e-15);
        hits++;
      }
    }
  }
  assert.ok(hits > 10 && misses > 100);
});

test('triangle queries reject AABB false positives and preserve shared edges and parameter ranges', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const direction = new Float32Array([0, -0, -1]);
  const outside = new Float32Array([0.75, 0.75, 1]);
  assert.ok(ray_aabb_intervals(outside, direction, new Float32Array([0, 0, 0, 1, 1, 0]), 0, 2)[0] >= 0);
  assert.deepEqual(Array.from(ray_triangle_hits(outside, direction, positions, new Uint32Array([0, 1, 2]), 0, 2, false)), [-1, 0, 0, 0]);
  const shared = new Float32Array([0.5, 0.5, 1]), indices = new Uint32Array([0, 1, 2, 1, 3, 2]);
  const hit = ray_triangle_hits(shared, direction, positions, indices, 1, 1, true);
  assert.deepEqual(Array.from(hit), [1, 0, 0.5, 0.5, 1, 0.5, 0, 0.5]);
  assert.ok(hit instanceof Float64Array);
  assert.deepEqual(Array.from(ray_triangle_hits(shared, direction, positions, indices, 0, 0.5, true)), [-1, 0, 0, 0, -1, 0, 0, 0]);
  const original = positions.slice(), invalid = new Uint32Array([0, 1, 2, 1, 3, 4]);
  assert.throws(() => ray_triangle_hits(shared, direction, positions, invalid, 0, Infinity, true), /triangle 1/);
  assert.deepEqual(positions, original);
  positions.fill(0);
  assert.equal(hit[0], 1);
  assert.equal(hit[4], 1);
});

test('triangle intersections retain analytic hits across coordinate and direction scales', () => {
  for (const exponent of [-140, -80, 0, 80, 120]) {
    const size = 2 ** exponent;
    const positions = new Float32Array([0, 0, 0, size, 0, 0, 0, size, 0]);
    for (const speed of [-149, -80, 0, 80, 120]) {
      const actual = ray_triangle_hits(new Float32Array([size * 0.25, size * 0.25, size]),
        new Float32Array([0, 0, -(2 ** speed)]), positions, new Uint32Array([0, 1, 2]), 0, Infinity, true);
      assert.deepEqual(Array.from(actual), [2 ** (exponent - speed), 0.5, 0.25, 0.25]);
    }
  }
});
