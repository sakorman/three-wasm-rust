import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`geometry updates retain buffers, bounds and restored vertices (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const triangle = (x: number, width = 0.2) => new Float32Array([x - width, -0.2, 0, x + width, -0.2, 0, x, 0.2, 0]);
      const data: EngineScene = {
        name: 'Shared geometry', scenario: 'city', seed: 0, extent: 1,
        parents: new Int32Array([-1, -1, -1]),
        transforms: new Float32Array([
          0, -0.45, 0, 0, 0, 0, 1, 1, 1, 1,
          0, 0.45, 0, 0, 0, 0, 1, 1, 1, 1,
          0, 0, 0, 0, 0, 0, 1, 1, 1, 1,
        ]),
        meshNodes: new Uint32Array([0, 1, 2]), groups: new Uint32Array([0, 1, 2]),
        radii: new Float32Array([0.3, 0.3, 0.3]), centers: new Float32Array([-2, 0, 0, -2, 0, 0, 0.6, 0, 0]),
        batchGeometries: new Uint32Array([0, 0, 1]), batchMaterials: new Uint32Array([0, 1, 2]), animatedNodes: new Uint32Array(),
        geometries: [
          { name: 'moving', radius: 3, positions: triangle(-2), indices: new Uint32Array([0, 1, 2]) },
          { name: 'marker', radius: 1, positions: triangle(0.6), indices: new Uint32Array([0, 1, 2]) },
        ],
        materials: [
          { name: 'red', color: [1, 0, 0], unlit: true },
          { name: 'green', color: [0, 1, 0], unlit: true },
          { name: 'blue', color: [0, 0, 1], unlit: true },
        ],
      };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('No WebGL2');
      const allocations = { createBuffer: 0, createVertexArray: 0, createProgram: 0 };
      for (const name of ['createBuffer', 'createVertexArray', 'createProgram'] as const) {
        Object.defineProperty(gl, name, { value: new Proxy(gl[name], {
          apply(target, context, args: unknown[]) { allocations[name]++; return Reflect.apply(target, context, args); },
        }) });
      }
      const engine = new Engine(canvas, data, instanced);
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const camera = { projection: identity, view: identity, viewProjection: identity };
      const capture = () => {
        const stats = engine.frame(0, camera, true);
        const pixels = [[128, 70], [128, 185], [205, 128]].map(([x, y]) => {
          const pixel = new Uint8Array(4);
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return Array.from(pixel);
        });
        if (gl.getError()) throw new Error('WebGL error');
        return { visible: Array.from(engine.queue.visible_nodes()), draws: stats.draws, triangles: stats.triangles, pixels };
      };
      const failures: string[] = [];
      const reject = (action: () => void) => {
        try { action(); failures.push('accepted'); } catch (error) { failures.push(String(error)); }
      };
      try {
        const initial = capture(), before = { ...allocations };
        const positions = triangle(0);
        engine.updateGeometry(0, positions);
        const invalidated = engine.queue.visible_count() === 0 && engine.queue.matrices_len() === 0;
        positions.fill(50);
        const moved = capture();
        for (const id of [-1, 0.5, 99]) reject(() => engine.updateGeometry(id, triangle(0)));
        for (const invalid of [new Float32Array(6), new Float32Array(9).fill(NaN), new Float32Array(9).fill(Infinity), new Float32Array([-3e38, -3e38, 0, 3e38, 3e38, 0, 0, 0, 0])])
          reject(() => engine.updateGeometry(0, invalid));
        const afterInvalid = capture();
        for (let i = 0; i < 64; i++) { engine.updateGeometry(0, triangle(0, 0.12 + (i % 5) * 0.02)); capture(); }
        engine.updateGeometry(0, new Float32Array(9));
        const degenerate = capture();
        engine.updateGeometry(0, triangle(0));
        const beforeLoss = capture(), after = { ...allocations };
        for (const geometry of data.geometries) { geometry.positions.fill(50); geometry.indices.fill(0); }
        data.batchGeometries.fill(1);
        data.batchMaterials.fill(2);
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('No context test extension');
        const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
          canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
        });
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        const restored = capture();
        await event('webglcontextlost', () => extension.loseContext());
        reject(() => engine.updateGeometry(0, new Float32Array(9).fill(NaN)));
        engine.updateGeometry(0, triangle(-2));
        await event('webglcontextrestored', () => extension.restoreContext());
        const changedWhileLost = capture();
        engine.dispose();
        reject(() => engine.updateGeometry(0, triangle(0)));
        return { initial, moved, afterInvalid, degenerate, beforeLoss, restored, changedWhileLost, before, after, invalidated, failures };
      } finally { engine.dispose(); }
    }, instanced);
    expect(result.initial.visible).toEqual([2]);
    expect(result.moved.visible).toEqual([0, 1, 2]);
    expect(result.moved.draws).toBe(3);
    expect(result.moved.triangles).toBe(3);
    expect(result.moved.pixels).toEqual([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
    expect(result.invalidated).toBe(true);
    expect(result.afterInvalid).toEqual(result.moved);
    expect(result.degenerate.visible).toEqual([0, 1, 2]);
    expect(result.degenerate.pixels[0]).toEqual(result.initial.pixels[0]);
    expect(result.degenerate.pixels[1]).toEqual(result.initial.pixels[1]);
    expect(result.degenerate.pixels[2]).toEqual([0, 0, 255, 255]);
    expect(result.after).toEqual(result.before);
    expect(result.restored).toEqual(result.beforeLoss);
    expect(result.changedWhileLost).toEqual(result.initial);
    expect(result.failures).toHaveLength(9);
    for (const failure of result.failures) expect(failure).not.toBe('accepted');
  });
}

test('raw geometry edits keep topology and reject malformed replacements', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const results = await page.evaluate(async () => {
    const { EngineRenderer, SceneGraph, RenderQueue } = await import('../../pkg/three_wasm_rust.js');
    const camera = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const positions = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]);
    const results = [];
    for (const instanced of [false, true]) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const graph = new SceneGraph(new Int32Array([-1]), new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
      const queue = new RenderQueue(new Uint32Array([0]), new Uint32Array([0]), new Float32Array([1]), 1);
      const renderer = new EngineRenderer(canvas, 1, instanced);
      try {
        renderer.add_geometry(positions, new Uint32Array([0, 1, 2]));
        renderer.add_material(new Float32Array([1, 0, 0]), true);
        renderer.set_batches(new Uint32Array([0]), new Uint32Array([0]));
        if (instanced) queue.prepare(graph, camera, false); else queue.prepare_direct(graph, camera, false);
        const capture = () => {
          if (instanced) renderer.render(queue, camera); else renderer.render_direct(queue, graph, camera);
          const gl = canvas.getContext('webgl2'); if (!gl) throw new Error('No WebGL2');
          const pixel = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          if (gl.getError()) throw new Error('WebGL error'); return Array.from(pixel);
        };
        const before = capture(), shifted = positions.slice();
        for (let i = 0; i < shifted.length; i += 3) shifted[i] += 2;
        renderer.update_geometry(0, shifted);
        const moved = capture(), failures = [];
        for (const [id, values] of [[99, positions], [0, new Float32Array(6)], [0, new Float32Array(9).fill(NaN)]] as const) {
          try { renderer.update_geometry(id, values); failures.push(false); } catch { failures.push(true); }
        }
        const afterInvalid = capture();
        renderer.update_geometry(0, positions);
        results.push({ before, moved, afterInvalid, restored: capture(), failures, triangles: renderer.triangles() });
      } finally { renderer.free(); queue.free(); graph.free(); }
    }
    return results;
  });
  for (const result of results) {
    expect(result.before).toEqual([255, 0, 0, 255]);
    expect(result.moved).not.toEqual(result.before);
    expect(result.afterInvalid).toEqual(result.moved);
    expect(result.restored).toEqual(result.before);
    expect(result.failures).toEqual([true, true, true]);
    expect(result.triangles).toBe(1);
  }
});
