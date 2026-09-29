import { describe, expect, it } from 'vitest';
import type { CollisionOwner, GridParams, SpawnSlot, WorldPoly } from '@s2u/scene';
import { NetClient, type NetWalk } from '../src/net/client';
import { LoopbackMatch, simMapOfLoaded } from '../src/net/loopback';
import { Button, groundGrid, packGround, TICK_HZ, type Command, type Knock, type ServerEvent } from '../src/sim';

/**
 * The page's single-player match (owner, 2026-09-29: "let's make offline tick rounds etc too"): the server's own `Room`
 * run in the page behind a socket that never leaves it, so offline plays the same rounds, damage, deaths and respawns
 * as a match, through the same `NetClient` and `NetPage` (`./loopback`).
 */

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

/** The walk as the net client drives it, recording. */
class Walk implements NetWalk {
  tap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null = null;
  spawns: { at: readonly number[]; yaw: number }[] = [];
  knocks: Knock[] = [];
  locked = false;
  feet: [number, number, number] = [0, 0, 0];
  setNetTap(tap: Walk['tap']): void { this.tap = tap; }
  respawn(at: readonly [number, number, number], yaw: number): boolean { this.spawns.push({ at, yaw }); this.feet = [at[0], at[1], at[2]]; return true; }
  nudge(dx: number, dy: number, dz: number): void { this.feet = [this.feet[0] + dx, this.feet[1] + dy, this.feet[2] + dz]; }
  setLocked(on: boolean): void { this.locked = on; }
  knock(k: Knock): boolean { this.knocks.push(k); return true; }
  /** One page tick: the stick at rest. */
  tick(): void { this.tap?.({ forward: 0, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 }, this.feet); }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

async function join(rules: 'respawn' | 'classic' = 'respawn') {
  const match = new LoopbackMatch(simMapOfLoaded(loaded()), null, { rules, auto: false });
  const walk = new Walk();
  const events: ServerEvent[] = [];
  const client = new NetClient({ url: 'loopback:', map: 'MP99', name: 'Solo', socket: match.socket }, walk);
  client.on((ev) => events.push(ev));
  await flush();
  return { match, walk, events, client };
}

/** `n` page ticks, each with the room stepped once (the page and the room at the same 60 Hz). */
async function run(ctx: Awaited<ReturnType<typeof join>>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) { ctx.walk.tick(); ctx.match.step(); }
  await flush();
}

describe('the single-player match (./loopback)', () => {
  it('builds the room\'s map from the loaded map: its own copy of the hull (the room\'s doors turn its own)', () => {
    const l = loaded();
    const m = simMapOfLoaded(l);
    expect(m.stem).toBe('MP99');
    expect(m.ground).not.toBe(l.ground);
    expect(m.ground.points).toEqual(l.ground.points);
    expect(m.respawns).toHaveLength(1);
    expect(groundGrid(m.ground)).toBeTruthy();
  });

  it('joins through the same client as a match: welcomed as the host\'s SEAL, stood at a slot, the round on', async () => {
    const ctx = await join();
    expect(ctx.client.state).toBe('open');
    expect(ctx.client.role).toBe('player');
    expect(ctx.client.team).toBe('seal');
    expect(ctx.walk.spawns).toHaveLength(1);
    expect(ctx.walk.spawns[0]!.at[0]).toBe(-100);
    expect(ctx.walk.locked).toBe(false);
    await run(ctx, 2);
    const score = ctx.events.filter((e) => e.type === 'score').pop() as Extract<ServerEvent, { type: 'score' }>;
    expect(score.timeLeft).toBeGreaterThan(359);
  });

  it('runs the page\'s commands in the room', async () => {
    const ctx = await join();
    await run(ctx, 30);
    expect(ctx.match.room.player(ctx.client.id)!.sim.seq).toBeGreaterThanOrEqual(29);
  });

  it('a grenade at the player\'s own feet: the blast rings, hurts and kills it -- a suicide -- and locks the walk', async () => {
    const ctx = await join();
    await run(ctx, 2);
    ctx.client.send({ type: 'throw', seq: ctx.client.lastSeq(), kind: 'M67', from: [-100, 16.4, 0], velocity: [0, 0, 0] });
    await run(ctx, 3.3 * TICK_HZ);
    const types = ctx.events.map((e) => e.type);
    expect(types).toContain('blast');
    expect(types).toContain('hurt');
    const kill = ctx.events.find((e) => e.type === 'kill') as Extract<ServerEvent, { type: 'kill' }>;
    expect(kill).toMatchObject({ victim: ctx.client.id, how: 'suicide', weapon: 'M67' });
    expect(ctx.walk.locked).toBe(true);
  });

  it('respawns on the Action press once the body has faded (respawn rules, research 91 section 4.1)', async () => {
    const ctx = await join();
    await run(ctx, 2);
    ctx.client.send({ type: 'throw', seq: ctx.client.lastSeq(), kind: 'M67', from: [-100, 16.4, 0], velocity: [0, 0, 0] });
    await run(ctx, 3.3 * TICK_HZ + 10 * TICK_HZ);
    const tap = ctx.walk.tap!;
    tap({ forward: 0, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: Button.Action, stance: 0, weapon: 0 }, ctx.walk.feet);
    await run(ctx, 2);
    expect(ctx.walk.spawns.length).toBe(2);
    expect(ctx.walk.spawns[1]!.at[0]).toBe(-300);               // a respawn record, not a round-start slot
  });

  it('classic alone: the round starts with the one SEAL and runs to its clock', async () => {
    const ctx = await join('classic');
    await run(ctx, 2);
    expect(ctx.events.some((e) => e.type === 'roundStart')).toBe(true);
  });

  it('stops its clock when closed', async () => {
    const ctx = await join();
    ctx.client.close();
    await flush();
    expect(ctx.match.room.stats().players).toBe(0);
  });
});
