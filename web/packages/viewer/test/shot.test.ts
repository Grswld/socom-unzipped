import { describe, expect, it } from 'vitest';
import { Group, Line, Matrix4, Mesh, Vector3 } from 'three';
import { DEFAULT_GRID_PARAMS, type GridParams, type WorldPoly } from '@s2u/scene';
import { EYE_HEIGHT, packGround, type GroundData } from '../src/walk';
import {
  actorMatrix, aimDirection, fireOffsetsPlaceholder, heldWeaponMatrix, Shooter,
  HOLD_PLACEHOLDER, RECOIL_PLACEHOLDER, SHOT_RANGE_PLACEHOLDER, VIEWER_FIRE_ARGS,
  type Mover, type WeaponPoint,
} from '../src/shot';

/**
 * The shot (W2.4 step 4; web/docs/research/79 §3-§5): the fire point by `GetPutativeFirePointW`'s port with the
 * placeholder offsets, the eye's ray for the aim point, the fire point's ray for the hit, and the count on the hook.
 * A synthetic world: a floor at y 0 and a wall across x = 100, on a 4 x 4 grid of 100-unit cells.
 */

/** The M4A1 SD's own nodes as `WEAP_GEO` holds them (the weapon fixture test pins these). */
const M4_POINTS: WeaponPoint[] = [
  { name: 'firepoint', at: [7.7854, 0.8338, 0] },
  { name: 'firepoint_shell', at: [0.9817, 0.0703, 0.0178] },
  { name: 'aimpoint', at: [-0.2146, 0.8338, 0] },
  { name: 'Gun_box', at: [0, 0, 0] },
];

