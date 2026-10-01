// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollisionOwner, GridParams, SpawnSlot, WorldPoly } from '@s2u/scene';
import {
  Button, cameraLook, centreClaim, faceToward, groundGrid, MoverSim, packGround, PROBE_LIFT, quantiseCommand, Walker, type Command, type SimMap,
} from '../src/sim';
import { NetClient, type NetWalk, type WebSocketLike } from '../src/net/client';
import { Room } from '../src/net/room';

/**
 * The netcode end to end (web sprint 3, M4; the bar's item 1): the page's `NetClient` against the `Room` over an
 * in-memory socket -- as the offline match runs it (`../src/net/loopback`) -- the page's mover driven as `WalkMode`
 * drives it in a match: presses applied at once, each tick on the quantised command. The prediction must agree with the
 * room with no correction at all; and the others must be drawn between snapshots, behind the room. (The local demo,
 * owner 2026-10-01: the latency and loss cases of the online match went with it to the separate redotcom project.)
 */

function map(): SimMap {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 10, cellsZ: 10, originX: -1000, originZ: -1000 };
  const floor = (x0: number, z0: number, x1: number, z1: number, y: number): WorldPoly => ({
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1]),
  });
  // A floor with a raised deck: the run crosses its edge, so the script walks off it and lands (the air, the landing).
  const polys = [floor(-1000, -1000, 1000, 1000, 0), floor(-400, -300, -100, 300, 30)];
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  const ground = packGround(params, polys, owners);
  const slot = (side: 0 | 1, x: number, z: number): SpawnSlot => ({ side, index: 0, position: [x, 30, z], onFloor: true, step: 2, facing: [1, 0], loc: { map: 0, x: 0, z: 0 } });
  return { stem: 'MP99', name: 'DECK', ground, grid: groundGrid(ground), spawns: null, slots: [slot(0, -300, 0), slot(1, -300, 100)], respawns: [], notes: [] };
}

/** `WalkMode` as the net client drives it: a press applied at once, the ticks on the quantised command. */
class PageWalk implements NetWalk {
  sim: MoverSim | null = null;
  tap: ((cmd: Omit<Command, 'seq'>, feet: [number, number, number]) => void) | null = null;
  locked = true;
  constructor(readonly grid: ReturnType<typeof groundGrid>) {}
  setNetTap(tap: typeof this.tap): void { this.tap = tap; }
  setLocked(on: boolean): void { this.locked = on; }
  respawn(at: readonly [number, number, number], yaw: number, replay: readonly Command[] = []): boolean {
    this.sim = new MoverSim(new Walker(this.grid), null);
    this.sim.walker.place(at[0], at[1] + PROBE_LIFT, at[2]);   // `walk.ts` respawn: the tick's pick (PL-2)
    this.sim.walker.state.yaw = yaw;
    for (const c of replay) this.sim.apply(c);
    return true;
  }
  nudge(dx: number, dy: number, dz: number): void { const s = this.sim!.walker.state; s.x += dx; s.y += dy; s.z += dz; }
  /** One tick of play: the press, then the quantised tick, then the tap. */
  play(input: Omit<Command, 'seq'>): void {
    // Locked (dead, or not yet stood anywhere) the page sends no stick and no presses -- but the Action press, the
    // respawn's (`WalkMode.action`).
    if (!this.sim || this.locked) { this.tap?.({ ...input, forward: 0, right: 0, buttons: input.buttons & Button.Action }, [0, 0, 0]); return; }
    const cmd = quantiseCommand({ ...input, seq: 0 });
    this.sim.apply(cmd);
    const s = this.sim.walker.state;
    this.tap?.(cmd, [s.x, s.y, s.z]);
  }
}

/** A socket pair: the page's end (`WebSocketLike`) and the server's `Conn`. */
function pair(room: Room, id: number): () => WebSocketLike {
  return () => {
    const page: WebSocketLike = {
      binaryType: 'arraybuffer', readyState: 0, onopen: null, onclose: null, onmessage: null, onerror: null,
      send(data) {
        if (typeof data === 'string') {
          const ev = JSON.parse(data);
          if (ev.type === 'hello') room.hello(id, conn, ev);
          else room.text(id, ev);
        } else room.binary(id, data);
      },
      close() { room.leave(id); },
    };
    const conn = {
      send: (frame: Uint8Array | string) => page.onmessage?.({ data: typeof frame === 'string' ? frame : frame.slice().buffer }),
      close: () => page.onclose?.({ code: 1000, reason: '' }),
    };
    setTimeout(() => { page.readyState = 1; page.onopen?.({}); }, 0);
    return page;
  };
}

