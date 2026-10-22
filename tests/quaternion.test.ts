import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Matrix4, Quaternion, Vector3 } from 'three';
import init, { SceneGraph, RenderQueue, compose_transform } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('finite nonzero quaternion scales agree with Three.js normalization', () => {
  for (const base of [[0, 0, 0, 1], [0.25, -0.5, 0.75, 1], [1, 0, 0, 0]]) {
    for (const magnitude of [2 ** -149, 2 ** -140, 1e-30, 1e-13, 1, 1e30]) {
      for (const sign of [-1, 1]) {
        const t = new Float32Array([2, -3, 4, ...base.map((value) => value * magnitude * sign), -2, 3, 4]);
        const reference = new Matrix4().compose(new Vector3().fromArray(t),
          new Quaternion().fromArray(t, 3).normalize(), new Vector3().fromArray(t, 7));
        const actual = compose_transform(t), graph = new SceneGraph(new Int32Array([-1]), t);
        try {
          actual.forEach((value, i) => assert.ok(Math.abs(value - reference.elements[i]) < 2e-6, `${magnitude}/${i}`));
          assert.deepEqual(graph.world_matrices(), actual);
          const second = t.slice(); second[0] += 1;
          graph.set_transform(0, second); graph.update_world_matrices();
          assert.equal(graph.world_matrices()[12], 3);
        } finally { graph.free(); }
      }
    }
  }
});

test('zero or nonfinite quaternion batches preserve prior transforms and prepared queues', () => {
  const tiny = new Float32Array([0, 0, 0, 0, 0, 2 ** -140, 2 ** -140, 1, 1, 1]);
  const graph = new SceneGraph(new Int32Array([-1, 0]), new Float32Array([...tiny, ...tiny]));
  const queue = new RenderQueue(new Uint32Array([1]), new Uint32Array([0]), new Float32Array([1]), 1);
  try {
    queue.prepare(graph, new Float32Array(new Matrix4().elements), false);
    const before = graph.world_matrices();
    for (const q of [[0, 0, 0, 0], [-0, 0, -0, 0], [0, 0, NaN, 1], [0, 0, Infinity, 1]]) {
      const invalid = new Float32Array([...tiny, ...tiny]);
      invalid[0] = 10; invalid.set(q, 13);
      const input = invalid.slice();
      assert.throws(() => graph.set_transforms(invalid));
      assert.deepEqual(invalid, input);
      assert.deepEqual(graph.world_matrices(), before);
      assert.equal(queue.visible_count(), 1);
      assert.throws(() => compose_transform(invalid.slice(10)));
    }
    const changed = new Float32Array([...tiny, ...tiny]); changed[0] = 1;
    graph.set_transforms(changed); graph.update_world_matrices();
    assert.equal(graph.world_matrices()[12], 1);
    assert.equal(queue.visible_count(), 0);
  } finally { queue.free(); graph.free(); }
});
