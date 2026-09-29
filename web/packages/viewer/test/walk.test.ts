import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, probeGround, SEAL_LOCOMOTION, SEAL_TUNING, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { loadMap } from '../src/loadMap';
import {
  groundGrid, groundPolygons, landingClass, packGround, rootY, runningJumpSpeed, stanceBody, throttleStep, Walker, WalkMode, ACTION_CLIPS,
  ACTION_SECONDS, BODY_RADIUS, CARRY_DECAY, EYE_HEIGHT, JUMP_DELAY, JUMP_LOCK, RUNNING_JUMP_SPEED, STANCES, TICK,
  type GroundData, type Stance, type WalkInput,
} from '../src/walk';
import { Traversal } from '../src/traversal';

/**
 * The walk (web sprint 1, W1.4): a mover at the engine's 60 Hz on the probe's floor, sliding on walls at radius
 * 3.5, the eye 15.4 over the feet (W1.R2). Synthetic worlds pin the rules; Frostfire's route pins the whole.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

/** A flat ground polygon (`m_ditype` 3: bits 0 and 1), world space. */
function floor(minX: number, minZ: number, maxX: number, maxZ: number, y: number): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([minX, y, minZ, maxX, y, minZ, maxX, y, maxZ, minX, y, maxZ]),
  };
}

/** A vertical wall across z at `x`, from y0 to y1 (`m_ditype` 2: bit 1, the column probe's, research 24 section 1.2). */
function wallX(x: number, z0: number, z1: number, y0: number, y1: number, cameratype = 0): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/wall', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype,
    points: Float32Array.from([x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0]),
  };
}

/** A 4 x 4 grid of `cellDim` cells (100 by default) from (-2, -2) cells, one owner per polygon. */
function world(polys: WorldPoly[], cellDim = 100): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim, cellsX: 4, cellsZ: 4, originX: -2 * cellDim, originZ: -2 * cellDim };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

/** The yaw, in degrees, that faces from (x, z) toward (tx, tz): the camera looks down its own -z (`camera.ts`). */
const facing = (x: number, z: number, tx: number, tz: number): number => Math.atan2(-(tx - x), -(tz - z)) * 180 / Math.PI;

const FORWARD: WalkInput = { forward: 1, right: 0, boost: false };
const STILL: WalkInput = { forward: 0, right: 0, boost: false };

describe('the mover (W1.4, W1.R2)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);

  it('stands on the floor under a point, eye 15.4 over its feet, and refuses a point with no floor', () => {
    const w = new Walker(plain);
    expect(w.place(10, 50, 20)).toBe(true);
    expect([w.state.x, w.state.y, w.state.z]).toEqual([10, 0, 20]);
    expect(w.eye()).toEqual([10, EYE_HEIGHT, 20]);
    expect(EYE_HEIGHT).toBe(15.4);                        // research 17 section 1's 15.38, W1.R2
    expect(w.place(500, 50, 500)).toBe(false);            // off the grid's floor: nothing under it
    expect([w.state.x, w.state.z]).toEqual([10, 20]);     // and the mover has not moved
  });

  it('steps at 60 Hz whatever the frame rate: 30 fps and 240 fps land in the same place', () => {
    const run = (fps: number): [number, number, number] => {
      const w = new Walker(plain);
      w.place(0, 0, 0);
      w.state.yaw = facing(0, 0, 1, 0);
      for (let i = 0; i < fps; i++) w.advance(1 / fps, FORWARD);
      return [w.state.x, w.state.y, w.state.z];
    };
    const slow = run(30), fast = run(240);
    expect(slow[0]).toBeGreaterThan(20);
    expect(fast[0]).toBeCloseTo(slow[0], 9);
    expect(fast[2]).toBeCloseTo(slow[2], 9);
    // The accumulator carries the remainder: two 10 ms frames make one tick, not zero.
    const w = new Walker(plain);
    w.place(0, 0, 0);
    expect(w.advance(0.01, FORWARD)).toBe(0);
    expect(w.advance(0.01, FORWARD)).toBe(1);
    expect(TICK).toBe(1 / 60);                            // CGame::Tick, web/docs/research/71 section 1.5
  });

  it('a step toward a wall is still stopped when the walk is fast: 65 a second is 1.08 a tick', () => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 0, -1);
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(w.state.vx * w.state.vx + w.state.vz * w.state.vz).toBeGreaterThan(64 * 64);
  });
});

/** Speeds of every tick, units a second, over `ticks` ticks of `input` on a big flat floor, facing -z. */
function speeds(input: WalkInput, ticks: number, stance: Stance = 'stand', from?: Walker): { w: Walker; v: number[] } {
  const w = from ?? new Walker(world([floor(-2000, -2000, 2000, 2000, 0)], 1000));
  if (!from) { w.place(0, 0, 0); w.stance = stance; }
  const v: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const x = w.state.x, z = w.state.z;
    w.tick(input);
    v.push(Math.hypot(w.state.x - x, w.state.z - z) / TICK);
  }
  return { w, v };
}
/** The mean speed over the last second of a run: distance / time, as the brief measures it. */
const lastSecond = (v: number[]): number => v.slice(-60).reduce((a, b) => a + b, 0) / 60;

describe('the game\'s speeds (W2.2b, W2.R2): motion.rdr\'s bands through FUN_00586c10 and FUN_00583350', () => {
  it('ten seconds of full forward holds 65.0 a second; back 37.0; the strafes 65; the boost does nothing', () => {
    expect(lastSecond(speeds(FORWARD, 600).v)).toBeCloseTo(65, 1);                                   // seal_run 6.5 m/s
    expect(lastSecond(speeds({ forward: -1, right: 0, boost: false }, 600).v)).toBeCloseTo(37, 1);   // seal_run_bw 3.7
    expect(lastSecond(speeds({ forward: 0, right: 1, boost: false }, 600).v)).toBeCloseTo(65, 1);    // seal_rstrafe
    expect(lastSecond(speeds({ forward: 0, right: -1, boost: false }, 600).v)).toBeCloseTo(65, 1);   // seal_lstrafe
    expect(lastSecond(speeds({ forward: 1, right: 0, boost: true }, 600).v)).toBeCloseTo(65, 1);     // W2.R2: no boost
  });

  it('the throttle is linear (throt_exp 1): half a stick is 32.5', () => {
    expect(lastSecond(speeds({ forward: 0.5, right: 0, boost: false }, 600).v)).toBeCloseTo(32.5, 1);
    expect(lastSecond(speeds({ forward: -0.5, right: 0, boost: false }, 600).v)).toBeCloseTo(18.5, 1);
  });

  it('a diagonal blends the run and the strafe by the stick\'s angle and renormalises: 65 at 45 degrees, heading 45', () => {
    const s = Math.SQRT1_2;
    const { w, v } = speeds({ forward: s, right: s, boost: false }, 600);
    expect(lastSecond(v)).toBeCloseTo(65, 1);
    // Facing -z, right is +x: the heading is 45 degrees between them.
    expect(Math.atan2(w.state.x, -w.state.z) * 180 / Math.PI).toBeCloseTo(45, 0);
  });

  it('the ramp: the stick moves at most upper_z_accel 5 a second, so 90 % of the run is reached on tick 11 (0.18 s)', () => {
    const { v } = speeds(FORWARD, 30);
    const first90 = v.findIndex((x) => x >= 0.9 * 65) + 1;
    expect(first90).toBe(11);                                   // 0.9 / 5 = 0.18 s = 10.8 ticks, up to the next tick
    expect(v[0]).toBeCloseTo(65 * 5 / 60, 6);                   // one tick of 5 a second
    expect(v[11]).toBeCloseTo(65, 6);                           // full at 0.2 s
    // The limit is lower_z_accel 2 with the stick at rest and upper 5 at full: (1 - (1 - |s|)^8) between them.
    expect(throttleStep(0, 1, 'forward', TICK)).toBeCloseTo(5 / 60, 9);
    expect(throttleStep(0.5, 0, 'forward', TICK)).toBeCloseTo(0.5 - 2 / 60, 9);
    expect(throttleStep(0, 0.5, 'forward', TICK)).toBeCloseTo((2 + 3 * (1 - 0.5 ** 8)) / 60, 9);
  });

  it('a stick let go stops at once, from full or half (FUN_00586f00 idles it; FUN_00586570 skips the ramp at rest)', () => {
    const run = speeds(FORWARD, 60);
    expect(speeds(STILL, 1, 'stand', run.w).v[0]).toBe(0);
    const half = speeds({ forward: 0.5, right: 0, boost: false }, 60);
    expect(speeds(STILL, 1, 'stand', half.w).v[0]).toBe(0);
    // Easing off without letting go is the ramp's: from 0.5 to 0.1 the stick falls at the limit.
    const ease = speeds({ forward: 0.1, right: 0, boost: false }, 1, 'stand', speeds({ forward: 0.5, right: 0, boost: false }, 60).w).v;
    expect(ease[0]).toBeCloseTo(65 * (0.5 - (2 + 3 * (1 - 0.9 ** 8)) / 60), 6);
    expect(throttleStep(0.5, 0, 'forward', TICK)).toBeCloseTo(0.5 - 2 / 60, 9);
    expect(throttleStep(1, 0, 'forward', TICK)).toBe(0);
    expect(throttleStep(1, -1, 'right', TICK)).toBe(-1);       // the lateral snap: > 0.78, > 7.8 a second
  });
});

