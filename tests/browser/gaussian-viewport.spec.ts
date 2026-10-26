import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { gaussianCase, compareGaussianQuads } from './fixtures/gaussian-raster.ts';

for (const packed of [false, true]) {
  test(`viewport candidates remove offscreen draws without losing edge pixels (${packed ? 'binary16' : 'f32'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const data = gaussianCase(false);
    for (const center of [[-1000, 96], [1256, 96], [128, -1000], [128, 1192], [-2, 96], [258, 96], [128, -2], [128, 194]]) {
      data.centers.push(...center); data.covariance.push(16, 6, 9); data.opacity.push(1);
    }
    const prepared = await page.evaluate(async ({ data, packed }) => {
      const { gaussian_screen_bounds, gaussian_visible_indices, gaussian_viewport_indices, gaussian_pack_half_extents } =
        await import('../../web/engine/index.ts');
      const bounds = gaussian_screen_bounds(new Float32Array(data.covariance), new Float32Array(data.opacity), data.cutoff);
      const candidates = gaussian_visible_indices(new Float32Array(data.opacity), data.cutoff);
      const packedExtents = packed ? gaussian_pack_half_extents(bounds) : undefined;
      const cullBounds = bounds.slice();
      if (packedExtents) {
        const half = (bits: number) => {
          const exponent = bits >>> 10, fraction = bits & 1023;
          return exponent ? 2 ** (exponent - 15) * (1 + fraction / 1024) : 2 ** -24 * fraction;
        };
        packedExtents.forEach((value, i) => cullBounds.set([half(value & 0xffff), half(value >>> 16)], i * 2));
      }
      const activeIndices = gaussian_viewport_indices(new Float32Array(data.centers), cullBounds, candidates, 256, 192);
      const centerOnly = Array.from(candidates).filter(id => data.centers[id * 2] >= 0 && data.centers[id * 2] <= 256 &&
        data.centers[id * 2 + 1] >= 0 && data.centers[id * 2 + 1] <= 192);
      return { fixed: Array.from(bounds), adaptive: Array.from(bounds), candidates: Array.from(candidates),
        activeIndices: Array.from(activeIndices), centerOnly, packedExtents: packedExtents ? Array.from(packedExtents) : undefined };
    }, { data, packed });
    expect(prepared.candidates).toHaveLength(28);
    expect(prepared.activeIndices).toEqual(prepared.candidates.filter(id => id < 28 || id >= 32));
    expect(prepared.activeIndices).toHaveLength(24);
    const pixels = await page.evaluate(compareGaussianQuads, { ...data, ...prepared });
    const control = await page.evaluate(compareGaussianQuads, { ...data, ...prepared, activeIndices: prepared.centerOnly });
    expect(pixels.differentChannels).toBe(0);
    expect(pixels.compactionDifferentChannels).toBe(0);
    expect(pixels.fixedDraws).toBe(28);
    expect(pixels.adaptiveDraws).toBe(24);
    expect(pixels.visiblePixels).toBeGreaterThan(3000);
    expect(control.differentChannels).toBeGreaterThan(0);
    const path = info.outputPath('gaussian-viewport.json');
    await writeFile(path, JSON.stringify({ packed, candidates: prepared.candidates, activeIndices: prepared.activeIndices,
      pixels, centerOnlyDifferentChannels: control.differentChannels }, null, 2));
    await info.attach('gaussian-viewport.json', { path, contentType: 'application/json' });
  });
}
