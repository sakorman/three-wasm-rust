interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Asynchronous timer queries. Never gl.finish() or wait on an unavailable result. */
export class GpuTimer {
  private readonly extension: TimerExtension | null;
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  readonly samples: number[] = [];
  disjoint = false;
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }
  get supported() {
    return this.extension !== null;
  }
  begin() {
    if (!this.extension || this.disjoint || this.pending.length >= 8) return;
    this.active = this.gl.createQuery();
    if (this.active) this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, this.active);
  }
  end() {
    if (this.active && this.extension) {
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
  }
  poll() {
    if (!this.extension) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      this.disjoint = true;
      this.samples.length = 0;
      for (const q of this.pending) this.gl.deleteQuery(q);
      this.pending = [];
      return;
    }
    while (
      this.pending.length &&
      this.gl.getQueryParameter(this.pending[0], this.gl.QUERY_RESULT_AVAILABLE)
    ) {
      const q = this.pending.shift()!;
      const nanos: unknown = this.gl.getQueryParameter(q, this.gl.QUERY_RESULT);
      if (typeof nanos === 'number' && Number.isFinite(nanos)) this.samples.push(nanos / 1e6);
      this.gl.deleteQuery(q);
    }
  }
  dispose() {
    this.end();
    for (const q of this.pending) this.gl.deleteQuery(q);
    this.pending = [];
  }
}
