import { GAUSSIAN_RASTER_UPLOAD_STRIDE } from './gaussian.ts';
import { GaussianUploadBuffers } from './GaussianUploadBuffers.ts';
import type { PackedGaussianRasterUpload } from './gaussian.ts';
import type { GaussianUploadBufferSnapshot, GaussianUploadResourceStats } from './GaussianUploadBuffers.ts';
import type { ContextLifecycle } from './ContextLifecycle.ts';

export interface GaussianRasterDrawOptions {
  width: number;
  height: number;
  cutoff: number;
  /** Applies the optional per-record half-space CDF coefficients. Defaults to true. */
  applyClip?: boolean;
}

const vertexSource = `#version 300 es
precision highp float;
layout(location=0) in vec2 center;
layout(location=1) in vec2 extent;
layout(location=2) in vec3 conic;
layout(location=3) in float opacity;
layout(location=4) in vec3 clip;
layout(location=5) in float clipEnabled;
layout(location=6) in vec3 color;
uniform vec2 viewport;
out vec2 vCenter;
out vec3 vConic;
out float vOpacity;
out vec3 vClip;
out float vClipEnabled;
out vec3 vColor;
const vec2 corners[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0)
);
void main() {
  vec2 pixel = center + extent * corners[gl_VertexID];
  gl_Position = vec4(pixel / viewport * 2.0 - 1.0, 0.0, 1.0);
  vCenter = center;
  vConic = conic;
  vOpacity = opacity;
  vClip = clip;
  vClipEnabled = clipEnabled;
  vColor = color;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec2 vCenter;
in vec3 vConic;
in float vOpacity;
in vec3 vClip;
in float vClipEnabled;
in vec3 vColor;
uniform float cutoff;
uniform bool applyClip;
out vec4 outputColor;
float normalCdf(float value) {
  float t = 1.0 / (1.0 + 0.2316419 * abs(value));
  float tail = 0.39894228 * exp(-0.5 * value * value) * t *
    (((((1.33027443 * t - 1.82125598) * t) + 1.78147794) * t - 0.35656378) * t + 0.31938153);
  return value >= 0.0 ? 1.0 - tail : tail;
}
void main() {
  vec2 delta = gl_FragCoord.xy - vCenter;
  float quadratic = vConic.x * delta.x * delta.x + 2.0 * vConic.y * delta.x * delta.y + vConic.z * delta.y * delta.y;
  float clipFactor = applyClip && vClipEnabled > 0.5 ? normalCdf(dot(vClip.xy, -delta) + vClip.z) : 1.0;
  float alpha = vOpacity * exp(-0.5 * quadratic) * clipFactor;
  if (alpha < cutoff) discard;
  outputColor = vec4(vColor * alpha, alpha);
}`;

interface ProgramState {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  viewport: WebGLUniformLocation;
  cutoff: WebGLUniformLocation;
  applyClip: WebGLUniformLocation;
}

function assertDrawOptions({ width, height, cutoff }: GaussianRasterDrawOptions): void {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('Gaussian raster viewport must use positive safe integers');
  }
  if (!Number.isFinite(cutoff) || cutoff < 0 || cutoff > 1) throw new Error('Gaussian raster cutoff must be within [0, 1]');
}

/**
 * Draws packed Gaussian records through an independent WebGL2 point-splat pass.
 *
 * This renderer uses the same compact order as `prepareGaussianRaster()`: callers retain
 * responsibility for camera preparation, tile dispatch, SH evaluation and targets.
 */
