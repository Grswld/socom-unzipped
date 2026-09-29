import { IDENTITY, Skeleton, transformPoint, type Pnt3D, type WeaponPoint } from '@s2u/scene';

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

/**
 * The play skeleton: the body's own 26 parts (`LoadedBody.parts`, `CLIB_GEO`) and the held item's node after them,
 * under `rhand` at the identity; the body's own skeleton unchanged when it has no `rhand`.
 */
export function heldSkeleton(base: Skeleton): Skeleton {
  const parent = base.indexOf(HELD_ITEM.parent);
  if (parent < 0) return base;
  return new Skeleton(base.model, base.modelMatrix, [
    ...base.parts,
    { index: base.size, name: HELD_ITEM.name, parent, bindLocal: Float32Array.from(IDENTITY), bbox: new Float32Array(6), type: 0, flags: 0 },
  ]);
}

/** The weapon model's muzzle, in its own frame (the grip at the origin), or null when it names none. */
export function muzzlePoint(points: readonly WeaponPoint[]): Pnt3D | null {
  const p = points.find((q) => q.name === MUZZLE_NODE || q.name === 'firepont');
  return p ? [p.at[0], p.at[1], p.at[2]] : null;
}

/** The muzzle in the model's frame through the posed skeleton: the node's world matrix carries the weapon's point. */
export function muzzleOf(skeleton: Skeleton, muzzle: Pnt3D): Pnt3D | null {
  const i = skeleton.indexOf(HELD_ITEM.name);
  if (i < 0) return null;
  return transformPoint(skeleton.world[i]!, muzzle[0], muzzle[1], muzzle[2]);
}
