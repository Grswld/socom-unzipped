/**
 * The phone's tip (owner, 2026-09-29): on a touch device, a line recommending a controller and the phone held sideways.
 * Shown once a visit, and again whenever the phone is turned to portrait; its close button dismisses it for good, which
 * is remembered in this browser (`localStorage`). A visit is the tab's session (`sessionStorage`). Both stores are
 * best-effort: a private window or blocked site data leaves the rule to this page's memory alone.
 */

/** A key-value store that may throw, as the browser's storages do; `storeOf` guards one. */
export interface TipStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Dismissed for good: `localStorage`. */
export const TIP_DISMISSED_KEY = 's2u.viewer.mobileTipDismissed';
/** Shown this visit: `sessionStorage`. */
export const TIP_SEEN_KEY = 's2u.viewer.mobileTipSeen';

/** A browser storage behind a guard: a throw on access reads as nothing there, and a write that throws is dropped. */
export function storeOf(storage: () => Storage): TipStore {
  return {
    get: (key) => { try { return storage().getItem(key); } catch { return null; } },
    set: (key, value) => { try { storage().setItem(key, value); } catch { /* the page's memory keeps it */ } },
  };
}

/** What the tip says: a controller and landscape, or landscape alone when a pad is already connected. */
export function tipText(padConnected: boolean): string {
  return padConnected
    ? 'Turn your phone sideways (landscape) to play.'
    : 'Best with a controller: connect one to your phone, and hold it sideways (landscape).';
}

/** The tip's rule: when to show it. The page shows and hides it (`Ui.showTip`). */
export class MobileTip {
  private touch = false;
  private portrait = false;
  /** The page's own memory, for a storage that refuses. */
  private dismissedHere = false;
  private seenHere = false;

  constructor(private readonly local: TipStore, private readonly session: TipStore) {}

  private dismissed(): boolean {
    return this.dismissedHere || this.read(this.local, TIP_DISMISSED_KEY) === '1';
  }

  private read(store: TipStore, key: string): string | null {
    try { return store.get(key); } catch { return null; }
  }

  private write(store: TipStore, key: string): void {
    try { store.set(key, '1'); } catch { /* the page's memory keeps it */ }
  }

  /** At the page's start: whether to show it -- on a touch device, not dismissed, not yet shown this visit. */
  start(touch: boolean, portrait: boolean): boolean {
    this.touch = touch;
    this.portrait = portrait;
    if (!touch || this.dismissed()) return false;
    if (this.seenHere || this.read(this.session, TIP_SEEN_KEY) === '1') return false;
    this.seenHere = true;
    this.write(this.session, TIP_SEEN_KEY);
    return true;
  }

  /** The phone turned: whether to show it again -- a turn into portrait, on a touch device, not dismissed. */
  rotate(portrait: boolean): boolean {
    const turned = portrait && !this.portrait;
    this.portrait = portrait;
    return this.touch && turned && !this.dismissed();
  }

  /** The player closed it: gone for good. */
  dismiss(): void {
    this.dismissedHere = true;
    this.write(this.local, TIP_DISMISSED_KEY);
  }
}
