import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { HELD_RIFLE, HELD_SIDEARM, type CollisionOwner, type EffectProgram, type GridParams, type MotionClip, type SpawnSlot, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  bulletDamage, Button, cameraLook, centreClaim, decodeSnapshot, encodeCommands, EYE_HEIGHT, faceToward, fireInterval, groundGrid, groundPolygons,
  loadSimMap, MoverSim, packGround, PROBE_LIFT, PROTOCOL_VERSION, quantiseCommand, RELOAD_CLIPS, PISTOL_RELOAD_CLIPS, RELOAD_SECONDS_PLACEHOLDER,
  TICK_HZ, Walker, type ClientEvent, type Command, type DoorSpec, type MotionEntry, type ServerEvent, type SimClips, type SimMap,
} from '../../viewer/src/sim';
import { MAX_BATCH, Room, type Conn } from '../src/room';

type V3 = [number, number, number];
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');

/**
 * The match (web sprint 3, M3/M6/M7; W3.R8-R13) on a synthetic map -- a 2000-unit floor at y 0, side A's slots in the
 * west, B's in the east -- so it runs without the disc (the repository's convention).
 */

function flatMap(): SimMap {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 10, cellsZ: 10, originX: -1000, originZ: -1000 };
  const floor: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-1000, 0, -1000, 1000, 0, -1000, 1000, 0, 1000, -1000, 0, 1000]),
  };
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
  const ground = packGround(params, [floor], owners);
  const slot = (side: 0 | 1, index: number, x: number, z: number): SpawnSlot => ({
    side, index, position: [x, 0, z], onFloor: true, step: side === 0 ? 2 : 6, facing: side === 0 ? [1, 0] : [-1, 0], loc: { map: 0, x: 0, z: 0 },
  });
  const slots = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [slot(0, i, -400, -200 + i * 50), slot(1, i, 400, -200 + i * 50)]);
  const respawns = [0, 1, 2].flatMap((i) => [slot(0, i, -600, -500 + i * 500), slot(1, i, 600, -500 + i * 500)]);
  return { stem: 'MP99', name: 'FLAT', ground, grid: groundGrid(ground), spawns: null, slots, respawns, notes: [] };
}

/**
 * DOORS: the flat map with one door (web/docs/research/92-doors.md) -- a leaf 12 wide and 24 high along x from its hinge
 * at the origin, and the game's shape of swing: shut (valve 0), a quarter turn about y over a second and the valve set
 * to 1; open, back and the valve to 0.
 */
function doorMap(): SimMap {
  const base = flatMap();
  const floor = groundPolygons(base.ground)[0]!;
  const leaf: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/door_1', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([0, 0, 0, 12, 0, 0, 12, 24, 0, 0, 24, 0]),
  };
  const sweep = { minX: -12, maxX: 12, minZ: -12, maxZ: 12 };
  const owners: CollisionOwner[] = [
    { modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 },
    { modelName: 'worldmodel', path: 'worldmodel/door_1', first: 1, count: 1, sweep },
  ];
  const ground = packGround(base.ground.grid, [{ ...floor, points: Float32Array.from(floor.points) }, leaf], owners);
  const quarter: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const swing: EffectProgram = {
    name: 'door_1_swing', root: 0, flags: 0, nodes: ['NA'],
    sequences: [{
      name: 'NA', activation: 1, ops: [
        { op: 'if', conditions: [{ kind: 'valve', valve: 'door_1_valve', operation: 2, operand: 0 }] },
        { op: 'fromTo', node: -6, flags: 0x40, seconds: 1, from: [1, 1, 1], to: [1, 1, 1], rotation: { from: [0, 0, 0, 1], to: quarter } },
        { op: 'valve', valve: 'door_1_valve', operation: 0x0b, operand: 1 },
        { op: 'else' },
        { op: 'fromTo', node: -6, flags: 0x40, seconds: 1, from: [1, 1, 1], to: [1, 1, 1], rotation: { from: quarter, to: [0, 0, 0, 1] } },
        { op: 'valve', valve: 'door_1_valve', operation: 0x0b, operand: 0 },
        { op: 'endif' },
      ],
    }],
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const doors: DoorSpec[] = [{
    index: 0, node: 'door_1', path: 'worldmodel/door_1', valve: 'door_1_valve', range: 30, elevation: -1,
    programs: [swing], local: identity, parent: identity, owners: [1], sweep,
  }];
  return { ...base, ground, grid: groundGrid(ground), doors };
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
  last() { return decodeSnapshot(this.frames[this.frames.length - 1]!); }
}

function setup(opts: ConstructorParameters<typeof Room>[2] = {}, map: SimMap = flatMap(), clips: SimClips | null = null) {
  let now = 0;
  let seed = 1;
  const room = new Room(map, clips, { now: () => now, random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, ...opts });
  const clients = new Map<number, Client>();
  const join = (id: number, name = ''): Client => {
    const c = new Client();
    clients.set(id, c);
    room.hello(id, c, { type: 'hello', version: PROTOCOL_VERSION, name, map: 'MP99' }, `10.0.0.${id}`);
    return c;
  };
  const seqs = new Map<number, number>();
  const cmd = (id: number, over: Partial<Command> = {}): Command => {
    const seq = (seqs.get(id) ?? room.player(id)?.sim.seq ?? 0) + 1;
    seqs.set(id, seq);
    const p = room.player(id)!;
    return { seq, forward: 0, right: 0, yaw: p.sim.walker.state.yaw, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0, ...over };
  };
  const send = (id: number, commands: Command[], viewTick = room.tick): void => room.binary(id, encodeCommands({ viewTick, commands }));
  const advance = (ms: number): void => { now += ms; };
  return { room, join, cmd, send, advance, clients, reset: (id: number) => seqs.delete(id) };
}

type Setup = ReturnType<typeof setup>;
type Fire = Extract<ClientEvent, { type: 'fire' }>;

/**
 * A player that aims and fires as the page does (protocol 5): its look sent in every command, a round at the command
 * just run -- the eye and the aim down the cone's centre (`centreClaim`: the page's camera in the open), the round from
 * the eye's height over the feet to the point it looks at. The server decides the round once the next command has run
 * (`run(1)` after `shoot`).
 */
