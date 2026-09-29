/**
 * The controller (web sprint 2, W2.7; ruling W2.R5, the owner's word of 2026-09-28): a pad drives the fly camera and
 * the walk with one mapping, the game's own layout, through the one input structure the keys and the touch stick
 * already feed.
 *
 * - **The pad.** The Gamepad API's standard mapping (W3C Gamepad, "Remapping": buttons 0-3 the face buttons bottom,
 *   right, left, top; 4/5 the bumpers; 6/7 the triggers; 8/9 back and start; 10/11 the stick clicks; 12-15 the d-pad;
 *   axes 0/1 the left stick, 2/3 the right, y growing down) read as the PS2 pad the launcher maps it to -- by
 *   position, never by a family's letter (third_party/ps2recomp/ps2xShared/include/launcher/mapping.h:48-50, and its
 *   default table, ps2xShared/src/mapping.cpp:16-25: face down is Cross, face up Triangle, and so on).
 * - **The layout** is data, `PAD_LAYOUT`: each row a control, the action, and the source it rests on -- or `assumed`
 *   where the repository does not say what that button does in SOCOM II. Never an assumption presented as documented.
 * - **The input** is `Input`: the move and look pairs and the actions, which `padInput` reads off a pad through the
 *   table and `mergeInput` merges with the touch stick's. The move pair is the touch stick's own (`./touch`,
 *   `stickVector`), so the camera and the mover take it unchanged.
 * - **The watch** (`PadWatch`) says when a pad comes and goes, from the events and from the poll alike.
 */
import { stickVector } from './touch';

/** The standard mapping's buttons, named as the PS2 pad's (W3C Gamepad standard layout, by position). */
export const PAD_BUTTON = {
  Cross: 0, Circle: 1, Square: 2, Triangle: 3, L1: 4, R1: 5, L2: 6, R2: 7,
  Select: 8, Start: 9, L3: 10, R3: 11, Up: 12, Down: 13, Left: 14, Right: 15,
} as const;
export type PadButton = keyof typeof PAD_BUTTON;

/** The standard mapping's sticks: the axis pair of each, x then y, y growing down (W3C Gamepad standard layout). */
export const PAD_STICK = { 'L-stick': [0, 1], 'R-stick': [2, 3] } as const;
export type PadStick = keyof typeof PAD_STICK;

/**
 * The stick dead zone, radial: a push shorter than this reads as nothing, and past it the length is rescaled so the
 * zone's edge is 0 and the rim 1 (`./touch`, `stickVector`). 0.15 is the launcher's default (`padDeadZone`,
 * ps2xShared/include/launcher/launcher_config.h:165) and the runtime's since 2026-09-16
 * (ps2xRuntime/include/runtime/host_gamepad_select.h:39-47). The runtime applies it per axis (`hostPadAxis`, :70-79);
 * radial here, so a diagonal is not pulled onto the axes.
 */
export const PAD_DEAD_ZONE = 0.15;

/**
 * An analogue button past this value counts as down when the browser does not say `pressed` itself. `pressed` is the
 * standard's own word and wins; the value is for a pad, or a test's fake, that reports only the value.
 */
export const PAD_PRESS = 0.5;

/** The actions that are on or off: each is one or more buttons. */
export type PadFlag = 'jump' | 'crouch' | 'stance' | 'boost' | 'fire' | 'aim' | 'zoom' | 'action' | 'leanLeft' | 'leanRight' | 'mode';
export const PAD_FLAGS: readonly PadFlag[] = ['jump', 'crouch', 'stance', 'boost', 'fire', 'aim', 'zoom', 'action', 'leanLeft', 'leanRight', 'mode'];
export type PadAction = 'move' | 'look' | PadFlag;

/**
 * What the pad, the keys' lanes and the touch stick ask for in one frame. The pairs are in the unit disc: `moveX`
 * right and `moveY` forward, the touch stick's frame (`./touch`, `stickVector`); `lookX` right and `lookY` up. The
 * actions mean the same button in both modes (W2.R5): `jump` is a jump on foot and up in the fly camera, `crouch` a
 * crouch on foot and down; `mode` is the walk/fly switch `G` is. `stance` is the game's stance button (Triangle): a tap
 * and a hold mean different things on foot (`./play`, `StanceButton`), and it is down in the fly camera like `crouch`.
 * `boost` is the fly camera's alone: the walk has no sprint. `zoom` is the scope (d-pad Up), the walk's alone: one press
 * a step (`pressedSince`). `action` is the game's Action button (Cross: the climb, the ladder's slide) and `leanLeft` /
 * `leanRight` its peek (the d-pad's left and right, held), the walk's alone (web research 86 section 7.4).
 */
