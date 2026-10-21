export type Backend = 'rust' | 'rust-direct' | 'three' | 'instanced';
export type Comparison = 'direct' | 'instanced';
export type Scenario = 'city' | 'warehouse' | 'hierarchy';
export interface GeometryData {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  radius: number;
}
export interface MaterialData {
  name: string;
  color: [number, number, number];
  unlit: boolean;
}
export interface EngineScene {
  name: string;
  scenario: Scenario;
  seed: number;
  parents: Int32Array;
  transforms: Float32Array;
  meshNodes: Uint32Array;
  groups: Uint32Array;
  radii: Float32Array;
  /** Local sphere centers in meshNodes order (xyz); omitted centers are at the origin. */
  centers?: Float32Array;
  batchGeometries: Uint32Array;
  batchMaterials: Uint32Array;
  animatedNodes: Uint32Array;
  geometries: GeometryData[];
  materials: MaterialData[];
  extent: number;
}
export interface CameraFrame {
  projection: Float32Array;
  view: Float32Array;
  viewProjection: Float32Array;
}
export interface FrameStats {
  updateMs: number;
  prepareMs: number;
  submitMs: number;
  cpuMs: number;
  visible: number;
  draws: number;
  triangles: number;
  updated: number | null;
}
/** Renderer-owned GPU allocations; excludes CPU/WASM data and driver overhead. */
export interface GpuResourceStats {
  ready: boolean;
  buffers: number;
  vertexArrays: number;
  programs: number;
  vertexBytes: number;
  indexBytes: number;
  instanceBytes: number;
  bufferBytes: number;
}
export interface SceneBackend {
  readonly kind: Backend;
  readonly gl: WebGL2RenderingContext;
  readonly context: ContextLifecycle;
  frame(time: number, camera: CameraFrame, culling: boolean, timer?: DrawTimer): FrameStats;
  dispose(): void;
}
export interface DrawTimer {
  begin(): void;
  end(): void;
}
export const backendNames: Record<Backend, string> = {
  rust: 'Rust 引擎 · 实例化',
  'rust-direct': 'Rust 引擎 · 逐对象',
  three: 'Three.js · 普通 Mesh',
  instanced: 'Three.js · 实例化',
};
export interface EngineSnapshot {
  comparison: Comparison;
  scenario: Scenario;
  objects: number;
  nodes: number;
  stats: Partial<Record<Backend, FrameStats>>;
  camera: CameraFrame;
}
declare global {
  interface Window {
    engineLab: { snapshot(): EngineSnapshot };
  }
}
import type { ContextLifecycle } from './ContextLifecycle.ts';
