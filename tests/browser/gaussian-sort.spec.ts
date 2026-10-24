import { test, expect } from '@playwright/test';
import { compareGaussianQuads } from './fixtures/gaussian-raster.ts';

for (const tied of [false, true]) {
  test(`Gaussian depth ordering preserves the expected alpha composition (${tied ? 'signed-zero ties' : 'far-to-near'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const depths = tied ? [-0, 0] : [1, 5], candidates = tied ? [1, 0] : [0, 1];
    const data = { covariance: [9, 0, 9, 9, 0, 9], opacity: [0.5, 0.5], centers: [128.5, 96.5, 128.5, 96.5], cutoff: Math.fround(1 / 255) };
    const result = await page.evaluate(async ({ data, depths, candidates }) => {
      const { gaussian_screen_bounds, gaussian_depth_order } = await import('../../pkg/three_wasm_rust.js');
      const bounds = Array.from(gaussian_screen_bounds(new Float32Array(data.covariance), new Float32Array(data.opacity), data.cutoff));
      const activeIndices = Array.from(gaussian_depth_order(new Float32Array(depths), new Uint32Array(candidates)));
      return { fixed: bounds, adaptive: bounds, activeIndices };
    }, { data, depths, candidates });
    const referenceIndices = [...candidates].sort((a, b) => depths[b] - depths[a]);
    expect(result.activeIndices).toEqual([1, 0]);
    const pixels = await page.evaluate(compareGaussianQuads, { ...data, ...result, referenceIndices });
    expect(pixels.compactionDifferentChannels).toBe(0);
    expect(pixels.differentChannels).toBeGreaterThan(100);
    const expectedCenter = [0.75, 0.4375, 0.25, 0.75].map((value) => Math.round(value * 255));
    pixels.actualCenter.forEach((value, i) => expect(Math.abs(value - expectedCenter[i])).toBeLessThanOrEqual(1));
    expect(pixels.actualCenter).not.toEqual(pixels.fixedCenter);
    const { writeFile } = await import('node:fs/promises');
    const path = info.outputPath('gaussian-sort.json');
    await writeFile(path, JSON.stringify({ tied, order: result.activeIndices, ...pixels }, null, 2));
    await info.attach('gaussian-sort.json', { path, contentType: 'application/json' });
  });
}
