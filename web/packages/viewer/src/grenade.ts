import {
  AdditiveBlending, DataTexture, DoubleSide, Group, LinearFilter, Mesh, MeshBasicMaterial, NormalBlending, PlaneGeometry,
  RGBAFormat, Sprite, SpriteMaterial, UnsignedByteType, BufferGeometry, Float32BufferAttribute, Line,
  LineBasicMaterial, Points, PointsMaterial, type Texture,
} from 'three';
import type { Rgba } from '@s2u/gs';
import {
  actorToWorldDir, actorToWorldPoint, explosionDamage, GRENADE_BLAST, gridCast, heldPower, launchGrenade, M67,
  materialAnim, maxThrowDistance, releaseSeconds, stepGrenade, stepThrowPower, throwAnim, throwVelocity,
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
 * - **The slot.** In SOCOM II the grenade is a weapon slot (the d-pad / Select picks it) thrown with the fire button
 *   (R1). Here: `4` takes the grenade, `1` (or `4` again) the rifle; the fire trigger (the left button, the touch fire
 *   button) throws while the grenade is up (`main.ts` routes it). The pad's binding is the UI workstream's to add.
 * - **The throw.** Held, the power chases the button's pressure (`stepThrowPower`: a key or a click is pressure 1, so
 *   the power is how long it was held: 0.54 at a quarter second, 0.95 at one); let go, `GetThrowAnim` picks the clip
 *   (a toss under power 0.6 with the aim under sin 0.3), and at its release fraction the grenade leaves the hand at
 *   `throwVelocity`'s velocity from the clip's hand offset, its fuse (`Timer1` 3 s) starting then.
 * - **The flight.** `stepGrenade` at 60 Hz (`FLIGHT_TICK`), over `gridCast` of the walk's hull with the map's
 *   `DefaultMaterial`: gravity 98, the bounce at each material's ELASTICITY_COEFF, the rest under 5 units/s, the
 *   explosion at 3 s where it lies, the removal at 3.1.
 * - **Drawn.** The `grenade` model (`WEAP_GEO`) in the hand (`HAND_PLACEHOLDER` until the skeleton's `rhand` is offered)
 *   and in flight (tumbling at `SPIN_PLACEHOLDER`); the explosion as the `frag_grenade` zAnim's parts read off their
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

/** What the walk offers the grenade: the hull, the mover as the body reads it, the view. */
export interface GrenadeSource {
  grid(): Grid | null;
  snapshot(): PlaySnapshot | null;
  view(): WalkView;
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
  /** The zAnim the game plays at the throw (`FireAnimName` `frag_start` -> `.THROW_OBJECT`). */
  sound: string;
}

export interface BounceInfo { material: string; pos: V3; speed: number; sound: boolean; anim: string }
export interface ExplosionInfo {
  pos: V3;
  /** `Explosion_Radius` x10. */
  radius: number;
  /** The zAnim (`frag_grenade`; the material's own `frag_grenade_<material>` where the game has one). */
  anim: string;
  /** The material under it, when it lay on one. */
  material: string | null;
  /** `explosionDamage` at the player's feet, 0 beyond the radius (nothing takes it). */
  damageToPlayer: number;
  distanceToPlayer: number | null;
}

/** The events other workstreams hang off (`on`). */
export interface GrenadeEvents {
  /** The slot changed: the weapon workstream hides the rifle while this is true. */
  equip: (equipped: boolean) => void;
  /** The throw's clip starts: the motion workstream plays `anim.clip` at `anim.playback`; the hand lets go in `releaseIn` s. */
  throwStart: (info: { anim: ThrowAnim; power: number; releaseIn: number }) => void;
  /** The grenade leaves the hand (audio: `.THROW_OBJECT`). */
  throw: (info: ThrowInfo) => void;
  /** A bounce (audio: the material's `grenade_hit_*` zAnim when `sound`). */
  bounce: (info: BounceInfo) => void;
  /** The explosion (audio `.GREN_MED`; the look workstream's screen shake by distance). */
  explode: (info: ExplosionInfo) => void;
}

export interface GrenadeStats {
  equipped: boolean;
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

interface Particle { sprite: Sprite; vel: V3; life: number; age: number; size: [number, number]; gravity: number; fade: number }
/** A grenade in the air or on the ground; `rest` is the material it came to rest on, null while it has not. */
interface Live { g: Grenade; model: Group | null; spin: V3; trail: V3[]; line: Line | null; dots: Points | null; rest: string | null }
interface Pending { anim: ThrowAnim; power: number; aimSin: number; stance: ThrowStance; left: number; total: number }

type Listeners = { [K in keyof GrenadeEvents]: GrenadeEvents[K][] };

export class GrenadeThrower {
  /** Everything drawn: the hand's grenade, the ones in flight, the effects, the scorches. `main.ts` adds it once. */
  readonly object = new Group();
  private template: Group | null = null;
  private readonly hand = new Group();
  private handModel: Group | null = null;
  private textures = new Map<string, Texture>();
  private defaultMaterial = '';
  private cast: HullCast | null = null;
  private castGrid: Grid | null = null;
  private equipped_ = false;
  private phase_: GrenadePhase = 'holstered';
  private power = 0;
  private left: number;
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
  private readonly listeners: Listeners = { equip: [], throwStart: [], throw: [], bounce: [], explode: [] };
  private bound: EventTarget | null = null;
  private readonly scorchGeometry = new PlaneGeometry(1, 1);

  constructor(
    private readonly source: GrenadeSource,
    private readonly record: ThrowableRecord = M67,
    private readonly random: () => number = Math.random,
  ) {
    this.left = record.capacity;
    this.object.add(this.hand);
    this.hand.visible = false;
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

  private emit<K extends keyof GrenadeEvents>(kind: K, arg: Parameters<GrenadeEvents[K]>[0]): void {
    for (const fn of this.listeners[kind] as ((a: typeof arg) => void)[]) fn(arg);
  }

  /** A new map: its grenade model (`WorldView.grenade`) and assets; the pouch refilled, the air and the ground cleared. */
  setMap(template: Group | null, assets: GrenadeAssets | null | undefined): void {
    this.reset();
    this.template = template;
    if (this.handModel) this.hand.remove(this.handModel);
    this.handModel = template ? template.clone() : null;
    if (this.handModel) this.hand.add(this.handModel);
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
    for (const s of this.scorches) { this.object.remove(s); (s.material as MeshBasicMaterial).dispose(); }
    this.scorches.length = 0;
    this.left = this.record.capacity;
    this.thrown = 0;
    this.pending = null;
    this.recover = 0;
    this.power = 0;
    this.lastThrow = null;
    this.bounceLog.length = 0;
    this.explosionLog.length = 0;
    this.accumulator = 0;
    if (this.phase_ !== 'holstered') this.phase_ = this.left > 0 ? 'ready' : 'holstered';
  }

  equipped(): boolean { return this.equipped_; }
  phase(): GrenadePhase { return this.phase_; }

  /** Takes the grenade (true), the rifle (false) or toggles; false when there is none left to take. The equip event. */
  equip(on: boolean = !this.equipped_): boolean {
    if (on && this.left <= 0 && this.phase_ !== 'throwing') on = false;
    if (on === this.equipped_) return this.equipped_;
    if (!on && this.phase_ === 'throwing') return this.equipped_;          // mid-throw the slot stays
    this.equipped_ = on;
    this.phase_ = on ? 'ready' : 'holstered';
    this.power = 0;
    this.emit('equip', on);
    return on;
  }

  /** The debug trail behind each grenade in flight (off by default: the game draws none). */
  setTrail(on: boolean): void { this.trail = on; }

  /** The fire button pressed with the grenade up: the throw's hold begins, its power from 0 (`FUN_00594cf0`). */
  pull(): void {
    if (!this.equipped_ || this.phase_ !== 'ready' || this.left <= 0 || !this.source.snapshot()) return;
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
    if (!this.equipped_ && !this.equip(true)) return null;
    if (this.phase_ === 'throwing' && !this.pending && this.left > 0) this.phase_ = 'ready';   // skip the last clip's tail
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
    if (this.pending) {
      this.pending.left -= dt;
      if (this.pending.left <= 0) this.letGo();
    } else if (this.phase_ === 'throwing') {
      this.recover -= dt;
      if (this.recover <= 0) {
        if (this.left > 0) this.phase_ = 'ready';
        else { this.phase_ = 'holstered'; this.equipped_ = false; this.emit('equip', false); }
      }
    }
    this.fly(dt);
    this.effects(dt);
    this.placeHand(snap);
  }

  stats(): GrenadeStats {
    const r = this.record;
    return {
      equipped: this.equipped_, phase: this.phase_, power: this.power, left: this.left, thrown: this.thrown,
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

  /** `4` takes the grenade (or puts it back), `1` the rifle; while walking, no modifier, not on auto-repeat. */
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
    if ((e.code !== 'Digit4' && e.code !== 'Digit1') || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.target instanceof HTMLElement && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    if (!this.source.snapshot()) return;
    this.equip(e.code === 'Digit4' ? !this.equipped_ : false);
  };

  // ---- the throw ----------------------------------------------------------------------------------------------

  private stance(snap: PlaySnapshot): ThrowStance {
    return snap.stance;
  }

  /** The button let go: `GetThrowAnim`'s clip, the release a fraction into it (`releaseSeconds`). */
  private startThrow(): void {
    const snap = this.source.snapshot();
    if (!snap) { this.phase_ = 'ready'; return; }
    const aimSin = Math.sin((snap.pitch * Math.PI) / 180);
    const stance = this.stance(snap);
    const anim = throwAnim(this.power, aimSin, stance, snap.vx * snap.vx + snap.vz * snap.vz);
    const releaseIn = releaseSeconds(anim);
    this.pending = { anim, power: this.power, aimSin, stance, left: releaseIn, total: anim.duration / anim.playback };
    this.phase_ = 'throwing';
    this.emit('throwStart', { anim, power: this.power, releaseIn });
  }

  /** The hand opens: the velocity off the clip's hand (`throwVelocity`), a grenade in the air, its fuse lit. */
  private letGo(): ThrowInfo | null {
    const p = this.pending, snap = this.source.snapshot();
    this.pending = null;
    if (!p || !snap) { this.phase_ = this.equipped_ ? 'ready' : 'holstered'; return null; }
    const launch = throwVelocity(p.power, p.aimSin, p.anim.offset, maxThrowDistance(p.stance));
    const from = actorToWorldPoint(snap.feet, snap.yaw, p.anim.offset);
    const velocity = actorToWorldDir(snap.yaw, launch.velocity);
    const g = launchGrenade(from, velocity, this.record);
    const model = this.template ? this.template.clone() : null;
    if (model) { model.position.set(...from); this.object.add(model); }
    const spin: V3 = [rand(-1, 1, this.random), rand(-1, 1, this.random), rand(-1, 1, this.random)];
    this.live.push({ g, model, spin, trail: [[...from]], line: null, dots: null, rest: null });
    this.left--;
    this.thrown++;
    this.recover = Math.max(0, p.total - releaseSeconds(p.anim));
    this.phase_ = 'throwing';
    this.power = 0;
    const info: ThrowInfo = { power: p.power, anim: p.anim, launch, aimSin: p.aimSin, stance: p.stance, from, velocity, sound: '.THROW_OBJECT' };
    this.lastThrow = {
      power: p.power, aimSin: p.aimSin, stance: p.stance, from, velocity, sound: info.sound, clip: p.anim.clip, toss: p.anim.toss,
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
        for (const e of stepGrenade(l.g, FLIGHT_TICK, cast, this.record)) this.handle(l, e);
        if (this.trail && l.g.state === 'flight') l.trail.push([...l.g.pos]);
      }
      for (let i = this.live.length - 1; i >= 0; i--) if (this.live[i]!.g.state === 'removed') { this.dropLive(this.live[i]!); this.live.splice(i, 1); }
    }
    for (const l of this.live) this.drawLive(l, dt);
  }

  private handle(l: Live, e: GrenadeEvent): void {
    if (e.kind === 'bounce') {
      const info: BounceInfo = { material: e.material, pos: e.point, speed: e.speed, sound: e.sound, anim: materialAnim(this.record.hitAnim, e.material) };
      this.bounceLog.push(info);
      if (this.bounceLog.length > 64) this.bounceLog.shift();
      this.emit('bounce', info);
    } else if (e.kind === 'rest') {
      l.rest = e.material;
    } else if (e.kind === 'explode') {
      this.explode(e.point, l.rest);
      if (l.model) l.model.visible = false;
    }
  }

  private drawLive(l: Live, dt: number): void {
    if (l.model && l.g.state !== 'detonated') {
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

  private explode(pos: V3, material: string | null): void {
    const snap = this.source.snapshot();
    const distance = snap ? Math.hypot(pos[0] - snap.feet[0], pos[1] - snap.feet[1], pos[2] - snap.feet[2]) : null;
    const info: ExplosionInfo = {
      pos: [...pos], radius: this.record.explosionRadius,
      anim: material ? materialAnim(this.record.explosionAnim, material) : this.record.explosionAnim,
      material, distanceToPlayer: distance,
      damageToPlayer: distance === null ? 0 : explosionDamage(distance, this.record),
    };
    this.explosionLog.push(info);
    if (this.explosionLog.length > 32) this.explosionLog.shift();
    this.burst(pos);
    if (material !== null) this.scorch(pos, material);
    this.emit('explode', info);
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
      const drag = Math.exp(-2.5 * dt);
      p.vel = [p.vel[0] * drag, p.vel[1] * (p.gravity ? 1 : drag), p.vel[2] * drag];
      p.sprite.position.x += p.vel[0] * dt;
      p.sprite.position.y += p.vel[1] * dt;
      p.sprite.position.z += p.vel[2] * dt;
      const size = p.size[0] + (p.size[1] - p.size[0]) * Math.sqrt(t);
      p.sprite.scale.set(size, size, 1);
      p.sprite.material.opacity = p.fade * (1 - t) * (1 - t) * (t < 0.04 ? t / 0.04 : 1);
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
    const show = !!snap && this.equipped_ && this.left > 0 && (this.phase_ === 'ready' || this.phase_ === 'holding' || !!this.pending)
      && this.source.view() === 'third' && this.handModel !== null;
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

function textureOf(rgba: Rgba): DataTexture {
  const t = new DataTexture(rgba.data, rgba.width, rgba.height, RGBAFormat, UnsignedByteType);
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
