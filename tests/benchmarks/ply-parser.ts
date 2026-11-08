import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = new URL('../../', import.meta.url);
export const sourceKeys = ['centers', 'covariances', 'opacities', 'colors', 'shCoefficients'] as const;
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Load only the historical parser; its dependencies use the current checkout. */
export async function preparePlyParser(revision: string | undefined, instrument = false) {
  if (revision !== undefined && !/^[a-f\d]{7,40}$/i.test(revision)) throw new Error('Supply a baseline commit SHA');
  const git = (args: string[]) => execFileSync('git', args, { cwd: fileURLToPath(root), encoding: 'utf8' }).trimEnd();
  const commit = git(['rev-parse', revision ?? 'HEAD']);
  const path = 'web/engine/GaussianPly.ts';
  const original = revision === undefined ? await readFile(new URL(path, root), 'utf8')
    : execFileSync('git', ['show', `${commit}:${path}`], { cwd: fileURLToPath(root), encoding: 'utf8' });
  let source = original.replace(/from '([^']+)'/g, (match: string, specifier: string) => specifier.startsWith('.')
    ? `from '${new URL(specifier, new URL(path, root)).href}'` : match);
  if (instrument) {
    const imported = '  gaussian_covariances_from_log_scales_rotations,';
    assert.equal(source.split(imported).length, 2, 'Expected exactly one covariance helper import');
    source = source.replace(imported, '  gaussian_covariances_from_log_scales_rotations as covarianceHelper,');
    source += `
let observer: (stage: 'before' | 'after', scales: Float32Array, rotations: Float32Array, result?: Float32Array) => void;
export function observeCovariance(callback: typeof observer) { observer = callback; }
function gaussian_covariances_from_log_scales_rotations(scales: Float32Array, rotations: Float32Array) {
  observer('before', scales, rotations);
  const result = covarianceHelper(scales, rotations);
  observer('after', scales, rotations, result);
  return result;
}
`;
  }
  const temporary = await mkdtemp(join(tmpdir(), 'ply-parser-'));
  try {
    const path = join(temporary, 'parser.mts');
    await writeFile(path, source);
    return { url: pathToFileURL(path).href, commit, sourceSha256: sha256(original),
      dispose: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