afterEach(() => { vi.useRealTimers(); });

function script(t: number, yaw: number): Omit<Command, 'seq'> {
  return {
    forward: t < 240 ? 1 : 0.4, right: t > 150 && t < 300 ? 0.6 : 0, yaw: yaw + (t < 200 ? t * 0.3 : 60 - t * 0.1), pitch: -5, turn: t < 200 ? 0.09 : -0.03,
    buttons: t === 90 || t === 330 ? Button.Jump : t === 260 || t === 380 ? Button.Stance : 0, stance: t === 260 ? 1 : 0, weapon: 0,
  };
}

describe('the netcode in the page (bar 1)', () => {
  it('predicts the local SEAL exactly as the server runs it: no correction, the same feet at the same command', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const m = map();
    const room = new Room(m, null, { now: () => Date.now() });
    const page = new PageWalk(m.grid);
    const client = new NetClient({ map: 'MP99', name: 'Pred', socket: pair(room, 1) }, page);
    let yaw = 0;
    client.on((ev) => { if (ev.type === 'spawn') yaw = ev.yaw; });
    for (let t = 0; t < 600; t++) {
      page.play(script(t - 30, yaw));
      room.step();
      vi.advanceTimersByTime(1000 / 60);
    }
    for (let t = 0; t < 60; t++) { page.play({ forward: 0, right: 0, yaw, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 }); room.step(); vi.advanceTimersByTime(1000 / 60); }
    expect(client.role).toBe('player');
    expect(client.corrections).toEqual({ small: 0, snapped: 0, largest: 0 });
    const server = room.player(1)!.sim;
    // The server has run every command the page sent (the last 60 are standing still: the feet agree).
    const s = server.walker.state, p = page.sim!.walker.state;
    expect([s.x, s.y, s.z]).toEqual([p.x, p.y, p.z]);
    expect(Math.hypot(p.x + 300, p.z)).toBeGreaterThan(100);       // it went somewhere
    client.close();
  });
});

describe('the others, drawn behind the server (M4)', () => {
  it('interpolates a running body between snapshots, 100 ms behind, smoothly', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const m = map();
    const room = new Room(m, null, { now: () => Date.now() });
    const a = new PageWalk(m.grid), b = new PageWalk(m.grid);
    const ca = new NetClient({ map: 'MP99', name: 'A', socket: pair(room, 1) }, a);
    const cb = new NetClient({ map: 'MP99', name: 'B', socket: pair(room, 2) }, b);
    const xs: number[] = [];
    for (let t = 0; t < 240; t++) {
      a.play({ forward: 0, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 });
      b.play({ forward: t > 30 ? 1 : 0, right: 0, yaw: 270, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 });
      room.step();
      vi.advanceTimersByTime(1000 / 60);
      const other = ca.bodies().find((x) => x.id === 2);
      if (t > 120 && other) xs.push(other.feet[0]);
    }
    // B runs toward +x at a steady speed: A draws it moving every frame, no step backwards, no frozen pair.
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    const steps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.max(...steps) / Math.min(...steps)).toBeLessThan(1.6);
    // Drawn behind B's own mover by about the interpolation delay.
    const lag = b.sim!.walker.state.x - xs[xs.length - 1]!;
    expect(lag).toBeGreaterThan(0);
    expect(ca.snapshotRate()).toBeGreaterThan(25);
    ca.close(); cb.close();
  });
});

