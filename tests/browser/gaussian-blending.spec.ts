import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`Gaussian compositing isolates and restores RGB/alpha equations (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (tiled) => {
      const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
      const width = 32, height = 32;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
      const record = (color: number[]) => [16.5, 16.5, 12, 12, .04, 0, .04, .5, 0, 0, 0, 0, ...color];
      const readBlendState = () => ({
        enabled: gl.isEnabled(gl.BLEND),
        equations: [gl.getParameter(gl.BLEND_EQUATION_RGB), gl.getParameter(gl.BLEND_EQUATION_ALPHA)] as number[],
        factors: [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA].map((name) => gl.getParameter(name) as number),
      });
      const draw = () => tiled
        ? renderer.drawTiles({ width, height, cutoff: .01, applyClip: false })
        : renderer.draw({ width, height, cutoff: .01, applyClip: false });
      const render = () => {
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        draw();
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((count, value, index) => count + Number(value !== b[index]), 0);
      const nativeDraw = gl.drawArraysInstanced.bind(gl);
      let failNextDraw = false;
      Object.defineProperty(gl, 'drawArraysInstanced', { value: (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) => {
        if (failNextDraw) { failNextDraw = false; throw new Error('Injected draw failure'); }
        nativeDraw(...args);
      } });
      try {
        renderer.update({
          splatData: new Float32Array([...record([1, 0, 0]), ...record([0, 1, 0])]),
          originalIds: new Uint32Array([7, 3]),
          tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 2, 4, 6, 8, 0, 1, 0, 1, 0, 1, 0, 1]) },
        });
        const baseline = render();
        const center = Array.from(baseline.slice((16 * width + 16) * 4, (16 * width + 16) * 4 + 4));
        const cases = [
          [gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT],
          [gl.FUNC_REVERSE_SUBTRACT, gl.FUNC_ADD],
          [gl.FUNC_ADD, gl.FUNC_SUBTRACT],
          [gl.MIN, gl.MAX],
          [gl.MAX, gl.MIN],
        ].map(([rgb, alpha], index) => {
          if (index % 2) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.ZERO, gl.ONE);
          gl.blendEquationSeparate(rgb, alpha);
          const before = readBlendState();
          const pixels = render();
          return { before, after: readBlendState(), differingChannels: difference(baseline, pixels) };
        });
        const beforeFailure = readBlendState();
        failNextDraw = true;
        let failure = '';
        try { draw(); } catch (error) { failure = String(error); }
        const afterFailure = readBlendState();
        const retryDifference = difference(baseline, render());
        return { center, cases, beforeFailure, afterFailure, failure, retryDifference, error: gl.getError() };
      } finally { renderer.dispose(); lifecycle.dispose(); }
    }, tiled);
    const path = info.outputPath('gaussian-blending.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-blending.json', { path, contentType: 'application/json' });
    // Red at alpha 0.5, then green at alpha 0.5: premultiplied RGBA = [0.25, 0.5, 0, 0.75].
    for (const [index, expected] of [64, 128, 0, 191].entries()) {
      expect(Math.abs(result.center[index] - expected)).toBeLessThanOrEqual(1);
    }
    expect(result.cases.map((entry) => entry.differingChannels)).toEqual([0, 0, 0, 0, 0]);
    for (const entry of result.cases) expect(entry.after).toEqual(entry.before);
    expect(result.failure).toContain('Injected draw failure');
    expect(result.afterFailure).toEqual(result.beforeFailure);
    expect(result.retryDifference).toBe(0);
    expect(result.error).toBe(0);
  });
}
