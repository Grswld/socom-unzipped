import { Box3, BufferAttribute, CapsuleGeometry, Group, Mesh, SphereGeometry, Vector3, type BufferGeometry } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { uniform, vec4, vertexColor } from 'three/tsl';

/**
 * The stand-in body (web sprint 2, W2.3; the spec's W2.R3): a mannequin at the SEAL's measured proportions, drawn
 * on the walker's feet, facing the body's yaw, in the world's own shading path. The real model (`CLIB_GEO.ZED`'s
 * skinned `CMesh` chain) and its animations (`MPZANIM.ZAR`) are web sprint 3's first candidate; this is the size
 * and the place, measured.
 *
 * **The height: 19.6 units over the feet (1.96 m at `MetersPerUnit 0.1`), by two routes that share one number.**
 *
 * - **The skeleton (the console dump `logs/parity/spawn_pcsx2.rdram`, research 17 section 8).** The instance at
 *   `actor+0x170` holds a count (32, `+0x60`) and a pointer to a table of 32 *node pointers* (`+0x64`, `0x1715940`
 *   for the player), not an array of nodes: 26 live, six null. Each node is one `CZBodyPart` (reCOM
 *   `research/recom/src/gamez/zBody/zbody.h:54-71`; SOCOM II's field order, confirmed on the dump): `+0x00` vec3
 *   local translation, `+0x0c` its `zdb::CNode` (whose first 64 bytes are the local matrix, and whose `+0x90`
 *   points to the node's name), `+0x10` saved translation, `+0x1c` the parent part, `+0x20` quat (x, y, z, w; the
 *   CNode's matrix is exactly this quat's rotation, row-vector convention, on all 26), `+0x30` saved quat, `+0x40`
 *   u16 id. The names are reCOM's `CSeal` parts (`research/recom/src/gamez/zSeal/zseal.h:534-567`): `skel_root`,
 *   `hips`, `spinelo`, `spinehi`, `neck`, `head`, `l/rscap`, `l/rshoulder_wgt`, `l/rbicep`, `l/rforearm`,
 *   `l/rhand`, `l/rthigh`, `l/rcalf`, `l/rfoot`, `l/rtoe`, `aimnodes`, `rifle`; no eyeball or eyelid part is live.
 *   Composing parent-first from the root (`t * R(q)` under the parent) puts, **on the upright standing actors of
 *   the dump** (root Y 11.08-11.57; the SEALs' own skeleton, the bone lengths the player's within 0.7 -- the hips
 *   and shoulders differ that much; a fifth standing actor is bent, its head at 15.03, and is left out), the `head`
 *   joint at **17.28-17.48 (17.37 at the bind root 11.484)**, the `neck` at 16.50, the shoulder joints at 15.4-15.7
 *   and 4.0 apart, the `hips` at 11.48, the knees (`calf`) at 5.7-5.9, the ankles (`foot`) at 1.15, the toes at
 *   0.3-0.5 -- the model's origin is the soles. The player at spawn is **crouched** (root 5.504, under the 9.0
 *   stance test research 17 section 8 cites; right knee at 0.54, kneeling): its `head` joint composes to 10.16.
 * - **The console frame (`scripts/parity/refs/console_spawn_slot8.png`, 640x448, the SEAL's back).** The camera is
 *   research 17 section 1's at spawn: the smoothed eye (939.439, -126.264, 832.160), the target (939.439, -130.489,
 *   858.341), the projection the map's half-angles `fov (0.6109 0.4276)` over 320 and 224 pixels, screen right
 *   world -x (the view runs +z). The player (939.4391, -145.8672, 857.0661) is 27.71 units from that eye along the
 *   view (24.91 level, 19.60 below it; 26.96 from the unsmoothed `cam+0x2c` eye). Projecting the dump's composed
 *   skeleton through it (the actor matrix at `actor+0x80` turns the model half a turn) lands the `head` joint at
 *   x 348.3 where the frame's head is centred at 351 -- the camera, the convention and the skeleton agree. The
 *   helmet's top row is **269** (the first dark row over the ground, x 338-352). Back-projected onto the vertical
 *   through the feet it is 13.21 over them (the crude route: it assumes the crown above the feet); onto the
 *   vertical through the head joint (29.24 deep: the crouched SEAL leans forward) it is **12.39**, which is
 *   **2.23 above the head joint** and is the crouch height used here. [unsmoothed eye: 13.28 and 12.46.]
 * - **Standing = the standing head joint + the head's measured 2.23 = 17.37 + 2.23 = 19.6.** The frame gives the
 *   head (joint to crown, the SEAL's beanie included), the dump gives the standing joint. Assumptions: the crown
 *   is above the head joint in both stances (the head upright; a crown one unit deeper would lower the crouch
 *   number by 0.26); the standing actors' pose is the player's stand (same skeleton, root within 0.1 of the bind);
 *   the soles are at the model origin (the toe joints 0.3-0.5 over it). Research 17 section 1 has the actor's
 *   feet 0.504 over the collision hit; the stand-in stands on the viewer's floor and does not add it. Cross-check:
 *   the neck (C7) at 16.50 is 0.84 of 19.6, a human's 0.85; the knees 0.30 (human 0.29). Row 269 +/- 1 pixel is
 *   +/- 0.06; the whole is good to about +/- 0.3.
 * - **The width: 5.1** -- the frame's body at the shoulder rows (318-330) spans x 293-375, 82 pixels at the
 *   shoulders' 28.3 depth, 0.0618 units a pixel. The skeleton's shoulder joints are 3.8-4.0 apart; a deltoid's
 *   0.6 each side makes the same 5.1. (Walls still take the body radius 3.5, W1.R2.)
 * - **The eye: `HEAD_HEIGHT` 18.3 [estimate].** No eyeball part is live on the dump (`m_leyeball`/`m_reyeball`,
 *   `zseal.h:563-564`, `CSeal::SetupEyes`, `zseal.h:347`), so the eye is the head's: the anthropometric eye height
 *   0.936 of the stature (18.35), which lies 0.9 over the head joint and 1.3 under the crown.
 * - **Prone: 3.0 over the feet [estimate]** -- the torso's depth lying on the floor; no prone actor is on the dump.
 *
 * **The stride** is a model, not the animation: a full cycle (two steps) is `height * (0.55 + 0.025 * speed)` units
 * long -- a human's 0.8 of stature at a walk (1.4 m/s) and 2.2 at a run (6.5 m/s: `READERC.ZAR/motion.rdr`'s
 * `seal_run` `max_velocity`, 65 units/s) -- and the cadence is the speed over it: 1.52 cycles a second at 65
 * [estimate]. The speed is the feet's own, frame to frame, so `walk.ts` is not asked for it.
 *
 * **The shading** is the world's untextured path (`world.ts`'s `SHADED_PLAIN`): the vertex colour clamped, times
 * the brighten `1 + FIX/128` as a uniform (`./lighting`), fogged by the scene's GS fog node (`./fog`: the material's
 * `fog` flag, as a world draw with `PRIM.FGE` set). The colours are the console frame's own, sampled on the SEAL and
 * divided by the frame's brighten of 1.727 (FIX 93): pack (23.6, 26.5, 26.9), camouflage sleeve (28.5, 31.5, 25.4),
 * beanie (14.1, 13.6, 12.6), trousers (17.2, 19.9, 18.9) -- dark, as the SEAL in that shade is.
 *
 * **First person.** W2.1's walk is seen in the third person, the body whole; its first person (`V`) puts the eye at
 * `HEAD_HEIGHT` and hides the body (`main.ts`). Should an eye be within the body's column all the same (the body
 * radius 3.5 around the feet, from the feet to the crown), the upper body -- torso, neck, head, arms -- is not drawn
 * and the legs are; from outside, it is drawn whole.
 */

