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
- **W2.7 — the controller (M).** `viewer/src/gamepad.ts`: the Gamepad API polled each frame, dead zones, the PS2
  layout per W2.R5 as a data table (documented vs assumed per row), one input structure the keyboard, the touch stick
  and the pad all feed (the sprint 1 stick already does), the fly camera and the mover both driven by it; a toast
  ("Controller connected: <id>" / "Controller disconnected") in the page's own style; the mapping table shown under
  the panel. Tests: the mapping is pure and pinned; an e2e injects a fake `navigator.getGamepads` and sees the toast
  and the mover move.
- **The close (W2.9):** README, the sweep, the e2e, the Log; the PR.

## 5. Rulings

- **W2.R1** — the player is drawn as SOCOM draws it: third-person over the shoulder by default, first-person aim (§1).
  **Confirmed by the owner, 2026-09-28.**
- **W2.R2** — every number is the game's or a named placeholder (§1).
- **W2.R3** — web sprint 2 continues on the cloud branch of sprint 1 (`claude/web-sprint-cloud-8wa72q`, PR #100 grows)
  unless the owner names another branch; the sprint's rulings are `W2.Rn` in this file.
- **W2.R5** — **full controller support** (the owner's word, 2026-09-28): the Gamepad API's standard mapping read
  as the PS2 pad the launcher maps it to (Cross, Circle, Square, Triangle, L1/R1, L2/R2, L3/R3, the two sticks, the
  d-pad), the sticks and buttons meaning in the viewer what they mean in SOCOM II's own layout as the repository
  documents it (`docs/INSTALL.md` §6, `socom2_host_input.cpp`: the sticks move and look; L1/R1 aim and fire; L2/R2
  lean; Triangle the stance, a PC pad's crouch on L3 as the launcher's shortcut), the fly camera and the walk driven
  by one mapping (the same stick is the same motion in both; jump is "up" in the air of the fly camera, crouch is
  "down"), and a toast when a controller connects or leaves, naming it. A binding the repository does not document
  is marked assumed in the mapping table.
- **W2.R6** — a game file's values transcribed into source are extracted data (the PR template's first checklist row),
  whatever their form: tuning tables are read from the disc at run time (`READERC.ZAR` beside the maps or in the ISO),
  the source carries only what a research note already prints as a named default, and the page says which it runs on;
  the controller's own instruction to embed `dynamics.rdr`'s 87 fields is withdrawn and the commit that did it is not
  carried (the cloud controller, 2026-09-28, W2.3a).
- **W2.R4** — the default target is the SEAL model (`seal_A_scuba` with the `seal_scuba_*` fittings) and the
  **M4A1 SD** (`m4Acarbine_sd` in `WEAP_MDL`) -- the owner's word of 2026-09-28; the other side's body `al_gman01` and
  the sidearm `baretta_m9` are the controller's defaults after it (the owner can overturn by number).

## 6. Findings recorded during the sprint

*(dated, newest last)*

### The motion format: one reader for all 341 clips; the player is not `zAnimObjectMotionBegin` (2026-09-28, W2.2a)

Every clip -- `MOTION_S.ZAR`'s seven victory clips, identical on all 22 maps, and `MOTION_P.ZAR`'s 334 -- reads with one
layout (`web/docs/research/77-motion-format.md`): 30 keys a second, per-part quaternion channels, translations at 1/256
of a unit (the constant offsets reproduce `seal_A_scuba`'s bind nodes within a step, so the clips carry the SEAL
skeleton's bone lengths; on `al_gman01` they are up to 44 steps out), the bind rows reproduced as three.js reads them
with no conjugation or axis swap. The upper-body clips (`seal_p_*`, `seal_pfp_*`, `seal_mv_*`: 14-16 parts, no root or
legs) layer over the full-body ones. Cycles by name (frames): `seal_stand` 16, `seal_walk` 25, `seal_jog` 22,
`seal_run` 19, `seal_crouch` 21, `seal_crouchwalk` 28, `seal_prone` 10, `seal_jump` 20, `seal_runningjump_launch` 25,
`seal_runningjump_in_air` 14, `seal_land_soft` 20, `seal_land_hard` 20, `seal_recoil` 2, `seal_reload` 45, the `_fp_`
first-person set. Playback lives in `READERC.ZAR`'s `motion.rdr` (398 entries: `looped`, `playback`, `max_velocity`,
`BlendTime`, `zanim_callback` -- the motion calls the zAnim animation, e.g. `seal_jump` → `jump_whoosh` at 0.4; 24 of
26 callback names are CZANIM animations); the victory clips are one-shot. `zAnimObjectMotionBegin` 0x262690 is zAnim's
OBJECT_MOTION begin hook, not the skeletal player, and its command is at least 0x80 bytes where reCOM's `0x13` type is
20 on all 1,777 uses; blend-or-hold between keys is `FUN_0028c4f0` / `FUN_0028c380` / `FUN_0028c250` (called from
`Tick_0` at 0x57a818-0x57a82c), with `FUN_00289bb0`, `FUN_0028d670`, `FUN_0028a100`, `CZSIObject_Read` 0x289380
beside them -- not on hand, so `MOTION_BLEND` is slerp on the shorter arc, named. Research 25's in-memory "walk" keys
are `seal_run`'s root byte for byte.

### The character mesh, the skeleton and the gear (2026-09-28, W2.1)

`CLIB_MDL`'s CMesh chain decodes on all 22 maps with no failure (411 meshes, 671,131 vertices, 485,725 triangles,
24,061 batches; `web/docs/research/78-character-mesh-and-skeleton.md`): the head quadword's low u16 is the tag count
(= `ref_count`); per batch one reloc-9 matrix tag whose ADDR is the palette slot, one reloc-10 bone list per bone
(VU1 `0x52`'s input), then one reloc-11 draw packet (indices, the two GIFtag templates PRIM 125/123, uvs; no colour,
no face normal). The bind palette reproduces every vertex's per-bone copies to 0.0017. `zdb_CSubMesh_Read`
(0x3b8c20) reads one u32 into `this+0x68` (`matrix_id`, by elimination) and tail-calls `zdb_CVisual_Read` 0x3c3570:
the EE reads no vertex, bone or weight lane. `CLIB_GEO`'s skeleton has 26 palette slots: the 25 parts under `skel_root`
(`hips`, `rthigh` … `lhand`, matching research 50's 25 pointers and `character.rdr`'s `body_items`) and `body`, a
sibling at the origin; slots 0, 10 (`aimnodes`) and 25 carry no vertex. `READERC.ZAR`'s `character.rdr` is the game's
gear table and `chartype.rdr` names each map's player: Frostfire's `mp2_seal1` is `seal_A_scuba` in six pieces (the
eyes on the head, the holster on `rthigh`, the assault gear on `hips`, the knife on `rcalf`, the satchel on
`spinehi`; no goggles -- those are `mp2_seal3`'s); gear offsets turn Rz·Ry·Rx about fixed axes in the character's own
frame. The gear (`FLIB_MDL`) and the weapons (`WEAP_MDL`) use VU1 command `0x70`'s scaled positions (ITOF15 ×
`TOP+3.w`, `interpretScaledChain`); SEMANTICS §3 calls `0x70` "the character-model unpack", which it is not. The
model's eye line is 18.16 over the feet in the bind pose (crown 19.43); W1.R2's 15.4 is research 17's camera target
over a lowered root, so the walk keeps 15.4 for its view and the body's eye is 18.16. The four-influence cut is exact
in the bind pose and drops up to 0.151 of a weight posed (1,257 vertices with five or six influences). Two named
placeholders: the colour lane (an EE upload, data quadword 338, not on disc; unity as all 916 gear vertices store)
and the lighting (the map's `GlobalLighting` rig). reCOM slips: `hookupMesh` fetches `mtx_count` under the `_START`
key and indexes the buffer as u32s (`vis_main.cpp:49-51`); `CVisual::Create`'s switch has no breaks (`:253-260`).

### The pad layout against the repository (2026-09-28, W2.7)

Of eleven rows four are documented (the sticks, `mapping.h:25-27`, `socom2_host_input.cpp:297, :336`; L3 and
Triangle for crouch, `docs/INSTALL.md` §6, `PLAYTEST.md` step 8, `launcher_config.cpp:568`,
`host_crouch_shortcut.h:4-7`) and seven assumed. Two of W2.R5's readings are contradicted by the tree: the repository
documents the game's L2 as the second-weapon swap (`launcher_config.cpp:572`, `host_crouch_shortcut.h:13-14`), not a
lean, and the fire mode on L3, not Circle; aim on L1 has no support (`socom2_host_input.cpp:297` puts fire on L1/R1
without saying which). The rows stay as the ruling says, marked assumed with the contradiction in the note, until the
owner rules. The runtime's dead zone is 0.15 per axis (`host_gamepad_select.h:70-79`); the viewer's is radial at the
same size.

### The seal table's file, and what the two tick bodies are (2026-09-28, W2.3a)

`dynamics.rdr` in `RUN/READERC.ZAR` is the seal tuning table's source, 87 fields, and reCOM's `CharacterDynamics`
(`zCharacter/zchar.h:145-249`) falls on research 17 §8's offsets +0x00 to +0x188 exactly; the metre fields are ×10 in
memory (`low_climb_height` 1.3 → a 13-unit crate), `max_slope` is 50° in the file and its cosine in memory, `throt_exp`
(+0x118) and `cam_look_dwell` / `cam_net_*` (+0x160-0x168) are not in the file, and +0x30-0x38 is `m_landSpeed[3]`
computed from the fall distances (`char_dyn.cpp:32-35`). Research 17's nine printed values match the file. Values it
did not print, recorded here as measurements (not in code, W2.R6): `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` 6.2 / 9.1 / 12 m,
`low/med/high_climb_height` 1.3 / 2.15 / 2.65 m, `min_stand_height` 1 m, `min_jump_height` 2 m, `turn_maxrate` 2,
`stand_turn_factor` 2.3, the accel limits 2 / 5 / 2 / 5, `fb_accel` and `lr_accel` 0.01. **The camera triples (W2.6):**
`cam_back` height 20.5, dist 13, side 0, aim (0, 20.5, −2); `cam_first` the same; `cam_full` 20.5 / 30 / 0;
`cam_tether_stiff` 0.95 -- against research 18's measured 23.1-unit ring and 25 up at the spawn, so the triple is not the
whole of the camera. `motion.rdr`'s `max_velocity` (run 6.5, run back 3.7, strafe 6.5, crouchwalk 1.48, prone strafe
0.55) × 10 is 1.4-1.6× research 18's measured holds (40 / 25.3 / 44.3), so it is not simply the ground speed (W2.2b).
`SealProcessAltitude` (0x5b5d40) is the probe's selection only and `Tick_0` (0x57a330-0x57b510) the SEAL's
animation-and-look tick; neither reads a table field, and the jump, the gravity step, air control and the crouch height
are in neither. The console's root lift (research 17 §1's 5.504) + 1 = 6.504 = `step_height` to 0.004. Under the
speed reading every walk-off lands at 61.3 or more (at least "hard"), so the landing rates are probably not compared
with that speed. The Bash guard misreads a `git commit` whose `-m` argument holds a newline as a commit without paths.

