/**
 * The rifle raised to fire and lowered after (the WEAPON workstream; the owner's playtest: "shooting should engage a
 * second animation where the rifle goes up"). A port of three pieces of `socom2_game.elf`, each cited by address:
 *
 * 1. **The envelope** at `seal+0x1160` (four floats: `in`, `hold`, `out`, `remaining`):
 *    `FUN_00286d90` 0x286d90 starts it (`remaining = in + hold + out`), `FUN_00286d40` 0x286d40 runs it down by the
 *    tick, `FUN_00286d70` 0x286d70 clears it, `FUN_00286c90` 0x286c90 reads its linear weight -- rising over the first
 *    `in` seconds, 1 through `hold`, falling over the last `out` -- and `FUN_00286b80` 0x286b80 the same weight eased
 *    (`2s^2` to the half, its mirror after: the node blend's ease, `animator.ts` `blendWeight`).
 * 2. **The raise/lower state** at `seal+0xf74` (1 up, 2 down, bit 0x10 moving): `FUN_005dfe30` 0x5dfe30 asks for a
 *    state, `FUN_005dfc80` 0x5dfc80 runs it each tick, `FUN_005dffc0` 0x5dffc0 sets the rifle's times into
 *    `seal+0xee4..0xef0`: **in 0.1 s** (`0x3dcccccd`), **hold 100000 s** (`0x47c35000`, "until lowered"),
 *    **out 0.5 s** (`0x3f000000`), and their sum `0x47c3504d`.
 * 3. **The player's trigger** (`FUN_00594cf0` 0x594cf0, decomp lines 453577-453650, the player control): the fire
 *    button's edge state at `ctrl+0x118` (0 idle, 2 pressed, 1 held, 3 released); pressed or held asks for the rifle
 *    up; every edge resets the countdown at `ctrl+0x234` to `ctrl+0x22c` + `ctrl+0x230` x rand, which the controller's
 *    constructor (`FUN_00598280` 0x598280, lines 454808-454809) sets to **5.0 s** and **0**; idle, the countdown
 *    runs, and when it has run out the rifle is asked down. While the controller holds its aim (`ctrl+0xc0 > 0`, or
 *    the inventory's `FUN_005be6c0` && !`FUN_005b90f0`) the rifle is kept up and the countdown reset.
 *
 * The weight is what `CZSealBody_Tick_0` (0x57a330, decomp lines 438828-438860) blends the clips' **Fire** versions
 * in with (`FUN_0028bdd0(weight, ...)`, the version looked up by `FUN_0058c970` → `FUN_005e1a10` from the table
 * `FUN_005e0690` fills at lines 494790-494801): see `./weaponPose`.
 *
 * What is the viewer's and not the game's, by name:
 * - `AIM_HOLDS_RAISE`: the controller's aim test is read as the viewer's aim lane (`ctrl+0xc0` is not named).
 * - The capability bit `seal+0x258` bit 0 and the item test `item+0x7c != 0xbe` that gate the raise
 *   (`FUN_005dfe30`) are taken as passed: the SEAL holds a rifle.
 * - The countdown's "never" sentinel `DAT_0065a858` is not on hand; the countdown here always runs.
 */

/** `FUN_005dffc0` 0x5dffc0: the rifle's raise envelope, seconds (in, hold -- "until lowered" -- and out). */
export const RAISE_TIMES = { in: 0.1, hold: 100000, out: 0.5 } as const;
/**
 * `FUN_00598280` 0x598280 (lines 454808-454809): how long the rifle stays up after the trigger was last down,
 * seconds, and the random extra (none).
 */
export const LOWER_DELAY = { base: 5, random: 0 } as const;
/**
 * The viewer's reading (named): the controller keeps the rifle up while it aims (`ctrl+0xc0 > 0` in `FUN_00594cf0`),
 * taken as the aim lane (L1 / the right button).
 */
export const AIM_HOLDS_RAISE = true;

/** The node blend's ease: `2s^2` to the half, its mirror after (`FUN_00286b80`'s tail, `blendWeight` in `./animator`). */
export function ease(s: number): number {
  if (s <= 0.5) return s * 2 * s;
  const d = (s - 1) * 2;
  return 1 - d * 0.5 * d;
}

/** The four-float envelope at `seal+0x1160` (`FUN_00286b80` .. `FUN_00286d90`). */
export class Envelope {
  in = 0;
  hold = 0;
  out = 0;
  /** Seconds left: the whole length at the start, 0 when spent. */
  remaining = 0;

  get total(): number {
    return this.out + this.in + this.hold;
  }

  /** `FUN_00286d90`: the three lengths, and the whole of it left. */
  start(inS: number, hold: number, out: number): void {
    this.in = inS;
    this.hold = hold;
    this.out = out;
    this.remaining = out + inS + hold;
  }

  /** `FUN_00286d70`. */
  clear(): void {
    this.in = this.hold = this.out = this.remaining = 0;
  }

  /** `FUN_00286d40`: `dt` seconds off what is left, not under 0. */
  run(dt: number): number {
    this.remaining = Math.max(0, this.remaining - dt);
    return this.remaining;
  }

