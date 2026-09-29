import { IDENTITY, multiply, Skeleton, transformPoint, type Pnt3D, type WeaponPoint } from '@s2u/scene';

/**
 * The rifle in the SEAL's hands (the WEAPON workstream; the owner's playtest: "no weapon model visible").
 *
 * **How the game hangs it.** The SEAL's skeleton has no weapon node on disc (`CLIB_GEO`'s 26 slots, research 78 §3);
 * the body makes them. `CZSealBody`'s constructor (decomp lines 419640-419690, the 25 `FUN_0028e7b0` part look-ups
 * into `+0x2e8..+0x348` in reCOM's order: `+0x2fc` spinelo, `+0x300` rhand) sets `m_item` (`+0xf79`) to 1, the rifle,
 * and calls `FUN_00553290` 0x553290 for slots 1 and 2: each makes a fresh `CNode` (`FUN_00316e30`), names it "rifle"
 * (slot 1, the string at 0x65c498) or "pistol" (slot 2), and adds it to the body (`FUN_0028ebe0`) under **`rhand`
 * when that item is the one in hand**, else under the carry part -- `spinelo` for the rifle, whose offset there is
 * `character.rdr`'s "rifle" gear (`NONAME.flt` on spinelo, `FUN_0058b0f0`'s `FindGear("rifle")`). The node's pose
 * is the clips': the pack's clips carry a `rifle` track (a constant `(1.266, 0.258, -0.148)` from the hand in most,
 * turned through the run), a few the SOCOM 1 name `weapon` (`./animator` `partIndex`).
 *
 * **The model on it.** `WEAP_GEO`'s M4A1 SD (research 79 §2.2) is modelled with its grip at the origin, the barrel
 * along +x, up +y; hung at the node's identity, `seal_fp_stand` puts the barrel along the body's forward (-z) to
 * within two degrees and the sight 15.2 over the feet at the cheek, `seal_stand` carries it at the low ready, the
 * left hand under the fore-end in both (measured on MP2's skeleton): the node is the grip.
 *
 * **The fire point.** When the rifle is drawn the body looks up the weapon model's "aimpoint" and "firepoint" nodes
 * (`FUN_005a60d0` 0x5a60d0: `vtbl+100` with 0x65f658 / 0x65f668 into `+0x14ac` / `+0x14bc`) and keeps their places
 * relative to the actor (`+0x14a0`, `+0x14b0`); `GetPutativeFirePointW` 0x57fa70's second path returns `+0x14b0` plus
 * the position (research 79 §3.1) and the aim test `FUN_0054ea80` fires from it. So a round leaves the posed
 * weapon's `firepoint`: `muzzleOf`.
 *
 * The viewer's reading, named: the node's rest (the bind) is the identity -- a fresh `CNode`; every clip the picker
 * plays moves it.
 */

/** The held item's node, and the part it hangs from with the rifle in hand (`FUN_00553290`, `m_item` 1). */
export const HELD_ITEM = { name: 'rifle', parent: 'rhand' } as const;

/** The weapon model's muzzle node (research 79 §2.2; the RPG-7 spells it `firepont`). */
export const MUZZLE_NODE = 'firepoint';

/** WEAPON: the sidearm's node (`FUN_00553290` slot 2, the string "pistol"): under `rhand` while it is drawn. */
export const PISTOL_ITEM = { name: 'pistol', parent: 'rhand' } as const;

/**
 * The play skeleton: the body's own 26 parts (`LoadedBody.parts`, `CLIB_GEO`) and the two held items' nodes after
 * them, `rifle` then `pistol`, under `rhand` at the identity (the clips' `rifle` / `pistol` tracks pose them there);
 * the body's own skeleton unchanged when it has no `rhand`.
 */
export function heldSkeleton(base: Skeleton): Skeleton {
  const parent = base.indexOf(HELD_ITEM.parent);
  if (parent < 0) return base;
  const node = (index: number, name: string) =>
    ({ index, name, parent, bindLocal: Float32Array.from(IDENTITY), bbox: new Float32Array(6), type: 0, flags: 0 });
  return new Skeleton(base.model, base.modelMatrix, [...base.parts, node(base.size, HELD_ITEM.name), node(base.size + 1, PISTOL_ITEM.name)]);
}

/**
 * Where a weapon rides, as the game hangs it (research on the swap, `FUN_005a7260` / `FUN_005a7730` / `FUN_005a60d0` /
 * `FUN_005a75d0` / `FUN_005a70f0`):
 * - `hand`: its node under `rhand`, posed by the clips' track (`skeleton.world` of `rifle` / `pistol`);
 * - `swap`: the rifle during the swap, re-parented to `spinelo` at its start (`FUN_005a7260`) and posed there by the swap
 *   clip's own `rifle` track (the clips carry it `spinelo`-relative: the muzzle ahead of the chest at key 0, on the back
 *   at the end);
 * - `carry`: the rifle slung, `character.rdr`'s "rifle" offset on `spinelo` (`FUN_005a60d0(seal, 2, 0)`);
 * - `holster`: the pistol in its holster, the "pistol" offset on `rthigh` (`FUN_005a75d0`);
 * - `spawn`: the pistol as the constructor hangs it, on `+0x304` (`hips`) at the identity.
 */
export type Mount = 'hand' | 'swap' | 'carry' | 'holster' | 'spawn';

/** The carry offsets (`LoadedBody.carries`): part index and offset matrix, or null without `character.rdr`. */
export interface Carries { rifle: { part: number; offset: Float32Array } | null; pistol: { part: number; offset: Float32Array } | null }

/**
 * A weapon's matrix in the model's frame (row-major, row-vector) on its mount, through the posed skeleton; null when the
 * mount's part or offset is not to hand.
 */
export function mountMatrix(skeleton: Skeleton, item: 'rifle' | 'pistol', mount: Mount, carries: Carries | null): Float32Array | null {
  const node = skeleton.indexOf(item);
  switch (mount) {
    case 'hand': return node >= 0 ? skeleton.world[node]! : null;
    case 'swap': {
      const spine = skeleton.indexOf('spinelo');
      return node >= 0 && spine >= 0 ? multiply(skeleton.local[node]!, skeleton.world[spine]!) : null;
    }
    case 'carry': case 'holster': {
      const c = item === 'rifle' ? carries?.rifle : carries?.pistol;
      return c ? multiply(c.offset, skeleton.world[c.part]!) : null;
    }
    case 'spawn': {
      const hips = skeleton.indexOf('hips');
      return hips >= 0 ? skeleton.world[hips]! : null;
    }
  }
}

/** The weapon model's muzzle, in its own frame (the grip at the origin), or null when it names none. */
export function muzzlePoint(points: readonly WeaponPoint[]): Pnt3D | null {
  const p = points.find((q) => q.name === MUZZLE_NODE || q.name === 'firepont');
  return p ? [p.at[0], p.at[1], p.at[2]] : null;
}

/** The muzzle in the model's frame through the posed skeleton: the node's world matrix carries the weapon's point. */
export function muzzleOf(skeleton: Skeleton, muzzle: Pnt3D, item: 'rifle' | 'pistol' = 'rifle'): Pnt3D | null {
  const i = skeleton.indexOf(item);
  if (i < 0) return null;
  return transformPoint(skeleton.world[i]!, muzzle[0], muzzle[1], muzzle[2]);
}
