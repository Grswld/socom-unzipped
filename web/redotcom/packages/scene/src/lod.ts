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
 * The opacity of a model in a band at a camera range squared, as `CVisual::DrawLOD` scales it: 0 outside
 * the band, 1 on its plateau, and a ramp linear in the range *squared* across each fade -- rising over the
 * near fade, `m_minInvDeltaRangeSq * (rangeSq - m_minRangeNearSq)`, and its mirror falling over the far
 * fade. Where a near copy's far fade is its successor's near fade (Frostfire's railings, 100-120 units)
 * the two sum to 1 at every range; each is at half at 110.45 units, where the range squared is halfway.
 *
 * reCOM's `DrawLOD` (`zVisual/vis_main.cpp:305-317`), transcribed exactly, is three tests and a scale:
 *
 *     if (lod->m_minRangeNearSq < range || lod->m_maxRangeFarSq > range) return false;
 *     if (!lod->m_minFade) return false;
 *     if (lod->m_minRangeFarSq < range || lod->m_maxRangeFarSq > range) return false;
 *     *distance *= lod->m_minInvDeltaRangeSq * (range - lod->m_minRangeNearSq);
 *
 * Taken as read, the comparisons are reversed (the first rejects every range inside the band), and the
 * second range test repeats the first -- its `m_maxRangeFarSq > range` half is the first's, and its other
 * half can only fire where the first already has -- so it is a transcription of a test that was surely
 * the near fade's own (`range < m_minRangeFarSq`: on the ramp, else full). What is used here is the
 * reading the band and the disc support: outside `[m_minRangeNearSq, m_maxRangeFarSq]` not drawn, the
 * ramp across the near fade where `m_minFade` is set, and its mirror across the far fade where
 * `m_maxFade` is. The disc's `LOD_Object` (the world root; `test/lod.test.ts`) stores
 * `m_minInvDeltaRangeSq` as `1 / (m_minRangeFarSq - m_minRangeNearSq)` -- 1/4400 for the railings -- and
 * at +20 a float reCOM's `CLOD_band` (`zRender/zrender.h:180-192`) lacks, the far fade's own inverse
 * delta, with the two fade bits after it; on the three fixture maps a fade is flagged exactly where its
 * two ends differ, so the ends alone say whether to ramp. The range is a plain distance: `CPipe::
 * RenderVisual` passes `GetScaledRangeSquared` (`zRender/zrndr_pipe.cpp:371`), a stub in reCOM
 * (`zCamera/zcam.h:181`), and the viewer has no zoom to scale by.
 *
 * `last` keeps the plateau open outward: the last copy at a spot is never faded or culled by its far
 * edge (`lodIsLast`, `e92b071c`), though it still fades in.
 */
export function lodOpacity(band: LodBand, rangeSq: number, last = false): number {
  const minNearSq = band.nearFade[0] * band.nearFade[0];
  const minFarSq = band.nearFade[1] * band.nearFade[1];
  const maxNearSq = band.farFade[0] * band.farFade[0];
  const maxFarSq = band.farFade[1] * band.farFade[1];
  if (rangeSq < minNearSq || (!last && rangeSq > maxFarSq)) return 0;
  let opacity = 1;
  // Divided rather than multiplied by the reciprocal the disc stores: the same ramp, without its rounding.
  if (rangeSq < minFarSq) opacity *= (rangeSq - minNearSq) / (minFarSq - minNearSq);
  if (!last && rangeSq > maxNearSq) opacity *= (maxFarSq - rangeSq) / (maxFarSq - maxNearSq);
  return opacity;
}

/**
 * Whether a model in a band is drawn at a camera range (a plain distance, not squared): wherever
 * `lodOpacity` is above zero. Across a crossover both copies are drawn, one fading in as the other fades
 * out, as the engine draws them; it used to switch at the middle of each fade instead.
 */
export function lodVisible(band: LodBand, range: number, last = false): boolean {
  return lodOpacity(band, range * range, last) > 0;
}

/**
 * Whether a copy in `band` is the last one at its spot: none of the `others` placed there fades in
 * later. The engine culls every copy past its far fade, and on the disc that edge sits inside the
 * fog (Frostfire's grates end at 500 units where the fog runs 200..640), so nothing is seen to go.
 * The viewer's camera goes where the game's never does and its fog can be off, and there a culled
 * last copy is a hole: a floor grate or a tank catwalk gone at 50 m. So the last copy is kept at
 * every range (`lodOpacity(..., last)`), and only a copy with a successor still fades out for it.
 */
export function lodIsLast(band: LodBand, others: Iterable<LodBand>): boolean {
  const from = (band.nearFade[0] + band.nearFade[1]) / 2;
  for (const other of others) {
    if (other !== band && (other.nearFade[0] + other.nearFade[1]) / 2 > from) return false;
  }
  return true;
}
