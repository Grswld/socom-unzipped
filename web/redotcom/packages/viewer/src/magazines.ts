/**
 * The kit's magazines as SOCOM II keeps them -- one ring a weapon, each magazine keeping its own rounds -- shared by the
 * page's `Fire` (`./fire`) and the match's room (`./net/room`), so the two count alike.
 * No imports: it runs in Node (the shared sim's boundary) and in the page.
 *
 * What the game does (research 84 §18 has the citations in full):
 *
 * - **The ring.** `CZKit` holds `s32 m_reloads[30][10]` and `s32 m_currentmag[30]` (reCOM `zseal.h:235-236`; the
 *   kit's `+0x1d4` and `+0x684` in SOCOM II): ten magazine slots a kit slot, and the index of the one in the weapon.
 * - **What is carried** (`FUN_005ba3d0`, decomp 472706-472775; `FUN_005ba5b0` 472779-472830): the first `NumMags`
 *   slots, each topped up to `Ammo_Capacity`, the rest 0; `NumMags` doubled for a firearm when the kit holds the
 *   Double Ammo Load (item id 0xC2), never more than 10. A kit slot set up (`FUN_005bc5d0` 473877-473904) starts with
 *   `m_currentmag` 0. [Reading: the page and the server pass no Double Ammo Load -- research 84 §18.]
 * - **A round** (`FUN_005c1970`, 477039-477042; `FUN_005bc730` 474123-474126) takes one from
 *   `m_reloads[slot][m_currentmag[slot]]`, the magazine in the weapon, and from nothing else.
 * - **A reload** (`FUN_005c2a90`, 477460-477484) walks the ring from the slot after `m_currentmag` round to the one
 *   before it and takes **the first magazine with rounds in it** -- a whole one or a part-spent one, whichever comes
 *   next in order; the one taken out keeps what it had, in its slot. No rounds move between magazines, and no pool:
 *   the rounds in the weapon plus the rounds in the other magazines only ever fall, by the rounds fired.
 * - **The ammo box** (`FUN_00237760`, 85128-85201): `"%d/%d"` is the magazine in the weapon
 *   (`FUN_005c3890` -> `m_reloads[slot][m_currentmag]`) over `Ammo_Capacity` (`FUN_005c3ce0`), and `"%d MAG%c"` is
 *   **the magazines with rounds in them, the one in the weapon among them, less one** (`FUN_005c49b0` counts the slots
 *   `> 0`; the box prints it `- 1`, hidden below 1).
 * - **The last magazine**: with no other magazine holding rounds a reload finds nothing and does not start; the
 *   weapon runs dry and its trigger clicks.
 */

/** `m_reloads[slot][10]`: the magazine slots a weapon has. */
export const RING_SLOTS = 10;
/** The Double Ammo Load's item id (`FUN_005ba3d0` looks for `-0x3e`, 0xC2, among the kit's items). */
export const DOUBLE_AMMO_ID = 0xc2;

/**
 * `FUN_005ba3d0`: the magazines a weapon starts with -- its `NumMags`, doubled with the Double Ammo Load (the firearms'
 * categories, `FUN_003d1a60` 4, 0x1f, 0x33, 0x51, 0x5b, 0x65), at most `RING_SLOTS`.
 */
export function magazinesCarried(numMags: number, doubleAmmo = false): number {
  const n = Math.max(0, Math.floor(numMags)) * (doubleAmmo ? 2 : 1);
  return Math.min(RING_SLOTS, n);
}

/**
 * Whether the viewer's kit counts the Double Ammo Load: no [reading, research 84 §18 -- `mp_seal1` lists it, but the
 * console frame of a live spawn shows the M4A1's three magazines, "2 MAGS"]. The page and the server both read this.
 */
export const KIT_DOUBLE_AMMO = false;

/** A weapon's ring at a spawn: its `Ammo_Capacity` and `NumMags` (the record's `magazine` and `mags`). */
export function ringFor(record: { readonly magazine: number; readonly mags: number }, doubleAmmo = KIT_DOUBLE_AMMO): MagazineRing {
  return new MagazineRing(record.magazine, Math.max(1, magazinesCarried(record.mags, doubleAmmo)));
}

/** One weapon's ring of magazines and the one in the weapon (`m_reloads[slot]`, `m_currentmag[slot]`). */
export class MagazineRing {
  private readonly slots: number[] = new Array<number>(RING_SLOTS).fill(0);
  private current = 0;

  /** `capacity` rounds a magazine (`Ammo_Capacity`); `carried` magazines (`magazinesCarried`). */
  constructor(readonly capacity: number, readonly carried: number) {
    this.fill();
  }

  /** `FUN_005ba3d0` at a spawn: the carried magazines full, the rest empty, the first in the weapon. */
  fill(): void {
    const n = Math.min(RING_SLOTS, Math.max(0, this.carried));
    for (let i = 0; i < RING_SLOTS; i++) this.slots[i] = i < n ? this.capacity : 0;
    this.current = 0;
  }

  /** The rounds in the magazine in the weapon (the box's first number). */
  rounds(): number {
    return this.slots[this.current]!;
  }

  /** Whether the magazine in the weapon is full. */
  full(): boolean {
    return this.rounds() >= this.capacity;
  }

  /** One round leaves the magazine in the weapon (`FUN_005c1970`): false when it is empty. */
  fire(): boolean {
    if (this.slots[this.current]! <= 0) return false;
    this.slots[this.current]!--;
    return true;
  }

  /** `FUN_005c2a90`'s walk: the next slot after the one in the weapon, round the ring, with rounds in it; -1 none. */
  next(): number {
    for (let k = 1; k < RING_SLOTS; k++) {
      const j = (this.current + k) % RING_SLOTS;
      if (this.slots[j]! > 0) return j;
    }
    return -1;
  }

  /** Whether a reload would find a magazine (`next() >= 0`). */
  canReload(): boolean {
    return this.next() >= 0;
  }

  /**
   * The reload's swap (`FUN_005c2a90` 477483, at the reload's start): the next magazine with rounds goes in, the one
   * taken out keeps its rounds in its slot. False, and nothing changes, when there is none.
   */
  reload(): boolean {
    const j = this.next();
    if (j < 0) return false;
    this.current = j;
    return true;
  }

  /** The ammo box's MAGS: the magazines with rounds, the one in the weapon among them, less one; at least 0. */
  shownMags(): number {
    let n = 0;
    for (const r of this.slots) if (r > 0) n++;
    return Math.max(0, n - 1);
  }

  /** Every round the weapon has: in it and in its other magazines. */
  total(): number {
    return this.slots.reduce((a, b) => a + b, 0);
  }

  /** The ten slots' rounds and the index of the one in the weapon (for tests and the hook). */
  state(): { slots: number[]; current: number } {
    return { slots: [...this.slots], current: this.current };
  }
}
