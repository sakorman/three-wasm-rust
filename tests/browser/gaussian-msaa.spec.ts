import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`Gaussian alpha composition ignores inherited sample coverage (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
      const width = 32, height = 32;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context loss extension unavailable');
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
      const samples = (gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA8, gl.SAMPLES) as Int32Array).find(n => n > 1 && n <= 4);
      if (!samples) throw new Error('Multisample RGBA8 renderbuffer unavailable');
      const createTarget = (count: number) => {
        const framebuffer = gl.createFramebuffer(), renderbuffer = gl.createRenderbuffer();
        if (!framebuffer || !renderbuffer) throw new Error('Target allocation failed');
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, count, gl.RGBA8, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, renderbuffer);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Target incomplete');
        return { framebuffer, renderbuffer };
      };
      let target = createTarget(samples), resolve = createTarget(0);
      const releaseTargets = () => {
        for (const item of [target, resolve]) { gl.deleteFramebuffer(item.framebuffer); gl.deleteRenderbuffer(item.renderbuffer); }
      };
      const draw = () => tiled ? renderer.drawTiles({ width, height, cutoff: .01 }) : renderer.draw({ width, height, cutoff: .01 });
      const pixels = () => {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolve.framebuffer);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resolve.framebuffer);
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        return data;
      };
      const configure = (alpha: boolean, coverage: boolean, value: number, invert: boolean) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (alpha) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE); else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        if (coverage) gl.enable(gl.SAMPLE_COVERAGE); else gl.disable(gl.SAMPLE_COVERAGE);
        gl.sampleCoverage(value, invert);
      };
      const readState = () => ({
        alpha: gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE), coverage: gl.isEnabled(gl.SAMPLE_COVERAGE),
        value: gl.getParameter(gl.SAMPLE_COVERAGE_VALUE) as number, invert: gl.getParameter(gl.SAMPLE_COVERAGE_INVERT) as boolean,
        drawTarget: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === target.framebuffer,
        readTarget: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === target.framebuffer,
      });
      const event = (name: string, action: () => void) => new Promise<void>(resolve => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      try {
        const record = (color: number[]) => [16.5, 16.5, 12, 12, .04, 0, .04, .5, 0, 0, 0, 0, ...color];
        renderer.update({ splatData: new Float32Array([...record([1, 0, 0]), ...record([0, 1, 0])]),
          originalIds: new Uint32Array([7, 3]),
          tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 2, 4, 6, 8, 0, 1, 0, 1, 0, 1, 0, 1]) } });
        configure(false, false, 1, false); draw();
        const baseline = pixels(), resources = renderer.resourceStats();
        const difference = (data: Uint8Array) => baseline.reduce((n, v, i) => n + Number(v !== data[i]), 0);
        const center = (data: Uint8Array) => Array.from(data.slice((16 * width + 16) * 4, (16 * width + 16) * 4 + 4));
        const phases = [];
        for (let phase = 0; phase < 2; phase++) {
          if (phase) {
            releaseTargets();
            await event('webglcontextlost', () => extension.loseContext());
            await event('webglcontextrestored', () => extension.restoreContext());
            target = createTarget(samples); resolve = createTarget(0);
          }
          const cases = ([
            [false, false, .25, true], [true, false, 1, false],
            [false, true, 0, false], [false, true, .5, false],
            [false, true, 1, true], [false, true, .25, true],
            [true, true, .5, true], [true, true, 1, false],
          ] as const).map(settings => {
            configure(settings[0], settings[1], settings[2], settings[3]);
            const before = readState(); draw(); const after = readState(), data = pixels();
            return { before, after, differingChannels: difference(data), center: center(data) };
          });
          configure(true, true, .25, true);
          const beforeFailure = readState(), originalDraw = gl.drawArraysInstanced.bind(gl);
          gl.drawArraysInstanced = (...args) => { originalDraw(...args); throw new Error('Injected post-draw failure'); };
          let failure = '';
          try { draw(); } catch (error) { failure = String(error); }
          finally { gl.drawArraysInstanced = originalDraw; }
          const afterFailure = readState();
          configure(true, true, .25, true); draw();
          phases.push({ cases, beforeFailure, afterFailure, failure, retryDifference: difference(pixels()),
            resourcesUnchanged: JSON.stringify(renderer.resourceStats()) === JSON.stringify(resources), error: gl.getError() });
        }
        return { samples, center: center(baseline), phases };
      } finally { releaseTargets(); renderer.dispose(); lifecycle.dispose(); }
    }, tiled);
    const path = info.outputPath('gaussian-msaa.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-msaa.json', { path, contentType: 'application/json' });
    expect(result.samples).toBeGreaterThan(1);
    for (const [index, expected] of [64, 128, 0, 191].entries()) expect(Math.abs(result.center[index] - expected)).toBeLessThanOrEqual(1);
    for (const phase of result.phases) {
      for (const entry of phase.cases) {
        expect(entry.after).toEqual(entry.before);
        expect(entry.differingChannels, JSON.stringify(entry.before)).toBe(0);
      }
      expect(phase.failure).toContain('Injected post-draw failure');
      expect(phase.afterFailure).toEqual(phase.beforeFailure);
      expect(phase.retryDifference).toBe(0);
      expect(phase.resourcesUnchanged).toBe(true);
      expect(phase.error).toBe(0);
    }
  });
}
