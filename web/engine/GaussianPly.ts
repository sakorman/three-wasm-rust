import { gaussian_covariances_from_log_scales_rotations } from '../../pkg/three_wasm_rust.js';

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

/**
 * Decode the binary little-endian PLY layout emitted by the original 3D Gaussian Splatting
 * training code. It activates log scales, opacity and quaternion rotation through the WASM
 * covariance helper, then reconstructs only degree-zero SH color. Higher SH terms stay
 * unconsumed until view-dependent shading is available.
 *
 * Call `init()` before this function. The result is model-space source data, not a prepared
 * camera view; callers must transform centers and covariances into camera space first.
 */
export function parseGaussianSplatPly(buffer: ArrayBuffer): GaussianPlySource {
  const header = parseHeader(buffer);
  const required = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
    .map(name => requiredFloat(header, name));
  const requiredBytes = header.bodyOffset + header.count * header.stride;
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes > buffer.byteLength) throw new Error('Gaussian PLY vertex data is truncated');
  const view = new DataView(buffer);
  const centers = new Float32Array(header.count * 3);
  const logScales = new Float32Array(header.count * 3);
  const rotations = new Float32Array(header.count * 4);
  const opacities = new Float32Array(header.count);
  const colors = new Float32Array(header.count * 3);
  for (let index = 0; index < header.count; index++) {
    const record = header.bodyOffset + index * header.stride;
    const value = (property: PlyProperty) => finiteF32(view.getFloat32(record + property.offset, true), property.name, index);
    const [x, y, z, red, green, blue, opacity, scaleX, scaleY, scaleZ, rotationW, rotationX, rotationY, rotationZ] = required.map(value);
    centers.set([x, y, z], index * 3);
    logScales.set([scaleX, scaleY, scaleZ], index * 3);
    rotations.set([rotationW, rotationX, rotationY, rotationZ], index * 4);
    opacities[index] = finiteF32(sigmoid(opacity), 'activated opacity', index);
    colors.set([
      finiteF32(Math.max(0, red * SH_C0 + .5), 'degree-zero red', index),
      finiteF32(Math.max(0, green * SH_C0 + .5), 'degree-zero green', index),
      finiteF32(Math.max(0, blue * SH_C0 + .5), 'degree-zero blue', index),
    ], index * 3);
  }
  const covariances = gaussian_covariances_from_log_scales_rotations(logScales, rotations);
  return { centers, covariances, opacities, colors };
}