function gunner(s: Setup, id: number) {
  let look = { yaw: s.room.player(id)!.sim.walker.state.yaw, pitch: 0 };
  let point: V3 | null = null;
  let over: Partial<Command> = {};
  const run = (n = 1, extra: Partial<Command> = {}): void => {
    for (let i = 0; i < n; i++) { s.send(id, [s.cmd(id, { ...look, ...over, ...extra })]); s.room.step(); }
  };
  const feet = (): V3 => { const st = s.room.player(id)!.sim.walker.state; return [st.x, st.y, st.z]; };
  /** Turn to look at a point (and send two commands so the server has the look). */
  const face = (at: V3): void => {
    look = faceToward({ feet: feet(), posture: s.room.player(id)!.sim.walker.posture }, at);
    point = at;
    run(2);
  };
  /** The page's round at the last command run; `edit` changes the event (a forged field). */
  const claim = (edit: (ev: Fire) => Fire = (e) => e): Fire => {
    const seq = s.room.player(id)!.sim.seq;
    const f = s.room.player(id)!.cone.frame(seq)!;
    const from: V3 = [f.feet[0], f.feet[1] + EYE_HEIGHT, f.feet[2]];
    const { eye } = cameraLook(f);
    const t = point ? Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]) : 200;
    const c = centreClaim(f, from, t);
    return edit({ type: 'fire', seq, from: c.from, dir: c.dir, eye: c.eye, aim: c.aim, weapon: 0, viewTick: s.room.tick });
  };
  const shoot = (edit?: (ev: Fire) => Fire): Fire => { const ev = claim(edit); s.room.text(id, ev); return ev; };
  const hold = (extra: Partial<Command>): void => { over = extra; };
  return { run, face, shoot, claim, hold, feet };
}

describe('the lobby in the room (research 91 section 7, W3.R12)', () => {
  it('seats joiners by the game\'s rule, welcomes each with its team, and queues the 17th', () => {
    const { room, join } = setup();
    const first = join(1, 'Alpha');
    expect(first.of('welcome')[0]).toMatchObject({ role: 'player', team: 'terrorist', name: 'Alpha' });   // both empty -> Terrorists
    expect(join(2).of('welcome')[0]!.team).toBe('seal');
    for (let id = 3; id <= 16; id++) join(id);
    expect(room.stats().players).toBe(16);
    const late = join(17, 'Late');
    expect(late.of('welcome')[0]).toMatchObject({ role: 'spectator', queue: 1 });
    room.leave(5);
    expect(late.of('promoted')).toHaveLength(1);
    expect(room.player(17)).toBeDefined();
  });

  it('gives a blank name the game\'s Player default', () => {
    const { join } = setup();
    expect(join(1, '').of('welcome')[0]!.name).toMatch(/^Player\d{4}$/);
  });
});

describe('the command stream (W3.R8)', () => {
  it('runs a client\'s commands on the server exactly as the client\'s own mover predicts them', () => {
    const { room, join, cmd, send } = setup();
    const c = join(1);
    room.step();
    const spawn = c.of('spawn').at(-1)!;
    // The client's prediction: the same shared sim on the same map, placed where the server placed it.
    const map = flatMap();
    const local = new MoverSim(new Walker(map.grid), null);
    local.walker.place(spawn.at[0], spawn.at[1] + PROBE_LIFT, spawn.at[2]);   // walk.ts respawn: the tick's pick (PL-2)
    local.walker.state.yaw = spawn.yaw;
    const script: Command[] = [];
    for (let t = 0; t < 180; t++) {
      script.push(quantiseCommand(cmd(1, {
        forward: t < 90 ? 1 : 0.3, right: t > 60 ? 0.5 : 0, yaw: spawn.yaw + t * 0.7, turn: 0.2,
        buttons: t === 30 ? Button.Jump : t === 120 ? Button.Stance : 0, stance: 1,
      })));
    }
    for (let t = 0; t < script.length; t += 3) { send(1, script.slice(Math.max(0, t - 2), t + 3)); room.step(); room.step(); room.step(); }
    for (let i = 0; i < 10; i++) room.step();
    for (const k of script) local.apply(k);
    const server = room.player(1)!.sim.walker.state;
    expect(room.player(1)!.sim.seq).toBe(script.at(-1)!.seq);
    expect([server.x, server.y, server.z]).toEqual([local.walker.state.x, local.walker.state.y, local.walker.state.z]);
    const snap = c.last();
    expect(snap.own!.ack).toBe(script.at(-1)!.seq);
    expect(snap.own!.x).toBe(Math.fround(server.x));
  });

  it('never runs a client faster than real time, past a one-second burst (the speed guard)', () => {
    const { room, join, cmd, send, advance } = setup();
    join(1);
    room.step();
    const burst = Array.from({ length: 300 }, () => cmd(1, { forward: 1 }));
    for (let i = 0; i < 300; i += MAX_BATCH) send(1, burst.slice(i, i + MAX_BATCH));
    const before = room.player(1)!.sim.seq;
    for (let i = 0; i < 60; i++) { advance(1000 / 60); room.step(); }
    // A second of play: at most the second's 60 and the second saved up.
    expect(room.player(1)!.sim.seq - before).toBeLessThanOrEqual(121);
    expect(room.player(1)!.sim.seq - before).toBeGreaterThan(60);
  });

  it('runs a stall\'s backlog once the loop is back (the dropped ticks are the wall time\'s)', () => {
    const { room, join, cmd, send, advance } = setup();
    join(1);
    for (let i = 0; i < 70; i++) { advance(1000 / 60); room.step(); }       // the saved credit spent on nothing
    const before = room.player(1)!.sim.seq;
    const backlog = Array.from({ length: 40 }, () => cmd(1));
    for (let i = 0; i < 40; i += MAX_BATCH) send(1, backlog.slice(i, i + MAX_BATCH));
    advance(700);                                                             // the loop stalled 0.7 s: 42 ticks lost
    room.step();
    expect(room.player(1)!.sim.seq - before).toBe(40);
  });

  it('sends each client the others\' bodies at 30 Hz, never its own', () => {
    const { room, join } = setup();
    const a = join(1), b = join(2);
    for (let i = 0; i < 60; i++) room.step();
    expect(a.frames.length).toBe(30);
    expect(a.last().bodies.map((x) => x.id)).toEqual([2]);
    expect(b.last().bodies.map((x) => x.id)).toEqual([1]);
  });
});

