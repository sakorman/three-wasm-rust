export type ContextState = 'ready' | 'lost' | 'failed' | 'disposed';

/** Keep GPU lifetime separate from scene data. Restoring a context invalidates every GL handle. */
export class ContextLifecycle {
  private currentState: ContextState = 'ready';
  private currentGeneration = 0;
  private currentError: unknown;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly gl: WebGL2RenderingContext,
    private readonly rebuild: () => void = () => {},
    private readonly releaseLostResources: () => void = () => {},
  ) {
    gl.canvas.addEventListener('webglcontextlost', this.onLost);
    gl.canvas.addEventListener('webglcontextrestored', this.onRestored);
    if (gl.isContextLost()) this.lose();
  }

  get ready() {
    return this.state === 'ready' && !this.gl.isContextLost();
  }
  get state() {
    return this.currentState;
  }
  get generation() {
    return this.currentGeneration;
  }
  get error() {
    return this.currentError;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  assertReady() {
    if (this.gl.isContextLost()) this.lose();
    if (!this.ready) throw new Error(`WebGL context is ${this.state}`);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private lose() {
    // A failed rebuild can be retried when the browser supplies another context.
    if (this.state !== 'ready' && this.state !== 'failed') return;
    this.currentState = 'lost';
    this.currentGeneration++;
    // Drop the old handles while GL calls are ignored, before restoration creates a new namespace.
    try {
      this.releaseLostResources();
    } catch (error) {
      this.currentError = error;
    }
    this.notify();
  }

  private readonly onLost = (event: Event) => {
    event.preventDefault();
    this.lose();
  };

  private readonly onRestored = () => {
    if (this.state !== 'lost' || this.gl.isContextLost()) return;
    try {
      this.rebuild();
      this.currentError = undefined;
      this.currentState = 'ready';
    } catch (error) {
      this.currentError = error;
      this.currentState = 'failed';
    }
    this.notify();
  };

  dispose() {
    if (this.state === 'disposed') return;
    this.gl.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.gl.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.currentState = 'disposed';
    this.listeners.clear();
  }
}
