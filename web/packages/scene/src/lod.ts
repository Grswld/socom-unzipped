import type { RdrNode } from '@s2u/archive';

/**
 * A level-of-detail band out of `READERM.ZAR/lod.rdr`: the range a model fades in over and the range
 * it fades out over, in world units. `[0, 0]` for a near copy's fade-in.
 *
 * The binary twin in the world root, `LOD_Object`, holds the same numbers squared (`CLOD_band`,
 * `zRender/zrender.h:186`: `m_minRangeNearSq`, `m_minRangeFarSq`, `m_maxRangeNearSq`, `m_maxRangeFarSq`)
 * and `CVisual::DrawLOD` compares the camera's range squared against them, so the range is a plain
 * distance from the camera.
 */
export interface LodBand {
  nearFade: [number, number];
  farFade: [number, number];
}

/**
 * The map's level-of-detail table, `READERM.ZAR/lod.rdr`, as a band per model.
 *
 * The record is two lists. `LOD_Definititions` (sic) names bands, each with a `nearFade` and a
 * `farFade` pair of distances; `LOD_Connection` puts model names into a band through an
 * `ObjectList`. Frostfire: `railings_high` fades in at 0 and out at 100-120, `railings_low` fades in
 * at 100-120 and out at 420-440, and the graph places *both* sets of railings at the same spot. The
 * engine (`CVisual::DrawLOD`) shows one or the other by camera range; drawn together they z-fight.
 */
export function lodBands(rdr: RdrNode): Map<string, LodBand> {
  const bands = new Map<string, LodBand>();
  const out = new Map<string, LodBand>();
  const list = (node: RdrNode, key: string): RdrNode[] => {
    if (!Array.isArray(node)) return [];
    const at = node.indexOf(key);
    const value = at >= 0 ? node[at + 1] : undefined;
    return Array.isArray(value) ? value : [];
  };
  const pair = (node: RdrNode, key: string): [number, number] => {
    const v = list(node, key);
    const a = typeof v[0] === 'string' ? Number(v[0]) : 0;
    const b = typeof v[1] === 'string' ? Number(v[1]) : a;
    return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0];
  };
  const root = Array.isArray(rdr) && rdr.length === 1 && Array.isArray(rdr[0]) ? rdr[0] : rdr;
  for (const band of list(root, 'LOD_Definititions')) {
    if (!Array.isArray(band) || typeof band[0] !== 'string') continue;
    bands.set(band[0], { nearFade: pair(band, 'nearFade'), farFade: pair(band, 'farFade') });
  }
  for (const link of list(root, 'LOD_Connection')) {
    if (!Array.isArray(link)) continue;
    // `["LODTYPE1", "<band>", "ObjectList", [...names]]`: the band is the string before `ObjectList`.
    const at = link.indexOf('ObjectList');
    const name = at >= 1 ? link[at - 1] : undefined;
    const band = typeof name === 'string' ? bands.get(name) : undefined;
    if (!band) continue;
    for (const model of list(link, 'ObjectList')) if (typeof model === 'string') out.set(model, band);
  }
  return out;
}

/** The models that are far copies: in a band whose fade-in starts above zero. */
export function farLodModels(rdr: RdrNode): Set<string> {
  const far = new Set<string>();
  for (const [model, band] of lodBands(rdr)) if (band.nearFade[0] > 0) far.add(model);
  return far;
}

/**
 * Whether a model in a band is shown at a camera range. The engine fades one copy out while the
 * other fades in across the overlap (`DrawLOD` scales the opacity by where in the band the range
 * falls); without a fade the copy switches at the middle of each ramp, which is where the two would
 * have crossed at half opacity.
 */
export function lodVisible(band: LodBand, range: number): boolean {
  const from = (band.nearFade[0] + band.nearFade[1]) / 2;
  const to = (band.farFade[0] + band.farFade[1]) / 2;
  return range >= from && range < to;
}
