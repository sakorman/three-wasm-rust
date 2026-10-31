import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('f32 conic rejection precedes upload and a corrected view survives context restore', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
    const width = 32, height = 32;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss extension unavailable');
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const prepared = {
      originalIds: new Uint32Array([7]), screenCenters: new Float32Array([16.5, 16.5]),
      screenCovariances: new Float32Array([25, 0, 25]), opacities: new Float32Array([.5]),
      colors: new Float32Array([1, 0, 0]), depths: new Float32Array([2]), halfExtents: new Float32Array([12, 12]),
      tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 1, 2, 3, 4, 0, 0, 0, 0]) },
    };
    const render = (tiled: boolean) => {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (tiled) renderer.drawTiles({ width, height, cutoff: .01 });
      else renderer.draw({ width, height, cutoff: .01 });
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, value, index) => sum + Number(value !== b[index]), 0);
    const event = (name: string, action: () => void) => new Promise<void>(resolve => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    try {
      renderer.update(packGaussianRasterUpload(prepared));
      const baseline = render(false), beforeResources = renderer.resourceStats(), before = renderer.snapshot()!;
      const cases = [
        [2.685375213623047, 2.444232225418091, 2.224743604660034],
        [18.332870483398438, 4.2816901206970215, 1],
      ].map(covariance => {
        let phase = 'pack', error = '';
        try {
          const upload = packGaussianRasterUpload({ ...prepared, screenCovariances: new Float32Array(covariance) });
          phase = 'upload'; renderer.update(upload); phase = 'done';
        } catch (failure) { error = String(failure); }
        const after = renderer.snapshot()!;
        return {
          phase, error, differingChannels: difference(baseline, render(true)), resources: renderer.resourceStats(),
          sameHandles: after.splatBuffer === before.splatBuffer && after.tileBuffer === before.tileBuffer,
        };
      });
      renderer.update(packGaussianRasterUpload({ ...prepared, colors: new Float32Array([0, 1, 0]) }));
      const corrected = render(false), correctedTileDifference = difference(corrected, render(true));
      await event('webglcontextlost', () => extension.loseContext());
      await event('webglcontextrestored', () => extension.restoreContext());
      return {
        beforeResources, cases, correctedDifference: difference(baseline, corrected), correctedTileDifference,
        restoredDifference: difference(corrected, render(false)), restoredTileDifference: difference(corrected, render(true)),
        ready: renderer.ready, error: gl.getError(),
      };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  const path = info.outputPath('gaussian-conic.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-conic.json', { path, contentType: 'application/json' });
  for (const entry of result.cases) {
    expect(entry.phase).toBe('pack');
    expect(entry.error).toMatch(/conic.*positive definite.*f32.*index 0/);
    expect(entry.differingChannels).toBe(0);
    expect(entry.resources).toEqual(result.beforeResources);
    expect(entry.sameHandles).toBe(true);
  }
  expect(result.correctedDifference).toBeGreaterThan(0);
  expect(result.correctedTileDifference).toBe(0);
  expect(result.restoredDifference).toBe(0);
  expect(result.restoredTileDifference).toBe(0);
  expect(result.ready).toBe(true);
  expect(result.error).toBe(0);
});