describe('fire, damage and death (W3.R4, research 91 sections 1-4)', () => {
  /** Two players face to face 100 units apart on the flat map, A looking at B's chest. */
  function duel(map?: SimMap, clips: SimClips | null = null) {
    const s = setup({}, map, clips);
    const a = s.join(1), b = s.join(2);
    s.room.step();
    const pa = s.room.player(1)!, pb = s.room.player(2)!;
    pa.sim.walker.place(0, 20, 0); pb.sim.walker.place(100, 20, 0);
    const g = gunner(s, 1);
    for (let i = 0; i < 20; i++) s.room.step();                 // history at the new places
    g.face([100, 12, 0]);
    return { ...s, a, b, pa, pb, g };
  }

  it('three body rounds of the M4A1 SD kill; the kill is +2 and prints the game\'s line', () => {
    const { room, b, pb, a, g } = duel();
    g.shoot(); g.run(9); g.shoot(); g.run(1);
    expect(pb.alive).toBe(true);
    expect(b.of('hurt').length).toBe(2);
    g.run(8); g.shoot(); g.run(1);
    expect(pb.alive).toBe(false);
    const kill = a.of('kill')[0]!;
    expect(kill).toMatchObject({ killer: 1, victim: 2, how: 'weapon', weapon: 'M4A1 SD' });
    expect(room.player(1)!.score).toBe(2);
    expect(room.player(2)!.deaths).toBe(1);
  });

  it('refuses rounds faster than the weapon\'s rate', () => {
    const { b, g } = duel();
    g.shoot(); g.run(1); g.shoot(); g.run(1); g.shoot(); g.run(1);
    expect(b.of('hurt').length).toBe(1);
  });

  it('BL-1: takes a burst at the game\'s wait, FireWait x 0.8 (FUN_005c09f0): rounds 7, 6, 7, 7, 6 commands apart all count', () => {
    const { b, pa, g } = duel();
    g.face([100, 12, 300]);                                      // away from B: the count is the point
    expect(fireInterval(HELD_RIFLE.fireWait, 2) * TICK_HZ).toBeCloseTo(6.72, 9);
    for (const gap of [7, 6, 7, 7, 6]) { g.shoot(); g.run(gap); }
    g.shoot(); g.run(1);
    expect(b.of('shot').length).toBe(6);
    expect(pa.mags[0].rounds()).toBe(24);
    g.run(10);
    g.shoot(); g.run(5); g.shoot(); g.run(1);                    // 5 apart: faster than any mode, still refused
    expect(b.of('shot').length).toBe(7);
  });

  it('BL-3: the rate is the server\'s clock -- forged command numbers far ahead never fire', () => {
    const { b, g } = duel();
    g.shoot();
    const ev = g.claim();
    g.run(1);
    g.shoot(() => ({ ...ev, seq: 1_000_000 }));
    g.shoot(() => ({ ...ev, seq: 2_000_000 }));
    g.run(20);
    expect(b.of('hurt').length).toBe(1);
  });

  it('BL-3: the weapon is the server\'s mover\'s, not the event\'s: weapon 1 with the rifle in hand fires the rifle', () => {
    const honest = duel();
    honest.g.shoot(); honest.g.run(1);
    const forged = duel();
    forged.g.shoot((e) => ({ ...e, weapon: 1 })); forged.g.run(1);
    expect(forged.b.of('hurt')).toHaveLength(1);
    expect(forged.b.of('hurt')[0]!.health).toEqual(honest.b.of('hurt')[0]!.health);   // the rifle's damage
    expect(forged.b.of('shot')[0]!.weapon).toBe(0);
    expect(forged.pa.mags[0].rounds()).toBe(29);
    expect(forged.pa.mags[1].total()).toBe(36);                   // the Mark 23's ring untouched
    // Alternating the index does not reach a second weapon's rate: one round of the two.
    forged.g.run(10);
    forged.g.shoot((e) => ({ ...e, weapon: 0 })); forged.g.shoot((e) => ({ ...e, weapon: 1 })); forged.g.run(1);
    expect(forged.b.of('hurt')).toHaveLength(2);
    expect(forged.pa.mags[0].rounds()).toBe(28);
  });

  it('EYE_HEIGHT: the round leaves within reach of the shared eye (feet + EYE_HEIGHT); 41 over it is refused', () => {
    const { b, g } = duel();
    g.shoot((e) => ({ ...e, from: [e.from[0], e.from[1] + 41, e.from[2]] })); g.run(1);
    expect(b.of('shot')).toHaveLength(0);
    g.shoot(); g.run(1);
    expect(b.of('shot')).toHaveLength(1);
    expect(b.of('shot')[0]!.from[1]).toBeCloseTo(EYE_HEIGHT, 3);
  });

  it('OWNER-3: a round outside the server\'s cone, from an eye off the camera, or not down the eye\'s ray is refused', () => {
    const { b, g } = duel();
    const turn = (v: readonly number[], deg: number): V3 => {
      const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
      return [v[0]! * c - v[2]! * sn, v[1]!, v[0]! * sn + v[2]! * c];
    };
    // Two degrees off at rest (the SD's cone is TargetMin, 1 px): an aimbot's snap.
    g.shoot((e) => ({ ...e, aim: turn(e.aim, 2), dir: turn(e.dir, 2) })); g.run(10);
    g.shoot((e) => ({ ...e, eye: [e.eye[0], e.eye[1] + 20, e.eye[2]] })); g.run(10);
    g.shoot((e) => ({ ...e, dir: turn(e.dir, 3) })); g.run(10);
    expect(b.of('shot')).toHaveLength(0);
    g.shoot(); g.run(1);
    expect(b.of('shot')).toHaveLength(1);
  });

  it('BL-3: a round cannot leave from the far side of a wall, nor a grenade', () => {
    const { b, g, room } = duel(wallMap());
    g.face([100, 12, 0]);
    // A muzzle 25 ahead of the eye is within MUZZLE_SLACK, but the wall at x 10 stands between it and the body.
    g.shoot((e) => ({ ...e, from: [25, EYE_HEIGHT, 0], dir: [1, 0, 0] })); g.run(1);
    expect(b.of('shot')).toHaveLength(0);
    const m67 = room.player(1)!.grenades.M67;
    room.text(1, { type: 'throw', seq: 5, kind: 'M67', from: [25, EYE_HEIGHT, 0], velocity: [0, 0, 0] });
    expect(b.of('grenade')).toHaveLength(0);
    expect(room.player(1)!.grenades.M67).toBe(m67);
    // From the near side it leaves (the round pierces the thin wall: the room's surfaces are all PENETRATION 0.5).
    g.run(10);
    g.shoot(); g.run(1);
    expect(b.of('shot')).toHaveLength(1);
    expect(b.of('shot')[0]!.from[0]).toBeCloseTo(0, 6);
  });

  it('hits where the shooter saw a moving target, within the rewind', () => {
    const { room, pb, b, g } = duel();
    const seen = room.tick;
    pb.sim.walker.place(100, 20, 60);                           // B has moved 60 units aside since
    g.run(3);
    g.shoot((e) => ({ ...e, viewTick: seen })); g.run(1);       // aimed where the shooter saw B, 67 ms ago
    expect(b.of('hurt').length).toBe(1);
    g.run(8);
    g.shoot((e) => ({ ...e, viewTick: room.tick })); g.run(1);  // aimed at where B is not now
    expect(b.of('hurt').length).toBe(1);
  });

  it('respawns on the Action button only after the fade (10 s), far from the enemy', () => {
    const { room, pb, cmd, send, reset, b, g } = duel();
    g.shoot(); g.run(9); g.shoot(); g.run(9); g.shoot(); g.run(1);
    expect(pb.alive).toBe(false);
    reset(2);
    send(2, [cmd(2, { buttons: Button.Action })]);
    room.step();
    expect(room.player(2)!.alive).toBe(false);
    for (let i = 0; i < 10 * TICK_HZ; i++) room.step();
    send(2, [cmd(2, { buttons: Button.Action })]);
    room.step();
    expect(room.player(2)!.alive).toBe(true);
    const spawn = b.of('spawn').at(-1)!;
    expect(Math.abs(spawn.at[0])).toBe(600);                    // a respawn record, not a round-start slot
  });

  it('counts the magazines as the page does: a ring, a part-spent one kept and come round to (research 84 section 17)', () => {
    const { room, pa, b, g } = duel();
    g.face([-100, 30, 0]);                                       // rounds away from B: the count is the point
    const round = (): void => { g.shoot(); g.run(10); };
    const reload = (): void => { room.text(1, { type: 'reload', seq: pa.sim.seq }); g.run(2 * TICK_HZ + 1); };
    const rifle = pa.mags[0];
    expect(rifle.state().slots.slice(0, 3)).toEqual([30, 30, 30]);
    round(); reload();                                          // 29 kept, the second in
    round(); round();
    expect(rifle.rounds()).toBe(28);
    reload();                                                   // the third in
    expect(rifle.rounds()).toBe(30);
    for (let i = 0; i < 4; i++) round();
    reload();                                                   // round the ring: the first, as it was left
    expect(rifle.rounds()).toBe(29);
    expect(rifle.shownMags()).toBe(2);
    expect(rifle.total()).toBe(90 - 7);
    expect(pa.mags[1].total()).toBe(36);                        // the Mark 23's ring untouched
    expect(b.of('hurt').length).toBe(0);
  });

  it('MJ-2: R on a full magazine reloads when another slot holds rounds (FUN_005c2a90 477462-477483: no fullness gate)', () => {
    const { room, pa, g } = duel();
    expect(pa.mags[0].full()).toBe(true);
    room.text(1, { type: 'reload', seq: pa.sim.seq }); g.run(1);
    expect(pa.mags[0].state().current).toBe(1);
    expect(pa.reloadUntil[0]).toBeGreaterThan(pa.ran);
  });

  it('BL-3: a second reload while the first plays is refused (FUN_005c2a90 477398: FUN_005a7ab0)', () => {
    const { room, pa, g } = duel();
    g.face([-100, 30, 0]);
    g.shoot(); g.run(1);
    room.text(1, { type: 'reload', seq: pa.sim.seq }); g.run(1);
    const once = pa.mags[0].state();
    g.run(9);
    room.text(1, { type: 'reload', seq: pa.sim.seq }); g.run(1);
    expect(pa.mags[0].state()).toEqual(once);
  });
});

