import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`PLY view reuse matches fresh preparation after every camera input changes (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianPlyRenderer, GaussianRasterRenderer, parseGaussianSplatPly,
        packGaussianRasterUpload, prepareGaussianPlyForThreeCamera } = await import('../../web/engine/index.ts');
      const { syntheticPly, viewOptions, pixels, difference, clear } = await import('../../tests/browser/fixtures/gaussian-ply-view.ts');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      let writes = 0;
      for (const name of ['bufferData', 'bufferSubData'] as const) {
        const method = gl[name].bind(gl) as (...args: unknown[]) => unknown;
        Object.defineProperty(gl, name, { value: (...args: unknown[]) => { writes++; return method(...args); } });
      }
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianPlyRenderer(gl, lifecycle);
      const reference = new GaussianRasterRenderer(gl, lifecycle);
      const input = syntheticPly(), source = parseGaussianSplatPly(input), options = viewOptions(tiled);
      const compare = () => {
        clear(gl); const start = writes, stats = renderer.render(options), actual = pixels(gl), uploadWrites = writes - start;
        clear(gl); const referenceStart = writes;
        reference.update(packGaussianRasterUpload(prepareGaussianPlyForThreeCamera({ ...options, source })));
        const draw = { ...options.camera, cutoff: options.cutoff, applyClip: options.applyClip };
        if (options.tileSize !== undefined) reference.drawTiles(draw); else reference.draw(draw);
        return { ...stats, uploadWrites, referenceWrites: writes - referenceStart, difference: difference(actual, pixels(gl)) };
      };
      try {
        renderer.loadPly(input);
        new Uint8Array(input).fill(0);
        const staticFrames = Array.from({ length: 64 }, compare);
        const changes: { name: string; frame: ReturnType<typeof compare>; stable: ReturnType<typeof compare> }[] = [];
        const change = (name: string, action: () => void) => {
          action(); changes.push({ name, frame: compare(), stable: compare() });
        };
        change('model', () => { options.modelToWorld[12] += .125; });
        change('view', () => { options.threeWorldToView[12] += .2; });
        change('camera-position', () => { options.threeCameraWorldPosition[0] += .3; });
        change('focal-x', () => { options.camera.focalX += 3; });
        change('focal-y', () => { options.camera.focalY += 3; });
        change('principal-x', () => { options.camera.principalX += .5; });
        change('principal-y', () => { options.camera.principalY += .5; });
        change('near', () => { options.camera.near = 2.5; });
        change('far', () => { options.camera.far = 3; });
        change('width', () => { options.camera.width = 63; });
        change('height', () => { options.camera.height = 47; });
        change('cutoff', () => { options.cutoff = .02; });
        change('filter', () => { options.filterVariance = .25; });
        change('clip-plane', () => { options.clipPlane = { normal: new Float32Array([0, 0, -1]), offset: -2.5 }; });
        change('clip-normal', () => { options.clipPlane!.normal[0] = .1; });
        change('clip-offset', () => { options.clipPlane!.offset = -2.7; });
        change('tile-size', () => { options.tileSize = tiled ? 8 : 16; });
        change('full-draw', () => { options.tileSize = undefined; });
        const clipToggle = (() => { options.applyClip = false; return compare(); })();
        return { staticFrames, changes, clipToggle, resources: renderer.resourceStats(), error: gl.getError() };
      } finally { renderer.dispose(); reference.dispose(); lifecycle.dispose(); }
    }, tiled);
    const path = info.outputPath('gaussian-ply-view.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-ply-view.json', { path, contentType: 'application/json' });
    expect(result.staticFrames.filter(frame => frame.viewUpdated)).toHaveLength(1);
    expect(result.staticFrames.reduce((sum, frame) => sum + frame.uploadWrites, 0)).toBe(tiled ? 2 : 1);
    expect(result.staticFrames.reduce((sum, frame) => sum + frame.referenceWrites, 0)).toBe(tiled ? 128 : 64);
    for (const frame of result.staticFrames) { expect(frame.difference).toBe(0); expect(frame.recordCount).toBe(3); }
    for (const entry of result.changes) {
      expect(entry.frame.viewUpdated, entry.name).toBe(true);
      expect(entry.frame.uploadWrites, entry.name).toBeGreaterThan(0);
      expect(entry.frame.difference, entry.name).toBe(0);
      expect(entry.stable.viewUpdated, entry.name).toBe(false);
      expect(entry.stable.uploadWrites, entry.name).toBe(0);
      expect(entry.stable.difference, entry.name).toBe(0);
    }
    expect(result.clipToggle.viewUpdated).toBe(false);
    expect(result.clipToggle.uploadWrites).toBe(0);
    expect(result.clipToggle.difference).toBe(0);
    expect(result.resources.sourceCount).toBe(3);
    expect(result.resources.sourceBytes).toBe(3 * (3 + 6 + 1 + 3 + 12) * 4);
    expect(result.error).toBe(0);
  });
}
