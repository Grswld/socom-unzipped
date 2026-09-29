import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mesh, Vector3 } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, DEFAULT_RIFLE, UNITS_PER_METRE, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { loadMap } from '../src/loadMap';
import { ammoText, DECAL_OFFSET, Fire, MAX_DECALS, RELOAD_SECONDS, type FireAim, type FireEvent, type FireSource } from '../src/fire';
import { packGround, WalkMode } from '../src/walk';
import { INIT_AIM_PITCH } from '../src/playerCamera';

/**
 * The shot (web sprint 2, W2.5): a hitscan segment from the aim origin along the aim through `segmentHit`, at the
 * M4A1's `FireWait` (`ZWEAPON.ZAR/zweapon.rdr`), a mark on the polygon it meets, the magazine counting down.
 */

type V3 = [number, number, number];
const quad = (points: number[]): WorldPoly =>
  ({ modelName: 'worldmodel', path: 'worldmodel/q', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype: 0, points: Float32Array.from(points) });
/** A wall across x at depth `z` (the shooter at z 0 looks down -z), x -50..50, y 0..50. */
const wallAt = (z: number): WorldPoly => quad([-50, 0, z, 50, 0, z, 50, 50, z, -50, 50, z]);
/** A wall leaning back 30 degrees from the vertical, its foot at z = -40: a plane that is not an axis. */
const leaning = (): WorldPoly => {
  const t = Math.tan(Math.PI / 6);
  return quad([-50, 0, -40, 50, 0, -40, 50, 50, -40 - 50 * t, -50, 50, -40 - 50 * t]);
};

function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

/** A shooter at (0, 20, 0) looking along `dir` (the aim point 1000 out), over `grid`; `aim` null is "not walking". */
function rig(grid: Grid | null, dir: V3 = [0, 0, -1], rifle = DEFAULT_RIFLE): { fire: Fire; source: { on: boolean } } {
  const source = { on: true };
  const eye: V3 = [0, 20, 0];
  const aim = (): FireAim | null => (source.on ? { eye, far: [eye[0] + dir[0] * 1000, eye[1] + dir[1] * 1000, eye[2] + dir[2] * 1000] } : null);
  // A fixed "random" size: the decal's side is decals.rdr's MIN_SIZE + 0.5 x (MAX_SIZE - MIN_SIZE).
  return { fire: new Fire({ grid: () => grid, aim }, rifle, undefined, () => 0.5), source };
}

