import { test, expect } from '@playwright/test';
import type { CameraFrame, EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`reflected triangles retain their front face (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const results = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const data: EngineScene = {
        name: 'Reflected triangles', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1, 0, 0, -1, -1]),
        transforms: new Float32Array([
          0, 0, 0, 0, 0, 0, 1, -1, 1, 1,
          -0.55, 0.45, 0, 0, 0, 0, 1, 0.5, 0.5, 1,
          0.55, 0.45, 0, 0, 0, 0, 1, -0.5, 0.5, 1,
          -0.55, -0.45, 0, 0, 0, 0, 1, -0.5, 0.5, 1,
          0.55, -0.45, 0, 0, 0, 0, 1, 0.5, 0.5, 1,
        ]),
        meshNodes: new Uint32Array([1, 2, 3, 4]), groups: new Uint32Array(4),
        radii: new Float32Array(4).fill(1),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]),
        animatedNodes: new Uint32Array(),
        geometries: [{
          name: 'triangle', radius: 1,
          positions: new Float32Array([-0.55, -0.45, 0, 0.55, -0.45, 0, 0, 0.55, 0]),
          indices: new Uint32Array([0, 1, 2]),
        }],
        materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      const canvas = () => {
        const value = document.createElement('canvas');
        value.width = value.height = 256;
        return value;
      };
      const engine = new Engine(canvas(), data, instanced);
      const referenceCanvas = canvas(), batchCanvas = canvas();
      const read = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(256 * 256 * 4);
        gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      const compare = (pixels: Uint8Array, reference: Uint8Array) => {
        let colored = 0, difference = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 60) colored++;
          for (let c = 0; c < 3; c++) difference += Math.abs(pixels[i + c] - reference[i + c]);
        }
        return { colored, difference: difference / (256 * 256 * 3) };
      };
      const results = [];
      try {
        // Mixed signs, changed parent, all CW, then all CCW exercise batch migration and GL state.
        const signs = [[-1, -1, -1, 1], [1, -1, 1, -1], [-1, 1, -1, -1], [1, 1, 1, 1]];
        for (const [phase, scales] of signs.entries()) {
          for (const [i, id] of [0, 2, 3, 4].entries())
            data.transforms[id * 10 + 7] = scales[i] * (id === 0 ? 1 : 0.5);
          engine.graph.set_transforms(data.transforms);
          const reference = new ThreeBackend(referenceCanvas, data, 'three');
          const batched = instanced ? new ThreeBackend(batchCanvas, data, 'instanced') : undefined;
          try {
            for (const back of [false, true]) {
              const view = identity.slice();
              if (back) view[0] = view[10] = -1;
              const frame: CameraFrame = { projection: identity, view, viewProjection: view };
              const stats = engine.frame(0, frame, true);
              const actual = read(engine.gl);
              const nativeStats = reference.frame(0, frame, true);
              const expected = read(reference.gl);
              const batchStats = batched?.frame(0, frame, true);
              results.push({
                phase, back, stats, nativeStats, batchStats,
                rust: compare(actual, expected),
                native: compare(expected, expected),
                batched: batched ? compare(read(batched.gl), expected) : undefined,
              });
            }
          } finally {
            batched?.dispose();
            reference.dispose();
          }
        }
      } finally {
        engine.dispose();
      }
      return results;
    }, instanced);
    for (const result of results) {
      const message = JSON.stringify(result);
      expect(result.rust.difference, message).toBeLessThan(0.05);
      expect(result.stats.visible, message).toBe(4);
      expect(result.stats.triangles, message).toBe(4);
      expect(result.nativeStats.draws, message).toBe(4);
      expect(result.stats.draws, message).toBe(instanced ? (result.phase < 2 ? 2 : 1) : 4);
      if (result.back) expect(result.rust.colored, message).toBe(0);
      else {
        expect(result.native.colored, message).toBeGreaterThan(4000);
        expect(result.rust.colored, message).toBe(result.native.colored);
      }
      if (result.batched) {
        expect(result.batched.difference, message).toBeLessThan(0.05);
        expect(result.batchStats?.draws, message).toBe(result.stats.draws);
      }
    }
  });
}