/** The flat map with a wall across x 10 (z -100..100, 50 high): between a shooter at the origin and x 25. */
function wallMap(): SimMap {
  const base = flatMap();
  const floor = groundPolygons(base.ground)[0]!;
  const wall: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/wall', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([10, 0, -100, 10, 0, 100, 10, 50, 100, 10, 50, -100]),
  };
  const owners: CollisionOwner[] = [
    { modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 },
    { modelName: 'worldmodel', path: 'worldmodel/wall0', first: 1, count: 1 },
  ];
  const ground = packGround(base.ground.grid, [{ ...floor, points: Float32Array.from(floor.points) }, wall], owners);
  return { ...base, ground, grid: groundGrid(ground) };
}

/** A clip of a name, `seconds` long at 30 keys a second, and its `motion.rdr` row with that `playback`. */
function reloadClips(lengths: Record<string, number>): SimClips {
  const clips: MotionClip[] = Object.entries(lengths).map(([name, seconds]) => ({
    name, version: 0, duration: seconds, frameCount: Math.round(seconds * 30), rate: 30, unknown10: -1, unknown14: 1, parts: [],
  }));
  const table = new Map<string, MotionEntry>(Object.entries(lengths).map(([name, playback]) => [name, {
    looped: false, playback, maxVelocity: -1, blendTime: null, transitionA: null, transitionB: null, noInterrupt: null,
  } as unknown as MotionEntry]));
  return { clips, table, roots: new Map() };
}

describe('MJ-1: the reload locks the weapon for its clip (motion.rdr playback, FUN_005a82e0), one table with the page', () => {
  // motion.rdr's playback: seal_reload 1.6, crouch 1.9, prone 1.7, moving 1.2 (reloadClip.ts; simMap.test.ts pins the disc).
  const RIFLE = { [RELOAD_CLIPS.stand]: 1.6, [RELOAD_CLIPS.crouch]: 1.9, [RELOAD_CLIPS.prone]: 1.7, [RELOAD_CLIPS.moving]: 1.2 };
  const PISTOL = { [PISTOL_RELOAD_CLIPS.stand]: 1.3, [PISTOL_RELOAD_CLIPS.crouch]: 1.3, [PISTOL_RELOAD_CLIPS.prone]: 1.3, [PISTOL_RELOAD_CLIPS.moving]: 1.3 };

  /** A duel with the clips; A reloads in `stance` (moving: the stick held forward) and fires at `after` commands. */
  function lock(stance: 0 | 1 | 2, moving: boolean, after: number, clips: SimClips | null = reloadClips({ ...RIFLE, ...PISTOL })): number {
    const s = setup({}, flatMap(), clips);
    const b = (s.join(1), s.join(2));
    s.room.step();
    s.room.player(1)!.sim.walker.place(0, 20, 0); s.room.player(2)!.sim.walker.place(100, 20, 0);
    const g = gunner(s, 1);
    if (stance) { g.run(1, { buttons: Button.Stance, stance }); g.run(150); }
    if (moving) g.hold({ forward: 1 });
    g.face([100, 60, 400]);                                      // away from B: nothing in the way
    g.run(30);
    const p = s.room.player(1)!;
    s.room.text(1, { type: 'reload', seq: p.sim.seq });
    const start = p.ran;
    g.run(after - 1);
    expect(p.ran).toBe(start + after - 1);
    g.shoot(); g.run(1);
    return b.of('shot').length;
  }

  it('standing 1.6 s: a round two commands short is refused, one at the length is taken', () => {
    expect(lock(0, false, Math.round(1.6 * TICK_HZ) - 2)).toBe(0);
    expect(lock(0, false, Math.round(1.6 * TICK_HZ))).toBe(1);
  });

  it('crouched 1.9 s, prone 1.7 s, moving 1.2 s', () => {
    expect(lock(1, false, Math.round(1.9 * TICK_HZ) - 2)).toBe(0);
    expect(lock(1, false, Math.round(1.9 * TICK_HZ))).toBe(1);
    expect(lock(2, false, Math.round(1.7 * TICK_HZ) - 2)).toBe(0);
    expect(lock(2, false, Math.round(1.7 * TICK_HZ))).toBe(1);
    expect(lock(0, true, Math.round(1.2 * TICK_HZ) - 2)).toBe(0);
    expect(lock(0, true, Math.round(1.2 * TICK_HZ))).toBe(1);
  });

  it('without the clips: RELOAD_SECONDS_PLACEHOLDER (2 s)', () => {
    expect(RELOAD_SECONDS_PLACEHOLDER).toBe(2);
    expect(lock(0, false, 2 * TICK_HZ - 2, null)).toBe(0);
    expect(lock(0, false, 2 * TICK_HZ, null)).toBe(1);
  });

  it('a swap mid-reload clears the lock: the Mark 23 fires at once, from its own ring', () => {
    const s = setup({}, flatMap(), reloadClips({ ...RIFLE, ...PISTOL }));
    const b = (s.join(1), s.join(2));
    s.room.step();
    s.room.player(1)!.sim.walker.place(0, 20, 0); s.room.player(2)!.sim.walker.place(100, 20, 0);
    const g = gunner(s, 1);
    g.face([100, 60, 400]);
    const p = s.room.player(1)!;
    s.room.text(1, { type: 'reload', seq: p.sim.seq }); g.run(1);
    expect(p.reloadUntil[0]).toBeGreaterThan(p.ran);
    g.run(1, { buttons: Button.Swap, weapon: 1 });
    expect(p.sim.weapon).toBe(1);
    g.run(2);
    g.shoot(); g.run(1);
    expect(b.of('shot')).toHaveLength(1);
    expect(b.of('shot')[0]!.weapon).toBe(1);
    expect(p.mags[1].rounds()).toBe(11);
  });
});

