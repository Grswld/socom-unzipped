import {
  BufferGeometry, DataTexture, DoubleSide, Float32BufferAttribute, Group, Line, LineBasicMaterial, LinearFilter, Matrix4, Mesh,
  MeshBasicMaterial, PlaneGeometry, RGBAFormat, UnsignedByteType, Vector3,
} from 'three';
import type { Material } from 'three';
import type { Rgba } from '@s2u/gs';
import { BULLET_MARK, DEFAULT_RIFLE, UNITS_PER_METRE, segmentHit, segmentHits, type DecalEntry, type Grid, type WeaponRecord } from '@s2u/scene';
import { penetrate } from './accuracy';
import { RifleKick, type KickStance, type KickStats } from './rifleKick';

/**
 * Simple shooting (web sprint 2, W2.5; the spec's §4 W2.5): a hitscan round along the aim, at the rifle's own rate,
 * a mark where it meets the hull, a magazine that counts down. No damage, no targets, no recoil beyond the reticle's
 * bloom, no sound (the spec's list).
 *
 * - **The rifle.** `@s2u/scene`'s `DEFAULT_RIFLE`: `RUN/ZWEAPON.ZAR/zweapon.rdr`'s M4A1, the first weapon of
 *   `READERC.ZAR/character.rdr`'s `mp_seal1` kit -- `FireWait 0.12` s between rounds (500 a minute),
 *   `Ammo_Capacity 30`, `NumMags 3`, `Maximum_Range 1000` (`scene/src/weapons.ts` cites the records).
 * - **The ray.** The game fires from the weapon model's `firepoint` node toward the aim point (`FUN_00297410`'s,
 *   1000 ahead along the pitched look: `playerCamera.ts`). WEAPON: with the rifle in the SEAL's hands the source
 *   gives that point (`FireSource.muzzle`: the posed `firepoint`, `./heldItem` -- `+0x14b0` plus the position, the
 *   path `GetPutativeFirePointW` 0x57fa70 takes with a1 false), and the round runs in two legs: the eye's ray along
 *   the view's centre line finds the point under the reticle (the aim point), then the segment from the muzzle to
 *   it finds what the round meets -- the same point unless something stands between the rifle and it (the
 *   convergence is research 79 §4's reading). Without a muzzle (no body, no clips) **the eye stands in for the
 *   firepoint**: the segment runs from the camera's eye through the aim point, `Maximum_Range` long, which lands
 *   under the reticle (the spec's §7, W2.1). `segmentHit` (`scene/src/segment.ts`) walks the grid the probe walks.
 * - **Which surfaces.** Every polygon, walls and floors. The engine's segment test skips bit-18 or bit-19 surfaces
 *   by `DAT_0044d758` (`segment.ts`); the five callers that set it to 1 (`FUN_0029bf70` the camera, `FUN_0057efe0`
 *   the headroom ray, `FUN_00596d60` the peek, `FUN_005aa6e0` a camera-side ray) are none of them a round, and the
 *   round's own path was not found in the sitting, so no class is applied (the brief's fallback).
 * - **The mark.** EFFECTS (`setMarks`, web/docs/research/89 §5): the hit polygon's material's row of the rifle's
 *   `DecalSet`, projected along the round, none where the material has none. Without the tables,
 *   `READERC.ZAR/decals.rdr`'s `BULLET_MARK_SMALL` (the M4A1's `DecalSet`), its `STONE` row:
 *   `bullet_mark_stone.tif` (16x16, off every map archive's `RUN\COMMON\EFFE_TXR.ZED`: `hudBitmaps.ts`), a side
 *   between `MIN_SIZE` 1 and `MAX_SIZE` 1.8 units. The quad lies on the polygon's plane, `DECAL_OFFSET` off it toward
 *   the shooter, facing out. A plain dark disc stands in when the bitmap is absent. At most `MAX_DECALS` are kept,
 *   the oldest recycled (the game's `TEMP_DECAL_POOL` is 150 + 50 overflow: `decals.rdr`).
 * - **The magazine.** 30 in the rifle and `NumMags - 1` = 2 spare -- `NumMags` read as the magazines carried with
 *   the loaded one among them, which is what the console frame's ammo box shows at spawn ("2 MAGS"). `R` reloads
 *   over the reload clip's length when the source knows it (`FireSource.reloadSeconds`: `motion.rdr`'s `playback`
 *   of `seal_reload` 1.6, `seal_crouch_reload` 1.9, `seal_prone_reload` 1.7, `seal_mv_reload` 1.2 -- the M4A1's
 *   record has no `ReloadTime`, so the game's reload is its animation's), else over `RELOAD_SECONDS` [estimate]; a
 *   partly spent magazine is dropped, as a spare is a whole magazine.
 * - **The range** is `Maximum_Range` x `UNITS_PER_METRE` (10): the file's ranges are metres (research 84 §2).
 * - **The gun** (`setGun`, `./accuracy` through `main.ts`; research 84): the eye's ray leaves off the view's centre
 *   line by the reticle's cone and knock (`FUN_005bd100` / `FUN_00592260`), so the point it finds -- the one the
 *   muzzle's leg then fires at -- lies inside the reticle; the fire mode's rounds a pull (single 1, burst 3,
 *   automatic unlimited) and its wait (`FireWait`, x 0.8 in burst and automatic). Without one: straight down the
 *   aim, one round a `FireWait`, held for automatic.
 * - **The trigger.** A press fires at once if the wait has passed since the last round; held, it fires at the rate
 *   while the pull has rounds left. The tracer is drawn for one frame, from the muzzle (or, without one, a stand-in
 *   beside the eye: a line along the view's own centre line would be a point on the screen) to the hit.
 * - **The kick** (WEAPON, `./rifleKick`): the aim's pitch kicked by the stance's `FireRifleKick*` and let back, as the
 *   game's `FUN_005b91c0` / `FUN_005b9280` do, through the source's `look` and `kickPitch` -- **only scoped**: the
 *   game starts it only on a pull's first round in a scope and ticks it only in the 9x view or a scope (research 84
 *   §8), which the gun says (`kickStarts`, `kickTicks`). Unscoped the recoil is the reticle's knock alone.
 * - **The events** (`subscribe`, for the audio and the body): `round` each time a round leaves, with the weapon's
 *   name and id, the fire point in the world, the aim's end and whether it met the hull; `reloadStart` with the
 *   reload's length; `reloadEnd` when the fresh magazine is in (`completed`), or when a reset cut it short.
 */

