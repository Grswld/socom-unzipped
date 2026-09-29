import type { Group, Object3D, PerspectiveCamera } from 'three';
import { IDENTITY, multiply, Skeleton, transformPoint, type MotionClip, type Pnt3D, type WeaponPoint } from '@s2u/scene';
import { Animator, type AnimEvent, type AnimStats, type MoverSnapshot } from './animator';
import { EYE_MODEL, type LoadedBody } from './body';
import type { BodyView } from './bodyView';
import type { Pose } from './camera';
import type { FireEvent } from './fire';
import { pressedSince, releasedSince, type Input } from './gamepad';
import { HELD_ITEM, heldSkeleton, muzzleOf, muzzlePoint } from './heldItem';
import type { MotionEntry } from './motionTable';
import type { MoverActionName, Stance, WalkMode } from './walk';
import { STILL_CLIPS, WeaponPose, type WeaponPoseStats } from './weaponPose';
import { WeaponRaise, type RaiseStats } from './weaponRaise';

/**
 * The play mode (web sprint 2, W2.2b; ruling W2.R1): the walk mode with the body. Entering walk (`G`, the panel's
 * switch, the pad's Start) shows the map's SEAL at the mover's feet, facing the body's yaw, running the game's clips
 * (`./animator`). The frame is drawn from the walk's own camera -- the game's third-person camera
 * (`./playerCamera`, `FUN_0029a950`; it replaced the cloud sprint's measured shoulder rig at the merge of the two
 * sprint 2s) -- and aiming (`L1`, the right mouse button) holds its first-person view. Leaving hides the body. The
 * W2.1 body switch is **"show the body in fly mode"**: with it on, the body stays in view where the play left it --
 * or at slot A in its bind pose, W2.1's picture, until played.
 */

/** Which view draws the frame: the game's third-person camera in play, the aim (first person), or the fly camera. */
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
 * is the trigger's (`main.ts`), and the stance lane's tap and hold are `StanceButton`'s.
 */
export function playActions(before: Input, after: Input): { jump: boolean; crouch: boolean; aim: boolean } {
  return { jump: pressedSince(before, after).includes('jump'), crouch: releasedSince(before, after).includes('crouch'), aim: after.aim };
}

/**
 * How long Triangle is held before it means prone, seconds. A guess: the game does not time the button, it reads its
 * pressure (a light press toggles crouch at release, a full press goes prone at once; `host_crouch_shortcut.h:4-7`,
 * docs/KNOWN.md R139), and a browser pad's button is only on or off, so the owner's rule (2026-09-28: tap crouches,
 * hold goes prone) needs a length, and none is in the repository. 0.4 s is a comfortable tap's ceiling.
 */
export const STANCE_HOLD_S_PLACEHOLDER = 0.4;

/** What a tap on the stance button does: stand and crouch toggle, and from prone it stands up. */
export function stanceOnTap(stance: Stance): Stance {
  return stance === 'stand' ? 'crouch' : 'stand';
}

/** What a hold does: prone, or from prone up on its feet (the game's full press stands a prone SEAL). */
export function stanceOnHold(stance: Stance): Stance {
  return stance === 'prone' ? 'stand' : 'prone';
}

/**
 * The stance button as a state machine, one `update` a frame: a press let go inside `STANCE_HOLD_S_PLACEHOLDER` is a
 * tap and acts at the release, as the game's light press does; a press held that long acts at that moment (the game's
 * full press acts at once) and its release then does nothing. Returns the stance to go to, or null.
 */
export class StanceButton {
  private held = 0;
  private was = false;
  private acted = false;

  constructor(private readonly holdSeconds = STANCE_HOLD_S_PLACEHOLDER) {}

