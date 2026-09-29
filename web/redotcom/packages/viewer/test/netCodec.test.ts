import { describe, expect, it } from 'vitest';
import {
  decodeCommands, decodeSnapshot, encodeCommands, encodeSnapshot, frameKind, quantiseCommand,
} from '../src/net/codec';
import { bodyOf, snapshotOf } from '../src/net/body';
import { ACTION_CODES, Button, Frame, PROTOCOL_VERSION, type BodyState, type Command } from '../src/net/protocol';
import { ACTION_CLIPS, moverSnapshot, Walker, type MoverActionName } from '../src/mover';
import { buildGrid, type CollisionOwner, type GridParams, type WorldPoly } from '@s2u/scene';
import { TRAVERSAL_CLIPS } from '../src/traversal';

/** The wire (web sprint 3, M3): what goes in comes out, to the quantisers' steps; a snapshot's size is as budgeted. */

let seed = 7;
const rand = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

function command(seq: number): Command {
  return {
    seq, forward: between(-1, 1), right: between(-1, 1), yaw: between(-720, 720), pitch: between(-90, 90), turn: between(-8, 8),
    buttons: Math.floor(rand() * 1024), stance: Math.floor(rand() * 3), weapon: Math.floor(rand() * 2),
  };
}

function body(id: number): BodyState {
  return {
    id, feet: [between(-4000, 4000), between(-200, 800), between(-4000, 4000)], yaw: between(0, 360), pitch: between(-60, 60),
    vx: between(-100, 100), vy: between(-240, 80), vz: between(-100, 100), flags: Math.floor(rand() * 1024),
    stance: Math.floor(rand() * 3), landing: Math.floor(rand() * 4), jumps: Math.floor(rand() * 256), ground: Math.floor(rand() * 4),
    groundForward: between(-1, 1), groundRight: between(-1, 1), groundCls: Math.floor(rand() * 5) - 1,
    action: Math.floor(rand() * 16), actionSerial: Math.floor(rand() * 256), actionT: between(0, 3), actionSeconds: rand() < 0.3 ? -1 : between(0, 3),
    overlay: Math.floor(rand() * 256), overlayT: between(0, 1), overlaySeconds: between(0, 1), turnRate: between(-10, 10),
    trav: Math.floor(rand() * (TRAVERSAL_CLIPS.length + 1)), travFrame: between(0, 60), travRootY: rand() < 0.5 ? Number.NaN : between(0, 20),
    travBlend: Math.floor(rand() * 4), travBlendWeight: rand(), peek: Math.floor(rand() * 3) - 1, weapon: Math.floor(rand() * 2),
  };
}

const angle = (a: number, b: number): number => Math.abs(((a - b) % 360 + 540) % 360 - 180);

describe('the command frame (M3)', () => {
  it('round-trips a batch to the quantisers\' steps, and quantiseCommand is exactly what the server reads', () => {
    for (let trial = 0; trial < 200; trial++) {
      const cmds = [command(trial * 3 + 1), command(trial * 3 + 2), command(trial * 3 + 3)];
      const bytes = encodeCommands({ viewTick: trial * 1.5, commands: cmds });
      expect(frameKind(bytes)).toBe(Frame.Commands);
      expect(bytes.byteLength).toBe(6 + 15 * 3);
      const back = decodeCommands(bytes);
      expect(back.viewTick).toBeCloseTo(trial * 1.5, 3);
      back.commands.forEach((c, i) => {
        const a = cmds[i]!;
        expect(c.seq).toBe(a.seq);
        expect(Math.abs(c.forward - a.forward)).toBeLessThanOrEqual(0.5 / 127 + 1e-12);
        expect(angle(c.yaw, a.yaw)).toBeLessThanOrEqual(360 / 65536);
        expect(Math.abs(c.pitch - a.pitch)).toBeLessThanOrEqual(0.005 + 1e-9);
        expect([c.buttons, c.stance, c.weapon]).toEqual([a.buttons, a.stance, a.weapon]);
        expect(c).toEqual(quantiseCommand(a));
      });
    }
  });

  it('carries every button bit', () => {
    const all = Object.values(Button).reduce((a, b) => a | b, 0);
    const back = decodeCommands(encodeCommands({ viewTick: 0, commands: [{ ...command(1), buttons: all }] }));
    expect(back.commands[0]!.buttons).toBe(all);
  });
});

