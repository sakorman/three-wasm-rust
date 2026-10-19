import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box, cylinder, sphere, geometryBounds } from '../web/engine/geometry.ts';

test('geometry bounds contain vertices after rounding their center and radius to f32', () => {
  for (const positions of [
    new Float32Array([1e8, 0, 0, 1e8 + 8, 0, 0]),
    new Float32Array([-4, 2, 1, 7, -3, 5, 0, 1, -6]),
    new Float32Array([1, 2, 3, 1, 2, 3]),
    new Float32Array([-1e-30, 0, 0, 1e-30, 0, 0]),
  ]) {
    const bounds = geometryBounds(positions);
    assert.equal(bounds.radius, Math.fround(bounds.radius));
    for (let i = 0; i < positions.length; i += 3)
      assert.ok(Math.hypot(positions[i] - bounds.center[0], positions[i + 1] - bounds.center[1], positions[i + 2] - bounds.center[2]) <= bounds.radius);
  }
  const shifted = geometryBounds(new Float32Array([1e8, 0, 0, 1e8 + 8, 0, 0]));
  assert.equal(shifted.center[0], 1e8);
  assert.equal(shifted.radius, 8);
  assert.equal(geometryBounds(new Float32Array([1, 2, 3])).radius, 0);
});

test('primitive origin spheres round outward instead of cutting through vertices', () => {
  for (const geometry of [box(), cylinder(), sphere()]) {
    for (let i = 0; i < geometry.positions.length; i += 3)
      assert.ok(Math.hypot(...geometry.positions.subarray(i, i + 3)) <= geometry.radius, geometry.name);
  }
});

test('geometry bounds reject invalid positions and unrepresentable radii', () => {
  for (const values of [[], [1, 2], [NaN, 0, 0], [Infinity, 0, 0]])
    assert.throws(() => geometryBounds(new Float32Array(values)), /Invalid vertex positions/);
  assert.throws(() => geometryBounds(new Float32Array([-3e38, -3e38, 0, 3e38, 3e38, 0])), /exceeds f32 range/);
});