### The weapons' form, the fire point's inputs, and the table that is not on the disc's readers (2026-09-28, W2.4)

Weapons (`WEAP_MDL`), fittings (`FLIB_MDL`, 10 of 10 nodes) and turrets (`TURR_MDL`, 35 of 35 on Crossroads) use VU1
`0x70`'s position form, `int16 / 32768 × TOP+3.w` (every visual node lands inside its own `nparams` bbox that way and
none the other; `TOP+3.xyz` is zero in every such packet); the world and the props use `0x68`'s `int16 / 16 +
TOP+3.xyz`. The `WEAP_*` members' bytes differ between maps (MP6 and MP61 repack the vertices of 24 and 26 weapons,
MP8, MP52, MP71 of 11) while the triangles are the same everywhere; the M4A1 SD has 1,067 vertices on MP6 against
1,107 elsewhere. `GetPutativeFirePointW` (0x57fa70-0x57fce0) reads the stance list at `*(+0x1c0)` (the byte at +0x2b of
each entry, top-down, skipping 3), the actor state `(short)+0x174` (state 3 splits on `(signed char)+0x375 == −1`),
`m_velM` at +0x2c (moving: |v|² > 400, z ≠ 0, |x/z| < 0.5) and `m_item` at +0xf79; `a1` true takes one of ten constant
offsets (0x65d038-0x65d0c8, 16 bytes apart) through `m_node`'s matrix (`FUN_003085c0`), false the cached point at
+0x14b0 plus the position at +0x1c (`FUN_00309240`); `a2` picks the second row of three offsets for stance codes 0-2.
The ten offsets and the zero point at 0x3f64c0 are ELF data (176 bytes) not in the handoff. `CTFireWeapon_Parse`
(0x5dc800, `Parse__12CTFireWeaponFP5_zrdr`) is the AI script's FireWeapon task parser beside `CTMove`, `CTLookAt`,
`CTStance`, `CTFireMode`: it allocates a 0x2c-byte node and reads one argument. No weapon table is in `READERC.ZAR`
(56 compiled scripts), `MOTION_P.ZAR` or the 22 archives; if SOCOM II keeps SOCOM 1's layout the fields are reCOM's
`CZWeapon`, `CZWeaponStance` (the reticle knock and rifle kick), `CZFTSWeapon` and `CZAmmo` (research 79 §1.2).
`dynamics.rdr` holds the aim limits: `init_aim_pitch` −9.167, `max_aim_pitch` 60, `min_aim_pitch` −70, `max_aim_yaw`
85, and `CAMERA_WIGGLE` (amplitude 22, duration 0.6, rate 0.1). The body's recoil is a motion clip (`seal_recoil`,
`seal_crouch_recoil`, `seal_prone_recoil`, `seal_p_recoil`, `seal_p_prone_recoil`; `looped 0`, `transition_speed_B`
0.1); `Recoil__10CZSealBodyFv` is among the demo's twelve largest functions (research 49 §5), so it is not a small
helper, and its r0001 twin is unnamed.

### The clips on the mover, the camera rig, and the crouched target behind 15.4 (2026-09-28, W2.2b, W2.6)

`viewer/src/animator.ts` picks the clip from the mover's state and blends over `motion.rdr`'s `BlendTime` (a 2s²
cross-fade that matches research 17 §4.2's traced weights to the third decimal for the first seven samples); the speed
bands are `motion.rdr`'s `transition_speed_A/B` × 10 when read, else `BAND_PLACEHOLDERS`; cycles are rate-matched so
the root travels the mover's distance, other clips play in `playback` seconds; `seal_p_*` layers over the legs when the
weapon is a pistol (`seal_p_stand` carries 27 parts and replaces the whole clip). The clips' own root speeds (units/s):
`seal_walk` 17.9, `seal_jog` 30.8, `seal_run` 57.7, `seal_walk_bw` 32.5, `seal_run_bw` 33.7, the strafes 14.8 / 14.6,
`seal_crouchwalk` 13.0, `seal_crouchwalk_bw` 10.1 -- each inside its `transition_speed` band × 10; research 18's
measured 44.3 strafe is three times the strafe clips' own speed. The landing clips move their roots about 3.3 forward.
Root motion is not applied to the mover (`Tick_0` lines 7792-7898 are the carry). **Research 17's 15.38 is a crouched
camera target:** its root 5.50391 is exactly 1409/256, the crouch clips' constant root height, and its "bind height"
11.4845 is `seal_stand`'s root (2940/256); research 17 §4.1's standing target is 21.485 = root + 10. The walk keeps
its 15.4 eye (W1.R2 stands as the walk's view); the shoulder rig rides the posed root and the aim view uses the posed
body's eyes (18.16 in the bind pose, 17.81 in `seal_stand`). **The camera rigs:** the measured rig (`CAM_BACK_MEASURED`,
25 up and 23.1 back, the aim point 21.485 up and 1.273 ahead per research 17 §4.1 row 0) orbits its aim point at
24.6, near research 18's 24.9, and is the default; the disc's `cam_back` (20.5 up, 13 back, side 0) is a panel switch
offered once `dynamics.rdr` is read, with `cam_tether_stiff` 0.95 (at +0x15c) read as the part of the gap closed each
60 Hz tick; `cam_first` on this disc is identical to `cam_back`, so the aim view is not it. The camera ray collides with
the hull including `m_cameratype`'s bit-18 polygons. `pose()` stays the fly camera (the look and the walk's eye);
`stats().camera` reports the drawn one (`third` / `aim` / `fly`). Not done: the first-person arms (`seal_fp_*`), the
relighting of a pose's own limb turns (only the body's facing is relit, every 10°), the weapon in the hand (the held
weapon is hidden in the shoulder view until then).

### The rifle in the hands, the Fire set, the kick and the satchel (2026-09-28, the WEAPON workstream)

*(the owner's playtest: "no weapon model visible"; "shooting should engage a second animation where the rifle goes
up"; "the SEAL has a backpack and usually only has one when he has the bomb")* **The hand.** `CZSealBody`'s
constructor (decomp lines 419640-419690) looks up the 25 parts in reCOM's order (`+0x2fc` spinelo, `+0x300` rhand,
`+0x304` hips), sets `m_item` (`+0xf79`) to 1 and calls `FUN_00553290` 0x553290 for slots 1 and 2: a fresh `CNode`
named "rifle" (0x65c498) or "pistol", added to the body (`FUN_0028ebe0`) under `rhand` when that item is in hand,
else under its carry part (`spinelo` for the rifle, whose offset there is `character.rdr`'s "rifle" gear,
`NONAME.flt`, found by `FUN_0058b0f0`); a "weapon" node and "rifle_out" are made beside them. The pack's clips pose
the node: a `rifle` track (constant `(1.266, 0.258, -0.148)` from the hand in most, turned through the run) or, in
`seal_jump`, `seal_runningjump_in_air`, `seal_prone_crawl` and `seal_crouch_recoil`, the SOCOM 1 name `weapon`
with the same key. The M4A1 SD hung at the node's identity (its grip at the origin, research 79 §2.2) has its barrel
along the body's forward to within 2° in `seal_fp_stand`, the sight 15.2 over the feet at the cheek and the left
hand under the fore-end (MP2's skeleton; `viewer/test/weapon.test.ts`). **The fire point** is the posed weapon's:
`FUN_005a60d0` looks up the model's "aimpoint"/"firepoint" into `+0x14ac`/`+0x14bc` and the body keeps their places
at `+0x14a0`/`+0x14b0`, the second path of `GetPutativeFirePointW` (a1 false) -- so the round leaves the muzzle
toward the point under the reticle. The ten stance offsets at 0x65d038 are zero in the image's `.data` (filled at
run time), so the first path stays `shot.ts`'s placeholder. **The Fire set.** `FUN_005e0690` pairs twelve anim types
with a Fire version (`FUN_005e1bf0`, entry +4 of the table at `animset+0x5c`, lines 494790-494801): Stand, Walk,
Jog, Run, Walk/Jog backwards, Step, Crouch, Crouch walk, Crouch step, Crouch walk backwards, Prone -- `animset.rdr`
names them `seal_fp_*` ("fp" is the fire pose, not first person); the strafes and jumps have none. `Tick_0` (lines
438828-438860) blends the Fire version into each flagged motion slot at `FUN_00286b80(seal+0x1160)`, an eased
envelope (in, hold, out, remaining) that `FUN_005dfe30` starts with `FUN_005dffc0`'s 0.1 s in, 100000 s hold and
0.5 s out and cuts to a fall from its level; the player control (`FUN_00594cf0` lines 453577-453650) raises it on the
fire button's press or hold and asks it down when a countdown -- reset to `ctrl+0x22c` = 5.0 s (`FUN_00598280`) at
every edge and while the controller aims -- has run out. **No recoil clip**: the image holds no "recoil" type name
(only `RecoilPct`), so `animset.rdr`'s "Rifle recoil" → `seal_recoil` is never asked for. **The kick** is on the aim:
per round `FUN_005b91c0` seats the rest at the pitch and a goal of `FireRifleKickBaseDist` + `RandomDist` × rand;
`FUN_005b9280` (behind `DAT_00650938`, 1 in the image's `.data`) climbs the pitch (`ctrl+0x130`, radians: the
aim limits `FUN_00594600` clamps it to are stored ×0.017453292) at `FireRifleKickRate` and lets it back at
`FireRifleKickReturnRate` -- the M4A1 standing 0.09-0.105 rad at 0.5 rad/s, back at 0.18; each round re-seats the
rest, so a held trigger climbs about 0.06 rad a round at `FireWait` 0.12. **The reload** is its clip: "Rifle reload"
`seal_reload` (`motion.rdr` playback 1.6 s), crouch 1.9, prone 1.7, "Moving rifle reload" `seal_mv_reload` 1.2 (an
upper-body overlay); the M4A1's record has no `ReloadTime`. **The muzzle's effect** is `FireAnimName`, a CZANIM
animation: `muzzle_m4` is `shell_eject`, `flash_fire_hider`, `shell_smoke_med`; `muzzle_m4SD` is the shell and the
smoke, no flash; the `_zoom` variants carry `zoom_flash_fire` for the first-person view, where no weapon model is
drawn. **The satchel** is `mp2_seal1`'s default gear, hung and then hidden: `FUN_00599f00` dresses the SEAL
(`FUN_0058b790` per piece) and calls `FUN_0059df60(seal, 0)`, which finds the gear "Satchel" (0x65f0f8) and turns
it off through its node's `vtbl+0x38`; the inventory's bomb pickup (`FUN_005bbf10`, item 0x9a) calls
`FUN_0059df60(owner, 1)`, and the plant, the drop and the round's reset hide it again. Implemented in
`viewer/src/heldItem.ts`, `weaponRaise.ts`, `weaponPose.ts`, `rifleKick.ts`, `bodyView.ts` (`HIDDEN_AT_SPAWN`,
`setGearVisible`); named readings: the Fire clip's phase on locomotion cycles (`PHASE_SHARED`), the reload's 0.2 s
blend (`RELOAD_BLEND_PLACEHOLDER`), the aim lane as the controller's aim (`AIM_HOLDS_RAISE`), no stick term in the
kick's fall (`STICK_FOLLOW_PLACEHOLDER`).

### The sidearm, the swap and the reload (2026-09-29, the WEAPON workstream, round 2)

**The kit.** Every `mp_seal1` (and Frostfire's `mp2_seal1`) kit in `character.rdr` is M4A1, Mark 23, M67, HE, then
Double Ammo Load or C4 (`kitWeapons`); the Mark 23 is `ID` 15, `a_mark23`, `FireWait` 0.2, 12 x 3 of .45 ACP (`Piercing`
4), `MaxFireMode` 1, one zoom mode, 125 m, knock 20/60/40, bloom 20 on 10..30 (prone 14..34), `muzzle_mark23`,
`.MARK_23`/`_M`/`_F`, `.MARK_23_RLD`, `RecoilPct` 0.1 (`HELD_SIDEARM`, pinned to the file). **L1 and L2** (`FUN_00594cf0`
453288-453312) press the slots at `ctrl+0x224` and `+0x228`, 0.0 and 1.0 from the constructor (`FUN_00598280`
454785-454786): the primary and the sidearm; the grenades are the Inventory's (R2). The gate (`FUN_005a8cb0`,
`FUN_005bdc30`, the slot's count, `FUN_005c4fd0`, else the denied sound `FUN_003419c0`) and `FUN_005c4b10`: the slot in
the hand does nothing (no toggle back), a scope drops to first person, a change of category starts the swap
(`FUN_005c50b0` -> `FUN_005c1660` -> `FUN_005a64c0`, the MOTION workstream's `WalkMode.swapWeapon`); refused while
reloading, mid-swap, throwing, in the air. **Rifle to pistol:** `FUN_005a7260` re-parents the rifle to `spinelo` and
sets `m_item` 2 at once (`FUN_0057d5e0` turns the playing clips to their pistol versions); `FUN_005a7730` moves the
pistol to `rhand` at the clip's hand-off (0.72 standing, 0.82 crouched, 0.62 prone, 0.79 the moving overlay --
normalised phase, not settled); at the end `FUN_005a60d0(seal, 2, 0)` slings the rifle at `character.rdr`'s "rifle"
offset on `spinelo` (0.1, -1.39, -0.66; 48, 112.9, -33.98). The swap clips carry the rifle `spinelo`-relative (the
muzzle ahead of the chest at key 0, on the back at the end: measured on MP2's skeleton) and the pistol `rhand`-relative.
**Pistol to rifle:** the clip backwards; `FUN_005a75d0` holsters the pistol on `rthigh` at the "pistol" offset (1.03,
-0.23, -1.03; -9.9, -186.5, 197.07) as the clip passes the hand-off going back; at the end `FUN_005a70f0` puts the rifle in
the hand, `m_item` 1. At spawn the pistol hangs on `+0x304`, `hips`, at the identity. The pistol-fire pairs
(`FUN_005e1af0`) are `seal_pfp_stand` ... `seal_pfp_crouch_step` (the strafes and 90-degree runs map to the pistol's own);
the pistol's reloads `seal_p_reload`, `seal_p_crouch_reload`, `seal_p_prone_reload`, `seal_p_mv_reload`. **The reload.**
Every start goes through `FUN_005c2a90` after the weapon spec's `ReloadDelay` (`+0x5c`, 0.01 by default); the magazine
empties -> an automatic reload 0.01 s on (`FUN_005c5340` 479297-479320), not for grenades; a dry trigger plays the empty
click and reloads. `FUN_005a82e0`: still is a speed of at most 20 (400.0 = 20², hard-coded; `min_running_reload_speed`
is loaded and never read) -- standing or crouched still the stance's reload, moving the `Moving ... reload` overlay,
prone always the prone reload; with a `ReloadTime` the still clip's rate is its duration over it. **The magazine is
refilled at the start** (477483) and the old one keeps its rounds in the kit's ten-slot ring; the reload sound plays
at the start; no round leaves during any reload (`FUN_005a7de0` via `FUN_005a7ab0`); walking out of a still reload turns
it into the moving overlay at the same normalised time (`FUN_00550ef0` 418205-418224); nothing is lost. No magazine
model moves (`gear_mag01` is static on `lthigh`). **First person:** the frame renderer `FUN_001ebed0` (50823-50842)
hides the camera target's whole scene node (`body+0x28`, the weapon under its bones) for the world pass whenever the
camera is in mode 3 -- every zoom state from 1 up (`FUN_001f1610` -> preset 2 -> `FUN_0029b0c0`): no body, head, arms
or weapon, and no view model; a round zoomed plays the weapon's `%s_zoom` muzzle animation (`FUN_003d22b0`, `def+0x88`)
at the weapon's firepoint. **The accuracy pip** (`FUN_005aa6e0` 464290-464350, `FUN_00215250` 69706-69770): while the
raise envelope is up or coming down, the ray from the fire point to the aim point is cast; a hit short of it (0.008)
is projected and kept as an offset from the reticle's centre; the HUD shows `ret_accuracy` there unless both offsets
are within the drawn size (signed), fading 32 a frame to 128, pulled in to 200 px only scoped. Implemented in
`viewer/src/kit.ts`, `heldItem.ts` (`PISTOL_ITEM`, `mountMatrix`), `play.ts` (`setSidearm`, `setItem`, `setMounts`),
`weaponPose.ts` (`PISTOL_FIRE_VERSIONS`, `PISTOL_RELOAD_CLIPS`, `RELOAD_STILL_SPEED`), `fire.ts` (the magazine ring,
`RELOAD_DELAY`, `dry`, `setWeapon`, `blockedMuzzle`), `reticle.ts` (`stepPip`), `body.ts` (`carries`).

