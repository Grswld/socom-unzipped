import { describe, expect, it } from 'vitest';
import type { CollisionOwner, GridParams, SpawnSlot, WorldPoly } from '@s2u/scene';
import {
  Button, decodeSnapshot, encodeCommands, groundGrid, MoverSim, packGround, quantiseCommand, TICK_HZ, Walker,
  type Command, type ServerEvent, type SimMap,
} from '../../viewer/src/sim';
import { Room, type Conn } from '../src/room';

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

function setup(opts: ConstructorParameters<typeof Room>[2] = {}) {
  let now = 0;
  let seed = 1;
  const room = new Room(flatMap(), null, { now: () => now, random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }, ...opts });
  const clients = new Map<number, Client>();
  const join = (id: number, name = ''): Client => {
    const c = new Client();
    clients.set(id, c);
    room.hello(id, c, { type: 'hello', version: 1, name, map: 'MP99' }, `10.0.0.${id}`);
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
    local.walker.place(spawn.at[0], spawn.at[1] + 15.4, spawn.at[2]);
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

  it('never runs more commands than ticks given, past a 200 ms burst (the speed guard)', () => {
    const { room, join, cmd, send } = setup();
    join(1);
    room.step();
    const burst = Array.from({ length: 120 }, () => cmd(1, { forward: 1 }));
    for (let i = 0; i < 120; i += 60) send(1, burst.slice(i, i + 60));
    const before = room.player(1)!.sim.seq;
    room.step();
    expect(room.player(1)!.sim.seq - before).toBeLessThanOrEqual(12);
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
  /** Two players face to face 100 units apart on the flat map. */
  function duel() {
    const s = setup();
    const a = s.join(1), b = s.join(2);
    s.room.step();
    const pa = s.room.player(1)!, pb = s.room.player(2)!;
    pa.sim.walker.place(0, 20, 0); pb.sim.walker.place(100, 20, 0);
    for (let i = 0; i < 20; i++) s.room.step();                 // history at the new places
    const shoot = (seq: number, viewTick = s.room.tick, dz = 0) =>
      s.room.text(1, { type: 'fire', seq, from: [0, 15.4, 0], dir: [1, -0.05, dz], weapon: 0, viewTick });
    return { ...s, a, b, pa, pb, shoot };
  }

  it('three body rounds of the M4A1 SD kill; the kill is +2 and prints the game\'s line', () => {
    const { room, b, pb, shoot, a } = duel();
    shoot(100); shoot(109); room.step();
    expect(pb.alive).toBe(true);
    expect(b.of('hurt').length).toBe(2);
    shoot(118);
    expect(pb.alive).toBe(false);
    const kill = a.of('kill')[0]!;
    expect(kill).toMatchObject({ killer: 1, victim: 2, how: 'weapon', weapon: 'M4A1 SD' });
    expect(room.player(1)!.score).toBe(2);
    expect(room.player(2)!.deaths).toBe(1);
  });

  it('refuses rounds faster than the weapon\'s rate', () => {
    const { b, shoot } = duel();
    shoot(100); shoot(101); shoot(102);
    expect(b.of('hurt').length).toBe(1);
  });

  it('hits where the shooter saw a moving target, within the rewind', () => {
    const { room, pb, shoot, b } = duel();
    const seen = room.tick;
    pb.sim.walker.place(100, 20, 60);                           // B has moved 60 units aside since
    for (let i = 0; i < 6; i++) room.step();
    shoot(100, room.tick);                                      // aimed at where B is not now
    expect(b.of('hurt').length).toBe(0);
    shoot(109, seen);                                           // aimed where the shooter saw B, 100 ms ago
    expect(b.of('hurt').length).toBe(1);
  });

  it('respawns on the Action button only after the fade (10 s), far from the enemy', () => {
    const { room, pb, shoot, cmd, send, reset, b } = duel();
    shoot(100); shoot(109); shoot(118);
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
