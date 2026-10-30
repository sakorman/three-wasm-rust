import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('duplicate tile references are rejected without changing the live or restored image', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
    const width = 32, height = 32;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Context loss extension unavailable');
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const calls = { create: 0, data: 0, subData: 0 };
    for (const method of ['createBuffer', 'bufferData', 'bufferSubData'] as const) {
      Object.defineProperty(gl, method, { value: new Proxy(gl[method], { apply(target, context, args: unknown[]) {
        if (method === 'createBuffer') calls.create++;
        else if (method === 'bufferData') calls.data++;
        else calls.subData++;
        return Reflect.apply(target, context, args);
      } }) });
    }
    const upload = {
      splatData: new Float32Array([16.5, 16.5, 12, 12, .04, 0, .04, .5, 0, 0, 0, 0, 1, 0, 0]),
      originalIds: new Uint32Array([7]),
      tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 1, 2, 3, 4, 0, 0, 0, 0]) },
    };
    const invalid = { ...upload, tiles: { ...upload.tiles, packed: new Uint32Array([0, 1, 2, 3, 5, 0, 0, 0, 0, 0]) } };
    const render = (tiled: boolean) => {
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (tiled) renderer.drawTiles({ width, height, cutoff: .01 });
      else renderer.draw({ width, height, cutoff: .01 });
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    const event = (name: string, action: () => void) => new Promise<void>(resolve => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    const reject = () => {
      const beforeCalls = { ...calls }, beforeResources = renderer.resourceStats(), before = renderer.snapshot();
      let error = '';
      try { renderer.update(invalid); } catch (failure) { error = String(failure); }
      const after = renderer.snapshot();
      return {
        error, beforeCalls, afterCalls: { ...calls }, beforeResources, afterResources: renderer.resourceStats(),
        sameHandles: before?.splatBuffer === after?.splatBuffer && before?.tileBuffer === after?.tileBuffer,
      };
    };
    try {
      renderer.update(upload);
      const baseline = render(false), tiled = render(true);
      const difference = (pixels: Uint8Array) => pixels.reduce((count, value, index) => count + Number(value !== baseline[index]), 0);
      const alpha = (pixels: Uint8Array) => pixels[(16 * width + 16) * 4 + 3];
      const live = reject(), afterInvalid = render(true);
      await event('webglcontextlost', () => extension.loseContext());
      const lost = reject();
      await event('webglcontextrestored', () => extension.restoreContext());
      const restored = render(true);
      return {
        live, lost, baselineAlpha: alpha(baseline), afterInvalidAlpha: alpha(afterInvalid), restoredAlpha: alpha(restored),
        tiledDifference: difference(tiled), afterInvalidDifference: difference(afterInvalid), restoredDifference: difference(restored),
        ready: renderer.ready, error: gl.getError(),
      };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  const path = info.outputPath('gaussian-tile-validation.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-tile-validation.json', { path, contentType: 'application/json' });
  for (const attempt of [result.live, result.lost]) {
    expect(attempt.error).toContain('duplicate Gaussian tile reference');
    expect(attempt.afterCalls).toEqual(attempt.beforeCalls);
    expect(attempt.afterResources).toEqual(attempt.beforeResources);
    expect(attempt.sameHandles).toBe(true);
  }
  expect(result.baselineAlpha).toBe(128);
  expect(result.afterInvalidAlpha).toBe(result.baselineAlpha);
  expect(result.restoredAlpha).toBe(result.baselineAlpha);
  expect(result.tiledDifference).toBe(0);
  expect(result.afterInvalidDifference).toBe(0);
  expect(result.restoredDifference).toBe(0);
  expect(result.ready).toBe(true);
  expect(result.error).toBe(0);
});
