import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preparePlyParser, sourceKeys } from './benchmarks/ply-parser.ts';
import { runPlyMemoryProbe } from './benchmarks/ply-memory-probe.ts';

test('PLY memory probes observe empty, full and partial covariance chunks in fresh WASM instances', async () => {
  const parser = await preparePlyParser(undefined, true);
  try {
    for (const count of [0, 65536, 65537]) {
      const result = runPlyMemoryProbe(parser.url, count, 3);
      assert.deepEqual(result.calls.map(call => call.count), count === 0 ? [] : count === 65536 ? [65536] : [65536, 1]);
      for (const call of result.calls) {
        assert.equal(call.inputViewBytes, call.count * 28);
        assert.equal(call.inputBackingBytes, Math.min(count, 65536) * 28);
        assert.equal(call.resultBytes, call.count * 24);
      }
      assert.deepEqual(sourceKeys.map(key => result.outputs[key].bytes), [3, 6, 1, 3, 48].map(n => count * n * 4));
      assert.deepEqual(result.samples.filter(s => !s.stage.startsWith('covariance')).map(s => s.stage),
        ['before-decode', 'after-decode', 'retained-after-gc', 'released-after-gc']);
      const capacities = result.samples.map(s => s.wasmCapacityBytes);
      assert.ok(capacities.every((n, i) => n > 0 && n % 65536 === 0 && (i === 0 || n >= capacities[i - 1])));
    }
  } finally { await parser.dispose(); }
});

test('same-parser memory control reports identical calls and hashes instead of an assumed baseline reduction', async () => {
  const parser = await preparePlyParser(undefined, true);
  try {
    const before = runPlyMemoryProbe(parser.url, 65537, 0), after = runPlyMemoryProbe(parser.url, 65537, 0);
    assert.deepEqual(before.calls, after.calls);
    assert.equal(before.inputSha256, after.inputSha256);
    assert.deepEqual(before.outputs, after.outputs);
    assert.deepEqual(before.samples.map(s => s.wasmCapacityBytes), after.samples.map(s => s.wasmCapacityBytes));
  } finally { await parser.dispose(); }
});
