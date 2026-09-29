import { describe, expect, it } from 'vitest';
import { readShare, writeShare, type ShareState } from '../src/shareUrl';

/**
 * Shareable links (owner, 2026-09-29): the page's state in its address -- `mode` (play / explore; `redotcom` its old
 * alias), `map`, `view` (modern / ps2) and `online` (off / shared / local) -- read on load over the remembered choices,
 * and written back as they change, so the address bar is a link to the same setup. The developer's own parameters
 * (`devmode`, `fly`, `mp`, `server`, `lag`, `loss`) pass through untouched and are never added.
 */
describe('readShare', () => {
  it('reads the four settings', () => {
    expect(readShare('?mode=play&map=mp2&view=ps2&online=shared')).toEqual({ play: true, map: 'MP2', view: 'ps2', online: 'shared', alias: false });
    expect(readShare('mode=explore&view=modern&online=off')).toEqual({ play: false, map: null, view: 'modern', online: 'off', alias: false });
  });

  it('is nothing where the address says nothing', () => {
    expect(readShare('')).toEqual({ play: null, map: null, view: null, online: null, alias: false });
    expect(readShare('?devmode&fly')).toEqual({ play: null, map: null, view: null, online: null, alias: false });
  });

  it('takes ?redotcom as mode=play, and says so, so the page can rewrite it', () => {
    expect(readShare('?redotcom')).toMatchObject({ play: true, alias: true });
    expect(readShare('?map=MP2&redotcom=1')).toMatchObject({ play: true, map: 'MP2', alias: true });
    expect(readShare('?mode=explore&redotcom')).toMatchObject({ play: false, alias: true });   // mode, when it is one, wins
  });

  it('falls back silently on values it does not know', () => {
    expect(readShare('?mode=walk&map=../x&view=crt&online=everywhere')).toEqual({ play: null, map: null, view: null, online: null, alias: false });
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

  it('replaces what was there and drops the redotcom alias', () => {
    expect(writeShare('?redotcom&map=MP2&fly', { play: true })).toBe('?mode=play&map=MP2&fly');
    expect(writeShare('?mode=play&map=MP2&view=ps2', { play: false, map: 'MP7' })).toBe('?mode=explore&map=MP7&view=ps2');
  });

  it('leaves a setting out when told to (null), and keeps one it was not told about', () => {
    expect(writeShare('?mode=play&online=local', { online: null })).toBe('?mode=play');
    expect(writeShare('?mode=play&online=local', {})).toBe('?mode=play&online=local');
  });

  it('writes nothing at all for nothing', () => {
    expect(writeShare('', {})).toBe('');
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
      expect(read.alias).toBe(false);
    }
  });
  it('writes back what it read (an address already in the canonical order is a fixed point)', () => {
    for (const q of ['?mode=play&map=MP2&view=modern&online=off', '?mode=explore&map=MP9&view=ps2&online=shared&fly&devmode']) {
      const r = readShare(q);
      expect(writeShare(q, { play: r.play, map: r.map, view: r.view, online: r.online })).toBe(q);
    }
  });
});
