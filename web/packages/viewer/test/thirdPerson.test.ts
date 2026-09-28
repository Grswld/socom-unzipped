import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PerspectiveCamera, Vector3 } from 'three';
import { parseRdr, Zar, type RdrNode } from '@s2u/archive';
import { buildGrid, type CollisionOwner, type GridParams, type WorldPoly } from '@s2u/scene';
import {
  castRayForCamera, pullIn, readCameraRig, rigView, tether, ShoulderCamera, CAM_BACK_MEASURED, CAMERA_MARGIN_PLACEHOLDER,
  ORBIT_MAX_DEG, ORBIT_MIN_DEG, RIG_ROOT_Y, TETHER_SNAP_PLACEHOLDER, TETHER_STIFF_PLACEHOLDER,
} from '../src/thirdPerson';

/**
 * W2.6: the game's third-person camera behind the SEAL (W2.R1): a rig in the actor's frame -- the camera's side,
 * height and distance behind, and the point it aims at (reCOM `CCameraParams`, `zCharacter/char_dyn.cpp:261-280`) --
 * turned with the look, orbited by the look's pitch, tethered, and pulled in off the hull. The measured rig is the
 * default (research 18's ring, research 17 §4.1's target); the disc's `cam_back` is the switch, read at run time.
 */

const close = (a: readonly number[], b: readonly number[], digits = 6): void => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(b[i]!, digits));
};

describe('the rigs (W2.R2: the game\'s numbers, or a measurement named as the default)', () => {
  it('defaults to the measurement: 25 up and 23.1 behind (research 18), aiming 21.485 up and 1.273 ahead (research 17 §4.1)', () => {
    expect(CAM_BACK_MEASURED).toEqual({ side: 0, height: 25, dist: 23.1, aim: [0, 21.485, -1.273] });
    // research 17 §4.1 row #0: the rig was taken with the root node at 11.4845, the standing SEAL's
    expect(RIG_ROOT_Y).toBe(11.4845);
    expect([TETHER_STIFF_PLACEHOLDER, TETHER_SNAP_PLACEHOLDER, CAMERA_MARGIN_PLACEHOLDER]).toEqual([1, 100, 1]);
    expect([ORBIT_MIN_DEG, ORBIT_MAX_DEG]).toEqual([-60, 75]);
  });

  it('reads a rig from dynamics.rdr by name -- side, height, dist and the three-number aim -- or none', () => {
    // made-up numbers (W2.R6: the file's never appear here)
    const rdr: RdrNode = [
      'cam_back_height', ['30'], 'cam_back_dist', ['12'], 'cam_back_side', ['1.5'], 'cam_back_aim', ['0.5', '28', '-3'],
      'cam_side_height', ['9'],
    ];
    expect(readCameraRig(rdr, 'cam_back')).toEqual({ side: 1.5, height: 30, dist: 12, aim: [0.5, 28, -3] });
    expect(readCameraRig(rdr, 'cam_side')).toBeNull();                        // incomplete
    expect(readCameraRig(['cam_x_height', ['1'], 'cam_x_dist', ['1'], 'cam_x_side', ['1'], 'cam_x_aim', ['1', '2']], 'cam_x')).toBeNull();
    expect(readCameraRig([], 'cam_back')).toBeNull();
  });
});

