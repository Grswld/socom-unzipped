import {
  AdditiveBlending, DataTexture, DoubleSide, Group, LinearFilter, Mesh, MeshBasicMaterial, NormalBlending, PlaneGeometry,
  RGBAFormat, Sprite, SpriteMaterial, UnsignedByteType, BufferGeometry, Float32BufferAttribute, Line,
  LineBasicMaterial, Points, PointsMaterial, type Texture,
} from 'three';
import type { Rgba } from '@s2u/gs';
import {
  actorToWorldDir, actorToWorldPoint, AN_M8, CLAYMORE, CLAYMORE_RULES, claymoreCone, explosionDamage, flashLevel, GRENADE_BLAST, gridCast, heldPower, HE,
  launchGrenade, M67, MARK141,
  materialAnim, maxThrowDistance, PLACE_CLAYMORE_ANIM, releaseSeconds, stepGrenade, stepThrowPower, throwAnim, throwClipSeconds, THROW_ANIMS,
  throwVelocity,
  type Grenade, type GrenadeEvent, type Grid, type HullCast, type ThrowAnim, type ThrowLaunch, type ThrowStance,
  type ThrowableRecord, type V3,
} from '@s2u/scene';
import type { GrenadeAssets } from './grenadeAssets';
import { GRENADE_BITMAPS } from './grenadeAssets';
import type { PlaySnapshot, WalkView } from './walk';

/**
 * SOCOM II's frag grenade in walk mode (the grenades workstream; web/docs/research/85). The physics is
 * `@s2u/scene`'s `projectile.ts`, the game's own; this file is the page's part: the slot, the held throw, the clip's
 * timing, the grenades in flight over the map's hull, what is drawn, and the events the audio, weapon and UI
 * workstreams hang off.
 *
 * - **The slots.** In SOCOM II a grenade is a kit slot, taken up from R2's inventory or by L1/L2 (`SwapWeapon1/2`)
 *   swapping to the slot assigned to them (research 85 §9.1), and thrown with the fire button (R1). Here: `1` the
 *   rifle, `4` the M67, `5` the HE; the pad's L2 (`swap2`) and R2 (`cycleInventory`); the fire trigger (the left
 *   button, the touch fire button, R1) throws while one is up (`main.ts` routes it).
 * - **The throw.** Held, the power chases the button's pressure (`stepThrowPower`: a key or a click is pressure 1, so
 *   the power is how long it was held: 0.54 at a quarter second, 0.95 at one); let go, `GetThrowAnim` picks the clip
 *   (a toss under power 0.6 with the aim under sin 0.3), played on the body (`./throwPose`), and at its release phase
 *   the grenade leaves the posed right hand's (2, 0, 0) (`GrenadeSource.handPoint`) at `throwVelocity`'s velocity, its
 *   fuse (`Timer1` 3 s) starting then. The smoke pours out from 3 s to 40 s; the flash whites the screen out by the game's rule.
 * - **The flight.** `stepGrenade` at 60 Hz (`FLIGHT_TICK`), over `gridCast` of the walk's hull with the map's
 *   `DefaultMaterial`: gravity 98, the bounce at each material's ELASTICITY_COEFF, the rest under 5 units/s, the
 *   explosion at 3 s where it lies, the removal at 3.1.
 * - **Drawn.** The `grenade` model (`WEAP_GEO`; the HE's `HEgrenade`) on the right hand's held node (`heldNode`;
 *   `HAND_PLACEHOLDER` without a posed body) and in flight (tumbling at `SPIN_PLACEHOLDER`); the explosion as the `frag_grenade` zAnim's parts read off their
 *   commands (`EXPLOSION_READING`): the flash, a fireball, sparks, smoke, dust and a ground roll, with the bitmaps
 *   `GRENADE_BITMAPS` names; the scorch from `GRENADE_BLAST`. Optionally the flight's trail (a debug line, off).
 */

/** The flight's fixed step: the walk's 60 Hz (`walk.ts` `TICK`) [reading: the projectile runs on the frame's dt]. */
export const FLIGHT_TICK = 1 / 60;
/** Where the grenade sits in the hand before the clip lifts it, actor frame (x right, y up, z behind) [placeholder]. */
export const HAND_PLACEHOLDER: V3 = [3.5, 12.5, -4];
/** The grenade's tumble in flight, radians a second [placeholder: `SetModelOrientation` 0x3cabe0 is not read]. */
export const SPIN_PLACEHOLDER = 14;

/**
 * The explosion as the `frag_grenade` zAnim composes it (`RUN/CZANIM.ZAR`: `FRAG_sparks`, `dust_explode_long`,
 * `light_flash_large`, `bsmoke_explode_large`, `dust_ground_roll`, the sound `.GREN_MED`). **[reading]**: the particle
 * command (set 0, command 0x27, ~300 bytes) is not decoded field by field; the numbers below are the floats that
 * stand out in each and read as velocity ranges (x, y, z), sizes, lives and grey levels (research 85 §6).
 */
export const EXPLOSION_READING = {
  /** `light_flash_large` (command 0x32): (214.2, 242.25, 216.75, 64), 100 -> 190, 0.5 s. */
  flash: { color: [216.75 / 255, 242.25 / 255, 214.2 / 255] as V3, radius: [100, 190] as const, life: 0.5 },
  /** `bsmoke_explode_large`'s `fire_explode`: x, z +-70, y 0..240; 8-10 across. */
  fire: { count: 14, vx: 70, vy: [0, 240] as const, size: [8, 10] as const, grow: 2.2, life: [0.35, 0.6] as const, gravity: 0 },
  /** `FRAG_sparks`' `spark_streak`: x, z +-200, y 110..180, pulled down by 1000; 0.5-0.8 across, 0.63-0.65 s. */
  spark: { count: 24, vx: 200, vy: [110, 180] as const, size: [0.5, 0.8] as const, grow: 1, life: [0.63, 0.65] as const, gravity: 1000 },
  /** `GreyDustCloudUp` / `BlackDustCloudUp`: x -40..40, y 50..100; 10-12 across; 6.5-7.5 s and 9.5-10.5 s; 0.5 -> 0.2 grey. */
  smoke: { count: 10, vx: 40, vy: [50, 100] as const, size: [10, 12] as const, grow: 3, life: [6.5, 10.5] as const, gravity: 0, grey: [0.5, 0.2] as const },
  /** `dust_explode_long`: +-15; 5-10 across; 6.5-9.5 s; grey 0.6. */
  dust: { count: 8, vx: 15, vy: [-15, 15] as const, size: [5, 10] as const, grow: 3, life: [6.5, 9.5] as const, gravity: 0, grey: [0.6, 0.6] as const },
  /** `dust_ground_roll`'s `DustRoll`: x, z +-140 along the ground; 12-15 across; 2.6-3.0 s; grey 0.4. */
  roll: { count: 12, vx: 140, vy: [0, 6] as const, size: [12, 15] as const, grow: 2, life: [2.6, 3] as const, gravity: 0, grey: [0.4, 0.3] as const },
} as const;

export type GrenadePhase = 'holstered' | 'ready' | 'holding' | 'throwing';

