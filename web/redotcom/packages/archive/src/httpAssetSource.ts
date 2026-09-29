import type { RangedAssetSource, ReadProgress } from './assetSource';
import { parseServedIndex, type MapInfo, type ServedIndex } from './mapIndex';

/**
 * An `AssetSource` over a served directory: the disc tree under `baseUrl`, with an `index.json`
 * beside it listing every archive that was extracted. The trailing slash on `baseUrl` is optional.
 *
 * `index.json` is `{ maps, common }` (`ServedIndex`), written by `tools/extract-maps.ts`: `maps` is one
 * `MapInfo` -- `{ archive, path, name }` -- an archive, the name read from each `mission.rdr` once at
 * extraction time. That is the whole reason the name is in there: naming the 22 maps from the archives
 * themselves costs 224 MB of fetches, which is not a menu. `common` is the archives every map shares
 * (`READERC.ZAR`, `ZWEAPON.ZAR`; web sprint 2, W2.R5), which `list()` names too. The older indexes -- an
 * array of `MapInfo`, or of bare paths, whose entries carry no name -- still load (`parseServedIndex`).
 */
export class HttpAssetSource implements RangedAssetSource {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async list(): Promise<string[]> {
    const { maps, common } = await this.index();
    return [...maps.map((m) => m.path), ...common];
  }

  /** Every map the served index names, ready for a picker. No archive is read. */
  async maps(): Promise<MapInfo[]> {
    return (await this.index()).maps;
  }

  private async index(): Promise<ServedIndex> {
    return parseServedIndex(await (await this.get('index.json')).json());
  }

  /**
   * With no `onProgress`, one `arrayBuffer()`. With one, the body is read a chunk at a time so the page
   * can show how far a 13 MB archive has got -- which is the whole of the wait on a cold cache over the
   * network, and used to look like a frozen page.
   *
   * The streaming path still falls back: no `body` (an old browser, a mocked fetch) or no declared
   * length and it reads the buffer in one go, because a progress bar with no denominator is worth less
   * than the simpler code path.
   */
  async read(path: string, onProgress?: ReadProgress): Promise<Uint8Array> {
    const response = await this.get(path);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!onProgress || !response.body || !Number.isFinite(declared) || declared <= 0) {
      return new Uint8Array(await response.arrayBuffer());
    }
    const out = new Uint8Array(declared);
    const reader = response.body.getReader();
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // A server that under-declared its length would overflow the buffer; take what fits and stop
      // trusting the header rather than throwing on a map that would otherwise have drawn.
      if (loaded + value.length > out.length) {
        const all = new Uint8Array(loaded + value.length);
        all.set(out.subarray(0, loaded));
        all.set(value, loaded);
        loaded += value.length;
        onProgress(loaded, loaded);
        return all.subarray(0, loaded);
      }
      out.set(value, loaded);
      loaded += value.length;
      onProgress(loaded, declared);
    }
    return loaded === out.length ? out : out.subarray(0, loaded);
  }

  /**
   * A file's length (web/docs/research/81 §1: the ranged reads of `SOUNDS/BNKSTORE.ZAR`): a `HEAD`'s
   * `Content-Length`, or, where a server leaves it out, the total a one-byte `Range` answer's `Content-Range` names.
   */
  async size(path: string): Promise<number> {
    const head = await fetch(`${this.base}/${path}`, { method: 'HEAD' });
    if (!head.ok) throw new Error(`HTTP ${head.status} ${path}`);
    const declared = Number(head.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared >= 0) return declared;
    const probe = await fetch(`${this.base}/${path}`, { headers: { Range: 'bytes=0-0' } });
    const total = Number(/\/(\d+)$/.exec(probe.headers.get('content-range') ?? '')?.[1] ?? NaN);
    if (!Number.isFinite(total)) throw new Error(`HTTP ${path}: the server says neither its length nor its range`);
    return total;
  }

  /**
   * `length` bytes from `offset` with a `Range` request. A server that ignores the header answers 200 with the
   * whole file, which is sliced rather than refused -- correct, only slower; a short answer is refused.
   */
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0) throw new Error(`HTTP ${path}: no range of ${length} bytes at ${offset}`);
    if (length === 0) return new Uint8Array(0);
    const response = await fetch(`${this.base}/${path}`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 206) bytes = bytes.subarray(offset, offset + length);
    if (bytes.byteLength !== length) throw new Error(`HTTP ${path}: ${length} bytes at ${offset} run past its end`);
    return bytes;
  }

  private async get(path: string): Promise<Response> {
    const response = await fetch(`${this.base}/${path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return response;
  }
}
