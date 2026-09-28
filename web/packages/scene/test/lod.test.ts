import { describe, expect, it } from 'vitest';
import { farLodModels, lodBands, lodIsLast, lodOpacity, lodVisible } from '../src/lod';
import { parseZdb, zdbMember, Zar, type RdrNode } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';

/**
 * `lod.rdr` as Frostfire ships it (`READERM.ZAR`), trimmed: bands with fade ranges, and lists of the
 * models in each. The near copies start at 0; the far copies start further out; the graph places both
 * at the same spot and the engine shows one by camera range.
 */
const FROSTFIRE: RdrNode = [[
  'LOD_Definititions', [
    ['midgrate', 'nearFade', ['0', '0'], 'farFade', ['360', '360']],
    ['lowgrate', 'nearFade', ['260', '260'], 'farFade', ['500', '500']],
    ['railings_high', 'nearFade', ['0', '0'], 'farFade', ['100', '120']],
    ['railings_low', 'nearFade', ['100', '120'], 'farFade', ['420', '440']],
    ['furniture', 'nearFade', ['0', '0'], 'farFade', ['250', '260']],
  ],
  'LOD_Connection', [
    ['LODTYPE1', 'midgrate', 'ObjectList', ['grate_midlod']],
    ['LODTYPE1', 'lowgrate', 'ObjectList', ['grate_lowlod']],
    ['LODTYPE1', 'railings_high', 'ObjectList', ['railstraithi1', 'railcornerhi1']],
    ['LODTYPE1', 'railings_low', 'ObjectList', ['railstraitlo1', 'railcornerlo1', 'tankrailbarslo']],
    ['LODTYPE1', 'furniture', 'ObjectList', ['chair_office']],
  ],
]];

describe('lodBands', () => {
  it('gives every listed model its band, with both fade ranges', () => {
    const bands = lodBands(FROSTFIRE);
    expect(bands.get('railstraithi1')).toEqual({ nearFade: [0, 0], farFade: [100, 120] });
    expect(bands.get('railstraitlo1')).toEqual({ nearFade: [100, 120], farFade: [420, 440] });
    expect(bands.get('grate_midlod')).toEqual({ nearFade: [0, 0], farFade: [360, 360] });
    expect(bands.size).toBe(8);
  });

  it('is empty for a record with no LOD lists, and for one that is not a record at all', () => {
    expect(lodBands([['LOD_Definititions', []]]).size).toBe(0);
    expect(lodBands('nothing').size).toBe(0);
    expect(lodBands([]).size).toBe(0);
  });

  it('ignores a connection whose band was never defined', () => {
    const rdr: RdrNode = [['LOD_Definititions', [], 'LOD_Connection', [['LODTYPE1', 'ghost', 'ObjectList', ['x']]]]];
    expect(lodBands(rdr).size).toBe(0);
  });
});

describe('farLodModels', () => {
  it('names the models in a band that fades in above zero, and none from a band that starts at zero', () => {
    expect([...farLodModels(FROSTFIRE)].sort()).toEqual(['grate_lowlod', 'railcornerlo1', 'railstraitlo1', 'tankrailbarslo']);
  });
});

