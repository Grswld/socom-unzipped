import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FsAssetSource } from '@s2u/archive/node';
import type { LodBand } from '@s2u/scene';
import { loadMap } from '../src/loadMap';

/**
 * Issue #113's count: a detail pass (`world.ts`, `addDetail`) kept its base's opaque state, so a banded
 * prop fading under `DrawLOD`'s ramp showed its detail grain at full strength through the fade. That
 * matters wherever a banded prop -- a `LOD_Object` whose band has a fade range, its two ends apart --
 * draws with a texture whose `mp<N>_lib.rdr` entry binds a detail record (`LoadedMap.detail`).
 *
 * Over the 22 maps there is one: Frostfire's `railramp_sl8n`, drawn with `floor_oilgrime.tif` and its
 * ADDITIVE `flooroil_detail.tif`, band 0..420-440, placed three times. No other LOD copy stands within 5 units
 * of any of the three, so each is the last at its spot (`lodIsLast`): its plateau stays open outward and it
 * never enters the ramp. So the viewer never drew the defect on the disc's maps; the rule is fixed anyway
 * (`worldLodDetail.test.ts`), and this pins the one prop it covers.
 * Frostfire has 9 banded props (8 fading); Night Stalker (MP73) 33 banded, none with a fade range; no
 * other map has a band. Needs the extracted maps: `SOCOM_MAPS` names the directory holding `index.json`
 * and `RUN/*.ZDB` (e.g. `web/public/maps` after `npm run extract-maps`); skipped when unset.
 */
const MAPS = process.env.SOCOM_MAPS;

/** A band ramps where its fade's two ends differ (`lodOpacity`); a band with none switches, not fades. */
const fades = (band: LodBand): boolean => band.nearFade[0] !== band.nearFade[1] || band.farFade[0] !== band.farFade[1];

describe.skipIf(!MAPS)(`banded props whose texture binds a detail pass${MAPS ? '' : ' (SOCOM_MAPS unset)'}`, () => {
  it('is one prop on the 22 maps: Frostfire\'s railramp_sl8n on floor_oilgrime.tif', async () => {
    const index = JSON.parse(readFileSync(resolve(MAPS!, 'index.json'), 'utf8')) as { archive: string; path: string }[];
    expect(index).toHaveLength(22);
    const source = new FsAssetSource(MAPS!);
    const hits: Record<string, string[]> = {};
    for (const { archive, path } of index) {
      const map = await loadMap(source, path);
      hits[archive] = map.props.filter((p) => p.lod !== null && fades(p.lod)).flatMap((p) => p.parts
        .filter((part) => part.textureName !== null && map.detail[part.textureName] !== undefined)
        .map((part) => `${p.modelName}:${part.textureName}`));
    }
    const want = Object.fromEntries(index.map(({ archive }) => [archive, [] as string[]]));
    want['MP2'] = ['railramp_sl8n:floor_oilgrime.tif'];
    expect(hits).toEqual(want);
  }, 600_000);
});
