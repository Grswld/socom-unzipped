import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpAssetSource } from '../src/httpAssetSource';

/** The index `extract-maps.ts` writes: one `MapInfo` an archive, the name already read from `mission.rdr`. */
const INDEX = [{ archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' }];

/** A server that holds one archive under `/maps`, and 404s everything else. */
const serve = (index: unknown = INDEX) =>
  vi.fn(async (url: string) => {
    if (url === '/maps/index.json') return new Response(JSON.stringify(index));
    if (url === '/maps/RUN/MP2.ZDB') return new Response(new Uint8Array([7, 8]));
    return new Response(null, { status: 404 });
  });

afterEach(() => vi.unstubAllGlobals());

describe('HttpAssetSource', () => {
  it('lists from index.json and reads bytes', async () => {
    vi.stubGlobal('fetch', serve());
    const s = new HttpAssetSource('/maps');
    expect(await s.list()).toEqual(['RUN/MP2.ZDB']);
    expect(Array.from(await s.read('RUN/MP2.ZDB'))).toEqual([7, 8]);
    await expect(s.read('RUN/NOPE.ZDB')).rejects.toThrow('HTTP 404 RUN/NOPE.ZDB');
  });

  it('answers the picker from the index alone, reading no archive', async () => {
    const fetched = serve();
    vi.stubGlobal('fetch', fetched);
    expect(await new HttpAssetSource('/maps').maps()).toEqual(INDEX);
    expect(fetched.mock.calls.map((c) => c[0])).toEqual(['/maps/index.json']);
  });

  it('still reads an older index that is a plain array of paths', async () => {
    vi.stubGlobal('fetch', serve(['RUN/MP2.ZDB']));
    const s = new HttpAssetSource('/maps');
    expect(await s.list()).toEqual(['RUN/MP2.ZDB']);
    // No name on disc, so the archive id stands in rather than the menu going blank.
    expect(await s.maps()).toEqual([{ archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'MP2' }]);
  });

  it('takes a base URL with or without its trailing slash', async () => {
    const fetched = serve();
    vi.stubGlobal('fetch', fetched);
    expect(await new HttpAssetSource('/maps/').list()).toEqual(['RUN/MP2.ZDB']);
    expect(Array.from(await new HttpAssetSource('/maps/').read('RUN/MP2.ZDB'))).toEqual([7, 8]);
    expect(fetched.mock.calls.map((c) => c[0])).toEqual(['/maps/index.json', '/maps/RUN/MP2.ZDB']);
  });

  it('reports a missing index the same way', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    await expect(new HttpAssetSource('/maps').list()).rejects.toThrow('HTTP 503 index.json');
  });
});
