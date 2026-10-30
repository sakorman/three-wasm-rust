import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init from '../pkg/three_wasm_rust.js';
import { evaluateGaussianPlyShColors, parseGaussianSplatPly } from '../web/engine/index.ts';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

function ply(restNames: string[], channelSize: number): ArrayBuffer {
  const base: Record<string, number> = {
    x: 0, y: 0, z: 2, f_dc_0: .1, f_dc_1: .2, f_dc_2: .3,
    opacity: 0, scale_0: 0, scale_1: 0, scale_2: 0, rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
  };
  // Deliberately scramble physical property order, including f_rest_10 before f_rest_2.
  const names = [...Object.keys(base), ...restNames].sort();
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', 'element vertex 2',
    ...names.map(name => `property float ${name}`), 'end_header', ''].join('\n'));
  const buffer = new ArrayBuffer(header.length + 2 * names.length * 4);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  for (let vertex = 0; vertex < 2; vertex++) {
    names.forEach((name, column) => {
      const index = Number(name.slice('f_rest_'.length));
      const value = name.startsWith('f_rest_')
        ? 1000 * vertex + 100 * (Math.floor(index / channelSize) + 1) + index % channelSize + 1
        : base[name];
      view.setFloat32(header.length + (vertex * names.length + column) * 4, value, true);
    });
  }
  return buffer;
}

for (const degree of [1, 2, 3] as const) {
  test(`degree-${degree} PLY converts channel-major SH fields into coefficient-major RGB`, () => {
    const count = (degree + 1) ** 2, rest = count - 1;
    const input = ply(Array.from({ length: 3 * rest }, (_, index) => `f_rest_${index}`), rest);
    const originalBytes = new Uint8Array(input).slice();
    const source = parseGaussianSplatPly(input);
    assert.equal(source.shDegree, degree);
    for (let vertex = 0; vertex < 2; vertex++) {
      assert.deepEqual(Array.from(source.shCoefficients.slice(vertex * count * 3, vertex * count * 3 + 3)), Array.from(new Float32Array([.1, .2, .3])));
      for (let basis = 1; basis < count; basis++) {
        const offset = (vertex * count + basis) * 3;
        assert.deepEqual(Array.from(source.shCoefficients.slice(offset, offset + 3)),
          [1000 * vertex + 100 + basis, 1000 * vertex + 200 + basis, 1000 * vertex + 300 + basis]);
      }
    }
    assert.deepEqual(new Uint8Array(input), originalBytes);
    const preserved = source.shCoefficients.slice();
    new Uint8Array(input).fill(0);
    assert.deepEqual(source.shCoefficients, preserved);
  });
}

test('incomplete and unknown SH groups retain DC instead of reinterpreting a lower-degree prefix', () => {
  const groups = [0, 8, 10, 23, 25, 44, 46].map(count => Array.from({ length: count }, (_, index) => `f_rest_${index}`));
  groups.push(Array.from({ length: 45 }, (_, index) => `f_rest_${index}`).filter(name => name !== 'f_rest_20'));
  groups.push(Array.from({ length: 45 }, (_, index) => `f_rest_${index === 20 ? 99 : index}`));
  groups.push([...Array.from({ length: 9 }, (_, index) => `f_rest_${index}`), 'f_rest_unknown']);
  for (const names of groups) {
    const source = parseGaussianSplatPly(ply(names, 15));
    assert.equal(source.shDegree, 0, names.join(','));
    assert.equal(source.shCoefficients.length, 6);
    assert.deepEqual(evaluateGaussianPlyShColors(source, new Float32Array([0, 0, 0])), source.colors);
  }
});
