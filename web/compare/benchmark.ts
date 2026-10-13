import { GpuTimer } from './GpuTimer.ts';
import { REVISION } from 'three';
import type {
  Backend,
  CameraFrame,
  EngineScene,
  FrameStats,
  SceneBackend,
  Comparison,
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
  schemaVersion: 3;
  comparison: Comparison;
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
    instancing: boolean;
    matrixUpdate: 'full' | 'dirty';
    drawOrder: 'scene' | 'grouped';
    notes: string;
  };
  results: ModeResult[];
}
export function nextFrame(signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const frame = requestAnimationFrame((time) => {
      signal.removeEventListener('abort', cancel);
      resolve(time);
    });
    function cancel() {
      cancelAnimationFrame(frame);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

export async function compareBackends(
  backends: readonly SceneBackend[],
  data: EngineScene,
  camera: CameraFrame,
  options: {
    culling: boolean;
    animation: boolean;
    sampleFrames: number;
    warmupFrames: number;
    rounds: number;
    signal: AbortSignal;
    comparison: Comparison;
  },
  progress: (mode: Backend, round: number, done: number, total: number) => void,
): Promise<ComparisonReport> {
  const modes = backends.map((backend) => backend.kind);
  const expected =
    options.comparison === 'direct' ? ['rust-direct', 'three'] : ['rust', 'instanced'];
  if (modes.length !== 2 || expected.some((mode, i) => mode !== modes[i]))
    throw new Error('对照实现与所选模式不一致');
  const byMode = new Map(backends.map((backend) => [backend.kind, backend]));
  const samples: Record<Backend, ModeResult['samples']> = {
    rust: [],
    'rust-direct': [],
    three: [],
    instanced: [],
  };
  const gpu: Record<Backend, number[]> = { rust: [], 'rust-direct': [], three: [], instanced: [] };
  const gpuStatus: Record<Backend, string> = {
    rust: 'unsupported',
    'rust-direct': 'unsupported',
    three: 'unsupported',
    instanced: 'unsupported',
  };
  const order: Backend[][] = [];
  const generations = backends.map((backend) => backend.context.generation);
  const check = () => {
    if (options.signal.aborted)
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('测试已取消');
    if (document.hidden) throw new Error('标签页已进入后台，请回到前台重新测试');
    for (const [i, backend] of backends.entries()) {
      if (!backend.context.ready || backend.context.generation !== generations[i])
        throw new Error('测试已中止：图形上下文改变');
      if (backend.gl.drawingBufferWidth !== width || backend.gl.drawingBufferHeight !== height)
        throw new Error('测试已中止：画布尺寸改变');
    }
  };
  const width = backends[0].gl.drawingBufferWidth,
    height = backends[0].gl.drawingBufferHeight;
  for (const backend of backends)
    if (backend.gl.drawingBufferWidth !== width || backend.gl.drawingBufferHeight !== height)
      throw new Error('对照画布尺寸不一致');
  for (let round = 0; round < options.rounds; round++) {
    const sequence = modes.map((_, i) => modes[(i + round) % modes.length]);
    order.push(sequence);
    for (const mode of sequence) {
      check();
      progress(mode, round, 0, options.warmupFrames + options.sampleFrames);
      const backend = byMode.get(mode)!,
        timer = new GpuTimer(backend.gl);
      try {
        let boundary = await nextFrame(options.signal);
        for (let frame = 0; frame < options.warmupFrames + options.sampleFrames; frame++) {
          check();
          const recording = frame >= options.warmupFrames;
          const stats = backend.frame(
            options.animation ? frame / 60 : 0,
            camera,
            options.culling,
            recording ? timer : undefined,
          );
          const end = await nextFrame(options.signal);
          check();
          if (recording) samples[mode].push({ ...stats, frameMs: end - boundary });
          boundary = end;
          timer.poll();
          if (frame % 20 === 0)
            progress(mode, round, frame + 1, options.warmupFrames + options.sampleFrames);
        }
        for (let i = 0; i < 8; i++) {
          check();
          await nextFrame(options.signal);
          check();
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
  check();
  const left = samples[modes[0]],
    right = samples[modes[1]];
  if (
    left.some(
      (sample, i) =>
        sample.visible !== right[i].visible ||
        sample.triangles !== right[i].triangles ||
        (options.comparison === 'direct' &&
          (sample.draws !== sample.visible || right[i].draws !== right[i].visible)),
    )
  ) {
    throw new Error('两组绘制工作量不一致，本次结果作废。可关闭剔除后重试。');
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
    schemaVersion: 3,
    comparison: options.comparison,
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
      instancing: options.comparison === 'instanced',
      matrixUpdate: options.comparison === 'direct' ? 'full' : 'dirty',
      drawOrder: options.comparison === 'direct' ? 'scene' : 'grouped',
      notes:
        'Paired backends; identical animation, camera, geometry, shaders, AA and pixel size. Direct pair: no instancing, full matrix recomputation, scene order, culling off by default. Instanced pair: instancing and dirty updates on both sides. Matching visible/triangle counts are required; direct draws must equal visible objects. CPU includes update+prepare+submit; native Three.js culling occurs inside render. rAF includes presentation/scheduling. GPU queries wrap submission, not pure rasterization; no gl.finish. Rust f32 vs JS Number and engine/driver binding differences remain; this is not a language-only benchmark.',
    },
    results,
  };
}
