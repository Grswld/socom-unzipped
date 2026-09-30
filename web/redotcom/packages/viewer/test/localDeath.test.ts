import { describe, expect, it } from 'vitest';
import type { CollisionOwner, GridParams, SpawnSlot, WorldPoly } from '@s2u/scene';
import { FlyCamera } from '../src/camera';
import { packGround, WalkMode } from '../src/walk';
import { NetClient, type WebSocketLike } from '../src/net/client';
import { LoopbackMatch, simMapOfLoaded } from '../src/net/loopback';
import { blastKnock, deathClip, PART, TICK_HZ, type ServerEvent } from '../src/sim';

const M67 = { explosionRadius: 150 };
import { DEATH_EYE_REACH, DEATH_ORBIT_RATE, DEATH_TILT_MAX, deathEye, newDeathCamera } from '../src/deathCamera';

/**
 * The page's OWN death (owner's play-test, 2026-09-29: "I took damage from being exploded in offline mode but my
 * character did not fall over ... He stayed standing waiting for respawn, unable to move"). The game throws a SEAL its
 * blast kills (`FUN_0057e770` L440981: inside the radius or dead; state 8 at L441001), lands it in `Land forward` /
 * `Land backwards` and leaves it down (no get-up for the dead); the dead's camera is the death camera
 * (`FUN_00297a30`); the respawn stands a new SEAL. The page's real `WalkMode`, driven by the real `NetClient`, offline
 * through the loopback room and online through a socket fed the server's events.
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

/** The single-player match with the page's real walk; `script` is the room's draw, spent first. */
async function offline() {
  let seed = 1;
  const script: number[] = [];
  const random = (): number => {
    if (script.length) return script.shift()!;
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const loaded = { path: 'RUN/MP99.ZDB', name: 'FLAT', ground: ground(), slots: [slot(0, 0, -100, 0), slot(1, 0, 100, 0)], respawns: [slot(0, 0, -300, 0)], doors: [] };
  const match = new LoopbackMatch(simMapOfLoaded(loaded), null, { auto: false, random });
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

  it('the respawn stands a new SEAL: out of the landing, unlocked, the look and the camera its own again', async () => {
    const ctx = await offline();
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

