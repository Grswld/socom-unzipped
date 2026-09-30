import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELD_RIFLE, HELD_SIDEARM, type CollisionOwner, type GridParams, type SpawnSlot, type WorldPoly } from '@s2u/scene';
import { FlyCamera } from '../src/camera';
import { packGround, WalkMode } from '../src/walk';
import { NetClient, type WebSocketLike } from '../src/net/client';
import { LoopbackMatch, simMapOfLoaded } from '../src/net/loopback';
import { blastKnock, deathClip, PART, RESPAWN_RULES_ENABLED, TICK_HZ, type ServerEvent } from '../src/sim';
import { ELIMINATED_HOLD_S, eliminationLines, MAX_ROUNDS, roundBanner, ROUND_WATCH_S } from '../src/net/rules';
import { DEAD_LINES, NetPage } from '../src/netPage';
import { Hud } from '../src/hud';
import { roundScreenLayout } from '../src/roundScreens';
import type { RemotePlayers } from '../src/remotePlayers';
import { ENGINE_READ_S, ROUND_COMPLETE_S } from '../../server/src/room';

const M67 = { explosionRadius: 150 };
import { DEATH_EYE_REACH, DEATH_ORBIT_RATE, DEATH_TILT_MAX, deathEye, newDeathCamera } from '../src/deathCamera';

/**
 * The page's OWN death (owner's play-test, 2026-09-29: "I took damage from being exploded in offline mode but my
 * character did not fall over ... He stayed standing waiting for respawn, unable to move"). The game throws a SEAL its
 * blast kills (`FUN_0057e770` L440981: inside the radius or dead; state 8 at L441001), lands it in `Land forward` /
 * `Land backwards` and leaves it down (no get-up for the dead); the dead's camera is the death camera
 * (`FUN_00297a30`). The page's real `WalkMode`, driven by the real `NetClient`, offline through the loopback room and
 * online through a socket fed the server's events.
 *
 * What stands the SEAL up again depends on the rules. The page ships classic (`RESPAWN_RULES_ENABLED` off, the owner's
 * ruling of 2026-09-29), offline too: the dead do not respawn (`FUN_002a7560` L149405-149431) and watch until the next
 * round (`FUN_005979a0` L454484-454489). Offline the one SEAL is its whole side, so its death eliminates the SEALs
 * (MP51 `objectives` `start`: `aiteam_00` == 0 after WAIT 5 + WAIT 10; the empty Terrorist side is never eliminated,
 * SOLO_ROUND_PLACEHOLDER, research 91 section 20), the Terrorists win the round, and the next round stands a fresh SEAL
 * at its start slot (`FUN_00223680` L75913-75931). The respawn ruleset (kept behind the switch) stands a new SEAL at a
 * respawn record on the press after the fade (research 91 section 4.1); its test forces the switch on.
 */

const PARAMS: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 10, cellsZ: 10, originX: -1000, originZ: -1000 };
const FLOOR: WorldPoly = {
  modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
  points: Float32Array.from([-1000, 0, -1000, 1000, 0, -1000, 1000, 0, 1000, -1000, 0, 1000]),
};
const OWNERS: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
const ground = () => packGround(PARAMS, [FLOOR], OWNERS);

const slot = (side: 0 | 1, index: number, x: number, z: number): SpawnSlot => ({
  side, index, position: [x, 0, z], onFloor: true, step: 2, facing: [1, 0], loc: { map: 0, x: 0, z: 0 },
});

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  return c;
};

