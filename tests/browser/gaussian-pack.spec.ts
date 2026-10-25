import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { gaussianCase, compareGaussianQuads, type GaussianCase } from './fixtures/gaussian-raster.ts';

for (const kind of ['ellipses', 'boundary', 'large'] as const) {
  test(`packed Gaussian bounds preserve f32 coverage through shader unpacking (${kind})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const cutoff = Math.fround(1 / 255);
    // The right edge crosses a pixel center; nearest half rounding removes it.
    const data: GaussianCase = kind === 'large' ? {
      covariance: [Math.fround(2048.25 ** 2 / (2 * Math.log(1 / cutoff))), 0, 100],
      opacity: [1], centers: [Math.fround(128.5 - 2048.2), 96.5], cutoff,
    } : gaussianCase(kind === 'boundary');
    const bounds = await page.evaluate(async ({ covariance, opacity, cutoff }) => {
      const { gaussian_screen_bounds, gaussian_pack_half_extents } = await import('../../pkg/three_wasm_rust.js');
      const extents = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity), cutoff);
      return { fixed: Array.from(extents), adaptive: Array.from(extents), packedExtents: Array.from(gaussian_pack_half_extents(extents)) };
    }, data);
    const result = await page.evaluate(compareGaussianQuads, { ...data, ...bounds });
    let nearestDifferentChannels: number | undefined;
    if (kind === 'large') {
      const nearest = [...bounds.packedExtents];
      nearest[0] = ((nearest[0] & 0xffff0000) | 0x6800) >>> 0; // width 2048 instead of 2050
      const control = await page.evaluate(compareGaussianQuads, { ...data, ...bounds, packedExtents: nearest });
      nearestDifferentChannels = control.differentChannels;
      expect(nearestDifferentChannels).toBeGreaterThan(0);
    }
    const path = info.outputPath('gaussian-pack.json');
    await writeFile(path, JSON.stringify({ ...result, halfExtents: bounds.fixed, packedExtents: bounds.packedExtents, nearestDifferentChannels }, null, 2));
    await info.attach('gaussian-pack.json', { path, contentType: 'application/json' });
    expect(result.visiblePixels).toBeGreaterThan(0);
    expect(result.differentChannels).toBe(0);
    expect(result.compactionDifferentChannels).toBe(0);
    if (kind === 'boundary') expect(result.equalCutoffAlpha).toBe(1);
  });
}
