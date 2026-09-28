import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRdr, parseZdb, readTexManifest, Zar, zdbMember, type TexEntry } from '@s2u/archive';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { detailBindings, loadMap, type LoadedMap } from '../src/loadMap';

/**
 * The detail pass's binding (W1.6): which of a map's draws get a second pass, and with what. A draw's
 * texture binds one when its `mp<N>_lib.rdr` entry carries a `detail` record (web/docs/research/72 §6).
 * That is the disc's own rule, measured: over the 22 maps every one of the 2,395 visuals drawn with a
 * texture that has a detail record carries a `detail_buff` of its own, and none drawn with such a texture
 * lacks one -- so binding by texture is binding by visual.
 */
const entry = (name: string, detail?: TexEntry['detail']): [string, TexEntry] => [name.toLowerCase(), {
  name, dim2: { width: 64, height: 64, bpp: 8 }, typeU: 1, typeV: 1, pal: true, detail,
}];

describe('detailBindings (synthetic)', () => {
  const manifest = new Map<string, TexEntry>([
    entry('ground.tif', { name: 'Ground_Det.tif', uv: 4, range: 202500, bmode: 'COLORBLEND' }),
    entry('wall.tif', { name: 'wall_det.tif', uv: 3, range: 20000000, bmode: 'COLORBLEND' }),
    entry('sky.tif'),
  ]);

  it('binds the drawn textures whose entry has a detail record, the detail named as map.textures keys it', () => {
    expect(detailBindings(manifest, ['ground.tif', 'sky.tif', 'ground.tif'])).toEqual({
      'ground.tif': { name: 'ground_det.tif', uv: 4, range: 202500, bmode: 'COLORBLEND' },
    });
  });

  it('binds nothing for a texture the manifest does not list, or a map with no manifest', () => {
    expect(detailBindings(manifest, ['nowhere.tif'])).toEqual({});
    expect(detailBindings(new Map(), ['ground.tif'])).toEqual({});
  });
});

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const mp2 = fixture('RUN/MP2.ZDB');
const absent = mp2 === null || fixture('RUN/MP6.ZDB') === null || fixture('RUN/MP72.ZDB') === null;
const load = (path: string): Promise<LoadedMap> => loadMap(new FsAssetSource(FIXTURES), path);

describe.skipIf(absent)(`the detail bindings out of loadMap${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it.skipIf(absent)('Frostfire: the manifest lists all 37 names the world\'s chains cite, and floor_oilgrime.tif binds its detail', async () => {
    const map = await load('RUN/MP2.ZDB');
    const toc = parseZdb(mp2!);
    const readerm = Zar.parse(zdbMember(mp2!, toc, 'READERM.ZAR'));
    const manifest = readTexManifest(parseRdr(readerm.data(readerm.find('mp2_lib.rdr')!)));
    // Research 72 §6-7: the world's chains cite 37 distinct names; every one is in the manifest.
    const cited = new Set(map.world.map((m) => m.textureName).filter((n): n is string => n !== null));
    expect(cited.size).toBe(37);
    for (const name of cited) expect(manifest.has(name), name).toBe(true);

    // The one detail texture Frostfire draws: 8 across, gone at 500 units, added (SEMANTICS §11.6).
    expect(map.detail).toEqual({
      'floor_oilgrime.tif': { name: 'flooroil_detail.tif', uv: 8, range: 250000, bmode: 'ADDITIVE' },
    });
    expect(map.textures['flooroil_detail.tif']).toMatchObject({ width: 128, height: 128 });
    // `a_floor.tif`'s detail, `a_floordetail.tif`, is in none of the map's libraries -- and `a_floor.tif`
    // is drawn by nothing, so nothing is missing and nothing is said.
    expect(map.detail['a_floor.tif']).toBeUndefined();
    expect(map.diagnostics.filter((d) => /detail/i.test(d))).toEqual([]);
    const draws = [...map.world, ...map.props.flatMap((p) => p.parts)].filter((m) => m.textureName === 'floor_oilgrime.tif');
    expect(draws.length).toBeGreaterThan(0);
  });

  it.skipIf(absent)('Desert Glory and Crossroads bind the COLORBLEND details their drawn ground and walls carry', async () => {
    const mp6 = await load('RUN/MP6.ZDB');
    expect(mp6.detail['afghan2r_floor_dirty.tif']).toEqual({ name: 'detail_map.tif', uv: 4, range: 202500, bmode: 'COLORBLEND' });
    expect(mp6.textures['detail_map.tif']).toBeDefined();
    const mp72 = await load('RUN/MP72.ZDB');
    expect(Object.keys(mp72.detail).sort()).toEqual([
      'cobblestone_rock.tif', 'extwalls01.tif', 'road_cobble.tif', 'roadcement2.tif', 'rooftile.tif', 'wall_dirty05.tif',
    ]);
    for (const [base, d] of Object.entries(mp72.detail)) {
      expect(d.bmode, base).toBe('COLORBLEND');
      expect(mp72.textures[d.name], `${base} -> ${d.name}`).toBeDefined();
    }
    for (const map of [mp6, mp72]) expect(map.diagnostics.filter((d) => /detail/i.test(d))).toEqual([]);
  });
});
