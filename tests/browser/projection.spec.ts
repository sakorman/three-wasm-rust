import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`CPU projected geometry preserves equivalent homogeneous scales (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const results = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const { transform_points } = await import('../../pkg/three_wasm_rust.js');
      const expected = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
      const data: EngineScene = {
        name: 'Projected geometry', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1]), transforms: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
        meshNodes: new Uint32Array([0]), groups: new Uint32Array([0]), radii: new Float32Array([1]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
        geometries: [{ name: 'triangle', radius: 1, positions: expected, indices: new Uint32Array([0, 1, 2]) }],
        materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      const canvas = () => {
        const value = document.createElement('canvas');
        value.width = value.height = 128;
        return value;
      };
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const frame = { projection: identity, view: identity, viewProjection: identity };
      const read = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(128 * 128 * 4);
        gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      const reference = new Engine(canvas(), data, instanced);
      const results = [];
      const projectedCanvas = canvas();
      try {
        reference.frame(0, frame, false);
        const expectedPixels = read(reference.gl);
        for (const scale of [2 ** -90, -(2 ** -90), 1, 2 ** 90]) {
          const magnitude = scale > 1 ? 2 ** 60 : 1;
          const matrix = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0], (v) => v * scale);
          const points = Float32Array.from([-1, -1, -2, 1, -1, -2, 0, 1, -2], (v) => v * magnitude);
          const positions = transform_points(matrix, points);
          const engine = new Engine(projectedCanvas, { ...data, geometries: [{ ...data.geometries[0], positions }] }, instanced);
          try {
            engine.frame(0, frame, false);
            const pixels = read(engine.gl);
            let difference = 0, colored = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              if (pixels[i] > 60) colored++;
              for (let channel = 0; channel < 3; channel++) difference += Math.abs(pixels[i + channel] - expectedPixels[i + channel]);
            }
            results.push({ scale, colored, difference, positions: Array.from(positions) });
          } finally { engine.dispose(); }
        }
      } finally { reference.dispose(); }
      return results;
    }, instanced);
    for (const result of results) {
      expect(result.positions.map((value) => value === 0 ? 0 : value))
        .toEqual([-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0]);
      expect(result.colored).toBeGreaterThan(1000);
      expect(result.difference).toBe(0);
    }
  });
}
