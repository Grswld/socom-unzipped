import type { Material } from './materials';

/**
 * When the game plays the walk's sounds, and which (web/docs/research/81 §4-§6), as pure functions of what the
 * viewer knows about the SEAL.
 */

/**
 * `FUN_00342670` (decomp 241912-241955): a sound's gain at `distance` units from the listener under its script
 * `RANGE` -- 1 inside `min`, `1 - (d - min) / (max - min)` out to `max`, 0 beyond. The game multiplies the play
 * volume (0..0x400) by it, and by the global 1.0 at `0x3e0070` (read off the ELF), before 989snd's square law.
 */
export function rangeGain(distance: number, range: readonly [number, number]): number {
  const [min, max] = range;
  if (distance <= min) return 1;
  if (distance > max || max <= min) return 0;
  return 1 - (distance - min) / (max - min);
}

/**
 * `FUN_00342670`'s pan: the source in the listener's frame, `atan2(x, -z)` in whole degrees, a negative one plus 360
 * -- 0 ahead, 90 to the right, 270 to the left, the 989snd pan (`makeVolume`). Here from the listener's own right and
 * forward components, so the viewer's axes do not matter.
 */
export function panDegrees(right: number, forward: number): number {
  const deg = Math.trunc((Math.atan2(right, forward) * 180) / Math.PI);
  return deg < 0 ? deg + 360 : deg;
}

/** The stance byte `+0x174` as `FUN_0058a720` returns it: 0 standing, 1 crouched, 2 prone. */
export type StanceCode = 0 | 1 | 2;

/**
 * `FUN_005a39b0` (decomp 460385-460434): the footstep's sound for the material under the feet -- prone, its
 * `CRAWLSOUND`; otherwise `STEPSOUND` when the stick is past half on either axis (any of the controller's three
 * axis floats over 0.5 or under -0.5), `STEALTH_STEPSOUND` when it is not. A material with no such sound is silent.
 */
export function footstepSound(material: Material | undefined, stance: StanceCode, stick: number): string | null {
  if (!material) return null;
  if (stance === 2) return material.crawl;
  return Math.abs(stick) > 0.5 ? material.step : material.stealthStep;
}

/** Which foot a footfall is: the left at the start of the cycle, the right at its middle. */
export type Foot = 'left' | 'right';

/**
 * `FUN_005a3570` (decomp 460266-460378): the footfalls of a locomotion clip. The clip's play position (`+0x1c` of the
 * current track, a float whose whole part counts the cycles) is taken modulo 1: entering (0, 0.5) is the left foot's
 * fall (flag `+0x211`, the bone at `+0x2f0`), entering (0.5, 1) the right's (`+0x210`, `+0x2f4`), each once until the
 * position leaves its half. Only while the SEAL moves -- its speed squared over 0.25 (`FUN_0058a820`'s class 2 or 3
 * standing; the same test crouched and prone) -- or the stick's forward axis is at 0.1 or more either way; and only on
 * a clip whose flags carry 0x40 (`FUN_005551a0`), the locomotion cycles. Prone, the left foot's fall plays nothing
 * (the call is skipped for stance 2) and the right's plays the crawl: one crawl a cycle.
 */
export class FootfallClock {
  private left = false;
  private right = false;

  /**
   * One frame: `phase` is the cycle position (any real; its fraction is used), `moving` the game's test above.
   * Returns the foot that fell this frame, or null.
   */
  update(phase: number | null, moving: boolean): Foot | null {
    if (phase === null || !moving) return null;   // the block is skipped: the flags keep what they held
    const f = phase - Math.floor(phase);
    let fell: Foot | null = null;
    if (f <= 0 || f >= 0.5) this.left = false;
    else if (!this.left) { this.left = true; fell = 'left'; }
    if (f <= 0.5 || f >= 1) this.right = false;
    else if (!this.right) { this.right = true; fell = 'right'; }
    return fell;
  }
}

/** `FUN_005a3570`'s moving test from the SEAL's velocity (units a second) and the stick's forward axis. */
export function footfallMoving(speed: number, stickForward: number): boolean {
  return speed * speed > 0.25 || Math.abs(stickForward) >= 0.1;
}

/** `.BONE_BRK_1` (0x65f548, `DAT_0044d580` of `FUN_005a49f0`): the hard landing's crack. */
export const HARD_LANDING_SOUND = '.BONE_BRK_1';

/**
 * The landing speeds the class is taken against: reCOM's `m_landSpeed[i] = gravity * sqrt(2 * fallDist[i] / gravity)`
 * (`zCharacter/char_dyn.cpp:32-35`), `sqrt(2 g d)`, over `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` in units -- the
 * table's `+0x30..+0x38` (`0x44c280..0x44c288`) that `FUN_005ac1f0` compares.
 */
export function landSpeeds(gravity: number, fallDistances: readonly [number, number, number]): [number, number, number] {
  const s = (d: number): number => gravity * Math.sqrt((2 * d) / gravity);
  return [s(fallDistances[0]), s(fallDistances[1]), s(fallDistances[2])];
}

/** The landing's class, `FUN_005ac1f0`'s `lVar8`: 0 soft, 1 light damage, 2 heavy, 3 deadly. */
export type LandingClass = 0 | 1 | 2 | 3;

/** `FUN_005ac1f0` (decomp 464866-464960): a landing's class at contact `speed` (units a second). */
export function landingClass(speed: number, speeds: readonly [number, number, number]): LandingClass {
  if (speed <= speeds[0]) return 0;
  if (speed <= speeds[1]) return 1;
  if (speed < speeds[2]) return 2;
  return 3;
}

/**
 * `FUN_005ac1f0`'s sounds: the material's `LANDSOUND` for a soft landing and a light one (the light one also a
 * grunt, `FUN_00578150(0.33)`, the damage voice -- not modelled); `.BONE_BRK_1` alone for a heavy one; both for a
 * deadly one. Stances 8 and 10 (not the walk's) always land soft.
 */
export function landingSounds(material: Material | undefined, cls: LandingClass): string[] {
  const land = material?.land ?? null;
  const out: string[] = [];
  if (cls !== 2 && land) out.push(land);
  if (cls >= 2) out.push(HARD_LANDING_SOUND);
  return out;
}
