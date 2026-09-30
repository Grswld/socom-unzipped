# 86 — Traversal: the ladder, the climb, the peek, the water

**Date:** 2026-09-28. **Scope:** the moves the walk lacked -- ladders, climbing onto and over obstacles (with the
climb icon and the jump-grab), the lean/peek, and wading -- read from the game and built into the viewer's walk
(`packages/viewer/src/traversal.ts`, `climb.ts`, `clipPath.ts`, `traversalPage.ts`, `actionIcon.ts`;
`packages/scene/src/ladder.ts`; the water in `packages/scene/src/probe.ts` / `collision.ts`).

**Sources.** "decomp NNN" is a line of `game/analysis/socom2_game.elf.decomp.c`; `FUN_`/`DAT_` are its Ghidra names.
The clips are the disc's `RUN/MOTION_P.ZAR`, the table `RUN/READERC.ZAR/motion.rdr` and `dynamics.rdr`, read with
the viewer's own readers (research 77) on 2026-09-28. reCOM (`research/recom`) names the states and the fields; it has
no ladder, climb or peek logic (declarations only). Markings: **[read]** off the decompilation, **[data]** measured on
the disc's files, **[derived]** computed from read values, **[viewer]** a choice of the viewer's, named.

## 0. The short of it

- **Everything is the polygon's `m_appflags`.** `DI_PARAMS`' three bits after `m_cameratype` (reCOM
  `zIntersect/zintersect.h:26`; surface word bits 20-22), tested as `((byte)poly[+0xA] & 0x7f) >> 4`
  [read: `FUN_002a9260` decomp 150357, `FUN_005b2620` 468399, `FUN_005b3ce0` 469133, `FUN_005b4b40` 469640,
  `FUN_005b0eb0`, `FUN_005b3890`]: **2 is a ladder, 1 and 3 climb by height, 4 is a crate (climbed only between 5 and
  32), 5 is always climbed over, 0 is never climbed.** Census of all 197,993 placed polygons of the 22 maps [data]:
  94 carry 2 (38 ladders on 14 maps, and nothing that is not a ladder), 4 is on crates, containers, pallets and low
  walls of 20 maps, 5 on MP1's and MP6's fences and boxes and three of MP81's polygons, and **1 and 3 occur on no
  multiplayer map**.
