import type { MotionClip } from '@s2u/scene';
import { ActionIconView, type ActionIcons, type ActionShown } from './actionIcon';
import type { Input } from './gamepad';
import type { MotionEntry } from './motionTable';
import { Traversal, type ClimbPrompt, type TraversalEvent, type TraversalKind } from './traversal';
import { groundPolygons, type WalkMode } from './walk';

/**
 * The traversal on the page (web research 86): the moves made for each mover (`WalkMode.useTraversal`), the clips
 * handed to them, the keys, the pad's lanes, the temporary action icon, the events out to the audio, and the hook's
 * view. `main.ts` makes one and calls `frame` each frame.
 *
 * **The bindings** (research 86 section 7). The game's: the action button is **Cross** (`controller.rdr` Default:
 * X -> Action, Square -> Jump), the peek is the **d-pad's left and right, held** (`FUN_00594cf0`, decomp
 * 453431-453457). The keyboard's, here, while walking: **X** the action (the pad's Cross; F is the viewer's
 * fullscreen), **Q** / **E** held the peek left / right (the fly camera's down / up, free on foot). The pad's lanes are
 * the UI workstream's (`./gamepad`): until it maps Cross to an action lane and the d-pad to the lean lanes, the lean
 * reads the existing `leanLeft` / `leanRight` lanes (L2 / R2 in `PAD_LAYOUT`) and the action has no pad button.
 *
 * **The events** go out as `s2u:traversal` `CustomEvent`s on `window`, `detail` the `TraversalEvent`: the audio's hook.
 */

/** The events' name on `window`. */
export const TRAVERSAL_EVENT = 's2u:traversal';

/** What the hook reports (`stats().traversal`, `__viewer.traversal()`). */
export interface TraversalStats {
  kind: TraversalKind;
  ladder: string | null;
  clip: string | null;
  key: number;
  prompt: ClimbPrompt | null;
  peek: number;
  depth: number;
  ladders: number;
  /** The last few events, newest last. */
  events: TraversalEvent[];
}

export class TraversalPage {
  private moves: Traversal | null = null;
  private clips: { clips: MotionClip[]; table: ReadonlyMap<string, MotionEntry> | null } | null = null;
  private readonly icon: ActionIconView | null;
  private readonly held = new Set<string>();
  private padLean: -1 | 0 | 1 = 0;
  /** The hook's lean (`__viewer.setLean`), for the tests. */
  hookLean: -1 | 0 | 1 = 0;
  private readonly recent: TraversalEvent[] = [];

  constructor(private readonly walk: WalkMode, overlayParent: HTMLElement | null) {
    this.icon = overlayParent ? new ActionIconView(overlayParent) : null;
    walk.useTraversal((walker, ground) => {
      const t = new Traversal(walker.grid, groundPolygons(ground));
      if (this.clips) t.setClips(this.clips.clips, this.clips.table);
      t.on((e) => this.emit(e));
      this.moves = t;
      return t;
    });
  }

  /** The play clips as the worker sent them (`PlayData`): the traversal's roots come from them. */
  setClips(data: { clips: MotionClip[]; table: [string, MotionEntry][] | null } | null): void {
    this.clips = data ? { clips: data.clips, table: data.table ? new Map(data.table) : null } : null;
    if (this.clips && this.moves) this.moves.setClips(this.clips.clips, this.clips.table);
  }

  /** A map's action icons (`LoadedMap.actionIcons`). */
  setIcons(icons: ActionIcons | null | undefined): void {
    this.icon?.setIcons(icons);
  }

  /** The traversal on the current mover, or null. */
  traversal(): Traversal | null {
    return this.walk.traversal() === this.moves ? this.moves : null;
  }

  /** The action button, as the keyboard's X or a test presses it; false when not walking. */
  action(): boolean {
    return this.walk.action();
  }

  /** The pad's lanes each frame (`padFrame`): the lean while held. */
  padLanes(input: Input): void {
    this.padLean = input.leanLeft === input.leanRight ? 0 : input.leanLeft ? -1 : 1;
  }

  /** X (the action, on its press), Q and E (the peek, held) on `target`, while walking; modifiers and fields ignored. */
  bindKeys(target: EventTarget = globalThis): void {
    target.addEventListener('keydown', ((e: KeyboardEvent) => {
      if (!['KeyX', 'KeyQ', 'KeyE'].includes(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.walk.mode() !== 'walk') return;
      const el = e.target;
      if (typeof HTMLElement !== 'undefined' && el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return;
      if (e.code === 'KeyX') { if (!e.repeat) this.action(); return; }
      this.held.add(e.code);
    }) as EventListener);
    target.addEventListener('keyup', ((e: KeyboardEvent) => { this.held.delete(e.code); }) as EventListener);
    target.addEventListener('blur', () => this.held.clear());
  }

  /** One frame, before the walk's: the lean from the keys and the pad; after the draw, the icon over `frame`. */
  input(): void {
    const q = this.held.has('KeyQ'), e = this.held.has('KeyE');
    const keys: -1 | 0 | 1 = q === e ? 0 : q ? -1 : 1;
    this.walk.lean(keys !== 0 ? keys : this.padLean !== 0 ? this.padLean : this.hookLean);
  }

  /** The icon: the climb's while one is offered, the ladder slide's on a ladder (research 86 section 3.4). */
  frame(dt: number, frame: { left: number; top: number; width: number; height: number }): void {
    const t = this.traversal();
    let shown: ActionShown = null;
    if (t && this.walk.mode() === 'walk') {
      const prompt = t.climbPrompt();
      if (prompt) shown = { icon: 'climb', prompt };
      else if (t.state().kind === 'ladder') shown = { icon: 'slide' };
    }
    this.icon?.frame(dt, shown, frame);
  }

  stats(): TraversalStats | null {
    const t = this.traversal();
    if (!t || this.walk.mode() !== 'walk') return null;
    const s = t.state();
    return {
      ...s, prompt: t.climbPrompt(), peek: t.peek(), depth: t.depth(), ladders: t.ladders.length, events: [...this.recent],
    };
  }

  private emit(e: TraversalEvent): void {
    this.recent.push(e);
    if (this.recent.length > 16) this.recent.shift();
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent(TRAVERSAL_EVENT, { detail: e }));
  }
}
