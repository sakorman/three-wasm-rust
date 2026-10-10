import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuTimer } from '../web/compare/GpuTimer.ts';

function context(supported = true) {
  let available = false,
    disjoint = false,
    created = 0,
    deleted = 0,
    reads = 0;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: () => (supported ? { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 } : null),
    createQuery: () => ({ id: ++created }),
    beginQuery: () => {},
    endQuery: () => {},
    deleteQuery: () => {
      deleted++;
    },
    getParameter: () => disjoint,
    getQueryParameter: (_query: unknown, parameter: number) => {
      if (parameter === 1) return available;
      reads++;
      return 2_500_000;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    available: () => {
      available = true;
    },
    disjoint: () => {
      disjoint = true;
    },
    stats: () => ({ created, deleted, reads }),
  };
}

test('GPU timer reads only available results and converts nanoseconds to milliseconds', () => {
  const ctx = context(),
    timer = new GpuTimer(ctx.gl);
  timer.begin();
  timer.end();
  timer.poll();
  assert.equal(ctx.stats().reads, 0);
  ctx.available();
  timer.poll();
  assert.deepEqual(timer.samples, [2.5]);
  assert.equal(ctx.stats().deleted, 1);
  timer.dispose();
});

test('GPU timer discards disjoint samples and deletes pending queries', () => {
  const ctx = context(),
    timer = new GpuTimer(ctx.gl);
  timer.begin();
  timer.end();
  ctx.available();
  timer.poll();
  timer.begin();
  timer.end();
  ctx.disjoint();
  timer.poll();
  assert.equal(timer.disjoint, true);
  assert.deepEqual(timer.samples, []);
  assert.equal(ctx.stats().deleted, 2);
  timer.begin();
  timer.end();
  assert.equal(ctx.stats().created, 2);
});

test('GPU timer supports missing extensions and caps outstanding queries', () => {
  const missing = context(false),
    timer = new GpuTimer(missing.gl);
  timer.begin();
  timer.end();
  timer.poll();
  timer.dispose();
  assert.equal(timer.supported, false);
  assert.equal(missing.stats().created, 0);
  const ctx = context(),
    pending = new GpuTimer(ctx.gl);
  for (let i = 0; i < 20; i++) {
    pending.begin();
    pending.end();
  }
  assert.equal(ctx.stats().created, 8);
  pending.dispose();
  assert.equal(ctx.stats().deleted, 8);
});
