import type { MotionClip } from '@s2u/scene';
import type { ActionPrompt, ClimbPrompt as HudClimbPrompt } from './hud';
import type { Input } from './gamepad';
import type { MotionEntry } from './motionTable';
import { rippleAnimation, Traversal, type ClimbPrompt, type Ripple, type TraversalEvent, type TraversalKind } from './traversal';
import type { EffectPlace } from './effects';
import { groundPolygons, type WalkMode } from './walk';

/**
 * The traversal on the page (web research 86): the moves made for each mover (`WalkMode.useTraversal`), the clips
 * handed to them, the keys, the pad's lanes, the HUD's prompts, the sounds the clips do not already carry, the events,
 * and the hook's view. `main.ts` makes one.
 *
 * **The bindings** (research 86 section 7.4): the game's action button is **Cross** (`controller.rdr` Default:
 * X -> Action, Square -> Jump), its peek **the d-pad's left and right, held** (`FUN_00594cf0`, decomp 453431-453457);
 * `./gamepad`'s `action`, `leanLeft` and `leanRight` lanes carry them. The keyboard, walking: **X** the action (taken on
 * its release, as the game takes the pad's; held, the slide from a ladder's head), **Q** / **E** held the peek left /
 * right (the fly camera's down / up, free on foot).
 *
 * **The HUD** (`./hud`): the climb prompt goes to `Hud.feed`'s `climb` (`hudClimb`); on a ladder the action slot shows
 * the ladder slide's icon (`action_slide.tif`, entry 0x10 "LADDER SLIDE") through `Hud.setAction` (`hudFrame`).
 *
 * **The sounds** (research 86 section 7.5): the clips' `zanim_callback`s -- `ladder_rung` (`.STEP_LADDER`), `climb_up`,
 * `pull_up`, `jump_whoosh` -- reach the audio through the animator's own events (`Play.onEvent` -> `WalkSounds`), as
 * the traversal's clips play in the animator; so do the wade's steps and the fall into water (the bed's `UNDERWATER`
 * material's `.STEP_WATER` / `.FALL_WATER`). What no clip carries is sent here: the slide's `~LADDER_SLIDE` loop at
 * its start (`FUN_00344f30`, decomp 461031; the audio plays one pass of it) and the slide's landing (`FUN_005af930`'s
 * landing, at the slide's contact speed).
 *
 * **The events** also go out as `s2u:traversal` `CustomEvent`s on `window`, `detail` the `TraversalEvent`.
 */

/** The events' name on `window`. */
export const TRAVERSAL_EVENT = 's2u:traversal';

/** What the hook reports (`__viewer.traversal()`). */
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

/** The sounds the page lends the traversal: a sound by name, and a landing (`GameAudio.play` / `WalkSounds`). */
export interface TraversalSounds {
  play(name: string, position: [number, number, number]): void;
  land(speed: number, position: [number, number, number]): void;
}

/** The part of `Hud` the ladder's icon needs. */
export interface ActionSlot { setAction(action: ActionPrompt | null, allowed?: boolean): void }

/** The part of `Effects` the water's ripples and splash need. */
export interface TraversalEffects {
  spawn(name: string, place: EffectPlace): { readonly finished: boolean; stop(): void } | null;
  play(name: string, place: EffectPlace): boolean;
}

/** `seal_fall_in_water` (decomp 469892-469896): the splash of a fall into water, once, at the water's point. */
export const FALL_IN_WATER = 'seal_fall_in_water';

/** `~LADDER_SLIDE` (0x65f558): the slide's loop. */
export const LADDER_SLIDE_SOUND = '~LADDER_SLIDE';

export class TraversalPage {
  private moves: Traversal | null = null;
  private clips: { clips: MotionClip[]; table: ReadonlyMap<string, MotionEntry> | null } | null = null;
  private readonly held = new Set<string>();
  private padLean: -1 | 0 | 1 = 0;
  /** The action button held, on the keyboard (X) and on the pad (Cross). */
  private keyHeld = false;
  private padHeld = false;
  /** The hook's lean (`__viewer.setLean`), for the tests. */
  hookLean: -1 | 0 | 1 = 0;
  private readonly recent: TraversalEvent[] = [];
  /** Whether the HUD's action slot holds the ladder slide's icon because of us. */
  private slideShown = false;
  /** The effects the water plays through, and the ripple now running per size (`+0x1370` big, `+0x136c` small). */
  private effects: TraversalEffects | null = null;
  private readonly ripples: Record<Ripple['size'], { handle: { readonly finished: boolean; stop(): void }; name: string; place: EffectPlace } | null> = { big: null, small: null };

