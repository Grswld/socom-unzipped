import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetSource } from '@s2u/archive';
import { buildZar } from '../../scene/test/syntheticZar';
import { renderAmbienceLoops, SOUND_BANKS_PATH, SOUND_SCRIPT_PATH, soundFromDisc } from '../src/soundData';

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const script = resolve(fixtures, SOUND_SCRIPT_PATH);

/**
 * A bank that will not parse is named in `missing`, never thrown (research 81 §8: "`missing` names what could not be
 * read"; worker.ts: "Never an error either"): the params loop and the ambience render read bank by bank.
 */
describe.skipIf(!existsSync(script))('a bank that will not parse', () => {
  it('is named in missing, and the rest of the map sound still comes', async () => {
    const garbage = new Uint8Array(96).fill(0xab);
    const store = buildZar([{ name: 'MP2_am.bnk', data: garbage }]);
    const source: AssetSource = {
      list: async () => [],
      read: async (path: string) => {
        if (path === SOUND_BANKS_PATH) return store;
        if (path === SOUND_SCRIPT_PATH) return new Uint8Array(readFileSync(script));
        throw new Error(`no ${path}`);
      },
    };
    const d = await soundFromDisc(source, 'RUN/MP2.ZDB', 'MP2');
    expect(d.banks.map((b) => b.file)).toEqual(['MP2_am.bnk']);
    expect(d.missing.some((m) => /^MP2_am\.bnk: /.test(m))).toBe(true);
    expect(d.params).toEqual([]);
    expect(renderAmbienceLoops({ ...d, beds: { outside: ['~OUTDOOR_AMB'], inside: [] } }, 1, 0.1)).toEqual([]);
  });
});
