import * as THREE from 'three';

/** Fixed seed + identical Float32 inputs for all backends. */
export function createSceneData(count, seed = 2026) {
  if (!Number.isInteger(count) || count < 0 || count > 100_000) throw new RangeError('Invalid node count');
  let state = seed >>> 0;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
  const parents = new Int32Array(count);
  const transforms = new Float32Array(count * 10);
  const colors = new Float32Array(count * 3);
  const palette = [[0.91, 0.52, 0.28], [0.98, 0.73, 0.42], [0.34, 0.7, 0.71], [0.63, 0.81, 0.78]];
  for (let i = 0; i < count; i++) {
    const root = i % 16 === 0;
    parents[i] = root ? -1 : i - i % 16;
    const angle = random() * Math.PI * 2;
    const radius = root ? 10 + random() * 24 : 1 + random() * 5;
    const scale = root ? 0.85 : 0.25 + random() * 0.55;
    transforms.set([
      Math.cos(angle) * radius, (random() - 0.5) * (root ? 24 : 8), Math.sin(angle) * radius,
      0, 0, 0, 1, scale, scale, scale,
    ], i * 10);
    colors.set(palette[Math.floor(random() * palette.length)], i * 3);
  }
  return { parents, transforms, colors };
}

/** Uses the actual Three.js Object3D implementation as the reference. */
export class ThreeGraph {
  constructor({ parents, transforms }) {
    this.nodes = Array.from(parents, (_, i) => {
      const node = new THREE.Object3D();
      const offset = i * 10;
      node.position.fromArray(transforms, offset);
      node.quaternion.fromArray(transforms, offset + 3).normalize();
      node.scale.fromArray(transforms, offset + 7);
      return node;
    });
    this.roots = [];
    parents.forEach((parent, i) => {
      if (parent === -1) this.roots.push(this.nodes[i]);
      else this.nodes[parent].add(this.nodes[i]);
    });
    this.output = new Float32Array(parents.length * 16);
    this.updateWorldMatrices();
  }

  updateWorldMatrices() {
    for (const root of this.roots) root.updateMatrixWorld(true);
  }

  animateDemo(seconds) {
    const t = Math.fround(seconds);
    const sx = Math.sin(t * 0.125), cx = Math.cos(t * 0.125);
    for (let i = 0; i < this.nodes.length; i++) {
      const halfY = Math.fround(Math.fround(t * 0.2) + Math.fround(i * Math.fround(0.0065)));
      const sy = Math.sin(halfY), cy = Math.cos(halfY);
      this.nodes[i].quaternion.set(sx * cy, cx * sy, -sx * sy, cx * cy);
    }
    this.updateWorldMatrices();
  }

  worldMatrices() {
    for (let i = 0; i < this.nodes.length; i++) this.nodes[i].matrixWorld.toArray(this.output, i * 16);
    return this.output;
  }
}

/** Do not retain this borrowed view across allocations or graph.free(). */
export function matrixView(wasm, graph) {
  const pointer = graph.matrices_ptr();
  const length = graph.matrices_len();
  return new Float32Array(wasm.memory.buffer, pointer, length);
}
