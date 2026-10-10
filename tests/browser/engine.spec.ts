import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {} from '../../web/engine/types.ts';

declare global {
  interface Window {
    drawAudit: Record<string, { direct: number; instanced: number }>;
  }
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.locator('#count').selectOption('500');
  await expect(page.locator('#fps')).not.toHaveText('—');
}

async function comparePixels(page: Page, reference: string) {
  const result = await page.evaluate(
    (reference) =>
      new Promise<{ difference: number; colored: number; errors: number[] }>((resolve) =>
        requestAnimationFrame(() => {
          const capture = (id: string) => {
            const canvas = document.getElementById(id);
            if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing canvas');
            const gl = canvas.getContext('webgl2');
            if (!gl) throw new Error('Missing context');
            const pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            return { pixels, error: gl.getError() };
          };
          const a = capture('rust-canvas'),
            b = capture(reference);
          let difference = 0,
            colored = 0;
          for (let i = 0; i < a.pixels.length; i += 4) {
            if (a.pixels[i] > 60 || a.pixels[i + 1] > 60) colored++;
            for (let c = 0; c < 3; c++) difference += Math.abs(a.pixels[i + c] - b.pixels[i + c]);
          }
          resolve({
            difference: difference / ((a.pixels.length / 4) * 3),
            colored,
            errors: [a.error, b.error],
          });
        }),
      ),
    reference,
  );
  expect(result.errors).toEqual([0, 0]);
  expect(result.colored).toBeGreaterThan(1000);
  expect(result.difference).toBeLessThan(3);
}

test('all scene presets match native and instanced Three.js pixels', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await ready(page);
  await page.getByRole('button', { name: '暂停动画' }).click();
  for (const scenario of ['city', 'warehouse', 'hierarchy']) {
    await page.locator('#scenario').selectOption(scenario);
    await page.locator('#comparison').selectOption('direct');
    await comparePixels(page, 'three-canvas');
    const stats = await page.evaluate(() => window.engineLab.snapshot().stats);
    expect(stats['rust-direct']?.draws).toBe(500);
    expect(stats.three?.draws).toBe(500);
    await page.locator('#comparison').selectOption('instanced');
    await comparePixels(page, 'instanced-canvas');
    await page.screenshot({ path: info.outputPath(`${scenario}.png`), fullPage: true });
  }
  await page.locator('#culling').uncheck();
  await comparePixels(page, 'instanced-canvas');
  expect(await page.evaluate(() => window.engineLab.snapshot().stats.rust?.visible)).toBe(500);
  await page.locator('#culling').check();
  const bounds = await page.locator('#rust-view').boundingBox();
  if (!bounds) throw new Error('Missing view');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 25, {
    steps: 8,
  });
  await page.mouse.up();
  await comparePixels(page, 'instanced-canvas');
  await page.getByRole('button', { name: '重置视角' }).click();
  await page.getByRole('button', { name: '继续动画' }).click();
  await expect(page.getByRole('button', { name: '暂停动画' })).toBeVisible();
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('serial benchmark exports the non-instanced pair with matching conditions', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.getByRole('button', { name: '运行两组对照' }).click();
  await expect(page.locator('#scenario')).toBeDisabled();
  await expect(page.locator('#bench-progress')).toContainText('测试完成', { timeout: 100_000 });
  await expect(page.locator('#results tr')).toHaveCount(2);
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON' }).click();
  const download = await event;
  const path = info.outputPath('engine-report.json');
  await download.saveAs(path);
  const { readFile } = await import('node:fs/promises');
  const report: unknown = JSON.parse(await readFile(path, 'utf8'));
  expect(report).toEqual(
    expect.objectContaining({
      schemaVersion: 3,
      comparison: 'direct',
      objects: 500,
      protocol: expect.objectContaining({
        rounds: 4,
        sampleFrames: 24,
        instancing: false,
        matrixUpdate: 'full',
        drawOrder: 'scene',
      }),
    }),
  );
  if (
    typeof report !== 'object' ||
    report === null ||
    !('results' in report) ||
    !Array.isArray(report.results)
  )
    throw new Error('Missing results');
  const results: unknown[] = report.results;
  expect(results).toHaveLength(2);
  for (const row of results)
    expect(row).toEqual(
      expect.objectContaining({
        draws: 500,
        visible: 500,
        samples: expect.any(Array),
        cpuMedian: expect.any(Number),
        fps: expect.any(Number),
        gpuStatus: expect.any(String),
      }),
    );
  for (const row of results) {
    if (
      typeof row !== 'object' ||
      row === null ||
      !('samples' in row) ||
      !Array.isArray(row.samples)
    )
      throw new Error('Missing samples');
    expect(row.samples).toHaveLength(96);
    expect(row.samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draws: 500, visible: 500, updated: expect.any(Number) }),
      ]),
    );
  }
  await page.screenshot({ path: info.outputPath('comparison.png'), fullPage: true });
  await expect(page.locator('#scenario')).toBeEnabled();
  await expect(page.locator('#error')).toBeHidden();
  await comparePixels(page, 'three-canvas');
});