describe('lodOpacity (CVisual::DrawLOD, reCOM zVisual/vis_main.cpp:305-317)', () => {
  const high = lodBands(FROSTFIRE).get('railstraithi1')!;
  const low = lodBands(FROSTFIRE).get('railstraitlo1')!;
  const at = (band: typeof high, units: number, last = false) => lodOpacity(band, units * units, last);

  it('fades the railings across their crossover: the low copy comes in over 100-120 units as the high one goes', () => {
    // The ramp is in the range *squared*, as DrawLOD's is: at 110 units the low copy is
    // (110^2 - 100^2) / (120^2 - 100^2) = 2100 / 4400 = 21/44 in, not the 1/2 a ramp in plain units gives.
    const units = [90, 100, 110, 120, 130];
    expect(units.map((u) => at(low, u))).toEqual([0, 0, 21 / 44, 1, 1]);
    expect(units.map((u) => at(high, u))).toEqual([1, 1, 23 / 44, 0, 0]);
  });

  it('the two copies sum to one everywhere across the crossover', () => {
    for (let u = 100; u <= 120; u += 0.25) expect(at(low, u) + at(high, u)).toBeCloseTo(1, 12);
  });

  it('each copy is at half where the range squared is halfway through the fade: 110.45 units', () => {
    const half = Math.sqrt((100 * 100 + 120 * 120) / 2);
    expect(half).toBeCloseTo(110.4536, 4);
    expect(at(low, half)).toBeCloseTo(0.5, 12);
    expect(at(high, half)).toBeCloseTo(0.5, 12);
  });

  it('ramps with the slope m_minInvDeltaRangeSq: one over the fade\'s width in range squared', () => {
    const slope = 1 / (120 * 120 - 100 * 100);
    for (const rangeSq of [10000, 11000, 12345, 14000]) expect(lodOpacity(low, rangeSq)).toBeCloseTo(slope * (rangeSq - 10000), 12);
  });

  it('fades the far copy out across its far fade and culls it past it, unless it is the last copy', () => {
    expect(at(low, 420)).toBe(1);
    expect(at(low, 430)).toBeCloseTo((440 * 440 - 430 * 430) / (440 * 440 - 420 * 420), 12);
    expect(at(low, 440)).toBe(0);
    expect(at(low, 441)).toBe(0);
    for (const u of [430, 440, 441, 5000]) expect(at(low, u, true)).toBe(1);   // e92b071c: the last copy stays
    expect(at(low, 90, true)).toBe(0);                                         // ... but still fades in
    expect(at(low, 110, true)).toBe(21 / 44);
  });

  it('a band with no fade is a hard edge, drawn at both of its ends', () => {
    const mid = lodBands(FROSTFIRE).get('grate_midlod')!;    // 0,0 .. 360,360
    const far = lodBands(FROSTFIRE).get('grate_lowlod')!;    // 260,260 .. 500,500
    expect([0, 200, 360, 360.01].map((u) => at(mid, u))).toEqual([1, 1, 1, 0]);
    expect([259.99, 260, 500, 500.01].map((u) => at(far, u))).toEqual([0, 1, 1, 0]);
  });
});

describe('lodVisible', () => {
  const high = lodBands(FROSTFIRE).get('railstraithi1')!;
  const low = lodBands(FROSTFIRE).get('railstraitlo1')!;

  it('is true exactly where lodOpacity is above zero, last copy or not', () => {
    for (const band of [high, low]) {
      for (const last of [false, true]) {
        for (let u = 0; u <= 500; u += 0.25) expect(lodVisible(band, u, last)).toBe(lodOpacity(band, u * u, last) > 0);
      }
    }
  });

  it('shows the near copy alone before the crossover, both copies across it, and the far copy alone after it', () => {
    for (const range of [0, 50, 99, 100]) { expect(lodVisible(high, range)).toBe(true); expect(lodVisible(low, range)).toBe(false); }
    for (const range of [100.5, 110, 119.5]) { expect(lodVisible(high, range)).toBe(true); expect(lodVisible(low, range)).toBe(true); }
    for (const range of [120, 200, 439]) { expect(lodVisible(high, range)).toBe(false); expect(lodVisible(low, range)).toBe(true); }
  });

  it('culls both copies past the far fade of the far one, as the engine does', () => {
    expect(lodVisible(low, 441)).toBe(false);
    expect(lodVisible(high, 441)).toBe(false);
  });

  it('keeps the last copy at every range when asked, and the near copy still steps aside for it', () => {
    expect(lodVisible(low, 441, true)).toBe(true);
    expect(lodVisible(low, 5000, true)).toBe(true);
    expect(lodVisible(low, 50, true)).toBe(false);      // not yet faded in
    expect(lodVisible(high, 441, true)).toBe(true);     // a lone near copy asked to stay, stays
  });
});

