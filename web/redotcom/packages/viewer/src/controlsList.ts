/**
 * The Controls popover's two lists (owner, 2026-09-29: two tabs, Controller and Mouse & Keyboard, only what a player
 * needs): each row the button or key and what it does, grouped, for the mode you are in. Player-facing words only --
 * the sources, the readings and the debug keys live in the developer section of `web/README.md`, and the pad's full
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
 * The keyboard and mouse for a mode. `play` is whether reCOM mode is on: without it the fly list is all there is, and
 * it does not say `G` walks.
 */
export function controlGroups(mode: ControlMode, play: boolean): ControlGroup[] {
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
          ...(play ? [{ keys: 'G', does: 'walk' }] : []),
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
        ...(play ? [{ keys: 'G', does: 'fly camera' }] : []),
        { keys: 'F', does: 'fullscreen' },
      ],
    },
  ];
}

/** The controller for a mode, by the PS2 pad's names (the Gamepad API's standard layout, by position). */
export function padControlGroups(mode: ControlMode, play: boolean): ControlGroup[] {
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
      ...(play ? [{ name: GROUP_GENERAL, rows: [{ keys: 'Start', does: 'walk' }] }] : []),
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
        ...(play ? [{ keys: 'Start', does: 'fly camera' }] : []),
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
