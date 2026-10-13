import * as THREE from 'three';
import { ContextLifecycle } from '../engine/ContextLifecycle.ts';
import meshVertex from '../engine/shaders/mesh.vert?raw';
import instanceVertex from '../engine/shaders/instanced.vert?raw';
import fragmentShader from '../engine/shaders/surface.frag?raw';
import type {
  CameraFrame,
  EngineScene,
  FrameStats,
  SceneBackend,
  DrawTimer,
} from '../engine/types.ts';

/** Native Mesh and an explicitly optimized InstancedMesh reference, both using Three.js. */
export class ThreeBackend implements SceneBackend {
  readonly gl: WebGL2RenderingContext;
  readonly context: ContextLifecycle;
  private disposed = false;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly root = new THREE.Group();
  private readonly camera = new THREE.Camera();
  private readonly vp = new THREE.Uniform(new THREE.Matrix4());
  private readonly nodes: THREE.Object3D[];
  private readonly geometries: THREE.BufferGeometry[];
  private readonly materials: THREE.RawShaderMaterial[];
  private readonly mirroredMaterials: THREE.RawShaderMaterial[];
  private readonly batches: THREE.InstancedMesh[] = [];
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  private readonly counts: Uint32Array;
  private lastTime = NaN;

  constructor(
    canvas: HTMLCanvasElement,
    readonly data: EngineScene,
    readonly kind: 'three' | 'instanced',
  ) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: false });
    // Three.js registered its own restore handler above; it recreates its GL state first.
    this.context = new ContextLifecycle(gl, () => this.resetClearColor());
    // The direct pair draws in scene traversal order, without material/depth sorting.
    this.renderer.sortObjects = kind !== 'three';
    this.resetClearColor();
    this.scene.matrixWorldAutoUpdate = false;
    this.root.matrixAutoUpdate = kind === 'three';
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.geometries = data.geometries.map((g) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(g.indices, 1));
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), g.radius);
      return geometry;
    });
    this.materials = data.materials.map(
      (m) =>
        new THREE.RawShaderMaterial({
          vertexShader: kind === 'three' ? meshVertex : instanceVertex,
          fragmentShader,
          glslVersion: THREE.GLSL3,
          uniforms: {
            viewProjection: this.vp,
            baseColor: new THREE.Uniform(new THREE.Vector3(...m.color)),
            unlit: new THREE.Uniform(m.unlit ? 1 : 0),
          },
        }),
    );
    // InstancedMesh has one winding state per draw, so reflected instances need a separate batch.
    this.mirroredMaterials =
      kind === 'instanced'
        ? this.materials.map((material) => {
            const mirrored = material.clone();
            mirrored.side = THREE.BackSide;
            mirrored.uniforms.viewProjection = this.vp;
            return mirrored;
          })
        : [];
    const meshIndex = new Map(Array.from(data.meshNodes, (node, i) => [node, i]));
    this.nodes = Array.from(data.parents, (_, id) => {
      const index = meshIndex.get(id),
        group = index === undefined ? undefined : data.groups[index];
      const node =
        kind === 'three' && group !== undefined
          ? new THREE.Mesh(
              this.geometries[data.batchGeometries[group]],
              this.materials[data.batchMaterials[group]],
            )
          : new THREE.Object3D();
      node.position.fromArray(data.transforms, id * 10);
      node.quaternion.fromArray(data.transforms, id * 10 + 3).normalize();
      node.scale.fromArray(data.transforms, id * 10 + 7);
      node.updateMatrix();
      node.matrixAutoUpdate = kind === 'three';
      return node;
    });
    data.parents.forEach((parent, id) => {
      (parent === -1 ? this.root : this.nodes[parent]).add(this.nodes[id]);
    });
    this.root.updateMatrixWorld(true);
    this.counts = new Uint32Array(data.batchGeometries.length * 2);
    if (kind === 'three') this.scene.add(this.root);
    else {
      for (const group of data.groups) this.counts[group * 2]++;
      data.batchGeometries.forEach((geometry, group) => {
        for (const materials of [this.materials, this.mirroredMaterials]) {
          const mesh = new THREE.InstancedMesh(
            this.geometries[geometry],
            materials[data.batchMaterials[group]],
            this.counts[group * 2],
          );
          mesh.frustumCulled = false;
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          this.batches.push(mesh);
          this.scene.add(mesh);
        }
      });
    }
  }

  private resetClearColor() {
    this.renderer.setClearColor(
      new THREE.Color().setRGB(0.035, 0.055, 0.075, THREE.SRGBColorSpace),
      1,
    );
  }

  frame(time: number, frame: CameraFrame, culling: boolean, timer?: DrawTimer): FrameStats {
    this.context.assertReady();
    const start = performance.now();
    if (time !== this.lastTime) {
      const seconds = Math.fround(time);
      for (const id of this.data.animatedNodes) {
        const angle = Math.fround(
          Math.fround(seconds * Math.fround(0.2)) + Math.fround((id % 19) * Math.fround(0.03)),
        );
        const node = this.nodes[id];
        node.quaternion.set(0, Math.sin(angle), 0, Math.cos(angle));
        if (this.kind === 'instanced') node.updateMatrix();
      }
      this.lastTime = time;
    }
    this.root.updateMatrixWorld();
    const afterUpdate = performance.now();
    this.vp.value.fromArray(frame.viewProjection);
    this.camera.projectionMatrix.fromArray(frame.projection);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.camera.matrixWorldInverse.fromArray(frame.view);
    this.camera.matrixWorld.copy(this.camera.matrixWorldInverse).invert();
    let visible = 0;
    if (this.kind === 'instanced') {
      this.frustum.setFromProjectionMatrix(this.vp.value);
      this.counts.fill(0);
      for (let i = 0; i < this.data.meshNodes.length; i++) {
        const node = this.nodes[this.data.meshNodes[i]];
        this.sphere.center.set(0, 0, 0);
        this.sphere.radius = this.data.radii[i];
        this.sphere.applyMatrix4(node.matrixWorld);
        if (culling && !this.frustum.intersectsSphere(this.sphere)) continue;
        const group = this.data.groups[i] * 2 + Number(node.matrixWorld.determinant() < 0);
        this.batches[group].setMatrixAt(this.counts[group]++, node.matrixWorld);
        visible++;
      }
      for (let group = 0; group < this.batches.length; group++) {
        const mesh = this.batches[group];
        mesh.count = this.counts[group];
        mesh.visible = mesh.count > 0;
        mesh.instanceMatrix.clearUpdateRanges();
        if (mesh.count > 0) {
          mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    } else for (const id of this.data.meshNodes) this.nodes[id].frustumCulled = culling;
    const afterPrepare = performance.now();
    // Use identical drawing buffer dimensions; setSize is only needed after a resize.
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== this.gl.canvas.width || size.y !== this.gl.canvas.height)
      this.renderer.setSize(this.gl.canvas.width, this.gl.canvas.height, false);
    timer?.begin();
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      timer?.end();
    }
    const end = performance.now(),
      info = this.renderer.info.render;
    return {
      updateMs: afterUpdate - start,
      prepareMs: afterPrepare - afterUpdate,
      submitMs: end - afterPrepare,
      cpuMs: end - start,
      visible: this.kind === 'three' ? info.calls : visible,
      draws: info.calls,
      triangles: info.triangles,
      updated: this.kind === 'three' ? this.data.parents.length : null,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context.dispose();
    for (const mesh of this.batches) mesh.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const m of this.mirroredMaterials) m.dispose();
    this.renderer.dispose();
  }
}
