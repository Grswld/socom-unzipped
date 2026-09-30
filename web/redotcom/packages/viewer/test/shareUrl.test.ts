import { describe, expect, it } from 'vitest';
import { ONLINE_OVERRIDES, onlineChoiceAddress, readShare, RETIRED_PARAMS, writeShare, type ShareState } from '../src/shareUrl';

/**
 * Shareable links (owner, 2026-09-29): the page's state in its address -- `mode` (play / explore), `map`, `view` (modern / ps2) and `online` (off / shared / local) -- read on load over the remembered choices,
 * and written back as they change, so the address bar is a link to the same setup. The developer's own parameters
 * (`devmode`, `fly`, `mp`, `server`, `lag`, `loss`) pass through untouched and are never added.
 */
describe('readShare', () => {
  it('reads the four settings', () => {
    expect(readShare('?mode=play&map=mp2&view=ps2&online=shared')).toEqual({ play: true, map: 'MP2', view: 'ps2', online: 'shared'});
    expect(readShare('mode=explore&view=modern&online=off')).toEqual({ play: false, map: null, view: 'modern', online: 'off'});
  });

  it('is nothing where the address says nothing', () => {
    expect(readShare('')).toEqual({ play: null, map: null, view: null, online: null});
    expect(readShare('?devmode&fly')).toEqual({ play: null, map: null, view: null, online: null});
  });

  it('reads the old ?redotcom as nothing: the mode comes from mode= or the remembered choice (owner, 2026-09-29)', () => {
    expect(readShare('?redotcom')).toEqual({ play: null, map: null, view: null, online: null });
    expect(readShare('?map=MP2&redotcom=1')).toMatchObject({ play: null, map: 'MP2' });
    expect(readShare('?mode=explore&redotcom')).toMatchObject({ play: false });
    expect(readShare('?mode=play&redotcom')).toMatchObject({ play: true });
    expect(RETIRED_PARAMS).toContain('redotcom');
  });

  it('falls back silently on values it does not know', () => {
    expect(readShare('?mode=walk&map=../x&view=crt&online=everywhere')).toEqual({ play: null, map: null, view: null, online: null});
    expect(readShare('?mode=PLAY&view=PS2&online=Shared')).toMatchObject({ play: true, view: 'ps2', online: 'shared' });
  });

  it('never throws on a malformed query', () => {
    expect(() => readShare('?%E0%A4%A&map=%')).not.toThrow();
  });
});

describe('writeShare', () => {
  it('writes the four in a fixed order, first', () => {
    expect(writeShare('', { play: true, map: 'MP2', view: 'modern', online: 'off' })).toBe('?mode=play&map=MP2&view=modern&online=off');
    expect(writeShare('', { play: false, view: 'ps2' })).toBe('?mode=explore&view=ps2');
  });

  it('keeps the developer\'s parameters as they were, a bare one bare, and never adds them', () => {
    expect(writeShare('?fly&devmode&server=wss://a.b/ws&lag=50', { play: true, map: 'MP9' }))
      .toBe('?mode=play&map=MP9&fly&devmode&server=wss://a.b/ws&lag=50');
    expect(writeShare('?fly', { online: 'shared' })).toBe('?online=shared&fly');
  });

  it('replaces what was there, and takes the retired redotcom out whatever it is told', () => {
    expect(writeShare('?redotcom&map=MP2&fly', { play: true })).toBe('?mode=play&map=MP2&fly');
    expect(writeShare('?redotcom&map=MP2', {})).toBe('?map=MP2');
    expect(writeShare('?redotcom=1', { view: 'ps2' })).toBe('?view=ps2');
    expect(writeShare('?mode=play&map=MP2&view=ps2', { play: false, map: 'MP7' })).toBe('?mode=explore&map=MP7&view=ps2');
  });

  it('leaves a setting out when told to (null), and keeps one it was not told about', () => {
    expect(writeShare('?mode=play&online=local', { online: null })).toBe('?mode=play');
    expect(writeShare('?mode=play&online=local', {})).toBe('?mode=play&online=local');
  });

  it('writes nothing at all for nothing', () => {
    expect(writeShare('', {})).toBe('');
  });

  it('drops a developer parameter only when told to, bare or valued, and keeps the rest as they were', () => {
    expect(writeShare('?mode=play&server=wss://a.b/ws&mp&lag=50', { online: 'off', drop: ['server', 'mp'] }))
      .toBe('?mode=play&online=off&lag=50');
    expect(writeShare('?mp=1&fly&server=', { drop: ['server', 'mp'] })).toBe('?fly');
    expect(writeShare('?fly&devmode&server=wss://a.b/ws&lag=50', { play: true }))       // without `drop`: never removed
      .toBe('?mode=play&fly&devmode&server=wss://a.b/ws&lag=50');
  });
});

/**
 * An Online choice the visitor makes replaces a server the address named (`./online` gives `&server=` and `&mp`
 * precedence on load), so the address drops them: otherwise a reload or the copied link goes back to that server
 * while this browser remembers the choice (PL-12).
 */
describe('onlineChoiceAddress', () => {
  it('writes the choice and takes server= and mp out of the address', () => {
    for (const choice of ['off', 'shared', 'local'] as const) {
      const search = writeShare('?mode=explore&online=shared&server=ws://127.0.0.1:9/ws&mp&devmode', onlineChoiceAddress(choice));
      expect(search).toBe(`?mode=explore&online=${choice}&devmode`);
      const q = new URLSearchParams(search);
      expect(q.has('server')).toBe(false);
      expect(q.has('mp')).toBe(false);
      expect(readShare(search).online).toBe(choice);
    }
  });
  it('names exactly the two parameters that beat online=', () => {
    expect([...ONLINE_OVERRIDES].sort()).toEqual(['mp', 'server']);
  });
});

describe('the round trip', () => {
  const states: ShareState[] = [
    { play: true, map: 'MP2', view: 'modern', online: 'off' },
    { play: false, map: 'MP71', view: 'ps2', online: 'shared' },
    { play: true, view: 'ps2', online: 'local' },
    { play: false },
  ];
  it('reads back what it wrote', () => {
    for (const s of states) {
      const read = readShare(writeShare('?devmode', s));
      expect(read.play).toBe(s.play ?? null);
      expect(read.map).toBe(s.map ?? null);
      expect(read.view).toBe(s.view ?? null);
      expect(read.online).toBe(s.online ?? null);
    }
  });
  it('writes back what it read (an address already in the canonical order is a fixed point)', () => {
    for (const q of ['?mode=play&map=MP2&view=modern&online=off', '?mode=explore&map=MP9&view=ps2&online=shared&fly&devmode']) {
      const r = readShare(q);
      expect(writeShare(q, { play: r.play, map: r.map, view: r.view, online: r.online })).toBe(q);
    }
  });
});