describe('the rig in the world: turned with the look, orbited by its pitch, riding the root', () => {
  it('stands behind the feet along the look and aims ahead of them', () => {
    const at0 = rigView([0, 0, 0], 0, 0, CAM_BACK_MEASURED, 0);
    close(at0.eye, [0, 25, 23.1]);                                  // yaw 0 looks down -z: behind is +z
    close(at0.aim, [0, 21.485, -1.273]);
    const at90 = rigView([100, 5, -40], 90, 0, CAM_BACK_MEASURED, 0);
    close(at90.eye, [100 + 23.1, 30, -40]);                          // yaw 90 looks down -x: behind is +x
    close(at90.aim, [100 - 1.273, 26.485, -40]);
    const side = rigView([0, 0, 0], 0, 0, { side: 4, height: 20, dist: 10, aim: [4, 20, -2] }, 0);
    close(side.eye, [4, 20, 10]);                                   // side is the actor's right, +x at yaw 0
  });

  it('rides the posed root: a crouch lowers eye and aim alike (the rig is the standing SEAL\'s)', () => {
    const low = rigView([0, 0, 0], 0, 0, CAM_BACK_MEASURED, 5.504 - RIG_ROOT_Y);
    close(low.aim, [0, 21.485 + 5.504 - RIG_ROOT_Y, -1.273]);
    expect(low.aim[1]).toBeCloseTo(15.5, 1);                        // research 17 §1's crouched target, 15.38, within 0.13
    close(low.eye, [0, 25 + 5.504 - RIG_ROOT_Y, 23.1]);
  });

  it('orbits the aim point with the look\'s pitch: looking up lowers the camera, the distance kept; clamped', () => {
    const level = rigView([0, 0, 0], 0, 0, CAM_BACK_MEASURED, 0);
    const up = rigView([0, 0, 0], 0, 20, CAM_BACK_MEASURED, 0);
    const down = rigView([0, 0, 0], 0, -20, CAM_BACK_MEASURED, 0);
    const dist = (v: { eye: number[]; aim: number[] }) => Math.hypot(v.eye[0]! - v.aim[0]!, v.eye[1]! - v.aim[1]!, v.eye[2]! - v.aim[2]!);
    expect(up.eye[1]).toBeLessThan(level.eye[1]);
    expect(down.eye[1]).toBeGreaterThan(level.eye[1]);
    expect(dist(up)).toBeCloseTo(dist(level), 9);
    expect(dist(down)).toBeCloseTo(dist(level), 9);
    const elevation = (v: { eye: number[]; aim: number[] }) => Math.atan2(v.eye[1]! - v.aim[1]!, v.eye[2]! - v.aim[2]!) * 180 / Math.PI;
    expect(elevation(level) - elevation(up)).toBeCloseTo(20, 9);
    expect(elevation(rigView([0, 0, 0], 0, 89, CAM_BACK_MEASURED, 0))).toBeCloseTo(ORBIT_MIN_DEG, 9);
    expect(elevation(rigView([0, 0, 0], 0, -89, CAM_BACK_MEASURED, 0))).toBeCloseTo(ORBIT_MAX_DEG, 9);
  });
});

describe('the tether (cam_tether_stiff, the reading: the part of the gap closed each 60 Hz tick)', () => {
  it('is rigid at 1, holds at 0, closes half the gap a tick at 0.5, the same however the time is cut', () => {
    close(tether([10, 0, 0], [0, 0, 0], 1, 1 / 60), [0, 0, 0]);
    close(tether([10, 0, 0], [0, 0, 0], 0, 1 / 60), [10, 0, 0]);
    close(tether([10, 0, 0], [0, 0, 0], 0.5, 1 / 60), [5, 0, 0]);
    const halves = tether(tether([10, 4, 0], [0, 0, 0], 0.5, 1 / 120), [0, 0, 0], 0.5, 1 / 120);
    close(halves, tether([10, 4, 0], [0, 0, 0], 0.5, 1 / 60));
    // a gap past the snap (a new map, a teleport) is not followed but jumped
    close(tether([500, 0, 0], [0, 0, 0], 0.1, 1 / 60), [0, 0, 0]);
    close(tether(null, [3, 2, 1], 0.1, 1 / 60), [3, 2, 1]);
  });
});

/** A 4 x 4 grid of 100-unit cells from (-200, -200), one owner a polygon. */
function hull(polys: WorldPoly[]) {
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 }));
  return buildGrid(params, [], [], polys, owners);
}
/** A vertical wall across z at `z`, x from x0 to x1, y from y0 to y1; `cameratype` bit 0 is research 23/24's bit 18. */
function wallZ(z: number, x0: number, x1: number, y0: number, y1: number, cameratype = 0): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/wall', region: 0, ditype: 2, material: 25, ptcount: 4, cameratype,
    points: Float32Array.from([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]),
  };
}

describe('the pull-in: the hull between the head and the camera (castRayForCamera, a ray through the probe\'s polygons)', () => {
  it('finds the first polygon a segment crosses, as a fraction of it; none, null', () => {
    const grid = hull([wallZ(15, -50, 50, 0, 60), wallZ(10, -50, 50, 0, 60)]);
    expect(castRayForCamera(grid, [0, 20, 0], [0, 20, 20])).toBeCloseTo(0.5, 9);          // the nearer wall, z 10
    expect(castRayForCamera(grid, [0, 20, 0], [0, 20, 8])).toBeNull();                    // short of both
    expect(castRayForCamera(grid, [0, 70, 0], [0, 70, 20])).toBeNull();                   // over them
    expect(castRayForCamera(grid, [60, 20, 0], [60, 20, 20])).toBeNull();                 // beside them
    expect(castRayForCamera(hull([]), [0, 20, 0], [0, 20, 20])).toBeNull();
  });

  it('takes every polygon of the hull, m_cameratype\'s bit-18 volumes too (the probe skips them; the camera is theirs)', () => {
    const grid = hull([wallZ(10, -50, 50, 0, 60, 1)]);
    expect(castRayForCamera(grid, [0, 20, 0], [0, 20, 20])).toBeCloseTo(0.5, 9);
  });

  it('pulls the camera in to the hit less the margin along the ray, and never past the aim', () => {
    close(pullIn([0, 20, 0], [0, 20, 20], 0.5), [0, 20, 10 - CAMERA_MARGIN_PLACEHOLDER]);
    close(pullIn([0, 20, 0], [0, 20, 20], null), [0, 20, 20]);
    close(pullIn([0, 20, 0], [0, 20, 20], 0.01), [0, 20, 0]);
  });
});

