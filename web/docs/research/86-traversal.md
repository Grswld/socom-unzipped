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

### 3.6 Climbables for the tests [data]

`appflags` 4 is on 20 maps (MP2 359 polygons, MP12 151, MP6 89, MP1 68, MP81 62, MP61 57 ...), 5 on MP1 (100), MP6
(8), MP81 (3). Frostfire's, pinned by the tests: the crate `worldmodel/crates1/prop02` at x 922.8-940.6, z 761-778.1,
top 111.85 (h 11.9: "Climb crate", approached from z 790 at x 938, clear of the 19-tall `prop01` beside it); the
container `container_blue01` at x 680-720, z 640-680, top 130 (h 30: the hang). MP6's `crate05/mp6_justbox1` (13 tall,
`appflags` 5) is a climb-over; `wall_low3` / `wall_high2` (`appflags` 4, 29.5-30) are hangs.

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

### 4.3 The body [read]

Full-body clips, held on their last key (section 1). No hitbox shift in code (hit regions are per bone,
`damanim.rdr`, and follow the skeleton [inference]). `FUN_0057fa70` (441667-441672) holds per-stance points
(peek right (7.55, 9.78, -2.54), left (-0.24, 8.87, 5.11)) the AI reads (424337); meaning unconfirmed.

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

## 6. Crawling and headroom [read]

The headroom ray `FUN_0057efe0` (decomp 441190-441240) goes up from pos + (0, hips.y + 2, 0) to pos.y + 12 (to crouch)
or + 19 (to stand), passing when clear or when the hit's `(byte10 & 0xf) >> 2 == 1`. `FUN_00552ec0` (418916-419015)
refuses a stance change it blocks (prone to crouch needs the 12, anything to stand the 19), so a SEAL stays down under
a table; going prone probes the body's axis (`FUN_0054d620`, 11.2 and 8.0 at step_height x 0.5 = 3.25) and water <= 2.
The prone crawl has no ceiling test. The walk's crouch-run already runs the 19 ray (`walk.ts`); the stance change's
refusal is not modelled here (it is the stance's, the MOTION workstream's).

## 7. What the viewer does, the seams, the bindings, the events

### 7.1 Modelled

The ladder (contact mount at the foot and the head, the climb at 7.59, the rungs, the head ray, the foot, the slide at
0.8 g and its landing), the climb (appflags, contact, table, facing, action press, the automatic step up, the steer,
the clip's path, the hang and pull-up, the jump-grab), the peek (d-pad/Q/E held, still, side ray, stance clips,
camera ease, third- and first-person shifts, the pass's surface mode, no locomotion), the wade (water no floor,
depth, the factor, the stances). Tests: `test/traversal.test.ts` (18, synthetic hulls and Frostfire's), `clipPath.test.ts`
(2), `e2e/traversal.spec.ts` (Frostfire's ladder, crate and peek, with pictures).

### 7.2 Placeholders and simplifications (named in the code)

The crate/medium blend plays the heavier clip; "180" (the turn at a ladder's head) is instant; "Hang jump down" is a
let-go; the climb-off's reverse on collision, the slide from the head, `FUN_0054e430`'s ray, the material's foot
offset in `h`, the uphill factor in the water and the water's effects are not modelled; the ladder's 7.59 is derived
(W2.2c to measure); the fallback clip shapes (a smoothstep with each clip's seconds, rise and travel) stand in only
before the pack arrives.

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
