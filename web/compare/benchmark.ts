import { GpuTimer } from './GpuTimer.ts';
import { REVISION } from 'three';
import type {
  Backend,
  CameraFrame,
  EngineScene,
  FrameStats,
  SceneBackend,
} from '../engine/types.ts';

export interface ModeResult {
  mode: Backend;
  cpuMedian: number;
  cpuP95: number;
  frameMedian: number;
  fps: number;
  updateMedian: number;
  prepareMedian: number;
  submitMedian: number;
  gpuMedian: number | null;
  gpuStatus: string;
  gpuSamples: number[];
  draws: number;
  visible: number;
  triangles: number;
  samples: (FrameStats & { frameMs: number })[];
}
export interface ComparisonReport {
  schemaVersion: 2;
  createdAt: string;
  scenario: string;
  objects: number;
  nodes: number;
  animatedNodes: number;
  seed: number;
  width: number;
  height: number;
  culling: boolean;
  animation: boolean;
  userAgent: string;
  hardwareConcurrency: number;
  threeRevision: string;
  camera: { projection: number[]; view: number[]; viewProjection: number[] };
  protocol: {
    warmupFrames: number;
    sampleFrames: number;
    rounds: number;
    order: Backend[][];
    notes: string;
  };
  results: ModeResult[];
}
export const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
export function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

export async function compareBackends(
  backends: Record<Backend, SceneBackend>,
  data: EngineScene,
  camera: CameraFrame,
  options: {
    culling: boolean;
    animation: boolean;
    sampleFrames: number;
    warmupFrames: number;
    rounds: number;
    signal: AbortSignal;
  },
  progress: (mode: Backend, round: number, done: number, total: number) => void,
): Promise<ComparisonReport> {
  const modes: Backend[] = ['rust', 'three', 'instanced'];
  const samples: Record<Backend, ModeResult['samples']> = { rust: [], three: [], instanced: [] };
  const gpu: Record<Backend, number[]> = { rust: [], three: [], instanced: [] };
  const gpuStatus: Record<Backend, string> = {
    rust: 'unsupported',
    three: 'unsupported',
    instanced: 'unsupported',
  };
  const order: Backend[][] = [];
  const check = () => {
    if (options.signal.aborted)
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('测试已取消');
    if (document.hidden) throw new Error('标签页已进入后台，请回到前台重新测试');
  };
  const width = backends.rust.gl.drawingBufferWidth,
    height = backends.rust.gl.drawingBufferHeight;
  for (const mode of modes)
    if (
      backends[mode].gl.drawingBufferWidth !== width ||
      backends[mode].gl.drawingBufferHeight !== height
    )
      throw new Error('对照画布尺寸不一致');
  for (let round = 0; round < options.rounds; round++) {
    const sequence = modes.map((_, i) => modes[(i + round) % modes.length]);
    order.push(sequence);
    for (const mode of sequence) {
      check();
      progress(mode, round, 0, options.warmupFrames + options.sampleFrames);
      const backend = backends[mode],
        timer = new GpuTimer(backend.gl);
      try {
        let boundary = await nextFrame();
        for (let frame = 0; frame < options.warmupFrames + options.sampleFrames; frame++) {
          check();
          const recording = frame >= options.warmupFrames;
          const stats = backend.frame(
            options.animation ? frame / 60 : 0,
            camera,
            options.culling,
            recording ? timer : undefined,
          );
          const end = await nextFrame();
          if (recording) samples[mode].push({ ...stats, frameMs: end - boundary });
          boundary = end;
          timer.poll();
          if (frame % 20 === 0)
            progress(mode, round, frame + 1, options.warmupFrames + options.sampleFrames);
        }
        for (let i = 0; i < 8; i++) {
          check();
          await nextFrame();
          timer.poll();
        }
        if (timer.disjoint) {
          gpuStatus[mode] = 'disjoint';
          gpu[mode] = [];
        } else if (gpuStatus[mode] !== 'disjoint' && timer.supported) {
          gpu[mode].push(...timer.samples);
          gpuStatus[mode] = gpu[mode].length ? 'available' : 'unavailable';
        }
      } finally {
        timer.dispose();
      }
    }
  }
  const results = modes.map((mode): ModeResult => {
    const list = samples[mode],
      median = (key: keyof FrameStats) =>
        quantile(
          list.map((s) => Number(s[key])),
          0.5,
        );
    return {
      mode,
      samples: list,
      cpuMedian: median('cpuMs'),
      cpuP95: quantile(
        list.map((s) => s.cpuMs),
        0.95,
      ),
      frameMedian: quantile(
        list.map((s) => s.frameMs),
        0.5,
      ),
      fps: 1000 / (list.reduce((sum, s) => sum + s.frameMs, 0) / list.length),
      updateMedian: median('updateMs'),
      prepareMedian: median('prepareMs'),
      submitMedian: median('submitMs'),
      gpuMedian: gpu[mode].length ? quantile(gpu[mode], 0.5) : null,
      gpuStatus: gpuStatus[mode],
      gpuSamples: gpu[mode],
      draws: median('draws'),
      visible: median('visible'),
      triangles: median('triangles'),
    };
  });
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    scenario: data.scenario,
    objects: data.meshNodes.length,
    nodes: data.parents.length,
    animatedNodes: data.animatedNodes.length,
    seed: data.seed,
    width,
    height,
    culling: options.culling,
    animation: options.animation,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    threeRevision: REVISION,
    camera: {
      projection: Array.from(camera.projection),
      view: Array.from(camera.view),
      viewProjection: Array.from(camera.viewProjection),
    },
    protocol: {
      warmupFrames: options.warmupFrames,
      sampleFrames: options.sampleFrames,
      rounds: options.rounds,
      order,
      notes:
        'Sequential backends; identical deterministic time sequence, camera, geometry, shaders, AA and pixel size. CPU includes update+prepare+submit. rAF interval includes presentation/scheduling. GPU timer spans queued frame commands and is asynchronous; no gl.finish. Native Mesh culling occurs inside Three.js render. Precision: Rust f32 vs JS Number. Auto batching and dirty updates are algorithmic differences, not a language-only comparison.',
    },
    results,
  };
}
