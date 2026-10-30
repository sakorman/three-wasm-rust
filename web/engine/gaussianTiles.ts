import type { GaussianRasterTiles } from './gaussian.ts';

/** Copy checked tile references without changing their stored compositing order. */
export function copyGaussianRasterTiles(tiles: GaussianRasterTiles, recordCount: number): GaussianRasterTiles {
  if (!Number.isSafeInteger(tiles.tileSize) || tiles.tileSize <= 0
    || !Number.isSafeInteger(tiles.columns) || tiles.columns <= 0
    || !Number.isSafeInteger(tiles.rows) || tiles.rows <= 0) {
    throw new Error('Gaussian tile metadata must use positive safe integers');
  }
  const tileCount = tiles.columns * tiles.rows;
  if (!Number.isSafeInteger(tileCount) || tiles.packed.length < tileCount + 1 || tiles.packed[0] !== 0) {
    throw new Error('Gaussian tile offsets are malformed');
  }
  const referenceStart = tileCount + 1;
  const referenceCount = tiles.packed.length - referenceStart;
  if (tiles.packed[tileCount] !== referenceCount) throw new Error('Gaussian tile offsets must end at the reference count');
  for (let tile = 0; tile < tileCount; tile++) {
    if (tiles.packed[tile] > tiles.packed[tile + 1]) throw new Error('Gaussian tile offsets must be monotonic');
  }
  const seen = new Set<number>();
  for (let tile = 0; tile < tileCount; tile++) {
    seen.clear();
    for (let reference = tiles.packed[tile]; reference < tiles.packed[tile + 1]; reference++) {
      const id = tiles.packed[referenceStart + reference];
      if (id >= recordCount) throw new Error('Gaussian tile reference is out of range');
      if (seen.has(id)) throw new Error(`duplicate Gaussian tile reference at tile ${tile}`);
      seen.add(id);
    }
  }
  return { tileSize: tiles.tileSize, columns: tiles.columns, rows: tiles.rows, packed: tiles.packed.slice() };
}
