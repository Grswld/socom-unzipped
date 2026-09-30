import { HttpAssetSource, IsoAssetSource, type AssetSource, type MapInfo } from '@s2u/archive';
import { listDiscMaps, type IndexProblem } from './discIndex';
import { loadMap, transferables, type LoadedMap, type LoadStage } from './loadMap';
import { playFromDisc, playTransferables, type PlayData } from './motionTable';
import {
  loopTransferables, renderAmbienceLoops, renderReverb, reverbTransferables, soundFromDisc, soundTransferables, type SoundData,
} from './soundData';
import { LONG_LOOP_SECONDS_PLACEHOLDER, LOOP_FADE_SECONDS_PLACEHOLDER, LOOP_SECONDS_PLACEHOLDER } from './loopLength';
import type { RenderedSound } from '@s2u/sound';
import { effectsFromDisc, effectTransferables, type EffectData } from './effectData';

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
  /** A map's sound (web/redotcom/docs/research/81, `./soundData`): its banks, the script, the materials, the weapons, the callbacks. */
  | { kind: 'sound'; id: number; source: SourceRequest; path: string; archive: string }
  /** EFFECTS: a map's effect programs, models, textures and mark tables (web/redotcom/docs/research/89, `./effectData`). */
  | { kind: 'effects'; id: number; source: SourceRequest; path: string; archive: string };

/**
 * What comes back. `error` carries the request that failed so the page can say what it was doing, and
 * `progress` arrives repeatedly during a load so the page can show a bar rather than a frozen picture.
 *
 * A progress message is advisory: it carries the same `id`, and the page drops the ones whose id it has
 * moved on from, exactly as it drops a stale map.
 */
export type ViewerResponse =
  /** `problems`: the archives a disc image holds that would not name themselves, and why (`./discIndex`). */
  | { kind: 'index'; id: number; maps: MapInfo[]; problems: IndexProblem[] }
  | { kind: 'map'; id: number; map: LoadedMap }
  | { kind: 'progress'; id: number; stage: LoadStage; done: number; total: number }
  /** The clips and their table entries, or null when the source has no `MOTION_P.ZAR` (the body keeps its bind pose). */
  | { kind: 'play'; id: number; data: PlayData | null }
  /** The map's sound data; with no `SOUNDS/BNKSTORE.ZAR` it holds no banks and names the archive in `missing`. */
  | { kind: 'sound'; id: number; data: SoundData }
  /** The same map's beds and emitters rendered as loops, after its sound data (`renderAmbienceLoops`). */
  | { kind: 'soundLoops'; id: number; loops: { name: string; sound: RenderedSound }[] }
  /** The map's effect data: whatever would not read is left out and said in its `missing`. */
  | { kind: 'effects'; id: number; data: EffectData }
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
        // of kilobytes apiece rather than the 224 MB of all 22 -- and says which archive would not name itself, and why.
        const source = sourceFor(request.source);
        const { maps, problems } = source instanceof HttpAssetSource ? { maps: await source.maps(), problems: [] }
          : await listDiscMaps(source);
        ctx.postMessage({ kind: 'index', id: request.id, maps, problems });
      } else if (request.kind === 'sound') {
        // Never an error either: without the banks the walk is silent.
        const data = await soundFromDisc(sourceFor(request.source), request.path, request.archive);
        data.loopsFollow = true;
        // The loops are rendered from the bank bytes before those are handed over, and sent after the data.
        const loops = renderAmbienceLoops(data, LOOP_SECONDS_PLACEHOLDER, LOOP_FADE_SECONDS_PLACEHOLDER, LONG_LOOP_SECONDS_PLACEHOLDER);
        renderReverb(data);                           // the reverb's response here, not on the page's unlock
        ctx.postMessage({ kind: 'sound', id: request.id, data }, [...soundTransferables(data), ...reverbTransferables(data)]);
        ctx.postMessage({ kind: 'soundLoops', id: request.id, loops }, loopTransferables(loops));
      } else if (request.kind === 'effects') {
        // Never an error either: a part that will not read is left out and named in `missing`.
        const data = await effectsFromDisc(sourceFor(request.source), request.path, request.archive);
        ctx.postMessage({ kind: 'effects', id: request.id, data }, effectTransferables(data));
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
