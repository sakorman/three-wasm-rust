import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import init from '../../pkg/three_wasm_rust.js';
import { parseGaussianSplatPly, type GaussianPlySource } from '../../web/engine/GaussianPly.ts';
import { gaussianPlyFixture } from '../fixtures/gaussian-ply.ts';

// Usage: npx tsx tests/benchmarks/ply-decode.ts <baseline-commit> [count=100000] [rounds=9]
const [revision, countArg = '100000', roundsArg = '9'] = process.argv.slice(2);
if (!revision || !/^[a-f\d]{7,40}$/i.test(revision)) throw new Error('Supply a baseline commit SHA');
const count = Number(countArg), rounds = Number(roundsArg);
if (!Number.isSafeInteger(count) || count < 1 || count > 1_000_000
  || !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 101) throw new Error('Invalid count or rounds');
const root = new URL('../../', import.meta.url);
const baselineSha = execFileSync('git', ['rev-parse', revision], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
const source = execFileSync('git', ['show', `${baselineSha}:web/engine/GaussianPly.ts`], {
  cwd: fileURLToPath(root), encoding: 'utf8',
}).replace(/from '([^']+)'/g, (match: string, specifier: string) => specifier.startsWith('.')
  ? `from '${new URL(specifier, new URL('web/engine/GaussianPly.ts', root)).href}'` : match);
const temporary = await mkdtemp(join(tmpdir(), 'ply-decode-'));
await init({ module_or_path: await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root)) });
const keys = ['centers', 'covariances', 'opacities', 'colors', 'shCoefficients'] as const;
const median = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
try {
  const baselinePath = join(temporary, 'baseline.mts');
  await writeFile(baselinePath, source);
  const { parseGaussianSplatPly: baseline } = await import(pathToFileURL(baselinePath).href) as {
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
    results.push({ degree, count, inputBytes: buffer.byteLength, before, after,
      baselineMedianMs: median(before), currentMedianMs: median(after), identicalBytes: true });
  }
  process.stdout.write(JSON.stringify({ baselineSha, node: process.version, platform: process.platform,
    arch: process.arch, cpu: cpus()[0]?.model, warmup: 3, rounds,
    scope: 'Synchronous PLY decode including output allocation and WASM covariance; excludes I/O, WASM init, view preparation and GPU',
    results }, null, 2) + '\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