type Vec3 = [number, number, number];

/** The mark's lift off the polygon's plane, toward the shooter, in units. */
export const DECAL_OFFSET = 0.05;
/**
 * The marks kept; the 151st reuses the oldest. `decals.rdr`'s `TEMP_DECAL_POOL` `BASE 150` (`OVERFLOW 50`): the game
 * trims its temporary pool back to the base, oldest first, every frame (`FUN_003bf110`, research 89 §5).
 */
export const MAX_DECALS = 150;
/** A reload's length in seconds [estimate: the header]. */
export const RELOAD_SECONDS = 2;
/** The tracer's start from the eye, in the view's own axes (right, up, ahead), units [estimate: a muzzle stand-in]. */
const MUZZLE: Vec3 = [1.2, -1.5, 3];
/** A muzzle round's segment runs this far past the aim point, so float rounding cannot make it miss what it aims at. */
const AIM_MARGIN = 0.01;

/** Where the shot comes from and goes toward: the camera's eye and the aim point (`WalkMode.fireAim`). */
export interface FireAim { eye: Vec3; far: Vec3 }
/**
 * The gunplay a round is shot through (`./accuracy`, research 84): `trigger` on each press and release (the pull's
 * count restarts), `roundsPerPull` for the fire mode, `interval` for its wait, `round` for the eye ray's direction
 * off the aim -- called once per round that leaves, which counts it -- and the scoped kick's gate: `kickStarts`
 * (asked after `round`) and `kickTicks`.
 */
