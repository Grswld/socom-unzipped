/**
 * Where the viewer's archive bytes come from. Paths are archive-relative and always use forward slashes
 * ("RUN/MP2.ZDB"), so the same index code runs over a served directory in the browser and over the disc
 * tree copied into `public/maps` in node.
 */
export interface AssetSource {
  list(): Promise<string[]>;
  /**
   * `onProgress` is called with bytes so far and the total the server declared, for a progress bar.
   * It is optional on both sides: a source that cannot report progress (a local directory, a source
   * whose server sends no `Content-Length`) simply never calls it, and a caller that does not care
   * passes nothing and gets the cheaper path.
   */
  read(path: string, onProgress?: ReadProgress): Promise<Uint8Array>;
}

/** Bytes so far and the declared total; `total` is 0 when the server did not say. */
export type ReadProgress = (loaded: number, total: number) => void;

/**
 * A source that can read part of a file without the rest of it, and say how long the file is. The ISO
 * source is one (design spec §3.1: it reads by LBN, so any range of an extent is one `Blob.slice`), and it
 * is why `listMaps` can name the maps on a player's disc from each archive's table of contents and its
 * `READERM.ZAR` -- tens of kilobytes an archive -- instead of the 224 MB of all 22. A served directory
 * has `index.json` for that instead and does not implement it.
 */
export interface RangedAssetSource extends AssetSource {
  size(path: string): Promise<number>;
  /** `length` bytes from `offset`; throws when the range runs past the end of the file. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
}

/** Whether `source` reads by range. */
export function isRanged(source: AssetSource): source is RangedAssetSource {
  const s = source as Partial<RangedAssetSource>;
  return typeof s.readRange === 'function' && typeof s.size === 'function';
}