/** The crown over the feet, standing (above: the dump's head joint 17.37 + the frame's head 2.23). */
export const STANDING_HEIGHT = 19.6;
/** The crown over the feet, crouched: the console frame at spawn, the SEAL crouched (above). */
export const CROUCH_HEIGHT = 12.4;
/** The body's top lying prone [estimate: the torso's depth on the floor]. */
export const PRONE_HEIGHT = 3;
/** The eye over the feet, standing [estimate: 0.936 of the stature], for the first-person switch (W2.1). */
export const HEAD_HEIGHT = 18.3;
/** The body's width at the shoulders, arms in (the console frame). */
export const SHOULDER_WIDTH = 5.1;

export type Stance = 'stand' | 'crouch' | 'prone';

/** The dump's standing skeleton (above), over the feet: the hips, and the hip joints under them. */
const HIPS = 11.48, HIP_DROP = 11.48 - 9.83, HIP_SPREAD = 1.0;
/** The crouch's hips: the player's root at spawn, 5.504 (research 17 section 1). */
const CROUCH_HIPS = 5.504;
/** The torso over the hips to the neck's base (16.50), and the shoulder joints (15.5) and their half-span. */
const NECK_BASE = 16.5 - HIPS, SHOULDER = 15.5 - HIPS;
const HEAD_R = 1.2, HEAD_CENTRE = STANDING_HEIGHT - HEAD_R - HIPS;
const TORSO_DEPTH = 1.5, ARM_R = 0.6;
const TORSO_HALF_WIDTH = SHOULDER_WIDTH / 2 - ARM_R;
/** Upper arm, forearm and hand: `bicep` 3.37 + `forearm` 2.83 + the hand. */
const ARM_LENGTH = 6.2;
/** The `thigh`-to-`calf` bone (4.33) and the shin to the sole (the knee's 5.8 standing, the leg bent a little). */
const THIGH = 4.33, THIGH_R = 0.8, SHIN = 5.6, SHIN_R = 0.7;
/** Prone: the hips at the torso's depth, so its back is `PRONE_HEIGHT` up. */
const PRONE_HIPS = PRONE_HEIGHT - TORSO_DEPTH;
/** The swing: the hips' largest angle (radians), and how much of it each stance keeps [estimates]. */
const MAX_SWING = 0.6;
const SWING_SCALE: Record<Stance, number> = { stand: 1, crouch: 0.5, prone: 0.25 };
/** A frame's move faster than this is a placement (a map load, the hook), not a stride. */
const PLACEMENT_SPEED = 300;
/** The colours (above), 0..1 before the brighten. */
const PACK = rgb(23.6, 26.5, 26.9), SLEEVE = rgb(28.5, 31.5, 25.4), BEANIE = rgb(14.1, 13.6, 12.6), TROUSERS = rgb(17.2, 19.9, 18.9);

