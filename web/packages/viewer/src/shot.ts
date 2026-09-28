import {
  BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, OctahedronGeometry,
  type Object3D,
} from 'three';
import {
  castRay, firePoint, fireSlot,
  type FireOffsets, type FirePointState, type FireSlot, type Grid, type Pnt3D, type WeaponPoint,
} from '@s2u/scene';
import { EYE_HEIGHT, groundGrid, type GroundData } from './walk';

export type { WeaponPoint } from '@s2u/scene';

/**
 * The shot (W2.4; web/docs/research/79 §3-§5): in walk mode the left button fires from the fire point
 * `GetPutativeFirePointW` computes (`@s2u/scene`'s `firePoint`, ported), a tracer runs to the first hull polygon
 * (`castRay`) and a marker sits at the hit; the count and the last shot go on the hook for the controller's pose.
 * The held weapon is drawn with its muzzle node on that fire point.
 *
 * What is the game's and what is not, by name (W2.R2):
 *
 * - **The game's:** the port of the body -- which of its constants a state reads, and the node matrix it carries it
 *   through; the weapon's own nodes (`firepoint`, `aimpoint`, from `WEAP_GEO`); the eye's 15.4 (W1.R2); the hull.
 * - **`HOLD_PLACEHOLDER`**: the body's ten offsets are data the handoff does not carry (research 79 §3), so every
 *   slot takes one offset -- the M4A1 SD held with its sight point `relief` ahead of the eye, `right` to its right
 *   and `down` under it, the muzzle where the weapon's own nodes then put it. Until W2.1's skeleton puts the weapon
 *   in the hand, this is also where it is drawn: in front of the camera in first person, lower right.
 * - **`VIEWER_ACTOR_PLACEHOLDER`**: the actor fields the body reads that the mover does not have. `actorState` 1 is
 *   what the actor reads walking and standing (research 25, research 21); the stance list, `m_item` and the byte at
 *   `+0x375` are placeholders until the body's model (W2.1) and the crouch (W2.3a) give them values.
 * - **`VIEWER_FIRE_ARGS`**: a1 true (the stance table, which needs no cached point) and a2 false; the callers of
 *   `GetPutativeFirePointW` and the arguments they pass are not in the handoff.
 * - **`SHOT_RANGE_PLACEHOLDER`**: the weapon table's `m_maxrange` is not on hand (research 79 §1).
 * - **`RECOIL_PLACEHOLDER`**: `Recoil__10CZSealBodyFv` is unidentified and the table's kick fields are not on hand
 *   (research 79 §5): no kick, until W2.5. *Superseded on the page* (the WEAPON workstream): the kick is
 *   `./rifleKick`'s port of `FUN_005b91c0` / `FUN_005b9280` on `zweapon.rdr`'s `FireRifleKick*`, and the round leaves
 *   the posed weapon's `firepoint` (`./heldItem`) -- `GetPutativeFirePointW`'s a1-false path, `+0x14b0` plus the
 *   position. This file's `Shooter` is not wired into the page; the port and its placeholders stand as the a1-true
 *   reference (the ten offsets at 0x65d038 are zero in the image's `.data`: filled at run time).
 * - **The aim point.** The shot leaves the fire point toward the point the eye's ray meets (reCOM's `m_aim_point`,
 *   `zSeal/zseal.h:785`), so it lands under the crosshair unless something is in the way; with nothing under the
 *   crosshair it runs along the aim to the range. The viewer's reading: the game's projectile path
 *   (`CZWeapon::Fire`, `CZProjectile_PostTick` 0x3c9fb0) is not decompiled.
 */

/** Where the weapon is held against the eye, game units (a placeholder: see the file's comment). */
export const HOLD_PLACEHOLDER = { right: 1.5, down: 2, relief: 1 } as const;
/** How far a shot reaches: the weapon table's `m_maxrange` is not on hand (a placeholder). */
export const SHOT_RANGE_PLACEHOLDER = 5000;
/** The aim's kick per shot, degrees of pitch: none until W2.5 finds the recoil (a placeholder). */
export const RECOIL_PLACEHOLDER = { kickPitchDegrees: 0 } as const;
/** `GetPutativeFirePointW`'s two `bool` arguments as the viewer passes them (a placeholder: the callers are not on hand). */
export const VIEWER_FIRE_ARGS = { fromStanceTable: true, alternate: false } as const;
/** The actor fields the mover does not carry (`actorState` 1 is research 25's standing and walking; the rest placeholders). */
export const VIEWER_ACTOR_PLACEHOLDER = { actorState: 1, byte375: -1, item: 0, stanceCodes: [] as number[] } as const;

