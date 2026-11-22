import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`Gaussian viewport limits reject before drawing or replacing a PLY view (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianRasterRenderer, GaussianPlyRenderer } = await import('../../web/engine/index.ts');
      const { syntheticPly, viewOptions, pixels, difference, clear } = await import('../../tests/browser/fixtures/gaussian-ply-view.ts');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context loss extension unavailable');
      const getParameter = gl.getParameter.bind(gl);
      const limits = Array.from(getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array);
      let override: number[] | undefined, limitQueries = 0, writes = 0, draws = 0;
      Object.defineProperty(gl, 'getParameter', { value: (name: number) => {
        if (name === gl.MAX_VIEWPORT_DIMS) { limitQueries++; if (override) return new Int32Array(override); }
        return getParameter(name);
      } });
      for (const name of ['bufferData', 'bufferSubData', 'drawArraysInstanced'] as const) {
        const original = gl[name].bind(gl) as (...args: unknown[]) => unknown;
        Object.defineProperty(gl, name, { value: (...args: unknown[]) => {
          if (name === 'drawArraysInstanced') draws++; else writes++;
          return original(...args);
        } });
      }
      const lifecycle = new ContextLifecycle(gl), raster = new GaussianRasterRenderer(gl, lifecycle);
      const ply = new GaussianPlyRenderer(gl, lifecycle), options = viewOptions(tiled);
      const tileSize = Math.max(...limits);
      raster.update({
        splatData: new Float32Array([32.5, 24.5, 12, 12, .04, 0, .04, .8, 0, 0, 0, 0, 1, .5, .25]),
        originalIds: new Uint32Array([0]),
        ...(tiled && { tiles: { tileSize, columns: 1, rows: 1, packed: new Uint32Array([0, 1, 0]) } }),
      });
      ply.loadPly(syntheticPly());
      const drawRaster = (width = 64, height = 48) => {
        const draw = { width, height, cutoff: .01 };
        if (tiled) raster.drawTiles(draw); else raster.draw(draw);
      };
      const state = () => ({ viewport: Array.from(getParameter(gl.VIEWPORT) as Int32Array),
        scissor: Array.from(getParameter(gl.SCISSOR_BOX) as Int32Array),
        scissorEnabled: gl.isEnabled(gl.SCISSOR_TEST), blend: gl.isEnabled(gl.BLEND) });
      const attempt = (action: () => void) => { try { action(); return ''; } catch (error) { return String(error); } };
      const event = (name: string, action: () => void) => new Promise<void>(resolve => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      try {
        clear(gl); drawRaster(); const baseline = pixels(gl);
        const boundary = [];
        for (const [width, height] of [[limits[0], 48], [64, limits[1]]]) {
          clear(gl); drawRaster(width, height); boundary.push(difference(baseline, pixels(gl)));
        }
        clear(gl); const firstPly = ply.render(options), plyPixels = pixels(gl), resources = ply.resourceStats();
        const rejected = [];
        const invalid = [[limits[0] + 1, 48], [64, limits[1] + 1], [2 ** 31, 48],
          [2 ** 32 + 64, 48], [64, 2 ** 32 + 48], [Number.MAX_SAFE_INTEGER, 48]];
        for (const [width, height] of invalid) {
          const before = state(), startWrites = writes, startDraws = draws;
          const rasterError = attempt(() => drawRaster(width, height));
          const plyError = attempt(() => ply.render({ ...options, camera: { ...options.camera, width, height } }));
          rejected.push({ rasterError, plyError, writes: writes - startWrites, draws: draws - startDraws,
            before, after: state(), pixelDifference: difference(plyPixels, pixels(gl)), resources: ply.resourceStats() });
        }
        const startQueries = limitQueries, startWrites = writes;
        const stable = ply.render(options);
        const stableWrites = writes - startWrites, steadyLimitQueries = limitQueries - startQueries;

        // A restored context can expose different capabilities. Simulate a smaller device limit.
        await event('webglcontextlost', () => extension.loseContext());
        override = [128, 96];
        await event('webglcontextrestored', () => extension.restoreContext());
        clear(gl); const restored = ply.render(options), restoredDifference = difference(plyPixels, pixels(gl));
        const restoreStartWrites = writes, restoreStartDraws = draws;
        const restoredErrors = [attempt(() => drawRaster(129, 48)),
          attempt(() => ply.render({ ...options, camera: { ...options.camera, height: 97 } }))];
        const restoreRejectedWrites = writes - restoreStartWrites, restoreRejectedDraws = draws - restoreStartDraws;
        clear(gl); drawRaster(); const rasterRestoredDifference = difference(baseline, pixels(gl));
        ply.dispose(); raster.dispose();
        return { limits, boundary, firstPly, resources, rejected, stable, stableWrites, steadyLimitQueries,
          restored, restoredDifference, restoredErrors, restoreRejectedWrites, restoreRejectedDraws,
          rasterRestoredDifference, disposed: ply.resourceStats(), glError: gl.getError() };
      } finally { ply.dispose(); raster.dispose(); lifecycle.dispose(); }
    }, tiled);
    const path = info.outputPath('gaussian-viewport-limits.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-viewport-limits.json', { path, contentType: 'application/json' });
    expect(result.firstPly.recordCount).toBeGreaterThan(0);
    expect(result.boundary).toEqual([0, 0]);
    for (const rejected of result.rejected) {
      expect(rejected.rasterError).toMatch(/viewport.*limit/);
      expect(rejected.plyError).toMatch(/viewport.*limit/);
      expect(rejected.writes).toBe(0); expect(rejected.draws).toBe(0);
      expect(rejected.before).toEqual(rejected.after);
      expect(rejected.pixelDifference).toBe(0); expect(rejected.resources).toEqual(result.resources);
    }
    expect(result.stable.viewUpdated).toBe(false); expect(result.stableWrites).toBe(0);
    expect(result.steadyLimitQueries).toBe(0);
    expect(result.restored.viewUpdated).toBe(false); expect(result.restoredDifference).toBe(0);
    expect(result.restoredErrors.every(error => /viewport.*limit/.test(error))).toBe(true);
    expect(result.restoreRejectedWrites).toBe(0); expect(result.restoreRejectedDraws).toBe(0);
    expect(result.rasterRestoredDifference).toBe(0);
    expect(result.disposed.sourceBytes).toBe(0); expect(result.disposed.upload.cpuBytes).toBe(0);
    expect(result.disposed.upload.gpuBytes).toBe(0); expect(result.glError).toBe(0);
  });
}