function rgb(r: number, g: number, b: number): [number, number, number] {
  const k = 1 / (1.7266 * 255);
  return [r * k, g * k, b * k];
}

/** The body's forward on the ground, (x, z), at a yaw in degrees: the camera looks down its own -z (`walk.ts`). */
export function bodyForward(yawDegrees: number): [number, number] {
  const yaw = (yawDegrees * Math.PI) / 180;
  return [-Math.sin(yaw), -Math.cos(yaw)];
}

/** Stride cycles a second at a speed in units/s (the model above); 0 standing still. */
export function strideCadence(speed: number): number {
  if (!(speed > 0)) return 0;
  return speed / (STANDING_HEIGHT * (0.55 + 0.025 * speed));
}

/**
 * The hip and knee angles (radians about the body's x; positive swings the limb forward) that put the sole straight
 * under the hip joint `hip` over the floor: two-bone IK, the knee forward. The shin's end is its cap's centre, so
 * the rounded sole touches the floor at any tilt.
 */
function restLeg(hip: number): { hip: number; knee: number } {
  const a = THIGH, b = SHIN - SHIN_R, h = hip - SHIN_R;
  if (h >= a + b) return { hip: 0, knee: 0 };
  const alpha = Math.acos(Math.min(1, (a * a + h * h - b * b) / (2 * a * h)));
  const beta = Math.acos(Math.min(1, (b * b + h * h - a * a) / (2 * b * h)));
  return { hip: alpha, knee: -(alpha + beta) };
}

/** A capsule from its origin down to -`length` (caps included), coloured. */
function limb(radius: number, length: number, colour: [number, number, number]): BufferGeometry {
  const g = new CapsuleGeometry(radius, Math.max(0, length - 2 * radius), 4, 12);   // 12 round: a vertex on each axis, so the bounds are the radius
  g.translate(0, -length / 2, 0);
  return paint(g, colour);
}

