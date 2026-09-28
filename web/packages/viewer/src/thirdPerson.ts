import { PerspectiveCamera, Vector3 } from 'three';
import { rdrGet, type RdrNode } from '@s2u/archive';
import { cellsCovering, modelGate, type Grid, type WorldPoly } from '@s2u/scene';
import type { Pose } from './camera';

/**
 * The game's third-person camera (web sprint 2, W2.6; ruling W2.R1: over the shoulder by default, first-person aim)
 * and the aim view.
 *
 * - **The rig.** reCOM's `CCameraParams` (`zCamera/zcam.h:63-64`), filled by `CharacterDynamics::Load` from
 *   `dynamics.rdr`'s `cam_<view>_side/_height/_dist/_aim` (`zCharacter/char_dyn.cpp:261-280`): an offset in the actor's
 *   frame -- x to its right, y up, z behind -- and an aim point in the same frame, both carried through the actor's
 *   matrix and looked along (`zCamera/camera.cpp:216-231`). The default is **the measurement**, `CAM_BACK_MEASURED`:
 *   the spec's section 6 records that the disc's `cam_back` alone does not reproduce research 18's ring; the disc's
 *   triple, read at run time (W2.R6), is the switch.
 * - **The ride.** Research 17 §4.1 traced the camera's target at the root node's height plus 10 (`FUN_0029a950`) and
 *   its eye moving with it, so the rig -- measured on a standing SEAL, root at `RIG_ROOT_Y` -- rides the posed root:
 *   a crouch lowers it (to research 17 §1's 15.38 target within 0.13), a run lowers it a little.
 * - **The look.** The rig turns with the look's yaw; the look's pitch orbits the eye about the aim point (the reading:
 *   the game pitches this camera with the right stick, research 18 "RUP 2 s: camera pitches up to the sky", and how
 *   is not in the bodies on hand), between `ORBIT_MIN_DEG` and `ORBIT_MAX_DEG`.
 * - **The tether.** `cam_tether_stiff` (+0x15c) as the part of the gap closed each 60 Hz tick: the reading, the field's
 *   name read as a spring's stiffness (1 rigid). reCOM has the field (`zchar.h:233`) and not the code that reads it.
 * - **The pull-in.** A ray from the aim point to the camera through the hull's polygons (`castRayForCamera`, the probe's
 *   own set): the camera stands `CAMERA_MARGIN_PLACEHOLDER` short of the first one met.
 * - **The aim view.** First person at the body's eye (`./play`, `eyePoint`), along the look.
 */

/** A camera rig, the actor's frame: its forward is -z, so `dist` is behind it and an aim's -z ahead of it. */
export interface CameraRig {
  side: number;
  height: number;
  dist: number;
  aim: readonly [number, number, number];
}

/**
 * The measured rig, the default (W2.R2: a measurement named as one). The eye 25 over the feet on a 23.1 ring behind
 * them: the 40 online sweep rows sit exactly 25.000 over their floor on research 18's 23.1-unit orbit ring (web sprint
 * 1's spec, section 6, W1.5; research 18's calibration table, orbit radius mean 23.09). The aim is research 17 §4.1's
 * row #0 target, local (1.460, 21.485, -1.273) with its x -- the root's own sideways offset in the stand clip -- dropped,
 * as the body's root is stood over the feet (`./animator`). The same row's eye, (2.808, 25.452, 23.315), agrees.
 */
export const CAM_BACK_MEASURED: Readonly<CameraRig> = Object.freeze({ side: 0, height: 25, dist: 23.1, aim: Object.freeze([0, 21.485, -1.273] as const) });

/** The root node's height the measured rig was taken at: research 17 §4.1 row #0, a standing SEAL's 11.4845. */
export const RIG_ROOT_Y = 11.4845;

/** PLACEHOLDER (W2.R2): the orbit's bounds, degrees of elevation over the aim point; the viewer's, no source. */
export const ORBIT_MIN_DEG = -60;
export const ORBIT_MAX_DEG = 75;

/** PLACEHOLDER (W2.R2): the tether before the disc's `cam_tether_stiff` is read -- rigid. No source. */
export const TETHER_STIFF_PLACEHOLDER = 1;
/** PLACEHOLDER (W2.R2): a gap past this many units (a new map, a teleport, a hook's pose) is jumped, not followed. */
export const TETHER_SNAP_PLACEHOLDER = 100;
/** PLACEHOLDER (W2.R2): how far short of the hull the pulled-in camera stands, units. No source. */
export const CAMERA_MARGIN_PLACEHOLDER = 1;

/** The tick the tether's stiffness is per: `CGame::Tick` at 60 Hz (web/docs/research/71 section 1.5). */
const TICK = 1 / 60;

type Vec3 = [number, number, number];
const deg = Math.PI / 180;

