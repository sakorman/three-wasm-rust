import * as THREE from 'three';
import { SceneGraph, identity_value, multiply_matrices, multiply_matrices_batch } from '../pkg/three_wasm_rust.js';
import type { InitOutput } from '../pkg/three_wasm_rust.js';
import { createSceneData, ThreeGraph, matrixView } from './scene.ts';
import type { BenchmarkReport, BenchmarkRow, TimingStats } from './types.ts';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let sink = 0;

function measure(fn: () => number, iterations: number) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) sink += fn() || 0;
  return (performance.now() - start) / iterations;
}

async function compare(name: string, unit: string, js: () => number, rust: () => number, iterations = 20): Promise<BenchmarkRow> {
  // Warm both paths and alternate execution order to reduce ordering bias.
  measure(js, 10);
  measure(rust, 10);
  const javascript: number[] = [], wasm: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    if (sample % 2 === 0) {
      javascript.push(measure(js, iterations)); wasm.push(measure(rust, iterations));
    } else {
      wasm.push(measure(rust, iterations)); javascript.push(measure(js, iterations));
    }
    await pause();
  }
  const stats = (values: number[]): TimingStats => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6], samplesMs: values };
  };
  const jsStats = stats(javascript), wasmStats = stats(wasm);
  const ratio = jsStats.medianMs > 0 && wasmStats.medianMs > 0 ? jsStats.medianMs / wasmStats.medianMs : null;
  return { name, unit, javascript: jsStats, wasm: wasmStats, ratio, iterations };
}

export async function runBenchmarks(
  wasm: InitOutput,
  count: number,
  progress: (rows: readonly BenchmarkRow[]) => void = () => {},
): Promise<BenchmarkReport> {
  const data = createSceneData(count);
  const graph = new SceneGraph(data.parents, data.transforms);
  const reference = new ThreeGraph(data);
  const rows: BenchmarkRow[] = [];
  const record = async (...args: Parameters<typeof compare>) => {
    const result = await compare(...args);
    rows.push(result); progress(rows.slice()); await pause();
  };
  try {
    await record('场景矩阵更新', `${count.toLocaleString()} 个节点 / 次`,
      () => { reference.updateWorldMatrices(); return reference.nodes[0]?.matrixWorld.elements[0] || 0; },
      () => { graph.update_world_matrices(); return graph.node_count(); });
    await record('更新 + JS 可用矩阵', `${count.toLocaleString()} 个节点 / 次`,
      () => { reference.updateWorldMatrices(); return reference.worldMatrices()[0] || 0; },
      () => { graph.update_world_matrices(); return matrixView(wasm, graph)[0] || 0; });

    const matrices = Math.min(count, 10_000);
    const a = new Float32Array(matrices * 16), b = new Float32Array(matrices * 16);
    const ma = new THREE.Matrix4().makeRotationY(0.3), mb = new THREE.Matrix4().makeTranslation(1, 2, 3);
    for (let i = 0; i < matrices; i++) { ma.toArray(a, i * 16); mb.toArray(b, i * 16); }
    const out = new Float32Array(a.length), left = new THREE.Matrix4(), right = new THREE.Matrix4(), product = new THREE.Matrix4();
    await record('批量矩阵乘法（含传输）', `${matrices.toLocaleString()} 对 / 次`,
      () => {
        for (let i = 0; i < a.length; i += 16) product.multiplyMatrices(left.fromArray(a, i), right.fromArray(b, i)).toArray(out, i);
        return out[0] || 0;
      },
      () => multiply_matrices_batch(a, b)[0] || 0, 10);
    const oneA = a.subarray(0, 16), oneB = b.subarray(0, 16);
    await record('逐个矩阵乘法（含传输）', '1,000 对 / 次',
      () => {
        for (let i = 0; i < 1000; i++) product.multiplyMatrices(left.fromArray(oneA), right.fromArray(oneB)).toArray(out, 0);
        return out[0];
      },
      () => { let result = 0; for (let i = 0; i < 1000; i++) result += multiply_matrices(oneA, oneB)[0]; return result; }, 5);
    const jsIdentity = (value: number) => value;
    await record('函数调用开销', '10,000 次调用 / 次',
      () => { let result = 0; for (let i = 0; i < 10_000; i++) result += jsIdentity(i); return result; },
      () => { let result = 0; for (let i = 0; i < 10_000; i++) result += identity_value(i); return result; }, 10);
    return {
      schemaVersion: 1, createdAt: new Date().toISOString(), count, seed: 2026,
      userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      devicePixelRatio, threeRevision: THREE.REVISION,
      notes: 'CPU wall-clock only; no GPU completion measurement. f32 WASM vs JS Number. JS identity may be inlined. 10 warmup runs; 7 alternating samples; median. Ratios are JS / WASM.',
      rows, checksum: sink,
    };
  } finally { graph.free(); }
}
