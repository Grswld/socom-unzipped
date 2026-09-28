import type { PerspectiveCamera } from 'three';
import { IDENTITY, multiply, Skeleton, transformPoint, type MotionClip } from '@s2u/scene';
import { Animator, type AnimStats, type MoverSnapshot } from './animator';
import { EYE_MODEL, type LoadedBody } from './body';
import type { BodyView } from './bodyView';
import type { Pose } from './camera';
import { pressedSince, releasedSince, type Input } from './gamepad';
import type { MotionEntry } from './motionTable';
import { CROUCH_EYE_PLACEHOLDER } from './physics';
import {
  actorToWorld, ShoulderCamera, CAM_BACK_MEASURED, RIG_ROOT_Y, TETHER_STIFF_PLACEHOLDER, type CameraRig,
} from './thirdPerson';
import { EYE_HEIGHT, type WalkMode } from './walk';

/**
 * The play mode (web sprint 2, W2.2b and W2.6; ruling W2.R1): the walk mode with the body, seen over its shoulder.
 * Entering walk (`G`, the panel's switch, the pad's Start) shows the map's SEAL at the mover's feet, facing the look,
 * running the game's clips (`./animator`), and draws the frame from the game's third-person camera
 * (`./thirdPerson`); aiming (`L1`, the right mouse button) draws it from the body's eyes. Leaving hides the body. The
 * W2.1 body switch becomes **"show the body in fly mode"**: with it on, the body stays in view where the play left
 * it -- or at slot A in its bind pose, W2.1's picture, until played.
 *
 * The fly camera stays the look and the walk's eye (15.4 over the feet, W1.R2) in play: the hook's `pose()` and the
 * walk's e2e read it there. The camera the frame is drawn with is `frame`'s answer.
 */

/** Which camera draws the frame: the shoulder camera in play, the aim view, or the fly camera. */
export type ViewKind = 'third' | 'aim' | 'fly';

/**
 * Whether the body is drawn: always over the shoulder, never in the aim view -- a first-person view from the body's
 * own eyes, where the head would fill the screen; the first-person arms (`seal_fp_*`, 77 §12) are not drawn, a carry --
 * and in the fly camera only when the panel's switch asks.
 */
export function bodyVisible(kind: ViewKind, flyToggle: boolean): boolean {
  return kind === 'third' || (kind === 'fly' && flyToggle);
}

/**
 * The pad's lanes as the play mode acts on them (W2.R5; `./gamepad`'s `Input`, the pad and the touch buttons merged):
 * the jump on the press, the crouch on the release -- the game toggles the stance when the button comes up
 * (docs/PLAYTEST.md step 8, `host_crouch_shortcut.h:5-6`) -- and the aim view while the aim lane is held. The fire lane
 * is W2.4's.
 */
export function playActions(before: Input, after: Input): { jump: boolean; crouch: boolean; aim: boolean } {
  return { jump: pressedSince(before, after).includes('jump'), crouch: releasedSince(before, after).includes('crouch'), aim: after.aim };
}

/**
 * The scene skeleton of a decoded body (`@s2u/scene`'s `Skeleton`: the animator writes it, `setLocal` per part), from
 * the parts the worker sent. The model node's matrix is the identity on all 411 characters (78 §3.1); the nodes'
 * bboxes, types and flags are the skeleton reader's and not sent, so they are left empty -- nothing here reads them.
 */
export function bodySkeleton(body: LoadedBody): Skeleton {
  return new Skeleton(body.model, IDENTITY, body.parts.map((p, index) => ({
    index, name: p.name, parent: p.parent, bindLocal: Float32Array.from(p.bindLocal), bbox: new Float32Array(6), type: 0, flags: 0,
  })));
}

/**
 * The body's eyes through a pose, model space: the mean of the eye gear's origins (`character.rdr`'s offsets on the
 * head, 78 §5) carried through the posed palette -- 18.16 over the feet in the bind pose (78 §6.3, `LoadedBody.eye`).
 * Null for a body with no eye gear (a bare body: no `character.rdr`).
 */
export function eyePoint(body: LoadedBody, palette: readonly Float32Array[]): [number, number, number] | null {
  const eyes = body.fittings.filter((f) => EYE_MODEL.test(f.model) && palette[f.part]);
  if (!eyes.length) return null;
  let x = 0, y = 0, z = 0;
  for (const f of eyes) {
    const p = transformPoint(multiply(f.offset, palette[f.part]!), 0, 0, 0);
    x += p[0]; y += p[1]; z += p[2];
  }
  return [x / eyes.length, y / eyes.length, z / eyes.length];
}

