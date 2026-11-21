import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, sha256 } from './ply-parser.ts';

// Run npm run build:wasm first, then: npx tsx tests/benchmarks/save-sort-baseline.ts <new-directory>
const [directory] = process.argv.slice(2);
if (!directory) throw new Error('Supply a new directory for the built baseline');
const git = (args: string[]) => execFileSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' }).trimEnd();
assert.equal(git(['status', '--porcelain', '--', 'src', 'Cargo.toml', 'Cargo.lock']), '', 'Baseline Rust inputs must be committed');
const source = await readFile(new URL('src/gaussian.rs', root));
const wasm = await readFile(new URL('pkg/three_wasm_rust_bg.wasm', root));
const js = await readFile(new URL('pkg/three_wasm_rust.js', root));
const target = resolve(directory);
await mkdir(target); // Never overwrite a saved baseline.
await writeFile(join(target, 'three_wasm_rust.js'), js);
await writeFile(join(target, 'three_wasm_rust_bg.wasm'), wasm);
await writeFile(join(target, 'package.json'), '{"type":"module"}\n');
await writeFile(join(target, 'baseline.json'), JSON.stringify({ commit: git(['rev-parse', 'HEAD']),
  sourceSha256: sha256(source), wasmSha256: sha256(wasm) }, null, 2) + '\n');