describe('the clock (W3.R11)', () => {
  it('runs the original\'s match: the clock, TIME EXPIRED and 15 s more, the result, FINAL ROUND and GAME COMPLETE, then the next match', () => {
    const { room, join } = setup({ roundSeconds: 2 });
    const a = join(1), b = join(2);
    for (let i = 0; i < 2 * TICK_HZ; i++) room.step();
    expect(a.of('timeExpired')).toHaveLength(1);
    expect(a.of('roundOver')).toHaveLength(0);
    for (let i = 0; i < 16 * TICK_HZ; i++) room.step();
    const over = a.of('roundOver')[0]!;
    expect(over).toMatchObject({ round: 1, winner: null, matchOver: true });   // 1 alive each: a draw
    expect(over.screens).toEqual([{ screen: 'finalRound', seconds: 10 }, { screen: 'gameComplete', seconds: 10 }]);
    for (let i = 0; i < 23 * TICK_HZ; i++) room.step();
    expect(b.of('roundStart')[0]).toMatchObject({ round: 1, seconds: 2 });     // a new match, from round 1
  });
});

describe('the kicks (W3.R13, research 91 section 17)', () => {
  it('moves an idle player to the back of the queue when someone waits, and closes it when nobody does', () => {
    const { room, join, advance } = setup();
    for (let id = 1; id <= 16; id++) join(id);
    const waiting = join(17);
    advance(4 * 60_000 + 1);
    room.step();
    expect(waiting.of('promoted')).toHaveLength(1);
    expect(room.player(17)).toBeDefined();
    // The idle rotate through the queue in FIFO order (each demoted one goes to the back): one waits at the end.
    expect(room.stats().players).toBe(16);
    expect(room.stats().spectators).toBe(1);
  });

  it('disconnects an idle player when nobody waits', () => {
    const { room, join, advance, clients } = setup();
    join(1);
    advance(4 * 60_000 + 1);
    room.step();
    expect(clients.get(1)!.of('kicked')[0]).toEqual({ type: 'kicked', reason: 'idle' });
    expect(clients.get(1)!.closed?.code).toBe(4001);
  });

  it('a look that only jitters across north is idle, as the same jitter anywhere else is; a real turn is not (shortTurn)', () => {
    const idleAfter = (yaws: readonly number[]): boolean => {
      const { room, join, cmd, send, advance, clients } = setup();
      join(1);
      for (let i = 0; i < 25; i++) { send(1, [cmd(1, { yaw: yaws[i % yaws.length]! })]); room.step(); advance(10_000); }
      room.step();
      return clients.get(1)!.of('kicked').length > 0;
    };
    expect(idleAfter([100.1, 99.9])).toBe(true);                   // 0.2 degrees: under the 0.5 a look must move
    expect(idleAfter([0.1, 359.9])).toBe(true);                    // the same 0.2 across north (it read as 359.8)
    expect(idleAfter([350, 10])).toBe(false);                      // 20 degrees across north: a turn
  });

  it('removes a teammate at the round\'s end on more votes than half its team, and refuses its rejoin', () => {
    const { room, join, clients } = setup({ roundSeconds: 1 });
    const endOfMatch = (1 + 16 + 23) * TICK_HZ;
    for (let id = 1; id <= 6; id++) join(id);                   // the join rule, ties to SEALs: T 1,4,6  S 2,3,5
    const t = [1, 2, 3, 4, 5, 6].filter((id) => room.player(id)!.team === room.player(1)!.team);
    expect(t).toEqual([1, 4, 6]);
    room.text(2, { type: 'vote', target: 1, remove: true });    // not a teammate: no vote
    expect(clients.get(1)!.of('votes')).toHaveLength(0);
    room.text(4, { type: 'vote', target: 1, remove: true });
    expect(clients.get(1)!.of('votes').at(-1)!.count).toBe(1);
    for (let i = 0; i < endOfMatch; i++) room.step();
    expect(clients.get(1)!.closed).toBeNull();                  // 1 of 3: not more than half
    room.text(6, { type: 'vote', target: 1, remove: true });
    for (let i = 0; i < 17 * TICK_HZ + 1; i++) room.step();
    expect(clients.get(1)!.of('kicked')[0]).toEqual({ type: 'kicked', reason: 'vote' });
    expect(clients.get(1)!.closed?.code).toBe(4002);
    const again = join(1);
    expect(again.of('refused')[0]!.reason).toMatch(/banned/);
  });
});

