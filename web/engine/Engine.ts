import { SceneGraph, RenderQueue, EngineRenderer } from '../../pkg/three_wasm_rust.js';
import type { CameraFrame, EngineScene, SceneBackend, FrameStats, DrawTimer } from './types.ts';

/** The engine path has no Three.js dependency. Call init() from the WASM package first. */
export class Engine implements SceneBackend {
  readonly kind: 'rust' | 'rust-direct';
  readonly gl: WebGL2RenderingContext;
  readonly graph: SceneGraph;
  readonly queue: RenderQueue;
  private readonly renderer: EngineRenderer;
  private lastTime = NaN;
  private disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    readonly data: EngineScene,
    private readonly instanced = true,
  ) {
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
      this.renderer = new EngineRenderer(canvas, data.meshNodes.length, instanced);
    } catch (error) {
      this.queue.free();
      this.graph.free();
      throw error;
    }
    try {
      for (const g of data.geometries) this.renderer.add_geometry(g.positions, g.indices);
      for (const m of data.materials)
        this.renderer.add_material(Float32Array.from(m.color), m.unlit);
      this.renderer.set_batches(data.batchGeometries, data.batchMaterials);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  frame(time: number, camera: CameraFrame, culling: boolean, timer?: DrawTimer): FrameStats {
    if (this.disposed) throw new Error('Engine is disposed');
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
      if (this.instanced) this.renderer.render(this.queue, camera.viewProjection);
      else this.renderer.render_direct(this.queue, this.graph, camera.viewProjection);
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
      draws: this.renderer.draw_calls(),
      triangles: this.renderer.triangles(),
      updated: this.graph.updated_count(),
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.free();
    this.queue.free();
    this.graph.free();
  }
}
