import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import init from '../pkg/three_wasm_rust.js';
import { gaussianPlyFixture, plyValue } from './fixtures/gaussian-ply.ts';
import { composeThreeModelToPositiveZCamera, evaluateGaussianPlyShColors, modelCameraPositionFromThreeWorld, parseGaussianSplatPly, prepareGaussianPlyForThreeCamera, prepareGaussianRaster, transformGaussianPlyToCameraSpace } from '../web/engine/index.ts';

await init({ module_or_path: await readFile(new URL('../pkg/three_wasm_rust_bg.wasm', import.meta.url)) });

const fields = [
  'rot_2', 'f_rest_0', 'f_rest_1', 'f_rest_2', 'f_rest_3', 'f_rest_4', 'f_rest_5', 'f_rest_6', 'f_rest_7', 'f_rest_8', 'scale_1', 'x', 'f_dc_2', 'rot_0', 'opacity', 'z',
  'scale_0', 'f_dc_0', 'rot_3', 'y', 'scale_2', 'f_dc_1', 'rot_1',
] as const;

type Vertex = Record<(typeof fields)[number], number>;

function binaryPly(vertices: Vertex[], names: readonly (typeof fields)[number][] = fields, types: Partial<Record<(typeof fields)[number], string>> = {}): ArrayBuffer {
  const header = [
    'ply', 'format binary_little_endian 1.0', 'comment synthetic trained splats', `element vertex ${vertices.length}`,
    ...names.map(name => `property ${types[name] ?? 'float'} ${name}`), 'element face 0', 'end_header', '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const buffer = new ArrayBuffer(headerBytes.length + vertices.length * names.length * Float32Array.BYTES_PER_ELEMENT);
  new Uint8Array(buffer).set(headerBytes);
  const view = new DataView(buffer);
  for (let row = 0; row < vertices.length; row++) {
    for (let column = 0; column < names.length; column++) {
      view.setFloat32(headerBytes.length + (row * names.length + column) * 4, vertices[row][names[column]], true);
    }
  }
  return buffer;
}

function fullShPly(degree: 2 | 3): ArrayBuffer {
  const base = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const rest = Array.from({ length: 3 * ((degree + 1) ** 2 - 1) }, (_, index) => `f_rest_${index}`);
  const names = [...base, ...rest];
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', 'element vertex 1', ...names.map(name => `property float ${name}`), 'end_header', ''].join('\n'));
  const buffer = new ArrayBuffer(header.length + names.length * Float32Array.BYTES_PER_ELEMENT);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  names.forEach((name, index) => {
    const value = name === 'z' ? 2 : name === 'rot_0' ? 1 : name === rest.at(-1) ? .25 : 0;
    view.setFloat32(header.length + index * 4, value, true);
  });
  return buffer;
}

function vertex(values: Partial<Vertex>): Vertex {
  return {
    x: 0, y: 0, z: 2, f_dc_0: 0, f_dc_1: 0, f_dc_2: 0,
    f_rest_0: 0, f_rest_1: 0, f_rest_2: 0, f_rest_3: 0, f_rest_4: 0, f_rest_5: 0, f_rest_6: 0, f_rest_7: 0, f_rest_8: 0,
    opacity: 0, scale_0: 0, scale_1: 0, scale_2: 0, rot_0: 1, rot_1: 0, rot_2: 0, rot_3: 0,
    ...values,
  };
}

function close(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 2e-6 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
}

test('trained binary PLY decodes activated attributes and degree-zero SH into the Gaussian preparation input', () => {
  const source = parseGaussianSplatPly(binaryPly([
    vertex({ x: 1, y: 2, z: 3, scale_1: Math.log(2), scale_2: Math.log(3) }),
    vertex({ x: -.25, y: .5, z: 4, f_dc_0: 1, f_dc_1: -10, f_dc_2: .5, opacity: Math.log(3), scale_0: Math.log(2), scale_1: Math.log(3), scale_2: Math.log(4), rot_0: Math.SQRT1_2, rot_3: Math.SQRT1_2 }),
  ]));
  assert.deepEqual(Array.from(source.centers), [1, 2, 3, -.25, .5, 4]);
  assert.deepEqual(Array.from(source.opacities), [.5, .75]);
  close(source.colors[0], .5); close(source.colors[1], .5); close(source.colors[2], .5);
  close(source.colors[3], .5 + .28209479177387814); assert.equal(source.colors[4], 0); close(source.colors[5], .5 + .5 * .28209479177387814);
  assert.equal(source.shDegree, 1);
  assert.equal(source.shCoefficients.length, 24);
  const expectedCovariance = [1, 0, 0, 4, 0, 9, 9, 0, 0, 4, 0, 16];
  source.covariances.forEach((value, index) => close(value, expectedCovariance[index]));
  const cameraSource = transformGaussianPlyToCameraSpace(source, new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1,
  ]));
  assert.deepEqual(Array.from(cameraSource.centers), [1, 2, 4, -.25, .5, 5]);
  assert.deepEqual(Array.from(cameraSource.covariances), Array.from(source.covariances));
  source.opacities[0] = .1; source.colors[0] = 9;
  assert.equal(cameraSource.opacities[0], .5);
  assert.equal(cameraSource.colors[0], .5);

  const prepared = prepareGaussianRaster({
    ...cameraSource, cutoff: .1,
    camera: { focalX: 96, focalY: 96, principalX: 128, principalY: 96, near: 1, far: 5, width: 256, height: 192 },
  });
  assert.deepEqual(Array.from(prepared.originalIds), [1, 0]);
  assert.equal(prepared.colors.length, 6);
  close(prepared.colors[0], cameraSource.colors[3]);
  close(prepared.colors[3], cameraSource.colors[0]);
});