/** The throwables the viewer carries: `mp_seal1`'s kit (`character.rdr`: M4A1, Mark 23, M67, HE, Double Ammo Load). */
export type GrenadeItem = 'M67' | 'HE' | 'AN-M8' | 'Mark141' | 'Claymore';
/**
 * The throwables the viewer carries: `mp_seal1`'s M67 and HE, the AN-M8 smoke of `mp_seal2`/`mp_seal4`, and the
 * Mark141 flashbang, which no MP default kit carries (the loadout screen's to give).
 */
export const THROWABLES: Readonly<Record<GrenadeItem, ThrowableRecord>> = { M67, HE, 'AN-M8': AN_M8, Mark141: MARK141, Claymore: CLAYMORE };
/** What the hand can hold besides the rifle: a throwable, or the claymore's Detonator (`CLAYMORE_RULES`). */
export type HeldItem = GrenadeItem | 'Detonator';
/** A kit slot: the rifle, a throwable, the Detonator. */
export type KitItem = 'rifle' | HeldItem;
/**
 * The kit's items in slot order as the viewer holds them (the Mark 23, slot 1, is not in the viewer); the Detonator
 * last, as `FUN_005c74e0` appends it to a kit with a claymore.
 */
export const KIT_ITEMS: readonly KitItem[] = ['rifle', 'M67', 'HE', 'AN-M8', 'Mark141', 'Claymore', 'Detonator'];

/** A placed item rather than a thrown one: `Muzzle_Velocity` 0 (the claymore; the C4 is no MP SEAL kit's). */
export const isPlaced = (r: ThrowableRecord): boolean => r.muzzleVelocity === 0;

/**
 * The smoke the AN-M8 pours out from `Timer1` to `Timer2`, as `smoke_stream` (`CZANIM.ZAR`, called by `smoke_grenade`)
 * sets it out [reading of its two `large_smoke` sources, command 0x1b]: puffs of `cloudpuff01.tif` thrown +-20 across
 * and 0-17 up, 3-4.5 across (x10 here, as the game's metres), living 5-7 s, grey 0.6 and 0.4, the pair running 20 s
 * twice over -- the 40 s of `Timer2`. The rate (one a source every 0.4 s) is doubled to fill the screen the game's own
 * sort order builds [placeholder].
 */
export const SMOKE_PLACEHOLDER = { every: 0.2, rise: [0, 17] as const, spread: 20, size: [30, 45] as const, grow: 1.6, life: [5, 7] as const, grey: [0.6, 0.4] as const };
/**
 * PLACEHOLDER (named): the smoke screen is drawn here even when the effects ran `smoke_grenade`, whose `large_smoke`
 * puffs do not yet read as a screen in the effects' particles; false once they do (the EFFECTS workstream's call).
 */
export const SMOKE_ALWAYS_PLACEHOLDER = true;

/** What a throwable does when it goes off: the frag's blast, the smoke's screen, the flash's white-out. */
export type Detonation = 'blast' | 'smoke' | 'flash';
export const detonationOf = (r: ThrowableRecord): Detonation =>
  r.explosionRadius === 0 ? 'smoke' : r.explosionDamage === 0 ? 'flash' : 'blast';
/**
 * PLACEHOLDER (named): the item L2 swaps to. The game's L2 is `SwapWeapon2` (`controller.rdr`'s Default), which
 * selects the kit slot held at the controller's `+0x228` -- slot 1, the sidearm, by default (`CSealCtrl`'s constructor
 * 0x598280), any slot the player assigns in the inventory (`FUN_0021bda0`); the viewer has no sidearm.
 */
export const L2_SLOT_PLACEHOLDER: GrenadeItem = 'M67';
/** The peek value past which a throw is the lean's toss [reading: the game tests the lean clip, not the value]. */
export const PEEK_THROW = 0.5;
/** The game releases from the hand bone's (2, 0, 0) (`CZKit_TickExplosives`, `FUN_002869d0` with 0x66b6d0). */
export const RELEASE_POINT: V3 = [2, 0, 0];

/** What the walk offers the grenade: the hull, the mover as the body reads it, the view. */
export interface GrenadeSource {
  grid(): Grid | null;
  snapshot(): PlaySnapshot | null;
  view(): WalkView;
  /** A point in a posed part's frame in the world (`Play.partPoint`): the hand the grenade leaves; null before a pose. */
  handPoint?(part: 'rhand' | 'lhand', p: V3): V3 | null;
  /** The held item's node under the right hand (`Play.heldNode`): the grenade rides it while it is up. */
  heldNode?(): Group | null;
  /** The peek (`DAT_004161c0`, -1 left .. 1 right; the traversal's): past half a side, the body is in state 3. */
  peek?(): number;
}

/** A throw as it left the hand: for the hook, the audio and the tests. */
export interface ThrowInfo {
  power: number;
  anim: ThrowAnim;
  launch: ThrowLaunch;
  /** The aim's sine the throw took (the walk's pitch). */
  aimSin: number;
  stance: ThrowStance;
  from: V3;
  velocity: V3;
  /** The sound the game's throw zAnim plays (`FireAnimName` `frag_start` -> `.THROW_OBJECT`). */
  sound: string;
  /** The throw zAnim itself (`frag_start`, `HE_start`), for the audio's zAnim map. */
  fireAnim: string;
  /** The throwable, and whether the release came from the posed hand (else the table's point). */
  item: GrenadeItem;
  fromHand: boolean;
}

export interface BounceInfo { material: string; pos: V3; speed: number; sound: boolean; anim: string }
export interface ExplosionInfo {
  pos: V3;
  /** `Explosion_Radius` x10. */
  radius: number;
  /** The zAnim (`frag_grenade`; the material's own `frag_grenade_<material>` where the game has one). */
  anim: string;
  /**
   * The throwable's own explosion zAnim (`DefaultSpecialAnimName`: `frag_grenade`, `HE_grenade`): the material
   * variants call it (set 0 command 0x45) rather than play `.GREN_MED` themselves.
   */
  baseAnim: string;
  /** The material under it, when it lay on one. */
  material: string | null;
  /** `explosionDamage` at the player's feet, 0 beyond the radius (nothing takes it). */
  damageToPlayer: number;
  distanceToPlayer: number | null;
  /** The throwable, and what it does going off. */
  item: string;
  detonation: Detonation;
  /**
   * The flashbang's white-out level for the player (`flashLevel`: 1-3, the map's `blindplayer0<level>`), from the
   * distance and how squarely the SEAL faces it; null for the others, out of reach, or no SEAL on the ground.
   */
  flash: 1 | 2 | 3 | null;
  /** Whether the game's own zAnim ran through the effects (`setEffectPlayer`), so no placeholder was drawn. */
  byEffects: boolean;
}

/** Where the effects play a zAnim: the point, and the surface's normal when it lay on one. */
export interface EffectAt { position: V3; normal?: V3 | null; velocity?: V3 | null }

