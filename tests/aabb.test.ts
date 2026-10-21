import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Box3, Matrix4, Vector3, Quaternion, Euler } from 'three';
import init, { SceneGraph, RenderQueue } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

test('world AABBs enclose Three.js corner bounds across hierarchy, shear and reflection', () => {
  const count = 512, parents = new Int32Array(count), transforms = new Float32Array(count * 10);
  const nodes = new Uint32Array(count), bounds = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    parents[i] = i % 4 ? i - 1 : -1;
    transforms.set([Math.sin(i), Math.cos(i), i % 7, 0, 0, 0, 1,
      i % 3 ? -0.8 : 0, 1.7, 0.4], i * 10);
    new Quaternion().setFromEuler(new Euler(i * 0.3, i * 0.2, i * 0.1)).toArray(transforms, i * 10 + 3);
    nodes[i] = count - i - 1;
    bounds.set([-1.3, -0.4, 0.2, 0.7, 1.5, 2.8], i * 6);
  }
  const graph = new SceneGraph(parents, transforms);
  try {
    const actual = graph.world_aabbs(nodes, bounds), matrices = graph.world_matrices();
    nodes.forEach((node, index) => {
      const offset = index * 6;
      const reference = new Box3(new Vector3().fromArray(bounds, offset), new Vector3().fromArray(bounds, offset + 3))
        .applyMatrix4(new Matrix4().fromArray(matrices, node * 16));
      const expected = [...reference.min.toArray(), ...reference.max.toArray()];
      expected.forEach((value, axis) => {
        const result = actual[offset + axis];
        assert.ok(axis < 3 ? result <= value : result >= value, `${index}/${axis} shrank`);
        assert.ok(Math.abs(result - value) < 2e-6 * Math.max(1, Math.abs(value)), `${index}/${axis} too loose`);
      });
    });
  } finally { graph.free(); }
});

// Exact f32 values expressed as integers in units of 2^-149.
function units(value: number): bigint {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
  const exponent = (bits >>> 23) & 255;
  const fraction = BigInt(bits & 0x7fffff);
  const magnitude = exponent ? (fraction + (1n << 23n)) << BigInt(exponent - 1) : fraction;
  return bits >>> 31 ? -magnitude : magnitude;
}

test('world AABBs contain exact binary corner sums across extreme magnitudes', () => {
  const graph = new SceneGraph(new Int32Array([-1]), new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
  const nodes = new Uint32Array([0]), max = units(new Float32Array([3.4028234663852886e38])[0]) << 149n;
  let checked = 0, rejected = 0;
  try {
    for (const scale of [-120, -80, -24, 0, 24, 80, 120]) {
      for (const size of [-140, -80, -1, 0, 80, 120]) {
        const transform = new Float32Array([2 ** 50, -(2 ** 40), 0, 0.3, 0.2, 0.1, 0.8,
          -(2 ** scale), 2 ** scale, 2 ** (scale - 3)]);
        graph.set_transform(0, transform); graph.update_world_matrices();
        const bounds = new Float32Array([-(2 ** size), -(2 ** (size - 1)), 0, 2 ** size, 2 ** (size - 1), 2 ** size]);
        const matrix = graph.world_matrices(), exact: bigint[][] = [[], [], []];
        for (let corner = 0; corner < 8; corner++) {
          for (let row = 0; row < 3; row++) {
            let sum = units(matrix[12 + row]) << 149n;
            for (let axis = 0; axis < 3; axis++)
              sum += units(matrix[axis * 4 + row]) * units(bounds[axis + (corner & (1 << axis) ? 3 : 0)]);
            exact[row].push(sum);
          }
        }
        if (exact.flat().some((value) => value < -max || value > max)) {
          assert.throws(() => graph.world_aabbs(nodes, bounds), /exceeds f32 range/); rejected++;
        } else {
          const actual = graph.world_aabbs(nodes, bounds);
          exact.forEach((corners, row) => {
            const min = units(actual[row]) << 149n, max = units(actual[row + 3]) << 149n;
            assert.ok(corners.every((value) => min <= value && value <= max), `${scale}/${size}/${row}`);
          });
          checked++;
        }
      }
    }
    assert.ok(checked > 20 && rejected > 0);
  } finally { graph.free(); }
});

test('AABB queries preserve prepared queues and return owned results after edits and release', () => {
  const graph = new SceneGraph(new Int32Array([-1]), new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
  const nodes = new Uint32Array([0]), bounds = new Float32Array([-1, -2, -3, 1, 2, 3]);
  const queue = new RenderQueue(nodes, new Uint32Array([0]), new Float32Array([4]), 1);
  const matrix = new Float32Array(new Matrix4().elements);
  let result: Float32Array;
  try {
    queue.prepare(graph, matrix, false);
    result = graph.world_aabbs(nodes, bounds);
    assert.equal(queue.visible_count(), 1);
    assert.throws(() => graph.world_aabbs(new Uint32Array([0, 1]), new Float32Array(12)), /query 1/);
    assert.equal(queue.visible_count(), 1);
    graph.set_transform(0, new Float32Array([3, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
    assert.throws(() => graph.world_aabbs(nodes, bounds), /pending/);
    graph.update_world_matrices();
    assert.deepEqual(Array.from(graph.world_aabbs(nodes, bounds)), [2, -2, -3, 4, 2, 3]);
    assert.deepEqual(result, bounds);
  } finally { queue.free(); graph.free(); }
  assert.deepEqual(result!, bounds);
});
