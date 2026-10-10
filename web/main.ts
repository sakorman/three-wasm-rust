import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import init, { SceneGraph, RustRenderer } from '../pkg/three_wasm_rust.js';
import type { InitOutput } from '../pkg/three_wasm_rust.js';
import { createSceneData, ThreeGraph, matrixView } from './scene.ts';
import { runBenchmarks } from './benchmark.ts';
import { ui } from './dom.ts';
import type { BenchmarkReport, BenchmarkRow, RenderMode } from './types.ts';
import vertexShader from './shaders/scene.vert?raw';
import fragmentShader from './shaders/scene.frag?raw';
import './style.css';

interface Runtime {
  wasm: InitOutput;
  threeRenderer: THREE.WebGLRenderer;
  geometry: THREE.BoxGeometry;
  positions: Float32Array;
  indices: Uint32Array;
  material: THREE.RawShaderMaterial;
  controls: OrbitControls;
}

interface SceneResources {
  graph: SceneGraph;
  reference: ThreeGraph;
  rustRenderer: RustRenderer;
  mesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.RawShaderMaterial>;
}

const { stage, rustCanvas, threeCanvas } = ui;
const controlsList = [ui.mode, ui.count, ui.pause, ui.reset, ui.benchmark];
const modeLabels: Record<RenderMode, string> = {
  rust: 'RUST / WEBGL2', hybrid: 'RUST → THREE.JS', javascript: 'THREE.JS / JAVASCRIPT',
};
let runtime: Runtime | undefined;
let resources: SceneResources | undefined;
let result: BenchmarkReport | undefined;
let running = true, benchmarking = false, failed = false, elapsed = 0, raf = 0;
let previousTime = performance.now(), lastReport = previousTime, frames = 0, computeTotal = 0, renderTotal = 0;
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
const scene = new THREE.Scene();
const vp = new THREE.Matrix4();
const vpArray = new Float32Array(16);
const viewProjection = new THREE.Uniform(new THREE.Matrix4());

function getRuntime(): Runtime {
  if (!runtime) throw new Error('Renderer is not initialized');
  return runtime;
}

function getResources(): SceneResources {
  if (!resources) throw new Error('Scene is not initialized');
  return resources;
}

