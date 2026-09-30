/**
 * The Controls popover's two lists (owner, 2026-09-29: two tabs, Controller and Mouse & Keyboard, only what a player
 * needs): each row the button or key and what it does, grouped, for the mode you are in. Player-facing words only --
 * the sources, the readings and the debug keys live in the developer sections of `web/redotcom/README.md` ("Controls", "Build"), and the pad's full
 * table with its citations stays `./gamepad`'s `PAD_LAYOUT`.
 *
 * The keys are the ones the page binds: `WASD` and the fly keys (`./camera`), `G`, `C`, `Space` (`./walk`), `R`
 * (`./fire`), `B` (`./main`), `X`, `Q`, `E` (`./traversalPage`), `1` to `4` (`./main`, `./kit`), `Tab`, `M`, `F` and the
 * backtick (`./ui`, `./main`); the mouse's click fires and the right click steps the zoom (`./main`, `./fire`). The pad
 * rows follow `PAD_LAYOUT`, with reload on R3 (the motion workstream's binding, 2026-09-29).
 */

export type ControlMode = 'walk' | 'fly';

/** The PlayStation face-button glyphs the design system draws (`.s2u-hint__glyph--*`). */
export type FaceGlyph = 'cross' | 'circle' | 'square' | 'triangle';

/** One line: the key, mouse action or pad button, and what it does; a face button carries its glyph. */
export interface ControlRow { keys: string; does: string; glyph?: FaceGlyph }
export interface ControlGroup { name: string; rows: ControlRow[] }

/** The group names, in the order the popover lists them (`./gamepad`'s `padGroup` uses them too). */
export const GROUP_MOVE = 'Move';
export const GROUP_COMBAT = 'Combat';
export const GROUP_STANCE = 'Stance & action';
export const GROUP_WEAPONS = 'Weapons';
export const GROUP_GENERAL = 'General';

/**
 * The keyboard and mouse for a mode. `toggle` is whether `G` switches walk and fly: only in Play, and only with the
 * developer's `?devmode` (owner, 2026-09-29: the fly camera is not a player's in Play; `./flyAccess`). Without it
 * neither list names `G`. `multiplayer` false (a build with it off, `./multiplayer`) adds `MULTIPLAYER_OFF_ROW` to General.
 */
export function controlGroups(mode: ControlMode, toggle: boolean, multiplayer = true): ControlGroup[] {
  return withMultiplayerNote(keyGroups(mode, toggle), multiplayer);
}

/**
 * The row a build with multiplayer off (`./multiplayer`, `VITE_S2U_MULTIPLAYER=off`) adds to both lists' General group:
 * no key or button joins a match there, and the list says so rather than leave a player looking for one.
 */
export const MULTIPLAYER_OFF_ROW: ControlRow = { keys: 'Multiplayer', does: 'off in this build' };

function withMultiplayerNote(groups: ControlGroup[], multiplayer: boolean): ControlGroup[] {
  if (multiplayer) return groups;
  const general = groups.find((g) => g.name === GROUP_GENERAL);
  if (general) general.rows.push(MULTIPLAYER_OFF_ROW);
  else groups.push({ name: GROUP_GENERAL, rows: [MULTIPLAYER_OFF_ROW] });
  return groups;
}

