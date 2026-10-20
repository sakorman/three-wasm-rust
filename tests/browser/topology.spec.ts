import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`topology replacement preserves references and rolls back allocation failures (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const triangle = (x: number) => new Float32Array([x - 0.2, -0.2, 0, x + 0.2, -0.2, 0, x, 0.2, 0]);
      const square = new Float32Array([-0.2, -0.2, 0, 0.2, -0.2, 0, 0.2, 0.2, 0, -0.2, 0.2, 0]);
      const triangleIndices = new Uint32Array([0, 1, 2]), squareIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
      const data: EngineScene = {
        name: 'Topology', scenario: 'city', seed: 0, extent: 1,
        parents: new Int32Array([-1, -1, -1]),
        transforms: new Float32Array([
          0, -0.45, 0, 0, 0, 0, 1, 1, 1, 1,
          0, 0.45, 0, 0, 0, 0, 1, 1, 1, 1,
          0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
        ]),
        meshNodes: new Uint32Array([0, 1, 2]), groups: new Uint32Array([0, 1, 2]),
        centers: new Float32Array([-2, 0, 0, -2, 0, 0, 0.6, 0, 0]), radii: new Float32Array([0.3, 0.3, 0.3]),
        batchGeometries: new Uint32Array([0, 0, 1]), batchMaterials: new Uint32Array([0, 1, 2]), animatedNodes: new Uint32Array(),
        geometries: [
          { name: 'shared', positions: triangle(-2), indices: triangleIndices.slice(), radius: 3 },
          { name: 'marker', positions: triangle(0.6), indices: triangleIndices.slice(), radius: 1 },
        ],
        materials: [
          { name: 'red', color: [1, 0, 0], unlit: true },
          { name: 'green', color: [0, 1, 0], unlit: true },
          { name: 'blue', color: [0, 0, 1], unlit: true },
        ],
      };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('No WebGL2');
      const live = { Buffer: new Set<unknown>(), VertexArray: new Set<unknown>(), Program: new Set<unknown>() };
      let fault = '', seen = 0, programs = 0;
      for (const kind of ['Buffer', 'VertexArray', 'Program'] as const) {
        const createName = `create${kind}` as const, deleteName = `delete${kind}` as const;
        Object.defineProperty(gl, createName, { value: new Proxy(gl[createName], {
          apply(target, context, args: unknown[]) {
            if (fault === 'vao' && kind === 'VertexArray') return null;
            if (kind === 'Buffer' && (fault === 'vertex' || fault === 'index')) {
              seen++;
              if (seen === (fault === 'vertex' ? 1 : 2)) return null;
            }
            const value: unknown = Reflect.apply(target, context, args);
            if (value) live[kind].add(value);
            if (kind === 'Program') programs++;
            return value;
          },
        }) });
        Object.defineProperty(gl, deleteName, { value: new Proxy(gl[deleteName], {
          apply(target, context, args: unknown[]) { live[kind].delete(args[0]); return Reflect.apply(target, context, args); },
        }) });
      }
      Object.defineProperty(gl, 'bufferData', { value: new Proxy(gl.bufferData, {
        apply(target, context, args: unknown[]) {
          if ((fault === 'vertex-storage' && args[0] === gl.ARRAY_BUFFER) ||
              (fault === 'index-storage' && args[0] === gl.ELEMENT_ARRAY_BUFFER)) return;
          return Reflect.apply(target, context, args);
        },
      }) });
      canvas.addEventListener('webglcontextlost', () => { for (const objects of Object.values(live)) objects.clear(); });
      const counts = () => ({ buffers: live.Buffer.size, vaos: live.VertexArray.size, programs: live.Program.size });
      const engine = new Engine(canvas, data, instanced);
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const frame = { projection: identity, view: identity, viewProjection: identity };
      const capture = () => {
        const stats = engine.frame(0, frame, true);
        const pixels = [[128, 70], [128, 185], [205, 128]].map(([x, y]) => {
          const pixel = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); return Array.from(pixel);
        });
        if (gl.getError()) throw new Error('WebGL error');
        return { visible: Array.from(engine.queue.visible_nodes()), draws: stats.draws, triangles: stats.triangles, pixels };
      };
      const rejected: { message: string; view: ReturnType<typeof capture>; resources: ReturnType<typeof counts> }[] = [];
      const reject = (action: () => void) => {
        let message = 'accepted';
        try { action(); } catch (error) { message = String(error); }
        fault = '';
        rejected.push({ message, view: capture(), resources: counts() });
      };
      try {
        const initial = capture(), baseline = counts();
        const input = square.slice(), indices = squareIndices.slice();
        engine.replaceGeometry(0, input, indices);
        const invalidated = engine.queue.visible_count() === 0;
        input.fill(100); indices.fill(0);
        const grown = capture();
        for (const id of [-1, 0.5, 99]) reject(() => engine.replaceGeometry(id, square, squareIndices));
        for (const invalid of [new Uint32Array(), new Uint32Array([0, 1]), new Uint32Array([0, 1, 4])])
          reject(() => engine.replaceGeometry(0, square, invalid));
        reject(() => engine.replaceGeometry(0, new Float32Array(12).fill(NaN), squareIndices));
        for (const mode of ['vao', 'vertex', 'index', 'vertex-storage', 'index-storage']) {
          fault = mode; seen = 0;
          reject(() => engine.replaceGeometry(0, triangle(-2), triangleIndices));
        }
        const cycles = [];
        for (let i = 0; i < 32; i++) {
          engine.replaceGeometry(0, i % 2 ? square : triangle(-2), i % 2 ? squareIndices : triangleIndices);
          cycles.push({ triangles: capture().triangles, resources: counts() });
        }
        // In-place updates now accept the new vertex count and keep the new index topology.
        engine.updateGeometry(0, square.slice());
        const beforeLoss = capture(), programsBeforeLoss = programs;
        for (const geometry of data.geometries) { geometry.positions.fill(50); geometry.indices.fill(0); }
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('No context test extension');
        const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
          canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
        });
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        const restored = capture();
        await event('webglcontextlost', () => extension.loseContext());
        engine.replaceGeometry(0, triangle(-2), triangleIndices);
        let lostRejected = false;
        try { engine.replaceGeometry(0, square, new Uint32Array([0, 1, 4])); } catch { lostRejected = true; }
        await event('webglcontextrestored', () => extension.restoreContext());
        const replacedWhileLost = capture();
        engine.dispose();
        let disposedRejected = false;
        try { engine.replaceGeometry(0, square, squareIndices); } catch { disposedRejected = true; }
        return { initial, baseline, grown, invalidated, rejected, cycles, beforeLoss, restored,
          replacedWhileLost, programsBeforeLoss, lostRejected, disposedRejected, afterDispose: counts() };
      } finally { fault = ''; engine.dispose(); }
    }, instanced);
    expect(result.initial.visible).toEqual([2]);
    expect(result.invalidated).toBe(true);
    expect(result.grown.visible).toEqual([0, 1, 2]);
    expect(result.grown.triangles).toBe(5);
    expect(result.grown.draws).toBe(3);
    expect(result.grown.pixels).toEqual([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
    expect(result.rejected).toHaveLength(12);
    for (const rejected of result.rejected) {
      expect(rejected.message).not.toBe('accepted');
      expect(rejected.view).toEqual(result.grown);
      expect(rejected.resources).toEqual(result.baseline);
    }
    result.cycles.forEach((cycle, i) => {
      expect(cycle.triangles).toBe(i % 2 ? 5 : 1);
      expect(cycle.resources).toEqual(result.baseline);
    });
    expect(result.programsBeforeLoss).toBe(1);
    expect(result.restored).toEqual(result.beforeLoss);
    expect(result.replacedWhileLost).toEqual(result.initial);
    expect(result.lostRejected && result.disposedRejected).toBe(true);
    expect(result.afterDispose).toEqual({ buffers: 0, vaos: 0, programs: 0 });
  });
}

test('raw topology replacement updates draw counts and validates before allocating', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const results = await page.evaluate(async () => {
    const { EngineRenderer, SceneGraph, RenderQueue } = await import('../../pkg/three_wasm_rust.js');
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const triangle = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
    const square = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    const results = [];
    for (const instanced of [false, true]) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const graph = new SceneGraph(new Int32Array([-1]), new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
      const queue = new RenderQueue(new Uint32Array([0]), new Uint32Array([0]), new Float32Array([1]), 1);
      const renderer = new EngineRenderer(canvas, 1, instanced);
      try {
        renderer.add_geometry(triangle, new Uint32Array([0, 1, 2]));
        renderer.add_material(new Float32Array([1, 0, 0]), true);
        renderer.set_batches(new Uint32Array([0]), new Uint32Array([0]));
        if (instanced) queue.prepare(graph, identity, false); else queue.prepare_direct(graph, identity, false);
        const capture = () => {
          if (instanced) renderer.render(queue, identity); else renderer.render_direct(queue, graph, identity);
          const gl = canvas.getContext('webgl2'); if (!gl) throw new Error('No WebGL2');
          const pixel = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          if (gl.getError()) throw new Error('WebGL error');
          return { triangles: renderer.triangles(), pixel: Array.from(pixel) };
        };
        const before = capture();
        renderer.replace_geometry(0, square, new Uint32Array([0, 1, 2, 0, 2, 3]));
        const grown = capture(), rejected = [];
        const gl = canvas.getContext('webgl2')!;
        let allocations = 0;
        Object.defineProperty(gl, 'createVertexArray', { value: new Proxy(gl.createVertexArray, {
          apply(target, context, args: unknown[]) { allocations++; return Reflect.apply(target, context, args); },
        }) });
        for (const [id, positions, indices] of [
          [99, triangle, new Uint32Array([0, 1, 2])],
          [0, new Float32Array(8), new Uint32Array([0, 1, 2])],
          [0, triangle, new Uint32Array([0, 1, 3])],
          [0, triangle, new Uint32Array([0, 1])],
          [0, new Float32Array(9).fill(NaN), new Uint32Array([0, 1, 2])],
        ] as const) {
          try { renderer.replace_geometry(id, positions, indices); rejected.push(false); } catch { rejected.push(true); }
        }
        const unchanged = capture(), failedAllocations = allocations;
        renderer.replace_geometry(0, triangle, new Uint32Array([0, 1, 2]));
        results.push({ before, grown, unchanged, shrunk: capture(), failedAllocations, rejected });
      } finally { renderer.free(); queue.free(); graph.free(); }
    }
    return results;
  });
  for (const result of results) {
    expect(result.before.triangles).toBe(1);
    expect(result.grown).toEqual({ triangles: 2, pixel: [255, 0, 0, 255] });
    expect(result.unchanged).toEqual(result.grown);
    expect(result.shrunk).toEqual(result.before);
    expect(result.failedAllocations).toBe(0);
    expect(result.rejected).toEqual([true, true, true, true, true]);
  }
});
