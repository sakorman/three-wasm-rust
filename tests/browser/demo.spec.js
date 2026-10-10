import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('WASM 已就绪');
  await expect(page.locator('#fps')).not.toHaveText('—');
}

async function hasRenderedGeometry(page, id) {
  const result = await page.evaluate(id => new Promise(resolve => requestAnimationFrame(() => {
    const canvas = document.getElementById(id), gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 60 || pixels[i + 1] > 60) colored++;
    resolve({ colored, error: gl.getError() });
  })), id);
  expect(result.error).toBe(0);
  expect(result.colored).toBeGreaterThan(1000);
}

test('three backends render, pause/resume, scale, orbit and reset', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await hasRenderedGeometry(page, 'rust-canvas');
  await page.getByRole('button', { name: '暂停动画' }).click();
  await expect(page.getByRole('button', { name: '继续动画' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('desktop-rust.png'), fullPage: true });
  for (const mode of ['hybrid', 'javascript', 'rust']) {
    await page.locator('#mode').selectOption(mode);
    await hasRenderedGeometry(page, mode === 'rust' ? 'rust-canvas' : 'three-canvas');
  }
  await page.locator('#count').selectOption('20000');
  await hasRenderedGeometry(page, 'rust-canvas');
  await page.screenshot({ path: info.outputPath('desktop-dense.png'), fullPage: true });
  const stage = await page.locator('#stage').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down(); await page.mouse.move(stage.x + stage.width / 2 + 150, stage.y + 180, { steps: 10 }); await page.mouse.up();
  await page.mouse.wheel(0, 180);
  await page.getByRole('button', { name: '重置视角' }).click();
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '继续动画' }).click();
  await expect(page.getByRole('button', { name: '暂停动画' })).toBeVisible();
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('benchmark computes five measurements and downloads a reproducible JSON report', async ({ page }, info) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await page.locator('#count').selectOption('1000');
  await page.getByRole('button', { name: '运行性能对照' }).click();
  await expect(page.locator('#bench-progress')).toContainText('测试完成', { timeout: 60_000 });
  await expect(page.locator('#results tr')).toHaveCount(5);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON' }).click();
  const download = await downloadEvent;
  await download.saveAs(info.outputPath('benchmark.json'));
  const { readFile } = await import('node:fs/promises');
  const report = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(report.rows).toHaveLength(5);
  expect(report.count).toBe(1000);
  for (const row of report.rows) {
    expect(row.wasm.samplesMs).toHaveLength(7);
    expect(row.wasm.medianMs).toBeGreaterThanOrEqual(0);
  }
  await page.screenshot({ path: info.outputPath('benchmark.png'), fullPage: true });
  await expect(page.locator('#mode')).toBeEnabled();
  await expect(page.locator('#error')).toBeHidden();
  expect(errors).toEqual([]);
});

test('mobile layout fits, and all backends remain selectable', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '暂停动画' }).click();
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
  await page.locator('#mode').selectOption('javascript');
  await hasRenderedGeometry(page, 'three-canvas');
});

test('missing WebGL2 produces a visible error instead of a blank canvas', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      return kind === 'webgl2' ? null : original.call(this, kind, ...args);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('运行失败');
  await expect(page.locator('#mode')).toBeDisabled();
});

test('temporary zero-size layout preserves a usable projection and recovers', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const stage = document.getElementById('stage');
    stage.style.width = '0px'; stage.style.height = '0px';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect(page.locator('#status')).toHaveText('WASM 已就绪');
  await page.evaluate(() => {
    const stage = document.getElementById('stage');
    stage.style.width = ''; stage.style.height = '';
  });
  await hasRenderedGeometry(page, 'rust-canvas');
  await expect(page.locator('#error')).toBeHidden();
});
