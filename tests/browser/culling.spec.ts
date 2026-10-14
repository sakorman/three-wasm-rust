import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`tiny shear does not remove edge pixels (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const radius = 1e6, angle = Math.PI / 8, c = Math.SQRT1_2;
      // A triangle at the sphere's left tip, rotated back into the child's local space.
      const positions = Float32Array.from([
        -radius * c, radius * c, 0,
        (-radius + 4.5 - 0.8) * c, (radius - 4.5 - 0.8) * c, 0,
        (-radius + 4.5 + 0.8) * c, (radius - 4.5 + 0.8) * c, 0,
      ]);
      const data: EngineScene = {
        name: 'Sheared edge', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1, 0]),
        transforms: new Float32Array([
          radius + 6.5, 0, 0, 0, 0, 0, 1, 1.000008, 1, 1,
          0, 0, 0, 0, 0, Math.sin(angle), Math.cos(angle), 1, 1, 1,
        ]),
        meshNodes: new Uint32Array([1]), groups: new Uint32Array([0]),
        radii: new Float32Array([radius]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]),
        animatedNodes: new Uint32Array(),
        geometries: [{ name: 'edge triangle', radius, positions, indices: new Uint32Array([0, 1, 2]) }],
        materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      for (let i = 0; i < positions.length; i += 3)
        if (Math.hypot(positions[i], positions[i + 1], positions[i + 2]) > radius)
          throw new Error('Triangle exceeds its sphere');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const engine = new Engine(canvas, data, instanced);
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const camera = { projection: identity, view: identity, viewProjection: identity };
      const read = () => {
        const gl = engine.gl, pixels = new Uint8Array(256 * 256 * 4);
        gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      try {
        engine.frame(0, camera, false);
        const expected = read();
        const stats = engine.frame(0, camera, true), actual = read();
        let colored = 0, difference = 0;
        for (let i = 0; i < actual.length; i += 4) {
          if (actual[i] > 60) colored++;
          for (let channel = 0; channel < 3; channel++)
            difference += Math.abs(actual[i + channel] - expected[i + channel]);
        }
        return { colored, difference, visible: stats.visible, draws: stats.draws };
      } finally {
        engine.dispose();
      }
    }, instanced);
    expect(result.visible).toBe(1);
    expect(result.draws).toBe(1);
    expect(result.colored).toBeGreaterThan(1000);
    expect(result.difference).toBe(0);
  });
}
