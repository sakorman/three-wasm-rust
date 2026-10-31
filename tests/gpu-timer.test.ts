import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GpuTimer } from '../web/compare/GpuTimer.ts';

function context(supported = true) {
  let available = false,
    disjoint = false,
    created = 0,
    deleted = 0,
    reads = 0;
  const canvas = new EventTarget();
  let lost = false;
  let active: unknown = null;
  let duration: unknown = 2_500_000;
  let allocationFails = false;
  const gl = {
    canvas,
    isContextLost: () => lost,
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    CURRENT_QUERY: 5,
    getQuery: () => active,
    getExtension: () => (supported ? { TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 } : null),
    createQuery: () => allocationFails ? null : ({ id: ++created }),
    beginQuery: (_target: number, query: unknown) => {
      assert.equal(active, null, 'a timer query is already active');
      active = query;
    },
    endQuery: () => {
      assert.notEqual(active, null, 'no timer query is active');
      active = null;
    },
    deleteQuery: () => {
      deleted++;
    },
    getParameter: () => disjoint,
    getQueryParameter: (_query: unknown, parameter: number) => {
      if (parameter === 1) return available;
      reads++;
      return duration;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl,
    available: () => {
      available = true;
    },
    disjoint: (value = true) => {
      disjoint = value;
    },
    duration: (value: unknown) => { duration = value; },
    failAllocation: (value: boolean) => { allocationFails = value; },
    active: () => active,
    stats: () => ({ created, deleted, reads }),
    lose: () => {
      lost = true;
      active = null;
      canvas.dispatchEvent(new Event('webglcontextlost'));
    },
    restore: () => {
      lost = false;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
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

test('overlapping GPU timers preserve the current query and retry after it ends', () => {
  const ctx = context(), outer = new GpuTimer(ctx.gl), inner = new GpuTimer(ctx.gl);
  outer.begin();
  const query = ctx.active();
  inner.begin(); inner.end(); inner.poll();
  assert.equal(ctx.active(), query);
  assert.deepEqual(ctx.stats(), { created: 1, deleted: 0, reads: 0 });
  assert.equal(inner.diagnostics.queryConflicts, 1);
  assert.deepEqual(inner.samples, []);
  outer.end(); ctx.available(); outer.poll();
  inner.begin(); inner.end(); inner.poll();
  assert.deepEqual(outer.samples, [2.5]);
  assert.deepEqual(inner.samples, [2.5]);
  outer.dispose(); inner.dispose();
});

for (const stop of ['end', 'dispose', 'disjoint'] as const) {
  test(`GPU timer ${stop} discards interrupted queries without ending an external query`, () => {
    const ctx = context(), timer = new GpuTimer(ctx.gl);
    timer.begin();
    ctx.gl.endQuery(3);
    const external = ctx.gl.createQuery();
    ctx.gl.beginQuery(3, external!);
    if (stop === 'disjoint') { ctx.disjoint(); timer.poll(); }
    else timer[stop]();
    assert.equal(ctx.active(), external);
    assert.equal(timer.diagnostics.queryConflicts, 1);
    assert.equal(timer.diagnostics.pendingQueries, 0);
    ctx.available(); timer.poll();
    assert.deepEqual(timer.samples, []);
    timer.dispose();
    assert.equal(ctx.active(), external);
    assert.deepEqual(ctx.stats(), { created: 2, deleted: 1, reads: 0 });
    ctx.gl.endQuery(3); ctx.gl.deleteQuery(external);
  });
}

test('an externally ended GPU query is rejected and later sampling can recover', () => {
  const ctx = context(), timer = new GpuTimer(ctx.gl);
  timer.begin(); ctx.gl.endQuery(3); timer.end();
  ctx.available(); timer.poll();
  assert.deepEqual(timer.samples, []);
  assert.equal(timer.diagnostics.queryConflicts, 1);
  timer.begin(); timer.end(); timer.poll();
  assert.deepEqual(timer.samples, [2.5]);
  assert.deepEqual(ctx.stats(), { created: 2, deleted: 2, reads: 1 });
  timer.dispose();
});

test('GPU timer ignores duplicate begin and cannot restart after disposal', () => {
  const ctx = context(), timer = new GpuTimer(ctx.gl);
  timer.begin();
  timer.begin();
  assert.equal(ctx.stats().created, 1);
  timer.dispose();
  assert.equal(ctx.active(), null);
  assert.deepEqual(ctx.stats(), { created: 1, deleted: 1, reads: 0 });
  timer.dispose();
  timer.begin();
  timer.end();
  timer.poll();
  assert.deepEqual(ctx.stats(), { created: 1, deleted: 1, reads: 0 });
});

test('disjoint closes an active query and remains invalid after the flag clears', () => {
  const ctx = context(), timer = new GpuTimer(ctx.gl);
  timer.begin();
  ctx.disjoint();
  timer.poll();
  assert.equal(ctx.active(), null);
  assert.equal(ctx.stats().deleted, 1);
  ctx.disjoint(false);
  ctx.available();
  timer.end();
  timer.begin();
  timer.poll();
  timer.dispose();
  assert.equal(timer.disjoint, true);
  assert.deepEqual(timer.samples, []);
  assert.deepEqual(ctx.stats(), { created: 1, deleted: 1, reads: 0 });
});

test('GPU timer rejects invalid durations but keeps zero-duration samples', () => {
  const ctx = context(), timer = new GpuTimer(ctx.gl);
  ctx.available();
  for (const value of [-1, NaN, Infinity, 'invalid', 0, 2_500_000]) {
    ctx.duration(value);
    timer.begin();
    timer.end();
    timer.poll();
  }
  assert.deepEqual(timer.samples, [0, 2.5]);
  assert.equal(timer.diagnostics.invalidResults, 4);
  assert.deepEqual(ctx.stats(), { created: 6, deleted: 6, reads: 6 });
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
  assert.deepEqual(timer.diagnostics, { allocationFailures: 0, queueLimitSkips: 0, invalidResults: 0, queryConflicts: 0, pendingQueries: 0 });
  const ctx = context(),
    pending = new GpuTimer(ctx.gl);
  for (let i = 0; i < 20; i++) {
    pending.begin();
    pending.end();
  }
  assert.equal(ctx.stats().created, 8);
  assert.deepEqual(pending.diagnostics, { allocationFailures: 0, queueLimitSkips: 12, invalidResults: 0, queryConflicts: 0, pendingQueries: 8 });
  pending.dispose();
  assert.equal(ctx.stats().deleted, 8);
});

test('GPU timer never reads stale queries after context restoration', () => {
  const ctx = context(),
    timer = new GpuTimer(ctx.gl);
  timer.begin();
  timer.end();
  ctx.available();
  timer.poll();
  timer.begin();
  timer.end();
  ctx.lose();
  ctx.restore();
  timer.poll();
  timer.begin();
  timer.end();
  timer.dispose();
  assert.deepEqual(timer.samples, []);
  assert.equal(timer.disjoint, true);
  assert.deepEqual(ctx.stats(), { created: 2, deleted: 1, reads: 1 });
});

test('GPU diagnostics distinguish allocation failure from unread results and return isolated snapshots', () => {
  const ctx = context(), timer = new GpuTimer(ctx.gl);
  ctx.failAllocation(true);
  timer.begin(); timer.end();
  ctx.failAllocation(false);
  timer.begin(); timer.end(); timer.poll();
  const snapshot = timer.diagnostics;
  assert.deepEqual(snapshot, { allocationFailures: 1, queueLimitSkips: 0, invalidResults: 0, queryConflicts: 0, pendingQueries: 1 });
  assert.equal(ctx.stats().reads, 0);
  snapshot.allocationFailures = 99;
  assert.equal(timer.diagnostics.allocationFailures, 1);
  ctx.available(); timer.poll();
  assert.deepEqual(timer.samples, [2.5]);
  assert.equal(timer.diagnostics.pendingQueries, 0);
  assert.equal(snapshot.pendingQueries, 1);
  timer.dispose();
});

test('pending diagnostics are captured before cleanup without waiting for GPU results', () => {
  const ctx = context(), timer = new GpuTimer(ctx.gl);
  for (let i = 0; i < 24; i++) { timer.begin(); timer.end(); timer.poll(); }
  const snapshot = timer.diagnostics;
  assert.deepEqual(snapshot, { allocationFailures: 0, queueLimitSkips: 16, invalidResults: 0, queryConflicts: 0, pendingQueries: 8 });
  timer.dispose();
  assert.equal(timer.diagnostics.pendingQueries, 0);
  assert.equal(snapshot.pendingQueries, 8);
  assert.deepEqual(ctx.stats(), { created: 8, deleted: 8, reads: 0 });
});
