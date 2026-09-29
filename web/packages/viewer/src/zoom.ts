import type { WeaponRecord } from '@s2u/scene';

/**
 * The view state and its zoom (research 84 §7), ported from the SEAL body's `+0x200` byte and its three functions:
 *
 * - **The states** (`FUN_005448a0`, which sets `+0x200` and the magnification `+0x204`): 0 the third-person view
 *   (1.0); 1 first person (1.01; 2 is its vehicle twin); 3 night vision (1.01); 4 the 9x view (9.0, with the
 *   `zoom_control` motion); 5 to 12 the weapon's scope, magnification `ZoomMode[state - 4]` (`FUN_003c5980` with
 *   `state - 4`, verified in the disassembly at 0x544adc). So the M4A1's one scope level is state 5 at `ZoomMode1`
 *   2.5x (the M4A1 SD's 3x); `ZoomMode0` (1.5 on every record) is never a magnification -- it is only the look's
 *   divisor in state 4 (`FUN_005be660`).
 * - **Zoom in** (d-pad Up, `FUN_005445b0`, jump table 0x65c360): 0 -> 1; 1 -> 5 when the weapon has two or more
 *   zoom modes, else 4 (night maps: 1 -> 3 first); 3 or 4 -> 5 (two or more modes); s >= 5 -> s + 1 while
 *   `s - 3 < NumZoomModes`. No wrap: the last level stays.
 * - **Zoom out** (d-pad Down, `FUN_00544400`, jump table 0x65c320): 1, 2 -> 0; 3, 4 -> 1; 5 -> 1 (3 at night); s > 5
 *   -> s - 1.
 * - **What drops it**: a second round of a pull while scoped (`FUN_005c5340`: state 1); a weapon switch from the night
 *   vision (`FUN_005c4b10`: 3 -> 1, and only 3); death, a vehicle, a ladder (`FUN_00547af0`, `FUN_005463c0`,
 *   `FUN_00579720`: 0). Not a reload, not a stance change, not moving -- which is cut to 0.2 while scoped.
 * - **The animation** (`FUN_001f1610` / `FUN_001f0750`): the magnification runs linearly to its new value at 3 x the
 *   target a second in (1 -> 2.5 in 0.2 s), and out at 3 x the old one.
 * - **The FOV**: the camera's projection scale is the magnification (`FUN_0029b2f0`: `cam+0x470/+0x474` = zoom x
 *   the aspect's 1.0), so tan(half FOV) divides by it.
 * - **The look** (`FUN_005966a0`): both sticks' look divided by `FUN_005be660` -- `ZoomMode[state - 4]` when that
 *   index exists, else 1 (first person changes nothing) -- and x 0.2 more in state 4.
 */

export type ZoomView = 'third' | 'first' | 'nightvision' | 'binoculars' | 'scope';

/** `FUN_005448a0`'s magnifications: third person, the first-person views, the 9x view. */
export const ZOOM_THIRD = 1.0;
export const ZOOM_FIRST = 1.01;
export const ZOOM_BINOCULARS = 9.0;
/** The zoom's speed: 3 x the target (or the old target, zooming out) a second. */
export const ZOOM_RATE = 3;
/** `DAT_00650638`: the move stick while scoped, and the look's extra factor in state 4. */
export const SCOPE_SLOW = 0.2;

export class Zoom {
  private s = 0;
  private applied = ZOOM_THIRD;
  private rate = 0;

  constructor(private weapon: WeaponRecord, private night = false) {}

  setWeapon(weapon: WeaponRecord): void {
    this.weapon = weapon;
    if (this.s === 3) this.set(1);                // FUN_005c4b10 478813-478833: a switch drops the night vision only
  }

  /** Night maps: first person zooms into the night vision first (`DAT_0045c380 + 0x5dc`). */
  setNight(on: boolean): void { this.night = on; }

  /** The view state (`body+0x200`). */
  state(): number { return this.s; }

