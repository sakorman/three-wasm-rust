import { expect, test } from '@playwright/test';

for (const tiled of [false, true]) {
  test(`PLY camera can cross the model and return (${tiled ? 'tiles' : 'full'})`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    const result = await page.evaluate(async tiled => {
      const { ContextLifecycle, GaussianPlyRenderer, GaussianRasterRenderer, parseGaussianSplatPly,
        prepareGaussianPlyForThreeCamera, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
      const { syntheticPly, viewOptions, clear, pixels, difference } = await import('../../tests/browser/fixtures/gaussian-ply-view.ts');
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const context = new ContextLifecycle(gl), owner = new GaussianPlyRenderer(gl, context);
      const reference = new GaussianRasterRenderer(gl, context), input = syntheticPly();
      const source = parseGaussianSplatPly(input), options = viewOptions(tiled);
      // Known visible source IDs for this camera path; no production culling in the oracle.
      const path = [{ z: 5, ids: [0, 1, 2] }, { z: 2.5, ids: [0] }, { z: 1, ids: [] }, { z: 5, ids: [0, 1, 2] }];
      try {
        owner.loadPly(input);
        const frames = path.map(({ z, ids }) => {
          options.threeWorldToView[14] = -z;
          options.threeCameraWorldPosition[2] = z;
          clear(gl); const stats = owner.render(options), actual = pixels(gl);
          const subset = (values: Float32Array, stride: number) => Float32Array.from(ids.flatMap(
            id => Array.from(values.subarray(id * stride, (id + 1) * stride))));
          const selected = { ...source, centers: subset(source.centers, 3), covariances: subset(source.covariances, 6),
            opacities: subset(source.opacities, 1), colors: subset(source.colors, 3), shCoefficients: subset(source.shCoefficients, 12) };
          reference.update(packGaussianRasterUpload(prepareGaussianPlyForThreeCamera({ ...options, source: selected })));
          clear(gl);
          const draw = { ...options.camera, cutoff: options.cutoff };
          if (tiled) reference.drawTiles(draw); else reference.draw(draw);
          const diff = difference(actual, pixels(gl));
          clear(gl); const stable = owner.render(options);
          return { z, count: stats.recordCount, updated: stats.viewUpdated, stable: stable.viewUpdated,
            diff, stableDiff: difference(actual, pixels(gl)),
            visible: actual.reduce((n, v, i) => n + Number(i % 4 === 3 && v > 0), 0) };
        });
        return { frames, error: gl.getError() };
      } finally { owner.dispose(); reference.dispose(); context.dispose(); }
    }, tiled);
    await info.attach('camera-crossing.json', { body: JSON.stringify(result), contentType: 'application/json' });
    expect(result.frames.map(frame => frame.count)).toEqual([3, 1, 0, 3]);
    for (const frame of result.frames) {
      expect(frame.updated).toBe(true);
      expect(frame.stable).toBe(false);
      expect(frame.diff).toBe(0);
      expect(frame.stableDiff).toBe(0);
      if (frame.count) expect(frame.visible).toBeGreaterThan(0);
      else expect(frame.visible).toBe(0);
    }
    expect(result.error).toBe(0);
  });
}
