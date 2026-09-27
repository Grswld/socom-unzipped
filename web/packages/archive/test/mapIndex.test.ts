import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { FsAssetSource } from '../src/fsAssetSource';
import { listMaps } from '../src/mapIndex';

const served = resolve(import.meta.dirname, '../../../public/maps');

/** 36 §0: the display name is the `description` key of `mission.rdr`, read here from the archives
 *  themselves rather than copied into a table. */
const NAMES: Record<string, string> = {
  MP1: 'BLIZZARD', MP2: 'FROSTFIRE', MP5: 'ABANDONED', MP6: 'DESERT GLORY', MP7: 'NIGHT STALKER',
  MP8: "RAT'S NEST", MP9: 'BITTER JUNGLE', MP10: 'BLOOD LAKE', MP11: 'DEATH TRAP', MP12: 'THE RUINS',
  MP51: 'VIGILANCE', MP52: 'THE MIXER', MP53: 'FOXHUNT', MP61: 'SUJO', MP62: 'ENOWAPI',
  MP64: 'SHADOW FALLS', MP71: 'FISH HOOK', MP72: 'CROSSROADS', MP73: 'SANDSTORM',
  MP81: 'CHAIN REACTION', MP82: 'GUIDANCE', MP83: 'REQUIEM',
};

describe('listMaps', () => {
  it.skipIf(!existsSync(served))('names all 22 MP archives from their mission.rdr', async () => {
    const maps = await listMaps(new FsAssetSource(served));
    expect(maps.length).toBe(22);
    const byArchive = Object.fromEntries(maps.map((m) => [m.archive, m.name]));
    expect(byArchive).toMatchObject(NAMES);
    expect(maps[0]!.archive).toBe('MP1'); expect(maps[1]!.archive).toBe('MP2'); expect(maps[2]!.archive).toBe('MP5');
    expect(maps[0]!.path).toBe('RUN/MP1.ZDB');
  }, 120_000);
});

describe('FsAssetSource', () => {
  it.skipIf(!existsSync(served))('lists forward-slash paths and reads bytes back', async () => {
    const source = new FsAssetSource(served);
    const paths = await source.list();
    expect(paths).toContain('RUN/MP2.ZDB');
    const head = (await source.read('RUN/MP2.ZDB')).subarray(0, 4);
    expect(head.byteLength).toBe(4);
  });
});
