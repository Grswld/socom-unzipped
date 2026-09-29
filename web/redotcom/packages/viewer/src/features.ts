/**
 * What the page offers (owner, 2026-09-28; the settings toggle, 2026-09-29). Playing as a SEAL -- walk mode, the body,
 * the rifle, the HUD, the Sound and Mouse look sections, the touch stance and fire buttons -- is the settings' Mode
 * switch's **Play** (Explore / Play, remembered in this browser under `PLAY_KEY`). The address's `mode=play` /
 * `mode=explore` beats the memory, and the old `?redotcom` is read as `mode=play` when no `mode` is given (`./shareUrl`
 * `readShare`, which `./main` reads; `?mode=explore&redotcom` is Explore). On Explore the page is the map viewer alone:
 * `PlayUi` takes the play's markup out after the page is wired and puts it back when Play is chosen, without a reload.
 */

/** Where the settings switch remembers the mode: '1' reCOM, '0' the map viewer. */
export const PLAY_KEY = 's2u.viewer.recom';

/** The remembered choice, best-effort both ways: storage throws in a private window. */
export function readPlayChoice(): string | null {
  try { return globalThis.localStorage?.getItem(PLAY_KEY) ?? null; } catch { return null; }
}
export function writePlayChoice(on: boolean): void {
  try { globalThis.localStorage?.setItem(PLAY_KEY, on ? '1' : '0'); } catch { /* the default next time */ }
}

/** The attribute that marks a piece of the page as the play's: `index.html` carries it, `removePlayUi` reads it. */
export const PLAY_ATTRIBUTE = 'data-play';

/**
 * Takes the play's elements out of the page for good (the tests' way to build the map viewer's page; the page itself
 * uses the reversible `PlayUi`): the Fly / Walk switch, the body switch, the Sound and Mouse look
 * sections and the touch stance and fire buttons -- removed, not hidden. Returns how many.
 */
export function removePlayUi(root: ParentNode = document): number {
  const found = Array.from(root.querySelectorAll(`[${PLAY_ATTRIBUTE}]`));
  for (const el of found) el.remove();
  return found.length;
}

/**
 * The play's elements, taken out and put back as the settings switch turns the play off and on (reversible, so the
 * player's own disc -- a `File` a reload would lose -- stays open). Each element leaves a comment in its place and goes
 * back into it, the same node with its listeners, so what was wired while it was on the page stays wired.
 */
export class PlayUi {
  private readonly held: { el: Element; mark: Comment }[] = [];

  constructor(private readonly root: ParentNode = document) {}

  /** Whether the play's elements are on the page. */
  shown(): boolean {
    return this.held.length === 0;
  }

  /** Takes them out (the map viewer); returns how many. Nothing twice. */
  detach(): number {
    if (this.held.length) return 0;
    const found = Array.from(this.root.querySelectorAll(`[${PLAY_ATTRIBUTE}]`))
      // An element inside another marked one goes with its parent.
      .filter((el) => !el.parentElement?.closest(`[${PLAY_ATTRIBUTE}]`));
    for (const el of found) {
      const mark = el.ownerDocument.createComment(PLAY_ATTRIBUTE);
      el.replaceWith(mark);
      this.held.push({ el, mark });
    }
    return found.length;
  }

  /** Puts them back where they were (reCOM); returns how many. */
  attach(): number {
    const n = this.held.length;
    for (const { el, mark } of this.held.splice(0)) mark.replaceWith(el);
    return n;
  }

  /** On or off, whichever is asked. */
  set(on: boolean): void {
    if (on) this.attach(); else this.detach();
  }
}
