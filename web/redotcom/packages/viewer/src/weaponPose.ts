import { sampleClip, type MotionClip, type PartPose } from '@s2u/scene';
import { slerp, type LayerContext, type PoseLayer } from './animator';
import { entryOf } from './locomotion';
import type { MotionEntry, MotionTable } from './motionTable';
import { PISTOL_RELOAD_CLIPS, RELOAD_CLIPS, reloadClip, reloadSeconds, type ReloadStance } from './reloadClip';

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

// The reload's clips, its still test and its length live in `./reloadClip` (one table with the match server, MJ-1).
export { PISTOL_RELOAD_CLIPS, RELOAD_CLIPS, RELOAD_STILL_SPEED, reloadLength, type ReloadStance } from './reloadClip';

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

/** A locomotion clip: `max_velocity` over 0 in the table (77 §7), which plays by the mover's speed. */
const isLocomotion = (entry: MotionEntry | undefined): boolean => entry !== undefined && entry.maxVelocity !== null && entry.maxVelocity > 0;

/**
 * The two layers over the clips, in the order the animator takes them: the Fire version at the raise weight, then the
 * reload over it. `step` runs their clocks once a frame, before the animator's.
 */
/**
 * Poses merged by weight, part by part (the node blend's way, `FUN_00577000`): each part's turn slerped in at its
 * weight over the running sum, its place a weighted mean; a part only some poses carry is theirs.
 */
export function mergeParts(poses: readonly { parts: readonly PartPose[]; weight: number }[]): PartPose[] {
  const acc = new Map<string, { part: PartPose; w: number }>();
  for (const { parts, weight } of poses) {
    if (!(weight > 0)) continue;
    for (const p of parts) {
      const a = acc.get(p.name);
      if (!a) { acc.set(p.name, { part: { ...p, rotation: [...p.rotation], translation: [...p.translation] }, w: weight }); continue; }
      const f = weight / (a.w + weight);
      const t = a.part.translation;
      a.part = {
        ...a.part,
        rotation: slerp(a.part.rotation, p.rotation, f),
        translation: [t[0] + (p.translation[0] - t[0]) * f, t[1] + (p.translation[1] - t[1]) * f, t[2] + (p.translation[2] - t[2]) * f],
      };
      a.w += weight;
    }
  }
  return [...acc.values()].map((a) => a.part);
}

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
    return reloadSeconds(this.clips, this.table, stance, moving, this.item);
  }

  /** `FUN_005a82e0`'s choice: prone the prone reload; else moving the overlay, still the stance's; the item's set. */
  reloadClip(stance: ReloadStance, moving: boolean): string {
    return reloadClip(stance, moving, this.item);
  }

  stats(): WeaponPoseStats {
    return { ...this.now };
  }

  private sampleFire(current: LayerContext): { parts: readonly PartPose[]; weight: number } | null {
    this.now.fire = null;
    this.now.fireWeight = 0;
    if (!(this.fireWeight > 0)) return null;
    // Per motion slot (`FUN_0057a330` 438828-438860: each slot flagged 0x40 takes its own type's Fire version at the
    // raise weight): the play's nodes that have one, by their weights; a node without one (the strafes, the 90-degree
    // runs) keeps its own clip, so its share of the layer is left out. Keyed on the main clip alone, the whole upper
    // body jumped from the low ready to the shoulder in one frame when the stick's turn made a forward clip the main
    // one (the owner's playtest, 2026-09-29: the hot rifle strafing -- 3.8 units at the muzzle in a frame).
    const versions = this.item === 'pistol' ? PISTOL_FIRE_VERSIONS : FIRE_VERSIONS;
    const nodes = current.nodes ?? [{ clip: current.clip, frame: current.frame, phase: current.phase, weight: 1 }];
    let total = 0;
    const picks: { fire: MotionClip; phase: number; weight: number }[] = [];
    for (const n of nodes) {
      total += n.weight;
      const name = versions[n.clip.name];
      const fire = name ? this.clips.get(name) : undefined;
      if (fire && n.weight > 0) picks.push({ fire, phase: n.phase, weight: n.weight });
    }
    if (!picks.length || !(total > 0)) return null;
    const lead = picks.reduce((a, b) => (b.weight > a.weight ? b : a));
    if (lead.fire.name !== this.fireClip) { this.fireClip = lead.fire.name; this.fireClock = 0; }
    const sampled = picks.map((p) => {
      const entry = entryOf(p.fire.name, this.table);
      // A still Fire clip plays over its `playback` seconds (the one-shot rule, research 77 §7); a moving one shares
      // the base clip's phase (PHASE_SHARED).
      const playback = entry?.playback !== null && entry?.playback !== undefined && entry.playback > 0 ? entry.playback : null;
      const time = PHASE_SHARED && isLocomotion(entry)
        ? p.phase * p.fire.duration
        : this.fireClock * (playback ? p.fire.duration / playback : 1);
      return { parts: sampleClip(p.fire, time, { loop: entry?.looped ?? true }).parts, weight: p.weight };
    });
    const share = picks.reduce((s, p) => s + p.weight, 0) / total;
    const weight = this.fireWeight * Math.min(1, share);
    this.now.fire = lead.fire.name;
    this.now.fireWeight = weight;
    return { parts: sampled.length === 1 ? sampled[0]!.parts : mergeParts(sampled), weight };
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
