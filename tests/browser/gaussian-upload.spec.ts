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
  expect(result.stride).toBe(48);
  expect(result.splatBufferSize).toBe(3 * 48);
  expect(result.tileBufferSize).toBeGreaterThan(0);
  expect(result.tileReferences).toBe(52);
  expect(result.changedChannels).toBeGreaterThan(500);
  expect(result.visiblePixels).toBeGreaterThan(100);
  const path = info.outputPath('gaussian-upload.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-upload.json', { path, contentType: 'application/json' });
});
