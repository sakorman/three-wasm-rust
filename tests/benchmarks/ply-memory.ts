import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { preparePlyParser, root, sha256 } from './ply-parser.ts';
import { runPlyMemoryProbe } from './ply-memory-probe.ts';

// Usage: npx tsx tests/benchmarks/ply-memory.ts <baseline-commit> [count=500000] [rounds=3]
const [revision, countArg = '500000', roundsArg = '3'] = process.argv.slice(2);
if (!revision) throw new Error('Supply a baseline commit SHA');
const count = Number(countArg), rounds = Number(roundsArg);
assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000, 'Invalid count');
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 9, 'Invalid rounds');
const baseline = await preparePlyParser(revision, true);
try {
  const current = await preparePlyParser(undefined, true);
  try {
    const results = [];
    for (const degree of [0, 3] as const) {
      const runs = [];
      for (let round = 0; round < rounds; round++) {
        const order = round % 2 === 0 ? ['baseline', 'current'] as const : ['current', 'baseline'] as const;
        const pair = order.map(variant => ({ variant, ...runPlyMemoryProbe(variant === 'baseline' ? baseline.url : current.url, count, degree) }));
        assert.equal(pair[0].inputSha256, pair[1].inputSha256);
        assert.deepEqual(pair[0].outputs, pair[1].outputs, 'Decoded outputs differ');
        runs.push({ round, order, pair });
      }
      results.push({ count, degree, outputDigestsMatch: true, runs });
    }
    process.stdout.write(JSON.stringify({
      baseline: { commit: baseline.commit, parserSha256: baseline.sourceSha256 },
      current: { head: current.commit, parserSha256: current.sourceSha256 },
      wasmSha256: sha256(await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root))),
      node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model,
      scope: 'Cold synchronous decode; each sample uses a new process and WASM instance. Historical parser uses current dependencies.',
      accounting: 'Stage snapshots, not JS heap peaks. WASM capacity is linear-memory capacity, not live allocations. ArrayBuffers is included in external; fields must not be summed. GC runs before decode, after retaining outputs, and after release; none is forced during decode. Covariance probes affect execution; no timing or GPU claims.',
      rounds, results,
    }, null, 2) + '\n');
  } finally { await current.dispose(); }
} finally { await baseline.dispose(); }
