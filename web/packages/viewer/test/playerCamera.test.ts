import { afterEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, probeFloor, segmentHit, SEAL_TUNING, type CollisionOwner, type Grid, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { FlyCamera } from '../src/camera';
import { loadMap } from '../src/loadMap';
import { HEAD_HEIGHT } from '../src/stature';
import {
  aimPoint, firstPersonHeight, localCamera, lookHeight, pitchLimits, ramp, PlayerCamera,
  CAM_BACK, CAM_MARGIN, INIT_AIM_PITCH, type Vec3,
} from '../src/playerCamera';
import { groundGrid, packGround, rootY, WalkMode, EYE_HEIGHT, TICK } from '../src/walk';

/**
 * The game's third-person camera (web sprint 2, W2.1): `FUN_0029a950`'s target and eye, `FUN_00296f10`'s look line,
 * `FUN_0029bf70`'s pass, `FUN_0029bc90`'s placement (`playerCamera.ts`'s header). Synthetic worlds pin the rules
 * against research 17 section 1's console numbers; Frostfire's spawn A pins the whole on the disc's hull.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

function quad(points: number[], ditype: number, path: string): WorldPoly {
  return { modelName: 'worldmodel', path, region: 0, ditype, material: 25, ptcount: 4, cameratype: 0, points: Float32Array.from(points) };
}
const floor = (y: number): WorldPoly => quad([-200, y, -200, 200, y, -200, 200, y, 200, -200, y, 200], 3, 'worldmodel/floor');
/** A vertical wall across x at `z`, x0..x1, y0..y1. */
const wallZ = (z: number, x0: number, x1: number, y0 = 0, y1 = 60): WorldPoly => quad([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z], 2, 'worldmodel/wallz');
/** A vertical wall across z at `x`, z0..z1, y0..y1. */
const wallX = (x: number, z0: number, z1: number, y0 = 0, y1 = 60): WorldPoly => quad([x, y0, z0, x, y0, z1, x, y1, z1, x, y1, z0], 2, 'worldmodel/wallx');

function world(polys: WorldPoly[]): Grid {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}

const STAND = 11.484, CROUCH = 5.504;
/** The console's own root at spawn, research 17 section 1 (`walk.ts` keeps it to three places). */
const CONSOLE_ROOT = 5.50391;
const ORIGIN: Vec3 = [0, 0, 0];
const close = (a: readonly number[], b: readonly number[], digits = 3): void => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v, `component ${i}: ${a.join(', ')} against ${b.join(', ')}`).toBeCloseTo(b[i]!, digits));
};
/** Runs `ticks` camera ticks standing still at `feet`, facing `yaw`, at `pitch`, with `root`. */
function settle(cam: PlayerCamera, feet: Vec3, yaw: number, pitch: number, root: number, ticks = 1): void {
  for (let i = 0; i < ticks; i++) cam.tick(feet, yaw, pitch, root);
}

describe('FUN_0029a950: the ramp and the target (research 17 section 3)', () => {
  it('the ramp at rootY 5.504, 5.6, 2.169 and 0 is 9.874, 10.0, 5.5 and 10.0 (the no-root fallback)', () => {
    expect(ramp(5.504)).toBeCloseTo(9.874, 3);
    expect(ramp(5.6)).toBe(10);
    expect(ramp(2.169)).toBe(5.5);
    expect(ramp(0)).toBe(10);
    expect(ramp(11.484)).toBe(10);                                          // standing: saturated
  });

  it('the target is 15.378 over the feet crouched (the console\'s 15.3782) and 21.484 standing', () => {
    expect(lookHeight(CROUCH)).toBeCloseTo(15.378, 3);
    expect(lookHeight(STAND)).toBeCloseTo(21.484, 3);
    expect(rootY('stand')).toBe(STAND);
    expect(rootY('crouch')).toBe(CROUCH);
  });

  it('the rest pitch is dynamics.rdr\'s init_aim_pitch, -9.167 degrees (the console\'s actor+0x1070 quaternion)', () => {
    expect(SEAL_TUNING.initAimPitch).toBe(-9.167);
    expect(INIT_AIM_PITCH).toBe(-9.167);
  });

  it('at pitch 0 the goal is 28 behind the target, level (fStack_8 + 28.0)', () => {
    const local = localCamera(STAND, 0);
    close(local.target, [0, 21.484, 0]);
    close(local.eye, [0, 21.484, CAM_BACK]);
    expect(local.dist).toBeCloseTo(28, 9);
  });

  it('with the console\'s crouched spawn geometry it is the console\'s local eye (0, 19.483, 24.166) exactly: the pitch shortens it, not the pass', () => {
    // research 17 section 4.1 row #13: target local (0, 15.378, -1.274), eye local (0, 19.483, 24.166)
    const local = localCamera(CONSOLE_ROOT, INIT_AIM_PITCH);
    close(local.target, [0, 15.378, -1.2745]);             // -8 x 0.15931; research 17 prints -1.274
    close(local.eye, [0, 19.483, 24.166]);
    expect(local.dist).toBeCloseTo(25.770, 3);                              // 28 + |sin p| x (14 - 28)
  });
});

