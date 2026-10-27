import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextLifecycle } from '../web/engine/ContextLifecycle.ts';
import { GaussianUploadBuffers } from '../web/engine/GaussianUploadBuffers.ts';
import type { PackedGaussianRasterUpload } from '../web/engine/gaussian.ts';

function upload(): PackedGaussianRasterUpload {
  const record = (centerX: number, opacity: number) => [centerX, 12, 4, 5, 2, 0, 2, opacity, 0, 0, 0, 0];
  return {
    splatData: new Float32Array([...record(10, .8), ...record(20, .6), ...record(30, .4)]),
    originalIds: new Uint32Array([7, 8, 9]),
    tiles: { tileSize: 16, columns: 2, rows: 1, packed: new Uint32Array([0, 2, 3, 0, 1, 2]) },
  };
}

function fakeContext() {
  const canvas = new EventTarget();
  const bytes = new Map<object, Uint8Array>();
  let arrayBuffer: object | null = null, elementBuffer: object | null = null, lost = false;
  let creates = 0, deletes = 0, dataCalls = 0, subDataCalls = 0, ignoreNextData = false;
  const binding = (target: number) => target === 0x8892 ? arrayBuffer : elementBuffer;
  const setBinding = (target: number, buffer: object | null) => {
    if (target === 0x8892) arrayBuffer = buffer;
    else elementBuffer = buffer;
  };
  const copy = (data: Float32Array | Uint32Array | number) => typeof data === 'number'
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const gl = {
    canvas, ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, ARRAY_BUFFER_BINDING: 0x8894,
    ELEMENT_ARRAY_BUFFER_BINDING: 0x8895, BUFFER_SIZE: 0x8764, DYNAMIC_DRAW: 0x88e8,
    isContextLost: () => lost,
    createBuffer: () => { const buffer = {}; bytes.set(buffer, new Uint8Array()); creates++; return buffer; },
    deleteBuffer: (buffer: object | null) => { if (buffer && bytes.delete(buffer)) deletes++; },
    bindBuffer: (target: number, buffer: object | null) => setBinding(target, buffer),
    getParameter: (name: number) => name === 0x8894 ? arrayBuffer : elementBuffer,
    getBufferParameter: (target: number) => bytes.get(binding(target)!)!.byteLength,
    bufferData: (target: number, data: Float32Array | Uint32Array | number) => {
      const buffer = binding(target); if (!buffer) throw new Error('Missing bound buffer');
      dataCalls++;
      if (ignoreNextData) { ignoreNextData = false; return; }
      bytes.set(buffer, copy(data));
    },
    bufferSubData: (target: number, offset: number, data: Float32Array | Uint32Array) => {
      const buffer = binding(target), storage = buffer && bytes.get(buffer);
      if (!storage || offset + data.byteLength > storage.byteLength) throw new Error('Invalid buffer sub-data range');
      storage.set(copy(data), offset); subDataCalls++;
    },
  } as unknown as WebGL2RenderingContext;
  canvas.addEventListener('webglcontextlost', () => {
    bytes.clear(); arrayBuffer = null; elementBuffer = null;
  });
  return {
    gl,
    failNextBufferData: () => { ignoreNextData = true; },
    stats: () => ({ creates, deletes, dataCalls, subDataCalls }),
    floatAt: (buffer: WebGLBuffer) => new Float32Array(bytes.get(buffer as unknown as object)!.buffer)[0],
    lose: () => {
      lost = true;
      const event = new Event('webglcontextlost', { cancelable: true });
      canvas.dispatchEvent(event);
      return event;
    },
    restore: () => { lost = false; canvas.dispatchEvent(new Event('webglcontextrestored')); },
  };
}

test('Gaussian upload buffers reuse capacity and recreate copied data after a context restore', () => {
  const fake = fakeContext(), lifecycle = new ContextLifecycle(fake.gl), buffers = new GaussianUploadBuffers(fake.gl, lifecycle);
  const initial = upload();
  buffers.update(initial);
  const first = buffers.snapshot();
  assert.ok(first);
  assert.equal(first.recordCount, 3);
  assert.equal(first.splatBytes, 144);
  assert.equal(first.splatCapacityBytes, 144);
  assert.equal(first.tileBytes, 24);
  assert.equal(first.tileCapacityBytes, 24);
  assert.equal(fake.stats().creates, 2);

  const reduced: PackedGaussianRasterUpload = {
    splatData: initial.splatData.slice(0, 24), originalIds: initial.originalIds.slice(0, 2),
  };
  buffers.update(reduced);
  const reused = buffers.snapshot();
  assert.ok(reused);
  assert.equal(reused.splatBytes, 96);
  assert.equal(reused.splatCapacityBytes, 144);
  assert.equal(reused.tileBuffer, undefined);
  assert.equal(reused.tileCapacityBytes, 0);
  assert.deepEqual(fake.stats(), { creates: 2, deletes: 1, dataCalls: 2, subDataCalls: 1 });

  assert.equal(fake.lose().defaultPrevented, true);
  assert.equal(buffers.snapshot(), undefined);
  const recovery = upload(), expectedCenter = recovery.splatData[0];
  buffers.update(recovery);
  recovery.splatData[0] = -100;
  fake.restore();
  const restored = buffers.snapshot();
  assert.ok(restored);
  assert.notEqual(restored.splatBuffer, first.splatBuffer);
  assert.equal(fake.floatAt(restored.splatBuffer), expectedCenter);
  assert.deepEqual(fake.stats(), { creates: 4, deletes: 1, dataCalls: 4, subDataCalls: 1 });

  assert.throws(() => buffers.update({ ...recovery, splatData: new Float32Array(1) }), /inconsistent/);
  buffers.dispose();
  assert.equal(buffers.snapshot(), undefined);
  assert.deepEqual(fake.stats(), { creates: 4, deletes: 3, dataCalls: 4, subDataCalls: 1 });
  lifecycle.dispose();
});

test('Gaussian upload buffers reject a silent storage allocation failure and allow a later retry', () => {
  const fake = fakeContext(), lifecycle = new ContextLifecycle(fake.gl), buffers = new GaussianUploadBuffers(fake.gl, lifecycle);
  fake.failNextBufferData();
  assert.throws(() => buffers.update(upload()), /storage allocation failed/);
  assert.equal(buffers.snapshot(), undefined);
  assert.match(String(buffers.error), /storage allocation failed/);
  assert.deepEqual(fake.stats(), { creates: 1, deletes: 1, dataCalls: 1, subDataCalls: 0 });
  buffers.update(upload());
  assert.ok(buffers.snapshot());
  assert.equal(buffers.error, undefined);
  buffers.dispose();
  lifecycle.dispose();
});
