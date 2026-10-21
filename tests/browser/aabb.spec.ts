import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`world AABBs enclose rendered pixels without changing resources (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine, box } = await import('../../web/engine/index.ts');
      const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
      const data: EngineScene = {
        name: 'AABB', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1, 0]),
        transforms: new Float32Array([
          -0.1, 0.05, 0, 0, 0, Math.sin(0.15), Math.cos(0.15), 0.9, 0.3, 0.5,
          0, 0, 0, 0, 0, Math.sin(0.3), Math.cos(0.3), -1, 1, 1,
        ]),
        meshNodes: new Uint32Array([1]), groups: new Uint32Array([0]), radii: new Float32Array([1]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]),
        animatedNodes: new Uint32Array(), geometries: [box()],
        materials: [{ name: 'red', color: [1, 0, 0], unlit: true }],
      };
      const canvases = [document.createElement('canvas'), document.createElement('canvas')];
      for (const canvas of canvases) canvas.width = canvas.height = 192;
      const engine = new Engine(canvases[0], data, instanced);
      const reference = new ThreeBackend(canvases[1], data, instanced ? 'instanced' : 'three');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const camera = { projection: identity, view: identity, viewProjection: identity };
      const local = new Float32Array([-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]);
      const capture = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(192 * 192 * 4);
        gl.readPixels(0, 0, 192, 192, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      const enclosed = (bounds: Float32Array, pixels: Uint8Array) => {
        let colored = 0;
        for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) {
          if (pixels[(y * 192 + x) * 4] < 100) continue;
          colored++;
          const nx = (x + 0.5) / 96 - 1, ny = (y + 0.5) / 96 - 1, margin = 1 / 96;
          if (nx < bounds[0] - margin || nx > bounds[3] + margin || ny < bounds[1] - margin || ny > bounds[4] + margin)
            throw new Error('Rendered pixel lies outside world AABB');
        }
        return colored;
      };
      try {
        engine.frame(0, camera, false); reference.frame(0, camera, false);
        const beforeResources = engine.resourceStats();
        const before = engine.graph.world_aabbs(data.meshNodes, local);
        const a = capture(engine.gl), b = capture(reference.gl);
        let difference = 0;
        for (let i = 0; i < a.length; i++) if (i % 4 !== 3) difference += Math.abs(a[i] - b[i]);
        const colored = enclosed(before, a), referenceColored = enclosed(before, b);
        const visible = engine.queue.visible_count();
        const transform = data.transforms.slice(0, 10); transform[0] += 0.125;
        engine.graph.set_transform(0, transform);
        let pendingRejected = false;
        try { engine.graph.world_aabbs(data.meshNodes, local); } catch { pendingRejected = true; }
        engine.frame(0, camera, false);
        const after = engine.graph.world_aabbs(data.meshNodes, local);
        const movedColored = enclosed(after, capture(engine.gl));
        const afterResources = engine.resourceStats();
        engine.dispose();
        return { before: Array.from(before), after: Array.from(after), pendingRejected, visible,
          colored, referenceColored, movedColored, difference: difference / (192 * 192 * 3),
          beforeResources, afterResources };
      } finally { engine.dispose(); reference.dispose(); }
    }, instanced);
    expect(result.pendingRejected).toBe(true);
    expect(result.visible).toBe(1);
    expect(result.difference).toBeLessThan(0.1);
    for (const count of [result.colored, result.referenceColored, result.movedColored]) expect(count).toBeGreaterThan(1000);
    expect(result.after[0] - result.before[0]).toBeCloseTo(0.125, 6);
    expect(result.after[3] - result.before[3]).toBeCloseTo(0.125, 6);
    expect(result.afterResources).toEqual(result.beforeResources);
  });
}
