import { describe, expect, it } from 'vitest';
import { KEY_STANCE, StanceButton, STANCE_HOLD_S_PLACEHOLDER, stanceKeyOnHold, stanceKeyOnTap } from '../src/stanceButton';
import * as play from '../src/play';
import type { Stance } from '../src/walk';

/** The PC's C (owner, 2026-09-29): a tap toggles stand and crouch, from prone a tap crouches; a hold goes prone. */
describe('the C key\'s stance rules', () => {
  const FRAME = 1 / 60;
  const press = (b: StanceButton, from: Stance, seconds: number): Stance[] => {
    const asked: Stance[] = [];
    let now = from;
    for (let t = 0; t < seconds - 1e-9; t += FRAME) { const go = b.update(true, FRAME, now); if (go) { asked.push(go); now = go; } }
    const go = b.update(false, FRAME, now);
    if (go) asked.push(go);
    return asked;
  };

  it('a tap: stand to crouch, crouch to stand, prone to crouch', () => {
    expect(stanceKeyOnTap('stand')).toBe('crouch');
    expect(stanceKeyOnTap('crouch')).toBe('stand');
    expect(stanceKeyOnTap('prone')).toBe('crouch');
  });

  it('a hold: prone from standing or crouched, and nothing from prone', () => {
    expect(stanceKeyOnHold('stand')).toBe('prone');
    expect(stanceKeyOnHold('crouch')).toBe('prone');
    expect(stanceKeyOnHold('prone')).toBeNull();
  });

  it('shares the pad\'s hold threshold, and the machine runs them', () => {
    expect(STANCE_HOLD_S_PLACEHOLDER).toBe(0.4);
    expect(press(new StanceButton(STANCE_HOLD_S_PLACEHOLDER, KEY_STANCE), 'prone', 0.1)).toEqual(['crouch']);
    expect(press(new StanceButton(STANCE_HOLD_S_PLACEHOLDER, KEY_STANCE), 'prone', 0.6)).toEqual([]);
    expect(press(new StanceButton(STANCE_HOLD_S_PLACEHOLDER, KEY_STANCE), 'stand', 0.6)).toEqual(['prone']);
    expect(press(new StanceButton(STANCE_HOLD_S_PLACEHOLDER, KEY_STANCE), 'stand', STANCE_HOLD_S_PLACEHOLDER - 2 * FRAME)).toEqual(['crouch']);
  });

  it('the pad\'s Triangle keeps its own rules (a tap from prone stands), from the same module', () => {
    expect(press(new StanceButton(), 'prone', 0.1)).toEqual(['stand']);
    expect(play.StanceButton).toBe(StanceButton);
  });
});
