import type { Group, Object3D, PerspectiveCamera } from 'three';
import { IDENTITY, multiply, partMatrix, sampleClip, Skeleton, transformPoint, type MotionClip, type Pnt3D, type WeaponPoint } from '@s2u/scene';
import { Animator, type AnimEvent, type AnimStats, type MoverSnapshot, type PoseLayer } from './animator';
import { EYE_MODEL, type LoadedBody } from './body';
import type { BodyView } from './bodyView';
import type { Pose } from './camera';
import type { FireEvent } from './fire';
import { pressedSince, releasedSince, type Input } from './gamepad';
import { HELD_ITEM, heldSkeleton, MountEase, mountMatrix, muzzlePoint, PISTOL_ITEM, type Carries, type Mount } from './heldItem';
import type { Firearm } from './kit';
import type { MotionEntry, MotionTable } from './motionTable';
import { ACTION_CLIPS, actionRoots, type MoverActionName, type Stance, type WalkMode } from './walk';
export { actionRoots };
import { SEAL_ANIMS } from './locomotion';
import { reloadMoving } from './reloadClip';
import { WeaponPose, type WeaponPoseStats } from './weaponPose';
import { WeaponRaise, type RaiseStats } from './weaponRaise';

/**
 * The play mode (web sprint 2, W2.2b; ruling W2.R1): the walk mode with the body. Entering walk (`G`, the panel's
 * switch, the pad's Start) shows the map's SEAL at the mover's feet, facing the body's yaw, running the game's clips
 * (`./animator`). The frame is drawn from the walk's own camera -- the game's third-person camera
 * (`./playerCamera`, `FUN_0029a950`; it replaced the cloud sprint's measured shoulder rig at the merge of the two
 * sprint 2s) -- or, zoomed (the right mouse button, d-pad Up), the scope's view from the head. There is no first
 * person (the owner, 2026-09-29: the views are third person and scoped, as SOCOM II's). Leaving hides the body. The
 * W2.1 body switch is **"show the body in fly mode"**: with it on, the body stays in view where the play left it --
 * or at slot A in its bind pose, W2.1's picture, until played.
 */

/** Which view draws the frame: the game's third-person camera in play, the scope (from the head), or the fly camera. */
export type ViewKind = 'third' | 'scope' | 'fly';

/**
 * Whether the body is drawn: always over the shoulder, never in the scope -- a view from the body's own eyes, where
 * the head would fill the screen -- and in the fly camera only when the panel's switch asks.
 */
export function bodyVisible(kind: ViewKind, flyToggle: boolean): boolean {
  return kind === 'third' || (kind === 'fly' && flyToggle);
}

/**
 * The pad's lanes as the play mode acts on them (W2.R5; `./gamepad`'s `Input`, the pad and the touch buttons merged):
 * the jump on the press, the crouch on the release -- the game toggles the stance when the button comes up
 * (docs/PLAYTEST.md step 8, `host_crouch_shortcut.h:5-6`). The fire lane is the trigger's (`main.ts`), and the stance
 * lane's tap and hold are `StanceButton`'s (`./stanceButton`).
 */
export function playActions(before: Input, after: Input): { jump: boolean; crouch: boolean } {
  return { jump: pressedSince(before, after).includes('jump'), crouch: releasedSince(before, after).includes('crouch') };
}

// The stance button's machine and rules live in `./stanceButton` (the pad's Triangle here, the PC's `C` in `./walk`).
export { StanceButton, STANCE_HOLD_S_PLACEHOLDER, stanceOnHold, stanceOnTap } from './stanceButton';

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

/** What the weapon's trigger and aim are this frame (the page's: `Fire.triggerHeld`, and `aiming` while in the scope). */
export interface WeaponInput { trigger: boolean; aiming: boolean }

