import { Euler, Group, Matrix4, Mesh, PlaneGeometry, Quaternion, Vector3, type Camera, type Material, type Object3D } from 'three';
import type { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  launchMotion, NODE_CALLER, NODE_ROOT, segmentHit, stepMotion,
  type DecalEntry, type EffectCondition, type EffectContext, type EffectOp, type EffectProgram, type Grid, type MotionState,
  type MotionWorld, type ObjectMotion,
} from '@s2u/scene';
import type { Rgba } from '@s2u/gs';
import { EffectRun, type EffectHost, type OpTick } from './effectRunner';
import { buildEffectModel, effectBrighten, markMaterial } from './effectMaterials';
import { ParticleSystem } from './particles';
import { EffectLights } from './effectLights';
import type { EffectData, EffectTexture } from './effectData';
import type { FireEvent, MarkTable } from './fire';
import { fixSoundName } from '@s2u/sound';

/**
 * The gunplay's effects (web/docs/research/89), drawn in walk mode: the game's own zAnim effect animations out of the
 * map's `CZANIM.ZAR` and `MZANIM.ZAR`, run by the zAnim sequencer (`./effectRunner`) over the game's own models
 * (`EFFE_GEO`/`EFFE_MDL`) and particle textures (`ALPH_TXR`), in the world's GS arithmetic (`./effectMaterials`).
 *
 * - **A round** (`onRound`, from `Fire.subscribe`; the game's `FUN_005c5340`): the weapon's `FireAnimName` -- the M4A1
 *   SD's `muzzle_m4SD`, which calls `shell_eject` and `shell_smoke_med`; the M4A1's `muzzle_m4` adds `flash_fire_hider`;
 *   in the aim view the `_zoom` variant -- with the weapon's node, the `firepoint`'s place in it and the fire direction.
 * - **The casing** (`OBJECT_MOTION`, `@s2u/scene`'s `effectMotion`): thrown from the weapon's node to its right, tumbling,
 *   bouncing on the hull by its material's coefficient with its material's sound, gone at rest or at 1.2 s; at most
 *   four at once with the bounces (the `bullet_ejecting` valve), the rest a 0.7 s flight through everything.
 * - **The smoke** (`PARTICLE_SOURCE`, `./particles`): `shell_smoke_med`'s source is switched off in the retail data, so
 *   the rifles draw none; the particle manager runs every other source (the impacts, the grenades').
 * - **The impact** (`FUN_003c8920`): `bullet_hit_<material>` of the map's `MZANIM` at the hit, with the round's velocity
 *   and the surface normal -- sparks on metal, dust and chunks on stone and dirt, the splash and ring on water.
 * - **The marks** (`marks()`, for `Fire.setMarks`): `decals.rdr`'s row for the hit polygon's material.
 * - **`play(name, place)`**: any animation of the map's zAnim archives at a place -- the API the grenades take their
 *   impacts and explosions through (`frag_grenade_stone`, `he_grenade`, `grenade_hit_snow` ...).
 */

type Vec3 = [number, number, number];

/** TRAVERSAL SEAM: a running effect as `spawn` hands it back. */
/**
 * Where an effect plays: what the engine hands `FUN_00272bb0` (research 89 §1) -- the caller's node (type 3, the
 * commands' `NODE_CALLER`), a position (5), a velocity (6) and a direction (7). A round's muzzle animation gets the
 * weapon's node, the `firepoint`'s place in it and the fire direction (`FUN_005c5340`); a bullet's hit the hit point,
 * the round's direction and the surface normal (`FUN_003c8920`).
 */
export interface EffectPlace extends EffectContext {
  /** The caller node's world matrix (three's column-major `Matrix4`), or none. */
  node?: Matrix4 | null;
}

/** The effect animation a weapon's round plays: `FireAnimName`, or its `_zoom` variant in the aim view (89 §4). */
export function muzzleAnimation(fireAnim: string | null, zoomed: boolean): string | null {
  if (!fireAnim) return null;
  return zoomed ? `${fireAnim}_zoom` : fireAnim;
}

/** A round's impact animation (`FUN_003c4700`: `"%s_%s"` of the weapon's `HitAnimName` and the material's name). */
export function impactAnimation(hitAnim: string, material: string | undefined): string | null {
  return material ? `${hitAnim}_${material}`.toLowerCase() : null;
}

/**
 * The mark table the hit polygon's material resolves through (research 89 §5): the SOILS name, then the set's row --
 * none for a material without one (`FUN_003d0ba0`: no default).
 */
