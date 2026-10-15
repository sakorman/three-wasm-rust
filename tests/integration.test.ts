import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import init, {
  SceneGraph,
  RenderQueue,
  RustRenderer,
  compose_transform,
  multiply_matrices,
  multiply_matrices_batch,
  transform_points,
} from '../pkg/three_wasm_rust.js';
import { createSceneData, ThreeGraph, matrixView } from '../web/scene.ts';
import { createEngineScene } from '../web/engine/scenes.ts';
import { OrbitCamera } from '../web/engine/camera.ts';

const wasm = await init({
  module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)),
});

function close(actual: Float32Array, expected: ArrayLike<number>, label = '') {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) =>
    assert.ok(
      Number.isFinite(value) &&
        Math.abs(value - expected[i]) < 0.0002 + Math.abs(expected[i]) * 0.00002,
      `${label}[${i}]: ${value} != ${expected[i]}`,
    ),
  );
}

test('the module is real WebAssembly and exports a Rust renderer', () => {
  assert.ok(wasm.memory instanceof WebAssembly.Memory);
  assert.equal(typeof RustRenderer, 'function');
});

test('TRS, multiplication and point transforms match independent Three.js math', () => {
  const data = createSceneData(128);
  for (let i = 0; i < 128; i++) {
    const t = data.transforms.slice(i * 10, i * 10 + 10);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.03, i * -0.02, i * 0.07));
    q.toArray(t, 3);
    t[7] *= -1;
    t[8] *= 2; // negative and nonuniform scale
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(t),
      new THREE.Quaternion().fromArray(t, 3).normalize(),
      new THREE.Vector3().fromArray(t, 7),
    );
    close(compose_transform(t), matrix.elements, 'compose');
    const rotation = new THREE.Matrix4().makeRotationY(0.72);
    close(
      multiply_matrices(Float32Array.from(matrix.elements), Float32Array.from(rotation.elements)),
      matrix.clone().multiply(rotation).elements,
      'multiply',
    );
    const points = new Float32Array([1, -2, 3, -3, 2, 1]);
    const expected: number[] = [];
    for (let j = 0; j < points.length; j += 3)
      new THREE.Vector3().fromArray(points, j).applyMatrix4(matrix).toArray(expected, j);
    close(transform_points(Float32Array.from(matrix.elements), points), expected, 'points');
  }
});

test('batch multiply handles several independent matrices', () => {
  const a = new THREE.Matrix4().makeRotationX(0.3).elements;
  const b = new THREE.Matrix4().makeTranslation(3, 2, 1).elements;
  const expected = new THREE.Matrix4()
    .fromArray(a)
    .multiply(new THREE.Matrix4().fromArray(b)).elements;
  close(multiply_matrices_batch(Float32Array.from([...a, ...b]), Float32Array.from([...b, ...a])), [
    ...expected,
    ...new THREE.Matrix4().fromArray(b).multiply(new THREE.Matrix4().fromArray(a)).elements,
  ]);
});

test('real WASM scene and animation match Three.js at 5,000 nodes', () => {
  const data = createSceneData(5000),
    graph = new SceneGraph(data.parents, data.transforms),
    reference = new ThreeGraph(data);
  try {
    close(graph.world_matrices(), reference.worldMatrices(), 'initial');
    for (const time of [0, 0.5, 3.25, 100]) {
      graph.animate_demo(time);
      reference.animateDemo(time);
      close(matrixView(wasm, graph), reference.worldMatrices(), `t=${time}`);
    }
  } finally {
    graph.free();
  }
});

test('matrix products preserve cancellation and agree with Three.js on finite f32 input', () => {
  for (const magnitude of [1e8, 1e20, 1e30]) {
    const a = Float32Array.from(new THREE.Matrix4().elements);
    const b = a.slice();
    a[0] = a[4] = magnitude;
    b[0] = magnitude;
    b[1] = -magnitude;
    const reference = new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b));
    close(multiply_matrices(a, b), reference.elements);
    close(multiply_matrices_batch(a, b), reference.elements);
    b[1] = 0;
    if (magnitude >= 1e20) {
      assert.throws(() => multiply_matrices(a, b), /exceeds f32 range/);
      assert.throws(() => multiply_matrices_batch(a, b), /exceeds f32 range/);
    }
  }
});

