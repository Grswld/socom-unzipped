import { describe, expect, it } from 'vitest';
import { HAND_OFF, KIT_SLOTS, Kit, type Firearm } from '../src/kit';
import type { SwapPick } from '../src/walk';

/**
 * The WEAPON workstream's kit (`./kit`): L1 the rifle, L2 the Mark 23 (the controller's slots 0.0 and 1.0,
 * `FUN_00598280`); the swap's `m_item` at once going to the pistol and at the end coming back; the pistol to the hand
 * and back to the holster at the clip's hand-off (`FUN_005a7730` / `FUN_005a75d0`); the rifle slung on `spinelo`.
 */
function rig(pick: Partial<SwapPick> | null = { action: 'swapStand', overlay: false, seconds: 1 }, gate = true) {
  const items: Firearm[] = [];
  const asked: Firearm[] = [];
  let started = 0;
  let ok = gate;
  const kit = new Kit({
    swapClip: (to) => { asked.push(to); return pick && { action: null, overlay: false, reversed: to === 'rifle', seconds: 1, ...pick }; },
    canSwap: () => ok,
    item: (i) => items.push(i),
    started: () => { started++; },
  });
  return { kit, items, asked, started: () => started, gate: (on: boolean) => { ok = on; } };
}

describe('the kit\'s slots and the rifle <-> pistol swap', () => {
  it('holds the slots in the kit\'s order, and the hand-off phases per clip', () => {
    expect(KIT_SLOTS).toEqual(['rifle', 'pistol', 'M67', 'HE']);
    expect(HAND_OFF).toEqual({ swapStand: 0.72, swapCrouch: 0.82, swapProne: 0.62, moving: 0.79 });
  });

  it('rifle to pistol: m_item at once, the rifle to spinelo, the pistol to the hand at 0.72, the rifle slung at the end', () => {
    const { kit, items, started } = rig();
    expect(kit.state()).toMatchObject({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'spawn' }, swap: null });
    expect(kit.select('rifle')).toBe(false);                     // the one in the hand: nothing, no toggle back
    expect(kit.select('pistol')).toBe(true);
    expect(started()).toBe(1);
    expect(items).toEqual(['pistol']);                           // FUN_005a7260: m_item 2 at once
    expect(kit.state()).toMatchObject({ item: 'pistol', mounts: { rifle: 'swap', pistol: 'spawn' } });
    expect(kit.swapping()).toBe(true);
    kit.frame(0.7);
    expect(kit.state().mounts.pistol).toBe('spawn');
    kit.frame(0.03);                                             // past 0.72: FUN_005a7730
    expect(kit.state().mounts.pistol).toBe('hand');
    expect(kit.select('pistol')).toBe(false);                    // already going there
    kit.frame(0.3);
    expect(kit.state()).toMatchObject({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' }, swap: null });
    expect(kit.swapping()).toBe(false);
  });

  it('pistol to rifle: the clip backwards, the pistol holstered as it passes the hand-off, m_item back at the end', () => {
    const { kit, items } = rig();
    kit.select('pistol'); kit.frame(1.01);
    items.length = 0;
    expect(kit.select('rifle')).toBe(true);
    expect(items).toEqual([]);                                   // the pistol's anim set until the end
    expect(kit.state().mounts).toEqual({ rifle: 'swap', pistol: 'hand' });
    kit.frame(0.27);
    expect(kit.state().mounts.pistol).toBe('hand');
    kit.frame(0.02);                                             // 1 - 0.29 <= 0.72: FUN_005a75d0
    expect(kit.state().mounts.pistol).toBe('holster');
    kit.frame(0.8);
    expect(kit.state()).toMatchObject({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'holster' }, swap: null });
    expect(items).toEqual(['rifle']);                            // FUN_005a70f0 at the end
  });

  it('the moving overlay hands off at 0.79, prone at 0.62', () => {
    const moving = rig({ action: null, overlay: true, seconds: 1 });
    moving.kit.select('pistol');
    moving.kit.frame(0.78);
    expect(moving.kit.state().mounts.pistol).toBe('spawn');
    moving.kit.frame(0.02);
    expect(moving.kit.state().mounts.pistol).toBe('hand');
    const prone = rig({ action: 'swapProne', overlay: false, seconds: 2 });
    prone.kit.select('pistol');
    prone.kit.frame(1.25);
    expect(prone.kit.state().mounts.pistol).toBe('hand');
  });

  it('is refused by the gate (reloading, throwing) and by the mover (in the air, an action): nothing changes', () => {
    const gated = rig(undefined, false);
    expect(gated.kit.select('pistol')).toBe(false);
    expect(gated.asked).toEqual([]);
    const refused = rig(null);
    expect(refused.kit.select('pistol')).toBe(false);
    expect(refused.asked).toEqual(['pistol']);
    expect(refused.kit.state()).toMatchObject({ item: 'rifle', mounts: { rifle: 'hand' } });
  });

  it('settles a swap on leaving the walk, and resets to the spawn\'s hold for a new map', () => {
    const { kit, items } = rig();
    kit.select('pistol');
    kit.settle();
    expect(kit.state()).toMatchObject({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' }, swap: null });
    kit.reset();
    expect(kit.state()).toMatchObject({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'spawn' } });
    expect(items).toEqual(['pistol', 'rifle']);
  });
});
