import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import { multiply, OrbitCamera } from '../web/engine/camera.ts';

test('camera matrix multiplication keeps offsets between cancelling large terms', () => {
  const projection = new Float32Array(new Matrix4().elements), view = projection.slice();
  projection[0] = 1e8; projection[4] = 1; projection[12] = -1e8;
  view[12] = 1; view[13] = 0.5;
  const product = multiply(projection, view);
  assert.equal(product[12], 0.5);
  assert.deepEqual(product, new Float32Array(new Matrix4().fromArray(projection).multiply(new Matrix4().fromArray(view)).elements));
  for (const magnitude of [1e20, 1e30]) {
    const left = new Float32Array(new Matrix4().elements), right = left.slice();
    left[0] = left[4] = magnitude; right[0] = magnitude; right[1] = -magnitude;
    const expected = new Float32Array(new Matrix4().fromArray(left).multiply(new Matrix4().fromArray(right)).elements);
    assert.deepEqual(multiply(left, right), expected);
    assert.ok(multiply(left, right).every(Number.isFinite));
  }
});

test('camera matrix multiplication validates inputs and rejects final overflow without mutation', () => {
  const identity = new Float32Array(new Matrix4().elements);
  for (const invalid of [new Float32Array(15), new Float32Array(17), new Float32Array(16).fill(NaN), new Float32Array(16).fill(Infinity)]) {
    assert.throws(() => multiply(invalid, identity), /finite 4x4/);
    assert.throws(() => multiply(identity, invalid), /finite 4x4/);
  }
  const a = identity.slice(), b = identity.slice(); a[0] = b[0] = 1e30;
  const beforeA = a.slice(), beforeB = b.slice();
  assert.throws(() => multiply(a, b), /exceeds f32 range/);
  assert.deepEqual(a, beforeA); assert.deepEqual(b, beforeB);
  assert.deepEqual(multiply(identity, identity), identity);
});

test('orbit camera view-projection agrees with one final f32 rounding', () => {
  const camera = new OrbitCamera();
  camera.distance = 7.4; camera.yaw = 0.34; camera.pitch = 0.45; camera.target = [3, 7, -11];
  assert.equal(camera.frame(1.6).viewProjection[14], 1.8080949783325195);
  for (const distance of [6, 60, 700, 1e8]) {
    for (const aspect of [0.5, 1, 1.7, 3]) {
      camera.distance = distance; camera.target = [13, -7, 23];
      camera.yaw = 0.73; camera.pitch = 0.47;
      const frame = camera.frame(aspect);
      const reference = new Float32Array(new Matrix4().fromArray(frame.projection).multiply(new Matrix4().fromArray(frame.view)).elements);
      frame.viewProjection.forEach((value, i) => assert.ok(value === reference[i], `${distance}/${aspect}/${i}`));
    }
  }
  camera.dispose();
});
