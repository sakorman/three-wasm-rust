export interface GaussianCase {
  covariance: number[];
  opacity: number[];
  centers: number[];
  cutoff: number;
}

export function gaussianCase(boundary: boolean): GaussianCase {
  const cutoff = Math.fround(1 / 255);
  if (boundary) return {
    covariance: [1, 0, 1, 16, 3, 9, 4, -1, 2, 1, 0, 1],
    opacity: [cutoff, cutoff, Math.fround(cutoff * 0.99), Math.fround(cutoff * 1.01)],
    centers: [32.5, 32.5, 64.5, 64.5, 96.5, 96.5, 128.5, 128.5], cutoff,
  };
  const covariance: number[] = [], opacity: number[] = [], centers: number[] = [];
  for (let i = 0; i < 28; i++) {
    const xx = 9 + i % 3 * 7, yy = 4 + i % 4 * 3;
    covariance.push(xx, Math.fround((i % 2 ? 0.65 : -0.5) * Math.sqrt(xx * yy)), yy);
    opacity.push(Math.fround([1, 0.2, 0.05, 0.01, 0.001, 0][i % 6]));
    centers.push(i < 24 ? 22 + i % 6 * 34 : 115 + (i - 24) * 3, i < 24 ? 24 + Math.floor(i / 6) * 40 : 91 + (i - 24) * 2);
  }
  return { covariance, opacity, centers, cutoff };
}

/** Raster fixture uses the same Gaussian equation and draw order for both quad sizes. */
export function compareGaussianQuads(data: GaussianCase & { fixed: number[]; adaptive: number[]; activeIndices?: number[]; referenceIndices?: number[]; packedExtents?: number[] }) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 192;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: true });
  if (!gl) throw new Error('No WebGL2');
  const shader = (type: number, source: string) => {
    const value = gl.createShader(type); if (!value) throw new Error('No shader');
    gl.shaderSource(value, source); gl.compileShader(value);
    if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(value) ?? 'Compile failure');
    return value;
  };
  const vertex = shader(gl.VERTEX_SHADER, `#version 300 es
precision highp float;
precision highp int;
uniform vec2 center, extent;
uniform uint packedExtent;
uniform bool usePackedExtent;
const vec2 corners[6] = vec2[6](vec2(-1,-1), vec2(1,-1), vec2(1,1), vec2(-1,-1), vec2(1,1), vec2(-1,1));
void main() { vec2 halfSize = usePackedExtent ? unpackHalf2x16(packedExtent) : extent;
  vec2 pixel = center + halfSize * corners[gl_VertexID]; gl_Position = vec4(pixel / vec2(128,96) - 1.0, 0, 1); }`);
  const fragment = shader(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;
uniform vec2 center;
uniform vec3 conic, color;
uniform float opacity, cutoff;
out vec4 outputColor;
void main() { vec2 d = gl_FragCoord.xy - center; float q = conic.x*d.x*d.x + 2.0*conic.y*d.x*d.y + conic.z*d.y*d.y;
  float alpha = opacity * exp(-0.5*q); if (alpha < cutoff) discard; outputColor = vec4(color * alpha, alpha); }`);
  const program = gl.createProgram(); if (!program) throw new Error('No program');
  gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  gl.deleteShader(vertex); gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'Link failure');
  const location = (name: string) => { const value = gl.getUniformLocation(program, name); if (!value) throw new Error(name); return value; };
  const center = location('center'), extent = location('extent'), conic = location('conic');
  const opacity = location('opacity'), cutoff = location('cutoff'), color = location('color');
  const packedExtent = location('packedExtent'), usePackedExtent = location('usePackedExtent');
  gl.useProgram(program); gl.viewport(0, 0, 256, 192); gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.uniform1f(cutoff, data.cutoff);
  const allIndices = Array.from(data.opacity.keys());
  const halfValue = (bits: number) => {
    const exponent = bits >>> 10, fraction = bits & 1023;
    return exponent ? 2 ** (exponent - 15) * (1 + fraction / 1024) : 2 ** -24 * fraction;
  };
  const draw = (bounds: number[], indices = allIndices, packed?: number[]) => {
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(usePackedExtent, packed ? 1 : 0);
    let area = 0, draws = 0;
    for (const i of indices) {
      const x = bounds[i * 2], y = bounds[i * 2 + 1];
      if (x === 0 || y === 0) continue;
      const [xx, xy, yy] = data.covariance.slice(i * 3, i * 3 + 3), det = xx * yy - xy * xy;
      gl.uniform2f(center, data.centers[i * 2], data.centers[i * 2 + 1]); gl.uniform2f(extent, x, y);
      if (packed) gl.uniform1ui(packedExtent, packed[i]);
      gl.uniform3f(conic, yy / det, -xy / det, xx / det); gl.uniform1f(opacity, data.opacity[i]);
      gl.uniform3f(color, 1, i % 2 ? 0.25 : 0.75, i % 3 ? 0.6 : 0.2);
      gl.drawArrays(gl.TRIANGLES, 0, 6); draws++;
      area += packed ? 4 * halfValue(packed[i] & 0xffff) * halfValue(packed[i] >>> 16) : 4 * x * y;
    }
    const pixels = new Uint8Array(256 * 192 * 4); gl.readPixels(0, 0, 256, 192, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (gl.getError()) throw new Error('WebGL error');
    return { pixels, area, draws, visited: indices.length };
  };
  try {
    const fixed = draw(data.fixed), denseAdaptive = draw(data.adaptive, data.referenceIndices), adaptive = draw(data.adaptive, data.activeIndices, data.packedExtents);
    let differentChannels = 0, compactionDifferentChannels = 0, visiblePixels = 0;
    for (let i = 0; i < fixed.pixels.length; i++) if (fixed.pixels[i] !== adaptive.pixels[i]) differentChannels++;
    for (let i = 0; i < denseAdaptive.pixels.length; i++) if (denseAdaptive.pixels[i] !== adaptive.pixels[i]) compactionDifferentChannels++;
    for (let i = 3; i < adaptive.pixels.length; i += 4) if (adaptive.pixels[i]) visiblePixels++;
    return { differentChannels, visiblePixels, fixedArea: fixed.area, adaptiveArea: adaptive.area,
      areaReduction: 1 - adaptive.area / fixed.area, fixedDraws: fixed.draws, adaptiveDraws: adaptive.draws,
      denseVisited: denseAdaptive.visited, compactedVisited: adaptive.visited, compactionDifferentChannels,
      fixedCenter: Array.from(fixed.pixels.slice((96 * 256 + 128) * 4, (96 * 256 + 128) * 4 + 4)),
      actualCenter: Array.from(adaptive.pixels.slice((96 * 256 + 128) * 4, (96 * 256 + 128) * 4 + 4)),
      equalCutoffAlpha: adaptive.pixels[(32 * 256 + 32) * 4 + 3] };
  } finally { gl.deleteProgram(program); }
}
