import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_tile_bins } from '../../pkg/three_wasm_rust.js';
import { root, sha256 } from './ply-parser.ts';

// Run once in a fresh process per build to compare WASM linear memory capacity.
const wasm = await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root));
const { memory } = await init({ module_or_path: wasm });
const side = 1000, tileCount = side * side;
const ids = Uint32Array.of(3, 2, 1, 0);
const centers = new Float32Array(2 * ids.length).fill(side / 2);
const extents = new Float32Array(centers.length).fill(side / 2);
const initialBytes = memory.buffer.byteLength;
const bins = gaussian_tile_bins(centers, extents, ids, side, side, 1);
const finalBytes = memory.buffer.byteLength;
assert.equal(bins.length, tileCount + 1 + tileCount * ids.length);
for (let tile = 0; tile <= tileCount; tile++) assert.equal(bins[tile], tile * ids.length);
const entries = bins.subarray(tileCount + 1);
for (let i = 0; i < entries.length; i++) assert.equal(entries[i], ids[i % ids.length]);
console.log(JSON.stringify({ wasmSha256: sha256(wasm), node: process.version, tileCount,
  references: entries.length, initialBytes, finalBytes, outputBytes: bins.byteLength,
  outputSha256: sha256(new Uint8Array(bins.buffer, bins.byteOffset, bins.byteLength)) }));
