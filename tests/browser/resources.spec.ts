import { test, expect } from '@playwright/test';

for (const instanced of [false, true]) {
  test(`resource snapshots match live buffers through edits and recovery (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine, OrbitCamera, createEngineScene } = await import('../../web/engine/index.ts');
      const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 120;
      const gl = canvas.getContext('webgl2'); if (!gl) throw new Error('No WebGL2');
      const live = { Buffer: new Set<unknown>(), VertexArray: new Set<unknown>(), Program: new Set<unknown>() };
      const storage = new Map<unknown, number>();
      let failing = false, storageReads = 0;
      for (const kind of ['Buffer', 'VertexArray', 'Program'] as const) {
        const create = `create${kind}` as const, remove = `delete${kind}` as const;
        Object.defineProperty(gl, create, { value: new Proxy(gl[create], {
          apply(target, context, args: unknown[]) {
            const value: unknown = Reflect.apply(target, context, args);
            if (value) live[kind].add(value);
            return value;
          },
        }) });
        Object.defineProperty(gl, remove, { value: new Proxy(gl[remove], {
          apply(target, context, args: unknown[]) {
            live[kind].delete(args[0]);
            if (kind === 'Buffer') storage.delete(args[0]);
            return Reflect.apply(target, context, args);
          },
        }) });
      }
      Object.defineProperty(gl, 'getBufferParameter', { value: new Proxy(gl.getBufferParameter, {
        apply(target, context, args: unknown[]) { storageReads++; return Reflect.apply(target, context, args); },
      }) });
      Object.defineProperty(gl, 'bufferData', { value: new Proxy(gl.bufferData, {
        apply(target, context, args: unknown[]) {
          if (failing) return;
          Reflect.apply(target, context, args);
          const targetType = args[0] as number;
          const buffer: unknown = gl.getParameter(targetType === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING);
          storage.set(buffer, Number(gl.getBufferParameter(targetType, gl.BUFFER_SIZE)));
        },
      }) });
      canvas.addEventListener('webglcontextlost', () => {
        for (const set of Object.values(live)) set.clear();
        storage.clear();
      });
      const data = createEngineScene('city', 100), engine = new Engine(canvas, data, instanced);
      const camera = new OrbitCamera(); camera.reset(data.extent);
      const triangle = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), triIndices = new Uint32Array([0, 1, 2]);
      const square = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), quadIndices = new Uint32Array([0, 1, 2, 0, 2, 3]);
      const check = () => {
        const reads = storageReads, stats = engine.resourceStats();
        if (reads !== storageReads) throw new Error('Stats queried GPU buffer storage');
        if (stats.buffers !== live.Buffer.size || stats.vertexArrays !== live.VertexArray.size || stats.programs !== live.Program.size ||
            stats.bufferBytes !== [...storage.values()].reduce((sum, bytes) => sum + bytes, 0))
          throw new Error(`Resource mismatch: ${JSON.stringify(stats)}`);
        return stats;
      };
      const draw = () => {
        engine.frame(0, camera.frame(160 / 120), true);
        if (gl.getError()) throw new Error('WebGL error');
      };
      try {
        draw();
        const initial = check();
        const vertexBytes = data.geometries.reduce((sum, g) => sum + g.positions.byteLength, 0);
        const indexBytes = data.geometries.reduce((sum, g) => sum + g.indices.byteLength, 0);
        engine.updateMaterial(0, [0.4, 0.6, 0.2], true);
        engine.updateGeometry(0, data.geometries[0].positions);
        const updated = check();
        engine.replaceGeometry(0, square, quadIndices); draw();
        const grown = check();
        failing = true;
        let rejected = false;
        try { engine.replaceGeometry(0, triangle, triIndices); } catch { rejected = true; }
        failing = false;
        const afterFailure = check();
        const cycles = [];
        for (let i = 0; i < 16; i++) {
          engine.replaceGeometry(0, i % 2 ? square : triangle, i % 2 ? quadIndices : triIndices);
          draw(); cycles.push(check());
        }
        const extension = gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('No context test extension');
        const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
          canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
        });
        let immediateLost;
        await event('webglcontextlost', () => {
          extension.loseContext(); immediateLost = engine.resourceStats();
        });
        const lost = check();
        engine.replaceGeometry(0, triangle, triIndices);
        const editedWhileLost = check();
        await event('webglcontextrestored', () => extension.restoreContext());
        draw(); const restored = check();
        await event('webglcontextlost', () => extension.loseContext());
        failing = true;
        await event('webglcontextrestored', () => extension.restoreContext());
        const failed = check(), state = engine.context.state;
        failing = false;
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        draw(); const retried = check();
        engine.context.dispose();
        const stopped = check();
        engine.dispose(); engine.dispose();
        return { initial, updated, grown, afterFailure, rejected, cycles, immediateLost, lost, editedWhileLost,
          restored, failed, state, retried, stopped, disposed: check(), vertexBytes, indexBytes,
          oldVertexBytes: data.geometries[0].positions.byteLength, oldIndexBytes: data.geometries[0].indices.byteLength,
          geometryCount: data.geometries.length };
      } finally { failing = false; engine.dispose(); camera.dispose(); }
    }, instanced);
    const instanceBytes = instanced ? 6400 : 0;
    const initial = { ready: true, buffers: result.geometryCount * 2 + Number(instanced), vertexArrays: result.geometryCount,
      programs: 1, vertexBytes: result.vertexBytes, indexBytes: result.indexBytes, instanceBytes,
      bufferBytes: result.vertexBytes + result.indexBytes + instanceBytes };
    expect(result.initial).toEqual(initial);
    expect(result.updated).toEqual(initial);
    const grown = { ...initial, vertexBytes: initial.vertexBytes - result.oldVertexBytes + 48,
      indexBytes: initial.indexBytes - result.oldIndexBytes + 24,
      bufferBytes: initial.bufferBytes - result.oldVertexBytes - result.oldIndexBytes + 72 };
    const shrunk = { ...grown, vertexBytes: grown.vertexBytes - 12, indexBytes: grown.indexBytes - 12, bufferBytes: grown.bufferBytes - 24 };
    expect(result.grown).toEqual(grown);
    expect(result.rejected).toBe(true);
    expect(result.afterFailure).toEqual(grown);
    result.cycles.forEach((snapshot, i) => expect(snapshot).toEqual(i % 2 ? grown : shrunk));
    expect(result.restored).toEqual(shrunk);
    expect(result.retried).toEqual(shrunk);
    expect(result.stopped).toEqual({ ...shrunk, ready: false });
    expect(result.state).toBe('failed');
    for (const snapshot of [result.immediateLost, result.lost, result.editedWhileLost, result.failed, result.disposed])
      expect(snapshot).toEqual({ ready: false, buffers: 0, vertexArrays: 0, programs: 0,
        vertexBytes: 0, indexBytes: 0, instanceBytes: 0, bufferBytes: 0 });
  });
}

test('raw resource snapshots keep zero-capacity buffers and independent lifetimes', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { EngineRenderer } = await import('../../pkg/three_wasm_rust.js');
    const canvas = document.createElement('canvas'), renderer = new EngineRenderer(canvas, 0, true);
    const empty = renderer.resource_stats();
    renderer.add_geometry(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]));
    const filled = renderer.resource_stats();
    const gl = canvas.getContext('webgl2')!, extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('No context test extension');
    const lostEvent = new Promise<void>((resolve) => canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); resolve(); }, { once: true }));
    extension.loseContext();
    const lost = renderer.resource_stats();
    await lostEvent;
    renderer.free();
    try {
      return { empty: [empty.buffers, empty.vertex_arrays, empty.buffer_bytes, empty.instance_bytes],
        filled: [filled.buffers, filled.vertex_arrays, filled.buffer_bytes], lost: [lost.buffers, lost.programs, lost.buffer_bytes] };
    } finally { empty.free(); filled.free(); lost.free(); }
  });
  expect(result.empty).toEqual([1, 0, 0, 0]);
  expect(result.filled).toEqual([3, 1, 48]);
  expect(result.lost).toEqual([0, 0, 0]);
});
