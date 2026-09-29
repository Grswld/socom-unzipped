import { sampleClip, type MotionClip, type PartPose } from '@s2u/scene';
import type { LayerContext, PoseLayer } from './animator';
import { entryOf } from './locomotion';
import type { MotionEntry, MotionTable } from './motionTable';

/**
 * The rifle's poses over the clips (the WEAPON workstream): the **Fire** set the game blends in while the rifle is up
 * (`./weaponRaise`), and the **reload**. An `Animator` pose layer (`addPoseLayer`), so the clip picker and its
 * cross-fade are untouched.
 *
 * **The Fire set.** `FUN_005e0690` 0x5e0690 (decomp lines 494790-494801) pairs twelve anim types with their Fire
 * versions through `FUN_005e1bf0` (the table at `animset+0x5c`, entry +4); `CZSealBody_Tick_0` 0x57a330 (lines
 * 438828-438860), for a motion slot whose flags carry 0x40, maps the playing type back to its base (`FUN_0058c820`)
 * and on to its Fire version (`FUN_0058c970` → `FUN_005e1a10`), and blends that motion into the slot with the raise
 * weight (`FUN_0028bdd0(weight, ...)`); a type with no Fire version (the strafes, the jumps) blends nothing. The types'
 * clips are `READERC.ZAR/animset.rdr`'s "Seal anim set" (and the GLOBAL set it includes for `seal_walk`/`seal_jog`,
 * the clips the viewer's picker plays for Walk and Jog): Stand → `seal_fp_stand`, Walk → `seal_fp_walk` ... below.
 * The `fp` is "fire pose", not first person: "Fire stand" names `seal_fp_stand` (animset.rdr). Its rifle is at the
 * shoulder: the barrel along the body's forward, the sight 15.2 over the feet (research 78's skeleton, MP2).
 *
 * **Not the recoil clips.** `animset.rdr` binds "Rifle recoil" → `seal_recoil` (and the crouch, prone and pistol
 * forms), but no such type name is in the game's image (`socom2_game.elf` holds "Fire stand" and "Rifle reload" and
 * no "recoil" but `RecoilPct`): nothing asks for them, so they are not played. The body's kick is `./rifleKick`'s.
 *
 * **The reload** plays the stance's reload clip -- "Rifle reload" `seal_reload`, "Rifle crouch reload"
 * `seal_crouch_reload`, "Rifle prone reload" `seal_prone_reload`, and "Moving rifle reload" `seal_mv_reload` (an
 * upper-body overlay, `BlendOverlay` in `motion.rdr`) -- over its `motion.rdr` `playback` seconds, which is also the
 * reload's length (`reloadSeconds`: the M4A1's record has no `ReloadTime`, research 79 §1.2 / the spec's W2.5).
 *
 * The viewer's readings, named:
 * - `PHASE_SHARED`: a Fire version of a locomotion cycle plays at the base clip's phase (so the legs keep their step);
 *   a Fire version of a pose (stand, crouch, prone, the steps) runs on its own clock at its own rate. The game makes a
 *   second motion for it (`FUN_0028d860(slot, motion, -1)`), whose clock is not read here.
 * - `RELOAD_BLEND_PLACEHOLDER`: the reload clips have no `BlendTime` in `motion.rdr`, so they blend in and out over
 *   the animator's own placeholder (`BLEND_TIME_PLACEHOLDER`, 0.2 s).
 * - The moving reload is the game's `FUN_005a82e0` test (`RELOAD_STILL_SPEED`), frame by frame at the same normalised
 *   time: a still reload the SEAL walks out of turns into the moving overlay (`FUN_00550ef0` 418205-418224).
 */

/**
 * The Fire version of each clip the picker can play (`FUN_005e0690`'s twelve pairs through animset.rdr's names).
 * Keys are the base clips: the Seal set's own and the GLOBAL set's, which the viewer's picker plays.
 */
export const FIRE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  // Stand (type 1) → Fire stand
  seal_stand: 'seal_fp_stand', seal_stand_alert01: 'seal_fp_stand', seal_stand_alert02: 'seal_fp_stand',
  // Walk (2), Jog (3), Run (4) → Fire walk, Fire jog, Fire run
  seal_walk: 'seal_fp_walk', seal_walk_alert: 'seal_fp_walk', seal_walk_alert02: 'seal_fp_walk',
  seal_jog: 'seal_fp_jog', seal_jog_alert: 'seal_fp_jog', seal_run: 'seal_fp_run',
  // Walk backwards (5), Jog backwards (6)
  seal_walk_bw: 'seal_fp_walk_bw', seal_run_bw: 'seal_fp_run_bw',
  // Step (0x10)
  seal_step: 'seal_fp_step', seal_alert_step: 'seal_fp_step',
  // Crouch (0x12), Crouch walk (0x14), Crouch step (0x15), Crouch walk backwards (0x18)
  seal_crouch: 'seal_fp_crouch', seal_crouch_alert01: 'seal_fp_crouch', seal_crouch_alert02: 'seal_fp_crouch',
  seal_crouchwalk: 'seal_fp_crouchwalk', seal_crouch_step: 'seal_fp_crouch_step', seal_crouchwalk_bw: 'seal_fp_crouchwalk_bw',
  // Prone (0x1a)
  seal_prone: 'seal_fp_prone',
});

