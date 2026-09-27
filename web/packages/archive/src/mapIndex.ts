import type { AssetSource } from './assetSource';
import { parseZdb, zdbMember } from './zdb';
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
 * Every `RUN/MP*.ZDB` in the source, named from its own `mission.rdr` rather than from a table typed out
 * of 36 §0, sorted by archive number (MP1, MP2, MP5, ... MP83; MP3 and MP4 do not exist).
 *
 * Each archive is read whole -- 224 MB over the 22 -- so this is a node-side or build-time call, not a page
 * load. `tools/extract-maps.ts` calls it once and writes the answer into `public/maps/index.json`, which is
 * what `HttpAssetSource.maps()` serves to the viewer; this stays the path for a source that has no such
 * index, which is the ISO of milestone M5.
 */
export async function listMaps(source: AssetSource): Promise<MapInfo[]> {
  const paths = (await source.list()).filter((p) => MAP_ARCHIVE.test(p));
  const out: MapInfo[] = [];
  for (const path of paths) {
    const bytes = await source.read(path);
    const toc = parseZdb(bytes);
    // 36 §6: the scripts are the root children of READERM.ZAR, named with their .rdr suffix.
    const readerm = Zar.parse(zdbMember(bytes, toc, 'READERM.ZAR'));
    const mission = readerm.root.children.find((k) => k.name.toLowerCase() === 'mission.rdr');
    if (!mission) throw new Error(`${path}: READERM.ZAR has no mission.rdr`);
    const name = rdrGet(parseRdr(readerm.data(mission)), 'description');
    if (typeof name !== 'string') throw new Error(`${path}: mission.rdr has no description`);
    out.push({ archive: mapArchiveId(path)!, path, name });
  }
  return out.sort((a, b) => Number(a.archive.slice(2)) - Number(b.archive.slice(2)));
}