/** A shot's ray stops this far past the aim point, so float rounding cannot make it miss the surface it aims at. */
const AIM_MARGIN = 0.01;
/** The hit marker's size and the two colours, the viewer's own. */
const MARKER_RADIUS = 1;
const TRACER_COLOUR = 0xffd24a, MARKER_COLOUR = 0xff3b30;

/** A weapon node's position by name, or the origin when the model has none by that name. */
const pointOf = (points: readonly WeaponPoint[], name: string): Pnt3D =>
  points.find((p) => p.name === name)?.at ?? [0, 0, 0];

/**
 * The offset every slot of the body's table takes (`HOLD_PLACEHOLDER`), in the actor's frame -- x left, y up, z
 * forward (`actorMatrix`) -- from the weapon's own muzzle and sight nodes (the weapon's frame: x along the barrel,
 * y up, z to its right).
 */
export function fireOffsetsPlaceholder(points: readonly WeaponPoint[]): FireOffsets {
  const muzzle = pointOf(points, 'firepoint'), sight = pointOf(points, 'aimpoint');
  const offset: Pnt3D = [
    -(HOLD_PLACEHOLDER.right + (muzzle[2] - sight[2])),
    EYE_HEIGHT - HOLD_PLACEHOLDER.down + (muzzle[1] - sight[1]),
    HOLD_PLACEHOLDER.relief + (muzzle[0] - sight[0]),
  ];
  const copy = (): Pnt3D => [offset[0], offset[1], offset[2]];
  return {
    code0: copy(), code1: copy(), code2: copy(), code0Alt: copy(), code1Alt: copy(), code2Alt: copy(),
    state3: copy(), state3Unset: copy(), movingItem1: copy(), moving: copy(),
  };
}

/**
 * The mover as the body's `m_node` matrix: row-major, row-vector (research 24 §1.1), turned by the camera's yaw,
 * translated to the feet (the actor's position, `+0x1c`). Local z is the facing -- the axis the body's own movement
 * test measures along (research 79 §3) -- y is up, and x = y cross z, the actor's left, so the rotation is proper.
 */
export function actorMatrix(feet: Pnt3D, yawDegrees: number): Float32Array {
  const yaw = (yawDegrees * Math.PI) / 180, s = Math.sin(yaw), c = Math.cos(yaw);
  // The camera looks down its own -z (`camera.ts`): forward (-sin, 0, -cos), and left = up x forward = (-cos, 0, sin).
  return Float32Array.from([-c, 0, s, 0, 0, 1, 0, 0, -s, 0, -c, 0, feet[0], feet[1], feet[2], 1]);
}

/** Where the camera looks: its -z turned by pitch about x, then yaw about y (`camera.ts`, rotation order YXZ). */
export function aimDirection(yawDegrees: number, pitchDegrees: number): Pnt3D {
  const yaw = (yawDegrees * Math.PI) / 180, pitch = (pitchDegrees * Math.PI) / 180;
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
}

const sub = (a: Pnt3D, b: Pnt3D): Pnt3D => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Pnt3D, b: Pnt3D): Pnt3D => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Pnt3D): Pnt3D | null => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};

/**
 * The held weapon's matrix, row-major row-vector (which is also three's `elements`, `@s2u/scene`'s `toColumnMajor`):
 * its barrel (+x) from `at` toward `toward`, level (its +y as near world up as the barrel allows), and its `muzzle`
 * node on `at`.
 */
