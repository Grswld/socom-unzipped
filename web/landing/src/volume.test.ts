import { describe, it, expect } from 'vitest';
import { DEFAULT_VOLUME, parseVolume, levels } from './volume';

describe('volume', () => {
  it('defaults to about 70%', () => {
    expect(DEFAULT_VOLUME).toBe(0.7);
    expect(parseVolume(null)).toBe(0.7);
    expect(parseVolume('')).toBe(0.7);
    expect(parseVolume('loud')).toBe(0.7);
  });

  it('reads a stored value and keeps it in 0..1', () => {
    expect(parseVolume('0.35')).toBe(0.35);
    expect(parseVolume('0')).toBe(0);
    expect(parseVolume('7')).toBe(1);
    expect(parseVolume('-2')).toBe(0);
  });

  it('gives the movie a little less than the effects, and nothing when muted', () => {
    expect(levels(1, false)).toEqual({ video: 0.85, sfx: 1 });
    expect(levels(0.7, false).video).toBeCloseTo(0.595);
    expect(levels(0.7, false).sfx).toBeCloseTo(0.7);
    expect(levels(0.7, true)).toEqual({ video: 0, sfx: 0 });
    expect(levels(0, false)).toEqual({ video: 0, sfx: 0 });
  });
});
