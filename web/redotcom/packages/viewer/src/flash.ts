import { BLIND_KEYS, blindStrength } from '@s2u/scene';

/**
 * The flashbang's white-out on the screen (web/redotcom/docs/research/85 §9.5): the map's `MZANIM.ZAR` animation
 * `blindplayer0<level>` the player controller starts (0x597c00) for a Mark141 inside 150 units -- level 3 facing it
 * close, 2 half-turned or further, 1 facing away or far (`@s2u/scene`'s `flashLevel`). Its `blinded` command holds the
 * screen white at a strength (60, or 25 for level 1) for 1.5 s / 8 s and brings it back by 4 s / 10 s (2 s for level
 * 1: `BLIND_KEYS`); its `fadein` takes 0.2 s to reach it.
 *
 * [reading] The strength's scale is not decoded: 60 is drawn as a full white-out and 25 as 25/60 of one; the command's
 * grey (0.75, 0.9) is taken as the white's tint. A DOM layer over the canvas, above the HUD, as the console's filter is
 * over the whole frame.
 */

/** The `fadein` sequence's rise, seconds (its first key, 0.2). */
export const BLIND_FADE_IN = 0.2;
/** The strength drawn as a full white-out [reading]. */
export const BLIND_FULL = 60;

/** The white-out's opacity `t` seconds into a level (0 once it is over). */
export function whiteOut(level: 1 | 2 | 3, t: number): number {
  if (t < 0) return 0;
  const rise = Math.min(1, t / BLIND_FADE_IN);
  return Math.min(1, blindStrength(level, t) / BLIND_FULL) * rise;
}

export interface WhiteOutState { level: 1 | 2 | 3 | null; t: number; opacity: number; length: number }

export class WhiteOut {
  private level: 1 | 2 | 3 | null = null;
  private t = 0;
  private readonly el: HTMLDivElement | null;

  constructor(parent: HTMLElement | null) {
    this.el = parent ? document.createElement('div') : null;
    if (this.el && parent) {
      // Drawn by the page's stylesheet (`styles.css` `#whiteout`); only its opacity is written here, frame by frame.
      this.el.id = 'whiteout';
      this.el.setAttribute('aria-hidden', 'true');
      this.el.style.opacity = '0';
      parent.appendChild(this.el);
    }
  }

  /** A flash: the stronger of the running level and the new one takes over, from its start. */
  start(level: 1 | 2 | 3): void {
    if (this.level !== null && this.level > level && this.opacity() > 0) return;
    this.level = level;
    this.t = 0;
  }

  stop(): void {
    this.level = null;
    this.draw();
  }

  update(dt: number): void {
    if (this.level === null) return;
    this.t += dt;
    if (this.t > BLIND_KEYS[this.level].at(-1)!.t) this.level = null;
    this.draw();
  }

  opacity(): number {
    return this.level === null ? 0 : whiteOut(this.level, this.t);
  }

  state(): WhiteOutState {
    return { level: this.level, t: this.t, opacity: this.opacity(), length: this.level ? BLIND_KEYS[this.level].at(-1)!.t : 0 };
  }

  private draw(): void {
    if (this.el) this.el.style.opacity = String(this.opacity());
  }
}