export interface FireGun {
  trigger(down: boolean): void;
  roundsPerPull(): number;
  interval(fireWait: number): number;
  round(dir: Vec3): Vec3;
  kickStarts?(): boolean;
  kickTicks?(): boolean;
}

/**
 * What the shot reads from the page: the walk's hull and its aim, each null when there is none (not walking); and,
 * WEAPON, the posed rifle's muzzle in the world (`Play.muzzle`) and the reload clip's length (`Play.reloadSeconds`),
 * each null when there is none.
 */
export interface FireSource {
  grid(): Grid | null;
  aim(): FireAim | null;
  muzzle?(): Vec3 | null;
  reloadSeconds?(): number | null;
  /** WEAPON: the aim's pitch (radians, up positive) and the stance, for the kick (`./rifleKick`); null when not walking. */
  look?(): { pitch: number; stance: KickStance } | null;
  /** WEAPON: turns the aim's pitch by `radians` (the kick). */
  kickPitch?(radians: number): void;
}

/**
 * The weapon an event is about: the record's `InternalName` and `ID` (`zweapon.rdr`: the M4A1 is 54), its muzzle
 * animation (`FireAnimName`) and its sound names (`FireSoundClose`/`Med`/`Far`, `ReloadSound`), null where the record
 * has none.
 */
export interface FireWeapon {
  name: string;
  id: number;
  fireAnim: string | null;
  sounds: { close: string | null; med: string | null; far: string | null; reload: string | null };
}
/**
 * What `Fire` tells its subscribers (the audio workstream's hook, and the body's reload):
 * - `round`: a round left `from` -- the fire point in the world (the muzzle, or the eye without one) -- toward
 *   `to`, where it met the hull when `hit`; `rounds` left in the magazine after it.
 * - `reloadStart`: a reload began, `seconds` long.
 * - `reloadEnd`: the reload finished and the magazine is full (`completed`), or it was cut short (a new map).
 */
export type FireEvent =
  | {
    type: 'round'; weapon: FireWeapon; from: Vec3; to: Vec3; hit: boolean; rounds: number;
    /** EFFECTS: the hit polygon's normal, facing the shooter, and its `material` byte (the SOILS index); null on a miss. */
    normal?: Vec3 | null; material?: number | null;
    /** ACCURACY: the surfaces the round went through before `to`, each struck (research 84 section 10). */
    through?: { point: Vec3; normal: Vec3; material: number | null }[];
  }
  | { type: 'reloadStart'; weapon: FireWeapon; seconds: number }
  | { type: 'reloadEnd'; weapon: FireWeapon; completed: boolean };
export type FireListener = (event: FireEvent) => void;
export interface ShotHit {
  point: Vec3; normal: Vec3; distance: number;
  /** EFFECTS: the polygon's `material` byte, an index into the SOILS table (web/docs/research/81 §4, 89 §5). */
  material?: number;
}
/**
 * EFFECTS (web/docs/research/89 §5): the mark per surface -- the polygon's material byte to its `decals.rdr` row of the
 * rifle's `DecalSet` (null: the material has no row, and the round leaves no mark) and a row's bitmap by texture name
 * (null: the dark disc). Without one every hit takes the constructor's mark.
 */
export interface MarkTable {
  row(material: number): DecalEntry | null;
  bitmap(texture: string): Rgba | null;
  /** The material a mark's bitmap draws with, when the table makes its own (the effects' GS arithmetic, brightened). */
  material?(texture: string): Material | null;
}
/** One round: the segment tested and what it met. */
/**
 * One round: the segment tested and what it met -- `hit` where it stopped (null: it stopped in the air), `through` the
 * surfaces it went through on the way (marked and struck, research 84 section 10).
 */
