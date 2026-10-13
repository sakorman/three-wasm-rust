import { test, expect } from '@playwright/test';
import type { CameraFrame, EngineScene } from '../../web/engine/types.ts';

for (const instanced of [false, true]) {
  test(`off-origin bounds preserve visible geometry (${instanced ? 'instanced' : 'direct'})`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toHaveText('引擎已就绪');
    await page.getByRole('button', { name: '暂停动画' }).click();
    const results = await page.evaluate(async (instanced) => {
      const { Engine } = await import('../../web/engine/Engine.ts');
      const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
      const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      const data: EngineScene = {
        name: 'Offset bounds', scenario: 'hierarchy', seed: 0, extent: 1,
        parents: new Int32Array([-1, 0, 0, -1]),
        transforms: new Float32Array([
          0, 0, 0, 0, 0, 0, 1, -1, 1, 1,
          -4.5, 0.4, 0, 0, 0, 0, 1, 0.4, 0.4, 1,
          4.5, -0.4, 0, 0, 0, 0, 1, -0.4, 0.4, 1,
          0, 0, 0, 0, 0, 0, 1, 0.4, 0.4, 1,
        ]),
        meshNodes: new Uint32Array([1, 2, 3]), groups: new Uint32Array(3),
        radii: new Float32Array(3).fill(0.75),
        centers: new Float32Array([10, 0, 0, 10, 0, 0, 10, 0, 0]),
        batchGeometries: new Uint32Array([0]), batchMaterials: new Uint32Array([0]),
        animatedNodes: new Uint32Array(),
        geometries: [{
          name: 'offset triangle', radius: 11,
          positions: new Float32Array([9.5, -0.5, 0, 10.5, -0.5, 0, 10, 0.5, 0]),
          indices: new Uint32Array([0, 1, 2]),
        }],
        materials: [{ name: 'orange', color: [1, 0.5, 0.2], unlit: true }],
      };
      const canvas = () => {
        const value = document.createElement('canvas');
        value.width = value.height = 256;
        return value;
      };
      const engine = new Engine(canvas(), data, instanced);
      const reference = new ThreeBackend(canvas(), data, instanced ? 'instanced' : 'three');
      const read = (gl: WebGL2RenderingContext) => {
        const pixels = new Uint8Array(256 * 256 * 4);
        gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError()) throw new Error('WebGL error');
        return pixels;
      };
      const compare = (pixels: Uint8Array, expected: Uint8Array) => {
        let colored = 0, difference = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] > 60) colored++;
          for (let c = 0; c < 3; c++) difference += Math.abs(pixels[i + c] - expected[i + c]);
        }
        return { colored, difference: difference / (256 * 256 * 3) };
      };
      const results = [];
      try {
        for (const [phase, shift] of [0, -4, 0].entries()) {
          if (phase === 2) {
            await Promise.all([engine, reference].map(async (backend) => {
              const extension = backend.gl.getExtension('WEBGL_lose_context');
              if (!extension) throw new Error('Missing context test extension');
              const event = (name: string, action: () => void) => new Promise<void>((resolve) => {
                backend.gl.canvas.addEventListener(name, () => setTimeout(resolve, 0), { once: true });
                action();
              });
              await event('webglcontextlost', () => extension.loseContext());
              await event('webglcontextrestored', () => extension.restoreContext());
            }));
          }
          const view = identity.slice();
          view[12] = shift;
          const frame: CameraFrame = { projection: identity, view, viewProjection: view };
          reference.frame(0, frame, false);
          const expected = read(reference.gl);
          for (const culling of [false, true]) {
            const rustStats = engine.frame(0, frame, culling);
            const rust = compare(read(engine.gl), expected);
            const threeStats = reference.frame(0, frame, culling);
            const three = compare(read(reference.gl), expected);
            results.push({ shift, culling, rustStats, threeStats, rust, three });
          }
        }
      } finally {
        reference.dispose();
        engine.dispose();
      }
      return results;
    }, instanced);
    for (const result of results) {
      const message = JSON.stringify(result);
      const visible = result.culling ? (result.shift === 0 ? 2 : 1) : 3;
      expect(result.rustStats.visible, message).toBe(visible);
      expect(result.threeStats.visible, message).toBe(visible);
      expect(result.rustStats.draws, message).toBe(result.threeStats.draws);
      expect(result.rust.colored, message).toBeGreaterThan(1000);
      expect(result.three.colored, message).toBeGreaterThan(1000);
      expect(result.rust.difference, message).toBeLessThan(0.05);
      expect(result.three.difference, message).toBeLessThan(0.05);
    }
  });
}

test('invalid sphere descriptors are rejected before context allocation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText('引擎已就绪');
  const messages = await page.evaluate(async () => {
    const { Engine } = await import('../../web/engine/Engine.ts');
    const { ThreeBackend } = await import('../../web/compare/ThreeBackend.ts');
    const { createEngineScene } = await import('../../web/engine/scenes.ts');
    const data = createEngineScene('city', 100);
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'getContext', { value: () => { throw new Error('Allocated context'); } });
    const variants = [
      { ...data, centers: new Float32Array(1) },
      { ...data, centers: new Float32Array(data.meshNodes.length * 3).fill(NaN) },
      { ...data, radii: new Float32Array(data.meshNodes.length).fill(-1) },
    ];
    const messages: string[] = [];
    for (const invalid of variants)
      for (const create of [() => new Engine(canvas, invalid), () => new ThreeBackend(canvas, invalid, 'three')]) {
        try {
          create().dispose();
          messages.push('Accepted invalid bounds');
        } catch (error) {
          messages.push(String(error));
        }
      }
    return messages;
  });
  expect(messages).toHaveLength(6);
  for (const message of messages) expect(message).toContain('Invalid bounding spheres');
});