describe('the placed camera on open ground (FUN_0029bf70 with no hit, FUN_0029bc90)', () => {
  const open = world([floor(0)]);

  it('pitch 0, standing: the eye 28.75 behind the feet (the pass reaches 0.75 past the goal) and 21.484 up', () => {
    const cam = new PlayerCamera(open);
    settle(cam, ORIGIN, 0, 0, STAND);
    const v = cam.view(1);
    close(v.target, [0, 21.484, 0]);
    close(v.eye, [0, 21.484, 28 + CAM_MARGIN]);                              // yaw 0 faces -z: behind is +z
    close(v.far, [0, 21.484, -1000]);
    // Turned to face -x (yaw 90), the camera is behind on +x.
    settle(cam, ORIGIN, 90, 0, STAND);
    close(cam.view(1).eye, [28.75, 21.484, 0]);
  });

  it('crouched at the rest pitch it is the console\'s smoothed eye: 19.603 up and 24.906 behind (cam+0xd8)', () => {
    // research 17 section 1: player (939.4391, -145.8672, 857.0661), cam+0xd8 (939.439, -126.264, 832.160); the
    // console's view runs +z, ours at yaw 0 runs -z, so its -24.906 is our +24.906.
    const cam = new PlayerCamera(open);
    settle(cam, [10, 0, 20], 0, INIT_AIM_PITCH, CONSOLE_ROOT);
    const v = cam.view(1);
    close(v.eye, [10, 19.603, 20 + 24.906]);
    close(v.target, [10, 15.378, 20 - 1.2745]);
    expect(cam.distance()).toBeCloseTo(26.51936, 3);                          // DAT_003de268 on the dump
  });

  it('standing at the rest pitch: 25.709 up, 24.906 behind', () => {
    const cam = new PlayerCamera(open);
    settle(cam, ORIGIN, 0, INIT_AIM_PITCH, STAND);
    close(cam.view(1).eye, [0, 25.709, 24.906]);
  });

  it('the view line runs from the eye through the target to the far point, so the reticle sits on the frame\'s centre', () => {
    const cam = new PlayerCamera(open);
    settle(cam, ORIGIN, 30, INIT_AIM_PITCH, STAND);
    const v = cam.view(1);
    const three = new PerspectiveCamera(49, 640 / 448, 4, 4000);
    three.position.set(...v.eye);
    three.lookAt(...v.target);
    three.updateMatrixWorld(true);
    const [nx, ny] = aimPoint(three, v.far);
    expect(nx).toBeCloseTo(0.5, 6);
    expect(ny).toBeCloseTo(0.5, 6);
  });

  it('draws between ticks: view(alpha) is the eye between the last two ticks', () => {
    const cam = new PlayerCamera(open);
    settle(cam, ORIGIN, 0, 0, STAND);
    settle(cam, [0, 0, -10], 0, 0, STAND);
    close(cam.view(0).eye, [0, 21.484, 28.75]);
    close(cam.view(0.5).eye, [0, 21.484, 23.75]);
    close(cam.view(1).eye, [0, 21.484, 18.75]);
  });

  it('a stance change moves the root over 0.2 s, not in one frame (the clips\' blend-in) [estimate]', () => {
    const cam = new PlayerCamera(open);
    settle(cam, ORIGIN, 0, 0, STAND);
    settle(cam, ORIGIN, 0, 0, CROUCH);
    expect(cam.rootY()).toBeLessThan(STAND);
    expect(cam.rootY()).toBeGreaterThan(CROUCH);
    settle(cam, ORIGIN, 0, 0, CROUCH, 12);
    expect(cam.rootY()).toBe(CROUCH);
  });
});

