import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { compareGaussianQuads } from './fixtures/gaussian-raster.ts';

test('3D Gaussian covariance projection keeps the perspective Jacobian in WASM', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const result = await page.evaluate(async () => {
    const { gaussian_project_covariances } = await import('../../web/engine/index.ts');
    const projected = gaussian_project_covariances(
      new Float32Array([2, 3, 10]),
      new Float32Array([1, 0.2, 0.1, 4, 0.3, 9]),
      100, 200, 320, 240,
    );
    let invalid = '';
    try {
      gaussian_project_covariances(new Float32Array([0, 0, 2, 0, 0, -1]),
        new Float32Array([1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1]), 100, 200, 0, 0);
    } catch (error) { invalid = String(error); }
    return { projected: Array.from(projected), invalid };
  });
  expect(result.projected.slice(0, 3)).toEqual([340, 300, 10]);
  expect(Math.abs(result.projected[3] - 132)).toBeLessThan(1e-5);
  expect(Math.abs(result.projected[4] - 130)).toBeLessThan(1e-5);
  expect(Math.abs(result.projected[5] - 1852)).toBeLessThan(1e-5);
  expect(result.invalid).toMatch(/splat 1/);
});

test('projection rejects rounded degeneracy and recovers through bounds, packing and rasterization', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const prepared = await page.evaluate(async () => {
    const { gaussian_project_covariances, gaussian_screen_bounds, gaussian_pack_half_extents, gaussian_depth_order } =
      await import('../../web/engine/index.ts');
    const rejected: string[] = [];
    const identityCovariance = new Float32Array([1, 0, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1]);
    for (const center of [[0, 0, 1e30], [1e5, 1e5, 1], [1e5, 100001, 1]]) {
      try {
        gaussian_project_covariances(new Float32Array([0, 0, 1, ...center]), identityCovariance, 1, 1, 0, 0);
      } catch (error) { rejected.push(String(error)); }
    }
    const projected = gaussian_project_covariances(new Float32Array([2, 3, 10, -2, 1, 5, 0, 0, 2]),
      new Float32Array(Array.from({ length: 3 }, () => [1, 0.2, 0.1, 4, 0.3, 9]).flat()), 10, 20, 126, 90);
    const centers: number[] = [], covariance: number[] = [], depths: number[] = [];
    for (let i = 0; i < projected.length; i += 6) {
      centers.push(projected[i], projected[i + 1]); depths.push(projected[i + 2]);
      covariance.push(...projected.slice(i + 3, i + 6));
    }
    const opacity = [0.5, Math.fround(0.2), 1], cutoff = Math.fround(1 / 255);
    const fixed = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(3).fill(1), cutoff);
    const adaptive = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity), cutoff);
    const indices = gaussian_depth_order(new Float32Array(depths), new Uint32Array([2, 0, 1]));
    return { rejected, projected: Array.from(projected), data: {
      centers, covariance, opacity, cutoff, fixed: Array.from(fixed), adaptive: Array.from(adaptive),
      packedExtents: Array.from(gaussian_pack_half_extents(adaptive)), activeIndices: Array.from(indices),
    } };
  });
  expect(prepared.rejected).toHaveLength(3);
  for (const error of prepared.rejected) expect(error).toMatch(/positive definite in f32 at splat 1/);
  expect(prepared.data.activeIndices).toEqual([0, 1, 2]);
  const pixels = await page.evaluate(compareGaussianQuads, prepared.data);
  expect(pixels.differentChannels).toBe(0);
  expect(pixels.compactionDifferentChannels).toBe(0);
  expect(pixels.visiblePixels).toBeGreaterThan(500);
  const path = info.outputPath('gaussian-projection.json');
  await writeFile(path, JSON.stringify({ rejected: prepared.rejected, projected: prepared.projected, pixels }, null, 2));
  await info.attach('gaussian-projection.json', { path, contentType: 'application/json' });
});
