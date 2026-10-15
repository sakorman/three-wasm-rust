import { test, expect } from '@playwright/test';
import type { ComparisonReport } from '../../web/compare/benchmark.ts';

for (const comparison of ['direct', 'instanced'] as const) {
  for (const missing of [false, true]) {
    test(`GPU reports require complete sampling (${comparison}, ${missing ? 'missing queries' : 'complete'})`, async ({ page }, info) => {
      await page.addInitScript((missing) => {
        const prototype = WebGL2RenderingContext.prototype;
        const extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
        const queries = new WeakSet<object>();
        const allocations = new WeakMap<WebGL2RenderingContext, number>();
        for (const name of ['getExtension', 'createQuery', 'beginQuery', 'endQuery', 'deleteQuery', 'getParameter', 'getQueryParameter'] as const) {
          const original = prototype[name];
          Object.defineProperty(prototype, name, {
            configurable: true,
            value: new Proxy(original, {
              apply(target, gl: WebGL2RenderingContext, args: unknown[]) {
                if (name === 'getExtension' && args[0] === 'EXT_disjoint_timer_query_webgl2') return extension;
                if (name === 'createQuery') {
                  const count = (allocations.get(gl) ?? 0) + 1;
                  allocations.set(gl, count);
                  if (missing && gl.canvas instanceof HTMLCanvasElement && gl.canvas.id === 'rust-canvas' && count % 4 === 0)
                    return null;
                  const query = {};
                  queries.add(query);
                  return query;
                }
                if (name === 'getParameter' && args[0] === extension.GPU_DISJOINT_EXT) return false;
                if ((name === 'beginQuery' || name === 'endQuery') && args[0] === extension.TIME_ELAPSED_EXT) return;
                if (typeof args[0] === 'object' && args[0] !== null && queries.has(args[0])) {
                  if (name === 'deleteQuery') return;
                  if (name === 'getQueryParameter') return args[1] === gl.QUERY_RESULT_AVAILABLE ? true : 2_500_000;
                }
                return Reflect.apply(target, gl, args);
              },
            }),
          });
        }
      }, missing);
      await page.goto('/');
      await expect(page.locator('#status')).toHaveText('引擎已就绪');
      await page.locator('#count').selectOption('500');
      await page.locator('#comparison').selectOption(comparison);
      await page.getByRole('button', { name: '运行两组对照' }).click();
      await expect(page.locator('#bench-progress')).toHaveText('测试完成', { timeout: 100_000 });
      const event = page.waitForEvent('download');
      await page.getByRole('button', { name: '导出 JSON' }).click();
      const download = await event;
      const path = info.outputPath('gpu-report.json');
      await download.saveAs(path);
      const { readFile } = await import('node:fs/promises');
      const report = JSON.parse(await readFile(path, 'utf8')) as ComparisonReport;
      for (const result of report.results) {
        const partial = missing && result.mode.startsWith('rust');
        expect(result.samples).toHaveLength(96);
        expect(result.gpuExpectedSamples).toBe(96);
        expect(result.gpuSamples).toHaveLength(partial ? 72 : 96);
        expect(result.gpuStatus).toBe(partial ? 'incomplete' : 'available');
        expect(result.gpuMedian).toBe(partial ? null : 2.5);
      }
      if (missing) {
        await expect(page.locator('#results')).toContainText('采样不全');
        await expect(page.locator('#results td').filter({ hasText: '采样不全' }))
          .toHaveAttribute('title', 'GPU 有效样本 72 / 96，未计算中位数。');
      }
      await expect(page.locator('#error')).toBeHidden();
    });
  }
}
