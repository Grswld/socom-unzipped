import { describe, it, expect } from 'vitest';
import { createRoller, move, lit, neighbour, pulseScale, MENU_ITEMS } from './roller';

describe('roller', () => {
  it('starts on ABOUT by default', () => {
    expect(lit(createRoller())).toBe('ABOUT');
    expect(MENU_ITEMS).toEqual(['ABOUT', 'SETUP GUIDE', 'SERVER', 'REDOTCOM', 'BUG REPORT', 'GITHUB']);
  });

  it('moves down and up one row at a time', () => {
    const r = createRoller(MENU_ITEMS, 1);
    expect(lit(move(r, 1))).toBe('SERVER');
    expect(lit(move(r, -1))).toBe('ABOUT');
  });

  it('wraps at both ends', () => {
    expect(lit(move(createRoller(MENU_ITEMS, 0), -1))).toBe('GITHUB');
    expect(lit(move(createRoller(MENU_ITEMS, MENU_ITEMS.length - 1), 1))).toBe('ABOUT');
    expect(lit(move(createRoller(), 9))).toBe('REDOTCOM');
  });

  it('shows the neighbours above and below, wrapping', () => {
    const r = createRoller(MENU_ITEMS, 0);
    expect(neighbour(r, -1)).toBe('GITHUB');
    expect(neighbour(r, 1)).toBe('SETUP GUIDE');
  });

  it('does not mutate the previous state', () => {
    const r = createRoller();
    move(r, 1);
    expect(r.index).toBe(0);
  });

  it('pulses around 1 within the amplitude', () => {
    expect(pulseScale(0)).toBeCloseTo(1);
    expect(pulseScale(0.3)).toBeCloseTo(1.12);
    expect(pulseScale(0.9)).toBeCloseTo(0.88);
  });

  it('rejects an empty list', () => {
    expect(() => createRoller([])).toThrow();
  });
});