export interface Shot { from: Vec3; to: Vec3; hit: ShotHit | null; through?: ShotHit[] }
export interface MagazineState { rounds: number; capacity: number; spare: number; reloading: boolean }
export interface FireState { shots: number; magazine: MagazineState; lastHit: ShotHit | null; decals: number; kick: KickStats }

const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

/**
 * The ammo box's line, as the console frame's bottom-left box reads at spawn ("30/30 · 2 MAGS"): the rounds in the
 * rifle over its capacity, then the spare magazines; `· RELOADING` while a reload runs.
 */
export function ammoText(m: MagazineState): string {
  const mags = `${m.spare} MAG${m.spare === 1 ? '' : 'S'}`;
  return `${m.rounds}/${m.capacity} · ${mags}${m.reloading ? ' · RELOADING' : ''}`;
}

/** The least elongation a slanting hit's mark is held to: `|dir . n|` at least this (research 89 §5, a reading). */
export const MARK_GRAZE_FLOOR = 0.2;

/**
 * The game's mark as a matrix on the unit quad (research 89 §5; `FUN_003d0ba0` decomp 323789, `FUN_00307810` 206429):
 * a square `side` across, square to the round's direction `dir` -- its up the world axis least aligned with the surface
 * normal, so no turn -- projected along `dir` onto the surface (the plane through `point` with normal `normal`, which
 * faces the shooter), then lifted `lift` along the normal. The projection stretches the mark on a slanting hit, as the
 * game's does; `MARK_GRAZE_FLOOR` bounds the stretch where the game's clip to the polygon would.
 */
export function projectedMark(point: Vec3, normal: Vec3, dir: Vec3, side: number, lift: number): Matrix4 {
  const n = new Vector3(...normal).normalize();
  const f = new Vector3(...dir).normalize();
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const up0 = axes.reduce((best, a) => (Math.abs(a.dot(n)) < Math.abs(best.dot(n)) ? a : best));
  const right = new Vector3().crossVectors(f, up0);
  if (right.lengthSq() < 1e-12) right.set(1, 0, 0).cross(f);
  right.normalize();
  const up = new Vector3().crossVectors(right, f).normalize();
  let fn = f.dot(n);
  if (Math.abs(fn) < MARK_GRAZE_FLOOR) fn = fn < 0 ? -MARK_GRAZE_FLOOR : MARK_GRAZE_FLOOR;
  // Along f onto the plane: an offset v from the point lands at v - f (v.n) / (f.n).
  const onPlane = (v: Vector3): Vector3 => v.clone().addScaledVector(f, -v.dot(n) / fn).multiplyScalar(side);
  const x = onPlane(right), y = onPlane(up);
  const at = new Vector3(...point).addScaledVector(n, lift);
  return new Matrix4().makeBasis(x, y, n).setPosition(at);
}

/** A dark disc, 16x16, soft at its rim: the mark when `bullet_mark_stone.tif` is not to hand. */
function darkDisc(): Rgba {
  const size = 16, data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 20;
      data[i + 3] = r >= 1 ? 0 : Math.round(220 * Math.min(1, (1 - r) * 3));
    }
  }
  return { width: size, height: size, data };
}

export class Fire {
  /** The marks and the tracer: `main.ts` adds it to the scene. */
  readonly object = new Group();
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly material: MeshBasicMaterial;
  private texture: DataTexture | null = null;
  private readonly decals: Mesh[] = [];
  private nextDecal = 0;
  private readonly tracer: Line;
  private tracerFrames = 0;
  private rounds: number;
  private spare: number;
  private reloadLeft = 0;
  /** Seconds until the next round may go; at most 0 is ready. */
  private wait = 0;
  private held = false;
  private shots = 0;
  private lastHit: ShotHit | null = null;
  private bound: EventTarget | null = null;
  private gun: FireGun | null = null;
  /** Rounds fired since the trigger was pressed (the fire mode's limit). */
  private pulled = 0;
  private readonly listeners = new Set<FireListener>();
  private readonly kick: RifleKick;
  private marks: MarkTable | null = null;
  private penetrationOf: ((material: number | undefined) => number) | null = null;
  private tracerRule: ((weaponId: number, round: number) => boolean) | null = null;
  /** EFFECTS: one material a mark bitmap, made on first use (the constructor's own is `material`). */
  private readonly markMaterials = new Map<string, Material>();