/**
 * The pistol's Fire versions (`FUN_005e0690`'s `FUN_005e1af0` pairs, entry +6 of the anim set's table, read through
 * `FUN_0058c970` -> `FUN_005e19d0` when `m_item` is 2): "Pistol fire stand" `seal_pfp_stand` ... twelve, keyed by the
 * base clip as `FIRE_VERSIONS` is; the strafes and the 90-degree runs take the pistol's own strafe and run clips.
 */
export const PISTOL_FIRE_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  seal_stand: 'seal_pfp_stand', seal_stand_alert01: 'seal_pfp_stand', seal_stand_alert02: 'seal_pfp_stand',
  seal_walk: 'seal_pfp_walk', seal_walk_alert: 'seal_pfp_walk', seal_walk_alert02: 'seal_pfp_walk',
  seal_jog: 'seal_pfp_jog', seal_jog_alert: 'seal_pfp_jog', seal_run: 'seal_pfp_run',
  seal_walk_bw: 'seal_pfp_walk_bw', seal_run_bw: 'seal_pfp_run_bw',
  seal_step: 'seal_pfp_step', seal_alert_step: 'seal_pfp_step',
  seal_crouch: 'seal_pfp_crouch', seal_crouch_alert01: 'seal_pfp_crouch', seal_crouch_alert02: 'seal_pfp_crouch',
  seal_crouchwalk: 'seal_pfp_crouchwalk', seal_crouch_step: 'seal_pfp_crouch_step', seal_crouchwalk_bw: 'seal_pfp_crouchwalk_bw',
  seal_prone: 'seal_pfp_prone',
  seal_rstrafe: 'seal_p_rstrafe', seal_lstrafe: 'seal_p_lstrafe', seal_rstrafe_fast: 'seal_p_rstrafe_fast',
  seal_lstrafe_fast: 'seal_p_lstrafe_fast', seal_run_90r: 'seal_p_run_90r', seal_run_90l: 'seal_p_run_90l',
});

/** The reload clips by stance, and the moving one (animset.rdr's "Rifle reload" family). */
export const RELOAD_CLIPS = {
  stand: 'seal_reload', crouch: 'seal_crouch_reload', prone: 'seal_prone_reload', moving: 'seal_mv_reload',
} as const;

/** The pistol's (animset.rdr's "Pistol reload", "Pistol crouch reload", "Pistol prone reload", "Moving pistol reload"). */
export const PISTOL_RELOAD_CLIPS = {
  stand: 'seal_p_reload', crouch: 'seal_p_crouch_reload', prone: 'seal_p_prone_reload', moving: 'seal_p_mv_reload',
} as const;

/**
 * `FUN_005a82e0`'s still test for the reload: the mover's speed squared at most 400.0 (20 units a second) --
 * hard-coded; `dynamics.rdr`'s `min_running_reload_speed` is loaded but never read. Faster, standing or crouched, the
 * moving reload (an overlay on the upper body); prone always the prone one.
 */
export const RELOAD_STILL_SPEED = 20;

/** Every clip the weapon's layer asks the worker for (the page adds them to `PLAY_CLIPS`). */
export const WEAPON_CLIPS: readonly string[] = [...new Set([
  ...Object.values(FIRE_VERSIONS), ...Object.values(RELOAD_CLIPS),
  ...Object.values(PISTOL_FIRE_VERSIONS), ...Object.values(PISTOL_RELOAD_CLIPS),
])];

/** The clips the picker plays standing still in each stance (kept for the hook's readers; the reload reads the speed). */
export const STILL_CLIPS: ReadonlySet<string> = new Set(['seal_stand', 'seal_crouch', 'seal_prone']);

/** PLACEHOLDER (named): the reload clips' blend in and out, seconds (`motion.rdr` gives them no `BlendTime`). */
export const RELOAD_BLEND_PLACEHOLDER = 0.2;
/** The viewer's reading (named): Fire versions of locomotion cycles share the base clip's phase. */
export const PHASE_SHARED = true;

/** What the layers are doing, for the hook. */
export interface WeaponPoseStats { fire: string | null; fireWeight: number; reload: string | null; reloadWeight: number }

/** A stance as the reload picks its clip. */
export type ReloadStance = 'stand' | 'crouch' | 'prone';

/** A locomotion clip: `max_velocity` over 0 in the table (77 §7), which plays by the mover's speed. */
const isLocomotion = (entry: MotionEntry | undefined): boolean => entry !== undefined && entry.maxVelocity !== null && entry.maxVelocity > 0;

