import type { Stance } from './walk';

/**
 * The stance button's tap and hold: the pad's Triangle (`./play`, `main.ts`) and the PC's `C` (`./walk`), one state
 * machine with each its own rules.
 */

/**
 * How long the stance button is held before it means prone, seconds -- Triangle on the pad and `C` on the keyboard. A
 * guess: the game does not time the button, it reads its pressure (a light press toggles crouch at release, a full
 * press goes prone at once; `host_crouch_shortcut.h:4-7`, docs/KNOWN.md R139), and a browser pad's button is only on
 * or off, so the owner's rule (2026-09-28: tap crouches, hold goes prone) needs a length, and none is in the
 * repository. 0.4 s is a comfortable tap's ceiling.
 */
export const STANCE_HOLD_S_PLACEHOLDER = 0.4;

/** What a tap on the pad's stance button does: stand and crouch toggle, and from prone it stands up. */
export function stanceOnTap(stance: Stance): Stance {
  return stance === 'stand' ? 'crouch' : 'stand';
}

/** What a hold on the pad's does: prone, or from prone up on its feet (the game's full press stands a prone SEAL). */
export function stanceOnHold(stance: Stance): Stance {
  return stance === 'prone' ? 'stand' : 'prone';
}

/** What a tap on `C` does (owner, 2026-09-29): stand and crouch toggle, and from prone it crouches. */
export function stanceKeyOnTap(stance: Stance): Stance {
  return stance === 'crouch' ? 'stand' : 'crouch';
}

/** What a hold on `C` does (owner, 2026-09-29): prone; already prone, nothing. */
export function stanceKeyOnHold(stance: Stance): Stance | null {
  return stance === 'prone' ? null : 'prone';
}

/** A button's two meanings: the stance a tap and a hold go to from a stance (null: nothing). */
export interface StanceRules {
  tap(stance: Stance): Stance | null;
  hold(stance: Stance): Stance | null;
}

/** The pad's Triangle (owner, 2026-09-28). */
export const PAD_STANCE: StanceRules = { tap: stanceOnTap, hold: stanceOnHold };
/** The PC's `C` (owner, 2026-09-29). */
export const KEY_STANCE: StanceRules = { tap: stanceKeyOnTap, hold: stanceKeyOnHold };

/**
 * The stance button as a state machine, one `update` a frame: a press let go inside `STANCE_HOLD_S_PLACEHOLDER` is a
 * tap and acts at the release, as the game's light press does; a press held that long acts at that moment (the game's
 * full press acts at once) and its release then does nothing. Returns the stance to go to, or null.
 */
export class StanceButton {
  private held = 0;
  private was = false;
  private acted = false;

  constructor(private readonly holdSeconds = STANCE_HOLD_S_PLACEHOLDER, private readonly rules: StanceRules = PAD_STANCE) {}

  update(down: boolean, dt: number, stance: Stance): Stance | null {
    let go: Stance | null = null;
    if (down) {
      if (!this.was) { this.held = 0; this.acted = false; }
      this.held += dt;
      if (!this.acted && this.held >= this.holdSeconds) { this.acted = true; go = this.rules.hold(stance); }
    } else if (this.was && !this.acted) {
      go = this.rules.tap(stance);
    }
    this.was = down;
    return go;
  }

  /** Forgets a press under way (the walk left, the page lost the keyboard): its release is then no tap. */
  reset(): void {
    this.held = 0;
    this.was = false;
    this.acted = false;
  }
}
