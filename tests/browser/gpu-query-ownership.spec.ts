import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const stop of ['end', 'dispose', 'disjoint'] as const) {
  test(`GPU query ownership survives overlap and interruption (${stop})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    const result = await page.evaluate(async stop => {
      const { GpuTimer } = await import('../../web/compare/GpuTimer.ts');
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) throw new Error('WebGL2 unavailable');
      const getExtension = gl.getExtension.bind(gl), getParameter = gl.getParameter.bind(gl);
      const native = getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      // Occlusion queries exercise the same native ownership rules when timer queries are unavailable.
      const extension = native ?? { TIME_ELAPSED_EXT: gl.ANY_SAMPLES_PASSED, GPU_DISJOINT_EXT: 0x8fbb };
      let disjoint = false;
      Object.defineProperty(gl, 'getExtension', { value: (name: string) => name === 'EXT_disjoint_timer_query_webgl2' ? extension : getExtension(name) });
      Object.defineProperty(gl, 'getParameter', { value: (name: number) => name === extension.GPU_DISJOINT_EXT ? disjoint : getParameter(name) });
      const target = extension.TIME_ELAPSED_EXT;
      const active = () => gl.getQuery(target, gl.CURRENT_QUERY);
      const external = gl.createQuery();
      if (!external) throw new Error('Query allocation failed');
      const timer = new GpuTimer(gl);
      try {
        gl.beginQuery(target, external);
        timer.begin(); timer.end();
        const overlap = { preserved: active() === external, diagnostics: timer.diagnostics, error: gl.getError() };
        if (active()) gl.endQuery(target);

        timer.begin();
        const owned = active();
        if (!owned) throw new Error('Timer did not acquire a query');
        gl.endQuery(target);
        gl.beginQuery(target, external);
        if (stop === 'disjoint') { disjoint = true; timer.poll(); }
        else timer[stop]();
        const interrupted = {
          preserved: active() === external, deleted: !gl.isQuery(owned), diagnostics: timer.diagnostics,
          samples: [...timer.samples], error: gl.getError(),
        };
        timer.dispose();
        const preservedAfterDispose = active() === external;
        if (active()) gl.endQuery(target);

        const retry = new GpuTimer(gl);
        disjoint = false;
        retry.begin(); gl.endQuery(target); retry.end();
        const ended = { diagnostics: retry.diagnostics, samples: [...retry.samples], error: gl.getError() };
        retry.begin();
        const restarted = active() !== null;
        retry.end();
        const queued = retry.diagnostics.pendingQueries;
        retry.dispose();
        return { nativeTimer: native !== null, overlap, interrupted, preservedAfterDispose, ended, restarted, queued, error: gl.getError() };
      } finally {
        timer.dispose();
        if (active()) gl.endQuery(target);
        gl.deleteQuery(external);
      }
    }, stop);
    const path = info.outputPath('gpu-query-ownership.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gpu-query-ownership.json', { path, contentType: 'application/json' });
    expect(result.overlap.preserved).toBe(true);
    expect(result.overlap.error).toBe(0);
    expect(result.overlap.diagnostics.queryConflicts).toBe(1);
    expect(result.overlap.diagnostics.pendingQueries).toBe(0);
    expect(result.interrupted.preserved).toBe(true);
    expect(result.interrupted.deleted).toBe(true);
    expect(result.interrupted.diagnostics.queryConflicts).toBe(2);
    expect(result.interrupted.diagnostics.pendingQueries).toBe(0);
    expect(result.interrupted.samples).toEqual([]);
    expect(result.interrupted.error).toBe(0);
    expect(result.preservedAfterDispose).toBe(true);
    expect(result.ended.diagnostics.queryConflicts).toBe(1);
    expect(result.ended.diagnostics.pendingQueries).toBe(0);
    expect(result.ended.samples).toEqual([]);
    expect(result.ended.error).toBe(0);
    expect(result.restarted).toBe(true);
    expect(result.queued).toBe(1);
    expect(result.error).toBe(0);
  });
}
