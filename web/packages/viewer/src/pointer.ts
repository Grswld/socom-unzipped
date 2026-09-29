/**
 * Pointer capture, guarded. `setPointerCapture` throws a `NotFoundError` ("No active pointer with the given id") when the
 * pointer is no longer active by the time the handler runs -- it was released between the event and the call, the click was
 * turned into a pointer lock, or the event was synthetic -- and an uncaught throw in a `pointerdown` handler fired on every
 * such click. Capture is a convenience (a drag that leaves the element keeps arriving), so a refusal is not an error.
 */

/** The part of an element the guards use. */
export interface Capturable {
  setPointerCapture?(id: number): void;
  releasePointerCapture?(id: number): void;
  hasPointerCapture?(id: number): boolean;
}

/**
 * Captures `id` on `el`. True when it is captured, or when there is no capture to ask for (a browser without it, a test's
 * bare element: the drag goes on without); false, and nothing thrown, when the browser refuses -- the pointer is gone, so no
 * `pointerup` will come for it and the caller must not wait for one.
 */
export function capturePointer(el: Capturable, id: number): boolean {
  try {
    if (typeof el.setPointerCapture !== 'function') return true;
    el.setPointerCapture(id);
    return true;
  } catch {
    return false;
  }
}

/** Lets go of `id` on `el` if it holds it; never throws (a released or unknown pointer is already let go). */
export function releasePointer(el: Capturable, id: number): void {
  try {
    if (typeof el.hasPointerCapture === 'function' && !el.hasPointerCapture(id)) return;
    el.releasePointerCapture?.(id);
  } catch { /* already released */ }
}