/** The clips and the table as the worker read them (`./motionTable`, `PlayData`). */
export interface PlayClips { clips: MotionClip[]; table: [string, MotionEntry][] | null }

/** What `stats().camera` reports: the camera drawing, the rig it runs on, whether the disc's was read, the tether. */
export interface ViewStats {
  kind: ViewKind;
  rig: 'measured' | 'disc';
  discRig: boolean;
  tether: number;
  pose: Pose;
}

/** The mover's snapshot at rest where it stands: what the body plays in fly mode once it has been played. */
const at = (s: MoverSnapshot): MoverSnapshot => ({ ...s, vx: 0, vz: 0, vy: 0, airborne: false, landing: null });

/** A camera's pose in the fly camera's convention (yaw 0 looks down -z; degrees). */
function poseOf(camera: PerspectiveCamera): Pose {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements, p = camera.position;
  const dx = -e[8]!, dy = -e[9]!, dz = -e[10]!, n = Math.hypot(dx, dy, dz) || 1;
  return { x: p.x, y: p.y, z: p.z, yaw: (Math.atan2(-dx, -dz) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, dy / n))) * 180) / Math.PI };
}

/**
 * The play mode's state on the page: the body, its skeleton, the clips, the animator over them, the shoulder camera,
 * the aim, and the panel's switches. `frame` runs once a frame after the walk's own and answers the camera to draw with.
 */
export class Play {
  private body: BodyView | null = null;
  private loaded: LoadedBody | null = null;
  private skeleton: Skeleton | null = null;
  private clips: PlayClips | null = null;
  private animator: Animator | null = null;
  private flyToggle = false;
  /** The mover's last state in play, for the body left standing in fly mode; null until the first play. */
  private last: (MoverSnapshot & { feet: [number, number, number] }) | null = null;
  private readonly shoulder = new ShoulderCamera();
  /** The disc's `cam_back` and `cam_tether_stiff`, once read; which rig runs. */
  private discRig: CameraRig | null = null;
  private stiff: number | null = null;
  private useDisc = false;
  private aimLane = false;
  private aimForced: boolean | null = null;
  private walking = false;
  private kind: ViewKind = 'fly';
  private drawn: PerspectiveCamera | null = null;

  /** A map's body, or none: the animator is rebuilt over its skeleton (the clips are the source's, kept). */
  setBody(view: BodyView | null, body: LoadedBody | null): void {
    this.body = view;
    this.loaded = view ? body : null;
    this.skeleton = view && body ? bodySkeleton(body) : null;
    this.last = null;
    this.shoulder.reset();
    this.rebuild();
  }

  /** The source's clips and table (`playFromDisc`), or none: without them the body stands in its bind pose. */
  setClips(clips: PlayClips | null): void {
    this.clips = clips && clips.clips.length ? clips : null;
    this.rebuild();
  }

  /** The panel's body switch: the body in fly mode (W2.1's switch, turned). */
  setFlyToggle(on: boolean): void {
    this.flyToggle = on;
  }

  /** The disc's `cam_back` rig and `cam_tether_stiff` (`dynamics.rdr`, W2.R6), either null when the source has none. */
  setCameraTable(rig: CameraRig | null, stiff: number | null): void {
    this.discRig = rig;
    this.stiff = stiff;
    if (!rig) this.useDisc = false;
  }

  /** The panel's rig switch: the disc's `cam_back` (true) or the measurement; false, and the measurement, until it is read. */
  useDiscRig(on: boolean): boolean {
    this.useDisc = on && this.discRig !== null;
    return this.useDisc === on;
  }

  /** The aim lanes, held: `L1`, the right mouse button (`playActions`). */
  setAimLane(on: boolean): void {
    this.aimLane = on;
  }

  /** The hook's aim, over the lanes: on, off, or null to hand back to them. The camera kind it makes now. */
  setAimForced(on: boolean | null): ViewKind {
    this.aimForced = on;
    return this.kindNow();
  }

