import { sampleClip, THROW_ANIMS, type MotionClip, type PartPose, type ThrowAnim } from '@s2u/scene';
import type { LayerContext, PoseLayer } from './animator';
import { BLEND_TIME_DEFAULT, entryOf, motionOf, type Motion } from './locomotion';
import type { MotionTable } from './motionTable';

/**
 * The throw's clip on the body (the grenades workstream; web/docs/research/85 §3): the clip `GetThrowAnim` picked,
 * played as the game plays a one-shot and laid over the locomotion as an `Animator` pose layer, the way the weapon's
 * reload is (`./weaponPose`) -- the clip picker and its cross-fade untouched.
 *
 * - **The clock** is the one-shot rule the motion workstream read (`./locomotion`, `FUN_0028c4f0`): the phase runs at
 *   `1 / (playback (n - 1) / n)` a second to its stop at `(n - 1) / n`, the key sampled `phase x n`; the release
 *   fraction is a phase (`@s2u/scene`'s `releaseSeconds`), so the hand lets go on the clip's own frame.
 * - **The blend**: in over the clip's `BlendTime` (0.2 on the crouched throw, else `FUN_00287620`'s 0.4), as a new play
 *   cross-fades; out over `BLEND_TIME_DEFAULT` once the clip holds its last key, as the locomotion's play that follows
 *   would cross-fade in [reading: the play after a throw is not traced].
 * - **The callbacks**: `motion.rdr`'s `zanim_callback`s on the clip (`throw_whoosh` at 0.45 on the standing throw: the
 *   grunt `.MALE_GRUNT`) as the phase crosses them, for the page's audio.
 */

/** Every throw clip the page asks the worker for (the page adds them to `PLAY_CLIPS`). */
export const THROW_CLIPS: readonly string[] = [...new Set(Object.values(THROW_ANIMS).map((a) => a.clip))];

/** Where the clips come from once the source's pack is in (`Play.motionSource`). */
export type ThrowClipSource = () => { clips: ReadonlyMap<string, MotionClip>; table: MotionTable | null } | null;

export interface ThrowPoseStats { clip: string | null; phase: number; weight: number; elapsed: number }

export class ThrowPose {
  private motion: Motion | null = null;
  private elapsed = 0;
  private phase = 0;
  private weight = 0;
  private fired = new Set<string>();
  /** The pose layer: `Play.addPoseLayer` lays it over the clips. */
  readonly layer: PoseLayer = { sample: (c) => this.sample(c) };

  constructor(private readonly source: ThrowClipSource) {}

  /** The throw's clip starts now; false without the clip (the grenade still flies, from the table's hand). */
  start(anim: ThrowAnim): boolean {
    const src = this.source();
    const clip = src?.clips.get(anim.clip);
    if (!src || !clip) { this.motion = null; return false; }
    this.motion = motionOf(clip, entryOf(clip.name, src.table));
    this.elapsed = 0;
    this.phase = 0;
    this.fired = new Set();
    return true;
  }

  /** Stops at once (a new map, leaving the walk). */
  stop(): void {
    this.motion = null;
    this.weight = 0;
  }

  playing(): boolean {
    return this.motion !== null;
  }

  /** Advances the clock by `dt`; returns the callbacks the phase crossed (their zAnim names). */
  step(dt: number): string[] {
    const m = this.motion;
    if (!m) return [];
    this.elapsed += dt;
    const a = m.frames < 2 ? 1 : (m.frames - 1) / m.frames;
    this.phase = Math.min(m.end, this.elapsed / (m.period * a));
    const played = m.period * a * m.end;                       // playback ((n - 1) / n)^2 seconds
    const blendIn = m.blendTime > 0 ? Math.min(1, this.elapsed / m.blendTime) : 1;
    const blendOut = this.elapsed <= played ? 1 : Math.max(0, 1 - (this.elapsed - played) / BLEND_TIME_DEFAULT);
    this.weight = Math.min(blendIn, blendOut);
    const out: string[] = [];
    for (const c of m.callbacks) {
      if (this.phase >= c.phase && !this.fired.has(c.name)) { this.fired.add(c.name); out.push(c.name); }
    }
    if (blendOut <= 0) this.stop();
    return out;
  }

  stats(): ThrowPoseStats {
    return { clip: this.motion?.name ?? null, phase: this.phase, weight: this.weight, elapsed: this.elapsed };
  }

  private sample(_current: LayerContext): { parts: readonly PartPose[]; weight: number } | null {
    const m = this.motion;
    if (!m || !(this.weight > 0)) return null;
    const key = this.phase * m.frames;
    return { parts: sampleClip(m.clip, key / m.clip.rate, { loop: false }).parts, weight: this.weight };
  }
}
