import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('packed Gaussian upload uses stable interleaved attributes for an instanced clipped draw', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { GAUSSIAN_RASTER_UPLOAD_STRIDE, packGaussianRasterUpload, prepareGaussianRaster } = await import('../../web/engine/index.ts');
    const width = 256, height = 192, cutoff = .1;
    const prepared = prepareGaussianRaster({
      centers: new Float32Array([0, 0, .8, .1, 0, 2, 0, 0, 4.5, 10, 0, 2]),
      covariances: new Float32Array([
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
      ]),
      opacities: new Float32Array([.5, .8, .7, .9]), cutoff, filterVariance: .25, tileSize: 16,
      camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 4, width, height },
      clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -1 },
    });
    const upload = packGaussianRasterUpload(prepared);
    if (!upload.tiles) throw new Error('Packed upload omitted tile data');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type); if (!shader) throw new Error('Shader allocation failed');
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader compile failed');
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
precision highp float;
layout(location=0) in vec2 center;
layout(location=1) in vec2 extent;
layout(location=2) in vec3 conic;
layout(location=3) in float opacity;
layout(location=4) in vec3 clip;
layout(location=5) in float clipEnabled;
out vec2 vCenter; out vec3 vConic; out float vOpacity; out vec3 vClip; out float vClipEnabled;
const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main() { vec2 pixel = center + extent * corners[gl_VertexID]; gl_Position = vec4(pixel / vec2(128.0, 96.0) - 1.0, 0.0, 1.0);
  vCenter = center; vConic = conic; vOpacity = opacity; vClip = clip; vClipEnabled = clipEnabled; }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