test('complete degree-one PLY coefficients produce view-dependent linear RGB in model coordinates', () => {
  const source = parseGaussianSplatPly(binaryPly([vertex({ f_rest_4: 1 })]));
  const evaluated = evaluateGaussianPlyShColors(source, new Float32Array([0, 0, 0]));
  assert.deepEqual(Array.from(source.colors), [.5, .5, .5]);
  assert.equal(evaluated[0], .5);
  close(evaluated[1], .5 + .4886025119029199);
  assert.equal(evaluated[2], .5);
  assert.throws(() => evaluateGaussianPlyShColors(source, new Float32Array([0, 0, 2])), /coincides/);
  for (const degree of [2, 3] as const) {
    const decoded = parseGaussianSplatPly(fullShPly(degree));
    assert.equal(decoded.shDegree, degree);
    assert.equal(decoded.shCoefficients.length, 3 * (degree + 1) ** 2);
    assert.equal(decoded.shCoefficients.at(-1), .25);
  }
});

test('trained PLY parser rejects truncated, unsupported and invalid source records before preparation', () => {
  const valid = binaryPly([vertex({})]);
  assert.throws(() => parseGaussianSplatPly(valid.slice(0, valid.byteLength - 1)), /truncated/);
  assert.throws(() => parseGaussianSplatPly(binaryPly([vertex({})], fields.filter(name => name !== 'f_dc_2'))), /missing vertex property: f_dc_2/);
  assert.throws(() => parseGaussianSplatPly(binaryPly([vertex({})], fields, { x: 'double' })), /x must use f32/);
  assert.throws(() => parseGaussianSplatPly(binaryPly([vertex({ rot_0: 0 })])), /rotation must be non-zero/);
  assert.throws(() => parseGaussianSplatPly(new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n').buffer), /binary_little_endian/);
  assert.throws(() => parseGaussianSplatPly(new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nproperty float x\nelement vertex 0\nend_header\n').buffer), /property must follow an element/);
  assert.throws(() => parseGaussianSplatPly(new TextEncoder().encode('ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty list uchar int vertex_indices\nend_header\n').buffer), /list properties/);
  const source = parseGaussianSplatPly(valid);
  const singularAffine = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.throws(() => transformGaussianPlyToCameraSpace(source, singularAffine), /invertible/);
});

test('PLY row decoding preserves unaligned reordered fields across all SH degrees', () => {
  for (const degree of [0, 1, 2, 3] as const) for (const count of [0, 1, 257]) {
    const { buffer } = gaussianPlyFixture(count, degree), before = new Uint8Array(buffer).slice();
    const source = parseGaussianSplatPly(buffer), coefficients = (degree + 1) ** 2;
    assert.equal(source.shDegree, degree);
    assert.equal(source.centers.length, count * 3);
    assert.equal(source.covariances.length, count * 6);
    assert.equal(source.shCoefficients.length, count * coefficients * 3);
    for (let row = 0; row < count; row++) {
      for (let channel = 0; channel < 3; channel++) {
        assert.equal(source.centers[row * 3 + channel], plyValue(['x', 'y', 'z'][channel], row));
        const dc = plyValue(`f_dc_${channel}`, row);
        assert.equal(source.shCoefficients[row * coefficients * 3 + channel], dc);
        assert.equal(source.colors[row * 3 + channel], Math.fround(Math.max(0, dc * .28209479177387814 + .5)));
        for (let basis = 1; basis < coefficients; basis++) {
          assert.equal(source.shCoefficients[(row * coefficients + basis) * 3 + channel],
            plyValue(`f_rest_${channel * (coefficients - 1) + basis - 1}`, row));
        }
      }
      const logit = plyValue('opacity', row), exp = Math.exp(logit);
      assert.equal(source.opacities[row], Math.fround(logit >= 0 ? 1 / (1 + Math.exp(-logit)) : exp / (1 + exp)));
      const covariance = source.covariances.subarray(row * 6, row * 6 + 6);
      for (const [component, axis] of [[0, 0], [3, 1], [5, 2]]) {
        close(covariance[component], Math.exp(2 * plyValue(`scale_${axis}`, row)));
      }
      assert.deepEqual([covariance[1], covariance[2], covariance[4]], [0, 0, 0]);
    }
    assert.deepEqual(new Uint8Array(buffer), before);
  }
});

test('PLY row decoding rejects non-finite fields without retaining scratch values', () => {
  const { buffer, fields, bodyOffset, stride } = gaussianPlyFixture(3, 3), view = new DataView(buffer);
  const reference = parseGaussianSplatPly(buffer);
  for (const { name, offset } of fields) {
    const address = bodyOffset + 2 * stride + offset, value = view.getFloat32(address, true);
    for (const invalid of [NaN, Infinity, -Infinity]) {
      view.setFloat32(address, invalid, true);
      assert.throws(() => parseGaussianSplatPly(buffer), {
        message: `Gaussian PLY ${name} must be finite at vertex 2`,
      });
    }
    view.setFloat32(address, value, true);
  }
  assert.deepEqual(parseGaussianSplatPly(buffer), reference);
  const xOffset = fields.find(field => field.name === 'x')!.offset;
  view.setFloat32(bodyOffset + xOffset, -0, true);
  assert.ok(Object.is(parseGaussianSplatPly(buffer).centers[0], -0));
  new Uint8Array(buffer).fill(0);
  assert.equal(reference.centers[0], -.5);
});

test('PLY covariance decoding keeps chunk boundaries and reports global error indices', () => {
  const count = (1 << 16) + 1, { buffer, fields, stride, bodyOffset } = gaussianPlyFixture(count, 0);
  const source = parseGaussianSplatPly(buffer);
  assert.equal(source.centers.length, count * 3);
  assert.equal(source.covariances.length, count * 6);
  for (const row of [0, count - 2, count - 1]) {
    assert.equal(source.centers[row * 3], plyValue('x', row));
    assert.equal(source.covariances[row * 6], Math.fround(Math.exp(2 * plyValue('scale_0', row))));
  }
  const rotation = fields.find(field => field.name === 'rot_0')!;
  new DataView(buffer).setFloat32(bodyOffset + (count - 1) * stride + rotation.offset, 0, true);
  assert.throws(() => parseGaussianSplatPly(buffer), new RegExp(`rotation must be non-zero at splat ${count - 1}`));
});

test('Three.js model and view matrices compose into the positive-z Gaussian camera convention', () => {
  const model = new THREE.Matrix4().compose(
    new THREE.Vector3(1, -2, -3),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, -.5, .1)),
    new THREE.Vector3(2, 1.5, .75),
  );
  const camera = new THREE.PerspectiveCamera(55, 1.6, .1, 100);
  camera.position.set(4, 3, 7);
  camera.lookAt(1, -2, -3);
  camera.updateMatrixWorld();
  const matrix = composeThreeModelToPositiveZCamera(
    Float32Array.from(model.elements),
    Float32Array.from(camera.matrixWorldInverse.elements),
  );
  const modelCameraPosition = modelCameraPositionFromThreeWorld(
    Float32Array.from(model.elements),
    Float32Array.from(camera.getWorldPosition(new THREE.Vector3()).toArray()),
  );
  const expectedModelCameraPosition = camera.getWorldPosition(new THREE.Vector3()).applyMatrix4(model.clone().invert());
  expectedModelCameraPosition.toArray().forEach((value, index) => close(modelCameraPosition[index], value));
  const expected = new THREE.Matrix4()
    .makeScale(1, 1, -1)
    .multiply(camera.matrixWorldInverse)
    .multiply(model);
  expected.elements.forEach((value, index) => close(matrix[index], value));
  const cameraSource = transformGaussianPlyToCameraSpace({
    centers: new Float32Array([0, 0, 0]),
    covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
    opacities: new Float32Array([.5]),
    colors: new Float32Array([.2, .4, .6]),
    shDegree: 0,
    shCoefficients: new Float32Array([-.3, -.1, .3]),
  }, matrix);
  const expectedCenter = new THREE.Vector3().applyMatrix4(expected);
  [expectedCenter.x, expectedCenter.y, expectedCenter.z].forEach((value, index) => close(cameraSource.centers[index], value));
  assert.ok(cameraSource.centers[2] > 0);
});

test('trained PLY prepares a Three.js camera view without mixing SH and raster coordinate spaces', () => {
  const source = parseGaussianSplatPly(binaryPly([vertex({ f_rest_4: 1 })]));
  const model = new THREE.Matrix4().compose(
    new THREE.Vector3(1, -2, -3),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, -.5, .1)),
    new THREE.Vector3(2, 1.5, .75),
  );
  const camera = new THREE.PerspectiveCamera(55, 1.6, .1, 100);
  camera.position.set(4, 3, 7);
  camera.lookAt(1, -2, -3);
  camera.updateMatrixWorld();
  const modelToWorld = Float32Array.from(model.elements);
  const threeWorldToView = Float32Array.from(camera.matrixWorldInverse.elements);
  const threeCameraWorldPosition = Float32Array.from(camera.getWorldPosition(new THREE.Vector3()).toArray());
  const rasterCamera = { focalX: 256, focalY: 256, principalX: 256, principalY: 160, near: .1, far: 100, width: 512, height: 320 };
  const prepared = prepareGaussianPlyForThreeCamera({
    source, modelToWorld, threeWorldToView, threeCameraWorldPosition,
    cutoff: .1, camera: rasterCamera, tileSize: 32,
  });
  const expectedColors = evaluateGaussianPlyShColors(source, modelCameraPositionFromThreeWorld(modelToWorld, threeCameraWorldPosition));
  const expectedCameraSource = transformGaussianPlyToCameraSpace(source, composeThreeModelToPositiveZCamera(modelToWorld, threeWorldToView));
  const expected = prepareGaussianRaster({ ...expectedCameraSource, colors: expectedColors, cutoff: .1, camera: rasterCamera, tileSize: 32 });
  assert.deepEqual(Array.from(prepared.originalIds), Array.from(expected.originalIds));
  assert.deepEqual(Array.from(prepared.screenCenters), Array.from(expected.screenCenters));
  assert.deepEqual(Array.from(prepared.colors), Array.from(expected.colors));
  assert.deepEqual(Array.from(prepared.depths), Array.from(expected.depths));
  assert.deepEqual(Array.from(prepared.tiles?.packed ?? []), Array.from(expected.tiles?.packed ?? []));
  assert.deepEqual(Array.from(source.colors), [.5, .5, .5]);
  assert.throws(() => prepareGaussianPlyForThreeCamera({
    source, modelToWorld, threeWorldToView, threeCameraWorldPosition: new Float32Array([0, 0]),
    cutoff: .1, camera: rasterCamera,
  }), /three values/);
});
