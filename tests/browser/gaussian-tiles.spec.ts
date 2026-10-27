import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test('tile bins preserve filtered Gaussian raster output with per-tile depth order', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const result = await page.evaluate(async () => {
    const { gaussian_depth_order, gaussian_filter_screen_covariances, gaussian_screen_bounds, gaussian_tile_bins, gaussian_tile_depth_order, gaussian_visible_indices } =
      await import('../../web/engine/index.ts');
    const width = 256, height = 192, tileSize = 32, cutoff = Math.fround(1 / 255);
    const centers = new Float32Array([
      80, 80, 84, 80, 80, 84, 84, 84, 88, 80, 80, 88, 88, 88, 84, 88,
    ]);
    const originalCovariance = new Float32Array([
      20, 5, 11, 16, -3, 9, 28, 8, 18, 12, -4, 24,
      36, 10, 15, 11, 3, 25, 22, -7, 17, 14, 2, 30,
    ]);
    const originalOpacity = new Float32Array([.7, .5, .8, .35, .65, .45, .75, .55]);
    const filtered = gaussian_filter_screen_covariances(originalCovariance, originalOpacity, .3);
    const covariance = new Float32Array(originalOpacity.length * 3), opacity = new Float32Array(originalOpacity.length);
    for (let index = 0; index < opacity.length; index++) {
      covariance.set(filtered.slice(index * 4, index * 4 + 3), index * 3);
      opacity[index] = filtered[index * 4 + 3];
    }
    const bounds = gaussian_screen_bounds(covariance, opacity, cutoff);
    const candidates = gaussian_visible_indices(opacity, cutoff);
    const depths = new Float32Array([1, 8, 2, 7, 3, 6, 4, 5]);
    const globallyOrdered = gaussian_depth_order(depths, candidates);
    const packed = gaussian_tile_bins(centers, bounds, candidates, width, height, tileSize);
    const columns = Math.ceil(width / tileSize), rows = Math.ceil(height / tileSize), offsetCount = columns * rows + 1;
    const sortedPacked = gaussian_tile_depth_order(depths, packed, columns * rows);
    const offsets = sortedPacked.slice(0, offsetCount), entries = sortedPacked.slice(offsetCount), unsortedEntries = packed.slice(offsetCount);
    const raster = (tiled: boolean, tileEntries = entries) => {
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
uniform vec3 conic, color;
uniform float opacity, cutoff;
out vec4 outputColor;
void main() { vec2 d = gl_FragCoord.xy - center; float q = conic.x*d.x*d.x + 2.0*conic.y*d.x*d.y + conic.z*d.y*d.y;
  float alpha = opacity * exp(-0.5*q); if (alpha < cutoff) discard; outputColor = vec4(color * alpha, alpha); }`);
      const program = gl.createProgram(); if (!program) throw new Error('Program allocation failed');
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Program link failed');
      try {
        const uniform = (name: string) => { const value = gl.getUniformLocation(program, name); if (!value) throw new Error(`Missing ${name}`); return value; };
        const center = uniform('center'), extent = uniform('extent'), conic = uniform('conic');
        const alpha = uniform('opacity'), threshold = uniform('cutoff'), color = uniform('color');
        const draw = (id: number) => {
          const covarianceOffset = id * 3, centerOffset = id * 2;
          const xx = covariance[covarianceOffset], xy = covariance[covarianceOffset + 1], yy = covariance[covarianceOffset + 2];
          const determinant = xx * yy - xy * xy;
          gl.uniform2f(center, centers[centerOffset], centers[centerOffset + 1]);
          gl.uniform2f(extent, bounds[centerOffset], bounds[centerOffset + 1]);
          gl.uniform3f(conic, yy / determinant, -xy / determinant, xx / determinant);
          gl.uniform1f(alpha, opacity[id]); gl.uniform3f(color, id % 2 ? .3 : .8, id % 3 ? .55 : .2, .7);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        };
        gl.useProgram(program); gl.viewport(0, 0, width, height); gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(threshold, cutoff); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        let draws = 0;
        if (tiled) {
          gl.enable(gl.SCISSOR_TEST);
          for (let tileY = 0; tileY < rows; tileY++) for (let tileX = 0; tileX < columns; tileX++) {
            const tile = tileY * columns + tileX;
            gl.scissor(tileX * tileSize, tileY * tileSize, Math.min(tileSize, width - tileX * tileSize), Math.min(tileSize, height - tileY * tileSize));
            for (let cursor = offsets[tile]; cursor < offsets[tile + 1]; cursor++) { draw(tileEntries[cursor]); draws++; }
          }
          gl.disable(gl.SCISSOR_TEST);
        } else {
          for (const id of globallyOrdered) { draw(id); draws++; }
        }
        const pixels = new Uint8Array(width * height * 4); gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return { pixels: Array.from(pixels), draws, error: gl.getError() };
      } finally { gl.deleteProgram(program); }
    };
    const full = raster(false), tiled = raster(true), unsorted = raster(true, unsortedEntries);
    let differentChannels = 0, unorderedDifferentChannels = 0, visiblePixels = 0, largestTile = 0;
    for (let index = 0; index < full.pixels.length; index++) if (full.pixels[index] !== tiled.pixels[index]) differentChannels++;
    for (let index = 0; index < full.pixels.length; index++) if (full.pixels[index] !== unsorted.pixels[index]) unorderedDifferentChannels++;
    for (let index = 3; index < tiled.pixels.length; index += 4) if (tiled.pixels[index]) visiblePixels++;
    for (let tile = 0; tile < offsets.length - 1; tile++) largestTile = Math.max(largestTile, offsets[tile + 1] - offsets[tile]);
    return { candidates: Array.from(candidates), globallyOrdered: Array.from(globallyOrdered), offsets: Array.from(offsets), referenceCount: entries.length, largestTile,
      full: { draws: full.draws, error: full.error }, tiled: { draws: tiled.draws, error: tiled.error }, unsorted: { draws: unsorted.draws, error: unsorted.error },
      differentChannels, unorderedDifferentChannels, visiblePixels };
  });
  expect(result.full.error).toBe(0);
  expect(result.tiled.error).toBe(0);
  expect(result.unsorted.error).toBe(0);
  expect(result.referenceCount).toBeGreaterThan(result.candidates.length);
  expect(result.largestTile).toBeGreaterThan(1);
  expect(result.tiled.draws).toBe(result.referenceCount);
  expect(result.differentChannels).toBe(0);
  expect(result.unorderedDifferentChannels).toBeGreaterThan(0);
  expect(result.visiblePixels).toBeGreaterThan(1000);
  await writeFile(info.outputPath('gaussian-tiles.json'), JSON.stringify(result, null, 2));
});
