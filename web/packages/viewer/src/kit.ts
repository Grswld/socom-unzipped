import type { Mount } from './heldItem';
import type { SwapPick } from './walk';

/**
 * The SEAL's kit slots and the rifle <-> pistol swap (the WEAPON workstream's sidearm round). What the game does:
 *
 * - **The slots.** `mp_seal1`'s kit is M4A1, Mark 23, M67, HE, ... (`READERC.ZAR/character.rdr`; the viewer's rifle is
 *   W2.R4's M4A1 SD). The player control (`FUN_00594cf0`, decomp 453288-453312) reads L1 (pad button 9) as a press
 *   of the slot kept at `ctrl+0x224` and L2 (button 10) the one at `+0x228`; the controller's constructor
 *   (`FUN_00598280`, 454785-454786) sets them to 0.0 and 1.0 -- slot 0, the primary, and slot 1, **the sidearm**. R2 is
 *   the Inventory (`FUN_0021bda0`'s menu over every slot): the grenades are reached there, not on L2.
 * - **The gate** (`FUN_005a8cb0`, `FUN_005bdc30`, the slot's count, `FUN_005c4fd0`, else the denied sound
 *   `FUN_003419c0`), then `FUN_005c4b10`: the slot already in the hand does nothing (**no toggle back**); a scope drops
 *   to first person; the kit's selected slot `+0x824` is set, and a change of category (`FUN_005c50b0`) starts the swap
 *   through `FUN_005c1660` -> `FUN_005a64c0`, whose clip choice the MOTION workstream ported (`WalkMode.swapWeapon`).
 *   Refused while reloading, while a swap runs, while throwing, in the air.
 * - **Rifle to pistol.** At the start `FUN_005a7260` re-parents the rifle to `spinelo` (the clip's own `rifle` track
 *   poses it there) and sets `m_item` to 2 at once; `FUN_0057d5e0` turns the playing clips to their pistol versions.
 *   A callback in the clip (`FUN_005a7730`) moves the pistol to `rhand` at the hand-off (`HAND_OFF`); at the end
 *   `FUN_005a60d0(seal, 2, 0)` hangs the rifle on `spinelo` at `character.rdr`'s "rifle" offset.
 * - **Pistol to rifle.** The same clip played backwards; its callback (`FUN_005a75d0`) holsters the pistol on `rthigh`
 *   at the "pistol" offset as the clip passes the hand-off going back; at the end `FUN_005a70f0` puts the rifle in the
 *   hand and sets `m_item` to 1.
 * - **At spawn** the pistol hangs on `+0x304` (`hips`) at the identity (`FUN_00553290` slot 2).
 *
 * The viewer's readings, named: the hand-off points are the clips' normalised phases the callback fires at
 * (`HAND_OFF`, research of this round: "not settled" -- where the clip's `pistol` track reaches the hand's hold); the
 * swap's progress is the pick's own seconds (the walk's action or overlay runs the clip on the same clock).
 */

export type Firearm = 'rifle' | 'pistol';
/** What the page's inventory holds, slot order (`mp_seal1`: M4A1, Mark 23, M67, HE). */
export type KitItem = Firearm | 'M67' | 'HE';
export const KIT_SLOTS: readonly KitItem[] = ['rifle', 'pistol', 'M67', 'HE'];

/**
 * The clips' hand-off points, normalised phase (`FUN_005a7730` / `FUN_005a75d0`'s callbacks): standing 0.72, crouched
 * 0.82, prone 0.62, the moving overlay 0.79 [reading: the phases are this round's research's, not settled].
 */
export const HAND_OFF = { swapStand: 0.72, swapCrouch: 0.82, swapProne: 0.62, moving: 0.79 } as const;

/** Where each weapon rides, and which one the anim set and the fire use (`m_item`). */
export interface KitState {
  item: Firearm;
  mounts: { rifle: Mount; pistol: Mount };
  swap: { to: Firearm; progress: number; handed: boolean; clip: string } | null;
}

