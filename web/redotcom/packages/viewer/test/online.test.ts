import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LOCAL_SERVER, ONLINE_KEY, SHARED_SERVER, onlineChoice, onlineLine, readOnline, resolveOnline, writeOnline,
} from '../src/online';
import { retryDelayMs } from '../src/netPage';

/** The panel's Online setting (owner, 2026-09-29): Off, Shared or Local; the URL's `&mp` / `&server=` over it. */
const HTTP = { protocol: 'http:', host: 'localhost:5173' };
const HTTPS = { protocol: 'https:', host: 'socomunzipped.com' };

describe('the Online setting: the servers', () => {
  it('Shared is the public match server and Local the static server on this machine', () => {
    expect(SHARED_SERVER).toBe('wss://mp.socomunzipped.com/ws');
    expect(LOCAL_SERVER).toBe('ws://localhost:8787/ws');
  });

  it('reads a stored value back as one of the three, Off for anything else', () => {
    expect(onlineChoice('shared')).toBe('shared');
    expect(onlineChoice('local')).toBe('local');
    for (const v of [null, '', 'off', 'on', 'SHARED', '1']) expect(onlineChoice(v), String(v)).toBe('off');
  });
});

describe('resolveOnline: the URL first, then the stored choice', () => {
  it('with nothing in the URL takes the stored choice: Off (no server), Shared, Local', () => {
    expect(resolveOnline('', null, HTTP)).toEqual({ choice: 'off', url: null, fromUrl: false });
    expect(resolveOnline('?map=MP2&mode=play', 'off', HTTP)).toEqual({ choice: 'off', url: null, fromUrl: false });
    expect(resolveOnline('', 'shared', HTTP)).toEqual({ choice: 'shared', url: SHARED_SERVER, fromUrl: false });
    expect(resolveOnline('?map=MP2', 'local', HTTPS)).toEqual({ choice: 'local', url: LOCAL_SERVER, fromUrl: false });
  });

  it('&mp overrides it with this page own host, ws or wss by the page protocol', () => {
    expect(resolveOnline('?mode=play&mp', 'off', HTTP)).toEqual({ choice: 'url', url: 'ws://localhost:5173/ws', fromUrl: true });
    expect(resolveOnline('?mp', 'local', HTTPS)).toEqual({ choice: 'url', url: 'wss://socomunzipped.com/ws', fromUrl: true });
  });

  it('&server= names the server, and shows as the matching choice when it is Shared or Local', () => {
    expect(resolveOnline('?mp&server=ws://127.0.0.1:9000/ws', 'shared', HTTP)).toMatchObject({ choice: 'url', url: 'ws://127.0.0.1:9000/ws', fromUrl: true });
    expect(resolveOnline(`?server=${LOCAL_SERVER}`, 'off', HTTP)).toMatchObject({ choice: 'local', url: LOCAL_SERVER, fromUrl: true });
    expect(resolveOnline(`?mp&server=${SHARED_SERVER}`, null, HTTP)).toMatchObject({ choice: 'shared', url: SHARED_SERVER, fromUrl: true });
  });

  it('carries the latency injector with a server, from the URL or the setting, and not with Off', () => {
    expect(resolveOnline('?mp&lag=100&loss=2', null, HTTP).simulate).toEqual({ latencyMs: 100, jitterMs: 20, loss: 0.02 });
    expect(resolveOnline('?lag=50', 'local', HTTP).simulate).toEqual({ latencyMs: 50, jitterMs: 10, loss: 0 });
    expect(resolveOnline('?lag=50', 'off', HTTP).simulate).toBeUndefined();
  });
});

describe('the remembered choice', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('is Off on a first visit, and what was written after', () => {
    expect(resolveOnline('', readOnline(), HTTP).choice).toBe('off');
    writeOnline('local');
    expect(localStorage.getItem(ONLINE_KEY)).toBe('local');
    expect(resolveOnline('', readOnline(), HTTP)).toMatchObject({ choice: 'local', url: LOCAL_SERVER });
    writeOnline('off');
    expect(resolveOnline('', readOnline(), HTTP).url).toBeNull();
  });

  it('survives a storage that throws: Off, and no exception', () => {
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('private window'); };
    Storage.prototype.setItem = () => { throw new Error('private window'); };
    try {
      expect(readOnline()).toBeNull();
      expect(() => writeOnline('shared')).not.toThrow();
    } finally {
      Storage.prototype.getItem = get;
      Storage.prototype.setItem = set;
    }
  });
});

describe('the connection line, and the retry', () => {
  it('says off, connecting, online with the players, unreachable with the wait, refused with the reason', () => {
    const base = { players: 0, retryIn: 0, watching: false };
    expect(onlineLine({ ...base, state: 'off' })).toEqual({ text: 'single player: no server', lamp: null });
    expect(onlineLine({ ...base, state: 'connecting' })).toEqual({ text: 'connecting ...', lamp: null });
    expect(onlineLine({ ...base, state: 'online', players: 1 })).toEqual({ text: 'online · 1 player', lamp: 'up' });
    expect(onlineLine({ ...base, state: 'online', players: 5, watching: true })).toEqual({ text: 'online · 5 players · watching', lamp: 'up' });
    expect(onlineLine({ ...base, state: 'retrying', retryIn: 3.2 })).toEqual({ text: 'server unreachable · retrying in 4 s', lamp: 'down' });
    expect(onlineLine({ ...base, state: 'retrying', retryIn: 0 }).text).toBe('server unreachable · retrying in 1 s');
    expect(onlineLine({ ...base, state: 'refused', reason: 'The game is full.' })).toEqual({ text: 'refused: The game is full.', lamp: 'down' });
  });

  it('backs off 1, 2, 4 ... 10 s after a match was reached, and 2, 4 ... 60 s to a server never reached', () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => retryDelayMs(n, true))).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => retryDelayMs(n, false))).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });
});