describe('grenades (research 85, 91 section 5)', () => {
  it('an M67 at an enemy\'s feet kills it after the 3 s fuse; a teammate beside it is spared (friendly fire off)', () => {
    const { room, join } = setup();
    const a = join(1), b = join(2), c = join(3);            // T, S, S (the join rule)
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.player(2)!.sim.walker.place(200, 20, 0);
    room.player(3)!.sim.walker.place(0, 20, 60);              // a SEAL (an enemy of the thrower), 60 from the blast
    expect(room.player(3)!.team).toBe('seal');
    room.text(1, { type: 'throw', seq: 5, kind: 'M67', from: [0, 15.4, 0], velocity: [0, 0, 0] });   // dropped at the feet
    expect(b.of('grenade')).toHaveLength(1);
    for (let i = 0; i < 3.2 * TICK_HZ; i++) room.step();
    // It fell at the thrower's own feet: the thrower dies of it (a suicide), the SEAL at 60 is hurt or killed by it,
    // the SEAL at 200 is past the 150 radius.
    expect(room.player(1)!.alive).toBe(false);
    expect(a.of('kill').some((k) => k.victim === 1 && k.how === 'suicide')).toBe(true);
    expect(room.player(2)!.alive).toBe(true);
    expect(c.of('hurt').length).toBe(1);
  });

  it('refuses a throw with none left, or from far from the thrower', () => {
    const { room, join } = setup();
    const b = (join(1), join(2));
    room.step();
    room.player(1)!.sim.walker.place(0, 20, 0);
    room.text(1, { type: 'throw', seq: 5, kind: 'M67', from: [500, 15.4, 0], velocity: [0, 0, 0] });
    expect(b.of('grenade')).toHaveLength(0);
    for (let i = 0; i < 20; i++) room.text(1, { type: 'throw', seq: 5 + i, kind: 'HE', from: [0, 15.4, 0], velocity: [10, 5, 0] });
    expect(b.of('grenade').length).toBeLessThan(20);
  });
});

describe('doors (web/docs/research/92-doors.md): the server runs them and every client sees them', () => {
  it('a player at the door opens it with the door event; the snapshots carry it swinging, then open; its leaf moves in the hull', () => {
    const { room, join } = setup({}, doorMap());
    const a = join(1), b = join(2);
    room.step();
    room.player(1)!.sim.walker.place(6, 20, 15);
    room.player(2)!.sim.walker.place(400, 20, 0);
    room.step(); room.step();
    expect(a.last().doors).toEqual([{ valve: 0, phase: 255 }]);
    room.text(2, { type: 'door', seq: 3, door: 0 });                  // 400 away: out of its range, refused
    room.step(); room.step();
    expect(b.last().doors).toEqual([{ valve: 0, phase: 255 }]);
    room.text(1, { type: 'door', seq: 4, door: 0 });
    for (let i = 0; i < 16; i++) room.step();
    const mid = b.last().doors![0]!;
    expect(mid.phase).toBeLessThan(255);
    expect(mid.phase).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) room.step();
    expect(a.last().doors).toEqual([{ valve: 1, phase: 255 }]);
    expect(b.last().doors).toEqual([{ valve: 1, phase: 255 }]);
    // The leaf turned a quarter about its hinge: its far edge from (12, y, 0) to (0, y, -12) in the hull.
    const leaf = groundPolygons(room.map.ground)[1]!;
    expect(leaf.points[3]).toBeCloseTo(0, 3);
    expect(leaf.points[5]).toBeCloseTo(-12, 3);
    room.text(9, { type: 'door', seq: 1, door: 0 });                  // no such player: nothing
    room.text(1, { type: 'door', seq: 5, door: 7 });                  // no such door: nothing
    for (let i = 0; i < 4; i++) room.step();
    expect(a.last().doors).toEqual([{ valve: 1, phase: 255 }]);
  });
});

describe('the room reports its rules and the game\'s round count (protocol 4)', () => {
  it('a respawn room is unchanged: its welcome and round start name the rules and mp_max_rounds (11)', () => {
    const { room, join } = setup({ roundSeconds: 2 });
    const a = join(1);
    expect(a.of('welcome')[0]).toMatchObject({ rules: 'respawn', round: 1, rounds: 11, ghost: false });
    join(2);
    for (let i = 0; i < (2 + 16 + 23) * TICK_HZ; i++) room.step();
    // The one-round match is over and the next begins: the banner's count is still mp_max_rounds (FUN_001fb420).
    expect(a.of('roundOver')[0]).toMatchObject({ round: 1, matchOver: true });
    expect(a.of('roundStart')[0]).toMatchObject({ round: 1, rounds: 11 });
  });
});

