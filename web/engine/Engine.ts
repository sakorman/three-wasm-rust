import { SceneGraph, RenderQueue, EngineRenderer } from '../../pkg/three_wasm_rust.js';
import { ContextLifecycle } from './ContextLifecycle.ts';
import { validateBounds } from './bounds.ts';
import { geometryBounds } from './geometry.ts';
import type { CameraFrame, EngineScene, SceneBackend, FrameStats, DrawTimer, MaterialData, GpuResourceStats } from './types.ts';

/** The engine path has no Three.js dependency. Call init() from the WASM package first. */
export class Engine implements SceneBackend {
  readonly kind: 'rust' | 'rust-direct';
  readonly gl: WebGL2RenderingContext;
  readonly graph: SceneGraph;
  readonly queue: RenderQueue;
  readonly context: ContextLifecycle;
  private renderer: EngineRenderer | undefined;
  private lastTime = NaN;
  private disposed = false;
  private readonly materials: MaterialData[];
  private readonly geometries: { positions: Float32Array; indices: Uint32Array }[];
  private readonly batchGeometries: Uint32Array;
  private readonly batchMaterials: Uint32Array;

  constructor(
    canvas: HTMLCanvasElement,
    readonly data: EngineScene,
    private readonly instanced = true,
  ) {
    validateBounds(data);
    this.geometries = data.geometries.map((geometry) => ({
      positions: geometry.positions.slice(), indices: geometry.indices.slice(),
    }));
    this.batchGeometries = data.batchGeometries.slice();
    this.batchMaterials = data.batchMaterials.slice();
    this.materials = data.materials.map((material) => ({
      ...material,
      color: [...material.color],
    }));
    this.kind = instanced ? 'rust' : 'rust-direct';
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.graph = new SceneGraph(data.parents, data.transforms);
    try {
      this.queue = new RenderQueue(
        data.meshNodes,
        data.groups,
        data.radii,
        data.batchGeometries.length,
      );
    } catch (error) {
      this.graph.free();
      throw error;
    }
    try {
      if (data.centers) this.queue.set_bounds(data.centers, data.radii);
      this.renderer = this.createRenderer(canvas);
    } catch (error) {
      this.queue.free();
      this.graph.free();
      throw error;
    }
    this.context = new ContextLifecycle(
      gl,
      () => {
        this.renderer = this.createRenderer(canvas);
      },
      () => {
        this.renderer?.free();
        this.renderer = undefined;
      },
    );
  }

  private createRenderer(canvas: HTMLCanvasElement): EngineRenderer {
    const renderer = new EngineRenderer(canvas, this.queue.matrix_capacity(), this.instanced);
    try {
      for (const g of this.geometries) renderer.add_geometry(g.positions, g.indices);
      for (const m of this.materials)
        renderer.add_material(Float32Array.from(m.color), m.unlit);
      renderer.set_batches(this.batchGeometries, this.batchMaterials);
      return renderer;
    } catch (error) {
      renderer.free();
      throw error;
    }
  }

  /** Applies on the next frame; changes made while the context is lost survive restoration. */
  updateMaterial(id: number, color: readonly number[], unlit: boolean): void {
    if (this.disposed || this.context.state === 'disposed') throw new Error('Engine is disposed');
    if (!Number.isInteger(id) || id < 0 || id >= this.materials.length)
      throw new Error('Invalid material id');
    if (color.length !== 3) throw new Error('Invalid material color');
    for (const value of color)
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new Error('Invalid material color');
    const values = Float32Array.from(color);
    if (this.context.ready) {
      if (!this.renderer) throw new Error('GPU resources are unavailable');
      this.renderer.update_material(id, values, unlit);
    }
    this.materials[id] = {
      ...this.materials[id], color: [values[0], values[1], values[2]], unlit,
    };
  }

