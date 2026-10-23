import { test, expect } from '@playwright/test';
import { gaussianCase, compareGaussianQuads } from './fixtures/gaussian-raster.ts';

for (const boundary of [false, true]) {
  test(`opacity-aware Gaussian quads preserve cutoff pixels (${boundary ? 'boundary' : 'ellipses'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const data = gaussianCase(boundary);
    const bounds = await page.evaluate(async ({ covariance, opacity, cutoff }) => {
      const { gaussian_screen_bounds } = await import('../../pkg/three_wasm_rust.js');
      return {
        fixed: Array.from(gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity.length).fill(1), cutoff)),
        adaptive: Array.from(gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity), cutoff)),
      };
    }, data);
    const result = await page.evaluate(compareGaussianQuads, { ...data, ...bounds });
    const { writeFile } = await import('node:fs/promises');
    const path = info.outputPath('gaussian-coverage.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-coverage.json', { path, contentType: 'application/json' });
    expect(result.differentChannels).toBe(0);
    expect(result.visiblePixels).toBeGreaterThan(boundary ? 0 : 1000);
    expect(result.areaReduction).toBeGreaterThan(boundary ? 0.95 : 0.4);
    expect(result.adaptiveDraws).toBeLessThan(result.fixedDraws);
    if (boundary) expect(result.equalCutoffAlpha).toBe(1);
  });
}
