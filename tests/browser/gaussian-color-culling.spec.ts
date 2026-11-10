import { expect, test } from '@playwright/test';

test('culled splats do not change the colors of surviving splats', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer, packGaussianRasterUpload, prepareGaussianRaster } = await import('../../web/engine/index.ts');
    const size = 32, cutoff = .01;
    const camera = { focalX: 32, focalY: 32, principalX: 16.5, principalY: 16.5, near: .1, far: 10, width: size, height: size };
    // x, depth, opacity, RGB. Only the near green and far blue splats survive.
    const near = [0, 2, .5, 0, 1, 0], far = [0, 4, .5, 0, 0, 1];
    const prepare = (rows: number[][]) => prepareGaussianRaster({
      camera, cutoff, tileSize: 16,
      centers: Float32Array.from(rows.flatMap(([x, z]) => [x, 0, z])),
      covariances: Float32Array.from(rows.flatMap(() => [.04, 0, 0, .04, 0, .04])),
      opacities: Float32Array.from(rows, row => row[2]),
      colors: Float32Array.from(rows.flatMap(row => row.slice(3))),
    });
    const scene = prepare([[0, 2, 0, 1, 0, 0], near, [0, 100, .5, 1, 1, 0], [100, 3, .5, 1, 0, 1], far]);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const draw = (tiled: boolean) => {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      const options = { width: size, height: size, cutoff };
      if (tiled) renderer.drawTiles(options); else renderer.draw(options);
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    try {
      renderer.update(packGaussianRasterUpload(prepare([far, near])));
      const reference = draw(false);
      renderer.update(packGaussianRasterUpload(scene));
      const full = draw(false), tiles = draw(true);
      const diff = (pixels: Uint8Array) => pixels.reduce((sum, v, i) => sum + Number(v !== reference[i]), 0);
      const center = (16 * size + 16) * 4;
      return { ids: Array.from(scene.originalIds), center: Array.from(full.slice(center, center + 4)),
        fullDiff: diff(full), tileDiff: diff(tiles), error: gl.getError() };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  await info.attach('color-culling.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.ids).toEqual([4, 1]);
  // Green at 1/2 over blue at 1/2, on transparent black (premultiplied RGBA8).
  [0, 128, 64, 191].forEach((value, i) => expect(Math.abs(result.center[i] - value)).toBeLessThanOrEqual(1));
  expect(result.fullDiff).toBe(0);
  expect(result.tileDiff).toBe(0);
  expect(result.error).toBe(0);
});
