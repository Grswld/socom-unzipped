// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CollisionOwner, GridParams, SpawnSlot, WorldPoly } from '@s2u/scene';
import {
  groundGrid, packGround, PROTOCOL_VERSION, ROUND_WATCH_S, TICK_HZ, type ServerEvent, type SimMap,
} from '../src/sim';
import { Room, type Conn } from '../src/net/room';

/**
 * The room's blasts (web research 85 section 7, 91 section 5; `../../viewer/src/net/blast`) and its single-player match
 * (`solo`, the page's offline loopback: `../../viewer/src/net/loopback`), on a synthetic floor, as `room.test.ts` does.
 */

const PARAMS: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 10, cellsZ: 10, originX: -1000, originZ: -1000 };
const FLOOR: WorldPoly = {
  modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
  points: Float32Array.from([-1000, 0, -1000, 1000, 0, -1000, 1000, 0, 1000, -1000, 0, 1000]),
};

/** The flat map; with `wall`, a wall across x = 30 from z -200 to 200, 80 high (between a blast at 0 and x 60). */
function map(wall = false): SimMap {
  const polys: WorldPoly[] = [FLOOR];
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
  if (wall) {
    polys.push({ ...FLOOR, path: 'worldmodel/wall', ditype: 2, points: Float32Array.from([30, 0, -200, 30, 0, 200, 30, 80, 200, 30, 80, -200]) });
    owners.push({ modelName: 'worldmodel', path: 'worldmodel/wall0', first: 1, count: 1 });
  }
  const ground = packGround(PARAMS, polys, owners);
  const slot = (side: 0 | 1, index: number, x: number, z: number): SpawnSlot => ({
    side, index, position: [x, 0, z], onFloor: true, step: side === 0 ? 2 : 6, facing: side === 0 ? [1, 0] : [-1, 0], loc: { map: 0, x: 0, z: 0 },
  });
  const slots = [0, 1, 2, 3].flatMap((i) => [slot(0, i, -400, -200 + i * 50), slot(1, i, 400, -200 + i * 50)]);
  return { stem: 'MP99', name: 'FLAT', ground, grid: groundGrid(ground), spawns: null, slots, respawns: [], notes: [] };
}

class Client implements Conn {
  readonly events: ServerEvent[] = [];
  readonly frames: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  send(frame: Uint8Array | string): void {
    if (typeof frame === 'string') this.events.push(JSON.parse(frame) as ServerEvent);
    else this.frames.push(frame);
  }
  close(code: number, reason: string): void { this.closed = { code, reason }; }
  of<T extends ServerEvent['type']>(type: T): Extract<ServerEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<ServerEvent, { type: T }>[];
  }
}

