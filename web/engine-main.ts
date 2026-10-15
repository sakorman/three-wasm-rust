import init from '../pkg/three_wasm_rust.js';
import { Engine } from './engine/Engine.ts';
import { OrbitCamera } from './engine/camera.ts';
import { createEngineScene } from './engine/scenes.ts';
import { backendNames } from './engine/types.ts';
import type { Backend, Comparison, EngineScene, SceneBackend, FrameStats } from './engine/types.ts';
import { ThreeBackend } from './compare/ThreeBackend.ts';
import { compareBackends } from './compare/benchmark.ts';
import type { ComparisonReport } from './compare/benchmark.ts';
import './engine.css';

function element<T extends HTMLElement>(id: string, kind: { new (): T }): T {
  const value = document.getElementById(id);
  if (!(value instanceof kind)) throw new Error(`Missing ${id}`);
  return value;
}
const ui = {
  scenario: element('scenario', HTMLSelectElement),
  count: element('count', HTMLSelectElement),
  comparison: element('comparison', HTMLSelectElement),
  rustLabel: element('rust-label', HTMLSpanElement),
  referenceLabel: element('reference-label', HTMLSpanElement),
  culling: element('culling', HTMLInputElement),
  pause: element('pause', HTMLButtonElement),
  reset: element('reset', HTMLButtonElement),
  benchmark: element('benchmark', HTMLButtonElement),
  cancel: element('cancel', HTMLButtonElement),
  quality: element('quality', HTMLSelectElement),
  download: element('download', HTMLButtonElement),
  status: element('status', HTMLSpanElement),
  dot: element('status-dot', HTMLSpanElement),
  error: element('error', HTMLDivElement),
  summary: element('scene-summary', HTMLSpanElement),
  fps: element('fps', HTMLElement),
  progress: element('bench-progress', HTMLDivElement),
  results: element('results', HTMLTableSectionElement),
};
const canvases: Record<'rust' | 'three' | 'instanced', HTMLCanvasElement> = {
  rust: element('rust-canvas', HTMLCanvasElement),
  three: element('three-canvas', HTMLCanvasElement),
  instanced: element('instanced-canvas', HTMLCanvasElement),
};
const leftView = element('rust-view', HTMLDivElement),
  rightView = element('three-view', HTMLDivElement);
const camera = new OrbitCamera();
let data: EngineScene;
let backends: { rust: Engine; reference: ThreeBackend } | undefined;
let animation = !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  elapsed = 0,
  failed = false,
  raf = 0,
  last = performance.now(),
  reportTime = last,
  frames = 0;
let recovering = false,
  disposed = false;
