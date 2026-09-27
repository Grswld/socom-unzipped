import { HttpAssetSource, listMaps, type AssetSource, type MapInfo } from '@s2u/archive';
import { loadMap, transferables, type LoadedMap, type LoadStage } from './loadMap';

/**
 * The decode thread. A 12 MB archive, 416 VIF packets and 37 palettised textures are a few hundred
 * milliseconds of tight loops; done here the page keeps rendering and the camera keeps moving while a map
 * comes in. Everything it sends back travels in the transfer list, so nothing is copied.
 */

/**
 * What the page asks of this worker. Every request carries an `id` that its answer repeats: two loads can
 * be in flight at once (the boot auto-load and a map the player picked a moment later), they finish in
 * whatever order their archives decode in, and the page must be able to tell the answer it still wants
 * from the one it has moved on from.
 */
export type ViewerRequest =
  | { kind: 'index'; id: number; baseUrl: string }
  | { kind: 'load'; id: number; baseUrl: string; path: string };

/**
 * What comes back. `error` carries the request that failed so the page can say what it was doing, and
 * `progress` arrives repeatedly during a load so the page can show a bar rather than a frozen picture.
 *
 * A progress message is advisory: it carries the same `id`, and the page drops the ones whose id it has
 * moved on from, exactly as it drops a stale map.
 */
export type ViewerResponse =
  | { kind: 'index'; id: number; maps: MapInfo[] }
  | { kind: 'map'; id: number; map: LoadedMap }
  | { kind: 'progress'; id: number; stage: LoadStage; done: number; total: number }
  | { kind: 'error'; id: number; doing: string; message: string };

/** Worker globals without pulling the WebWorker lib in beside the DOM one (they collide on `self`). */
const ctx = self as unknown as {
  postMessage(message: ViewerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent<ViewerRequest>) => void): void;
};

const sources = new Map<string, AssetSource>();
const sourceFor = (baseUrl: string): AssetSource => {
  const known = sources.get(baseUrl);
  if (known) return known;
  const made = new HttpAssetSource(baseUrl);
  sources.set(baseUrl, made);
  return made;
};

ctx.addEventListener('message', (event: MessageEvent<ViewerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.kind === 'index') {
        // The served index already carries every map's name (`extract-maps.ts` read each `mission.rdr`
        // once), so filling the picker costs one small fetch. `listMaps` -- which reads all 22 archives,
        // 224 MB -- is what a source with no such index needs, and that is the ISO of M5.
        const source = sourceFor(request.baseUrl);
        const maps = source instanceof HttpAssetSource ? await source.maps() : await listMaps(source);
        ctx.postMessage({ kind: 'index', id: request.id, maps });
      } else {
        // Throttled to one message per stage per 2 percent: a 13 MB archive arrives in hundreds of
        // chunks, and posting each one costs more than the bar is worth.
        let last = -1;
        const map = await loadMap(sourceFor(request.baseUrl), request.path, (stage, done, total) => {
          const step = total > 0 ? Math.floor((done / total) * 50) : done;
          const mark = stage.charCodeAt(0) * 1000 + step;
          if (mark === last) return;
          last = mark;
          ctx.postMessage({ kind: 'progress', id: request.id, stage, done, total });
        });
        ctx.postMessage({ kind: 'map', id: request.id, map }, transferables(map));
      }
    } catch (e) {
      const doing = request.kind === 'index' ? 'listing the maps' : `loading ${request.path}`;
      ctx.postMessage({ kind: 'error', id: request.id, doing, message: e instanceof Error ? e.message : String(e) });
    }
  })();
});