/**
 * The world root's `LOD_Object` (the binary twin of `lod.rdr`, polish spec section 4): 32-byte records,
 * five floats -- `m_minRangeNearSq`, `m_minRangeFarSq`, `m_minInvDeltaRangeSq`, `m_maxRangeNearSq`,
 * `m_maxRangeFarSq` -- then at +20 a sixth float reCOM's `CLOD_band` (`zRender/zrender.h:180-192`) does not
 * have, the far fade's own inverse delta, then the fade bits at +24 (bit 0 `m_minFade`, bit 1 `m_maxFade`).
 */
const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)('LOD_Object on the disc (Frostfire, MP2)', () => {
  it('stores the ramp as one over the fade width in range squared, so the fade is linear in range squared', () => {
    const toc = parseZdb(MP2!);
    const zar = Zar.parse(zdbMember(MP2!, toc, 'MP2.ZED'));
    const key = zar.find('LOD_Object')!;
    const bytes = zar.data(key);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(key.size % 32).toBe(0);
    const records = [];
    for (let o = 0; o < key.size; o += 32) {
      const f = (k: number) => view.getFloat32(o + k * 4, true);
      records.push({ minNear: f(0), minFar: f(1), minInv: f(2), maxNear: f(3), maxFar: f(4), maxInv: f(5), bits: view.getUint32(o + 24, true) });
    }
    // railings_low: in over 100-120, out over 420-440, both fades flagged.
    const low = records.find((r) => r.minNear === 100 * 100 && r.minFar === 120 * 120 && r.maxFar === 440 * 440)!;
    expect(low.bits & 3).toBe(3);
    expect(low.minInv).toBeCloseTo(1 / (120 * 120 - 100 * 100), 10);
    expect(low.maxInv).toBeCloseTo(1 / (440 * 440 - 420 * 420), 10);
    // Every fade on the map, flagged or not, agrees: the stored slope is one over the squared width, and a
    // fade is flagged exactly where its two ends differ -- so the ends in `lod.rdr` say whether to ramp.
    for (const r of records) {
      expect((r.bits & 1) !== 0).toBe(r.minFar !== r.minNear);
      expect((r.bits & 2) !== 0).toBe(r.maxFar !== r.maxNear);
      if (r.bits & 1) expect(r.minInv * (r.minFar - r.minNear)).toBeCloseTo(1, 5); else expect(r.minInv).toBe(0);
      if (r.bits & 2) expect(r.maxInv * (r.maxFar - r.maxNear)).toBeCloseTo(1, 5); else expect(r.maxInv).toBe(0);
    }
    // And lodOpacity's ramp is the disc's: DrawLOD's `m_minInvDeltaRangeSq * (range - m_minRangeNearSq)`.
    const band = lodBands(FROSTFIRE).get('railstraitlo1')!;
    for (const rangeSq of [10500, 12100, 13900]) expect(lodOpacity(band, rangeSq)).toBeCloseTo(low.minInv * (rangeSq - low.minNear), 6);
  });
});

describe('lodIsLast', () => {
  const bands = lodBands(FROSTFIRE);
  const high = bands.get('railstraithi1')!;
  const low = bands.get('railstraitlo1')!;
  const lone = bands.get('chair_office')!;

  it('is the far copy of a pair, not the near one', () => {
    expect(lodIsLast(low, [high])).toBe(true);
    expect(lodIsLast(high, [low])).toBe(false);
  });

  it('is a copy with nothing else at its spot', () => {
    expect(lodIsLast(lone, [])).toBe(true);
    expect(lodIsLast(high, [])).toBe(true);
  });

  it('ignores itself and another copy that fades in no later', () => {
    expect(lodIsLast(low, [low, high, lone])).toBe(true);
  });
});
