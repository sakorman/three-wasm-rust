import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`filtered clip pixels follow the restricted-density convolution (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianRasterRenderer, prepareGaussianRaster, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
      const { filteredClipScene, filteredClipReference } = await import('../../tests/fixtures/gaussian-filtered-clip.ts');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const context = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, context);
      const results = [];
      try {
        for (const variance of [.25, 1, 4]) for (const normal of [[1, 0, 0], [0, -1, 0], [.6, .8, 0]]) {
          const input = filteredClipScene(variance, normal), prepared = prepareGaussianRaster(input);
          renderer.update(packGaussianRasterUpload(prepared));
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          const options = { width: 32, height: 32, cutoff: input.cutoff };
          if (tiled) renderer.drawTiles(options); else renderer.draw(options);
          const pixels = new Uint8Array(32 * 32 * 4);
          gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          let maxError = 0, outsideTolerance = 0, lit = 0;
          for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
            const alpha = filteredClipReference(x - 16, y - 16, variance, input.clipPlane!.normal, input.clipPlane!.offset);
            const expected = alpha < input.cutoff ? 0 : Math.round(alpha * 255);
            for (let channel = 0; channel < 4; channel++) {
              const actual = pixels[(y * 32 + x) * 4 + channel], error = Math.abs(actual - expected);
              maxError = Math.max(maxError, error); if (error > 1) outsideTolerance++; if (actual > 0) lit++;
            }
          }
          results.push({ variance, normal, maxError, outsideTolerance, lit, centerAlpha: pixels[(16 * 32 + 16) * 4 + 3] });
        }
        return { results, error: gl.getError() };
      } finally { renderer.dispose(); context.dispose(); }
    }, tiled);
    await writeFile(info.outputPath('filtered-clip.json'), JSON.stringify(result, null, 2));
    for (const entry of result.results) {
      expect(entry.lit).toBeGreaterThan(0); expect(entry.maxError).toBeLessThanOrEqual(1); expect(entry.outsideTolerance).toBe(0);
    }
    expect(result.error).toBe(0);
  });
}