describe('the shot on a synthetic hull (W2.5)', () => {
  it('hits the first polygon along the aim, marks it, and counts the round', () => {
    const { fire } = rig(world([wallAt(-60), wallAt(-30)]));
    const shot = fire.shoot()!;
    expect(shot).not.toBeNull();
    expect(shot.hit!.distance).toBeCloseTo(30, 6);
    expect(shot.hit!.point).toEqual([0, 20, -30]);
    const s = fire.state();
    expect(s.shots).toBe(1);
    expect(s.magazine).toEqual({ rounds: 29, capacity: 30, spare: 2, reloading: false });
    expect(s.decals).toBe(1);
    expect(s.lastHit!.distance).toBeCloseTo(30, 6);
  });

  it('a miss fires -- the round is spent, the tracer drawn to the range -- but marks nothing', () => {
    const { fire } = rig(world([wallAt(-30)]), [0, 0, 1]);
    const shot = fire.shoot()!;
    expect(shot.hit).toBeNull();
    // Maximum_Range is metres; the world is 10 units a metre (DAT_003dfe10, research 84 section 2).
    expect(new Vector3(...shot.to).distanceTo(new Vector3(...shot.from))).toBeCloseTo(DEFAULT_RIFLE.maximumRange * UNITS_PER_METRE, 6);
    expect(fire.state()).toMatchObject({ shots: 1, decals: 0, lastHit: null });
    expect(fire.state().magazine.rounds).toBe(29);
  });

  it('fires nothing when not walking (no aim) or with no hull', () => {
    const { fire, source } = rig(world([wallAt(-30)]));
    source.on = false;
    expect(fire.shoot()).toBeNull();
    expect(fire.pull()).toBeNull();
    fire.update(1);
    expect(fire.state().shots).toBe(0);
    expect(rig(null).fire.shoot()).toBeNull();
  });

  it('the mark lies on the polygon\'s plane, 0.05 off it toward the shooter, and faces the polygon\'s normal', () => {
    const wall = leaning();
    const { fire } = rig(world([wall]), [0.2, -0.1, -1]);
    const shot = fire.shoot()!;
    const hit = shot.hit!;
    const mark = fire.decalMeshes()[0]!;
    // The plane's normal, facing the shooter (+z, tilted up by the lean).
    const n = new Vector3(0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6));
    expect(new Vector3(...hit.normal).distanceTo(n)).toBeLessThan(1e-6);
    // The quad's own +z (its face) is the normal; its four corners are 0.05 off the plane.
    mark.updateMatrixWorld();
    const face = new Vector3(0, 0, 1).applyQuaternion(mark.quaternion);
    expect(face.distanceTo(n)).toBeLessThan(1e-6);
    const onWall = new Vector3(...hit.point);
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      const corner = new Vector3(x, y, 0).applyMatrix4(mark.matrixWorld);
      expect(corner.clone().sub(onWall).dot(n)).toBeCloseTo(DECAL_OFFSET, 6);
    }
    // decals.rdr BULLET_MARK_SMALL STONE: 1 to 1.8 units; the fixed "random" 0.5 gives 1.4.
    expect(mark.scale.x).toBeCloseTo(1.4, 9);
    expect(mark.scale.y).toBeCloseTo(1.4, 9);
  });

  it('keeps 150 marks (decals.rdr TEMP_DECAL_POOL BASE) and recycles the oldest', () => {
    const { fire } = rig(world([wallAt(-30)]), [0, 0, -1], { ...DEFAULT_RIFLE, magazine: 200 });
    for (let i = 0; i < 160; i++) { expect(fire.shoot()).not.toBeNull(); fire.update(DEFAULT_RIFLE.fireWait); }
    expect(MAX_DECALS).toBe(150);
    expect(fire.state().decals).toBe(150);
    expect(fire.decalMeshes().filter((m) => m.visible)).toHaveLength(150);
  });

  it('draws the tracer for one frame', () => {
    const { fire } = rig(world([wallAt(-30)]));
    expect(fire.tracerVisible()).toBe(false);
    fire.shoot();
    expect(fire.tracerVisible()).toBe(true);
    fire.update(1 / 60);                  // the frame the shot is drawn in
    expect(fire.tracerVisible()).toBe(true);
    fire.update(1 / 60);                  // the next one
    expect(fire.tracerVisible()).toBe(false);
  });
});