describe('the stances (W2.2b): C cycles stand, crouch, prone', () => {
  it('each stance runs at its motion.rdr bands', () => {
    const band = (clip: string): number => SEAL_LOCOMOTION.find((b) => b.clip === clip)!.maxVelocity;
    expect(STANCES).toEqual(['stand', 'crouch', 'prone']);
    expect(stanceBody('stand').bands).toEqual({ forward: band('seal_run'), back: band('seal_run_bw'), right: band('seal_rstrafe'), left: band('seal_lstrafe') });
    expect(stanceBody('crouch').bands).toEqual({ forward: 14.8, back: 13.5, right: 15, left: 15 });
    expect(stanceBody('prone').bands).toEqual({ forward: 11, back: 11, right: 5.5, left: 5.5 });
  });

  it('the crouch walk (FUN_00584c60): under 0.838 of a stick it is rescaled to 14 / 14.8, so it runs at 14.0 whatever the push', () => {
    const k = 14 / 14.8;
    expect(lastSecond(speeds({ forward: 0.5, right: 0, boost: false }, 600, 'crouch').v)).toBeCloseTo(14.0, 1);   // not 7.4
    expect(lastSecond(speeds({ forward: 0.2, right: 0, boost: false }, 600, 'crouch').v)).toBeCloseTo(14.0, 1);
    expect(lastSecond(speeds({ forward: -0.5, right: 0, boost: false }, 600, 'crouch').v)).toBeCloseTo(k * 13.5, 1);
    expect(lastSecond(speeds({ forward: 0, right: 0.5, boost: false }, 600, 'crouch').v)).toBeCloseTo(k * 15, 1);
    // One clip set by direction class (FUN_00582d10), no blend: a shallow diagonal walks straight ahead.
    const { w } = speeds({ forward: 0.5, right: 0.2, boost: false }, 600, 'crouch');
    expect(Math.abs(w.state.x)).toBeLessThan(1e-6);
    expect(w.posture).toBe('crouch');
  });

  it('the crouch at full stick (>= 0.838) with 19 units of headroom stands and runs the standing blend (FUN_0057efe0, FUN_00583030)', () => {
    const open = speeds(FORWARD, 600, 'crouch');
    expect(lastSecond(open.v)).toBeCloseTo(65, 1);
    expect(open.w.stance).toBe('crouch');
    expect(open.w.posture).toBe('stand');
    // Under a ceiling 17 over the floor the headroom ray is cut: the crouch walk at 14.0 instead.
    const roofed = new Walker(world([floor(-2000, -2000, 2000, 2000, 0), floor(-2000, -2000, 2000, 2000, 17)], 1000));
    roofed.place(0, 5, 0);
    expect(roofed.state.y).toBe(0);
    roofed.stance = 'crouch';
    const low = speeds(FORWARD, 600, 'crouch', roofed);
    expect(lastSecond(low.v)).toBeCloseTo(14.0, 1);
    expect(low.w.posture).toBe('crouch');
    // Back under 0.838 the run drops to the crouch walk again.
    expect(lastSecond(speeds({ forward: 0.8, right: 0, boost: false }, 120, 'crouch', open.w).v)).toBeCloseTo(14.0, 1);
    expect(open.w.posture).toBe('crouch');
  });

  it('prone (FUN_005845c0 -> FUN_00583500): no ramp, one axis by direction class, the band times that axis', () => {
    expect(speeds(FORWARD, 1, 'prone').v[0]).toBeCloseTo(11, 6);                                   // full on tick 1
    expect(speeds({ forward: -1, right: 0, boost: false }, 1, 'prone').v[0]).toBeCloseTo(11, 6);   // the crawl reversed
    expect(speeds({ forward: 0, right: -1, boost: false }, 1, 'prone').v[0]).toBeCloseTo(5.5, 6);
    const ahead = speeds({ forward: 0.8, right: 0.6, boost: false }, 1, 'prone');
    expect(ahead.v[0]).toBeCloseTo(0.8 * 11, 6);                                                     // max(|x|, |z|) x 11
    expect(Math.abs(ahead.w.state.x)).toBeLessThan(1e-9);                                            // straight ahead
    const aside = speeds({ forward: 0.6, right: 0.8, boost: false }, 1, 'prone');
    expect(aside.v[0]).toBeCloseTo(0.8 * 5.5, 6);                                                    // the strafe, 5.5
    expect(Math.abs(aside.w.state.z)).toBeLessThan(1e-9);
  });

  it('the root height: standing 11.484 and crouched 5.504 as the dump has them; prone at the camera ramp\'s floor', () => {
    expect(rootY('stand')).toBe(11.484);                       // five standing actors in the console dump
    expect(rootY('crouch')).toBe(5.504);                       // the crouched player there (research 17 section 1)
    expect(rootY('crouch')).toBeLessThan(9);                   // FUN_00584c60's own stance test: root under 9
    expect(rootY('prone')).toBeLessThanOrEqual(2.169155);      // FUN_0029a950's ramp is flat below this
  });

  it('the body column lowers with the stance: a crouch passes under a lintel at 16 that stops a standing SEAL', () => {
    const lintel = world([floor(-200, -200, 200, 200, 0), wallX(50, -150, 150, 16, 40)]);
    const x = (stance: Stance): number => {
      const w = new Walker(lintel);
      w.place(0, 0, 0);
      w.stance = stance;
      w.state.yaw = facing(0, 0, 1, 0);
      for (let i = 0; i < 600; i++) w.tick(stance === 'crouch' ? { forward: 0.5, right: 0, boost: false } : FORWARD);
      return w.state.x;
    };
    expect(x('stand')).toBeLessThan(50);
    expect(x('crouch')).toBeGreaterThan(60);
    expect(x('prone')).toBeGreaterThan(60);
    expect(stanceBody('stand')).toMatchObject({ bodyLow: 6, bodyHigh: 20 });
  });
});

