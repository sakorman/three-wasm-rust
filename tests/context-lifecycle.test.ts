import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextLifecycle } from '../web/engine/ContextLifecycle.ts';

function context() {
  const canvas = new EventTarget();
  let lost = false;
  const gl = { canvas, isContextLost: () => lost } as unknown as WebGL2RenderingContext;
  return {
    gl,
    setLost: () => {
      lost = true;
    },
    lose: () => {
      lost = true;
      const event = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(event);
      return event;
    },
    restore: () => {
      lost = false;
      canvas.dispatchEvent(new Event('webglcontextrestored'));
    },
  };
}

test('context loss invalidates once and rebuilds before notifying readiness', () => {
  const ctx = context(),
    events: string[] = [];
  const lifecycle = new ContextLifecycle(
    ctx.gl,
    () => events.push('rebuild'),
    () => events.push('release'),
  );
  lifecycle.subscribe(() => events.push(lifecycle.state));
  assert.equal(ctx.lose().defaultPrevented, true);
  ctx.lose();
  assert.equal(lifecycle.generation, 1);
  assert.throws(() => lifecycle.assertReady(), /lost/);
  ctx.restore();
  lifecycle.assertReady();
  assert.deepEqual(events, ['release', 'lost', 'rebuild', 'ready']);
  ctx.lose();
  ctx.restore();
  assert.equal(lifecycle.generation, 2);
  lifecycle.dispose();
});

test('context loss can be detected before its asynchronous event arrives', () => {
  const ctx = context();
  const lifecycle = new ContextLifecycle(ctx.gl);
  ctx.setLost();
  assert.equal(lifecycle.ready, false);
  assert.throws(() => lifecycle.assertReady(), /lost/);
  ctx.lose();
  assert.equal(lifecycle.generation, 1);
  ctx.restore();
  assert.equal(lifecycle.ready, true);
  lifecycle.dispose();
});

test('rebuild failure stays unavailable; dispose removes restore listeners', () => {
  const ctx = context();
  let calls = 0;
  const lifecycle = new ContextLifecycle(ctx.gl, () => {
    calls++;
    throw new Error('allocation failed');
  });
  ctx.lose();
  ctx.restore();
  assert.equal(lifecycle.state, 'failed');
  assert.throws(() => lifecycle.assertReady(), /failed/);
  lifecycle.dispose();
  lifecycle.dispose();
  ctx.lose();
  ctx.restore();
  assert.equal(calls, 1);
  assert.equal(lifecycle.state, 'disposed');
});

test('disposing during loss prevents resurrection', () => {
  const ctx = context();
  let calls = 0;
  const lifecycle = new ContextLifecycle(ctx.gl, () => {
    calls++;
  });
  ctx.lose();
  lifecycle.dispose();
  ctx.restore();
  assert.equal(calls, 0);
  assert.equal(lifecycle.ready, false);
});

for (const earlyDetection of [false, true]) {
  test(`a later context cycle retries a failed rebuild (early detection: ${earlyDetection})`, () => {
    const ctx = context(), events: string[] = [];
    let rebuilds = 0, releases = 0;
    const lifecycle = new ContextLifecycle(ctx.gl, () => {
      if (++rebuilds <= 2) throw new Error('temporary allocation failure');
    }, () => { releases++; });
    lifecycle.subscribe(() => events.push(lifecycle.state));
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (earlyDetection) {
        ctx.setLost();
        assert.throws(() => lifecycle.assertReady(), /lost/);
      }
      ctx.lose();
      assert.equal(lifecycle.state, 'lost');
      assert.equal(lifecycle.generation, cycle);
      ctx.restore();
      if (cycle < 3) {
        assert.equal(lifecycle.state, 'failed');
        assert.match(String(lifecycle.error), /temporary allocation failure/);
        assert.throws(() => lifecycle.assertReady(), /failed/);
        // Duplicate restore events and readiness checks must not cause retries.
        ctx.restore();
        assert.equal(rebuilds, cycle);
      }
    }
    lifecycle.assertReady();
    assert.equal(lifecycle.error, undefined);
    assert.equal(releases, 3);
    assert.deepEqual(events, ['lost', 'failed', 'lost', 'failed', 'lost', 'ready']);
    lifecycle.dispose();
  });
}
