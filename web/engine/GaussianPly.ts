import {
  gaussian_compose_three_camera,
  gaussian_covariances_from_log_scales_rotations,
  gaussian_model_camera_position,
  gaussian_sh_colors,
  gaussian_transform_camera_space,
} from '../../pkg/three_wasm_rust.js';
import {
  prepareGaussianRaster,
  type GaussianClipPlane,
  type GaussianRasterCamera,
  type PreparedGaussianRaster,
} from './gaussian.ts';

const MAX_HEADER_BYTES = 1 << 20;
const MAX_SPLATS = 1_000_000;
const SH_C0 = 0.28209479177387814;

type PlyScalarType = 'char' | 'int8' | 'uchar' | 'uint8' | 'short' | 'int16' | 'ushort' | 'uint16' | 'int' | 'int32' | 'uint' | 'uint32' | 'float' | 'float32' | 'double' | 'float64';

interface PlyProperty {
  name: string;
  type: PlyScalarType;
  offset: number;
}

interface GaussianPlyHeader {
  bodyOffset: number;
  count: number;
  stride: number;
  properties: Map<string, PlyProperty>;
}

export type GaussianShDegree = 0 | 1 | 2 | 3;

/** Camera-independent source attributes decoded from one trained 3D Gaussian PLY file. */
export interface GaussianPlySource {
  /** Model-space centers; transform them to camera space before raster preparation. */
  centers: Float32Array;
  /** Model-space covariance layout `[xx, xy, xz, yy, yz, zz]`; transform it to camera space before raster preparation. */
  covariances: Float32Array;
  /** Activated alpha values in `[0, 1]`. */
  opacities: Float32Array;
  /** Non-negative, view-independent linear RGB reconstructed from degree-zero SH. */
  colors: Float32Array;
  /** Decoded SH degree. Full trained PLY exports use degrees zero through three. */
  shDegree: GaussianShDegree;
  /** Coefficient-major RGB triples per splat: `[r0, g0, b0, r1, g1, b1, ...]`. */
  shCoefficients: Float32Array;
}

/** Gaussian attributes expressed in the positive-z camera convention used by raster preparation. */
export interface GaussianCameraSource {
  centers: Float32Array;
  covariances: Float32Array;
  opacities: Float32Array;
  colors: Float32Array;
}

/** Inputs needed to prepare one trained PLY view from copied Three.js camera state. */
export interface GaussianPlyThreeCameraOptions {
  source: GaussianPlySource;
  /** Model-to-world matrix in Three.js column-major layout. */
  modelToWorld: Float32Array;
  /** Three.js `camera.matrixWorldInverse` in its native negative-z convention. */
  threeWorldToView: Float32Array;
  /** Three.js world-space camera position. */
  threeCameraWorldPosition: Float32Array;
  cutoff: number;
  camera: GaussianRasterCamera;
  filterVariance?: number;
  clipPlane?: GaussianClipPlane;
  tileSize?: number;
}

const scalarSizes: Readonly<Record<PlyScalarType, number>> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function asciiLine(bytes: Uint8Array, start: number, end: number): string {
  if (end > start && bytes[end - 1] === 13) end--;
  let line = '';
  for (let index = start; index < end; index++) {
    const value = bytes[index];
    if (value < 32 || value > 126) throw new Error('Gaussian PLY header must be ASCII');
    line += String.fromCharCode(value);
  }
  return line;
}

