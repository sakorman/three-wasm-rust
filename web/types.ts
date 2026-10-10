/** Position xyz, quaternion xyzw and scale xyz: 10 floats per node. */
export interface SceneData {
  parents: Int32Array;
  transforms: Float32Array;
  colors: Float32Array;
}

export type RenderMode = 'rust' | 'hybrid' | 'javascript';

export interface TimingStats {
  medianMs: number;
  minMs: number;
  maxMs: number;
  samplesMs: number[];
}

export interface BenchmarkRow {
  name: string;
  unit: string;
  javascript: TimingStats;
  wasm: TimingStats;
  /** Null when either measurement is below the timer's resolution. */
  ratio: number | null;
  iterations: number;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  createdAt: string;
  count: number;
  seed: number;
  userAgent: string;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  threeRevision: string;
  notes: string;
  rows: BenchmarkRow[];
  checksum: number;
}
