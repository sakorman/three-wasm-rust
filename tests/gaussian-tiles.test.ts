import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_tile_bins } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

function referenceBins(centers: Float32Array, extents: Float32Array, candidates: Uint32Array, width: number, height: number, tileSize: number) {
  const columns = Math.ceil(width / tileSize), rows = Math.ceil(height / tileSize), tiles = Array.from({ length: columns * rows }, () => [] as number[]);
  for (const id of candidates) {
    const offset = id * 2, x = centers[offset], y = centers[offset + 1], halfWidth = extents[offset], halfHeight = extents[offset + 1];
    if (halfWidth === 0 || halfHeight === 0 || x + halfWidth < 0 || x - halfWidth > width || y + halfHeight < 0 || y - halfHeight > height) continue;
    const x0 = Math.min(columns - 1, Math.floor(Math.max(0, x - halfWidth) / tileSize));
    const x1 = Math.min(columns - 1, Math.floor(Math.min(width, x + halfWidth) / tileSize));
    const y0 = Math.min(rows - 1, Math.floor(Math.max(0, y - halfHeight) / tileSize));
    const y1 = Math.min(rows - 1, Math.floor(Math.min(height, y + halfHeight) / tileSize));
    for (let tileY = y0; tileY <= y1; tileY++) for (let tileX = x0; tileX <= x1; tileX++) tiles[tileY * columns + tileX].push(id);
  }
  const offsets = [0];
  for (const tile of tiles) offsets.push(offsets[offsets.length - 1] + tile.length);
  return Uint32Array.from([...offsets, ...tiles.flat()]);
}

test('tile bins retain conservative edge tiles and the candidate order within each tile', () => {
  const centers = new Float32Array([8, 8, 20, 6, -1, 8, 40, 2]);
  const extents = new Float32Array([8, 8, 2, 2, 2, 1, 2, 2]);
  const candidates = new Uint32Array([2, 0, 3, 1]);
  const bins = gaussian_tile_bins(centers, extents, candidates, 35, 18, 16);
  assert.deepEqual(Array.from(bins), [0, 2, 4, 4, 5, 6, 6, 2, 0, 0, 1, 0, 0]);
  centers.fill(0); extents.fill(0); candidates.fill(0);
  assert.deepEqual(Array.from(bins), [0, 2, 4, 4, 5, 6, 6, 2, 0, 0, 1, 0, 0]);
});

test('tile bins match an independent row-major reference across 4097 bounded splats', () => {
  const count = 4097, width = 257, height = 193, tileSize = 16;
  const centers = new Float32Array(count * 2), extents = new Float32Array(count * 2);
  for (let index = 0; index < count; index++) {
    centers[index * 2] = Math.fround((index * 37 % 401) - 72.75);
    centers[index * 2 + 1] = Math.fround((index * 53 % 317) - 61.5);
    extents[index * 2] = Math.fround(.25 + index % 13 * .75);
    extents[index * 2 + 1] = Math.fround(.5 + index % 11 * .6);
  }
  const candidates = Uint32Array.from({ length: count }, (_, index) => count - index - 1);
  const expected = referenceBins(centers, extents, candidates, width, height, tileSize);
  const actual = gaussian_tile_bins(centers, extents, candidates, width, height, tileSize);
  assert.deepEqual(actual, expected);
  const offsetCount = Math.ceil(width / tileSize) * Math.ceil(height / tileSize) + 1;
  assert.equal(actual[offsetCount - 1], actual.length - offsetCount);
});

test('tile bins reject invalid dimensions and complete batches', () => {
  const centers = new Float32Array([8, 8, 12, 12]), extents = new Float32Array([2, 2, 2, 2]);
  for (const [width, height, tileSize] of [[0, 1, 1], [1, 0, 1], [1, 1, 0]] as const)
    assert.throws(() => gaussian_tile_bins(centers, extents, new Uint32Array(), width, height, tileSize), /tile/);
  assert.throws(() => gaussian_tile_bins(new Float32Array([8, 8, NaN, 0]), extents, new Uint32Array([0]), 16, 16, 8), /centers/);
  assert.throws(() => gaussian_tile_bins(centers, new Float32Array([2, 2, 0, -1]), new Uint32Array([0]), 16, 16, 8), /extents/);
  assert.throws(() => gaussian_tile_bins(centers, extents, new Uint32Array([0, 0]), 16, 16, 8), /duplicate/);
  assert.throws(() => gaussian_tile_bins(centers, extents, new Uint32Array([2]), 16, 16, 8), /out of range/);
});