describe('the rate, the magazine and the reload (W2.5)', () => {
  it('fires at FireWait: n shots over t seconds held is at most floor(t x rate) + 1, and at least floor(t x rate)', () => {
    const rate = 1 / DEFAULT_RIFLE.fireWait;               // 8.33 a second, 500 a minute
    for (const [t, frame] of [[1, 1 / 60], [0.5, 1 / 144], [2.4, 1 / 30], [3, 0.05]] as const) {
      const { fire } = rig(world([wallAt(-30)]), [0, 0, -1], { ...DEFAULT_RIFLE, magazine: 1000 });
      fire.pull();
      for (let s = 0; s < Math.round(t / frame); s++) fire.update(frame);
      const n = fire.state().shots;
      expect(n).toBeLessThanOrEqual(Math.floor(t * rate + 1e-9) + 1);
      expect(n).toBeGreaterThanOrEqual(Math.floor(t * rate + 1e-9));
    }
  });

  it('clicks faster than the rate are held back; a release keeps the wait', () => {
    const { fire } = rig(world([wallAt(-30)]));
    expect(fire.pull()).not.toBeNull();
    fire.release();
    fire.update(0.05);
    expect(fire.pull()).toBeNull();          // 0.05 s after a shot: FireWait is 0.12
    fire.release();
    fire.update(0.08);
    expect(fire.pull()).not.toBeNull();      // 0.13 s after it
    expect(fire.state().shots).toBe(2);
  });

  it('empties the magazine, refuses to fire, reloads over RELOAD_SECONDS from a spare, and runs out of spares', () => {
    const { fire } = rig(world([wallAt(-30)]));
    expect(RELOAD_SECONDS).toBe(2);
    for (let i = 0; i < 30; i++) { expect(fire.shoot()).not.toBeNull(); fire.update(0.2); }
    expect(fire.state().magazine).toEqual({ rounds: 0, capacity: 30, spare: 2, reloading: false });
    expect(fire.shoot()).toBeNull();
    expect(fire.reload()).toBe(true);
    expect(fire.reload()).toBe(false);                       // already reloading
    expect(fire.state().magazine.reloading).toBe(true);
    fire.update(1.9);
    expect(fire.shoot()).toBeNull();                         // not while reloading
    fire.update(0.2);
    expect(fire.state().magazine).toEqual({ rounds: 30, capacity: 30, spare: 1, reloading: false });
    expect(fire.reload()).toBe(false);                       // a full magazine
    fire.shoot(); fire.update(0.2);
    expect(fire.reload()).toBe(true);
    fire.update(RELOAD_SECONDS);
    expect(fire.state().magazine).toEqual({ rounds: 30, capacity: 30, spare: 0, reloading: false });
    fire.shoot(); fire.update(0.2);
    expect(fire.reload()).toBe(false);                       // no spare left
  });

  it('R reloads while walking; Ctrl+R, a repeat and R in fly mode are left alone', () => {
    const target = new EventTarget();
    const { fire, source } = rig(world([wallAt(-30)]));
    fire.bindKey(target);
    fire.shoot(); fire.update(0.2);
    const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent('keydown', { code: 'KeyR', ...init });
    target.dispatchEvent(key({ ctrlKey: true }));
    target.dispatchEvent(key({ repeat: true }));
    source.on = false;
    target.dispatchEvent(key({}));
    expect(fire.state().magazine.reloading).toBe(false);
    source.on = true;
    target.dispatchEvent(key({}));
    expect(fire.state().magazine.reloading).toBe(true);
    fire.unbindKey();
  });

  it('takes its gun: the direction of each round, the rounds a pull and the wait of the mode (research 84)', () => {
    const { fire } = rig(world([wallAt(-30)]), [0, 0, -1], { ...DEFAULT_RIFLE, magazine: 100 });
    const calls: string[] = [];
    let perPull = 3;
    fire.setGun({
      trigger: (down) => calls.push(down ? 'down' : 'up'),
      roundsPerPull: () => perPull,
      interval: (w) => w * 0.8,
      round: (dir) => { calls.push('round'); return [dir[0] + 0.1, dir[1], dir[2]]; },
    });
    const shot = fire.pull()!;
    // The round went off the aim by the gun's tangent: 0.1 right per unit ahead, hitting the wall 30 ahead at x 3.
    expect(shot.hit!.point[0]).toBeCloseTo(3, 6);
    // Burst: three rounds a pull at 0.8 x FireWait, then nothing until the trigger is let go.
    for (let i = 0; i < 20; i++) fire.update(DEFAULT_RIFLE.fireWait * 0.8);
    expect(fire.state().shots).toBe(3);
    fire.release();
    fire.update(1);
    expect(fire.pull()).not.toBeNull();
    expect(calls.filter((c) => c === 'round')).toHaveLength(4);
    expect(calls.filter((c) => c === 'down')).toHaveLength(2);
    perPull = 1;
    fire.release();
    fire.update(1);
    fire.pull();
    for (let i = 0; i < 20; i++) fire.update(DEFAULT_RIFLE.fireWait);
    expect(fire.state().shots).toBe(5);                    // single: one a pull, held or not
  });
});

