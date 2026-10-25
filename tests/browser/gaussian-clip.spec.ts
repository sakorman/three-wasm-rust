import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { compareGaussianQuads } from './fixtures/gaussian-raster.ts';

test('depth candidates remove behind-camera splats before projection and preserve raster coverage', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const prepared = await page.evaluate(async () => {
    const { gaussian_visible_indices, gaussian_clip_depth_indices, gaussian_depth_order,
      gaussian_project_covariances, gaussian_screen_bounds, gaussian_pack_half_extents } = await import('../../web/engine/index.ts');
    const centers = new Float32Array([0, 0, -1, 0, 0, 0, 0, 0, 0.5, -0.25, 0, 2,
      0.25, 0, 4, 0, 0, 10, 0, 0, 11, 0, 0, 3]);
    const covariance3d = new Float32Array(Array.from({ length: 8 }, () => [0.01, 0, 0, 0.02, 0, 0.01]).flat());
    const opacities = new Float32Array([1, 1, 1, 0.5, 0.2, 1, 1, 0]), cutoff = Math.fround(1 / 255);
    const depths = Float32Array.from(opacities, (_, i) => centers[i * 3 + 2]);
    const visible = gaussian_visible_indices(opacities, cutoff);
    const candidates = new Uint32Array([4, 0, 5, 1, 3, 2, 6, 7].filter(id => visible.includes(id)));
    const clipped = gaussian_clip_depth_indices(depths, candidates, 2, 10);
    const order = gaussian_depth_order(depths, clipped);
    const expected = Array.from(candidates).filter(id => depths[id] >= 2 && depths[id] <= 10).sort((a, b) => depths[b] - depths[a]);
    const gather = (array: Float32Array, stride: number, ids: ArrayLike<number>) =>
      new Float32Array(Array.from(ids, id => Array.from(array.slice(id * stride, id * stride + stride))).flat());
    let unfilteredError = '';
    try { gaussian_project_covariances(centers, covariance3d, 128, 128, 128, 96); }
    catch (error) { unfilteredError = String(error); }
    const projected = gaussian_project_covariances(gather(centers, 3, order), gather(covariance3d, 6, order), 128, 128, 128, 96);
    const reference = gaussian_project_covariances(gather(centers, 3, expected), gather(covariance3d, 6, expected), 128, 128, 128, 96);
    const screenCenters: number[] = [], covariance: number[] = [];
    for (let i = 0; i < projected.length; i += 6) {
      screenCenters.push(projected[i], projected[i + 1]); covariance.push(...projected.slice(i + 3, i + 6));
    }
    const opacity = Array.from(gather(opacities, 1, order));
    const fixed = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(3).fill(1), cutoff);
    const adaptive = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity), cutoff);
    return { visible: Array.from(visible), clipped: Array.from(clipped), order: Array.from(order), expected,
      projected: Array.from(projected), reference: Array.from(reference), unfilteredError,
      data: { centers: screenCenters, covariance, opacity, cutoff, fixed: Array.from(fixed), adaptive: Array.from(adaptive),
        packedExtents: Array.from(gaussian_pack_half_extents(adaptive)) } };
  });
  expect(prepared.visible).toHaveLength(7);
  expect(prepared.clipped).toEqual([4, 5, 3]);
  expect(prepared.order).toEqual([5, 4, 3]);
  expect(prepared.order).toEqual(prepared.expected);
  expect(prepared.projected).toEqual(prepared.reference);
  expect(prepared.data.opacity).toEqual([1, Math.fround(0.2), 0.5]);
  expect(prepared.unfilteredError).toMatch(/invalid Gaussian center, depth or covariance at splat 0/);
  const pixels = await page.evaluate(compareGaussianQuads, prepared.data);
  expect(pixels.differentChannels).toBe(0);
  expect(pixels.visiblePixels).toBeGreaterThan(500);
  expect(pixels.adaptiveDraws).toBe(3);
  const path = info.outputPath('gaussian-clip.json');
  await writeFile(path, JSON.stringify({ ...prepared, pixels }, null, 2));
  await info.attach('gaussian-clip.json', { path, contentType: 'application/json' });
});
