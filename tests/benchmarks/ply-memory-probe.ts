import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import init from '../../pkg/three_wasm_rust.js';
import type { GaussianPlySource, GaussianShDegree } from '../../web/engine/GaussianPly.ts';
import { gaussianPlyFixture } from '../fixtures/gaussian-ply.ts';
import { root, sha256, sourceKeys } from './ply-parser.ts';

interface MemorySample extends NodeJS.MemoryUsage { stage: string; wasmCapacityBytes: number }
interface CovarianceCall { count: number; inputViewBytes: number; inputBackingBytes: number; resultBytes: number }
interface Parser {
  parseGaussianSplatPly(buffer: ArrayBuffer): GaussianPlySource;
  observeCovariance(callback: (stage: 'before' | 'after', scales: Float32Array, rotations: Float32Array, result?: Float32Array) => void): void;
}

async function measure(parserUrl: string, count: number, degree: GaussianShDegree) {
  assert.ok(global.gc, 'Memory probes require --expose-gc');
  const parser = await import(parserUrl) as Parser;
  const wasm = await init({ module_or_path: await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root)) });
  let input: ArrayBuffer | undefined = gaussianPlyFixture(count, degree).buffer;
  const inputBytes = input.byteLength, inputSha256 = sha256(new Uint8Array(input));
  const samples: MemorySample[] = [], calls: CovarianceCall[] = [];
  const snapshot = (stage: string) => samples.push({ stage, ...process.memoryUsage(), wasmCapacityBytes: wasm.memory.buffer.byteLength });
  parser.observeCovariance((stage, scales, rotations, result) => {
    if (stage === 'after') {
      calls.push({ count: scales.length / 3, inputViewBytes: scales.byteLength + rotations.byteLength,
        inputBackingBytes: scales.buffer.byteLength + (scales.buffer === rotations.buffer ? 0 : rotations.buffer.byteLength),
        resultBytes: result!.byteLength });
    }
    snapshot(`covariance-${stage}`);
  });
  global.gc();
  snapshot('before-decode');
  let source: GaussianPlySource | undefined = parser.parseGaussianSplatPly(input);
  snapshot('after-decode');
  const outputs = Object.fromEntries(sourceKeys.map(key => {
    const values = source![key];
    return [key, { bytes: values.byteLength, sha256: sha256(new Uint8Array(values.buffer, values.byteOffset, values.byteLength)) }];
  }));
  assert.equal(source.shDegree, degree);
  assert.equal(source.centers.length, count * 3);
  assert.equal(sha256(new Uint8Array(input)), inputSha256, 'Parser mutated its input');
  global.gc();
  snapshot('retained-after-gc');
  // Keep both owners live through the retained snapshot, then explicitly release them.
  assert.equal(input.byteLength, inputBytes);
  assert.equal(source.opacities.length, count);
  input = undefined;
  source = undefined;
  global.gc();
  snapshot('released-after-gc');
  return { count, degree, inputBytes, inputSha256, outputs, calls, samples };
}

export type PlyMemoryProbe = Awaited<ReturnType<typeof measure>>;

/** A fresh process gives each case its own V8 heap and WASM linear-memory high-water mark. */
export function runPlyMemoryProbe(parserUrl: string, count: number, degree: GaussianShDegree): PlyMemoryProbe {
  return JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--import', import.meta.resolve('tsx'),
    fileURLToPath(import.meta.url), '--probe', parserUrl, String(count), String(degree)], {
    cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000,
  })) as PlyMemoryProbe;
}

if (process.argv[2] === '--probe') {
  const [url, countArg, degreeArg] = process.argv.slice(3);
  const count = Number(countArg), degree = Number(degreeArg);
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000);
  assert.ok([0, 1, 2, 3].includes(degree));
  process.stdout.write(JSON.stringify(await measure(url, count, degree as GaussianShDegree)) + '\n');
}