  update(down: boolean, dt: number, stance: Stance): Stance | null {
    let go: Stance | null = null;
    if (down) {
      if (!this.was) { this.held = 0; this.acted = false; }
      this.held += dt;
      if (!this.acted && this.held >= this.holdSeconds) { this.acted = true; go = stanceOnHold(stance); }
    } else if (this.was && !this.acted) {
      go = stanceOnTap(stance);
    }
    this.was = down;
    return go;
  }
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

/** What the weapon's trigger and aim are this frame (the page's: `Fire.triggerHeld`, the aim lane). */
export interface WeaponInput { trigger: boolean; aiming: boolean }

/** What `weapon()` on the hook reports: the raise, the layers, whether the rifle is in hand, and the muzzle. */
export interface WeaponStats {
  held: boolean;
  raise: RaiseStats;
  pose: WeaponPoseStats | null;
  muzzle: [number, number, number] | null;
}

/** What `stats().view` reports: which view draws the frame, and the drawn camera's pose. */
export interface ViewStats {
  kind: ViewKind;
  pose: Pose;
}

/** The mover's snapshot at rest where it stands: what the body plays in fly mode once it has been played. */
const at = (s: MoverSnapshot): MoverSnapshot => ({
  ...s, vx: 0, vz: 0, vy: 0, airborne: false, landing: null, ground: { state: 'idle', forward: 0, right: 0, cls: -1 }, action: null,
});

/**
 * What the play mode tells the page (`Play.onEvent`) -- for the audio, above all. The animator's (`AnimEvent`: a
 * `motion.rdr` `zanim_callback` crossed, a footfall, a play started) with the world point of the foot for a footfall
 * (the posed `lfoot` / `rfoot` joint, the node `FUN_005a3570` sounds at), and the mover's own: a take-off and a
 * landing (its contact speed, units a second down, and the clip the game gives it: `FUN_005af590`; the game plays the
 * surface's landing sound on every landing, `FUN_005ac1f0`).
 */
export type PlayEvent =
  | (Extract<AnimEvent, { kind: 'footfall' }> & { position: [number, number, number] | null })
  | Exclude<AnimEvent, { kind: 'footfall' }>
  | { kind: 'takeoff'; running: boolean }
  | { kind: 'land'; speed: number; clip: 'land' | 'landHard' | 'hit' | 'hitStomach' | 'landDeath' | null; cls?: 0 | 1 | 2 | 3 };

/** A camera's pose in the fly camera's convention (yaw 0 looks down -z; degrees). */
function poseOf(camera: PerspectiveCamera): Pose {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements, p = camera.position;
  const dx = -e[8]!, dy = -e[9]!, dz = -e[10]!, n = Math.hypot(dx, dy, dz) || 1;
  return { x: p.x, y: p.y, z: p.z, yaw: (Math.atan2(-dx, -dz) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, dy / n))) * 180) / Math.PI };
}

