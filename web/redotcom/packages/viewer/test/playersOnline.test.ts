import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { MapInfo } from '@s2u/archive';
import {
  countPlayers, LOCAL_ROOMS, mapSuffix, MAX_BACKOFF_MS, nextDelayMs, POLL_MS, REQUEST_TIMEOUT_MS, RoomsPoller, roomsUrl,
  sameCounts, SHARED_ROOMS, totalText, UNKNOWN, type PlayerCounts, type Visibility,
} from '../src/playersOnline';
import { LOCAL_SERVER, SHARED_SERVER } from '../src/online';
import { Ui } from '../src/ui';

/**
 * PLAYERS ONLINE (owner, 2026-09-29: "At the top just remove 'redotcom · SOCOM II multiplayer' and replace it with a
 * PLAYERS ONLINE count. Next to each map in the dropdown, include a number beside them or a label to show how many
 * people are playing on each map. It should update automatically at a reasonable interval, efficiently.").
 */

const rows = (...r: [string, number, number?, string?][]): unknown[] =>
  r.map(([map, players, spectators = 0, rules = 'classic']) => ({ map, rules, players, spectators, round: 1 }));
const counts = (total: number, byMap: Record<string, number>): PlayerCounts => ({ total, byMap: new Map(Object.entries(byMap)) });

describe('the source: the shared server, the local one on Local', () => {
  it('reads the shared server\'s /rooms (the Online setting\'s Shared host), the local one\'s when Online is Local', () => {
    expect(SHARED_ROOMS).toBe(SHARED_SERVER.replace(/^wss:/, 'https:').replace(/\/ws$/, '/rooms'));
    expect(LOCAL_ROOMS).toBe(LOCAL_SERVER.replace(/^ws:/, 'http:').replace(/\/ws$/, '/rooms'));
    expect(roomsUrl('off')).toBe(SHARED_ROOMS);
    expect(roomsUrl('shared')).toBe(SHARED_ROOMS);
    expect(roomsUrl('url')).toBe(SHARED_ROOMS);
    expect(roomsUrl('local')).toBe(LOCAL_ROOMS);
  });

  it('the build\'s VITE_S2U_ROOMS replaces the shared list only: off (or empty) is none, a URL is that URL', () => {
    expect(roomsUrl('off', 'off')).toBeNull();
    expect(roomsUrl('shared', ' off ')).toBeNull();
    expect(roomsUrl('shared', '')).toBeNull();
    expect(roomsUrl('shared', 'https://staging.example.com/rooms')).toBe('https://staging.example.com/rooms');
    expect(roomsUrl('local', 'off')).toBe(LOCAL_ROOMS);
  });
});