describe('the camera object (ShoulderCamera)', () => {
  const grid = hull([]);

  it('stands at the rig\'s eye looking at its aim, and takes the fly camera\'s projection', () => {
    const shoulder = new ShoulderCamera();
    const fly = new PerspectiveCamera(49, 1.5, 4, 3000);
    shoulder.follow(fly);
    expect([shoulder.camera.fov, shoulder.camera.aspect, shoulder.camera.near, shoulder.camera.far]).toEqual([49, 1.5, 4, 3000]);
    shoulder.update(1 / 60, { feet: [0, 0, 0], yaw: 0, pitch: 0, lift: 0, rig: CAM_BACK_MEASURED, stiff: 1, grid });
    close(shoulder.camera.position.toArray(), [0, 25, 23.1]);
    const look = shoulder.camera.getWorldDirection(new Vector3());
    close(look.toArray(), new Vector3(0, 21.485 - 25, -1.273 - 23.1).normalize().toArray());
    expect(shoulder.pose()).toMatchObject({ x: expect.closeTo(0, 6), y: expect.closeTo(25, 6), z: expect.closeTo(23.1, 6) });
  });

  it('tethers from where it was, and is pulled in by a wall behind the SEAL', () => {
    const shoulder = new ShoulderCamera();
    shoulder.update(1 / 60, { feet: [0, 0, 0], yaw: 0, pitch: 0, lift: 0, rig: CAM_BACK_MEASURED, stiff: 0.5, grid });
    shoulder.update(1 / 60, { feet: [10, 0, 0], yaw: 0, pitch: 0, lift: 0, rig: CAM_BACK_MEASURED, stiff: 0.5, grid });
    expect(shoulder.camera.position.x).toBeCloseTo(5, 6);            // half the 10 closed in one tick
    const walled = new ShoulderCamera();
    walled.update(1 / 60, { feet: [0, 0, 0], yaw: 0, pitch: 0, lift: 0, rig: CAM_BACK_MEASURED, stiff: 1, grid: hull([wallZ(12, -50, 50, 0, 60)]) });
    expect(walled.camera.position.z).toBeLessThan(12);
    expect(walled.camera.position.z).toBeGreaterThan(12 - 2 * CAMERA_MARGIN_PLACEHOLDER);
  });

  it('is the first-person aim view at an eye, along the look; a reset forgets the tether', () => {
    const shoulder = new ShoulderCamera();
    shoulder.aimAt([1, 18.16, 2], 30, -10);
    expect(shoulder.pose()).toMatchObject({ x: 1, y: expect.closeTo(18.16, 5), z: 2, yaw: expect.closeTo(30, 9), pitch: expect.closeTo(-10, 9) });
    shoulder.reset();
    shoulder.update(1 / 60, { feet: [50, 0, 0], yaw: 0, pitch: 0, lift: 0, rig: CAM_BACK_MEASURED, stiff: 0.01, grid });
    expect(shoulder.camera.position.x).toBeCloseTo(50, 6);           // nothing to tether from: straight to the rig
  });
});

const READERC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/maps/RUN/READERC.ZAR');
const noReaderc = !existsSync(READERC);

describe.skipIf(noReaderc)(`the disc's camera rig${noReaderc ? ' (READERC.ZAR absent from public/maps/RUN)' : ''}`, () => {
  it('carries cam_back whole in dynamics.rdr, and a tether stiffness between 0 and 1 (presence, not values: W2.R6)', () => {
    const zar = Zar.parse(new Uint8Array(readFileSync(READERC)));
    const rdr = parseRdr(zar.data(zar.find('dynamics.rdr')!));
    const back = readCameraRig(rdr, 'cam_back')!;
    expect(back).not.toBeNull();
    for (const v of [back.side, back.height, back.dist, ...back.aim]) expect(Number.isFinite(v)).toBe(true);
    // not the measurement: the spec's section 6 says the triple alone does not reproduce research 18's ring
    expect(back.dist).not.toBeCloseTo(CAM_BACK_MEASURED.dist, 1);
  });
});
