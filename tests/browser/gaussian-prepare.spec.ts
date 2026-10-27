import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('prepared Gaussian raster data keeps local tile IDs and applies clip coefficients in the fragment pass', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { prepareGaussianRaster } = await import('../../web/engine/index.ts');
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
    if (!prepared.clipCoefficients || !prepared.tiles) throw new Error('Preparation omitted requested clip or tile data');
    const clipCoefficients = prepared.clipCoefficients, tiles = prepared.tiles;
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
void main() { vec2 d = gl_FragCoord.xy - center;
  float q = conic.x*d.x*d.x + 2.0*conic.y*d.x*d.y + conic.z*d.y*d.y;
  float alpha = opacity * exp(-0.5*q) * normalCdf(dot(clip.xy, -d) + clip.z);
  if (alpha < cutoff) discard; outputColor = vec4(alpha, alpha, alpha, alpha); }`);
    const program = gl.createProgram(); if (!program) throw new Error('Program allocation failed');
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
    try {
      const uniform = (name: string) => { const value = gl.getUniformLocation(program, name); if (!value) throw new Error(`Missing ${name}`); return value; };
      const center = uniform('center'), extent = uniform('extent'), conic = uniform('conic'), clip = uniform('clip');
      const opacity = uniform('opacity'), threshold = uniform('cutoff');
      const raster = (applyClip: boolean) => {
        gl.useProgram(program); gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(threshold, cutoff);
        for (let index = 0; index < prepared.originalIds.length; index++) {
          const [x, y] = prepared.screenCenters.slice(index * 2, index * 2 + 2);
          const [halfWidth, halfHeight] = prepared.halfExtents.slice(index * 2, index * 2 + 2);
          const [xx, xy, yy] = prepared.screenCovariances.slice(index * 3, index * 3 + 3);
          const [kx, ky, h] = clipCoefficients.slice(index * 3, index * 3 + 3);
          const determinant = xx * yy - xy * xy;
          gl.uniform2f(center, x, y); gl.uniform2f(extent, halfWidth, halfHeight);
          gl.uniform3f(conic, yy / determinant, -xy / determinant, xx / determinant);
          gl.uniform1f(opacity, prepared.opacities[index]);
          gl.uniform3f(clip, applyClip ? kx : 0, applyClip ? ky : 0, applyClip ? h : 12);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      const unclipped = raster(false), clipped = raster(true);
      let changedChannels = 0, visiblePixels = 0;
      for (let index = 0; index < clipped.length; index++) if (clipped[index] !== unclipped[index]) changedChannels++;
      for (let index = 3; index < clipped.length; index += 4) if (clipped[index]) visiblePixels++;
      const tileCount = tiles.columns * tiles.rows;
      return {
        originalIds: Array.from(prepared.originalIds), depths: Array.from(prepared.depths),
        clip: Array.from(clipCoefficients), tileReferences: Array.from(tiles.packed.slice(tileCount + 1)),
        changedChannels, visiblePixels, error: gl.getError(),
      };
    } finally { gl.deleteProgram(program); }
  });
  expect(result.error).toBe(0);
  expect(result.originalIds).toEqual([2, 1, 0]);
  expect(result.depths[0]).toBeGreaterThan(result.depths[1]);
  expect(result.depths[1]).toBeGreaterThan(result.depths[2]);
  expect(result.clip[8]).toBeLessThan(0);
  expect(result.tileReferences.length).toBeGreaterThan(0);
  for (const index of result.tileReferences) expect(index).toBeLessThan(result.originalIds.length);
  expect(result.changedChannels).toBeGreaterThan(500);
  expect(result.visiblePixels).toBeGreaterThan(100);
  const path = info.outputPath('gaussian-prepare.json');
  await writeFile(path, JSON.stringify(result, null, 2));
  await info.attach('gaussian-prepare.json', { path, contentType: 'application/json' });
});