describe('classic: respawn off, the create-game default (research 91 sections 9, 12, 18)', () => {
  /** Two players on a classic room, T (1) and S (2) by the join rule; the match launched once both sides have one. */
  function classic(opts: ConstructorParameters<typeof Room>[2] = {}) {
    const s = setup({ rules: 'classic', roundSeconds: 60, ...opts });
    const t = s.join(1, 'Tango'), sl = s.join(2, 'Sierra');
    s.room.step();
    const guns = new Map<number, ReturnType<typeof gunner>>();
    /** Three M4A1 SD rounds to the body from 100 units: a kill (the duel above). */
    const kill = (shooter: number, victim: number): void => {
      const a = s.room.player(shooter)!, b = s.room.player(victim)!;
      a.sim.walker.place(0, 20, 0); b.sim.walker.place(100, 20, 0);
      s.room.step(); s.room.step();
      const g = guns.get(shooter) ?? gunner(s, shooter);
      guns.set(shooter, g);
      g.face([100, 12, 0]);
      for (let i = 0; i < 3 && b.alive; i++) { g.shoot(); g.run(10); }
      expect(b.alive).toBe(false);
    };
    const steps = (seconds: number): void => { for (let i = 0; i < Math.round(seconds * TICK_HZ); i++) s.room.step(); };
    return { ...s, t, sl, kill, steps };
  }

  it('launches when both sides have a player (the launch rule): round 1 of 11, everyone at the start slots', () => {
    const { t, sl, room } = classic();
    expect(t.of('welcome')[0]).toMatchObject({ rules: 'classic', rounds: 11 });
    expect(sl.of('roundStart').at(-1)).toMatchObject({ round: 1, rounds: 11, wins: { seal: 0, terrorist: 0 } });
    expect(room.player(1)!.alive && room.player(2)!.alive).toBe(true);
  });

  it('elimination ends the round, tested from 15 s in (WAIT 5, WAIT 10); the side left alive wins; +2 +1 +5', () => {
    const { t, room, kill, steps } = classic();
    kill(1, 2);
    steps(14);
    expect(t.of('eliminated')).toHaveLength(0);
    steps(1.2);
    expect(t.of('eliminated')).toEqual([{ type: 'eliminated', winner: 'terrorist' }]);
    expect(t.of('roundOver')).toHaveLength(0);                   // WAIT 2, then `failure`/`success`: WAIT 20, WAIT 1
    steps(23);
    expect(t.of('roundOver')[0]).toMatchObject({
      round: 1, winner: 'terrorist', wins: { seal: 0, terrorist: 1 }, matchOver: false, screens: [{ screen: 'roundComplete', seconds: 5 }],
    });
    expect(room.player(1)!.score).toBe(2 + 1 + 5);             // the kill, alive at the end, the winning side
    expect(room.player(2)!.score).toBe(0);
    expect(t.of('timeExpired')).toHaveLength(0);
    steps(8.2);                                                 // the engine's 3 s and ROUND COMPLETE's 5 s
    expect(t.of('roundStart').at(-1)).toMatchObject({ round: 2, rounds: 11, wins: { seal: 0, terrorist: 1 } });
    expect(room.player(2)!.alive).toBe(true);
    expect(room.player(1)!.mags[0].total()).toBe(90);          // a full kit at the round's start (FUN_00598b90(p,0))
  });

  it('the clock ends a round as a draw: no message, no hold, nobody scores the win', () => {
    const { t, room, steps } = classic({ roundSeconds: 20 });
    steps(20.1);
    expect(t.of('roundOver')[0]).toMatchObject({ round: 1, winner: null, wins: { seal: 0, terrorist: 0 }, matchOver: false });
    expect(t.of('timeExpired')).toHaveLength(0);
    expect(t.of('eliminated')).toHaveLength(0);
    expect(room.player(1)!.score).toBe(1);                      // alive at the end only
    expect(room.player(2)!.score).toBe(1);
  });

  it('no respawn: the Action press does nothing; the dead wait for the next round', () => {
    const { room, kill, steps, send, cmd, reset } = classic();
    kill(1, 2);
    steps(11);
    reset(2);
    send(2, [cmd(2, { buttons: Button.Action })]);
    room.step();
    expect(room.player(2)!.alive).toBe(false);
  });

  it('first to mp_half_rounds (6 of 11) ends the match: FINAL ROUND and GAME COMPLETE, then a new match', () => {
    const { t, kill, steps } = classic();
    for (let r = 1; r <= 6; r++) {
      kill(1, 2);
      steps(15.2 + 23);
      expect(t.of('roundOver').at(-1)).toMatchObject({ round: r, winner: 'terrorist', matchOver: r === 6 });
      if (r < 6) steps(8.2);
    }
    expect(t.of('roundOver').at(-1)!.screens).toEqual([{ screen: 'finalRound', seconds: 10 }, { screen: 'gameComplete', seconds: 10 }]);
    expect(t.of('roundOver').at(-1)!.wins).toEqual({ seal: 0, terrorist: 6 });
    steps(23.2);
    expect(t.of('roundStart').at(-1)).toMatchObject({ round: 1, wins: { seal: 0, terrorist: 0 } });
  });

  it('level after the last round: a tiebreaker round, and another while it is drawn (the game_over script)', () => {
    const { t, kill, steps } = classic({ roundSeconds: 20 });
    for (let r = 1; r <= 10; r++) {
      if (r % 2) kill(1, 2); else kill(2, 1);
      steps(15.2 + 23 + 8.2);
    }
    expect(t.of('roundOver').at(-1)).toMatchObject({ round: 10, wins: { seal: 5, terrorist: 5 }, matchOver: false });
    steps(20.1);                                                // round 11 to the clock: a draw, still 5-5
    expect(t.of('roundOver').at(-1)).toMatchObject({ round: 11, winner: null, matchOver: false });
    steps(8.2);
    expect(t.of('roundStart').at(-1)).toMatchObject({ round: 12, rounds: 11 });   // PLAYING TIEBREAKER ROUND
    steps(20.1 + 8.2);                                          // a drawn tiebreaker: another
    expect(t.of('roundStart').at(-1)).toMatchObject({ round: 13 });
    kill(2, 1);
    steps(15.2 + 23);
    expect(t.of('roundOver').at(-1)).toMatchObject({ round: 13, winner: 'seal', wins: { seal: 6, terrorist: 5 }, matchOver: true });
  });

  it('a late joiner is a ghost until the next round, and a ghost is not a living player', () => {
    const { room, join, kill, steps, clients } = classic();
    steps(1);
    const late = join(3, 'Late');                              // T 1, S 1: ties to SEALs
    expect(late.of('welcome')[0]).toMatchObject({ role: 'player', team: 'seal', ghost: true });
    expect(room.player(3)!.alive).toBe(false);
    expect(clients.get(1)!.of('spawn').some((e) => e.id === 3)).toBe(false);
    kill(1, 2);                                                 // the only living SEAL
    steps(15.2);
    expect(late.of('eliminated')).toEqual([{ type: 'eliminated', winner: 'terrorist' }]);
    steps(23 + 8.2);
    expect(room.player(3)!.alive).toBe(true);
  });
});

describe('BL-2: a malformed event is dropped, never thrown (one frame took the match server down)', () => {
  it('fire, throw, name, vote, door and ping with missing or wrong-typed fields: nothing thrown, nothing sent, nothing spent', () => {
    const { room, join } = setup();
    const a = join(1, 'Alpha'), b = join(2);
    room.step();
    const p = room.player(1)!;
    const before = { mags: p.mags[0].state(), grenades: { ...p.grenades }, name: a.of('welcome')[0]!.name };
    const bad: unknown[] = [
      null, 'fire', 5, {}, { type: 'fire' },
      { type: 'fire', seq: 1, from: 'x', dir: 'y', viewTick: 1, eye: [0, 0, 0], aim: [0, 0, 1] },
      { type: 'fire', seq: 1.5, from: [0, 15.4, 0], dir: [1, 0, 0], viewTick: 0, eye: [0, 0, 0], aim: [1, 0, 0] },
      { type: 'fire', seq: 1, from: [0, NaN, 0], dir: [1, 0, 0], viewTick: 0, eye: [0, 0, 0], aim: [1, 0, 0] },
      { type: 'fire', seq: 1, from: ['a', 'b', 'c'], dir: [1, 0, 0], viewTick: 0, eye: [0, 0, 0], aim: [1, 0, 0] },
      { type: 'fire', seq: 1, from: [0, 15.4, 0], dir: [1, 0, 0], viewTick: 0 },
      { type: 'throw', kind: 'M67' },
      { type: 'throw', seq: 1, kind: 'constructor', from: [0, 15.4, 0], velocity: [0, 0, 0] },
      { type: 'throw', seq: 1, kind: 'toString', from: [0, 15.4, 0], velocity: [0, 0, 0] },
      { type: 'throw', seq: 1, kind: 'M67', from: null, velocity: null },
      { type: 'throw', seq: 1, kind: 7, from: [0, 15.4, 0], velocity: [0, 0, 0] },
      { type: 'name', name: null }, { type: 'name', name: 5 }, { type: 'name', name: 'x'.repeat(300) },
      { type: 'vote', target: 'x', remove: 1 }, { type: 'vote' },
      { type: 'door', door: 'x' }, { type: 'door' },
      { type: 'ping', t: 'x' }, { type: 'ping' },
      { type: 'reload' }, { type: 'reload', seq: 'x' },
    ];
    for (const ev of bad) expect(() => room.text(1, ev as ClientEvent), JSON.stringify(ev)).not.toThrow();
    for (let i = 0; i < 5; i++) room.step();
    for (const c of [a, b]) for (const t of ['shot', 'grenade', 'renamed', 'pong', 'votes'] as const) expect(c.of(t), t).toHaveLength(0);
    expect(p.mags[0].state()).toEqual(before.mags);
    expect(p.grenades).toEqual(before.grenades);
    expect(Object.keys(p.grenades)).toEqual(['M67', 'HE', 'AN-M8', 'Mark141']);
    expect(p.pending).toHaveLength(0);
    // A well-formed name and ping still go through.
    room.text(1, { type: 'name', name: 'Bravo' });
    room.text(1, { type: 'ping', t: 1 });
    expect(b.of('renamed')).toHaveLength(1);
    expect(a.of('pong')).toHaveLength(1);
  });
});

