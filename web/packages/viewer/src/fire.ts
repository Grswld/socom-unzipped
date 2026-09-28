import {
  BufferGeometry, DataTexture, DoubleSide, Float32BufferAttribute, Group, Line, LineBasicMaterial, LinearFilter, Mesh,
  MeshBasicMaterial, PlaneGeometry, RGBAFormat, UnsignedByteType, Vector3,
} from 'three';
import type { Rgba } from '@s2u/gs';
import { BULLET_MARK, DEFAULT_RIFLE, segmentHit, type DecalEntry, type Grid, type WeaponRecord } from '@s2u/scene';

/**
 * Simple shooting (web sprint 2, W2.5; the spec's §4 W2.5): a hitscan round along the aim, at the rifle's own rate,
 * a mark where it meets the hull, a magazine that counts down. No damage, no targets, no recoil beyond the reticle's
 * bloom, no sound (the spec's list).
 *
 * - **The rifle.** `@s2u/scene`'s `DEFAULT_RIFLE`: `RUN/ZWEAPON.ZAR/zweapon.rdr`'s M4A1, the first weapon of
 *   `READERC.ZAR/character.rdr`'s `mp_seal1` kit -- `FireWait 0.12` s between rounds (500 a minute),
 *   `Ammo_Capacity 30`, `NumMags 3`, `Maximum_Range 1000` (`scene/src/weapons.ts` cites the records).
 * - **The ray.** The game fires from the weapon model's `firepoint` node toward the aim point (`FUN_00297410`'s,
 *   1000 ahead along the pitched look: `playerCamera.ts`). The viewer has no weapon model, so **the eye stands in
 *   for the firepoint**: the segment runs from the camera's eye through the aim point, `Maximum_Range` long. Its
 *   line is the view's centre line, so the round lands under the reticle (the spec's §7, W2.1: the aim point
 *   projects to the frame's centre at rest). `segmentHit` (`scene/src/segment.ts`) walks the grid the probe walks.
 * - **Which surfaces.** Every polygon, walls and floors. The engine's segment test skips bit-18 or bit-19 surfaces
 *   by `DAT_0044d758` (`segment.ts`); the five callers that set it to 1 (`FUN_0029bf70` the camera, `FUN_0057efe0`
 *   the headroom ray, `FUN_00596d60` the peek, `FUN_005aa6e0` a camera-side ray) are none of them a round, and the
 *   round's own path was not found in the sitting, so no class is applied (the brief's fallback).
 * - **The mark.** `READERC.ZAR/decals.rdr`'s `BULLET_MARK_SMALL` (the M4A1's `DecalSet`), its `STONE` row:
 *   `bullet_mark_stone.tif` (16x16, off every map archive's `RUN\COMMON\EFFE_TXR.ZED`: `hudBitmaps.ts`), a side
 *   between `MIN_SIZE` 1 and `MAX_SIZE` 1.8 units. The quad lies on the polygon's plane, `DECAL_OFFSET` off it toward
 *   the shooter, facing out. A plain dark disc stands in when the bitmap is absent. At most `MAX_DECALS` are kept,
 *   the oldest recycled (the game's `TEMP_DECAL_POOL` is 150 + 50 overflow: `decals.rdr`).
 * - **The magazine.** 30 in the rifle and `NumMags - 1` = 2 spare -- `NumMags` read as the magazines carried with
 *   the loaded one among them, which is what the console frame's ammo box shows at spawn ("2 MAGS"). `R` reloads
 *   over `RELOAD_SECONDS` [estimate: the M4A1's record has no `ReloadTime`, so the game's reload is its animation's
 *   length, which is not in the tree]; a partly spent magazine is dropped, as a spare is a whole magazine.
 * - **The bloom.** A round adds `ReticuleKnock / ReticuleKnockMax` (12 / 45) to W2.4's 0..1 spread and it returns at
 *   `ReticuleKnockReturn / ReticuleKnockMax` (70 / 45) a second, capped at 1 -- the file's `STANCE_STAND` numbers,
 *   mapped onto the reticle's spread as a ratio [estimate: their units are not traced].
 * - **The trigger.** A press fires at once if `FireWait` has passed since the last round; held, it fires at the rate
 *   (the M4A1's `MaxFireMode 3`, read as automatic [reading]). The tracer is drawn for one frame, from a muzzle stand-in
 *   beside the eye (a line along the view's own centre line would be a point on the screen) to the hit.
 */

type Vec3 = [number, number, number];

/** The mark's lift off the polygon's plane, toward the shooter, in units. */
export const DECAL_OFFSET = 0.05;
/** The marks kept; the 65th reuses the oldest. */
export const MAX_DECALS = 64;
/** A reload's length in seconds [estimate: the header]. */
export const RELOAD_SECONDS = 2;
/** The tracer's start from the eye, in the view's own axes (right, up, ahead), units [estimate: a muzzle stand-in]. */
const MUZZLE: Vec3 = [1.2, -1.5, 3];

