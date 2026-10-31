import { test, expect } from '@playwright/test';
import type { ComparisonReport } from '../../web/compare/benchmark.ts';

for (const comparison of ['direct', 'instanced'] as const) {
  for (const fault of ['complete', 'allocation', 'invalid', 'pending', 'unsupported', 'disjoint', 'busy', 'interrupted'] as const) {
    test(`GPU reports explain missing samples (${comparison}, ${fault})`, async ({ page }, info) => {
      await page.addInitScript((fault) => {
        const prototype = WebGL2RenderingContext.prototype;
        const extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
        const queries = new WeakMap<object, number>();
        const allocations = new WeakMap<WebGL2RenderingContext, number>();
        const active = new WeakMap<WebGL2RenderingContext, object>();
        const attempts = new WeakMap<WebGL2RenderingContext, number>();
        const external = {};
        for (const name of ['getExtension', 'createQuery', 'beginQuery', 'endQuery', 'deleteQuery', 'getQuery', 'getParameter', 'getQueryParameter'] as const) {
          const original = prototype[name];
          Object.defineProperty(prototype, name, {
            configurable: true,
            value: new Proxy(original, {
              apply(target, gl: WebGL2RenderingContext, args: unknown[]) {
                const affected = gl.canvas instanceof HTMLCanvasElement && gl.canvas.id === 'rust-canvas';
                if (name === 'getExtension' && args[0] === 'EXT_disjoint_timer_query_webgl2')
                  return affected && fault === 'unsupported' ? null : extension;
                if (name === 'createQuery') {
                  const count = (allocations.get(gl) ?? 0) + 1;
                  allocations.set(gl, count);
                  if (affected && fault === 'allocation' && count % 4 === 0)
                    return null;
                  const query = {};
                  queries.set(query, count);
                  return query;
                }
                if (name === 'getParameter' && args[0] === extension.GPU_DISJOINT_EXT)
                  return affected && fault === 'disjoint';
                if (args[0] === extension.TIME_ELAPSED_EXT) {
                  if (name === 'getQuery' && args[1] === gl.CURRENT_QUERY) {
                    const query = active.get(gl);
                    if (query) return query;
                    const count = (attempts.get(gl) ?? 0) + 1;
                    attempts.set(gl, count);
                    return affected && fault === 'busy' && count % 4 === 0 ? external : null;
                  }
                  if (name === 'beginQuery') {
                    const query = args[1] as object;
                    // Simulate another owner ending this interval before timer.end().
                    active.set(gl, affected && fault === 'interrupted' && queries.get(query)! % 4 === 0 ? external : query);
                    return;
                  }
                  if (name === 'endQuery') { active.delete(gl); return; }
                }
                if (typeof args[0] === 'object' && args[0] !== null && queries.has(args[0])) {
                  if (name === 'deleteQuery') { if (active.get(gl) === external) active.delete(gl); return; }
                  if (name === 'getQueryParameter') {
                    if (args[1] === gl.QUERY_RESULT_AVAILABLE) return !(affected && fault === 'pending');
                    return affected && fault === 'invalid' && queries.get(args[0])! % 4 === 0 ? NaN : 2_500_000;
                  }
                }
                return Reflect.apply(target, gl, args);
              },
            }),
          });
        }
      }, fault);
      await page.goto('./');
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
        const reason = result.mode.startsWith('rust') ? fault : 'complete';
        const partial = reason === 'allocation' || reason === 'invalid' || reason === 'busy' || reason === 'interrupted';
        const complete = reason === 'complete';
        expect(result.samples).toHaveLength(96);
        expect(result.gpuExpectedSamples).toBe(96);
        expect(result.gpuSamples).toHaveLength(complete ? 96 : partial ? 72 : 0);
        expect(result.gpuStatus).toBe(complete ? 'available' : partial ? 'incomplete' : reason === 'pending' ? 'unavailable' : reason);
        expect(result.gpuMedian).toBe(complete ? 2.5 : null);
        expect(result.gpuDiagnostics).toEqual({
          allocationFailures: reason === 'allocation' ? 24 : 0,
          queueLimitSkips: reason === 'pending' ? 64 : 0,
          invalidResults: reason === 'invalid' ? 24 : 0,
          queryConflicts: reason === 'busy' || reason === 'interrupted' ? 24 : 0,
          pendingQueries: reason === 'pending' ? 32 : 0,
          unsupportedRounds: reason === 'unsupported' ? 4 : 0,
          disjointRounds: reason === 'disjoint' ? 4 : 0,
        });
      }
      if (fault === 'allocation' || fault === 'invalid' || fault === 'busy' || fault === 'interrupted') {
        await expect(page.locator('#results')).toContainText('采样不全');
        await expect(page.locator('#results td').filter({ hasText: '采样不全' }))
          .toHaveAttribute('title', 'GPU 有效样本 72 / 96，未计算中位数。');
      }
      await expect(page.locator('#error')).toBeHidden();
    });
  }
}
