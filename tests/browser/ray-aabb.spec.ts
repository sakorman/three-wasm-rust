import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`ray candidates match visible boxes and update after movement (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine, box, ray_aabb_intervals } = await import('../../web/engine/index.ts');
      const data: EngineScene = {
        name: 'Ray boxes', scenario: 'city', seed: 0, extent: 1,
        parents: new Int32Array([-1, -1, -1, -1]),
        transforms: new Float32Array([
          0, 0, -0.35, 0, 0, 0, 1, 0.3, 0.3, 0.3,
          -0.6, 0, 0, 0, 0, 0, 1, 0.3, 0.3, 0.3,
          0, 0, 0.35, 0, 0, 0, 1, -0.3, 0.3, 0.3,
          0.6, 0, 0, 0, 0, 0, 1, 0.3, 0.3, 0.3,
        ]),
        meshNodes: new Uint32Array([0, 1, 2, 3]), groups: new Uint32Array([0, 1, 2, 3]),
        radii: new Float32Array(4).fill(0.9), animatedNodes: new Uint32Array(),
        batchGeometries: new Uint32Array(4), batchMaterials: new Uint32Array([0, 1, 2, 3]), geometries: [box()],
        materials: [
          { name: 'back', color: [0, 0, 1], unlit: true },
          { name: 'left', color: [1, 0, 0], unlit: true },
          { name: 'front', color: [0, 1, 0], unlit: true },
          { name: 'right', color: [1, 1, 0], unlit: true },
        ],
      };
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
      const engine = new Engine(canvas, data, instanced), gl = engine.gl;
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const projection = identity.slice(); projection[10] = -1;
      const frame = { projection, view: identity, viewProjection: projection };
      const local = new Float32Array(Array.from({ length: 4 }, () => [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]).flat());
      const direction = new Float32Array([0, 0, -1]);
      const select = (bounds: Float32Array, x: number, near = 0, far = Infinity) => {
        const intervals = ray_aabb_intervals(new Float32Array([x, 0, 2]), direction, bounds, near, far);
        let index = -1, closest = Infinity, hits = 0;
        for (let i = 0; i < data.meshNodes.length; i++) if (intervals[i * 2] >= 0) {
          hits++;
          if (intervals[i * 2] < closest) { index = i; closest = intervals[i * 2]; }
        }
        return { node: index === -1 ? -1 : data.meshNodes[index], hits };
      };
      const pixel = (x: number) => {
        const value = new Uint8Array(4);
        gl.readPixels(Math.floor((x + 1) * 96), 96, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
        if (gl.getError()) throw new Error('WebGL error');
        return Array.from(value);
      };
      try {
        engine.frame(0, frame, false);
        const resources = engine.resourceStats(), bounds = engine.graph.world_aabbs(data.meshNodes, local);
        const picks = [-0.6, 0, 0.6].map((x) => ({ ...select(bounds, x), pixel: pixel(x) }));
        const clipped = select(bounds, 0, 2, 3), missed = select(bounds, 0.95);
        const transform = data.transforms.slice(20, 30); transform[0] = 0.6;
        engine.graph.set_transform(2, transform);
        engine.frame(0, frame, false);
        const moved = select(engine.graph.world_aabbs(data.meshNodes, local), 0), movedPixel = pixel(0);
        const oldSnapshot = select(bounds, 0);
        return { picks, clipped, missed, moved, movedPixel, oldSnapshot,
          resources, afterResources: engine.resourceStats(), visible: engine.queue.visible_count() };
      } finally { engine.dispose(); }
    }, instanced);
    expect(result.picks).toEqual([
      { node: 1, hits: 1, pixel: [255, 0, 0, 255] },
      { node: 2, hits: 2, pixel: [0, 255, 0, 255] },
      { node: 3, hits: 1, pixel: [255, 255, 0, 255] },
    ]);
    expect(result.clipped).toEqual({ node: 0, hits: 1 });
    expect(result.missed).toEqual({ node: -1, hits: 0 });
    expect(result.moved).toEqual({ node: 0, hits: 1 });
    expect(result.movedPixel).toEqual([0, 0, 255, 255]);
    expect(result.oldSnapshot).toEqual({ node: 2, hits: 2 });
    expect(result.afterResources).toEqual(result.resources);
    expect(result.visible).toBe(4);
  });
}
