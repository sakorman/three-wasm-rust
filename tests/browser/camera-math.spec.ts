import { test, expect } from '@playwright/test';
import { Matrix4 } from 'three';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`camera multiplication preserves visible offsets (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const projection = new Float32Array(new Matrix4().elements), view = projection.slice();
    projection[0] = 1e8; projection[4] = 1; projection[12] = -1e8;
    view[12] = 1; view[13] = 0.5;
    const referenceMatrix = new Matrix4().fromArray(projection).multiply(new Matrix4().fromArray(view)).elements;
    const result = await page.evaluate(async ({ instanced, referenceMatrix }) => {
      const { Engine } = await import('../../web/engine/index.ts');
      const { multiply } = await import('../../web/engine/camera.ts');
      const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
      const projection = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), view = projection.slice();
      projection[0] = 1e8; projection[4] = 1; projection[12] = -1e8;
      view[12] = 1; view[13] = 0.5;
      const frame = { projection, view, viewProjection: multiply(projection, view) };
      const expected = { projection, view, viewProjection: new Float32Array(referenceMatrix) };
      const data: EngineScene = {
        name: 'Camera cancellation', scenario: 'city', seed: 0, extent: 1, parents: new Int32Array([-1]),
        transforms: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1e-8, 1, 1]),
        meshNodes: new Uint32Array([0]), groups: new Uint32Array([0]), radii: new Float32Array([1]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
        geometries: [{ name: 'triangle', positions: new Float32Array([-0.3, -0.3, 0, 0.3, -0.3, 0, 0, 0.3, 0]), indices: new Uint32Array([0, 1, 2]), radius: 1 }],
        materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      const canvas = () => { const value = document.createElement('canvas'); value.width = value.height = 192; return value; };
      const engine = new Engine(canvas(), data, instanced);
      const reference = new ThreeBackend(canvas(), data, instanced ? 'instanced' : 'three');
      const capture = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(192 * 192 * 4);
        gl.readPixels(0, 0, 192, 192, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      try {
        engine.frame(0, frame, false); reference.frame(0, expected, false);
        const actual = capture(engine.gl), baseline = capture(reference.gl);
        let difference = 0, colored = 0;
        for (let i = 0; i < actual.length; i += 4) {
          if (actual[i] > 60) colored++;
          for (let channel = 0; channel < 3; channel++) difference += Math.abs(actual[i + channel] - baseline[i + channel]);
        }
        return { offset: frame.viewProjection[12], colored, difference: difference / (192 * 192 * 3) };
      } finally { reference.dispose(); engine.dispose(); }
    }, { instanced, referenceMatrix });
    expect(result.offset).toBe(0.5);
    expect(result.colored).toBeGreaterThan(1000);
    expect(result.difference).toBeLessThan(0.05);
  });
}
