import { resolveOnline, type OnlineTarget } from './online';
import { RoomsPoller, roomsUrl, type PlayerCounts, type RoomsPollerOptions } from './playersOnline';
import type { ShareState } from './shareUrl';

/**
 * The multiplayer switch (owner, 2026-09-30: "release the existing [redotcom] to /redotcom in its current state with
 * multiplayer disabled"). One build-time value, `VITE_S2U_MULTIPLAYER`: on unless it says `off` (or `0`, `false`, `no`),
 * so `npm run dev` and a plain build keep multiplayer, and the site's release build (`web/shared/deploy/site/deploy.sh`)
 * sets it off.
 *
 * Off, the page is single player and talks to no match server:
 * - the settings' **Online** section (the switch, its line, the name field) is taken out of the page, not hidden;
 * - the panel's kicker is the product's name, `redotcom`, with no PLAYERS ONLINE count;
 * - the `/rooms` poll never starts (no request to the shared server or to a local one);
 * - the address's `online`, `mp` and `server` are ignored and taken out of it;
 * - no `NetClient` is ever made for a server -- the target is always none;
 * - the Controls lists say multiplayer is off in this build.
 * The offline match (`./net/loopback`, the match server's room in the page, reCOM mode against yourself) stays: it is
 * single player and needs no network.
 */

/** Whether the build's `VITE_S2U_MULTIPLAYER` leaves multiplayer on: anything but `off`, `0`, `false` or `no` (case aside). */
export function multiplayerEnabled(flag: string | undefined): boolean {
  const v = (flag ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

/** The address's multiplayer parameters: ignored with multiplayer off, and taken out of the address. */
export const MULTIPLAYER_PARAMS: readonly string[] = ['online', 'mp', 'server'];

/** The panel's kicker with multiplayer off: the product's name (the design system's kicker), no count. */
export const SINGLE_PLAYER_KICKER = 'redotcom';

/** No server to join. */
export const NO_SERVER: OnlineTarget = { choice: 'off', url: null, fromUrl: false };

/** The address with multiplayer off: `online=` written out and `mp` / `server` dropped (`./shareUrl` `writeShare`). */
export function singlePlayerAddress(): ShareState {
  return { online: null, drop: MULTIPLAYER_PARAMS };
}

/**
 * The server the page joins (`./online` `resolveOnline`): with multiplayer off, none -- the address and the remembered
 * choice are not read at all.
 */
export function onlineTarget(
  enabled: boolean, search: string, stored: () => string | null, location: { protocol: string; host: string; hostname?: string },
): OnlineTarget {
  return enabled ? resolveOnline(search, stored(), location) : NO_SERVER;
}

/** The PLAYERS ONLINE poll (`./playersOnline`), or none with multiplayer off: nothing is made, so nothing is asked. */
export function playersPoller(
  enabled: boolean, choice: OnlineTarget['choice'], override: string | undefined, onCounts: (c: PlayerCounts | null) => void,
  options: Omit<RoomsPollerOptions, 'url' | 'onCounts'> = {},
): RoomsPoller | null {
  return enabled ? new RoomsPoller({ ...options, url: roomsUrl(choice, override), onCounts }) : null;
}

/**
 * The page's markup with multiplayer off, before `Ui` reads it: the Online section out, and the kicker the product's
 * name alone (its count and the tooltip about the server gone).
 */
export function stripMultiplayerUi(doc: Document = document): void {
  doc.getElementById('mp-section')?.remove();
  const kicker = doc.getElementById('panel-kicker');
  if (kicker) {
    kicker.removeAttribute('title');
    kicker.textContent = SINGLE_PLAYER_KICKER;
  }
}