- **`dynamics.rdr`'s `low/med/high_climb_height` (13 / 21.5 / 26.5) and `min_stand_height` have no reader.** The
  loader `FUN_0059ba80` stores them at `0x44c250 +0x178..+0x188` (decomp 456970-456979) and nothing reads them; the
  climb's table is literal constants (`FUN_00580b70`, section 3.3). 13 and 21.5 are the heights the crate and medium
  clips were authored for (`refPt.y` + the root's 11.52).
- **`cam_peekl` / `cam_peekr` (side -/+70, aim (-/+30 0 0)) are dead data.** The peek camera is a literal shift of
  2.5 / 2.8 units (section 4.2).
- **The buttons** [read, `controller.rdr` Default]: **Cross is Action** (climb, the ladder's slide), **Square is Jump**,
  **the d-pad's left / right held is the peek**. The viewer's `PAD_LAYOUT` (W2.7) has Cross on jump and the lean on
  L2 / R2 -- both are the viewer's assumptions, and both differ from the game (section 7).

## 1. The clips

All from `motion.rdr` and `MOTION_P.ZAR` [data]. "Rise" and "ahead" are the skeleton root's travel from key 0 to the
last real key (the closing key is key 0 again, research 77 section 5); "seconds" is the loaded clip's `+0x10`
(section 1.1). Every climb and ladder clip carries `UseVelY` (the actor's vertical velocity is the root's) and `NoFire`.

| clip | keys | seconds | root y at key 0 | rise | ahead | `refPt` | NoInterrupt | callbacks |
|---|---|---|---|---|---|---|---|---|
| `seal_stand2ladder` | 27 | 0.9 | 11.78 | +3.52 | 6.73 | (-0.07, -11.78, -12.22) | (bare) | |
| `seal_climbladder` (loop) | 16 | 0.178 | 15.58 | +10.0 a cycle | 0 | | | `ladder_rung` at 0.01, 0.5 |
| `seal_climboffladder` | 37 | 1.4 | 17.02 | +18.91 (to 36.5 in the clip) | 8.38 | (0.265, 8.824, -5.565) | (bare) | |
| `seal_ladder2slide` | 13 | 0.5 | 20.39 | | | (0.265, 8.824, -5.565) | (bare) | |
| `seal_ladderslide` (loop) | 7 | 0.2 | 18.26 | | | same | (bare) | |
| `seal_ladderslide_land` | 37 | 1.3 | 11.44 | | -4.7 (back off) | same | 0.5 | |
| `seal_step_up` | 13 | 0.75 | 11.5 | +8.17 | 10.46 | (0, -3.48, -8) | 0.8 | |
| `seal_climbcrate` | 30 | 1.25 | 11.52 | +12.88 | 11.34 | (0, 1.48, -8.92) | 0.9 | `climb_up` at 0.1 |
| `seal_climb_medium` | 32 | 1.5 | 11.52 | +21.48 | 11.44 | (0, 9.98, -8.92) | 0.9 | `climb_up` at 0.1 |
| `seal_climb_over` | 19 | 1.0 | 10.96 | -0.96 | 16.28 | (0, -0.96, -10.28) | 0.8 | `climb_up` at 0.1 |
| `seal_stand2hang` | 25 | 1.4 | 11.52 | +6.81 | 3.49 | (0, 18.51, -5.65) | 0.85 | `jump_whoosh` at 0.5 |
| `seal_hang` (loop) | | 2.2 | 18.14 | | | | | |
| `seal_hang2climbup` | 63 | 2.8 | 18.14 | +22.59 | 5.24 | | 0.9 | `pull_up` at 0.01 |
| `seal_stand2llean` / `rlean` | 23 / 18 | 0.4 | 9.9 | | | | (bare) | |
| `seal_crouch2llean` / `rlean` | 15 / 21 | 0.5 | 5.1 | | | | (bare) | |
| `seal_prone2llean` / `rlean` | 12 / 10 | 0.8 / 0.65 | 2.2 | | | | (bare) | |

Also on hand, not played here: `seal_hang_jumpdown` (1.5 s), `seal_ledge2hang_bw`, `seal_hopdown_fw/bw` (0.4 s,
single-key poses), `seal_llean_rstep` / `seal_p_rlean_rstep` (a step while leaning), `seal_toss_llean/rlean`
(a grenade from a peek), `seal_dive2prone` (1.6 s, `dive_prone` at 0.45), `seal_slide` (6 s, the steep-ground slide
`FUN_0054edf0`, decomp 417196), the pistol's `seal_p_*` copies of all of the above.

### 1.1 `playback` and the loaded clip's length

`FUN_00287620` (decomp 131281-131320) [read]: a one-shot, or a loop whose `max_velocity` is negative, takes `playback`
as its length in seconds; a loop with a positive `max_velocity` (a locomotion cycle, the ladder's climb) takes its
own duration **divided by** `playback` -- `seal_climbladder`, 16 keys (0.533 s) over `playback` 3, loops in 0.178 s.
The same routine sets the clip's rate factor `+0x1c` to `max_velocity x 10 / 100` for a loop (0.135 for the ladder),
1 for a one-shot. A one-shot then runs from key 0 to its last key n - 1 in `playback x ((n - 1) / n)^2` seconds
(`FUN_0028c4f0`, the motion workstream's `oneShotSeconds`, research 80): `seal_climbcrate` 1.168 s. `ClipShape.seconds`
follows both.

### 1.2 `refPt` and the root's travel

`refPt.y` is the ledge's height less the root's start height: 13 - 11.52 = 1.48 (crate), 21.5 - 11.52 = 9.98
(medium) [derived; the fit is exact]. `refPt.z` is how far ahead of the root the edge is at the start: 8.92 for both
climbs. `FUN_005b1a10` (decomp 467859) records the clip's `refPt` (from clip `+0x4c`, `FUN_0058c2f0`), the target on
the edge and the facing; `FUN_005b2d20` (439017) then steers the actor until `R x refPt` lands on the target (section
3.5). At a clip's end `FUN_00589aa0` (446538) sets the actor on the ground under it (`FUN_003157d0`) and the root's y
to 11.4 (crate), 11.5 (medium), 10.73 (hang to climb), 10.45 (step up) [read]; gravity is suspended through these
clips (`FUN_005af930`, 466760).

**The viewer** (`clipPath.ts`) carries the feet from the move's start to its end in step with the clip's own running
rise and travel, and gives the animator the root's height over those feet that keeps the drawn body where the clip
puts it, stretched evenly over the move when the obstacle and the clip disagree (a 9-unit crate climbed with the
crate clip's 12.9), so the body ends on the top in the standing root with no pop [viewer].

## 2. Ladders

### 2.1 How a ladder is marked [read, data]

- `FUN_002a9260` (decomp ~150310-150357) builds the ladder list at load, at `DAT_00437ce4`: every node with at least
  one `di` polygon of `appflags` 2 gets a 0x28-byte entry (bbox min `+0`, max `+0xc`, node `+0x18`, occupancy `+0x1c`
  -- one SEAL a ladder --, owner `+0x20`, id `+0x24`). Lookups: `FUN_002a90f0` by node, `FUN_002a9210` by id; the
  SEAL's ladder id is `seal+0x1062` (0xFFFF none). `FUN_002a8f50` finds the nearest by the box's middle for the AI.
- Not by name: the ELF has no lowercase "ladder" string, and the nodes are `ladderdown`, `di_ladder`, `ladder35`,
  `ladders`, `climbme`, `climb01` ... The `LadderPressUp/Down`, `LadderUp/Down` and `GetLadderInfo` strings are the
  online rankings' UI, not climbing.
- **Each ladder is two quads in one vertical plane, both `m_ditype` 2 (side only):** the span, from the bottom floor to
  the top floor, and over it a short quad (9.4 to 10.0 tall; the game splits them at 15) wound the other way.
  The exporter repeats a prototype's `di` on its instancing node, so a ladder can come twice (MP61); `findLadders`
  merges the copies and sides each ladder: the climbing side is the one the top deck is not on (the probe's floor
  within 2.5 of the top, 6 either side of the plane).

### 2.2 Every ladder of the 22 maps [data, `findLadders` on the served tree, 2026-09-28]

The climbing side is the normal's; all 38 were sided by their deck.

| map | node | x | z | bottom | top | climbed from (n) |
|---|---|---|---|---|---|---|
| MP2 | `worldmodel/ladsnipe/ladderdown` | 547.5 | 854.4 | 100.0 | 160.0 | (0, 1) |
| MP2 | `worldmodel/lad1/ladderdown_1` | 783.3 | 363.7 | 99.9 | 155.2 | (0.87, -0.50) |
| MP2 | `worldmodel/lad2/ladderdown` | 496.7 | 596.3 | 99.9 | 155.2 | (-0.87, 0.50) |
| MP2 | `worldmodel/ldr/ladderdown` | 989.0 | 617.1 | 102.5 | 152.6 | (0, 1) |
| MP2 | `worldmodel/laddrilltower/ladddown` | 158.5 | 913.0 | 100.0 | 156.8 | (-1, 0) |
| MP6 | `worldmodel/g40` | 2065.8 | 1983.3 | 0.0 | 61.0 | (0, 1) |
| MP72 | `worldmodel/tower/di_ladder` | 1557.4 | 1330.7 | 119.3 | 219.3 | (0, 1) |
| MP10 | `worldmodel/myladder` | 676.4 | 1682.3 | 28.4 | 128.4 | (-1, 0) |
| MP10 | `worldmodel/myladder` | 2083.7 | 1691.2 | 30.8 | 90.8 | (-1, 0) |
| MP10 | `worldmodel/myladder_1` | 1352.2 | 1211.0 | 28.4 | 128.4 | (-1, 0) |
| MP5 | `worldmodel/myladder` | 990.6 | 1565.7 | 20.5 | 86.2 | (-1, 0) |
| MP53 | `worldmodel/ladder` | 3009.5 | 3246.5 | 80.8 | 165.8 | (0, -1) |
| MP61 | `worldmodel/ladder_astrike2/ladder` | 905.6 | 1891.1 | -3.7 | 48.8 | (0, 1) |
| MP61 | `worldmodel/ladder` | 937.4 | 986.0 | 39.4 | 91.9 | (0, -1) |
| MP61 | `worldmodel/ladder` | 1012.2 | 1770.2 | -3.7 | 48.8 | (1, 0) |
| MP61 | `worldmodel/ladder` | 434.2 | 1448.8 | -1.7 | 50.8 | (1, 0) |
| MP61 | `worldmodel/g1902/di_ladder01` | 813.0 | 1471.9 | -0.1 | 50.0 | (0, 1) |
| MP62 | `worldmodel/g253/climbme` | 1692.2 | 1901.9 | 200.4 | 275.7 | (1, 0) |
| MP62 | `worldmodel/g253/climbme` | 1349.0 | 1395.6 | 201.3 | 276.6 | (1, 0) |
| MP62 | `worldmodel/g253/climbme` | 2629.0 | 1394.0 | 205.3 | 280.6 | (1, 0) |
| MP62 | `worldmodel/g253/climbme` | 1854.8 | 1103.7 | 174.9 | 255.2 | (0, 1) |
| MP64 | `worldmodel/towerladder_di` | 563.7 | 2628.6 | 48.9 | 98.9 | (-0.42, 0.91) |
| MP64 | `worldmodel/towerladder_di` | 1810.5 | 1757.6 | 93.4 | 143.4 | (1, 0) |
| MP71 | `worldmodel/ladder01/di_ladder1` | 1952.1 | 1092.7 | 139.2 | 179.2 | (-1, 0) |
| MP71 | `worldmodel/ladder02/di_ladder1_1` | 2329.4 | 809.8 | 182.0 | 222.0 | (0, -1) |
| MP73 | `worldmodel/g5213/ladder35` | 810.0 | 1196.0 | 110.0 | 145.0 | (0, 1) |
| MP73 | `worldmodel/g5213_1/ladder42` | 782.0 | 923.1 | 66.0 | 108.0 | (1, 0) |
| MP73 | `worldmodel/ladder_tower/ladder50` | 1109.0 | 1020.2 | 60.0 | 130.0 | (-1, 0) |
| MP73 | `worldmodel/ladder_tower/ladder50` | 838.9 | 1459.5 | 60.0 | 130.0 | (-0.72, -0.69) |
| MP8 | `worldmodel/climb01` (19 wide) | 1330.0 | 616.2 | 91.7 | 149.2 | (0.59, -0.81) |
| MP8 | `worldmodel/climb05` (19 wide) | 868.6 | 1411.5 | 104.3 | 161.8 | (1, -0.04) |
| MP81 | `worldmodel/ladders` | 1288.2 | 1557.2 | 22.9 | 120.4 | (0.42, 0.91) |
| MP81 | `worldmodel/di_ladder` | 1183.9 | 984.4 | 5.0 | 57.5 | (0, -1) |
| MP81 | `worldmodel/di_ladder` | 1279.9 | 984.4 | 5.0 | 57.5 | (0, -1) |
| MP81 | `worldmodel/di_ladder` | 1380.9 | 984.4 | 5.0 | 57.5 | (0, -1) |
| MP81 | `worldmodel/di_ladder` | 1141.9 | 1069.7 | 120.0 | 247.5 | (0, 1) |
| MP81 | `worldmodel/di_ladder_2` | 1418.1 | 1069.7 | 120.0 | 247.5 | (0, 1) |
| MP82 | `.../ladder_hit/ladder_guardtower1=.../down` | 650.1 | 425.4 | -40.0 | 10.5 | (-1, 0) |
| MP82 | `.../ladder_static/ladder_guardtower1=.../down` | 2168.2 | 2098.6 | 47.6 | 98.0 | (1, 0) |

The tests climb MP2's first (the sniper ladder, 100 to 160) with the disc's clips, and pin all five of MP2's.

### 2.3 The state machine [read]

The state is `seal+0x174` == 5 (reCOM `SEAL_STATE::stateClimbLadder`, `zSeal/zseal.h:64`); "is on a ladder" is
`FUN_0054f6e0` (decomp 417318). Anim types (the name table at `0x661060`, `FUN_005e30f0`): 0x2c "Stand -> Ladder",
0x2d "Climb ladder", 0x2e "Climb off ladder"; by name (`FUN_005e1df0`, decomp 495177-495348): `DAT_003def40` "Ladder
-> slide", `DAT_003def50` "Ladderslide", `DAT_003def60` "Ladderslide land".

- **The contact, no button.** `FUN_005b4b40` (decomp 469562) runs each tick (not in states 4, 5) on the wall contact
  the move solver records at `seal+0x1090` (point, polygon `+0xc`, normal `+0x10`, node `+0x1c`): in front
  (`dot(normalize(seal - contact).xz, n) >= 0.3`) and facing it (`dot(seal matrix row 2, n) >= 0.02`, row 2 the back
  axis: facing into the quad); for the short quad `|dot|`, either facing. `FUN_005b3890` (decomp 469000) drops the
  contact past 24 across the ground (576 = 24^2), behind the plane, or with the feet more than 10 under the short
  quad's bottom. Walking into the ladder mounts it, through a reservation (`FUN_005b2620` -> `FUN_005b1130` /
  `FUN_005b1570`; online `FUN_002b9f60`), executed in `FUN_005b1c80`.
- **At the foot** (the tall quad, `seal+0x1331` = 0), `FUN_005b1c80` (decomp 468183) -> `FUN_0057f880`: "Climb ladder"
  at time 0 and "Stand -> Ladder" over it on layer 5; the SEAL aligned on the midpoint of the quad's horizontal edge
  (consecutive vertices within 0.01 in y), facing -normal, the root's target at feet + 15.6 (`0x4179999a`) -- the
  climb's key-0 root, 15.58 [data].
- **At the head** (the short quad, `0x1331` = 1), `FUN_0057f690`: "Climb off ladder" played backwards (the reverse
  flag: `FUN_0028c160` negates the rate and starts at the end), after "180" (decomp 468243) when facing away.
- **Climbing**, `FUN_00584240` (decomp 443742; the state-5 case of `FUN_005870e0`, 445180): the clip's rate is the
  stick's forward `seal+0x240` times clip `+0x1c` (0.135), backwards for a stick back; the rise is the root's. **At a
  full stick: 0.135 x 16 keys / 0.178 s = 12.15 keys a second, 0.625 units a key: 7.59 units a second** [derived:
  W2.2c to measure on the console]. A rung is 5 units (two `ladder_rung` callbacks a 10-unit cycle). No turning
  (`NoTurn`, `FUN_0054f7e0` decomp 417605), the lateral stick zeroed (`FUN_00550ef0`, 418157 and 418343).
- **The head.** At each cycle's end in state 5 (decomp 418140, `FUN_005b10b0`) with the stick at 0.03 or more
  (`DAT_003f3428`), `FUN_005b0eb0` casts a ray 11 along the facing from the root raised by the climb-off's offset less
  1; with no `appflags` 2 polygon hit, "Climb off ladder" plays forward and at its end (`FUN_00588bc0`, decomp 446544)
  the SEAL is set on the top and the ladder released (`FUN_0059d750`). A climb off that would collide (radius 15 or
  19.1, `FUN_0054f7e0`) is reversed back onto the ladder (`FUN_0057f5b0`) -- not modelled. The viewer reads "the
  offset" as the climb-off's rise (18.91): the ray at root + 17.91 clears the short quad's top exactly when the hips
  stand 7.9 under the deck, which puts them 11.0 over it at the clip's end -- the standing root [derived].
- **The foot.** A stick back with the feet under the ground + 1.0 plays "Stand -> Ladder" backwards.
- **The slide.** The action button's context action 0x10 (bit `1 << 16` of `seal+0xed4`), labelled "LADDER SLIDE"
  (0x3e4de8) beside ACTION and CLIMB (`FUN_0021ded0`, decomp 73601): `FUN_00592d50` (452108) -> `FUN_0057f530` (only
  while "Climb ladder" plays) -> `FUN_0057f3e0`: "Ladder -> slide" then "Ladderslide", falling at **gravity x 0.8**
  (`FUN_0059b440`, decomp 456492), the root held at 11.44 (`FUN_0059b870`), "Ladderslide land" on the ground
  (`FUN_005af930` 466864, `FUN_0057f310`). A slide from the head (holding input slot 0 in the reversed climb-off's last
  0.2, `FUN_00582540` decomp 442920) is not modelled.
- **The camera** has no ladder mode; `FUN_0029a950` only skips its upward test on a ladder (decomp 142503).
- **Network codes** (`FUN_005880e0` decomp 445738): 1 jump, 5 mount at the foot, 6 at the head, 7 ladder to slide, 8
  slide from the head, 0x14 a reverted climb-off.

**The viewer's stand-off** from the rungs is `refPt.z`'s 5.565 [viewer: the rungs 5.565 ahead of the root, as the
climb-off and slide clips' `refPt` says; the hands land on the rungs in the browser, `ladder-mid.png`].

### 2.4 The head, as the game plays it (round 3) [read]

- **The "180".** A top mount by a SEAL facing more than 90 degrees from the climb-off's facing (`FUN_00306fd0`'s cosine
  under 0, decomp 468210-468256) plays "180" -- `animset.rdr` maps it to `seal_180` (`motion.rdr`: one-shot, playback
  0.95, BlendTime 0.2, NoInterrupt; 28 keys, the root turning 0 to 180 degrees and 5.7 back) -- with the actor's yaw
  turned **by code**: `+0x44..0x4c = (0, -angle / (0.95 x (n - 1) / n), 0)`, the exact angle needed; the clip runs
  0.95 x (27/28)^2 = 0.883 s. Its end (446650-446651), like the no-turn path, runs `FUN_005b1890` (467818): the steer
  record on the reversed climb-off -- refPt (0.347, (edgeY - y) - 12.899 + 0.5, 3.2), facing -normal, target (edge x,
  edgeY - 1.412, edge z) -- and `FUN_005b2d20` backs the SEAL onto it. **The viewer** turns the yaw over the clip and
  holds the clip's own root turn at its key 0 (`TraversalPose.holdRootTurn`: whether the game shows it was not found;
  shown with the code's turn it would be a 360).
- **The slide from the head.** `FUN_00582540` (decomp 442907-442978), each tick of a one-shot not yet interrupted: with
  "Climb off ladder" (0x2e) playing **reversed** and its phase `+0x1c` under **0.2** (the reversed run's last fifth,
  the SEAL at the rungs), input slot 0 -- "Action" (`PTR_s_Action_003f2be0`, Cross) -- **held** (state 2) drops the
  clip stack and plays **"Ladderslide" directly** (`FUN_00588bc0(a, 0x3def50, 5, 0, 0xd)`, no "Ladder -> slide"), the
  slide's height `+0x2e4` the actor's y; network code 8. The pad's context action fires on the button's **release**
  (state 3, `FUN_00594cf0` 453194-453225) and the jump on its press: the viewer takes the action on release and reads it
  held.
- **The climb-off's reversal** (`FUN_0057f5b0`, decomp 441417) is **character against character**: `FUN_0054f7e0`
  (417353) tests every other character (stance radii 6 / 7 / 8, x1.75 moving; cylinders 19.1 / 15 / 6 tall) each tick
  of a forward climb-off, and meeting one reverses the clip from where it is (rate -1, network code 0x14); a reversed
  finish sets "Climb ladder" at time 1.0 (446544-446559). The viewer has no other characters: **not applicable**.

## 3. The climb

### 3.1 The contact and what is climbable [read]

The move solver `FUN_005483d0` (decomp 413610-413670) records the wall it hits at `actor+0x1090` via `FUN_005b0d30`,
replacing a stored contact when the new one is climbable or the actor is more than 24 from it; `FUN_005b3890(actor, 0)`
(decomp 468959) drops it past 24, behind the face, or facing away (dot <= 0). **No forward rays**: the only ray is
`FUN_0054e430`'s, when the polygon's bottom is under actor y + 21.1: from the actor toward the contact x 1.1 at the
bottom + 0.5, a steep hit there replacing the contact (not modelled).

| `appflags` | the climb (`FUN_005b2620` 468288, `FUN_005b3ce0` 469088, `FUN_0059d9f0` 457413) |
|---|---|
| 1, 3 | by the height, `FUN_00580b70` |
| 2 | the ladder: `FUN_0057f7d0` for a quad <= 15 tall, else `FUN_0057f9c0` |
| 4 | by the height only for 5 < h <= 32; for 5 < h <= 10 it steps up with no press (decomp 469259-469276) |
| 5 | always "Climb over" (`FUN_00580a80`) |
| 0 | never |

### 3.2 The facing and the height [read]

The facing (from `*(actor+0x28)`'s rows, horizontal, normalised) against the wall's normal >= 0.3 (about 72.5
degrees; decomp 469208, again in `FUN_005b4b40`), and the direction from the contact to the actor within 0.3 of the
normal (`FUN_005b2620`). The height `h` = the polygon's top (`FUN_002dbfb0`) + a material term
(`DAT_0044f358[mat] + 0x38`, read as `FOOT_STEP_OFFSET`, unverified; left out) - the actor's y, measured wherever the
actor is -- in the air too.

### 3.3 The height's table (`FUN_00580b70`, decomp 442174; all literals) [read]

| h | the clip (standing or crouched; prone does not climb) |
|---|---|
| <= 5 | nothing |
| 5 .. 10 | "Step up" |
| 10 .. 12 | 0x2a "Climb crate" |
| 12 .. 26.5 | `FUN_00581110`: crate at weight 1 - (h - 12) / 14.5, medium the rest |
| 26.5 .. 28 | "Climb medium" |
| 28 .. 32 | 0x21 "Stand -> Hang", 0x22 "Hang" |
| > 32 | nothing |

From the hang (state 4, `FUN_00581c10` decomp 442605): 0x23 "Hang -> Climb" or 0x24 "Hang jump down". **The viewer**
plays the heavier of the crate/medium blend (the animator plays one clip), its path stretched to `h` [viewer]; pulls up
on the stick ahead or the action button and lets go on the stick back, the jump-down clip not played [viewer].

**Round 3: the blend and the height, as the game weighs them** [read]. `FUN_00581110` (decomp 442306-442340) starts a
"Climb medium" play (`FUN_0028dc90`), then swaps in two nodes without a blend (`FUN_0028bef0` 133999; weights normalised
by `FUN_0028bdf0`): the crate at `w = 1 - (h - 12) / 14.5`, the medium at `1 - w`, each at speed 1. The phase runs at
`w / (1.25 x 29/30) + (1 - w) / (1.5 x 31/32)` a second (`FUN_0028c4f0` 134225) to the medium's end 31/32 (the play
was made for it: `FUN_0028cc10` 134485-134493): 1.171 s at w = 1, 1.278 at 0.5, 1.408 at 0 [derived]; each node samples
`phase x n`, the crate held at key 29 (`FUN_0028d670` 134881-134899). refPt: x and z the crate's, y `w x 1.48 + (1 - w)
x 9.98` (`FUN_005b1a10` 467893-467898). The vertical motion is the weighted root velocity (`FUN_0028c250`
134149-134183), UseVelY from the first node (`FUN_0057b510` 439215-439223). **The viewer plays both** (a two-node
`trav:` play in the animator, `TraversalPose.blend`) and carries the feet on the blended root (`blendShapes`).
The height adds the contact polygon's material's `FOOT_STEP_OFFSET` (`+0x38`, the parser 181399-181401; default 0,
`FUN_002deb30`): -0.8 on GRASS, BROKEN GLASS, LEAVES, ICE, SNOW, GRAVEL (the hull's 4, 14-18), 0 elsewhere.
`FUN_005b3a60` (469016-469080; the scale from the disassembly at 0x5b3bb0 / 0x5b3c10) pulls the target to 3 from an end
it is within 3 of, takes the midpoint when both are, and always the midpoint for appflags 1.

**The obstacle ray** (`FUN_0054e430`, decomp 416696-416790), called only by the climb offer `FUN_005b3ce0` (469246)
each frame: at Y = the contact polygon's **top** + 0.5 (`FUN_002dd4d0`'s highest point; cast only when Y < the feet +
19.1 + 2.0), a level segment from over the feet to 1.1 of the way past the contact, against all collision (the actor's
own collider off); its hit replaces the contact (`FUN_005b0d30`) when steep (`n_y <= 0.6428`, `max_slope`'s cosine,
`DAT_0044c268`), of no VOLUMETRIC or LIQUID material, and on another object. Implemented (`obstacleRay`).

### 3.4 The button, the icon, the jump-grab [read]

- **Action = Cross.** `controller.rdr` Default: X -> Action, Square -> Jump; the logical Action is 0 and Jump 5 (the name
  table at 0x3f2be0). In `FUN_00594cf0` (decomp 453187-453243) Action state 3 calls the controller's `vtbl[0x78]` =
  `FUN_00592d50`, whose bit 4 (decomp 452182) sets `m_action_climb` (0x105e bit 1; reCOM `zseal.h:729`) and a latch the
  next tick's `FUN_00550ef0` (418120-418155) turns into `FUN_005b4b40` (469562), which re-checks the facing, calls
  `FUN_005b2620` and zeroes the velocity. With Jump and Action on one button (the "Goldeneye" config, `FUN_002c63d0`) a
  press jumps only if the stick moves or no action is offered.
- **The icon.** `FUN_00593500` (decomp 452227, every frame through the HUD, 73390) sets bit 2 of the action mask
  `+0xed0` (`FUN_00544ca0(actor, 2, 1)`) when `FUN_0059d980` finds a climb of type 3, 4, 1 or 5 -- **also while
  airborne** (0x105e bit 5, `FUN_00587f50` / `f10`): that is the jump-grab's icon. The bitmap is `action_climb.tif`,
  entry 2 "CLIMB" (0x3e4e00) of the texture set `0x45c3c0` (`FUN_0021ded0`, decomp 73549, 73614-73621); on a ladder
  entry 0x10 "LADDER SLIDE" is `action_slide.tif`. Both are in `RUN\COMMON\HUD_TXR.ZED` with `HUD_PAL.ZED` [data].
  The panel is centred at x 306 of 640, half-width 25, y 365-415 of 448 (`DAT_003dc628/630/640`, `DAT_0040c160`
  decomp 327763), its tint pulsing base + t x delta at rate 5 (`FUN_0021f120`, 73840).
- **The jump-grab.** `h` is from the airborne y, so a jump brings a ledge up to 36 into the table's 32 while the
  contact holds; the press can come any time the icon shows. No exact window figure exists: it is the table and the
  contact.

### 3.5 The steer and the move [read]

`FUN_005b2d20` (decomp 439017, from `FUN_0057a330`) steers the actor until `R x refPt` lands on the target (the contact
on the top edge kept 3 from its ends, or the edge's midpoint, `FUN_005b3a60`): at most 30 a second on each axis and
4.712 radians a second of turn, stopping at facing > 0.993 and inside 1, or after 46 ticks, abandoning past 30. Extra
offsets: "Stand -> Hang" (0, 11.78, -2.42), "Climb over" (0, -0.29, -2.42), "Step up" `refPt.y` + 1.

**Round 4 (2026-09-29, the owner's "reached far above the ledge"): the steer is vertical too** [read]. `FUN_005b2d20`
(decomp 468517-468748, called from `FUN_0057a330` while the steer record lives, i.e. as the clip plays) sets a velocity
on **all three** axes, each clamped to +-30 a second: the target (`+0x8c`, whose y `FUN_005b1a10` copies from the
contact polygon's top point, 467887) less the actor's position, its root (`vtbl+0x88`) and the turned `refPt`. Under a
`UseVelY` clip `FUN_0059afd0` holds the root at most 11.487 over the actor (456455-456460), so the body is lifted or
lowered by `top - (feet + 11.487 + refPt.y)` -- the clip's hands meet the ledge whatever the height, the clip is never
stretched to it. The viewer had only the horizontal steer and spread the height mismatch over the rise, so at the pull
the hands were +2.2 over a 10.5 ledge, -2.4 under Frostfire's 18.96 crates, -6.7 under a 27.5 ledge, and **+5.9 over
Frostfire's 30 containers while hanging** (the hang drawn on "Hang -> Climb"'s 18.14 root, not the held one). Now
`ClipPath`'s `lift` applies that shift from the clip's start at 30 a second and the hang holds the body where "Stand ->
Hang" left it: at the pull 0 to -0.1 for the crate, to -1.7 for the medium (the clips' own grab), -0.88 hanging at
28.5-31.5 (`test/traversalBody.test.ts`). A crate under 13 lowers the body: at 10.5 the soles go ~1 under the floor for
the steer's first ticks (gravity is suspended through these clips, `FUN_005af930` 466760; whether the game's collider
stops the actor there is not read).

### 3.6 Climbables for the tests [data]

`appflags` 4 is on 20 maps (MP2 359 polygons, MP12 151, MP6 89, MP1 68, MP81 62, MP61 57 ...), 5 on MP1 (100), MP6
(8), MP81 (3). Frostfire's, pinned by the tests: the crate `worldmodel/crates1/prop02` at x 922.8-940.6, z 761-778.1,
top 111.85 (h 11.9: "Climb crate", approached from z 790 at x 938, clear of the 19-tall `prop01` beside it); the
container `container_blue01` at x 680-720, z 640-680, top 130 (h 30: the hang). MP6's `crate05/mp6_justbox1` (13 tall,
`appflags` 5) is a climb-over; `wall_low3` / `wall_high2` (`appflags` 4, 29.5-30) are hangs.

### 3.7 The hang, as the game plays it (round 3) [read]

The state-4 handler is `FUN_00584390` (decomp 443780; `FUN_00581c10` 442607 only picks the exit clip): the stick at
rest (0.03) holds the hang with no timer; ahead climbs ("Hang -> Climb", 443810); any other push -- back or aside --
lets go ("Hang jump down", 443830). The jump latch lets go (`FUN_00581dc0(a, -1)`, 418136-418138), as does an action
with nothing offered (451991-451994); a stance button climbs on stand and lets go on crouch or prone (`FUN_00581ed0`
442695-442732, 418877-418906). "Hang jump down" (0x24, `seal_hang_jumpdown`, 1.5 s) is **not** gravity-suspended
(466760-466790): `FUN_0059afd0` (456390-456395) takes the height from the clip's root only for its first 0.2 -- the push,
the root 18.82 up to 21.30 by key 7 and back from the wall -- and from the fall after; the clip plays on through it.
The viewer runs that (`hangDown`, `hangDropFall`). "Ledge -> Hang backwards", "Hop down forward / backwards": **nothing
in this ELF plays them** (0x25 only on a branch no caller takes, 442360; 0x26 never; 0x2b only tested, 418310); no
climb down is offered at a ledge.

### 3.8 The climb's facing, and the owner's "turned around and climbed the wrong way" (round 6, 2026-09-29) [read, viewer]

**The game's rule** [read]. The facing is the body's, never the stick's or the camera's apart from it (in SOCOM II the
look's yaw is the body's): the offer `FUN_005b3ce0` takes the actor matrix's third row, horizontal
(`*(actor+0x28) + 0x20`, `+0x28`, decomp 469213-469218), dots it with the contact's normal and wants >= 0.3
(section 3.2); no forward probe picks the wall (section 3.1: the contact is the move solver's). So **walking backwards
or strafing into a box offers nothing** (the facing is 180 or 90 degrees off), and neither does a look more than 72.5
degrees away. On the press, `FUN_005b2620` hands the contact's normal (`pfVar13 + 4`, 468504) to `FUN_005b1a10`, which
stores it **negated** at the steer record's `+0x7c` (467938-467946): the facing to reach is into the wall, the
polygon's, not the probe's or the stick's. `FUN_005b2d20` (468637-468680) turns to it by vectors: the target facing
brought into the actor's frame by the rotation's conjugate (`FUN_00306fd0` with `-q.xyz`), `acos` of its dot with the
frame's forward (`DAT_003f6500`) over the tick's time, clamped to 4.712 a second, its sign from the cross product's y
(`FUN_001bfc78`; `fStack_ec < 0` negates it). **The turn is always the short way** -- there is no angle to wrap.

**The viewer's fault** [viewer, measured]. `align` and the ladder head's `mountTop` took the turn as
`((want - yaw + 540) % 360) - 180`. JavaScript's `%` keeps the dividend's sign, so for a yaw more than 540 over `want`
the result is -180 or under: the SEAL spun the long way. The page's camera yaw is never wrapped (`camera.ts` adds the
mouse's turn to it; only the net command quantises it to 0..360, so an online mover never saw it), so two turns to the
left were enough. At 4.5 degrees a tick, `FUN_005b2d20`'s 46 ticks ran out mid-spin and the clip played with the body
off the ledge while the feet went onto it. Frostfire's crate `crates1/prop02`, its west face (x 922.8; the plan's yaw
-90), approached head on at yaw 630 (-90 two turns round): **153.0 degrees off the clip's travel as it started, the
body's facing against the feet's travel -0.89 at worst, the feet 0.92 short of the head-on end**; at yaw 700 on a
synthetic 12 crate 133 degrees off. Every other approach was already right: head on 0 degrees; 30 and 60 degrees
either side turned the short way and climbed (0 off); backwards, strafing either way and 85 degrees off offered
nothing (the facing test); the south face's inside corner with `prop01` (x 916.6-934.4, z 778.1-795.2, 18.96 tall) and
the north-west outside corner climbed whichever face the contact held, facing it; standing against it then pressing,
the same. The ladder head at yaw 720 played a needless full-circle "180" before a mount that wanted no turn.

**The fix**: `shortTurn(from, to)` (`traversal.ts`), the signed short turn in [-180, 180) for any winding, in `align`
and `mountTop`. After it every approach above starts the clip within the steer's 6.8 degrees (0 measured), the feet end
where the head-on climb's do, and the ladder head at any winding mounts straight. The mover stays deterministic (plain
arithmetic on the same yaw; the server's is the quantised command's). Pinned in `test/climbFacing.test.ts` (Frostfire,
and a synthetic box and ladder that run without the disc).

**The yaw's one arithmetic** (round 6, `yaw.ts`) [read, viewer]. The game's facing is the actor's rotation (the
quaternion `piVar10[0x14..0x17]`, 468642-468645), so it has no winding; the viewer's degrees are kept equivalent by two
functions and nothing else: `shortTurn` (above, moved from `traversal.ts`) for every difference of two yaws -- the look
rate (`main.ts` `gunFrame`, the server's `ShotCone`), the turn rate (`walk.ts`), the snapshot interpolation
(`net/client.ts`), the room's idle test (`room.ts`, which read 0.1 -> 359.9 as a 359.8 turn) -- and `wrapYaw`, the
canonical [0, 360) the wire already reads a yaw back in (`net/codec` u16 a turn), for every stored yaw: the page camera
(`camera.ts`, radians [0, 2 pi) at each write), the mover's look (`walk.ts`), the play snapshot (`moverSnapshot`), the
spawn's facing and the bots. Spun two turns either way the walk gives the same look, aim, round, command bytes and climb
as never turned (`test/yawWinding.test.ts`).

## 4. The peek

### 4.1 Input and conditions [read]

`FUN_00594cf0` (decomp 453431-453457) resets the peek byte `seal+0x375` to 2 (none) each frame; it is 1 (right) while
pad button 5 is held past 0.03 of its pressure 0x14, 0xFF (left) for button 7 / pressure 0x15 -- libpad2's **d-pad
right and left** (the game's packer pairs them, decomp 179819-179861; 0xc Triangle, 10 L1, 0xb R1, 8 L2, 9 R2).
Held, not toggled; on or off, not analogue. Blocked while Triangle is held, dead (state 8), or when the side ray
`FUN_00596d60` hits (9.5 right, `0x41180000`; 7.8375 left, `0x40facccd`; at `min(8, ...)`), or when
`FUN_005b4340(seal, 1)` fails (state 0-3, grounded, not carrying, not jumping or reloading). `FUN_0057d810` (decomp
440451-440530) plays "Peek left/right" (0x1d/0x1e), "Crouch peek left/right" (0x1f/0x20) or "Prone peek left/right"
and sets state 3; the release goes through `FUN_0057dc80` (440560). **No locomotion in state 3**
(`FUN_005870e0`: `case 3: case 8: break`, decomp 445166-445175), and the start wants a still SEAL (`FUN_00587c20`,
read as such).

### 4.2 The camera [read]

`FUN_002998f0` (decomp 141962-141976): the target is -1 for 0xFF, +1 for 1, else 0 (and 0 for state 2 prone-not-peeking
or 8); `DAT_004161c0 = target + (DAT_004161c0 - target) x exp(-cam_peek_decay_rate x dt)`, the rate `DAT_0044c3bc`
= 6 (`dynamics.rdr`; the static default at decomp 328433 is 6 too): a time constant of 1/6 s, 95 % in 0.5 s.
`FUN_0029a950` (decomp 142478-142484): the actor-space x of the target and of the eye's (0, 0, 28) is `peek x 2.5`
left and `peek x 2.8` right, before the look quaternion (`FUN_0029a660`'s far camera the same, 142365). First person
(`FUN_0029ae50`, 142613-142617): the eye node + `peek x 3.3` left, `x 4.35` right. While the peek is not 0 the pass
`FUN_0029bf70` sets `FUN_002d4fd0(DAT_004161c0 == 0)` (143369-143373): the movement's surface mode (bit 18 skipped,
not bit 19). The `cam_peekl/peekr` side, height and dist go into a throwaway local in the loader `FUN_0059ba80`
(456637); the aim triples into a vector indexed by `cam+0xe4`, whose view-cycle `FUN_0029b0c0` (142653-142657) skips
indices 1-4: dead data. `camera_roll` has no reader.

**Round 4 (2026-09-29, the owner's "not enough peek, it recentres"): the aim does not take the shift** [read].
`FUN_00297410` (decomp 140987-141028) makes the far point `targetL + rotate(actor+0x1070, (0, 0, -1000))`: the look
quaternion turns a straight-ahead vector, not `v`, so the peek moves the eye (about 2 x the shift out: 5.6 right, 5.0
left at a level pitch) and the target across and leaves the aim parallel to the facing (0.16 degrees in). The viewer
aimed along `-n`, which carries the shift, so the view swung 5.8 degrees back toward the body as the peek eased to its
hold -- the recentre -- and the rounds went there too; fixed in `playerCamera.ts` (`LocalCamera.ahead`). The lean clips
hold their last key with no return (head 4.0 across standing right, 2.6 left); the skeleton root's x and z are 0 in the
game as in the viewer (`FUN_0057a330` zeroes them, 439147-439148), so nothing else shifts the camera.

### 4.3 The body [read]

Full-body clips, held on their last key (section 1). No hitbox shift in code (hit regions are per bone,
`damanim.rdr`, and follow the skeleton [inference]). `FUN_0057fa70` (441667-441672) holds per-stance points
(peek right (7.55, 9.78, -2.54), left (-0.24, 8.87, 5.11)) the AI reads (424337); meaning unconfirmed.

### 4.4 The throw from a peek (round 3) [read]

`GetThrowAnim` (`FUN_0057fce0`, decomp 441707-441880), state 3: by the lean clip playing (`FUN_00577e40`), "Peek right
toss" (`seal_toss_rlean`, release at 0.55, 0.668 s) for the standing or crouched right lean, "Peek left toss"
(`seal_toss_llean`, release 0.87, 1.007 s) for the left -- whatever the power or the aim; the grenade leaves the left
hand for the left toss (decomp 477060-477065). **A prone peek has no throw**: its lean types are not tested, the
function returns 0 and the caller clears the throw (475499-475510). The throw leaves the peek as it is (the toss is
pushed over the held lean). The viewer: `PlaySnapshot.peek` (the lean held), which `grenade.ts`'s stance maps to the
peek stances, refusing the throw prone.

## 5. The water

### 5.1 How water is marked [read, data]

`materials.rdr`'s `LIQUID` flag sets material `+0x3c` bit 1 (parser decomp 181411-181414; `VOLUMETRIC` bit 0,
`UNDERWATER` bit 2, `PICKUP` bit 4). **The hull's `m_material` is the SOILS index two past the reader's order**
[data, census]: 11 is `WATER` (flat surfaces, `|n_y|` 1.00, on 14 maps: MP64 212 polygons, MP53 34, MP62 22, MP12 20,
MP52 9 ...), 12 `UNDERWATER` (the beds under them), 9 `GLASS` (Frostfire's window panes, MP6's bottles), 25
`METAL_THICK` (Frostfire's `DefaultMaterial`, 1,357 of its 3,318). No fixture map (MP2, MP6, MP72) has water.

### 5.2 The wade [read]

- In the ground probe `FUN_005b5d40` (decomp 470160-470243) a LIQUID hit is no floor candidate; it goes to
  `FUN_005b52b0` (469852): the depth `+0xf88` = the water's y - (pos.y + bbox.minY), the water over the feet, the
  in-water flag `0x105e` bit 7. The SEAL walks on the bed.
- `FUN_005b56c0` (decomp 469966-469975, 470153): `f = clamp(1 - depth x water_factor_slope, min_water_factor, 1)`, with
  `dynamics.rdr`'s **0.05** and **0.75** (the ELF's static 0.066 / 0.6, decomp 328407/328410, are overwritten): 0.75
  from 5 deep. It multiplies both stick axes (after an uphill factor, `sqrt(1 - d^2)` squared of the ground normal
  `+0x410` against the move axis -- not modelled), not in the air, standing (`FUN_00586570` 444865) and crouched
  (`FUN_00584c60` 444163/444173), not prone.
- Stances: prone only to 2 deep (`FUN_00581660` 442448, `FUN_00584c10` 444028; deeper, crouch `FUN_005845c0` 443864),
  crouched only to 8.5 (`FUN_00581990` 442553, `FUN_005857e0` 444354; deeper, stand 444080), the crawl moving only to
  1.5 (`FUN_00583500` 443387). No swim state, no drowning, no depth limit.
- Effects (decomp 460997-461004, `FUN_0026a250`): `big_ripple_anim` / `_walk` / `_run` by `FUN_0058a820` (speed^2 < 0.25,
  < 400, else), `small_ripple_*` for a water line 0-10 over the box top, `seal_fall_in_water` on landing from the air
  (469892-469896); the steps are the material's `STEPSOUND` / `CRAWLSOUND` (`.STEP_WATER`, `.STEALTH_WATER`, `.WATER_JUMP`).

### 5.3 The slope on the stick (round 3) [read]

`FUN_005b56c0` (decomp 469966-470138), grounded, in water or not: each stick axis pushed past 0.03 is multiplied by
`1 - d^2` where `d` is the floor's normal `+0x410` against the axis's way (the negative axis for a negative push) and
`d < 0` -- uphill; 1 downhill or across; 0 at `d <= -1`. Then, in water, the water's factor. The viewer applies both
(`Traversal.stickScale`, the walk's `stickScale` seam), so a 30-degree ramp is climbed at 0.75 of the stick.

### 5.4 The ripples and the splash (round 3) [read]

`FUN_005b52b0` (469810-469920), on each liquid hit of the ground probe: F the feet, T the body box's top, W the water:
F < W < T the **big** ripple, T < W < T + 10 the **small**, by the speed class (`FUN_0058a820` 446876: speed^2 under 0.25
`_anim`, under 400 `_walk`, else `_run`): `big_ripple_anim` / `_walk` / `_run`, `small_ripple_anim...` (`FUN_0026a250`,
460997-461003), at the water's point over the feet and following it (a tag-3 pointer). A new one only when there is
none or the last has ended; a switch of size stops the other. `seal_fall_in_water` once on a fall into water
(F < W < T, airborne, not in water the frame before; 469892-469896). The viewer runs them through the map's effects
(`TraversalPage.effectsFrame`, `Effects.spawn`). The condition bit `actor+0xe1` bit 4 was not identified (taken as set).

## 6. Crawling and headroom [read]

The headroom ray `FUN_0057efe0` (decomp 441190-441240) goes up from pos + (0, hips.y + 2, 0) to pos.y + 12 (to crouch)
or + 19 (to stand), passing when clear or when the hit's `(byte10 & 0xf) >> 2 == 1`. `FUN_00552ec0` (418916-419015)
refuses a stance change it blocks (prone to crouch needs the 12, anything to stand the 19), so a SEAL stays down under
a table; going prone probes the body's axis (`FUN_0054d620`, 11.2 and 8.0 at step_height x 0.5 = 3.25) and water <= 2.
The prone crawl has no ceiling test. The walk's crouch-run already runs the 19 ray (`walk.ts`); the stance change's
refusal is not modelled here (it is the stance's, the MOTION workstream's).

### 6.1 The dive (round 3) [read]

`dive_to_prone` (`DAT_003def08`, 495336; `seal_dive2prone`, 1.6 s, BlendTime 0.2, NoInterrupt, `dive_prone` at 0.45).
**Its button is the stance button's full press**: Triangle's pressure past 0.3 (`FUN_00594cf0` 453331-453390) from a
stand or a crouch dives when `FUN_00584b00` (443977-444010) passes -- not already diving, in water no deeper than 2, no
weapon swap, the body moving at **30 a second or more** (root speed^2 >= 900), the play interruptible -- else it goes
prone (a light press toggles crouch on release). `FUN_0057e540` (440870-440920): the world velocity kept (`+0x1350`),
a 0.2 s hold, airborne; the clip's own root travel zeroed (416510-416514); the position by the kept velocity, bled at
**150 a second each second** on the ground (416527-416545); a virtual root falling at 235 to the prone's 2.2
(`FUN_0059b870` 456585-456600); the play ends grounded at rest (418158-418167) -- about 0.9 s and 45 units from a full
run [derived]. The viewer's stance buttons reach it through `WalkMode.setStance('prone')` (C from a crouch, the pad's
Triangle held -- the viewer's stand-in for the full press).

### 6.2 What else the game has [read]

The steep-ground **slide** (`DAT_003dead8` "Slide", `FUN_0054edf0` 417032-417205, surface test `FUN_0054f330`): a
3-bit field of the ground polygon's surface word bits 28-30 (inside reCOM's `m_reserved`, not decoded by the viewer's
reader) and the slope -- steeper than 50 degrees slides; speed along the fall line gaining `(1 - n_y) x 235` a second;
the clip past 58.75 a second. **Not implemented**: it needs the field decoded and the walk's refusal of steep floors
replaced. No prone roll, no mantle beyond the climbs, no rappel, zipline or swim exist.

### 6.3 The jump up a slope: the floor in the air (round 4, 2026-09-29) [read, data]

**The owner's report** (2026-09-29, after playing): a jump while running up terrain went through the ground most of the
time. **Reproduced** (`test/walk.test.ts`, "a running jump up a slope"): ramps of 15, 26.6, 40 and 48 degrees over a
floor running on under them, a take-off on the flat just short of a ramp's foot, Frostfire's rail ramp `rmp1` (x
680-705, z 891 -> 975, y 100 -> 142, 26.6 degrees, the 100 floor under it) and MP6's hillside `g157` at z 1700 (x 1010
-> 1040, y 36 -> 59, about 39 degrees). Before the fix every one ended with the feet under the slope's top -- by 0.8 to
46 units; on `rmp1` the SEAL landed on the 100 floor *under* the ramp, 27.6 under its top.

**The cause** [viewer]: the airborne tick (`Walker.fall`) looked for its landing only among the floors **at or under
the feet as they were the tick before** (`h.y <= from`), and only while falling (`vy <= 0`). A running jump's feet sink
0.98 through the 0.1 s wind-up (research 80 section 2.2) while the run carries them 6.5 units up the slope, so at the
impulse they are already under the slope; from then on the slope was never a candidate: rising, nothing was tested;
falling, the only floors "under the feet" were a floor beneath the ramp (Frostfire: landed there) or none (the fall
went on under the map). The flat-ground tests never saw it: there the floor stays under the feet. `airStep` added a
second fault: a column whose floor was over the feet was refused, stalling the flight against a rising slope.

**What the game does** [read]:

- `FUN_005b0420` (decomp 467037-467110) probes the ground every tick, airborne or not, and takes the floor with
  `FUN_005b5d40` (470163-470290): the highest hit at or under the probe's origin + 1, else the lowest, refused only
  when it is more than 20 over the feet -- the walk's own `selectFloor` (research 23 section 1.1, research 24 section 2).
  The origin is the actor's record `+0xf54` plus a node's world position, written by `FUN_005b0840` (467165-467300);
  the viewer keeps research 23's reading of it, the feet + 5 (`PROBE_LIFT`).
- `FUN_0059ad30` (456263-456327) with that floor: with the jump's bit (`actor+0x1061` bit 1) set and bit 2 clear, the
  feet (`actor+0x2e4`) **under the floor** and the wind-up spent (`actor+0x1360 <= 0`), the feet are **put on the
  floor**, bit 1 cleared and bit 2 set. **The fall speed is not touched**: no test of its sign.
- `FUN_0059b440` (456467-456570), the walk-off branch the jump is now in: with the feet at or under the floor, the fall
  speed `actor+0x133c` is recorded and zeroed **only when it is a fall** (`0 <= +0x133c`), and the feet put on the floor
  (plus the material's offset); the airborne bit 5 is cleared -- the landing, `FUN_005af930` -> `FUN_005af590` -- only
  when the feet are within 3 (`DAT_0044c264`) of the floor **and falling**.

So in the game a slope rising over a jump's feet lifts them onto it and the rise goes on; the landing is on the way
down. **The fix** (`walk.ts` `fall`, `airStep`): the airborne floor is `selectFloor(probeGround(x, z), from + 5, y)`,
the ground's own pick; feet at or under it are put on it; a fall (`vy <= 0`) is the landing, a rise goes on. A column is
entered in the air when that same pick finds a floor there -- `selectFloor(probeGround(x, z), y + PROBE_LIFT, y)`, up to
20 over the feet (`FUN_005b5d40` 470163-470290) -- and the tick's floor then puts the feet on it (`FUN_0059ad30`
456313-456322, `FUN_0059b440`). No floor (the map's edge, a hole, a top more than 20 over the feet) is the probe's miss:
`FUN_005b0420` (467057, 467098) with `DAT_003df1c8` set (1 in the ELF) puts the actor back at its last hit
(`FUN_003157d0`), so the sub-step is not taken (`mover.ts` `airStep`). This replaced, 2026-09-29 (OWNER-5, launch fix
B10), the viewer's former allowance -- a column entered only with a floor within `step_height` (6.5) over the feet, a
rule no function gave -- which stopped a jump dead at a wall-less ledge 7-20 high. Pinned by `test/walk.test.ts`: a
12-high wall-less ledge is entered, its cut far side taken at 12 and refused at 25, and the map's edge pins the jump.
The flat jump, the walk-off and every landing test are unchanged (the flat floor is never over the feet in flight).

**Bounds** [derived]: with `FUN_005b56c0`'s uphill factor on the stick (section 5.3) the run up a slope of angle a is
`65 cos^2 a`, so the feet end the wind-up at most `0.98 + 65 cos^2 a x 7/60 x tan a <= 0.98 + 3.79` = 4.8 under the
slope's top -- inside the pick's 6, so the slope is always the floor chosen, even over a floor beneath. Without the
factor (a bare `Walker`) a ramp over 33.5 degrees over another floor can sink the feet past 6, and the game's pick then
takes the floor beneath as well; the tests of the steep ramps run with the traversal's driver, as the page does.
Terrain without a floor beneath takes the slope as "the lowest" up to 20 under it. **Not modelled**: the game's two-tick
landing (`FUN_0059ad30` puts the feet on the floor, the next `FUN_0059b440` zeroes the fall and clears bit 5) and the
3-unit landing window -- the viewer lands on the tick of contact, as before.

### 6.4 The prone press in water: issue #22 (round 5, 2026-09-29) [read, data]

**The report** (research 90 section 9.4, #22): at spawn A of Enowapi (MP62), Shadow Falls (MP64) and Fish Hook (MP71),
holding `C` gave crouch, not prone; `setStance('prone')` would not take; the SEAL crept ~15 units over the 6 s of
the tap-hold-tap-tap run with no stick.

**Not the slope** [data, `test/traversal.test.ts`, the served tree's maps]: the three spawns stand on the bed of water
5.3, 3.8 and 4.3 deep (Enowapi's water at y -14.17 over the feet at -19.49), on ground 3.5, 20 and 1 degrees off
flat. Nothing in the game refuses prone by slope: the stance functions below read the water, and the only slope gate
on the SEAL's actions is the jump's (`FUN_0057e1b0`, decomp 440799, `actor+0x1348` against `max_slope`). The walk
does not slide on a slope either; at rest the mover at each spawn holds its feet bit for bit.

**What the game does** [read]: the stance request `actor+0x374` goes through `FUN_00552d60` (decomp 418866-418900):
prone to the dive test (`FUN_00584b00`) and else `FUN_00581660`; crouch to `FUN_00581990`. `FUN_00581660` (442436)
with the in-water bit (`+0x105e` bit 7) and the depth `+0xf88` over **2.0** does not go prone: it **rewrites the
request to crouch** (`+0x374 = 1`) and calls `FUN_00581990` instead; that one, over **8.5**, rewrites it to stand
(`+0x374 = 0`) and calls `FUN_00581c10`. So the game **substitutes** -- a prone press 2-8.5 deep is a crouch press
(from stand the stand-to-crouch clip; already crouched, nothing), and deeper a stand. The viewer's crouch at those
spawns is the game's answer; tap-hold-tap-tap there is crouch > crouch > stand > crouch, and a prone reading needs
water no deeper than 2.

**The viewer's defect, and the creep** [viewer]: `Walker.changeStance` took the prone request as asked -- the stance
prone and the `Crouch -> Prone` (or `Stand -> Prone`) clip started, its root motion (`FUN_0028c250`, round 3) carrying
the body ~8 units -- and only the next tick's water rule (`Traversal.water`, `FUN_005b56c0`'s stand-up) put the stance
back to crouch, the clip still playing out. That clip's travel is the "creep"; the stand/crouch clips of the taps move
the feet ~1.7 out and back. **The fix**: the seam `TickDriver.stanceFor` (`Traversal.stanceFor`, the water over the
feet where they stand) rewrites the press as `FUN_00581660` / `FUN_00581990` do before `changeStance` starts any clip,
for the page and the server's `MoverSim` alike (both call `changeStance`); `WalkMode.setStance` reads the stance back.
The pad's Triangle and `C` need nothing of their own. `tools/release-sweep.ts`'s want of crouch > prone > crouch >
stand holds only at a spawn in water 2 deep or less.

## 7. What the viewer does, the seams, the bindings, the events

### 7.1 Modelled

The ladder (contact mount at the foot and the head, the climb at 7.59, the rungs, the head ray, the foot, the slide at
0.8 g and its landing), the climb (appflags, contact, table, facing, action press, the automatic step up, the steer,
the clip's path, the hang and pull-up, the jump-grab), the peek (d-pad/Q/E held, still, side ray, stance clips,
camera ease, third- and first-person shifts, the pass's surface mode, no locomotion), the wade (water no floor,
depth, the factor, the stances). Tests: `test/traversal.test.ts` (18, synthetic hulls and Frostfire's), `clipPath.test.ts`
(2), `e2e/traversal.spec.ts` (Frostfire's ladder, crate and peek, with pictures).

### 7.2 Placeholders and simplifications (named in the code)

Closed in round 3: the crate/medium blend (both nodes, the game's weights), the "180" (by code, 0.883 s), "Hang jump
down" (the push, then the fall), the slide from the head, `FUN_0054e430`'s ray, the material's foot offset, the uphill
factor, the ripples and the splash, the lean's toss, the dive. Left: the climb-off's reversal on meeting another
character (the viewer has none); the steep-ground slide (section 6.2); the ripples' `actor+0xe1` bit 4 (taken as set);
the Triangle's pressure (a hold stands in for the full press); the ladder's 7.59 is derived (W2.2c to measure); the
fallback clip shapes (a smoothstep with each clip's seconds, rise and travel) stand in only before the pack arrives.

Named in the code:

| name | value | stands for | status |
|---|---|---|---|
| `DEATH_LANDING_GETUP_PLACEHOLDER` (`mover.ts`) | true | a deadly fall's `Land forward` getting up (`Get up forward`) in the free walk (`&nomatch`, `&fly`), where nothing kills; the game dies in that landing (`FUN_005af590` 466641-466728, state 8, vtable +0x90) and never gets up (`FUN_005979a0` 454470-454495 spectates or fades the body; research 80 section 6c) | open, the free walk alone: in a match -- online, or the offline match run in the page (research 91 section 20) -- the net client's `kill` sets `Walker.dead`, which holds `Land forward` (or a knock's `Land backwards`) at its last key. A blast knock's landing always gets up, as the game's own (`knockLanding_`, L446653-446700) |
| `STANCE_HOLD_S_PLACEHOLDER` (`stanceButton.ts`) | 0.4 s | how long Triangle (the pad) or `C` (the PC) is held before it means prone: the game reads the button's pressure, not a time (a light press toggles crouch at release, a full press goes prone at once; `host_crouch_shortcut.h`, KNOWN R139), and a browser's button is only on or off, so the owner's rule (2026-09-28: tap crouches, hold goes prone) needs a length | open, the owner's to set (handoff section 6) |

Retired: the airborne column's `step_height` allowance (section 6.3; the ground's pick replaced it, OWNER-5).

### 7.3 The seams (re-applied over the MOTION rewrite at the merge of `claude/web-viewer-playtest-fixes`, 3e673174)

- `walk.ts`: `GROUND_FIELDS` 6 (`appflags` packed; `WorldPoly.appflags`); `TickDriver` / `TraversalHooks`
  interfaces; `Walker.driver`, whose `tick` runs first in `Walker.tick` (before the jump lock and the actions),
  returning true when it moved the mover; `Walker.setAirborne(on, vy)`, which also ends the action, the jump and the
  carried velocity (a jump-grab ends the running jump; a hang's let-go starts `Jump fall`); the water's
  `stickFactor` before the air / ground split; `WalkMode.useTraversal`, `traversal()`, `action()`, `lean()`,
  `attachMoves` (where `stand()` makes the `Walker`), the move's yaw held in `look()`, `moves?.reset(w)` in
  `setCamera`, the peek on the camera and the move's root under the posed one in `cameraTick()`, the peek's shift and
  the move's root in `follow()`'s first person, `PlaySnapshot.traversal`; the jump and a stance change refused while
  `busy()`; `stance_` kept with the mover's after the ticks. Every line is marked `TRAVERSAL SEAM`.
- `animator.ts`: `MoverSnapshot.traversal` (`TraversalPose`: clip, frame, loop, rootY); `step` hands it to
  `traversalStep`, a one-node play keyed `trav:<clip>` at the move's key, its `zanim_callback`s fired through `onEvent`
  as the phase passes them, `rootOverride` setting the root's height in `pose()` -- so `rootY()`, and through
  `WalkMode.setPosedRoot` the camera, carry the move's root.
- `playerCamera.ts`: `peekShift`, `localCamera(rootY, pitch, peek = 0)`, `PlayerCamera.peek`,
  `firstPersonPeekShift`, `isPeekCameraSurface` and `cameraPass`'s `accept`.
- Round 3: `TickDriver.stickScale` (the slope and the water per axis) and `Walker.glide(dx, dz)` (the dive's carry);
  `TraversalHooks.jump`, `stanceButton`, `dive`, `peeking`; `WalkMode.setStance('prone')` asks the dive first;
  `PlaySnapshot.peek`; `TraversalPose.holdRootTurn` / `blend` in the animator; `Effects.spawn` (a run's handle);
  `grenade.ts`'s stance takes the peek.
- `gamepad.ts`: the `action` lane on Cross (standard button 0), `leanLeft` / `leanRight` on the d-pad's Left / Right
  (14 / 15), walk-only (`ACTION_WORDS`); `ui.ts`'s walk hint names X, Q / E, Cross and the d-pad.
- `main.ts`: `TraversalPage` (with the audio's `play` / `onLand`), `TRAVERSAL_CLIPS` in the play request, `setClips`
  on the play data, `padLanes(before, after)` in `padFrame`, `input()` before `walk.frame`, `hudFrame(hud)` and
  `hud.feed({ climb: traversal.hudClimb() })`; the hook's `traversal()`, `action()`, `setLean()` (`hook.ts`).

### 7.4 Bindings

| control | the game's | the viewer |
|---|---|---|
| Cross (button 0) | Action (climb, the ladder slide) | the `action` lane, on its press, walking |
| Square | Jump | jump (the owner's layout) |
| d-pad Left / Right (14 / 15), held | peek left / right | the `leanLeft` / `leanRight` lanes, walking |
| keyboard X | (the pad's Cross) | the action, on its press, walking |
| keyboard Q / E, held | (the d-pad) | the peek left / right, walking (the fly camera's down / up) |

### 7.5 The sounds and the events

The traversal's clips play in the animator, so their `motion.rdr` callbacks sound through `Play.onEvent` ->
`WalkSounds` -> `GameAudio.onAnimCallback` like any clip's: `ladder_rung` (CZANIM `ladder_rung`, `.STEP_LADDER` at the
hips; reCOM's SOCOM 1 `sounds.rdr` `SND_STEP_LADDER ONESHOT RANGE(30,200)`), `climb_up` (`.CLIMB_UP`), `pull_up`
(`.PULL_UP`), `jump_whoosh` (`.JUMP_WHOOSH`). The wade's steps and a fall into water are the bed's `UNDERWATER`
material's (`.STEP_WATER`, `.FALL_WATER`) through the footfalls and the landing. `TraversalPage` sends only what no clip
carries: the slide's `~LADDER_SLIDE` (0x65f558, `FUN_00344f30` decomp 461031; the audio plays one pass of the loop) and
the slide's landing (`onLand` at its contact speed). Every `TraversalEvent` also goes out on `window` as
`s2u:traversal`: `ladderMount {from}`, `ladderRung {y}`, `ladderDismount {at}`, `ladderSlide {on}`, `ladderSlideLand
{speed}`, `climbStart {kind}`, `climbUp`, `pullUp`, `jumpWhoosh`, `climbEnd {kind}`, `waterEnter {depth}`, `waterLand
{depth}`, `waterLeave`.

**The HUD** (`./hud`, research 87): the climb prompt as `Hud.feed`'s `climb` (the step up and the vault as `low`: one
bitmap for all), the ladder's `action_slide.tif` through `Hud.setAction('ladder_slide')` while on a ladder.

**The jump** is the walk's (research 80): the standing jump stays on the floor (its rise is the clip's), so a ledge is
climbed from it as from the floor; the running jump's 79.9 up lifts the feet 13.6, bringing a 36 ledge into the table's
32 while the contact holds -- the jump-grab, pinned in `traversal.test.ts` on the walk's own `Walker.jump`.

## 8. The states [read]

`seal+0x174`: 0 stand, 1 crouch, 2 prone, 3 peek, 4 hang, 5 ladder, 6 in air, 7 idle, 8 dead, 9/10 carrying/carried
(the dispatcher decomp 445166-445230; reCOM `zseal.h:58-72`). `DAT_003deae8` "Jump" (0x661510) is an anim type, not a
state. The traversal anim types: Jump launch/fall/land/land hard, Step up, Stand -> Hang, Hang, Hang -> Climb, Hang jump
down, Ledge -> Hang backwards, Hop down forward/backwards, Climb crate/medium/over, Stand -> Ladder, Climb ladder, Climb
off ladder, Ladder -> slide, Ladderslide, Ladderslide land, Falling, Land soft/hanging, Fall forward, Get up forward,
Slide, Prone crawl/turn/strafes/cover, the peeks, 180. No roll, mantle beyond the climbs, rappel, zipline or swim.
