import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`tiny quaternion rotations render and restore like normalized inputs (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine, box } = await import('../../web/engine/index.ts');
      const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
      const transforms = (magnitude: number) => new Float32Array([
        -0.1, 0, 0, 0, 0, 0.5 * magnitude, magnitude, 0.8, 0.5, 0.5,
        0.2, 0, 0, 0, 0, -0.25 * magnitude, magnitude, -1, 1, 1,
      ]);
      const data: EngineScene = {
        name: 'Quaternion scale', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1, 0]), transforms: transforms(2 ** -140),
        meshNodes: new Uint32Array([1]), groups: new Uint32Array([0]), radii: new Float32Array([1]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
        geometries: [box()], materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      const canvas = () => { const value = document.createElement('canvas'); value.width = value.height = 192; return value; };
      const engine = new Engine(canvas(), data, instanced);
      const reference = new ThreeBackend(canvas(), { ...data, transforms: transforms(1) }, instanced ? 'instanced' : 'three');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const frame = { projection: identity, view: identity, viewProjection: identity };
      const capture = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(192 * 192 * 4);
        gl.readPixels(0, 0, 192, 192, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      try {
        reference.frame(0, frame, false);
        const expected = capture(reference.gl), resources = engine.resourceStats();
        const compare = () => {
          engine.frame(0, frame, false);
          const actual = capture(engine.gl);
          let colored = 0, difference = 0;
          for (let i = 0; i < actual.length; i += 4) {
            if (actual[i] > 60) colored++;
            for (let c = 0; c < 3; c++) difference += Math.abs(actual[i + c] - expected[i + c]);
          }
          return { colored, difference: difference / (192 * 192 * 3) };
        };
        const results = [compare()];
        for (const factor of [-(2 ** -140), 2 ** -100, 1, 2 ** 120]) {
          engine.graph.set_transforms(transforms(factor)); results.push(compare());
        }
        const small = transforms(2 ** -140);
        engine.graph.set_transform(0, small.slice(0, 10));
        engine.graph.set_transform(1, small.slice(10));
        results.push(compare());
        const invalid = small.slice(); invalid.fill(0, 13, 17);
        let rejected = false;
        try { engine.graph.set_transforms(invalid); } catch { rejected = true; }
        results.push(compare());
        const extension = engine.gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('No context test extension');
        const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
          engine.gl.canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
        });
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        results.push(compare());
        return { results, rejected, resources, after: engine.resourceStats() };
      } finally { reference.dispose(); engine.dispose(); }
    }, instanced);
    expect(result.rejected).toBe(true);
    expect(result.after).toEqual(result.resources);
    for (const view of result.results) {
      expect(view.colored).toBeGreaterThan(1000);
      expect(view.difference).toBeLessThan(0.1);
    }
  });
}