  /** `FUN_00286c90`: the linear weight (and `remaining` clamped to the whole, as the body stores it back). */
  linear(): number {
    const total = this.total;
    const t = Math.min(this.remaining, total);
    this.remaining = t;
    if (!(t > 0)) return 0;
    if (this.hold + this.out < t) return (total - t) / this.in;
    return t < this.out ? t / this.out : 1;
  }

  /** `FUN_00286b80`: the linear weight, eased. */
  weight(): number {
    return ease(this.linear());
  }
}

/** The state word at `seal+0xf74`: up or down, and whether it is on its way. */
const UP = 1, DOWN = 2, MOVING = 0x10;

/** The trigger's edge state at `ctrl+0x118` (`FUN_00594cf0`): 0 idle, 2 pressed, 1 held, 3 released. */
export type TriggerEdge = 0 | 1 | 2 | 3;

/** `FUN_00594cf0`'s edge table: the next state from the last and whether the button is down now. */
export function nextEdge(last: TriggerEdge, down: boolean): TriggerEdge {
  switch (last) {
    case 3: return down ? 2 : 0;
    case 2: return down ? 1 : 3;
    case 1: return down ? 1 : 3;
    default: return down ? 2 : 0;
  }
}

/** What the rifle is doing, for the hook. */
export interface RaiseStats { weight: number; state: 'up' | 'down'; moving: boolean; countdown: number; edge: TriggerEdge }

/**
 * The rifle's raise: fed the trigger and the aim once a frame, it answers the weight the Fire clips blend in with.
 * Down at the start, as the controller's countdown starts spent (`FUN_00598280` sets it before the 5 s is stored).
 */
export class WeaponRaise {
  readonly envelope = new Envelope();
  private state = DOWN;
  private edge: TriggerEdge = 0;
  private countdown = 0;

  /** `FUN_005dfe30`: asks for the rifle up (1) or down (2). */
  request(target: typeof UP | typeof DOWN): void {
    if (target === (this.state & ~MOVING)) return;
    const env = this.envelope;
    let since = env.remaining;
    if (since > 0) since = RAISE_TIMES.out + RAISE_TIMES.in + RAISE_TIMES.hold - since;   // `seal+0xef0` - remaining
    if (target === DOWN) {
      // Falls from where it is: the linear weight, under 0.99, times the out time.
      env.remaining = Math.min(0.99, env.linear()) * env.out;
      this.state = DOWN | MOVING;
    } else {
      this.state = UP | MOVING;
      if (since === 0) env.start(RAISE_TIMES.in, RAISE_TIMES.hold, RAISE_TIMES.out);
      else if (RAISE_TIMES.in <= since && since < RAISE_TIMES.in + RAISE_TIMES.hold) this.state &= ~MOVING;
    }
  }

  /** `FUN_005dfc80`: one tick of the raise or the fall. */
  private run(dt: number): void {
    const env = this.envelope;
    const s = this.state & ~MOVING;
    if ((this.state & MOVING) === 0) {
      if (s === DOWN && env.weight() !== 0) { this.state = UP; this.request(DOWN); }
      else if (s === UP && env.weight() !== 1) { this.state = DOWN; this.request(UP); }
      return;
    }
    if (s === DOWN) {
      env.run(dt);
      if (env.remaining <= 0) { this.state &= ~MOVING; env.clear(); }
    } else if (s === UP) {
      const full = env.out + env.hold;
      if (env.remaining <= full) { env.remaining = full; this.state &= ~MOVING; }
      else env.run(dt);
    }
  }

  /**
   * One frame: the trigger's edge (`FUN_00594cf0`), the request it makes, then the envelope's tick. Returns the
   * eased weight the Fire clips take.
   */
  frame(dt: number, input: { trigger: boolean; aiming: boolean }): number {
    this.edge = nextEdge(this.edge, input.trigger);
    const reset = (): void => { this.countdown = LOWER_DELAY.base + LOWER_DELAY.random * Math.random(); };
    if (this.edge === 0) {
      let want: typeof UP | typeof DOWN = AIM_HOLDS_RAISE && input.aiming ? UP : DOWN;
      if (want === DOWN) {
        this.countdown -= dt;
        if (this.countdown > 0) want = UP;
      } else reset();
      this.request(want);
    } else {
      reset();
      this.request(UP);
    }
    this.run(dt);
    return this.envelope.weight();
  }

  /** The eased weight now, without a tick. */
  weight(): number {
    return this.envelope.weight();
  }

  /** Straight down, for a new map or leaving the walk. */
  reset(): void {
    this.envelope.clear();
    this.state = DOWN;
    this.edge = 0;
    this.countdown = 0;
  }

  stats(): RaiseStats {
    return {
      weight: this.envelope.weight(), state: (this.state & ~MOVING) === UP ? 'up' : 'down',
      moving: (this.state & MOVING) !== 0, countdown: Math.max(0, this.countdown), edge: this.edge,
    };
  }
}
