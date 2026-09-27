/**
 * Moving on a touch screen.
 *
 * A one-finger drag already looks around, which is the half of it the canvas gives for free; what a
 * phone has no way to do is *move*. So the left half of the screen becomes a virtual stick -- a circle
 * that appears wherever the thumb lands and follows it -- and two buttons in the bottom-right corner
 * do what Q and E do. The right half is left alone, so looking still works while the stick is held.
 *
 * Deliberately small. No sprint, no tuning, no gestures: the stick feeds an axis pair into the same
 * velocity model the keys drive (`./camera`), and the ramp and the glide come out of that for free.
 */
import type { FlyCamera } from './camera';

/** How far from the centre counts as nothing, as a fraction of the base's radius. */
export const DEAD_ZONE = 0.15;

/** The stick's travel in CSS pixels: past this it is fully pushed. */
const RADIUS = 52;
/** How far a push counts as the rim, and how long it has to stay there to mean a boost. */
export const RIM = 0.97;
export const RIM_HOLD_MS = 400;

/**
 * The boost gesture on a phone: the thumb pushed to the stick's rim and held there. A moment at the
 * rim is ordinary steering; holding it is the ask. There is no second control for it, because a
 * second control is the thing a thumb cannot reach while it is on the stick.
 */
export function boostFromRim(pushed: number, heldMs: number): boolean {
  return pushed >= RIM && heldMs >= RIM_HOLD_MS;
}

/**
 * Where the stick is pushed, as an axis pair in the unit disc.
 *
 * `dx`/`dy` are the thumb's offset from where it landed, in CSS pixels, with `dy` positive *down* the
 * screen the way a pointer event gives it. What comes back is `x` right and `y` **forward**, so the
 * sign of `dy` flips: pushing the stick up the screen moves the camera the way it is looking.
 *
 * Two shaping rules, both there to stop the stick feeling wrong rather than to be clever:
 *
 * - **Dead zone.** A thumb resting on the glass wanders a few pixels, and without a dead zone the
 *   camera creeps whenever a finger is down. Inside it the answer is exactly zero.
 * - **Rescaled past it.** The magnitude is remapped so that the dead-zone edge is 0 and the rim is 1,
 *   rather than jumping straight to `DEAD_ZONE` the moment the zone is left. Direction is untouched.
 *
 * The magnitude is clamped to 1, so a thumb dragged off the base is fully pushed rather than faster
 * than fully pushed -- `camera.update` clamps too, but a vector that means what it says is easier to
 * reason about than one that relies on being clamped later.
 */
export function stickVector(dx: number, dy: number, radius = RADIUS, deadZone = DEAD_ZONE): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };
  const pushed = Math.min(distance / radius, 1);
  if (pushed <= deadZone) return { x: 0, y: 0 };
  const scale = ((pushed - deadZone) / (1 - deadZone)) / distance;
  return { x: dx * scale, y: -dy * scale };
}

/** Where the knob is drawn, in pixels from the base's centre: the raw offset, clamped to the rim. */
export function knobOffset(dx: number, dy: number, radius = RADIUS): { x: number; y: number } {
  const distance = Math.hypot(dx, dy);
  if (distance <= radius) return { x: dx, y: dy };
  return { x: (dx / distance) * radius, y: (dy / distance) * radius };
}

/**
 * Is this a device that wants them? A coarse pointer says so up front, and a touch event says so for
 * the hybrids a media query gets wrong -- a laptop with a touch screen reports a fine pointer and can
 * still be poked. Either one shows the controls, and once shown they stay.
 */
export function wantsTouchControls(): boolean {
  try {
    return globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  } catch {
    return false;
  }
}

/** Wires the stick and the two buttons to a camera. Returns nothing: there is nothing to take back. */
export function attachTouchControls(camera: FlyCamera): void {
  const zone = document.getElementById('stick-zone');
  const base = document.getElementById('stick-base');
  const knob = document.getElementById('stick-knob');
  const up = document.getElementById('touch-up');
  const down = document.getElementById('touch-down');
  if (!zone || !base || !knob || !up || !down) return;

  const show = (): void => document.body.classList.add('touch');
  if (wantsTouchControls()) show();
  // A hybrid device only gives itself away by being touched. Once, then the listener is done.
  globalThis.addEventListener('touchstart', show, { once: true, passive: true });

  let held: number | null = null;
  let originX = 0;
  let originY = 0;
  /** The timer that turns a held rim into a boost, or null while the stick is short of it. */
  let rimTimer: ReturnType<typeof setTimeout> | null = null;
  const leaveRim = (): void => {
    if (rimTimer !== null) clearTimeout(rimTimer);
    rimTimer = null;
    camera.setStickBoost(false);
  };

  zone.addEventListener('pointerdown', (e) => {
    if (held !== null) return;
    held = e.pointerId;
    originX = e.clientX;
    originY = e.clientY;
    // The base is placed where the thumb landed rather than sitting in a fixed corner: a thumb reaches
    // where it reaches, and a stick that starts under it never has to be found first.
    base.style.left = `${e.clientX}px`;
    base.style.top = `${e.clientY}px`;
    base.hidden = false;
    knob.style.transform = 'translate(-50%, -50%)';
    zone.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  zone.addEventListener('pointermove', (e) => {
    if (held !== e.pointerId) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    const v = stickVector(dx, dy);
    camera.setStick(v.x, v.y);
    // A thumb held still at the rim sends no more events, so the hold is a timer rather than a poll.
    const pushed = Math.min(Math.hypot(dx, dy) / RADIUS, 1);
    if (boostFromRim(pushed, RIM_HOLD_MS)) {
      if (rimTimer === null) rimTimer = setTimeout(() => camera.setStickBoost(true), RIM_HOLD_MS);
    } else {
      leaveRim();
    }
    const at = knobOffset(dx, dy);
    knob.style.transform = `translate(calc(-50% + ${at.x}px), calc(-50% + ${at.y}px))`;
    e.preventDefault();
  });

  const release = (e: PointerEvent): void => {
    if (held !== e.pointerId) return;
    held = null;
    camera.setStick(0, 0);
    leaveRim();
    base.hidden = true;
    if (zone.hasPointerCapture(e.pointerId)) zone.releasePointerCapture(e.pointerId);
  };
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);

  for (const [button, direction] of [[up, 1], [down, -1]] as [HTMLElement, number][]) {
    button.addEventListener('pointerdown', (e) => {
      camera.setLift(direction);
      button.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    // Up, cancelled, or the finger slid off the button: all of them mean stop.
    for (const event of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      button.addEventListener(event, () => camera.setLift(0));
    }
  }
}
