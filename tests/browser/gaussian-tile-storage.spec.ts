import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('Gaussian CPU tile submission uploads only the splat records across updates and restoration', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer, packGaussianRasterUpload, prepareGaussianRaster } = await import('../../web/engine/index.ts');
    const width = 256, height = 192, cutoff = .01;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss extension unavailable');
    const writes: { target: number; bytes: number }[] = [];
    for (const name of ['bufferData', 'bufferSubData'] as const) {
      const method = gl[name].bind(gl) as (...args: unknown[]) => unknown;
      Object.defineProperty(gl, name, { value: (...args: unknown[]) => {
        const data = args[name === 'bufferData' ? 1 : 2] as ArrayBufferView | number;
        writes.push({ target: args[0] as number, bytes: typeof data === 'number' ? data : data.byteLength });
        return method(...args);
      } });
    }
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const upload = packGaussianRasterUpload(prepareGaussianRaster({
      centers: new Float32Array([0, 0, .8, .1, 0, 2, 0, 0, 4.5, 10, 0, 2]),
      covariances: new Float32Array(Array.from({ length: 4 }, () => [.04, 0, 0, .04, 0, .25]).flat()),
      opacities: new Float32Array([.5, .8, .7, .9]), cutoff, filterVariance: .25, tileSize: 16,
      camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 4, width, height },
      clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -1 },
    }));
    const draw = (tiled: boolean) => {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (tiled) renderer.drawTiles({ width, height, cutoff, applyClip: true });
      else renderer.draw({ width, height, cutoff, applyClip: true });
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const event = (name: string, action: () => void) => new Promise<void>(resolve => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    try {
      renderer.update(upload);
      const baseline = draw(false);
      const rgbaSha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', baseline)))
        .map(value => value.toString(16).padStart(2, '0')).join('');
      const difference = (pixels: Uint8Array) => baseline.reduce((sum, value, index) => sum + Number(value !== pixels[index]), 0);
      const sample = () => ({
        writes: writes.splice(0), resources: renderer.resourceStats(), hasTileBuffer: Boolean(renderer.snapshot()?.tileBuffer),
        tileBytes: renderer.snapshot()?.tileBytes, fullDifference: difference(draw(false)), tileDifference: difference(draw(true)),
      });
      const initial = sample();
      renderer.update(upload);
      const updated = sample();
      // Neither the submission list nor its recovery copy may alias caller data.
      upload.tiles!.packed.fill(0); upload.splatData.fill(0);
      await event('webglcontextlost', () => extension.loseContext());
      const lost = renderer.resourceStats();
      await event('webglcontextrestored', () => extension.restoreContext());
      const restored = sample();
      renderer.clear();
      const cleared = renderer.resourceStats();
      await event('webglcontextlost', () => extension.loseContext());
      await event('webglcontextrestored', () => extension.restoreContext());
      const emptyRestoredWrites = writes.splice(0);
      renderer.dispose();
      return { rgbaSha256, initial, updated, restored, lost, cleared, emptyRestoredWrites, disposed: renderer.resourceStats(),
        visiblePixels: baseline.filter((_value, index) => index % 4 === 3 && baseline[index] > 0).length, error: gl.getError() };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  const path = info.outputPath('gaussian-tile-storage.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-tile-storage.json', { path, contentType: 'application/json' });
  expect(result.visiblePixels).toBeGreaterThan(100);
  for (const sample of [result.initial, result.updated, result.restored]) {
    expect(sample.fullDifference).toBe(0); expect(sample.tileDifference).toBe(0);
    expect(sample.tileBytes).toBe(1284); expect(sample.resources.cpuTileBytes).toBe(1284);
    expect(sample.writes).toEqual([{ target: 0x8892, bytes: 240 }]);
    expect(sample.hasTileBuffer).toBe(false);
    expect(sample.resources.gpuTileCapacityBytes).toBe(0); expect(sample.resources.gpuBytes).toBe(240);
  }
  expect(result.lost.cpuTileBytes).toBe(1284); expect(result.lost.gpuBytes).toBe(0);
  for (const stats of [result.cleared, result.disposed]) { expect(stats.cpuBytes).toBe(0); expect(stats.gpuBytes).toBe(0); }
  expect(result.emptyRestoredWrites).toEqual([]); expect(result.error).toBe(0);
});
