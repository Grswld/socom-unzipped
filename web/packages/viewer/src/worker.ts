import { HttpAssetSource, IsoAssetSource, listMaps, type AssetSource, type MapInfo } from '@s2u/archive';
import { loadMap, transferables, type LoadedMap, type LoadStage } from './loadMap';
import { playFromDisc, playTransferables, type PlayData } from './motionTable';
import { soundFromDisc, soundTransferables, type SoundData } from './soundData';

/**
 * The decode thread. A 12 MB archive, 416 VIF packets and 37 palettised textures are a few hundred
 * milliseconds of tight loops; done here the page keeps rendering and the camera keeps moving while a map
 * comes in. Everything it sends back travels in the transfer list, so nothing is copied.
 */

/**
 * Where a request's archives come from (design spec §3.1): the served disc tree under a base URL, or the
 * player's own disc image (W1.7, milestone M5). A `File` crosses to the worker by structured clone as a
 * handle on the file, not a copy of its bytes, so posting it with every request costs nothing.
 */
export type SourceRequest = { kind: 'http'; baseUrl: string } | { kind: 'iso'; file: File };

/**
 * What the page asks of this worker. Every request carries an `id` that its answer repeats: two loads can
 * be in flight at once (the boot auto-load and a map the player picked a moment later), they finish in
 * whatever order their archives decode in, and the page must be able to tell the answer it still wants
 * from the one it has moved on from.
 */
export type ViewerRequest =
  | { kind: 'index'; id: number; source: SourceRequest }
  | { kind: 'load'; id: number; source: SourceRequest; path: string }
  /** The play mode's clips (W2.2b): `RUN/MOTION_P.ZAR`'s named clips and `motion.rdr`'s entries for them, once a source. */
  | { kind: 'play'; id: number; source: SourceRequest; clips: string[] }
  /** A map's sound (web/docs/research/81, `./soundData`): its banks, the script, the materials, the weapons, the callbacks. */
  | { kind: 'sound'; id: number; source: SourceRequest; path: string; archive: string };

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
  /** The clips and their table entries, or null when the source has no `MOTION_P.ZAR` (the body keeps its bind pose). */
  | { kind: 'play'; id: number; data: PlayData | null }
  /** The map's sound data, or null when the source has no `SOUNDS/BNKSTORE.ZAR` (the walk is silent). */
  | { kind: 'sound'; id: number; data: SoundData | null }
  | { kind: 'error'; id: number; doing: string; message: string };

/** Worker globals without pulling the WebWorker lib in beside the DOM one (they collide on `self`). */
const ctx = self as unknown as {
  postMessage(message: ViewerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: MessageEvent<ViewerRequest>) => void): void;
};

const served = new Map<string, AssetSource>();
/**
 * The disc image last opened, kept so its directories are walked once rather than once a request. Each
 * request's `File` is a fresh clone, so it is recognised by what the page's file carries -- name, size and
 * modification time -- and a different disc replaces it.
 */
let disc: { key: string; source: IsoAssetSource } | null = null;
const sourceFor = (request: SourceRequest): AssetSource => {
  if (request.kind === 'iso') {
    const { file } = request;
    const key = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
    if (disc?.key !== key) disc = { key, source: new IsoAssetSource(file) };
    return disc.source;
  }
  const known = served.get(request.baseUrl);
  if (known) return known;
  const made = new HttpAssetSource(request.baseUrl);
  served.set(request.baseUrl, made);
  return made;
};

ctx.addEventListener('message', (event: MessageEvent<ViewerRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.kind === 'index') {
        // The served index already carries every map's name (`extract-maps.ts` read each `mission.rdr`
        // once), so filling the picker costs one small fetch. A disc image has no such index, so
        // `listMaps` names its maps -- by range, each archive's table of contents and `READERM.ZAR`, tens
        // of kilobytes apiece rather than the 224 MB of all 22.
        const source = sourceFor(request.source);
        const maps = source instanceof HttpAssetSource ? await source.maps() : await listMaps(source);
        ctx.postMessage({ kind: 'index', id: request.id, maps });
      } else if (request.kind === 'sound') {
        // Never an error either: without the banks the walk is silent.
        const data = await soundFromDisc(sourceFor(request.source), request.path, request.archive);
        ctx.postMessage({ kind: 'sound', id: request.id, data }, data ? soundTransferables(data) : []);
      } else if (request.kind === 'play') {
        // Never an error either: without the owner's pack the body stands in its bind pose.
        const data = await playFromDisc(sourceFor(request.source), request.clips);
        ctx.postMessage({ kind: 'play', id: request.id, data }, data ? playTransferables(data) : []);
      } else {
        // Throttled to one message per stage per 2 percent: a 13 MB archive arrives in hundreds of
        // chunks, and posting each one costs more than the bar is worth.
        let last = -1;
        const map = await loadMap(sourceFor(request.source), request.path, (stage, done, total) => {
          const step = total > 0 ? Math.floor((done / total) * 50) : done;
          const mark = stage.charCodeAt(0) * 1000 + step;
          if (mark === last) return;
          last = mark;
          ctx.postMessage({ kind: 'progress', id: request.id, stage, done, total });
        });
        ctx.postMessage({ kind: 'map', id: request.id, map }, transferables(map));
      }
    } catch (e) {
      const doing = request.kind === 'load' ? `loading ${request.path}`
        : request.source.kind === 'iso' ? `reading the disc image ${request.source.file.name}` : 'listing the maps';
      ctx.postMessage({ kind: 'error', id: request.id, doing, message: e instanceof Error ? e.message : String(e) });
    }
  })();
});
