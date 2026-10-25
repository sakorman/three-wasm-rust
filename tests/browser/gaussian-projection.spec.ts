import { test, expect } from '@playwright/test';

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
