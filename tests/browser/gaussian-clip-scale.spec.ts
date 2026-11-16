import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`Gaussian clipping preserves pixels when world units change (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianRasterRenderer, prepareGaussianRaster, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
      const { clipScaleScene, clipNormals, clipScales } = await import('../../tests/fixtures/gaussian-clip-scale.ts');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const context = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, context);
      const draw = (scale: number, normal: number[], filter: number) => {
        renderer.update(packGaussianRasterUpload(prepareGaussianRaster(clipScaleScene(scale, normal, filter))));
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        const options = { width: 32, height: 32, cutoff: .001 };
        if (tiled) renderer.drawTiles(options); else renderer.draw(options);
        const pixels = new Uint8Array(32 * 32 * 4);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      try {
        const views = [];
        for (const normal of clipNormals) for (const filter of [0, .25, 1]) {
          const reference = draw(1, normal, filter);
          for (const scale of clipScales) {
            const pixels = draw(scale, normal, filter);
            let maxError = 0, differingChannels = 0;
            for (let i = 0; i < pixels.length; i++) {
              maxError = Math.max(maxError, Math.abs(pixels[i] - reference[i]));
              if (pixels[i] !== reference[i]) differingChannels++;
            }
            views.push({ scale, normal, filter, maxError, differingChannels,
              centerAlpha: pixels[(16 * 32 + 16) * 4 + 3], lit: pixels.filter(v => v > 0).length });
          }
        }
        return { views, error: gl.getError() };
      } finally { renderer.dispose(); context.dispose(); }
    }, tiled);
    await writeFile(info.outputPath('clip-scale.json'), JSON.stringify(result, null, 2));
    for (const view of result.views) {
      expect(view.lit).toBeGreaterThan(0);
      expect(view.maxError).toBe(0); expect(view.differingChannels).toBe(0);
      if (view.normal[2] === -1) {
        // Phi(-0.5) is the analytic retained mass for this independent depth marginal.
        expect(Math.abs(view.centerAlpha - Math.round(255 * .8 * .3085375387259869 / (1 + view.filter)))).toBeLessThanOrEqual(1);
      }
    }
    expect(result.error).toBe(0);
  });
}