function paint(g: BufferGeometry, [r, gr, b]: [number, number, number]): BufferGeometry {
  const n = g.getAttribute('position').count;
  const colours = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) colours.set([r, gr, b, 1], i * 4);
  g.setAttribute('color', new BufferAttribute(colours, 4));
  return g;
}

export interface BodyState {
  visible: boolean;
  /** The body's top over the feet it stands on. */
  height: number;
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
}

/**
 * The mannequin. `main.ts` adds `object` to the scene, calls `update` with the walker's feet, the camera's yaw and
 * position each frame, and `setVisible` with the walk mode. `setStance` is for the walk's stances (W2.2b).
 */
export class Body {
  readonly object = new Group();
  private readonly pelvis = new Group();
  private readonly upper = new Group();
  private readonly hips: [Group, Group] = [new Group(), new Group()];
  private readonly knees: [Group, Group] = [new Group(), new Group()];
  private readonly arms: [Group, Group] = [new Group(), new Group()];
  private readonly head: Mesh;
  private readonly brighten = uniform(1);
  private stance: Stance = 'stand';
  private asked = false;
  private feet: [number, number, number] | null = null;
  private lastSpeed = 0;
  private cycle = 0;
  private upperOn = true;

  /** `brighten` reads the frame's `1 + FIX/128` (`./lighting`'s `brightenOf`) each update. */
  constructor(private readonly brightenOf: () => number = () => 1) {
    const material = new MeshBasicNodeMaterial();
    material.vertexColors = false;                 // the graph reads the attribute itself, as the world's does
    const plain = vec4(vertexColor()).clamp(0, 1);
    material.colorNode = vec4(plain.rgb.mul(this.brighten), 1);
    material.fog = true;                           // the scene's GS fog, as a world draw with FGE set

    const torso = new Mesh(limb(TORSO_DEPTH, NECK_BASE + HIP_DROP, PACK), material);
    torso.position.y = NECK_BASE;
    torso.scale.x = TORSO_HALF_WIDTH / TORSO_DEPTH;
    const neck = new Mesh(limb(0.55, 1.6, SLEEVE), material);
    neck.position.y = NECK_BASE + 1.3;
    this.head = new Mesh(paint(new SphereGeometry(HEAD_R, 12, 8), BEANIE), material);
    this.head.position.y = HEAD_CENTRE;
    this.upper.add(torso, neck, this.head);
    for (const [i, side] of [[0, -1], [1, 1]] as const) {
      const arm = this.arms[i];
      arm.position.set(side * TORSO_HALF_WIDTH, SHOULDER, 0);
      arm.add(new Mesh(limb(ARM_R, ARM_LENGTH, SLEEVE), material));
      this.upper.add(arm);
      const hip = this.hips[i], knee = this.knees[i];
      hip.position.set(side * HIP_SPREAD, -HIP_DROP, 0);
      hip.add(new Mesh(limb(THIGH_R, THIGH, TROUSERS), material));
      knee.position.y = -THIGH;
      knee.add(new Mesh(limb(SHIN_R, SHIN, TROUSERS), material));
      hip.add(knee);
      this.pelvis.add(hip);
    }
    this.pelvis.add(this.upper);
    this.object.add(this.pelvis);
    this.object.visible = false;
    this.pose();
  }

  setStance(stance: Stance): void {
    this.stance = stance;
    this.pose();
  }

  /** Drawn when asked and stood somewhere (`main.ts`: in walk mode). */
  setVisible(on: boolean): void {
    this.asked = on;
    this.object.visible = on && this.feet !== null;
  }

