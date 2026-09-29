import { parseRdr, rdrGet, Zar, type RdrNode } from '@s2u/archive';

/**
 * The surface materials, `READERC.ZAR/materials.rdr`'s `SOILS` list (web/docs/research/81 §4), as `FUN_002dde40`
 * (decomp 181253-181468) reads it into the table at `0x44f350`. Before the file's records, `FUN_002de4b0`
 * (decomp 181496-181567) appends two of the engine's own, `UNKNOWN` (0) and `PARTICLE_SYSTEM` (1), with no sounds;
 * then one record a list entry that has a `NAME` -- an entry without one is dropped, not kept as a hole -- in the
 * file's order from 2 on. A record's place is the number a collision polygon's `material` byte carries (`DAT_0044f358[m]`, which the ground probe, the
 * footstep and the landing index). The sound keys are turned into sound handles by name (`FUN_00344f30`):
 * `STEPSOUND` +0x08, `STEALTH_STEPSOUND` +0x0c, `CRAWLSOUND` +0x10, `LANDSOUND` +0x14, `FALLSOUND` +0x18 (the body
 * falling, not the SEAL landing: `FUN_0059a8e0`, `BODY_FALL_ON_MATERIAL_SOUND`); `STEALTH_FACTOR` +0x34,
 * `FOOT_STEP_OFFSET` +0x38.
 */
export interface Material {
  index: number;
  name: string;
  step: string | null;
  stealthStep: string | null;
  crawl: string | null;
  land: string | null;
  fall: string | null;
  stealthFactor: number | null;
  footStepOffset: number | null;
}

const text = (record: RdrNode, key: string): string | null => {
  const v = rdrGet(record, key);
  return typeof v === 'string' ? v : null;
};
const real = (record: RdrNode, key: string): number | null => {
  const v = rdrGet(record, key);
  return typeof v === 'string' && Number.isFinite(Number(v)) ? Number(v) : null;
};

/** The two records `FUN_002de4b0` appends ahead of the file's (strings at 0x3f3800 and 0x3f3810). */
export const BUILTIN_MATERIALS: readonly string[] = ['UNKNOWN', 'PARTICLE_SYSTEM'];

const silent = (index: number, name: string): Material => ({
  index, name, step: null, stealthStep: null, crawl: null, land: null, fall: null, stealthFactor: null, footStepOffset: null,
});

/** The material table: the engine's two, then the `SOILS` records of a decoded `materials.rdr`, indexed as the game indexes them. */
export function parseSoils(root: RdrNode): Material[] {
  const soils = rdrGet(root, 'SOILS');
  if (!Array.isArray(soils)) throw new Error('materials.rdr has no SOILS');
  const out: Material[] = BUILTIN_MATERIALS.map((name, i) => silent(i, name));
  for (const record of soils) {
    if (!Array.isArray(record)) continue;
    const name = text(record, 'NAME');
    if (name === null) continue;
    out.push({
      index: out.length, name,
      step: text(record, 'STEPSOUND'), stealthStep: text(record, 'STEALTH_STEPSOUND'), crawl: text(record, 'CRAWLSOUND'),
      land: text(record, 'LANDSOUND'), fall: text(record, 'FALLSOUND'),
      stealthFactor: real(record, 'STEALTH_FACTOR'), footStepOffset: real(record, 'FOOT_STEP_OFFSET'),
    });
  }
  return out;
}

/** `READERC.ZAR`'s `materials.rdr`, decoded. */
export function materialsFromArchive(readerc: Uint8Array): Material[] {
  const zar = Zar.parse(readerc);
  const key = zar.root.children.find((k) => k.name.toLowerCase() === 'materials.rdr');
  if (!key) throw new Error('READERC.ZAR has no materials.rdr');
  return parseSoils(parseRdr(zar.data(key)));
}