in vec2 vCenter; in vec3 vConic; in float vOpacity; in vec3 vClip; in float vClipEnabled;
uniform float cutoff; uniform bool applyClip;
out vec4 outputColor;
float normalCdf(float value) {
  float t = 1.0 / (1.0 + 0.2316419 * abs(value));
  float tail = 0.39894228 * exp(-0.5 * value * value) * t *
    (((((1.33027443 * t - 1.82125598) * t) + 1.78147794) * t - 0.35656378) * t + 0.31938153);
  return value >= 0.0 ? 1.0 - tail : tail;
}
void main() { vec2 d = gl_FragCoord.xy - vCenter;
  float q = vConic.x*d.x*d.x + 2.0*vConic.y*d.x*d.y + vConic.z*d.y*d.y;
  float clipFactor = applyClip && vClipEnabled > 0.5 ? normalCdf(dot(vClip.xy, -d) + vClip.z) : 1.0;
  float alpha = vOpacity * exp(-0.5*q) * clipFactor;
  if (alpha < cutoff) discard; outputColor = vec4(alpha, alpha, alpha, alpha); }`);
    const program = gl.createProgram(), vao = gl.createVertexArray(), splatBuffer = gl.createBuffer(), tileBuffer = gl.createBuffer();
    if (!program || !vao || !splatBuffer || !tileBuffer) throw new Error('WebGL allocation failed');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
    try {
      const stride = GAUSSIAN_RASTER_UPLOAD_STRIDE * Float32Array.BYTES_PER_ELEMENT;
      gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, splatBuffer); gl.bufferData(gl.ARRAY_BUFFER, upload.splatData, gl.DYNAMIC_DRAW);
      const attribute = (location: number, size: number, offset: number) => {
        gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * Float32Array.BYTES_PER_ELEMENT); gl.vertexAttribDivisor(location, 1);
      };
      attribute(0, 2, 0); attribute(1, 2, 2); attribute(2, 3, 4); attribute(3, 1, 7); attribute(4, 3, 8); attribute(5, 1, 11);
      const splatBufferSize = gl.getBufferParameter(gl.ARRAY_BUFFER, gl.BUFFER_SIZE);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tileBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, upload.tiles.packed, gl.STATIC_DRAW);
      const tileBufferSize = gl.getBufferParameter(gl.ELEMENT_ARRAY_BUFFER, gl.BUFFER_SIZE);
      const threshold = gl.getUniformLocation(program, 'cutoff'), applyClip = gl.getUniformLocation(program, 'applyClip');
      if (!threshold || !applyClip) throw new Error('Missing draw uniform');
      const raster = (clipped: boolean) => {
        gl.useProgram(program); gl.bindVertexArray(vao); gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(threshold, cutoff); gl.uniform1i(applyClip, clipped ? 1 : 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, upload.originalIds.length);
        const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const unclipped = raster(false), clipped = raster(true);
      let changedChannels = 0, visiblePixels = 0;
      for (let index = 0; index < clipped.length; index++) if (clipped[index] !== unclipped[index]) changedChannels++;
      for (let index = 3; index < clipped.length; index += 4) if (clipped[index]) visiblePixels++;
      const tileCount = upload.tiles.columns * upload.tiles.rows;
      return {
        originalIds: Array.from(upload.originalIds), stride, splatBufferSize, tileBufferSize,
        tileReferences: upload.tiles.packed.length - tileCount - 1, changedChannels, visiblePixels, error: gl.getError(),
      };
    } finally { gl.deleteBuffer(splatBuffer); gl.deleteBuffer(tileBuffer); gl.deleteVertexArray(vao); gl.deleteProgram(program); }
  });
  expect(result.error).toBe(0);
  expect(result.originalIds).toEqual([2, 1, 0]);
  expect(result.stride).toBe(60);
  expect(result.splatBufferSize).toBe(3 * 60);
  expect(result.tileBufferSize).toBeGreaterThan(0);
  expect(result.tileReferences).toBe(52);
  expect(result.changedChannels).toBeGreaterThan(500);
  expect(result.visiblePixels).toBeGreaterThan(100);
  const path = info.outputPath('gaussian-upload.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-upload.json', { path, contentType: 'application/json' });
});

test('Gaussian upload buffers reuse capacity and restore copied data after WebGL context loss', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianUploadBuffers, packGaussianRasterUpload, prepareGaussianRaster } = await import('../../web/engine/index.ts');
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 192;
    const gl = canvas.getContext('webgl2'); if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('Context-loss extension unavailable');
    const calls = { create: 0, delete: 0, data: 0, subData: 0 };
    for (const method of ['createBuffer', 'deleteBuffer', 'bufferData', 'bufferSubData'] as const) {
      Object.defineProperty(gl, method, { value: new Proxy(gl[method], {
        apply(target, context, args: unknown[]) {
          if (method === 'createBuffer') calls.create++;
          else if (method === 'deleteBuffer') calls.delete++;
          else if (method === 'bufferData') calls.data++;
          else calls.subData++;
          return Reflect.apply(target, context, args);
        },
      }) });
    }
    const lifecycle = new ContextLifecycle(gl), buffers = new GaussianUploadBuffers(gl, lifecycle);
    const makeUpload = () => packGaussianRasterUpload(prepareGaussianRaster({
      centers: new Float32Array([0, 0, .8, .1, 0, 2, 0, 0, 4.5, 10, 0, 2]),
      covariances: new Float32Array([
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
      ]),
      opacities: new Float32Array([.5, .8, .7, .9]), cutoff: .1, filterVariance: .25, tileSize: 16,
      camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 4, width: 256, height: 192 },
      clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -1 },
    }));
    const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    try {
      const initialUpload = makeUpload(); buffers.update(initialUpload);
      const initial = buffers.snapshot(); if (!initial) throw new Error('Missing initial Gaussian buffers');
      const smaller = { splatData: initialUpload.splatData.slice(0, 30), originalIds: initialUpload.originalIds.slice(0, 2) };
      buffers.update(smaller);
      const reused = buffers.snapshot(); if (!reused) throw new Error('Missing reused Gaussian buffer');
      await event('webglcontextlost', () => extension.loseContext());
      const duringLoss = buffers.snapshot();
      const recoveryUpload = makeUpload(), expectedCenter = recoveryUpload.splatData[0];
      buffers.update(recoveryUpload);
      recoveryUpload.splatData[0] = -999;
      await event('webglcontextrestored', () => extension.restoreContext());
      const restored = buffers.snapshot(); if (!restored) throw new Error('Missing restored Gaussian buffer');
      gl.bindBuffer(gl.ARRAY_BUFFER, restored.splatBuffer);
      const values = new Float32Array(12); gl.getBufferSubData(gl.ARRAY_BUFFER, 0, values);
      const error = gl.getError();
      return {
        initialBytes: initial.splatBytes, initialCapacity: initial.splatCapacityBytes, initialTileBytes: initial.tileBytes,
        reusedBytes: reused.splatBytes, reusedCapacity: reused.splatCapacityBytes, reusedHasTile: Boolean(reused.tileBuffer),
        duringLoss, restoredBytes: restored.splatBytes, restoredTileBytes: restored.tileBytes,
        sameHandle: restored.splatBuffer === initial.splatBuffer, expectedCenter, restoredCenter: values[0], error, calls,
      };
    } finally { buffers.dispose(); lifecycle.dispose(); }
  });
  expect(result.initialBytes).toBe(180);
  expect(result.initialCapacity).toBe(180);
  expect(result.initialTileBytes).toBe(980);
  expect(result.reusedBytes).toBe(120);
  expect(result.reusedCapacity).toBe(180);
  expect(result.reusedHasTile).toBe(false);
  expect(result.duringLoss).toBeUndefined();
  expect(result.restoredBytes).toBe(180);
  expect(result.restoredTileBytes).toBe(980);
  expect(result.sameHandle).toBe(false);
  expect(result.restoredCenter).toBe(result.expectedCenter);
  expect(result.error).toBe(0);
  expect(result.calls).toEqual({ create: 4, delete: 3, data: 4, subData: 1 });
});

test('Gaussian raster renderer composites packed records and restores its independent draw path', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer, packGaussianRasterUpload, prepareGaussianRaster } = await import('../../web/engine/index.ts');
    const width = 256, height = 192, cutoff = .1;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const extension = gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('Context-loss extension unavailable');
    let draws = 0;
    Object.defineProperty(gl, 'drawArraysInstanced', { value: new Proxy(gl.drawArraysInstanced, {
      apply(target, context, args: unknown[]) { draws++; return Reflect.apply(target, context, args); },
    }) });
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const makeUpload = () => packGaussianRasterUpload(prepareGaussianRaster({
      centers: new Float32Array([0, 0, .8, .1, 0, 2, 0, 0, 4.5, 10, 0, 2]),
      covariances: new Float32Array([
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
      ]),
      opacities: new Float32Array([.5, .8, .7, .9]), cutoff, filterVariance: .25, tileSize: 16,
      camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 4, width, height },
      clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -1 },
    }));
    const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
      canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true }); action();
    });
    const render = (applyClip: boolean) => {
      gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.draw({ width, height, cutoff, applyClip });
      const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    try {
      gl.disable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_DST_ALPHA, gl.ZERO, gl.ONE);
      const initialUpload = makeUpload(); renderer.update(initialUpload);
      const initial = render(true), unclipped = render(false);
      const blendRestored = !gl.isEnabled(gl.BLEND)
        && gl.getParameter(gl.BLEND_SRC_RGB) === gl.SRC_ALPHA
        && gl.getParameter(gl.BLEND_DST_RGB) === gl.ONE_MINUS_DST_ALPHA
        && gl.getParameter(gl.BLEND_SRC_ALPHA) === gl.ZERO
        && gl.getParameter(gl.BLEND_DST_ALPHA) === gl.ONE;
      let changedChannels = 0, visiblePixels = 0;
      for (let index = 0; index < initial.length; index++) if (initial[index] !== unclipped[index]) changedChannels++;
      for (let index = 3; index < initial.length; index += 4) if (initial[index]) visiblePixels++;
      await event('webglcontextlost', () => extension.loseContext());
      const readyWhileLost = renderer.ready, snapshotWhileLost = renderer.snapshot();
      const recoveryUpload = makeUpload(); renderer.update(recoveryUpload);
      recoveryUpload.splatData[0] = -999;
      await event('webglcontextrestored', () => extension.restoreContext());
      const restored = render(true);
      let restoredEqual = true;
      for (let index = 0; index < initial.length; index++) {
        if (initial[index] !== restored[index]) { restoredEqual = false; break; }
      }
      return { changedChannels, visiblePixels, blendRestored, readyWhileLost, snapshotWhileLost, restoredEqual, draws, error: gl.getError() };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  expect(result.changedChannels).toBeGreaterThan(500);
  expect(result.visiblePixels).toBeGreaterThan(100);
  expect(result.blendRestored).toBe(true);
  expect(result.readyWhileLost).toBe(false);
  expect(result.snapshotWhileLost).toBeUndefined();
  expect(result.restoredEqual).toBe(true);
  expect(result.draws).toBe(3);
  expect(result.error).toBe(0);
});

test('Gaussian raster renderer preserves the compact blend result when dispatching tile references', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer, packGaussianRasterUpload, prepareGaussianRaster } = await import('../../web/engine/index.ts');
    const width = 256, height = 192, cutoff = .1;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const nativeDraw = gl.drawArraysInstanced.bind(gl);
    let collectTileDraws = false, tileDrawCalls = 0;
    Object.defineProperty(gl, 'drawArraysInstanced', { value: (...args: Parameters<WebGL2RenderingContext['drawArraysInstanced']>) => {
      if (collectTileDraws) tileDrawCalls++;
      nativeDraw(...args);
    } });
    const upload = packGaussianRasterUpload(prepareGaussianRaster({
      centers: new Float32Array([0, 0, .8, .1, 0, 2, 0, 0, 4.5, 10, 0, 2]),
      covariances: new Float32Array([
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
        .04, 0, 0, .04, 0, .25, .04, 0, 0, .04, 0, .25,
      ]),
      opacities: new Float32Array([.5, .8, .7, .9]), cutoff, filterVariance: .25, tileSize: 16,
      camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 4, width, height },
      clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -1 },
    }));
    const pixels = () => {
      const result = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, result); return result;
    };
    try {
      renderer.update(upload);
      gl.disable(gl.SCISSOR_TEST); gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.draw({ width, height, cutoff, applyClip: true });
      const full = pixels();
      gl.clear(gl.COLOR_BUFFER_BIT); gl.scissor(2, 3, 4, 5);
      collectTileDraws = true;
      const draws = renderer.drawTiles({ width, height, cutoff, applyClip: true });
      collectTileDraws = false;
      const tiled = pixels();
      let equal = true, visiblePixels = 0;
      for (let index = 0; index < full.length; index++) if (full[index] !== tiled[index]) { equal = false; break; }
      for (let index = 3; index < tiled.length; index += 4) if (tiled[index]) visiblePixels++;
      const scissorBox = Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array);
      return { draws, tileDrawCalls, equal, visiblePixels, scissorEnabled: gl.isEnabled(gl.SCISSOR_TEST), scissorBox, error: gl.getError() };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  expect(result.draws).toBe(52);
  expect(result.tileDrawCalls).toBeGreaterThan(0);
  expect(result.tileDrawCalls).toBeLessThan(result.draws);
  expect(result.equal).toBe(true);
  expect(result.visiblePixels).toBeGreaterThan(100);
  expect(result.scissorEnabled).toBe(false);
  expect(result.scissorBox).toEqual([2, 3, 4, 5]);
  expect(result.error).toBe(0);
});

test('Gaussian raster renderer composites per-record linear RGB with premultiplied alpha', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { ContextLifecycle, GaussianRasterRenderer } = await import('../../web/engine/index.ts');
    const width = 64, height = 64;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
    const record = (x: number, color: [number, number, number]) => [
      x, 32.5, 16, 16, .08, 0, .08, .9, 0, 0, 0, 0, ...color,
    ];
    const upload = {
      splatData: new Float32Array([...record(16.5, [1, 0, 0]), ...record(47.5, [0, .5, 1])]),
      originalIds: new Uint32Array([0, 1]),
    };
    const pixelAt = (pixels: Uint8Array, x: number, y: number) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    try {
      renderer.update(upload);
      gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      renderer.draw({ width, height, cutoff: .01, applyClip: false });
      const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return { left: pixelAt(pixels, 16, 32), right: pixelAt(pixels, 47, 32), error: gl.getError() };
    } finally { renderer.dispose(); lifecycle.dispose(); }
  });
  expect(result.left[0]).toBeGreaterThan(200);
  expect(result.left[1]).toBeLessThan(4);
  expect(result.left[2]).toBeLessThan(4);
  expect(result.right[0]).toBeLessThan(4);
  expect(result.right[1]).toBeGreaterThan(100);
  expect(result.right[2]).toBeGreaterThan(200);
  expect(result.error).toBe(0);
});

test('trained Gaussian PLY keeps activated and view-dependent SH color through browser preparation and upload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { GAUSSIAN_RASTER_UPLOAD_STRIDE, parseGaussianSplatPly, packGaussianRasterUpload, prepareGaussianPlyForThreeCamera } = await import('../../web/engine/index.ts');
    const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', ...Array.from({ length: 9 }, (_, index) => `f_rest_${index}`)];
    const rows = [
      [0, 0, 2, 0, 0, 0, 0, -2, -2, -2, 1, 0, 0, 0, ...Array<number>(9).fill(0)],
      [.1, 0, 3, 1, -3, .5, Math.log(3), -2, -2, -2, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0],
    ];
    const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', `element vertex ${rows.length}`,
      ...fields.map(field => `property float ${field}`), 'end_header', ''].join('\n'));
    const buffer = new ArrayBuffer(header.length + rows.length * fields.length * Float32Array.BYTES_PER_ELEMENT);
    new Uint8Array(buffer).set(header);
    const view = new DataView(buffer);
    rows.forEach((row, rowIndex) => row.forEach((value, column) => view.setFloat32(header.length + (rowIndex * fields.length + column) * 4, value, true)));
    const source = parseGaussianSplatPly(buffer);
    const modelToWorld = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const threeWorldToView = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1]);
    const prepared = prepareGaussianPlyForThreeCamera({
      source, modelToWorld, threeWorldToView, threeCameraWorldPosition: new Float32Array([0, 0, 0]), cutoff: .1,
      camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 4, width: 256, height: 192 },
    });
    const upload = packGaussianRasterUpload(prepared);
    return {
      sourceColors: Array.from(source.colors), sourceOpacities: Array.from(source.opacities),
      shDegree: source.shDegree, preparedColors: Array.from(prepared.colors), cameraDepths: Array.from(prepared.depths),
      originalIds: Array.from(prepared.originalIds),
      farColor: Array.from(upload.splatData.slice(12, 15)), nearColor: Array.from(upload.splatData.slice(27, 30)), stride: GAUSSIAN_RASTER_UPLOAD_STRIDE,
    };
  });
  expect(result.sourceOpacities).toEqual([.5, .75]);
  expect(result.sourceColors[0]).toBeCloseTo(.5, 6);
  expect(result.sourceColors[3]).toBeCloseTo(.7820948, 6);
  expect(result.sourceColors[4]).toBe(0);
  expect(result.shDegree).toBe(1);
  expect(result.preparedColors[4]).toBeGreaterThan(1.1);
  expect(result.cameraDepths).toEqual([3, 2]);
  expect(result.originalIds).toEqual([0, 1]);
  expect(result.farColor[0]).toBeCloseTo(result.sourceColors[0], 6);
  expect(result.nearColor[0]).toBeCloseTo(result.preparedColors[3], 6);
  expect(result.nearColor[1]).toBeCloseTo(result.preparedColors[4], 6);
  expect(result.stride).toBe(15);
});
