import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`triangle queries select visible surfaces instead of empty box corners (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine, ray_triangle_hits, ray_aabb_intervals } = await import('../../web/engine/index.ts');
      const positions = new Float32Array([-0.7, -0.7, 0.25, 0.7, -0.7, 0.25, -0.7, 0.7, 0.25,
        -0.7, -0.7, -0.25, 0.7, -0.7, -0.25, -0.7, 0.7, -0.25]);
      const data: EngineScene = {
        name: 'Triangle ray', scenario: 'city', seed: 0, extent: 1, parents: new Int32Array([-1, -1]),
        transforms: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
        meshNodes: new Uint32Array([0, 1]), groups: new Uint32Array([0, 1]), radii: new Float32Array([2, 2]),
        batchGeometries: new Uint32Array([0, 1]), batchMaterials: new Uint32Array([0, 1]), animatedNodes: new Uint32Array(),
        geometries: [0, 1].map((i) => ({ name: `triangle ${i}`, positions: positions.slice(i * 9, i * 9 + 9), indices: new Uint32Array([0, 1, 2]), radius: 2 })),
        materials: [{ name: 'front', color: [1, 0, 0], unlit: true }, { name: 'back', color: [0, 0, 1], unlit: true }],
      };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
      const engine = new Engine(canvas, data, instanced), gl = engine.gl;
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const projection = identity.slice(); projection[10] = -1;
      const camera = { projection, view: identity, viewProjection: projection };
      const indices = new Uint32Array([3, 4, 5, 0, 1, 2]), direction = new Float32Array([0, 0, -1]);
      const pick = (x: number, y: number) => {
        const hits = ray_triangle_hits(new Float32Array([x, y, 2]), direction, positions, indices, 0, Infinity, true);
        let triangle = -1, closest = Infinity;
        for (let i = 0; i < 2; i++) if (hits[i * 4] >= 0 && hits[i * 4] < closest) { closest = hits[i * 4]; triangle = i; }
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.floor((x + 1) * 96), Math.floor((y + 1) * 96), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (gl.getError()) throw new Error('WebGL error');
        return { triangle, pixel: Array.from(pixel) };
      };
      try {
        engine.frame(0, camera, false);
        const resources = engine.resourceStats(), inside = pick(-0.3, -0.3), outside = pick(0.5, 0.5);
        const boxHit = ray_aabb_intervals(new Float32Array([0.5, 0.5, 2]), direction,
          new Float32Array([-0.7, -0.7, 0.25, 0.7, 0.7, 0.25]), 0, Infinity)[0] >= 0;
        for (let i = 0; i < 9; i += 3) positions[i] += 1.5;
        engine.updateGeometry(0, positions.slice(0, 9)); engine.frame(0, camera, false);
        return { inside, outside, boxHit, moved: pick(-0.3, -0.3), resources, after: engine.resourceStats() };
      } finally { engine.dispose(); }
    }, instanced);
    expect(result.inside).toEqual({ triangle: 1, pixel: [255, 0, 0, 255] });
    expect(result.outside.triangle).toBe(-1);
    expect(result.outside.pixel[0]).toBeLessThan(60);
    expect(result.boxHit).toBe(true);
    expect(result.moved).toEqual({ triangle: 0, pixel: [0, 0, 255, 255] });
    expect(result.after).toEqual(result.resources);
  });
}
