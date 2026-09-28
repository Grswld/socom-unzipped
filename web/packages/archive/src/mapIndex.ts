import { isRanged, type AssetSource, type RangedAssetSource } from './assetSource';
import { parseZdb, zdbEntry, zdbMember, zdbTocLength, ZDB_HEAD } from './zdb';
import { Zar } from './zar';
import { parseRdr, rdrGet } from './rdr';

/** One multiplayer map: its archive id, the path its bytes live at, and the name the game shows. */
export interface MapInfo { archive: string; path: string; name: string }

const MAP_ARCHIVE = /^RUN\/(MP\d+)\.ZDB$/i;

/** The archive id a disc path names -- `RUN/MP2.ZDB` -> `MP2` -- or null when it is not a map archive. */
export function mapArchiveId(path: string): string | null {
  return MAP_ARCHIVE.exec(path)?.[1]?.toUpperCase() ?? null;
}

/**
 * The archives every map shares, copied out of the disc's `RUN/` beside the map archives by
 * `tools/extract-maps.ts` (web sprint 2, W2.R5): `READERC.ZAR`, the character scripts (`dynamics.rdr`,
 * `motion.rdr`, ...), `ZWEAPON.ZAR`, the weapon table, and the player's motion packs -- `MOTION_P.ZAR`, the
 * skeletal clips (web/docs/research/77), and `MPZANIM.ZAR`, the multiplayer zAnim sets.
 */
export const COMMON_ARCHIVES: readonly string[] = ['RUN/READERC.ZAR', 'RUN/ZWEAPON.ZAR', 'RUN/MOTION_P.ZAR', 'RUN/MPZANIM.ZAR'];

/** `public/maps/index.json`: the maps for the picker, and the common archives served beside them. */
export interface ServedIndex { maps: MapInfo[]; common: string[] }

/** The index `tools/extract-maps.ts` writes. */
export function servedIndex(maps: MapInfo[], common: readonly string[] = COMMON_ARCHIVES): ServedIndex {
  return { maps, common: [...common] };
}

/**
 * Reads an `index.json` of any age: the sprint-2 object `{ maps, common }` (a key it does not know is
 * ignored), the earlier array of `MapInfo`, or the first array of bare paths -- whose entries carry no
 * name, so the archive id stands in. The two arrays have no common archives.
 */
export function parseServedIndex(json: unknown): ServedIndex {
  const entry = (e: string | MapInfo): MapInfo => {
    if (typeof e !== 'string') return e;
    const archive = mapArchiveId(e) ?? e;
    return { archive, path: e, name: archive };
  };
  if (Array.isArray(json)) return { maps: (json as (string | MapInfo)[]).map(entry), common: [] };
  if (json !== null && typeof json === 'object' && Array.isArray((json as { maps?: unknown }).maps)) {
    const { maps, common } = json as { maps: (string | MapInfo)[]; common?: unknown };
    return { maps: maps.map(entry), common: Array.isArray(common) ? common.filter((c): c is string => typeof c === 'string') : [] };
  }
  throw new Error('index.json is neither a list of maps nor { maps, common }');
}

/**
 * Every `RUN/MP*.ZDB` in the source, named from its own `mission.rdr` rather than from a table typed out
 * of 36 §0, sorted by archive number (MP1, MP2, MP5, ... MP83; MP3 and MP4 do not exist).
 *
 * Over a source that reads by range (`RangedAssetSource`: the player's ISO, milestone M5) each archive
 * costs its header, its table of contents and its `READERM.ZAR` -- tens of kilobytes -- so it is a page
 * load. Over any other source each archive is read whole, 224 MB over the 22: a node-side or build-time
 * call, which is how `tools/extract-maps.ts` writes `public/maps/index.json` for `HttpAssetSource.maps()`.
 */
export async function listMaps(source: AssetSource): Promise<MapInfo[]> {
  const paths = (await source.list()).filter((p) => MAP_ARCHIVE.test(p));
  const out: MapInfo[] = [];
  for (const path of paths) {
    // 36 §6: the scripts are the root children of READERM.ZAR, named with their .rdr suffix.
    const readerm = isRanged(source) ? await readermByRange(source, path) : readermOf(await source.read(path));
    const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
    if (!mission) throw new Error(`${path}: READERM.ZAR has no mission.rdr`);
    const name = rdrGet(parseRdr(readerm.data(mission)), 'description');
    if (typeof name !== 'string') throw new Error(`${path}: mission.rdr has no description`);
    out.push({ archive: mapArchiveId(path)!, path, name });
  }
  return out.sort((a, b) => Number(a.archive.slice(2)) - Number(b.archive.slice(2)));
}

/** `READERM.ZAR` out of a whole archive. */
function readermOf(bytes: Uint8Array): Zar {
  return Zar.parse(zdbMember(bytes, parseZdb(bytes), 'READERM.ZAR'));
}

/**
 * `READERM.ZAR` read on its own: the 0xA0-byte header says how long the table of contents is (36 §1),
 * the table says where the member lies, and only those three ranges of the archive are fetched.
 */
async function readermByRange(source: RangedAssetSource, path: string): Promise<Zar> {
  const size = await source.size(path);
  const head = await source.readRange(path, 0, Math.min(ZDB_HEAD, size));
  const toc = parseZdb(await source.readRange(path, 0, Math.min(zdbTocLength(head), size)), size);
  const entry = zdbEntry(toc, 'READERM.ZAR');
  return Zar.parse(await source.readRange(path, entry.offset, entry.size));
}