  /** Deform existing geometry; topology is fixed and affected mesh bounds are recomputed. */
  updateGeometry(id: number, positions: Float32Array): void {
    if (this.disposed || this.context.state === 'disposed') throw new Error('Engine is disposed');
    if (!Number.isInteger(id) || id < 0 || id >= this.geometries.length)
      throw new Error('Invalid geometry id');
    if (positions.length !== this.geometries[id].positions.length)
      throw new Error('Geometry update requires the original vertex count');
    const copy = positions.slice(), bounds = geometryBounds(copy);
    const groups: number[] = [];
    this.batchGeometries.forEach((geometry, group) => {
      if (geometry === id) groups.push(group);
    });
    if (this.context.ready) {
      if (!this.renderer) throw new Error('GPU resources are unavailable');
      this.renderer.update_geometry(id, copy);
    }
    this.queue.set_group_bounds(Uint32Array.from(groups), bounds.center, bounds.radius);
    this.geometries[id].positions = copy;
  }

  /** Replace positions and triangle indices while preserving geometry ID and scene references. */
  replaceGeometry(id: number, positions: Float32Array, indices: Uint32Array): void {
    if (this.disposed || this.context.state === 'disposed') throw new Error('Engine is disposed');
    if (!Number.isInteger(id) || id < 0 || id >= this.geometries.length)
      throw new Error('Invalid geometry id');
    const copy = positions.slice(), indexCopy = indices.slice();
    const bounds = geometryBounds(copy);
    if (!indexCopy.length || indexCopy.length % 3 !== 0 || indexCopy.length > 0x7fffffff ||
        indexCopy.some((index) => index >= copy.length / 3))
      throw new Error('Invalid triangle indices');
    const groups: number[] = [];
    this.batchGeometries.forEach((geometry, group) => {
      if (geometry === id) groups.push(group);
    });
    if (this.context.ready) {
      if (!this.renderer) throw new Error('GPU resources are unavailable');
      this.renderer.replace_geometry(id, copy, indexCopy);
    }
    this.queue.set_group_bounds(Uint32Array.from(groups), bounds.center, bounds.radius);
    this.geometries[id] = { positions: copy, indices: indexCopy };
  }

  frame(time: number, camera: CameraFrame, culling: boolean, timer?: DrawTimer): FrameStats {
    if (this.disposed) throw new Error('Engine is disposed');
    this.context.assertReady();
    const renderer = this.renderer;
    if (!renderer) throw new Error('GPU resources are unavailable');
    const start = performance.now();
    if (time !== this.lastTime) {
      this.graph.animate_nodes(this.data.animatedNodes, time);
      this.lastTime = time;
    }
    if (this.instanced) this.graph.update_world_matrices();
    else this.graph.update_all_world_matrices();
    const afterUpdate = performance.now();
    if (this.instanced) this.queue.prepare(this.graph, camera.viewProjection, culling);
    else this.queue.prepare_direct(this.graph, camera.viewProjection, culling);
    const afterPrepare = performance.now();
    timer?.begin();
    try {
      if (this.instanced) renderer.render(this.queue, camera.viewProjection);
      else renderer.render_direct(this.queue, this.graph, camera.viewProjection);
    } finally {
      timer?.end();
    }
    const end = performance.now();
    return {
      updateMs: afterUpdate - start,
      prepareMs: afterPrepare - afterUpdate,
      submitMs: end - afterPrepare,
      cpuMs: end - start,
      visible: this.queue.visible_count(),
      draws: renderer.draw_calls(),
      triangles: renderer.triangles(),
      updated: this.graph.updated_count(),
    };
  }
  /** Current GPU allocation snapshot. Lost, failed and disposed engines report zero. */
  resourceStats(): GpuResourceStats {
    if (this.disposed || !this.renderer) return {
      ready: false, buffers: 0, vertexArrays: 0, programs: 0,
      vertexBytes: 0, indexBytes: 0, instanceBytes: 0, bufferBytes: 0,
    };
    const stats = this.renderer.resource_stats();
    try {
      return {
        ready: this.context.ready && stats.programs !== 0, buffers: stats.buffers, vertexArrays: stats.vertex_arrays,
        programs: stats.programs, vertexBytes: stats.vertex_bytes, indexBytes: stats.index_bytes,
        instanceBytes: stats.instance_bytes, bufferBytes: stats.buffer_bytes,
      };
    } finally { stats.free(); }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context.dispose();
    this.renderer?.free();
    this.renderer = undefined;
    this.queue.free();
    this.graph.free();
  }
}
