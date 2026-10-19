import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`material updates preserve resources and survive context recovery (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const data: EngineScene = {
        name: 'Shared material', scenario: 'city', seed: 0, extent: 1,
        parents: new Int32Array([-1, -1]),
        transforms: new Float32Array([
          -0.45, 0, 0, 0, 0, 0, 1, 0.6, 0.6, 1,
          0.45, 0, 0, 0, 0, 0, 1, 0.6, 0.6, 1,
        ]),
        meshNodes: new Uint32Array([0, 1]), groups: new Uint32Array([0, 0]), radii: new Float32Array([1, 1]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
        geometries: [{ name: 'triangle', radius: 1, positions: new Float32Array([-0.4, -0.4, 0, 0.4, -0.4, 0, 0, 0.4, 0]), indices: new Uint32Array([0, 1, 2]) }],
        materials: [{ name: 'shared', color: [1, 0.2, 0.1], unlit: true }],
      };
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      if (!gl) throw new Error('No WebGL2');
      const allocations = { createProgram: 0, createBuffer: 0, createVertexArray: 0 };
      for (const name of ['createProgram', 'createBuffer', 'createVertexArray'] as const) {
        Object.defineProperty(gl, name, { value: new Proxy(gl[name], {
          apply(target, context, args: unknown[]) {
            allocations[name]++;
            return Reflect.apply(target, context, args);
          },
        }) });
      }
      const engine = new Engine(canvas, data, instanced);
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const camera = { projection: identity, view: identity, viewProjection: identity };
      const capture = () => {
        const stats = engine.frame(0, camera, false);
        const pixels = [70, 185].map((x) => {
          const pixel = new Uint8Array(4);
          gl.readPixels(x, 128, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return Array.from(pixel);
        });
        if (gl.getError()) throw new Error('WebGL error');
        return { pixels, draws: stats.draws, visible: stats.visible };
      };
      const failures: string[] = [];
      const reject = (action: () => void) => {
        try { action(); failures.push('accepted'); } catch (error) { failures.push(String(error)); }
      };
      try {
        const initial = capture(), before = { ...allocations };
        data.materials[0].color = [0, 0, 0];
        data.materials[0].unlit = false;
        const color = [0.1, 0.8, 0.2];
        engine.updateMaterial(0, color, true);
        color.fill(0);
        const green = capture();
        engine.updateMaterial(0, [0.1, 0.8, 0.2], false);
        const lit = capture();
        for (const id of [-1, 0.5, 99]) reject(() => engine.updateMaterial(id, [1, 0, 0], true));
        for (const invalid of [[0, 0], [NaN, 0, 0], [-0.1, 0, 0], [1.1, 0, 0], new Array<number>(3)])
          reject(() => engine.updateMaterial(0, invalid, true));
        const afterInvalid = capture();
        for (let i = 0; i < 64; i++) {
          engine.updateMaterial(0, [i / 63, 0.5, 0.25], true);
          capture();
        }
        const beforeLoss = capture(), after = { ...allocations };
        const extension = gl.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('No context test extension');
        const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
          canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true });
          action();
        });
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        const restored = capture();
        await event('webglcontextlost', () => extension.loseContext());
        reject(() => engine.updateMaterial(0, new Array<number>(3), true));
        engine.updateMaterial(0, [0.2, 0.4, 0.9], true);
        await event('webglcontextrestored', () => extension.restoreContext());
        const changedWhileLost = capture(), generation = engine.context.generation;
        engine.dispose();
        reject(() => engine.updateMaterial(0, [1, 0, 0], true));
        return { initial, green, lit, afterInvalid, beforeLoss, restored, changedWhileLost,
          before, after, generation, failures, source: data.materials[0] };
      } finally { engine.dispose(); }
    }, instanced);
    const check = (capture: typeof result.initial, color: number[]) => {
      expect(capture.draws).toBe(instanced ? 1 : 2);
      expect(capture.visible).toBe(2);
      for (const pixel of capture.pixels) {
        expect(pixel[3]).toBe(255);
        color.forEach((channel, i) => expect(Math.abs(pixel[i] - channel)).toBeLessThanOrEqual(1));
      }
    };
    check(result.initial, [255, 51, 26]);
    check(result.green, [26, 204, 51]);
    const light = 0.42 + 0.58 * 0.6 / Math.sqrt(1.16);
    check(result.lit, [0.1, 0.8, 0.2].map((value) => Math.round(value * light * 255)));
    expect(result.afterInvalid).toEqual(result.lit);
    check(result.beforeLoss, [255, 128, 64]);
    expect(result.restored).toEqual(result.beforeLoss);
    check(result.changedWhileLost, [51, 102, 230]);
    expect(result.after).toEqual(result.before);
    expect(result.generation).toBe(2);
    expect(result.failures).toHaveLength(10);
    for (const failure of result.failures) expect(failure).not.toBe('accepted');
    expect(result.source.color).toEqual([0, 0, 0]);
    expect(result.source.unlit).toBe(false);
  });
}

test('raw material updates keep IDs and reject invalid edits atomically', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const results = await page.evaluate(async () => {
    const { EngineRenderer, SceneGraph, RenderQueue } = await import('../../pkg/three_wasm_rust.js');
    const camera = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const results = [];
    for (const instanced of [false, true]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const graph = new SceneGraph(new Int32Array([-1]), new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
      const queue = new RenderQueue(new Uint32Array([0]), new Uint32Array([0]), new Float32Array([1]), 1);
      const renderer = new EngineRenderer(canvas, 1, instanced);
      try {
        renderer.add_geometry(new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]), new Uint32Array([0, 1, 2]));
        const id = renderer.add_material(new Float32Array([1, 0, 0]), true);
        renderer.set_batches(new Uint32Array([0]), new Uint32Array([id]));
        if (instanced) queue.prepare(graph, camera, false);
        else queue.prepare_direct(graph, camera, false);
        const capture = () => {
          if (instanced) renderer.render(queue, camera);
          else renderer.render_direct(queue, graph, camera);
          const gl = canvas.getContext('webgl2');
          if (!gl) throw new Error('No WebGL2');
          const pixel = new Uint8Array(4);
          gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          if (gl.getError()) throw new Error('WebGL error');
          return Array.from(pixel);
        };
        const before = capture();
        renderer.update_material(id, new Float32Array([0, 1, 0]), true);
        const after = capture(), failures = [];
        for (const [material, color] of [[99, [1, 0, 0]], [id, [1, 0]], [id, [NaN, 0, 0]], [id, [-1, 0, 0]]] as const) {
          try { renderer.update_material(material, Float32Array.from(color), true); failures.push(false); }
          catch { failures.push(true); }
        }
        results.push({ before, after, invalid: capture(), failures, draws: renderer.draw_calls(), visible: queue.visible_count() });
      } finally { renderer.free(); queue.free(); graph.free(); }
    }
    return results;
  });
  for (const result of results) {
    expect(result.before).toEqual([255, 0, 0, 255]);
    expect(result.after).toEqual([0, 255, 0, 255]);
    expect(result.invalid).toEqual(result.after);
    expect(result.failures).toEqual([true, true, true, true]);
    expect(result.draws).toBe(1);
    expect(result.visible).toBe(1);
  }
});
