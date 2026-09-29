// The main-menu roller: a vertical list with one lit item, wrapping at both ends.
// Pure state so it can be unit-tested; the DOM binding lives in main.ts.

export const MENU_ITEMS = ['ABOUT', 'SETUP GUIDE', 'SERVER', 'REDOTCOM', 'BUG REPORT', 'GITHUB'] as const;
export type MenuItem = (typeof MENU_ITEMS)[number];

export interface RollerState {
  readonly items: readonly string[];
  readonly index: number;
}

export function createRoller(items: readonly string[] = MENU_ITEMS, index = 0): RollerState {
  if (items.length === 0) throw new Error('roller needs at least one item');
  return { items, index: ((index % items.length) + items.length) % items.length };
}

/** Move the lit item by `delta` rows (positive = down), wrapping. */
export function move(state: RollerState, delta: number): RollerState {
  const n = state.items.length;
  return { ...state, index: (((state.index + delta) % n) + n) % n };
}

export function lit(state: RollerState): string {
  return state.items[state.index];
}

/** Item shown `offset` rows away from the lit one (negative = above), wrapping. */
export function neighbour(state: RollerState, offset: number): string {
  return lit(move(state, offset));
}

/**
 * The lit row's pulse: the game grows and shrinks the text continuously.
 * Returns a scale factor for time `t` (seconds). Period and amplitude are read off the
 * parity captures ("lit ONLINE spans 114-146 px" against a ~130 px mean → ±12 %).
 */
export function pulseScale(t: number, period = 1.2, amplitude = 0.12): number {
  return 1 + amplitude * Math.sin((2 * Math.PI * t) / period);
}