function walkRig() {
  const fly = new FlyCamera(canvas());
  const walk = new WalkMode(fly);
  walk.setGround(ground(), [0, 0, 0]);
  fly.setPose({ x: -100, y: 40, z: 0, yaw: 0, pitch: 0 });
  let wish = { forward: 0, right: 0, boost: false };
  fly.groundWish = () => wish;
  return { fly, walk, setWish: (w: typeof wish) => { wish = w; } };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

/** A seeded draw for the room; `script` is spent first. */
function draw() {
  let seed = 1;
  const script: number[] = [];
  const random = (): number => {
    if (script.length) return script.shift()!;
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  return { script, random };
}

/** The test map: one SEAL start slot at x -100, its respawn twin at x -300 (the Terrorists' slot empty offline). */
const LOADED = () => ({ path: 'RUN/MP99.ZDB', name: 'FLAT', ground: ground(), slots: [slot(0, 0, -100, 0), slot(1, 0, 100, 0)], respawns: [slot(0, 0, -300, 0)], doors: [] });

/**
 * The single-player match with the page's real walk; `script` is the room's draw, spent first. `respawnRules` forces the
 * respawn ruleset on (it is off as the page ships: the room plays classic).
 */
async function offline(respawnRules = RESPAWN_RULES_ENABLED) {
  const { script, random } = draw();
  const match = new LoopbackMatch(simMapOfLoaded(LOADED()), null, { auto: false, random, respawnRules });
  const rig = walkRig();
  const events: ServerEvent[] = [];
  const client = new NetClient({ url: 'loopback:', map: 'MP99', name: 'Solo', socket: match.socket }, rig.walk);
  client.on((ev) => events.push(ev));
  await flush();
  /** `n` page frames at 60 Hz, the room stepped once after each. */
  const run = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) { rig.walk.frame(1 / TICK_HZ); match.step(); await flush(); }
  };
  return { ...rig, match, client, events, script, run };
}

/**
 * The offline match as the page plays it (`main.ts`): the real `NetPage` -- its HUD's banner and round screens, its
 * scoreboard rows -- joined to the loopback room with the page's real walk, on a clock the test runs (the page's
 * `performance.now`, the room's and the screens' alike).
 */
async function offlinePage() {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const { random } = draw();
  const match = new LoopbackMatch(simMapOfLoaded(LOADED()), null, { auto: false, random });
  const rig = walkRig();
  const hud = new Hud();
  hud.setVisible(true);
  const remote = { setTeam: () => undefined, forget: () => undefined, died: () => undefined, clear: () => undefined, frame: () => undefined } as unknown as RemotePlayers;
  const respawned: number[] = [];
  const net = new NetPage({
    walk: rig.walk, remote, hud, clips: () => null, remoteGrenade: () => undefined, spectate: () => undefined,
    respawned: () => { respawned.push(clock); }, roundEffects: () => undefined, weapons: [HELD_RIFLE, HELD_SIDEARM],
    socket: match.socket, solo: true,
  }, 'loopback:', 'MP99', 'Solo', undefined, false, 'classic');
  const events: ServerEvent[] = [];
  net.client.on((ev) => events.push(ev));
  await flush();
  /** Every message the HUD has up now, its lines joined by '/'. */
  const banner = (): string[] => hud.state().model.banner.map((b) => b.lines.map((l) => l.text).join('/'));
  /** Every message the HUD put up while `n` frames ran. */
  const posted = new Set<string>();
  /** `n` page frames at 60 Hz (the walk, the page, the HUD), the room stepped once after each. */
  const run = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      clock += 1000 / TICK_HZ;
      rig.walk.frame(1 / TICK_HZ);
      net.frame(1 / TICK_HZ, {} as never, false);
      hud.step(1 / TICK_HZ);
      for (const b of banner()) posted.add(b);
      match.step();
      await flush();
    }
  };
  /** Frames until the `count`th event of `type` has come (at most `max`); the frames it took. */
  const until = async (type: ServerEvent['type'], max: number, count = 1): Promise<number> => {
    for (let i = 0; i < max; i++) { if (events.filter((e) => e.type === type).length >= count) return i; await run(1); }
    throw new Error(`no ${type} in ${max} frames`);
  };
  return { ...rig, match, net, hud, events, respawned, banner, posted, run, until, tick: () => match.room.tick };
}

afterEach(() => { vi.restoreAllMocks(); });

/** The action names the page's mover went through, frame by frame (repeats dropped). */
function track(walk: WalkMode, seen: string[]): void {
  const n = walk.snapshot()?.action?.name ?? 'none';
  if (seen[seen.length - 1] !== n) seen.push(n);
}

