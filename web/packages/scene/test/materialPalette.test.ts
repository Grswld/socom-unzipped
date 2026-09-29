import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture } from '../../archive/test/fixtures';
import { parseMaterialPalette, parseSceneGraph, placeInstances } from '../src/index';

/**
 * The environment-map materials: the world root's `Material_Palette` entries that name a reflection texture, and the
 * visuals that name an entry in `vparams` byte 7. Frostfire (a fixture) has only untextured entries; Blood Lake (the
 * served tree, when extracted) binds its water to `palEntry_3`, `m19_skycap01.tif`.
 */
const MP2 = fixture('RUN/MP2.ZDB');
const SERVED = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN/MP10.ZDB');
const MP10 = existsSync(SERVED) ? new Uint8Array(readFileSync(SERVED)) : null;
const open = (bytes: Uint8Array, stem: string) => {
  const toc = parseZdb(bytes);
  return (suffix: string) => Zar.parse(zdbMember(bytes, toc, suffix.replace('*', stem)));
};

describe('Material_Palette', () => {
  it.skipIf(!MP2)('Frostfire names no reflection texture: its two entries are the untextured kind', () => {
    expect(parseMaterialPalette(open(MP2!, 'MP2')('*.ZED'))).toEqual([]);
  });

  it.skipIf(!MP10)('Blood Lake: the water visuals name palEntry_3, the sky cap it reflects', () => {
    const zar = open(MP10!, 'MP10');
    const palette = parseMaterialPalette(zar('*.ZED'));
    const water = palette.find((e) => e.index === 3)!;
    expect(water).toEqual({ index: 3, rgba: [80, 80, 80, 20], uvScale: expect.closeTo(0.2, 5), rimOffset: 130, rimSlope: expect.closeTo(1 / 130, 6), texture: 'm19_skycap01.tif' });
    const placed = placeInstances(parseSceneGraph(zar('*_GEO.ZED')));
    const bound = placed.filter((p) => p.material?.some((m) => m === 4));
    expect(bound.length).toBeGreaterThanOrEqual(20);
    expect(bound.every((p) => /water/.test(p.path))).toBe(true);
  });
});