test('hierarchy cancellation preserves a local offset through dirty and full updates', () => {
  const angle = Math.PI / 8;
  const root = new Float32Array([0, 0, 0, 0, 0, Math.sin(angle), Math.cos(angle), 1e8, 1, 1]);
  const probe = new SceneGraph(new Int32Array([-1]), root);
  const matrix = probe.world_matrices();
  probe.free();
  root[0] = -matrix[0];
  root[1] = -matrix[1];
  const child = new Float32Array([1, 0.5, 0, 0, 0, 0, 1, 1e-8, 1, 1]);
  const graph = new SceneGraph(new Int32Array([-1, 0]), new Float32Array([...root, ...child]));
  try {
    for (const offset of [0.5, -0.5, 0.25]) {
      child[1] = offset;
      graph.set_transform(1, child);
      for (const update of [() => graph.update_world_matrices(), () => graph.update_all_world_matrices()]) {
        update();
        close(graph.world_matrices().slice(28, 31), [matrix[4] * offset, matrix[5] * offset, 0]);
      }
    }
  } finally { graph.free(); }
});

test('reparenting a child to a later node preserves local TRS', () => {
  const data = createSceneData(3);
  data.parents.fill(-1);
  const graph = new SceneGraph(data.parents, data.transforms),
    reference = new ThreeGraph(data);
  try {
    graph.reparent(0, 2);
    graph.update_world_matrices();
    reference.nodes[2].add(reference.nodes[0]);
    reference.roots = [reference.nodes[1], reference.nodes[2]];
    reference.updateWorldMatrices();
    close(graph.world_matrices(), reference.worldMatrices());
    assert.throws(() => graph.reparent(2, 0), /cycle/);
    graph.update_world_matrices();
    close(graph.world_matrices(), reference.worldMatrices());
  } finally {
    graph.free();
  }
});

test('copy and borrowed matrix APIs remain correct across memory growth', () => {
  const data = createSceneData(2),
    graph = new SceneGraph(data.parents, data.transforms);
  const copy = graph.world_matrices(),
    view = matrixView(wasm, graph);
  wasm.memory.grow(1);
  assert.equal(view.byteLength, 0);
  close(matrixView(wasm, graph), copy);
  graph.free();
  assert.equal(copy.length, 32);
});

test('JS-facing validation rejects malformed data and keeps prior transforms', () => {
  assert.throws(() => new SceneGraph(new Int32Array([1, 0]), new Float32Array(20)), /cycle/);
  const data = createSceneData(2),
    graph = new SceneGraph(data.parents, data.transforms);
  try {
    const before = graph.world_matrices();
    assert.throws(() => graph.set_transforms(new Float32Array(20)), /quaternion/);
    assert.throws(() => graph.set_transform(0, new Float32Array(9)), /length/);
    assert.throws(() => graph.animate_demo(Infinity), /finite/);
    graph.update_world_matrices();
    close(graph.world_matrices(), before);
    const changed = data.transforms.slice(0, 10);
    changed[0] += 10;
    graph.set_transform(0, changed);
    graph.update_world_matrices();
    assert.ok(Math.abs(graph.world_matrices()[12] - before[12] - 10) < 0.0001);
  } finally {
    graph.free();
  }
  assert.throws(() => multiply_matrices_batch(new Float32Array(17), new Float32Array(17)), /16/);
  assert.throws(
    () => transform_points(new Float32Array(16), new Float32Array([1, 2, 3])),
    /infinity/,
  );
});

test('zero nodes and repeated allocation / release work', () => {
  for (let i = 0; i < 100; i++) {
    const graph = new SceneGraph(new Int32Array(), new Float32Array());
    graph.animate_demo(1);
    assert.equal(graph.node_count(), 0);
    graph.free();
  }
});