const poly = (points: number[], ditype: number): WorldPoly => ({
  modelName: 'worldmodel', path: 'worldmodel/p', region: 0, ditype, material: 25, ptcount: points.length / 3,
  cameratype: 0, points: Float32Array.from(points),
});
const FLOOR = poly([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200], 3);
const WALL = poly([100, 0, -100, 100, 0, 100, 100, 100, 100, 100, 100, -100], 2);
const PARAMS: GridParams = { ...DEFAULT_GRID_PARAMS, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
const ground = (polys: WorldPoly[]): GroundData => packGround(PARAMS, polys,
  polys.map((p, i) => ({ modelName: p.modelName, path: `${p.path}${i}`, first: i, count: 1 })));

/** Standing at the origin facing +x: the camera looks down its own -z, so yaw -90 faces +x (`camera.ts`). */
const standing = (over: Partial<Mover> = {}): Mover => ({
  mode: 'walk', feet: [0, 0, 0], eye: [0, EYE_HEIGHT, 0], yaw: -90, pitch: 0, ...over,
});

const near = (a: readonly number[], b: readonly number[], digits = 6): void => {
  expect(a).toHaveLength(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};

function armed(polys: WorldPoly[] = [FLOOR, WALL]): { shooter: Shooter; weapon: Group } {
  const shooter = new Shooter();
  const weapon = new Group();
  weapon.add(new Mesh());
  shooter.setMap(ground(polys), { object: weapon, points: M4_POINTS });
  return { shooter, weapon };
}

describe('the placeholders (W2.R2: named, tested as placeholders)', () => {
  it('holds the weapon 1.5 right of and 2 under the eye, its sight 1 ahead of it', () => {
    expect(HOLD_PLACEHOLDER).toEqual({ right: 1.5, down: 2, relief: 1 });
    expect(SHOT_RANGE_PLACEHOLDER).toBe(5000);
    expect(RECOIL_PLACEHOLDER).toEqual({ kickPitchDegrees: 0 });
    expect(VIEWER_FIRE_ARGS).toEqual({ fromStanceTable: true, alternate: false });
  });

  it('gives all ten slots one offset in the actor frame: x left, y up, z forward, from the M4A1 SD\'s nodes', () => {
    const offsets = fireOffsetsPlaceholder(M4_POINTS);
    // forward: the relief plus the muzzle's 8.0 ahead of the sight point; up: the eye less the drop; x: right is -x.
    for (const o of Object.values(offsets)) near(o, [-1.5, EYE_HEIGHT - 2, 1 + 7.7854 + 0.2146]);
    expect(Object.keys(offsets)).toHaveLength(10);
  });
});

describe('the actor frame and the aim', () => {
  it('faces the camera\'s forward: yaw -90 puts local z along +x and local x (left) along -z', () => {
    const m = actorMatrix([10, 20, 30], -90);
    near([m[8]!, m[9]!, m[10]!], [1, 0, 0]);
    near([m[0]!, m[1]!, m[2]!], [0, 0, -1]);
    near([m[4]!, m[5]!, m[6]!], [0, 1, 0]);
    near([m[12]!, m[13]!, m[14]!, m[15]!], [10, 20, 30, 1]);
  });

  it('aims down the camera\'s -z turned by yaw then pitch (`camera.ts`, rotation order YXZ)', () => {
    near(aimDirection(0, 0), [0, 0, -1]);
    near(aimDirection(-90, 0), [1, 0, 0]);
    near(aimDirection(-90, 45), [Math.SQRT1_2, Math.SQRT1_2, 0]);
  });

  it('holds the weapon with its muzzle node on the fire point and its barrel (+x) toward the aim point', () => {
    const m = heldWeaponMatrix([9, 13.4, 1.5], [100, 13.4, 1.5], [7.7854, 0.8338, 0]);
    const muzzle = new Vector3(7.7854, 0.8338, 0).applyMatrix4(new Matrix4().fromArray(m));
    near([muzzle.x, muzzle.y, muzzle.z], [9, 13.4, 1.5], 5);
    near([m[0]!, m[1]!, m[2]!], [1, 0, 0]);
    near([m[4]!, m[5]!, m[6]!], [0, 1, 0]);
  });
});

describe('the shot', () => {
  it('leaves the fire point and lands where the eye aims: on the wall at the crosshair', () => {
    const { shooter } = armed();
    const shot = shooter.fire(standing());
    expect(shot).not.toBeNull();
    near(shot!.from, [9, EYE_HEIGHT - 2, 1.5], 5);
    near(shot!.to, [100, EYE_HEIGHT, 0], 4);
    expect(shot!.hit).toBe(true);
    expect(shot!.slot).toBe('code0');
    expect(shooter.stats()).toEqual({ shots: 1, lastShot: shot });
  });

  it('counts every shot and keeps the last', () => {
    const { shooter } = armed();
    shooter.fire(standing());
    const second = shooter.fire(standing({ pitch: -45 }));
    expect(shooter.stats().shots).toBe(2);
    expect(shooter.stats().lastShot).toBe(second);
    // Looking 45 degrees down from 15.4 up: the floor 15.4 ahead, and the shot converges on it.
    near(second!.to, [EYE_HEIGHT, 0, 0], 4);
    expect(second!.hit).toBe(true);
  });

  it('goes out to the range and reports no hit when the aim finds nothing', () => {
    const { shooter } = armed([FLOOR]);
    const shot = shooter.fire(standing());
    expect(shot!.hit).toBe(false);
    near(shot!.to, [SHOT_RANGE_PLACEHOLDER, EYE_HEIGHT, 0], 4);
  });

  it('stands the actor under the drawn eye, not the last tick\'s feet, so the weapon does not shake against the view', () => {
    const { shooter } = armed();
    const shot = shooter.fire(standing({ feet: [0, 0, 0], eye: [0.5, EYE_HEIGHT, 0] }))!;   // half a tick drawn ahead
    near(shot.from, [9.5, EYE_HEIGHT - 2, 1.5], 5);
  });

  it('does not fire in fly mode, nor with no map', () => {
    const { shooter } = armed();
    expect(shooter.fire(standing({ mode: 'fly' }))).toBeNull();
    expect(shooter.stats()).toEqual({ shots: 0, lastShot: null });
    expect(new Shooter().fire(standing())).toBeNull();
  });

  it('draws a tracer from the fire point to the hit, and a marker at the hit', () => {
    const { shooter } = armed();
    const shot = shooter.fire(standing())!;
    const tracer = shooter.group.children.find((c): c is Line => c instanceof Line)!;
    const p = tracer.geometry.getAttribute('position');
    near([p.getX(0), p.getY(0), p.getZ(0)], shot.from, 4);
    near([p.getX(1), p.getY(1), p.getZ(1)], shot.to, 4);
    expect(tracer.visible).toBe(true);
    const marker = shooter.group.getObjectByName('hit marker')!;
    expect(marker.visible).toBe(true);
    near([marker.position.x, marker.position.y, marker.position.z], shot.to, 4);
    shooter.fire(standing({ yaw: 90 }));                  // facing -x: out over the floor's edge into nothing
    expect(marker.visible).toBe(false);
  });

  it('takes the moving slot when the feet run forward faster than 20 a second (velM from the frames)', () => {
    const { shooter } = armed();
    shooter.frame(1 / 30, standing());
    shooter.frame(1 / 30, standing({ feet: [1, 0, 0], eye: [1, EYE_HEIGHT, 0] }));   // 30 a second along +x
    expect(shooter.fire(standing({ feet: [1, 0, 0], eye: [1, EYE_HEIGHT, 0] }))!.slot).toBe('moving');
  });
});

describe('the held weapon', () => {
  it('shows while walking with its muzzle on the fire point, and hides in fly mode', () => {
    const { shooter, weapon } = armed();
    shooter.frame(1 / 60, standing());
    expect(weapon.visible).toBe(true);
    weapon.updateMatrixWorld(true);
    const muzzle = new Vector3(7.7854, 0.8338, 0).applyMatrix4(weapon.matrixWorld);
    near([muzzle.x, muzzle.y, muzzle.z], [9, EYE_HEIGHT - 2, 1.5], 4);
    shooter.frame(1 / 60, standing({ mode: 'fly', feet: null }));
    expect(weapon.visible).toBe(false);
  });
});
