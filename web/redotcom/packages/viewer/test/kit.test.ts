import { describe, expect, it } from 'vitest';
import { HAND_OFF, hotkey, KIT_SLOTS, Kit, type Firearm } from '../src/kit';
import type { SwapPick, SwapProgress } from '../src/walk';
import { DEFAULT_RIFLE } from '@s2u/scene';
import { Fire, RELOAD_DELAY } from '../src/fire';

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

describe('the PC number keys (the owner, 2026-09-29)', () => {
  it('1 the main weapon, 2 the sidearm, 3 and 4 the equipment slots 1 and 2; nothing else', () => {
    expect(hotkey('Digit1')).toEqual({ firearm: 'rifle' });
    expect(hotkey('Digit2')).toEqual({ firearm: 'pistol' });
    expect(hotkey('Digit3')).toEqual({ equipment: 1 });
    expect(hotkey('Digit4')).toEqual({ equipment: 2 });
    for (const code of ['Digit0', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Numpad1', 'KeyQ']) expect(hotkey(code), code).toBeNull();
  });
});

describe('the swap on the clock of the walk (swapProgress: the re-sync the handoff asked for)', () => {
  /** A kit whose host reports the clip the walk plays: `on` is what `swapProgress` answers. */
  function synced() {
    let on: SwapProgress | null = null;
    const items: Firearm[] = [];
    const kit = new Kit({
      swapClip: (to) => { on = { action: 'swapStand', overlay: false, progress: 0 }; return { action: 'swapStand', overlay: false, reversed: to === 'rifle', seconds: 1.24 }; },
      canSwap: () => true, item: (i) => items.push(i), swapProgress: () => on,
    });
    return { kit, items, set: (p: SwapProgress | null) => { on = p; } };
  }

  it('hands off by the clip playing -- the 0.79 of the overlay once a standing swap is cut to it -- and ends when it does', () => {
    const { kit, set } = synced();
    kit.select('pistol');
    set({ action: 'swapStand', overlay: false, progress: 0.5 });
    kit.frame(5);                                            // the kit's own count would be long over: it is not used
    expect(kit.state().swap).toMatchObject({ progress: 0.5, handed: false });
    set({ action: null, overlay: true, progress: 0.75 });    // the stick cut it: the moving overlay at the same phase
    kit.frame(1 / 60);
    expect(kit.state().swap).toMatchObject({ progress: 0.75, handed: false, clip: 'seal_mv_rifle2pistol' });   // past 0.72, not 0.79
    set({ action: null, overlay: true, progress: 0.8 });
    kit.frame(1 / 60);
    expect(kit.state().mounts.pistol).toBe('hand');
    expect(kit.swapping()).toBe(true);
    set(null);                                               // the overlay is over: the swap with it, that frame
    kit.frame(1 / 60);
    expect(kit.state()).toMatchObject({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' }, swap: null });
  });

  it('back to the rifle: m_item on the frame the clip ends, not a frame before or after', () => {
    const { kit, items, set } = synced();
    kit.select('pistol'); set(null); kit.frame(1 / 60);
    items.length = 0;
    kit.select('rifle');
    set({ action: 'swapStand', overlay: false, progress: 0.99 });
    kit.frame(1);
    expect(kit.state().mounts.rifle).toBe('swap');
    expect(items).toEqual([]);
    set(null);
    kit.frame(1 / 60);
    expect(kit.state().mounts.rifle).toBe('hand');
    expect(items).toEqual(['rifle']);
  });
});

describe('the reload waits out a swap (FUN_00594cf0 453460-453463: the request only while FUN_005a7ab0 is 0)', () => {
  it('R mid-swap is refused, and taken once the swap has played to its end', () => {
    const { kit } = rig();
    const fire = new Fire({ grid: () => null, aim: () => null, ready: () => !kit.swapping() }, DEFAULT_RIFLE);
    expect(kit.select('pistol')).toBe(true);
    expect(fire.reload()).toBe(false);
    expect(fire.state().magazine.reloading).toBe(false);
    kit.frame(0.5);
    expect(fire.reload()).toBe(false);
    kit.frame(0.6);                                              // the clip's end: the swap is over
    expect(kit.swapping()).toBe(false);
    expect(fire.reload()).toBe(true);
    fire.update(RELOAD_DELAY + 0.001);
    expect(fire.state().magazine.reloading).toBe(true);
  });
});