function parseCount(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Gaussian PLY ${label} must be a non-negative integer`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`Gaussian PLY ${label} exceeds the safe integer range`);
  return count;
}

function propertyType(value: string): PlyScalarType {
  if (!(value in scalarSizes)) throw new Error(`Gaussian PLY scalar type is unsupported: ${value}`);
  return value as PlyScalarType;
}

function parseHeader(buffer: ArrayBuffer): GaussianPlyHeader {
  const bytes = new Uint8Array(buffer);
  const properties = new Map<string, PlyProperty>();
  let stride = 0, vertexCount = -1, vertexActive = false, vertexSeen = false, formatSeen = false, elementSeen = false, lineStart = 0, lineNumber = 0;
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  for (let index = 0; index < limit; index++) {
    if (bytes[index] !== 10) continue;
    const line = asciiLine(bytes, lineStart, index);
    lineStart = index + 1;
    if (lineNumber++ === 0) {
      if (line !== 'ply') throw new Error('Gaussian PLY header must start with ply');
      continue;
    }
    if (line === 'end_header') {
      if (!formatSeen || !vertexSeen) throw new Error('Gaussian PLY header must declare binary format and a vertex element');
      return { bodyOffset: lineStart, count: vertexCount, stride, properties };
    }
    if (line === '' || line === 'comment' || line === 'obj_info' || line.startsWith('comment ') || line.startsWith('obj_info ')) continue;
    const tokens = line.split(/ +/);
    if (tokens[0] === 'format') {
      if (formatSeen || tokens.length !== 3 || tokens[1] !== 'binary_little_endian' || tokens[2] !== '1.0') {
        throw new Error('Gaussian PLY must use binary_little_endian 1.0 format');
      }
      formatSeen = true;
      continue;
    }
    if (tokens[0] === 'element') {
      if (tokens.length !== 3) throw new Error('Gaussian PLY element declaration is malformed');
      const count = parseCount(tokens[2], `element count for ${tokens[1]}`);
      elementSeen = true;
      if (tokens[1] === 'vertex') {
        if (vertexSeen || vertexCount !== -1) throw new Error('Gaussian PLY must declare exactly one first vertex element');
        if (count > MAX_SPLATS) throw new Error('Gaussian PLY contains more than 1000000 vertices');
        vertexCount = count;
        vertexSeen = true;
        vertexActive = true;
      } else {
        if (!vertexSeen) throw new Error('Gaussian PLY vertex element must come before other elements');
        vertexActive = false;
      }
      continue;
    }
    if (tokens[0] === 'property') {
      if (!elementSeen) throw new Error('Gaussian PLY property must follow an element declaration');
      if (!vertexActive) continue;
      if (tokens[1] === 'list') throw new Error('Gaussian PLY vertex list properties are unsupported');
      if (tokens.length !== 3) throw new Error('Gaussian PLY vertex property declaration is malformed');
      const type = propertyType(tokens[1]), name = tokens[2];
      if (properties.has(name)) throw new Error(`Gaussian PLY vertex property is duplicated: ${name}`);
      properties.set(name, { name, type, offset: stride });
      stride += scalarSizes[type];
      continue;
    }
    throw new Error(`Gaussian PLY header directive is unsupported: ${tokens[0]}`);
  }
  throw new Error(bytes.length > MAX_HEADER_BYTES ? 'Gaussian PLY header exceeds 1 MiB' : 'Gaussian PLY header is missing end_header');
}

function requiredFloat(header: GaussianPlyHeader, name: string): PlyProperty {
  const property = header.properties.get(name);
  if (!property) throw new Error(`Gaussian PLY is missing vertex property: ${name}`);
  if (property.type !== 'float' && property.type !== 'float32') {
    throw new Error(`Gaussian PLY vertex property ${name} must use f32`);
  }
  return property;
}

function finiteF32(value: number, label: string, index: number): number {
  if (!Number.isFinite(value)) throw new Error(`Gaussian PLY ${label} must be finite at vertex ${index}`);
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new Error(`Gaussian PLY ${label} exceeds f32 range at vertex ${index}`);
  return rounded;
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponent = Math.exp(value);
  return exponent / (1 + exponent);
}

function validateSource({ centers, covariances, opacities, colors, shDegree, shCoefficients }: GaussianPlySource): void {
  if (centers.length % 3 !== 0 || covariances.length !== centers.length * 2
    || opacities.length !== centers.length / 3 || colors.length !== centers.length) {
    throw new Error('Gaussian source attributes have inconsistent lengths');
  }
  if (!Number.isInteger(shDegree) || shDegree < 0 || shDegree > 3
    || shCoefficients.length !== centers.length * (shDegree + 1) ** 2) {
    throw new Error('Gaussian source SH coefficients have inconsistent degree or length');
  }
  for (let index = 0; index < opacities.length; index++) {
    if (!Number.isFinite(opacities[index]) || opacities[index] < 0 || opacities[index] > 1) {
      throw new Error(`Gaussian source opacity is invalid at index ${index}`);
    }
  }
  for (let index = 0; index < colors.length; index++) {
    if (!Number.isFinite(colors[index]) || colors[index] < 0) {
      throw new Error(`Gaussian source color is invalid at component ${index}`);
    }
  }
  for (let index = 0; index < shCoefficients.length; index++) {
    if (!Number.isFinite(shCoefficients[index])) {
      throw new Error(`Gaussian source SH coefficient is invalid at component ${index}`);
    }
  }
}

function shProperties(header: GaussianPlyHeader): { degree: GaussianShDegree; rest: PlyProperty[] } {
  for (let degree = 3; degree >= 1; degree--) {
    const count = 3 * ((degree + 1) ** 2 - 1);
    const names = Array.from({ length: count }, (_, index) => `f_rest_${index}`);
    if (names.every(name => header.properties.has(name))) {
      return { degree: degree as GaussianShDegree, rest: names.map(name => requiredFloat(header, name)) };
    }
  }
  return { degree: 0, rest: [] };
}

/**
 * Decode the binary little-endian PLY layout emitted by the original 3D Gaussian Splatting
 * training code. It activates log scales, opacity and quaternion rotation through the WASM
 * covariance helper. Complete `f_rest_0…N` groups for degrees one through three are
 * retained as coefficient-major RGB triples; incomplete or unknown groups remain ignored.
 * `evaluateGaussianPlyShColors()` evaluates the retained coefficients for a camera position.
 *
 * Call `init()` before this function. The result is model-space source data, not a prepared
 * camera view; callers must transform centers and covariances into camera space first.
 */
export function parseGaussianSplatPly(buffer: ArrayBuffer): GaussianPlySource {
  const header = parseHeader(buffer);
  const required = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    .map(name => requiredFloat(header, name));
  const sh = shProperties(header);
  const requiredBytes = header.bodyOffset + header.count * header.stride;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > buffer.byteLength) throw new Error('Gaussian PLY vertex data is truncated');
  const view = new DataView(buffer);
  const centers = new Float32Array(header.count * 3);
  const logScales = new Float32Array(header.count * 3);
  const rotations = new Float32Array(header.count * 4);
  const opacities = new Float32Array(header.count);
  const colors = new Float32Array(header.count * 3);
  const shCoefficients = new Float32Array(header.count * (sh.degree + 1) ** 2 * 3);
  for (let index = 0; index < header.count; index++) {
    const record = header.bodyOffset + index * header.stride;
    const value = (property: PlyProperty) => finiteF32(view.getFloat32(record + property.offset, true), property.name, index);
    const [x, y, z, red, green, blue, opacity, scaleX, scaleY, scaleZ, rotationW, rotationX, rotationY, rotationZ] = required.map(value);
    centers.set([x, y, z], index * 3);
    logScales.set([scaleX, scaleY, scaleZ], index * 3);
    rotations.set([rotationW, rotationX, rotationY, rotationZ], index * 4);
    opacities[index] = finiteF32(sigmoid(opacity), 'activated opacity', index);
    const coefficientOffset = index * (sh.degree + 1) ** 2 * 3;
    shCoefficients.set([red, green, blue], coefficientOffset);
    for (let restIndex = 0; restIndex < sh.rest.length; restIndex++) {
      shCoefficients[coefficientOffset + 3 + restIndex] = value(sh.rest[restIndex]);
    }
    colors.set([
      finiteF32(Math.max(0, red * SH_C0 + .5), 'degree-zero red', index),
      finiteF32(Math.max(0, green * SH_C0 + .5), 'degree-zero green', index),
      finiteF32(Math.max(0, blue * SH_C0 + .5), 'degree-zero blue', index),
    ], index * 3);
  }
  const covariances = gaussian_covariances_from_log_scales_rotations(logScales, rotations);
  return { centers, covariances, opacities, colors, shDegree: sh.degree, shCoefficients };
}

/**
 * Evaluate the decoded 0–3 degree SH coefficients for a camera position in model space.
 *
 * The returned non-negative linear RGB may be passed to `prepareGaussianRaster()`. It is
 * independent from the model-to-camera transform, so the position must use `source.centers`'
 * original coordinate system rather than the positive-z camera space.
 */
export function evaluateGaussianPlyShColors(source: GaussianPlySource, modelCameraPosition: Float32Array): Float32Array {
  validateSource(source);
  return gaussian_sh_colors(source.centers, source.shCoefficients, source.shDegree, modelCameraPosition);
}

/**
 * Compose a model matrix and a Three.js `camera.matrixWorldInverse` into the positive-z
 * camera convention used by Gaussian raster preparation. All inputs and the result are
 * column-major. This helper has no Three.js dependency so it can be used with copied matrix
 * elements from any compatible caller.
 */
export function composeThreeModelToPositiveZCamera(modelToWorld: Float32Array, threeWorldToView: Float32Array): Float32Array {
  return gaussian_compose_three_camera(modelToWorld, threeWorldToView);
}

/**
 * Convert a Three.js-compatible world-space camera position into PLY model space.
 *
 * Pass the returned position to `evaluateGaussianPlyShColors()` before transforming the
 * source to camera space. Inputs are copied matrix elements and position values, so this
 * helper does not import or retain Three.js objects.
 */
export function modelCameraPositionFromThreeWorld(modelToWorld: Float32Array, threeCameraWorldPosition: Float32Array): Float32Array {
  return gaussian_model_camera_position(modelToWorld, threeCameraWorldPosition);
}

/**
 * Transform a decoded model-space PLY source into the positive-z camera convention used by
 * `prepareGaussianRaster()`. `worldToCamera` is column-major and must be affine; its linear
 * part transforms covariance as `R × Σ × Rᵀ`. Use `composeThreeModelToPositiveZCamera()` for
 * a standard Three.js negative-z view matrix.
 */
export function transformGaussianPlyToCameraSpace(source: GaussianPlySource, worldToCamera: Float32Array): GaussianCameraSource {
  validateSource(source);
  const packed = gaussian_transform_camera_space(source.centers, source.covariances, worldToCamera);
  const count = source.centers.length / 3;
  if (packed.length !== count * 9) throw new Error('Gaussian camera-space transform returned an invalid record count');
  const centers = new Float32Array(count * 3), covariances = new Float32Array(count * 6);
  for (let index = 0; index < count; index++) {
    const sourceOffset = index * 9;
    centers.set(packed.subarray(sourceOffset, sourceOffset + 3), index * 3);
    covariances.set(packed.subarray(sourceOffset + 3, sourceOffset + 9), index * 6);
  }
  return { centers, covariances, opacities: source.opacities.slice(), colors: source.colors.slice() };
}

/**
 * Prepare one trained PLY view from copied Three.js model and camera state.
 *
 * SH colors are evaluated with the camera position transformed back into model space, while
 * centers and covariances use the matching positive-z camera transform. The returned compact
 * raster view is independent from the source and all input matrix/position arrays.
 */
export function prepareGaussianPlyForThreeCamera({
  source,
  modelToWorld,
  threeWorldToView,
  threeCameraWorldPosition,
  cutoff,
  camera,
  filterVariance,
  clipPlane,
  tileSize,
}: GaussianPlyThreeCameraOptions): PreparedGaussianRaster {
  const modelCameraPosition = modelCameraPositionFromThreeWorld(modelToWorld, threeCameraWorldPosition);
  const colors = evaluateGaussianPlyShColors(source, modelCameraPosition);
  const worldToCamera = composeThreeModelToPositiveZCamera(modelToWorld, threeWorldToView);
  const cameraSource = transformGaussianPlyToCameraSpace(source, worldToCamera);
  return prepareGaussianRaster({ ...cameraSource, colors, cutoff, camera, filterVariance, clipPlane, tileSize });
}
