import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {} from '../../web/engine/types.ts';

declare global {
  interface Window {
    recoveryFault: {
      failing: boolean;
      allocations: number;
      draws: number;
      extension: WEBGL_lose_context;
    };
  }
}

async function contextEvent(page: Page, restore: boolean) {
  await page.evaluate((restore) => new Promise<void>((resolve) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#rust-canvas')!;
    canvas.addEventListener(restore ? 'webglcontextrestored' : 'webglcontextlost',
      () => setTimeout(resolve, 0), { once: true });
    const extension = window.recoveryFault.extension;
    if (restore) extension.restoreContext();
    else { window.recoveryFault.draws = 0; extension.loseContext(); }
  }), restore);
}

async function capture(page: Page) {
  return page.evaluate(() => new Promise<{ hash: number; colored: number; error: number }>((resolve) => {
    requestAnimationFrame(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#rust-canvas')!;
      const gl = canvas.getContext('webgl2')!;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 2166136261, colored = 0;
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 60 || pixels[i + 1] > 60) colored++;
      resolve({ hash, colored, error: gl.getError() });
    });
  }));
}

for (const comparison of ['direct', 'instanced']) {
  test(`a new context restores the workbench after repeated allocation failure (${comparison})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('./');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.locator('#count').selectOption('500');
    await page.locator('#comparison').selectOption(comparison);
    await page.getByRole('button', { name: '暂停动画' }).click();
    const before = await capture(page), snapshot = await page.evaluate(() => window.engineLab.snapshot());
    await page.evaluate(() => {
      const gl = document.querySelector<HTMLCanvasElement>('#rust-canvas')!.getContext('webgl2')!;
      const extension = gl.getExtension('WEBGL_lose_context');
      if (!extension) throw new Error('No context test extension');
      const fault = window.recoveryFault = { failing: true, allocations: 0, draws: 0, extension };
      Object.defineProperty(gl, 'bufferData', { value: new Proxy(gl.bufferData, {
        apply(target, context, args: unknown[]) {
          fault.allocations++;
          if (fault.failing) return;
          return Reflect.apply(target, context, args);
        },
      }) });
      for (const name of ['drawElements', 'drawElementsInstanced'] as const)
        Object.defineProperty(gl, name, { value: new Proxy(gl[name], {
          apply(target, context, args: unknown[]) { fault.draws++; return Reflect.apply(target, context, args); },
        }) });
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await contextEvent(page, false);
      await expect(page.locator('#status')).toHaveText('等待图形恢复');
      await contextEvent(page, true);
      await expect(page.locator('#status')).toHaveText('图形恢复失败');
      await expect(page.locator('#error')).toContainText('allocation failed');
      await expect(page.locator('#benchmark')).toBeDisabled();
      await expect(page.locator('#download')).toBeHidden();
      // Waiting frames must neither submit draws nor repeatedly allocate resources.
      const allocationCounts = await page.evaluate(async () => {
        const before = window.recoveryFault.allocations;
        for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
        return { before, after: window.recoveryFault.allocations, draws: window.recoveryFault.draws };
      });
      expect(allocationCounts.after).toBe(allocationCounts.before);
      expect(allocationCounts.draws).toBe(0);
    }
    await page.evaluate(() => { window.recoveryFault.failing = false; });
    await contextEvent(page, false);
    await expect(page.locator('#error')).toBeHidden();
    await contextEvent(page, true);
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await expect(page.locator('#benchmark')).toBeEnabled();
    await expect(page.locator('#error')).toBeHidden();
    await expect(page.getByRole('button', { name: '继续动画' })).toBeEnabled();
    const after = await capture(page);
    expect(after.colored).toBeGreaterThan(1000);
    expect(after.error).toBe(0);
    expect(after).toEqual(before);
    expect((await page.evaluate(() => window.engineLab.snapshot())).camera).toEqual(snapshot.camera);
    expect(errors).toEqual([]);
  });
}