export function markTable(
  materials: readonly string[], rows: readonly DecalEntry[], bitmaps: ReadonlyMap<string, Rgba>, defaultMaterial = 0,
  material?: (texture: string) => Material | null,
): MarkTable {
  const byName = new Map(rows.map((r) => [r.material, r]));
  return {
    row: (m) => byName.get(materials[m === 0 ? defaultMaterial : m] ?? '') ?? null,
    bitmap: (texture) => bitmaps.get(texture.toLowerCase()) ?? null,
    ...(material ? { material } : {}),
  };
}

/** A running animation the caller keeps (the ripples' endless loops): its place can move, and it can be stopped. */
export interface EffectHandle {
  readonly name: string;
  /** Its place: move `place.node` (a `Matrix4`) in place to carry what follows it. */
  readonly place: EffectPlace;
  alive(): boolean;
  /** Ended (`!alive()`): the traversal's ripple keeper reads it. */
  readonly finished: boolean;
  stop(): void;
}

/** What the SEAL's water does each frame (`FUN_005b52b0`'s inputs): the feet, the water over them, the velocity, the air. */
export interface WaterState {
  feet: Vec3;
  /** The water line over the feet (`actor+0xf88`), 0 out of it. */
  depth: number;
  /** The body's height (its model box: `./stature`). */
  height: number;
  velocity: Vec3;
  airborne: boolean;
}

/** `FUN_0058a820`'s speed class, 0-based: still (|v|² < 0.25), moving, running (|v|² >= 400). */
export function speedClass(v: readonly number[]): 0 | 1 | 2 {
  const s = v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!;
  return s < 0.25 ? 0 : s < 400 ? 1 : 2;
}

/** The wading ripples by speed class (`FUN_005b52b0`, decomp 469808-469920): the body in the water, and under it. */
export const RIPPLES = {
  big: ['big_ripple_anim', 'big_ripple_anim_walk', 'big_ripple_anim_run'],
  small: ['small_ripple_anim', 'small_ripple_anim_walk', 'small_ripple_anim_run'],
} as const;

/** How far over the body's top the water still ripples (`FUN_005b52b0`: `hi < water < hi + 10`). */
export const RIPPLE_OVER = 10;
/** A footprint's side (`FUN_005a3280`'s 3.5, decomp 460186) and the pool it shares with the marks' kind (150). */
export const FOOTPRINT_SIZE = 3.5;
export const MAX_FOOTPRINTS = 150;

/** One live instance of an effect model (a casing, a flash), made for a run and dropped with it. */
interface Instance { object: Object3D; model: string }

interface RunContext {
  place: EffectPlace;
  instance: Instance | null;
  /** A map's ambient effect: its looping (`~`) sounds are the audio's emitters', not played here. */
  ambient?: boolean;
}

export interface EffectStats {
  loaded: boolean;
  programs: number;
  models: string[];
  textures: number;
  missing: string[];
  runs: number;
  played: Record<string, number>;
  shells: number;
  particles: number;
  sources: number;
  emitted: number;
  lastShell: { position: Vec3; velocity: Vec3 } | null;
  /** The `LIGHT` passes live now, begun so far, their overlays, and their ranges now. */
  lights: ReturnType<EffectLights['stats']>;
  /** The mission's ambient effects running now. */
  ambient: string[];
  /** The SEAL's splashes, the ripple loops running, the footprints placed. */
  water: { splashes: number; ripples: string; footprints: number };
  /** The effect models drawn now, by name. */
  shown: string[];
  bounces: number;
  sounds: string[];
}

/** The zAnim main gravity (`Anim_Main_Params`, -98 on every archive: 77 §9). */
export const ZANIM_GRAVITY = -98;

const unit = (v: Vec3): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };

