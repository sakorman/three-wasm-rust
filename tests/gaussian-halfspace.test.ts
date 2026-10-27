import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { gaussian_halfspace_clip_coefficients } from '../pkg/three_wasm_rust.js';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

function referenceCoefficients(center: number[], covariance: number[], focalX: number, focalY: number, planeNormal: number[], planeOffset: number) {
  const normalLength = Math.hypot(...planeNormal);
  const normal = planeNormal.map(value => value / normalLength), offset = planeOffset / normalLength;
  const [x, y, z] = center, [xx, xy, xz, yy, yz, zz] = covariance;
  const mx = [focalX / z, 0, -focalX * x / z ** 2], my = [0, focalY / z, -focalY * y / z ** 2];
  const axx = mx[0] * (mx[0] * xx + mx[2] * xz) + mx[2] * (mx[0] * xz + mx[2] * zz);
  const axy = mx[0] * (my[1] * xy + my[2] * xz) + mx[2] * (my[1] * yz + my[2] * zz);
  const ayy = my[1] * (my[1] * yy + my[2] * yz) + my[2] * (my[1] * yz + my[2] * zz);
  const [a00, a01, a11] = [Math.fround(axx), Math.fround(axy), Math.fround(ayy)];
  const determinant = a00 * a11 - a01 ** 2, inverse = [a11 / determinant, -a01 / determinant, a00 / determinant];
  const sigmaNormal = [xx * normal[0] + xy * normal[1] + xz * normal[2], xy * normal[0] + yy * normal[1] + yz * normal[2], xz * normal[0] + yz * normal[1] + zz * normal[2]];
  const b = [mx[0] * sigmaNormal[0] + mx[2] * sigmaNormal[2], my[1] * sigmaNormal[1] + my[2] * sigmaNormal[2]];
  const inverseB = [inverse[0] * b[0] + inverse[1] * b[1], inverse[1] * b[0] + inverse[2] * b[1]];
  const variance = normal.reduce((sum, value, index) => sum + value * sigmaNormal[index], 0);
  const standardDeviation = Math.sqrt(Math.max(variance - b[0] * inverseB[0] - b[1] * inverseB[1], 1e-8));
  return [inverseB[0] / standardDeviation, inverseB[1] / standardDeviation,
    (offset - normal[0] * x - normal[1] * y - normal[2] * z) / standardDeviation].map(Math.fround);
}

test('half-space clip coefficients match an independent affine conditional reference over 4097 splats', () => {
  const count = 4097, centers = new Float32Array(count * 3), covariance = new Float32Array(count * 6);
  for (let index = 0; index < count; index++) {
    const a = .02 + index % 7 * .01, b = (index % 5 - 2) * .003, c = (index % 3 - 1) * .002;
    const d = .03 + index % 11 * .006, e = (index % 4 - 1.5) * .002, f = .04 + index % 13 * .005;
    centers.set([Math.fround((index % 17 - 8) * .04), Math.fround((index % 19 - 9) * .03), Math.fround(.8 + index % 23 * .15)], index * 3);
    covariance.set([a * a, a * b, a * c, b * b + d * d, b * c + d * e, c * c + e * e + f * f].map(Math.fround), index * 6);
  }
  const focalX = 128, focalY = 96, normal = new Float32Array([.8, -.3, -.5]), offset = Math.fround(-1.2);
  const actual = gaussian_halfspace_clip_coefficients(centers, covariance, focalX, focalY, normal, offset);
  for (let index = 0; index < count; index++) {
    const expected = referenceCoefficients(Array.from(centers.slice(index * 3, index * 3 + 3)), Array.from(covariance.slice(index * 6, index * 6 + 6)), focalX, focalY, Array.from(normal), offset);
    for (let component = 0; component < 3; component++) {
      const value = actual[index * 3 + component], tolerance = 3e-5 * Math.max(1, Math.abs(expected[component]));
      assert.ok(Math.abs(value - expected[component]) <= tolerance, `splat ${index}, component ${component}: ${value} != ${expected[component]}`);
    }
  }
});

test('half-space clip coefficients are invariant under plane scaling and reject invalid planes', () => {
  const centers = new Float32Array([0, 0, 2]), covariance = new Float32Array([.02, 0, 0, .02, 0, .04]);
  const unit = gaussian_halfspace_clip_coefficients(centers, covariance, 96, 96, new Float32Array([.8, 0, -.6]), -1.2);
  const scaled = gaussian_halfspace_clip_coefficients(centers, covariance, 96, 96, new Float32Array([2.4, 0, -1.8]), -3.6);
  for (let index = 0; index < unit.length; index++) assert.ok(Math.abs(unit[index] - scaled[index]) < 2e-6);
  assert.throws(() => gaussian_halfspace_clip_coefficients(centers, covariance, 96, 96, new Float32Array([0, 0, 0]), 0), /nonzero/);
  assert.throws(() => gaussian_halfspace_clip_coefficients(centers, covariance, 96, 96, new Float32Array([0, NaN, 1]), 0), /plane/);
});
