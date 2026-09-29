/**
 * The keyboard and mouse controls the Controls popover lists (owner, 2026-09-28; round 2), grouped, for the mode you
 * are in and no other. Data, so the page's list and its test read one table. The pad's layout is `./gamepad`'s
 * `PAD_LAYOUT`, grouped by `padGroup` under the same names.
 *
 * The keys are the ones the page binds: `WASD` and the fly keys (`./camera`), `G`, `C`, `V`, `Space` (`./walk`), `R`
 * (`./fire`), `B` (`./main`), `X`, `Q`, `E` (`./traversalPage`), `1` to `4` (`./main`, `./kit`'s `hotkey`), `F` and the backtick
 * (`./ui`); the mouse's click fires and the right click steps the zoom (`./main`, `./fire`).
 */

export type ControlMode = 'walk' | 'fly';

/** One line: the keys or the mouse action, and what it does. */
export interface ControlRow { keys: string; does: string }
export interface ControlGroup { name: string; rows: ControlRow[] }

/** The group names, in the order the popover lists them, for both the keys and the pad. */
export const GROUP_MOVE = 'Move';
export const GROUP_COMBAT = 'Combat';
export const GROUP_STANCE = 'Stance & traversal';
export const GROUP_WEAPONS = 'Weapons';
export const GROUP_GENERAL = 'General';

/**
 * The keyboard and mouse for a mode. `play` is whether walking exists on the page (`?redotcom`): without it the fly
 * list is all there is, and it does not say `G` walks.
 */
export function controlGroups(mode: ControlMode, play: boolean): ControlGroup[] {
  const general: ControlRow[] = [
    ...(play ? [{ keys: 'G', does: mode === 'walk' ? 'fly' : 'walk' }] : []),
    { keys: 'F', does: 'fullscreen' },
    { keys: '`', does: 'hide the panel, for a clean look' },
  ];
  if (mode === 'fly') {
    return [
      {
        name: GROUP_MOVE,
        rows: [
          { keys: 'W A S D', does: 'fly along the look' },
          { keys: 'Space / Shift', does: 'up / down (Q / E too)' },
          { keys: 'double-tap W', does: 'boost, held' },
          { keys: 'wheel', does: 'fly speed' },
          { keys: 'mouse / arrows', does: 'look' },
        ],
      },
      { name: GROUP_GENERAL, rows: general },
    ];
  }
  return [
    {
      name: GROUP_MOVE,
      rows: [
        { keys: 'W A S D', does: 'move' },
        { keys: 'mouse', does: 'look, turn' },
        { keys: 'Space', does: 'jump' },
        { keys: 'V', does: 'first / third person' },
      ],
    },
    {
      name: GROUP_COMBAT,
      rows: [
        { keys: 'click', does: 'fire (held)' },
        { keys: 'right click', does: 'zoom, a step a click' },
        { keys: 'R', does: 'reload' },
        { keys: 'B', does: 'fire mode' },
      ],
    },
    {
      name: GROUP_STANCE,
      rows: [
        { keys: 'C', does: 'stance: stand, crouch, prone' },
        { keys: 'X', does: 'action: climb, ladder slide' },
        { keys: 'Q / E', does: 'peek left / right (held)' },
      ],
    },
    {
      name: GROUP_WEAPONS,
      rows: [
        { keys: '1', does: 'main weapon (the rifle)' },
        { keys: '2', does: 'sidearm (the Mark 23)' },
        { keys: '3', does: 'equipment slot 1 (the M67 grenade)' },
        { keys: '4', does: 'equipment slot 2 (the HE grenade)' },
      ],
    },
    { name: GROUP_GENERAL, rows: general },
  ];
}
