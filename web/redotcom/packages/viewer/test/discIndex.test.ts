import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsoAssetSource } from '@s2u/archive';
import { buildIso } from '../../archive/test/isoImage';
import { indexVerdict, listDiscMaps } from '../src/discIndex';

/**
 * An unreadable archive on a dropped ISO reaches the disc page's status line with its reason (PL-11, wave-1 B13's
 * carry-over): the worker lists with `onProblem` (`../src/discIndex`) and the page says `listed N of M maps; X unreadable: ...`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const worker = readFileSync(resolve(here, '../src/worker.ts'), 'utf-8');
const main = readFileSync(resolve(here, '../src/main.ts'), 'utf-8');

const JUNK = new Uint8Array(64).fill(0x5a);
const MP2 = { archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' };
const MP7 = { archive: 'MP7', path: 'RUN/MP7.ZDB', name: 'MP7' };

describe('the disc map list and what would not read in it', () => {
  it('lists a dropped image, keeping each unreadable archive under its id and its reason', async () => {
    const source = new IsoAssetSource(new Blob([buildIso([{ path: 'RUN/MP7.ZDB', bytes: JUNK }, { path: 'SYSTEM.CNF', bytes: JUNK }])]));
    const { maps, problems } = await listDiscMaps(source);
    expect(maps).toEqual([MP7]);
    expect(problems.length).toBe(1);
    expect(problems[0]!.path).toBe('RUN/MP7.ZDB');
    expect(problems[0]!.message.length).toBeGreaterThan(0);
  });

  it('every archive read: no note, the page opens', () => {
    expect(indexVerdict([MP2], [])).toEqual({ open: true, note: null, diagnostics: [] });
    expect(indexVerdict([], []).open).toBe(false);
  });

  it('one archive unreadable: listed N of M, the archive and the reason on the line, the page opens', () => {
    const v = indexVerdict([MP2, MP7], [{ path: 'RUN/MP7.ZDB', message: 'zdb: toc runs past the file' }]);
    expect(v).toEqual({
      open: true,
      note: 'listed 1 of 2 maps; MP7.ZDB unreadable: zdb: toc runs past the file',
      diagnostics: ['MP7.ZDB unreadable: zdb: toc runs past the file'],
    });
  });

  it('drops the path a reason already leads with', () => {
    const v = indexVerdict([MP7], [{ path: 'RUN/MP7.ZDB', message: 'RUN/MP7.ZDB: READERM.ZAR has no mission.rdr' }]);
    expect(v.note).toBe('listed 0 of 1 maps; MP7.ZDB unreadable: READERM.ZAR has no mission.rdr');
  });

  it('not one archive named: the page stays on the disc page', () => {
    expect(indexVerdict([MP7], [{ path: 'RUN/MP7.ZDB', message: 'bad' }]).open).toBe(false);
  });

  it('the worker lists a disc with its problems and sends them; the page puts the note on the disc page line', () => {
    expect(worker).toMatch(/await listDiscMaps\(source\)/);
    expect(worker).toMatch(/kind: 'index', id: request\.id, maps, problems/);
    expect(worker).not.toMatch(/await listMaps\(source\)/);
    expect(main).toMatch(/indexVerdict\(message\.maps, message\.problems\)/);
    expect(main).toMatch(/ui\.setDiscState\(verdict\.note, 'error'\)/);
  });
});
