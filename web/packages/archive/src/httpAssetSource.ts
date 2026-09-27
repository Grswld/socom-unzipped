import type { AssetSource, ReadProgress } from './assetSource';
import { mapArchiveId, type MapInfo } from './mapIndex';

/**
 * An `AssetSource` over a served directory: the disc tree under `baseUrl`, with an `index.json`
 * beside it listing every archive that was extracted. The trailing slash on `baseUrl` is optional.
 *
 * `index.json` is an array of `MapInfo` — `{ archive, path, name }` — written by `tools/extract-maps.ts`,
 * which reads each `mission.rdr` once at extraction time. That is the whole reason the name is in there:
 * naming the 22 maps from the archives themselves costs 224 MB of fetches, which is not a menu. An older
 * index that is a plain array of paths still loads; those entries carry no name, so the archive id stands in.
 */
export class HttpAssetSource implements AssetSource {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async list(): Promise<string[]> {
    return (await this.maps()).map((m) => m.path);
  }

  /** Every map the served index names, ready for a picker. No archive is read. */
  async maps(): Promise<MapInfo[]> {
    const entries = (await (await this.get('index.json')).json()) as (string | MapInfo)[];
    return entries.map((entry) => {
      if (typeof entry !== 'string') return entry;
      const archive = mapArchiveId(entry) ?? entry;
      return { archive, path: entry, name: archive };
    });
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

  private async get(path: string): Promise<Response> {
    const response = await fetch(`${this.base}/${path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
    return response;
  }
}
