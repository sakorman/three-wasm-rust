import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import init from '../../pkg/three_wasm_rust.js';
import { parseGaussianSplatPly, type GaussianPlySource } from '../../web/engine/GaussianPly.ts';
import { gaussianPlyFixture } from '../fixtures/gaussian-ply.ts';
import { preparePlyParser, root, sha256, sourceKeys as keys } from './ply-parser.ts';

// Usage: npx tsx tests/benchmarks/ply-decode.ts <baseline-commit> [count=100000] [rounds=9]
const [revision, countArg = '100000', roundsArg = '9'] = process.argv.slice(2);
if (!revision || !/^[a-f\d]{7,40}$/i.test(revision)) throw new Error('Supply a baseline commit SHA');
const count = Number(countArg), rounds = Number(roundsArg);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000
  || !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 101) throw new Error('Invalid count or rounds');
const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const historical = await preparePlyParser(revision);
try {
  await init({ module_or_path: await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root)) });
  const { parseGaussianSplatPly: baseline } = await import(historical.url) as {
    parseGaussianSplatPly: typeof parseGaussianSplatPly;
  };
  const results = [];
  for (const degree of [0, 3] as const) {
    const { buffer } = gaussianPlyFixture(count, degree);
    const inputBefore = new Uint8Array(buffer).slice();
    let reference: GaussianPlySource | undefined;
    const run = (parse: typeof baseline) => {
      const start = performance.now(), decoded = parse(buffer), elapsed = performance.now() - start;
      if (!reference) reference = decoded;
      assert.equal(decoded.shDegree, reference.shDegree);
      for (const key of keys) assert.deepEqual(new Uint8Array(decoded[key].buffer), new Uint8Array(reference[key].buffer));
      return elapsed;
    };
    for (let warmup = 0; warmup < 3; warmup++) { run(baseline); run(parseGaussianSplatPly); }
    const before: number[] = [], after: number[] = [];
    for (let round = 0; round < rounds; round++) {
      if (round % 2 === 0) { before.push(run(baseline)); after.push(run(parseGaussianSplatPly)); }
      else { after.push(run(parseGaussianSplatPly)); before.push(run(baseline)); }
    }
    assert.deepEqual(new Uint8Array(buffer), inputBefore);
    results.push({ degree, count, inputBytes: buffer.byteLength,
      before, after,
      baselineMedianMs: median(before), currentMedianMs: median(after), identicalBytes: true });
  }
  process.stdout.write(JSON.stringify({ baselineSha: historical.commit, baselineParserSha256: historical.sourceSha256,
    currentParserSha256: sha256(await readFile(new URL('web/engine/GaussianPly.ts', root))),
    wasmSha256: sha256(await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root))), node: process.version, platform: process.platform,
    arch: process.arch, cpu: cpus()[0]?.model, warmup: 3, rounds,
    scope: 'Synchronous PLY decode including output allocation and WASM covariance; excludes I/O, WASM init, view preparation and GPU. Shared warmed WASM instance; not a memory benchmark',
    results }, null, 2) + '\n');
} finally { await historical.dispose(); }
