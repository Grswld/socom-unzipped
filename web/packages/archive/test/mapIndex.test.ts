import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FsAssetSource, readServedIndex } from '../src/fsAssetSource';
import { COMMON_ARCHIVES, listMaps, parseServedIndex, servedIndex } from '../src/mapIndex';

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
  // Web sprint 2 Task 0: an agent worktree junctions `test-fixtures/RUN` in from the main tree, and a
  // junction's Dirent says symbolic link, not directory -- so the walk listed `RUN` as a file and
  // `listMaps` over the fixtures found no map. The walk follows a link to a directory.
  it('lists through a junction or symlinked directory as through the directory itself', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 's2u-fs-'));
    try {
      mkdirSync(join(tmp, 'real'));
      writeFileSync(join(tmp, 'real', 'MP2.ZDB'), new Uint8Array([1, 2, 3]));
      mkdirSync(join(tmp, 'root'));
      writeFileSync(join(tmp, 'root', 'index.json'), '[]');
      symlinkSync(join(tmp, 'real'), join(tmp, 'root', 'RUN'), 'junction');
      const source = new FsAssetSource(join(tmp, 'root'));
      expect(await source.list()).toEqual(['RUN/MP2.ZDB', 'index.json']);
      expect(Array.from(await source.read('RUN/MP2.ZDB'))).toEqual([1, 2, 3]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Task 0 review: a link whose target is gone is skipped (it has no bytes to read), not a failed walk;
  // a junction back to its own ancestor is walked once, not forever. Where the host refuses to make a
  // link at all, the test has nothing to prove and returns.
  const tryLink = (target: string, path: string): boolean => {
    try { symlinkSync(target, path, 'junction'); return true; } catch { return false; }
  };

  it('skips a dangling link rather than failing the walk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 's2u-fs-'));
    try {
      mkdirSync(join(tmp, 'gone'));
      mkdirSync(join(tmp, 'root'));
      writeFileSync(join(tmp, 'root', 'index.json'), '[]');
      if (!tryLink(join(tmp, 'gone'), join(tmp, 'root', 'RUN'))) return;
      rmSync(join(tmp, 'gone'), { recursive: true });
      expect(await new FsAssetSource(join(tmp, 'root')).list()).toEqual(['index.json']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('walks a junction that loops back to its own ancestor once', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 's2u-fs-'));
    try {
      mkdirSync(join(tmp, 'root', 'RUN'), { recursive: true });
      writeFileSync(join(tmp, 'root', 'RUN', 'MP2.ZDB'), new Uint8Array([1]));
      if (!tryLink(join(tmp, 'root'), join(tmp, 'root', 'RUN', 'LOOP'))) return;
      expect(await new FsAssetSource(join(tmp, 'root')).list()).toEqual(['RUN/MP2.ZDB']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(served))('lists forward-slash paths and reads bytes back', async () => {
    const source = new FsAssetSource(served);
    const paths = await source.list();
    expect(paths).toContain('RUN/MP2.ZDB');
    const head = (await source.read('RUN/MP2.ZDB')).subarray(0, 4);
    expect(head.byteLength).toBe(4);
  });
});

// W2.R5 (web sprint 2 Task 0): `index.json` names the maps and, beside them, the common archives the
// extractor copies from the disc's `RUN/` -- `READERC.ZAR` (the character scripts) and `ZWEAPON.ZAR`.
describe('the served index', () => {
  const MAPS = [{ archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' }];

  it('is the maps and the common archives, READERC and ZWEAPON beside the map archives', () => {
    expect(COMMON_ARCHIVES).toEqual(['RUN/READERC.ZAR', 'RUN/ZWEAPON.ZAR']);
    const index = servedIndex(MAPS);
    expect(index).toEqual({ maps: MAPS, common: ['RUN/READERC.ZAR', 'RUN/ZWEAPON.ZAR'] });
    // What the extractor writes is what the reader reads back.
    expect(parseServedIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
  });

  it('still reads the older indexes: an array of MapInfo, or of bare paths, with no common archives', () => {
    expect(parseServedIndex(MAPS)).toEqual({ maps: MAPS, common: [] });
    expect(parseServedIndex(['RUN/MP2.ZDB'])).toEqual({
      maps: [{ archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'MP2' }], common: [],
    });
  });

  it('ignores a key it does not know, and refuses what is not an index', () => {
    expect(parseServedIndex({ maps: MAPS, common: ['RUN/READERC.ZAR'], later: 1 }))
      .toEqual({ maps: MAPS, common: ['RUN/READERC.ZAR'] });
    expect(parseServedIndex({ maps: MAPS })).toEqual({ maps: MAPS, common: [] });
    expect(() => parseServedIndex({ common: [] })).toThrow('index.json');
    expect(() => parseServedIndex(7)).toThrow('index.json');
  });
});

// Task 0 review: `tools/probe-spawns.ts` read `index.json` as `MapInfo[]` and iterated it, which the
// sprint-2 object is not; the tools read the served index through this one helper.
describe('readServedIndex', () => {
  it('reads the { maps, common } index off disk, and the older array', () => {
    const tmp = mkdtempSync(join(tmpdir(), 's2u-index-'));
    try {
      const maps = [{ archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' }];
      writeFileSync(join(tmp, 'index.json'), JSON.stringify(servedIndex(maps)));
      expect(readServedIndex(tmp)).toEqual({ maps, common: ['RUN/READERC.ZAR', 'RUN/ZWEAPON.ZAR'] });
      writeFileSync(join(tmp, 'index.json'), JSON.stringify(maps));
      expect(readServedIndex(tmp).maps).toEqual(maps);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
