import { describe, expect, it } from 'vitest';
import { MobileTip, TIP_DISMISSED_KEY, TIP_SEEN_KEY, tipText, type TipStore } from '../src/mobileTip';

/**
 * The phone's tip (owner, 2026-09-29): a controller and landscape recommended, once a visit and again on a turn to
 * portrait, until the player dismisses it -- which is remembered for good.
 */
function memory(): TipStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => { data.set(k, v); } };
}
function broken(): TipStore {
  return { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('blocked'); } };
}

describe('MobileTip', () => {
  it('is never shown on a device with no touch', () => {
    const tip = new MobileTip(memory(), memory());
    expect(tip.start(false, false)).toBe(false);
    expect(tip.rotate(true)).toBe(false);
  });

  it('shows once a visit: the first start, not a reload in the same visit', () => {
    const local = memory(), session = memory();
    expect(new MobileTip(local, session).start(true, false)).toBe(true);
    expect(session.data.get(TIP_SEEN_KEY)).toBe('1');
    expect(new MobileTip(local, session).start(true, false)).toBe(false);          // the same visit
    expect(new MobileTip(local, memory()).start(true, false)).toBe(true);          // a new visit
  });

  it('shows again on a turn to portrait, not on a turn to landscape', () => {
    const tip = new MobileTip(memory(), memory());
    expect(tip.start(true, false)).toBe(true);
    expect(tip.rotate(false)).toBe(false);
    expect(tip.rotate(true)).toBe(true);
    expect(tip.rotate(true)).toBe(false);                                          // still portrait: no turn
    expect(tip.rotate(false)).toBe(false);
    expect(tip.rotate(true)).toBe(true);
  });

  it('once dismissed, is gone for good: no rotation and no later visit brings it back', () => {
    const local = memory();
    const tip = new MobileTip(local, memory());
    expect(tip.start(true, true)).toBe(true);
    tip.dismiss();
    expect(local.data.get(TIP_DISMISSED_KEY)).toBe('1');
    expect(tip.rotate(false)).toBe(false);
    expect(tip.rotate(true)).toBe(false);
    expect(new MobileTip(local, memory()).start(true, true)).toBe(false);
  });

  it('works without storage: once in the page, dismissed in the page', () => {
    const tip = new MobileTip(broken(), broken());
    expect(tip.start(true, false)).toBe(true);
    expect(tip.start(true, false)).toBe(false);
    tip.dismiss();
    expect(tip.rotate(true)).toBe(false);
  });

  it('asks for a controller and for landscape', () => {
    expect(tipText(false)).toMatch(/controller/i);
    expect(tipText(false)).toMatch(/landscape|sideways/i);
    expect(tipText(true)).toMatch(/landscape|sideways/i);
  });
});
