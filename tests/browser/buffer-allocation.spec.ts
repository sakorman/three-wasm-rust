import { test, expect } from '@playwright/test';

for (const mode of ['engine', 'legacy'] as const) {
  test(`buffer storage failure rejects renderer construction and releases resources (${mode})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const results = await page.evaluate(async (mode) => {
      const { EngineRenderer, RustRenderer, SceneGraph, RenderQueue } = await import('../../pkg/three_wasm_rust.js');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const gl = canvas.getContext('webgl2'); if (!gl) throw new Error('No WebGL2');
      const live = { Buffer: new Set<unknown>(), VertexArray: new Set<unknown>(), Program: new Set<unknown>(), Shader: new Set<unknown>() };
      for (const kind of ['Buffer', 'VertexArray', 'Program', 'Shader'] as const) {
        const create = `create${kind}` as const, remove = `delete${kind}` as const;
        Object.defineProperty(gl, create, { value: new Proxy(gl[create], {
          apply(target, context, args: unknown[]) {
            const value: unknown = Reflect.apply(target, context, args); if (value) live[kind].add(value); return value;
          },
        }) });
        Object.defineProperty(gl, remove, { value: new Proxy(gl[remove], {
          apply(target, context, args: unknown[]) { live[kind].delete(args[0]); return Reflect.apply(target, context, args); },
        }) });
      }
      const counts = () => Object.fromEntries(Object.entries(live).map(([name, values]) => [name, values.size]));
      let failedUpload = 0, uploads = 0;
      Object.defineProperty(gl, 'bufferData', { value: new Proxy(gl.bufferData, {
        apply(target, context, args: unknown[]) {
          uploads++;
          if (uploads === failedUpload) return;
          return Reflect.apply(target, context, args);
        },
      }) });
      const positions = new Float32Array([-0.6, -0.6, 0, 0.6, -0.6, 0, 0, 0.6, 0]);
      const indices = new Uint32Array([0, 1, 2]);
      const camera = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const create = (empty = false) => mode === 'engine'
        ? new EngineRenderer(canvas, empty ? 0 : 1, true)
        : new RustRenderer(canvas, positions, indices, empty ? new Float32Array() : new Float32Array([1, 0, 0]));
      const render = (renderer: ReturnType<typeof create>, empty = false) => {
        const graph = new SceneGraph(empty ? new Int32Array() : new Int32Array([-1]),
          empty ? new Float32Array() : new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]));
        const queue = new RenderQueue(empty ? new Uint32Array() : new Uint32Array([0]),
          empty ? new Uint32Array() : new Uint32Array([0]), empty ? new Float32Array() : new Float32Array([1]), 1);
        try {
          if (renderer instanceof EngineRenderer) {
            renderer.add_geometry(positions, indices);
            renderer.add_material(new Float32Array([1, 0, 0]), true);
            renderer.set_batches(new Uint32Array([0]), new Uint32Array([0]));
            queue.prepare(graph, camera, false);
            renderer.render(queue, camera);
          } else renderer.render(graph, camera);
          const pixel = new Uint8Array(4); gl.readPixels(64, 64, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return { pixel: Array.from(pixel), error: gl.getError() };
        } finally { queue.free(); graph.free(); }
      };
      const results = [];
      for (const ordinal of (mode === 'engine' ? [1] : [1, 2, 3, 4])) {
        uploads = 0; failedUpload = ordinal;
        let message = 'accepted';
        try { create().free(); } catch (error) { message = String(error); }
        const remaining = counts();
        failedUpload = 0;
        const renderer = create();
        let restored;
        try { restored = render(renderer); } finally { renderer.free(); }
        results.push({ ordinal, message, remaining, restored, afterDispose: counts() });
      }
      const empty = create(true);
      try {
        const result = render(empty, true);
        if (result.error || result.pixel[0] > 60) throw new Error('Zero-capacity renderer failed');
      } finally { empty.free(); }
      return results;
    }, mode);
    for (const result of results) {
      expect(result.message, `upload ${result.ordinal}`).not.toBe('accepted');
      expect(result.message).toContain('allocation failed');
      expect(Object.values(result.remaining)).toEqual([0, 0, 0, 0]);
      expect(Object.values(result.afterDispose)).toEqual([0, 0, 0, 0]);
      expect(result.restored.error).toBe(0);
      expect(result.restored.pixel[0]).toBeGreaterThan(100);
    }
  });
}

test('failed instance storage during restoration keeps the Engine unavailable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { Engine, OrbitCamera, createEngineScene } = await import('../../web/engine/index.ts');
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
    const data = createEngineScene('city', 100), camera = new OrbitCamera(); camera.reset(data.extent);
    const frame = camera.frame(160 / 120), engine = new Engine(canvas, data, true), gl = engine.gl;
    engine.frame(0, frame, false);
    let failing = false, draws = 0;
    Object.defineProperty(gl, 'bufferData', { value: new Proxy(gl.bufferData, {
      apply(target, context, args: unknown[]) {
        if (failing && typeof args[1] === 'number') return;
        return Reflect.apply(target, context, args);
      },
    }) });
    Object.defineProperty(gl, 'drawElementsInstanced', { value: new Proxy(gl.drawElementsInstanced, {
      apply(target, context, args: unknown[]) { draws++; return Reflect.apply(target, context, args); },
    }) });
    const extension = gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('No test extension');
    const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    try {
      await event('webglcontextlost', () => extension.loseContext());
      failing = true;
      await event('webglcontextrestored', () => extension.restoreContext());
      let rejection = 'accepted';
      try { engine.frame(0, frame, false); } catch (error) { rejection = String(error); }
      const state = engine.context.state, error = String(engine.context.error), failedDraws = draws;
      engine.dispose(); failing = false;
      const replacement = new Engine(canvas, data, true);
      try {
        const stats = replacement.frame(0, frame, false);
        return { state, error, rejection, failedDraws, visible: stats.visible, draws: stats.draws, glError: gl.getError() };
      } finally { replacement.dispose(); }
    } finally { engine.dispose(); camera.dispose(); }
  });
  expect(result.state).toBe('failed');
  expect(result.error).toContain('allocation failed');
  expect(result.rejection).toContain('failed');
  expect(result.failedDraws).toBe(0);
  expect(result.visible).toBe(100);
  expect(result.draws).toBeGreaterThan(0);
  expect(result.glError).toBe(0);
});
