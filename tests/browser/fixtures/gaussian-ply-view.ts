import type { GaussianPlyRenderOptions } from '../../../web/engine/index.ts';

export function syntheticPly(shift = 0): ArrayBuffer {
  const fields = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3', ...Array.from({ length: 9 }, (_, index) => `f_rest_${index}`)];
  const rows = [
    [-.25 + shift, 0, 2, 1, -.5, -.5, 1, -2, -2, -2, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
    [.2 + shift, .1, 3, -.5, 1, -.5, 1, -2, -1.8, -2, 1, 0, 0, 0, 0, .5, 0, 0, 0, 0, 0, 0, 0],
    [shift, -.2, 2.5, -.5, -.5, 1, 1, -2, -2, -2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -.5, 0],
  ];
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', `element vertex ${rows.length}`,
    ...fields.map(field => `property float ${field}`), 'end_header', ''].join('\n'));
  const buffer = new ArrayBuffer(header.length + rows.length * fields.length * 4);
  new Uint8Array(buffer).set(header);
  const data = new DataView(buffer);
  rows.forEach((row, index) => row.forEach((value, column) => data.setFloat32(header.length + (index * fields.length + column) * 4, value, true)));
  return buffer;
}

export function viewOptions(tiled: boolean): GaussianPlyRenderOptions {
  return {
    modelToWorld: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    threeWorldToView: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1]),
    threeCameraWorldPosition: new Float32Array([0, 0, 5]), cutoff: .01,
    camera: { focalX: 64, focalY: 64, principalX: 32, principalY: 24, near: .1, far: 100, width: 64, height: 48 },
    ...(tiled && { tileSize: 16 }),
  };
}

export function pixels(gl: WebGL2RenderingContext): Uint8Array {
  const result = new Uint8Array(64 * 48 * 4);
  gl.readPixels(0, 0, 64, 48, gl.RGBA, gl.UNSIGNED_BYTE, result);
  return result;
}

export function difference(a: Uint8Array, b: Uint8Array): number {
  return a.reduce((sum, value, index) => sum + Number(value !== b[index]), 0);
}

export function clear(gl: WebGL2RenderingContext): void {
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
}
