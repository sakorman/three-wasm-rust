import type { GeometryData } from './types.ts';

function outwardRadius(value: number): number {
  const rounded = new Float32Array([value]);
  if (rounded[0] < value) new Uint32Array(rounded.buffer)[0]++;
  if (!Number.isFinite(rounded[0])) throw new Error('Bounding radius exceeds f32 range');
  return rounded[0];
}

/** AABB-centered sphere, rounded outward after the center is stored as f32. */
export function geometryBounds(positions: Float32Array): { center: Float32Array; radius: number } {
  if (!positions.length || positions.length % 3 !== 0) throw new Error('Invalid vertex positions');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const value = positions[i], axis = i % 3;
    if (!Number.isFinite(value)) throw new Error('Invalid vertex positions');
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  }
  const center = Float32Array.from(min, (value, axis) => (value + max[axis]) * 0.5);
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3)
    radius = Math.max(radius, Math.hypot(positions[i] - center[0], positions[i + 1] - center[1], positions[i + 2] - center[2]));
  return { center, radius: outwardRadius(radius) };
}

function geometry(name: string, vertices: number[], faces: number[]): GeometryData {
  const positions = Float32Array.from(vertices);
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3)
    radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]));
  return { name, positions, indices: Uint32Array.from(faces), radius: outwardRadius(radius) };
}

export function box(): GeometryData {
  return geometry(
    'box',
    [
      -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    ],
    [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0,
      4, 7, 0, 7, 3,
    ],
  );
}

export function cylinder(segments = 12): GeometryData {
  const v: number[] = [],
    f: number[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (i * Math.PI * 2) / segments,
      x = Math.cos(angle) * 0.5,
      z = Math.sin(angle) * 0.5;
    v.push(x, -0.5, z, x, 0.5, z);
  }
  const bottom = v.length / 3;
  v.push(0, -0.5, 0);
  const top = v.length / 3;
  v.push(0, 0.5, 0);
  for (let i = 0; i < segments; i++) {
    const a = i * 2,
      b = ((i + 1) % segments) * 2;
    f.push(a, a + 1, b + 1, a, b + 1, b, bottom, a, b, top, b + 1, a + 1);
  }
  return geometry('cylinder', v, f);
}

export function sphere(segments = 12, rings = 8): GeometryData {
  const v: number[] = [],
    f: number[] = [];
  for (let y = 0; y <= rings; y++)
    for (let x = 0; x <= segments; x++) {
      const theta = (Math.PI * y) / rings,
        phi = (Math.PI * 2 * x) / segments;
      v.push(
        0.5 * Math.sin(theta) * Math.cos(phi),
        0.5 * Math.cos(theta),
        0.5 * Math.sin(theta) * Math.sin(phi),
      );
    }
  for (let y = 0; y < rings; y++)
    for (let x = 0; x < segments; x++) {
      const a = y * (segments + 1) + x,
        b = a + segments + 1;
      if (y > 0) f.push(a, a + 1, b);
      if (y < rings - 1) f.push(a + 1, b + 1, b);
    }
  return geometry('sphere', v, f);
}