function readMode(): RenderMode {
  const value = ui.mode.value;
  if (value === 'rust' || value === 'hybrid' || value === 'javascript') return value;
  throw new Error(`Unknown render mode: ${value}`);
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function showError(error: unknown) {
  failed = true;
  cancelAnimationFrame(raf);
  ui.error.hidden = false;
  ui.error.textContent = `运行失败：${errorMessage(error)}\n请确认浏览器支持 WebGL2，并通过 npm run dev 或 HTTP 服务访问。`;
  ui.status.textContent = '运行失败';
  ui.statusDot.classList.remove('ready');
  for (const control of controlsList) control.disabled = true;
  console.error(error);
}

function resetCamera() {
  const { controls } = getRuntime();
  camera.position.set(52, 39, 65);
  controls.target.set(0, 0, 0);
  controls.update();
}

function resize() {
  const { threeRenderer } = getRuntime();
  const { width, height } = stage.getBoundingClientRect();
  // Screenshots, hidden containers and layout transitions can briefly report 0.
  // Preserve the last valid projection instead of producing Infinity / NaN.
  if (width <= 0 || height <= 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  rustCanvas.width = Math.round(width * dpr);
  rustCanvas.height = Math.round(height * dpr);
  threeRenderer.setPixelRatio(dpr);
  threeRenderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function resetMetrics() {
  previousTime = lastReport = performance.now();
  frames = computeTotal = renderTotal = 0;
  for (const metric of [ui.fps, ui.compute, ui.render]) metric.textContent = '—';
}

function disposeScene() {
  if (!resources) return;
  resources.rustRenderer.free();
  resources.graph.free();
  scene.remove(resources.mesh);
  resources.mesh.dispose();
  resources = undefined;
}

function rebuild() {
  const { geometry, positions, indices, material } = getRuntime();
  disposeScene();
  const data = createSceneData(Number(ui.count.value));
  const graph = new SceneGraph(data.parents, data.transforms);
  let rustRenderer: RustRenderer | undefined;
  let mesh: SceneResources['mesh'] | undefined;
  try {
    const reference = new ThreeGraph(data);
    rustRenderer = new RustRenderer(rustCanvas, positions, indices, data.colors);
    mesh = new THREE.InstancedMesh(geometry, material, data.parents.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(data.colors, 3);
    mesh.frustumCulled = false;
    // Restore the same absolute pose when switching counts or compute backends.
    graph.animate_demo(elapsed);
    reference.animateDemo(elapsed);
    scene.add(mesh);
    resources = { graph, reference, rustRenderer, mesh };
  } catch (error) {
    rustRenderer?.free();
    graph.free();
    mesh?.dispose();
    throw error;
  }
  resetMetrics();
}

function switchMode() {
  const { graph, reference } = getResources();
  const mode = readMode();
  rustCanvas.hidden = mode !== 'rust';
  threeCanvas.hidden = mode === 'rust';
  ui.sceneLabel.textContent = modeLabels[mode];
  graph.animate_demo(elapsed);
  reference.animateDemo(elapsed);
  resetMetrics();
}

function frame(now: number) {
  if (failed) return;
  try {
    const delta = Math.min((now - previousTime) / 1000, 0.1);
    previousTime = now;
    if (!benchmarking) {
      const { wasm, controls, threeRenderer } = getRuntime();
      const { graph, reference, rustRenderer, mesh } = getResources();
      if (running) elapsed += delta;
      controls.update();
      camera.updateMatrixWorld();
      vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray(vpArray);
      const mode = readMode();
      const begin = performance.now();
      if (running) {
        if (mode === 'javascript') reference.animateDemo(elapsed);
        else graph.animate_demo(elapsed);
      }
      const afterCompute = performance.now();
      if (mode === 'rust') rustRenderer.render(graph, vpArray);
      else {
        mesh.instanceMatrix.array.set(mode === 'javascript' ? reference.worldMatrices() : matrixView(wasm, graph));
        mesh.instanceMatrix.needsUpdate = true;
        viewProjection.value.copy(vp);
        threeRenderer.render(scene, camera);
      }
      computeTotal += afterCompute - begin;
      renderTotal += performance.now() - afterCompute;
      frames++;
      if (now - lastReport >= 500) {
        ui.fps.textContent = (frames * 1000 / (now - lastReport)).toFixed(0);
        ui.compute.textContent = (computeTotal / frames).toFixed(2);
        ui.render.textContent = (renderTotal / frames).toFixed(2);
        lastReport = now;
        frames = computeTotal = renderTotal = 0;
      }
    }
    raf = requestAnimationFrame(frame);
  } catch (error) { showError(error); }
}

function displayRows(rows: readonly BenchmarkRow[]) {
  ui.results.replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = row.name;
    const unit = document.createElement('small'); unit.textContent = row.unit; label.append(unit);
    tr.append(label);
    const milliseconds = (value: number) => value > 0 ? value.toFixed(4) + ' ms' : '低于计时精度';
    for (const value of [milliseconds(row.javascript.medianMs), milliseconds(row.wasm.medianMs), row.ratio !== null && Number.isFinite(row.ratio) ? row.ratio.toFixed(2) + '×' : '低于计时精度']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    return tr;
  }));
}

ui.benchmark.addEventListener('click', async () => {
  benchmarking = true;
  for (const control of controlsList) control.disabled = true;
  ui.download.hidden = true;
  ui.progress.textContent = '正在预热与采样，请保持此标签页在前台…';
  try {
    result = await runBenchmarks(getRuntime().wasm, Number(ui.count.value), rows => {
      displayRows(rows);
      ui.progress.textContent = `已完成 ${rows.length} / 5 项测试…`;
    });
    ui.progress.textContent = '测试完成。比值 > 1 表示此项 WASM 更快；< 1 表示 JavaScript 更快。';
    ui.download.hidden = false;
  } catch (error) {
    ui.progress.textContent = `测试失败：${errorMessage(error)}`;
  } finally {
    benchmarking = false;
    if (!failed) for (const control of controlsList) control.disabled = false;
    resetMetrics();
  }
});
ui.download.addEventListener('click', () => {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'three-wasm-rust-benchmark.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
ui.pause.addEventListener('click', () => { running = !running; ui.pause.textContent = running ? '暂停动画' : '继续动画'; });
ui.reset.addEventListener('click', resetCamera);
ui.mode.addEventListener('change', () => { try { switchMode(); } catch (error) { showError(error); } });
ui.count.addEventListener('change', () => { try { rebuild(); } catch (error) { showError(error); } });
for (const canvas of [rustCanvas, threeCanvas]) canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); showError('WebGL 上下文已丢失，请刷新页面重新创建资源。'); });

let observer: ResizeObserver | undefined;
async function start() {
  const wasm = await init();
  const threeRenderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true });
  threeRenderer.setClearColor(new THREE.Color().setRGB(0.035, 0.055, 0.075, THREE.SRGBColorSpace), 1);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const positions = geometry.getAttribute('position').array;
  const index = geometry.getIndex();
  if (!(positions instanceof Float32Array) || !index) {
    geometry.dispose();
    threeRenderer.dispose();
    throw new Error('Expected indexed geometry with Float32 positions');
  }
  const indices = Uint32Array.from(index.array);
  const material = new THREE.RawShaderMaterial({
    vertexShader, fragmentShader, glslVersion: THREE.GLSL3,
    uniforms: { viewProjection },
  });
  const controls = new OrbitControls(camera, stage);
  runtime = { wasm, threeRenderer, geometry, positions, indices, material, controls };
  controls.enableDamping = true;
  controls.minDistance = 12;
  controls.maxDistance = 160;
  resetCamera();
  rebuild();
  resize();
  observer = new ResizeObserver(resize); observer.observe(stage);
  document.addEventListener('visibilitychange', resetMetrics);
  ui.status.textContent = 'WASM 已就绪';
  ui.statusDot.classList.add('ready');
  for (const control of controlsList) control.disabled = false;
  raf = requestAnimationFrame(frame);
}

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(raf);
  observer?.disconnect();
  disposeScene();
  runtime?.controls.dispose();
  runtime?.geometry.dispose();
  runtime?.material.dispose();
  runtime?.threeRenderer.dispose();
  runtime = undefined;
});
// pagehide releases WASM handles; a bfcache restore must recreate them.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
start().catch(showError);
