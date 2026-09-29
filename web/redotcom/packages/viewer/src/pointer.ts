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

/** The part of an element `requestLock` uses. */
export interface Lockable {
  requestPointerLock?(options?: { unadjustedMovement?: boolean }): unknown;
}

/**
 * Asks for the pointer lock, raw where the browser offers it, and never lets a refusal escape. Chrome's `requestPointerLock`
 * returns a promise that rejects when the document is not focused, the gesture is spent, or the option is not supported
 * (`unadjustedMovement`), and an older or stricter browser throws at once; the plain request that follows a refusal
 * returns a promise too, whose rejection was left unhandled -- the second uncaught error on a canvas click. Every one of
 * them ends here: a lock that is not granted leaves the drag look, which is what the camera falls back to. Returns whether
 * a request was made.
 */
export function requestLock(el: Lockable): boolean {
  if (typeof el.requestPointerLock !== 'function') return false;
  const swallow = (r: unknown): void => { if (r instanceof Promise) r.catch(() => undefined); };
  const plain = (): void => {
    try { swallow(el.requestPointerLock?.()); } catch { /* the drag look */ }
  };
  try {
    const r = el.requestPointerLock({ unadjustedMovement: true });
    if (r instanceof Promise) r.catch(plain);
  } catch {
    plain();
  }
  return true;
}