/** Where the shot comes from and goes toward: the camera's eye and the aim point (`WalkMode.fireAim`). */
export interface FireAim { eye: Vec3; far: Vec3 }
/** What the shot reads from the page: the walk's hull and its aim, each null when there is none (not walking). */
export interface FireSource { grid(): Grid | null; aim(): FireAim | null }
export interface ShotHit { point: Vec3; normal: Vec3; distance: number }
/** One round: the segment tested and what it met. */
export interface Shot { from: Vec3; to: Vec3; hit: ShotHit | null }
export interface MagazineState { rounds: number; capacity: number; spare: number; reloading: boolean }
export interface FireState { shots: number; magazine: MagazineState; lastHit: ShotHit | null; decals: number }

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
  private bloom = 0;
  private bound: EventTarget | null = null;

  constructor(
    private readonly source: FireSource,
    private readonly rifle: WeaponRecord = DEFAULT_RIFLE,
    private readonly mark: DecalEntry = BULLET_MARK,
    private readonly random: () => number = Math.random,
  ) {
    this.rounds = rifle.magazine;
    this.spare = Math.max(0, rifle.mags - 1);
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

  /** The trigger pressed: a round now if the rifle is ready; held, `update` keeps firing at the rate. */
  pull(): Shot | null {
    this.held = true;
    return this.tryFire();
  }

  release(): void {
    this.held = false;
  }

  /** One round now if the rate, the magazine and the aim allow: the hook's `shoot()`. */
  shoot(): Shot | null {
    return this.tryFire();
  }

  /** `R`: a fresh magazine from the spares over `RELOAD_SECONDS`; false when full, out of spares or already at it. */
  reload(): boolean {
    if (this.reloadLeft > 0 || this.spare <= 0 || this.rounds >= this.rifle.magazine) return false;
    this.reloadLeft = RELOAD_SECONDS;
    return true;
  }

  /**
   * One frame, before it is drawn: the reload, the bloom's return, the rate's wait, a held trigger's rounds, and the
   * tracer's one frame -- a tracer lit since the last frame is drawn in this one and gone in the next.
   */
  update(dt: number): number {
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 1e-9) { this.reloadLeft = 0; this.rounds = this.rifle.magazine; this.spare--; }
    }
    const { knockReturn, knockMax } = this.rifle.knock;
    this.bloom = Math.max(0, this.bloom - (knockReturn / knockMax) * dt);
    if (this.tracerFrames > 0) this.tracerFrames--;
    else this.tracer.visible = false;
    this.wait -= dt;
    let fired = 0;
    while (this.held && this.wait <= 1e-9 && this.tryFire()) fired++;
    if (this.wait < 0) this.wait = 0;
    if (fired > 0) this.tracerFrames = 0;           // lit in this frame: drawn in it, gone in the next
    return fired;
  }

  /** The reticle's bloom, 0..1 (W2.4's `setSpread`). */
  spread(): number {
    return this.bloom;
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
      lastHit: this.lastHit ? { point: [...this.lastHit.point], normal: [...this.lastHit.normal], distance: this.lastHit.distance } : null,
      decals: this.decals.filter((d) => d.visible).length,
    };
  }

  /** A new map: the marks go, the magazines are full again. */
  reset(): void {
    for (const d of this.decals) this.object.remove(d);
    this.decals.length = 0;
    this.nextDecal = 0;
    this.rounds = this.rifle.magazine;
    this.spare = Math.max(0, this.rifle.mags - 1);
    this.reloadLeft = 0;
    this.wait = 0;
    this.held = false;
    this.lastHit = null;
    this.bloom = 0;
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
    const dir = unit(sub(aim.far, aim.eye));
    const from: Vec3 = [...aim.eye];
    const end: Vec3 = [from[0] + dir[0] * this.rifle.maximumRange, from[1] + dir[1] * this.rifle.maximumRange, from[2] + dir[2] * this.rifle.maximumRange];
    const h = segmentHit(grid, from, end);
    let hit: ShotHit | null = null;
    if (h) {
      // Newell's normal points either way: the mark faces the shooter.
      const d = h.normal[0] * dir[0] + h.normal[1] * dir[1] + h.normal[2] * dir[2];
      const normal: Vec3 = d > 0 ? [-h.normal[0], -h.normal[1], -h.normal[2]] : [...h.normal];
      hit = { point: [...h.point], normal, distance: h.t * this.rifle.maximumRange };
      this.place(hit);
    }
    this.rounds--;
    this.shots++;
    this.wait += this.rifle.fireWait;
    this.lastHit = hit;
    const { knock, knockMax } = this.rifle.knock;
    this.bloom = Math.min(1, this.bloom + knock / knockMax);
    this.drawTracer(from, dir, hit ? hit.point : end);
    return { from, to: hit ? [...hit.point] : end, hit };
  }

  private place(hit: ShotHit): void {
    let mesh = this.decals.length < MAX_DECALS ? undefined : this.decals[this.nextDecal];
    if (!mesh) {
      mesh = new Mesh(this.geometry, this.material);
      mesh.renderOrder = 1;
      this.decals.push(mesh);
      this.object.add(mesh);
    }
    this.nextDecal = (this.nextDecal + 1) % MAX_DECALS;
    const n = new Vector3(...hit.normal);
    mesh.position.set(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(n, DECAL_OFFSET);
    mesh.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), n);
    // A turn about the normal, so the marks do not all share one grain.
    mesh.rotateZ(this.random() * Math.PI * 2);
    const side = this.mark.minSize + this.random() * (this.mark.maxSize - this.mark.minSize);
    mesh.scale.set(side, side, 1);
    mesh.visible = true;
    mesh.updateMatrixWorld();
  }

  private drawTracer(eye: Vec3, dir: Vec3, to: Vec3): void {
    const ahead = new Vector3(...dir);
    const right = new Vector3().crossVectors(ahead, new Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, ahead).normalize();
    const start = new Vector3(...eye).addScaledVector(right, MUZZLE[0]).addScaledVector(up, MUZZLE[1]).addScaledVector(ahead, MUZZLE[2]);
    const position = this.tracer.geometry.getAttribute('position') as Float32BufferAttribute;
    position.setXYZ(0, start.x, start.y, start.z);
    position.setXYZ(1, to[0], to[1], to[2]);
    position.needsUpdate = true;
    this.tracer.geometry.computeBoundingSphere();
    this.tracer.visible = true;
    this.tracerFrames = 1;
  }
}