describe('the snapshot frame (M3)', () => {
  it('round-trips the own state exactly (float32) and every body to its steps, 55 bytes a body', () => {
    for (let trial = 0; trial < 50; trial++) {
      const bodies = Array.from({ length: 15 }, (_, i) => body(i + 1));
      const own = { ack: trial * 7, x: between(-4000, 4000), y: between(0, 500), z: between(-4000, 4000), vx: 1.5, vy: -3.25, vz: 0 };
      const bytes = encodeSnapshot({ tick: 1000 + trial, own, bodies });
      expect(bytes.byteLength).toBe(1 + 4 + 1 + 28 + 1 + 55 * 15 + 1);   // protocol 2: the door count, 0 here
      const back = decodeSnapshot(bytes);
      expect(back.tick).toBe(1000 + trial);
      expect(back.own!.ack).toBe(own.ack);
      expect(back.own!.x).toBe(Math.fround(own.x));
      back.bodies.forEach((b, i) => {
        const a = bodies[i]!;
        expect(b.feet).toEqual(a.feet.map(Math.fround));
        expect(angle(b.yaw, a.yaw)).toBeLessThanOrEqual(360 / 65536);
        expect(Math.abs(b.vy - a.vy)).toBeLessThanOrEqual(1 / 128 + 1e-9);
        expect([b.flags, b.stance, b.landing, b.ground, b.jumps, b.action, b.actionSerial, b.overlay, b.trav, b.travBlend, b.peek, b.weapon, b.groundCls])
          .toEqual([a.flags, a.stance, a.landing, a.ground, a.jumps, a.action, a.actionSerial, a.overlay, a.trav, a.travBlend, a.peek, a.weapon, a.groundCls]);
        expect(Math.abs(b.actionT - a.actionT)).toBeLessThanOrEqual(0.0005 + 1e-9);
        if (a.actionSeconds < 0) expect(b.actionSeconds).toBe(-1);
        expect(Number.isNaN(b.travRootY)).toBe(Number.isNaN(a.travRootY));
      });
    }
  });

  it('a spectator\'s snapshot has no own state', () => {
    const back = decodeSnapshot(encodeSnapshot({ tick: 5, own: null, bodies: [] }));
    expect(back).toEqual({ tick: 5, own: null, bodies: [] });
  });

  it('carries the doors, two bytes each, after the bodies (protocol 2)', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(2);         // 3 added the scope and the hold bits (moverHold.test.ts)
    const doors = [{ valve: 0, phase: 255 }, { valve: 1, phase: 17 }, { valve: 1, phase: 255 }];
    const plain = encodeSnapshot({ tick: 5, own: null, bodies: [body(1)] });
    const bytes = encodeSnapshot({ tick: 5, own: null, bodies: [body(1)], doors });
    expect(bytes.length - plain.length).toBe(6);
    expect(decodeSnapshot(bytes).doors).toEqual(doors);
    // Out of range values are clamped to the byte, not wrapped.
    expect(decodeSnapshot(encodeSnapshot({ tick: 5, own: null, bodies: [], doors: [{ valve: 300, phase: -4 }] })).doors).toEqual([{ valve: 255, phase: 0 }]);
    expect(() => decodeSnapshot(bytes.subarray(0, bytes.length - 1))).toThrow();
  });

  it('refuses a truncated frame', () => {
    const bytes = encodeSnapshot({ tick: 5, own: null, bodies: [body(1)] });
    expect(() => decodeSnapshot(bytes.subarray(0, bytes.length - 3))).toThrow();
  });
});

