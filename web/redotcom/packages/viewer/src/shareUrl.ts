/**
 * Shareable links (owner, 2026-09-29): the page's state lives in its address, so copying the address bar gives a friend
 * the same setup.
 *
 * - `mode=play` (reCOM, on foot) or `mode=explore` (the free camera). Absent, the remembered choice, else Explore.
 * - `map=MP2` -- the archive's stem.
 * - `view=modern` or `view=ps2` -- the picture switch.
 * - `online=off`, `shared` or `local` -- the Online setting. `&server=` and `&mp` still override it (`./online`).
 *
 * `redotcom` (the old flag that gated the play, owner 2026-09-29: "&redotcom can die now. The mode replaces it") has no
 * effect and is taken out of the address the next time the page writes it. `rules=` (the match's rules, web sprint 3) is
 * retired while classic is the only ruleset (owner ruling, 2026-09-29;
 * `./net/protocol` `RESPAWN_RULES_ENABLED`): never read, and taken out of the address the next time it is written.
 *
 * On load the address beats the remembered choice; with a parameter absent the remembered choice applies, and the page
 * writes it into the address (`history.replaceState`: no reload, no history entries). A value this page does not know
 * reads as absent. The developer's parameters (`devmode`, `fly`, `mp`, `server`, `lag`, `loss`, anything else) pass
 * through as they were, a bare one kept bare, and are never added -- but an Online choice the visitor makes takes
 * `server` and `mp` out (`onlineChoiceAddress`): the choice replaces the server they named, so the link must too.
 */
import type { OnlineChoice } from './online';
import { RESPAWN_RULES_ENABLED } from './net/protocol';

export type ShareView = 'modern' | 'ps2';

/** The settings a link carries: a value to write, `null` to take it out, absent to leave the address's own. */
export interface ShareState {
  play?: boolean | null;
  map?: string | null;
  view?: ShareView | null;
  online?: OnlineChoice | null;
  /** Other parameters to take out of the address (a developer's, which are otherwise always kept). */
  drop?: readonly string[];
}

/** What an address says: each setting, or null where it says nothing this page understands. */
export interface ShareRead {
  play: boolean | null;
  map: string | null;
  view: ShareView | null;
  online: OnlineChoice | null;
}

/** The parameters this module owns, in the order it writes them. */
const KEYS = ['mode', 'map', 'view', 'online'] as const;
/**
 * Parameters the page no longer understands, never read and taken out whenever it writes its address: the old
 * `redotcom` flag, and `rules` while respawn is off.
 */
export const RETIRED_PARAMS: readonly string[] = RESPAWN_RULES_ENABLED ? ['redotcom'] : ['redotcom', 'rules'];
/** A map's archive stem: letters, digits and underscores (`MP2`, `MP71`). */
const MAP_STEM = /^[A-Za-z0-9_]{1,16}$/;

export function readShare(search: string): ShareRead {
  const out: ShareRead = { play: null, map: null, view: null, online: null };
  let q: URLSearchParams;
  try { q = new URLSearchParams(search); } catch { return out; }
  const get = (key: string): string | null => q.get(key)?.toLowerCase() ?? null;
  const mode = get('mode');
  if (mode === 'play') out.play = true;
  else if (mode === 'explore') out.play = false;
  const map = q.get('map');
  if (map && MAP_STEM.test(map)) out.map = map.toUpperCase();
  const view = get('view');
  if (view === 'modern' || view === 'ps2') out.view = view;
  const online = get('online');
  if (online === 'off' || online === 'shared' || online === 'local') out.online = online;
  return out;
}

/** A query part's key, decoded; the part itself when it cannot be. */
function keyOf(part: string): string {
  const raw = part.split('=')[0]!.replace(/\+/g, ' ');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * The query string with `state` written in: its settings first, in a fixed order, then every other parameter as
 * it was. `''` when nothing is left. By hand rather than through `URLSearchParams`, which writes `&fly` back as `&fly=`.
 */
export function writeShare(search: string, state: ShareState): string {
  const parts = search.replace(/^\?/, '').split('&').filter((p) => p !== '');
  const had = new Map<string, string>();
  const rest: string[] = [];
  for (const part of parts) {
    const key = keyOf(part);
    if (RETIRED_PARAMS.includes(key) || state.drop?.includes(key)) continue;
    if ((KEYS as readonly string[]).includes(key)) { if (!had.has(key)) had.set(key, part); continue; }
    rest.push(part);
  }
  const wanted: Record<(typeof KEYS)[number], string | null | undefined> = {
    mode: state.play === undefined ? undefined : state.play === null ? null : state.play ? 'play' : 'explore',
    map: state.map === undefined ? undefined : state.map === null ? null : state.map,
    view: state.view,
    online: state.online,
  };
  const ours: string[] = [];
  for (const key of KEYS) {
    const value = wanted[key];
    if (value === null) continue;
    if (value === undefined) { const kept = had.get(key); if (kept) ours.push(kept); continue; }
    ours.push(`${key}=${encodeURIComponent(value)}`);
  }
  const all = [...ours, ...rest];
  return all.length ? `?${all.join('&')}` : '';
}

/** The parameters that beat `online=` on load (`./online` `resolveOnline`, `./netPage` `netSettings`). */
export const ONLINE_OVERRIDES: readonly string[] = ['server', 'mp'];

/**
 * The address after the visitor picks an Online choice: the choice written, and the `server=` / `mp` that beat it on
 * load taken out, so a reload and the copied link join what the visitor chose, not the server the link had named.
 */
export function onlineChoiceAddress(choice: OnlineChoice): ShareState {
  return { online: choice, drop: ONLINE_OVERRIDES };
}

/** Writes `state` into the page's address without a reload or a history entry; best-effort (a `file:` page has none). */
export function updateAddress(state: ShareState): void {
  try {
    const loc = globalThis.location;
    if (!loc) return;
    const search = writeShare(loc.search, state);
    if (search === loc.search) return;
    globalThis.history?.replaceState(globalThis.history.state, '', `${loc.pathname}${search}${loc.hash}`);
  } catch { /* a page without a history */ }
}
