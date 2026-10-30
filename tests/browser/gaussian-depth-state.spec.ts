import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const tiled of [false, true]) {
  test(`Gaussian pass preserves depth and isolates face culling (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (tiled) => {
      const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
      const width = 32, height = 32;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, depth: true });
      if (!gl || !gl.getParameter(gl.DEPTH_BITS)) throw new Error('WebGL2 depth buffer unavailable');
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
      const probe = gl.createProgram();
      if (!probe) throw new Error('Probe program unavailable');
      for (const [type, source] of [
        [gl.VERTEX_SHADER, `#version 300 es
          const vec2 vertices[3] = vec2[3](vec2(-1, -1), vec2(3, -1), vec2(-1, 3));
          void main() { gl_Position = vec4(vertices[gl_VertexID], 1, 1); }`],
        [gl.FRAGMENT_SHADER, `#version 300 es
          precision highp float;
          out vec4 color;
          void main() { color = vec4(1); }`],
      ] as const) {
        const shader = gl.createShader(type);
        if (!shader) throw new Error('Probe shader unavailable');
        gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Probe compile failed');
        gl.attachShader(probe, shader); gl.deleteShader(shader);
      }
      gl.linkProgram(probe);
      if (!gl.getProgramParameter(probe, gl.LINK_STATUS)) throw new Error('Probe link failed');
      const pixels = () => {
        const value = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, value);
        return value;
      };
      const draw = () => tiled
        ? renderer.drawTiles({ width, height, cutoff: .01 })
        : renderer.draw({ width, height, cutoff: .01 });
      const readState = () => ({
        depth: gl.isEnabled(gl.DEPTH_TEST), mask: gl.getParameter(gl.DEPTH_WRITEMASK) as boolean,
        func: gl.getParameter(gl.DEPTH_FUNC) as number,
        range: Array.from(gl.getParameter(gl.DEPTH_RANGE) as Float32Array),
        cull: gl.isEnabled(gl.CULL_FACE), face: gl.getParameter(gl.CULL_FACE_MODE) as number,
        winding: gl.getParameter(gl.FRONT_FACE) as number,
      });
      const clear = () => {
        gl.disable(gl.SCISSOR_TEST); gl.depthMask(true); gl.clearDepth(1);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      };
      const depthChanges = () => {
        // Only pixels still at the original depth of 1 can become white.
        gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.EQUAL); gl.depthMask(false); gl.depthRange(0, 1);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(probe); gl.bindVertexArray(null); gl.viewport(0, 0, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return pixels().reduce((count, value, index) => count + Number(index % 4 === 0 && value !== 255), 0);
      };
      const configure = (depth: boolean, func: number, mask: boolean, cull: boolean, face: number, winding: number) => {
        clear();
        if (depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
        gl.depthFunc(func); gl.depthMask(mask); gl.depthRange(.2, .8);
        if (cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
        gl.cullFace(face); gl.frontFace(winding);
      };
      const nativeDraw = gl.drawArraysInstanced.bind(gl);
      let failNextDraw = false;
      Object.defineProperty(gl, 'drawArraysInstanced', { value: (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) => {
        nativeDraw(...args);
        if (failNextDraw) { failNextDraw = false; throw new Error('Injected post-draw failure'); }
      } });
      try {
        const record = (color: number[]) => [16.5, 16.5, 12, 12, .04, 0, .04, .5, 0, 0, 0, 0, ...color];
        renderer.update({
          splatData: new Float32Array([...record([1, 0, 0]), ...record([0, 1, 0])]), originalIds: new Uint32Array([7, 3]),
          tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 2, 4, 6, 8, 0, 1, 0, 1, 0, 1, 0, 1]) },
        });
        configure(false, gl.LESS, true, false, gl.BACK, gl.CCW);
        draw();
        const baseline = pixels();
        const difference = (value: Uint8Array) => baseline.reduce((count, channel, index) => count + Number(channel !== value[index]), 0);
        const cases = ([
          [true, gl.LESS, true, false, gl.BACK, gl.CCW],
          [true, gl.NEVER, false, false, gl.BACK, gl.CCW],
          [true, gl.GREATER, true, false, gl.BACK, gl.CCW],
          [false, gl.ALWAYS, true, true, gl.FRONT, gl.CCW],
          [false, gl.LEQUAL, false, true, gl.BACK, gl.CW],
          [true, gl.LESS, true, true, gl.FRONT_AND_BACK, gl.CCW],
          [false, gl.GEQUAL, false, false, gl.BACK, gl.CW],
        ] as const).map(([depth, func, mask, cull, face, winding]) => {
          configure(depth, func, mask, cull, face, winding);
          const before = readState(); draw();
          const after = readState(), differingChannels = difference(pixels());
          return { before, after, differingChannels, changedDepthPixels: depthChanges() };
        });
        configure(true, gl.LESS, true, true, gl.BACK, gl.CCW);
        const beforeFailure = readState(); failNextDraw = true;
        let failure = '';
        try { draw(); } catch (error) { failure = String(error); }
        const afterFailure = readState(), failureDepthChanges = depthChanges();
        configure(true, gl.LESS, true, false, gl.BACK, gl.CW);
        draw();
        return {
          center: Array.from(baseline.slice((16 * width + 16) * 4, (16 * width + 16) * 4 + 4)),
          cases, beforeFailure, afterFailure, failure, failureDepthChanges,
          retryDifference: difference(pixels()), retryDepthChanges: depthChanges(), error: gl.getError(),
        };
      } finally { gl.useProgram(null); gl.deleteProgram(probe); renderer.dispose(); lifecycle.dispose(); }
    }, tiled);
    const path = info.outputPath('gaussian-depth-state.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-depth-state.json', { path, contentType: 'application/json' });
    for (const [index, expected] of [64, 128, 0, 191].entries()) expect(Math.abs(result.center[index] - expected)).toBeLessThanOrEqual(1);
    expect(result.cases.map((entry) => entry.differingChannels)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(result.cases.map((entry) => entry.changedDepthPixels)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    for (const entry of result.cases) expect(entry.after).toEqual(entry.before);
    expect(result.failure).toContain('Injected post-draw failure');
    expect(result.afterFailure).toEqual(result.beforeFailure);
    expect(result.failureDepthChanges).toBe(0);
    expect(result.retryDifference).toBe(0);
    expect(result.retryDepthChanges).toBe(0);
    expect(result.error).toBe(0);
  });
}