describe('the page\'s own death by a blast, offline (the loopback room)', () => {
  it('an M67 at its own feet throws the body, lands it and keeps it down; the room\'s corpse agrees', async () => {
    const ctx = await offline();
    await ctx.run(5);
    const id = ctx.client.id;
    const feet0 = ctx.walk.feet()!;
    ctx.client.send({ type: 'throw', seq: ctx.client.lastSeq(), kind: 'M67', from: [feet0[0], feet0[1] + 16.4, feet0[2]], velocity: [0, 0, 0] });
    const seen: string[] = [];
    for (let i = 0; i < 3.3 * TICK_HZ + 4 * TICK_HZ; i++) { await ctx.run(1); track(ctx.walk, seen); }
    const kill = ctx.events.find((e) => e.type === 'kill') as Extract<ServerEvent, { type: 'kill' }> | undefined;
    expect(kill).toMatchObject({ victim: id, how: 'suicide' });
    const blast = ctx.events.find((e) => e.type === 'blast') as Extract<ServerEvent, { type: 'blast' }>;
    expect(blast.knock).not.toBeNull();                              // the killing blast carries its knock
    // Thrown, landed, and held down: no get-up (the game's dead stay in state 8).
    expect(seen[0]).toBe('none');
    expect(['fallForward', 'fallBackwards']).toContain(seen[1]);
    expect(['landDeath', 'landBackwards']).toContain(seen[2]);
    expect(seen).toHaveLength(3);
    const snap = ctx.walk.snapshot()!;
    expect(snap.airborne).toBe(false);
    expect(snap.action!.t).toBeCloseTo(snap.action!.seconds!, 6);   // the landing's last key
    expect(ctx.walk.isLocked()).toBe(true);
    expect(ctx.walk.isDead()).toBe(true);
    // The room's corpse (what the other screens draw) went through the same fall and lies in the same landing.
    const corpse = ctx.match.room.player(id)!.sim.walker;
    expect(corpse.dead).toBe(true);
    expect(corpse.airborne).toBe(false);
    expect(corpse.action?.name).toBe(snap.action!.name);
  });

  it('the dead body keeps its facing whatever the look does, and the camera is the death camera (mode 6, a suicide)', async () => {
    const ctx = await offline();
    await ctx.run(5);
    const feet0 = ctx.walk.feet()!;
    ctx.client.send({ type: 'throw', seq: ctx.client.lastSeq(), kind: 'M67', from: [feet0[0], feet0[1] + 16.4, feet0[2]], velocity: [0, 0, 0] });
    await ctx.run(3.3 * TICK_HZ + 2 * TICK_HZ);
    expect(ctx.walk.isDead()).toBe(true);
    const yaw = ctx.walk.snapshot()!.yaw;
    const angle = (): number => { const c = ctx.walk.cameraState()!, f = ctx.walk.feet()!; return Math.atan2(c.eye[0] - f[0], c.eye[2] - f[2]); };
    const a0 = angle();
    ctx.fly.setPose({ yaw: 120, pitch: -30 });                     // the player turns the look: the dead do not turn
    await ctx.run(TICK_HZ);
    expect(ctx.walk.snapshot()!.yaw).toBe(yaw);
    let turned = angle() - a0;
    while (turned < -Math.PI) turned += 2 * Math.PI;
    while (turned > Math.PI) turned -= 2 * Math.PI;
    expect(Math.abs(turned)).toBeGreaterThan(DEATH_ORBIT_RATE * 0.8);   // about 0.87 rad in the second
    expect(Math.abs(turned)).toBeLessThan(DEATH_ORBIT_RATE * 1.2);
    expect(ctx.walk.cameraState()!.mode).toBe('third');
  });

  it('classic, as shipped: no respawn; the lone SEAL\'s death eliminates the SEALs, the round ends, the next stands a fresh SEAL', async () => {
    expect(RESPAWN_RULES_ENABLED).toBe(false);
    const ctx = await offlinePage();
    expect(ctx.match.room.rules).toBe('classic');
    await ctx.run(5);
    const id = ctx.net.client.id;
    const start = ctx.events.find((e) => e.type === 'roundStart') as Extract<ServerEvent, { type: 'roundStart' }>;
    expect(start).toMatchObject({ round: 1, rounds: MAX_ROUNDS, wins: { seal: 0, terrorist: 0 } });
    const startedAt = ctx.tick() - 5;                              // round 1 began at the room's first step with the SEAL
    const feet0 = ctx.walk.feet()!;
    expect(feet0[0]).toBeCloseTo(-100, 3);                         // the SEAL's start slot
    // The join places the SEAL (the waiting room's spawn) and round 1 places it again (`startRound`).
    const spawns = (): number => ctx.events.filter((e) => e.type === 'spawn').length;
    const spawned = spawns(), refills = ctx.respawned.length;
    ctx.net.throwEvent('M67', [feet0[0], feet0[1] + 16.4, feet0[2]], [0, 0, 0]);
    await ctx.until('kill', 4 * TICK_HZ);
    const deadAt = ctx.tick();
    expect(ctx.events.find((e) => e.type === 'kill')).toMatchObject({ victim: id, how: 'suicide' });
    await ctx.run(3 * TICK_HZ);
    // The body down, locked, on the death camera; the game's classic lines for the dead, never the respawn prompt.
    expect(ctx.walk.isDead()).toBe(true);
    expect(ctx.walk.isLocked()).toBe(true);
    expect(['landDeath', 'landBackwards']).toContain(ctx.walk.snapshot()!.action!.name);
    expect(ctx.walk.cameraState()!.mode).toBe('third');
    expect([...ctx.posted]).toContain(DEAD_LINES.join('/'));
    // Past the fade (10 s, where the respawn room takes the press) the press stands nobody up (`FUN_002a7560`: respawn
    // needs the option) -- and it is still before the elimination is watched.
    await ctx.run(10.2 * TICK_HZ - (ctx.tick() - deadAt));
    ctx.walk.action();
    await ctx.run(3);
    expect(ctx.tick() - startedAt).toBeLessThan(ROUND_WATCH_S * TICK_HZ);
    expect(spawns()).toBe(spawned);
    expect(ctx.walk.isDead()).toBe(true);
    expect(ctx.events.some((e) => e.type === 'eliminated')).toBe(false);   // nothing is watched before 15 s
    // From 15 s into the round: no living SEAL -> "ALL SEALS ELIMINATED" / "TERRORISTS WIN!"; the empty Terrorist side
    // is not eliminated (no SEAL win, SOLO_ROUND_PLACEHOLDER).
    await ctx.until('eliminated', 15 * TICK_HZ);
    expect(ctx.tick() - startedAt).toBeGreaterThanOrEqual(ROUND_WATCH_S * TICK_HZ);
    expect(ctx.tick() - startedAt).toBeLessThanOrEqual(ROUND_WATCH_S * TICK_HZ + 2);
    expect(ctx.events.filter((e) => e.type === 'eliminated')).toEqual([{ type: 'eliminated', winner: 'terrorist' }]);
    await ctx.run(1);
    expect(ctx.banner()).toContain(eliminationLines('terrorist').map((l) => l.text).join('/'));
    expect(ctx.banner()).toContain('ALL SEALS ELIMINATED/TERRORISTS WIN!');
    // The result 23 s later (`success` / `failure` WAIT 20, WAIT 1, after `start`'s WAIT 2): the round's end.
    const decidedAt = ctx.tick();
    const over = await ctx.until('roundOver', (ELIMINATED_HOLD_S + 1) * TICK_HZ);
    expect(over).toBeGreaterThanOrEqual(ELIMINATED_HOLD_S * TICK_HZ - 2);
    expect(ctx.tick() - decidedAt).toBeLessThanOrEqual(ELIMINATED_HOLD_S * TICK_HZ + 2);
    expect(ctx.events.find((e) => e.type === 'roundOver')).toMatchObject({
      round: 1, winner: 'terrorist', wins: { seal: 0, terrorist: 1 }, matchOver: false,
      screens: [{ screen: 'roundComplete', seconds: ROUND_COMPLETE_S }],
    });
    // The scoreboard: the suicide's -2, no +1 (dead at the end), no +5 (the losing side) (`FUN_00223970` L76146-76165).
    await ctx.run(1);
    const score = ctx.events.filter((e) => e.type === 'score').at(-1) as Extract<ServerEvent, { type: 'score' }>;
    expect(score.wins).toEqual({ seal: 0, terrorist: 1 });
    expect(score.rows).toEqual([expect.objectContaining({ id, team: 'seal', kills: 0, deaths: 1, score: -2, alive: false })]);
    expect(ctx.walk.isDead()).toBe(true);                          // still down through the result
    // ROUND COMPLETE after the engine's 3 s: the SEALs LOSER, the Terrorists WINNER, the one row under the SEALs.
    await ctx.run(ENGINE_READ_S * TICK_HZ + 30);
    expect(ctx.net.screenUp()).toBe(true);
    const screen = ctx.hud.state().model.roundScreen!;
    expect(screen).toMatchObject({ kind: 'roundComplete', winner: 'terrorist', wins: { seal: 0, terrorist: 1 } });
    const texts = roundScreenLayout(screen).texts;
    expect(texts.filter((t) => t.role === 'title').map((t) => t.text)).toEqual(['ROUND COMPLETE']);
    expect(texts.filter((t) => t.role === 'result').map((t) => t.text)).toEqual(['LOSER', 'WINNER']);
    expect(texts.some((t) => t.text === 'Solo')).toBe(true);
    // The next round: the SEAL stood fresh at its start slot, not at the respawn record; the kit refilled.
    await ctx.until('roundStart', ROUND_COMPLETE_S * TICK_HZ, 2);
    const next = ctx.events.filter((e) => e.type === 'roundStart').at(-1) as Extract<ServerEvent, { type: 'roundStart' }>;
    expect(next).toMatchObject({ round: 2, rounds: MAX_ROUNDS, wins: { seal: 0, terrorist: 1 } });
    await ctx.run(3);
    expect(spawns()).toBe(spawned + 1);
    expect(ctx.respawned).toHaveLength(refills + 1);
    expect(ctx.net.screenUp()).toBe(false);
    expect(ctx.walk.isDead()).toBe(false);
    expect(ctx.walk.isLocked()).toBe(false);
    const snap = ctx.walk.snapshot()!;
    expect(snap.action).toBeNull();
    expect(snap.stance).toBe('stand');
    expect(snap.feet[0]).toBeCloseTo(-100, 3);
    expect(ctx.match.room.player(id)!.alive).toBe(true);
    ctx.fly.setPose({ yaw: 45 });
    await ctx.run(2);
    expect(ctx.walk.snapshot()!.yaw).toBeCloseTo(45, 0);           // the look is the body's again
    // The death camera is left: the eye no longer turns about the body on its own (mode 6 turned it ~0.87 rad a second).
    const angle = (): number => { const c = ctx.walk.cameraState()!, f = ctx.walk.feet()!; return Math.atan2(c.eye[0] - f[0], c.eye[2] - f[2]); };
    const a0 = angle();
    await ctx.run(TICK_HZ);
    expect(Math.abs(angle() - a0)).toBeLessThan(0.01);
    // The round's banner: "STARTING ROUND 2 OF 11" (`FUN_001fb420`), then the SEALs' objective.
    await ctx.run(6 * TICK_HZ);
    expect(roundBanner(2, MAX_ROUNDS)).toBe('STARTING ROUND 2 OF 11');
    expect([...ctx.posted]).toContain('STARTING ROUND 2 OF 11');
    expect([...ctx.posted]).toContain('OBJECTIVE:/ELIMINATE THE TERRORISTS');
    ctx.net.close();
  });

  it('respawn rules (forced on; off as shipped): the respawn stands a new SEAL -- out of the landing, unlocked, the look and the camera its own again', async () => {
    const ctx = await offline(true);
    expect(ctx.match.room.rules).toBe('respawn');
    await ctx.run(5);
    const feet0 = ctx.walk.feet()!;
    ctx.client.send({ type: 'throw', seq: ctx.client.lastSeq(), kind: 'M67', from: [feet0[0], feet0[1] + 16.4, feet0[2]], velocity: [0, 0, 0] });
    await ctx.run(3.3 * TICK_HZ + 10.5 * TICK_HZ);
    expect(ctx.walk.isDead()).toBe(true);
    ctx.walk.action();                                               // the respawn's press (research 91 section 4.1)
    await ctx.run(3);
    expect(ctx.events.filter((e) => e.type === 'spawn')).toHaveLength(2);
    expect(ctx.walk.isDead()).toBe(false);
    expect(ctx.walk.isLocked()).toBe(false);
    const snap = ctx.walk.snapshot()!;
    expect(snap.action).toBeNull();
    expect(snap.stance).toBe('stand');
    expect(snap.feet[0]).toBeCloseTo(-300, 3);
    ctx.fly.setPose({ yaw: 45 });
    await ctx.run(2);
    expect(ctx.walk.snapshot()!.yaw).toBeCloseTo(45, 0);           // the look is the body's again
  });

  it('a SURVIVED blast still knocks the SEAL down, and it gets up (one fragment on an arm, 100-odd units off)', async () => {
    const ctx = await offline();
    await ctx.run(5);
    const feet0 = ctx.walk.feet()!;
    ctx.client.send({ type: 'throw', seq: ctx.client.lastSeq(), kind: 'M67', from: [feet0[0], feet0[1] + 16.4, feet0[2]], velocity: [0, 0, 0] });
    // Walk away from it (the stick forward: facing yaw 0, down -z), then stand still before the fuse.
    ctx.setWish({ forward: 1, right: 0, boost: false });
    const seen: string[] = [];
    let at = 0;
    for (let i = 0; i < 3.3 * TICK_HZ + 5 * TICK_HZ; i++) {
      if (i === 100) ctx.setWish({ forward: 0, right: 0, boost: false });
      if (i === 3.2 * TICK_HZ - 20) ctx.script.push(0.0, 0.0, 0.65);   // 9 x 900 / d^2 < 1 -> 1 fragment, the left arm
      await ctx.run(1);
      if (ctx.events.some((e) => e.type === 'blast') && !at) at = i;
      if (at) track(ctx.walk, seen);
    }
    const hurt = ctx.events.find((e) => e.type === 'hurt') as Extract<ServerEvent, { type: 'hurt' }>;
    expect(hurt).toBeDefined();
    const f = ctx.walk.feet()!;
    const d = Math.hypot(f[0] - hurt.from[0], f[2] - hurt.from[2]);
    expect(d).toBeGreaterThan(95);
    expect(d).toBeLessThan(150);
    expect(ctx.events.some((e) => e.type === 'kill')).toBe(false);
    expect(ctx.walk.isDead()).toBe(false);
    expect(seen).toEqual(seen[0] === 'fallForward'
      ? ['fallForward', 'landDeath', 'getUp', 'none']
      : ['fallBackwards', 'landBackwards', 'getUpBackwards', 'none']);
  });
});

