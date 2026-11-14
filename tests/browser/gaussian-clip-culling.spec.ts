import { test, expect } from '@playwright/test';

for (const tiled of [false, true]) {
  test(`offscreen clip overflow leaves visible splats drawable (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianRasterRenderer, prepareGaussianRaster, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
      const { clipCullingScene } = await import('../../tests/fixtures/gaussian-clip-culling.ts');
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context loss extension unavailable');
      const context = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, context);
      const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, value, i) => sum + Number(value !== b[i]), 0);
      const draw = (applyClip = true) => {
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        const options = { width: 32, height: 32, cutoff: .01, applyClip };
        if (tiled) renderer.drawTiles(options); else renderer.draw(options);
        const pixels = new Uint8Array(32 * 32 * 4);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const event = (name: string, action: () => void) => new Promise<void>(resolve => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      try {
        const scene = clipCullingScene(), reference = clipCullingScene([3, 1]);
        const views = [];
        for (const [x, y, offset] of [[1, 0, 0], [1, .2, -.03], [-1, -.2, .05]]) {
          const clipPlane = { normal: new Float32Array([x, y, 0]), offset };
          renderer.update(packGaussianRasterUpload(prepareGaussianRaster({ ...reference, clipPlane })));
          const expected = draw();
          const prepared = prepareGaussianRaster({ ...scene, clipPlane });
          renderer.update(packGaussianRasterUpload(prepared));
          const actual = draw();
          views.push({ ids: [...prepared.originalIds], difference: difference(actual, expected),
            clippingDifference: difference(actual, draw(false)), litChannels: actual.filter(value => value > 0).length });
        }
        const before = draw(), resources = renderer.resourceStats();
        await event('webglcontextlost', () => extension.loseContext());
        const lostBytes = renderer.resourceStats().gpuBytes;
        await event('webglcontextrestored', () => extension.restoreContext());
        const restoredDifference = difference(before, draw()), restoredResources = renderer.resourceStats();
        renderer.update(packGaussianRasterUpload(prepareGaussianRaster(clipCullingScene([0, 2]))));
        const emptyChannels = draw().filter(value => value > 0).length;
        renderer.update(packGaussianRasterUpload(prepareGaussianRaster(scene)));
        const reloadedChannels = draw().filter(value => value > 0).length;
        renderer.dispose();
        return { views, resources, lostBytes, restoredDifference, restoredResources, emptyChannels,
          reloadedChannels, disposed: renderer.resourceStats(), error: gl.getError() };
      } finally { renderer.dispose(); context.dispose(); }
    }, tiled);
    await info.attach('clip-culling.json', { body: JSON.stringify(result), contentType: 'application/json' });
    for (const view of result.views) {
      expect(view.ids).toEqual([3, 1]); expect(view.difference).toBe(0);
      expect(view.clippingDifference).toBeGreaterThan(0); expect(view.litChannels).toBeGreaterThan(0);
    }
    expect(result.lostBytes).toBe(0); expect(result.restoredDifference).toBe(0);
    expect(result.restoredResources).toEqual(result.resources);
    expect(result.emptyChannels).toBe(0); expect(result.reloadedChannels).toBeGreaterThan(0);
    expect(result.disposed.cpuBytes).toBe(0); expect(result.disposed.gpuBytes).toBe(0);
    expect(result.error).toBe(0);
  });
}