describe('the pass against the hull (FUN_0029bf70)', () => {
  it('a wall 10 behind the actor pulls the eye in to 0.75 short of it, never through', () => {
    const cam = new PlayerCamera(world([floor(0), wallZ(10, -50, 50)]));
    for (let i = 0; i < 120; i++) {
      settle(cam, ORIGIN, 0, 0, STAND);
      const eye = cam.view(1).eye;
      expect(eye[2]).toBeLessThanOrEqual(10 - CAM_MARGIN + 1e-9);
    }
    close(cam.view(1).eye, [0, 21.484, 10 - CAM_MARGIN]);
    // At any pitch the eye stays on the actor's side of the wall.
    for (const pitch of [-60, -30, INIT_AIM_PITCH, 20, 50]) {
      settle(cam, ORIGIN, 0, pitch, STAND, 5);
      expect(cam.view(1).eye[2], `pitch ${pitch}`).toBeLessThan(10);
    }
  });

  it('a camera-type-1 polygon within 2.75 of the target is passed over for the next hit (FUN_0029cd20); at 5 it stops the eye', () => {
    const typeOne = (z: number): WorldPoly => ({ ...wallZ(z, -50, 50), cameratype: 1, path: 'worldmodel/camera1' });
    const near = new PlayerCamera(world([floor(0), typeOne(2), wallZ(10, -50, 50)]));
    settle(near, ORIGIN, 0, 0, STAND, 3);
    close(near.view(1).eye, [0, 21.484, 10 - CAM_MARGIN]);                  // not inside the head, 1.25 behind the target
    const far = new PlayerCamera(world([floor(0), typeOne(5), wallZ(10, -50, 50)]));
    settle(far, ORIGIN, 0, 0, STAND, 3);
    close(far.view(1).eye, [0, 21.484, 5 - CAM_MARGIN]);
  });

  it('a filtered hit still counts as a hit (DAT_00416038): the distance lets out during the hold', () => {
    // A plain wall behind x < 0 only, a type-1 polygon 2 behind everywhere.
    const typeOne: WorldPoly = { ...wallZ(2, -100, 100), cameratype: 1, path: 'worldmodel/camera1' };
    const cam = new PlayerCamera(world([floor(0), wallZ(10, -100, 0), typeOne]));
    settle(cam, [-10, 0, 0], 0, 0, STAND, 3);                               // the plain wall behind: pulled in, held
    expect(cam.distance()).toBeCloseTo(9.25, 6);
    settle(cam, [20, 0, 0], 0, 0, STAND, 1);                                // past its end: only the filtered hit
    expect(cam.distance()).toBeCloseTo(9.25 + 0.03 * (28.75 - 9.25), 6);   // out at once, the hold notwithstanding
  });

  it('holds the pulled-in distance 1.5 s after the last hit, then lets it out at 3 % a tick', () => {
    const cam = new PlayerCamera(world([floor(0), wallZ(10, -50, 50)]));
    settle(cam, ORIGIN, 0, 0, STAND, 5);
    expect(cam.distance()).toBeCloseTo(10 - CAM_MARGIN, 6);
    const away: Vec3 = [120, 0, 0];                                          // past the wall's end: nothing behind
    settle(cam, away, 0, 0, STAND, 85);
    expect(cam.distance()).toBeCloseTo(9.25, 6);                             // cam+0x4c still counting down
    settle(cam, away, 0, 0, STAND, 10);
    expect(cam.distance()).toBeGreaterThan(9.3);
    expect(cam.distance()).toBeLessThan(28.75);
    settle(cam, away, 0, 0, STAND, 400);
    expect(cam.distance()).toBeCloseTo(28.75, 2);
  });

  it('the four side probes push the eye 0.75 off a wall beside it', () => {
    // A wall along the view line 0.5 to the eye's right (+x at yaw 0): the +side probe ends 0.25 inside it.
    const cam = new PlayerCamera(world([floor(0), wallX(0.5, 5, 60)]));
    settle(cam, ORIGIN, 0, 0, STAND);
    const eye = cam.view(1).eye;
    expect(eye[0]).toBeCloseTo(0.5 - CAM_MARGIN, 6);
    expect(eye[2]).toBeCloseTo(28.75, 6);
  });

  it('a ceiling over the eye pushes it down 0.75 off it', () => {
    const ceiling = quad([-50, 22, 20, 50, 22, 20, 50, 22, 40, -50, 22, 40], 3, 'worldmodel/ceiling');
    const cam = new PlayerCamera(world([floor(0), ceiling]));
    settle(cam, ORIGIN, 0, 0, STAND);
    expect(cam.view(1).eye[1]).toBeCloseTo(22 - CAM_MARGIN, 6);
  });
});

