import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const operation of ['clear', 'failed-growth'] as const) {
  test(`Gaussian VAO releases deleted upload buffers (${operation})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async operation => {
      const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context loss extension unavailable');
      const externalVao = gl.createVertexArray(), externalVertex = gl.createBuffer(), externalIndex = gl.createBuffer();
      if (!externalVao || !externalVertex || !externalIndex) throw new Error('External resources unavailable');
      gl.bindVertexArray(externalVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, externalVertex); gl.bufferData(gl.ARRAY_BUFFER, 16, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, externalIndex); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, 4, gl.STATIC_DRAW);
      const vaos: WebGLVertexArrayObject[] = [];
      const createVao = gl.createVertexArray.bind(gl), bufferData = gl.bufferData.bind(gl);
      Object.defineProperty(gl, 'createVertexArray', { value: () => {
        const vao = createVao(); if (vao) vaos.push(vao); return vao;
      } });
      let failNextData = false;
      Object.defineProperty(gl, 'bufferData', { value: (...args: Parameters<WebGL2RenderingContext['bufferData']>) => {
        if (failNextData) { failNextData = false; return; }
        bufferData(...args);
      } });
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
      const upload = {
        splatData: new Float32Array([16.5, 16.5, 12, 12, .04, 0, .04, .5, 0, 0, 0, 0, 1, .5, .25]),
        originalIds: new Uint32Array([7]),
        tiles: { tileSize: 16, columns: 2, rows: 2, packed: new Uint32Array([0, 1, 2, 3, 4, 0, 0, 0, 0]) },
      };
      const references = (vao: WebGLVertexArrayObject, buffer?: WebGLBuffer) => {
        const previous = gl.getParameter(gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
        gl.bindVertexArray(vao);
        const count = Array.from({ length: 7 }, (_, index) => gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) as WebGLBuffer | null)
          .filter(value => buffer ? value === buffer : value !== null).length;
        gl.bindVertexArray(previous);
        return count;
      };
      const externalUnchanged = () => gl.getParameter(gl.VERTEX_ARRAY_BINDING) === externalVao
        && gl.getParameter(gl.ARRAY_BUFFER_BINDING) === externalVertex
        && gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === externalIndex
        && gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === externalVertex;
      const render = (tiled: boolean) => {
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (tiled) renderer.drawTiles({ width: 32, height: 32, cutoff: .01 });
        else renderer.draw({ width: 32, height: 32, cutoff: .01 });
        const pixels = new Uint8Array(32 * 32 * 4);
        gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const event = (name: string, action: () => void) => new Promise<void>(resolve => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      try {
        renderer.update(upload);
        const baseline = render(false);
        const difference = (pixels: Uint8Array) => baseline.reduce((sum, value, index) => sum + Number(value !== pixels[index]), 0);
        const cycles = [];
        for (let cycle = 0; cycle < 3; cycle++) {
          const oldBuffer = renderer.snapshot()!.splatBuffer, vao = vaos[0];
          const beforeReferences = references(vao, oldBuffer);
          let error = '';
          if (operation === 'clear') renderer.clear();
          else {
            failNextData = true;
            try { renderer.update({ splatData: new Float32Array([...upload.splatData, ...upload.splatData]), originalIds: new Uint32Array([7, 8]) }); }
            catch (failure) { error = String(failure); }
          }
          const afterReferences = references(vao), stats = renderer.resourceStats();
          const statePreserved = externalUnchanged(), vaoRetained = gl.isVertexArray(vao) && vaos.length === 1;
          const bufferDeleted = !gl.isBuffer(oldBuffer), unavailable = renderer.snapshot() === undefined;
          renderer.update(upload);
          const reloadDifference = difference(render(cycle % 2 === 0));
          cycles.push({ beforeReferences, afterReferences, error, stats, statePreserved, vaoRetained, bufferDeleted, unavailable, reloadDifference });
        }
        // Clear while lost must not leave a source to resurrect on restore.
        await event('webglcontextlost', () => extension.loseContext());
        renderer.clear();
        await event('webglcontextrestored', () => extension.restoreContext());
        const restoredEmpty = renderer.snapshot() === undefined && renderer.resourceStats().cpuBytes === 0;
        const restoredReferences = references(vaos[vaos.length - 1]);
        renderer.update(upload);
        return {
          cycles, restoredEmpty, restoredReferences, restoredDifference: difference(render(false)),
          restoredTileDifference: difference(render(true)), ready: renderer.ready, error: gl.getError(),
        };
      } finally {
        renderer.dispose(); lifecycle.dispose();
        gl.deleteVertexArray(externalVao); gl.deleteBuffer(externalVertex); gl.deleteBuffer(externalIndex);
      }
    }, operation);
    const path = info.outputPath('gaussian-buffer-references.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-buffer-references.json', { path, contentType: 'application/json' });
    for (const cycle of result.cycles) {
      expect(cycle.beforeReferences).toBe(7);
      expect(cycle.afterReferences).toBe(0);
      expect(cycle.error).toBe(operation === 'clear' ? '' : 'Error: Gaussian upload buffer storage allocation failed');
      expect(cycle.stats.gpuBytes).toBe(0);
      expect(cycle.stats.cpuBytes).toBe(operation === 'clear' ? 0 : 128);
      expect(cycle.statePreserved).toBe(true);
      expect(cycle.vaoRetained).toBe(true);
      expect(cycle.bufferDeleted).toBe(true);
      expect(cycle.unavailable).toBe(true);
      expect(cycle.reloadDifference).toBe(0);
    }
    expect(result.restoredEmpty).toBe(true);
    expect(result.restoredReferences).toBe(0);
    expect(result.restoredDifference).toBe(0);
    expect(result.restoredTileDifference).toBe(0);
    expect(result.ready).toBe(true);
    expect(result.error).toBe(0);
  });
}