  /**
   * One frame: stand on `feet` (null in fly mode: hidden), face `yawDegrees`, swing the legs at the feet's own speed,
   * and leave the upper body undrawn while `eye` is inside the body's column.
   */
  update(feet: readonly [number, number, number] | null, yawDegrees: number, dt: number, eye: { x: number; y: number; z: number } | readonly [number, number, number]): void {
    if (!feet) {
      this.feet = null;
      this.object.visible = false;
      this.lastSpeed = 0;
      return;
    }
    const was = this.feet;
    this.feet = [feet[0], feet[1], feet[2]];
    const moved = was && dt > 0 ? Math.hypot(feet[0] - was[0], feet[2] - was[2]) / dt : 0;
    this.lastSpeed = moved > PLACEMENT_SPEED ? 0 : moved;
    this.cycle = (this.cycle + 2 * Math.PI * strideCadence(this.lastSpeed) * dt) % (2 * Math.PI);
    this.object.position.set(feet[0], feet[1], feet[2]);
    this.object.rotation.set(0, (yawDegrees * Math.PI) / 180, 0);
    this.brighten.value = this.brightenOf();
    const [ex, ey, ez] = Array.isArray(eye) ? eye : [(eye as Vector3).x, (eye as Vector3).y, (eye as Vector3).z];
    const inside = Math.hypot(ex - feet[0], ez - feet[2]) < 3.5 && ey >= feet[1] && ey <= feet[1] + STANDING_HEIGHT + 1;
    this.upperOn = !inside;
    this.upper.visible = this.upperOn;
    this.object.visible = this.asked;
    this.pose();
  }

  /** The hook's view (`hook.ts`): drawn or not, the top over the feet, the world bounds. */
  state(): BodyState {
    const visible = this.object.visible;
    if (!this.feet) return { visible, height: 0, bounds: null };
    this.object.updateMatrixWorld(true);
    const box = new Box3().setFromObject(this.object, true);
    return {
      visible,
      height: box.max.y - this.feet[1],
      bounds: { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] },
    };
  }

  /** The body's forward on the ground, (x, z), from its own turn. */
  forward(): [number, number] {
    const f = new Vector3(0, 0, -1).applyQuaternion(this.object.quaternion);
    return [f.x, f.z];
  }

  /** The head sphere in world space. */
  headSphere(): { centre: [number, number, number]; radius: number } {
    this.object.updateMatrixWorld(true);
    const c = this.head.getWorldPosition(new Vector3());
    return { centre: [c.x, c.y, c.z], radius: HEAD_R };
  }

  /** The feet's speed over the last frame, units/s. */
  speed(): number {
    return this.lastSpeed;
  }

  /** The stride's phase, radians. */
  phase(): number {
    return this.cycle;
  }

  /** The left and right hip angles, radians (positive: forward). */
  legAngles(): [number, number] {
    return [this.hips[0].rotation.x, this.hips[1].rotation.x];
  }

  /** Whether the torso, neck, head and arms are drawn (not while the eye is inside them). */
  upperShown(): boolean {
    return this.upperOn;
  }

  /** The stance's pose, plus the stride's swing. */
  private pose(): void {
    const hipsY = this.stance === 'stand' ? HIPS : this.stance === 'crouch' ? CROUCH_HIPS : PRONE_HIPS;
    this.pelvis.position.y = hipsY;
    this.pelvis.rotation.x = this.stance === 'prone' ? -Math.PI / 2 : 0;
    // Crouched, the torso leans until the crown is at the measured 12.4.
    const lean = this.stance === 'crouch' ? Math.acos((CROUCH_HEIGHT - HEAD_R - hipsY) / HEAD_CENTRE) : 0;
    this.upper.rotation.x = -lean;
    const rest = this.stance === 'prone' ? { hip: 0, knee: 0 } : restLeg(hipsY - HIP_DROP);
    const stride = strideCadence(this.lastSpeed) > 0 ? this.lastSpeed / strideCadence(this.lastSpeed) : 0;
    const amp = Math.min(MAX_SWING, Math.atan2(stride / 4, HIPS - HIP_DROP)) * SWING_SCALE[this.stance];
    const s = Math.sin(this.cycle), c = Math.cos(this.cycle);
    for (const [i, sign] of [[0, 1], [1, -1]] as const) {
      this.hips[i].rotation.x = rest.hip + sign * amp * s;
      this.knees[i].rotation.x = rest.knee - 1.2 * amp * Math.max(0, sign * c);
      this.arms[i].rotation.x = lean - sign * 0.8 * amp * s;   // hanging plumb, swinging against the legs
    }
  }
}