test('WASM overflow errors invalidate packed queues and allow repaired scenes', () => {
  const local = (scale: number) => new Float32Array([0, 0, 0, 0, 0, 0, 1, scale, scale, scale]);
  assert.throws(() => new SceneGraph(new Int32Array([-1, 0]),
    new Float32Array([...local(1e20), ...local(1e20)])), /non-finite world matrix at node 1/);
  const graph = new SceneGraph(new Int32Array([-1, 0]), new Float32Array([...local(1), ...local(1e20)]));
  const queue = new RenderQueue(new Uint32Array([1]), new Uint32Array([0]), new Float32Array([1e-20]), 1);
  const camera = Float32Array.from(new THREE.Matrix4().elements);
  try {
    queue.prepare(graph, camera, false);
    graph.set_transform(0, local(1e20));
    assert.equal(queue.visible_count(), 0);
    assert.equal(queue.matrices_len(), 0);
    assert.throws(() => queue.prepare(graph, camera, false), /pending or non-finite/);
    assert.throws(() => graph.update_world_matrices(), /non-finite world matrix/);
    assert.throws(() => graph.update_all_world_matrices(), /non-finite world matrix/);
    assert.throws(() => queue.prepare_direct(graph, camera, true), /pending or non-finite/);
    graph.set_transform(0, local(1));
    graph.update_world_matrices();
    queue.prepare(graph, camera, false);
    assert.equal(queue.visible_count(), 1);
    assert.equal(queue.matrices_len(), 16);
    assert.ok(Array.from(graph.world_matrices()).every(Number.isFinite));
  } finally {
    graph.free();
  }
  assert.equal(queue.visible_count(), 0);
  assert.equal(queue.matrices_len(), 0);
  queue.free();
});

test('engine scene presets have reproducible resources and match Three.js visibility', () => {
  for (const scenario of ['city', 'warehouse', 'hierarchy'] as const) {
    const data = createEngineScene(scenario, 500);
    assert.deepEqual(data.transforms, createEngineScene(scenario, 500).transforms);
    assert.equal(data.meshNodes.length, 500);
    const graph = new SceneGraph(data.parents, data.transforms);
    const queue = new RenderQueue(
      data.meshNodes,
      data.groups,
      data.radii,
      data.batchGeometries.length,
    );
    const reference = new ThreeGraph({
      parents: data.parents,
      transforms: data.transforms,
      colors: new Float32Array(),
    });
    const camera = new OrbitCamera();
    camera.reset(data.extent);
    try {
      for (const yaw of [0, 0.72, 2.2]) {
        camera.yaw = yaw;
        camera.distance = data.extent * 0.9;
        const frame = camera.frame(1.3);
        queue.prepare(graph, frame.viewProjection, true);
        const frustum = new THREE.Frustum().setFromProjectionMatrix(
          new THREE.Matrix4().fromArray(frame.viewProjection),
        );
        const visible: number[] = [];
        data.meshNodes.forEach((id, i) => {
          const sphere = new THREE.Sphere(new THREE.Vector3(), data.radii[i]).applyMatrix4(
            reference.nodes[id].matrixWorld,
          );
          if (frustum.intersectsSphere(sphere)) visible.push(id);
        });
        assert.deepEqual(Array.from(queue.visible_nodes()), visible, `${scenario} visible nodes`);
        assert.equal(
          Array.from(queue.batch_counts()).reduce((a, b) => a + b, 0),
          visible.length,
        );
      }
      graph.animate_nodes(data.animatedNodes, 2.25);
      graph.update_world_matrices();
      assert.ok(graph.updated_count() < graph.node_count());
      for (const id of data.animatedNodes) {
        const angle = Math.fround(
          Math.fround(Math.fround(2.25) * Math.fround(0.2)) +
            Math.fround((id % 19) * Math.fround(0.03)),
        );
        reference.nodes[id].quaternion.set(0, Math.sin(angle), 0, Math.cos(angle));
      }
      reference.updateWorldMatrices();
      close(graph.world_matrices(), reference.worldMatrices(), scenario);
      graph.update_world_matrices();
      assert.equal(graph.updated_count(), 0);
      graph.update_all_world_matrices();
      assert.equal(graph.updated_count(), graph.node_count());
    } finally {
      graph.free();
      queue.free();
    }
  }
});

