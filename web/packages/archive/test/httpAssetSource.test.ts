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

  it('reads the sprint-2 index: the maps for the picker, the common archives in the listing (W2.R5)', async () => {
    vi.stubGlobal('fetch', serve({ maps: INDEX, common: ['RUN/READERC.ZAR', 'RUN/ZWEAPON.ZAR'] }));
    const s = new HttpAssetSource('/maps');
    expect(await s.maps()).toEqual(INDEX);
    expect(await s.list()).toEqual(['RUN/MP2.ZDB', 'RUN/READERC.ZAR', 'RUN/ZWEAPON.ZAR']);
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

  it('reads a range with a Range request, and slices a server that ignores it (81 §1)', async () => {
    const file = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const ranged = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = /bytes=(\d+)-(\d+)/.exec(String((init?.headers as Record<string, string> | undefined)?.Range ?? ''));
      if (init?.method === 'HEAD') return new Response(null, { headers: { 'content-length': '10' } });
      if (!range) return new Response(file);
      return new Response(file.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
    });
    vi.stubGlobal('fetch', ranged);
    const s = new HttpAssetSource('/maps');
    expect(await s.size('RUN/SOUNDS/BNKSTORE.ZAR')).toBe(10);
    expect(Array.from(await s.readRange('RUN/SOUNDS/BNKSTORE.ZAR', 3, 4))).toEqual([3, 4, 5, 6]);
    expect((ranged.mock.calls[1]![1] as RequestInit).headers).toEqual({ Range: 'bytes=3-6' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(file)));   // a server with no ranges answers 200, whole
    expect(Array.from(await new HttpAssetSource('/maps').readRange('X', 8, 2))).toEqual([8, 9]);
    await expect(new HttpAssetSource('/maps').readRange('X', 8, 4)).rejects.toThrow('run past its end');
  });
});
