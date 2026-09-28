# Web sprint 2 — "the player" (design)

> The browser project's second sprint, written 2026-09-28 17:56Z by the cloud controller on the owner's word at web sprint 1's
> close: *"Focus on jump, recoil, shoot from the right spot, next and the real moving character model."* Plan:
> `../plans/2026-09-28-web-sprint-2.md`. Previous: `2026-09-28-web-sprint-1-the-engines-world-design.md` (its §7 and §8
> stand; the tree at this write carries every task of it: the grid, the probe and walk, the disc's spawns, the ISO source).

## 1. What was asked, and how it is read

A SEAL body that is the player: the real character model, moving as the game moves it, jumping as the game jumps,
shooting from the spot the game shoots from, with the game's recoil. **W2.R1 — the player is drawn as SOCOM draws it:**
the third-person orbit camera the seal table's `cam_back` triple describes (research 18's 23.1-unit ring, 25 units up,
the same camera the 40 sweep rows recorded), and the first-person aim view when aiming; the sprint 1 walk mode becomes
the play mode, the fly camera stays. **W2.R2 — every number is the game's:** the seal tuning table (research 17 §8:
`gravity` 235, `jump_factor` 0.85, `land_fall_rate` 40, `land_hard_fall_rate` 115, `ground_touch_distance` 8,
`max_slope` 0.642788, `step_height` 6.5, the `cam_*` triples, `min_jump_height`, the climb heights), the decomp's own
functions where the owner supplies their bodies (`CZSealBody_GetPutativeFirePointW` 0x57fa70, `Recoil__10CZSealBodyFv`,
`CZSealBody_Tick_0` 0x57a330, `SealProcessAltitude` 0x5b5d40, `zdb_CSubMesh_Read` 0x3b8c20, `zAnimObjectMotionBegin`
0x262690, `CTFireWeapon_Parse` 0x5dc800), and the game's own recordings as the tests' oracles; a placeholder is named as
one in the code and the Log, tested as a placeholder, and never silently promoted.

## 2. Where it stands (the data on hand)

In every `MP*.ZDB` (the 22 on hand): `CLIB_MDL.ZED` -- the character meshes (`MESH_seal_A_scuba` … `MESH_seal_E_scuba`,
`MESH_al_gman01` … `MESH_al_captain`, 17 on Frostfire, each with `_START`, `ref_count` and `mtx_count`: the skinned form
research 72 §3 calls `vtype` 1/2, `CMesh`/`CSubMesh`, `vis_main.cpp:246-265`, hooked up through `MESH_%s` by
`hookupMesh`); `CLIB_GEO.ZED` -- `models` holding the same 17 (the skeletons and their nodes); `FLIB_MDL.ZED` -- the
fittings (`right_eye`, `left_eye`, `gear_holster`, `seal_scuba_aslt_gear`, `seal_scuba_knife`, `Satchel`,
`seal_goggles`); `COMMON/WEAP_MDL.ZED` and `WEAP_GEO.ZED` -- all 59 weapons (`m4Acarbine`, `m4Acarbine_203`,
`baretta_m9`, `a_mark23sd` …); `CZANIM.ZAR` and `MZANIM.ZAR` -- the zAnim command sets (`Anim_Main_Params`, a name
table, `Anim_Sets`); `MOTION_S.ZAR` -- seven motions (`victory_backflip` … `victory_rodeo`), the first sample of the
skeletal motion format; `EFFE_MDL/GEO`. **Not on hand:** `RUN/MOTION_P.ZAR` (the player's motions, 1,856,512 B at LBN
0xeb506, research 25), the reader file that carries the seal tuning table's values (research 17 §8 gives the names,
offsets and the values it read), and the decomp's bodies (only `recomp/socom2_names.csv` is in the tree). The owner is
asked for these in the Log's open entry; the tasks below say which step waits on which.

The engine's structures, from reCOM and the names: `CZSealBody` (369 methods; the constructor stores 25 body-part
pointers `m_root` … `m_rtoe`, research 50), `CZBodyPart::Orient` 0x28eed0, `CBody_PartInSpace` 0x2869d0,
`zdb::CMesh`/`CSubMesh` (`vis_mesh.cpp`, 44 lines in reCOM), `zAnim*` (`anim_main.cpp` 355 lines), `CZWeapon` (91
methods), `CZProjectile`, `CTFireWeapon`; the tuning table loaded by `FUN_0059ba80` through the by-name getter
`FUN_0032ea80`.

## 3. Goal and bar

**Goal:** open Frostfire, press the play key, and a SEAL stands at A's slot facing the slot's facing, seen over the
shoulder as the game shows it; walk, run and jump on the game's floors with the game's gravity; aim, and the shot leaves
the spot the game computes, the reticle kicking as the game kicks it; the body runs the game's own motion clips.