/** A socket the test plays the server on (`netClient.test.ts`'s). */
function fakeSocket() {
  const s: WebSocketLike & { server(ev: ServerEvent): void } = {
    binaryType: 'arraybuffer', readyState: 1,
    onopen: null, onclose: null, onmessage: null, onerror: null,
    send: () => undefined, close: () => undefined,
    server(ev: ServerEvent) { s.onmessage?.({ data: JSON.stringify(ev) }); },
  };
  queueMicrotask(() => s.onopen?.({}));
  return s;
}

describe('the page\'s own death by a blast, online (the server\'s events through NetClient)', () => {
  it('the blast\'s knock, then the kill: thrown, landed and held down; the spawn brings a standing SEAL', async () => {
    const rig = walkRig();
    const socket = fakeSocket();
    const client = new NetClient({ url: 'mem', map: 'MP1', name: 'A', socket: () => socket }, rig.walk);
    await flush();
    socket.server({ type: 'welcome', id: 3, version: 0, map: 'MP1', tick: 0, role: 'player', team: 'seal', queue: 0 } as unknown as ServerEvent);
    socket.server({ type: 'spawn', id: 3, at: [-100, 0, 0], yaw: 0, after: 0 });
    for (let i = 0; i < 10; i++) rig.walk.frame(1 / TICK_HZ);
    socket.server({ type: 'blast', ring: { seconds: 5, volume: 0.35 }, knock: { velocity: [20, 60, 0], fall: 'fallBackwards' }, after: 10 } as unknown as ServerEvent);
    socket.server({ type: 'hurt', health: [0, 0, 0, 0, 0, 0], from: [-110, 0, 0], part: PART.BODY } as unknown as ServerEvent);
    socket.server({ type: 'kill', killer: 3, victim: 3, weapon: 'M67', how: 'suicide', clip: null } as unknown as ServerEvent);
    const seen: string[] = [];
    for (let i = 0; i < 5 * TICK_HZ; i++) { rig.walk.frame(1 / TICK_HZ); track(rig.walk, seen); }
    expect(seen).toEqual(['fallBackwards', 'landBackwards']);
    expect(rig.walk.feet()![0]).toBeGreaterThan(-100);             // carried along the push
    socket.server({ type: 'spawn', id: 3, at: [50, 0, 0], yaw: 90, after: 400 });
    rig.walk.frame(1 / TICK_HZ);
    expect(rig.walk.snapshot()!.action).toBeNull();
    expect(rig.walk.isDead()).toBe(false);
    client.close();
  });
});