export function heldWeaponMatrix(at: Pnt3D, toward: Pnt3D, muzzle: Pnt3D): Float32Array {
  const x = unit(sub(toward, at)) ?? [1, 0, 0];
  const z = unit(cross(x, [0, 1, 0])) ?? unit(cross(x, [0, 0, 1]))!;    // the weapon's right
  const y = cross(z, x);
  const t: Pnt3D = [
    at[0] - (muzzle[0] * x[0] + muzzle[1] * y[0] + muzzle[2] * z[0]),
    at[1] - (muzzle[0] * x[1] + muzzle[1] * y[1] + muzzle[2] * z[1]),
    at[2] - (muzzle[0] * x[2] + muzzle[1] * y[2] + muzzle[2] * z[2]),
  ];
  return Float32Array.from([...x, 0, ...y, 0, ...z, 0, ...t, 1]);
}

/**
 * What the page tells the shot about the mover each frame: the walk's feet and the camera's eye and look.
 *
 * The actor's position the body reads (`+0x1c`) is taken as the eye less `EYE_HEIGHT`, not `feet`: the walk draws
 * the eye between its last two 60 Hz ticks (`Walker.eye`) while `feet` is the last tick's, so a weapon hung off
 * `feet` would shake against the view by up to a tick's step. `feet` says whether the mover is walking.
 */
export interface Mover {
  mode: 'walk' | 'fly';
  /** The feet while walking (`WalkMode.feet`), else null. */
  feet: Pnt3D | null;
  /** The camera's position: the eye, 15.4 over the feet, while walking. */
  eye: Pnt3D;
  /** The camera's look, degrees (`Pose`). */
  yaw: number;
  pitch: number;
}

/** One shot, for the hook: where it left, where it stopped, whether that was the hull, and the body's slot. */
export interface ShotRecord { from: Pnt3D; to: Pnt3D; hit: boolean; slot: FireSlot }

/** The actor's position while walking: the eye less `EYE_HEIGHT` (see `Mover`); null when not walking. */
function actorPosition(mover: Mover): Pnt3D | null {
  if (mover.mode !== 'walk' || !mover.feet) return null;
  return [mover.eye[0], mover.eye[1] - EYE_HEIGHT, mover.eye[2]];
}

/** The weapon `buildWorld` drew for the map, and its named points (`LoadedMap.weapon`). */
export interface HeldWeapon { object: Object3D; points: readonly WeaponPoint[] }

/** The shot and the held weapon, for one map at a time. `group` goes in the scene once. */
export class Shooter {
  readonly group = new Group();
  private ground: GroundData | undefined;
  private grid: Grid | null = null;
  private weapon: HeldWeapon | null = null;
  private offsets: FireOffsets = fireOffsetsPlaceholder([]);
  private ready = false;
  private shots = 0;
  private last: ShotRecord | null = null;
  /** The actor's position at the last walking frame (`actorPosition`), and `m_velM` from the change. */
  private previousAt: Pnt3D | null = null;
  private velM: Pnt3D = [0, 0, 0];
  private readonly tracer: Line;
  private readonly marker: Mesh;

