import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const mode of ['direct', 'instanced', 'legacy'] as const) {
  test(`invalid scene state stops GPU submission (${mode})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (mode) => {
      const { SceneGraph, RenderQueue, EngineRenderer, RustRenderer } = await import('../../pkg/three_wasm_rust.js');
      const local = (scale: number) => new Float32Array([0, 0, 0, 0, 0, 0, 1, scale, scale, scale]);
      const graph = new SceneGraph(new Int32Array([-1, 0]), new Float32Array([...local(1), ...local(1)]));
      const queue = new RenderQueue(new Uint32Array([1]), new Uint32Array([0]), new Float32Array([1]), 1);
      const camera = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const positions = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]);
      const indices = new Uint32Array([0, 1, 2]);
      const renderer = mode === 'legacy'
        ? new RustRenderer(canvas, positions, indices, new Float32Array([1, 0.5, 0.2, 1, 0.5, 0.2]))
        : new EngineRenderer(canvas, 1, mode === 'instanced');
      if (renderer instanceof EngineRenderer) {
        renderer.add_geometry(positions, indices);
        renderer.add_material(new Float32Array([1, 0.5, 0.2]), true);
        renderer.set_batches(new Uint32Array([0]), new Uint32Array([0]));
      }
      const gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('No WebGL2');
      let gpuCalls = 0, alive = true;
      for (const method of ['clear', 'bufferSubData', 'uniformMatrix4fv', 'drawElements', 'drawElementsInstanced'] as const) {
        Object.defineProperty(gl, method, { value: new Proxy(gl[method], {
          apply(target, context, args: unknown[]) {
            gpuCalls++;
            return Reflect.apply(target, context, args);
          },
        }) });
      }
      const prepare = () => mode === 'instanced'
        ? queue.prepare(graph, camera, false)
        : queue.prepare_direct(graph, camera, false);
      const render = () => {
        if (renderer instanceof RustRenderer) renderer.render(graph, camera);
        else if (mode === 'instanced') renderer.render(queue, camera);
        else renderer.render_direct(queue, graph, camera);
      };
      const pixels = () => {
        const values = new Uint8Array(128 * 128 * 4);
        gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, values);
        return values;
      };
      const failures: { label: string; message: string; gpuCalls: number }[] = [];
      const reject = (label: string, action: () => void) => {
        const before = gpuCalls;
        let message = 'accepted';
        try { action(); } catch (error) { message = String(error); }
        failures.push({ label, message, gpuCalls: gpuCalls - before });
      };
      try {
        prepare();
        render();
        const expected = pixels();
        if (renderer instanceof EngineRenderer && mode === 'direct') {
          const other = new SceneGraph(new Int32Array([-1, 0]), new Float32Array([...local(1), ...local(1)]));
          try { reject('foreign scene', () => renderer.render_direct(queue, other, camera)); }
          finally { other.free(); }
        }
        graph.set_transform(0, local(1e20));
        reject('pending draw', render);
        reject('pending queue', prepare);
        graph.set_transform(1, local(1e20));
        reject('overflow update', () => graph.update_world_matrices());
        reject('overflow queue', prepare);
        reject('overflow draw', render);
        const invalidVisible = queue.visible_count();
        graph.set_transforms(new Float32Array([...local(1), ...local(1)]));
        graph.update_world_matrices();
        if (mode !== 'legacy') reject('stale repaired queue', render);
        prepare();
        render();
        const actual = pixels();
        let colored = 0, difference = 0;
        for (let i = 0; i < actual.length; i += 4) {
          if (actual[i] > 60) colored++;
          for (let c = 0; c < 3; c++) difference += Math.abs(actual[i + c] - expected[i + c]);
        }
        graph.free();
        alive = false;
        if (renderer instanceof EngineRenderer && mode === 'instanced')
          reject('disposed scene', () => renderer.render(queue, camera));
        return { failures, invalidVisible, freedVisible: queue.visible_count(), colored, difference, error: gl.getError() };
      } finally {
        renderer.free();
        queue.free();
        if (alive) graph.free();
      }
    }, mode);
    for (const failure of result.failures) {
      expect(failure.message, failure.label).not.toBe('accepted');
      expect(failure.gpuCalls, failure.label).toBe(0);
    }
    expect(result.failures.find((f) => f.label === 'overflow update')?.message).toContain('non-finite world matrix');
    expect(result.invalidVisible).toBe(0);
    expect(result.freedVisible).toBe(0);
    expect(result.colored).toBeGreaterThan(1000);
    expect(result.difference).toBe(0);
    expect(result.error).toBe(0);
  });
}

test('Engine resumes after transform overflow without rebuilding GPU resources', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const results = await page.evaluate(async () => {
    const { Engine } = await import('../../web/engine/Engine.ts');
    const local = (scale: number) => new Float32Array([0, 0, 0, 0, 0, 0, 1, scale, scale, scale]);
    const transforms = new Float32Array([...local(1), ...local(1)]);
    const data: EngineScene = {
      name: 'Overflow recovery', scenario: 'hierarchy', seed: 0, extent: 1,
      parents: new Int32Array([-1, 0]), transforms,
      meshNodes: new Uint32Array([1]), groups: new Uint32Array([0]), radii: new Float32Array([1]),
      batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
      geometries: [{ name: 'triangle', radius: 1, positions: new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]), indices: new Uint32Array([0, 1, 2]) }],
      materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
    };
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const frame = { projection: identity, view: identity, viewProjection: identity };
    const results = [];
    for (const instanced of [false, true]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 128;
      const engine = new Engine(canvas, data, instanced);
      try {
        engine.frame(0, frame, false);
        engine.graph.set_transforms(new Float32Array([...local(1e20), ...local(1e20)]));
        let message = 'accepted';
        try { engine.frame(0, frame, false); } catch (error) { message = String(error); }
        const invalidVisible = engine.queue.visible_count();
        engine.graph.set_transforms(transforms);
        const stats = engine.frame(0, frame, false);
        results.push({ instanced, message, invalidVisible, stats, state: engine.context.state, generation: engine.context.generation });
      } finally { engine.dispose(); }
    }
    return results;
  });
  for (const result of results) {
    expect(result.message).toContain('non-finite world matrix');
    expect(result.invalidVisible).toBe(0);
    expect(result.stats.visible).toBe(1);
    expect(result.stats.draws).toBe(1);
    expect(result.state).toBe('ready');
    expect(result.generation).toBe(0);
  }
});