test('direct comparison uses no instanced WebGL draw calls on either side', async ({ page }) => {
  await page.addInitScript(() => {
    window.drawAudit = {};
    for (const method of [
      'drawElements',
      'drawArrays',
      'drawElementsInstanced',
      'drawArraysInstanced',
    ] as const) {
      const original = WebGL2RenderingContext.prototype[method];
      Object.defineProperty(WebGL2RenderingContext.prototype, method, {
        configurable: true,
        writable: true,
        value: new Proxy(original, {
          apply(target, gl: WebGL2RenderingContext, args: unknown[]) {
            const id = gl.canvas instanceof HTMLCanvasElement ? gl.canvas.id : 'offscreen';
            const count = (window.drawAudit[id] ??= { direct: 0, instanced: 0 });
            count[method.endsWith('Instanced') ? 'instanced' : 'direct']++;
            return Reflect.apply(target, gl, args);
          },
        }),
      });
    }
  });
  await ready(page);
  await expect(page.locator('#comparison')).toHaveValue('direct');
  await expect(page.locator('#culling')).not.toBeChecked();
  await page.getByRole('button', { name: '暂停动画' }).click();
  const startup = await page.evaluate(() => window.drawAudit);
  expect(startup['rust-canvas'].instanced).toBe(0);
  expect(startup['three-canvas'].instanced).toBe(0);
  const audit = await page.evaluate(async () => {
    window.drawAudit = {};
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { calls: window.drawAudit, state: window.engineLab.snapshot() };
  });
  for (const id of ['rust-canvas', 'three-canvas'])
    expect(audit.calls[id]).toEqual({ direct: 500, instanced: 0 });
  expect(audit.state.stats['rust-direct']?.updated).toBe(audit.state.nodes);
  expect(audit.state.stats.three?.updated).toBe(audit.state.nodes);
  await comparePixels(page, 'three-canvas');
});

test('instanced comparison remains available as a separate paired benchmark', async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page);
  await page.locator('#comparison').selectOption('instanced');
  await page.getByRole('button', { name: '运行两组对照' }).click();
  await expect(page.locator('#bench-progress')).toContainText('测试完成', { timeout: 100_000 });
  await expect(page.locator('#results tr')).toHaveCount(2);
  await expect(page.locator('#results')).toContainText('Rust 引擎 · 实例化');
  await expect(page.locator('#results')).toContainText('Three.js · 实例化');
  await expect(page.locator('#report-context')).toContainText('实例化 / 脏更新');
  await comparePixels(page, 'instanced-canvas');
});

test('benchmark cancellation restores controls; mobile view fits', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '运行两组对照' }).click();
  await page.getByRole('button', { name: '取消测试' }).click();
  await expect(page.locator('#bench-progress')).toContainText('取消');
  await expect(page.locator('#scenario')).toBeEnabled();
  await page.getByRole('button', { name: '暂停动画' }).click();
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
  await comparePixels(page, 'three-canvas');
});

test('engine handles missing WebGL2 with an actionable error', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = new Proxy(original, {
      apply(target, canvas: HTMLCanvasElement, args: [string, ...unknown[]]) {
        return args[0] === 'webgl2' ? null : Reflect.apply(target, canvas, args);
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('WebGL2');
  await expect(page.locator('#benchmark')).toBeDisabled();
});

test('resizing during sampling cancels the report instead of mixing resolutions', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: '运行两组对照' }).click();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect(page.locator('#bench-progress')).toContainText('尺寸改变');
  await expect(page.locator('#scenario')).toBeEnabled();
  await expect(page.locator('#download')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();
});

test('large scenes can be rebuilt and released without losing either renderer', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: '暂停动画' }).click();
  await page.locator('#comparison').selectOption('instanced');
  await page.locator('#count').selectOption('20000');
  await comparePixels(page, 'instanced-canvas');
  expect(await page.evaluate(() => window.engineLab.snapshot().objects)).toBe(20000);
  await page.locator('#count').selectOption('500');
  await page.locator('#comparison').selectOption('direct');
  await comparePixels(page, 'three-canvas');
  await expect(page.locator('#error')).toBeHidden();
});