/** What `weapon()` on the hook reports: the raise, the layers, whether the rifle is in hand, and the muzzle. */
export interface WeaponStats {
  held: boolean;
  /** WEAPON: the firearm the anim set and the fire use (`m_item`), and where each weapon rides. */
  item: Firearm;
  mounts: { rifle: Mount; pistol: Mount };
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
  | { kind: 'land'; speed: number; clip: 'land' | 'landHard' | 'hit' | 'hitStomach' | 'landDeath' | 'landBackwards' | null; cls?: 0 | 1 | 2 | 3 };

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
 * camera, `./playerCamera`), and the zoom puts it in the scope, at the head (`WalkMode.setScoped`).
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
  /** The raise's weight this frame, for the animator (`MoverSnapshot.aimWeight`). */
  private aimWeight = 0;
  private weaponPose: WeaponPose | null = null;
  private weaponInput: () => WeaponInput = () => ({ trigger: false, aiming: false });
  private hand: Group | null = null;
  private weapon: Object3D | null = null;
  private muzzleAt: Pnt3D | null = null;
  /** WEAPON: the sidearm's model and muzzle, the firearm in use, and where each weapon rides (`./kit`). */
  private sidearm: Object3D | null = null;
  private sidearmMuzzle: Pnt3D | null = null;
  private item: Firearm = 'rifle';
  private mounts: { rifle: Mount; pistol: Mount } = { rifle: 'hand', pistol: 'spawn' };
  /** WEAPON: a weapon eased from where it was drawn to a new mount (`MountEase`: the swap's ends, the hand-off). */
  private readonly ease = new MountEase();
  private stance: Stance = 'stand';
  private readonly listeners = new Set<(e: PlayEvent) => void>();
  /** The rifle put away while another item is in the hand (the grenade: `./grenade`'s `equip`). */
  private stowed = false;
  /** GRENADES: pose layers laid over the clips from outside (the throw, `./throwPose`), kept across a new body or pack. */
  private readonly extraLayers: PoseLayer[] = [];
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
    if (view && this.skeleton && this.skeleton.indexOf(PISTOL_ITEM.name) >= 0) view.addProp(PISTOL_ITEM.name, PISTOL_ITEM.parent);
    // The weapons ride the body's own frame: their matrices are set from their mounts each frame (`mountMatrix`).
    for (const o of [this.weapon, this.sidearm]) if (o && view) view.group.add(o);
    this.last = null;
    this.ease.reset();
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
    this.hangHeld(object);
  }

  /** WEAPON: the map's sidearm (`WorldView.sidearm`, the kit's Mark 23) and its points; it rides its mount (`./kit`). */
  setSidearm(object: Object3D | null, points: readonly WeaponPoint[]): void {
    this.sidearm?.removeFromParent();
    this.sidearm = object;
    this.sidearmMuzzle = object ? muzzlePoint(points) : null;
    this.hangHeld(object);
  }

  /**
   * WEAPON: the firearm the anim set uses (`m_item`: `Animator.setWeapon`, the pistol's versions of the clips) and the
   * Fire set's and the reload's versions (`./weaponPose`).
   */
  setItem(item: Firearm): void {
    this.item = item;
    this.animator?.setWeapon(item);
    if (this.weaponPose) this.weaponPose.item = item;
  }

  /** WEAPON: where each weapon rides this frame (`Kit.state().mounts`). */
  setMounts(mounts: { rifle: Mount; pistol: Mount }): void {
    this.mounts = { ...mounts };
  }

  /** `FUN_005a82e0`: faster than 20 units a second (`|v|^2 > 400`) is the moving reload -- the room's test (`./reloadClip`). */
  private movingForReload(): boolean {
    const v = this.last;
    return v !== null && reloadMoving(v.vx, v.vy, v.vz);
  }

  private hangHeld(object: Object3D | null): void {
    if (!object) return;
    object.matrixAutoUpdate = false;
    object.visible = false;
    this.body?.group.add(object);
  }

  /** The weapons on their mounts in the body's frame; hidden before the first play and while stowed in the hand. */
  private placeHeld(dt: number): void {
    const skeleton = this.skeleton;
    const played = this.last !== null && this.animator !== null && skeleton !== null;
    const carries = (this.loaded?.carries ?? null) as Carries | null;
    for (const [item, object] of [['rifle', this.weapon], ['pistol', this.sidearm]] as const) {
      if (!object) continue;
      const mount = this.mounts[item];
      const hangs = mount === 'swap' ? `swap:${this.last?.overlay ? 'overlay' : this.last?.action?.name ?? ''}` : mount;
      const m = this.ease.place(item, hangs, played ? mountMatrix(skeleton!, item, mount, carries, this.animator!.heldLocal(item)) : null, dt);
      object.visible = m !== null && !(this.stowed && mount === 'hand');
      if (m) { object.matrix.fromArray(m); object.matrixWorldNeedsUpdate = true; }
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
    return this.weaponPose?.reloadSeconds(this.stance, this.movingForReload()) ?? null;
  }

  /**
   * WEAPON: the posed weapon's `firepoint` in the world (`./heldItem`), or null with no body, weapon or play yet: the
   * weapon as it is drawn (its mount's matrix, eased after a swap: `MountEase`), so a round leaves the muzzle seen.
   */
  muzzle(): [number, number, number] | null {
    const last = this.last, skeleton = this.skeleton;
    const pistol = this.item === 'pistol';
    const at = pistol ? this.sidearmMuzzle : this.muzzleAt, object = pistol ? this.sidearm : this.weapon;
    if (!last || !skeleton || !at || !object || !this.animator || this.mounts[this.item] !== 'hand') return null;
    if (skeleton.indexOf(this.item) < 0 || !this.ease.placed(this.item)) return null;
    const p = transformPoint(Float32Array.from(object.matrix.elements), at[0], at[1], at[2]);
    return p ? actorToWorld(last.feet, last.yaw, p) : null;
  }

  /** WEAPON: the hook's `weapon()`. */
  weaponStats(): WeaponStats {
    return {
      held: this.weapon !== null && this.hand !== null, item: this.item, mounts: { ...this.mounts },
      raise: this.raise.stats(), pose: this.weaponPose?.stats() ?? null, muzzle: this.muzzle(),
    };
  }

  /** WEAPON: shows the gear by its `character.rdr` name -- `Satchel` for the bomb carrier (`HIDDEN_AT_SPAWN`). */
  setGearVisible(name: string, on: boolean): boolean {
    return this.body?.setGearVisible(name, on) ?? false;
  }

  /** The source's clips and table (`playFromDisc`), or none: without them the body stands in its bind pose. */
  setClips(clips: PlayClips | null): void {
    this.clips = clips && clips.clips.length ? clips : null;
    this.roots = this.clips ? actionRoots(this.clips.clips) : null;
    this.rootsSent = false;
    this.rebuild();
  }
  /** The action clips' root keys (`actionRoots`), handed to the walk once each time they change. */
  private roots: Map<string, Float32Array> | null = null;
  private rootsSent = false;

  /** The panel's body switch: the body in fly mode (W2.1's switch, turned). */
  setFlyToggle(on: boolean): void {
    this.flyToggle = on;
  }

  /**
   * One frame: in walk mode the body at the mover's drawn feet, facing the body's yaw, its clip advanced by `dt` and
   * its pose on the bones -- shown in third person, hidden in the scope; in fly mode, once played, the body left standing
   * where the mover was. `camera` is the one the frame is drawn with, for `viewStats`.
   */
  frame(dt: number, walk: Pick<WalkMode, 'snapshot' | 'view'> & Partial<Pick<WalkMode, 'setPosedRoot' | 'mover' | 'setActionRoots'>>, camera: PerspectiveCamera): void {
    if (!this.rootsSent && walk.setActionRoots) { walk.setActionRoots(this.roots); this.rootsSent = true; }
    const snap = walk.snapshot();
    this.kind = snap === null ? 'fly' : walk.view() === 'scope' ? 'scope' : 'third';
    // WEAPON: the rifle's raise from the trigger and the aim while walking. In fly mode the body left standing keeps
    // the rifle where the play left it (the raise does not tick) and a reload stops.
    if (snap) {
      this.stance = snap.stance;
      const w = this.raise.frame(dt, this.weaponInput());
      if (this.weaponPose) {
        this.weaponPose.fireWeight = w;
        this.weaponPose.moving = reloadMoving(snap.vx, snap.vy, snap.vz);
      }
      this.weaponPose?.step(dt);
      // MOTION: the same weight scales the aim's twist and lets the head look run when 0 (FUN_0057a330 439152-439193).
      this.aimWeight = w;
    } else this.weaponPose?.stopReload();
    this.bodyFrame(dt, snap && { ...snap, aimWeight: this.aimWeight });
    // The rifle rides the clips' `rifle` node: in W2.1's bind pose, never played, the hand holds nothing.
    this.placeHeld(dt);
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

  /** GRENADES: a pose layer over the clips after the weapon's (the throw's clip, `./throwPose`); kept on a rebuild. */
  addPoseLayer(layer: PoseLayer): void {
    this.extraLayers.push(layer);
    this.animator?.addPoseLayer(layer);
  }

  /** GRENADES: the source's clips by name and their `motion.rdr` table, or null before the pack is in. */
  motionSource(): { clips: ReadonlyMap<string, MotionClip>; table: MotionTable | null } | null {
    if (!this.clips) return null;
    return { clips: new Map(this.clips.clips.map((c) => [c.name, c])), table: this.clips.table ? new Map(this.clips.table) : null };
  }

  /** GRENADES: the held item's node under `rhand` (`HELD_ITEM`), to hang another item on while the rifle is stowed. */
  heldNode(): Group | null {
    return this.hand;
  }

  /**
   * GRENADES: a point in a posed part's own frame (`rhand`, `lhand`, the held item's node), in the world -- null with no
   * body, no clips or before the first play. `CZKit_TickExplosives` releases a grenade from the hand's (2, 0, 0).
   */
  partPoint(name: string, p: Pnt3D): [number, number, number] | null {
    const last = this.last, skeleton = this.skeleton;
    if (!last || !skeleton || !this.animator) return null;
    const i = skeleton.indexOf(name);
    if (i < 0) return null;
    const at = transformPoint(skeleton.world[i]!, p[0], p[1], p[2]);
    return actorToWorld(last.feet, last.yaw, [at[0], at[1], at[2]]);
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
    if (this.skeleton && this.clips) restHolds(this.skeleton, this.clips.clips);
    this.animator = this.skeleton && this.clips ? new Animator(this.skeleton, this.clips.clips, table) : null;
    // WEAPON: the Fire set and the reload over the clips, as pose layers (the picker is untouched).
    this.weaponPose = this.animator && this.clips ? new WeaponPose(new Map(this.clips.clips.map((c) => [c.name, c])), table) : null;
    this.animator?.setWeapon(this.item);
    if (this.weaponPose) this.weaponPose.item = this.item;
    if (this.animator && this.weaponPose) {
      this.animator.addPoseLayer(this.weaponPose.fireLayer);
      this.animator.addPoseLayer(this.weaponPose.reloadLayer);
    }
    if (this.animator) for (const layer of this.extraLayers) this.animator.addPoseLayer(layer);
    if (this.animator) this.unhook = this.animator.onEvent((e) => this.relay(e));
  }
}

/**
 * WEAPON: the held items' rest -- the grip in the hand as the stand clips hold it (`seal_stand`'s `rifle` track,
 * `seal_p_stand`'s `pistol` track, key 0: `(1.266, 0.258, -0.148)` from `rhand`) -- so a clip that carries no track for
 * the item in the hand (the jumps, the hits) keeps the hold rather than the node's bare identity [reading: the game's
 * node keeps the last pose written to it].
 */
function restHolds(skeleton: Skeleton, clips: readonly MotionClip[]): void {
  for (const [part, clipName] of [['rifle', 'seal_stand'], ['pistol', 'seal_p_stand']] as const) {
    const i = skeleton.indexOf(part);
    const clip = clips.find((c) => c.name === clipName);
    const track = clip ? sampleClip(clip, 0).parts.find((p) => p.name === part) : undefined;
    if (i < 0 || !track) continue;
    (skeleton.parts[i]!.bindLocal as Float32Array).set(partMatrix(track.rotation, track.translation));
    skeleton.setLocal(i, skeleton.parts[i]!.bindLocal);
  }
  skeleton.update();
}

/**
 * The actor's frame to the world: a point in the model's own axes (x to its right, y up, z behind) at the feet,
 * turned by the facing's yaw (degrees, as `Pose.yaw`: yaw 0 faces -z).
 */
export function actorToWorld(feet: readonly number[], yaw: number, v: readonly [number, number, number]): [number, number, number] {
  const r = (yaw * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [feet[0]! + v[0] * c + v[2] * s, feet[1]! + v[1], feet[2]! - v[0] * s + v[2] * c];
}