/** A number a record holds under `key`, or null. */
function numberAt(rdr: RdrNode, key: string): number | null {
  const v = rdrGet(rdr, key);
  if (typeof v !== 'string') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A rig out of `dynamics.rdr` by the file's names -- `<prefix>_side`, `_height`, `_dist` and the three-number `_aim`
 * (reCOM `char_dyn.cpp:261-280`) -- or null when any is missing. Names only: the values stay the file's (W2.R6).
 */
export function readCameraRig(rdr: RdrNode, prefix: string): CameraRig | null {
  const side = numberAt(rdr, `${prefix}_side`), height = numberAt(rdr, `${prefix}_height`), dist = numberAt(rdr, `${prefix}_dist`);
  const aim = rdrGet(rdr, `${prefix}_aim`);
  if (side === null || height === null || dist === null || !Array.isArray(aim) || aim.length !== 3) return null;
  const a = aim.map((v) => (typeof v === 'string' ? Number(v) : NaN));
  if (!a.every(Number.isFinite)) return null;
  return { side, height, dist, aim: [a[0]!, a[1]!, a[2]!] };
}

/**
 * A point in the actor's frame (x right, y up, z behind: the model's own, which faces -z) into the world, the actor's
 * feet at `feet` and its facing the look's `yaw` degrees -- three's turn about y, as the body is placed (`./bodyView`).
 */
export function actorToWorld(feet: readonly number[], yaw: number, v: Vec3): Vec3 {
  const c = Math.cos(yaw * deg), s = Math.sin(yaw * deg);
  return [feet[0]! + v[0] * c + v[2] * s, feet[1]! + v[1], feet[2]! - v[0] * s + v[2] * c];
}

/**
 * The rig in the world: the eye and the aim point for an actor at `feet` facing the look's `yaw`, the look's `pitch`
 * orbiting the eye about the aim (looking up lowers the camera, the distance kept, the elevation clamped), both
 * lifted by `lift` -- the posed root's height over `RIG_ROOT_Y`.
 */
export function rigView(feet: readonly number[], yaw: number, pitch: number, rig: CameraRig, lift: number): { eye: Vec3; aim: Vec3 } {
  const [ax, ay, az] = rig.aim;
  const oy = rig.height - ay, oz = rig.dist - az;
  const r = Math.hypot(oy, oz);
  const e = Math.min(ORBIT_MAX_DEG * deg, Math.max(ORBIT_MIN_DEG * deg, Math.atan2(oy, oz) - pitch * deg));
  return {
    eye: actorToWorld(feet, yaw, [rig.side, ay + r * Math.sin(e) + lift, az + r * Math.cos(e)]),
    aim: actorToWorld(feet, yaw, [ax, ay + lift, az]),
  };
}

/**
 * The tether: from `from` toward `to`, keeping `(1 - stiff)` of the gap each 60 Hz tick, in closed form so the cut of
 * the time does not matter. No `from`, or a gap past `TETHER_SNAP_PLACEHOLDER`: straight to `to`.
 */
export function tether(from: readonly number[] | null, to: readonly number[], stiff: number, dt: number): Vec3 {
  if (!from) return [to[0]!, to[1]!, to[2]!];
  const gx = from[0]! - to[0]!, gy = from[1]! - to[1]!, gz = from[2]! - to[2]!;
  if (Math.hypot(gx, gy, gz) > TETHER_SNAP_PLACEHOLDER) return [to[0]!, to[1]!, to[2]!];
  const keep = Math.pow(1 - Math.min(1, Math.max(0, stiff)), Math.max(0, dt) / TICK);
  return [to[0]! + gx * keep, to[1]! + gy * keep, to[2]! + gz * keep];
}

/** Where a segment `o + t d` crosses triangle (a, b, c), as `t`, or null (Moller-Trumbore, either face). */
function crossTriangle(o: Vec3, d: Vec3, p: Float32Array, a: number, b: number, c: number): number | null {
  const e1x = p[b]! - p[a]!, e1y = p[b + 1]! - p[a + 1]!, e1z = p[b + 2]! - p[a + 2]!;
  const e2x = p[c]! - p[a]!, e2y = p[c + 1]! - p[a + 1]!, e2z = p[c + 2]! - p[a + 2]!;
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const sx = o[0] - p[a]!, sy = o[1] - p[a + 1]!, sz = o[2] - p[a + 2]!;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/**
 * The first polygon of the hull the segment from `from` to `to` crosses, as the fraction of the segment, or null:
 * the collision polygons of every grid cell the segment's footprint covers, each model through the probe's gate
 * (`modelGate`), each polygon as a fan. Every polygon counts, `m_cameratype`'s bit-18 volumes too -- the probe skips
 * them (research 23 section 1.1) and what they are to the camera is not settled; the reading is that a field named for
 * the camera is the camera's.
 *
 * Named for the camera so it does not collide with the weapon's ray (W2.4, `castRay` beside the probe), which the
 * sprint tree may carry by the time this merges.
 */
export function castRayForCamera(grid: Grid, from: readonly number[], to: readonly number[]): number | null {
  const o: Vec3 = [from[0]!, from[1]!, from[2]!];
  const d: Vec3 = [to[0]! - o[0], to[1]! - o[1], to[2]! - o[2]];
  const box = { minX: Math.min(o[0], to[0]!), maxX: Math.max(o[0], to[0]!), minZ: Math.min(o[2], to[2]!), maxZ: Math.max(o[2], to[2]!) };
  const minY = Math.min(o[1], to[1]!), maxY = Math.max(o[1], to[1]!);
  const seen = new Set<WorldPoly>();
  let best: number | null = null;
  for (const cell of cellsCovering(grid, box)) {
    for (const atom of cell.atoms) {
      const object = atom.object;
      if (object.kind !== 'collision' || !modelGate(object.owner)) continue;
      const f = object.footprint;
      if (f.maxX < box.minX || f.minX > box.maxX || f.maxZ < box.minZ || f.minZ > box.maxZ) continue;
      for (const poly of object.polys) {
        if (seen.has(poly)) continue;
        seen.add(poly);
        const p = poly.points;
        let lo = Infinity, hi = -Infinity;
        for (let i = 1; i < p.length; i += 3) { lo = Math.min(lo, p[i]!); hi = Math.max(hi, p[i]!); }
        if (hi < minY || lo > maxY) continue;
        for (let k = 2; k < poly.ptcount; k++) {
          const t = crossTriangle(o, d, p, 0, 3 * (k - 1), 3 * k);
          if (t !== null && t >= 0 && t <= 1 && (best === null || t < best)) best = t;
        }
      }
    }
  }
  return best;
}

/**
 * The camera pulled in along the ray from the aim to the eye: to the hit at fraction `t`, less the margin, never past
 * the aim; the eye itself when nothing was hit.
 */
export function pullIn(aim: readonly number[], eye: readonly number[], t: number | null, margin = CAMERA_MARGIN_PLACEHOLDER): Vec3 {
  const dx = eye[0]! - aim[0]!, dy = eye[1]! - aim[1]!, dz = eye[2]! - aim[2]!;
  const length = Math.hypot(dx, dy, dz);
  if (t === null || length < 1e-9) return [eye[0]!, eye[1]!, eye[2]!];
  const keep = Math.max(0, t * length - margin) / length;
  return [aim[0]! + dx * keep, aim[1]! + dy * keep, aim[2]! + dz * keep];
}

/** What the shoulder camera is placed by each frame. */
export interface ShoulderInput {
  /** The actor's feet as drawn, the look (degrees), and the posed root's lift over `RIG_ROOT_Y`. */
  feet: readonly number[]; yaw: number; pitch: number; lift: number;
  rig: CameraRig;
  /** The tether's stiffness: the disc's `cam_tether_stiff`, else `TETHER_STIFF_PLACEHOLDER`. */
  stiff: number;
  /** The hull the pull-in casts through, or none. */
  grid: Grid | null;
}

/**
 * The camera the play mode draws with: over the shoulder (`update`) or at the eye (`aimAt`), with the fly camera's
 * projection (`follow`: its field of view -- the map's own, and the boost's widening -- its aspect and its planes).
 */
export class ShoulderCamera {
  readonly camera = new PerspectiveCamera();
  private smoothed: Vec3 | null = null;

  constructor() {
    this.camera.rotation.order = 'YXZ';
  }

  follow(source: PerspectiveCamera): void {
    const c = this.camera;
    if (c.fov === source.fov && c.aspect === source.aspect && c.near === source.near && c.far === source.far) return;
    c.fov = source.fov; c.aspect = source.aspect; c.near = source.near; c.far = source.far;
    c.updateProjectionMatrix();
  }

  /** Over the shoulder: the rig, tethered, pulled in off the hull, looking at the aim point. */
  update(dt: number, input: ShoulderInput): void {
    const { eye, aim } = rigView(input.feet, input.yaw, input.pitch, input.rig, input.lift);
    this.smoothed = tether(this.smoothed, eye, input.stiff, dt);
    const at = pullIn(aim, this.smoothed, input.grid ? castRayForCamera(input.grid, aim, this.smoothed) : null);
    this.camera.position.set(at[0], at[1], at[2]);
    if (Math.hypot(aim[0] - at[0], aim[1] - at[1], aim[2] - at[2]) > 1e-6) this.camera.lookAt(aim[0], aim[1], aim[2]);
    else this.camera.rotation.set(input.pitch * deg, input.yaw * deg, 0, 'YXZ');
  }

  /** The aim view: first person at `eye`, along the look. The tether keeps the shoulder's place for the way back. */
  aimAt(eye: readonly number[], yaw: number, pitch: number): void {
    this.camera.position.set(eye[0]!, eye[1]!, eye[2]!);
    this.camera.rotation.set(pitch * deg, yaw * deg, 0, 'YXZ');
  }

  /** Forgets where the camera was: the next `update` stands it at the rig outright (entering play, a new map). */
  reset(): void {
    this.smoothed = null;
  }

  /** The camera as a pose, the fly camera's convention (yaw 0 looks down -z; degrees). */
  pose(): Pose {
    const p = this.camera.position, d = this.camera.getWorldDirection(new Vector3());
    return { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(-d.x, -d.z) / deg, pitch: Math.asin(Math.max(-1, Math.min(1, d.y))) / deg };
  }
}