  constructor(
    private readonly source: FireSource,
    private readonly rifle: WeaponRecord = DEFAULT_RIFLE,
    private readonly mark: DecalEntry = BULLET_MARK,
    private readonly random: () => number = Math.random,
  ) {
    this.rounds = rifle.magazine;
    this.spare = Math.max(0, rifle.mags - 1);
    this.kick = new RifleKick(rifle, random);
    this.material = new MeshBasicMaterial({
      transparent: true, depthWrite: false, side: DoubleSide, fog: true, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    });
    this.setBitmap(null);
    const line = new BufferGeometry();
    line.setAttribute('position', new Float32BufferAttribute(new Float32Array(6), 3));
    this.tracer = new Line(line, new LineBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.85, fog: true, toneMapped: false }));
    this.tracer.frustumCulled = false;
    this.tracer.visible = false;
    this.object.add(this.tracer);
  }

  /** The mark's bitmap (`bullet_mark_stone.tif` off the map's `EFFE_TXR.ZED`), or null for the dark disc. */
  setBitmap(rgba: Rgba | null | undefined): void {
    this.texture?.dispose();
    const image = rgba ?? darkDisc();
    const t = new DataTexture(image.data, image.width, image.height, RGBAFormat, UnsignedByteType);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.texture = t;
    this.material.map = t;
    this.material.needsUpdate = true;
  }

  /** The gunplay the rounds go through (`FireGun`), or null for a straight shot at `FireWait`. */
  setGun(gun: FireGun | null): void {
    this.gun = gun;
  }

  /**
   * EFFECTS: which rounds draw the tracer -- `(weapon id, the round's count from 1) => boolean`, the game's
   * `tracerRound` (`@s2u/scene`) -- or null for every round.
   */
  setTracerRule(rule: ((weaponId: number, round: number) => boolean) | null): void {
    this.tracerRule = rule;
  }

  /** EFFECTS: the per-material marks (`MarkTable`), or null for the constructor's one mark on every surface. */
  /**
   * ACCURACY (research 84 section 10): a polygon's material byte to its `PENETRATION` (`materials.rdr` SOILS), so the
   * round passes over the 1.0 materials and goes through the others by the game's rule; null: every surface stops it.
   */
  setPenetration(penetrationOf: ((material: number | undefined) => number) | null): void {
    this.penetrationOf = penetrationOf;
  }

  setMarks(marks: MarkTable | null): void {
    this.marks = marks;
    for (const m of this.markMaterials.values()) { (m as MeshBasicMaterial).map?.dispose(); m.dispose(); }
    this.markMaterials.clear();
  }

  private markMaterial(texture: string): Material {
    const known = this.markMaterials.get(texture);
    if (known) return known;
    const provided = this.marks?.material?.(texture) ?? null;
    if (provided) { this.markMaterials.set(texture, provided); return provided; }
    const m = this.material.clone();
    const image = this.marks?.bitmap(texture) ?? darkDisc();
    const t = new DataTexture(image.data, image.width, image.height, RGBAFormat, UnsignedByteType);
    t.magFilter = LinearFilter;
    t.minFilter = LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    m.map = t;
    this.markMaterials.set(texture, m);
    return m;
  }

  /** The trigger pressed: a round now if the rifle is ready; held, `update` keeps firing at the rate. */
  pull(): Shot | null {
    if (!this.held) { this.pulled = 0; this.gun?.trigger(true); }
    this.held = true;
    return this.pullRound();
  }

  release(): void {
    if (this.held) this.gun?.trigger(false);
    this.held = false;
    this.pulled = 0;
  }

  /** A round of the pull, if the fire mode has one left. */
  private pullRound(): Shot | null {
    if (this.gun && this.pulled >= this.gun.roundsPerPull()) return null;
    const shot = this.tryFire();
    if (shot) this.pulled++;
    return shot;
  }

  /** Whether the trigger is down (the rifle's raise reads it: `./weaponRaise`). */
  triggerHeld(): boolean {
    return this.held;
  }

  /** Calls `listener` with every round and reload (`FireEvent`); returns the unsubscribe. */
  subscribe(listener: FireListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: FireEvent): void {
    for (const l of [...this.listeners]) l(event);
  }

  private weapon(): FireWeapon {
    const s = this.rifle.sounds;
    return { name: this.rifle.name, id: this.rifle.id, fireAnim: this.rifle.fireAnim ?? null, sounds: s ? { ...s } : { close: null, med: null, far: null, reload: null } };
  }

  /** One round now if the rate, the magazine and the aim allow: the hook's `shoot()`. */
  shoot(): Shot | null {
    return this.tryFire();
  }

  /** `R`: a fresh magazine from the spares over `RELOAD_SECONDS`; false when full, out of spares or already at it. */
  reload(): boolean {
    if (this.reloadLeft > 0 || this.spare <= 0 || this.rounds >= this.rifle.magazine) return false;
    const clip = this.source.reloadSeconds?.() ?? null;
    this.reloadLeft = clip !== null && clip > 0 ? clip : RELOAD_SECONDS;
    this.emit({ type: 'reloadStart', weapon: this.weapon(), seconds: this.reloadLeft });
    return true;
  }

  /**
   * One frame, before it is drawn: the reload, the rate's wait, a held trigger's rounds, the scoped kick, and the
   * tracer's one frame -- a tracer lit since the last frame is drawn in this one and gone in the next.
   */
  update(dt: number): number {
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 1e-9) {
        this.reloadLeft = 0; this.rounds = this.rifle.magazine; this.spare--;
        this.emit({ type: 'reloadEnd', weapon: this.weapon(), completed: true });
      }
    }
    if (this.tracerFrames > 0) this.tracerFrames--;
    else this.tracer.visible = false;
    this.wait -= dt;
    let fired = 0;
    while (this.held && this.wait <= 1e-9 && this.pullRound()) fired++;
    if (this.wait < 0) this.wait = 0;
    if (fired > 0) this.tracerFrames = 0;           // lit in this frame: drawn in it, gone in the next
    const look = this.source.look?.() ?? null;
    const ticks = !this.gun?.kickTicks || this.gun.kickTicks();   // research 84 §8: the kick ticks only scoped
    if (look && ticks) {
      const turn = this.kick.frame(dt, look.pitch);
      if (turn !== 0) this.source.kickPitch?.(turn);
    } else this.kick.reset();
    return fired;
  }

  tracerVisible(): boolean {
    return this.tracer.visible;
  }

  /** The marks placed so far, oldest first until the pool wraps (tests and the hook). */
  decalMeshes(): Mesh[] {
    return this.decals;
  }

  state(): FireState {
    return {
      shots: this.shots,
      magazine: { rounds: this.rounds, capacity: this.rifle.magazine, spare: this.spare, reloading: this.reloadLeft > 0 },
      lastHit: this.lastHit ? { ...this.lastHit, point: [...this.lastHit.point], normal: [...this.lastHit.normal] } : null,
      decals: this.decals.filter((d) => d.visible).length,
      kick: this.kick.stats(),
    };
  }

  /** A new map: the marks go, the magazines are full again. */
  reset(): void {
    if (this.reloadLeft > 0) this.emit({ type: 'reloadEnd', weapon: this.weapon(), completed: false });
    for (const d of this.decals) this.object.remove(d);
    this.decals.length = 0;
    this.nextDecal = 0;
    this.rounds = this.rifle.magazine;
    this.spare = Math.max(0, this.rifle.mags - 1);
    this.reloadLeft = 0;
    this.wait = 0;
    this.held = false;
    this.lastHit = null;
    this.pulled = 0;
    this.kick.reset();
    this.tracerFrames = 0;
    this.tracer.visible = false;
  }

  /** `R` on `target` while walking (the aim is there), ignored with a modifier -- Ctrl+R stays the browser's -- and on repeat. */
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
    if (e.code !== 'KeyR' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || !this.source.aim()) return;
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    e.preventDefault();
    this.reload();
  };

  private tryFire(): Shot | null {
    if (this.wait > 1e-9 || this.reloadLeft > 0 || this.rounds <= 0) return null;
    const aim = this.source.aim(), grid = this.source.grid();
    if (!aim || !grid) return null;
    const look = unit(sub(aim.far, aim.eye));
    // Research 84: the eye's ray leaves by the reticle's cone and knock (without a gun, straight down the view).
    const ray = this.gun ? unit(this.gun.round(look)) : look;
    const reach = this.rifle.maximumRange * UNITS_PER_METRE;
    const eyeEnd: Vec3 = [aim.eye[0] + ray[0] * reach, aim.eye[1] + ray[1] * reach, aim.eye[2] + ray[2] * reach];
    const muzzle = this.source.muzzle?.() ?? null;
    let from: Vec3 = [...aim.eye], dir = ray, end = eyeEnd, fromMuzzle = false;
    if (muzzle) {
      // Two legs: the eye's ray finds the point under the reticle, the muzzle's segment what the round meets on the
      // way to it (see the header). The segment runs a hair past the aim point, so rounding cannot stop it short.
      // (The eye's ray, like the round, passes over the PENETRATION 1 materials: the volumes, the action boxes.)
      const pen = this.penetrationOf;
      const seen = segmentHit(grid, aim.eye, eyeEnd, pen ? (p) => pen(p.material) !== 1 : undefined);
      const target: Vec3 = seen ? [...seen.point] : eyeEnd;
      const toward = sub(target, muzzle);
      const length = Math.hypot(...toward);
      if (length > AIM_MARGIN) {
        from = [...muzzle];
        fromMuzzle = true;
        dir = unit(toward);
        end = [from[0] + dir[0] * (length + AIM_MARGIN), from[1] + dir[1] * (length + AIM_MARGIN), from[2] + dir[2] * (length + AIM_MARGIN)];
        if (!seen) end = target;
      }
    }
    const span = Math.hypot(...sub(end, from));
    const face = (h: { point: readonly number[]; normal: readonly number[]; t: number; poly: { material?: number } }, scale: number): ShotHit => {
      // Newell's normal points either way: the mark faces the shooter.
      const d = h.normal[0]! * dir[0] + h.normal[1]! * dir[1] + h.normal[2]! * dir[2];
      const normal: Vec3 = d > 0 ? [-h.normal[0]!, -h.normal[1]!, -h.normal[2]!] : [h.normal[0]!, h.normal[1]!, h.normal[2]!];
      return { point: [h.point[0]!, h.point[1]!, h.point[2]!], normal, distance: h.t * scale, material: h.poly.material };
    };
    let hit: ShotHit | null = null;
    const through: ShotHit[] = [];
    if (this.penetrationOf) {
      // Research 84 section 10: the round's own path from where it leaves, its whole range, every surface in order.
      const far: Vec3 = [from[0] + dir[0] * reach, from[1] + dir[1] * reach, from[2] + dir[2] * reach];
      const hits = segmentHits(grid, from, far);
      const path = penetrate(hits.map((h) => ({ distance: h.t * reach, penetration: this.penetrationOf!(h.poly.material) })), reach, this.rifle.piercing ?? 0);
      const struck = path.struck.map((i) => face(hits[i]!, reach));
      for (const s of struck) this.place(s, dir);
      if (path.through) { through.push(...struck); end = [from[0] + dir[0] * path.range, from[1] + dir[1] * path.range, from[2] + dir[2] * path.range]; }
      else { hit = struck.pop() ?? null; through.push(...struck); }
    } else {
      const h = segmentHit(grid, from, end);
      if (h) { hit = face(h, span); this.place(hit, dir); }
    }
    this.rounds--;
    this.shots++;
    this.wait += this.gun ? this.gun.interval(this.rifle.fireWait) : this.rifle.fireWait;
    this.lastHit = hit;
    // EFFECTS: the game's rule, when one is set (`setTracerRule`): the M4A1 SD draws none (research 89 §6).
    if (!this.tracerRule || this.tracerRule(this.rifle.id, this.shots)) this.drawTracer(from, dir, hit ? hit.point : end, fromMuzzle);
    const shot: Shot = { from, to: hit ? [...hit.point] : end, hit, ...(through.length ? { through } : {}) };
    const aimNow = this.source.look?.() ?? null;
    if (aimNow && (!this.gun?.kickStarts || this.gun.kickStarts())) this.kick.round(aimNow.pitch, aimNow.stance);
    this.emit({
      type: 'round', weapon: this.weapon(), from: [...shot.from], to: [...shot.to], hit: hit !== null, rounds: this.rounds,
      normal: hit ? [...hit.normal] : null, material: hit?.material ?? null,
      ...(through.length ? { through: through.map((t) => ({ point: [...t.point] as Vec3, normal: [...t.normal] as Vec3, material: t.material ?? null })) } : {}),
    });
    return shot;
  }

  private place(hit: ShotHit, dir: Vec3): void {
    const row = this.marks && hit.material !== undefined ? this.marks.row(hit.material) : this.mark;
    if (!row) return;                                   // EFFECTS: a surface without a row takes no mark
    let mesh = this.decals.length < MAX_DECALS ? undefined : this.decals[this.nextDecal];
    if (!mesh) {
      mesh = new Mesh(this.geometry, this.material);
      mesh.renderOrder = 1;
      this.decals.push(mesh);
      this.object.add(mesh);
    }
    this.nextDecal = (this.nextDecal + 1) % MAX_DECALS;
    const n = new Vector3(...hit.normal);
    if (this.marks) {
      // EFFECTS: the game's mark (`FUN_003d0ba0`, decomp 323789; research 89 §5): the size drawn once, the square
      // projected along the round's direction onto the surface -- stretched on a slanting hit -- with no turn.
      const side = row.minSize + this.random() * (row.maxSize - row.minSize);
      mesh.material = this.markMaterial(row.texture);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(projectedMark(hit.point, hit.normal, dir, side, DECAL_OFFSET));
      mesh.position.setFromMatrixPosition(mesh.matrix);   // the matrix is sheared: position only, for the hook
      mesh.visible = true;
      mesh.updateMatrixWorld(true);
      return;
    }
    mesh.matrixAutoUpdate = true;
    mesh.position.set(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(n, DECAL_OFFSET);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), n);
    // A turn about the normal, so the marks do not all share one grain.
    mesh.rotateZ(this.random() * Math.PI * 2);
    const side = row.minSize + this.random() * (row.maxSize - row.minSize);
    mesh.material = this.material;
    mesh.scale.set(side, side, 1);
    mesh.visible = true;
    mesh.updateMatrixWorld();
  }

  private drawTracer(eye: Vec3, dir: Vec3, to: Vec3, fromMuzzle = false): void {
    const ahead = new Vector3(...dir);
    const right = new Vector3().crossVectors(ahead, new Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, ahead).normalize();
    const start = fromMuzzle ? new Vector3(...eye)
      : new Vector3(...eye).addScaledVector(right, MUZZLE[0]).addScaledVector(up, MUZZLE[1]).addScaledVector(ahead, MUZZLE[2]);
    const position = this.tracer.geometry.getAttribute('position') as Float32BufferAttribute;
    position.setXYZ(0, start.x, start.y, start.z);
    position.setXYZ(1, to[0], to[1], to[2]);
    position.needsUpdate = true;
    this.tracer.geometry.computeBoundingSphere();
    this.tracer.visible = true;
    this.tracerFrames = 1;
  }
}