  constructor() {
    this.group.name = 'shot';
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(6), 3));
    this.tracer = new Line(geometry, new LineBasicMaterial({ color: TRACER_COLOUR }));
    this.tracer.name = 'tracer';
    this.tracer.frustumCulled = false;                  // its two points move with every shot
    this.tracer.visible = false;
    this.marker = new Mesh(new OctahedronGeometry(MARKER_RADIUS), new MeshBasicMaterial({ color: MARKER_COLOUR }));
    this.marker.name = 'hit marker';
    this.marker.visible = false;
    this.group.add(this.tracer, this.marker);
  }

  /** A new map: its hull (the grid is built at the first shot) and its weapon, and the count starts again. */
  setMap(ground: GroundData | undefined, weapon: HeldWeapon | null): void {
    if (this.weapon) this.group.remove(this.weapon.object);
    this.ground = ground;
    this.grid = null;
    this.weapon = weapon;
    this.offsets = fireOffsetsPlaceholder(weapon?.points ?? []);
    if (weapon) {
      weapon.object.matrixAutoUpdate = false;
      weapon.object.visible = false;
      this.group.add(weapon.object);
    }
    this.ready = true;
    this.shots = 0;
    this.last = null;
    this.previousAt = null;
    this.velM = [0, 0, 0];
    this.tracer.visible = false;
    this.marker.visible = false;
  }

  /** W2.6: the drawn camera's kind this frame -- the held weapon is hidden in the shoulder view (`third`). */
  private viewKind: 'third' | 'aim' | 'fly' = 'fly';

  /**
   * What the frame is drawn with (W2.6, `./play`): in the shoulder view the body carries no weapon yet (the hand is
   * the carry), so the held weapon -- placed at the fire point for the first-person hold -- would float at the
   * SEAL's head; it is hidden there and shown again in the aim view and the walk's own view.
   */
  follow(_camera: unknown, kind: 'third' | 'aim' | 'fly'): void {
    this.viewKind = kind;
  }

  /** One frame: `m_velM` from the actor's motion, and the weapon at the fire point along the aim; hidden in fly mode. */
  frame(dt: number, mover: Mover): void {
    const feet = actorPosition(mover);
    if (!feet) {
      if (this.weapon) this.weapon.object.visible = false;
      this.previousAt = null;
      this.velM = [0, 0, 0];
      return;
    }
    if (this.previousAt && dt > 0) {
      const v = sub(feet, this.previousAt).map((c) => c / dt) as Pnt3D;
      const m = actorMatrix([0, 0, 0], mover.yaw);
      // Into the actor's frame: the rows are its axes, so each component is a dot with one.
      this.velM = [v[0] * m[0]! + v[2] * m[2]!, v[1], v[0] * m[8]! + v[2] * m[10]!];
    }
    this.previousAt = [feet[0], feet[1], feet[2]];
    const weapon = this.weapon;
    if (!weapon) return;
    const from = firePoint(this.state(feet, mover.yaw), this.offsets);
    const dir = aimDirection(mover.yaw, mover.pitch);
    const m = heldWeaponMatrix(from, [from[0] + dir[0], from[1] + dir[1], from[2] + dir[2]], pointOf(weapon.points, 'firepoint'));
    weapon.object.matrix.fromArray(m);
    weapon.object.matrixWorldNeedsUpdate = true;
    weapon.object.visible = this.viewKind !== 'third';
  }

  /** One shot from the mover's fire point, or null when not walking or before a map. */
  fire(mover: Mover): ShotRecord | null {
    const feet = actorPosition(mover);
    if (!this.ready || !feet) return null;
    if (!this.grid && this.ground) this.grid = groundGrid(this.ground);
    const state = this.state(feet, mover.yaw);
    const from = firePoint(state, this.offsets);
    const dir = aimDirection(mover.yaw, mover.pitch);
    const seen = this.grid ? castRay(this.grid, mover.eye, dir, SHOT_RANGE_PLACEHOLDER) : null;
    const aim: Pnt3D = seen?.point ?? [
      mover.eye[0] + dir[0] * SHOT_RANGE_PLACEHOLDER, mover.eye[1] + dir[1] * SHOT_RANGE_PLACEHOLDER, mover.eye[2] + dir[2] * SHOT_RANGE_PLACEHOLDER,
    ];
    const toward = sub(aim, from);
    const reach = Math.hypot(toward[0], toward[1], toward[2]);
    const struck = this.grid && reach > 0 ? castRay(this.grid, from, toward, reach + AIM_MARGIN) : null;
    const shot: ShotRecord = { from, to: struck?.point ?? aim, hit: struck !== null, slot: fireSlot(state) };
    this.shots++;
    this.last = shot;
    this.draw(shot);
    return shot;
  }

  stats(): { shots: number; lastShot: ShotRecord | null } {
    return { shots: this.shots, lastShot: this.last };
  }

  /** What the body reads, from the mover (the port's inputs; the rest named placeholders). */
  private state(feet: Pnt3D, yaw: number): FirePointState {
    return {
      ...VIEWER_FIRE_ARGS, ...VIEWER_ACTOR_PLACEHOLDER,
      position: [feet[0], feet[1], feet[2]], nodeMatrix: actorMatrix(feet, yaw), velM: this.velM, cachedPoint: null,
    };
  }

  private draw(shot: ShotRecord): void {
    const positions = this.tracer.geometry.getAttribute('position') as BufferAttribute;
    positions.setXYZ(0, ...shot.from);
    positions.setXYZ(1, ...shot.to);
    positions.needsUpdate = true;
    this.tracer.visible = true;
    this.marker.position.set(...shot.to);
    this.marker.visible = shot.hit;
  }
}
