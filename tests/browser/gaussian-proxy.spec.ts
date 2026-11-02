import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const size of [32, 1]) {
  test(`Gaussian proxy rectangles preserve viewport coverage at extreme extents (${size}px)`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async size => {
      const { ContextLifecycle, GaussianRasterRenderer, prepareGaussianRaster, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
      const width = size, height = size, cutoff = .01;
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
      const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((n, v, i) => n + Number(v !== b[i]), 0);
      const event = (name: string, action: () => void) => new Promise<void>(resolve => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      try {
        const middle = [width / 2 + .125, height / 2 + .125];
        const cases = [
          { name: 'ordinary', center: middle, extent: [16, 16], conic: [.08, -.025, .04] },
          { name: 'wide-proxy', center: middle, extent: [1e10, 1e10], conic: [.08, -.025, .04] },
          { name: 'max-proxy', center: middle, extent: [3e38, 3e38], conic: [.08, -.025, .04] },
          { name: 'max-horizontal', center: middle, extent: [3e38, 8], conic: [.08, -.025, .04] },
          { name: 'max-vertical', center: middle, extent: [8, 3e38], conic: [.08, -.025, .04] },
          { name: 'broad-positive', center: [1e19, 1e19], extent: [3e19, 3e19], conic: [1e-38, 0, 1e-38] },
          { name: 'broad-negative', center: [-1e19, -1e19], extent: [3e19, 3e19], conic: [1e-38, 0, 1e-38] },
          { name: 'outside', center: [1e19, 1e19], extent: [1e18, 1e18], conic: [1e-38, 0, 1e-38] },
          { name: 'thin-axis', center: [.5, .5], extent: [.4, 20], conic: [.08, -.025, .04] },
          { name: 'prepared-broad', prepared: true, center: [0, 0], extent: [0, 0], conic: [1, 0, 1] },
        ];
        const entries = [];
        for (const entry of cases) {
          const tileCount = Math.ceil(width / 16) * Math.ceil(height / 16);
          const packed = new Uint32Array(tileCount * 2 + 1);
          for (let index = 0; index <= tileCount; index++) packed[index] = index;
          const upload = entry.prepared ? packGaussianRasterUpload(prepareGaussianRaster({
            centers: new Float32Array([1e19, 1e19, 1]),
            covariances: new Float32Array([1e38, 0, 0, 1e38, 0, 1e-20]),
            opacities: new Float32Array([.8]), colors: new Float32Array([1, 0, 0]), cutoff,
            camera: { width, height, focalX: 1, focalY: 1, principalX: 0, principalY: 0, near: .1, far: 10 }, tileSize: 16,
          })) : { splatData: new Float32Array([...entry.center, ...entry.extent, ...entry.conic, .8, 0, 0, 0, 0, 1, 0, 0]),
            originalIds: new Uint32Array([0]), tiles: { tileSize: 16, columns: Math.ceil(width / 16), rows: Math.ceil(height / 16), packed } };
          const data = upload.splatData, source = data.slice();
          renderer.update(upload);
          const full = render(false), tiled = render(true);
          let maxError = 0, mismatchedPixels = 0, expectedPixels = 0, actualPixels = 0;
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const dx = x + .5 - data[0], dy = y + .5 - data[1];
            const quadratic = data[4] * dx * dx + 2 * data[5] * dx * dy + data[6] * dy * dy;
            const alpha = data[7] * Math.exp(-.5 * quadratic);
            const inside = Math.abs(dx) <= data[2] && Math.abs(dy) <= data[3];
            const expected = !inside || alpha < cutoff ? 0 : Math.round(255 * alpha);
            const actual = full[(y * width + x) * 4 + 3], error = Math.abs(expected - actual);
            maxError = Math.max(maxError, error); mismatchedPixels += Number(error > 1);
            expectedPixels += Number(expected > 0); actualPixels += Number(actual > 0);
          }
          const resources = renderer.resourceStats();
          await event('webglcontextlost', () => extension.loseContext());
          await event('webglcontextrestored', () => extension.restoreContext());
          entries.push({ name: entry.name, maxError, mismatchedPixels, expectedPixels, actualPixels, tileDifference: difference(full, tiled),
            restoredDifference: difference(full, render(false)), restoredTileDifference: difference(full, render(true)),
            sourceUnchanged: data.every((value, index) => value === source[index]),
            resourcesUnchanged: JSON.stringify(resources) === JSON.stringify(renderer.resourceStats()) });
        }
        return { entries, error: gl.getError() };
      } finally { renderer.dispose(); lifecycle.dispose(); }
    }, size);
    const path = info.outputPath('gaussian-proxy.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-proxy.json', { path, contentType: 'application/json' });
    for (const entry of result.entries) {
      expect(entry.maxError, entry.name).toBeLessThanOrEqual(1);
      expect(entry.mismatchedPixels, entry.name).toBe(0);
      expect(entry.actualPixels, entry.name).toBe(entry.expectedPixels);
      expect(entry.tileDifference, entry.name).toBe(0);
      expect(entry.restoredDifference, entry.name).toBe(0);
      expect(entry.restoredTileDifference, entry.name).toBe(0);
      expect(entry.sourceUnchanged, entry.name).toBe(true);
      expect(entry.resourcesUnchanged, entry.name).toBe(true);
    }
    expect(result.error).toBe(0);
  });
}
