import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, probeGround, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { loadMap } from '../src/loadMap';
import {
  groundGrid, groundPolygons, packGround, Walker, WalkMode, BODY_RADIUS, EYE_HEIGHT, TICK, WALK_SPEED,
  type GroundData, type WalkInput,
} from '../src/walk';
import {
  sealTuning, CROUCH_EYE_PLACEHOLDER, CROUCH_SPEED_PLACEHOLDER, JUMP_PLACEHOLDER, MIN_JUMP_HEIGHT_PLACEHOLDER,
  SEAL_TUNING_DEFAULTS,
} from '../src/physics';

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

/** A 4 x 4 grid of 100-unit cells from (-200, -200), one owner per polygon. */
function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
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

  it('ramps and glides with the fly camera\'s velocity model, on the ground plane', () => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 0, -1);                    // straight down -z: yaw 0
    w.tick(FORWARD);
    const first = -w.state.z;
    for (let i = 0; i < 120; i++) w.tick(FORWARD);
    const before = -w.state.z;
    w.tick(FORWARD);
    const steady = -w.state.z - before;
    expect(first).toBeLessThan(steady * 0.5);
    expect(steady).toBeCloseTo(WALK_SPEED * TICK, 3);     // research 18 Finding 3: ~40 units a second
    const stop = -w.state.z;
    for (let i = 0; i < 120; i++) w.tick(STILL);
    expect(-w.state.z - stop).toBeGreaterThan(1);         // it glides on after the key comes up
    expect(w.state.vx).toBe(0);
    expect(w.state.vz).toBe(0);                           // and then stops for good
  });

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

  it('a wall is bit 18 clear and in the body\'s column, y + 6.5 to y + 20 (research 24 section 2 step 3; step_height)', () => {
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
    expect(through(wallX(50, -150, 150, 0, 6.5))).toBeGreaterThan(60);       // a step's face is not a wall ...
    expect(through(wallX(50, -150, 150, 0, 6.6))).toBeLessThan(50);          // ... and a face over a step's is
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

/** Ticks the mover until `until` holds or `limit` ticks have run; how many ran. */
function tickUntil(w: Walker, input: WalkInput, until: () => boolean, limit = 600): number {
  let n = 0;
  while (!until() && n < limit) { w.tick(input); n++; }
  return n;
}

describe('the step (W2.3a; research 17 section 8: step_height 6.5)', () => {
  /** Walks at a rise of `h` at x 30 for two seconds; where the feet end. `face` adds the rise's vertical face. */
  const climb = (h: number, { face = true, under = false } = {}): [number, number] => {
    const polys = [floor(-200, -200, under ? 200 : 30, 200, 0), floor(30, -200, 200, 200, h)];
    if (face) polys.push(wallX(30, -200, 200, 0, h));
    const w = new Walker(world(polys));
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 120; i++) { w.tick(FORWARD); expect(w.airborne).toBe(false); }
    return [w.state.x, w.state.y];
  };

  it('a rise of step_height is climbed in one step: 6.4 and 6.5 are, 6.6 is a wall', () => {
    expect(SEAL_TUNING_DEFAULTS.step_height).toBe(6.5);
    for (const h of [6.4, 6.5]) {
      const [x, y] = climb(h);
      expect(x, `rise ${h}`).toBeGreaterThan(40);
      expect(y, `rise ${h}`).toBe(Math.fround(h));
    }
    const [x, y] = climb(6.6);                                      // its face reaches into the body's column
    expect(x).toBeCloseTo(30 - BODY_RADIUS, 6);
    expect(y).toBe(0);
  });

  it('with no face to stop it, a rise over step_height refuses the step at the edge', () => {
    for (const h of [6.4, 6.5]) expect(climb(h, { face: false })[1], `rise ${h}`).toBe(Math.fround(h));
    const [x, y] = climb(6.6, { face: false });
    expect(x).toBeLessThanOrEqual(30);
    expect(x).toBeGreaterThan(29);
    expect(y).toBe(0);
    const [x20, y20] = climb(20, { face: false });                   // sprint 1 took any rise the pick allowed
    expect(x20).toBeLessThanOrEqual(30);
    expect(y20).toBe(0);
  });

  it('over a floor that runs on underneath, the pick takes the rise up to step_height from the feet', () => {
    // The selection takes the highest floor at or under its origin + 1 (research 23 section 1.1 item 9); the
    // mover's origin rides step_height - 1 over the feet, so the pick and the step are one rule.
    for (const h of [6.4, 6.5]) expect(climb(h, { under: true })[1], `rise ${h}`).toBe(Math.fround(h));
    const [x, y] = climb(6.6, { under: true });
    expect(x).toBeCloseTo(30 - BODY_RADIUS, 6);
    expect(y).toBe(0);
  });

  it('in the air, a floor over the feet by more than step_height is a face: the move is refused, and the feet fall', () => {
    // Off a 42-unit deck at x 30 toward a cliff from x 45 (no floor under it, no face): its top is 13 over the feet
    // when they get there (at about 27), so the mover falls down its side to the ground rather than onto it.
    const high = world([floor(-200, -200, 45, 200, 0), floor(-100, -100, 30, 100, 42), floor(45, -200, 200, 200, 40)]);
    const w = new Walker(high);
    w.place(0, 60, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    tickUntil(w, FORWARD, () => w.airborne, 180);
    tickUntil(w, FORWARD, () => !w.airborne, 180);
    expect(w.state.y).toBe(0);
    expect(w.state.x).toBeLessThanOrEqual(45);
    // A cliff whose top is 2.5 over the feet there is met on the way down, as a step's rise, and stood on.
    const low = world([floor(-200, -200, 45, 200, 0), floor(-100, -100, 30, 100, 42), floor(45, -200, 200, 200, 29)]);
    const v = new Walker(low);
    v.place(0, 60, 0);
    v.state.yaw = facing(0, 0, 1, 0);
    tickUntil(v, FORWARD, () => v.airborne, 180);
    tickUntil(v, FORWARD, () => !v.airborne, 180);
    expect(v.state.y).toBe(29);
    expect(v.state.x).toBeGreaterThanOrEqual(45);
  });
});

/** A floor rising along +x from (x0, y0) to (x1, y1), across z -200..200 (`m_ditype` 3). */
function ramp(x0: number, y0: number, x1: number, y1: number): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/ramp', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([x0, y0, -200, x1, y1, -200, x1, y1, 200, x0, y0, 200]),
  };
}