describe('the fall and the step (W2.2b): dynamics.rdr\'s gravity, touch distance, step height and slope', () => {
  it('stepping off a 42-unit deck falls under 235 a second squared, lands hard after ~0.60 s, and runs on after the clip', () => {
    const deck = world([floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 100, 42), wallX(30, -100, 100, 0, 42)]);
    const w = new Walker(deck);
    expect(w.place(0, 60, 0)).toBe(true);
    expect(w.state.y).toBe(42);
    w.state.yaw = facing(0, 0, 1, 0);
    let off = -1, landed = -1, inAir = '';
    for (let i = 0; i < 240 && landed < 0; i++) {
      w.tick(FORWARD);
      if (off < 0 && w.airborne) off = i;
      if (w.airborne) inAir = w.action?.name ?? '';
      if (off >= 0 && !w.airborne) landed = i;
    }
    expect(off).toBeGreaterThan(0);
    expect(w.state.y).toBe(0);
    // sqrt(2 x 42 / 235) = 0.598 s; the fall is stepped at 60 Hz and starts on the tick after the edge, so +-2 ticks.
    expect(SEAL_TUNING.gravity).toBe(235);
    expect(Math.abs((landed - off) * TICK - Math.sqrt(2 * 42 / 235))).toBeLessThanOrEqual(2 * TICK);
    expect(w.state.x).toBeGreaterThan(30 + 0.5 * 65);          // the run's 65 carried through the air
    expect(inAir).toBe('fall');                                 // FUN_0057e050: the in-air clip on the way down
    // The contact at sqrt(2 x 235 x 42) = 140 is over land_hard_fall_rate 115 (FUN_005af590): the hard landing, which
    // holds the mover while the carried 65 runs down at 150 a second squared (FUN_0054d9a0) ...
    expect(w.landing?.clip).toBe('landHard');
    expect(w.landing!.speed).toBeGreaterThan(115);
    expect(w.action?.name).toBe('landHard');
    // ... until its NoInterrupt 0.35 of the phase (FUN_00587c20: 0.35 x 1 x 19/20 = 0.3325 s), the held stick then
    // cutting it and the run going on
    const x = w.state.x;
    const held = Math.ceil((0.35 * ACTION_CLIPS.landHard.playback * 0.95) / TICK) - 1;
    for (let i = 0; i < held; i++) w.tick(FORWARD);
    expect(w.action?.name).toBe('landHard');
    let glide = 0, v = 65;
    for (let i = 0; i < held; i++) { v = Math.max(0, v - CARRY_DECAY * TICK); glide += v * TICK; }
    expect(w.state.x - x).toBeCloseTo(glide, 6);
    for (let i = 0; i < 3; i++) w.tick(FORWARD);
    expect(w.action).toBeNull();
    const x2 = w.state.x;
    for (let i = 0; i < 30; i++) w.tick(FORWARD);
    expect(w.state.x - x2).toBeGreaterThan(25);
    expect(w.state.y).toBe(0);
  });

  it('a drop within ground_touch_distance 8 is a step down; a 13-unit crate top is a short fall to the floor', () => {
    const steps = world([floor(-200, -200, 200, 200, 0), floor(-20, -20, 20, 20, 7.5)]);
    const s = new Walker(steps);
    s.place(0, 20, 0);
    s.state.yaw = facing(0, 0, 1, 0);
    let flew = false;
    for (let i = 0; i < 90; i++) { s.tick(FORWARD); flew ||= s.airborne; }
    expect(flew).toBe(false);
    expect(s.state.y).toBe(0);
    const crate = world([floor(-200, -200, 200, 200, 0), floor(-20, -20, 20, 20, 13)]);
    const w = new Walker(crate);
    w.place(0, 20, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    flew = false;
    for (let i = 0; i < 90; i++) { w.tick(FORWARD); flew ||= w.airborne; }
    expect(flew).toBe(true);
    expect(w.state.x).toBeGreaterThan(30);
    expect(w.state.y).toBe(0);
  });

  it('step_height 6.5: a 6.5-unit kerb climbs, a 7-unit kerb stops the mover', () => {
    const kerb = (h: number): Walker => {
      const w = new Walker(world([floor(-200, -200, 30, 200, 0), floor(30, -200, 200, 200, h)]));
      w.place(0, 0, 0);
      w.state.yaw = facing(0, 0, 1, 0);
      for (let i = 0; i < 120; i++) w.tick(FORWARD);
      return w;
    };
    expect(SEAL_TUNING.stepHeight).toBe(6.5);
    const low = kerb(6.5);
    expect(low.state.x).toBeGreaterThan(40);
    expect(low.state.y).toBe(6.5);
    const high = kerb(7);
    expect(high.state.x).toBeLessThanOrEqual(30);
    expect(high.state.y).toBe(0);
  });

  it('max_slope 50: a 45-degree ramp is walked up, a 55-degree ramp refuses', () => {
    const ramp = (degrees: number): Walker => {
      const h = 100 * Math.tan(degrees * Math.PI / 180);
      const slope: WorldPoly = {
        modelName: 'worldmodel', path: 'worldmodel/ramp', region: 0, ditype: 1, material: 25, ptcount: 4, cameratype: 0,
        points: Float32Array.from([30, 0, -200, 130, h, -200, 130, h, 200, 30, 0, 200]),
      };
      const w = new Walker(world([floor(-200, -200, 30, 200, 0), slope]));
      w.place(0, 0, 0);
      w.state.yaw = facing(0, 0, 1, 0);
      for (let i = 0; i < 60; i++) w.tick(FORWARD);
      return w;
    };
    expect(SEAL_TUNING.maxSlopeDeg).toBe(50);
    const walked = ramp(45);
    expect(walked.state.x).toBeGreaterThan(50);                 // 1 s at 65 with the 0.2 s ramp: ~59 from 0
    expect(walked.state.y).toBeCloseTo(walked.state.x - 30, 3);
    const refused = ramp(55);
    expect(refused.state.x).toBeLessThanOrEqual(30);
    expect(refused.state.y).toBe(0);
  });
});

describe('the mover, continued (W1.4)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);

  it('a step toward a wall ends 3.5 from it, and slides along it', () => {
    const walled = world([floor(-200, -200, 200, 200, 0), wallX(50, -150, 150, 0, 30)]);
    const w = new Walker(walled);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 180; i++) w.tick(FORWARD);
    expect(w.state.x).toBeCloseTo(50 - BODY_RADIUS, 6);
    expect(BODY_RADIUS).toBe(3.5);                        // research 24 section 2 step 3
    expect(w.state.z).toBeCloseTo(0, 6);
    // Now at 45 degrees into it: the push takes out the part into the wall and the rest slides along.
    w.state.yaw = facing(0, 0, 1, 1);
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(w.state.x).toBeCloseTo(50 - BODY_RADIUS, 6);
    expect(w.state.z).toBeGreaterThan(15);
  });

  it('a wall is bit 18 clear and in the body\'s column, y + 6 to y + 20 (research 24 section 2 step 3)', () => {
    const through = (poly: WorldPoly): number => {
      const w = new Walker(world([floor(-200, -200, 200, 200, 0), poly]));
      w.place(0, 0, 0);
      w.state.yaw = facing(0, 0, 1, 0);
      for (let i = 0; i < 180; i++) w.tick(FORWARD);
      return w.state.x;
    };
    expect(through(wallX(50, -150, 150, 0, 30))).toBeLessThan(50);           // a wall: stopped
    expect(through(wallX(50, -150, 150, 0, 30, 1))).toBeGreaterThan(60);     // bit 18 set: a doorway volume, walked through
    expect(through(wallX(50, -150, 150, 0, 5))).toBeGreaterThan(60);         // under the column: a kerb's face
    expect(through(wallX(50, -150, 150, 21, 40))).toBeGreaterThan(60);       // over the column: a lintel
  });

  it('a step over a 1-unit kerb climbs it', () => {
    const kerb = world([floor(-200, -200, 30, 200, 0), floor(30, -200, 200, 200, 1), wallX(30, -200, 200, 0, 1)]);
    const w = new Walker(kerb);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 120; i++) w.tick(FORWARD);
    expect(w.state.x).toBeGreaterThan(40);
    expect(w.state.y).toBe(1);
  });

  it('from below, the deck\'s face is a wall at the body\'s height', () => {
    const deck = world([floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 100, 42), wallX(30, -100, 100, 0, 42)]);
    const below = new Walker(deck);
    below.place(80, 10, 0);
    below.state.yaw = facing(80, 0, 0, 0);
    for (let i = 0; i < 180; i++) below.tick(FORWARD);
    expect(below.state.x).toBeCloseTo(30 + BODY_RADIUS, 6);
    expect(below.state.y).toBe(0);
  });

  it('refuses a step onto no floor at all, and the eye follows the feet between ticks', () => {
    const w = new Walker(plain);
    w.place(190, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 120; i++) w.tick(FORWARD);
    expect(w.state.x).toBeLessThanOrEqual(200);
    expect(w.state.x).toBeGreaterThan(199);
    // Interpolation: half a tick into the next one, the eye is between the last two positions.
    const v = new Walker(plain);
    v.place(0, 0, 0);
    v.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 60; i++) v.tick(FORWARD);
    const x0 = v.state.x;
    v.advance(TICK * 1.5, FORWARD);
    const x1 = v.state.x;
    expect(v.eye()[0]).toBeGreaterThan(x0);
    expect(v.eye()[0]).toBeLessThan(x1);
  });
});

describe('the ground\'s trip from the worker', () => {
  it('packs the polygons into two transferable arrays and gets every field and point back, named by their node', () => {
    const polys = [floor(0, 0, 10, 10, 3), { ...wallX(5, 0, 10, 0, 30, 1), region: 34, material: 9 }];
    const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/a', first: 0, count: 1, flags: 4097 },
      { modelName: 'door1', path: 'worldmodel/b=door1', first: 1, count: 1 }];
    const packed = packGround({ atomCount: 8192, posts: 16, cellDim: 100, cellsX: 1, cellsZ: 1, originX: 0, originZ: 0 }, polys, owners);
    expect(packed.points.length).toBe(24);
    const back = groundPolygons(structuredClone(packed));
    expect(back.map((p) => [p.modelName, p.path, p.ptcount, p.ditype, p.material, p.cameratype, p.region])).toEqual([
      ['worldmodel', 'worldmodel/a', 4, 3, 25, 0, 0], ['door1', 'worldmodel/b=door1', 4, 2, 9, 1, 34]]);
    expect([...back[1]!.points]).toEqual([...polys[1]!.points]);
    expect(back[0]!.points.buffer).toBe(back[1]!.points.buffer);     // views on one buffer, not copies
  });
});

/**
 * Research 24 section 6.1: A's spawn to B's floor, 20 legs. Each waypoint with the floor its leg ends on.
 */
const ROUTE: [number, number, number][] = [
  [806, 100, 665], [806, 100, 712], [760, 100, 720], [745, 100, 720], [695, 100, 730], [690, 100, 780],
  [685, 100, 830], [718, 100, 872], [720, 100, 915], [720, 100, 960], [720, 100, 1005], [735, 100, 1055],
  [720, 100, 1100], [715, 100, 1155], [712, 100, 1190], [705, 100, 1223], [680, 102, 1223.5], [640, 122, 1223.5],
  [600, 142, 1223.5], [565, 142, 1235],
];

