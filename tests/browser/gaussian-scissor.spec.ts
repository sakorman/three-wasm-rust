import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const offscreen of [false, true]) {
  test(`Gaussian tile dispatch respects caller scissor (${offscreen ? 'framebuffer' : 'canvas'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (offscreen) => {
      const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
      const width = 35, height = 27;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
      const target = offscreen ? gl.createFramebuffer() : null, color = offscreen ? gl.createRenderbuffer() : null;
      if (offscreen) {
        if (!target || !color) throw new Error('Framebuffer allocation failed');
        gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.bindRenderbuffer(gl.RENDERBUFFER, color);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete framebuffer');
      }
      const options = { width, height, cutoff: .01 };
      const pixels = () => {
        const values = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, values);
        return values;
      };
      const readState = () => ({
        enabled: gl.isEnabled(gl.SCISSOR_TEST), box: Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array),
        viewport: Array.from(gl.getParameter(gl.VIEWPORT) as Int32Array),
        targetBound: gl.getParameter(gl.FRAMEBUFFER_BINDING) === target,
      });
      const configure = (enabled: boolean, box: readonly [number, number, number, number]) => {
        gl.disable(gl.SCISSOR_TEST); gl.clearColor(.125, .25, .375, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(2, 3, 17, 19); gl.scissor(...box);
        if (enabled) gl.enable(gl.SCISSOR_TEST);
      };
      const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((count, channel, index) => count + Number(channel !== b[index]), 0);
      const nativeDraw = gl.drawArraysInstanced.bind(gl);
      let drawCalls = 0, failNextDraw = false;
      Object.defineProperty(gl, 'drawArraysInstanced', { value: (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) => {
        drawCalls++; nativeDraw(...args);
        if (failNextDraw) { failNextDraw = false; throw new Error('Injected tile draw failure'); }
      } });
      try {
        const record = (x: number, y: number, rgb: number[]) => [x, y, 32, 32, .02, 0, .02, .6, 0, 0, 0, 0, ...rgb];
        renderer.update({
          splatData: new Float32Array([...record(16.5, 13.5, [1, 0, 0]), ...record(30.5, 23.5, [0, 1, 0])]),
          originalIds: new Uint32Array([4, 9]),
          tiles: { tileSize: 16, columns: 3, rows: 2, packed: new Uint32Array([0, 2, 4, 6, 8, 10, 12, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]) },
        });
        const resources = renderer.resourceStats();
        const cases = ([
          { enabled: false, box: [0, 0, 0, 0], calls: 6 },
          { enabled: true, box: [0, 0, width, height], calls: 6 },
          { enabled: true, box: [7, 5, 15, 14], calls: 4 },
          { enabled: true, box: [30, 20, 50, 50], calls: 2 },
          { enabled: true, box: [-7, -9, 19, 21], calls: 1 },
          { enabled: true, box: [16, 0, 16, 16], calls: 1 },
          { enabled: true, box: [5, 5, 0, 10], calls: 0 },
          { enabled: true, box: [5, 5, 10, 0], calls: 0 },
          { enabled: true, box: [width, 0, 16, 16], calls: 0 },
          { enabled: true, box: [-20, -20, 5, 5], calls: 0 },
        ] as const).map(({ enabled, box, calls }) => {
          configure(enabled, box);
          const background = pixels();
          renderer.draw(options); const full = pixels();
          configure(enabled, box);
          const before = readState(); drawCalls = 0;
          const references = renderer.drawTiles(options), after = readState(), tiled = pixels();
          let outsideChanges = 0;
          if (enabled) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            if (x >= box[0] && x < box[0] + box[2] && y >= box[1] && y < box[1] + box[3]) continue;
            const offset = (y * width + x) * 4;
            if (tiled.subarray(offset, offset + 4).some((v, i) => v !== background[offset + i])) outsideChanges++;
          }
          return { before, after, expectedCalls: calls, drawCalls, references,
            differingChannels: difference(full, tiled), outsideChanges, changedChannels: difference(background, full) };
        });
        const box = [7, 5, 15, 14] as const;
        configure(true, box); renderer.draw(options); const reference = pixels();
        configure(true, box); const beforeFailure = readState(); failNextDraw = true;
        let failure = '';
        try { renderer.drawTiles(options); } catch (error) { failure = String(error); }
        const afterFailure = readState();
        configure(true, box); const retryReferences = renderer.drawTiles(options);
        return { cases, resources, afterResources: renderer.resourceStats(), failure, beforeFailure, afterFailure,
          retryReferences, retryDifference: difference(reference, pixels()), error: gl.getError() };
      } finally {
        renderer.dispose(); lifecycle.dispose(); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(target); gl.deleteRenderbuffer(color);
      }
    }, offscreen);
    const path = info.outputPath('gaussian-scissor.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-scissor.json', { path, contentType: 'application/json' });
    expect(result.cases.map((entry) => entry.differingChannels)).toEqual(Array(10).fill(0));
    expect(result.cases.map((entry) => entry.outsideChanges)).toEqual(Array(10).fill(0));
    for (const entry of result.cases) {
      expect(entry.after).toEqual(entry.before);
      expect(entry.drawCalls).toBe(entry.expectedCalls);
      expect(entry.references).toBe(entry.expectedCalls * 2);
      if (entry.expectedCalls) expect(entry.changedChannels).toBeGreaterThan(0);
      else expect(entry.changedChannels).toBe(0);
    }
    expect(result.afterResources).toEqual(result.resources);
    expect(result.failure).toContain('Injected tile draw failure');
    expect(result.afterFailure).toEqual(result.beforeFailure);
    expect(result.retryReferences).toBe(8);
    expect(result.retryDifference).toBe(0);
    expect(result.error).toBe(0);
  });
}