describe('PL-2: a spawn stands on the floor the walking tick would pick (the probe from the feet + PROBE_LIFT)', () => {
  /** The flat map with a table 12 up over every slot of side 1 (the Terrorists', x 400: a top 40 across). */
  function tableMap(): SimMap {
    const base = flatMap();
    const floor = groundPolygons(base.ground)[0]!;
    const top: WorldPoly = {
      modelName: 'worldmodel', path: 'worldmodel/table', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
      points: Float32Array.from([380, 12, -220, 420, 12, -220, 420, 12, 200, 380, 12, 200]),
    };
    const owners: CollisionOwner[] = [
      { modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 },
      { modelName: 'worldmodel', path: 'worldmodel/table0', first: 1, count: 1 },
    ];
    const ground = packGround(base.ground.grid, [{ ...floor, points: Float32Array.from(floor.points) }, top], owners);
    return { ...base, ground, grid: groundGrid(ground) };
  }

  it('under a table 12 up the spawn stands on the floor (0), not on the table: feet + 1 + 5 picks at or under 7', () => {
    const { room, join } = setup({}, tableMap());
    const a = join(1);
    room.step();
    expect(room.player(1)!.team).toBe('terrorist');
    const spawns = a.of('spawn').filter((e) => e.id === 1);
    expect(spawns.length).toBeGreaterThan(0);
    const at = spawns.at(-1)!.at;
    expect(at[0]).toBe(400);
    expect(at[1]).toBeCloseTo(0, 6);
    expect(PROBE_LIFT).toBe(5);
  });

  const MP2 = fixture('RUN/MP2.ZDB');
  it.skipIf(!MP2)(`Frostfire's respawn at (935.7, 100, 863.6) stands on its floor at 100, not the object 12 over it${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, async () => {
    const map = await loadSimMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const near = (r: SpawnSlot): boolean => Math.abs(r.position[0] - 935.7) < 0.2 && Math.abs(r.position[2] - 863.6) < 0.2;
    const record = [...map.respawns, ...map.slots].find(near)!;
    expect(record).toBeDefined();
    const only = { ...record, side: 0 as const };
    const s = setup({}, { ...map, slots: [only, { ...only, side: 1 as const }], respawns: [only, { ...only, side: 1 as const }] });
    const a = s.join(1);
    s.room.step();
    const at = a.of('spawn').filter((e) => e.id === 1).at(-1)!.at;
    expect(at[1]).toBeCloseTo(100, 1);
  });
});

describe('PL-8: a promotion into a classic round in play is a ghost\'s, and says so; an idler moved out is told', () => {
  it('the 17th, promoted while a classic round plays, is seated as a ghost and told ghost: true', () => {
    const { room, join, advance } = setup({ rules: 'classic', roundSeconds: 60 });
    for (let id = 1; id <= 16; id++) join(id);
    for (let i = 0; i < 10; i++) { advance(1000 / 60); room.step(); }
    const late = join(17);
    expect(late.of('welcome')[0]).toMatchObject({ role: 'spectator', queue: 1 });
    room.leave(5);
    expect(late.of('promoted')).toEqual([{ type: 'promoted', team: room.player(17)!.team, ghost: true }]);
    expect(room.player(17)!.alive).toBe(false);
  });

  it('a respawn room\'s promotion is no ghost', () => {
    const { room, join } = setup();
    for (let id = 1; id <= 16; id++) join(id);
    const late = join(17);
    room.leave(3);
    expect(late.of('promoted')[0]).toMatchObject({ ghost: false });
    expect(room.player(17)!.alive).toBe(true);
  });

  it('an idler moved out is sent demoted with its place in the queue; the others drop its body; its rounds are not run', () => {
    const { room, join, advance, clients } = setup();
    for (let id = 1; id <= 16; id++) join(id);
    join(17);
    advance(4 * 60_000 + 1);
    room.step();
    const one = clients.get(1)!;
    expect(one.of('demoted')[0]).toEqual({ type: 'demoted', position: 1 });
    expect(one.of('queue')).toHaveLength(0);                     // the demoted says it; no second line
    expect(clients.get(17)!.of('left').some((e) => e.id === 1)).toBe(true);
    expect(one.of('left').some((e) => e.id === 1)).toBe(false);
  });
});

describe('PL-9 / PL-16: a command batch is bounded (MAX_BATCH) and its duplicates found in a set', () => {
  it('drops a batch longer than MAX_BATCH whole; the same batch twice queues its commands once', () => {
    const { room, join, cmd, send } = setup();
    join(1);
    room.step();
    const p = room.player(1)!;
    const before = p.sim.seq;
    send(1, Array.from({ length: MAX_BATCH + 1 }, () => cmd(1)));
    expect(p.queue).toHaveLength(0);
    for (let i = 0; i < 60; i++) room.step();
    expect(p.sim.seq).toBe(before);
    expect(MAX_BATCH).toBe(16);
    const five = Array.from({ length: 5 }, () => cmd(1, { seq: 0 }));
    five.forEach((c, i) => { c.seq = before + 1 + i; });
    send(1, five); send(1, five);
    expect(p.queue).toHaveLength(5);
    expect([...p.queued].sort((x, y) => x - y)).toEqual(five.map((c) => c.seq));
    for (let i = 0; i < 5; i++) room.step();
    expect(p.sim.seq).toBe(before + 5);
    expect(p.queued.size).toBe(0);
  });
});
