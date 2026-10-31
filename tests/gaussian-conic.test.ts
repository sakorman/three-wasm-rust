import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packGaussianRasterUpload } from '../web/engine/gaussian.ts';

function prepared(covariance: number[]) {
  return {
    originalIds: new Uint32Array([7, 3]), screenCenters: new Float32Array([8, 8, 16, 16]),
    screenCovariances: new Float32Array([25, 0, 25, ...covariance]),
    opacities: new Float32Array([.5, .8]), colors: new Float32Array([1, 0, 0, 0, 1, 0]),
    depths: new Float32Array([3, 2]), halfExtents: new Float32Array([12, 12, 12, 12]),
  };
}

test('Gaussian packing rejects inverses made singular or indefinite by f32 rounding', () => {
  const cases = [
    { covariance: [2.685375213623047, 2.444232225418091, 2.224743604660034], inverse: [13831326, -15195897, 16695093], determinant: -11751291 },
    { covariance: [18.332870483398438, 4.2816901206970215, 1], inverse: [5161984, -22102016, 94633984], determinant: 0 },
  ];
  for (const fixture of cases) {
    const [a, b, c] = fixture.inverse;
    assert.equal(a * c - b * b, fixture.determinant);
    for (const exponent of [-80, 0, 80]) {
      for (const sign of [-1, 1]) {
        const covariance = fixture.covariance.map((value, index) => value * 2 ** exponent * (index === 1 ? sign : 1));
        const input = prepared(covariance), saved = structuredClone(input);
        const [xx, xy, yy] = input.screenCovariances.slice(3);
        assert.ok(xx * yy - xy * xy > 0, 'source covariance remains positive definite');
        assert.throws(() => packGaussianRasterUpload(input), /conic.*positive definite.*f32.*index 1/);
        assert.deepEqual(input, saved);
      }
    }
  }
});

test('Gaussian packing retains finite positive conics across reciprocal f32 scales', () => {
  const cases = [
    { covariance: [1, .5, 1], inverse: [4 / 3, -2 / 3, 4 / 3] },
    { covariance: [1, -.5, 1], inverse: [4 / 3, 2 / 3, 4 / 3] },
    { covariance: [2 ** 127, 0, 2 ** 127], inverse: [2 ** -127, 0, 2 ** -127] },
    { covariance: [2 ** -120, 0, 2 ** -120], inverse: [2 ** 120, 0, 2 ** 120] },
    { covariance: [1, 0, 2 ** -120], inverse: [1, 0, 2 ** 120] },
  ];
  for (const fixture of cases) {
    const input = prepared(fixture.covariance), saved = structuredClone(input);
    const result = packGaussianRasterUpload(input).splatData.slice(19, 22);
    const expected = new Float32Array(fixture.inverse);
    // The sign of an off-diagonal zero has no effect on the quadratic form.
    assert.deepEqual(Array.from(result, value => value || 0), Array.from(expected));
    assert.ok(result[0] * result[2] - result[1] * result[1] > 0);
    assert.deepEqual(input, saved);
  }
});