describe('penetration (research 84 section 10: HandleIntersections 0x3c9b70, FUN_003c8920)', () => {
  const wall = (z: number, material: number): WorldPoly => ({ ...wallAt(z), material });
  // Materials by byte: 30 glass (0.99), 26 metal thin (0.35), 25 stone (0), 29 an action volume (1).
  const PEN: Record<number, number> = { 30: 0.99, 26: 0.35, 25: 0, 29: 1 };
  it('passes over a PENETRATION 1 volume, goes through glass into the wall behind, marks both', () => {
    const { fire } = rig(world([wall(-10, 29), wall(-30, 30), wall(-60, 25)]));
    fire.setPenetration((m) => PEN[m ?? 0] ?? 0);
    const shot = fire.shoot()!;
    expect(shot.hit!.distance).toBeCloseTo(60, 6);                // stopped by the stone
    expect(shot.through!.map((t) => t.distance)).toEqual([30]);  // through the glass; the volume not struck
    expect(fire.state().decals).toBe(2);
  });

  it('a thin metal sheet leaves 0.35 x 1.3 of the range: a wall past it is out of reach', () => {
    // M4A1: 1000 m = 10,000 units; after the sheet at 30: 10,000 x 1.3 x 0.35 = 4,550 units.
    const { fire } = rig(world([wall(-30, 26), wall(-4000, 25)]));
    fire.setPenetration((m) => PEN[m ?? 0] ?? 0);
    expect(fire.shoot()!.hit!.distance).toBeCloseTo(4000, 3);
    const far = rig(world([wall(-30, 26), wall(-4600, 25)]));
    far.fire.setPenetration((m) => PEN[m ?? 0] ?? 0);
    const shot = far.fire.shoot()!;
    expect(shot.hit).toBeNull();                                  // the round's range ran out before the second wall
    expect(shot.through!.map((t) => t.distance)).toEqual([30]);
  });

  it('stone stops it at once; without a table every surface stops it', () => {
    const { fire } = rig(world([wall(-30, 25), wall(-60, 25)]));
    fire.setPenetration((m) => PEN[m ?? 0] ?? 0);
    expect(fire.shoot()!.hit!.distance).toBeCloseTo(30, 6);
    const plain = rig(world([wall(-30, 30), wall(-60, 25)]));
    expect(plain.fire.shoot()!.hit!.distance).toBeCloseTo(30, 6);
  });
});

describe('the walk hands the shot its hull and its aim (W2.5)', () => {
  it('none in fly mode; walking, the eye and the aim point, and the round lands on the wall ahead along the look', () => {
    const floor = quad([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]);
    const polys = [{ ...floor, ditype: 3 }, wallAt(-50)];
    const ground = packGround(
      { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
      polys, polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 })),
    );
    const fly = new FlyCamera(document.createElement('canvas'));
    const walk = new WalkMode(fly);
    walk.setGround(ground, [0, 0, 0]);
    const fire = new Fire({ grid: () => walk.grid(), aim: () => walk.fireAim() });
    expect(walk.grid()).toBeNull();
    expect(walk.fireAim()).toBeNull();
    expect(fire.shoot()).toBeNull();
    fly.setPose({ x: 0, y: 15.4, z: 0, yaw: 0, pitch: 0 });
    expect(walk.setMode('walk')).toBe(true);
    walk.setCamera({ x: 0, y: 15.4, z: 0, yaw: 0, pitch: 0 });
    const aim = walk.fireAim()!;
    // Standing at pitch 0 (W2.1): the eye 21.484 up and 28.75 behind, the aim 1000 ahead of the target, level.
    expect(aim.eye[1]).toBeCloseTo(21.484, 3);
    expect(aim.eye[2]).toBeCloseTo(28.75, 3);
    expect(aim.far[1]).toBeCloseTo(21.484, 3);
    const shot = fire.shoot()!;
    expect(shot.hit!.point[2]).toBeCloseTo(-50, 6);
    expect(shot.hit!.distance).toBeCloseTo(78.75, 3);
    expect(shot.hit!.normal).toEqual([0, 0, 1]);          // faces the shooter
  });
});