  view(): ZoomView {
    if (this.s === 0) return 'third';
    if (this.s === 3) return 'nightvision';
    if (this.s === 4) return 'binoculars';
    if (this.s >= 5) return 'scope';
    return 'first';
  }

  /** First person in any form: the page shows the view from the head. */
  firstPerson(): boolean { return this.s > 0; }

  /** A scope or the 9x view (`FUN_005b9990 || FUN_005b90f0`). */
  scoped(): boolean { return this.s >= 4; }

  private count(): number { return this.weapon.zoomModes.length; }

  /** The magnification the state asks for (`+0x204`). */
  target(): number {
    const s = this.s;
    if (s === 0) return ZOOM_THIRD;
    if (s <= 3) return ZOOM_FIRST;
    if (s === 4) return ZOOM_BINOCULARS;
    return s - 4 < this.count() ? this.weapon.zoomModes[s - 4]! : ZOOM_FIRST;
  }

  /** The magnification on screen now (the linear run toward `target`). */
  magnification(): number { return this.applied; }

  /** d-pad Up (`FUN_005445b0`). Returns the new state. */
  zoomIn(): number {
    const s = this.s, n = this.count();
    let next = s;
    if (s === 0) next = 1;
    else if (s === 1) next = this.night ? 3 : n >= 2 ? 5 : 4;
    else if (s === 3 || s === 4) next = n >= 2 ? 5 : s;
    else if (s >= 5 && s <= 11 && s - 3 < n) next = s + 1;
    this.set(next);
    return this.s;
  }

  /** d-pad Down (`FUN_00544400`). Returns the new state. */
  zoomOut(): number {
    const s = this.s, n = this.count();
    let next = s;
    if (s === 1 || s === 2) next = 0;
    else if (s === 3 || s === 4) next = 1;
    else if (s === 5) next = this.night ? 3 : 1;
    else if (s > 5 && s - 5 < n) next = s - 1;
    this.set(next);
    return this.s;
  }

  /**
   * The mouse's one button (the viewer's convenience, not the game's): zoom in, and from the last level back to the
   * third-person view -- third, first, scope, third ... The pad keeps the game's two directions.
   */
  cycle(): number {
    const before = this.s;
    if (this.zoomIn() === before) this.set(0);
    return this.s;
  }

  /** Straight to a state (`FUN_005448a0`): the drops (1 on a second scoped round, 0 on death). */
  set(state: number): void {
    if (state === this.s) return;
    const old = this.target();
    this.s = state;
    const t = this.target();
    // FUN_001f1610 (in: 3 x the target) / FUN_001f0750 (out: at least 3 x the old target).
    this.rate = t > old ? t * ZOOM_RATE : Math.max(this.rate, old * ZOOM_RATE);
  }

  /** The run toward the target, `dt` seconds. */
  update(dt: number): void {
    const t = this.target();
    if (this.applied < t) this.applied = Math.min(t, this.applied + this.rate * dt);
    else if (this.applied > t) this.applied = Math.max(t, this.applied - this.rate * dt);
  }

  /** Straight to the target, no run (a new map, a test). */
  settle(): void { this.applied = this.target(); }

  /** The vertical FOV in degrees for a base FOV: tan(half) divided by the magnification on screen. */
  fov(baseDegrees: number): number {
    const half = (baseDegrees * Math.PI) / 360;
    return (360 / Math.PI) * Math.atan(Math.tan(half) / this.applied);
  }

  /** The look's scale (`FUN_005966a0`): 1 / `ZoomMode[state - 4]` when that index exists, x 0.2 more in state 4. */
  lookScale(): number {
    const i = this.s - 4;
    const z = i >= 0 && i < this.count() ? this.weapon.zoomModes[i]! : 1;
    return (z !== 0 ? 1 / z : 1) * (this.s === 4 ? SCOPE_SLOW : 1);
  }

  /** The move stick's scale: 0.2 in state 4 and up. */
  moveScale(): number { return this.s >= 4 ? SCOPE_SLOW : 1; }

  reset(): void { this.s = 0; this.applied = ZOOM_THIRD; this.rate = 0; }
}