/** A room with a scripted draw: `script` is spent first, then a seeded one. */
function setup(opts: ConstructorParameters<typeof Room>[2] = {}, m: SimMap = map()) {
  let now = 0, seed = 1;
  const script: number[] = [];
  const random = (): number => {
    if (script.length) return script.shift()!;
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const room = new Room(m, null, { now: () => now, random, ...opts });
  const join = (id: number): Client => {
    const c = new Client();
    room.hello(id, c, { type: 'hello', version: PROTOCOL_VERSION, name: `P${id}`, map: 'MP99' }, `10.0.0.${id}`);
    return c;
  };
  return { room, join, script, advance: (ms: number) => { now += ms; } };
}

const FUSE_TICKS = 3.2 * TICK_HZ;

describe('the room\'s blast (FUN_005a0e70)', () => {
  it('knocks a survivor: the blast event carries the knock, and the server\'s mover leaves the ground with it', () => {
    const { room, join, script } = setup();
    const t = join(1), s = join(2);                               // a Terrorist throws, a SEAL 120 off survives
    void t;
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.player(2)!.sim.walker.place(120, 20, 0);
    room.text(1, { type: 'throw', seq: 1, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });
    room.player(1)!.sim.walker.place(-600, 20, 0);                // the thrower walks off before the fuse
    let knocked = false;
    for (let i = 0; i < FUSE_TICKS; i++) {
      if (i === FUSE_TICKS - 30) script.push(0.5, 0.0, 0.65);     // 13 close -> 0.81 -> 1 fragment, on the left arm
      room.step();
      if (s.of('blast').length && !knocked) { knocked = true; expect(room.player(2)!.sim.walker.airborne).toBe(true); }
    }
    const b = s.of('blast');
    expect(b).toHaveLength(1);
    expect(b[0]!.ring).toEqual({ seconds: 5, volume: 0.35 });
    expect(b[0]!.knock).not.toBeNull();
    expect(b[0]!.knock!.velocity[0]).toBeGreaterThan(0);          // away from the blast
    expect(b[0]!.after).toBe(room.player(2)!.sim.seq);
    expect(s.of('hurt')).toHaveLength(1);
    expect(room.player(2)!.alive).toBe(true);
  });

  it('hurts the thrower as anyone: an M67 at the thrower\'s own feet kills it, a suicide', () => {
    const { room, join } = setup();
    const t = join(1);
    join(2);
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.player(2)!.sim.walker.place(600, 20, 0);
    room.text(1, { type: 'throw', seq: 1, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });
    for (let i = 0; i < FUSE_TICKS; i++) room.step();
    expect(t.of('hurt')).toHaveLength(1);
    expect(t.of('blast')).toHaveLength(1);
    expect(room.player(1)!.alive).toBe(false);
    expect(t.of('kill')[0]).toMatchObject({ victim: 1, how: 'suicide', weapon: 'M67' });
  });

  it('throws the SEAL it kills (FUN_0057e770 L440981: inside the radius or dead) and the corpse stays down', () => {
    const { room, join } = setup();
    const t = join(1);
    join(2);
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.player(2)!.sim.walker.place(600, 20, 0);
    room.text(1, { type: 'throw', seq: 1, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });
    for (let i = 0; i < FUSE_TICKS; i++) room.step();
    const b = t.of('blast');
    expect(b).toHaveLength(1);
    expect(b[0]!.knock).not.toBeNull();                              // CORPSE_KNOCK_PLACEHOLDER retired
    expect(t.of('kill')[0]).toMatchObject({ victim: 1, clip: null }); // standing: no death clip, the knock's fall
    // The blast event comes before the kill, so the page lays the knock on its prediction while still alive.
    const order = t.events.map((e) => e.type).filter((k) => k === 'blast' || k === 'kill');
    expect(order).toEqual(['blast', 'kill']);
    const w = room.player(1)!.sim.walker;
    expect(w.dead).toBe(true);
    const seen: string[] = [];
    for (let i = 0; i < 4 * TICK_HZ; i++) {                          // no commands come: the room's clock ticks the body
      room.step();
      const n = w.action?.name ?? 'none';
      if (seen[seen.length - 1] !== n) seen.push(n);
    }
    expect(['landDeath', 'landBackwards']).toContain(seen[seen.length - 1]);
    expect(seen.some((n) => n.startsWith('getUp'))).toBe(false);
    expect(w.airborne).toBe(false);
  });

  it('a prone SEAL it kills is not thrown: the prone death clip of the BODY list (L441013-441015)', () => {
    const { room, join } = setup();
    const t = join(1);
    join(2);
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.player(1)!.sim.walker.changeStance('prone');
    for (let i = 0; i < 2 * TICK_HZ; i++) room.player(1)!.sim.walker.tick({ forward: 0, right: 0, boost: false });
    expect(room.player(1)!.sim.walker.posture).toBe('prone');
    room.player(2)!.sim.walker.place(600, 20, 0);
    room.text(1, { type: 'throw', seq: 1, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });
    for (let i = 0; i < FUSE_TICKS; i++) room.step();
    expect(room.player(1)!.alive).toBe(false);
    expect(t.of('blast')[0]!.knock).toBeNull();
    expect(t.of('kill')[0]).toMatchObject({ victim: 1, clip: 'death_prone_chest01' });
  });

  it('a wall between the blast and the head: no hurt, no blast event (FUN_005ac070)', () => {
    const { room, join } = setup({}, map(true));
    join(1);
    const s = join(2);
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.player(2)!.sim.walker.place(60, 20, 0);
    room.text(1, { type: 'throw', seq: 1, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });
    room.player(1)!.sim.walker.place(-600, 20, 0);
    for (let i = 0; i < FUSE_TICKS; i++) room.step();
    expect(s.of('hurt')).toHaveLength(0);
    expect(s.of('blast')).toHaveLength(0);
    expect(room.player(2)!.alive).toBe(true);
  });
});

describe('the single-player match (solo: the page\'s offline loopback)', () => {
  it('seats the one player as the host, a SEAL (FUN_002c5450), and starts classic\'s round at once', () => {
    const { room, join } = setup({ rules: 'classic', solo: true });
    const c = join(1);
    expect(c.of('welcome')[0]).toMatchObject({ role: 'player', team: 'seal', ghost: false });
    room.step();
    expect(c.of('roundStart')[0]).toMatchObject({ round: 1, rounds: 11 });
    expect(room.timeLeft()).toBeGreaterThan(359);
    expect(room.player(1)!.alive).toBe(true);
  });

  it('runs the round to its clock alone: no side is eliminated with nobody on it', () => {
    const { room, join } = setup({ rules: 'classic', solo: true, roundSeconds: 30 });
    const c = join(1);
    for (let i = 0; i < 29 * TICK_HZ; i++) room.step();
    expect(c.of('eliminated')).toHaveLength(0);
    for (let i = 0; i < 2 * TICK_HZ; i++) room.step();
    expect(c.of('roundOver')[0]).toMatchObject({ round: 1, winner: null });   // `mission_timer` at 00:00: a draw
  });

  it('a lone SEAL dead in classic: its side is eliminated, the Terrorists win the round', () => {
    const { room, join } = setup({ rules: 'classic', solo: true });
    const c = join(1);
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.text(1, { type: 'throw', seq: 1, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });
    for (let i = 0; i < (ROUND_WATCH_S + 1) * TICK_HZ; i++) room.step();
    expect(room.player(1)!.alive).toBe(false);
    expect(c.of('eliminated')).toEqual([{ type: 'eliminated', winner: 'terrorist' }]);
  });

  it('no idle kick in a match of one (the page left open is not a seat taken from anyone)', () => {
    const { room, join, advance } = setup({ solo: true });
    const c = join(1);
    for (let i = 0; i < 20; i++) { advance(60_000); room.step(); }
    expect(c.closed).toBeNull();
    expect(c.of('kicked')).toHaveLength(0);
  });
});