  /**
   * One frame: in walk mode the body at the mover's drawn feet, facing the look, its clip advanced by `dt` and its
   * pose on the bones, and the frame's camera -- over the shoulder, or at the eyes when aiming; in fly mode, once
   * played, the body left standing where the mover was, and the fly camera. Answers the camera to draw with.
   */
  frame(dt: number, walk: Pick<WalkMode, 'snapshot' | 'grid'>, fly?: PerspectiveCamera): PerspectiveCamera {
    const snap = walk.snapshot();
    if (snap && !this.walking) this.shoulder.reset();            // entering play: the camera starts on its rig
    this.walking = snap !== null;
    this.kind = this.kindNow();
    this.bodyFrame(dt, snap);
    let camera: PerspectiveCamera = fly ?? this.shoulder.camera;
    if (snap && fly) {
      this.shoulder.follow(fly);
      if (this.kind === 'aim') {
        const eye = this.eyeWorld(snap);
        this.shoulder.aimAt(eye ?? fly.position.toArray(), snap.yaw, snap.pitch);
      } else {
        this.shoulder.update(dt, {
          feet: snap.feet, yaw: snap.yaw, pitch: snap.pitch, lift: this.lift(snap), rig: this.rig(),
          stiff: this.stiff ?? TETHER_STIFF_PLACEHOLDER, grid: walk.grid(),
        });
      }
      camera = this.shoulder.camera;
    }
    this.drawn = camera;
    return camera;
  }

  /** What the clips are doing: the hook's `stats().anim`; null with no body, no clips, or before the first play. */
  animStats(): AnimStats | null {
    return this.animator && this.last ? this.animator.stats() : null;
  }

  /** The camera drawing the frame, for the hook's `stats().camera`. */
  viewStats(): ViewStats {
    const drawn = this.drawn;
    return {
      kind: this.kind, rig: this.useDisc ? 'disc' : 'measured', discRig: this.discRig !== null,
      tether: this.stiff ?? TETHER_STIFF_PLACEHOLDER,
      pose: drawn ? poseOf(drawn) : { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
    };
  }

  /** The posed root's height over the feet (the clip's), or null: the shoulder camera rides it. */
  rootY(): number | null {
    return this.animator && this.last ? this.animator.rootY() : null;
  }

  private kindNow(): ViewKind {
    if (!this.walking) return 'fly';
    return (this.aimForced ?? this.aimLane) ? 'aim' : 'third';
  }

  private rig(): CameraRig {
    return this.useDisc && this.discRig ? this.discRig : CAM_BACK_MEASURED;
  }

  /**
   * How far the rig rides up or down: the posed root over the standing root the rig was measured at (`RIG_ROOT_Y`,
   * research 17 §4.1); without clips, the walk's crouched eye below its standing one (`CROUCH_EYE_PLACEHOLDER`).
   */
  private lift(snap: MoverSnapshot): number {
    const root = this.rootY();
    if (root !== null) return root - RIG_ROOT_Y;
    return snap.crouched ? EYE_HEIGHT * (CROUCH_EYE_PLACEHOLDER - 1) : 0;
  }

  /**
   * The aim view's eye, in the world: the body's eyes through its pose (`eyePoint`; 18.16 over the feet standing in
   * the bind pose, research 78 §6.3), not the walk's 15.4 -- W1.R2's height is research 17's camera target (and, by
   * the root's 5.504, a crouched SEAL's), not an eye. Null with no eye gear: the walk's eye is the fallback.
   */
  private eyeWorld(snap: MoverSnapshot & { feet: readonly number[] }): [number, number, number] | null {
    const palette = this.skeleton?.palette();
    const eye = palette && this.loaded ? eyePoint(this.loaded, palette) : null;
    return eye && actorToWorld(snap.feet, snap.yaw, eye);
  }

  private bodyFrame(dt: number, snap: (MoverSnapshot & { feet: [number, number, number] }) | null): void {
    const view = this.body;
    if (!view) return;
    view.setVisible(bodyVisible(this.kind, this.flyToggle));
    if (snap) this.last = { ...snap, feet: [...snap.feet] };
    const mover = snap ?? (this.last && at(this.last));
    if (!mover || !this.last) return;                  // never played: W2.1's bind pose at slot A stays
    if (!snap && !view.group.visible) return;
    view.place(this.last.feet, mover.yaw);
    if (this.animator && this.skeleton) {
      this.animator.step(dt, mover);
      view.setPose(this.skeleton.local);
    }
  }

  private rebuild(): void {
    this.animator = this.skeleton && this.clips
      ? new Animator(this.skeleton, this.clips.clips, this.clips.table && new Map(this.clips.table))
      : null;
  }
}

