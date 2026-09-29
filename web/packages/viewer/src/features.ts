/**
 * What the page offers, by its URL (owner, 2026-09-28). Playing as a SEAL -- walk mode, the body, the rifle, the
 * touch stance and fire buttons -- is behind a URL parameter, `PLAY_PARAM`: without it the page is the map viewer
 * alone, and none of the play is rendered, bound or answered. Its presence is enough (`?redotcom`, `?redotcom=1`,
 * `?map=MP2&redotcom`); its value is never read.
 */

/** The URL parameter that turns the play on. */
export const PLAY_PARAM = 'redotcom';

/** Whether the play is on for a URL's query string (`location.search`, with or without its leading `?`). */
export function playEnabled(search: string): boolean {
  try {
    return new URLSearchParams(search).has(PLAY_PARAM);
  } catch {
    return false;
  }
}

/** The attribute that marks a piece of the page as the play's: `index.html` carries it, `removePlayUi` reads it. */
export const PLAY_ATTRIBUTE = 'data-play';

/**
 * Takes the play's elements out of the page when it is off, before anything is wired to them: the Fly / Walk switch,
 * the body switch, the ammo box and the touch stance and fire buttons -- removed, not hidden. Returns how many.
 */
export function removePlayUi(root: ParentNode = document): number {
  const found = Array.from(root.querySelectorAll(`[${PLAY_ATTRIBUTE}]`));
  for (const el of found) el.remove();
  return found.length;
}