/**
 * The play mode's state on the page: the body, its skeleton, the clips and the animator over them, and the panel's
 * body switch. `frame` runs once a frame after the walk's own; the view itself is the walk's (`./walk`, the game's
 * camera, `./playerCamera`), and the aim lanes hold its first-person view (`WalkMode.setAiming`).
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
  private kind: ViewKind = 'fly';
  private drawn: PerspectiveCamera | null = null;
  /** WEAPON: the rifle's raise (`./weaponRaise`), its layers over the clips (`./weaponPose`), the hand's node. */
  private readonly raise = new WeaponRaise();
  private weaponPose: WeaponPose | null = null;
  private weaponInput: () => WeaponInput = () => ({ trigger: false, aiming: false });
  private hand: Group | null = null;
  private weapon: Object3D | null = null;
  private muzzleAt: Pnt3D | null = null;
  private stance: Stance = 'stand';
  private readonly listeners = new Set<(e: PlayEvent) => void>();
  /** The rifle put away while another item is in the hand (the grenade: `./grenade`'s `equip`). */
  private stowed = false;
  private unhook: (() => void) | null = null;
  /** The last action seen, by its serial: a take-off and a landing are told once. */
  private seenAction: { name: MoverActionName; serial: number } | null = null;
  private wasAirborne = false;

  /** A map's body, or none: the animator is rebuilt over its skeleton (the clips are the source's, kept). */
  setBody(view: BodyView | null, body: LoadedBody | null): void {
    this.body = view;
    this.loaded = view ? body : null;
    this.skeleton = view && body ? heldSkeleton(bodySkeleton(body)) : null;
    this.hand = view && this.skeleton && this.skeleton.indexOf(HELD_ITEM.name) >= 0 ? view.addProp(HELD_ITEM.name, HELD_ITEM.parent) : null;
    if (this.weapon && this.hand) this.hand.add(this.weapon);
    this.last = null;
    this.raise.reset();
    this.rebuild();
  }

  /**
   * WEAPON: the map's held weapon (`WorldView.weapon`, the M4A1 SD) hung on the hand's `rifle` node at its grip, and
   * its named points (`LoadedMap.weapon.points`) for the muzzle. Null takes it off.
   */
  setWeapon(object: Object3D | null, points: readonly WeaponPoint[]): void {
    this.weapon?.removeFromParent();
    this.weapon = object;
    this.muzzleAt = object ? muzzlePoint(points) : null;
    if (object) {
      object.position.set(0, 0, 0);
      object.quaternion.identity();
      object.scale.set(1, 1, 1);
      object.matrixAutoUpdate = true;
      object.visible = true;
      this.hand?.add(object);
    }
  }

  /** WEAPON: where the trigger and the aim are read from each frame (the page wires `Fire` and the walk's view). */
  setWeaponInput(read: () => WeaponInput): void {
    this.weaponInput = read;
  }

  /** WEAPON: a round or a reload from `Fire` (`Fire.subscribe`): a reload plays the stance's reload clip. */
  weaponEvent(e: FireEvent): void {
    if (e.type === 'reloadStart') this.weaponPose?.startReload(this.stance, e.seconds);
    else if (e.type === 'reloadEnd') this.weaponPose?.stopReload();
  }

  /**
   * WEAPON: the reload's length for the stance the SEAL is in and whether it moves -- the reload clip's `playback`
   * (`./weaponPose`) -- or null without the clips (`Fire` keeps its own estimate then).
   */
  reloadSeconds(): number | null {
    const clip = this.animator && this.last ? this.animator.stats().clip : null;
    return this.weaponPose?.reloadSeconds(this.stance, clip !== null && !STILL_CLIPS.has(clip)) ?? null;
  }

  /** WEAPON: the posed weapon's `firepoint` in the world (`./heldItem`), or null with no body, weapon or play yet. */
  muzzle(): [number, number, number] | null {
    const last = this.last, skeleton = this.skeleton, at = this.muzzleAt;
    if (!last || !skeleton || !at || !this.weapon || !this.animator) return null;
    const p = muzzleOf(skeleton, at);
    return p ? actorToWorld(last.feet, last.yaw, p) : null;
  }

  /** WEAPON: the hook's `weapon()`. */
  weaponStats(): WeaponStats {
    return { held: this.weapon !== null && this.hand !== null, raise: this.raise.stats(), pose: this.weaponPose?.stats() ?? null, muzzle: this.muzzle() };
  }

  /** WEAPON: shows the gear by its `character.rdr` name -- `Satchel` for the bomb carrier (`HIDDEN_AT_SPAWN`). */
  setGearVisible(name: string, on: boolean): boolean {
    return this.body?.setGearVisible(name, on) ?? false;
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

  /**
   * One frame: in walk mode the body at the mover's drawn feet, facing the body's yaw, its clip advanced by `dt` and
   * its pose on the bones -- shown in third person, hidden in first; in fly mode, once played, the body left standing
   * where the mover was. `camera` is the one the frame is drawn with, for `viewStats`.
   */
  frame(dt: number, walk: Pick<WalkMode, 'snapshot' | 'view'> & Partial<Pick<WalkMode, 'setPosedRoot' | 'mover'>>, camera: PerspectiveCamera): void {
    const snap = walk.snapshot();
    this.kind = snap === null ? 'fly' : walk.view() === 'first' ? 'aim' : 'third';
    // WEAPON: the rifle's raise from the trigger and the aim while walking. In fly mode the body left standing keeps
    // the rifle where the play left it (the raise does not tick) and a reload stops.
    if (snap) {
      this.stance = snap.stance;
      const w = this.raise.frame(dt, this.weaponInput());
      if (this.weaponPose) this.weaponPose.fireWeight = w;
      this.weaponPose?.step(dt);
    } else this.weaponPose?.stopReload();
    this.bodyFrame(dt, snap);
    // The rifle rides the clips' `rifle` node: in W2.1's bind pose, never played, the hand holds nothing.
    if (this.weapon) this.weapon.visible = this.last !== null && this.animator !== null && !this.stowed;
    if (snap) this.moverEvents(snap, walk.mover?.() ?? null);
    // FUN_0029a950 reads the posed root: the walk's camera stands on it from its next tick.
    walk.setPosedRoot?.(snap && this.animator ? this.animator.rootY() : null);
    this.drawn = camera;
  }

  /**
   * Listens to the play mode's events (`PlayEvent`): the clips' callbacks and footfalls, the plays started, the take-offs
   * and the landings. Returns the unsubscribe. The listeners outlive a new map's body and clips.
   */
  /** The rifle away (true: the grenade is up) or back in the hand. */
  setRifleStowed(on: boolean): void {
    this.stowed = on;
  }

  onEvent(listener: (e: PlayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: PlayEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** The mover's take-offs and landings, each once, from the snapshot's action and the hook's landing record. */
  private moverEvents(snap: MoverSnapshot, mover: ReturnType<WalkMode['mover']>): void {
    const a = snap.action ?? null;
    if (a && (a.name === 'jump' || a.name === 'launch') && (this.seenAction?.serial !== a.serial)) {
      this.emit({ kind: 'takeoff', running: a.name === 'launch' });
    }
    if (this.wasAirborne && !snap.airborne) {
      const landing = mover?.landing ?? null;
      this.emit({ kind: 'land', speed: landing?.speed ?? 0, clip: landing?.clip ?? null, cls: landing?.cls ?? 0 });
    }
    this.seenAction = a && { name: a.name, serial: a.serial };
    this.wasAirborne = snap.airborne;
  }

  /** An animator event to the page's listeners, a footfall with its foot's world point. */
  private relay(e: AnimEvent): void {
    if (e.kind !== 'footfall') { this.emit(e); return; }
    const part = this.skeleton?.indexOf(e.foot === 'left' ? 'lfoot' : 'rfoot') ?? -1;
    const m = part >= 0 ? this.skeleton!.palette()[part] : undefined;
    const last = this.last;
    this.emit({ ...e, position: m && last ? actorToWorld(last.feet, last.yaw, [m[12]!, m[13]!, m[14]!]) : null });
  }

  /** What the clips are doing: the hook's `stats().anim`; null with no body, no clips, or before the first play. */
  animStats(): AnimStats | null {
    return this.animator && this.last ? this.animator.stats() : null;
  }

  /** The camera drawing the frame, for the hook's `stats().view`. */
  viewStats(): ViewStats {
    const drawn = this.drawn;
    return { kind: this.kind, pose: drawn ? poseOf(drawn) : { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 } };
  }

  /** The posed root's height over the feet (the clip's), or null before the first play. */
  rootY(): number | null {
    return this.animator && this.last ? this.animator.rootY() : null;
  }

  /** The body's eyes in the world through its pose (`eyePoint`), or null with no body, no eye gear or no play yet. */
  eyeWorld(): [number, number, number] | null {
    const palette = this.skeleton?.palette(), last = this.last;
    const eye = palette && this.loaded && last ? eyePoint(this.loaded, palette) : null;
    return eye && last ? actorToWorld(last.feet, last.yaw, eye) : null;
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
    this.unhook?.();
    this.unhook = null;
    const table = this.clips?.table ? new Map(this.clips.table) : null;
    this.animator = this.skeleton && this.clips ? new Animator(this.skeleton, this.clips.clips, table) : null;
    // WEAPON: the Fire set and the reload over the clips, as pose layers (the picker is untouched).
    this.weaponPose = this.animator && this.clips ? new WeaponPose(new Map(this.clips.clips.map((c) => [c.name, c])), table) : null;
    if (this.animator && this.weaponPose) {
      this.animator.addPoseLayer(this.weaponPose.fireLayer);
      this.animator.addPoseLayer(this.weaponPose.reloadLayer);
    }
    if (this.animator) this.unhook = this.animator.onEvent((e) => this.relay(e));
  }
}

/**
 * The actor's frame to the world: a point in the model's own axes (x to its right, y up, z behind) at the feet,
 * turned by the facing's yaw (degrees, as `Pose.yaw`: yaw 0 faces -z).
 */
export function actorToWorld(feet: readonly number[], yaw: number, v: readonly [number, number, number]): [number, number, number] {
  const r = (yaw * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [feet[0]! + v[0] * c + v[2] * s, feet[1]! + v[1], feet[2]! - v[0] * s + v[2] * c];
}
