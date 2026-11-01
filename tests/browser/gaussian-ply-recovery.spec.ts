import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`PLY view cache survives rejected inputs, upload failure and context restoration (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianPlyRenderer } = await import('../../web/engine/index.ts');
      const { syntheticPly, viewOptions, pixels, difference, clear } = await import('../../tests/browser/fixtures/gaussian-ply-view.ts');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context loss extension unavailable');
      let writes = 0, failNextWrite = false;
      for (const name of ['bufferData', 'bufferSubData'] as const) {
        const method = gl[name].bind(gl) as (...args: unknown[]) => unknown;
        Object.defineProperty(gl, name, { value: (...args: unknown[]) => {
          writes++;
          if (failNextWrite) { failNextWrite = false; throw new Error('Injected upload failure'); }
          return method(...args);
        } });
      }
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianPlyRenderer(gl, lifecycle);
      const options = viewOptions(tiled);
      const render = () => { clear(gl); const start = writes, frame = renderer.render(options); return { frame, writes: writes - start, pixels: pixels(gl) }; };
      const event = (name: string, action: () => void) => new Promise<void>(resolve => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      const attempt = (action: () => void) => { try { action(); return ''; } catch (error) { return String(error); } };
      try {
        renderer.loadPly(syntheticPly());
        const baseline = render(), initialResources = renderer.resourceStats();
        const invalid: { error: string; writes: number; updated: boolean; difference: number }[] = [];
        for (const action of [
          () => renderer.loadPly(new ArrayBuffer(0)),
          () => renderer.render({ ...options, modelToWorld: new Float32Array(15) }),
          () => renderer.render({ ...options, tileSize: 0 }),
          () => renderer.render({ ...options, camera: { ...options.camera, width: 0 } }),
          () => renderer.render({ ...options, cutoff: 0 }),
          () => renderer.render({ ...options, modelToWorld: new Float32Array(16) }),
        ]) {
          const start = writes, error = attempt(action), rejectedWrites = writes - start;
          const current = render();
          invalid.push({ error, writes: rejectedWrites, updated: current.frame.viewUpdated, difference: difference(baseline.pixels, current.pixels) });
        }
        const afterInvalid = renderer.resourceStats();
        await event('webglcontextlost', () => extension.loseContext());
        const lostResources = renderer.resourceStats(), lostReady = renderer.ready;
        const lostError = attempt(() => renderer.render(options));
        await event('webglcontextrestored', () => extension.restoreContext());
        const restored = render();

        // A failed upload can restore its newer CPU copy. The previous camera key must stay invalid.
        options.modelToWorld[12] = .25;
        failNextWrite = true;
        const uploadError = attempt(() => renderer.render(options)), failedResources = renderer.resourceStats();
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        options.modelToWorld[12] = 0;
        const retried = render(), retryStable = render();

        renderer.loadPly(syntheticPly(.25));
        const replacement = render();
        await event('webglcontextlost', () => extension.loseContext());
        renderer.loadPly(syntheticPly());
        await event('webglcontextrestored', () => extension.restoreContext());
        const loadedWhileLost = render();
        await event('webglcontextlost', () => extension.loseContext());
        renderer.clear();
        const cleared = renderer.resourceStats();
        await event('webglcontextrestored', () => extension.restoreContext());
        const emptyError = attempt(() => renderer.render(options)), emptyReady = renderer.ready;
        renderer.loadPly(syntheticPly());
        const reloaded = render();
        renderer.dispose(); renderer.dispose();
        return {
          initialResources, invalid, afterInvalid, lostResources, lostReady, lostError,
          restored: { ...restored.frame, writes: restored.writes, difference: difference(baseline.pixels, restored.pixels) },
          uploadError, failedResources,
          retried: { ...retried.frame, writes: retried.writes, difference: difference(baseline.pixels, retried.pixels) },
          retryStable: { ...retryStable.frame, writes: retryStable.writes },
          replacement: { ...replacement.frame, difference: difference(baseline.pixels, replacement.pixels) },
          loadedWhileLost: { ...loadedWhileLost.frame, difference: difference(baseline.pixels, loadedWhileLost.pixels) },
          cleared, emptyReady, emptyError,
          reloaded: { ...reloaded.frame, difference: difference(baseline.pixels, reloaded.pixels) },
          disposed: renderer.resourceStats(), disposedReady: renderer.ready,
          disposedErrors: [attempt(() => renderer.render(options)), attempt(() => renderer.loadPly(syntheticPly())), attempt(() => renderer.clear())],
          error: gl.getError(),
        };
      } finally { renderer.dispose(); lifecycle.dispose(); }
    }, tiled);
    const path = info.outputPath('gaussian-ply-recovery.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-ply-recovery.json', { path, contentType: 'application/json' });
    for (const entry of result.invalid) {
      expect(entry.error).not.toBe(''); expect(entry.writes).toBe(0);
      expect(entry.updated).toBe(false); expect(entry.difference).toBe(0);
    }
    expect(result.afterInvalid).toEqual(result.initialResources);
    expect(result.lostReady).toBe(false); expect(result.lostError).toMatch(/context is lost/);
    expect(result.lostResources.sourceBytes).toBe(result.initialResources.sourceBytes);
    expect(result.lostResources.upload.gpuBytes).toBe(0);
    expect(result.restored.viewUpdated).toBe(false); expect(result.restored.writes).toBe(0); expect(result.restored.difference).toBe(0);
    expect(result.uploadError).toMatch(/Injected upload failure/); expect(result.failedResources.upload.gpuBytes).toBe(0);
    expect(result.retried.viewUpdated).toBe(true); expect(result.retried.writes).toBeGreaterThan(0); expect(result.retried.difference).toBe(0);
    expect(result.retryStable.viewUpdated).toBe(false); expect(result.retryStable.writes).toBe(0);
    expect(result.replacement.viewUpdated).toBe(true); expect(result.replacement.difference).toBeGreaterThan(0);
    expect(result.loadedWhileLost.viewUpdated).toBe(true); expect(result.loadedWhileLost.difference).toBe(0);
    expect(result.cleared.sourceBytes).toBe(0); expect(result.cleared.upload.cpuBytes).toBe(0); expect(result.cleared.upload.gpuBytes).toBe(0);
    expect(result.emptyReady).toBe(false); expect(result.emptyError).toMatch(/not loaded/);
    expect(result.reloaded.viewUpdated).toBe(true); expect(result.reloaded.difference).toBe(0);
    expect(result.disposed.sourceBytes).toBe(0); expect(result.disposed.upload.cpuBytes).toBe(0); expect(result.disposed.upload.gpuBytes).toBe(0);
    expect(result.disposedReady).toBe(false); expect(result.disposedErrors.every(error => /disposed/.test(error))).toBe(true);
    expect(result.error).toBe(0);
  });
}