  constructor(private readonly walk: WalkMode, private readonly sounds: TraversalSounds | null = null) {
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

  /** The traversal on the current mover, or null. */
  traversal(): Traversal | null {
    return this.walk.traversal() === this.moves ? this.moves : null;
  }

  /** The action button, as the keyboard's X, the pad's Cross or a test presses it; false when not walking. */
  action(): boolean {
    return this.walk.action();
  }

  /**
   * The pad's lanes each frame (`padFrame`): the action held (the slide from a ladder's head reads it held) and taken on
   * its release -- `FUN_00594cf0` (decomp 453194-453225) fires the context action on the button's release edge (state 3),
   * the jump on its press -- and the peek while held.
   */
  padLanes(before: Input, after: Input): void {
    this.padHeld = after.action;
    this.traversal()?.holdAction(this.keyHeld || this.padHeld);
    if (before.action && !after.action && this.walk.mode() === 'walk') this.action();
    this.padLean = after.leanLeft === after.leanRight ? 0 : after.leanLeft ? -1 : 1;
  }

  /** X (the action, on its press), Q and E (the peek, held) on `target`, while walking; modifiers and fields ignored. */
  bindKeys(target: EventTarget = globalThis): void {
    target.addEventListener('keydown', ((e: KeyboardEvent) => {
      if (!['KeyX', 'KeyQ', 'KeyE'].includes(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.walk.mode() !== 'walk') return;
      const el = e.target;
      if (typeof HTMLElement !== 'undefined' && el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return;
      if (e.code === 'KeyX') { this.keyHeld = true; this.traversal()?.holdAction(true); return; }
      this.held.add(e.code);
    }) as EventListener);
    target.addEventListener('keyup', ((e: KeyboardEvent) => {
      this.held.delete(e.code);
      if (e.code !== 'KeyX' || !this.keyHeld) return;
      this.keyHeld = false;
      this.traversal()?.holdAction(this.padHeld);
      if (this.walk.mode() === 'walk') this.action();              // the context action on the release, as the pad's
    }) as EventListener);
    target.addEventListener('blur', () => { this.held.clear(); this.keyHeld = false; this.traversal()?.holdAction(this.padHeld); });
  }

  /** One frame, before the walk's: the peek from the keys, the pad and the hook. */
  input(): void {
    const q = this.held.has('KeyQ'), e = this.held.has('KeyE');
    const keys: -1 | 0 | 1 = q === e ? 0 : q ? -1 : 1;
    this.walk.lean(keys !== 0 ? keys : this.padLean !== 0 ? this.padLean : this.hookLean);
  }

  /** The HUD's climb prompt (`Hud.feed`'s `climb`): the step up and the vault use the low icon, as all use one bitmap. */
  hudClimb(): HudClimbPrompt | null {
    const t = this.traversal();
    const p = t && this.walk.mode() === 'walk' ? t.climbPrompt() : null;
    if (!p) return null;
    return { visible: p.visible, kind: p.kind === 'med' || p.kind === 'high' ? p.kind : 'low' };
  }

  /** The ladder's slot on the HUD: `action_slide.tif` while on a ladder (the slide the action button offers). */
  hudFrame(hud: ActionSlot): void {
    const on = this.walk.mode() === 'walk' && this.traversal()?.state().kind === 'ladder';
    if (on && !this.slideShown) hud.setAction('ladder_slide');
    else if (!on && this.slideShown) hud.setAction(null);
    this.slideShown = on;
  }

  /** The map's effects (`./effects`), for the water's ripples and splash. */
  setEffects(effects: TraversalEffects | null): void {
    this.effects = effects;
    this.ripples.big = null;
    this.ripples.small = null;
  }

  /**
   * One frame of the water's effects (`FUN_005b52b0`, decomp 469810-469920): the ripple the water line asks for,
   * following the SEAL (its place moved each frame); a new one only when there is none or the last has ended, a change
   * of pace waiting for it; the other size's stopped on a switch.
   */
  effectsFrame(): void {
    const fx = this.effects, t = this.traversal();
    const want = t && this.walk.mode() === 'walk' ? t.ripple() : null;
    for (const size of ['big', 'small'] as const) {
      const cur = this.ripples[size];
      if (cur && cur.handle.finished) this.ripples[size] = null;
      if (want && want.size !== size && cur && !cur.handle.finished) { cur.handle.stop(); this.ripples[size] = null; }
    }
    if (!fx || !want) return;
    const cur = this.ripples[want.size];
    if (cur) { cur.place.position = [...want.at]; return; }
    const place: EffectPlace = { position: [...want.at], velocity: [0, 0, 0], normal: [0, 1, 0] };
    const handle = fx.spawn(rippleAnimation(want), place);
    if (handle) this.ripples[want.size] = { handle, name: rippleAnimation(want), place };
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
    const feet = this.walk.drawnFeet();
    if (this.sounds && feet) {
      if (e.type === 'ladderSlide' && e.on) this.sounds.play(LADDER_SLIDE_SOUND, feet);
      else if (e.type === 'ladderSlideLand') this.sounds.land(e.speed, feet);
    }
    if (e.type === 'waterLand') this.effects?.play(FALL_IN_WATER, { position: [...e.at], velocity: [0, 0, 0], normal: [0, 1, 0] });
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent(TRAVERSAL_EVENT, { detail: e }));
  }
}
