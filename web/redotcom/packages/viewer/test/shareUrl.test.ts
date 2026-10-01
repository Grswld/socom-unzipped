import { describe, expect, it } from 'vitest';
import { MULTIPLAYER_PARAMS, readShare, RETIRED_PARAMS, writeShare, type ShareState } from '../src/shareUrl';

/**
 * Shareable links (owner, 2026-09-29): the page's state in its address -- `mode` (play / explore), `map` and `view`
 * (modern / ps2) -- read on load over the remembered choices, and written back as they change, so the address bar is a
 * link to the same setup. The developer's own parameters (`devmode`, `fly`, `lag`, ...) pass through untouched and are
 * never added. The online match's `online`, `mp` and `server` are retired with it (the local demo, owner 2026-10-01).
 */
describe('readShare', () => {
  it('reads the three settings', () => {
    expect(readShare('?mode=play&map=mp2&view=ps2')).toEqual({ play: true, map: 'MP2', view: 'ps2' });
    expect(readShare('mode=explore&view=modern')).toEqual({ play: false, map: null, view: 'modern' });
  });

  it('is nothing where the address says nothing', () => {
    expect(readShare('')).toEqual({ play: null, map: null, view: null });
    expect(readShare('?devmode&fly')).toEqual({ play: null, map: null, view: null });
  });

  it('reads the old ?redotcom as nothing: the mode comes from mode= or the remembered choice (owner, 2026-09-29)', () => {
    expect(readShare('?redotcom')).toEqual({ play: null, map: null, view: null });
    expect(readShare('?map=MP2&redotcom=1')).toMatchObject({ play: null, map: 'MP2' });
    expect(readShare('?mode=explore&redotcom')).toMatchObject({ play: false });
    expect(readShare('?mode=play&redotcom')).toMatchObject({ play: true });
    expect(RETIRED_PARAMS).toContain('redotcom');
  });

  it('reads the online match\'s parameters as nothing (the local demo has no online match)', () => {
    expect(readShare('?online=shared&mp&server=wss://a.b/ws')).toEqual({ play: null, map: null, view: null });
    for (const p of ['online', 'mp', 'server']) expect(RETIRED_PARAMS).toContain(p);
    expect([...MULTIPLAYER_PARAMS].sort()).toEqual(['mp', 'online', 'server']);
  });

  it('falls back silently on values it does not know', () => {
    expect(readShare('?mode=walk&map=../x&view=crt')).toEqual({ play: null, map: null, view: null });
    expect(readShare('?mode=PLAY&view=PS2')).toMatchObject({ play: true, view: 'ps2' });
  });

  it('never throws on a malformed query', () => {
    expect(() => readShare('?%E0%A4%A&map=%')).not.toThrow();
  });
});

describe('writeShare', () => {
  it('writes the three in a fixed order, first', () => {
    expect(writeShare('', { play: true, map: 'MP2', view: 'modern' })).toBe('?mode=play&map=MP2&view=modern');
    expect(writeShare('', { play: false, view: 'ps2' })).toBe('?mode=explore&view=ps2');
  });

  it('keeps the developer\'s parameters as they were, a bare one bare, and never adds them', () => {
    expect(writeShare('?fly&devmode&lag=50', { play: true, map: 'MP9' })).toBe('?mode=play&map=MP9&fly&devmode&lag=50');
    expect(writeShare('?fly', { view: 'ps2' })).toBe('?view=ps2&fly');
  });

  it('replaces what was there, and takes the retired redotcom out whatever it is told', () => {
    expect(writeShare('?redotcom&map=MP2&fly', { play: true })).toBe('?mode=play&map=MP2&fly');
    expect(writeShare('?redotcom&map=MP2', {})).toBe('?map=MP2');
    expect(writeShare('?redotcom=1', { view: 'ps2' })).toBe('?view=ps2');
    expect(writeShare('?mode=play&map=MP2&view=ps2', { play: false, map: 'MP7' })).toBe('?mode=explore&map=MP7&view=ps2');
  });

  it('takes the online match\'s online=, &mp and &server= out on any write, bare or valued (as the deployed teaser did)', () => {
    expect(writeShare('?mode=play&online=shared&server=wss://a.b/ws&mp&lag=50', {})).toBe('?mode=play&lag=50');
    expect(writeShare('?mp=1&fly&server=&online=local', {})).toBe('?fly');
  });

  it('leaves a setting out when told to (null), and keeps one it was not told about', () => {
    expect(writeShare('?mode=play&view=ps2', { view: null })).toBe('?mode=play');
    expect(writeShare('?mode=play&view=ps2', {})).toBe('?mode=play&view=ps2');
  });

  it('writes nothing at all for nothing', () => {
    expect(writeShare('', {})).toBe('');
  });

  it('drops a developer parameter only when told to, bare or valued, and keeps the rest as they were', () => {
    expect(writeShare('?mode=play&nomatch&lag=50', { drop: ['nomatch'] })).toBe('?mode=play&lag=50');
    expect(writeShare('?fly&devmode&lag=50', { play: true }))                          // without `drop`: never removed
      .toBe('?mode=play&fly&devmode&lag=50');
  });
});

describe('the round trip', () => {
  const states: ShareState[] = [
    { play: true, map: 'MP2', view: 'modern' },
    { play: false, map: 'MP71', view: 'ps2' },
    { play: true, view: 'ps2' },
    { play: false },
  ];
  it('reads back what it wrote', () => {
    for (const s of states) {
      const read = readShare(writeShare('?devmode', s));
      expect(read.play).toBe(s.play ?? null);
      expect(read.map).toBe(s.map ?? null);
      expect(read.view).toBe(s.view ?? null);
    }
  });
  it('writes back what it read (an address already in the canonical order is a fixed point)', () => {
    for (const q of ['?mode=play&map=MP2&view=modern', '?mode=explore&map=MP9&view=ps2&fly&devmode']) {
      const r = readShare(q);
      expect(writeShare(q, { play: r.play, map: r.map, view: r.view })).toBe(q);
    }
  });
});