describe('the slope (W2.3a; research 17 section 8: max_slope 0.642788, 50 degrees)', () => {
  /** Flat to x 30, a slope of `degrees` up to 30 over it, and a flat top beyond; and where the slope ends. */
  const hill = (degrees: number): { grid: Grid; top: number } => {
    const top = 30 + 30 / Math.tan((degrees * Math.PI) / 180);
    return { grid: world([floor(-200, -200, 30, 200, 0), ramp(30, 0, top, 30), floor(top, -200, 200, 200, 30)]), top };
  };

  it('stands still on 49 degrees; on 51 it has no footing and slides down the tangent to the flat', () => {
    const on = (degrees: number): Walker => {
      const { grid, top } = hill(degrees);
      const w = new Walker(grid);
      expect(w.place((30 + top) / 2, 40, 0)).toBe(true);
      expect(w.state.y).toBeCloseTo(15, 3);
      return w;
    };
    const stands = on(49);
    expect(stands.sliding).toBe(false);
    const at = [stands.state.x, stands.state.y];
    for (let i = 0; i < 120; i++) stands.tick(STILL);
    expect([stands.state.x, stands.state.y]).toEqual(at);
    const slides = on(51);
    expect(slides.sliding).toBe(true);
    let lowest = Infinity;
    for (let i = 0; i < 180; i++) { slides.tick(STILL); lowest = Math.min(lowest, slides.state.y); expect(slides.airborne).toBe(false); }
    expect(slides.state.y).toBe(0);
    expect(slides.state.x).toBeLessThan(30);
    expect(slides.sliding).toBe(false);                             // stood on the flat at the foot
    expect(lowest).toBe(0);
  });

  it('walks up 49 degrees to the top; walked at 51 it is carried back down and never gets up', () => {
    const climb = (degrees: number): { x: number; y: number; highest: number } => {
      const { grid } = hill(degrees);
      const w = new Walker(grid);
      w.place(0, 0, 0);
      w.state.yaw = facing(0, 0, 1, 0);
      let highest = 0;
      for (let i = 0; i < 240; i++) { w.tick(FORWARD); highest = Math.max(highest, w.state.y); }
      return { x: w.state.x, y: w.state.y, highest };
    };
    const up = climb(49);
    expect(up.y).toBe(30);
    expect(up.x).toBeGreaterThan(hill(49).top + 10);
    const refused = climb(51);
    expect(refused.highest).toBeLessThan(15);                        // half way at most, on the run's momentum
    expect(refused.x).toBeLessThan(hill(51).top);
  });
});