export interface Input {
  moveX: number; moveY: number;
  lookX: number; lookY: number;
  jump: boolean; crouch: boolean; stance: boolean; boost: boolean; fire: boolean; aim: boolean; zoom: boolean;
  action: boolean; leanLeft: boolean; leanRight: boolean; mode: boolean;
}

/** The input at rest: every axis 0, every action off. */
export function noInput(): Input {
  return {
    moveX: 0, moveY: 0, lookX: 0, lookY: 0,
    jump: false, crouch: false, stance: false, boost: false, fire: false, aim: false, zoom: false, action: false, leanLeft: false, leanRight: false, mode: false,
  };
}

/**
 * One row of the layout: a stick and the pair it drives, or a button and the action it holds. `documented` is the
 * file and section the binding rests on, or `'assumed'` where the repository does not say what the control does in
 * SOCOM II; `note` says why, and names the game's own meaning where the repository gives one that differs.
 */
export type PadRow = { documented: string; note: string } & (
  | { control: PadStick; action: 'move' | 'look' }
  | { control: PadButton; action: PadFlag });

// The sources, as the table cites them (relative to the repository's root).
const MAPPING_H = 'third_party/ps2recomp/ps2xShared/include/launcher/mapping.h';
const HOST_INPUT = 'third_party/ps2recomp/ps2xRuntime/src/lib/socom2_host_input.cpp';
const CROUCH_H = 'third_party/ps2recomp/ps2xRuntime/include/runtime/host_crouch_shortcut.h';
const LAUNCHER = 'third_party/ps2recomp/ps2xShared/src/launcher_config.cpp';
const STICKS = `${MAPPING_H}:25-27; ${HOST_INPUT}:297, :336`;
/** A binding the owner stated in words (the play-test of walk mode), not one the repository documents on its own. */
export const OWNER = 'owner, 2026-09-28';

/**
 * SOCOM II's layout as the owner gave it on 2026-09-28 (Square jumps, R1 fires, Triangle is the stance, L1 aims, Start
 * is the walk/fly switch, d-pad Up zooms, the left stick moves and the right looks), with what the repository documents beside it
 * where it does, and the viewer's own bindings marked `assumed`. Cross is the action and the d-pad's left and right the
 * peek (web research 86, from the game's own `controller.rdr` and pad read). Circle, Select and d-pad Down are left free.
 */
export const PAD_LAYOUT: readonly PadRow[] = [
  {
    control: 'L-stick', action: 'move', documented: STICKS,
    note: 'the game reads the two sticks as movement and aim (mapping.h), and WASD is the left stick '
      + '(socom2_host_input.cpp:336)',
  },
  {
    control: 'R-stick', action: 'look', documented: STICKS,
    note: 'the other stick, the aim: IJKL on the keyboard (socom2_host_input.cpp:336); the look turns at the arrow '
      + 'keys\' rate',
  },
  {
    control: 'Square', action: 'jump', documented: `${OWNER}; docs/KNOWN.md (R139 row)`,
    note: 'jump on foot and up in the fly camera. The owner\'s word, and the disc\'s control dictionary agrees '
      + '(KNOWN.md R139: "X is Action, Square is Jump, Circle is TeamCommand")',
  },
  {
    control: 'R1', action: 'fire', documented: OWNER,
    note: 'held, the rifle fires at its rate; let go, it stops -- the mouse button\'s trigger. The owner\'s word '
      + '(socom2_host_input.cpp:297 puts fire among the shoulder buttons without saying which)',
  },
  {
    control: 'Triangle', action: 'stance', documented: `${OWNER}; ${CROUCH_H}:4-7; docs/INSTALL.md §6`,
    note: 'the stance button. Tap: stand and crouch toggle; hold: prone; from prone a tap stands. The game reads '
      + 'Triangle\'s pressure (a light press toggles crouch at release, a full one goes prone: PlayerUpd, '
      + 'FUN_00594cf0), and a browser pad\'s button is on or off, so a hold stands in for the full press; the hold\'s '
      + 'length is a guess (`STANCE_HOLD_S_PLACEHOLDER`, ./play). Down in the fly camera',
  },
  {
    control: 'L1', action: 'aim', documented: OWNER,
    note: 'held on foot, the first-person aim view (W2.6). The owner\'s word (socom2_host_input.cpp:297 puts aim '
      + 'among the shoulder buttons without saying which)',
  },
  {
    control: 'Up', action: 'zoom', documented: OWNER,
    note: 'the scope: each press steps the zoom, on foot only. The owner\'s word (2026-09-28), like the right mouse '
      + 'button\'s; the repository does not say what the game\'s d-pad does',
  },
  {
    control: 'Start', action: 'mode', documented: OWNER,
    note: 'the viewer\'s walk/fly switch, as G is. The owner\'s word; in the game START is the pause and the menus '
      + '(socom2_host_input.cpp:294-296), the one button that takes a player out of play, as the fly camera is out of it',
  },
  {
    control: 'L3', action: 'crouch', documented: `docs/INSTALL.md §6; docs/PLAYTEST.md step 8; ${LAUNCHER}:568`,
    note: 'the launcher\'s default crouch shortcut, L-STICK CLICK; the game\'s own L3 is fire mode, which the '
      + 'shortcut moves to the keyboard\'s 2 key. In the game it toggles stand/crouch on release (PLAYTEST step 8); '
      + 'never prone. Down in the fly camera',
  },
  {
    control: 'Cross', action: 'action', documented: 'web/docs/research/86-traversal.md §3.4; docs/KNOWN.md (R139 row)',
    note: 'the action on foot: climbs what the climb icon offers (in the air too, after a jump), slides down a ladder. '
      + 'The game\'s own: controller.rdr\'s Default maps X to Action (FUN_00594cf0 -> FUN_00592d50, decomp 452182)',
  },
  {
    control: 'Left', action: 'leanLeft', documented: 'web/docs/research/86-traversal.md §4.1',
    note: 'held, the peek left on foot, standing still: FUN_00594cf0 (decomp 453431-453457) reads the d-pad\'s left as '
      + 'the peek, held, not toggled',
  },
  {
    control: 'Right', action: 'leanRight', documented: 'web/docs/research/86-traversal.md §4.1',
    note: 'held, the peek right on foot, standing still (the same read, the d-pad\'s right)',
  },
  {
    control: 'R3', action: 'boost', documented: 'assumed',
    note: 'the fly camera\'s boost, as a double-tapped W or the touch stick held at its rim, not a game control; what '
      + 'R3 does in SOCOM II the repository does not say. There is no sprint on foot (the owner, 2026-09-28)',
  },
];