/** The events other workstreams hang off (`on`). */
export interface GrenadeEvents {
  /** The slot changed: the weapon workstream hides the rifle while this is true (the Detonator's too). */
  equip: (equipped: boolean, item: HeldItem | null) => void;
  /** The throw's clip starts (`./throwPose` plays `anim.clip`); the hand lets go in `releaseIn` s. */
  throwStart: (info: { anim: ThrowAnim; power: number; releaseIn: number }) => void;
  /** A charge set down (the claymore): where, facing which way, and its zAnim (`c4_start`: `.PLACE_CHARGE`). */
  place: (info: { item: GrenadeItem; pos: V3; yaw: number; fireAnim: string }) => void;
  /** The grenade leaves the hand (audio: `.THROW_OBJECT`). */
  throw: (info: ThrowInfo) => void;
  /** A bounce (audio: the material's `grenade_hit_*` zAnim when `sound`). */
  bounce: (info: BounceInfo) => void;
  /** The explosion (audio `.GREN_MED`; the look workstream's screen shake by distance). */
  explode: (info: ExplosionInfo) => void;
  /** The claymore not set down: `CLAYMORE_RULES.maxPlacedMessage` for `seconds` (the UI's message line). */
  refuse: (info: { item: GrenadeItem; text: string; seconds: number }) => void;
  /** The Detonator fired (`CZKit_DetonateRemoteExplosives`): how many charges it set off, from where. */
  detonate: (info: { count: number; from: V3 }) => void;
}

export interface GrenadeStats {
  equipped: boolean;
  /** The throwable up, or the one that would be taken (`KIT_ITEMS`); `leftByItem` its count and the other's. */
  item: GrenadeItem;
  leftByItem: Record<GrenadeItem, number>;
  /** Its HUD icon (`IconTextureName`; the Detonator's while it is up). */
  icon: string;
  /** What is in the hand: a throwable, the Detonator, or null for the rifle. */
  held: HeldItem | null;
  /** The claymores down (`CLAYMORE_RULES.maxPlaced` at most). */
  placed: number;
  /** The placing action's clock running (`CLAYMORE_RULES.placeSeconds` to the charge on the ground). */
  placing: boolean;
  /** The refusal on screen (`CLAYMORE_RULES.maxPlacedMessage`), null when none. */
  message: string | null;
  /** Whether the grenade rides the posed hand's node (else the placeholder hold). */
  inHand: boolean;
  phase: GrenadePhase;
  power: number;
  left: number;
  thrown: number;
  record: Pick<ThrowableRecord, 'name' | 'fuse' | 'removal' | 'gravity' | 'explosionRadius' | 'explosionDamage' | 'capacity' | 'model'>;
  live: { pos: V3; vel: V3; state: Grenade['state']; fuse: number; bounces: number; age: number }[];
  lastThrow: (Omit<ThrowInfo, 'anim' | 'launch'> & { clip: string; toss: boolean; pitchDeg: number; speed: number; maxSpeed: number; range: number; releaseIn: number }) | null;
  bounces: BounceInfo[];
  explosions: ExplosionInfo[];
  effects: number;
  model: boolean;
  trail: boolean;
  defaultMaterial: string;
}

const rand = (lo: number, hi: number, r: () => number): number => lo + (hi - lo) * r();

interface Particle { sprite: Sprite; vel: V3; life: number; age: number; size: [number, number]; gravity: number; fade: number; still?: boolean }
/** A grenade in the air or on the ground; `rest` is the material it came to rest on, null while it has not. */
interface Live {
  g: Grenade; model: Group | null; spin: V3; trail: V3[]; line: Line | null; dots: Points | null; rest: string | null;
  /** A placed charge's facing (the SEAL's yaw when it was set down, degrees); undefined for a thrown grenade. */
  facing?: number;
}
interface Pending { anim: ThrowAnim; power: number; aimSin: number; stance: ThrowStance; left: number; total: number }

type Listeners = { [K in keyof GrenadeEvents]: GrenadeEvents[K][] };

export class GrenadeThrower {
  /** Everything drawn: the hand's grenade, the ones in flight, the effects, the scorches. `main.ts` adds it once. */
  readonly object = new Group();
  private templates: Partial<Record<GrenadeItem, Group>> = {};
  private readonly hand = new Group();
  private handModel: Group | null = null;
  /** The clone on the body's held node, and which item it is. */
  private heldModel: { item: HeldItem; object: Group } | null = null;
  /** The Detonator is up (`item_` stays the claymore, the slot it came from). */
  private detonatorUp = false;
  private detonatorTemplate: Group | null = null;
  /** The claymore's placing action: its clock to the charge down, and its clip's whole length. */
  private placing: { left: number; total: number } | null = null;
  private refusal: { text: string; left: number } | null = null;
  private item_: GrenadeItem = 'M67';
  private textures = new Map<string, Texture>();
  private defaultMaterial = '';
  private cast: HullCast | null = null;
  private castGrid: Grid | null = null;
  private equipped_ = false;
  private phase_: GrenadePhase = 'holstered';
  private power = 0;
  private left: Record<GrenadeItem, number>;
  private thrown = 0;
  private pending: Pending | null = null;
  private recover = 0;
  private readonly live: Live[] = [];
  private accumulator = 0;
  private readonly particles: Particle[] = [];
  private readonly scorches: Mesh[] = [];
  private lastThrow: GrenadeStats['lastThrow'] = null;
  private readonly bounceLog: BounceInfo[] = [];
  private readonly explosionLog: ExplosionInfo[] = [];
  private trail = false;
  private readonly listeners: Listeners = { equip: [], throwStart: [], place: [], throw: [], bounce: [], explode: [], refuse: [], detonate: [] };
  private bound: EventTarget | null = null;
  private readonly scorchGeometry = new PlaneGeometry(1, 1);

  constructor(
    private readonly source: GrenadeSource,
    private readonly records: Readonly<Record<GrenadeItem, ThrowableRecord>> = THROWABLES,
    private readonly random: () => number = Math.random,
  ) {
    this.left = capacities(records);
    this.object.add(this.hand);
    this.hand.visible = false;
  }

  /**
   * EFFECTS (web/docs/research/89): whether the explosion draws `EXPLOSION_READING`'s sprites -- only when the page
   * has not the game's own zAnim explosion to run (`main.ts` answers false once the map's effect data is in).
   */
  private placeholderBurst: () => boolean = () => true;
  setPlaceholderBurst(when: () => boolean): void {
    this.placeholderBurst = when;
  }

