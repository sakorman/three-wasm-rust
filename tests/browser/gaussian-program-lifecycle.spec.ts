import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const fault of ['fragment-allocation', 'fragment-compile', 'program-allocation', 'link'] as const) {
  test(`Gaussian program failures release resources and allow recovery (${fault})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (fault) => {
      const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('Context-loss extension unavailable');
      let failing = true, shaderAllocations = 0;
      const shaders: WebGLShader[] = [], programs: WebGLProgram[] = [], vaos: WebGLVertexArrayObject[] = [], buffers: WebGLBuffer[] = [];
      const createShader = gl.createShader.bind(gl), shaderSource = gl.shaderSource.bind(gl);
      const createProgram = gl.createProgram.bind(gl), createVao = gl.createVertexArray.bind(gl), createBuffer = gl.createBuffer.bind(gl);
      Object.defineProperty(gl, 'createShader', { value: (type: number) => {
        shaderAllocations++;
        if (failing && fault === 'fragment-allocation' && type === gl.FRAGMENT_SHADER) return null;
        const shader = createShader(type); if (shader) shaders.push(shader); return shader;
      } });
      Object.defineProperty(gl, 'shaderSource', { value: (shader: WebGLShader, source: string) => {
        if (failing && gl.getShaderParameter(shader, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER) {
          if (fault === 'fragment-compile') source = '#version 300 es\ninvalid shader source';
          if (fault === 'link') source = '#version 300 es\nprecision highp float; in vec3 missingVarying; out vec4 color; void main() { color = vec4(missingVarying, 1.0); }';
        }
        shaderSource(shader, source);
      } });
      Object.defineProperty(gl, 'createProgram', { value: () => {
        if (failing && fault === 'program-allocation') return null;
        const program = createProgram(); if (program) programs.push(program); return program;
      } });
      Object.defineProperty(gl, 'createVertexArray', { value: () => {
        const vao = createVao(); if (vao) vaos.push(vao); return vao;
      } });
      Object.defineProperty(gl, 'createBuffer', { value: () => {
        const buffer = createBuffer(); if (buffer) buffers.push(buffer); return buffer;
      } });
      const resources = () => ({
        shaders: shaders.filter((value) => gl.isShader(value)).length,
        programs: programs.filter((value) => gl.isProgram(value)).length,
        vaos: vaos.filter((value) => gl.isVertexArray(value)).length,
        buffers: buffers.filter((value) => gl.isBuffer(value)).length,
      });
      canvas.addEventListener('webglcontextlost', () => {
        shaders.length = 0; programs.length = 0; vaos.length = 0; buffers.length = 0;
      });
      const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
      });
      const lifecycle = new ContextLifecycle(gl);
      let renderer: InstanceType<typeof GaussianRasterRenderer> | undefined;
      try {
        const construction = [];
        for (let attempt = 0; attempt < 3; attempt++) {
          let error = '';
          try { const unexpected = new GaussianRasterRenderer(gl, lifecycle); unexpected.dispose(); }
          catch (reason) { error = String(reason); }
          construction.push({ error, resources: resources() });
        }
        // Keep later recovery checks independent of any constructor leaks reported above.
        for (const shader of shaders) if (gl.isShader(shader)) gl.deleteShader(shader);
        failing = false;
        renderer = new GaussianRasterRenderer(gl, lifecycle);
        renderer.update({
          splatData: new Float32Array([16.5, 16.5, 12, 12, .04, 0, .04, .8, 0, 0, 0, 0, 1, .5, .25]),
          originalIds: new Uint32Array([7]),
        });
        const render = () => {
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          renderer!.draw({ width: 32, height: 32, cutoff: .01 });
          const pixels = new Uint8Array(32 * 32 * 4);
          gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          return pixels;
        };
        const baseline = render();
        await event('webglcontextlost', () => extension.loseContext());
        failing = true;
        const allocationsBefore = shaderAllocations;
        await event('webglcontextrestored', () => extension.restoreContext());
        const failed = { ready: renderer.ready, error: String(renderer.error), resources: resources(), shaderAllocations: shaderAllocations - allocationsBefore };
        let drawError = '';
        try { render(); } catch (reason) { drawError = String(reason); }
        await event('webglcontextlost', () => extension.loseContext());
        failing = false;
        await event('webglcontextrestored', () => extension.restoreContext());
        const restored = render(), ready = renderer.ready;
        const differingChannels = baseline.reduce((sum, value, index) => sum + Number(value !== restored[index]), 0);
        const visiblePixels = restored.filter((value, index) => index % 4 === 3 && value > 0).length;
        renderer.dispose();
        return { construction, failed, drawError, ready, differingChannels, visiblePixels, disposed: resources(), error: gl.getError() };
      } finally { renderer?.dispose(); lifecycle.dispose(); }
    }, fault);
    const path = info.outputPath('gaussian-program-lifecycle.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-program-lifecycle.json', { path, contentType: 'application/json' });
    const empty = { shaders: 0, programs: 0, vaos: 0, buffers: 0 };
    for (const attempt of result.construction) {
      expect(attempt.error).not.toBe('');
      expect(attempt.resources).toEqual(empty);
    }
    expect(result.failed.ready).toBe(false);
    expect(result.failed.error).not.toBe('undefined');
    expect(result.failed.resources).toEqual({ ...empty, buffers: 1 });
    expect(result.failed.shaderAllocations).toBe(2);
    expect(result.drawError).toBe(result.failed.error);
    expect(result.ready).toBe(true);
    expect(result.differingChannels).toBe(0);
    expect(result.visiblePixels).toBeGreaterThan(100);
    expect(result.disposed).toEqual(empty);
    expect(result.error).toBe(0);
  });
}
