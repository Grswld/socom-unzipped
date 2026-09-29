import { describe, expect, it } from 'vitest';
import { remoteKit, remoteKitOf } from '../src/remotePlayers';
import { Kit, type Firearm, type KitState } from '../src/kit';
import { groundGrid, packGround, Walker, type GroundData } from '../src/mover';
import { MoverSim } from '../src/net/moverSim';
import { bodyOf, snapshotOf } from '../src/net/body';
import { decodeSnapshot, encodeSnapshot, quantiseCommand } from '../src/net/codec';
import { Button, type Command } from '../src/net/protocol';

// The merge of web sprint 3 into the integration branch: the replicated weapon (0 the rifle, 1 the Mark 23) puts the
// other player's weapons where the local kit puts them once its swap has ended (`./kit`: FUN_005a60d0 / FUN_005a75d0).
describe('remoteKit', () => {
  it('the rifle in the hand, the pistol holstered', () => {
    expect(remoteKit(0)).toEqual({ item: 'rifle', mounts: { rifle: 'hand', pistol: 'holster' } });
  });
  it('the pistol in the hand, the rifle carried', () => {
    expect(remoteKit(1)).toEqual({ item: 'pistol', mounts: { rifle: 'carry', pistol: 'hand' } });
  });
});

/**
 * The merge review's hole 3: the other player's hand-off follows the swap clip the snapshot carries (its action or
 * overlay, its clock and direction) -- the same clip, progress and `HAND_OFF` phase the local kit runs on -- instead
 * of switching when the replicated weapon does. One mover, swapped by commands as the server runs them; each tick the
 * body goes over the wire (`bodyOf` -> codec -> `snapshotOf`) and the remote's kit is compared with a local `Kit` on
 * that same mover's `swapProgress`.
 */
describe('the remote swap hands off mid-clip, as the local kit does', () => {
  const GROUND: GroundData = packGround(
    { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 },
    [{
      modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
      points: Float32Array.from([-200, 0, -200, 200, 0, -200, 200, 0, 200, -200, 0, 200]),
    }],
    [{ modelName: 'worldmodel', path: 'worldmodel/floor', first: 0, count: 1 }],
  );

  const rig = () => {
    const walker = new Walker(groundGrid(GROUND));
    walker.place(0, 30, 0);
    const sim = new MoverSim(walker, null);
    let seq = 0, pending: 0 | 1 | null = null, forward = 0;
    const kit = new Kit({
      swapClip: (to) => { pending = to === 'pistol' ? 1 : 0; return walker.swapWeapon(to); },
      canSwap: () => true, item: () => undefined, swapProgress: () => walker.swapProgress(),
    });
    /** One tick: the command (a swap press when the kit just took one), the step, the kit, the wire. */
    const tick = (): { local: KitState; remote: ReturnType<typeof remoteKit> } => {
      const swap = pending;
      pending = null;
      const cmd: Command = quantiseCommand({
        seq: ++seq, forward, right: 0, yaw: 0, pitch: 0, turn: 0,
        buttons: swap !== null ? Button.Swap : 0, stance: 0, weapon: swap ?? sim.weapon,
      });
      // The kit's `select` already started the clip on this mover (the page's press); the server's `prepare` sees the
      // same press with the weapon not yet moved, so hold the sim's weapon in step without starting a second clip.
      if (swap !== null) sim.weapon = swap;
      walker.tick(sim.prepare({ ...cmd, buttons: 0 }));
      kit.frame(1 / 60);
      const wire = decodeSnapshot(encodeSnapshot({
        tick: seq, own: null, bodies: [bodyOf(7, sim.body(), { alive: true, weapon: sim.weapon, aiming: false, trigger: false, boost: false })],
      })).bodies[0]!;
      return { local: kit.state(), remote: remoteKitOf(snapshotOf(wire)) };
    };
    return { kit, tick, stick: (f: number) => { forward = f; } };
  };

  /** Runs a swap to `to` for up to three seconds: the ticks the two disagree, and the tick each handed off. */
  const swapRun = (r: ReturnType<typeof rig>, to: Firearm) => {
    expect(r.kit.select(to)).toBe(true);
    let disagree = 0, localHand = -1, remoteHand = -1, midSwap = false;
    const handed = (m: { pistol: string }) => (to === 'pistol' ? m.pistol === 'hand' : m.pistol !== 'hand');
    for (let t = 0; t < 180; t++) {
      const { local, remote } = r.tick();
      if (local.item !== remote.item || local.mounts.rifle !== remote.mounts.rifle || (local.mounts.pistol === 'hand') !== (remote.mounts.pistol === 'hand')) disagree++;
      if (localHand < 0 && handed(local.mounts)) localHand = t;
      if (remoteHand < 0 && handed(remote.mounts)) remoteHand = t;
      if (remote.mounts.rifle === 'swap' && remoteHand === t) midSwap = true;   // handed while the clip still plays
      if (!local.swap && !r.kit.swapping() && remote.mounts.rifle !== 'swap' && t > 5) break;
    }
    return { disagree, localHand, remoteHand, midSwap };
  };

  it('standing: the pistol reaches the hand at the clip\'s hand-off, then back to the holster going the other way', () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.tick();
    const out = swapRun(r, 'pistol');
    expect(out.remoteHand).toBeGreaterThan(10);                     // not at the swap's start: mid-clip
    expect(out.midSwap).toBe(true);
    expect(Math.abs(out.remoteHand - out.localHand)).toBeLessThanOrEqual(1);
    expect(out.disagree).toBeLessThanOrEqual(2);                    // the snapshot's clock is quantised to 1/1000 s
    for (let i = 0; i < 5; i++) r.tick();
    const back = swapRun(r, 'rifle');
    expect(back.remoteHand).toBeGreaterThan(0);
    expect(back.midSwap).toBe(true);
    expect(Math.abs(back.remoteHand - back.localHand)).toBeLessThanOrEqual(1);
    expect(back.disagree).toBeLessThanOrEqual(2);
  });

  it('moving: the overlay\'s hand-off on the remote too', () => {
    const r = rig();
    r.stick(1);
    for (let i = 0; i < 40; i++) r.tick();                         // up to speed: the swap is the overlay
    const out = swapRun(r, 'pistol');
    expect(out.midSwap).toBe(true);
    expect(Math.abs(out.remoteHand - out.localHand)).toBeLessThanOrEqual(1);
    expect(out.disagree).toBeLessThanOrEqual(2);
  });
});