describe('the counts: players in classic rooms, never the watchers', () => {
  it('sums the players per map and in all, leaving out the spectators, the other rules and the empty maps', () => {
    const c = countPlayers(rows(['MP2', 3, 5], ['MP6', 0, 2], ['MP1', 2], ['MP1', 4, 0, 'respawn'], ['mp9', 1]))!;
    expect(c.total).toBe(6);
    expect(Object.fromEntries(c.byMap)).toEqual({ MP2: 3, MP1: 2, MP9: 1 });
  });

  it('an empty list is nobody (0); an answer that is not a room list is not known (null), never 0', () => {
    expect(countPlayers([])).toEqual({ total: 0, byMap: new Map() });
    for (const bad of [null, {}, 'x', 3, [null], [{ map: 'MP2' }], [{ players: 2 }], [{ map: 'MP2', players: -1 }], [{ map: 'MP2', players: Number.NaN }]]) {
      expect(countPlayers(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('compares two readings by what they say', () => {
    expect(sameCounts(null, null)).toBe(true);
    expect(sameCounts(counts(0, {}), null)).toBe(false);
    expect(sameCounts(counts(3, { MP2: 3 }), counts(3, { MP2: 3 }))).toBe(true);
    expect(sameCounts(counts(3, { MP2: 3 }), counts(3, { MP1: 3 }))).toBe(false);
    expect(sameCounts(counts(3, { MP2: 3 }), counts(3, { MP2: 2, MP1: 1 }))).toBe(false);
  });

  it('words them: the total or a dash (never 0 for unknown); a map\'s " · 3 playing", nothing for none or unknown', () => {
    expect(UNKNOWN).toBe('–');
    expect(totalText(null)).toBe('–');
    expect(totalText(counts(0, {}))).toBe('0');
    expect(totalText(counts(12, { MP2: 12 }))).toBe('12');
    expect(mapSuffix(null, 'MP2')).toBe('');
    expect(mapSuffix(counts(0, {}), 'MP2')).toBe('');
    expect(mapSuffix(counts(3, { MP2: 3 }), 'MP2')).toBe(' · 3 playing');
    expect(mapSuffix(counts(3, { MP2: 3 }), 'mp2')).toBe(' · 3 playing');
    expect(mapSuffix(counts(3, { MP2: 3 }), 'MP6')).toBe('');
  });
});

/** A clock and a timer queue the test steps by hand. */
class Clock {
  t = 1_000;
  private next = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  now = (): number => this.t;
  setTimeout = (fn: () => void, ms: number): unknown => { const id = this.next++; this.timers.set(id, { at: this.t + ms, fn }); return id; };
  clearTimeout = (h: unknown): void => { this.timers.delete(h as number); };
  pending(): number[] { return [...this.timers.values()].map((x) => x.at - this.t).sort((a, b) => a - b); }
  /** Moves the clock on, running each timer that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await flush();
    }
    this.t = end;
    await flush();
  }
}
/** Lets the answers' promises (a Response's body is read on the real event loop) settle. */
const flush = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => globalThis.setTimeout(r, 0)); };

class Page implements Visibility {
  hidden = false;
  private fns = new Set<() => void>();
  addEventListener(_: 'visibilitychange', fn: () => void): void { this.fns.add(fn); }
  removeEventListener(_: 'visibilitychange', fn: () => void): void { this.fns.delete(fn); }
  listeners(): number { return this.fns.size; }
  set(hidden: boolean): void { this.hidden = hidden; for (const f of this.fns) f(); }
}

interface Call { url: string; init: RequestInit; answer(res: Response | Error): void }

/** A fetch whose answers the test gives, one per call, in order. */
function fakeFetch(): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = ((url: string, init: RequestInit) => new Promise<Response>((ok, fail) => {
    init.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError')));
    calls.push({ url, init, answer: (r) => (r instanceof Error ? fail(r) : ok(r)) });
  })) as unknown as typeof fetch;
  return { fetch: f, calls };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the poll', () => {
  let clock: Clock, page: Page, net: ReturnType<typeof fakeFetch>, told: (PlayerCounts | null)[], poller: RoomsPoller;
  const make = (url: string | null = SHARED_ROOMS): RoomsPoller => new RoomsPoller({
    url, onCounts: (c) => told.push(c), fetch: net.fetch, visibility: page, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  beforeEach(() => { clock = new Clock(); page = new Page(); net = fakeFetch(); told = []; poller = make(); });

  it('asks at once on start, then once every 20 s while the server answers; tells a change only', async () => {
    poller.start();
    expect(told).toEqual([null]);                                         // the dash until the first answer
    await clock.advance(0);
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe(SHARED_ROOMS);
    // No hand-set If-None-Match (a CORS preflight on every poll): the browser's cache revalidates, and nothing else.
    expect(net.calls[0]!.init).toMatchObject({ cache: 'no-cache', credentials: 'omit', mode: 'cors' });
    expect(net.calls[0]!.init.headers).toBeUndefined();
    net.calls[0]!.answer(json(rows(['MP2', 3, 1])));
    await flush();
    expect(told.at(-1)).toEqual(counts(3, { MP2: 3 }));
    expect(POLL_MS).toBe(20_000);
    await clock.advance(19_999);
    expect(net.calls).toHaveLength(1);
    await clock.advance(1);
    expect(net.calls).toHaveLength(2);
    net.calls[1]!.answer(json(rows(['MP2', 3, 4])));                      // only the watchers moved: nothing to tell
    await flush();
    expect(told).toHaveLength(2);
    await clock.advance(20_000);
    net.calls[2]!.answer(json(rows(['MP2', 2], ['MP6', 1])));
    await flush();
    expect(told.at(-1)).toEqual(counts(3, { MP2: 2, MP6: 1 }));
  });

  it('never has two out: a request out holds the next poll, whatever the page does meanwhile', async () => {
    poller.start();
    await clock.advance(0);
    page.set(true);
    page.set(false);                                                       // shown again with one out: no second
    await clock.advance(REQUEST_TIMEOUT_MS - 1);
    expect(net.calls).toHaveLength(1);
    expect(poller.busy()).toBe(true);
    expect(clock.pending()).toEqual([1]);                                   // only the request's own time limit
  });

  it('gives a request up after 10 s (a failure), so a hung one never blocks the poll', async () => {
    poller.start();
    await clock.advance(0);
    await clock.advance(REQUEST_TIMEOUT_MS);
    expect(net.calls[0]!.init.signal!.aborted).toBe(true);
    expect(poller.busy()).toBe(false);
    expect(poller.failuresInARow()).toBe(1);
    expect(told).toEqual([null]);
  });

  it('keeps the counts on a 304 (a runtime that hands it through): the list did not change', async () => {
    poller.start();
    await clock.advance(0);
    net.calls[0]!.answer(json(rows(['MP2', 3])));
    await flush();
    await clock.advance(POLL_MS);
    net.calls[1]!.answer(new Response(null, { status: 304 }));
    await flush();
    expect(poller.counts()).toEqual(counts(3, { MP2: 3 }));
    expect(told).toEqual([null, counts(3, { MP2: 3 })]);
    expect(poller.failuresInARow()).toBe(0);
    expect(clock.pending()).toEqual([POLL_MS]);
  });

  it('while the server does not answer: the dash (never 0), and a backoff doubling from 40 s to 2 min; an answer resets it', async () => {
    poller.start();
    await clock.advance(0);
    net.calls[0]!.answer(json(rows(['MP2', 3])));
    await flush();
    await clock.advance(POLL_MS);
    net.calls[1]!.answer(new TypeError('Failed to fetch'));
    await flush();
    expect(told.at(-1)).toBeNull();
    expect(poller.counts()).toBeNull();
    expect(clock.pending()).toEqual([40_000]);
    const waits: number[] = [];
    for (let i = 2; i < 6; i++) {
      await clock.advance(clock.pending()[0]!);
      net.calls[i]!.answer(i % 2 ? new Response('', { status: 502 }) : new TypeError('Failed to fetch'));
      await flush();
      waits.push(clock.pending()[0]!);
    }
    expect(waits).toEqual([80_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(MAX_BACKOFF_MS).toBe(120_000);
    expect(told.filter((c) => c === null)).toHaveLength(2);               // the dash told once, not at every failure
    await clock.advance(MAX_BACKOFF_MS);
    net.calls[6]!.answer(json([]));
    await flush();
    expect(told.at(-1)).toEqual(counts(0, {}));                           // nobody on: 0, now that it is known
    expect(clock.pending()).toEqual([POLL_MS]);
    expect(nextDelayMs(0)).toBe(POLL_MS);
    expect(nextDelayMs(1)).toBe(40_000);
    expect(nextDelayMs(99)).toBe(MAX_BACKOFF_MS);
  });

  it('an answer that is not a room list is not known, and backs off like a failure', async () => {
    poller.start();
    await clock.advance(0);
    net.calls[0]!.answer(json({ error: 'nope' }));
    await flush();
    expect(poller.failuresInARow()).toBe(1);
    expect(told).toEqual([null]);
  });

  it('asks nothing while the page is hidden; shown again, asks at once if a poll fell due meanwhile, else at its time', async () => {
    poller.start();
    await clock.advance(0);
    net.calls[0]!.answer(json(rows(['MP2', 1])));
    await flush();
    page.set(true);
    expect(clock.pending()).toEqual([]);
    await clock.advance(10 * 60_000);
    expect(net.calls).toHaveLength(1);
    page.set(false);
    await clock.advance(0);
    expect(net.calls).toHaveLength(2);                                     // at once
    net.calls[1]!.answer(json(rows(['MP2', 1])));
    await flush();
    await clock.advance(5_000);
    page.set(true);
    await clock.advance(2_000);
    page.set(false);                                                       // back within the period: no extra request
    await clock.advance(0);
    expect(net.calls).toHaveLength(2);
    expect(clock.pending()).toEqual([13_000]);
  });

  it('a page hidden from the start asks nothing until it is shown', async () => {
    page.hidden = true;
    poller.start();
    await clock.advance(60_000);
    expect(net.calls).toHaveLength(0);
    page.set(false);
    await clock.advance(0);
    expect(net.calls).toHaveLength(1);
  });

  it('stop aborts the request that is out, clears the timer and the listener; a late answer is dropped', async () => {
    poller.start();
    expect(page.listeners()).toBe(1);
    await clock.advance(0);
    const call = net.calls[0]!;
    poller.stop();
    expect(call.init.signal!.aborted).toBe(true);
    expect(page.listeners()).toBe(0);
    expect(clock.pending()).toEqual([]);
    await clock.advance(10 * 60_000);
    expect(net.calls).toHaveLength(1);
    expect(told).toEqual([null]);
    poller.start();                                                        // the back-forward cache brings it back
    await clock.advance(0);
    expect(net.calls).toHaveLength(2);
  });

  it('a new source (the Online setting moved): the old request aborted, the dash, a poll now at the new URL', async () => {
    poller.start();
    await clock.advance(0);
    net.calls[0]!.answer(json(rows(['MP2', 3])));
    await flush();
    await clock.advance(5_000);
    poller.setUrl(LOCAL_ROOMS);
    expect(told.at(-1)).toBeNull();
    await clock.advance(0);
    expect(net.calls).toHaveLength(2);
    expect(net.calls[1]!.url).toBe(LOCAL_ROOMS);
    poller.setUrl(SHARED_ROOMS);                                           // moved again with that one out
    expect(net.calls[1]!.init.signal!.aborted).toBe(true);
    await clock.advance(0);
    expect(net.calls[2]!.url).toBe(SHARED_ROOMS);
    net.calls[2]!.answer(json(rows(['MP6', 2])));
    await flush();
    expect(told.at(-1)).toEqual(counts(2, { MP6: 2 }));
  });

  it('no source (the build turned the shared list off): the dash, and no request at all', async () => {
    poller = make(null);
    poller.start();
    await clock.advance(10 * 60_000);
    expect(net.calls).toHaveLength(0);
    expect(told).toEqual([null]);
  });
});

describe('the kicker and the picker', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
  const MAPS: MapInfo[] = [
    { archive: 'MP2', path: 'RUN/MP2.ZDB', name: 'FROSTFIRE' },
    { archive: 'MP6', path: 'RUN/MP6.ZDB', name: 'BLIZZARD' },
  ];
  let ui: Ui;
  beforeEach(() => {
    document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
    ui = new Ui();
    ui.setMaps(MAPS, 'RUN/MP2.ZDB');
  });
  const kicker = (): string => document.getElementById('panel-kicker')!.textContent!;
  const option = (path: string): HTMLOptionElement => [...(document.getElementById('maps') as HTMLSelectElement).options].find((o) => o.value === path)!;

  it('the kicker is the system kicker, first in the panel, "Players online" and a dash until the count is known', () => {
    const k = document.getElementById('panel-kicker')!;
    expect(k.classList.contains('s2u-kicker')).toBe(true);
    expect(k.parentElement!.firstElementChild).toBe(k);
    expect(kicker()).toBe('Players online –');
    expect(k.getAttribute('aria-live')).toBeNull();                        // a figure every 20 s would talk over the page
    expect(k.getAttribute('title')).toMatch(/Watchers are not counted/);
    expect(option('RUN/MP2.ZDB').textContent).not.toMatch(/playing/);
  });

  it('0 known is 0 in the kicker and nothing on the maps; counts show on their maps only; unknown again is the dash', () => {
    ui.setPlayerCounts(counts(0, {}));
    expect(kicker()).toBe('Players online 0');
    expect(option('RUN/MP2.ZDB').textContent).not.toMatch(/playing/);
    ui.setPlayerCounts(counts(5, { MP2: 3, MP6: 2 }));
    expect(kicker()).toBe('Players online 5');
    expect(option('RUN/MP2.ZDB').textContent).toMatch(/^FROSTFIRE.* · 3 playing$/);
    expect(option('RUN/MP6.ZDB').textContent).toMatch(/^BLIZZARD.* · 2 playing$/);
    // The option's text is its accessible name: the count is heard with the map.
    expect(option('RUN/MP2.ZDB').label).toMatch(/3 playing/);
    ui.setPlayerCounts(counts(3, { MP2: 3 }));
    expect(option('RUN/MP6.ZDB').textContent).not.toMatch(/playing/);
    ui.setPlayerCounts(null);
    expect(kicker()).toBe('Players online –');
    expect(option('RUN/MP2.ZDB').textContent).not.toMatch(/playing/);
  });

  it('a map list that comes after the counts carries them; the selection and values are untouched', () => {
    ui.setPlayerCounts(counts(4, { MP6: 4 }));
    ui.setMaps(MAPS, 'RUN/MP6.ZDB');
    expect(option('RUN/MP6.ZDB').textContent).toMatch(/ · 4 playing$/);
    expect((document.getElementById('maps') as HTMLSelectElement).value).toBe('RUN/MP6.ZDB');
    ui.setPlayerCounts(counts(1, { MP2: 1 }));
    expect((document.getElementById('maps') as HTMLSelectElement).value).toBe('RUN/MP6.ZDB');
    expect(option('RUN/MP2.ZDB').value).toBe('RUN/MP2.ZDB');
  });

  it('rewrites only what changed (an open picker is left alone)', () => {
    ui.setPlayerCounts(counts(3, { MP2: 3 }));
    const kept = option('RUN/MP6.ZDB').firstChild;
    const n = document.getElementById('players-online')!.firstChild;
    ui.setPlayerCounts(counts(3, { MP2: 3 }));
    expect(option('RUN/MP6.ZDB').firstChild).toBe(kept);
    expect(document.getElementById('players-online')!.firstChild).toBe(n);
  });
});
