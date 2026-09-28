import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { loadMap } from '../src/loadMap';
import {
  groundGrid, groundPolygons, packGround, Walker, WalkMode, BODY_RADIUS, EYE_HEIGHT, MAX_DROP, TICK, WALK_SPEED,
  type GroundData, type WalkInput,
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

  it('a step off a 42-unit deck stays on the deck; from below, the deck\'s face is a wall', () => {
    // The game's selection would take the floor 42 below (it rejects only a pick over the feet, research 23
    // section 1.1; the drop is a fall, research 24 section 7.4). The viewer does not model the fall: a floor more
    // than MAX_DROP under the feet refuses the step, the conservative reading.
    const deck = world([floor(-200, -200, 200, 200, 0), floor(-100, -100, 30, 100, 42), wallX(30, -100, 100, 0, 42)]);
    const w = new Walker(deck);
    expect(w.place(0, 60, 0)).toBe(true);
    expect(w.state.y).toBe(42);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 180; i++) w.tick(FORWARD);
    expect(w.state.y).toBe(42);
    expect(w.state.x).toBeLessThanOrEqual(30);
    expect(w.state.x).toBeGreaterThan(29);
    expect(MAX_DROP).toBe(20);
    // Diagonally into the edge, the step keeps its part along the edge rather than stopping dead.
    w.state.yaw = facing(0, 0, 1, 1);
    const z0 = w.state.z;
    for (let i = 0; i < 60; i++) w.tick(FORWARD);
    expect(w.state.y).toBe(42);
    expect(w.state.z - z0).toBeGreaterThan(10);
    // From the ground beyond it, the deck's side is a wall at the body's height.
    const below = new Walker(deck);
    below.place(80, 10, 0);
    below.state.yaw = facing(80, 0, 0, 0);
    for (let i = 0; i < 180; i++) below.tick(FORWARD);
    expect(below.state.x).toBeCloseTo(30 + BODY_RADIUS, 6);
    expect(below.state.y).toBe(0);
  });

  it('a drop within the window is walked: down a 13-unit crate top onto the floor', () => {
    const crate = world([floor(-200, -200, 200, 200, 0), floor(-20, -20, 20, 20, 13)]);
    const w = new Walker(crate);
    w.place(0, 20, 0);
    expect(w.state.y).toBe(13);
    w.state.yaw = facing(0, 0, 1, 0);
    for (let i = 0; i < 90; i++) w.tick(FORWARD);
    expect(w.state.x).toBeGreaterThan(30);
    expect(w.state.y).toBe(0);
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
});
