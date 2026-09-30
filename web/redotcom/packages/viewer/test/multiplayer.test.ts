import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { CollisionOwner, GridParams, SpawnSlot, WorldPoly } from '@s2u/scene';
import {
  multiplayerEnabled, MULTIPLAYER_PARAMS, NO_SERVER, onlineTarget, playersPoller, SINGLE_PLAYER_KICKER, singlePlayerAddress,
  stripMultiplayerUi,
} from '../src/multiplayer';
import { resolveOnline, SHARED_SERVER } from '../src/online';
import { SHARED_ROOMS } from '../src/playersOnline';
import { updateAddress, writeShare } from '../src/shareUrl';
import { controlGroups, GROUP_GENERAL, MULTIPLAYER_OFF_ROW, padControlGroups } from '../src/controlsList';
import { NetClient, type NetWalk } from '../src/net/client';
import { LoopbackMatch, simMapOfLoaded } from '../src/net/loopback';
import { packGround, type Command, type ServerEvent } from '../src/sim';
import { Ui } from '../src/ui';

/**
 * The multiplayer switch (owner, 2026-09-30: "release the existing [redotcom] to /redotcom in its current state with
 * multiplayer disabled"; `../src/multiplayer`): `VITE_S2U_MULTIPLAYER=off`, the site's release build, is single player
 * -- no Online section, no PLAYERS ONLINE count, no request to any match server, the address's multiplayer parameters
 * dropped -- and the offline match still plays. On (the default), nothing changes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../index.html'), 'utf-8');
const load = (): void => { document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML; };
const PAGE = { protocol: 'https:', host: 'socomunzipped.com', hostname: 'socomunzipped.com' };
const LOCAL_PAGE = { protocol: 'http:', host: 'localhost:5173', hostname: 'localhost' };

describe('the switch: VITE_S2U_MULTIPLAYER', () => {
  it('is on unless it says off (0, false, no; case and spaces aside): dev and a plain build keep multiplayer', () => {
    for (const on of [undefined, '', 'on', '1', 'true', 'yes', 'anything']) expect(multiplayerEnabled(on), String(on)).toBe(true);
    for (const off of ['off', 'OFF', ' off ', '0', 'false', 'False', 'no']) expect(multiplayerEnabled(off), off).toBe(false);
  });

  it('the site\'s release build sets it off (web/shared/deploy/site/deploy.sh\'s redotcom build line)', () => {
    const script = readFileSync(resolve(here, '../../../../shared/deploy/site/deploy.sh'), 'utf-8');
    const builds = script.split('\n').filter((l) => !l.trimStart().startsWith('#') && /npm run build -w @s2u\/redotcom/.test(l));
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatch(/\bVITE_S2U_MULTIPLAYER=off\b/);
    expect(builds[0]).toMatch(/\bVIEWER_BASE=\/redotcom\//);
  });
});

describe('multiplayer off: the page', () => {
  beforeEach(() => { load(); stripMultiplayerUi(); });

  it('has no Online section: the switch, its line and the name field are not in the DOM (removed, not hidden)', () => {
    for (const id of ['mp-section', 'online', 'online-label', 'online-state', 'online-text', 'mp-name']) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(document.querySelector('[data-online]')).toBeNull();
    expect(document.getElementById('panel-body')!.textContent).not.toMatch(/Join the map.s match/);
  });

  it('the kicker is the plain title redotcom: no PLAYERS ONLINE, no count, no server tooltip', () => {
    const kicker = document.getElementById('panel-kicker')!;
    expect(kicker.textContent).toBe(SINGLE_PLAYER_KICKER);
    expect(SINGLE_PLAYER_KICKER).toBe('redotcom');
    expect(kicker.classList.contains('s2u-kicker')).toBe(true);
    expect(kicker.hasAttribute('title')).toBe(false);
    expect(document.getElementById('players-online')).toBeNull();
  });

  it('the Ui is made on the stripped page, a counts reading leaves the kicker alone, and the Controls lists say multiplayer is off', () => {
    const ui = new Ui();
    ui.setPlayerCounts({ total: 7, byMap: new Map([['MP2', 7]]) });
    expect(document.getElementById('panel-kicker')!.textContent).toBe('redotcom');
    ui.setCameraHint(1, false);
    for (const list of ['#keys-list', '#pad-list']) {
      expect(document.querySelector(list)!.textContent, list).toContain('off in this build');
    }
  });

  it('both lists, every mode: General ends with the multiplayer-off row', () => {
    for (const make of [controlGroups, padControlGroups]) {
      for (const mode of ['walk', 'fly'] as const) {
        for (const toggle of [false, true]) {
          const general = make(mode, toggle, false).find((g) => g.name === GROUP_GENERAL)!;
          expect(general.rows.at(-1)).toEqual(MULTIPLAYER_OFF_ROW);
        }
      }
    }
    expect(MULTIPLAYER_OFF_ROW.does).toMatch(/off in this build/);
  });
});

describe('multiplayer off: the address', () => {
  it('online, mp and server are ignored: no server whatever the address or the memory says', () => {
    const stored = vi.fn(() => 'shared');
    for (const search of ['?online=shared', '?mp', '?server=wss%3A%2F%2Fevil.example%2Fws', '?online=local&mp&server=ws://localhost:8787/ws']) {
      expect(onlineTarget(false, search, stored, PAGE), search).toEqual(NO_SERVER);
      expect(onlineTarget(false, search, stored, LOCAL_PAGE), search).toEqual(NO_SERVER);
    }
    expect(stored).not.toHaveBeenCalled();
    expect(NO_SERVER.url).toBeNull();
  });

  it('they are taken out of the address; everything else stays as it was', () => {
    expect(MULTIPLAYER_PARAMS).toEqual(['online', 'mp', 'server']);
    expect(writeShare('?mode=play&map=MP2&online=shared&mp&server=wss%3A%2F%2Fx%2Fws&devmode&lag=80', singlePlayerAddress()))
      .toBe('?mode=play&map=MP2&devmode&lag=80');
    expect(writeShare('?online=local', singlePlayerAddress())).toBe('');
  });

  it('the page\'s own address is rewritten without them (no reload)', () => {
    history.replaceState(null, '', '/redotcom/?map=MP2&online=shared&mp&server=wss%3A%2F%2Fx%2Fws');
    updateAddress(singlePlayerAddress());
    expect(location.pathname).toBe('/redotcom/');
    expect(location.search).toBe('?map=MP2');
    history.replaceState(null, '', '/');
  });
});

// ---- the offline match, with no network at all ------------------------------------------------------------------------

const PARAMS: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 10, cellsZ: 10, originX: -1000, originZ: -1000 };
function loaded() {
  const floor: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-1000, 0, -1000, 1000, 0, -1000, 1000, 0, 1000, -1000, 0, 1000]),
  };
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
  const slot = (side: 0 | 1, index: number, x: number, z: number): SpawnSlot => ({
    side, index, position: [x, 0, z], onFloor: true, step: 2, facing: [1, 0], loc: { map: 0, x: 0, z: 0 },
  });
  return {
    path: 'RUN/MP99.ZDB', name: 'FLAT', ground: packGround(PARAMS, [floor], owners),
    slots: [slot(0, 0, -100, 0), slot(1, 0, 100, 0)], respawns: [slot(0, 0, -300, 0)], doors: [],
  };
}
class Walk implements NetWalk {
  tap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null = null;
  spawns = 0;
  feet: [number, number, number] = [0, 0, 0];
  setNetTap(tap: Walk['tap']): void { this.tap = tap; }
  respawn(at: readonly [number, number, number]): boolean { this.spawns++; this.feet = [at[0], at[1], at[2]]; return true; }
  nudge(): void { /* still */ }
  setLocked(): void { /* free */ }
  knock(): boolean { return true; }
  tick(): void { this.tap?.({ forward: 0, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 }, this.feet); }
}
const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('multiplayer off: no request to any host, and the offline match still plays', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let socketSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response('[]'));
    socketSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('WebSocket', socketSpy);
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('the PLAYERS ONLINE poll is never made, so /rooms is never asked, on any host', async () => {
    const told = vi.fn();
    for (const choice of ['off', 'shared', 'local', 'url'] as const) {
      expect(playersPoller(false, choice, undefined, told)).toBeNull();
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(told).not.toHaveBeenCalled();
  });

  it('the offline match joins, stands the SEAL and plays its round -- with no fetch and no WebSocket', async () => {
    const target = onlineTarget(false, '?mode=play&online=shared&mp', () => 'shared', PAGE);
    expect(target.url).toBeNull();    // main.ts `connectNet`: no server, so the offline match (`./net/loopback`)
    const match = new LoopbackMatch(simMapOfLoaded(loaded()), null, { auto: false });
    const walk = new Walk();
    const events: ServerEvent[] = [];
    const client = new NetClient({ url: 'loopback:', map: 'MP99', name: 'Solo', socket: match.socket }, walk);
    client.on((ev) => events.push(ev));
    await flush();
    expect(client.state).toBe('open');
    expect(client.role).toBe('player');
    expect(walk.spawns).toBe(1);
    for (let i = 0; i < 30; i++) { walk.tick(); match.step(); }
    await flush();
    expect(events.some((e) => e.type === 'score')).toBe(true);
    expect(match.room.player(client.id)!.sim.seq).toBeGreaterThanOrEqual(29);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  });
});