describe('a death and a respawn in the stream (M6)', () => {
  it('takes no snapped correction through a kill, the wait and the respawn', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const m = map();
    m.respawns.push(...m.slots.map((s) => ({ ...s })));
    const room = new Room(m, null, { now: () => Date.now() });
    const a = new PageWalk(m.grid), b = new PageWalk(m.grid);
    const ca = new NetClient({ map: 'MP99', name: 'A', socket: pair(room, 1) }, a);
    const cb = new NetClient({ map: 'MP99', name: 'B', socket: pair(room, 2) }, b);
    let look = { yaw: 0, pitch: 0 };
    for (let t = 0; t < 14 * 60; t++) {
      const firing = t >= 60 && t < 100 && a.sim !== null && room.player(2) !== undefined;
      const pb = room.player(2)?.sim.walker.state ?? { x: 0, y: 0, z: 0 };
      // A turns to B as the server has it (the test is about the stream, not the aim).
      if (firing) {
        const sa = a.sim!.walker.state;
        look = faceToward({ feet: [sa.x, sa.y, sa.z], posture: a.sim!.walker.posture }, [pb.x, pb.y + 12, pb.z]);
      }
      a.play({ forward: 0, right: 0, yaw: look.yaw, pitch: look.pitch, turn: 0, buttons: 0, stance: 0, weapon: 0 });
      // B runs about, and presses Action every second (the respawn's press once dead).
      b.play({ forward: 1, right: t % 120 < 60 ? 0.5 : -0.5, yaw: 90 + (t % 360), pitch: 0, turn: 0.1, buttons: t % 60 === 0 ? Button.Action : 0, stance: 0, weapon: 0 });
      if (firing && t % 9 === 0) {
        // A's round down its look (protocol 5: the eye and the aim at the cone's centre), at the command just sent.
        const sa = a.sim!.walker.state;
        const body = { feet: [sa.x, sa.y, sa.z], yaw: sa.yaw, pitch: sa.pitch, posture: a.sim!.walker.posture };
        const { eye } = cameraLook(body);
        const claim = centreClaim(body, [sa.x, sa.y + 15.4, sa.z], Math.hypot(pb.x - eye[0], pb.y + 12 - eye[1], pb.z - eye[2]));
        room.text(1, { type: 'fire', seq: ca.lastSeq(), ...claim, weapon: 0, viewTick: room.tick });
      }
      room.step();
      vi.advanceTimersByTime(1000 / 60);
    }
    expect(room.player(2)!.deaths).toBeGreaterThanOrEqual(1);
    expect(room.player(2)!.alive).toBe(true);
    expect(cb.corrections).toEqual({ small: 0, snapped: 0, largest: 0 });
    ca.close(); cb.close();
  });
});

describe('a new match stands everyone at the start (M6, W3.R11)', () => {
  it('takes no correction when the server re-spawns a living player at the next match', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const m = map();
    const room = new Room(m, null, { now: () => Date.now(), roundSeconds: 2 });
    const a = new PageWalk(m.grid);
    const ca = new NetClient({ map: 'MP99', name: 'A', socket: pair(room, 1) }, a);
    let spawns = 0;
    ca.on((ev) => { if (ev.type === 'spawn') spawns++; });
    for (let t = 0; t < (2 + 16 + 23 + 3) * 60; t++) {
      a.play({ forward: 1, right: (t % 200) < 100 ? 0.4 : -0.4, yaw: t * 0.5, pitch: 0, turn: 0.1, buttons: 0, stance: 0, weapon: 0 });
      room.step();
      vi.advanceTimersByTime(1000 / 60);
    }
    expect(spawns).toBe(2);                                   // the first match's, and the next's
    expect(ca.corrections).toEqual({ small: 0, snapped: 0, largest: 0 });
    ca.close();
  });
});

describe('PL-8: the client of an idler moved out (protocol 5 `demoted`)', () => {
  it('turns spectator: no commands go up after it, the mover is held', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const sent: (string | Uint8Array)[] = [];
    let page: WebSocketLike | null = null;
    const walk = new PageWalk(map().grid);
    const client = new NetClient({
      map: 'MP99', name: 'Idle', socket: () => {
        page = {
          binaryType: 'arraybuffer', readyState: 1, onopen: null, onclose: null, onmessage: null, onerror: null,
          send: (d) => { sent.push(d); }, close: () => undefined,
        };
        return page;
      },
    }, walk);
    page!.onopen?.({});
    page!.onmessage?.({ data: JSON.stringify({ type: 'welcome', id: 1, version: 6, map: 'MP99', tick: 0, role: 'player', team: 'seal', queue: 0, name: 'Idle', players: [], rules: 'respawn', round: 1, rounds: 11, ghost: false }) });
    page!.onmessage?.({ data: JSON.stringify({ type: 'spawn', id: 1, at: [0, 0, 0], yaw: 0, after: 0 }) });
    walk.play({ forward: 1, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 });
    expect(sent.some((d) => typeof d !== 'string')).toBe(true);
    page!.onmessage?.({ data: JSON.stringify({ type: 'demoted', position: 2 }) });
    expect(client.role).toBe('spectator');
    expect(client.queue).toBe(2);
    expect(walk.locked).toBe(true);
    const before = sent.length;
    for (let i = 0; i < 5; i++) walk.play({ forward: 1, right: 0, yaw: 0, pitch: 0, turn: 0, buttons: 0, stance: 0, weapon: 0 });
    expect(sent.slice(before).filter((d) => typeof d !== 'string')).toHaveLength(0);
  });
});
