import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('screen filter compensates opacity while keeping raster energy stable', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { gaussian_filter_screen_covariances, gaussian_screen_bounds } = await import('../../web/engine/index.ts');
    const cutoff = Math.fround(1 / 255);
    const covariance = new Float32Array([16, 5, 9]);
    const opacity = new Float32Array([.7]);
    const filtered = gaussian_filter_screen_covariances(covariance, opacity, .6);
    const filteredCovariance = filtered.slice(0, 3);
    const filteredOpacity = new Float32Array([filtered[3]]);
    const bounds = gaussian_screen_bounds(covariance, opacity, cutoff);
    const filteredBounds = gaussian_screen_bounds(filteredCovariance, filteredOpacity, cutoff);
    const raster = (covariance2: Float32Array, opacity2: number, bounds2: Float32Array) => {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 512;
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
uniform vec2 extent;
const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main() { vec2 pixel = vec2(256.0) + extent * corners[gl_VertexID]; gl_Position = vec4(pixel / 256.0 - 1.0, 0.0, 1.0); }`);
      const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec3 conic;
uniform float opacity, cutoff;
out vec4 outputColor;
void main() { vec2 d = gl_FragCoord.xy - vec2(256.0); float q = conic.x*d.x*d.x + 2.0*conic.y*d.x*d.y + conic.z*d.y*d.y;
  float alpha = opacity * exp(-0.5*q); if (alpha < cutoff) discard; outputColor = vec4(alpha); }`);
      const program = gl.createProgram(); if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
      try {
        const extent = gl.getUniformLocation(program, 'extent'), conic = gl.getUniformLocation(program, 'conic');
        const alpha = gl.getUniformLocation(program, 'opacity'), threshold = gl.getUniformLocation(program, 'cutoff');
        if (!extent || !conic || !alpha || !threshold) throw new Error('Missing uniform');
        const [xx, xy, yy] = covariance2, determinant = xx * yy - xy * xy;
        gl.useProgram(program); gl.viewport(0, 0, canvas.width, canvas.height); gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniform2fv(extent, bounds2); gl.uniform3f(conic, yy / determinant, -xy / determinant, xx / determinant);
        gl.uniform1f(alpha, opacity2); gl.uniform1f(threshold, cutoff); gl.drawArrays(gl.TRIANGLES, 0, 6);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let alphaSum = 0, visible = 0;
        for (let index = 3; index < pixels.length; index += 4) { alphaSum += pixels[index]; if (pixels[index]) visible++; }
        return { alphaSum, visible, error: gl.getError() };
      } finally { gl.deleteProgram(program); }
    };
    const original = raster(covariance, opacity[0], bounds);
    const filteredRaster = raster(filteredCovariance, filteredOpacity[0], filteredBounds);
    const originalEnergy = opacity[0] * Math.sqrt(covariance[0] * covariance[2] - covariance[1] ** 2);
    const filteredEnergy = filteredOpacity[0] * Math.sqrt(filteredCovariance[0] * filteredCovariance[2] - filteredCovariance[1] ** 2);
    return { covariance: Array.from(covariance), opacity: opacity[0], filtered: Array.from(filtered), bounds: Array.from(bounds),
      filteredBounds: Array.from(filteredBounds), original, filteredRaster, originalEnergy, filteredEnergy };
  });
  expect(result.filtered[0]).toBeCloseTo(16.6, 5);
  expect(result.filtered[1]).toBe(5);
  expect(result.filtered[2]).toBeCloseTo(9.6, 5);
  expect(result.filtered[3]).toBeLessThan(result.opacity);
  expect(result.original.error).toBe(0);
  expect(result.filteredRaster.error).toBe(0);
  expect(result.original.visible).toBeGreaterThan(100);
  expect(result.filteredRaster.visible).toBeGreaterThan(result.original.visible);
  expect(Math.abs(result.filteredEnergy - result.originalEnergy) / result.originalEnergy).toBeLessThan(2e-6);
  expect(Math.abs(result.filteredRaster.alphaSum - result.original.alphaSum) / result.original.alphaSum).toBeLessThan(.04);
  await writeFile(info.outputPath('gaussian-filter.json'), JSON.stringify(result, null, 2));
});
