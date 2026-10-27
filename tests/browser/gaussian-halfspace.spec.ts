import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('half-space coefficients produce a directional per-pixel Gaussian cut', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { gaussian_halfspace_clip_coefficients, gaussian_project_covariances, gaussian_screen_bounds } =
      await import('../../web/engine/index.ts');
    const width = 256, height = 192, focal = 96, cutoff = Math.fround(1 / 255), opacity = .8;
    const center3d = new Float32Array([0, 0, 2]), covariance3d = new Float32Array([.02, 0, 0, .02, 0, .04]);
    const projected = gaussian_project_covariances(center3d, covariance3d, focal, focal, width / 2, height / 2);
    const coefficient = gaussian_halfspace_clip_coefficients(center3d, covariance3d, focal, focal, new Float32Array([.8, 0, -.6]), -1.2);
    const extent = gaussian_screen_bounds(projected.slice(3), new Float32Array([opacity]), cutoff);
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
uniform vec2 center, extent;
const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main() { vec2 pixel = center + extent * corners[gl_VertexID]; gl_Position = vec4(pixel / vec2(128.0, 96.0) - 1.0, 0.0, 1.0); }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec2 center;
uniform vec3 conic, clip;
uniform float opacity, cutoff;
out vec4 outputColor;
float normalCdf(float value) {
  float t = 1.0 / (1.0 + 0.2316419 * abs(value));
  float tail = 0.39894228 * exp(-0.5 * value * value) * t *
    (((((1.33027443 * t - 1.82125598) * t) + 1.78147794) * t - 0.35656378) * t + 0.31938153);
  return value >= 0.0 ? 1.0 - tail : tail;
}
void main() { vec2 d = gl_FragCoord.xy - center; float q = conic.x*d.x*d.x + 2.0*conic.y*d.x*d.y + conic.z*d.y*d.y;
  float alpha = opacity * exp(-0.5*q) * normalCdf(dot(clip.xy, -d) + clip.z);
  if (alpha < cutoff) discard; outputColor = vec4(alpha, alpha * 0.4, alpha * 0.2, alpha); }`);
    const program = gl.createProgram(); if (!program) throw new Error('Program allocation failed');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
    try {
      const uniform = (name: string) => { const value = gl.getUniformLocation(program, name); if (!value) throw new Error(`Missing ${name}`); return value; };
      const center = uniform('center'), bounds = uniform('extent'), conic = uniform('conic'), alpha = uniform('opacity'), threshold = uniform('cutoff'), clip = uniform('clip');
      const xx = projected[3], xy = projected[4], yy = projected[5], determinant = xx * yy - xy * xy;
      const raster = (applyClip: boolean) => {
        gl.useProgram(program); gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2f(center, projected[0], projected[1]); gl.uniform2f(bounds, extent[0], extent[1]);
        gl.uniform3f(conic, yy / determinant, -xy / determinant, xx / determinant); gl.uniform1f(alpha, opacity); gl.uniform1f(threshold, cutoff);
        gl.uniform3f(clip, applyClip ? coefficient[0] : 0, applyClip ? coefficient[1] : 0, applyClip ? coefficient[2] : 12);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const unclipped = raster(false), clipped = raster(true);
      const alphaAt = (pixels: Uint8Array, x: number, y: number) => pixels[(y * width + x) * 4 + 3];
      const left = alphaAt(clipped, 112, 96), right = alphaAt(clipped, 144, 96), centerFull = alphaAt(unclipped, 128, 96), centerClipped = alphaAt(clipped, 128, 96);
      const normalCdf = (value: number) => {
        const t = 1 / (1 + .2316419 * Math.abs(value));
        const tail = .39894228 * Math.exp(-.5 * value ** 2) * t * (((((1.33027443 * t - 1.82125598) * t) + 1.78147794) * t - .35656378) * t + .31938153);
        return value >= 0 ? 1 - tail : tail;
      };
      const centerFactor = normalCdf(coefficient[0] * (projected[0] - 128.5) + coefficient[1] * (projected[1] - 96.5) + coefficient[2]);
      let changedChannels = 0, visiblePixels = 0;
      for (let index = 0; index < clipped.length; index++) if (clipped[index] !== unclipped[index]) changedChannels++;
      for (let index = 3; index < clipped.length; index += 4) if (clipped[index]) visiblePixels++;
      return { coefficient: Array.from(coefficient), left, right, centerFull, centerClipped, centerFactor, changedChannels, visiblePixels, error: gl.getError() };
    } finally { gl.deleteProgram(program); }
  });
  expect(result.error).toBe(0);
  expect(result.coefficient[0]).toBeGreaterThan(0);
  expect(Math.abs(result.coefficient[2])).toBeLessThan(1e-5);
  expect(result.left).toBeGreaterThan(result.right + 4);
  expect(result.centerClipped).toBeGreaterThan(0);
  expect(Math.abs(result.centerClipped / result.centerFull - result.centerFactor)).toBeLessThanOrEqual(.02);
  expect(result.changedChannels).toBeGreaterThan(500);
  expect(result.visiblePixels).toBeGreaterThan(100);
  const path = info.outputPath('gaussian-halfspace.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-halfspace.json', { path, contentType: 'application/json' });
});
