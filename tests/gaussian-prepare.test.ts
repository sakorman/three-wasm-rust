import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init from '../pkg/three_wasm_rust.js';
import { prepareGaussianRaster } from '../web/engine/index.ts';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

const camera = {
  focalX: 96, focalY: 96, principalX: 128, principalY: 96,
  near: 1, far: 4, width: 256, height: 192,
};

function repeatedCovariance(): Float32Array {
  return new Float32Array([
    .04, 0, 0, .04, 0, .25,
    .04, 0, 0, .04, 0, .25,
    .04, 0, 0, .04, 0, .25,
    .04, 0, 0, .04, 0, .25,
  ]);
}

test('Gaussian preparation keeps source IDs while compacting, clipping and tiling a camera view', () => {
  const centers = new Float32Array([0, 0, .8, .1, 0, 2, 0, 0, 4.5, 10, 0, 2]);
  const covariances = repeatedCovariance(), opacities = new Float32Array([.5, .8, .7, .9]);
  const savedCenters = centers.slice(), savedCovariances = covariances.slice(), savedOpacities = opacities.slice();
  const prepared = prepareGaussianRaster({
    centers, covariances, opacities, cutoff: .1, camera, filterVariance: .25, tileSize: 16,
    clipPlane: { normal: new Float32Array([0, 0, -1]), offset: -1 },
  });

  assert.deepEqual(Array.from(prepared.originalIds), [2, 1, 0]);
  assert.deepEqual(Array.from(prepared.depths), [4.5, 2, Math.fround(.8)]);
  assert.equal(prepared.screenCenters.length, 6);
  assert.equal(prepared.screenCovariances.length, 9);
  assert.equal(prepared.opacities.length, 3);
  assert.equal(prepared.halfExtents.length, 6);
  assert.ok(prepared.clipCoefficients);
  assert.ok(prepared.clipCoefficients[2] > 0 && prepared.clipCoefficients[5] > 0 && prepared.clipCoefficients[8] < 0);
  assert.ok(prepared.opacities[0] < .7, 'screen filtering should compensate the peak opacity');
  assert.ok(prepared.tiles);
  const tileCount = prepared.tiles.columns * prepared.tiles.rows;
  const tileIds = prepared.tiles.packed.subarray(tileCount + 1);
  assert.ok(tileIds.length > 0);
  for (const index of tileIds) assert.ok(index < prepared.originalIds.length);
  assert.deepEqual(centers, savedCenters);
  assert.deepEqual(covariances, savedCovariances);
  assert.deepEqual(opacities, savedOpacities);
});

test('Gaussian preparation rejects mismatched source buffers and unsafe tile settings', () => {
  const input = {
    centers: new Float32Array([0, 0, 2]), covariances: new Float32Array([.04, 0, 0, .04, 0, .25]),
    opacities: new Float32Array([.8]), cutoff: .1, camera,
  };
  assert.throws(() => prepareGaussianRaster({ ...input, covariances: new Float32Array([1, 0, 1]) }), /matching/);
  assert.throws(() => prepareGaussianRaster({ ...input, tileSize: 0 }), /tile size/);
  assert.throws(() => prepareGaussianRaster({ ...input, tileSize: 16, camera: { ...camera, width: 255.5 } }), /integer viewport/);
});
