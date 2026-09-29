import type { RifleKick as KickRecord, WeaponRecord } from '@s2u/scene';

/**
 * The rifle's kick on the aim (the WEAPON workstream; research 79 §5 left it a placeholder, `RECOIL_PLACEHOLDER` 0).
 * A port of the inventory's two routines in `socom2_game.elf`:
 *
 * - **A round** (`FUN_005b91c0` 0x5b91c0, decomp lines 472032-472058): the weapon's stance record
 *   (`FUN_003c5a50(weapon, FUN_0058a720(seal, 1))`: `zweapon.rdr`'s `Reticule_Modifiers STANCE_STAND/CROUCH/PRONE`)
 *   gives the kick's size, `FireRifleKickBaseDist` + `FireRifleKickRandomDist` x rand (`+0x44`, `+0x48`, read by
 *   `FUN_003c5f70` / `FUN_003c5f60`); the aim's pitch now (`ctrl+0x130`) is kept as the rest (`inv+0x38`), the size as
 *   the goal (`+0x3c`), the kick's progress (`+0x40`) goes to 0 and its state (`+0x44`) to 1, rising.
 * - **Each tick** (`FUN_005b9280` 0x5b9280, lines 472060-472135, run from `FUN_00550ef0` line 418393 while the
 *   inventory holds a gun), behind the flag `DAT_00650938` -- **1 in the image's `.data`** (`overlays/socom2_game.elf`
 *   at 0x650938), so the kick is on: rising, the pitch climbs at `FireRifleKickRate` (`+0x3c` of the stance record,
 *   `FUN_003c5f90`) a second and the progress with it, until the progress passes the goal (state 2); falling, the pitch
 *   drops at `FireRifleKickReturnRate` (`+0x40`, `FUN_003c5f80`) a second until it is back at the rest (state 0).
 *
 * The pitch is `ctrl+0x130`, the aim's pitch in radians: `FUN_00594600` holds it inside `dynamics.rdr`'s aim limits,
 * which the loader stores in radians (`FUN_0059ba80`: `x 0.017453292`). So the M4A1 standing kicks 0.09 to 0.105 rad
 * (5.2 to 6.0 degrees) at 0.5 rad a second and settles at 0.18; each round re-seats the rest at the pitch it finds,
 * so a held trigger climbs while the rounds come faster than a kick completes (at `FireWait` 0.12, 0.06 rad a round).
 *
 * The viewer's readings, named:
 * - `STICK_FOLLOW_PLACEHOLDER`: while falling the game raises the rest by the pad's pitch push (`ctrl+0x138` x
 *   `DAT_003df198` x `DAT_00650980` 0.04), so pulling against the climb keeps the new aim; the viewer's look comes from
 *   the mouse, not a stick rate, and takes no such term (0).
 * - The rest of `FUN_005b9280` (the hurt sway through `FUN_00592b40` and the sniper drift behind `DAT_00650940`) is not
 *   ported.
 */

/** The kick's state at `inv+0x44`: 0 settled, 1 rising, 2 falling. */
export type KickState = 0 | 1 | 2;

/** The stance the kick reads its record for (`FUN_0058a720`). */
export type KickStance = 'stand' | 'crouch' | 'prone';

/** PLACEHOLDER (named): the pad pitch push's share of the rest while the kick falls (`DAT_00650980` is 0.04 in the game). */
export const STICK_FOLLOW_PLACEHOLDER = 0;

export interface KickStats { state: KickState; goal: number; progress: number; rest: number }

export class RifleKick {
  private state: KickState = 0;
  private goal = 0;
  private progress = 0;
  private rest = 0;
  private stance: KickStance = 'stand';

  constructor(private readonly rifle: Pick<WeaponRecord, 'rifleKick'>, private readonly random: () => number = Math.random) {}

  private record(): KickRecord | null {
    return this.rifle.rifleKick?.[this.stance] ?? null;
  }

  /** `FUN_005b91c0`: a round left at aim pitch `pitch` (radians) in `stance`. */
  round(pitch: number, stance: KickStance): void {
    this.stance = stance;
    const k = this.record();
    if (!k) return;
    this.rest = pitch;
    this.goal = k.baseDist + k.randomDist * this.random();
    this.state = 1;
    this.progress = 0;
  }

  /**
   * `FUN_005b9280`'s kick: one tick of `dt` seconds on the aim pitch `pitch` (radians). Returns the change to make to
   * the pitch (radians; 0 when settled).
   */
  frame(dt: number, pitch: number): number {
    const k = this.record();
    if (!k || dt <= 0) return 0;
    if (this.state === 1 && this.goal > 0) {
      const progress = this.progress + k.rate * dt;
      this.progress = progress;
      if (this.goal < progress) { this.state = 2; return 0; }
      return k.rate * dt;
    }
    if (this.state === 2) {
      const next = pitch - k.returnRate * dt;
      this.progress -= k.returnRate * dt;
      if (next <= this.rest) {
        const back = this.rest - pitch;
        this.state = 0; this.goal = 0; this.progress = 0;
        return back;
      }
      return next - pitch;
    }
    return 0;
  }

  /** A new map, or leaving the walk: settled. */
  reset(): void {
    this.state = 0; this.goal = 0; this.progress = 0; this.rest = 0;
  }

  stats(): KickStats {
    return { state: this.state, goal: this.goal, progress: this.progress, rest: this.rest };
  }
}