describe('a body from the mover and back (M3/M5)', () => {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const floor: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]),
  };
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];

  it('carries what the animator reads through a run, a jump and a stance change', () => {
    const w = new Walker(buildGrid(params, [], [], [floor], owners));
    w.place(0, 20, 0);
    let jumps = 0;
    for (let t = 0; t < 180; t++) {
      if (t === 40 && w.jump()) jumps++;
      if (t === 120) w.changeStance('crouch');
      w.tick({ forward: t < 100 ? 1 : 0, right: 0.3, boost: false });
      const s = moverSnapshot(w, null, jumps, 0.5);
      const back = snapshotOf(decodeSnapshot(encodeSnapshot({ tick: t, own: null, bodies: [bodyOf(3, s, { alive: true, weapon: 0, aiming: false, trigger: false, boost: false })] })).bodies[0]!);
      expect(back.stance).toBe(s.stance);
      expect(back.airborne).toBe(s.airborne);
      expect(back.ground.state).toBe(s.ground.state);
      expect(back.ground.cls).toBe(s.ground.cls);
      expect(back.action?.name ?? null).toBe(s.action?.name ?? null);
      expect(back.landing).toBe(s.landing);
      expect(back.jumps).toBe(s.jumps);
      expect(back.alive).toBe(true);
      for (let k = 0; k < 3; k++) expect(back.feet[k]).toBeCloseTo(s.feet[k]!, 3);
    }
  });

  // The merge review's item 4: what the other screens draw by -- the posture (C tapped to crouch, held to prone, and back),
  // a jump on a slope, the aim and the trigger (the scope is the aim since first person went) -- survives the wire.
  it('carries the stances, a jump on a slope, the aim and the trigger', () => {
    const slope: WorldPoly = { ...floor, points: Float32Array.from([-200, -40, -200, 200, -40, -200, 200, 40, 200, -200, 40, 200]) };
    const w = new Walker(buildGrid(params, [], [], [slope], owners));
    expect(w.place(0, 60, -100)).toBe(true);
    let jumps = 0, sawAir = false, sawProne = false, sawCrouch = false;
    const actions = new Set<string>();
    for (let t = 0; t < 480; t++) {
      if (t === 40 && w.jump()) jumps++;
      if (t === 150) w.changeStance('crouch');
      if (t === 240) w.changeStance('prone');
      if (t === 360) w.changeStance('stand');
      w.tick({ forward: t < 100 ? 1 : 0, right: 0, boost: false });
      const s = moverSnapshot(w, null, jumps, 0.25);
      const extras = { alive: true, weapon: 0 as const, aiming: t % 3 === 0, trigger: t % 5 === 0, boost: false };
      const back = snapshotOf(decodeSnapshot(encodeSnapshot({ tick: t, own: null, bodies: [bodyOf(3, s, extras)] })).bodies[0]!);
      expect(back.stance).toBe(s.stance);
      expect(back.crouched).toBe(s.crouched);
      expect(back.airborne).toBe(s.airborne);
      expect(back.ground.state).toBe(s.ground.state);
      expect(back.action?.name ?? null).toBe(s.action?.name ?? null);
      expect(back.action?.reversed ?? null).toBe(s.action?.reversed ?? null);
      if (s.action && s.action.seconds !== null) expect(back.action!.t).toBeCloseTo(s.action.t, 2);
      expect(back.vy).toBeCloseTo(s.vy, 1);
      expect(back.aiming).toBe(extras.aiming);
      expect(back.trigger).toBe(extras.trigger);
      for (let k = 0; k < 3; k++) expect(back.feet[k]).toBeCloseTo(s.feet[k]!, 3);
      sawAir ||= s.airborne;
      sawProne ||= s.stance === 'prone';
      sawCrouch ||= s.stance === 'crouch';
      if (s.action) actions.add(s.action.name);
    }
    expect(sawAir && sawProne && sawCrouch).toBe(true);
    expect(actions.has('standToCrouch') && actions.has('crouchToProne')).toBe(true);
  });

  it('knows every action the mover has', () => {
    expect([...ACTION_CODES].sort()).toEqual((Object.keys(ACTION_CLIPS) as MoverActionName[]).concat(['jump', 'launch', 'fall'] as MoverActionName[]).filter((v, i, a) => a.indexOf(v) === i).sort());
  });
});
