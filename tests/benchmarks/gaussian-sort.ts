import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as currentBuild from '../../pkg/three_wasm_rust.js';
import { root, sha256 } from './ply-parser.ts';

// Usage: npx tsx tests/benchmarks/gaussian-sort.ts <baseline-pkg-dir> [count=100000] [rounds=15] [control]
// The directory contains baseline.json (commit, sourceSha256, wasmSha256) and the JS/WASM build.
const [directory, countArg = '100000', roundsArg = '15', mode] = process.argv.slice(2);
if (!directory) throw new Error('Supply a saved baseline package directory');
if (mode !== undefined && mode !== 'control') throw new Error('Unknown mode');
const count = Number(countArg), rounds = Number(roundsArg);
if (!Number.isSafeInteger(count) || count < 2 || count > 1_000_000
  || !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 101) throw new Error('Invalid count or rounds');
const baselineRoot = pathToFileURL(resolve(directory) + '/');
const baseline = await import(new URL('three_wasm_rust.js', baselineRoot).href) as typeof currentBuild;
const current = mode === 'control'
  ? await import(new URL('three_wasm_rust.js?control', baselineRoot).href) as typeof currentBuild : currentBuild;
const baselineInfo: { commit: string; sourceSha256: string; wasmSha256: string } =
  JSON.parse(await readFile(new URL('baseline.json', baselineRoot), 'utf8'));
assert.match(baselineInfo.commit, /^[a-f\d]{40}$/);
assert.match(baselineInfo.sourceSha256, /^[a-f\d]{64}$/);
assert.notEqual(baseline, current, 'Comparison requires separate module instances');
const beforeWasm = await readFile(new URL('three_wasm_rust_bg.wasm', baselineRoot));
const afterWasm = mode === 'control' ? beforeWasm : await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root));
assert.equal(sha256(beforeWasm), baselineInfo.wasmSha256);
await baseline.default({ module_or_path: beforeWasm });
await current.default({ module_or_path: afterWasm });
const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const bytes = (array: Float32Array | Uint32Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
const results = [];
for (const distribution of ['equal', 'sorted', 'late-inversion', 'adjacent', 'camera-range', 'wide'] as const) {
  const depths = new Float32Array(count), bits = new Uint32Array(depths.buffer);
  let state = 12345;
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    if (distribution === 'equal') depths[i] = i % 2 ? -0 : 0;
    else if (distribution === 'sorted' || distribution === 'late-inversion') depths[i] = 2 + i / count;
    else if (distribution === 'adjacent') bits[i] = 0x40000000 | (state & 255);
    else if (distribution === 'camera-range') depths[i] = 2 + (state % 43) / 43;
    else bits[i] = ((state & 0x807fffff) | (((state >>> 23) % 255) << 23)) >>> 0;
  }
  if (distribution === 'late-inversion') depths[0] = 4;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = count - 1 - i;
  for (const tiled of [false, true]) {
    const tileCount = Math.ceil(count / 1024), referenceStart = tileCount + 1;
    const input = tiled ? new Uint32Array(referenceStart + count) : indices;
    if (tiled) {
      for (let tile = 0; tile <= tileCount; tile++) input[tile] = Math.min(tile * 1024, count);
      input.set(indices, referenceStart);
    }
    const expected = input.slice();
    const compare = (a: number, b: number) => depths[b] - depths[a];
    if (tiled) for (let tile = 0; tile < tileCount; tile++) {
      const start = referenceStart + input[tile], end = referenceStart + input[tile + 1];
      expected.set(Array.from(input.subarray(start, end)).sort(compare), start);
    }
    else expected.set(Array.from(input).sort(compare));
    const inputHashes = [sha256(bytes(depths)), sha256(bytes(input))];
    const run = (module: typeof current) => {
      const start = performance.now();
      const output = tiled ? module.gaussian_tile_depth_order(depths, input, tileCount)
        : module.gaussian_depth_order(depths, input);
      const elapsed = performance.now() - start;
      assert.deepEqual(output, expected);
      return elapsed;
    };
    for (let i = 0; i < 5; i++) { run(baseline); run(current); }
    const before: number[] = [], after: number[] = [];
    for (let i = 0; i < rounds; i++) {
      if (i % 2 === 0) { before.push(run(baseline)); after.push(run(current)); }
      else { after.push(run(current)); before.push(run(baseline)); }
    }
    assert.deepEqual([sha256(bytes(depths)), sha256(bytes(input))], inputHashes);
    results.push({ distribution, tiled, count, tileCount: tiled ? tileCount : 0,
      before, after, baselineMedianMs: median(before), currentMedianMs: median(after),
      identicalToStableJsSort: true, unchangedInput: true });
  }
}
console.log(JSON.stringify({ baseline: baselineInfo,
  control: mode === 'control',
  currentSourceSha256: mode === 'control' ? baselineInfo.sourceSha256 : sha256(await readFile(new URL('src/gaussian.rs', root))),
  currentWasmSha256: sha256(afterWasm), node: process.version, platform: process.platform, arch: process.arch,
  cpu: cpus()[0]?.model, execArgv: process.execArgv, warmup: 5, rounds,
  scope: 'Synchronous WASM sort API including validation, JS/WASM copies and result allocation. Separate warmed WASM instances; excludes input generation, JS reference sort, verification, projection, upload and GPU. Not a memory or frame-time benchmark.',
  results }, null, 2));