  /** Subscribes to an event; returns the unsubscribe. */
  on<K extends keyof GrenadeEvents>(kind: K, fn: GrenadeEvents[K]): () => void {
    (this.listeners[kind] as GrenadeEvents[K][]).push(fn);
    return () => {
      const list = this.listeners[kind] as GrenadeEvents[K][];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  private emit<K extends keyof GrenadeEvents>(kind: K, ...args: Parameters<GrenadeEvents[K]>): void {
    for (const fn of this.listeners[kind] as ((...a: typeof args) => void)[]) fn(...args);
  }

  /** The current throwable's record. */
  private get record(): ThrowableRecord { return this.records[this.item_]; }
  private get template(): Group | null { return this.detonatorUp ? this.detonatorTemplate : this.templates[this.item_] ?? null; }
  /** What is in the hand. */
  held(): HeldItem | null { return !this.equipped_ ? null : this.detonatorUp ? 'Detonator' : this.item_; }
  /** The SEAL's claymores down (`FUN_003cc1f0` over the placed list, by owner). */
  placedCount(): number { return this.live.filter((l) => l.facing !== undefined && l.g.state === 'rest').length; }

  /**
   * A new map: its throwables' models by model name (`WorldView.grenades`) and assets; the pouch refilled, the air and
   * the ground cleared.
   */
  setMap(templates: Readonly<Record<string, Group>> | null, assets: GrenadeAssets | null | undefined): void {
    this.reset();
    this.templates = {};
    for (const item of Object.keys(this.records) as GrenadeItem[]) {
      const t = templates?.[this.records[item].model];
      if (t) this.templates[item] = t;
    }
    this.detonatorTemplate = templates?.[CLAYMORE_RULES.detonator.model] ?? null;
    this.refreshHandModel();
    this.dropHeld();
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    for (const [name, rgba] of Object.entries(assets?.bitmaps ?? {})) this.textures.set(name, textureOf(rgba));
    this.defaultMaterial = assets?.defaultMaterial ?? '';
    this.cast = null;
    this.castGrid = null;
  }

  /** Clears the air, the effects and the marks, and refills the pouch (a new map, or the hook). */
  reset(): void {
    for (const l of this.live) this.dropLive(l);
    this.live.length = 0;
    for (const p of this.particles) { this.object.remove(p.sprite); p.sprite.material.dispose(); }
    this.particles.length = 0;
    this.smokes.length = 0;
    for (const s of this.scorches) { this.object.remove(s); (s.material as MeshBasicMaterial).dispose(); }
    this.scorches.length = 0;
    this.left = capacities(this.records);
    this.thrown = 0;
    this.pending = null;
    this.recover = 0;
    this.power = 0;
    this.lastThrow = null;
    this.bounceLog.length = 0;
    this.explosionLog.length = 0;
    this.accumulator = 0;
    this.placing = null;
    this.refusal = null;
    if (this.detonatorUp) { this.detonatorUp = false; this.refreshHandModel(); }   // no charge down: no Detonator
    if (this.phase_ !== 'holstered') this.phase_ = this.left[this.item_] > 0 ? 'ready' : 'holstered';
  }

  equipped(): boolean { return this.equipped_; }
  phase(): GrenadePhase { return this.phase_; }
  /** The throwable up (or next taken). */
  item(): GrenadeItem { return this.item_; }
  /** The HUD icon of what is in the hand: the throwable's while it is up, null for the rifle's. */
  icon(): string | null { return !this.equipped_ ? null : this.detonatorUp ? CLAYMORE_RULES.detonator.icon : this.record.icon; }

  /**
   * Takes a throwable up (true; `item`, else the last one), puts it away for the rifle (false) or toggles; false when
   * there is none of it left. Mid-throw the slot stays. The equip event.
   */
  equip(on: boolean = !this.equipped_, item: GrenadeItem = this.item_): boolean {
    if (this.phase_ === 'throwing' || this.phase_ === 'holding') return this.equipped_;
    if (on && this.left[item] <= 0) return this.equipped_;
    if (on === this.equipped_ && (!on || item === this.item_) && !this.detonatorUp) return this.equipped_;
    this.equipped_ = on;
    this.detonatorUp = false;
    if (on) this.item_ = item;
    this.refreshHandModel();
    this.phase_ = on ? 'ready' : 'holstered';
    this.power = 0;
    this.emit('equip', on, on ? item : null);
    return on;
  }

  /** Selects a kit item by name (`1` the rifle, `4` the M67, `5` the HE, `9` the Detonator); false when it cannot be taken up. */
  select(item: KitItem): boolean {
    if (item === 'rifle') return !this.equip(false);
    if (item === 'Detonator') return this.takeDetonator();
    return this.equip(true, item) && this.item_ === item && !this.detonatorUp;
  }

  /** Whether a kit slot can be taken up now (`FUN_005bdc30`: the Detonator only with a charge down). */
  private available(item: KitItem): boolean {
    if (item === 'rifle') return true;
    if (item === 'Detonator') return this.placedCount() > 0;
    return this.left[item] > 0;
  }

  /**
   * The Detonator up (`FUN_005c8a20(0xc1)`): after a claymore goes down, or from the kit while one is down
   * (`FUN_005bdc30`). `force` is the placement's own switch, mid-clip.
   */
  private takeDetonator(force = false): boolean {
    if (!force && (this.phase_ === 'throwing' || this.phase_ === 'holding')) return false;
    if (this.placedCount() === 0) return false;
    if (this.detonatorUp) return true;
    this.equipped_ = true;
    this.detonatorUp = true;
    this.item_ = 'Claymore';
    this.refreshHandModel();
    if (this.phase_ !== 'throwing') this.phase_ = 'ready';
    this.power = 0;
    this.emit('equip', true, 'Detonator');
    return true;
  }

  /**
   * R2, the game's `Inventory` (`controller.rdr`; the menu `FUN_0021bda0` it opens lists the kit's slots): the viewer
   * steps to the next item of the kit that has any left, as a one-press stand-in for the menu [placeholder].
   */
  cycleInventory(): KitItem {
    const now = this.held() ?? 'rifle';
    for (let k = 1; k <= KIT_ITEMS.length; k++) {
      const next = KIT_ITEMS[(KIT_ITEMS.indexOf(now) + k) % KIT_ITEMS.length]!;
      if (this.available(next)) { this.select(next); break; }
    }
    return this.held() ?? 'rifle';
  }

  /**
   * L2, the game's `SwapWeapon2` (`FUN_00594cf0` at 0x5957d8: a press selects the slot the controller keeps at `+0x228`
   * through `FUN_005c4b10`, or plays `FUN_003419c0`'s refusal when the slot is empty): `L2_SLOT_PLACEHOLDER` here, and
   * a second press, already on it, goes back to the rifle [reading].
   */
  swap2(): KitItem {
    if (this.held() === L2_SLOT_PLACEHOLDER) this.select('rifle');
    else this.select(L2_SLOT_PLACEHOLDER);
    return this.held() ?? 'rifle';
  }

  /** The throw's clip done: the next of the same in the hand, or none left and back to the rifle. */
  private finishThrow(): void {
    if (this.detonatorUp || this.left[this.item_] > 0) { this.phase_ = 'ready'; return; }
    this.phase_ = 'holstered';
    this.equipped_ = false;
    this.emit('equip', false, null);
  }

  private refreshHandModel(): void {
    if (this.handModel) this.hand.remove(this.handModel);
    const t = this.template;
    this.handModel = t ? t.clone() : null;
    if (this.handModel) this.hand.add(this.handModel);
  }

  private dropHeld(): void {
    this.heldModel?.object.removeFromParent();
    this.heldModel = null;
  }

  /** The debug trail behind each grenade in flight (off by default: the game draws none). */
  setTrail(on: boolean): void { this.trail = on; }

  /** The fire button pressed with the grenade up: the throw's hold begins, its power from 0 (`FUN_00594cf0`). */
  pull(): void {
    if (!this.equipped_ || this.phase_ !== 'ready' || !this.source.snapshot()) return;
    if (this.detonatorUp) { this.detonateCharges(); return; }
    if (this.left[this.item_] <= 0) return;
    if (isPlaced(this.record)) { this.startPlacing(); return; }
    this.phase_ = 'holding';
    this.power = 0;
    this.pressure = 1;
  }

  /** The fire button let go: the pressure is 0, and the next update throws (`stepThrowPower`'s release). */
  release(): void {
    this.pressure = 0;
  }

  private pressure = 0;

  /**
   * The hook's throw: `holdSeconds` of the button held (`heldPower`), then let go -- the clip, the release and the
   * flight as a real throw's. `immediate` lets go of the grenade now rather than at the clip's release fraction.
   */
  throwNow(holdSeconds: number, immediate = true): ThrowInfo | null {
    if (!this.source.snapshot()) return null;
    if (this.phase_ === 'throwing' && !this.pending) this.finishThrow();   // skip the last clip's tail
    if (!this.equipped_ && !this.equip(true)) return null;
    if (this.phase_ !== 'ready') return null;
    this.power = heldPower(holdSeconds);
    this.startThrow();
    if (!immediate || !this.pending) return null;
    this.pending.left = 0;
    return this.letGo();
  }

  /** One frame: the hold's power, the clip's release, the flight at 60 Hz, the effects, the hand. */
  update(dt: number): void {
    const snap = this.source.snapshot();
    if (!snap) {
      // Out of the walk: a hold is dropped, what is in the air carries on.
      if (this.phase_ === 'holding') { this.phase_ = 'ready'; this.power = 0; }
    }
    if (this.phase_ === 'holding' && snap) {
      const step = stepThrowPower(this.power, this.pressure, dt);
      this.power = step.power;
      if (step.release) this.startThrow();
    }
    if (this.refusal && (this.refusal.left -= dt) <= 0) this.refusal = null;
    if (this.placing) {
      this.placing.left -= dt;
      if (this.placing.left <= 0) {
        const total = this.placing.total;
        this.placing = null;
        this.recover = Math.max(0, total - CLAYMORE_RULES.placeSeconds);
        if (!this.placeCharge()) this.recover = 0;
      }
    } else if (this.pending) {
      this.pending.left -= dt;
      if (this.pending.left <= 0) this.letGo();
    } else if (this.phase_ === 'throwing') {
      this.recover -= dt;
      if (this.recover <= 0) this.finishThrow();
    }
    this.fly(dt);
    this.smokeFrame(dt);
    this.effects(dt);
    this.placeHand(snap);
  }

  stats(): GrenadeStats {
    const r = this.record;
    return {
      equipped: this.equipped_, item: this.item_, leftByItem: { ...this.left }, icon: this.icon() ?? r.icon,
      held: this.held(), placed: this.placedCount(), placing: this.placing !== null, message: this.refusal?.text ?? null,
      inHand: this.heldModel !== null && this.heldModel.object.visible,
      phase: this.phase_, power: this.power, left: this.left[this.item_], thrown: this.thrown,
      record: { name: r.name, fuse: r.fuse, removal: r.removal, gravity: r.gravity, explosionRadius: r.explosionRadius, explosionDamage: r.explosionDamage, capacity: r.capacity, model: r.model },
      live: this.live.map(({ g }) => ({ pos: [...g.pos], vel: [...g.vel], state: g.state, fuse: g.fuse, bounces: g.bounces, age: g.age })),
      lastThrow: this.lastThrow && { ...this.lastThrow },
      bounces: this.bounceLog.slice(-16),
      explosions: this.explosionLog.slice(-8),
      effects: this.particles.length,
      model: this.template !== null,
      trail: this.trail,
      defaultMaterial: this.defaultMaterial,
    };
  }

  /** `4` takes the M67 (or puts it back), `5` the HE, `1` the rifle; while walking, no modifier, not on auto-repeat. */
  bindKey(target: EventTarget = globalThis): void {
    this.unbindKey();
    target.addEventListener('keydown', this.onKey as EventListener);
    this.bound = target;
  }

  unbindKey(): void {
    this.bound?.removeEventListener('keydown', this.onKey as EventListener);
    this.bound = null;
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    const pick = ({ Digit1: 'rifle', Digit4: 'M67', Digit5: 'HE', Digit6: 'AN-M8', Digit7: 'Mark141', Digit8: 'Claymore', Digit9: 'Detonator' } as const)[
      e.code as 'Digit1' | 'Digit4' | 'Digit5' | 'Digit6' | 'Digit7' | 'Digit8' | 'Digit9'];
    if (!pick || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target instanceof HTMLElement && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    if (!this.source.snapshot()) return;
    if (pick !== 'rifle' && this.held() === pick) this.select('rifle');
    else this.select(pick);
  };

  // ---- the placed charges ---------------------------------------------------------------------------------------

  /**
   * The claymore's fire (`FUN_005be9a0`, type -0x67; `CLAYMORE_RULES`): refused with the game's message once
   * `maxPlaced` are down, not started while the SEAL moves faster than `maxSpeed`; else the `Place claymore` action --
   * its clip (`PLACE_CLAYMORE_ANIM`) on the body through the throw's pose layer (the `throwStart` event) and its
   * clock to the charge on the ground (`placeSeconds`). False when it does not start.
   */
  private startPlacing(): boolean {
    const snap = this.source.snapshot();
    if (!snap || this.placing) return false;
    if (this.placedCount() >= CLAYMORE_RULES.maxPlaced) {
      if (!this.refusal) {
        this.refusal = { text: CLAYMORE_RULES.maxPlacedMessage, left: CLAYMORE_RULES.refuseSeconds };
        this.emit('refuse', { item: this.item_, text: this.refusal.text, seconds: CLAYMORE_RULES.refuseSeconds });
      }
      return false;
    }
    if (Math.hypot(snap.vx, snap.vz) > CLAYMORE_RULES.maxSpeed) return false;
    const anim = PLACE_CLAYMORE_ANIM;
    this.placing = { left: CLAYMORE_RULES.placeSeconds, total: throwClipSeconds(anim) };
    this.phase_ = 'throwing';
    this.power = 0;
    this.emit('throwStart', { anim, power: 0, releaseIn: CLAYMORE_RULES.placeSeconds });
    return true;
  }

  /**
   * Sets a claymore down now -- the placing action's end (`FUN_005c2430` then `FUN_005bc730`): the highest ground at
   * or under the right hand's point (`+0x300`) no lower than the feet less `placeDrop`, the charge facing the SEAL's
   * way, still; its fuse never runs (`+0xc5`). Then the Detonator comes up (`FUN_005c8a20(0xc1)`). Null when there is
   * no SEAL, no claymore up, or no ground in reach (nothing is set down, as the game's test fails).
   */
  placeCharge(): V3 | null {
    const snap = this.source.snapshot();
    if (!snap || !this.equipped_ || this.detonatorUp || !isPlaced(this.record) || this.left[this.item_] <= 0) return null;
    const hand = this.source.handPoint?.('rhand', [0, 0, 0]) ?? actorToWorldPoint(snap.feet, snap.yaw, [2, 8, -8]);
    const cast = this.hull();
    const low = snap.feet[1] - CLAYMORE_RULES.placeDrop;
    const hits = cast && hand[1] > low ? cast([hand[0], hand[1] + 1, hand[2]], [hand[0], low, hand[2]]) : [];
    const ground = hits.find((h) => !h.material.volumetric && h.material.penetration !== 1 && !h.material.liquid);
    if (!ground) return null;
    const pos: V3 = [ground.point[0], ground.point[1] + 0.1, ground.point[2]];
    const record = this.record;
    const g = launchGrenade(pos, [0, 0, 0], record);
    g.state = 'rest';
    const model = this.templates[this.item_]?.clone() ?? null;
    if (model) { model.position.set(...pos); model.rotation.set(0, (snap.yaw * Math.PI) / 180, 0); this.object.add(model); }
    this.live.push({ g, model, spin: [0, 0, 0], trail: [], line: null, dots: null, rest: ground.material.name, facing: snap.yaw });
    this.left[this.item_]--;
    this.emit('place', { item: this.item_, pos, yaw: snap.yaw, fireAnim: record.fireAnim });
    this.takeDetonator(true);
    return pos;
  }

  /**
   * The Detonator's fire (`CZKit_DetonateRemoteExplosives`, 0x5c0130): every claymore of the SEAL's within
   * `CLAYMORE_RULES.detonateRange` goes off on the next tick; then the claymore comes back up (`FUN_005c8a20(0x99)`;
   * the rifle when none is left [reading: the game selects the empty slot]). The count set off. The hook calls it
   * without the Detonator up (the fire's rule all the same).
   */
  detonateCharges(): number {
    const snap = this.source.snapshot();
    if (!snap) return 0;
    let n = 0;
    for (const l of this.live) {
      if (l.facing === undefined || l.g.state !== 'rest') continue;
      const d = Math.hypot(l.g.pos[0] - snap.feet[0], l.g.pos[1] - snap.feet[1], l.g.pos[2] - snap.feet[2]);
      if (d <= CLAYMORE_RULES.detonateRange) { l.g.fuse = 0; n++; }
    }
    this.emit('detonate', { count: n, from: [snap.feet[0], snap.feet[1], snap.feet[2]] });
    if (this.detonatorUp && this.phase_ === 'ready') {
      if (this.left.Claymore > 0) this.equip(true, 'Claymore');
      else this.equip(false);
    }
    return n;
  }

  // ---- the throw ----------------------------------------------------------------------------------------------

  /**
   * The body's state for `GetThrowAnim`: 3 (a peek) while the lean holds -- the peek value past `PEEK_THROW`, its side
   * picking the lean's toss (0x57fce0 asks which lean clip plays) -- else the stance.
   */
  private stance(snap: PlaySnapshot): ThrowStance {
    // TRAVERSAL SEAM (web research 86 section 4.4): peeking is state 3, whose throw is the lean's toss -- the snapshot's
    // peek, else the page's source, past half a side.
    const peek = snap.peek ?? this.source.peek?.() ?? 0;
    if (Math.abs(peek) > PEEK_THROW) return peek > 0 ? 'peek-right' : 'peek-left';
    return snap.stance;
  }

  /** The button let go: `GetThrowAnim`'s clip, the release a fraction into it (`releaseSeconds`). */
  private startThrow(): void {
    const snap = this.source.snapshot();
    if (!snap) { this.phase_ = 'ready'; return; }
    // TRAVERSAL SEAM (web research 86 section 4.4): a prone peek has no throw -- `GetThrowAnim` tests only the standing
    // and crouched lean types, returns 0, and the caller clears the throw (decomp 475499-475510).
    if (snap.peek && snap.stance === 'prone') { this.phase_ = 'ready'; return; }
    const aimSin = Math.sin((snap.pitch * Math.PI) / 180);
    const stance = this.stance(snap);
    const anim = throwAnim(this.power, aimSin, stance, snap.vx * snap.vx + snap.vz * snap.vz);
    const releaseIn = releaseSeconds(anim);
    this.pending = { anim, power: this.power, aimSin, stance, left: releaseIn, total: throwClipSeconds(anim) };
    this.phase_ = 'throwing';
    this.emit('throwStart', { anim, power: this.power, releaseIn });
  }

  /** The hand opens: the velocity off the clip's hand (`throwVelocity`), a grenade in the air, its fuse lit. */
  private letGo(): ThrowInfo | null {
    const p = this.pending, snap = this.source.snapshot();
    this.pending = null;
    if (!p || !snap) { this.phase_ = this.equipped_ ? 'ready' : 'holstered'; return null; }
    // The hand as posed now, the game's release point (the left hand for the left lean's toss); the table's point for
    // the hand when there is no posed body (`GetThrowAnim`'s, as the game's own arc preview uses).
    const part = p.anim === THROW_ANIMS.peekLeftToss ? 'lhand' : 'rhand';
    const hand = this.source.handPoint?.(part, RELEASE_POINT) ?? null;
    const local = hand ? worldToActor(snap.feet, snap.yaw, hand) : p.anim.offset;
    const launch = throwVelocity(p.power, p.aimSin, local, maxThrowDistance(p.stance));
    const from = hand ?? actorToWorldPoint(snap.feet, snap.yaw, p.anim.offset);
    const velocity = actorToWorldDir(snap.yaw, launch.velocity);
    const record = this.record;
    const g = launchGrenade(from, velocity, record);
    const model = this.template ? this.template.clone() : null;
    if (model) { model.position.set(...from); this.object.add(model); }
    const spin: V3 = [rand(-1, 1, this.random), rand(-1, 1, this.random), rand(-1, 1, this.random)];
    this.live.push({ g, model, spin, trail: [[...from]], line: null, dots: null, rest: null });
    this.left[this.item_]--;
    this.thrown++;
    this.recover = Math.max(0, p.total - releaseSeconds(p.anim));
    this.phase_ = 'throwing';
    this.power = 0;
    const info: ThrowInfo = {
      power: p.power, anim: p.anim, launch, aimSin: p.aimSin, stance: p.stance, from, velocity, sound: '.THROW_OBJECT',
      fireAnim: record.fireAnim, item: this.item_, fromHand: hand !== null,
    };
    this.lastThrow = {
      power: p.power, aimSin: p.aimSin, stance: p.stance, from, velocity, sound: info.sound, fireAnim: info.fireAnim,
      item: info.item, fromHand: info.fromHand, clip: p.anim.clip, toss: p.anim.toss,
      pitchDeg: (launch.pitch * 180) / Math.PI, speed: launch.speed, maxSpeed: launch.maxSpeed, range: launch.range,
      releaseIn: releaseSeconds(p.anim),
    };
    this.emit('throw', info);
    return info;
  }

  // ---- the flight ---------------------------------------------------------------------------------------------

  private hull(): HullCast | null {
    const grid = this.source.grid();
    if (!grid) return this.cast;              // out of the walk: the last hull still holds what is in the air
    if (grid !== this.castGrid) { this.castGrid = grid; this.cast = gridCast(grid, this.defaultMaterial); }
    return this.cast;
  }

  private fly(dt: number): void {
    if (!this.live.length) { this.accumulator = 0; return; }
    const cast = this.hull() ?? ((): [] => []);
    this.accumulator += dt;
    while (this.accumulator >= FLIGHT_TICK) {
      this.accumulator -= FLIGHT_TICK;
      for (const l of this.live) {
        for (const e of stepGrenade(l.g, FLIGHT_TICK, cast)) this.handle(l, e);
        if (this.trail && l.g.state === 'flight') l.trail.push([...l.g.pos]);
      }
      for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i]!.g.state === 'removed') { this.dropLive(this.live[i]!); this.live.splice(i, 1); }
    }
    for (const l of this.live) this.drawLive(l, dt);
  }

  private handle(l: Live, e: GrenadeEvent): void {
    if (e.kind === 'bounce') {
      const info: BounceInfo = { material: e.material, pos: e.point, speed: e.speed, sound: e.sound, anim: materialAnim(l.g.record.hitAnim, e.material) };
      this.bounceLog.push(info);
      if (this.bounceLog.length > 64) this.bounceLog.shift();
      this.emit('bounce', info);
    } else if (e.kind === 'rest') {
      l.rest = e.material;
    } else if (e.kind === 'explode') {
      this.explode(e.point, l.rest, l.g.record, l);
    }
  }

  private drawLive(l: Live, dt: number): void {
    if (l.model && l.g.state !== 'detonated' && l.facing === undefined) {
      l.model.position.set(...l.g.pos);
      if (l.g.state === 'flight') {
        l.model.rotation.x += l.spin[0] * SPIN_PLACEHOLDER * dt;
        l.model.rotation.y += l.spin[1] * SPIN_PLACEHOLDER * dt;
        l.model.rotation.z += l.spin[2] * SPIN_PLACEHOLDER * dt;
      } else {
        l.model.rotation.set(Math.PI / 2, l.model.rotation.y, 0);   // lying on its side
      }
    }
    if (this.trail && l.trail.length > 1) {
      if (!l.line) {
        l.line = new Line(new BufferGeometry(), new LineBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.9, toneMapped: false, depthTest: false, fog: false }));
        l.line.frustumCulled = false;
        l.line.renderOrder = 10003;                   // a debug overlay: drawn over the world
        this.object.add(l.line);
      }
      l.line.geometry.setAttribute('position', new Float32BufferAttribute(l.trail.flat(), 3));
      if (!l.dots) {
        // A dot a tick along the line, so the arc reads as a flight rather than a hairline.
        l.dots = new Points(new BufferGeometry(), new PointsMaterial({ color: 0xffe080, size: 5, sizeAttenuation: false, toneMapped: false, depthTest: false, fog: false }));
        l.dots.frustumCulled = false;
        l.dots.renderOrder = 10003;
        this.object.add(l.dots);
      }
      l.dots.geometry.setAttribute('position', new Float32BufferAttribute(l.trail.flat(), 3));
    }
  }

  private dropLive(l: Live): void {
    if (l.model) this.object.remove(l.model);
    if (l.line) { this.object.remove(l.line); l.line.geometry.dispose(); (l.line.material as LineBasicMaterial).dispose(); }
    if (l.dots) { this.object.remove(l.dots); l.dots.geometry.dispose(); (l.dots.material as PointsMaterial).dispose(); }
  }

  // ---- the explosion ------------------------------------------------------------------------------------------

  /**
   * The effects' door (`./effects`' `play`): the page hands it in, and a zAnim it can run replaces this file's
   * placeholder sprites for that explosion. Null (or false back) keeps the placeholders.
   */
  setEffectPlayer(play: ((anim: string, at: EffectAt) => boolean) | null): void {
    this.playEffect = play;
  }

  private playEffect: ((anim: string, at: EffectAt) => boolean) | null = null;

  private explode(pos: V3, material: string | null, record: ThrowableRecord, l: Live): void {
    const snap = this.source.snapshot();
    const distance = snap ? Math.hypot(pos[0] - snap.feet[0], pos[1] - snap.feet[1], pos[2] - snap.feet[2]) : null;
    const detonation = detonationOf(record);
    // The flash's rule (0x597c00): the SEAL's forward against the unit direction to the flash.
    let flash: 1 | 2 | 3 | null = null;
    if (detonation === 'flash' && snap && distance !== null) {
      const r = (snap.yaw * Math.PI) / 180, d = distance || 1;
      const facing = (-Math.sin(r) * (pos[0] - snap.feet[0]) - Math.cos(r) * (pos[2] - snap.feet[2])) / d;
      flash = flashLevel(distance, facing);
    }
    const anim = material && record.materialAnim ? materialAnim(record.materialAnim, material) : record.explosionAnim;
    const at: EffectAt = { position: [...pos], normal: material ? [0, 1, 0] : null };
    const byEffects = !!this.playEffect && (this.playEffect(anim, at) || (anim !== record.explosionAnim && this.playEffect(record.explosionAnim, at)));
    const info: ExplosionInfo = {
      pos: [...pos], radius: record.explosionRadius, anim, baseAnim: record.explosionAnim,
      material, distanceToPlayer: distance,
      damageToPlayer: distance === null || !snap ? 0 : this.damageAt(distance, record, l, pos, snap.feet),
      item: record.name, detonation, flash, byEffects,
    };
    this.explosionLog.push(info);
    if (this.explosionLog.length > 32) this.explosionLog.shift();
    if (!byEffects) {
      if (detonation === 'blast') this.burst(pos);
      else if (detonation === 'flash') this.glow(pos);
    }
    if (detonation === 'smoke' && (!byEffects || SMOKE_ALWAYS_PLACEHOLDER)) {
      this.smokes.push({ pos: [...pos], until: record.removal - record.fuse, next: 0, age: 0 });
    }
    if (detonation === 'blast' && material !== null) this.scorch(pos, material);
    // The smoke's canister lies where it went off; the others are gone.
    if (l.model) l.model.visible = detonation === 'smoke';
    this.emit('explode', info);
  }

  private readonly smokes: { pos: V3; until: number; next: number; age: number }[] = [];

  /** `GetDamage` (0x3c7600) at the SEAL's feet: a claymore's a 32nd outside its cone (`claymoreCone`). */
  private damageAt(distance: number, record: ThrowableRecord, l: Live, pos: V3, feet: readonly number[]): number {
    const d = explosionDamage(distance, record);
    if (l.facing === undefined || record !== CLAYMORE) return d;
    const r = (l.facing * Math.PI) / 180;
    const inside = claymoreCone([feet[0]! - pos[0], feet[1]! + 10 - pos[1], feet[2]! - pos[2]], [-Math.sin(r), 0, -Math.cos(r)]);
    return inside ? d : d / 32;
  }

  /** The flashbang's light as a glow (the placeholder for `flashcrash_grenade`'s `explosion_light`). */
  private glow(pos: V3): void {
    const R = EXPLOSION_READING;
    const flash = this.sprite(GRENADE_BITMAPS.fire, true, [1, 1, 1]);
    flash.position.set(pos[0], pos[1] + 3, pos[2]);
    this.particles.push({ sprite: flash, vel: [0, 0, 0], life: R.flash.life * 1.5, age: 0, size: [R.flash.radius[0] / 3, R.flash.radius[1] / 3], gravity: 0, fade: 1 });
  }

  /** `SMOKE_PLACEHOLDER`: each smoke's puffs, from its detonation to its removal. */
  private smokeFrame(dt: number): void {
    const S = SMOKE_PLACEHOLDER, r = this.random;
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const sm = this.smokes[i]!;
      sm.age += dt;
      if (sm.age >= sm.until) { this.smokes.splice(i, 1); continue; }
      sm.next -= dt;
      while (sm.next <= 0) {
        sm.next += S.every;
        const grey = rand(S.grey[1], S.grey[0], r);
        const s = this.sprite(GRENADE_BITMAPS.puff, false, [grey, grey, grey]);
        s.position.set(sm.pos[0], sm.pos[1] + 2, sm.pos[2]);
        const a = rand(0, Math.PI * 2, r), sp = rand(0.2, 1, r) * S.spread;
        this.particles.push({
          sprite: s, vel: [Math.cos(a) * sp, rand(S.rise[0], S.rise[1], r), Math.sin(a) * sp],
          life: rand(S.life[0], S.life[1], r), age: 0, size: ((w: number): [number, number] => [w, w * S.grow])(rand(S.size[0], S.size[1], r)), gravity: 0, fade: 0.9, still: true,
        });
      }
    }
  }

  /** The `frag_grenade` zAnim's parts as sprites (`EXPLOSION_READING`). */
  private burst(pos: V3): void {
    const R = EXPLOSION_READING, r = this.random;
    // The flash is a light in the game (radius 100 -> 190 over 0.5 s); the world's materials take no three.js light,
    // so it is drawn as a glow a fifth of that across, fading over the light's life [reading].
    const flash = this.sprite(GRENADE_BITMAPS.fire, true, R.flash.color);
    flash.position.set(pos[0], pos[1] + 4, pos[2]);
    this.particles.push({ sprite: flash, vel: [0, 0, 0], life: R.flash.life, age: 0, size: [R.flash.radius[0] / 5, R.flash.radius[1] / 5], gravity: 0, fade: 0.9 });
    type Emitter = { count: number; vx: number; vy: readonly [number, number]; size: readonly [number, number]; grow: number; life: readonly [number, number]; gravity: number; grey?: readonly [number, number] };
    const emit = (e: Emitter, bitmap: string, additive: boolean, ground = false): void => {
      for (let i = 0; i < e.count; i++) {
        const grey = e.grey ? rand(e.grey[1], e.grey[0], r) : 1;
        const s = this.sprite(bitmap, additive, [grey, grey, grey]);
        s.position.set(pos[0], pos[1] + (ground ? 1 : 3), pos[2]);
        const a = rand(0, Math.PI * 2, r), sp = rand(0.3, 1, r) * e.vx;
        const size = rand(e.size[0], e.size[1], r);
        this.particles.push({
          sprite: s, vel: [Math.cos(a) * sp, rand(e.vy[0], e.vy[1], r), Math.sin(a) * sp],
          life: rand(e.life[0], e.life[1], r), age: 0, size: [size, size * e.grow], gravity: e.gravity, fade: additive ? 1 : 0.85,
        });
      }
    };
    emit(R.fire, GRENADE_BITMAPS.fire, true);
    emit(R.spark, GRENADE_BITMAPS.spark, true);
    emit(R.smoke, GRENADE_BITMAPS.smoke, false);
    emit(R.dust, GRENADE_BITMAPS.dust, false);
    emit(R.roll, GRENADE_BITMAPS.puff, false, true);
  }

  private sprite(bitmap: string, additive: boolean, color: V3): Sprite {
    const map = this.textures.get(bitmap) ?? null;
    const material = new SpriteMaterial({
      map, color: map ? undefined : additive ? 0xffc070 : 0x807870, transparent: true, depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending, fog: true, toneMapped: false,
    });
    material.color.setRGB(...color);
    const s = new Sprite(material);
    s.frustumCulled = false;
    s.renderOrder = additive ? 10002 : 10001;
    this.object.add(s);
    return s;
  }

  private effects(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        this.object.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.vel[1] -= p.gravity * dt;
      const drag = Math.exp((p.still ? -0.6 : -2.5) * dt);
      p.vel = [p.vel[0] * drag, p.vel[1] * (p.gravity ? 1 : drag), p.vel[2] * drag];
      p.sprite.position.x += p.vel[0] * dt;
      p.sprite.position.y += p.vel[1] * dt;
      p.sprite.position.z += p.vel[2] * dt;
      const size = p.size[0] + (p.size[1] - p.size[0]) * Math.sqrt(t);
      p.sprite.scale.set(size, size, 1);
      // A smoke puff holds thick most of its life, then thins (the screen's); a blast's part fades from the start.
      const fading = p.still ? Math.min(1, (1 - t) / 0.35) : (1 - t) * (1 - t);
      p.sprite.material.opacity = p.fade * fading * (t < (p.still ? 0.15 : 0.04) ? t / (p.still ? 0.15 : 0.04) : 1);
    }
  }

  /**
   * `GRENADE_BLAST`'s `grenade_mark.tif` flat under a grenade that lay on the ground (the material's size, STONE's when
   * unlisted) [reading: the game's decal placement is not traced; one that went off in the air leaves none here].
   */
  private scorch(pos: V3, material: string): void {
    const [min, max] = GRENADE_BLAST[material] ?? GRENADE_BLAST.STONE!;
    const map = this.textures.get(GRENADE_BITMAPS.scorch) ?? null;
    const m = new MeshBasicMaterial({
      map, color: map ? 0xffffff : 0x151210, transparent: true, depthWrite: false, side: DoubleSide, fog: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, opacity: map ? 1 : 0.6,
    });
    const mark = new Mesh(this.scorchGeometry, m);
    const size = rand(min, max, this.random);
    mark.scale.set(size, size, 1);
    mark.rotation.set(-Math.PI / 2, 0, rand(0, Math.PI * 2, this.random));
    mark.position.set(pos[0], pos[1] - 0.05, pos[2]);
    this.object.add(mark);
    this.scorches.push(mark);
    if (this.scorches.length > 16) {
      const old = this.scorches.shift()!;
      this.object.remove(old);
      (old.material as MeshBasicMaterial).dispose();
    }
  }

  // ---- the hand -----------------------------------------------------------------------------------------------

  private placeHand(snap: PlaySnapshot | null): void {
    const held = !!snap && this.equipped_ && (this.detonatorUp || this.left[this.item_] > 0) &&
      (this.phase_ === 'ready' || this.phase_ === 'holding' || !!this.pending || !!this.placing);
    // On the body's held node (the rifle's `rifle` under `rhand`, which the throw clip moves): the grenade in the hand.
    const node = this.source.heldNode?.() ?? null;
    const template = this.template;
    if (node && template) {
      const item = this.held() ?? this.item_;
      if (!this.heldModel || this.heldModel.item !== item || this.heldModel.object.parent !== node) {
        this.dropHeld();
        const object = template.clone();
        node.add(object);
        this.heldModel = { item, object };
      }
      this.heldModel.object.visible = held;
      this.hand.visible = false;
      return;
    }
    this.dropHeld();
    const show = held && this.source.view() === 'third' && this.handModel !== null;
    this.hand.visible = show;
    if (!show || !snap) return;
    let offset: V3 = HAND_PLACEHOLDER;
    if (this.pending) {
      // The clip lifts the hand toward its release point [placeholder for the skeleton's hand].
      const k = 1 - Math.max(0, this.pending.left) / Math.max(1e-6, releaseSeconds(this.pending.anim));
      const to = this.pending.anim.offset;
      offset = [offset[0] + (to[0] - offset[0]) * k, offset[1] + (to[1] - offset[1]) * k, offset[2] + (to[2] - offset[2]) * k];
    }
    const at = actorToWorldPoint(snap.feet, snap.yaw, offset);
    this.hand.position.set(...at);
    this.hand.rotation.set(0, (snap.yaw * Math.PI) / 180, 0);
  }
}

/** A world point into the actor frame at `feet`, turned by `yawDeg` (the inverse of `actorToWorldPoint`). */
export function worldToActor(feet: readonly number[], yawDeg: number, w: readonly number[]): V3 {
  const r = (yawDeg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const dx = w[0]! - feet[0]!, dz = w[2]! - feet[2]!;
  return [dx * c - dz * s, w[1]! - feet[1]!, dx * s + dz * c];
}

/** Every throwable's pouch, full. */
function capacities(records: Readonly<Record<GrenadeItem, ThrowableRecord>>): Record<GrenadeItem, number> {
  return Object.fromEntries(Object.entries(records).map(([k, r]) => [k, r.capacity])) as Record<GrenadeItem, number>;
}

function textureOf(rgba: Rgba): DataTexture {
  const t = new DataTexture(rgba.data, rgba.width, rgba.height, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