describe('multiplayer on (the default): today\'s behaviour', () => {
  beforeEach(load);
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('the page keeps its Online section and PLAYERS ONLINE kicker, and the lists no multiplayer-off row', () => {
    expect(document.getElementById('mp-section')).not.toBeNull();
    expect(document.getElementById('players-online')).not.toBeNull();
    expect(document.getElementById('panel-kicker')!.textContent).toMatch(/Players online/);
    const ui = new Ui();
    ui.setCameraHint(1, false);
    expect(document.querySelector('#keys-list')!.textContent).not.toContain('off in this build');
    expect(document.querySelector('#pad-list')!.textContent).not.toContain('off in this build');
    for (const make of [controlGroups, padControlGroups]) {
      for (const mode of ['walk', 'fly'] as const) expect(make(mode, false)).toEqual(make(mode, false, true));
    }
  });

  it('the address and the memory choose the server as before (resolveOnline)', () => {
    for (const [search, stored] of [['?online=shared', null], ['?mp', null], ['', 'shared'], ['', null], ['?server=wss%3A%2F%2Fx%2Fws', 'off']] as const) {
      expect(onlineTarget(true, search, () => stored, PAGE), search).toEqual(resolveOnline(search, stored, PAGE));
    }
    expect(onlineTarget(true, '', () => 'shared', PAGE).url).toBe(SHARED_SERVER);
  });

  it('the PLAYERS ONLINE poll is made and asks the shared server\'s /rooms', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.useFakeTimers();
    const poller = playersPoller(true, 'off', undefined, () => undefined, { fetch: fetchSpy as unknown as typeof fetch })!;
    expect(poller).not.toBeNull();
    poller.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchSpy).toHaveBeenCalled();
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toBe(SHARED_ROOMS);
    poller.stop();
  });
});
