import { test, expect } from '@playwright/test';
import type { EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`hierarchy cancellation preserves the rendered position (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const result = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const { SceneGraph } = await import('../../pkg/three_wasm_rust.js');
      const angle = Math.PI / 8;
      const q = [0, 0, Math.sin(angle), Math.cos(angle)];
      const root = new Float32Array([0, 0, 0, ...q, 1e8, 1, 1]);
      const probe = new SceneGraph(new Int32Array([-1]), root);
      const matrix = probe.world_matrices();
      probe.free();
      root[0] = -matrix[0];
      root[1] = -matrix[1];
      const data: EngineScene = {
        name: 'Cancellation', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1, 0]),
        transforms: new Float32Array([...root, 1, 0.5, 0, 0, 0, 0, 1, 1e-8, 1, 1]),
        meshNodes: new Uint32Array([1]), groups: new Uint32Array([0]), radii: new Float32Array([1]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]), animatedNodes: new Uint32Array(),
        geometries: [{ name: 'triangle', radius: 1, positions: new Float32Array([-0.35, -0.35, 0, 0.35, -0.35, 0, 0, 0.35, 0]), indices: new Uint32Array([0, 1, 2]) }],
        materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      // The flat reference uses the exact cancellation result, without hierarchy multiplication.
      const flat: EngineScene = {
        ...data, parents: new Int32Array([-1]), meshNodes: new Uint32Array([0]),
        transforms: new Float32Array([matrix[4] * 0.5, matrix[5] * 0.5, 0, ...q, 1, 1, 1]),
      };
      const canvas = () => {
        const value = document.createElement('canvas');
        value.width = value.height = 256;
        return value;
      };
      const engine = new Engine(canvas(), data, instanced), reference = new Engine(canvas(), flat, instanced);
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const frame = { projection: identity, view: identity, viewProjection: identity };
      const read = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(256 * 256 * 4);
        gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      try {
        engine.frame(0, frame, false);
        reference.frame(0, frame, false);
        const actual = read(engine.gl), expected = read(reference.gl);
        let difference = 0, colored = 0;
        for (let i = 0; i < actual.length; i += 4) {
          if (actual[i] > 60) colored++;
          for (let c = 0; c < 3; c++) difference += Math.abs(actual[i + c] - expected[i + c]);
        }
        return { colored, difference: difference / (256 * 256 * 3), position: Array.from(engine.graph.world_matrices().slice(28, 31)) };
      } finally { reference.dispose(); engine.dispose(); }
    }, instanced);
    expect(result.colored).toBeGreaterThan(1000);
    expect(result.difference, JSON.stringify(result)).toBeLessThan(0.05);
    expect(result.position[0]).toBeCloseTo(-Math.SQRT1_2 * 0.5, 5);
    expect(result.position[1]).toBeCloseTo(Math.SQRT1_2 * 0.5, 5);
  });
}
