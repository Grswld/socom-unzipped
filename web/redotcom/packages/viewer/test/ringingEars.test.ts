import { afterEach, describe, expect, it, vi } from 'vitest';
import { RingingEars } from '../src/ringingEars';
import { BLAST_RING_SECONDS, BLAST_RING_VOLUME } from '../src/sim';

/** The blast's ringing ears (`FUN_005a0e70` L459221-459227): `.RINGING_EARS`, the mix at 0.35 for 5 s, then back. */

function audio() {
  const calls: string[] = [];
  let volume = 0.8;
  return { calls, volume: () => volume, setVolume: (v: number) => { volume = v; }, onAnimCallback: (name: string) => { calls.push(name); return name; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('the ringing ears', () => {
  it('plays .RINGING_EARS and holds the mix at 0.35 for 5 s, then gives it back', () => {
    vi.useFakeTimers();
    const a = audio(), ears = new RingingEars(a);
    ears.start(BLAST_RING_SECONDS, BLAST_RING_VOLUME);
    expect(a.calls).toEqual(['.RINGING_EARS']);
    expect(a.volume()).toBeCloseTo(0.8 * 0.35, 9);
    vi.advanceTimersByTime(4900);
    expect(ears.ringing).toBe(true);
    vi.advanceTimersByTime(200);
    expect(ears.ringing).toBe(false);
    expect(a.volume()).toBeCloseTo(0.8, 9);
  });

  it('a second blast inside the ring starts it again, from the volume before the first', () => {
    vi.useFakeTimers();
    const a = audio(), ears = new RingingEars(a);
    ears.start(5, 0.35);
    vi.advanceTimersByTime(3000);
    ears.start(5, 0.35);
    expect(a.volume()).toBeCloseTo(0.8 * 0.35, 9);
    vi.advanceTimersByTime(4000);
    expect(ears.ringing).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(a.volume()).toBeCloseTo(0.8, 9);
  });
});
