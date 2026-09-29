import { describe, expect, it } from 'vitest';
import { Hud } from '../src/hud';
import { NetPage, type NetPageDeps } from '../src/netPage';
import type { WebSocketLike } from '../src/net/client';
import type { Rules, ServerEvent } from '../src/net/protocol';
import type { RemotePlayers } from '../src/remotePlayers';
import type { WalkMode } from '../src/walk';
import { HELD_RIFLE, HELD_SIDEARM } from '@s2u/scene';

/**
 * The page in a match, by its rules: the round-start banner driven from the server's round (`FUN_001fb420`), the
 * classic round's messages and the dead's follow camera. A fake socket stands in for the server.
 */

function page(rules: Rules) {
  const sent: string[] = [];
  let socket: WebSocketLike | null = null;
  const hud = new Hud();
  hud.setVisible(true);
  const modes: string[] = [];
  const poses: ({ x: number } | null)[] = [];
  const walk = {
    setNetTap: () => undefined, setLocked: () => undefined, respawn: () => true, nudge: () => undefined,
    setTrigger: () => undefined, setDeathPose: () => undefined, setMode: (m: string) => { modes.push(m); return true; },
    mode: () => 'walk',
  } as unknown as WalkMode;
  const bodies: { id: number; flags: number; feet: [number, number, number]; yaw: number }[] = [];
  const remote = { setTeam: () => undefined, forget: () => undefined, died: () => undefined, clear: () => undefined, frame: () => undefined } as unknown as RemotePlayers;
  const deps: NetPageDeps = {
    walk, remote, hud, clips: () => null, remoteGrenade: () => undefined, spectate: (p) => { poses.push(p); },
    roundEffects: () => undefined, weapons: [HELD_RIFLE, HELD_SIDEARM],
    socket: () => {
      socket = { binaryType: '', readyState: 1, send: (d: string | Uint8Array) => { if (typeof d === 'string') sent.push(d); }, close: () => undefined } as unknown as WebSocketLike;
      return socket;
    },
  };
  const net = new NetPage(deps, 'ws://test/ws', 'MP2', 'Tester', undefined, false, rules);
  socket!.onopen?.({} as Event);
  const server = (ev: ServerEvent): void => { socket!.onmessage?.({ data: JSON.stringify(ev) } as MessageEvent); };
  // The client reads the bodies from its snapshots; the tests hand them in directly.
  (net.client as unknown as { bodies: () => unknown[] }).bodies = () => bodies;
  const banner = (): string[] => hud.state().model.banner.map((b) => b.lines.map((l) => l.text).join('/'));
  const welcome = (over: Partial<Extract<ServerEvent, { type: 'welcome' }>> = {}): void => server({
    type: 'welcome', id: 1, version: 4, map: 'MP2', tick: 0, role: 'player', team: 'seal', queue: 0, name: 'Tester',
    players: [], rules, round: 1, rounds: 11, ghost: false, ...over,
  });
  return { net, hud, sent, server, banner, welcome, bodies, modes, poses };
}

describe('the round-start banner online (FUN_001fb420 L57633-57648)', () => {
  it('the hello names the rules', () => {
    const { sent } = page('classic');
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: 'hello', version: 4, map: 'MP2', rules: 'classic' });
  });

  it('respawn keeps the original\'s quirk: STARTING ROUND 1 OF 11 for its one round, at the join and at each match', () => {
    const { hud, server, banner, welcome } = page('respawn');
    hud.step(20);
    welcome();
    hud.step(1);
    expect(banner()).toEqual(['STARTING ROUND 1 OF 11']);
    hud.step(20);
    server({ type: 'roundStart', round: 1, seconds: 360, wins: { seal: 0, terrorist: 0 }, rounds: 11 });
    hud.step(6);
    expect(banner()).toEqual(['STARTING ROUND 1 OF 11', 'OBJECTIVE:/ELIMINATE THE TERRORISTS']);
  });

  it('classic shows the true round of 11, then PLAYING TIEBREAKER ROUND; the objective by side', () => {
    const { hud, server, banner, welcome } = page('classic');
    welcome({ team: 'terrorist' });
    hud.step(20);
    server({ type: 'roundStart', round: 3, seconds: 360, wins: { seal: 1, terrorist: 1 }, rounds: 11 });
    hud.step(6);
    expect(banner()).toEqual(['STARTING ROUND 3 OF 11', 'OBJECTIVE:/ELIMINATE THE SEALS']);
    hud.step(20);
    server({ type: 'roundStart', round: 12, seconds: 360, wins: { seal: 5, terrorist: 5 }, rounds: 11 });
    hud.step(1);
    expect(banner()).toEqual(['PLAYING TIEBREAKER ROUND']);
  });

  it('a ghost gets no banner at the join, and the game\'s ghost lines', () => {
    const { hud, banner, welcome } = page('classic');
    hud.step(20);
    welcome({ ghost: true });
    hud.step(1);
    expect(banner()).toEqual(['You are a ghost.  You will play the next/round as a real player.  R2 Select new/weapons.  Use the directional/buttons to cycle through living teammates.']);
  });
});

describe('the classic round on the page', () => {
  it('posts the elimination lines', () => {
    const { hud, server, banner, welcome } = page('classic');
    welcome();
    hud.step(20);
    server({ type: 'eliminated', winner: 'seal' });
    hud.step(0.5);
    expect(banner()).toEqual(['ALL TERRORISTS ELIMINATED/SEALS VICTORIOUS!']);
  });

  it('dead: the game\'s lines, never the respawn prompt; Space follows the living teammates only', () => {
    const { net, hud, server, banner, welcome, bodies, modes, poses } = page('classic');
    welcome();
    server({ type: 'joined', id: 2, name: 'Mate', team: 'seal' });
    server({ type: 'joined', id: 3, name: 'Foe', team: 'terrorist' });
    server({ type: 'joined', id: 4, name: 'Down', team: 'seal' });
    bodies.push({ id: 2, flags: 64, feet: [100, 0, 0], yaw: 0 }, { id: 3, flags: 64, feet: [300, 0, 0], yaw: 0 }, { id: 4, flags: 0, feet: [500, 0, 0], yaw: 0 });
    hud.step(20);
    server({ type: 'kill', killer: 3, victim: 1, weapon: '552', how: 'weapon', clip: null });
    hud.step(6);
    const lines = banner();
    expect(lines).toContain('You have died.  R2 Select new weapons./Use the directional buttons/to cycle through living teammates');
    expect(lines.some((l) => l.includes('respawn'))).toBe(false);
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    net.frame(0.016, {} as never, false);
    expect(modes).toContain('fly');
    expect(poses.at(-1)!.x).toBeCloseTo(100, 0);                // the living teammate, not the foe nor the dead one
    net.close();
  });
});