/** The reload's length: the clip's `playback` seconds, else its keys at its own rate. */
export function reloadLength(clip: MotionClip | undefined, table: MotionTable | null): number | null {
  if (!clip) return null;
  const playback = table?.get(clip.name)?.playback;
  return playback !== null && playback !== undefined && playback > 0 ? playback : clip.frameCount / clip.rate;
}

/**
 * The two layers over the clips, in the order the animator takes them: the Fire version at the raise weight, then the
 * reload over it. `step` runs their clocks once a frame, before the animator's.
 */
export class WeaponPose {
  /** The raise weight (`./weaponRaise`), set once a frame. */
  fireWeight = 0;
  /** The firearm in use (`m_item`): the rifle's or the pistol's Fire versions and reloads. */
  item: 'rifle' | 'pistol' = 'rifle';
  /** The mover faster than `RELOAD_STILL_SPEED` (the page sets it each frame): the moving reload. */
  moving = false;
  private fireClock = 0;
  private fireClip: string | null = null;
  private reload: { stance: ReloadStance; elapsed: number; length: number } | null = null;
  private readonly now: WeaponPoseStats = { fire: null, fireWeight: 0, reload: null, reloadWeight: 0 };

  /** The Fire version of the clip playing, at the raise weight. */
  readonly fireLayer: PoseLayer = { sample: (c) => this.sampleFire(c) };
  /** The reload clip, blended in and out over `RELOAD_BLEND_PLACEHOLDER`. */
  readonly reloadLayer: PoseLayer = { sample: (c) => this.sampleReload(c) };

  constructor(private readonly clips: ReadonlyMap<string, MotionClip>, private readonly table: MotionTable | null) {}

  /** Advances the layers' own clocks (the Fire pose's, the reload's) by `dt` seconds. */
  step(dt: number): void {
    this.fireClock += dt;
    if (this.reload) {
      this.reload.elapsed += dt;
      if (this.reload.elapsed >= this.reload.length) this.reload = null;
    }
  }

  /** A reload starts: its clip by the stance (and, frame by frame, whether the SEAL moves); `length` seconds. */
  startReload(stance: ReloadStance, length: number): void {
    this.reload = length > 0 ? { stance, elapsed: 0, length } : null;
  }

  /** The reload stops early (a new map, leaving the walk). */
  stopReload(): void {
    this.reload = null;
  }

  /** Whether a reload clip is playing. */
  reloading(): boolean {
    return this.reload !== null;
  }

  /** The reload's length in a stance, moving or not: the clip's `playback` (null without the clip). */
  reloadSeconds(stance: ReloadStance, moving: boolean): number | null {
    return reloadLength(this.clips.get(this.reloadClip(stance, moving)), this.table);
  }

  /** `FUN_005a82e0`'s choice: prone the prone reload; else moving the overlay, still the stance's; the item's set. */
  reloadClip(stance: ReloadStance, moving: boolean): string {
    const set = this.item === 'pistol' ? PISTOL_RELOAD_CLIPS : RELOAD_CLIPS;
    return stance === 'prone' ? set.prone : moving ? set.moving : set[stance];
  }

  stats(): WeaponPoseStats {
    return { ...this.now };
  }

  private sampleFire(current: LayerContext): { parts: readonly PartPose[]; weight: number } | null {
    this.now.fire = null;
    this.now.fireWeight = 0;
    const name = (this.item === 'pistol' ? PISTOL_FIRE_VERSIONS : FIRE_VERSIONS)[current.clip.name];
    const fire = name ? this.clips.get(name) : undefined;
    if (!fire || !(this.fireWeight > 0)) return null;
    if (fire.name !== this.fireClip) { this.fireClip = fire.name; this.fireClock = 0; }
    const entry = entryOf(fire.name, this.table);
    // A still Fire clip plays over its `playback` seconds (the one-shot rule, research 77 §7); a moving one shares the
    // base clip's phase (PHASE_SHARED).
    const playback = entry?.playback !== null && entry?.playback !== undefined && entry.playback > 0 ? entry.playback : null;
    const time = PHASE_SHARED && isLocomotion(entry)
      ? current.phase * fire.duration
      : this.fireClock * (playback ? fire.duration / playback : 1);
    this.now.fire = fire.name;
    this.now.fireWeight = this.fireWeight;
    return { parts: sampleClip(fire, time, { loop: entry?.looped ?? true }).parts, weight: this.fireWeight };
  }

  private sampleReload(current: LayerContext): { parts: readonly PartPose[]; weight: number } | null {
    this.now.reload = null;
    this.now.reloadWeight = 0;
    const r = this.reload;
    if (!r) return null;
    const name = this.reloadClip(r.stance, this.moving);
    const clip = this.clips.get(name);
    if (!clip) return null;
    const fraction = Math.min(1, r.elapsed / r.length);
    const weight = Math.max(0, Math.min(1, Math.min(r.elapsed, r.length - r.elapsed) / RELOAD_BLEND_PLACEHOLDER));
    this.now.reload = name;
    this.now.reloadWeight = weight;
    return { parts: sampleClip(clip, fraction * clip.duration, { loop: false }).parts, weight };
  }
}
