import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {} from '../../web/engine/types.ts';

declare global {
  interface Window {
    recoveryExtensions: WEBGL_lose_context[];
  }
}

async function ready(page: Page, instanced = false) {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.locator('#count').selectOption('500');
  if (instanced) await page.locator('#comparison').selectOption('instanced');
  await page.getByRole('button', { name: '暂停动画' }).click();
}

async function lose(page: Page, ids: string[]) {
  await page.evaluate(async (ids) => {
    window.recoveryExtensions = [];
    await Promise.all(
      ids.map((id) => {
        const canvas = document.getElementById(id);
        if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing canvas');
        const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
        if (!extension) throw new Error('WEBGL_lose_context unavailable');
        window.recoveryExtensions.push(extension);
        return new Promise<void>((resolve) => {
          canvas.addEventListener('webglcontextlost', () => resolve(), { once: true });
          extension.loseContext();
        });
      }),
    );
  }, ids);
  await expect(page.locator('#status')).toHaveText('等待图形恢复');
  await expect(page.locator('#benchmark')).toBeDisabled();
}

async function restore(page: Page) {
  await page.evaluate(() => {
    for (const extension of window.recoveryExtensions) extension.restoreContext();
  });
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await expect(page.locator('#benchmark')).toBeEnabled();
  await expect(page.locator('#error')).toBeHidden();
}

async function checkPixels(page: Page, reference: string) {
  const result = await page.evaluate(
    (reference) =>
      new Promise<{
        error: number;
        difference: number;
        colored: number;
        referenceColored: number;
        corners: number[][];
      }>((resolve) =>
        requestAnimationFrame(() => {
          const capture = (id: string) => {
            const canvas = document.getElementById(id);
            if (!(canvas instanceof HTMLCanvasElement)) throw new Error('No canvas');
            const gl = canvas.getContext('webgl2');
            if (!gl) throw new Error('No WebGL2');
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return { pixels, error: gl.getError() };
          };
          const a = capture('rust-canvas'),
            b = capture(reference);
          let difference = 0,
            colored = 0,
            referenceColored = 0;
          for (let i = 0; i < a.pixels.length; i += 4) {
            if (a.pixels[i] > 60 || a.pixels[i + 1] > 60) colored++;
            if (b.pixels[i] > 60 || b.pixels[i + 1] > 60) referenceColored++;
            for (let c = 0; c < 3; c++) difference += Math.abs(a.pixels[i + c] - b.pixels[i + c]);
          }
          resolve({
            error: a.error || b.error,
            difference: difference / ((a.pixels.length / 4) * 3),
            colored,
            referenceColored,
            corners: [Array.from(a.pixels.slice(0, 4)), Array.from(b.pixels.slice(0, 4))],
          });
        }),
      ),
    reference,
  );
  expect(result.error).toBe(0);
  expect(result.colored).toBeGreaterThan(1000);
  expect(result.difference, JSON.stringify(result)).toBeLessThan(3);
}

for (const instanced of [false, true]) {
  test(`context recovery preserves scene and camera (${instanced ? 'instanced' : 'direct'})`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await ready(page, instanced);
    const reference = instanced ? 'instanced-canvas' : 'three-canvas';
    const before = await page.evaluate(() => window.engineLab.snapshot());
    for (const ids of [['rust-canvas'], [reference], ['rust-canvas', reference]]) {
      await lose(page, ids);
      await restore(page);
      await checkPixels(page, reference);
      const after = await page.evaluate(() => window.engineLab.snapshot());
      expect(after.objects).toBe(before.objects);
      expect(after.scenario).toBe(before.scenario);
      expect(after.camera).toEqual(before.camera);
      await expect(page.getByRole('button', { name: '继续动画' })).toBeVisible();
    }
    await page.getByRole('button', { name: '继续动画' }).click();
    await expect(page.locator('#fps')).not.toHaveText('—');
    expect(errors).toEqual([]);
  });
}

test('context loss cancels sampling and allows a fresh report after restoration', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.getByRole('button', { name: '运行两组对照' }).click();
  await lose(page, ['rust-canvas']);
  await expect(page.locator('#bench-progress')).toContainText('上下文丢失');
  await expect(page.locator('#download')).toBeHidden();
  await restore(page);
  await page.getByRole('button', { name: '运行两组对照' }).click();
  await expect(page.locator('#bench-progress')).toHaveText('测试完成', { timeout: 100_000 });
  await expect(page.locator('#results tr')).toHaveCount(2);
  await expect(page.locator('#download')).toBeVisible();
});

test('public Engine retains custom transforms through restore and cannot revive after dispose', async ({
  page,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const { Engine, OrbitCamera, createEngineScene } = await import('../../web/engine/index.ts');
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 120;
    const data = createEngineScene('city', 100),
      engine = new Engine(canvas, data, false),
      camera = new OrbitCamera();
    camera.reset(data.extent);
    const frame = camera.frame(160 / 120);
    engine.frame(0, frame, false);
    const transform = data.transforms.slice(0, 10);
    transform[0] += 7;
    engine.graph.set_transform(0, transform);
    engine.graph.update_world_matrices();
    const before = Array.from(engine.graph.world_matrices());
    const extension = engine.gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('No context test extension');
    async function event(name: string, action: () => void) {
      await new Promise<void>((resolve) => {
        canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true });
        action();
      });
    }
    await event('webglcontextlost', () => extension!.loseContext());
    let rejected = false;
    try {
      engine.frame(0, frame, false);
    } catch {
      rejected = true;
    }
    await event('webglcontextrestored', () => extension!.restoreContext());
    const stats = engine.frame(0, frame, false),
      after = Array.from(engine.graph.world_matrices());
    const generation = engine.context.generation;
    await event('webglcontextlost', () => extension!.loseContext());
    engine.dispose();
    engine.dispose();
    await event('webglcontextrestored', () => extension!.restoreContext());
    return { before, after, rejected, draws: stats.draws, generation, state: engine.context.state };
  });
  expect(result.after).toEqual(result.before);
  expect(result.draws).toBe(100);
  expect(result.rejected).toBe(true);
  expect(result.generation).toBe(1);
  expect(result.state).toBe('disposed');
});