let bench: AbortController | undefined, report: ComparisonReport | undefined;
let lastStats: Partial<Record<Backend, FrameStats>> = {};
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const controls = [
  ui.scenario,
  ui.count,
  ui.comparison,
  ui.culling,
  ui.pause,
  ui.reset,
  ui.benchmark,
  ui.quality,
];
function lock(disabled: boolean) {
  for (const control of controls) control.disabled = disabled;
}
function failure(error: unknown) {
  failed = true;
  bench?.abort(new Error(`测试已中止：${errorText(error)}`));
  cancelAnimationFrame(raf);
  ui.error.hidden = false;
  ui.error.textContent = `运行失败：${errorText(error)}。请使用支持 WebGL2 的浏览器，或刷新重建图形资源。`;
  ui.status.textContent = '运行失败';
  ui.dot.classList.remove('ready');
  lock(true);
  console.error(error);
}
function comparison(): Comparison {
  return ui.comparison.value === 'instanced' ? 'instanced' : 'direct';
}
function selectedReference(): 'three' | 'instanced' {
  return comparison() === 'instanced' ? 'instanced' : 'three';
}
function showReference() {
  canvases.three.hidden = selectedReference() !== 'three';
  canvases.instanced.hidden = selectedReference() !== 'instanced';
  const direct = comparison() === 'direct';
  ui.rustLabel.textContent = direct ? '逐对象 / 全量更新' : '实例化 / 脏更新';
  ui.referenceLabel.textContent = direct ? '普通 Mesh / 全量更新' : 'InstancedMesh / 脏更新';
}
function resize() {
  const width = Math.floor(Math.min(leftView.clientWidth, rightView.clientWidth)),
    height = leftView.clientHeight;
  if (width <= 0 || height <= 0) return;
  const ratio = Math.min(devicePixelRatio || 1, 1.5),
    w = Math.round(width * ratio),
    h = Math.round(height * ratio);
  if (canvases.rust.width === w && canvases.rust.height === h) return;
  bench?.abort(new Error('测试已中止：画布尺寸改变，请重新运行。'));
  for (const canvas of Object.values(canvases)) {
    canvas.width = w;
    canvas.height = h;
  }
}
function invalidate() {
  if (report) ui.progress.textContent = '设置已变，请重测';
}
function resetCamera() {
  camera.reset(data.extent);
  invalidate();
}
function disposeBackends() {
  if (backends) for (const backend of Object.values(backends)) backend.dispose();
  backends = undefined;
}
function contextChanged() {
  if (disposed || failed || !backends) return;
  const contexts = [backends.rust.context, backends.reference.context];
  const broken = contexts.find((context) => context.state === 'failed');
  if (broken) {
    failure(broken.error ?? new Error('图形恢复失败'));
    return;
  }
  if (contexts.some((context) => !context.ready)) {
    if (recovering) return;
    recovering = true;
    bench?.abort(new Error('测试已中止：图形上下文丢失'));
    report = undefined;
    ui.download.hidden = true;
    ui.results.innerHTML = '<tr><td colspan="6" class="empty">待测试</td></tr>';
    ui.status.textContent = '等待图形恢复';
    ui.dot.classList.remove('ready');
    ui.progress.textContent = '图形恢复中';
    ui.fps.textContent = '—';
    lastStats = {};
    document.body.classList.add('recovering');
    lock(true);
  } else if (recovering) {
    recovering = false;
    ui.error.hidden = true;
    ui.status.textContent = '引擎已就绪';
    ui.dot.classList.add('ready');
    ui.progress.textContent = '图形已恢复';
    document.body.classList.remove('recovering');
    last = reportTime = performance.now();
    frames = 0;
    if (!bench) lock(false);
  }
}
function rebuild() {
  disposeBackends();
  const scenario = ui.scenario.value;
  if (scenario !== 'city' && scenario !== 'warehouse' && scenario !== 'hierarchy')
    throw new Error('Unknown scenario');
  data = createEngineScene(scenario, Number(ui.count.value));
  const created: SceneBackend[] = [];
  try {
    const rust = new Engine(canvases.rust, data, comparison() === 'instanced');
    created.push(rust);
    const reference = new ThreeBackend(canvases[selectedReference()], data, selectedReference());
    created.push(reference);
    backends = { rust, reference };
    rust.context.subscribe(contextChanged);
    reference.context.subscribe(contextChanged);
  } catch (error) {
    for (const backend of created) backend.dispose();
    throw error;
  }
  elapsed = 0;
  lastStats = {};
  resetCamera();
  resize();
  showReference();
  ui.summary.textContent = `${data.meshNodes.length.toLocaleString()} 对象 / ${data.parents.length.toLocaleString()} 节点 / ${data.batchGeometries.length} 组 / ${data.animatedNodes.length} 动画`;
  invalidate();
}
function updateMetrics(id: string, stats: FrameStats) {
  const spans = document.querySelectorAll(`#${id} b`);
  const values = [
    `${stats.cpuMs.toFixed(2)} ms`,
    stats.draws.toLocaleString(),
    `${stats.visible.toLocaleString()} / ${data.meshNodes.length.toLocaleString()}`,
  ];
  spans.forEach((span, i) => {
    span.textContent = values[i];
  });
}
function tick(now: number) {
  if (failed || disposed) return;
  const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
  last = now;
  if (backends && (!backends.rust.context.ready || !backends.reference.context.ready))
    contextChanged();
  if (backends && !bench && !recovering && !failed) {
    try {
      if (animation) elapsed += dt;
      const frame = camera.frame(canvases.rust.width / canvases.rust.height);
      const rustStats = backends.rust.frame(elapsed, frame, ui.culling.checked);
      const referenceStats = backends.reference.frame(elapsed, frame, ui.culling.checked);
      lastStats[backends.rust.kind] = rustStats;
      lastStats[backends.reference.kind] = referenceStats;
      frames++;
      if (now - reportTime >= 500) {
        updateMetrics('rust-metrics', rustStats);
        updateMetrics('three-metrics', referenceStats);
        ui.fps.textContent = ((frames * 1000) / (now - reportTime)).toFixed(0);
        frames = 0;
        reportTime = now;
      }
    } catch (error) {
      if (!backends.rust.context.ready || !backends.reference.context.ready) contextChanged();
      else {
        failure(error);
        return;
      }
    }
  }
  raf = requestAnimationFrame(tick);
}
function showReport(value: ComparisonReport) {
  const ms = (n: number) => (n < 0.0001 ? '未分辨' : n.toFixed(2));
  const labels = [
    '',
    'CPU 中位 / P95',
    '帧间隔 / FPS',
    'GPU 中位',
    'Draw / 可见',
    '更新 / 准备 / 提交',
  ];
  ui.results.replaceChildren(
    ...value.results.map((row) => {
      const tr = document.createElement('tr');
      tr.dataset.backend = row.mode.startsWith('rust') ? 'rust' : 'three';
      const values = [
        backendNames[row.mode],
        `${ms(row.cpuMedian)} / ${ms(row.cpuP95)}`,
        `${ms(row.frameMedian)} / ${row.fps.toFixed(1)}`,
        row.gpuMedian === null
          ? row.gpuStatus === 'disjoint'
            ? '采样无效'
            : row.gpuStatus === 'incomplete'
              ? '采样不全'
              : '不可用'
          : ms(row.gpuMedian),
        `${row.draws.toLocaleString()} / ${row.visible.toLocaleString()}`,
        `${ms(row.updateMedian)} / ${ms(row.prepareMedian)} / ${ms(row.submitMedian)}`,
      ];
      for (const [index, text] of values.entries()) {
        const td = document.createElement('td');
        td.textContent = text;
        if (index > 0) td.dataset.label = labels[index];
        if (text.includes('未分辨')) td.title = '未分辨：低于当前计时器分辨率，并非没有耗时。';
        if (index === 3 && row.gpuStatus === 'incomplete')
          td.title = `GPU 有效样本 ${row.gpuSamples.length} / ${row.gpuExpectedSamples}，未计算中位数。`;
        tr.append(td);
      }
      return tr;
    }),
  );
  ui.download.hidden = false;
}
ui.benchmark.addEventListener('click', async () => {
  if (!backends || bench) return;
  bench = new AbortController();
  report = undefined;
  ui.results.innerHTML = '<tr><td colspan="6" class="empty">测试中…</td></tr>';
  lock(true);
  ui.cancel.hidden = false;
  ui.benchmark.hidden = true;
  ui.download.hidden = true;
  document.body.classList.add('testing');
  const options =
    ui.quality.value === 'full'
      ? { sampleFrames: 60, warmupFrames: 20 }
      : { sampleFrames: 24, warmupFrames: 8 };
  try {
    report = await compareBackends(
      [backends.rust, backends.reference],
      data,
      camera.frame(canvases.rust.width / canvases.rust.height),
      {
        ...options,
        rounds: 4,
        culling: ui.culling.checked,
        animation,
        signal: bench.signal,
        comparison: comparison(),
      },
      (mode, round, done, total) => {
        ui.progress.textContent = `${mode.startsWith('rust') ? 'Rust' : 'Three.js'}　${round + 1}/4 轮　${done}/${total} 帧`;
      },
    );
    showReport(report);
    ui.progress.textContent = '测试完成';
  } catch (error) {
    ui.progress.textContent = errorText(error);
    report = undefined;
    ui.results.innerHTML = '<tr><td colspan="6" class="empty">未完成</td></tr>';
  } finally {
    bench = undefined;
    ui.cancel.hidden = true;
    ui.benchmark.hidden = false;
    document.body.classList.remove('testing');
    if (!failed && !recovering && !disposed) lock(false);
    last = reportTime = performance.now();
    frames = 0;
  }
});
ui.cancel.addEventListener('click', () => bench?.abort(new Error('测试已取消')));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) bench?.abort(new Error('测试已中止：标签页进入后台，请回到前台重新运行。'));
});
ui.download.addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `engine-${report.scenario}-${report.comparison}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
ui.pause.addEventListener('click', () => {
  animation = !animation;
  ui.pause.textContent = animation ? '暂停动画' : '继续动画';
  invalidate();
});
ui.reset.addEventListener('click', resetCamera);
ui.comparison.addEventListener('change', () => {
  ui.culling.checked = comparison() === 'instanced';
  try {
    rebuild();
  } catch (error) {
    failure(error);
  }
});
ui.culling.addEventListener('change', invalidate);
for (const control of [ui.scenario, ui.count])
  control.addEventListener('change', () => {
    try {
      rebuild();
    } catch (error) {
      failure(error);
    }
  });
camera.attach(leftView, invalidate);
camera.attach(rightView, invalidate);
const observer = new ResizeObserver(resize);
observer.observe(leftView);
observer.observe(rightView);
window.addEventListener('pagehide', () => {
  disposed = true;
  bench?.abort();
  cancelAnimationFrame(raf);
  observer.disconnect();
  camera.dispose();
  disposeBackends();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
// Read-only diagnostics used by integration tests and browser devtools.
window.engineLab = {
  snapshot: () => ({
    comparison: comparison(),
    scenario: data.scenario,
    objects: data.meshNodes.length,
    nodes: data.parents.length,
    stats: lastStats,
    camera: camera.frame(canvases.rust.width / canvases.rust.height),
  }),
};
async function start() {
  await init();
  rebuild();
  showReference();
  ui.status.textContent = '引擎已就绪';
  ui.pause.textContent = animation ? '暂停动画' : '继续动画';
  ui.dot.classList.add('ready');
  lock(false);
  last = reportTime = performance.now();
  raf = requestAnimationFrame(tick);
}
start().catch(failure);