export class GaussianRasterRenderer {
  readonly uploads: GaussianUploadBuffers;
  private state: ProgramState | undefined;
  private currentError: unknown;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly context: ContextLifecycle,
  ) {
    if (context.gl !== gl) throw new Error('Gaussian raster renderer requires the lifecycle WebGL context');
    this.uploads = new GaussianUploadBuffers(gl, context);
    this.unsubscribe = context.subscribe(() => this.onContextStateChange());
    try {
      this.createState();
    } catch (error) {
      this.unsubscribe();
      this.uploads.dispose();
      throw error;
    }
  }

  get error(): unknown {
    return this.currentError ?? this.uploads.error;
  }

  get ready(): boolean {
    return this.context.ready && !this.error && this.state !== undefined;
  }

  update(upload: PackedGaussianRasterUpload): void {
    if (this.disposed) throw new Error('Gaussian raster renderer is disposed');
    this.uploads.update(upload);
  }

  /** Release the active Gaussian view while retaining the renderer program and VAO for reuse. */
  clear(): void {
    if (this.disposed) throw new Error('Gaussian raster renderer is disposed');
    this.uploads.clear();
  }

  snapshot(): GaussianUploadBufferSnapshot | undefined {
    return this.uploads.snapshot();
  }

  /** Resource snapshot for the copied upload data and reusable VBOs behind this renderer. */
  resourceStats(): GaussianUploadResourceStats {
    return this.uploads.resourceStats();
  }

  draw(options: GaussianRasterDrawOptions): void {
    this.withDraw(options, (upload) => {
      this.bindAttributes(0);
      this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, upload.recordCount);
    });
  }

  /** Draw tile-local records with scissor rectangles. Returns submitted references, not draw-call count. */
  drawTiles(options: GaussianRasterDrawOptions): number {
    assertDrawOptions(options);
    const tiles = this.uploads.tileLayout();
    if (!tiles) throw new Error('Gaussian raster tile data is unavailable');
    if (tiles.columns !== Math.ceil(options.width / tiles.tileSize) || tiles.rows !== Math.ceil(options.height / tiles.tileSize)) {
      throw new Error('Gaussian raster tile grid does not match the draw viewport');
    }
    return this.withDraw(options, () => {
      this.gl.enable(this.gl.SCISSOR_TEST);
      let references = 0;
      this.uploads.forEachTileBatch((column, row, tileSize, firstLocalId, count) => {
        const x = column * tileSize, y = row * tileSize;
        this.gl.scissor(x, y, Math.min(tileSize, options.width - x), Math.min(tileSize, options.height - y));
        this.bindAttributes(firstLocalId);
        this.gl.drawArraysInstanced(this.gl.TRIANGLES, 0, 6, count);
        references += count;
      });
      return references;
    });
  }

  private withDraw<T>(options: GaussianRasterDrawOptions, draw: (upload: GaussianUploadBufferSnapshot) => T): T {
    if (this.disposed) throw new Error('Gaussian raster renderer is disposed');
    assertDrawOptions(options);
    this.context.assertReady();
    if (this.error) throw this.error;
    const state = this.state, upload = this.uploads.snapshot();
    if (!state || !upload) throw new Error('Gaussian raster GPU resources are unavailable');
    const previousProgram = this.gl.getParameter(this.gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const previousVao = this.gl.getParameter(this.gl.VERTEX_ARRAY_BINDING) as WebGLVertexArrayObject | null;
    const previousArrayBuffer = this.gl.getParameter(this.gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
    const previousViewport = this.gl.getParameter(this.gl.VIEWPORT) as Int32Array;
    const blend = this.gl.isEnabled(this.gl.BLEND);
    const equationRgb = this.gl.getParameter(this.gl.BLEND_EQUATION_RGB) as number;
    const equationAlpha = this.gl.getParameter(this.gl.BLEND_EQUATION_ALPHA) as number;
    const sourceRgb = this.gl.getParameter(this.gl.BLEND_SRC_RGB) as number;
    const destinationRgb = this.gl.getParameter(this.gl.BLEND_DST_RGB) as number;
    const sourceAlpha = this.gl.getParameter(this.gl.BLEND_SRC_ALPHA) as number;
    const destinationAlpha = this.gl.getParameter(this.gl.BLEND_DST_ALPHA) as number;
    const scissor = this.gl.isEnabled(this.gl.SCISSOR_TEST);
    const previousScissor = this.gl.getParameter(this.gl.SCISSOR_BOX) as Int32Array;
    try {
      this.gl.useProgram(state.program);
      this.gl.bindVertexArray(state.vao);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, upload.splatBuffer);
      this.gl.enable(this.gl.BLEND);
      this.gl.blendEquation(this.gl.FUNC_ADD);
      this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
      this.gl.viewport(0, 0, options.width, options.height);
      this.gl.uniform2f(state.viewport, options.width, options.height);
      this.gl.uniform1f(state.cutoff, options.cutoff);
      this.gl.uniform1i(state.applyClip, options.applyClip === false ? 0 : 1);
      return draw(upload);
    } finally {
      this.gl.useProgram(previousProgram);
      this.gl.bindVertexArray(previousVao);
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, previousArrayBuffer);
      this.gl.viewport(previousViewport[0], previousViewport[1], previousViewport[2], previousViewport[3]);
      if (blend) this.gl.enable(this.gl.BLEND);
      else this.gl.disable(this.gl.BLEND);
      this.gl.blendEquationSeparate(equationRgb, equationAlpha);
      this.gl.blendFuncSeparate(sourceRgb, destinationRgb, sourceAlpha, destinationAlpha);
      if (scissor) this.gl.enable(this.gl.SCISSOR_TEST);
      else this.gl.disable(this.gl.SCISSOR_TEST);
      this.gl.scissor(previousScissor[0], previousScissor[1], previousScissor[2], previousScissor[3]);
    }
  }

  private bindAttributes(record: number): void {
    const stride = GAUSSIAN_RASTER_UPLOAD_STRIDE * Float32Array.BYTES_PER_ELEMENT;
    const attribute = (location: number, size: number, offset: number) => {
      this.gl.enableVertexAttribArray(location);
      this.gl.vertexAttribPointer(location, size, this.gl.FLOAT, false, stride,
        (record * GAUSSIAN_RASTER_UPLOAD_STRIDE + offset) * Float32Array.BYTES_PER_ELEMENT);
      this.gl.vertexAttribDivisor(location, 1);
    };
    attribute(0, 2, 0);
    attribute(1, 2, 2);
    attribute(2, 3, 4);
    attribute(3, 1, 7);
    attribute(4, 3, 8);
    attribute(5, 1, 11);
    attribute(6, 3, 12);
  }

  private readonly onContextStateChange = (): void => {
    if (this.disposed || !this.context.ready) {
      this.releaseState();
      return;
    }
    try {
      this.createState();
      this.currentError = undefined;
    } catch (error) {
      this.currentError = error;
      this.releaseState();
    }
  };

  private createState(): void {
    if (this.state) return;
    this.context.assertReady();
    const program = this.createProgram();
    const vao = this.gl.createVertexArray();
    if (!vao) {
      this.gl.deleteProgram(program);
      throw new Error('Gaussian raster VAO allocation failed');
    }
    const viewport = this.gl.getUniformLocation(program, 'viewport');
    const cutoff = this.gl.getUniformLocation(program, 'cutoff');
    const applyClip = this.gl.getUniformLocation(program, 'applyClip');
    if (!viewport || !cutoff || !applyClip) {
      this.gl.deleteVertexArray(vao);
      this.gl.deleteProgram(program);
      throw new Error('Gaussian raster shader uniform is unavailable');
    }
    this.state = { program, vao, viewport, cutoff, applyClip };
  }

  private createProgram(): WebGLProgram {
    const vertex = this.compile(this.gl.VERTEX_SHADER, vertexSource);
    const fragment = this.compile(this.gl.FRAGMENT_SHADER, fragmentSource);
    const program = this.gl.createProgram();
    if (!program) {
      this.gl.deleteShader(vertex);
      this.gl.deleteShader(fragment);
      throw new Error('Gaussian raster program allocation failed');
    }
    this.gl.attachShader(program, vertex);
    this.gl.attachShader(program, fragment);
    this.gl.linkProgram(program);
    this.gl.deleteShader(vertex);
    this.gl.deleteShader(fragment);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const log = this.gl.getProgramInfoLog(program) ?? 'Gaussian raster program link failed';
      this.gl.deleteProgram(program);
      throw new Error(log);
    }
    return program;
  }

  private compile(type: number, source: string): WebGLShader {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error('Gaussian raster shader allocation failed');
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const log = this.gl.getShaderInfoLog(shader) ?? 'Gaussian raster shader compile failed';
      this.gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  private releaseState(): void {
    if (!this.state) return;
    if (!this.gl.isContextLost()) {
      this.gl.deleteVertexArray(this.state.vao);
      this.gl.deleteProgram(this.state.program);
    }
    this.state = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.releaseState();
    this.uploads.dispose();
    this.currentError = undefined;
  }
}