/**
 * What each action is called on the panel, on foot and in the fly camera: one button, the same motion in both where
 * there is one. `null` is an action the mode does not have -- fire and aim are the walk's alone, the boost the fly
 * camera's alone (no sprint on foot), the action and the peek the walk's -- and the panel leaves that row out of that mode's table.
 */
export const ACTION_WORDS: Record<PadAction, { walk: string | null; fly: string | null }> = {
  move: { walk: 'move', fly: 'fly along the look' },
  look: { walk: 'look', fly: 'look' },
  jump: { walk: 'jump', fly: 'up' },
  crouch: { walk: 'crouch (tap toggles)', fly: 'down' },
  stance: { walk: 'stance: tap crouch, hold prone', fly: 'down' },
  boost: { walk: null, fly: 'boost' },
  fire: { walk: 'fire (held)', fly: null },
  aim: { walk: 'aim (held)', fly: null },
  zoom: { walk: 'zoom (scope)', fly: null },
  action: { walk: 'action (climb, ladder slide)', fly: null },
  leanLeft: { walk: 'peek left (held)', fly: null },
  leanRight: { walk: 'peek right (held)', fly: null },
  mode: { walk: 'fly (as G)', fly: 'walk (as G)' },
};

/** A citation with each path cut to its file's name, for the panel: `docs/INSTALL.md §6` is `INSTALL.md §6`. */
export function shortSource(documented: string): string {
  return documented.replace(/(?:[\w.-]+\/)+([\w.-]+)/g, '$1');
}

/** What `padInput` reads: the part of a `Gamepad` the mapping needs. A real `Gamepad` is one. */
export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
}

