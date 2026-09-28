import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, SEAL_LOCOMOTION, SEAL_TUNING, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { loadMap } from '../src/loadMap';
import {
  groundGrid, groundPolygons, packGround, rootY, stanceBody, throttleStep, Walker, WalkMode, BODY_RADIUS, EYE_HEIGHT,
  STANCES, TICK, type GroundData, type Stance, type WalkInput,
} from '../src/walk';

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

  it('releasing a full stick stops at once (the > 0.9, > 9 a second snap); half a stick runs down at 2 a second', () => {
    const run = speeds(FORWARD, 60);
    expect(speeds(STILL, 1, 'stand', run.w).v[0]).toBe(0);
    const half = speeds({ forward: 0.5, right: 0, boost: false }, 60);
    const down = speeds(STILL, 16, 'stand', half.w).v;
    expect(down[0]).toBeCloseTo(65 * (0.5 - 2 / 60), 6);
    expect(down[14]).toBe(0);                                   // 0.5 at 2 a second: 15 ticks
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
    expect(lastSecond(speeds(FORWARD, 600, 'crouch').v)).toBeCloseTo(14.8, 1);
    expect(lastSecond(speeds({ forward: -1, right: 0, boost: false }, 600, 'crouch').v)).toBeCloseTo(13.5, 1);
    expect(lastSecond(speeds({ forward: 0, right: 1, boost: false }, 600, 'crouch').v)).toBeCloseTo(15, 1);
    expect(lastSecond(speeds(FORWARD, 600, 'prone').v)).toBeCloseTo(11, 1);
    expect(lastSecond(speeds({ forward: 0, right: -1, boost: false }, 600, 'prone').v)).toBeCloseTo(5.5, 1);
  });

  it('the root height: standing 5.504 as measured; crouch and prone lower, prone at the camera ramp\'s floor', () => {
    expect(rootY('stand')).toBe(5.504);                        // research 17 section 1
    expect(rootY('crouch')).toBeLessThan(rootY('stand'));
    expect(rootY('crouch')).toBeGreaterThan(2.169155);
    expect(rootY('prone')).toBeLessThanOrEqual(2.169155);      // FUN_0029a950's ramp is flat below this
  });

  it('the body column lowers with the stance: a crouch passes under a lintel at 16 that stops a standing SEAL', () => {
    const lintel = world([floor(-200, -200, 200, 200, 0), wallX(50, -150, 150, 16, 40)]);
    const x = (stance: Stance): number => {
      const w = new Walker(lintel);
      w.place(0, 0, 0);
      w.stance = stance;
      w.state.yaw = facing(0, 0, 1, 0);
      for (let i = 0; i < 600; i++) w.tick(FORWARD);
      return w.state.x;
    };
    expect(x('stand')).toBeLessThan(50);
    expect(x('crouch')).toBeGreaterThan(60);
    expect(x('prone')).toBeGreaterThan(60);
    expect(stanceBody('stand')).toMatchObject({ bodyLow: 6, bodyHigh: 20 });
  });
});

describe('the fall and the step (W2.2b): dynamics.rdr\'s gravity, touch distance, step height and slope', () => {
  it('stepping off a 42-unit deck falls under 235 a second squared, lands after ~0.60 s, and runs on', () => {
    const deck = world([floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 100, 42), wallX(30, -100, 100, 0, 42)]);
    const w = new Walker(deck);
    expect(w.place(0, 60, 0)).toBe(true);
    expect(w.state.y).toBe(42);
    w.state.yaw = facing(0, 0, 1, 0);
    let off = -1, landed = -1;
    for (let i = 0; i < 240 && landed < 0; i++) {
      w.tick(FORWARD);
      if (off < 0 && w.airborne) off = i;
      if (off >= 0 && !w.airborne) landed = i;
    }
    expect(off).toBeGreaterThan(0);
    expect(w.state.y).toBe(0);
    // sqrt(2 x 42 / 235) = 0.598 s; the fall is stepped at 60 Hz and starts on the tick after the edge, so +-2 ticks.
    expect(SEAL_TUNING.gravity).toBe(235);
    expect(Math.abs((landed - off) * TICK - Math.sqrt(2 * 42 / 235))).toBeLessThanOrEqual(2 * TICK);
    expect(w.state.x).toBeGreaterThan(30 + 0.5 * 65);          // the run's 65 carried through the air
    const x = w.state.x;
    for (let i = 0; i < 30; i++) w.tick(FORWARD);
    expect(w.state.x - x).toBeCloseTo(32.5, 0);                 // and on at 65 after the landing
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

  it('C cycles the stance stand, crouch, prone, stand; not on Ctrl or a repeat; setStance for the hook', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    expect(mode.stance()).toBe('stand');
    key('KeyC');
    expect(mode.stance()).toBe('stand');                            // in fly mode C does nothing
    mode.setMode('walk');
    key('KeyC');
    expect(mode.stance()).toBe('crouch');
    key('KeyC', 'keydown', { ctrlKey: true });
    key('KeyC', 'keydown', { repeat: true });
    expect(mode.stance()).toBe('crouch');
    key('KeyC');
    expect(mode.stance()).toBe('prone');
    key('KeyC');
    expect(mode.stance()).toBe('stand');
    expect(mode.setStance('crouch')).toBe(true);
    const at = mode.feet()!;
    const pose = mode.walkFor(10, { forward: 1, right: 0, boost: false });
    expect(at[2] - pose.z).toBeGreaterThan(14.8 * 10 - 3);          // the crouch band, 14.8 a second
    expect(at[2] - pose.z).toBeLessThan(14.8 * 10);
  });

  it('entering walk drops the camera onto the floor under it, eye 15.4 over the feet', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 0, y: 90, z: 0, yaw: 30, pitch: -10 });
    mode.setMode('walk');
    expect(mode.feet()).toEqual([0, 42, 0]);                        // the deck, the highest floor under the camera
    expect(fly.pose()).toMatchObject({ x: 0, y: 42 + EYE_HEIGHT, z: 0 });
    expect(fly.pose().yaw).toBeCloseTo(30, 9);                      // the look is kept
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

  it('the keys and the stick drive the mover, at 60 Hz, and the camera follows at the eye', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });      // yaw 0 faces -z
    mode.setMode('walk');
    key('KeyW');
    for (let i = 0; i < 30; i++) { fly.update(1 / 30); mode.frame(1 / 30); }
    key('KeyW', 'keyup');
    const pose = fly.pose();
    expect(pose.z).toBeLessThan(130);
    expect(pose.x).toBeCloseTo(150, 6);
    expect(mode.feet()![1]).toBe(0);
    expect(pose.y).toBeCloseTo(EYE_HEIGHT, 9);
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
    expect(fly.pose()).toMatchObject({ x: 0, y: 42 + EYE_HEIGHT, z: 0 });
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
    expect(pose.x).toBeLessThan(120);
    expect(pose.z).toBeCloseTo(150, 6);
    expect(pose.y).toBeCloseTo(EYE_HEIGHT, 9);
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
