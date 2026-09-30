import type { OnlineChoice } from './online';

/**
 * PLAYERS ONLINE (owner, 2026-09-29: "At the top just remove 'redotcom · SOCOM II multiplayer' and replace it with a
 * PLAYERS ONLINE count. Next to each map in the dropdown, include a number beside them or a label to show how many
 * people are playing on each map. It should update automatically at a reasonable interval, efficiently.").
 *
 * The source is the match server's public `/rooms` (`packages/server/src/server.ts`: anonymous per-room counts, CORS
 * `*`): the shared server's (`SHARED_ROOMS`) whatever the Online setting says, except that Online set to Local -- a
 * choice only a local page offers (`./online` `pageIsLocal`) -- reads the local server's instead. Classic rooms only
 * (the only ruleset while respawn is off). The count is the rooms' **players**, not their spectators: a spectator is a
 * page in Explore with Online on, watching the match rather than playing it, so counting it would call a viewer a
 * player -- and the match's own line under Online counts players the same way (`./online` `onlineLine`).
 *
 * The poll (`RoomsPoller`): one small GET about every 20 s while the page is visible, none while it is hidden, one
 * straight away when it shows again if one fell due meanwhile; never two at once; backing off to 2 min while the server
 * does not answer (it shows a dash then, never 0); aborted on teardown. The server answers with an ETag and
 * `Cache-Control: public, max-age=10`, so the request goes out with `cache: 'no-cache'` and nothing else: the browser
 * revalidates with its own `If-None-Match` and a 304 costs a few header bytes. The page never sets `If-None-Match` by
 * hand -- a non-safelisted header on a cross-origin GET would add a CORS preflight to every poll, and the server does
 * not answer OPTIONS -- but a 304 that does reach it (a runtime without an HTTP cache) keeps the last counts.
 */

/** The shared server's room list: the Online setting's Shared server (`./online` `SHARED_SERVER`), over HTTPS. */
export const SHARED_ROOMS = 'https://mp.socomunzipped.com/rooms';
/** The local server's (`npm start -w @s2u/server`, port 8787; `./online` `LOCAL_SERVER`). */
export const LOCAL_ROOMS = 'http://localhost:8787/rooms';
/** The poll's period while the server answers, and the ceiling of its backoff while it does not. */
export const POLL_MS = 20_000;
export const MAX_BACKOFF_MS = 120_000;
/** A request that has not answered in this long is given up (a failure), so a hung one never blocks the next. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** What the kicker and a map show while the count is not known (never 0: nobody would be a claim). */
export const UNKNOWN = '–';

/**
 * The room list to read: the local server's when Online is Local, the shared server's otherwise. `override` is the
 * build's `VITE_S2U_ROOMS` (the e2e run's `off`, so its console stays clean while the shared server is not live; or
 * another URL): it replaces the shared list only, and `off` or an empty value means none (no poll at all).
 */
export function roomsUrl(choice: OnlineChoice | 'url', override?: string): string | null {
  if (choice === 'local') return LOCAL_ROOMS;
  if (override === undefined) return SHARED_ROOMS;
  const v = override.trim();
  return v === '' || v === 'off' ? null : v;
}

/** The players online: the total over the classic rooms, and each map's (by archive id, `MP2`), maps with none left out. */
export interface PlayerCounts { total: number; byMap: ReadonlyMap<string, number> }

/**
 * The counts out of a `/rooms` answer, or null when it is not one (not a list, a row without a map or a player count):
 * a list that cannot be read is shown as unknown, never as nobody. Rows of another ruleset are skipped (a server that
 * keeps respawn rooms open); a map's rooms are summed.
 */
export function countPlayers(body: unknown): PlayerCounts | null {
  if (!Array.isArray(body)) return null;
  const byMap = new Map<string, number>();
  let total = 0;
  for (const row of body as unknown[]) {
    if (!row || typeof row !== 'object') return null;
    const { map, rules, players } = row as { map?: unknown; rules?: unknown; players?: unknown };
    if (typeof map !== 'string' || typeof players !== 'number' || !Number.isFinite(players) || players < 0) return null;
    if (rules !== undefined && rules !== 'classic') continue;
    const n = Math.floor(players);
    if (n === 0) continue;
    const key = map.toUpperCase();
    byMap.set(key, (byMap.get(key) ?? 0) + n);
    total += n;
  }
  return { total, byMap };
}

/** Whether two readings say the same (so the page is not rewritten for nothing). */
export function sameCounts(a: PlayerCounts | null, b: PlayerCounts | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.total !== b.total || a.byMap.size !== b.byMap.size) return false;
  for (const [k, v] of a.byMap) if (b.byMap.get(k) !== v) return false;
  return true;
}

/** The kicker's figure: the total, or the dash while it is not known. */
export function totalText(c: PlayerCounts | null): string {
  return c ? String(c.total) : UNKNOWN;
}

/**
 * What follows a map's name in the picker: ` · 3 playing` when anyone is, nothing otherwise (0, or not known: an
 * `<option>` cannot be dimmed, and a dash on every row would be noise). It is the option's text, so its accessible name.
 */
export function mapSuffix(c: PlayerCounts | null, archive: string): string {
  const n = c?.byMap.get(archive.toUpperCase()) ?? 0;
  return n > 0 ? ` · ${n} playing` : '';
}

/** The page's visibility, as `document` gives it (the tests pass their own). */
export interface Visibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', fn: () => void): void;
  removeEventListener(type: 'visibilitychange', fn: () => void): void;
}