/** An axis, centred when the pad does not have it or reports something that is not a number. */
function axis(pad: GamepadLike, index: number): number {
  const v = pad.axes[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function down(button: { readonly pressed: boolean; readonly value: number } | undefined): boolean {
  return button !== undefined && (button.pressed || button.value >= PAD_PRESS);
}

/**
 * The pad's input through a layout: pure, so it is pinned on a synthetic pad (`test/gamepad.test.ts`). A stick goes
 * through the touch stick's own shaping (`stickVector` with a radius of 1: the dead zone, the rescale, the clamp to the
 * rim) with its y flipped, so up the stick is forward and up; a button holds its action. `null` is the rest input.
 */
export function padInput(pad: GamepadLike | null | undefined, layout: readonly PadRow[] = PAD_LAYOUT): Input {
  const out = noInput();
  if (!pad) return out;
  for (const row of layout) {
    if (row.action === 'move' || row.action === 'look') {
      const [ax, ay] = PAD_STICK[row.control as PadStick];
      const v = stickVector(axis(pad, ax), axis(pad, ay), 1, PAD_DEAD_ZONE);
      // `+ 0` turns stickVector's -0 (a y of 0 flipped) into 0.
      if (row.action === 'move') { out.moveX = v.x + 0; out.moveY = v.y + 0; }
      else { out.lookX = v.x + 0; out.lookY = v.y + 0; }
    } else if (down(pad.buttons[PAD_BUTTON[row.control as PadButton]])) {
      out[row.action] = true;
    }
  }
  return out;
}

/** The larger of two magnitudes, with its sign; the first on a tie. */
export function strongest(a: number, b: number): number {
  return Math.abs(b) > Math.abs(a) ? b : a;
}

/**
 * Several sources' input as one: on each axis the largest magnitude wins, and the actions OR together. The touch stick
 * and a pad pushed at once are not added into a push past the rim; a button held on either is held.
 */
export function mergeInput(...inputs: readonly Input[]): Input {
  const out = noInput();
  for (const i of inputs) {
    out.moveX = strongest(out.moveX, i.moveX);
    out.moveY = strongest(out.moveY, i.moveY);
    out.lookX = strongest(out.lookX, i.lookX);
    out.lookY = strongest(out.lookY, i.lookY);
    for (const f of PAD_FLAGS) out[f] ||= i[f];
  }
  return out;
}

/** The actions that went down between two frames: `mode` toggles on its press, as `G` does on its keydown. */
export function pressedSince(before: Input, after: Input): PadFlag[] {
  return PAD_FLAGS.filter((f) => after[f] && !before[f]);
}

/**
 * The actions that came up between two frames. The game's crouch acts on the release (docs/PLAYTEST.md step 8, and
 * host_crouch_shortcut.h:5-6: "acted on at release"), so a crouch that toggles reads this, not `pressedSince`.
 */
export function releasedSince(before: Input, after: Input): PadFlag[] {
  return PAD_FLAGS.filter((f) => before[f] && !after[f]);
}

/** A pad as `navigator.getGamepads()` lists it: the mapping's part and its identity. */
export interface PadLike extends GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  /** `'standard'` when the browser has put the pad's controls where the standard layout says. */
  readonly mapping: string;
}

/** What the page polls: `navigator`. `getGamepads` is absent in a browser without the API. */
export interface PadSource {
  getGamepads?(): ArrayLike<PadLike | null>;
}

/**
 * Which pads are connected, from the `gamepadconnected`/`gamepaddisconnected` events and from the poll alike, each
 * change said once. Chrome exposes no pad until one of its buttons is pressed and then fires the event; a pad already
 * exposed when the page loads is found by the poll. A pad that vanishes from the poll without its event (Firefox keeps
 * it listed with `connected` false) is lost there too.
 */
export class PadWatch {
  /** The connected pads' ids, by their index in `getGamepads()`. */
  private readonly known = new Map<number, string>();

  constructor(private readonly on: { connected(id: string): void; disconnected(id: string): void }) {}

  /** Listens for the two events on `target` (the window). An event that carries no pad is left to the poll. */
  attach(target: EventTarget): void {
    target.addEventListener('gamepadconnected', (e) => {
      const pad = (e as Partial<GamepadEvent>).gamepad as PadLike | undefined;
      if (pad) this.saw(pad);
    });
    target.addEventListener('gamepaddisconnected', (e) => {
      const pad = (e as Partial<GamepadEvent>).gamepad as PadLike | undefined;
      if (pad) this.lost(pad.index);
    });
  }

  /**
   * One frame's poll: reconciles the pads with what the source lists and returns the one to read -- the first with
   * the standard mapping, whose indices the layout is written in, else the first connected. With no `getGamepads`,
   * or one that throws (a permissions policy), nothing is read and nothing the events said is dropped.
   */
  poll(source: PadSource): PadLike | null {
    let pads: ArrayLike<PadLike | null>;
    try {
      if (typeof source.getGamepads !== 'function') return null;
      pads = source.getGamepads() ?? [];
    } catch {
      return null;
    }
    const present = new Set<number>();
    let chosen: PadLike | null = null;
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (!pad || !pad.connected) continue;
      present.add(pad.index);
      this.saw(pad);
      if (!chosen || (chosen.mapping !== 'standard' && pad.mapping === 'standard')) chosen = pad;
    }
    for (const index of [...this.known.keys()]) if (!present.has(index)) this.lost(index);
    return chosen;
  }

  /** How many pads are connected. */
  count(): number {
    return this.known.size;
  }

  /** The first connected pad's id, or null. */
  id(): string | null {
    for (const id of this.known.values()) return id;
    return null;
  }

  private saw(pad: PadLike): void {
    const was = this.known.get(pad.index);
    if (was === pad.id) return;
    if (was !== undefined) this.lost(pad.index);        // another pad in the same slot: the first has gone
    this.known.set(pad.index, pad.id);
    this.on.connected(pad.id);
  }

  private lost(index: number): void {
    const was = this.known.get(index);
    if (was === undefined) return;
    this.known.delete(index);
    this.on.disconnected(was);
  }
}