/** What the kit asks of the page. */
export interface KitHost {
  /** The walk's swap clip (`WalkMode.swapWeapon`): null when the mover refuses (in the air, an action playing). */
  swapClip(to: Firearm): SwapPick | null;
  /** Whether the kit may swap now: not reloading, not throwing (`FUN_005a8cb0` / `FUN_005bdc30`'s gates). */
  canSwap(): boolean;
  /** `m_item` changed: the anim set, the fire's record, the reticle, the icon, the sounds follow. */
  item(item: Firearm): void;
  /** A swap began (`FUN_005c4b10`): the scope drops to first person. */
  started?(to: Firearm): void;
}

/** The hand-off of a pick. */
function handOffOf(pick: SwapPick): number {
  return pick.overlay ? HAND_OFF.moving : HAND_OFF[pick.action ?? 'swapStand'];
}

export class Kit {
  private state_: KitState = { item: 'rifle', mounts: { rifle: 'hand', pistol: 'spawn' }, swap: null };
  private pick: SwapPick | null = null;
  private elapsed = 0;

  constructor(private readonly host: KitHost) {}

  state(): KitState {
    const s = this.state_;
    return { item: s.item, mounts: { ...s.mounts }, swap: s.swap && { ...s.swap } };
  }

  /** The firearm the fire and the anim set use (`m_item`). */
  item(): Firearm { return this.state_.item; }
  /** Whether a swap is playing (no round leaves until it is done: `FUN_005a7ab0`). */
  swapping(): boolean { return this.pick !== null; }

  /**
   * Takes a firearm up (L1 the rifle, L2 the pistol): true when a swap started. The one already in the hand does
   * nothing; refused mid-swap, by the page's gate (`canSwap`) or by the mover (`swapClip` null).
   */
  select(to: Firearm): boolean {
    if (this.pick || to === this.target() || !this.host.canSwap()) return false;
    const pick = this.host.swapClip(to);
    if (!pick) return false;
    this.pick = pick;
    this.elapsed = 0;
    const s = this.state_;
    s.swap = { to, progress: 0, handed: false, clip: pick.overlay ? 'seal_mv_rifle2pistol' : pick.action ?? '' };
    this.host.started?.(to);
    if (to === 'pistol') {
      // FUN_005a7260: the rifle to spinelo (the clip poses it) and m_item 2 at once.
      s.mounts.rifle = 'swap';
      s.item = 'pistol';
      this.host.item('pistol');
    } else s.mounts.rifle = 'swap';                // the rifle rises off the back as the clip plays backwards
    return true;
  }

  /** One frame of a swap: the hand-off as its phase passes, the end at its seconds. */
  frame(dt: number): void {
    const pick = this.pick, s = this.state_;
    if (!pick || !s.swap) return;
    this.elapsed += dt;
    const progress = pick.seconds > 0 ? Math.min(1, this.elapsed / pick.seconds) : 1;
    s.swap.progress = progress;
    const h = handOffOf(pick);
    if (!s.swap.handed && (s.swap.to === 'pistol' ? progress >= h : 1 - progress <= h)) {
      s.swap.handed = true;
      if (s.swap.to === 'pistol') s.mounts.pistol = 'hand';      // FUN_005a7730
      else s.mounts.pistol = 'holster';                          // FUN_005a75d0
    }
    if (progress >= 1) this.finish();
  }

  /** A new map, or leaving the walk mid-swap: the swap finishes where it was going. */
  settle(): void {
    if (this.pick) this.finish();
  }

  /** Back to the spawn: the rifle in the hand, the pistol on the hips. */
  reset(): void {
    this.pick = null;
    const was = this.state_.item;
    this.state_ = { item: 'rifle', mounts: { rifle: 'hand', pistol: 'spawn' }, swap: null };
    if (was !== 'rifle') this.host.item('rifle');
  }

  /** The firearm the kit is on or going to. */
  private target(): Firearm {
    return this.state_.swap?.to ?? this.state_.item;
  }

  private finish(): void {
    const s = this.state_, to = s.swap?.to ?? s.item;
    this.pick = null;
    s.swap = null;
    if (to === 'pistol') {
      s.mounts = { rifle: 'carry', pistol: 'hand' };             // FUN_005a60d0(seal, 2, 0)
    } else {
      s.mounts = { rifle: 'hand', pistol: s.mounts.pistol === 'hand' ? 'holster' : s.mounts.pistol };
      s.item = 'rifle';                                          // FUN_005a70f0: m_item 1 at the end
      this.host.item('rifle');
    }
  }
}
