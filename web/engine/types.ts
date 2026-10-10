export type Backend = 'rust' | 'three' | 'instanced';
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
export interface SceneBackend {
  readonly kind: Backend;
  readonly gl: WebGL2RenderingContext;
  frame(time: number, camera: CameraFrame, culling: boolean, timer?: DrawTimer): FrameStats;
  dispose(): void;
}
export interface DrawTimer {
  begin(): void;
  end(): void;
}
export const backendNames: Record<Backend, string> = {
  rust: 'Rust 引擎 · 自动批次',
  three: 'Three.js · 普通 Mesh',
  instanced: 'Three.js · 实例化',
};
export interface EngineSnapshot {
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