/** Steers the mover at a point, a tick at a time, until it is within `near` of it or `seconds` run out. */
function steer(w: Walker, tx: number, tz: number, near = 2, seconds = 10): boolean {
  for (let i = 0; i < seconds / TICK; i++) {
    const d = Math.hypot(tx - w.state.x, tz - w.state.z);
    if (d <= near) return true;
    w.state.yaw = facing(w.state.x, w.state.z, tx, tz);
    w.tick({ forward: Math.min(1, d / 10), right: 0, boost: false });
  }
  return false;
}

describe.skipIf(!MP2)(`walking Frostfire${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('walks research 24\'s route from A\'s spawn to B\'s floor, on each leg\'s floor within 1.5, and the door leaf stops it', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    expect(map.ground).toBeDefined();
    expect(groundPolygons(map.ground!).length).toBe(3318);           // research 24 section 1.1
    const w = new Walker(groundGrid(map.ground!));
    expect(w.place(796, 100 + EYE_HEIGHT, 614)).toBe(true);
    expect(w.state.y).toBe(100);
    for (const [i, [x, y, z]] of ROUTE.entries()) {
      expect(steer(w, x, z), `leg ${i + 1} to (${x}, ${z}) from (${w.state.x.toFixed(1)}, ${w.state.z.toFixed(1)})`).toBe(true);
      expect(Math.abs(w.state.y - y), `leg ${i + 1}: feet at ${w.state.y.toFixed(2)}, floor ${y}`).toBeLessThanOrEqual(1.5);
    }
    // Research 24 section 0.3 / 6.3: the door leaf between B's region and the building, x 576-589, z 1117-1118.
    // Squarely in front of it on B's side, then straight at it: the leaf stops the mover a body's radius short.
    expect(steer(w, 582.5, 1140)).toBe(true);
    w.state.yaw = facing(582.5, 1140, 582.5, 1000);
    for (let i = 0; i < 180; i++) w.tick({ forward: 1, right: 0, boost: false });
    expect(w.state.z).toBeGreaterThan(1118);
    expect(w.state.z).toBeLessThan(1118 + BODY_RADIUS + 1);
    expect(w.state.y).toBeCloseTo(142, 3);
  });

  it('walking off the 142 deck east of A\'s spawn falls 42 onto the 100 floor in ~0.60 s (W2.2b)', async () => {
    // B's ramp at z 1223 is walled on both sides; the open edge is the deck at x 630-675, z 725-815, y 142, whose
    // east side at x ~675 drops to the 100 floor (found by walking every 15 units of the 142 level, 2026-09-28).
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const w = new Walker(groundGrid(map.ground!));
    expect(w.place(660, 142 + EYE_HEIGHT, 725)).toBe(true);
    expect(w.state.y).toBe(142);
    w.state.yaw = facing(660, 725, 700, 725);
    let off = -1, landed = -1;
    for (let i = 0; i < 120 && landed < 0; i++) {
      w.tick(FORWARD);
      if (off < 0 && w.airborne) off = i;
      if (off >= 0 && !w.airborne) landed = i;
    }
    expect(off).toBeGreaterThan(0);
    expect(w.state.y).toBe(100);
    expect(Math.abs((landed - off) * TICK - Math.sqrt(2 * 42 / 235))).toBeLessThanOrEqual(2 * TICK);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The mode: G, the panel's switch, the stick, and the hook's setCamera (W1.4 step 5).

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  return c;
};
const key = (code: string, type: 'keydown' | 'keyup' = 'keydown', init: KeyboardEventInit = {}): void => {
  globalThis.dispatchEvent(new KeyboardEvent(type, { code, ...init }));
};

/** A floor over x, z -200..200 at y 0 and a deck over x, z -100..30 at y 42, as the probe receives them. */
const GROUND: GroundData = packGround(
  { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
  [floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 30, 42)],
  [{ modelName: 'worldmodel', path: 'worldmodel/ground', first: 0, count: 1 }, { modelName: 'worldmodel', path: 'worldmodel/deck', first: 1, count: 1 }],
);

describe('walk mode (W1.4 step 5)', () => {
  const made: WalkMode[] = [];
  const setUp = (ground: GroundData | null = GROUND, spawn: [number, number, number] | null = [150, 0, 150]) => {
    const fly = new FlyCamera(canvas());
    fly.setScale(0.1);
    const changes: boolean[] = [];
    const mode = new WalkMode(fly, (walking) => changes.push(walking));
    mode.setGround(ground ?? undefined, spawn);
    mode.bindKey();
    made.push(mode);
    return { fly, mode, changes };
  };
  afterEach(() => { for (const m of made.splice(0)) { m.unbindKey(); } key('KeyW', 'keyup'); });

  it('G toggles walk and fly, and the switch hears it; nothing is on Ctrl', () => {
    const { fly, mode, changes } = setUp();
    fly.setPose({ x: 150, y: 80, z: 150, yaw: 0, pitch: 0 });
    expect(mode.mode()).toBe('fly');
    key('KeyG');
    expect(mode.mode()).toBe('walk');
    key('KeyG');
    expect(mode.mode()).toBe('fly');
    key('KeyG', 'keydown', { ctrlKey: true });
    key('KeyG', 'keydown', { metaKey: true });
    expect(mode.mode()).toBe('fly');
    key('KeyG', 'keydown', { repeat: true });                       // a held G does not flicker the mode
    expect(mode.mode()).toBe('fly');
    expect(changes).toEqual([true, false]);
    // The panel's switch drives the same thing.
    expect(mode.setMode('walk')).toBe(true);
    expect(mode.mode()).toBe('walk');
    expect(changes).toEqual([true, false, true]);
  });

  it('a tap of C toggles stand and crouch, a hold goes prone (owner, 2026-09-29); not on Ctrl; setStance for the hook', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    const tap = (init: KeyboardEventInit = {}): void => { key('KeyC', 'keydown', init); key('KeyC', 'keyup', init); mode.frame(TICK); mode.frame(TICK); };
    expect(mode.stance()).toBe('stand');
    tap();
    expect(mode.stance()).toBe('stand');                            // in fly mode C does nothing
    mode.setMode('walk');
    tap();
    expect(mode.stance()).toBe('crouch');
    tap({ ctrlKey: true });
    expect(mode.stance()).toBe('crouch');
    tap();
    expect(mode.stance()).toBe('stand');
    key('KeyC');                                                    // held: prone at 0.4 s, the repeats ignored
    for (let t = 0; t < 0.5; t += TICK) { key('KeyC', 'keydown', { repeat: true }); mode.frame(TICK); }
    expect(mode.stance()).toBe('prone');
    key('KeyC', 'keyup');
    mode.frame(TICK);
    expect(mode.stance()).toBe('prone');
    tap();
    expect(mode.stance()).toBe('crouch');                           // from prone a tap crouches
    expect(mode.setStance('stand')).toBe(true);
    for (let t = 0; t < 2; t += TICK) mode.frame(TICK);             // the transitions' clips run out
    expect(mode.setStance('crouch')).toBe(true);
    const at = mode.feet()!;
    mode.walkFor(10, { forward: 0.5, right: 0, boost: false });
    const after = mode.feet()!;
    // Stand -> Crouch holds the mover 0.60 s (FUN_005817d0), then the crouch walk, 14.0 a second
    const walked = 14 * (10 - ACTION_SECONDS.standToCrouch);
    expect(at[2] - after[2]).toBeGreaterThan(walked - 3);
    expect(at[2] - after[2]).toBeLessThan(walked + 0.5);
  });

  it('the touch C button is C: a tap toggles stand and crouch (prone: crouch), a hold goes prone, a cancel is nothing', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    const tap = (): void => { mode.stanceTouch('down'); mode.stanceTouch('up'); mode.frame(TICK); mode.frame(TICK); };
    tap();
    expect(mode.stance()).toBe('stand');                            // in fly mode the button does nothing
    mode.setMode('walk');
    tap();
    expect(mode.stance()).toBe('crouch');
    tap();
    expect(mode.stance()).toBe('stand');
    mode.stanceTouch('down');                                       // held: prone at 0.4 s
    for (let t = 0; t < 0.5; t += TICK) mode.frame(TICK);
    expect(mode.stance()).toBe('prone');
    mode.stanceTouch('up');
    mode.frame(TICK);
    expect(mode.stance()).toBe('prone');                            // the hold's release does nothing
    for (let t = 0; t < 3; t += TICK) mode.frame(TICK);             // the dive's clip runs out
    tap();
    expect(mode.stance()).toBe('crouch');                           // from prone a tap crouches, not the pad's stand
    for (let t = 0; t < 3; t += TICK) mode.frame(TICK);
    mode.stanceTouch('down');                                       // cancelled (a system gesture took the finger): no tap
    mode.frame(TICK);
    mode.stanceTouch('cancel');
    mode.frame(TICK);
    mode.frame(TICK);
    expect(mode.stance()).toBe('crouch');
  });

  it('Ctrl+C is left to the browser in fly and walk mode; a bare C while walking is the stance\'s', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    const press = (init: KeyboardEventInit): boolean => {
      const e = new KeyboardEvent('keydown', { code: 'KeyC', cancelable: true, ...init });
      globalThis.dispatchEvent(e);
      globalThis.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyC' }));
      mode.frame(TICK);                                             // the tap acts at the release, on the next frame
      mode.frame(TICK);
      return e.defaultPrevented;
    };
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(press({})).toBe(false);                                   // fly mode: C is nobody's
    mode.setMode('walk');
    expect(press({ ctrlKey: true })).toBe(false);
    expect(mode.stance()).toBe('stand');
    expect(press({})).toBe(true);
    expect(mode.stance()).toBe('crouch');
  });

  it('entering walk drops the mover onto the floor under the camera, the game\'s camera behind it (W2.1)', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 0, y: 90, z: 0, yaw: 30, pitch: -10 });
    mode.setMode('walk');
    expect(mode.feet()).toEqual([0, 42, 0]);                        // the deck, the highest floor under the camera
    // Standing at the spawn pitch: 25.709 over the feet, 24.906 behind along the yaw (`playerCamera.ts`).
    const pose = fly.pose(), yaw = (30 * Math.PI) / 180;
    expect(pose.x).toBeCloseTo(24.906 * Math.sin(yaw), 3);
    expect(pose.y).toBeCloseTo(42 + 25.709, 3);
    expect(pose.z).toBeCloseTo(24.906 * Math.cos(yaw), 3);
    expect(pose.yaw).toBeCloseTo(30, 9);                            // the turn is kept; the pitch is the spawn's
    mode.setMode('fly');
    fly.setPose({ x: 0, y: 30, z: 0 });                             // under the deck, over the floor
    mode.setMode('walk');
    expect(mode.feet()).toEqual([0, 0, 0]);
  });

  it('entering walk off every floor stands on spawn A; with no ground at all it stays in fly', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 900, y: 90, z: 900 });
    expect(mode.setMode('walk')).toBe(true);
    expect(mode.feet()).toEqual([150, 0, 150]);
    const bare = setUp(null, [150, 0, 150]);
    expect(bare.mode.setMode('walk')).toBe(false);
    expect(bare.mode.mode()).toBe('fly');
    expect(bare.changes).toEqual([]);
  });

  it('the keys and the stick drive the mover, at 60 Hz, and the camera follows behind it', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });      // yaw 0 faces -z
    mode.setMode('walk');
    key('KeyW');
    for (let i = 0; i < 30; i++) { fly.update(1 / 30); mode.frame(1 / 30); }
    key('KeyW', 'keyup');
    const pose = fly.pose(), feet = mode.feet()!;
    expect(feet[2]).toBeLessThan(130);
    expect(pose.x).toBeCloseTo(150, 6);
    expect(feet[1]).toBe(0);
    expect(pose.y).toBeCloseTo(25.709, 3);                          // the game's camera standing (W2.1)
    expect(pose.z - mode.drawnFeet()![2]).toBeCloseTo(24.906, 3);  // both drawn between the last two ticks
    // The touch stick is the same wish: pushed up the screen, forward.
    const before = mode.feet()![2];
    fly.setStick(0, 1);
    for (let i = 0; i < 30; i++) { fly.update(1 / 30); mode.frame(1 / 30); }
    fly.setStick(0, 0);
    expect(mode.feet()![2]).toBeLessThan(before - 10);
    // And in fly mode the frame leaves the camera to fly.
    mode.setMode('fly');
    const at = fly.pose();
    mode.frame(1 / 30);
    expect(fly.pose()).toEqual(at);
  });

  it('the hook\'s setCamera also sets the mover: onto the floor under the new pose, or back to fly with none', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150 });
    mode.setMode('walk');
    mode.setCamera({ x: 0, y: 60, z: 0, yaw: 90 });
    expect(mode.feet()).toEqual([0, 42, 0]);
    // Facing -x (yaw 90), the camera behind on +x, at the spawn pitch (W2.1).
    expect(fly.pose().x).toBeCloseTo(24.906, 3);
    expect(fly.pose().y).toBeCloseTo(42 + 25.709, 3);
    expect(fly.pose().z).toBeCloseTo(0, 6);
    expect(fly.pose().yaw).toBeCloseTo(90, 9);
    mode.setCamera({ yaw: 180 });                                    // a turn only: the mover stays put
    expect(mode.feet()).toEqual([0, 42, 0]);
    mode.setCamera({ x: 900, y: 60, z: 900 });                      // nowhere to stand: the pose is honoured, in fly
    expect(mode.mode()).toBe('fly');
    expect(fly.pose()).toMatchObject({ x: 900, y: 60, z: 900 });
  });

  it('walkFor drives the mover a whole number of ticks, the same whatever the frame rate, for Playwright', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 90, pitch: 0 });     // yaw 90 faces -x
    mode.setMode('walk');
    const pose = mode.walkFor(1, { forward: 1, right: 0, boost: false });
    expect(mode.feet()![0]).toBeLessThan(120);
    expect(pose.x - mode.feet()![0]).toBeCloseTo(24.906, 3);       // the camera behind, on +x (W2.1)
    expect(pose.z).toBeCloseTo(150, 6);
    expect(pose.y).toBeCloseTo(25.709, 3);
    expect(fly.pose()).toEqual(pose);
  });

  it('a new map re-stands a walking mover: on the floor under the camera the map load placed', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150 });
    mode.setMode('walk');
    fly.setPose({ x: 0, y: 120, z: 0 });                             // main.ts stands the camera at the new spawn
    mode.setGround(GROUND, [150, 0, 150]);
    expect(mode.mode()).toBe('walk');
    expect(mode.feet()).toEqual([0, 42, 0]);
    mode.setGround(undefined, null);                                 // a map with no hull: back to fly
    expect(mode.mode()).toBe('fly');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The jump (web/docs/research/80-the-jump.md): FUN_0057e1b0's two jumps, FUN_005af930's impulse, FUN_005af590's landing.

describe('the jump, as the decompilation has it (research 80)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);
  const standing = (): Walker => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    return w;
  };

  it('under 15 a second is the standing jump: the Jump action on the floor, 0.99 s, the feet never leave it', () => {
    const w = standing();
    expect(RUNNING_JUMP_SPEED).toBe(15);                           // FUN_0057e1b0: 225 <= |v|^2
    expect(w.jump()).toBe(true);
    expect(w.action?.name).toBe('jump');
    expect(ACTION_SECONDS.jump).toBeCloseTo(1.1 * (19 / 20) ** 2, 9);   // seal_jump: playback 1.1, 20 keys
    let lowest = 0, highest = 0;
    for (let i = 0; i < 50; i++) {
      w.tick(STILL);
      expect(w.airborne).toBe(false);
      lowest = Math.min(lowest, w.state.y); highest = Math.max(highest, w.state.y);
    }
    expect([lowest, highest]).toEqual([0, 0]);                     // FUN_0059afd0: not UseVelY, the height is the actor's
    expect(w.jump()).toBe(false);                                  // the Jump action holds: no second jump inside it
    for (let i = 0; i < 20; i++) w.tick(STILL);
    expect(w.action).toBeNull();
    expect(w.jump()).toBe(true);                                   // and again once it is done
  });

  it('the standing jump\'s stick drives it at the sets\' top speeds: 65 ahead, 37 back, 65 aside, 20 crouched', () => {
    const speed = (input: WalkInput, stance: Stance = 'stand'): number => {
      const w = standing();
      w.stance = stance;
      w.jump();
      for (let i = 0; i < 30; i++) w.tick(input);
      return Math.hypot(w.state.vx, w.state.vz);
    };
    expect(speed(FORWARD)).toBeCloseTo(65, 6);
    expect(speed({ forward: -1, right: 0, boost: false })).toBeCloseTo(37, 6);
    expect(speed({ forward: 0, right: 1, boost: false })).toBeCloseTo(65, 6);
    expect(speed({ forward: 0, right: -1, boost: false })).toBeCloseTo(65, 6);
    expect(speed(FORWARD, 'crouch')).toBeCloseTo(20, 6);
    // no renormalisation (DAT_0064fc80 is 1 in the Jump state): a diagonal stick is the axes' own
    expect(speed({ forward: Math.SQRT1_2, right: Math.SQRT1_2, boost: false })).toBeCloseTo(65, 6);
    expect(speed(STILL)).toBe(0);                                  // at rest, seal_jump's root does not travel
  });

  it('from 15 a second the running jump: the launch, 79.9 up 0.1 s after take-off, 13.6 high, carried, no stick', () => {
    const w = standing();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);                  // running at 65
    const v0 = Math.hypot(w.state.vx, w.state.vz);
    expect(v0).toBeCloseTo(65, 6);
    const x0 = w.state.x;
    expect(w.jump()).toBe(true);
    expect(w.action?.name).toBe('launch');
    expect(w.airborne).toBe(true);
    expect(runningJumpSpeed()).toBeCloseTo(0.85 * 235 * 0.4, 9);  // jump_factor x gravity x 0.4 = 79.9
    let top = 0, ticks = 0, firstRise = -1;
    while (w.airborne && ticks < 200) {
      w.tick({ forward: 0, right: 1, boost: false });              // the stick does nothing in the air
      ticks++;
      if (firstRise < 0 && w.state.y > 0) firstRise = ticks;
      top = Math.max(top, w.state.y);
    }
    expect(firstRise).toBe(Math.round(JUMP_DELAY / TICK));         // the impulse on the tick the 0.1 s runs out
    // Through the wind-up the fall runs from 0 with the landing off: the feet sink 0.98 in five ticks (FUN_0059b440,
    // FUN_0059ad30). Then FUN_0059b440 adds g dt to the fall speed before it moves the height: the rise tops out
    // 12.92 over where it began (13.58 in closed form), 11.95 over the floor.
    let sink = 0, fall = 0;
    for (let i = 0; i < Math.round(JUMP_DELAY / TICK) - 1; i++) { fall += 235 * TICK; sink += fall * TICK; }
    expect(sink).toBeCloseTo(0.98, 2);
    let apex = -sink, h = -sink;
    for (let v = runningJumpSpeed() - 235 * TICK; v > 0; v -= 235 * TICK) { h += v * TICK; apex = h; }
    expect(top).toBeCloseTo(apex, 6);
    expect(apex).toBeCloseTo(11.95, 1);
    const air = ticks * TICK;
    expect(air).toBeGreaterThan(JUMP_DELAY + (2 * runningJumpSpeed()) / 235 - 2 * TICK);   // 0.75 s from the sunk feet
    expect(air).toBeLessThan(JUMP_DELAY + (2 * runningJumpSpeed()) / 235 + 2 * TICK);
    expect(w.state.x - x0).toBeCloseTo(v0 * air, 0);               // the take-off's 65, straight on
    expect(w.state.z).toBeCloseTo(0, 9);
    // landing at 79.9 with the stick off rest: no landing clip, the run goes on (FUN_005af590)
    expect(w.landing?.clip).toBeNull();
    expect(w.action).toBeNull();
    expect(w.jump()).toBe(false);                                  // JUMP_LOCK 0.4 s after a landing
    for (let i = 0; i < Math.ceil(JUMP_LOCK / TICK); i++) w.tick(FORWARD);
    expect(w.jump()).toBe(true);
  });

  it('a running jump landed with the stick at rest plays Jump land, gliding the carried speed down to a stop', () => {
    const w = standing();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    w.jump();
    while (w.airborne) w.tick(STILL);
    expect(w.landing?.clip).toBe('land');
    expect(w.landing!.speed).toBeLessThan(115);
    expect(w.action?.name).toBe('land');
    for (let i = 0; i < Math.ceil(ACTION_SECONDS.land / TICK); i++) w.tick(STILL);
    expect(w.action).toBeNull();
    expect(Math.hypot(w.state.vx, w.state.vz)).toBe(0);
  });

  it('prone cannot jump (FUN_005b4340 refuses stance 2); crouched it can, and stays crouched', () => {
    const w = standing();
    w.stance = 'prone';
    expect(w.jump()).toBe(false);
    w.stance = 'crouch';
    expect(w.jump()).toBe(true);
    expect(w.action?.name).toBe('jump');
    for (let i = 0; i < 70; i++) w.tick(STILL);
    expect(w.stance).toBe('crouch');
  });

  it('the one-shots the mover waits on are motion.rdr\'s playback over their keys (FUN_0028c4f0)', () => {
    for (const [name, c] of Object.entries(ACTION_CLIPS)) {
      expect(ACTION_SECONDS[name as keyof typeof ACTION_CLIPS]).toBeCloseTo(c.playback * ((c.frames - 1) / c.frames) ** 2, 9);
    }
  });

  it('a stance change on the floor plays its transition, holding the mover; moving over 10 it runs straight on', () => {
    const w = standing();
    w.changeStance('crouch');
    expect(w.action).toMatchObject({ name: 'standToCrouch', reversed: false });
    for (let i = 0; i < 20; i++) w.tick(FORWARD);
    expect(Math.hypot(w.state.x, w.state.z)).toBeLessThan(1.8);    // held: only the clip's own 1.7-unit shuffle
    for (let i = 0; i < 30; i++) w.tick(STILL);
    expect(w.action).toBeNull();
    w.changeStance('stand');
    expect(w.action).toMatchObject({ name: 'standToCrouch', reversed: true });
    for (let i = 0; i < 40; i++) w.tick(STILL);
    w.changeStance('prone');
    expect(w.action).toMatchObject({ name: 'standToProne', reversed: false });
    for (let i = 0; i < 60; i++) w.tick(STILL);
    w.changeStance('crouch');
    expect(w.action).toMatchObject({ name: 'crouchToProne', reversed: true });
    for (let i = 0; i < 60; i++) w.tick(STILL);
    w.changeStance('stand');
    expect(w.action?.reversed).toBe(true);
    for (let i = 0; i < 60; i++) w.tick(STILL);
    for (let i = 0; i < 60; i++) w.tick(FORWARD);                  // running at 65
    w.changeStance('crouch');
    expect(w.action).toBeNull();                                   // FUN_005817d0: speed^2 > 100, no transition
    expect(w.stance).toBe('crouch');
  });
});

describe('NoInterrupt and the heavy falls (FUN_00587c20, FUN_005af590, FUN_005ac1f0)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);
  const at = (): Walker => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    return w;
  };
  const drop = (height: number, random = 0.9): Walker => {
    const tower = world([floor(-200, -200, 200, 200, 0), floor(-20, -20, 20, 20, height)]);
    const w = new Walker(tower);
    w.random = () => random;
    w.place(0, height + 5, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 30; i++) w.tick(FORWARD);
    for (let i = 0; i < 400 && (w.airborne || w.state.y > 0); i++) w.tick(STILL);
    return w;
  };
  const phaseTicks = (name: keyof typeof ACTION_CLIPS): number => {
    const c = ACTION_CLIPS[name];
    return Math.floor((c.noInterrupt * c.playback * ((c.frames - 1) / c.frames)) / TICK);
  };

  it('the soft landing gives way to the stick at once (no NoInterrupt); a stick under 0.1 does not cut it', () => {
    const w = at();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    w.jump();
    while (w.airborne) w.tick(STILL);
    expect(w.action?.name).toBe('land');
    w.tick({ forward: 0.09, right: 0, boost: false });
    expect(w.action?.name).toBe('land');
    w.tick({ forward: 0.2, right: 0, boost: false });
    expect(w.action).toBeNull();
  });

  it('the standing jump gives way to the stick past 0.7 of its phase (0.73 s), not before', () => {
    const w = at();
    w.jump();
    for (let i = 0; i < phaseTicks('jump'); i++) w.tick(FORWARD);
    expect(w.action?.name).toBe('jump');
    for (let i = 0; i < 2; i++) w.tick(FORWARD);
    expect(w.action).toBeNull();
  });

  it('a transition is never cut by the stick: the player cannot interrupt Stand -> Crouch', () => {
    const w = at();
    w.changeStance('crouch');
    for (let i = 0; i < Math.floor(ACTION_SECONDS.standToCrouch / TICK) - 1; i++) w.tick(FORWARD);
    expect(w.action?.name).toBe('standToCrouch');
  });

  it('landingClass: sqrt(2 g h) of FALLING_DAMAGE_LIGHT/HEAVY/DEATH -- 170.7, 206.8, 237.5', () => {
    expect(landingClass(170)).toBe(0);
    expect(landingClass(171)).toBe(1);
    expect(landingClass(207)).toBe(2);
    expect(landingClass(Math.sqrt(2 * 235 * 120))).toBe(3);
  });

  it('a fall past heavy plays a hit, one of two by the draw; past death Land forward, then (the viewer) gets up', () => {
    const a = drop(100, 0.9);                                       // 216.8: heavy
    expect(a.landing).toMatchObject({ clip: 'hit', cls: 2 });
    expect(a.action?.name).toBe('hit');
    expect(drop(100, 0.2).landing?.clip).toBe('hitStomach');
    const b = drop(70);                                             // 181.4: light -- the hard landing
    expect(b.landing).toMatchObject({ clip: 'landHard', cls: 1 });
    const d = drop(130);                                            // 247.2: death
    expect(d.landing).toMatchObject({ clip: 'landDeath', cls: 3 });
    for (let i = 0; i < Math.ceil(ACTION_SECONDS.landDeath / TICK) + 1; i++) d.tick(STILL);
    expect(d.action?.name).toBe('getUp');
  });

  it('a hit carries the mover by the clip\'s own root travel, and gives way to the stick past 0.8', () => {
    const w = drop(100, 0.9);
    const x = w.state.x, z = w.state.z;
    for (let i = 0; i < phaseTicks('hit'); i++) w.tick(FORWARD);
    expect(w.action?.name).toBe('hit');
    const moved = Math.hypot(w.state.x - x, w.state.z - z);
    expect(moved).toBeGreaterThan(0.7 * 16.6 * 0.8);
    expect(moved).toBeLessThan(16.7);
    for (let i = 0; i < 2; i++) w.tick(FORWARD);
    expect(w.action).toBeNull();
  });
});

describe('round 3: the turn axis cuts, the actions move by their root key by key (FUN_00550ef0, FUN_0028c250)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);
  const at = (): Walker => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = 0;                                                // facing -z
    return w;
  };

  it('the turn axis past 0.1 (the turn over turn_maxrate) cuts an interruptible action as the stick does', () => {
    const w = at();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    w.jump();
    while (w.airborne) w.tick(STILL);
    expect(w.action?.name).toBe('land');
    w.turn = 0.1 * SEAL_TUNING.turnMaxRate;                          // exactly 0.1: not past it
    w.tick(STILL);
    expect(w.action?.name).toBe('land');
    w.turn = 0.3;
    w.tick(STILL);
    expect(w.action).toBeNull();
  });

  it('a transition carries the mover by the root key it is on, not the clip\'s mean', () => {
    const w = at();
    const n = ACTION_CLIPS.standToCrouch.frames;
    // made-up root keys: still for the first half of the keys, then 1 a key along -z (ahead)
    const keys = new Float32Array(2 * n);
    for (let i = 0; i < n; i++) keys[2 * i + 1] = -Math.max(0, i - Math.floor(n / 2));
    w.actionRoots = new Map([['seal_stand2crouch', keys]]);
    w.changeStance('crouch');
    const early = w.actionVelocity('standToCrouch', 0.05, false);
    expect(early).toEqual([0, 0]);
    const late = w.actionVelocity('standToCrouch', ACTION_SECONDS.standToCrouch * 0.9, false);
    expect(late[1]).toBeCloseTo(-n / ACTION_CLIPS.standToCrouch.playback, 6);   // 1 a key x keys / playback
    // backwards (getting up) the phase runs from the end and the motion turns round
    expect(w.actionVelocity('standToCrouch', 0.05, true)[1]).toBeCloseTo(n / ACTION_CLIPS.standToCrouch.playback, 6);
    let z = w.state.z;
    for (let i = 0; i < 10; i++) w.tick(STILL);
    expect(w.state.z).toBeCloseTo(z, 9);                            // the still half: no carry
    for (let i = 0; i < Math.ceil(ACTION_SECONDS.standToCrouch / TICK) - 12; i++) w.tick(STILL);
    expect(w.state.z).toBeLessThan(z - 5);                          // then carried ahead
    z = w.state.z;
  });

  it('with no root keys, each clip\'s mean travel stands in', () => {
    const w = at();
    const [x, z] = w.actionVelocity('crouchToProne', 0.2, false);
    const c = ACTION_CLIPS.crouchToProne;
    expect(x).toBeCloseTo(c.travel[0] / ACTION_SECONDS.crouchToProne, 9);
    expect(z).toBeCloseTo(c.travel[1] / ACTION_SECONDS.crouchToProne, 9);
  });
});

describe("the running jump's clips: the launch over the flight, the fall only past it, no stand at the landing (FUN_005af930)", () => {
  const plain = world([floor(-400, -400, 400, 400, 0)]);
  const at = (y = 0): Walker => {
    const w = new Walker(y === 0 ? plain : world([floor(-400, -400, 400, 400, y)]));
    w.place(0, y, 0);
    w.state.yaw = 0;                                                // facing -z
    return w;
  };
  /** The action or, with none, the ground state each tick: what the animator is handed. */
  const shown = (w: Walker): string => w.action?.name ?? `ground:${w.ground.state}`;

  it('a flat running jump holds Jump launch the whole flight and lands straight into the run', () => {
    const w = at();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(w.ground.state).toBe('stand');
    expect(w.jump()).toBe(true);
    const seq: string[] = [];
    while (w.airborne) { w.tick(FORWARD); seq.push(shown(w)); }
    for (let i = 0; i < 5; i++) { w.tick(FORWARD); seq.push(shown(w)); }
    const runs = seq.filter((x, i) => i === 0 || x !== seq[i - 1]);
    // the launch (2.21 s) outlasts the 0.75 s flight: no Jump fall; the landing tick poses the run it left in
    expect(runs).toEqual(['launch', 'ground:stand']);
    expect(ACTION_SECONDS.launch).toBeCloseTo(2.4 * (24 / 25) ** 2, 9);
    expect(w.landing?.clip).toBeNull();
  });

  it('a flight outlasting the launch gives way to Jump fall (FUN_0057e130 -> FUN_0057e050), then lands', () => {
    // a running jump off a 700-unit drop: the floor is only far under the take-off's edge
    const w = new Walker(world([floor(-400, -400, 400, -20, 0), floor(-400, -20, 400, 400, 700)]));
    w.place(0, 700, 60);
    w.state.yaw = 0;
    for (let i = 0; i < 60 && w.state.z > 0; i++) w.tick(FORWARD);
    expect(w.airborne).toBe(false);
    expect(w.jump()).toBe(true);
    const seq: string[] = [];
    let ticks = 0;
    while (w.airborne && ticks < 2000) { w.tick(FORWARD); seq.push(shown(w)); ticks++; }
    const runs = seq.filter((x, i) => i === 0 || x !== seq[i - 1]);
    expect(runs.slice(0, 2)).toEqual(['launch', 'fall']);
    expect(seq.indexOf('fall')).toBe(Math.ceil(ACTION_SECONDS.launch / TICK - 1e-6) - 1);
  });

  it('a walk-off still falls in Jump fall, and lands on the run with the stick held', () => {
    const w = new Walker(world([floor(-400, -400, 400, -20, 0), floor(-400, -20, 400, 400, 20)]));
    w.place(0, 20, 60);
    w.state.yaw = 0;
    const seq: string[] = [];
    for (let i = 0; i < 200; i++) { w.tick(FORWARD); seq.push(shown(w)); }
    const runs = seq.filter((x, i) => i === 0 || x !== seq[i - 1]);
    expect(runs).toEqual(['ground:stand', 'fall', 'ground:stand']);
  });
});

describe("round 4: the jump only from a looped play (FUN_0057e1b0's FUN_005551a0(entry+0x28, 0x40))", () => {
  const plain = world([floor(-400, -400, 400, 400, 0)]);
  const at = (): Walker => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = 0;
    return w;
  };

  it('refused through a soft landing past the lock, taken the tick the stick cuts it', () => {
    const w = at();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    w.jump();
    while (w.airborne) w.tick(STILL);
    expect(w.action?.name).toBe('land');
    for (let i = 0; i < Math.ceil(JUMP_LOCK / TICK) + 1; i++) w.tick(STILL);
    expect(w.action?.name).toBe('land');                            // 0.632 s: still playing past the 0.4 s lock
    expect(w.jump()).toBe(false);                                   // seal_land_soft is not looped
    w.tick(FORWARD);                                                // NoInterrupt 0: the stick cuts it
    expect(w.action).toBeNull();
    expect(w.jump()).toBe(true);
  });

  it('refused through a stance transition and the standing jump; taken on the idle after', () => {
    const w = at();
    w.changeStance('crouch');
    expect(w.action?.name).toBe('standToCrouch');
    expect(w.jump()).toBe(false);
    for (let i = 0; i < Math.ceil(ACTION_SECONDS.standToCrouch / TICK) + 1; i++) w.tick(STILL);
    expect(w.action).toBeNull();
    expect(w.jump()).toBe(true);                                    // crouched: the standing jump
    expect(w.action?.name).toBe('jump');
    expect(w.jump()).toBe(false);
  });
});

describe('round 4: the rifle <-> pistol swap in the picker (FUN_005a64c0)', () => {
  const plain = world([floor(-400, -400, 400, 400, 0)]);
  const at = (): Walker => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = 0;
    return w;
  };

  it('still: the stance\'s full-body swap holds the mover, backwards to the rifle; the jump waits for it', () => {
    const w = at();
    expect(w.swapWeapon('pistol')).toEqual({ action: 'swapStand', overlay: false, reversed: false, seconds: ACTION_SECONDS.swapStand });
    expect(w.action?.name).toBe('swapStand');
    expect(w.jump()).toBe(false);
    expect(w.swapWeapon('rifle')).toBeNull();                        // one at a time
    for (let i = 0; i < Math.ceil(ACTION_SECONDS.swapStand / TICK) + 1; i++) w.tick(STILL);
    expect(w.action).toBeNull();
    expect(w.state.x).toBeCloseTo(0, 6);
    w.stance = 'crouch';
    expect(w.swapWeapon('rifle')).toMatchObject({ action: 'swapCrouch', reversed: true });
    expect(w.action?.reversed).toBe(true);
    const p = at();
    p.stance = 'prone';
    expect(p.swapWeapon('pistol')?.action).toBe('swapProne');
    expect(ACTION_SECONDS.swapStand).toBeCloseTo(1.32 * (31 / 32) ** 2, 9);
  });

  it('on the move (over 20 a second): the overlay over the locomotion, the run going on', () => {
    const w = at();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    const pick = w.swapWeapon('pistol')!;
    expect(pick).toMatchObject({ action: null, overlay: true, reversed: false });
    expect(w.overlay?.clip).toBe('seal_mv_rifle2pistol');
    const z = w.state.z;
    for (let i = 0; i < 30; i++) w.tick(FORWARD);
    expect(w.action).toBeNull();
    expect(z - w.state.z).toBeGreaterThan(30);                       // still running
    for (let i = 0; i < Math.ceil(pick.seconds / TICK); i++) w.tick(FORWARD);
    expect(w.overlay).toBeNull();
  });

  it('the standing swap cut by the stick goes on as the overlay at its phase (FUN_00550ef0 418226-418245)', () => {
    const w = at();
    w.swapWeapon('pistol');
    for (let i = 0; i < 20; i++) w.tick(STILL);
    const t = w.action!.t;
    w.tick(FORWARD);
    expect(w.action).toBeNull();
    expect(w.overlay?.clip).toBe('seal_mv_rifle2pistol');
    expect(w.overlay!.t / w.overlay!.seconds).toBeCloseTo((t + TICK) / ACTION_SECONDS.swapStand, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The owner's 2026-09-29 report: a running jump up a slope went through the ground (web research 86 section 6.3).

/** The highest surface the probe has over (x, z): the slope's top where a ramp stands over a lower floor. */
const topAt = (grid: Grid, x: number, z: number): number => Math.max(...probeGround(grid, x, z).map((h) => h.y));

/** A walker on `grid` driven as the page drives it: the traversal's tick and `FUN_005b56c0`'s uphill factor. */
function driven(grid: Grid, polys: readonly WorldPoly[]): Walker {
  const w = new Walker(grid);
  w.driver = new Traversal(grid, polys);
  return w;
}

/**
 * Runs the mover from where it stands toward (tx, tz) until `jumpWhen` says so, jumps, and flies it to a landing.
 * Each tick from the impulse on (the 0.1 s wind-up sinks the feet in the game too: FUN_0059ad30 lands nothing while
 * `actor+0x1360` runs) the feet must stand at or over the slope's top under them. Returns the flight's lowest margin.
 */
function jumpUp(w: Walker, grid: Grid, tx: number, tz: number, jumpWhen: (w: Walker) => boolean): { worst: number; landed: boolean } {
  w.state.yaw = facing(w.state.x, w.state.z, tx, tz);
  for (let i = 0; i < 600 && !jumpWhen(w); i++) w.tick(FORWARD);
  expect(jumpWhen(w), `never reached the take-off, at (${w.state.x.toFixed(1)}, ${w.state.y.toFixed(1)}, ${w.state.z.toFixed(1)})`).toBe(true);
  expect(w.jump(), `jump refused at (${w.state.x.toFixed(1)}, ${w.state.z.toFixed(1)})`).toBe(true);
  let worst = Infinity, ticks = 0;
  const windUp = Math.round(JUMP_DELAY / TICK) - 1;
  while (w.airborne && ticks < 240) {
    w.tick(FORWARD);
    ticks++;
    if (ticks > windUp) worst = Math.min(worst, w.state.y - topAt(grid, w.state.x, w.state.z));
  }
  return { worst, landed: !w.airborne };
}

describe('a running jump up a slope lands on it, never under it (owner 2026-09-29; FUN_0059ad30, FUN_0059b440)', () => {
  /** A ramp rising along +x from x 0 at `degrees`, over a flat floor at 0 that runs on under it (as Frostfire's). */
  const ramp = (degrees: number): WorldPoly[] => {
    const k = Math.tan(degrees * Math.PI / 180);
    const slope: WorldPoly = {
      modelName: 'worldmodel', path: 'worldmodel/ramp', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
      points: Float32Array.from([0, 0, -200, 190, 190 * k, -200, 190, 190 * k, 200, 0, 0, 200]),
    };
    return [floor(-200, -200, 200, 200, 0), slope];
  };

  for (const degrees of [15, 26.6, 40, 48]) {
    it(`a ${degrees}-degree ramp: the flight never dips under it, and the landing is on it`, () => {
      const polys = ramp(degrees), grid = world(polys);
      const w = driven(grid, polys);
      w.place(-60, 0, 0);
      const r = jumpUp(w, grid, 200, 0, (m) => m.state.x > 20 && Math.hypot(m.state.vx, m.state.vz) >= RUNNING_JUMP_SPEED);
      expect(r.landed).toBe(true);
      expect(r.worst).toBeGreaterThanOrEqual(-1e-6);
      expect(w.state.y).toBeCloseTo(topAt(grid, w.state.x, w.state.z), 6);   // on the ramp, not the floor under it
      expect(w.state.y).toBeGreaterThan(5);
    });
  }

  it("taken off the flat at 65 just short of a 26.6-degree ramp's foot: the ramp rising under the flight is met, not passed", () => {
    const polys = ramp(26.6), grid = world(polys);
    const w = driven(grid, polys);
    w.place(-100, 0, 0);
    const r = jumpUp(w, grid, 200, 0, (m) => m.state.x > -3);
    expect(r.landed).toBe(true);
    expect(r.worst).toBeGreaterThanOrEqual(-1e-6);
    expect(w.state.y).toBeCloseTo(topAt(grid, w.state.x, w.state.z), 6);
    expect(w.state.y).toBeGreaterThan(5);
  });

  it('rising into the ground keeps the rise (FUN_0059b440 zeroes only a fall): no landing until the feet come down', () => {
    const polys = ramp(26.6), grid = world(polys);
    const w = driven(grid, polys);
    w.place(-100, 0, 0);
    w.state.yaw = facing(-100, 0, 200, 0);
    for (let i = 0; i < 600 && w.state.x < 10; i++) w.tick(FORWARD);
    expect(w.jump()).toBe(true);
    let rose = false, lastVy = 0;
    while (w.airborne) { w.tick(FORWARD); if (w.state.vy > 0) rose = true; if (w.airborne) lastVy = w.state.vy; }
    expect(rose).toBe(true);
    expect(lastVy).toBeLessThan(0);                                          // the landing is on a fall
    expect(w.landing!.speed).toBeGreaterThan(0);
  });
});

describe.skipIf(!MP2)(`a running jump up Frostfire's rail ramp${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('rmp1 (x 680-705, z 891-975, y 100 -> 142 at 26.6 degrees, the 100 floor under it): lands on the ramp', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const grid = groundGrid(map.ground!);
    for (const bare of [true, false]) {                                     // with and without the uphill factor
      const w = bare ? new Walker(grid) : driven(grid, groundPolygons(map.ground!));
      expect(w.place(693, 100 + EYE_HEIGHT, 870)).toBe(true);
      expect(w.state.y).toBe(100);
      const r = jumpUp(w, grid, 693, 1000, (m) => m.state.z > 905);
      expect(r.landed).toBe(true);
      expect(r.worst).toBeGreaterThanOrEqual(-1e-6);
      expect(w.state.y).toBeGreaterThan(110);                                 // not the 100 floor under the ramp
      expect(w.state.y).toBeCloseTo(topAt(grid, w.state.x, w.state.z), 6);
    }
  });
});

const MP6 = fixture('RUN/MP6.ZDB');
describe.skipIf(!MP6)(`a running jump up MP6's hillside${MP6 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('g157 at z 1700 (x 1010 -> 1040, y 36 -> 59, about 39 degrees): the flight stays over the ground', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP6.ZDB');
    const grid = groundGrid(map.ground!);
    for (const bare of [true, false]) {
      const w = bare ? new Walker(grid) : driven(grid, groundPolygons(map.ground!));
      expect(w.place(1012, 60, 1700)).toBe(true);
      const r = jumpUp(w, grid, 1100, 1700, (m) => Math.hypot(m.state.vx, m.state.vz) >= RUNNING_JUMP_SPEED);
      expect(r.landed).toBe(true);
      expect(r.worst).toBeGreaterThanOrEqual(-1e-6);
      expect(w.state.y).toBeCloseTo(topAt(grid, w.state.x, w.state.z), 6);
    }
  });
});
