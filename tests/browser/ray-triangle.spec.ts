import { test, expect } from '@playwright/test';
import { Matrix4, OrthographicCamera } from 'three';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`visible shared edges remain pickable (${instanced ? 'instanced' : 'direct'})`, async ({ page }, testInfo) => {
    const camera = new OrthographicCamera(-2e6, 2e6, 2e6, -2e6, 1, 4e6);
    camera.position.set(-267333, -77067, 295176.5);
    camera.lookAt(-10160, -24761, -81008.5);
    camera.updateMatrixWorld();
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async ({ instanced, projection, view, viewProjection }) => {
      const { Engine, ray_triangle_hits } = await import('../../web/engine/index.ts');
      const positions = new Float32Array([780330, 626276, -102685, -800650, -675798, -59332,
        -274359, -851746, 413331, 254039, 802224, -575348]);
      const indices = new Uint32Array([0, 1, 2, 3, 1, 0]);
      const data: EngineScene = {
        name: 'Shared edge', scenario: 'city', seed: 0, extent: 2e6, parents: new Int32Array([-1]),
        transforms: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
        meshNodes: new Uint32Array([0]), groups: new Uint32Array([0]), radii: new Float32Array([3e6]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
        geometries: [{ name: 'adjacent triangles', positions, indices, radius: 3e6 }],
        materials: [{ name: 'surface', color: [0, 1, 0], unlit: true }],
      };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 127;
      const engine = new Engine(canvas, data, instanced), gl = engine.gl;
      try {
        const p = new Float32Array(projection), v = new Float32Array(view);
        engine.frame(0, { projection: p, view: v, viewProjection: new Float32Array(viewProjection) }, false);
        const pixel = new Uint8Array(4);
        gl.readPixels(63, 63, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        const resources = engine.resourceStats();
        const hits = ray_triangle_hits(new Float32Array([-267333, -77067, 295176.5]),
          new Float32Array([257173, 52306, -376185]), positions, indices, 0, 2, false);
        return { pixel: Array.from(pixel), hits: Array.from(hits), resources,
          after: engine.resourceStats(), error: gl.getError() };
      } finally { engine.dispose(); }
    }, { instanced, projection: camera.projectionMatrix.toArray(), view: camera.matrixWorldInverse.toArray(),
      viewProjection: new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray() });
    await testInfo.attach('shared-edge.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(result.error).toBe(0);
    expect(result.pixel).toEqual([0, 255, 0, 255]);
    expect(result.hits[0] >= 0 || result.hits[4] >= 0).toBe(true);
    for (const offset of [0, 4]) if (result.hits[offset] >= 0) expect(result.hits[offset]).toBeCloseTo(1, 12);
    expect(result.after).toEqual(result.resources);
  });

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
