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
