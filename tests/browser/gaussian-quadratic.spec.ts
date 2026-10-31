import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('Gaussian quadratic evaluation preserves narrow and extreme splats across restore', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
    const width = 32, height = 32, cutoff = .01;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss extension unavailable');
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const render = (tiled: boolean) => {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (tiled) renderer.drawTiles({ width, height, cutoff });
      else renderer.draw({ width, height, cutoff });
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, value, index) => sum + Number(value !== b[index]), 0);
    const event = (name: string, action: () => void) => new Promise<void>(resolve => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    try {
      const cases = [
        { name: 'large-positive-cross', conic: [3e38, 2e38, 3e38], center: [16.5, 16.5] },
        { name: 'large-negative-cross', conic: [3e38, -2e38, 3e38], center: [16.5, 16.5] },
        { name: 'thin-diagonal', conic: [1e8, -1e8, 100000008], center: [16.125, 16.125] },
        { name: 'thin-mirrored', conic: [1e8, 1e8, 100000008], center: [16.125, 15.875] },
        { name: 'subnormal', conic: [1e-40, 0, 1e-40], center: [16.5, 16.5] },
        { name: 'ordinary', conic: [.08, -.025, .04], center: [16.125, 15.875] },
      ];
      const entries = [];
      for (const entry of cases) {
        const data = new Float32Array([...entry.center, 64, 64, ...entry.conic, .8, 0, 0, 0, 0, 1, 0, 0]);
        const upload = {
          splatData: data, originalIds: new Uint32Array([7]),
          tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 1, 2, 3, 4, 0, 0, 0, 0]) },
        };
        renderer.update(upload);
        const full = render(false), tiled = render(true);
        let maxError = 0, mismatchedPixels = 0, expectedPixels = 0, actualPixels = 0;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const dx = x + .5 - data[0], dy = y + .5 - data[1];
          const quadratic = data[4] * dx * dx + 2 * data[5] * dx * dy + data[6] * dy * dy;
          const alpha = data[7] * Math.exp(-.5 * quadratic);
          const expected = alpha < cutoff ? 0 : Math.round(255 * alpha);
          const actual = full[(y * width + x) * 4 + 3], error = Math.abs(expected - actual);
          maxError = Math.max(maxError, error);
          mismatchedPixels += Number(error > 1);
          expectedPixels += Number(expected > 0); actualPixels += Number(actual > 0);
        }
        const beforeResources = renderer.resourceStats();
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        entries.push({ name: entry.name, maxError, mismatchedPixels, expectedPixels, actualPixels,
          tileDifference: difference(full, tiled), restoreDifference: difference(full, render(false)),
          restoredTileDifference: difference(full, render(true)), resourcesUnchanged: JSON.stringify(beforeResources) === JSON.stringify(renderer.resourceStats()),
          sourceUnchanged: data[4] === Math.fround(entry.conic[0]) && data[5] === Math.fround(entry.conic[1]) && data[6] === Math.fround(entry.conic[2]),
        });
      }
      return { entries, ready: renderer.ready, error: gl.getError() };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  const path = info.outputPath('gaussian-quadratic.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-quadratic.json', { path, contentType: 'application/json' });
  for (const entry of result.entries) {
    expect(entry.maxError, entry.name).toBeLessThanOrEqual(1);
    expect(entry.mismatchedPixels, entry.name).toBe(0);
    expect(entry.actualPixels, entry.name).toBe(entry.expectedPixels);
    expect(entry.tileDifference, entry.name).toBe(0);
    expect(entry.restoreDifference, entry.name).toBe(0);
    expect(entry.restoredTileDifference, entry.name).toBe(0);
    expect(entry.resourcesUnchanged, entry.name).toBe(true);
    expect(entry.sourceUnchanged, entry.name).toBe(true);
  }
  expect(result.ready).toBe(true);
  expect(result.error).toBe(0);
});