describe('the crouch (W2.3a)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);

  it('lowers the eye to the placeholder fraction of 15.4 and the walk to the placeholder fraction of 40 (pins placeholders)', () => {
    expect(CROUCH_EYE_PLACEHOLDER).toBe(0.65);                      // PLACEHOLDER: no crouched eye is on hand
    expect(CROUCH_SPEED_PLACEHOLDER).toBe(0.5);                     // PLACEHOLDER: no crouched speed in the source (W2.R6)
    const w = new Walker(plain);
    w.place(0, 0, 0);
    expect(w.crouched).toBe(false);
    w.setCrouch(true);
    expect(w.crouched).toBe(true);
    expect(w.eye()).toEqual([0, EYE_HEIGHT * CROUCH_EYE_PLACEHOLDER, 0]);
    expect(w.eye()[1]).toBeCloseTo(10, 1);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 120; i++) w.tick(FORWARD);
    const before = w.state.x;
    w.tick(FORWARD);
    expect(w.state.x - before).toBeCloseTo(WALK_SPEED * CROUCH_SPEED_PLACEHOLDER * TICK, 3);
    w.setCrouch(false);                                              // standing again: the eye and the run come back
    expect(w.eye()[1]).toBe(EYE_HEIGHT);
    for (let i = 0; i < 120; i++) w.tick(FORWARD);
    const stood = w.state.x;
    w.tick(FORWARD);
    expect(w.state.x - stood).toBeCloseTo(WALK_SPEED * TICK, 3);
  });
});

