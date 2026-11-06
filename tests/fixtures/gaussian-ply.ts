/** Deterministic trained PLY with reordered fields and unaligned vertex records. */
export function gaussianPlyFixture(count: number, degree: 0 | 1 | 2 | 3) {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
    'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ...Array.from({ length: 3 * ((degree + 1) ** 2 - 1) }, (_, i) => `f_rest_${i}`)].reverse();
  const fields = names.map((name, i) => ({ name, offset: 1 + i * 4 }));
  const stride = 1 + fields.length * 4 + 8;
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', `element vertex ${count}`,
    'property uchar ignored_tag', ...fields.map(field => `property float ${field.name}`),
    'property double ignored_weight', 'end_header', ''].join('\n'));
  const buffer = new ArrayBuffer(header.length + count * stride), view = new DataView(buffer);
  new Uint8Array(buffer).set(header);
  for (let row = 0; row < count; row++) {
    for (const field of fields) view.setFloat32(header.length + row * stride + field.offset, plyValue(field.name, row), true);
  }
  return { buffer, fields, stride, bodyOffset: header.length };
}

export function plyValue(name: string, row: number): number {
  const n = (row % 97) / 97;
  if (name === 'x') return Math.fround(n - .5);
  if (name === 'y') return Math.fround(.25 - n);
  if (name === 'z') return Math.fround(2 + n);
  if (name === 'opacity') return Math.fround(n * 4 - 2);
  if (name.startsWith('scale_')) return Math.fround(-2 + n + Number(name.at(-1)) * .1);
  if (name.startsWith('rot_')) return name === 'rot_0' ? 1 : 0;
  if (name.startsWith('f_dc_')) return Math.fround(n - .2 * Number(name.at(-1)));
  return Math.fround((Number(name.slice(7)) + 1) * (n + 1) / 128);
}
