import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

for (const degree of [1, 2, 3] as const) {
  test(`degree-${degree} channel-major PLY preserves directional RGB through rasterization`, async ({ page }, info) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (degree) => {
      const { ContextLifecycle, GaussianRasterRenderer, parseGaussianSplatPly, prepareGaussianPlyForThreeCamera, packGaussianRasterUpload } = await import('../../web/engine/index.ts');
      const restCount = (degree + 1) ** 2 - 1;
      const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
        ...Array.from({ length: restCount * 3 }, (_, index) => `f_rest_${index}`)].reverse();
      const values: Record<string, number> = {
        scale_0: -2, scale_1: -2, scale_2: -2, rot_0: 1,
        // Y_1^0 is the second non-DC coefficient in each stored color channel.
        f_rest_1: .6, [`f_rest_${restCount + 1}`]: -.4, [`f_rest_${restCount * 2 + 1}`]: .2,
      };
      const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', 'element vertex 1',
        ...fields.map(field => `property float ${field}`), 'end_header', ''].join('\n'));
      const buffer = new ArrayBuffer(header.length + fields.length * 4);
      new Uint8Array(buffer).set(header);
      fields.forEach((field, index) => new DataView(buffer).setFloat32(header.length + index * 4, values[field] ?? 0, true));
      const source = parseGaussianSplatPly(buffer);
      const width = 32, height = 32;
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
      if (!gl) throw new Error('WebGL2 unavailable');
      const lifecycle = new ContextLifecycle(gl), renderer = new GaussianRasterRenderer(gl, lifecycle);
      const render = (tiled: boolean) => {
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        if (tiled) renderer.drawTiles({ width, height, cutoff: .01 });
        else renderer.draw({ width, height, cutoff: .01 });
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      };
      try {
        const views = [-1, 1].map(side => {
          const prepared = prepareGaussianPlyForThreeCamera({
            source, cutoff: .01, tileSize: 16,
            modelToWorld: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
            threeWorldToView: new Float32Array([side, 0, 0, 0, 0, 1, 0, 0, 0, 0, side, 0, 0, 0, -4, 1]),
            threeCameraWorldPosition: new Float32Array([0, 0, side * 4]),
            camera: { focalX: 32, focalY: 32, principalX: 16.5, principalY: 16.5, near: 1, far: 10, width, height },
          });
          const expected = [.6, -.4, .2].map(coefficient => Math.fround(.5 - side * Math.sqrt(3 / (4 * Math.PI)) * Math.fround(coefficient)));
          const upload = packGaussianRasterUpload(prepared);
          renderer.update(upload);
          const full = render(false), tiled = render(true);
          // Independently replace only RGB with the analytic +/-z color, retaining coverage.
          upload.splatData.set(expected, 12); renderer.update(upload);
          const reference = render(false);
          const difference = (pixels: Uint8Array) => pixels.reduce((count, value, index) => count + Number(value !== reference[index]), 0);
          return {
            side, expected, colors: Array.from(prepared.colors),
            center: Array.from(full.slice((16 * width + 16) * 4, (16 * width + 16) * 4 + 4)),
            fullDifference: difference(full), tileDifference: difference(tiled),
          };
        });
        return { degree: source.shDegree, views, error: gl.getError() };
      } finally { renderer.dispose(); lifecycle.dispose(); }
    }, degree);
    const path = info.outputPath('gaussian-ply-layout.json');
    await writeFile(path, JSON.stringify(result, null, 2));
    await info.attach('gaussian-ply-layout.json', { path, contentType: 'application/json' });
    expect(result.degree).toBe(degree);
    for (const view of result.views) {
      expect(view.colors).toEqual(view.expected);
      expect(view.fullDifference).toBe(0);
      expect(view.tileDifference).toBe(0);
      view.expected.forEach((color, channel) => expect(Math.abs(view.center[channel] - Math.round(color * .5 * 255))).toBeLessThanOrEqual(1));
      expect(Math.abs(view.center[3] - 128)).toBeLessThanOrEqual(1);
    }
    expect(result.error).toBe(0);
  });
}
