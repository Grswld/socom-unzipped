import { STANCES, type Stance, type SwapPick, type TraversalHooks, type Walker, type WalkInput, type PlaySnapshot } from '../mover';
import { moverSnapshot } from '../mover';
import { Button, holdOf, STANCE_CODES, type Command } from './protocol';

/**
 * One command applied to a mover (web sprint 3, W3.R8): the page's prediction and the server run every tick through
 * this one function, so the two movers see the same look, the same buttons in the same order and the same stick.
 * The rules are `WalkMode`'s own (`./walk`): a stance button while a move holds the mover goes to the move (hanging:
 * stand climbs, crouch/prone let go), prone from a run is the dive, the jump while hanging lets go, the swap is refused
 * while a move holds; the action and lean buttons go to the moves.
 */

/** What one tick did, for the page's bookkeeping (the animator's jump count, the stance shown). */
export interface TickResult { jumped: boolean; stance: Stance; swap: SwapPick | null }

/** The moves a mover may carry (`./traversal`'s `Traversal`), with the held action button. */
export type Moves = TraversalHooks & { holdAction?(on: boolean): void };

export class MoverSim {
  /** Jumps taken (the animator sees a take-off by the count). */
  jumps = 0;
  /** The weapon in hand: 0 the rifle, 1 the sidearm (`Button.Swap` moves it). */
  weapon: 0 | 1 = 0;
  /** The last command applied. */
  seq = 0;
  /** The turn the last command carried. */
  turn = 0;

  constructor(readonly walker: Walker, readonly moves: Moves | null) {
    walker.driver = moves;
  }

  /**
   * The command's look and buttons laid on the mover; returns the stick for its tick. Call `walker.tick` with it (the
   * server: `apply`) or hand this to `Walker.advance` as its `beforeTick` (the page).
   */
  prepare(cmd: Command, out?: TickResult): WalkInput {
    const w = this.walker, m = this.moves;
    this.seq = cmd.seq;
    this.turn = cmd.turn;
    w.state.yaw = cmd.yaw;
    w.state.pitch = cmd.pitch;
    w.turn = cmd.turn;
    const b = cmd.buttons;
    w.scoped = (b & Button.Scope) !== 0;                         // FUN_005966a0: the stick x 0.2 in the 9x view or a scope
    m?.lean((b & Button.LeanLeft) ? -1 : (b & Button.LeanRight) ? 1 : 0);
    m?.holdAction?.((b & Button.ActionHeld) !== 0);
    if (b & Button.Action) m?.action();
    if (b & Button.Stance) this.stance(STANCE_CODES[cmd.stance] ?? 'stand');
    let jumped = false;
    if (b & Button.Jump) jumped = this.jump();
    let swap: SwapPick | null = null;
    if (b & Button.Swap) {
      const to: 0 | 1 = cmd.weapon ? 1 : 0;
      if (to !== this.weapon && !m?.busy()) {
        swap = w.swapWeapon(to ? 'pistol' : 'rifle');
        if (swap) this.weapon = to;
      }
    }
    const hold = holdOf(b);
    if (hold) w.hold(hold);                                      // the kit's one-shot: a throw, the claymore, a still reload
    if (out) { out.jumped = jumped; out.stance = w.stance; out.swap = swap; }
    return { forward: cmd.forward, right: cmd.right, boost: (b & Button.Boost) !== 0 };
  }

  /** The whole tick: `prepare`, then the mover's step. */
  apply(cmd: Command): TickResult {
    const out: TickResult = { jumped: false, stance: this.walker.stance, swap: null };
    this.walker.tick(this.prepare(cmd, out));
    out.stance = this.walker.stance;
    return out;
  }

  /** `WalkMode.setStance` while walking. */
  private stance(stance: Stance): void {
    if (!STANCES.includes(stance)) return;
    const w = this.walker, m = this.moves;
    if (m?.busy()) { m.stanceButton(w, stance); return; }
    if (stance === 'prone' && w.stance !== 'prone' && m?.dive(w)) return;
    w.changeStance(stance);
  }

  /** `WalkMode.jump` while walking. */
  private jump(): boolean {
    const w = this.walker, m = this.moves;
    if (m?.busy()) return m.jump(w);
    if (!w.jump()) return false;
    this.jumps++;
    return true;
  }

  /** The body as the animator reads it, at the mover's own feet (a server steps whole ticks: nothing to draw between). */
  body(): PlaySnapshot {
    const s = moverSnapshot(this.walker, this.moves, this.jumps, this.turn);
    s.feet = [this.walker.state.x, this.walker.state.y, this.walker.state.z];
    return s;
  }
}
