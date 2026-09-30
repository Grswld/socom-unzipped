import { netSettings } from './netPage';
import type { Simulate } from './net/client';

/**
 * The panel's **Online** setting (owner, 2026-09-29): Off (the single page, as before), Shared (the public match server)
 * or Local (the static server `npm start -w @s2u/server` runs on this machine). Remembered in this browser (`ONLINE_KEY`).
 * Local is a developer's: offered only on a page served from this machine (`isLocalHost`; owner, 2026-09-29: "Make sure
 * the localhost option is only visible locally, never on the deployed site"). Elsewhere the option is not rendered, and
 * an `online=local` link or a remembered Local reads as Off (the page then writes Off into its address).
 * In reCOM mode the page joins the match as a player (`./netPage`); in the map viewer it joins as a spectator that
 * never takes a player's place (the hello's `watch`), to watch the match on the map.
 *
 * The URL still overrides it, as before the setting: `&mp` joins the server at this page's host (`/ws`) and
 * `&server=wss://host/ws` names one (`netSettings`); `&lag=`/`&loss=` run the latency injector either way.
 */

export type OnlineChoice = 'off' | 'shared' | 'local';
export const ONLINE_CHOICES: readonly OnlineChoice[] = ['off', 'shared', 'local'];

/** The public match server (web/deploy: Caddy in front of `@s2u/server`). */
export const SHARED_SERVER = 'wss://mp.socomunzipped.com/ws';
/** `npm start -w @s2u/server`'s default: PORT 8787 on this machine. */
export const LOCAL_SERVER = 'ws://localhost:8787/ws';

/** Where the choice is remembered. */
export const ONLINE_KEY = 's2u.viewer.online';

/**
 * Whether a host (`location.host` or `.hostname`: a port and IPv6 brackets are fine) is this machine: `localhost`,
 * `127.0.0.1`, `[::1]` or a name under `.localhost` (RFC 6761), case aside.
 */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]!;
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1' || name.endsWith('.localhost');
}

/** Whether the page is served from this machine (so Local is offered). */
export function pageIsLocal(location: { host: string; hostname?: string }): boolean {
  return isLocalHost(location.hostname || location.host);
}

/** The choices the setting offers: Local only on a local page. */
export function onlineChoices(local: boolean): readonly OnlineChoice[] {
  return local ? ONLINE_CHOICES : ONLINE_CHOICES.filter((c) => c !== 'local');
}

/** A stored or linked value, read back: one of the choices offered (`local`: whether Local is), or Off. */
export function onlineChoice(stored: string | null, local = true): OnlineChoice {
  return stored === 'shared' || (stored === 'local' && local) ? stored : 'off';
}

export interface OnlineTarget {
  /** What the panel shows as chosen: one of the three, or 'url' for a server the URL named that is neither. */
  choice: OnlineChoice | 'url';
  /** The server to join, or null for none. */
  url: string | null;
  /** True when the URL (`&mp`, `&server=`) decided it rather than the setting. */
  fromUrl: boolean;
  simulate?: Simulate;
}

/**
 * The server the page joins: the URL's `&mp` / `&server=` first (an override, as before the setting), else the stored
 * choice's -- Local only on a local page (`pageIsLocal`), else Off. `location` is the page's own, for `&mp`'s default of this host.
 */
export function resolveOnline(search: string, stored: string | null, location: { protocol: string; host: string; hostname?: string }): OnlineTarget {
  const fromUrl = netSettings(search, location);
  const q = new URLSearchParams(search);
  const lag = Number(q.get('lag') ?? '0'), loss = Number(q.get('loss') ?? '0');
  const simulate: Simulate | undefined = lag > 0 || loss > 0 ? { latencyMs: lag, jitterMs: lag / 5, loss: loss / 100 } : undefined;
  if (fromUrl) {
    const choice = fromUrl.url === SHARED_SERVER ? 'shared' : fromUrl.url === LOCAL_SERVER ? 'local' : 'url';
    return { choice, url: fromUrl.url, fromUrl: true, ...(fromUrl.simulate ? { simulate: fromUrl.simulate } : {}) };
  }
  const choice = onlineChoice(stored, pageIsLocal(location));
  const url = choice === 'shared' ? SHARED_SERVER : choice === 'local' ? LOCAL_SERVER : null;
  return { choice, url, fromUrl: false, ...(simulate && url ? { simulate } : {}) };
}

/** The remembered choice, best-effort both ways (storage throws in a private window). */
export function readOnline(): string | null {
  try { return globalThis.localStorage?.getItem(ONLINE_KEY) ?? null; } catch { return null; }
}
export function writeOnline(choice: OnlineChoice): void {
  try { globalThis.localStorage?.setItem(ONLINE_KEY, choice); } catch { /* Off next time */ }
}

/** The connection as the panel shows it (`NetPage.status`). */
export interface OnlineStatus {
  /** `offline`: Online is off and the page's own match runs (`./net/loopback`); `off`: Online off, no match at all. */
  state: 'off' | 'offline' | 'connecting' | 'online' | 'retrying' | 'refused';
  /** Players in the match, when online. */
  players: number;
  /** Seconds to the next attempt, when retrying. */
  retryIn: number;
  /** Whether this page watches (the map viewer) rather than plays. */
  watching: boolean;
  /** The server's reason, when refused. */
  reason?: string;
}

/** The one line the panel writes under the setting, and whether the lamp is up, down or neither. */
export function onlineLine(s: OnlineStatus): { text: string; lamp: 'up' | 'down' | null } {
  switch (s.state) {
    case 'off': return { text: 'single player: no server', lamp: null };
    case 'offline': return { text: 'offline match · no server', lamp: null };
    case 'connecting': return { text: 'connecting ...', lamp: null };
    case 'online': return { text: `online · ${s.players} ${s.players === 1 ? 'player' : 'players'}${s.watching ? ' · watching' : ''}`, lamp: 'up' };
    case 'retrying': return { text: `server unreachable · retrying in ${Math.max(1, Math.ceil(s.retryIn))} s`, lamp: 'down' };
    case 'refused': return { text: `refused: ${s.reason ?? 'by the server'}`, lamp: 'down' };
  }
}