export class Effects {
  readonly object = new Group();
  private programs = new Map<string, EffectProgram>();
  private readonly models = new Map<string, Group>();
  private textures = new Map<string, EffectTexture>();
  private readonly materials = new Map<string, MeshBasicNodeMaterial>();
  private runs: EffectRun[] = [];
  private readonly particles: ParticleSystem;
  /** The map's scene nodes the ambient effects sit at (`EffectData.sceneNodes`). */
  private sceneNodes = new Map<string, Matrix4>();
  /** The ambient effects running (`EffectData.ambient`). */
  private ambientRuns: EffectRun[] = [];
  /** The `LIGHT` commands' passes over the world (`./effectLights`). */
  readonly lights = new EffectLights();
  private readonly valves = new Map<string, number>();
  private readonly played: Record<string, number> = {};
  private grid: () => Grid | null = () => null;
  private bounces = 0;
  private lastShell: EffectStats['lastShell'] = null;
  private readonly sounds: string[] = [];
  private camera: Camera | null = null;
  private data: EffectData | null = null;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly sound: (name: string, at: Vec3, volume: number) => void = () => {},
  ) {
    this.object.name = 'effects';
    this.particles = new ParticleSystem(random);
    this.object.add(this.particles.object);
    this.object.add(this.lights.object);
  }

  /** What the lights re-draw (the world's group, the held weapon): `EffectLights.setReceivers`. */
  setLightReceivers(roots: () => Object3D[]): void {
    this.lights.setReceivers(roots);
  }

  /** The hull the casings bounce on (the walk's grid). */
  setWorld(grid: () => Grid | null): void {
    this.grid = grid;
  }

  /** The frame's brighten, `1 + FIX/128` (`./lighting`'s `brightenOf`). */
  setBrighten(value: number): void {
    effectBrighten.value = value;
  }

  /** A map's effect data (`./effectData`), or null: the effects stop and their objects go. */
  setData(data: EffectData | null): void {
    this.reset();
    this.models.clear();
    for (const m of this.materials.values()) { m.map?.dispose(); m.dispose(); }
    this.materials.clear();
    this.data = data;
    this.programs = new Map();
    for (const p of data?.programs ?? []) if (!this.programs.has(p.name.toLowerCase())) this.programs.set(p.name.toLowerCase(), p);
    this.textures = new Map(data?.textures ?? []);
    this.particles.setTextures(this.textures);
    this.sceneNodes = new Map((data?.sceneNodes ?? []).map(([n, m]) => [n, new Matrix4().fromArray(m)]));
    this.lights.setTexture(this.textures.get('light_map.tif') ?? null);
    for (const model of data?.models ?? []) this.models.set(model.name, buildEffectModel(model, this.textures, this.materials));
    // The mission's ambient effects start with the map, as the game starts its activation-1 animations.
    for (const name of data?.ambient ?? []) {
      const program = this.programs.get(name.toLowerCase());
      if (program) this.ambientRuns.push(this.start(program, { node: null }, true));
    }
  }

  /**
   * Everything the map's effects draw with, in one group for the renderer to compile before the first shot (research
   * 90 item 16: the first explosion's frames up to 417 ms were first use -- programs built, bitmaps uploaded): the
   * effect models, a particle group per particle texture, the marks' and the footprints' materials; and the light
   * passes' overlays over every receiver, beside it (`EffectLights.warmMeshes`). `warmStarted` takes them out of the
   * drawn scene once the compile call has its list, `warmDone` after.
   */
  warmUp(): Group {
    const g = new Group();
    g.name = 'effects warm-up';
    g.position.set(0, -1e6, 0);
    const d = this.data;
    if (!d) return g;
    for (const model of this.models.values()) g.add(model.clone(true));
    const particleTextures = new Set<string>();
    for (const p of d.programs) for (const s of p.sequences) for (const o of s.ops) if (o.op === 'particles') for (const t of o.source.textures) particleTextures.add(t.name.toLowerCase());
    for (const m of this.particles.warm(particleTextures)) { m.visible = true; }
    const quad = new PlaneGeometry(1, 1);
    for (const tex of [...d.marks.map((r) => r.texture), ...d.footprints.map(([, t]) => t)]) {
      const t = this.textures.get(tex.toLowerCase());
      if (t) g.add(new Mesh(quad, markMaterial(t)));
    }
    // The light passes' overlays, beside what they re-draw: the page compiles them with the scene.
    this.lights.warmMeshes();
    g.traverse((o) => { o.frustumCulled = false; });
    this.object.add(g);
    return g;
  }

  /**
   * The compile call has taken its list of what to build (synchronously): the warm-up's objects leave the drawn scene,
   * so the frames drawn while the programs build do not build them in the frame (research 90 item 19).
   */
  warmStarted(g: Group): void {
    this.object.remove(g);
    this.lights.warmHide();
  }

  /** The pre-warm is done: its group goes (the particle groups stay, hidden until they draw). */
  warmDone(g: Group): void {
    this.object.remove(g);
    this.lights.warmDone();
  }

  /** The per-material marks for `Fire.setMarks`, or null without the tables. */
  marks(): MarkTable | null {
    const d = this.data;
    if (!d || d.materials.length === 0 || d.marks.length === 0) return null;
    const bitmaps = new Map<string, Rgba>();
    for (const [name, t] of d.textures) bitmaps.set(name, t.rgba);
    return markTable(d.materials, d.marks, bitmaps, d.defaultMaterial, (texture) => {
      const t = this.textures.get(texture.toLowerCase());
      return t ? markMaterial(t) : null;
    });
  }

  /** Whether the map has an animation of that name (looked up without regard to case, as `FUN_0026a250` does). */
  has(name: string): boolean {
    return this.programs.has(name.toLowerCase());
  }

  /** Runs the animation `name` of the map's zAnim archives at `place`; false when the map has none of that name. */
  play(name: string, place: EffectPlace): boolean {
    return this.run(name, place) !== null;
  }

  /** As `play`, with a handle on the run (to move and stop an endless one); null when the map has none of that name. */
  run(name: string, place: EffectPlace): EffectHandle | null {
    const program = this.programs.get(name.toLowerCase());
    if (!program) return null;
    const r = this.start(program, place);
    return { name: program.name, place, alive: () => !r.finished, get finished() { return r.finished; }, stop: () => r.stop() };
  }

  // ---- the SEAL in water (FUN_005b52b0) and on sand and snow (FUN_005a3280) --------------------------------------

  private big: EffectHandle | null = null;
  private small: EffectHandle | null = null;
  private readonly rippleNode = new Matrix4();
  private readonly footprints: Mesh[] = [];
  private nextFootprint = 0;
  private readonly footprintGeometry = new PlaneGeometry(1, 1);
  private water = { splashes: 0, ripples: '' as string, footprints: 0 };

  /**
   * One frame of the SEAL's water (`FUN_005b52b0`, decomp 469808-469920): with the water line between the feet and the
   * body's top, the big ripple of the speed class, carried on a node kept at the water under the SEAL; with the water
   * up to 10 over the top, the small one; a loop, once started, runs until the band changes. Leaving the water stops
   * both [reading: the game's call comes only from a probe that met water, and its loops ran on where they were].
   */
  waterFrame(w: WaterState | null): void {
    const inBand = (big: boolean): boolean => {
      if (!w || w.depth <= 0) return false;
      const wy = w.feet[1] + w.depth, lo = w.feet[1], hi = w.feet[1] + w.height;
      return big ? lo < wy && wy < hi : hi <= wy && wy < hi + RIPPLE_OVER;
    };
    if (w) this.rippleNode.makeTranslation(w.feet[0], w.feet[1] + w.depth, w.feet[2]);
    const k = w ? speedClass(w.velocity) : 0;
    const keep = (h: EffectHandle | null, on: boolean, name: string): EffectHandle | null => {
      if (!on) { h?.stop(); return null; }
      if (h?.alive()) return h;
      return this.run(name, { node: this.rippleNode, position: w ? [w.feet[0], w.feet[1] + w.depth, w.feet[2]] : null });
    };
    this.big = keep(this.big, inBand(true), RIPPLES.big[k]);
    this.small = keep(this.small, inBand(false), RIPPLES.small[k]);
    this.water.ripples = [this.big?.name, this.small?.name].filter(Boolean).join(',');
  }

  /**
   * A fall into water (`waterLand`: `FUN_005b52b0`'s first frame in the water in the air): `seal_fall_in_water` at the
   * water line over the feet -- the splash, the spray and the rings, `.FALL_WATER`.
   */
  splash(feet: Vec3, depth: number): boolean {
    const at: Vec3 = [feet[0], feet[1] + depth, feet[2]];
    const ok = this.play('seal_fall_in_water', { position: at, normal: [0, 1, 0], velocity: [0, -1, 0] });
    if (ok) this.water.splashes++;
    return ok;
  }

  /**
   * A footfall (`FUN_005a3570`): the footprint of `decals.rdr`'s `FOOTSTEP_DECALS` for the ground's material -- SAND's
   * and SNOW's, none on the rest -- `FOOTPRINT_SIZE` across, flat on the ground, its length along the SEAL's forward
   * (`FUN_005a3280`, decomp 460186-460214). None prone. The game's `seal_footfall_<material>` zAnims are looked up and
   * exist on no map, so a footfall draws nothing else.
   */
  footfall(at: Vec3, material: number, normal: Vec3, forward: Vec3, prone: boolean): boolean {
    if (prone || !this.data) return false;
    const name = this.materialName(material);
    const texture = this.data.footprints.find(([m]) => m === name)?.[1];
    const t = texture ? this.textures.get(texture) : undefined;
    if (!t) return false;
    let mesh = this.footprints.length < MAX_FOOTPRINTS ? undefined : this.footprints[this.nextFootprint];
    const key = `footprint|${texture}`;
    let material3 = this.materials.get(key);
    if (!material3) { material3 = markMaterial(t); this.materials.set(key, material3); }
    if (!mesh) {
      mesh = new Mesh(this.footprintGeometry, material3);
      mesh.renderOrder = 1;
      this.footprints.push(mesh);
      this.object.add(mesh);
    }
    this.nextFootprint = (this.nextFootprint + 1) % MAX_FOOTPRINTS;
    mesh.material = material3;
    const n = new Vector3(...normal).normalize();
    // Up the print: the SEAL's forward laid on the ground (`cross(cross(orient, n), n)`, the sign a reading).
    const f = new Vector3(...forward);
    const up = f.clone().addScaledVector(n, -f.dot(n));
    if (up.lengthSq() < 1e-9) up.set(1, 0, 0).addScaledVector(n, -n.x);
    up.normalize();
    const right = new Vector3().crossVectors(up, n).normalize();
    mesh.matrixAutoUpdate = false;
    mesh.matrix.makeBasis(right.multiplyScalar(FOOTPRINT_SIZE), up.multiplyScalar(FOOTPRINT_SIZE), n)
      .setPosition(new Vector3(...at).addScaledVector(n, 0.05));
    mesh.visible = true;
    mesh.updateMatrixWorld(true);
    this.water.footprints++;
    return true;
  }

  /**
   * TRAVERSAL SEAM (web research 86 section 5.4): `play`, handing back the run -- whether it has finished, and a stop --
   * for an effect its caller keeps alive and replaces (`FUN_005b52b0`'s ripples: a new one only when the last ended).
   * The place is held, not copied: moving `place.position` moves the effect (the engine's tag-3 pointer).
   */
  spawn(name: string, place: EffectPlace): EffectHandle | null {
    return this.run(name, place);
  }

  private start(program: EffectProgram, place: EffectPlace, ambient = false): EffectRun {
    this.played[program.name] = (this.played[program.name] ?? 0) + 1;
    const run = new EffectRun(program, this.host, { place, instance: null, ambient } satisfies RunContext);
    this.runs.push(run);
    run.update(0);
    return run;
  }

  /**
   * A round from `Fire` (research 89 §4, `FUN_005c5340`): the weapon's `FireAnimName` -- its `_zoom` variant in the aim
   * view -- with the weapon's node (its world matrix: x along the barrel, y up, z to its right), the `firepoint`'s place
   * in it and the fire direction; then, where the round met the hull, `<HitAnimName>_<material>` (`FUN_003c8920`: the
   * map's `bullet_hit_metal_thick` ...) at the hit with the round's direction and the surface normal.
   */
  onRound(e: FireEvent, weapon: { matrix: Matrix4; muzzle: Vec3 | null } | null, zoomed: boolean): void {
    if (e.type !== 'round') return;
    const hitAnim = this.data?.hitAnims.find(([w]) => w === e.weapon.name)?.[1] ?? 'bullet_hit';
    const dir = unit([e.to[0] - e.from[0], e.to[1] - e.from[1], e.to[2] - e.from[2]]);
    const name = muzzleAnimation(e.weapon.fireAnim, zoomed);
    if (name && weapon) this.play(name, { node: weapon.matrix, position: weapon.muzzle ?? [0, 0, 0], velocity: dir });
    if (e.hit && typeof e.material === 'number' && e.normal) {
      const anim = impactAnimation(hitAnim, this.materialName(e.material));
      if (anim) this.play(anim, { position: [...e.to], velocity: dir, normal: [...e.normal] });
    }
  }

  /** A polygon's material byte to its SOILS name, 0 taking the map's `DefaultMaterial` (`FUN_002dc1d0`). */
  materialName(byte: number): string | undefined {
    const d = this.data;
    if (!d) return undefined;
    return d.materials[byte === 0 ? d.defaultMaterial : byte];
  }

  /** Holds every effect where it is (the hook's, for a picture of a flash that lives three frames). */
  paused = false;

  /** One frame: every run's tick, the particles, and the runs that ended. */
  update(dt: number, camera: Camera | null): void {
    this.camera = camera;
    if (this.paused) dt = 0;
    for (let i = 0; i < this.runs.length; i++) this.runs[i]!.update(dt);   // calls append runs, which start this tick
    const alive: EffectRun[] = [];
    for (const run of this.runs) {
      if (!run.finished) { alive.push(run); continue; }
      const ctx = run.context as RunContext;
      if (ctx.instance) this.object.remove(ctx.instance.object);
    }
    this.runs = alive;
    this.particles.update(dt, camera);
    this.lights.update(dt);
  }

  /** Everything playing stops (a new map). */
  reset(): void {
    for (const run of this.runs) {
      run.stop();
      const ctx = run.context as RunContext;
      if (ctx.instance) this.object.remove(ctx.instance.object);
    }
    this.runs = [];
    this.ambientRuns = [];
    this.valves.clear();
    this.particles.clear();
    this.lights.clear();
    this.big = null;
    this.small = null;
    for (const m of this.footprints) this.object.remove(m);
    this.footprints.length = 0;
    this.nextFootprint = 0;
    this.lastShell = null;
  }

  stats(): EffectStats {
    return {
      loaded: this.data !== null, programs: this.programs.size, models: [...this.models.keys()], textures: this.textures.size,
      missing: this.data?.missing.slice(0, 16) ?? [],
      runs: this.runs.length, played: { ...this.played }, shells: this.shellsLive(), particles: this.particles.count(),
      sources: this.particles.activeSources(), emitted: this.particles.emitted,
      lastShell: this.lastShell, bounces: this.bounces, sounds: this.sounds.slice(-16), lights: this.lights.stats(),
      ambient: this.ambientRuns.filter((r) => !r.finished).map((r) => r.program.name),
      water: { ...this.water },
      shown: this.runs.map((r) => (r.context as RunContext).instance).filter((i): i is Instance => !!i && i.model !== '' && i.object.visible).map((i) => i.model),
    };
  }

  private shellsLive(): number {
    let n = 0;
    for (const run of this.runs) {
      const inst = (run.context as RunContext).instance;
      if (inst && inst.model.startsWith('bullet_shell') && inst.object.visible) n++;
    }
    return n;
  }

  /**
   * The run's own node (`NODE_ROOT`, anim+0x3c): a copy of its root model (`create_instance`: a casing a round), or,
   * for an animation rooted at no model (`FRAG_sparks` moves its bare root and hangs its sparks on it), an empty node.
   * Made on first use.
   */
  private instanceOf(run: EffectRun): Instance | null {
    const ctx = run.context as RunContext;
    if (ctx.instance) return ctx.instance;
    const name = run.program.nodes[run.program.root] ?? '';
    const model = run.program.root > 0 ? this.models.get(name) : undefined;
    const object = model ? model.clone(true) : new Group();
    object.visible = false;
    this.object.add(object);
    ctx.instance = { object, model: model ? name : '' };
    return ctx.instance;
  }

  /** A node of a run: its instance's root (`NODE_ROOT`, or the root's own name), a named sub-node of it, or null. */
  private nodeOf(run: EffectRun, node: number): Object3D | null {
    const inst = this.instanceOf(run);
    if (!inst) return null;
    if (node === NODE_ROOT) return inst.object;
    const name = run.program.nodes[node];
    if (!name) return null;
    return inst.model === name ? inst.object : inst.object.getObjectByName(name) ?? null;
  }

  /** The caller's node for a run (`NODE_CALLER`), or null. */
  private callerMatrix(run: EffectRun): Matrix4 | null {
    return (run.context as RunContext).place.node ?? null;
  }

  /** A command's node as a world matrix: the caller's, the run's instance's, a named one, or null. */
  private nodeMatrix(run: EffectRun, node: number): Matrix4 | null {
    if (node === NODE_CALLER) return this.callerMatrix(run);
    if (node === 0) return null;
    // A node the map's scene holds (a mission's flame at `r_tower_flames`), and the camera (the snow and the rain
    // fall about it): the engine's node search finds them in the world (`_zanim_node_ref`'s search scope).
    const name = node === NODE_ROOT ? run.program.nodes[run.program.root] : run.program.nodes[node];
    if (name === 'camera' && this.camera) { this.camera.updateMatrixWorld(); return this.camera.matrixWorld; }
    const scene = name && !this.models.has(name) ? this.sceneNodes.get(name) : undefined;
    if (scene) return scene;
    const o = this.nodeOf(run, node);
    if (!o) return null;
    o.updateWorldMatrix(true, false);
    return o.matrixWorld;
  }

  /** Where a run is, for its sounds and its range test: the caller's origin, else the context's position. */
  private runPosition(run: EffectRun): Vec3 {
    const m = this.callerMatrix(run);
    if (m) return [m.elements[12]!, m.elements[13]!, m.elements[14]!];
    return (run.context as RunContext).place.position ?? [0, 0, 0];
  }

  private world(): MotionWorld | null {
    const grid = this.grid();
    if (!grid) return null;
    const fallback = this.data?.defaultMaterial ?? 0;
    const soil = (byte: number): number => (byte === 0 ? fallback : byte);
    // Newell's normal points either way: the one facing where the probe came from.
    const facing = (n: readonly number[], a: Vec3, b: Vec3): Vec3 => {
      const d = (b[0] - a[0]) * n[0]! + (b[1] - a[1]) * n[1]! + (b[2] - a[2]) * n[2]!;
      return d > 0 ? [-n[0]!, -n[1]!, -n[2]!] : [n[0]!, n[1]!, n[2]!];
    };
    return {
      segment: (a: Vec3, b: Vec3) => {
        const h = segmentHit(grid, a, b);
        return h ? { point: [...h.point], normal: facing(h.normal, a, b), material: soil(h.poly.material) } : null;
      },
      floor: (from: Vec3, depth: number) => {
        const to: Vec3 = [from[0], from[1] - depth, from[2]];
        const h = segmentHit(grid, from, to);
        return h ? { point: [...h.point], normal: facing(h.normal, from, to), material: soil(h.poly.material) } : null;
      },
    };
  }

  private readonly host: EffectHost = {
    random: () => this.random(),
    test: (c: EffectCondition, run: EffectRun): boolean => {
      if (c.kind === 'valve') return valveTest(this.valves.get(c.valve) ?? 0, c.operation, c.operand);
      if (c.kind === 'range') {
        // The activation gate: the camera against the caller (`RANGE_TEST` 0x109: "farther than", research 89 §2).
        const cam = this.camera;
        if (!cam) return false;
        const p = new Vector3(...this.runPosition(run));
        const d2 = p.distanceToSquared(new Vector3().setFromMatrixPosition(cam.matrixWorld));
        return (c.flags & 0x100) !== 0 ? d2 > c.rangeSquared : (c.flags & 0x80) !== 0 ? d2 < c.rangeSquared : false;
      }
      return false;
    },
    begin: (op: EffectOp, run: EffectRun): OpTick | void => this.begin(op, run),
  };

  private begin(op: EffectOp, run: EffectRun): OpTick | void {
    const ctx = run.context as RunContext;
    switch (op.op) {
      case 'call': {
        const program = this.programs.get(op.anim.toLowerCase());
        if (program) this.start(program, ctx.place);
        return;
      }
      case 'valve': {
        this.valves.set(op.valve, valveApply(this.valves.get(op.valve) ?? 0, op.operation, op.operand));
        return;
      }
      case 'active': {
        const node = this.nodeOf(run, op.node);
        if (node) node.visible = op.on;
        return;
      }
      case 'translate': {
        const node = this.nodeOf(run, op.node);
        if (!node) return;
        // `FUN_00263890`: the offset (flag 1), or the node's own place plus it (flag 4), plus the context's position
        // (flag 2); through the reference node's matrix when there is one (the muzzle: the `firepoint`'s place in the
        // weapon), else as it is (a hit: the world point).
        const ref = op.ref === 0 ? null : this.nodeMatrix(run, op.ref);
        const v = new Vector3();
        let set = false;
        if (op.flags & 4) { v.copy(node.position).add(new Vector3(...op.xyz)); set = true; } else if (op.flags & 1) { v.set(...op.xyz); set = true; }
        if ((op.flags & 2) && ctx.place.position) { v.add(new Vector3(...ctx.place.position)); set = true; }
        if (ref) node.position.copy(v.applyMatrix4(ref));
        else if (set) node.position.copy(v);
        return;
      }
      case 'rotate': {
        const node = this.nodeOf(run, op.node);
        if (!node) return;
        // `FUN_00263730`: the reference node's world rotation (unless flag 4), then the euler angles set (1) or added (2).
        const ref = op.ref === 0 ? null : this.nodeMatrix(run, op.ref);
        if (ref && (op.flags & 4) === 0) node.quaternion.setFromRotationMatrix(new Matrix4().extractRotation(ref));
        const e = new Quaternion().setFromEuler(new Euler(op.xyz[0], op.xyz[1], op.xyz[2], 'YXZ'));
        if (op.flags & 1) node.quaternion.copy(e);
        if (op.flags & 2) node.quaternion.multiply(e);
        return;
      }
      case 'fromTo': {
        const node = this.nodeOf(run, op.node);
        if (!node) return;
        let t = 0;
        const apply = (): void => {
          const k = op.seconds > 0 ? Math.min(1, t / op.seconds) : 1;
          node.scale.set(op.from[0] + (op.to[0] - op.from[0]) * k, op.from[1] + (op.to[1] - op.from[1]) * k, op.from[2] + (op.to[2] - op.from[2]) * k);
        };
        apply();
        return (dt) => { t += dt; apply(); return t >= op.seconds; };
      }
      case 'motion': return this.motion(op.motion, run);
      case 'particles': {
        const node = this.nodeMatrix(run, op.source.node);
        // Flag A 0x10: the source follows its node while it lives (`FUN_00329b40` reads the node's matrix each tick).
        const follow = op.source.follow ? () => this.nodeMatrix(run, op.source.node) : null;
        this.particles.emit(op.source, node, ctx.place, run.program.name, () => !run.finished, run, follow);
        return;
      }
      case 'light': {
        // Where it is (decomp 111995-112027): its node's place (flag 0x2: the caller), else the context's point (0x8),
        // plus its offset (0x4).
        const l = op.light;
        const m = l.node !== null ? this.nodeMatrix(run, l.node) : null;
        const base: Vec3 = m ? [m.elements[12]!, m.elements[13]!, m.elements[14]!]
          : l.atContext && ctx.place.position ? [...ctx.place.position] : this.runPosition(run);
        this.lights.begin(l, [base[0] + l.offset[0], base[1] + l.offset[1], base[2] + l.offset[2]], () => !run.finished);
        // The command runs its length (+0x3c) before its sequence goes on [reading: the tick keys the ranges by the
        // command's own time]; the light itself lasts until the animation ends.
        let t = 0;
        return l.duration > 0 ? (dt) => (t += dt) >= l.duration : undefined;
      }
      case 'pauseAnimation': {
        const name = op.anim.toLowerCase();
        for (const r of this.runs) if (r !== run && r.program.name.toLowerCase() === name) r.paused = true;
        return;
      }
      case 'stopAnimation': {
        const name = op.anim.toLowerCase();
        for (const r of this.runs) if (r !== run && r.program.name.toLowerCase() === name) r.stop();
        return;
      }
      case 'sound': {
        if (ctx.ambient && op.sound.startsWith('~')) return;
        const at = op.node > 0 ? this.nodeMatrix(run, op.node) : null;
        this.playSound(op.sound, at ? [at.elements[12]!, at.elements[13]!, at.elements[14]!] : this.runPosition(run), 1);
        return;
      }
      default: return;
    }
  }

  private playSound(raw: string, at: Vec3, volume: number): void {
    const name = fixSoundName(raw);   // the one name table (`@s2u/sound`)
    this.sounds.push(name);
    if (this.sounds.length > 64) this.sounds.splice(0, this.sounds.length - 64);
    this.sound(name, at, volume);
  }

  /** `OBJECT_MOTION` on a run's node: the launch now, the flight in its tick. */
  private motion(m: ObjectMotion, run: EffectRun): OpTick | void {
    const node = this.nodeOf(run, m.node);
    if (!node) return;
    const frame = m.frame === 0 ? null : this.nodeMatrix(run, m.frame);
    const inst = (run.context as RunContext).instance;
    const height = inst ? heightOf(inst.object) : 0.14;
    const place = (run.context as RunContext).place;
    const state: MotionState = launchMotion(m, node.position.toArray() as Vec3, frame ? rowsOf(frame) : null, this.random, ZANIM_GRAVITY, height, place.velocity ?? [0, 0, 0]);
    const isShell = inst?.model.startsWith('bullet_shell') ?? false;
    const world = this.world();
    const apply = (): void => {
      node.position.set(state.position[0], state.position[1], state.position[2]);
      node.quaternion.setFromEuler(new Euler(state.euler[0], state.euler[1], state.euler[2], 'YXZ'));
      if (isShell) this.lastShell = { position: [...state.position], velocity: [...state.velocity] };
    };
    apply();
    return (dt: number): boolean => {
      const bounces = stepMotion(m, state, dt, world);
      for (const b of bounces) {
        this.bounces++;
        if ((m.flags & 0x20) === 0) continue;
        const sound = b.entry?.sound ?? m.sound;
        const ref = b.entry?.refSpeed ?? m.refSpeed;
        if (sound) this.playSound(sound, b.point, ref > 0 ? Math.min(1, b.speed / ref) : 1);
      }
      apply();
      return state.done;
    };
  }
}

