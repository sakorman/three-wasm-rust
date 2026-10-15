import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`surface lighting is stable across translation and scale (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const results = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const data: EngineScene = {
        name: 'Sloped surface', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1]),
        transforms: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]),
        meshNodes: new Uint32Array([0]), groups: new Uint32Array([0]), radii: new Float32Array([2]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]),
        animatedNodes: new Uint32Array(),
        geometries: [{ name: 'sloped triangle', radius: 2,
          positions: new Float32Array([-0.6, -0.6, -0.6, 0.6, -0.6, 0.6, 0, 0.6, 0]),
          indices: new Uint32Array([0, 1, 2]),
        }],
        materials: [{ name: 'orange', color: [0.9, 0.4, 0.2], unlit: false }],
      };
      const results = [];
      const canvas = () => {
        const value = document.createElement('canvas');
        value.width = value.height = 256;
        return value;
      };
      const rustCanvas = canvas(), threeCanvas = canvas();
      for (const unlit of [false, true]) {
        data.materials[0].unlit = unlit;
        for (const magnitude of [1, 1e-12, 1e12]) {
          for (const scale of [1, -1]) {
            data.transforms[7] = scale * magnitude;
            data.transforms[8] = data.transforms[9] = magnitude;
            for (const offset of (magnitude === 1 ? [0, 1e8, -1e8] : [0])) {
              data.transforms[2] = offset;
              const engine = new Engine(rustCanvas, data, instanced);
              const reference = new ThreeBackend(threeCanvas, data, instanced ? 'instanced' : 'three');
              const view = identity.slice();
              view[14] = -offset;
              const projection = identity.slice();
              projection[0] = projection[5] = projection[10] = 1 / magnitude;
              const viewProjection = projection.slice();
              viewProjection[14] = -offset / magnitude;
              const frame = { projection, view, viewProjection };
              const read = (gl: WebGL2RenderingContext) => {
                const pixel = new Uint8Array(4);
                gl.readPixels(128, 128, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
                if (gl.getError()) throw new Error('WebGL error');
                return Array.from(pixel);
              };
              try {
                engine.frame(0, frame, false);
                reference.frame(0, frame, false);
                results.push({ unlit, magnitude, scale, offset, rust: read(engine.gl), three: read(reference.gl) });
              } finally {
                reference.dispose();
                engine.dispose();
              }
            }
          }
        }
      }
      return results;
    }, instanced);
    for (const result of results) {
      const message = JSON.stringify(result);
      // Plane z=x; reflecting x changes its slope to z=-x.
      const diffuse = Math.abs((-result.scale * 0.4 + 0.6) / Math.sqrt(2 * 1.16));
      const light = result.unlit ? 1 : 0.42 + 0.58 * diffuse;
      const expected = [0.9, 0.4, 0.2].map((color) => Math.round(color * light * 255));
      for (const actual of [result.rust, result.three]) {
        expect(actual[3], message).toBe(255);
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(actual[channel] - expected[channel]), message).toBeLessThanOrEqual(2);
      }
    }
  });
}

test('legacy lighting retains surface slopes at large coordinates', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  await page.getByRole('button', { name: '暂停动画' }).click();
  const results = await page.evaluate(async () => {
    const { SceneGraph, RustRenderer } = await import('../../pkg/three_wasm_rust.js');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const renderer = new RustRenderer(canvas,
      new Float32Array([-0.6, -0.6, -0.6, 0.6, -0.6, 0.6, 0, 0.6, 0]),
      new Uint32Array([0, 1, 2]), new Float32Array([0.9, 0.4, 0.2]));
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('No WebGL2');
    const results = [];
    try {
      for (const [magnitude, offset] of [[1, 0], [1, 1e8], [1, -1e8], [1e-12, 0], [1e12, 0]]) {
        const graph = new SceneGraph(new Int32Array([-1]),
          new Float32Array([0, 0, offset, 0, 0, 0, 1, magnitude, magnitude, magnitude]));
        const camera = new Float32Array([1 / magnitude, 0, 0, 0, 0, 1 / magnitude, 0, 0,
          0, 0, 1 / magnitude, 0, 0, 0, -offset / magnitude, 1]);
        try {
          renderer.render(graph, camera);
          const pixel = new Uint8Array(4);
          gl.readPixels(128, 128, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          results.push({ magnitude, offset, pixel: Array.from(pixel), error: gl.getError() });
        } finally { graph.free(); }
      }
    } finally { renderer.free(); }
    return results;
  });
  const light = 0.52 + 0.48 * 0.2 / Math.sqrt(2 * 1.16);
  const expected = [0.9, 0.4, 0.2].map((color) => Math.round(color * light * 255));
  for (const result of results) {
    expect(result.error).toBe(0);
    expect(result.pixel[3]).toBe(255);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(result.pixel[channel] - expected[channel]), JSON.stringify(result)).toBeLessThanOrEqual(2);
  }
});
