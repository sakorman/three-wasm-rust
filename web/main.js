import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import init, { SceneGraph, RustRenderer } from '../pkg/three_wasm_rust.js';
import { createSceneData, ThreeGraph, matrixView } from './scene.js';
import { runBenchmarks } from './benchmark.js';
import vertexShader from './shaders/scene.vert?raw';
import fragmentShader from './shaders/scene.frag?raw';
import './style.css';

const $ = id => document.getElementById(id);
const stage = $('stage'), rustCanvas = $('rust-canvas'), threeCanvas = $('three-canvas');
const controlsList = ['mode', 'count', 'pause', 'reset', 'benchmark'];
let wasm, graph, reference, rustRenderer, threeRenderer, mesh, geometry, material, controls;
let running = true, benchmarking = false, failed = false, result, elapsed = 0, raf;
let previousTime = performance.now(), lastReport = previousTime, frames = 0, computeTotal = 0, renderTotal = 0;
const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 400);
const scene = new THREE.Scene();
const vp = new THREE.Matrix4();
const vpArray = new Float32Array(16);

function showError(error) {
  failed = true;
  cancelAnimationFrame(raf);
  $('error').hidden = false;
  $('error').textContent = `运行失败：${error?.message || error}\n请确认浏览器支持 WebGL2，并通过 npm run dev 或 HTTP 服务访问。`;
  $('status').textContent = '运行失败';
  $('status-dot').classList.remove('ready');
  for (const id of controlsList) $(id).disabled = true;
  console.error(error);
}

function resetCamera() {
  camera.position.set(52, 39, 65);
  controls.target.set(0, 0, 0);
  controls.update();
}

function resize() {
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
  for (const id of ['fps', 'compute', 'render']) $(id).textContent = '—';
}

function rebuild() {
  rustRenderer?.free();
  rustRenderer = undefined;
  graph?.free();
  graph = undefined;
  if (mesh) { scene.remove(mesh); mesh.dispose(); mesh = undefined; }
  const data = createSceneData(Number($('count').value));
  graph = new SceneGraph(data.parents, data.transforms);
  reference = new ThreeGraph(data);
  rustRenderer = new RustRenderer(rustCanvas, geometry.attributes.position.array, Uint32Array.from(geometry.index.array), data.colors);
  mesh = new THREE.InstancedMesh(geometry, material, data.parents.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(data.colors, 3);
  mesh.frustumCulled = false;
  scene.add(mesh);
  // The same absolute pose is restored when switching counts or compute backends.
  graph.animate_demo(elapsed);
  reference.animateDemo(elapsed);
  resetMetrics();
}

function switchMode() {
  const mode = $('mode').value;
  rustCanvas.hidden = mode !== 'rust';
  threeCanvas.hidden = mode === 'rust';
  $('scene-label').textContent = { rust: 'RUST / WEBGL2', hybrid: 'RUST → THREE.JS', javascript: 'THREE.JS / JAVASCRIPT' }[mode];
  graph.animate_demo(elapsed);
  reference.animateDemo(elapsed);
  resetMetrics();
}

function frame(now) {
  if (failed) return;
  try {
    const delta = Math.min((now - previousTime) / 1000, 0.1);
    previousTime = now;
    if (!benchmarking) {
      if (running) elapsed += delta;
      controls.update();
      camera.updateMatrixWorld();
      vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).toArray(vpArray);
      const mode = $('mode').value;
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
        material.uniforms.viewProjection.value.copy(vp);
        threeRenderer.render(scene, camera);
      }
      computeTotal += afterCompute - begin;
      renderTotal += performance.now() - afterCompute;
      frames++;
      if (now - lastReport >= 500) {
        $('fps').textContent = (frames * 1000 / (now - lastReport)).toFixed(0);
        $('compute').textContent = (computeTotal / frames).toFixed(2);
        $('render').textContent = (renderTotal / frames).toFixed(2);
        lastReport = now;
        frames = computeTotal = renderTotal = 0;
      }
    }
    raf = requestAnimationFrame(frame);
  } catch (error) { showError(error); }
}

function displayRows(rows) {
  $('results').replaceChildren(...rows.map(row => {
    const tr = document.createElement('tr');
    const label = document.createElement('td');
    label.textContent = row.name;
    const unit = document.createElement('small'); unit.textContent = row.unit; label.append(unit);
    tr.append(label);
    const milliseconds = value => value > 0 ? value.toFixed(4) + ' ms' : '低于计时精度';
    for (const value of [milliseconds(row.javascript.medianMs), milliseconds(row.wasm.medianMs), Number.isFinite(row.ratio) ? row.ratio.toFixed(2) + '×' : '低于计时精度']) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    return tr;
  }));
}

$('benchmark').addEventListener('click', async () => {
  benchmarking = true;
  for (const id of controlsList) $(id).disabled = true;
  $('download').hidden = true;
  $('bench-progress').textContent = '正在预热与采样，请保持此标签页在前台…';
  try {
    result = await runBenchmarks(wasm, Number($('count').value), rows => {
      displayRows(rows);
      $('bench-progress').textContent = `已完成 ${rows.length} / 5 项测试…`;
    });
    $('bench-progress').textContent = '测试完成。比值 > 1 表示此项 WASM 更快；< 1 表示 JavaScript 更快。';
    $('download').hidden = false;
  } catch (error) {
    $('bench-progress').textContent = `测试失败：${error?.message || error}`;
  } finally {
    benchmarking = false;
    if (!failed) for (const id of controlsList) $(id).disabled = false;
    resetMetrics();
  }
});
$('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'three-wasm-rust-benchmark.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('pause').addEventListener('click', () => { running = !running; $('pause').textContent = running ? '暂停动画' : '继续动画'; });
$('reset').addEventListener('click', resetCamera);
$('mode').addEventListener('change', () => { try { switchMode(); } catch (error) { showError(error); } });
$('count').addEventListener('change', () => { try { rebuild(); } catch (error) { showError(error); } });
for (const canvas of [rustCanvas, threeCanvas]) canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); showError('WebGL 上下文已丢失，请刷新页面重新创建资源。'); });

let observer;
async function start() {
  wasm = await init();
  threeRenderer = new THREE.WebGLRenderer({ canvas: threeCanvas, antialias: true });
  threeRenderer.setClearColor(new THREE.Color().setRGB(0.035, 0.055, 0.075, THREE.SRGBColorSpace), 1);
  geometry = new THREE.BoxGeometry(1, 1, 1);
  material = new THREE.RawShaderMaterial({
    vertexShader, fragmentShader, glslVersion: THREE.GLSL3,
    uniforms: { viewProjection: { value: new THREE.Matrix4() } },
  });
  controls = new OrbitControls(camera, stage);
  controls.enableDamping = true;
  controls.minDistance = 12;
  controls.maxDistance = 160;
  resetCamera();
  rebuild();
  resize();
  observer = new ResizeObserver(resize); observer.observe(stage);
  document.addEventListener('visibilitychange', resetMetrics);
  $('status').textContent = 'WASM 已就绪';
  $('status-dot').classList.add('ready');
  for (const id of controlsList) $(id).disabled = false;
  raf = requestAnimationFrame(frame);
}

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(raf); observer?.disconnect(); controls?.dispose();
  rustRenderer?.free(); graph?.free(); mesh?.dispose(); geometry?.dispose(); material?.dispose(); threeRenderer?.dispose();
});
// pagehide releases WASM handles; a bfcache restore must recreate them.
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
start().catch(showError);