test('engine camera agrees with Three.js lookAt and perspective', () => {
  const orbit = new OrbitCamera();
  orbit.reset(25);
  const frame = orbit.frame(1.6);
  const camera = new THREE.PerspectiveCamera(46, 1.6, 0.1, 1000);
  camera.position.set(
    Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
    3 + Math.sin(orbit.pitch) * orbit.distance,
    Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.distance,
  );
  camera.lookAt(0, 3, 0);
  camera.updateMatrixWorld();
  close(frame.view, camera.matrixWorldInverse.elements, 'view');
  close(frame.projection, camera.projectionMatrix.elements, 'projection');
});

test('off-origin WASM spheres match Three.js across camera positions', () => {
  const data = createEngineScene('hierarchy', 500);
  const centers = Float32Array.from({ length: data.meshNodes.length * 3 }, (_, i) =>
    ((i * 7) % 23 - 11) * 1.25);
  const graph = new SceneGraph(data.parents, data.transforms);
  const queue = new RenderQueue(data.meshNodes, data.groups, data.radii, data.batchGeometries.length);
  const reference = new ThreeGraph({
    parents: data.parents, transforms: data.transforms, colors: new Float32Array(),
  });
  const camera = new OrbitCamera();
  camera.reset(data.extent);
  try {
    queue.set_bounds(centers, data.radii);
    assert.throws(() => queue.set_bounds(new Float32Array(3), data.radii), /bounding spheres/);
    for (const yaw of [0, 0.8, 2.2]) {
      camera.yaw = yaw;
      camera.distance = data.extent * 0.8;
      const frame = camera.frame(1.3);
      const frustum = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().fromArray(frame.viewProjection));
      const expected: number[] = [];
      data.meshNodes.forEach((id, i) => {
        const sphere = new THREE.Sphere(new THREE.Vector3().fromArray(centers, i * 3), data.radii[i]);
        if (frustum.intersectsSphere(sphere.applyMatrix4(reference.nodes[id].matrixWorld)))
          expected.push(id);
      });
      queue.prepare(graph, frame.viewProjection, true);
      assert.deepEqual(Array.from(queue.visible_nodes()), expected);
      queue.prepare_direct(graph, frame.viewProjection, true);
      assert.deepEqual(Array.from(queue.visible_nodes()), expected);
      assert.ok(expected.length > 0 && expected.length < data.meshNodes.length);
    }
  } finally {
    queue.free();
    graph.free();
  }
});

test('WASM culling retains a sphere whose sheared surface enters the clip volume', () => {
  const angle = Math.PI / 8;
  const graph = new SceneGraph(new Int32Array([-1, 0]), new Float32Array([
    2.000006, 0, 0, 0, 0, 0, 1, 1.000008, 1, 1,
    0, 0, 0, 0, 0, Math.sin(angle), Math.cos(angle), 1, 1, 1,
  ]));
  const queue = new RenderQueue(new Uint32Array([1]), new Uint32Array([0]), new Float32Array([1]), 1);
  try {
    const world = new THREE.Matrix4().fromArray(graph.world_matrices(), 16);
    const point = new THREE.Vector3(-Math.SQRT1_2, Math.SQRT1_2, 0).applyMatrix4(world);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4());
    assert.ok(frustum.containsPoint(point), `inside point: ${point.toArray()}`);
    // The native sphere shortcut shrinks this sheared bound; it is not the correctness oracle.
    assert.equal(frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(), 1).applyMatrix4(world)), false);
    for (const scale of [1e-30, 1, 1e30]) {
      const camera = Float32Array.from(new THREE.Matrix4().elements, (v) => v * scale);
      queue.prepare(graph, camera, true);
      assert.deepEqual(Array.from(queue.visible_nodes()), [1]);
      queue.prepare_direct(graph, camera, true);
      assert.deepEqual(Array.from(queue.visible_nodes()), [1]);
    }
  } finally {
    queue.free();
    graph.free();
  }
});

