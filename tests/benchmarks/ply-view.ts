import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import init from '../../pkg/three_wasm_rust.js';
import { prepareGaussianPlyForThreeCamera as current, type GaussianPlySource } from '../../web/engine/GaussianPly.ts';
import { preparePlyParser, root, sha256, sourceKeys } from './ply-parser.ts';

// Usage: npx tsx tests/benchmarks/ply-view.ts <baseline-commit> [count=100000] [rounds=9]
const [revision, countArg = '100000', roundsArg = '9'] = process.argv.slice(2);
if (!revision || !/^[a-f\d]{7,40}$/i.test(revision)) throw new Error('Supply a baseline commit SHA');
const count = Number(countArg), rounds = Number(roundsArg);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000
  || !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 101) throw new Error('Invalid count or rounds');
const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const bytes = (array: Float32Array | Uint32Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
function sourceFor(degree: 0 | 3): GaussianPlySource {
  const stride = 3 * (degree + 1) ** 2;
  const source: GaussianPlySource = { centers: new Float32Array(count * 3), covariances: new Float32Array(count * 6),
    opacities: new Float32Array(count), colors: new Float32Array(count * 3), shDegree: degree,
    shCoefficients: new Float32Array(count * stride) };
  for (let i = 0; i < count; i++) {
    source.centers.set([i % 7 === 0 ? 20 : (i % 101 - 50) / 50, (i % 79 - 39) / 50, 2 + (i % 43) / 43], i * 3);
    source.covariances.set([.002, .0001, 0, .003, 0, .002], i * 6);
    source.opacities[i] = i % 5 === 0 ? .001 : .6;
    for (let j = 0; j < stride; j++) source.shCoefficients[i * stride + j] = ((i + j) % 17 - 8) / 50;
    for (let j = 0; j < 3; j++) source.colors[i * 3 + j] = .5 + .28209479177387814 * source.shCoefficients[i * stride + j];
  }
  return source;
}
// Count only direct source-attribute slice allocations, separately from timed runs.
// This is not total allocation, peak heap usage, or WASM memory capacity.
function sourceSliceBytes(source: GaussianPlySource, run: () => void): number {
  let total = 0;
  try {
    for (const key of sourceKeys) {
      const array = source[key];
      Object.defineProperty(array, 'slice', { configurable: true, value: (start?: number, end?: number) => {
        const copy = Float32Array.prototype.slice.call(array, start, end);
        total += copy.byteLength;
        return copy;
      } });
    }
    run();
    return total;
  } finally {
    for (const key of sourceKeys) Reflect.deleteProperty(source[key], 'slice');
  }
}
const historical = await preparePlyParser(revision, false, true);

// Count temporary f32 views in a separate synchronous pass, without changing timed runs.
function subarrayCalls<T>(run: () => T): { result: T; calls: number } {
  const descriptor = Object.getOwnPropertyDescriptor(Float32Array.prototype, 'subarray');
  const original = Float32Array.prototype.subarray;
  let calls = 0;
  Object.defineProperty(Float32Array.prototype, 'subarray', { configurable: true, writable: true,
    value(this: Float32Array, begin?: number, end?: number) {
      calls++;
      return original.call(this, begin, end);
    } });
  try { return { result: run(), calls }; }
  finally {
    if (descriptor) Object.defineProperty(Float32Array.prototype, 'subarray', descriptor);
    else Reflect.deleteProperty(Float32Array.prototype, 'subarray');
  }
}
try {
  await init({ module_or_path: await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root)) });
  const { prepareGaussianPlyForThreeCamera: baseline } = await import(historical.url) as {
    prepareGaussianPlyForThreeCamera: typeof current;
  };
  const results = [];
  for (const degree of [0, 3] as const) for (const tiled of [false, true]) {
    const source = sourceFor(degree), sourceHashes = sourceKeys.map(key => sha256(bytes(source[key])));
    const options = { source,
      modelToWorld: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      threeWorldToView: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1]),
      threeCameraWorldPosition: new Float32Array([0, 0, 5]), cutoff: .01, filterVariance: .3,
      camera: { focalX: 256, focalY: 256, principalX: 256, principalY: 160, near: .1, far: 100, width: 512, height: 320 },
      clipPlane: { normal: new Float32Array([.2, .1, -1]), offset: -2.5 },
      ...(tiled && { tileSize: 32 }),
    };
    const reference = baseline(options);
    const baselineSliceBytes = sourceSliceBytes(source, () => assert.deepEqual(baseline(options), reference));
    const currentSliceBytes = sourceSliceBytes(source, () => assert.deepEqual(current(options), reference));
    const run = (prepare: typeof current) => {
      const start = performance.now(), view = prepare(options), elapsed = performance.now() - start;
      assert.deepEqual(view, reference);
      return elapsed;
    };
    for (let warmup = 0; warmup < 3; warmup++) { run(baseline); run(current); }
    const before: number[] = [], after: number[] = [];
    for (let round = 0; round < rounds; round++) {
      if (round % 2 === 0) { before.push(run(baseline)); after.push(run(current)); }
      else { after.push(run(current)); before.push(run(baseline)); }
    }
    assert.deepEqual(sourceKeys.map(key => sha256(bytes(source[key]))), sourceHashes);
    const countedBaseline = subarrayCalls(() => baseline(options)), countedCurrent = subarrayCalls(() => current(options));
    assert.deepEqual(countedBaseline.result, reference);
    assert.deepEqual(countedCurrent.result, reference);
    results.push({ degree, tiled, count, retained: reference.originalIds.length,
      baselineSliceBytes, currentSliceBytes, baselineSubarrayCalls: countedBaseline.calls, currentSubarrayCalls: countedCurrent.calls, before, after,
      baselineMedianMs: median(before), currentMedianMs: median(after), identicalOutput: true, unchangedSource: true });
  }
  process.stdout.write(JSON.stringify({ baselineSha: historical.commit, baselineSourceSha256: historical.sourceSha256,
    currentSourceSha256: sha256(await readFile(new URL('web/engine/GaussianPly.ts', root))),
    baselineRasterSha256: historical.rasterSha256,
    currentRasterSha256: sha256(await readFile(new URL('web/engine/gaussian.ts', root))),
    wasmSha256: sha256(await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root))), node: process.version,
    platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, warmup: 3, rounds,
    scope: 'Synchronous PLY view preparation only; excludes decode, upload and GPU. Historical PLY and raster preparation modules with other current dependencies and shared warmed WASM. Slice bytes and f32 subarray calls are separate instrumented runs, not peak memory or total allocations.',
    results }, null, 2) + '\n');
} finally { await historical.dispose(); }