function keyGroups(mode: ControlMode, toggle: boolean): ControlGroup[] {
  if (mode === 'fly') {
    return [
      {
        name: GROUP_MOVE,
        rows: [
          { keys: 'W A S D', does: 'fly' },
          { keys: 'Mouse / arrows', does: 'look' },
          { keys: 'Space / Shift', does: 'up / down' },
          { keys: 'Double-tap W', does: 'boost (hold)' },
          { keys: 'Wheel', does: 'fly speed' },
        ],
      },
      {
        name: GROUP_GENERAL,
        rows: [
          ...(toggle ? [{ keys: 'G', does: 'walk' }] : []),
          { keys: 'Esc', does: 'release the mouse' },
          { keys: 'F', does: 'fullscreen' },
          { keys: '`', does: 'hide the interface' },
        ],
      },
    ];
  }
  return [
    {
      name: GROUP_MOVE,
      rows: [
        { keys: 'W A S D', does: 'move' },
        { keys: 'Mouse', does: 'look' },
        { keys: 'Space', does: 'jump' },
      ],
    },
    {
      name: GROUP_COMBAT,
      rows: [
        { keys: 'Left click', does: 'fire' },
        { keys: 'Right click', does: 'zoom' },
        { keys: 'R', does: 'reload' },
        { keys: 'B', does: 'fire mode' },
      ],
    },
    {
      name: GROUP_STANCE,
      rows: [
        { keys: 'C', does: 'crouch (tap), prone (hold)' },
        { keys: 'X', does: 'action: doors, climb, ladders' },
        { keys: 'Q / E', does: 'peek left / right (hold)' },
      ],
    },
    {
      name: GROUP_WEAPONS,
      rows: [
        { keys: '1', does: 'main weapon' },
        { keys: '2', does: 'sidearm' },
        { keys: '3 / 4', does: 'grenades and equipment' },
      ],
    },
    {
      name: GROUP_GENERAL,
      rows: [
        { keys: 'Tab (hold)', does: 'scoreboard' },
        { keys: 'M', does: 'map' },
        { keys: 'Esc', does: 'release the mouse' },
        ...(toggle ? [{ keys: 'G', does: 'fly camera' }] : []),
        { keys: 'F', does: 'fullscreen' },
      ],
    },
  ];
}

/**
 * The controller for a mode, by the PS2 pad's names (the Gamepad API's standard layout, by position); Start as `G`.
 * `multiplayer` false (a build with it off) adds `MULTIPLAYER_OFF_ROW`, as `controlGroups` does.
 */
export function padControlGroups(mode: ControlMode, toggle: boolean, multiplayer = true): ControlGroup[] {
  return withMultiplayerNote(padGroups(mode, toggle), multiplayer);
}

function padGroups(mode: ControlMode, toggle: boolean): ControlGroup[] {
  if (mode === 'fly') {
    return [
      {
        name: GROUP_MOVE,
        rows: [
          { keys: 'Left stick', does: 'fly' },
          { keys: 'Right stick', does: 'look' },
          { keys: 'Square', does: 'up', glyph: 'square' },
          { keys: 'Triangle', does: 'down', glyph: 'triangle' },
          { keys: 'Circle', does: 'boost (hold)', glyph: 'circle' },
        ],
      },
      ...(toggle ? [{ name: GROUP_GENERAL, rows: [{ keys: 'Start', does: 'walk' }] }] : []),
    ];
  }
  return [
    {
      name: GROUP_MOVE,
      rows: [
        { keys: 'Left stick', does: 'move' },
        { keys: 'Right stick', does: 'look' },
        { keys: 'Square', does: 'jump', glyph: 'square' },
      ],
    },
    {
      name: GROUP_COMBAT,
      rows: [
        { keys: 'R1', does: 'fire' },
        { keys: 'D-pad Up / Down', does: 'zoom in / out' },
        { keys: 'R3', does: 'reload' },
        { keys: 'L3', does: 'fire mode' },
      ],
    },
    {
      name: GROUP_STANCE,
      rows: [
        { keys: 'Triangle', does: 'crouch (tap), prone (hold)', glyph: 'triangle' },
        { keys: 'Cross', does: 'action: doors, climb, ladders', glyph: 'cross' },
        { keys: 'D-pad Left / Right', does: 'peek left / right (hold)' },
      ],
    },
    {
      name: GROUP_WEAPONS,
      rows: [
        { keys: 'L1', does: 'main weapon' },
        { keys: 'L2', does: 'sidearm' },
        { keys: 'R2', does: 'next item: grenades and equipment' },
      ],
    },
    {
      name: GROUP_GENERAL,
      rows: [
        { keys: 'Select (hold)', does: 'scoreboard' },
        ...(toggle ? [{ keys: 'Start', does: 'fly camera' }] : []),
      ],
    },
  ];
}

/** The popover's two tabs: the controller's list and the keyboard and mouse's. */
export type ControlsTab = 'pad' | 'keys';

/** Where the chosen tab is remembered (`localStorage`, best-effort). */
export const CONTROLS_TAB_KEY = 's2u.viewer.controlsTab';

/** The tab to show: the one the player chose, else the Controller tab when a pad is connected, else Mouse & Keyboard. */
export function chooseTab(stored: string | null, padConnected: boolean): ControlsTab {
  if (stored === 'pad' || stored === 'keys') return stored;
  return padConnected ? 'pad' : 'keys';
}