export interface RoomsPollerOptions {
  /** The list to read, or null for none (`roomsUrl`). */
  url: string | null;
  /** Called with each new reading: counts, or null for not known (unreachable, unreadable, no source). Only on a change. */
  onCounts: (counts: PlayerCounts | null) => void;
  fetch?: typeof fetch;
  visibility?: Visibility;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  intervalMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
}

/** The delay before the next poll: the period after an answer, doubling per failure in a row up to the ceiling. */
export function nextDelayMs(failures: number, intervalMs = POLL_MS, maxMs = MAX_BACKOFF_MS): number {
  if (failures <= 0) return intervalMs;
  return Math.min(maxMs, intervalMs * 2 ** Math.min(failures, 16));
}

/** The `/rooms` poll (see the file's comment): `start` once, `setUrl` when the Online setting moves, `stop` on teardown. */
export class RoomsPoller {
  private url: string | null;
  private readonly onCounts: (c: PlayerCounts | null) => void;
  private readonly fetchFn: typeof fetch;
  private readonly vis: Visibility | null;
  private readonly now: () => number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;
  private readonly interval: number;
  private readonly maxBackoff: number;
  private readonly timeout: number;
  private timer: unknown = null;
  private inFlight: AbortController | null = null;
  /** The time limit of the request that is out. */
  private limit: unknown = null;
  private failures = 0;
  /** When the next poll falls due (ms, `now`'s clock). */
  private dueAt = 0;
  private running = false;
  private last: PlayerCounts | null = null;
  /** Whether `onCounts` has been told anything yet (the first reading is always told, even an unknown one). */
  private told = false;
  private lastTold: PlayerCounts | null = null;
  private readonly onVisibility = (): void => this.visibilityChanged();

  constructor(opts: RoomsPollerOptions) {
    this.url = opts.url;
    this.onCounts = opts.onCounts;
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.vis = opts.visibility ?? (typeof document === 'undefined' ? null : document);
    this.now = opts.now ?? (() => Date.now());
    this.setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearT = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.interval = opts.intervalMs ?? POLL_MS;
    this.maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS;
    this.timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** The counts last read (null: not known). */
  counts(): PlayerCounts | null { return this.last; }
  /** Failures in a row (the backoff's exponent), for the tests and the hook. */
  failuresInARow(): number { return this.failures; }
  /** Whether a request is out. */
  busy(): boolean { return this.inFlight !== null; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.vis?.addEventListener('visibilitychange', this.onVisibility);
    this.dueAt = this.now();
    if (!this.told) this.tell(null);        // the first start says "not known"; a restart keeps the last reading until the poll
    this.arm();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.vis?.removeEventListener('visibilitychange', this.onVisibility);
    this.disarm();
    this.drop();
  }

  /** Aborts the request that is out, if any, and its time limit: its answer, when it comes, is not wanted. */
  private drop(): void {
    if (this.limit !== null) this.clearT(this.limit);
    this.limit = null;
    this.inFlight?.abort();
    this.inFlight = null;
  }

  /** A new source (the Online setting moved): the old counts are not this server's, so unknown, and a poll now. */
  setUrl(url: string | null): void {
    if (url === this.url) return;
    this.url = url;
    this.drop();
    this.failures = 0;
    this.last = null;
    this.tell(null);
    this.dueAt = this.now();
    if (this.running) { this.disarm(); this.arm(); }
  }

  private hidden(): boolean { return this.vis?.hidden === true; }

  private disarm(): void {
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
  }

  /** Sets the timer for the due time -- none while hidden, none while a request is out (its end arms it), none without a source. */
  private arm(): void {
    this.disarm();
    if (!this.running || this.hidden() || this.inFlight || this.url === null) return;
    const wait = Math.max(0, this.dueAt - this.now());
    this.timer = this.setT(() => { this.timer = null; void this.poll(); }, wait);
  }

  private visibilityChanged(): void {
    if (this.hidden()) this.disarm();       // nothing goes out while nobody looks; a request already out may finish
    else this.arm();                        // shown again: at once if a poll fell due meanwhile, else at its time
  }

  private async poll(): Promise<void> {
    const url = this.url;
    if (!this.running || this.inFlight || url === null || this.hidden()) return;
    const ctrl = new AbortController();
    this.inFlight = ctrl;
    this.limit = this.setT(() => { this.limit = null; ctrl.abort(); }, this.timeout);
    let reading: PlayerCounts | null | 'same';
    try {
      const res = await this.fetchFn(url, { cache: 'no-cache', credentials: 'omit', mode: 'cors', signal: ctrl.signal });
      if (res.status === 304) reading = this.last ? 'same' : null;
      else if (res.ok) reading = countPlayers(await res.json());
      else reading = null;
    } catch {
      // A failed request: the browser has already written its own line for it; nothing more goes to the console.
      // An abort by `stop` or `setUrl` lands here too, and is dropped just below; a timeout's is a failure.
      reading = null;
    }
    if (this.inFlight !== ctrl) return;      // stopped, or the source moved: this answer is not wanted
    if (this.limit !== null) this.clearT(this.limit);
    this.limit = null;
    this.inFlight = null;
    if (reading === null) {
      this.failures++;
      this.last = null;
      this.tell(null);
    } else {
      this.failures = 0;
      if (reading !== 'same') { this.last = reading; this.tell(reading); }
    }
    this.dueAt = this.now() + nextDelayMs(this.failures, this.interval, this.maxBackoff);
    this.arm();
  }

  private tell(c: PlayerCounts | null): void {
    if (this.told && sameCounts(c, this.lastTold)) return;
    this.told = true;
    this.lastTold = c;
    this.onCounts(c);
  }
}
