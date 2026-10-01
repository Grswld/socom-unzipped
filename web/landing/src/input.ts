// Keyboard, mouse-wheel and gamepad input reduced to menu intents.

export type Intent = 'up' | 'down' | 'select' | 'back';

export function keyIntent(key: string): Intent | null {
  switch (key) {
    case 'ArrowUp': case 'w': case 'W': return 'up';
    case 'ArrowDown': case 's': case 'S': return 'down';
    case 'Enter': case ' ': case 'x': case 'X': return 'select';
    case 'Escape': case 'Backspace': return 'back';
    default: return null;
  }
}

/** Reads a gamepad's d-pad / left stick / cross, and circle or triangle for BACK (the game's BACK is triangle,
 * which is what the on-screen hint shows; circle is what people press). Edge-triggered by the caller. */
export function gamepadIntent(pad: Gamepad, deadzone = 0.5): Intent | null {
  const b = (i: number) => pad.buttons[i]?.pressed ?? false;
  const y = pad.axes[1] ?? 0;
  if (b(12) || y < -deadzone) return 'up';
  if (b(13) || y > deadzone) return 'down';
  if (b(0)) return 'select';
  if (b(1) || b(3)) return 'back';
  return null;
}

/** The right stick's vertical axis as a scroll speed in -1..1 (0 inside the dead zone): long panels on a pad. */
export function gamepadScroll(pad: Gamepad, deadzone = 0.25): number {
  const y = pad.axes[3] ?? 0;
  return Math.abs(y) < deadzone ? 0 : Math.max(-1, Math.min(1, y));
}

export function startGamepadPolling(onIntent: (i: Intent) => void, onScroll?: (speed: number) => void): () => void {
  let last: Intent | null = null;
  let raf = 0;
  const tick = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let intent: Intent | null = null;
    let scroll = 0;
    for (const p of pads) {
      if (!p) continue;
      if (!scroll) scroll = gamepadScroll(p);
      if (!intent) intent = gamepadIntent(p);
    }
    if (scroll && onScroll) onScroll(scroll);
    if (intent && intent !== last) onIntent(intent);
    last = intent;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