test('WASM culling handles reciprocal extreme scales and radii', () => {
  for (const scale of [1e-30, 1e30]) {
    const graph = new SceneGraph(new Int32Array([-1, -1]), new Float32Array([
      1.5, 0, 0, 0, 0, 0, 1, scale, scale, scale,
      3, 0, 0, 0, 0, 0, 1, -scale, scale, scale,
    ]));
    const queue = new RenderQueue(new Uint32Array([0, 1]), new Uint32Array(2), new Float32Array(2).fill(1 / scale), 1);
    try {
      const camera = Float32Array.from(new THREE.Matrix4().elements);
      queue.prepare(graph, camera, true);
      assert.deepEqual(Array.from(queue.visible_nodes()), [0]);
      queue.prepare_direct(graph, camera, true);
      assert.deepEqual(Array.from(queue.visible_nodes()), [0]);
    } finally {
      queue.free();
      graph.free();
    }
  }
});

test('WASM packs reflected hierarchies into winding batches without duplicating instances', () => {
  const data = createEngineScene('hierarchy', 500);
  for (let id = 0; id < data.parents.length; id++) {
    if (id % 2) data.transforms[id * 10 + 7] *= -1;
    if (id % 3) data.transforms[id * 10 + 8] *= -1;
  }
  const graph = new SceneGraph(data.parents, data.transforms);
  const queue = new RenderQueue(data.meshNodes, data.groups, data.radii, data.batchGeometries.length);
  const reference = new ThreeGraph({
    parents: data.parents, transforms: data.transforms, colors: new Float32Array(),
  });
  try {
    const groups: number[][] = Array.from({ length: data.batchGeometries.length * 2 }, () => []);
    data.meshNodes.forEach((node, i) => {
      const winding = Number(reference.nodes[node].matrixWorld.determinant() < 0);
      groups[data.groups[i] * 2 + winding].push(node);
    });
    queue.prepare(graph, Float32Array.from(new THREE.Matrix4().elements), false);
    assert.equal(queue.visible_count(), data.meshNodes.length);
    assert.equal(queue.batch_count(), groups.filter((nodes) => nodes.length).length);
    assert.deepEqual(Array.from(queue.batch_counts()), Array.from(data.batchGeometries, (_, group) =>
      groups[group * 2].length + groups[group * 2 + 1].length));
    const matrices = new Float32Array(wasm.memory.buffer, queue.matrices_ptr(), queue.matrices_len());
    close(matrices, groups.flat().flatMap((id) => reference.nodes[id].matrixWorld.elements), 'winding order');
    assert.deepEqual(Array.from(queue.visible_nodes()), Array.from(data.meshNodes));
  } finally {
    queue.free();
    graph.free();
  }
});

test('engine primitives have valid outward-facing triangles', () => {
  for (const geometry of createEngineScene('city', 100).geometries) {
    assert.ok(geometry.indices.length > 0);
    for (let i = 0; i < geometry.indices.length; i += 3) {
      const a = new THREE.Vector3().fromArray(geometry.positions, geometry.indices[i] * 3);
      const b = new THREE.Vector3().fromArray(geometry.positions, geometry.indices[i + 1] * 3);
      const c = new THREE.Vector3().fromArray(geometry.positions, geometry.indices[i + 2] * 3);
      const normal = b.clone().sub(a).cross(c.clone().sub(a));
      assert.ok(
        normal.dot(a.clone().add(b).add(c)) > 0,
        `${geometry.name} triangle ${i / 3} winding`,
      );
    }
  }
});