describe('the jump (W2.3a; a placeholder impulse until W2.3b)', () => {
  const plain = world([floor(-200, -200, 200, 200, 0)]);

  it('pins a placeholder: with no disc table a standing jump peaks at 10 and lands at its impulse, 0.583 s later', () => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    expect(w.jump()).toBe(true);
    expect(w.airborne).toBe(true);
    expect(w.state.vy).toBe(JUMP_PLACEHOLDER);
    expect(w.jump()).toBe(false);                                   // no second jump in the air
    let apex = 0;
    const ticks = tickUntil(w, STILL, () => { apex = Math.max(apex, w.state.y); return !w.airborne; }, 120);
    // Sampled at the ticks: under the apex by at most half a tick's fall, g (TICK / 2)^2 / 2 = 0.0082.
    expect(MIN_JUMP_HEIGHT_PLACEHOLDER - apex).toBeGreaterThanOrEqual(0);
    expect(MIN_JUMP_HEIGHT_PLACEHOLDER - apex).toBeLessThanOrEqual(0.5 * 235 * (TICK / 2) ** 2 + 1e-9);
    expect(ticks).toBe(36);                                          // 0.5835 s is inside the 36th tick
    expect(w.state.y).toBe(0);
    expect(w.landing!.airTime).toBeCloseTo((2 * JUMP_PLACEHOLDER) / SEAL_TUNING_DEFAULTS.gravity, 9);
    expect(w.landing!.speed).toBeCloseTo(JUMP_PLACEHOLDER, 6);
    expect(w.landing!.kind).toBe('hard');
    expect(w.jump()).toBe(true);                                    // down again, it can jump again
  });

  it('keeps the run through the air, stands up to jump from the crouch, and has no footing to jump from a slide', () => {
    const w = new Walker(plain);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    const vx = w.state.vx;
    w.jump();
    const x0 = w.state.x;
    for (let i = 0; i < 30; i++) w.tick(STILL);                      // the keys let go in the air change nothing
    expect(w.airborne).toBe(true);
    expect(w.state.vx).toBe(vx);
    expect(w.state.x - x0).toBeCloseTo(vx * 30 * TICK, 9);
    const c = new Walker(plain);
    c.place(0, 0, 0);
    c.setCrouch(true);
    expect(c.jump()).toBe(true);
    expect(c.crouched).toBe(false);
    const top = 30 + 30 / Math.tan((51 * Math.PI) / 180);
    const steep = new Walker(world([floor(-200, -200, 30, 200, 0), ramp(30, 0, top, 30), floor(top, -200, 200, 200, 30)]));
    steep.place((30 + top) / 2, 40, 0);
    expect(steep.sliding).toBe(true);
    expect(steep.jump()).toBe(false);
  });

  it('pins a placeholder: a running jump clears the face of a 9-unit crate and lands on its top', () => {
    // The face is a wall until the feet are 2.5 up (the column's foot at step_height 6.5); jumped 13 short of it
    // at the run's 40, the feet are 9.9 up as they cross it and come down on the top.
    const crate = world([floor(-200, -200, 200, 200, 0), floor(50, -50, 100, 50, 9), wallX(50, -50, 50, 0, 9)]);
    const w = new Walker(crate);
    w.place(0, 0, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(w.state.x).toBeLessThan(50 - BODY_RADIUS - 5);
    w.jump();
    tickUntil(w, FORWARD, () => !w.airborne, 120);
    expect(w.state.y).toBe(9);
    expect(w.state.x).toBeGreaterThan(50);
  });

  it('runs on the table it is given: the disc\'s min_jump_height is the apex, its gravity the fall', () => {
    const t = sealTuning({ min_jump_height: 16, gravity: 100 });     // made-up numbers, not the file's
    const w = new Walker(plain, t);
    expect(w.tuning).toBe(t);
    w.place(0, 0, 0);
    w.jump();
    let apex = 0;
    tickUntil(w, STILL, () => { apex = Math.max(apex, w.state.y); return !w.airborne; }, 240);
    expect(apex).toBeCloseTo(16, 1);
    expect(w.landing!.airTime).toBeCloseTo((2 * Math.sqrt(2 * 100 * 16)) / 100, 9);
    // A table set on a mover already standing takes effect at its next jump.
    const v = new Walker(plain);
    v.place(0, 0, 0);
    v.setTuning(t);
    v.jump();
    expect(v.state.vy).toBeCloseTo(Math.sqrt(2 * 100 * 16), 12);
  });
});