/** A matrix's rotation rows, row-vector convention (`v * M`): three's column-major basis vectors, unit length. */
function rowsOf(m: Matrix4): Vec3[] {
  const e = m.elements;
  return [unit([e[0]!, e[1]!, e[2]!]), unit([e[4]!, e[5]!, e[6]!]), unit([e[8]!, e[9]!, e[10]!])];
}

/** An object's height in its own frame (the casing's box: 0.14). */
function heightOf(object: Object3D): number {
  let min = Infinity, max = -Infinity;
  object.traverse((o) => {
    const p = (o as { geometry?: { attributes?: { position?: { array: ArrayLike<number> } } } }).geometry?.attributes?.position?.array;
    if (!p) return;
    for (let i = 1; i < p.length; i += 3) { min = Math.min(min, p[i]!); max = Math.max(max, p[i]!); }
  });
  return Number.isFinite(max - min) ? max - min : 0;
}

/** `FUN_00353fd0`'s tests: 0 true, 1 !=, 2 ==, 3 >, 4 <, 5 >=, 6 <= (the valve against the operand). */
export function valveTest(value: number, operation: number, operand: number): boolean {
  switch (operation) {
    case 0: return true;
    case 1: return value !== operand;
    case 2: return value === operand;
    case 3: return value > operand;
    case 4: return value < operand;
    case 5: return value >= operand;
    case 6: return value <= operand;
    default: return false;
  }
}

/** `FUN_00353fd0`'s operations: 0x0b set, 0x0c add, 0x0d subtract (not below 0), 0x0e multiply; the tests leave it. */
export function valveApply(value: number, operation: number, operand: number): number {
  switch (operation) {
    case 0x0b: return operand;
    case 0x0c: return value + operand;
    case 0x0d: return Math.max(0, value - operand);
    case 0x0e: return value * operand;
    default: return value;
  }
}
