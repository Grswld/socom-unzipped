# Web sprint 2 — "the player" — implementation plan

> Spec: `../specs/2026-09-28-web-sprint-2-the-player-design.md` (§4 the batch, §5 the rulings W2.R1-R4). Written
> 2026-09-28 17:56Z by the cloud controller against the sprint 1 close (`c09408f`, 480 tests in 43 files). Status: **CLOSED 2026-09-28** on the cloud branch
> `claude/web-sprint-cloud-8wa72q` (PR #100 carries both sprints; the owner's merge is the merge). The Log at the foot
> is the record, newest first.

**Goal:** a SEAL body that is the player -- the real mesh, the game's motions, the game's jump, the shot from the game's
fire point with the game's recoil -- seen as the game shows it.

## Global constraints

The sprint 1 plan's constraints stand (tests first, the RED/GREEN report, explicit pathspecs, no game bytes in the tree,
the controller merges). Staffing: Opus implementers in full clones `/home/user/wt-web-s2-<task>` on `agent/web-s2-<task>`
(push disabled), the data symlinked in; the controller reviews, merges, runs Playwright and the sweep. Every number from
the game's record or a placeholder named as such (W2.R2).

## What the owner is asked for (the open entry has the ask)

1. `RUN/MOTION_P.ZAR` (the player's motions) and the reader file holding the seal tuning table (`grep -rl jump_factor
   game/disc/RUN`), beside the maps on the site or at a private URL -- W2.2's second half, W2.3's jump, W2.6's triple.
2. The decomp's bodies, privately (never committed): `CZSealBody_GetPutativeFirePointW` 0x57fa70,
   `Recoil__10CZSealBodyFv`, `CZSealBody_Tick_0` 0x57a330 (the jump impulse and the gravity step), `SealProcessAltitude`
   0x5b5d40, `zdb_CSubMesh_Read` 0x3b8c20, `zAnimObjectMotionBegin` 0x262690, `CTFireWeapon_Parse` 0x5dc800 -- W2.1
   (shorter), W2.3's jump, W2.4, W2.5.
3. Recordings from the game as oracles (60 Hz actor and camera): a standing jump, a run, a five-shot burst with the
   M4A1 and the M9 (the fire point and the aim per frame).
4. The branch (W2.R3) and the rulings W2.R1, R4 to confirm or overturn.

## Task table

| # | task | package | size | waits on | status |
|---|---|---|---|---|---|
| 1 | the character mesh, static, in the bind pose | mesh, scene, viewer | L | -- | DONE (`c636a8b`) |
| 2a | the motion format from `MOTION_S.ZAR` + the zAnim sets | scene | L | -- | DONE (`5279e15`) |
| 2b | `MOTION_P.ZAR`'s cycles on the mover | viewer | M | 1, 2a | DONE (`ab3bf4d`) |
| 3a | gravity, fall, step, slope, crouch from the table | viewer | M | -- | DONE (squashed; W2.R6) |
| 3b | the jump impulse | viewer | S | 3a | folded into 3a (the bodies are on hand) |
| 4 | the weapon in hand and the fire point | mesh, viewer | M | 1 (the hand) | DONE (`0cec524`; the table absent on hand, the hand after 2b) |
| 5 | the recoil | viewer | S/M | 4, the owner's decomp | CARRIED (not in the bodies on hand; `seal_recoil` and `CAMERA_WIGGLE` the leads) |
| 6 | the game's camera | viewer | M | 1, the table's file | DONE (`ab3bf4d`; the measured rig the default, the disc's a switch) |
| 7 | the controller: the Gamepad API on the PS2 layout, fly and walk alike, the toast | viewer | M | -- | DONE (`ec2ec81`) |
| 9 | the close | docs | S | all | DONE (the close entry) |

## Log

*(newest first; `date -u` for every stamp)*

- **2026-09-28 19:56Z** — **CLOSED.** Task 2b + 6 merged `ab3bf4d` (agent `196edc5` + `537c07f`, Opus, 41 min; two conflicts with
  Task 4 resolved by union, the held weapon hidden in the shoulder view until the hand carries it). **The tree at the
  close:** 802 tests in 65 files (311 at sprint 1's open, 480 at its close), typecheck and build clean; the e2e here on
  a fresh dev server **10 passed** across five specs (`play` 1 -- walk at A, `seal_stand`, a walk/run clip while W is
  held and the feet moving, the jump airborne, a shoulder-view screenshot; `walk` 1; `pad` 1; `viewer` 5; `iso` 2); the
  22-map sweep **identical row for row to sprint 1's close** (`test-fixtures/health-s2-close.txt`). The shoulder view
  photographed and sent to the owner (`test-fixtures/screens/play/frostfire-play-shoulder.png`). **The bar (spec §3):**
  (1) every task with a failing test first and a game number; (2) green at every merge, the e2e at the close; (3) the
  character mesh decodes on all 22 maps' libraries (411 meshes, 0 diagnostics) and every one of the 59 weapons;
  (4) the motion format reads every clip of `MOTION_S.ZAR` on all 22 maps and every one of `MOTION_P.ZAR`'s 334;
  (5) the fall lands and is classed at the table's rates, the 6.5 step is climbed, the 50° slope refused, the jump a
  named placeholder reaching the table's `min_jump_height` (the impulse's body is not on hand); (6) the fire point is
  the decomp's with its ten offsets a named placeholder (176 bytes of ELF data), the recoil a named zero (its body is
  unidentified); (7) nothing regressed on the sweep. **Done beyond the batch:** the controller (W2.7), the disc read at
  run time for the seal table, the motion table and the camera (W2.R6). **Carried to web sprint 3, in order:** the
  weapon in the hand (the skeleton's `rhand`; the `rifle` prop part of the clips) and the first-person arms
  (`seal_fp_*`); the recoil (`seal_recoil` and `CAMERA_WIGGLE` the leads; the r0001 `Recoil` twin the ask); the jump
  impulse and root motion (`CZSealBody_PlaceLaterally` 0x5b3a60, `FUN_005b0420`, `Tick_0` 7792-7898); the fire point's
  176 bytes and the callers of `GetPutativeFirePointW`; the weapon table's file (`grep -rl WEAPON_ZAR_VERSION game/disc`);
  the blend rule (`FUN_0028c380` and the functions beside it); the pad rows still assumed (L2/R2, Cross, R1/L1) and the
  two the tree contradicts. **The owner's rows:** `READERC.ZAR` and `MOTION_P.ZAR` beside the maps on the deployed
  site (the body's gear, the seal table, the motion table, the clips; the viewer falls back without them); the two
  rulings W2.R3 (this branch, PR #100) and W2.R5's assumed rows to confirm or overturn. The handoff's disc files and
  the demo symbol table are deleted from the session at this close, as its README asks; the decomp bodies with them.
  **Spend:** twelve Opus sittings in sprint 2 (about 5.9 million subagent tokens) plus the controller.
- **2026-09-28 19:18Z** — **Task 4 DONE**, merged `0cec524` (agent `82311b8` + `3f01371`, Opus, 43 min) with a follow-up
  fix for the merge's union of `loadMap` (two drawn-texture lists → one); five conflicts with Tasks 1, 2a, 3a and 7
  resolved -- four additive, one real: Tasks 1 and 4 each added VU1 `0x70`'s scaled position form to the mesh
  interpreter under different names; the merge keeps Task 4's general `PositionForm = 'bias' | 'scale'` and
  `interpretChainPartsAs` and gives Task 1's `interpretScaledChain` as a wrapper over it. The merged tree 745 tests in
  61 files, typecheck and build clean. **The M4A1 SD** (`m4_high`: 688 vertices, 395 triangles, `m4.tif`/`mark03.tif`;
  all 59 weapons decode on all 22 maps, 212 chunks, 0 diagnostics; nodes `firepoint` at (7.79, 0.83, 0), `firepoint_shell`,
  `aimpoint`, `Gun_box`) is drawn in front of the camera lower right in walk mode (a named placeholder for the hand
  until the skeleton takes it); **the fire point** is `GetPutativeFirePointW` ported (`scene/src/firePoint.ts`: a1 selects
  one of ten constant offsets through `m_node`'s matrix or the cached point plus the position; a2 picks the second row
  for stance codes 0-2; the stance list, the actor state, `m_velM`'s moving test and `m_item` are its inputs); the ten
  offsets are 176 bytes of ELF data the handoff lacks (0x65d038-0x65d0d7, 16 at 0x3f64c0) -- `HOLD_PLACEHOLDER` stands
  in; `castRay` through the probe's polygons (surfaces with bit 18 skipped); the left button fires once the mouse is
  captured, the hook's `fire()` in Playwright, `stats().shots` and `lastShot {from, to, hit, slot}`; the shot converges
  on the crosshair's point (a reading). **No weapon table exists on hand**: `CTFireWeapon_Parse` is the AI's FireWeapon
  task parser (39 instructions, one argument), `READERC.ZAR` is 56 compiled scripts with no weapon record, and none of
  SOCOM 1's weapon keys (`WEAPON_ZAR_VERSION`, `ReticuleKnock`, `FireRifleKick`, `MuzzleVel` …) occurs in any file on hand
  -- the table is in another disc file or the ELF. **The recoil is not in the bodies**: `Tick_0`'s 51 callees write no
  aim angle; `seal_recoil` and four more clips in `MOTION_P.ZAR` are the body's kick, `dynamics.rdr`'s `CAMERA_WIGGLE`
  (22, 0.6, 0.1) a lead; `RECOIL_PLACEHOLDER` = 0. Research 79. **Asks for the owner** (research 79 §6): the 176 bytes,
  the callers of `GetPutativeFirePointW` (what a2 means), `grep -rl WEAPON_ZAR_VERSION game/disc` for the table's file,
  the r0001 twin of `Recoil` (research 49 §5 lists it among the demo's twelve largest functions).
- **2026-09-28 19:05Z** — **Task 3a DONE**, squashed into one commit (agent `8ea5f21` + `d7e852f`, Opus, 1 h 47 min with the
  rework; the branch's first commit transcribed `dynamics.rdr`'s 87 values into source and is not carried -- **W2.R6**:
  a game file's contents in source is extracted data, so the table is read from `RUN/READERC.ZAR` at run time through
  the map's own source, research 17 §8's nine printed values are the named defaults, and `stats().tuning` says `disc`
  or `defaults`); the merged tree 680 tests in 55 files, typecheck and build clean; three additive conflicts with Tasks
  1 and 7 (the hint line, the hook) resolved by union. The mover: gravity 235 and the fall replace the 20-unit refusal;
  landings classed at 40 / 115 (a reading: the vertical speed at contact); `step_height` 6.5 replaces the kerb rule
  (`BODY_LOW` 6.5, the probe origin 5.5; the console's root lift 5.504 + 1 = 6.504 is `step_height` to 0.004); a slope
  past 50° slides down its tangent under gravity (a reading); no air control (reCOM's `m_inAirHorizVel` agrees); the
  crouch on `C` with named placeholders (eye 0.65, speed 0.5); the jump on `Space` as `JUMP_PLACEHOLDER` = √(2·g·h),
  h the disc's `min_jump_height` (2 m) or 10 unread, `jump_factor` not applied. **The two bodies on hand do not hold
  the jump**: `SealProcessAltitude` is only the probe's selection (research 23 §1.1 item 9: the candidate loop at decomp
  lines 1212-1324, the 20-over-the-actor reject at 1643-1687), `Tick_0` is the animation-and-look tick (the model
  velocity from the throttles and per-stance limits at 4999-5255 or the clip's root displacement at 7792-7898, the blink
  timer, the turn) and neither reads a table field; `CZSealBody_PlaceLaterally` 0x5b3a60 and `FUN_005b0420` are the next
  bodies to ask for. Frostfire's walkway deck is railed on both long sides (research 24 §4.2 agrees), so the fall test
  uses the `pipeworks` platform's open edge (40 units onto the 100 floor, 0.5835 s, harder at 137.1) and the railing
  stop is pinned instead. The pad's jump/crouch/fire lanes (Task 7) are not yet wired to `walk.jump()`/`crouch()`: the
  play task wires them.
- **2026-09-28 18:58Z** — **Task 1 DONE**, merged `c636a8b` (agent `be5bef6` + `7b8df9f` + `f905b13`, Opus, 52 min; two
  add/add conflicts with 2a resolved: the scene index keeps all four exports, the two synthetic-ZAR test helpers keep
  both shapes as `syntheticZar.ts` (2a's) and `skeletonZar.ts` (1's)); **Task 7 DONE**, merged `ec2ec81` (agent
  `8468247`, Opus, 20 min, clean); the merged tree 651 tests in 54 files, typecheck and build clean. The SEAL photographed
  here at slot A (`test-fixtures/screens/w21/seal-{front,threeq,back}.png`, sent to the owner): 2,094 vertices, 1,523
  triangles, 7 textures, up to 5 bones a vertex, six pieces of gear, `dressedBy: character.rdr`, eye 18.16 over the feet.
  - **Task 1.** The CMesh chain decodes on all 22 maps (411 meshes, 671,131 vertices, 24,061 batches, 0 diagnostics;
    per batch one reloc-9 matrix tag whose ADDR is the palette slot, one reloc-10 bone list per bone -- VU1 `0x52`'s
    input -- then one reloc-11 draw packet; the bind palette holds to 0.0017 on every mesh); `mesh/src/skin.ts`
    (every influence kept; the four-influence cut exact in the bind pose, up to 0.151 of a weight dropped posed on 1,257
    vertices -- a carry for 2b), `scene/src/skeleton.ts` (26 palette slots: the 25 parts `skel_root` … `lhand` that
    match research 50's 25 pointers, plus `body`; the bind pose beside a settable pose for the clips),
    `scene/src/character.ts` (`READERC.ZAR`'s `character.rdr`: the gear table and each map's player from
    `chartype.rdr` -- Frostfire's `mp2_seal1` is `seal_A_scuba` with eyes, holster, assault gear, knife and satchel, no
    goggles), `viewer/src/body.ts` + `bodyView.ts` (a three `SkinnedMesh`, the gear hung off the bones, shaded through
    `materialSpec`), a "player body" switch under Advanced, `stats().body`, research 78. **The body needs `READERC.ZAR`
    beside the maps to be dressed** (`extract-maps` copies it now; without it the body is drawn bare with
    `dressedBy` saying why): the deployed tree's `maps/RUN/` wants it -- the owner's row. `zdb_CSubMesh_Read` reads
    only `matrix_id` (into +0x68) and tail-calls `CVisual::Read`; the lanes are VU1's alone. The gear and the weapons
    use VU1 `0x70`'s scaled positions (`interpretScaledChain`), which W2.4 is told. Two named placeholders: the
    colour lane (an EE upload not on disc, read as unity) and the lighting (the map's rig).
  - **Task 7.** `viewer/src/gamepad.ts`: the 16 buttons as the PS2 pad, a radial dead zone of 0.15 (the launcher's),
    `PAD_LAYOUT` as data (4 rows documented, 7 assumed, the counts pinned), `padInput` through the touch stick's
    `stickVector`, `mergeInput`, press/release edges, a `PadWatch`; the right stick looks at the arrows' rate scaled by
    the push (`camera.setLook`, the motion model untouched); Start toggles walk/fly like `G` (the game's Start leaves
    play too), R3 boosts, L3/Triangle crouch (on foot) or descend (in the air), Cross jumps or rises; fire, aim and lean
    exposed on `pad().input` and not wired (W2.4's shot and 2b's stances take them); a toast in the frame counter's pill
    (3.5 s, one at a time), the layout table under the hint line, "pad: connected" in the hint. Findings (§6): the
    repository documents L2 as the second-weapon swap and the fire mode on L3, against W2.R5's "L2/R2 lean" and the
    brief's "Circle fire mode" -- both rows stay as assumed with the contradiction noted; aim on L1 has no support in
    the tree; the runtime's dead zone is per axis, the viewer's radial. The pad e2e (`pad.spec.ts`, a fake
    `navigator.getGamepads`) runs with the close's checks.
- **2026-09-28 18:46Z** — **Task 2a DONE**, merged `5279e15` (agent `e9234f4` + `88cb40b`, Opus, 43 min): the merged tree 563
  tests in 48 files, typecheck and build clean. **One reader decodes all 341 clips** -- the seven victory clips (identical
  bytes on all 22 maps, 85-205 frames, 26 parts) and `MOTION_P.ZAR`'s 334 (1-81 frames; families `seal_*` 154, `seal_p_*`
  79, `seal_fp_*` 13, `seal_pfp_*` 12, `seal_mv_*` 6, `guard_*` 34, `death_*` 22, `civ_*` 12), all at **30 keys a
  second**, quaternion channels with the translation scale 1/256 (the constant offsets match `seal_A_scuba`'s bind nodes
  within a step), no conjugation or axis swap needed; the upper-body clips (`seal_p_*`, `seal_pfp_*`, `seal_mv_*`) carry
  14-16 parts and no root or legs, so 2b composes a pose from more than one clip; six prop parts beyond the victory
  set (`rifle`, `pistol`, `launcher`, `back`, `rifle_out`, `do_not_use`). `scene/motion.ts` (`parseMotionClip`,
  `parseMotionZar`, `sampleClip` to a plain pose by part name, `partMatrix`), `scene/zanim.ts` (`parseAnimSets`: the name
  tables, scripts, animations, node references, command streams to the byte), `tools/dump-motion.ts`, research 77.
  Findings (spec §6): `zAnimObjectMotionBegin` 0x262690 is zAnim's OBJECT_MOTION begin hook (a randomised velocity and
  spin), **not the skeletal player** -- the bodies that would settle blend-or-hold are `FUN_0028c4f0`, `FUN_0028c380`,
  `FUN_0028c250` (called from `Tick_0` at 0x57a818-0x57a82c), `FUN_00289bb0`, `FUN_0028d670`, `FUN_0028a100` and
  `CZSIObject_Read` 0x289380 -- an ask for the owner; until then `MOTION_BLEND` = slerp on the shorter arc, a named
  placeholder (4,632 adjacent key pairs are stored as −q, so the short arc is needed anyway). The zAnim sets reference
  no clips: the link runs the other way, `READERC.ZAR`'s `motion.rdr` (398 entries: `looped`, `playback`,
  `max_velocity`, `BlendTime`, `zanim_callback` -- `seal_jump` calls `jump_whoosh` at 0.4) is the playback table, 2b's
  to read; the victory clips are one-shot. `MOTION_S.ZAR` holds only the victory clips (sprint 1's spec placed the doors
  there; they are MZANIM animations). Research 25's "walk" clip is `seal_run`. A guard finding: the Bash hook misreads
  `git commit -m … -m … -- <paths>` as a commit without paths when a `-m` argument holds a newline (`-F <file>` passes).
- **2026-09-28 18:34Z** — The owner confirms W2.R1 (third-person over the shoulder) and adds **W2.R5, full controller
  support**: the pad drives the fly camera and the walk with one mapping, the game's own layout, and a toast says when a
  controller is connected. Task 7 dispatched (`agent/web-s2-pad`) beside the four running.
- **2026-09-28 18:30Z** — **The owner's handoff arrived** (a private zip, reference only, nothing of it committed; the disc
  files and the demo symbol table are deleted from the session when the format work is done, as its README asks):
  `RUN/MOTION_P.ZAR` (1,856,512 B) and `RUN/READERC.ZAR` (1,026,848 B; `grep -rl jump_factor` names it: the seal
  tuning table's file, and the menu's script sequences) placed under the ignored `public/maps/RUN/`; the decomp's bodies
  of `GetPutativeFirePointW` (0x57fa70), `Tick_0` (0x57a330), `SealProcessAltitude` (0x5b5d40), `zdb_CSubMesh_Read`
  (0x3b8c20), `zAnimObjectMotionBegin` (0x262690) and `CTFireWeapon_Parse` (0x5dc800) beside the repo as
  `research/handoff/decomp/` (excluded from git), with the naming-pipeline notes 44, 52, 55 and the demo symbol table as
  context. **`Recoil__10CZSealBodyFv` is not identified** anywhere in the project's name tables (the owner's search of
  every table and note); the lead is a helper called from `Tick_0` or the fire path near `GetPutativeFirePointW` /
  `CTFireWeapon_Parse`, or the `m_recoilParam` field reCOM's `zseal.h:576` carries -- W2.5 chases it in the bodies on
  hand before asking for Ghidra work. No recordings (a live capture; optional). W2.R1 and W2.R3 stay the owner's to
  confirm. The three running tasks are told: W2.2a gets `MOTION_P.ZAR` and the motion player's body, W2.1 the mesh
  reader's body, W2.3a the two altitude/tick bodies and `READERC.ZAR`'s table; W2.4 dispatched on the fire point and
  the weapon table.
- **2026-09-28 17:56Z** — **OPEN.** Written at sprint 1's close on the owner's word ("jump, recoil, shoot from the right
  spot, next and the real moving character model"; half the session's budget stands). The data on hand was surveyed
  (spec §2): the character meshes, the fittings, all 59 weapons, the zAnim sets and seven victory motions are in every
  map archive; `MOTION_P.ZAR`, the tuning table's file and the decomp's bodies are asked of the owner. Tasks 1, 2a and
  3a dispatched in parallel; 2b, 3b, 4, 5, 6 wait on the owner's items as the table says.
