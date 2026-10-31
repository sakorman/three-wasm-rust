interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export interface GpuDiagnostics {
  allocationFailures: number;
  queueLimitSkips: number;
  invalidResults: number;
  queryConflicts: number;
  pendingQueries: number;
}

/** Asynchronous timer queries. Never gl.finish() or wait on an unavailable result. */
export class GpuTimer {
  private readonly extension: TimerExtension | null;
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  private disposed = false;
  private allocationFailures = 0;
  private queueLimitSkips = 0;
  private invalidResults = 0;
  private queryConflicts = 0;
  readonly samples: number[] = [];
  disjoint = false;
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    gl.canvas.addEventListener('webglcontextlost', this.onLost);
  }
  get supported() {
    return this.extension !== null;
  }
  /** Snapshot before disposal; reading diagnostics never queries or stalls the GPU. */
  get diagnostics(): GpuDiagnostics {
    return {
      allocationFailures: this.allocationFailures,
      queueLimitSkips: this.queueLimitSkips,
      invalidResults: this.invalidResults,
      queryConflicts: this.queryConflicts,
      pendingQueries: this.pending.length + (this.active ? 1 : 0),
    };
  }
  begin() {
    if (this.disposed || this.active || this.disjoint) return;
    if (this.gl.isContextLost()) {
      this.onLost();
      return;
    }
    if (!this.extension) return;
    if (this.gl.getQuery(this.extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== null) {
      this.queryConflicts++;
      return;
    }
    if (this.pending.length >= 8) {
      this.queueLimitSkips++;
      return;
    }
    this.active = this.gl.createQuery();
    if (this.active) this.gl.beginQuery(this.extension.TIME_ELAPSED_EXT, this.active);
    else this.allocationFailures++;
  }
  end() {
    if (this.disposed) return;
    if (this.gl.isContextLost()) {
      this.onLost();
      return;
    }
    if (this.active && this.extension) {
      // Another owner may have ended our interval and started its own query.
      if (this.gl.getQuery(this.extension.TIME_ELAPSED_EXT, this.gl.CURRENT_QUERY) !== this.active) {
        this.queryConflicts++;
        this.gl.deleteQuery(this.active);
        this.active = null;
        return;
      }
      this.gl.endQuery(this.extension.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
  }
  poll() {
    if (this.disposed || this.disjoint) return;
    if (this.gl.isContextLost()) {
      this.onLost();
      return;
    }
    if (!this.extension) return;
    if (this.gl.getParameter(this.extension.GPU_DISJOINT_EXT)) {
      this.disjoint = true;
      this.samples.length = 0;
      this.end();
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
      if (typeof nanos === 'number' && Number.isFinite(nanos) && nanos >= 0)
        this.samples.push(nanos / 1e6);
      else this.invalidResults++;
      this.gl.deleteQuery(q);
    }
  }
  dispose() {
    if (this.disposed) return;
    this.end();
    this.disposed = true;
    for (const q of this.pending) this.gl.deleteQuery(q);
    this.pending = [];
    this.gl.canvas.removeEventListener('webglcontextlost', this.onLost);
  }

  private readonly onLost = () => {
    // Queries from a lost context cannot be read or deleted in a restored namespace.
    this.disjoint = true;
    this.samples.length = 0;
    this.active = null;
    this.pending = [];
  };
}
