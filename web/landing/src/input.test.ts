import { describe, it, expect } from 'vitest';
import { keyIntent, gamepadIntent, gamepadScroll } from './input';

function pad(buttons: number[] = [], axes: number[] = [0, 0]): Gamepad {
  const list = Array.from({ length: 17 }, (_, i) => ({ pressed: buttons.includes(i), touched: false, value: 0 }));
  return { buttons: list, axes } as unknown as Gamepad;
}

describe('keyIntent', () => {
  it('maps arrows, WASD, enter/space/x and escape', () => {
    expect(keyIntent('ArrowUp')).toBe('up');
    expect(keyIntent('s')).toBe('down');
    expect(keyIntent('Enter')).toBe('select');
    expect(keyIntent(' ')).toBe('select');
    expect(keyIntent('Escape')).toBe('back');
    expect(keyIntent('q')).toBeNull();
  });
});

describe('gamepadIntent', () => {
  it('reads the d-pad, the stick past the deadzone, and cross', () => {
    expect(gamepadIntent(pad([12]))).toBe('up');
    expect(gamepadIntent(pad([13]))).toBe('down');
    expect(gamepadIntent(pad([], [0, 0.9]))).toBe('down');
    expect(gamepadIntent(pad([], [0, -0.2]))).toBeNull();
    expect(gamepadIntent(pad([0]))).toBe('select');
    expect(gamepadIntent(pad([1]))).toBe('back');
  });
});

describe('gamepad', () => {
  const pad = (pressed: number[], axes: number[] = [0, 0, 0, 0]): Gamepad =>
    ({ buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: 0 })), axes } as unknown as Gamepad);

  it('takes circle and triangle as BACK, cross as SELECT', () => {
    expect(gamepadIntent(pad([0]))).toBe('select');
    expect(gamepadIntent(pad([1]))).toBe('back');
    expect(gamepadIntent(pad([3]))).toBe('back');
    expect(gamepadIntent(pad([12]))).toBe('up');
    expect(gamepadIntent(pad([], [0, 0.9, 0, 0]))).toBe('down');
    expect(gamepadIntent(pad([]))).toBeNull();
  });

  it('scrolls with the right stick outside its dead zone', () => {
    expect(gamepadScroll(pad([], [0, 0, 0, 0.1]))).toBe(0);
    expect(gamepadScroll(pad([], [0, 0, 0, 0.6]))).toBeCloseTo(0.6);
    expect(gamepadScroll(pad([], [0, 0, 0, -3]))).toBe(-1);
    expect(gamepadScroll(pad([], [0, 0]))).toBe(0);
  });
});
