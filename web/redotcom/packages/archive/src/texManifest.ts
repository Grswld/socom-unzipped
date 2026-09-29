import type { RdrNode } from './rdr';

/**
 * A texture's detail record in the manifest: the second texture the engine draws over it close up.
 *
 * - `name`: the detail texture, found by name in the map's texture libraries like any other.
 * - `uv`: the factor the second pass multiplies `S`,`T` by -- the float the `0x30`/`0x32` VU1 handlers
 *   scale the staging `ST` with (`web/packages/mesh/SEMANTICS.md` §7 and §11.6). 2 to 10 on the disc.
 * - `range`: a *squared* distance in world units, as the field it becomes is named:
 *   `tag_DETAIL_PARAMS.m_range_sqd_to_camera` (`research/recom/src/gamez/zVisual/zvis.h:96-99`), compared
 *   with the camera's range squared (`zRender/zrndr_pipe.cpp:311-322`). 90000 is 300 units, 250000 500.
 * - `bmode`: the blend, by name. `COLORBLEND` and `ADDITIVE` are the only two on the disc.
 */
export interface TexDetail { name: string; uv: number; range: number; bmode: string }

/** One texture of `mp<N>_lib.rdr` (web/docs/research/72 §6). */
export interface TexEntry {
  /** As the manifest spells it; the map is keyed lower-cased, the way the chains' citations are compared. */
  name: string;
  /** `dim2 (w h bpp)`. */
  dim2: { width: number; height: number; bpp: number } | undefined;
  /** The wrap mode per axis as the exporter wrote it. The bind packet's `CLAMP_1` is what the viewer draws with. */
  typeU: number | undefined;
  typeV: number | undefined;
  /** The bare `pal` flag: the texture is palettised. */
  pal: boolean;
  detail: TexDetail | undefined;
}

/** A record's fields: each key with its value list, or `true` for a key that has none (a flag). */
type Fields = Map<string, RdrNode[] | true>;

/**
 * A record read as the compiled scripts write it: a key string followed by its value list, or a key
 * string alone -- `pal`, `16bitpal`, `32bitpal` are flags with no list after them. `rdrGet` takes the
 * node after a key as its value, which on an entry reading `... "pal" "detail" (...)` gives `pal` the
 * value `"detail"`; this does not.
 */
function fields(record: RdrNode): Fields {
  const out: Fields = new Map();
  if (typeof record === 'string') return out;
  for (let i = 0; i < record.length; i++) {
    const key = record[i]!;
    if (typeof key !== 'string') continue;
    const next = record[i + 1];
    if (Array.isArray(next)) { out.set(key, next); i++; } else out.set(key, true);
  }
  return out;
}

const text = (v: RdrNode[] | true | undefined): string | undefined => {
  const first = Array.isArray(v) ? v[0] : undefined;
  return typeof first === 'string' ? first : undefined;
};
const num = (v: RdrNode[] | true | undefined, at = 0): number | undefined => {
  const node = Array.isArray(v) ? v[at] : undefined;
  if (typeof node !== 'string') return undefined;
  const n = Number(node);
  return Number.isFinite(n) ? n : undefined;
};

function readDetail(value: RdrNode[] | true | undefined): TexDetail | undefined {
  if (!Array.isArray(value)) return undefined;
  const f = fields(value);
  const name = text(f.get('name')), uv = num(f.get('uv')), range = num(f.get('range')), bmode = text(f.get('bmode'));
  if (name === undefined || uv === undefined || range === undefined || bmode === undefined) return undefined;
  return { name, uv, range, bmode };
}

/** The one library record of a compiled script, looked through the root list that wraps it. */
function libraryRecord(rdr: RdrNode): Fields {
  let node = rdr;
  while (Array.isArray(node) && node.length === 1 && Array.isArray(node[0])) node = node[0];
  return fields(node);
}

/**
 * Reads the texture manifest `mp<N>_lib.rdr` out of `READERM.ZAR` (web/docs/research/72 §6), keyed by
 * lower-cased texture name.
 *
 * A name listed twice keeps its **first** entry: Blizzard's `mp1_lib.rdr` lists `alaska4d_snow02.tif`
 * twice with different detail records, and all 56 visuals drawn with it carry the first one's `uv` and
 * `range` in their `detail_buff` -- the second never reached the disc's geometry. An entry with no name
 * is skipped. Nothing here decides what the viewer draws; see `viewer/src/materialSpec.ts`.
 */
export function readTexManifest(rdr: RdrNode): Map<string, TexEntry> {
  const out = new Map<string, TexEntry>();
  const textures = libraryRecord(rdr).get('textures');
  if (!Array.isArray(textures)) return out;
  for (const entry of textures) {
    const f = fields(entry);
    const name = text(f.get('name'));
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (out.has(key)) continue;
    const dim2 = f.get('dim2');
    const [width, height, bpp] = [num(dim2, 0), num(dim2, 1), num(dim2, 2)];
    out.set(key, {
      name,
      dim2: width !== undefined && height !== undefined && bpp !== undefined ? { width, height, bpp } : undefined,
      typeU: num(f.get('typeU')),
      typeV: num(f.get('typeV')),
      pal: f.get('pal') === true,
      detail: readDetail(f.get('detail')),
    });
  }
  return out;
}
