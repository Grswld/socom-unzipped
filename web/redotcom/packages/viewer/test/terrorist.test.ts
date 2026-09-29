import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { fixture } from '../../archive/test/fixtures';
import { loadMap, type LoadedMap } from '../src/loadMap';

/** Web sprint 3 M5: the map's own first Terrorist type rides along with the SEAL (research 91 §14). */
const here = dirname(fileURLToPath(import.meta.url));
const SERVED = resolve(here, '../../../public/maps');
const MP2 = fixture('RUN/MP2.ZDB');
const dressed = existsSync(resolve(SERVED, 'RUN/READERC.ZAR')) && existsSync(resolve(SERVED, 'RUN/MP2.ZDB'));

describe.skipIf(!MP2 || !dressed)("Frostfire's Terrorist", () => {
  let map: LoadedMap;
  it('is a terrorist type, not the SEAL model, with sub-meshes whose textures are loaded', async () => {
    map = await loadMap(new FsAssetSource(SERVED), 'RUN/MP2.ZDB');
    const t = map.terrorist!;
    expect(t).toBeTruthy();
    expect(t.character).toBe('mp2_terror1');
    expect(t.model).toBe('al_gman01');
    expect(t.model).not.toBe(map.body!.model);
    expect(t.subMeshes.length).toBeGreaterThan(0);
    for (const s of t.subMeshes) if (s.textureName !== null) expect(map.textures[s.textureName]).toBeTruthy();
  });
});