describe('the ammo box (W2.5)', () => {
  it('reads as the box on the console frame: rounds/capacity, then the spare magazines', () => {
    expect(ammoText({ rounds: 30, capacity: 30, spare: 2, reloading: false })).toBe('30/30 · 2 MAGS');
    expect(ammoText({ rounds: 7, capacity: 30, spare: 1, reloading: false })).toBe('7/30 · 1 MAG');
    expect(ammoText({ rounds: 0, capacity: 30, spare: 1, reloading: true })).toBe('0/30 · 1 MAG · RELOADING');
    expect(ammoText(rig(null).fire.state().magazine)).toBe('30/30 · 2 MAGS');
  });
});

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)(`the shot at Frostfire's spawn A${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('standing at A facing west at the rest pitch, the round meets the side of container_blue01 at the recorded distance', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const canvas = document.createElement('canvas');
    const fly = new FlyCamera(canvas);
    const walk = new WalkMode(fly);
    walk.setGround(map.ground, null);
    fly.setPose({ x: SPAWN_A[0], y: SPAWN_A[1] + 15.4, z: SPAWN_A[2], yaw: FACING.yaw, pitch: FACING.pitch });
    expect(walk.setMode('walk')).toBe(true);
    walk.setCamera({ yaw: FACING.yaw, pitch: FACING.pitch });
    walk.walkFor(0.5, { forward: 0, right: 0, boost: false });
    const fire = new Fire({ grid: () => walk.grid(), aim: () => walk.fireAim() });
    const shot = fire.shoot()!;
    expect(shot.hit).not.toBeNull();
    expect(shot.hit!.distance).toBeCloseTo(FACING.distance, 2);
    expect(shot.hit!.normal[0]).toBeCloseTo(Math.cos(Math.PI / 18), 6);
    expect(shot.hit!.point.map((c) => Math.round(c * 100) / 100)).toEqual(FACING.point);
    expect(fire.state().decals).toBe(1);
    expect(fire.decalMeshes()[0]).toBeInstanceOf(Mesh);
  });
});

/** Spawn A's feet on Frostfire (KNOWN section 1), as `e2e/reticle.spec.ts` stands there. */
const SPAWN_A: V3 = [796, 100, 614];
/**
 * The look at A the fixture shoots along -- yaw 90 (toward -x), the rest pitch `init_aim_pitch` -- and where the round
 * lands, recorded 2026-09-28 off this hull: from the third-person eye (820.906, 125.709, 614) through the SEAL's
 * column onto `container_blue01`'s `climb` side, 12 units west of A (its normal 10 degrees off +x).
 */
const FACING = { yaw: 90, pitch: INIT_AIM_PITCH, distance: 37.379, point: [784, 119.75, 614] as V3 };

describe('WEAPON: the round leaves the rifle\'s muzzle, the events, the reload\'s clip, the kick', () => {
  /** A shooter's eye at (0, 20, 0) looking down -z; the muzzle 3 right, 5 down, 8 ahead (a shouldered rifle). */
  const source = (grid: Grid, extra: Partial<FireSource> = {}): FireSource => ({
    grid: () => grid,
    aim: () => ({ eye: [0, 20, 0], far: [0, 20, -1000] }),
    muzzle: () => [3, 15, -8],
    ...extra,
  });

  it('fires from the muzzle toward the point under the reticle: the round lands where the eye\'s ray meets the wall', () => {
    const fire = new Fire(source(world([wallAt(-60)])), DEFAULT_RIFLE, undefined, () => 0.5);
    const shot = fire.shoot()!;
    expect(shot.from).toEqual([3, 15, -8]);
    expect(shot.hit!.point.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 20, -60]);
    expect(shot.hit!.distance).toBeCloseTo(Math.hypot(3, 5, 52), 5);
  });

  it('meets what stands between the rifle and the aim point first', () => {
    // a low wall from y 0 to 18 at z -30: under the eye's line (y 20) but across the muzzle's (y 17.1 there)
    const low = quad([-50, 0, -30, 50, 0, -30, 50, 18, -30, -50, 18, -30]);
    const fire = new Fire(source(world([wallAt(-60), low])), DEFAULT_RIFLE, undefined, () => 0.5);
    const shot = fire.shoot()!;
    expect(shot.hit!.point[2]).toBeCloseTo(-30, 6);
    expect(shot.hit!.point[1]).toBeCloseTo(15 + 5 * 22 / 52, 5);
  });

  it('without a muzzle it is the eye\'s round, as before', () => {
    const fire = new Fire(source(world([wallAt(-60)]), { muzzle: () => null }), DEFAULT_RIFLE, undefined, () => 0.5);
    expect(fire.shoot()!.from).toEqual([0, 20, 0]);
  });

  it('tells its subscribers each round (the weapon, the fire point, the end) and each reload\'s start and end', () => {
    const events: FireEvent[] = [];
    const fire = new Fire(source(world([wallAt(-60)]), { reloadSeconds: () => 1.6 }), DEFAULT_RIFLE, undefined, () => 0.5);
    const off = fire.subscribe((e) => events.push(e));
    fire.shoot();
    expect(events[0]).toMatchObject({
      type: 'round', from: [3, 15, -8], hit: true, rounds: 29,
      weapon: { name: 'M4A1', id: 54, fireAnim: 'muzzle_m4', sounds: { close: '.M4A1', med: '.M4A1_M', far: '.M4A1_F', reload: '.M4A1_RLD' } },
    });
    expect(fire.reload()).toBe(true);
    expect(events[1]).toMatchObject({ type: 'reloadStart', seconds: 1.6 });      // the reload clip's playback
    fire.update(1.5);
    expect(events).toHaveLength(2);
    fire.update(0.2);
    expect(events[2]).toMatchObject({ type: 'reloadEnd', completed: true });
    expect(fire.state().magazine).toMatchObject({ rounds: 30, spare: 1 });
    fire.shoot(); fire.update(0.2); fire.reload();
    fire.reset();
    expect(events.at(-1)).toMatchObject({ type: 'reloadEnd', completed: false });
    off();
    fire.shoot();
    expect(events.at(-1)!.type).toBe('reloadEnd');
  });

  it('holds the trigger for the raise, and kicks the aim\'s pitch through the source', () => {
    let pitch = 0;
    const fire = new Fire(source(world([wallAt(-60)]), {
      look: () => ({ pitch, stance: 'stand' }), kickPitch: (r) => { pitch += r; },
    }), DEFAULT_RIFLE, undefined, () => 0);
    expect(fire.triggerHeld()).toBe(false);
    fire.pull();
    expect(fire.triggerHeld()).toBe(true);
    fire.release();
    for (let i = 0; i < 6; i++) fire.update(1 / 60);
    expect(pitch).toBeCloseTo(6 * DEFAULT_RIFLE.rifleKick.stand!.rate / 60, 9);   // rising at FireRifleKickRate
    for (let i = 0; i < 120; i++) fire.update(1 / 60);
    expect(pitch).toBeCloseTo(0, 9);                                                // and back to the rest
    expect(fire.state().kick.state).toBe(0);
  });
});
