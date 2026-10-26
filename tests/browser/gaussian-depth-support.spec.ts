import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { compareGaussianQuads } from './fixtures/gaussian-raster.ts';

test('support-depth candidates preserve near and far crossing splats without losing raster coverage', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const prepared = await page.evaluate(async () => {
    const { gaussian_visible_indices, gaussian_clip_depth_indices, gaussian_clip_depth_support_indices,
      gaussian_depth_order, gaussian_project_covariances, gaussian_screen_bounds, gaussian_pack_half_extents } =
      await import('../../web/engine/index.ts');
    const cutoff = Math.fround(1 / 255), near = 2, far = 10;
    const centers = new Float32Array([
      -.35, -.05, 1.8, .05, .1, 2.6, .3, -.1, 10.2, .5, .2, 1.1, 0, 0, .8,
    ]);
    const covariance3d = new Float32Array([
      .02, 0, 0, .02, 0, .04, .02, 0, 0, .02, 0, .03, .03, 0, 0, .02, 0, .04,
      .01, 0, 0, .01, 0, .01, .01, 0, 0, .01, 0, .01,
    ]);
    const opacities = new Float32Array([1, .7, 1, 1, 0]);
    const candidates = new Uint32Array([2, 0, 3, 1].filter(id => gaussian_visible_indices(opacities, cutoff).includes(id)));
    const depths = Float32Array.from(opacities, (_, index) => centers[index * 3 + 2]);
    const centerClipped = gaussian_clip_depth_indices(depths, candidates, near, far);
    const supportClipped = gaussian_clip_depth_support_indices(centers, covariance3d, opacities, candidates, cutoff, near, far);
    const order = gaussian_depth_order(depths, supportClipped);
    const centerOrder = gaussian_depth_order(depths, centerClipped);
    const gather = (source: Float32Array, stride: number, ids: ArrayLike<number>) =>
      new Float32Array(Array.from(ids, id => Array.from(source.slice(id * stride, id * stride + stride))).flat());
    const projected = gaussian_project_covariances(gather(centers, 3, order), gather(covariance3d, 6, order), 128, 128, 128, 96);
    const screenCenters: number[] = [], covariance: number[] = [];
    for (let index = 0; index < projected.length; index += 6) {
      screenCenters.push(projected[index], projected[index + 1]);
      covariance.push(...projected.slice(index + 3, index + 6));
    }
    const opacity = Array.from(gather(opacities, 1, order));
    const fixed = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity.length).fill(1), cutoff);
    const adaptive = gaussian_screen_bounds(new Float32Array(covariance), new Float32Array(opacity), cutoff);
    const all = Array.from(order.keys());
    const data = { centers: screenCenters, covariance, opacity, cutoff, fixed: Array.from(fixed), adaptive: Array.from(adaptive),
      activeIndices: all, referenceIndices: all, packedExtents: Array.from(gaussian_pack_half_extents(adaptive)) };
    return { candidates: Array.from(candidates), centerClipped: Array.from(centerClipped), supportClipped: Array.from(supportClipped),
      order: Array.from(order), centerOrder: Array.from(centerOrder), centerLocal: Array.from(centerOrder, id => order.indexOf(id)), data };
  });
  expect(prepared.candidates).toEqual([2, 0, 3, 1]);
  expect(prepared.centerClipped).toEqual([1]);
  expect(prepared.supportClipped).toEqual([2, 0, 1]);
  expect(prepared.order).toEqual([2, 1, 0]);
  expect(prepared.centerLocal).toEqual([1]);
  const coverage = await page.evaluate(compareGaussianQuads, prepared.data);
  const centerOnly = await page.evaluate(compareGaussianQuads, { ...prepared.data, activeIndices: prepared.centerLocal });
  expect(coverage.differentChannels).toBe(0);
  expect(coverage.compactionDifferentChannels).toBe(0);
  expect(coverage.visiblePixels).toBeGreaterThan(500);
  expect(coverage.adaptiveDraws).toBe(3);
  expect(centerOnly.differentChannels).toBeGreaterThan(0);
  const path = info.outputPath('gaussian-depth-support.json');
  await writeFile(path, JSON.stringify({ ...prepared, coverage, centerOnly }, null, 2));
  await info.attach('gaussian-depth-support.json', { path, contentType: 'application/json' });
});