**The bar:** (1) every task lands with a failing test first and a number from the game's record; (2) typecheck, test,
build green at every merge, the e2e green at the close; (3) the character mesh decodes on all 22 maps' libraries with
no diagnostic, and every weapon of `WEAP_MDL`; (4) the motion format reads every clip of `MOTION_S.ZAR` on all 22 maps
and, when it arrives, every clip of `MOTION_P.ZAR`; (5) the physics reproduces the table: a fall lands at
`land_fall_rate`, a step of `step_height` is climbed, a slope past `max_slope` is not, a jump reaches the game's height
once its impulse is known (a placeholder until then, named); (6) the fire point and the recoil are the decomp's once its
bodies are supplied, else a placeholder named and the task carried; (7) nothing regresses on the sweep.

## 4. The batch

- **W2.1 — the character mesh, static (L).** `@s2u/mesh` gains the skinned chain form (`CMesh`/`CSubMesh`, `vtype` 1/2,
  the `mtx_count` matrices, the vertex lanes' bone indices and weights) and `@s2u/scene` the skeleton from `CLIB_GEO`
  (the 25 parts' nodes and bind matrices); the viewer draws `seal_A_scuba` in its bind pose at A's slot, facing the
  facing, with its fittings; a diagnostics count per library. Test: every `MESH_*` of every map's `CLIB_MDL` decodes;
  the vertex count and the bounds of `seal_A_scuba` are pinned; the bind pose stands on the floor (feet at the slot's
  y, the eye 15.4 up per W1.R2 within a unit). *Waits on nothing; `zdb_CSubMesh_Read`'s body, if supplied, shortens it.*
- **W2.2 — the motions (L).** The skeletal motion format from `MOTION_S.ZAR`'s seven clips (every map has them; a clip
  plays on the bind skeleton of W2.1), the zAnim sets of `CZANIM.ZAR` read to their name tables and command sets
  (`Anim_Sets`); playback at the game's tick with the clip's own rate; then `MOTION_P.ZAR`'s cycles (idle, walk, run,
  crouch, jump, aim) driven by the mover's state. Test: every clip of `MOTION_S.ZAR` decodes on all 22 maps with its
  frame count and bone set pinned; the victory clip plays without a NaN; *the second half waits on the owner's file.*
- **W2.3 — the physics (M).** The mover gains the table: gravity 235 units/s² (a fall instead of the 20-unit refusal of
  W1.4), `land_fall_rate`/`land_hard_fall_rate` as the landing thresholds, `step_height` 6.5, `max_slope` 0.642788 (50°),
  `ground_touch_distance` 8, the crouch stance; the jump as `jump_factor` × the impulse the decomp gives (`min_jump_height`
  as the bar) -- *the impulse waits on the owner's decomp or a 60 Hz trace of a standing jump; until then a named
  placeholder that reaches `min_jump_height`.* Test: the fall off Frostfire's deck (research 24 §7.4, 42 units) lands;
  the kerb is stepped and the 50° slope refused; the jump's apex against the trace when it comes.
- **W2.4 — the weapon in hand and the fire point (M).** `WEAP_MDL`'s `m4Acarbine` (and `baretta_m9`) decoded in the same
  form as the props or the characters (the task says which), attached to the hand part; the fire point per
  `GetPutativeFirePointW` -- *waits on its body; until then the muzzle node of the weapon model, named as the
  placeholder.* A shot draws a tracer from the point along the aim and the hit on the hull (the probe's polygons).
- **W2.5 — the recoil (S/M).** Per `Recoil__10CZSealBodyFv` and the weapon table `CTFireWeapon_Parse` reads -- *waits on
  the bodies and the weapon `.rdr`; until then the aim's kick is a named placeholder.*
- **W2.6 — the game's camera (M).** The third-person orbit camera from the `cam_back` triple (side, height, dist) and
  `cam_tether_stiff`, `cam_look_dwell`; the aim view from `cam_first`; the sprint 1 pose e2e updated. *The triple's
  values wait on the table's file; research 18's 23.1 and 25 stand in, named.*
- **The close (W2.9):** README, the sweep, the e2e, the Log; the PR.

## 5. Rulings

- **W2.R1** — the player is drawn as SOCOM draws it: third-person orbit by default, first-person aim (§1).
- **W2.R2** — every number is the game's or a named placeholder (§1).
- **W2.R3** — web sprint 2 continues on the cloud branch of sprint 1 (`claude/web-sprint-cloud-8wa72q`, PR #100 grows)
  unless the owner names another branch; the sprint's rulings are `W2.Rn` in this file.
- **W2.R4** — the default target is the SEAL model (`seal_A_scuba` with the `seal_scuba_*` fittings) and the
  **M4A1 SD** (`m4Acarbine_sd` in `WEAP_MDL`) -- the owner's word of 2026-09-28; the other side's body `al_gman01` and
  the sidearm `baretta_m9` are the controller's defaults after it (the owner can overturn by number).

## 6. Findings recorded during the sprint

*(dated, newest last)*