describe('the rules behind it', () => {
  it('a blast\'s death clip: none standing or crouched (the knock throws the corpse), the BODY list\'s prone clip prone', () => {
    expect(deathClip('blast', PART.HEAD, 'stand', () => 0)).toBeNull();
    expect(deathClip('blast', PART.BODY, 'crouch', () => 0)).toBeNull();
    expect(deathClip('blast', PART.HEAD, 'prone', () => 0)).toBe('death_prone_chest01');
    expect(deathClip('fall', PART.BODY, 'stand', () => 0)).toBeNull();
    expect(deathClip('bullet', PART.HEAD, 'stand', () => 0)).toBe('death_stand_head01');
  });

  it('the knock on the dead: past the radius from the root it still throws (L440981), at the reach factor clamped to 0', () => {
    const feet = [0, 0, 149.9];
    expect(blastKnock({ feet, posture: 'stand', yaw: 0 }, [0, 0, 0], M67, 1)).toBeNull();          // alive: the root is past 150
    const k = blastKnock({ feet, posture: 'stand', yaw: 0 }, [0, 0, 0], M67, 1, true)!;
    expect(k).not.toBeNull();
    expect(Math.hypot(...k.velocity)).toBe(0);                        // f = 0: it falls where it stands, in state 8
    expect(blastKnock({ feet, posture: 'prone', yaw: 0 }, [0, 0, 0], M67, 1, true)).toBeNull();   // prone: the clip instead
  });

  it('the death camera, mode 3: the eye swings to the far side of the body from the killer, 56 out', () => {
    const cam = newDeathCamera(() => [0, 0, -200]);               // the killer 200 ahead (down -z) of a body at 0
    let eye = deathEye(cam, [0, 25, 28], [0, 0, 0], 90, 1 / 60); // the body faces -x: its eye starts at +x... behind
    for (let i = 0; i < 20 * 60; i++) eye = deathEye(cam, [0, 25, 28], [0, 0, 0], 90, 1 / 60);
    // Actor space to world at yaw 90 (`toWorld`): the settled eye is on the +z side, away from the killer.
    const y = Math.PI / 2, wx = eye[0] * Math.cos(y) + eye[2] * Math.sin(y), wz = -eye[0] * Math.sin(y) + eye[2] * Math.cos(y);
    expect(wz).toBeGreaterThan(0);
    expect(Math.abs(wx)).toBeLessThan(Math.abs(wz) * 0.05);
    // Under 56 across the ground, the eye's reach is pushed out once a tick, x 2.05 of the tilted eye's (141284-141286).
    const base = 28 * Math.cos(DEATH_TILT_MAX) - 25 * Math.sin(-DEATH_TILT_MAX);
    expect(base).toBeLessThan(DEATH_EYE_REACH);
    expect(Math.hypot(eye[0], eye[2])).toBeCloseTo(base * 2.05, 6);
    expect(cam.tilt).toBe(DEATH_TILT_MAX);
  });
});