describe('gravity and the fall (W2.3a; research 17 section 8: gravity 235, ground_touch_distance 8)', () => {
  const BACK: WalkInput = { forward: -1, right: 0, boost: false };

  it('walks off a 42-unit deck and falls at 235: 0.598 s in the air, meeting the floor at 140.5, a harder landing', () => {
    // Research 24 section 7.4: stepping off a 42-unit deck is a fall in the game. The sprint 1 mover refused it
    // (MAX_DROP 20, the conservative reading); the table's gravity and ground_touch_distance replace the refusal.
    const deck = world([floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 100, 42), wallX(30, -100, 100, 0, 42)]);
    const w = new Walker(deck);
    expect(w.place(0, 60, 0)).toBe(true);
    expect([w.state.y, w.airborne, w.landing]).toEqual([42, false, null]);
    w.state.yaw = facing(0, 0, 1, 0);
    tickUntil(w, FORWARD, () => w.airborne, 180);
    expect(w.airborne).toBe(true);                                  // off the floor where the floor ends
    expect(w.state.x).toBeGreaterThan(30);
    expect(w.state.x).toBeLessThan(31);
    expect(w.landing).toBeNull();
    let lowest = Infinity;
    const air = tickUntil(w, FORWARD, () => { lowest = Math.min(lowest, w.state.y); return !w.airborne; }, 120);
    expect(air).toBeGreaterThanOrEqual(35);
    expect(air).toBeLessThanOrEqual(36);                            // 0.598 s is inside the 36th tick after take-off
    expect(w.state.y).toBe(0);
    expect(lowest).toBeGreaterThanOrEqual(0);                       // never under the floor it lands on
    expect(w.landing!.airTime).toBeCloseTo(Math.sqrt((2 * 42) / SEAL_TUNING_DEFAULTS.gravity), 9);
    expect(w.landing!.airTime).toBeCloseTo(0.598, 3);
    expect(w.landing!.speed).toBeCloseTo(Math.sqrt(2 * SEAL_TUNING_DEFAULTS.gravity * 42), 6);
    expect(w.landing!.speed).toBeCloseTo(140.5, 1);
    expect(w.landing!.kind).toBe('harder');                         // over land_hard_fall_rate 115
    expect(w.state.vy).toBe(0);
    // From the ground beyond it, the deck's side is a wall at the body's height.
    const below = new Walker(deck);
    below.place(80, 10, 0);
    below.state.yaw = facing(80, 0, 0, 0);
    for (let i = 0; i < 180; i++) below.tick(FORWARD);
    expect(below.state.x).toBeCloseTo(30 + BODY_RADIUS, 6);
    expect(below.state.y).toBe(0);
    expect(below.airborne).toBe(false);
  });

  it('a floor within ground_touch_distance 8 under the feet holds them: 7.9 and 8 are walked down, 8.1 is a fall', () => {
    const down = (h: number): { y: number; flew: boolean; landing: Walker['landing'] } => {
      const w = new Walker(world([floor(-200, -200, 200, 200, 0), floor(-20, -20, 20, 20, h)]));
      w.place(0, h + 5, 0);
      w.state.yaw = facing(0, 0, 1, 0);
      let flew = false;
      for (let i = 0; i < 90; i++) { w.tick(FORWARD); flew ||= w.airborne; }
      return { y: w.state.y, flew, landing: w.landing };
    };
    expect(SEAL_TUNING_DEFAULTS.ground_touch_distance).toBe(8);
    expect(down(7.9)).toEqual({ y: 0, flew: false, landing: null });
    expect(down(8)).toEqual({ y: 0, flew: false, landing: null });
    const fell = down(8.1);
    expect(fell.flew).toBe(true);
    expect(fell.y).toBe(0);
    expect(fell.landing!.speed).toBeCloseTo(Math.sqrt(2 * 235 * Math.fround(8.1)), 6);
    expect(fell.landing!.kind).toBe('hard');                         // 61.7: over land_fall_rate 40, under 115
  });

  it('a 13-unit crate top is a fall now, and lands hard at 78.2', () => {
    const crate = world([floor(-200, -200, 200, 200, 0), floor(-20, -20, 20, 20, 13)]);
    const w = new Walker(crate);
    w.place(0, 20, 0);
    expect(w.state.y).toBe(13);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 90; i++) w.tick(FORWARD);
    expect(w.state.x).toBeGreaterThan(30);
    expect(w.state.y).toBe(0);
    expect(w.landing!.speed).toBeCloseTo(Math.sqrt(2 * 235 * 13), 6);
    expect(w.landing!.kind).toBe('hard');
  });

  it('has no air control: the keys do not steer a falling mover (the reading; the decomp settles it)', () => {
    const deck = world([floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 100, 42)]);
    const w = new Walker(deck);
    w.place(0, 60, 0);
    w.state.yaw = facing(0, 0, 1, 0);
    tickUntil(w, FORWARD, () => w.airborne, 180);
    const [vx, vz, x0] = [w.state.vx, w.state.vz, w.state.x];
    expect(vx).toBeGreaterThan(WALK_SPEED * 0.99);
    w.state.yaw = facing(0, 0, 0, 1);                               // turned to face +z and pulling back
    for (let i = 0; i < 12; i++) w.tick(BACK);
    expect(w.airborne).toBe(true);
    expect([w.state.vx, w.state.vz]).toEqual([vx, vz]);
    expect(w.state.x - x0).toBeCloseTo(vx * 12 * TICK, 9);
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

/** The floors the probe finds under (x, z), low to high. */
const probeFloors = (w: Walker, x: number, z: number): number[] => probeGround(w.grid, x, z).map((h) => h.y).sort((a, b) => a - b);

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
    expect(w.airborne).toBe(false);
  });

  it('the walkway deck is railed: walked north at the walkway column, the railing stops the feet on 142 (research 24 section 4.2)', async () => {
    // Research 24 section 7.4 names the drop off the deck (142 over the 100 floor at the walkway column x 705-735,
    // z 975-1000) as a fall the game would take. The hull rails the deck on both long sides (rmp1: z 975 for x
    // 704.3-760, z 999.3-1000 for x 680-760, y 142-155), inside the body's column: A's 3c trail stopped against the
    // north one at z 994-995 (research 24 section 4.2). So the walkway column is not walked off; the fall is taken
    // off an open edge below.
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const w = new Walker(groundGrid(map.ground!));
    expect(w.place(720, 142 + EYE_HEIGHT, 987)).toBe(true);
    expect(w.state.y).toBe(142);
    expect(probeFloors(w, 720, 987)).toEqual([100, 142]);            // the two-floor column (W1.4 test c)
    w.state.yaw = facing(720, 987, 720, 1100);
    for (let i = 0; i < 180; i++) { w.tick(FORWARD); expect(w.airborne).toBe(false); }
    expect(w.state.z).toBeCloseTo(999.3 - BODY_RADIUS, 1);
    expect(w.state.y).toBe(142);
    w.state.yaw = facing(720, 987, 720, 900);                         // and south, the other railing
    for (let i = 0; i < 180; i++) { w.tick(FORWARD); expect(w.airborne).toBe(false); }
    expect(w.state.z).toBeCloseTo(975.7 + BODY_RADIUS, 1);
    expect(w.state.y).toBe(142);
  });

  it('walks off the pipeworks platform\'s open edge and falls 40 onto the 100 floor, landing harder at 137.1', async () => {
    // pipeworks #863: a floor at y 140 over x 520-544.5, z 720-830, whose west edge at x 520 has no wall in the
    // body's column (the face under it, y 100-140, is below the feet); beyond it deckv_28 at y 100.
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const w = new Walker(groundGrid(map.ground!));
    expect(w.place(532, 150, 775)).toBe(true);
    expect(w.state.y).toBe(140);
    w.state.yaw = facing(532, 775, 400, 775);
    tickUntil(w, FORWARD, () => w.airborne, 120);
    expect(w.airborne).toBe(true);
    expect(w.state.x).toBeLessThan(520);
    expect(w.state.x).toBeGreaterThan(519);
    tickUntil(w, FORWARD, () => !w.airborne, 120);
    expect(w.airborne).toBe(false);
    expect(w.state.y).toBe(100);
    expect(w.landing!.airTime).toBeCloseTo(Math.sqrt((2 * 40) / 235), 6);
    expect(w.landing!.speed).toBeCloseTo(Math.sqrt(2 * 235 * 40), 4);
    expect(w.landing!.kind).toBe('harder');
    expect(w.state.x).toBeLessThan(520 - 20);                         // carried on at the run's 40 through the fall
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

  it('C toggles the crouch in walk mode: the eye drops to the placeholder, and the hook sees the stance', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    expect(mode.mover()).toBeNull();                                 // flying: no mover to report
    key('KeyC');                                                     // and C does nothing in fly mode
    expect(mode.mover()).toBeNull();
    mode.setMode('walk');
    expect(mode.mover()).toEqual({ airborne: false, sliding: false, crouched: false, landing: null });
    key('KeyC');
    expect(mode.mover()!.crouched).toBe(true);
    expect(fly.pose().y).toBeCloseTo(EYE_HEIGHT * CROUCH_EYE_PLACEHOLDER, 9);
    key('KeyC', 'keydown', { repeat: true });                        // a held C does not flicker the stance
    key('KeyC', 'keydown', { ctrlKey: true });                       // nothing on Ctrl
    expect(mode.mover()!.crouched).toBe(true);
    key('KeyC');
    expect(mode.mover()!.crouched).toBe(false);
    expect(fly.pose().y).toBeCloseTo(EYE_HEIGHT, 9);
    expect(mode.crouch(true)).toBe(true);                            // the hook's way in
    expect(mode.mover()!.crouched).toBe(true);
  });

  it('Space jumps in walk mode and the camera rides the eye up; in fly mode Space is still up', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    mode.setMode('walk');
    key('Space');
    expect(mode.mover()).toMatchObject({ airborne: true, landing: null });
    let highest = 0;
    for (let i = 0; i < 20; i++) { fly.update(1 / 60); mode.frame(1 / 60); highest = Math.max(highest, fly.pose().y); }
    expect(highest).toBeGreaterThan(EYE_HEIGHT + 9);
    key('Space', 'keyup');
    key('Space', 'keydown', { repeat: true });                       // a held Space does not jump again
    for (let i = 0; i < 60; i++) { fly.update(1 / 60); mode.frame(1 / 60); }
    expect(mode.mover()).toMatchObject({ airborne: false, landing: { kind: 'hard' } });
    expect(fly.pose().y).toBeCloseTo(EYE_HEIGHT, 9);
    key('Space', 'keydown', { ctrlKey: true });                      // nothing on Ctrl
    expect(mode.mover()!.airborne).toBe(false);
    key('Space', 'keyup');
    expect(mode.jump()).toBe(true);                                   // the hook's way in
    mode.setMode('fly');
    expect(mode.jump()).toBe(false);
    const y0 = fly.pose().y;
    key('Space');
    for (let i = 0; i < 30; i++) { fly.update(1 / 30); mode.frame(1 / 30); }
    key('Space', 'keyup');
    expect(fly.pose().y).toBeGreaterThan(y0 + 1);                    // flying up, as before
    expect(mode.mover()).toBeNull();
  });

  it('runs on the defaults until the disc\'s table arrives, then on it, and says which (stats().tuning)', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 150, y: 40, z: 150, yaw: 0, pitch: 0 });
    expect(mode.tuningSource()).toBe('defaults');
    mode.setMode('walk');
    mode.setTuning({ min_jump_height: 16 });                           // a made-up disc table
    expect(mode.tuningSource()).toBe('disc');
    mode.jump();
    let highest = 0;
    for (let i = 0; i < 40; i++) { mode.frame(1 / 60); highest = Math.max(highest, mode.feet()![1]); }
    expect(highest).toBeGreaterThan(15.9);
    mode.setGround(GROUND, [150, 0, 150]);                             // a new map keeps the table
    expect(mode.tuningSource()).toBe('disc');
    mode.setTuning(null);                                             // no READERC.ZAR on the source: the defaults
    expect(mode.tuningSource()).toBe('defaults');
    mode.setTuning({});
    expect(mode.tuningSource()).toBe('defaults');
  });
});
