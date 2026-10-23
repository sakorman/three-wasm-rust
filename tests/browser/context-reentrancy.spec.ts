import { test, expect } from '@playwright/test';

for (const mode of ['dispose', 'dispose-throw', 'nested', 'nested-throw'] as const) {
  test(`context restoration handles callback reentry (${mode})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (mode) => {
      const { ContextLifecycle } = await import('../../web/engine/ContextLifecycle.ts');
      const canvas = document.createElement('canvas'), gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('No WebGL2');
      const extension = gl.getExtension('WEBGL_lose_context'); if (!extension) throw new Error('No context test extension');
      let calls = 0, releases = 0;
      const states: string[] = [];
      const lifecycle = new ContextLifecycle(gl, () => {
        calls++;
        if (mode.startsWith('dispose')) lifecycle.dispose();
        // Synchronous event forwarding must not enter the same rebuild twice.
        if (mode.startsWith('nested') && calls === 1)
          canvas.dispatchEvent(new Event('webglcontextrestored'));
        if (mode.endsWith('throw') && calls === 1) throw new Error('rebuild interrupted');
      }, () => { releases++; });
      lifecycle.subscribe(() => states.push(lifecycle.state));
      const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
        canvas.addEventListener(name, (event) => {
          event.preventDefault();
          setTimeout(resolve, 0);
        }, { once: true });
        action();
      });
      const capture = () => {
        let rejection = '';
        try { lifecycle.assertReady(); } catch (error) { rejection = String(error); }
        return { state: lifecycle.state, ready: lifecycle.ready, calls, releases,
          generation: lifecycle.generation, error: lifecycle.error ? String(lifecycle.error) : '', rejection };
      };
      try {
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        const first = capture();
        await event('webglcontextlost', () => extension.loseContext());
        await event('webglcontextrestored', () => extension.restoreContext());
        return { first, second: capture(), states };
      } finally { lifecycle.dispose(); }
    }, mode);
    expect(errors).toEqual([]);
    expect(result.first.calls).toBe(1);
    if (mode.startsWith('dispose')) {
      expect(result.first.state).toBe('disposed');
      expect(result.first.ready).toBe(false);
      expect(result.first.error).toBe('');
      expect(result.first.rejection).toContain('disposed');
      expect(result.second).toEqual(result.first);
      expect(result.states).toEqual(['lost']);
    } else {
      expect(result.first.state).toBe(mode === 'nested' ? 'ready' : 'failed');
      expect(result.first.ready).toBe(mode === 'nested');
      if (mode === 'nested-throw') expect(result.first.error).toContain('rebuild interrupted');
      expect(result.second).toMatchObject({ state: 'ready', ready: true, calls: 2, releases: 2,
        generation: 2, error: '', rejection: '' });
      expect(result.states).toEqual(['lost', mode === 'nested' ? 'ready' : 'failed', 'lost', 'ready']);
    }
  });
}