describe('the look limits and first person', () => {
  it('the pitch is the aim pitch: min/max_aim_pitch -70..60, prone -20..25 (FUN_00594600)', () => {
    expect(pitchLimits('stand')).toEqual([-70, 60]);
    expect(pitchLimits('crouch')).toEqual([-70, 60]);
    expect(pitchLimits('prone')).toEqual([-20, 25]);
  });

  it('first person puts the eye at the head: HEAD_HEIGHT standing, the crown less the same 1.3 in the other stances', () => {
    expect(firstPersonHeight('stand')).toBe(HEAD_HEIGHT);
    expect(firstPersonHeight('crouch')).toBeCloseTo(12.4 - 1.3, 9);
    expect(firstPersonHeight('prone')).toBeCloseTo(3 - 1.3, 9);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The mode: third person by default, V for first person, the mouse on the body's yaw and the camera's pitch.

const canvas = (): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.setPointerCapture = () => undefined;
  c.releasePointerCapture = () => undefined;
  c.hasPointerCapture = () => false;
  return c;
};
const GROUND = packGround(
  { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
  [floor(0)], [{ modelName: 'worldmodel', path: 'worldmodel/ground', first: 0, count: 1 }],
);

describe('walk mode\'s camera (W2.1)', () => {
  const made: WalkMode[] = [];
  const setUp = () => {
    const c = canvas();
    const fly = new FlyCamera(c);
    fly.setScale(0.1);
    const mode = new WalkMode(fly);
    mode.setGround(GROUND, [150, 0, 150]);
    mode.bindKey();
    made.push(mode);
    return { fly, mode, c };
  };
  afterEach(() => { for (const m of made.splice(0)) m.unbindKey(); });

  it('enters in third person at the rest pitch, the camera behind and over the feet; the hook reads it', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 0, y: 30, z: 0, yaw: 0, pitch: 0 });
    mode.setMode('walk');
    expect(mode.feet()).toEqual([0, 0, 0]);
    const cam = mode.cameraState()!;
    expect(cam.mode).toBe('third');
    expect(cam.pitch).toBeCloseTo(INIT_AIM_PITCH, 9);
    expect(cam.rootY).toBe(STAND);
    close(cam.target, [0, 21.484, -1.2745]);
    close(cam.eye, [0, 25.709, 24.906]);
    close([fly.camera.position.x, fly.camera.position.y, fly.camera.position.z], cam.eye);
    expect(fly.pose().pitch).toBeCloseTo(INIT_AIM_PITCH, 9);
  });

  it('V toggles first person (the eye at the head, looking along yaw and pitch) and back; Ctrl+V is left to the browser', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 0, y: 30, z: 0, yaw: 0, pitch: 0 });
    mode.setMode('walk');
    const press = (init: KeyboardEventInit): boolean => {
      const e = new KeyboardEvent('keydown', { code: 'KeyV', cancelable: true, ...init });
      globalThis.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(press({ ctrlKey: true })).toBe(false);
    expect(press({ metaKey: true })).toBe(false);
    expect(mode.cameraState()!.mode).toBe('third');
    expect(press({})).toBe(true);
    expect(mode.cameraState()!.mode).toBe('first');
    close([fly.camera.position.x, fly.camera.position.y, fly.camera.position.z], [0, HEAD_HEIGHT, 0]);
    expect(fly.camera.rotation.y).toBeCloseTo(0, 9);
    expect(fly.camera.rotation.x).toBeCloseTo((INIT_AIM_PITCH * Math.PI) / 180, 9);
    expect(mode.setView('third')).toBe(true);
    expect(mode.cameraState()!.mode).toBe('third');
    mode.setMode('fly');
    expect(press({})).toBe(false);                                           // fly mode: V is nobody's
  });

  it('the mouse turns the body\'s yaw (LOOK a pixel) and the camera\'s pitch at pitch_rate / turn_maxrate of it, clamped', () => {
    const { fly, mode, c } = setUp();
    fly.setPose({ x: 0, y: 30, z: 0, yaw: 0, pitch: 0 });
    mode.setMode('walk');
    const drag = (dx: number, dy: number): void => {
      c.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'touch' }));
      c.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy, pointerType: 'touch' }));
      c.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 100 + dx, clientY: 100 + dy, pointerType: 'touch' }));
    };
    const before = fly.pose();
    drag(-10, -10);                                                          // a touch drag turns twice as far (TOUCH_LOOK)
    const after = fly.pose();
    const look = (0.0028 * 20 * 180) / Math.PI;
    expect(after.yaw - before.yaw).toBeCloseTo(look, 6);
    expect(after.pitch - before.pitch).toBeCloseTo(look * (SEAL_TUNING.pitchRate / SEAL_TUNING.turnMaxRate), 6);
    drag(0, -10000);
    expect(fly.pose().pitch).toBeCloseTo(60, 6);
    drag(0, 10000);
    expect(fly.pose().pitch).toBeCloseTo(-70, 6);
    mode.setStance('prone');
    mode.frame(TICK);
    expect(fly.pose().pitch).toBeCloseTo(-20, 6);
  });

  it('a turn-only setCamera keeps the camera\'s pass: the pulled-in distance and the hold survive it', () => {
    const fly = new FlyCamera(canvas());
    const mode = new WalkMode(fly);
    made.push(mode);
    mode.setGround(packGround(
      { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
      [floor(0), wallZ(10, -50, 50)],
      [{ modelName: 'worldmodel', path: 'worldmodel/ground', first: 0, count: 1 }, { modelName: 'worldmodel', path: 'worldmodel/wall', first: 1, count: 1 }],
    ), null);
    fly.setPose({ x: 0, y: 30, z: 0, yaw: 0, pitch: 0 });
    mode.setMode('walk');
    mode.setCamera({ pitch: 0 });
    mode.frame(0.5);                                                         // 30 ticks against the wall behind
    const before = mode.cameraState()!.pass;
    expect(before.distance).toBeCloseTo(9.25, 6);
    expect(before.hold).toBeCloseTo(1.5, 6);
    mode.setCamera({ yaw: 180 });                                            // a turn: nothing behind now
    const after = mode.cameraState()!.pass;
    expect(after.distance).toBeCloseTo(9.25, 6);
    expect(after.hold).toBeCloseTo(1.5, 6);
    mode.frame(0.5);                                                         // held, counting down
    expect(mode.cameraState()!.pass.distance).toBeCloseTo(9.25, 6);
    expect(mode.cameraState()!.pass.hold).toBeCloseTo(1.0, 6);
    // A pose with a position is a new stand: a new camera.
    mode.setCamera({ x: 0, y: 30, z: 0, yaw: 0 });
    expect(mode.cameraState()!.pass.distance).toBeCloseTo(9.25, 6);       // the wall behind again, at once
    expect(mode.cameraState()!.pass.hold).toBeCloseTo(1.5, 6);
    mode.setCamera({ x: 0, y: 30, z: 0, yaw: 180 });
    expect(mode.cameraState()!.pass.distance).toBeCloseTo(28.75, 6);      // turned away, a new camera: no hold
  });

  it('the hook\'s setCamera still drops the mover from a pose, and walkFor moves the camera with the feet', () => {
    const { fly, mode } = setUp();
    fly.setPose({ x: 0, y: 30, z: 0 });
    mode.setMode('walk');
    mode.setCamera({ x: 50, y: EYE_HEIGHT, z: 50, yaw: 0, pitch: 0 });
    expect(mode.feet()).toEqual([50, 0, 50]);
    close(mode.cameraState()!.eye, [50, 21.484, 78.75]);
    mode.walkFor(1, { forward: 1, right: 0, boost: false });
    const feet = mode.feet()!;
    expect(feet[2]).toBeLessThan(0);
    close(mode.cameraState()!.eye, [50, 21.484, feet[2] + 28.75]);
  });
});

describe.skipIf(!MP2)(`the camera at Frostfire's spawn A${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  it('standing at A facing +z (along research 24\'s route), the eye is 25.709 over the floor and 24.906 behind, unobstructed', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    const grid = groundGrid(map.ground!);
    const feet: Vec3 = [796, 100, 614];
    expect(probeFloor(grid, feet[0], feet[1], feet[2])?.y).toBe(100);
    // Facing +z is yaw 180: the camera stands on the -z side. Nothing between the target and 0.75 past the goal.
    const cam = new PlayerCamera(grid);
    settle(cam, feet, 180, INIT_AIM_PITCH, STAND, 3);
    const v = cam.view(1);
    close(v.eye, [796, 125.709, 614 - 24.906]);
    close(v.target, [796, 121.484, 614 + 1.2745]);
    expect(segmentHit(grid, v.target, v.eye)).toBeNull();
  });
});
