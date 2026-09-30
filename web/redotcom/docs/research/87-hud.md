# SOCOM II's in-game HUD: every element, its bitmap, place, colour and driver (2026-09-28)

The HUD workstream's reading for the viewer's walk mode (`packages/viewer/src/hud.ts`, `hudFont.ts`, `hudAssets.ts`).
Sources, all read-only, nothing launched:

- **The code.** `C:/Projects/socom_pc/game/analysis/socom2_game.elf.decomp.c` (line numbers `Lnnnnn` below), with the
  `DAT_` constants read out of `C:/Projects/socom_pc/dist/socom2_game.elf` (string addresses checked against the
  decompilation's: `0x3e66c0` is `"%d MAG%c"`) and the class names of `recomp/socom2_names.csv`. Values the ELF holds as
  zero were resolved from their static initialisers (`0x3ff610`, the ammo text and the rounds' y; `0x3ff9c0`, the
  health bar's colours) or their runtime writers. reCOM (`research/recom/src/Apps/FTS/hud/hud.h`) names the classes;
  its `.cpp` files are empty.
- **The scripts.** `READERC.ZAR/hud.rdr` holds **no layout**: `static_radio (529 388)`, `dynamic_radio (575 388)`, the
  tactical map's polygon/line colours (`TacMap`) and the single-player tutorial pop-ups (`EventPopups`: 11
  `ActionIcon1stTime`, 119 `AnimCmd`, 2 `HudObjective` triggers). The layout is code. `READERC.ZAR/fonts.rdr` holds the
  two faces, `font_titlebar_01` and the HUD's `font_text_01` (§3).
- **The bitmaps.** Four libraries in every `MP*.ZDB` under `RUN\COMMON\`: `HUD_TXR` (37: the action icons, the pad's
  button faces), `HUD2_TXR` (72: the panels, the compass, the reticles, the nav marks), `HUDW_TXR` (65: the weapon icons,
  the fire-mode rounds), `FONT_TXR` (2: `font_text_01.tif`, `font_special_01.tif`); each against its own `_PAL`.
- **The pictures** (the console's own, PCSX2, 640x448 or 640x480 resized to 448 as the reference's notes do):
  `scripts/parity/refs/console_spawn_slot8.png` (Seeding Chaos at spawn, single player: the ammo box, the reticle, the
  compass, the team list) and, for the multiplayer HUD, `logs/parity/s4_pcsx2/A_ready091.png` (Vigilance, a SEAL in a
  round: ammo box, compass with a nav mark, info box "socomp / 04:49 / 2m", the radio icon), `A_rend053.png` (the
  `CROUCH` word), `A_ready024.png` (the "STARTING ROUND 1 OF 11" banner) -- the last three are not in the repository.

All positions are in pixels of the PS2 frame, **640x448, y down**: `CHUD` writes them straight (§2 on why a 480-line
reading is wrong), top-left corners unless said otherwise.

## 1. The elements of a multiplayer round

`CHUD` (the HUD object; its members are at the offsets named) draws three layers in order 0, 1, 2 (`FUN_001fba70`
L57752, called L50862-50869; `FUN_001f6e10` assigns a layer, 2 by default); the compass ring last (`FUN_00212130`).
The whole HUD is off while `CHUD+0x1a6f5` bit 0 is clear (`HUD_ON`/`HUD_OFF`). Every HUD string's colour is
`DAT_00408e40..4c` = **(128, 128, 128) at alpha 80** (the GS's 128 is 1: white at 0.625); the panels' alpha is **76.8
(0.6)**. On a spawn the ammo box and the team list **fade in**: hidden for 1.0 s, then alpha x (t - 1) x 2 to full at
1.5 s (`DAT_003dc380`, L56760-56800).

| # | element | bitmap / text | place and size | colour, alpha, motion | driven by | in the viewer's walk |
|---|---|---|---|---|---|---|
| 1.1 | ammo box panel | `newweapnbkrnd.tif` (HUD2, 128x64) stretched | x -10..160, y 364..439 (`DAT_003dcb90/98/a0/a8` = -10, 364, 170, 75) | alpha 0.6 x fade | -- | drawn |
| 1.2 | weapon icon | the weapon's HUDW icon (`FUN_005be050`); M4A1: `m4carbine_icon.tif` 128x32 | top-left (20, 389), its own size | alpha 1 x fade | the weapon in hand | drawn (`setWeaponIcon`) |
| 1.3 | rounds | `"%d/%d"` (`0x3e66b8`): rounds in the magazine / capacity | pen x 15, baseline 382, scale 0.9 | text colour x fade | `fire.state().magazine` | drawn |
| 1.4 | magazines | `"%d MAG%c"` (`0x3e66c0`): magazines - 1, `'S'` unless one; hidden with none | pen x 95, baseline 382, scale 0.9 | text colour x fade | the same | drawn |
| 1.5 | fire mode | `firemode.tif` (HUDW, 32x16) x 1, 3 or 4 for mode 1, 2, 3 (`FUN_00237b40` L85254) | x = 15 + 36i, the first moved to 10; y 422; its own size | alpha 1 x fade | the weapon's fire mode | drawn, 3 at rest (the console frame's; `setFireMode`) |
| 1.6 | compass ring | `compass_lo.tif` (HUD2, 128x128) at 0.75 | 96x96 centred on (565, 90) (`DAT_003dc508/50c`; `FUN_00211510` L67950-68287 overrides `CHUD_Init`'s 486-614 x 2-130) | alpha 100 (0.78); **turned** each frame by the player's facing (`FUN_00358730`) | the heading | drawn, turned by the walk's yaw |
| 1.7 | compass marks | `ret_nav_01..24`, `ret_able`, `ret_bravo`, `ret_objective`, `ret_bomb`, `ret_base`, `ret_hostage`, `ret_friendly`, `ret_extraction`, `ret_triangle`, `hud_talk`, `small_compass` (HUD2, 16x16) | 38 slots; within 200 units at radius distance x 0.005 x 65 and their own size, beyond it pinned at radius 64 at 1.2x with a 0.6x arrow at radius 50; most hidden beyond 900 | each type its own RGB (`FUN_002126f0` L68576); types 1-13 pulse alpha 64-128 at 250/s | objectives, team mates, the bomb, **nav points** | the nav points drawn (§10); the rest need objectives or a team the viewer has not |
| 1.8 | info box: health bar | untextured, (0, 128, 64) filled, (128, 64, 64) lost, (100, 100, 100) dead; a hit flashes white to green (`CHealthBar` `FUN_00241cc0` L89935) | (488, 396), 134x18 (`FUN_002388a0`) | alpha 80 | the player's health | drawn full |
| 1.9 | info box: the name on the bar | the player's name, scale 0.9 | centred on the bar, baseline 411 [measured on the Vigilance frames: ink x 535-575, y 402-411] | text colour | the profile | drawn when set (`setPlayerName`); empty by default |
| 1.10 | info box: timer line's box | `newweapnbkrnd.tif` mirrored [measured: x 488-622, y 418-438, its stripe on the left] | -- | alpha 0.6 | -- | drawn |
| 1.11 | round timer | `"%02d:%02d"` | pen (500, 433), scale 0.9 | text colour | the round clock | drawn **static** at 06:00 (`setTimer`) |
| 1.12 | range | `"%dm"` | pen (587, 433), scale 0.9 | text colour | the distance to what the reticle is on | drawn: the shot's own segment's hit, metres (`RangeFinder`, 5 Hz) [the game's source for the number not traced] |
| 1.13 | stance word | `STAND`, `CROUCH`, `PRONE` (`PoseBitmap`, `CHUD+0x11ca0`; it also loads `stance_*.tif`, never drawn) | right-aligned to x 480, baseline 431, scale 0.765 in multiplayer; (545, 380) in single player (`FUN_00222010` L75149) | alpha 127 on a change, down 64 a second (`FUN_00221d90` L75070): gone in 2 s | the stance | drawn on a change (`walk.posture()`) |
| 1.14 | action prompt | an `action_*.tif` (HUD, 64x64) by flag (§5) | 50x50 centred on x 306, y 365..415 (`DAT_003dc628/630/640`); up to two more at x 306 -/+ 62n | base + pulse x delta (§5); pulse 0-1-0 at 5/s (`DAT_0040d750`) | the player's action flags | drawn; the climb from the traversal's `climbPrompt()` |
| 1.15 | reticle | `ret_rifle_01/02.tif` | the frame's centre | (204, 204, 31) arms | the aim | `./reticle` (W2.4), not this pass |
| 1.16 | radio icon | `action_tune_team/offense/defense/spectators`, `action_no_talk2`, `action_dead_zone` (`FUN_00239570`) with the channel's count | `hud.rdr`'s `static_radio (529 388)`, `dynamic_radio (575 388)`; on the frame a 32x32 box at x 590-621, y 361-392 with a "1" beside it | grey 128, alpha 0 until used | the radio channel | **not drawn** (no radio) |
| 1.17 | event banner | the round's messages ("STARTING ROUND 1 OF 11", "OBJECTIVE: ...") over a mirrored panel | [measured on `A_ready024`: panel x 147-492, y 0-99; the line centred on x 320, ink y 81-93] | panel 0.6, text colour | round events | drawn: the round start (§8), and `flashMessage` |
| 1.18 | help lines | six lines of spectator/death help | x 324, baseline 380 + 18i | text colour | death, spectating | **not drawn** (no death); no "killed" format string exists in the ELF: there is no kill feed |
| 1.19 | team list (single player) | names right-aligned at x 510 (scale 0.855; BLUDSHOT shrunk to 0.74), orders at x 545 (`FOLLOWING`, `HOLDING`, `COVERING`, ... at `0x65caa0`), a 65x14 health bar at x 450, `hud_satchel.tif` at (522, row - 11) when carrying item `0x98`; rows' baselines 379, 394, 418, 433; two mirrored `newweapnbkrnd` halves 435-640 x 364-397 and 405-438 (`CTeamNames` `FUN_00221070` L74747) | -- | alpha 80 / 0.6 x fade | the fire team | **not drawn**: single player only (the console frame's SPECTER/JESTER, WARDOG/VANDAL) |
| 1.20 | tactical map (single player) | `CZNewHudMap`/`CZLineMap` over `AIMAPS.MPS` (§9); its 486-614 x 2-130 rect at zoom 1300 is the closed state, never drawn (corrected 2026-09-28: this row called it a radar) | 232-628 x 62-365 | -- | SELECT | drawn on `M` (§9) |

Not found in the ELF at all: `compass_bkrnd.tif`, `action_door_open.tif`, `action_door_close.tif`, `action_defuse.tif`.
**Corrected the same day:** the door icon is named by the *map* -- `READERM.ZAR/actions.rdr` lists each map's actions on
scene nodes (`node`, `valve`, `anim`, `type DOOR`/`MPBOMB`, `range`, `bitmap action_door_open.tif`/`action_MP_bomb.tif`):
Frostfire's three doors `bdoor_4`, `wdoor_1`, `wdoor_2` at 30 units, Blizzard's six doors and two bomb sites, Desert
Glory's one door (§5). No map names `action_defuse.tif` or `action_door_close.tif`. `TCM.tif`/`TCMArrow.tif` are the tactical command (radio) menu's
(`0x413120`), `hud_check.tif` and `team_background.tif` the objective list's (L63441): none is on the HUD at rest.
The scope's picture (`ret_scope_01/02`, `nvg_*`) is the reticle's (the ACCURACY workstream). **Corrected
2026-09-29:** there is a zoom readout, and a range line in the scope -- §13 (research 84 found them).

## 2. The bitmaps: four libraries, stored bottom row first, drawn bilinear

- **Upside down.** Decoded the way the world's textures are (row 0 of the decode is row 0 of the stored texels), every
  HUD bitmap comes out upside down against the console: `m4carbine_icon.tif` with its magazine up, `compass_lo.tif`'s
  `N` mirrored top-to-bottom (a rotation cannot turn it back: the console frame's ring at a half turn shows a true `N`),
  and `font_text_01.tif`'s capitals in rows 103-127 where `fonts.rdr` says `A` is `UL (2 0) LR (13 25)`. `readHud`
  (`hudAssets.ts`) flips the rows once; everything downstream indexes top row first, as `fonts.rdr` and the frame do.
  (The reticle's pair, read by `./hudBitmaps` for W2.4, is not flipped: its arm is symmetric and W2.4 placed it by
  measurement.)
- **The font is PSMT4.** `font_text_01.tif` (512x128) is TEX0 PSM `0x14`, the only 4-bit texture on the 22 maps; its
  16-entry CT32 CLUT sits in palette 139's buffer as an **8x2 block** (entries 0-7, then 8-15 sixteen entries on): a
  white ramp, alpha 0-120 and 135-255. `@s2u/gs` decodes it since this note (`csm1Clut4Index`).
- **No 480-line space.** The console frame's ammo panel is 160 pixels wide and 74.67 tall, which reads like a 160x80
  box squeezed from 480 lines to 448 -- but `CHUD`'s own numbers are -10..160 x 364..439 (170x75, its left 10 pixels
  off-screen), the icon and the rounds sit at their own sizes, and the compass is round. The frame is the HUD's space.
- **Bilinear, sampled at the pixel's corner.** Every HUD bitmap's TEX1 asks for bilinear filtering; the GS samples a
  sprite at each pixel's integer corner where GL samples at the centre, so the console's content sits half a pixel
  right of and below GL's for the same quad. Drawn nearest-neighbour at the code's rectangles, every bitmap on the
  console frame was +0.2..+0.8 pixels off ours; the pass now filters bilinearly and moves the texels by
  `GS_SAMPLE_OFFSET` 0.5 (edges unmoved), which brings them to -0.5..+0.1 (§6).

## 3. The font and the text model

`fonts.rdr`'s `font_text_01`: `textures (font_text_01.tif font_special_01.tif)`, `xspacing 0`, `opacity 0.7`, `scale
1`, `topy 0`, `boty 15`, `dropshadow { offset (1.5 1.5) color (0 0 0) opacity 0.75 baseline 0 }`, 185 glyphs of 25-row
cells (the 95 printable ASCII ones are transcribed in `hudFont.ts`, checked against the archive by its test). `CHUD_Init`
(`FUN_001fa360` L57227) loads it, falling back to `arialblack` if the bitmap is missing.

The draw (`FUN_003639c0` -> `FUN_003635c0` L261085 -> one sprite a glyph, `FUN_00361bd0` L260233):

- the glyph's quad runs from `pen + DispPos.x x S` to `pen + (width x HorScale + DispPos.x - 1) x S + 0.5`, over texels
  `UL.x .. UL.x + width - 1` (`S` = the string's scale x `+0x78` x the font's `+0x34`, 0.9 on the ammo box);
- the pen then moves by **`int((width + DispPos.x - 1) x S + 0.5) + xspacing`** (`FUN_00363c20`) -- the integer step is
  what makes "30/30" and "2 MAGS" fit: at S 0.9 the advances 7 ('3'), 8 ('0'), 9 ('/'), 11 ('M'), 9 ('A', 'G') put
  the rendered glyph centroids within 0.4 pixel of the console frame's;
- the glyph stands on the string's y, the **baseline**: its quad from `y + (B - h) x S + DAT_0049e9a8` up to
  `y + B x S + 0.5 + DAT_0049e9a0` (`h` 25, `B` a short of the font texture's record); the two `DAT_` offsets are
  runtime values. Fitted on the frame: the 25 rows cover 25 x S x 448/480 pixels (0.84 at 0.9) with row 20 -- the
  letters' foot -- on the baseline + 0.3, and the pen 0.6 left of the formula (`PEN_NUDGE`, the same on all four
  lines measured). Those three numbers are fits, not readings.
- the drop shadow is a second pass offset by the font's `+0x40/+0x44`, **kept as integers** (the 1.5 truncates to 1),
  times S; its alpha is `min(string alpha, 0.75 x 128)` = 80, black.
- the string's alpha is `min(80, font opacity 0.7 x 128 = 89.6)` = **80**: the console frame's text peaks at 168 over
  the panel's 23, which is 23 + 0.625 x 232.

## 4. What the viewer's walk shows, and what it cannot

The viewer's walk is one SEAL on a multiplayer map with no round, no team and no objectives. It shows 1.1-1.6 (the ammo
box and the compass exactly as in a round, the compass with the map's nav points, §10), 1.8-1.12 (the info box: a full bar, the name empty unless set, the timer
**static** at a round's 06:00, the range live), 1.13 on a stance change, 1.14 when the traversal or a caller feeds a
prompt, 1.17 on `flashMessage`. It leaves out the compass marks, the radio icon, the help lines, and the two
single-player elements (the team list, the radar). The HUD is drawn **only in walk mode** (`hud.setVisible(walking)`)
and fades in over 1.5 s after entering it, as after a spawn.

## 5. The context prompts (`CZActionBitmap`, `CHUD+0x174d0`)

Init `FUN_0021ded0` (L73437), colours `FUN_0021f120` (L73835), render `FUN_0021f210` (L73868), flags to icons
`FUN_0021f850` (L74040). One primary icon 50x50 centred on x 306, y 365-415; up to two more alternately left and right
at x 306 -/+ 62n. A hidden "ACTION ICON" label at (306, 358) scale 0.9 and a black 585-635 x 345-360 box (probably the
hold bar), both alpha 0. The colour is `base + pulse x delta`, the pulse ramping 0-1-0 at 5 a second:

| entry | base | delta | used for |
|---|---|---|---|
| 0 red | 120, 0, 0 | 80, 24, 24 | -- |
| 1 green | 24, 80, 24 | 24, 80, 24 | -- |
| 2 blue | 20, 50, 60 | 35, 80, 80 | an action that can be done (the viewer's default) |
| 3 grey | 42, 42, 42 | 8, 8, 8 | an action that cannot |

| prompt | flag | bitmap (HUD_TXR, 64x64) | the viewer |
|---|---|---|---|
| climb (a ledge; a ladder's foot) | `0x4` | `action_climb.tif` (a ladder, an up arrow) | `setClimbPrompt(climbPrompt())` from the traversal: any of its `low`/`med`/`high` (`dynamics.rdr`'s `low/med/high_climb_height` 1.3/2.15/2.65 m, x 10 in units at L456970-456975) |
| ladder slide ("LADDER SLIDE") | `0x10000` | `action_slide.tif` | `setAction('ladder_slide')` |
| pick up | -- | `action_pickup_item.tif` (`_item1`, `_item2`) | `setAction('pickup')` |
| the bomb: pick up, plant, defuse | -- | `action_MP_Bomb.tif`; drop `action_drop_MP_Bomb.tif` | `setAction('bomb')`, `'bomb_drop'` |
| C4, button, lever, turret, knife, restrain | -- | `action_place_c4`, `action_button`, `action_pull_lever`, `action_mount/dismount_turret`, `action_knife`, `action_restrain` | `setAction(...)` |
| a generic action; any missing icon | -- | `action_x.tif` (32x32, the pad's X) | the fallback; it is **not** drawn beside the others |
| a door (a map's `DOOR` action) | `actions.rdr` | `action_door_open.tif`, per the map's `bitmap` | `nearby: 'door'` within the door node's `range` (30) of the feet [the game's own reach test -- facing, a cone -- not traced] |
| defuse, door close | -- | `action_defuse.tif`, `action_door_close.tif` ship but nothing names them | not offered |

## 6. The viewer's drawing against the console's pixels (2026-09-28)

`e2e/hud.spec.ts` renders Frostfire in the PS2 presentation at spawn A, the heading the console frame's (yaw 180), the
magazine 30/30 and 2 spare, and cross-correlates each element's box of the drawn frame with
`console_spawn_slot8.png`'s (a 9-pixel box blur off both, the worlds under them differing; a 0.05-pixel search). The
content's offset, console minus ours, pixels:

| element | dx | dy | correlation |
|---|---|---|---|
| rounds "30/30" | -0.15 | +0.20 | 0.94 |
| magazines "2 MAGS" | 0.00 | +0.20 | 0.94 |
| rifle icon | -0.50 | -0.25 | 0.81 |
| fire-mode rounds | -0.35 | +0.05 | 0.98 |

Against the Vigilance round frame (not in the repository; the same script by hand): the compass ring +0.1/+0.1, the
timer "04:49" -0.1/+0.2, the range "2m" -0.1/+0.2, the `CROUCH` word +0.1/+0.7, the ammo box's lines within 0.2; the
health bar's edges 488-622 x 396-414 on both, the ammo panel's right edge at x 160 on both. Every element is within the
one-pixel bar; the rectangles themselves are `CHUD`'s numbers, asserted exactly by the unit tests.

## 8. The round start (2026-09-28, second round)

`FUN_001fb420` (called at L149758) resets the HUD, retracts any letterbox (`FUN_001fec60`), formats `"STARTING ROUND %d
OF %d"` (`0x3e3520`; `"PLAYING TIEBREAKER ROUND"` `0x3e3540` past the last) and posts it with `FUN_002b6530` into the
message window `READERC.ZAR/messages.rdr` configures -- left 157, bottom 91, maxlength 325, margins 10 and 8, which is
the panel **147-492 x 0-99** the frame shows, `newweapnbkrnd.tif` behind, up to 8 lines 15 apart, colour 0 (128, 128,
128) at alpha 100. Each line fades in at 280 alpha a second (0.36 s), holds `fadetime` 7 s from its posting, and fades
out the same way (`FUN_002b77a0`). "OBJECTIVE:" / the side's objective (`mp51LOC` 5100/5101: "ELIMINATE THE
TERRORISTS" for the SEALs in Suppression) arrives in the same window about 5 s later; what posts it was not found. The
only fader is `CFader_FadeIn(0.5)` at HUD init (L57476); no letterbox at spawn.

**Measured on the Vigilance round start** (`logs/parity/s4_pcsx2/A_ready021..034`, one frame a second, the round clock
read off each frame: 05:59 on frame 21 ... 05:46 on 34): the whole picture at a third of its brightness on frame 21,
full on 22; the single line's ink y 81-94, "STARTING ROUND 1 OF 11" ink x 231-407 (scale 1.0 by its width, not the
code's 0.9 x 1.1429); on frame 26 the objective's two lines in half-faded and the first line moved up -- ink feet at 61,
76 and 91 (the objective line "ELIMINATE THE TERRORISTS" at 0.765, 149 wide); the first line half gone on 28, gone on 29;
the objective half gone on 33, the panel gone on 34. Fitted: the round clock's 06:00 at 0.58 s before frame 21; the
first message posted at 0.36 s, the second at 5.36 s -- so **both 0.36 s in, 7 s from posting, 0.36 s out**, 5 s apart.

The viewer (`ROUND_START`, `roundStartAt`) plays: the fade from black over 1.5 s [the frames' 0.33 visible at 0.58 s
and full by 1.58 s; `CFader_FadeIn`'s 0.5 argument not resolved], the ammo box's 1-1.5 s fade (§1), the two messages
at 0.36 and 5.36 s with the code's 0.357 s fades and 7 s `fadetime` -- which put the model at 0.62 and 0.38 where the
frames measure 0.54 and 0.39 on frames 26 and 28/33 -- lines stacked 15
apart from the newest's baseline at 83.4 + 10.6 x its scale. `setRound({ round, rounds, objective })` changes the words.

## 9. The tactical map (2026-09-28, second round)

**SOCOM II has no tactical map in a multiplayer round.** `controller.rdr` maps `Select` to `TACMAP` (action 12 of the
table ending `0x3f2c10`; `FUN_002c6670` L167011 numbers the pad: Pause 0, Select 1, Circle 7, Square 8, X 9, R1 10,
R2 11, L1 12, L2 13, R3 14, L3 15), but the map object is made (`FUN_001fb420` L57630) and ticked (L56700) only while
the multiplayer flag `DAT_0045a0c1` is 0. In a multiplayer round SELECT **holds the scoreboard** (shown on the press,
L56760 / `FUN_0022be20` L79675, refreshed each second, hidden on release, L79873; the options read
"FIREMODE/SCOREBOARD"). The single-player map (`CZNewHudMap` with `CZLineMap`), 1:1, is what the viewer draws on `M`:

- **Toggle:** SELECT opens (`FUN_00209ae0` L64434 -> `FUN_0020a780`) and closes (`FUN_00209ee0` L64539 ->
  `FUN_0020a470`). Opening hides the HUD and the compass (`FUN_001f71c0`) and puts the player in input mode 4; closing
  restores them through the 1.5 s fade-in (`FUN_001f7030`). No fade of the map itself was found.
- **Geometry:** `CZLineMap` (`FUN_0020ebd0` L66383) draws the map's `AIMAPS.MPS` (research 75): its polylines (type
  `word & 0x1f`, the `hud.rdr` `TacMap` type; filled fans on flag bit 0x20, `FUN_0020f5c0` L66770, else lines,
  `FUN_0020e470` L66172, thick when `Width` > 1.01; alpha opacity x 127), zones of kind 1 or 5 as (200, 0, 200)
  outlines at alpha 100 (`FUN_0020df70`), named points of kind 5 labelled (`FUN_0020dac0`); a vertex at its cell's centre
  (`FUN_002102e0` L67204); linked sub-maps at 0.3 alpha. Blizzard (79), Frostfire (253) and Bitter Jungle (56) have
  polylines; the file's `value` is 0 on 534 of 553 (type 0: white lines at full), 1-3 on 19. The fill flag's source in
  the file was not found: the viewer draws every polyline as lines.
- **Layout:** the box 232-628 x 62-365, centre (430, 213.5); the grid 7 horizontal lines 38.125 apart and 9 vertical
  40.85 apart from x 230, `FOV.tif`'s texel at (0.5, 0.94) at alpha 24, each line wiping in over 1 s, 0.1 s apart; the
  north arrow's three strokes round (600, 100) (`FUN_0020be00`) and "N" at (596, 107), scale 1; the player
  (`FUN_002222e0`) an 8x8 `teammate_health.tif` and a 72-pixel `FOV.tif` cone in the team mate's (82, 205, 205)
  (enemy (150, 0, 0), dead (10, 10, 10)); markers 20x20 in their compass bitmap and colour (`FUN_0020e750`);
  `hud_arrow_off2.tif` at the box's edges, pulsing 0-128 at 1.5/s where more map lies that way, else 32; the legend
  (R2 held: a black 230-445 x 60-210 box, 16-pixel icons at x 257, text 0.72 at x 276) and the objective list on the
  left are not drawn.
- **Transform** (`FUN_0020ae50` L64993): minus the player's (x, z) (or the pan point), turned by
  atan2(-f.z, -f.x) + pi/2 so the camera's forward is up -- **heading-up, fixed while open** -- scaled by 396 / zoom,
  plus the box's centre. **Zoom** is the world width across the box: 2200 on opening, 1300-4000 (`mission.rdr`'s
  `TacMapZoom` defaults 1, 2.2, 0.55), 24 units a tick on the right stick; **pan** 36 units a tick on the left stick,
  clamped to the first sub-map; Circle centres between the player and the objective, Square on the player, X selects.
- **The viewer:** `tacMap.ts` (`TacMap`, `tacMapLayout`, `readTacData`), the HUD pass's layer 1. `M` toggles it while
  walking; `-` / `=` held zoom out and in at 24 units a 60 Hz tick. No keyboard pan (WASD still walks: the viewer does
  not freeze the SEAL as input mode 4 does); `panBy`/`centre` wait for the pad's sticks. There is no box behind the map
  (none was found in the code), so it is drawn straight over the world.

## 10. The compass's nav marks (2026-09-28, second round)

`FUN_002acad0` makes a compass mark for each AIMAPS named point; its type is the name's first letter - 0x55 for c-z, so
Charlie is 14 and its bitmap `ret_nav_01.tif` (C; the green box is part of the bitmap), up to Zulu's `ret_nav_24`. The
nav marks' colour is (32, 62, 32) (`FUN_002126f0`'s table); their alpha `DAT_003dc500` 128. Of the nav marks only those
within 200 units and **the single nearest** show (L68254). Placement (`FUN_00211510`): the bearing from the view,
(sin, cos) clockwise from straight ahead; within 200 units at radius distance x 0.005 x 65 at the bitmap's own size;
farther, at radius 64 at 1.2x (`DAT_003dc510`), with the mark's second bitmap -- `ret_triangle.tif` at 0.6x, turned to
the bearing -- at radius 50. North is -z, east +x (the compass ring's own reading, §1.6). The pinned mark's arrow is
orange on the frames, (170, 124, 53) at its peak over a white bitmap: (85, 62, 27) as a GS colour [measured; the table
entry it takes was not resolved].

**Checked against the console:** Vigilance's round-2 start (`A_rend053`, the SEAL facing north: the ring's N at
(565.5, 57.0), bearing 0.0): the green "C" box's pixels x 590-608, y 27-45, centre (599.5, 36.5), the orange arrow x
589-593, y 46-49. The viewer at Vigilance's A (540, 1456) facing north: Charlie (689.76, 1216.11) 283 units off, 32.6
degrees right -- its box x 589-607, y 26-44 (centre (598.5, 35.5)), the arrow x 588-593, y 46-50: **one pixel** from the
console on each edge, the console's SEAL standing where KNOWN §1 puts A to within that. The viewer's nav points are the
map's kind-1 named points (Frostfire: Charlie, Delta, Echo, Foxtrot; Vigilance: Charlie, Delta, Echo, Foxtrot, Juliet,
Romeo, Whiskey). The marks' other types (the bomb, extraction, objectives, team mates) wait for data the viewer lacks;
the multiplayer handlers of types 0-13 (the jump table at `DAT_003e44b0`) were not resolved.

## 12. The round's scoreboard: SELECT held (2026-09-29, third round)

In a multiplayer round SELECT held shows the scoreboard (§9). `FUN_0022be20` (L79675): on the press
(`FUN_002c64e0(0xc) == 1`) `FUN_0022cc10` (L79974) builds it and sets `DAT_0040f608`; while held `DAT_00412e78`
accumulates and the layout is rebuilt every 1.0 s (L79866); the release (state 3) calls `FUN_0022bb30` (L79873).
`FUN_0022a8b0` (L79100) draws it; while it is up L56808-56828 hide the ammo box (`CHUD+0x1a700`), the compass, the
action prompts, the reticle and the timer every frame.

| part | what | place | colour |
|---|---|---|---|
| panel | `newweapnbkrnd.tif` nine-sliced (`FUN_0022ae90` L79223): 20-pixel corners, the corner texels 20/173 by 20/74 (`DAT_003e5718` 0.8844, `DAT_003e5720` 0.2703, L327982), the left corners mirrored | x 153..630, y 104..430 (the message window's bottom 91 + its YMargin 8 + 5) | bitmap white, alpha 100 [the colour is never set] |
| team bars | untextured, under the panel | x 153..630, y y0..y0 + 25; SEALs y0 104, TERRORISTS (104 + 430) / 2 = 267 (`FUN_00229d00` L78846) | SEALs (32, 32, 64), TERRORISTS (64, 32, 32), alpha 80 |
| team line | locale 60521 "SEALs" / 60522 "TERRORISTS", " :   " (0x3e5788), "%d" (game +0x120 / +0x124, rounds won [inferred]) | pen (171, y0 + 20), scale 1 | alpha 90 |
| columns | locale 60523 "KILLS", "DEATH" (0x3e5790), "SCORE" (0x3e5798), centred (C2DString +0x69) | centres 455, 522, 588 (175 and 175/3 from `DAT_003dc8e8`), baseline y0 + 20, scale 1 | alpha 90 |
| rows | 8 a team, by score (`FUN_0022de60` L80575: same team, not a spectator, named); the clan tag "[clan]" at x 163 in (128, 64, 32), the name at 223, the three numbers centred on the columns (kills +0x550 + 0x598, deaths +0x556 + 0x59e, score +0x580 + 0x5c8) | baseline y0 + 38 + 16.8 i (SEALs 142 .. 259.6, TERRORISTS 305 .. 422.6), scale 0.8 (`FUN_0022a290` L78951) | (115, 115, 115) alpha 110; the local player's blue 12 (yellow) [inferred: controller vtbl+0x2c]; the dead x 0.6 [inferred: +0xe1 bit 4] |
| stripes | odd rows 1, 3, 5, 7: `newweapnbkrnd`'s centre texel | x 161..624, baseline - 12 .. + 4 (`DAT_003dc990..9b0`) | alpha 60 |
| satchel | `hud_satchel.tif` on the row of the carrier of item 0x9a | x 200..216, baseline - 12 .. + 4 | -- |
| GAME DETAILS | a (64, 128, 64) `newweapnbkrnd` strip y 104..129 over its body y 129..229; "GAME DETAILS" (0x3e57c0) at (20, 124), scale 1, alpha 90; three lines at x 24, y 145 / 165 / 185, scale 0.8, (115, 115, 115) alpha 110, cut with "-" to 118: online the lobby, the game's name and its type (1 BREACH, 2 DEMOLITION, 3 ESCORT, 4 EXTRACT, 5 SUPPRESSION); LAN "LAN game", the name, the type (`FUN_0022ac30` L79186) | x 10..152 | strip alpha 80 |
| SPECTATORS | the same strip y 229..254, "SPECTATORS" (0x3e57b0) at (20, 249); up to 8 names at (24, 270 + 16.8 i), scale 0.8 | x 10..152, body to 430 | -- |
| Modern place (owner ruling 2026-09-29: "try to bump up the location of the scoreboard a bit when in modern mode") | the whole board -- panel, bars, rows, GAME DETAILS, SPECTATORS -- raised by `MODERN_SCOREBOARD_LIFT` 4 in the Modern presentation only (`scoreboard.ts`); the PS2 presentation keeps the game's place | top 100: clear of the message window above (panel to 99, its newest line's glyph cells to ~99.9), the same at every aspect (both centre-anchored, height-scaled) | -- |
| Modern size (owner ruling 2026-09-29, final: "you can just make it a bit smaller instead of moving the top chat") | the whole board scaled uniformly about its top-centre (320, 100) by `modernScoreboardFit` (`hud.ts`), Modern only: just enough that its bottom (426 at scale 1) and, where it stands beside rather than over, its sides keep `MODERN_SCOREBOARD_MARGIN` 4 from the bottom HUD still up (health bar top 396, the name's glyph cells 394.5, box 418, range 416.5, stance word 417.0, zoom 403.5 -- all right-edge-anchored but the zoom's left edge); floor `MODERN_SCOREBOARD_MIN_SCALE` 0.75; the message window untouched, the PS2 place pinned | scale 16:9 0.8957 (the bar binds), 21:9 1, 16:10 0.8911, 4:3 0.8911, phone 812x375 0.9602 (the stance word binds), phone 390x844 0.8911 (the name binds); every aspect clears above the floor | -- |

The draw order: the team bars, the panel, the details' body and header, "GAME DETAILS", the stripes, the teams'
strings, the detail lines, the spectators' panels and names, the satchel last.

**The viewer** (`scoreboard.ts`, `scoreboardLayout`): SELECT on a pad (the `scoreboard` lane, `./gamepad`'s
`PAD_LAYOUT`, standard button 8) or **Tab** held on the keyboard (`scoreboardKeys.ts`), walking only; the HUD pass's
layer 1, the bars as its shapes. Filled with the one SEAL -- `hud.setPlayerName`'s name, else "SEAL" -- on the first row
in the local player's yellow, its three numbers 0; the TERRORISTS empty; the details "LAN game", the map's name and its
game type (`./mapOrder`'s `mode`); no spectators. No console frame of the held scoreboard is in the captures
(`A_rend050`'s "ROUND COMPLETE" is the round's end screen, another screen), so it is drawn from the code alone.

## 13. The zoom readout and the scope's range (2026-09-29, third round)

`FUN_001f6ce0` (L56025): the magnification from the view mode (`+0x200`: 4 gives 9.0, 5..12 the weapon's zoom,
`FUN_005be660`; else 0); over 1.01 **`"ZOOM: %2.1fx"`** (0x3e3098) into `CHUD+0x744` at the pen (20, 420), scale 0.9
(`CHUD_Init` L57311-57319: the HUD's text colour, alpha 80); hidden otherwise. Re-evaluated on the HUD's scoped and
normal switches (`FUN_001f7360` L56238, `FUN_001f7560` L56287); in the scoped state the ammo box hides
(`FUN_00237de0` L56217-56225), so the readout stands where it was. The reticle's range: **`"RANGE(m): %.0f"`**
(0x3e4850) of the distance to what the reticle is on / 10, `"RANGE(m): ----"` (0x3e4860) with nothing
(`FUN_00216770` L70446-70463), written into CHUD's own string (scale 0.9, L57320-57326), shown by the reticle's switch
(`FUN_00213e20` L69258) at (415, 215) with the scope's `ret_scope_02` (`DAT_003dc528/530`, L69508), at (515, 40) with
the binoculars, (515, 70) with the night vision, hidden otherwise.

**The viewer** draws both while `hud.setZoom` (the ACCURACY workstream's `zoom.magnification()`) is over 1.01: the
readout at (20, 420), the range at (415, 215) from the range finder's metres (§1.12), and hides the ammo box.
The binoculars' and night vision's (515, 40/70) are not drawn: the viewer has neither.

## 14. The message window's posts (2026-09-29, third round)

`FUN_002b6530(scale, window, text, colour, centred, fade)` (L157901): a scale of 0 is the window's own, else scale x
1.1429; `colour & 0xff` indexes (`FUN_002b7530` L158316) 0 (128, 128, 128), 1 (128, 128, 64), 2 (64, 64, 96), 3 (64,
128, 64), 4 (128, 64, 32), 5 (128, 64, 64), all alpha 100; `fade` 0 is the window's `fadetime`. The windows: the main
one `0x4366a0` (`messages.rdr`: left 157, bottom 91, scale 0.9, fadetime 7), the small one `0x437060`
(`small_messages.rdr`: left 12, bottom 91, scale 0.9, fadetime 5, maxlength 120), the subtitles `0x436b80`.

What one SEAL can make the game post: an item's name on a pick-up and "Satchel" (colour 0, the small window,
`FUN_005bb000` L473374, L473660); "Unable To Deploy: Max Equipment Items Placed (4)" (colour 2, the main window,
`FUN_005be9a0` L475331); in multiplayer the deaths -- "%s falls to their death" (0x65c440), "%s commits suicide with
%s" (0x65c460), "%s fragged %s with %s" (0x65c480) (colour 0, `FUN_00547860` L412893, `FUN_00547a90` L412970); the comm
menu's and the taunts' "%s : %s" (colours 3 and 5, `FUN_005e7960` L498224). **Not posted by anything:** reload, out of
ammo, low ammo, an empty magazine, the fire mode's name, the stance, the weapon switch, the zoom -- the ELF has no such
strings ("RELOAD" and "NOAMMO" are `CHRSND_*` sound ids); the fire mode is only `firemode.tif`'s rounds, the stance only
its word. "%s : FIRE IN THE HOLE!" (locale 60592) is a team mate's grenade, never the local player's.

**The viewer** posts with `hud.postMessage(text | lines, scale = 0.9)` on the main window (0.357 s in, out 7 s after
posting, the newest 8 lines, a colour per line), and posts the one death it can cause: a landing of the death class
(`FUN_005ac1f0`'s class 3) is "%s falls to their death" with the player's name -- the viewer's SEAL then walks on. No
pick-ups, deploys, grenade kills or comms exist in the viewer yet.

## 15. Estimates and open ends

- The text's vertical factor (25 x S x 448/480), its foot row offset (+0.3) and `PEN_NUDGE` (-0.6) are fitted (§3);
  the `CROUCH` word at scale 0.765 sits 0.7 high of the console's, which says the vertical model is not the code's.
- The name's place on the bar, the timer box's rectangle and the banner are measured, not read.
- The range readout's source in the code was not traced; the viewer uses the rifle's shot segment.
- The fire-mode count at rest is the console frame's three (mode 2); the viewer's rifle fires fully automatic (W2.5
  reads `MaxFireMode 3` as automatic, which the HUD would show as four rounds). `setFireMode` is the switch.
- The prompt's vertex alpha (1) and the stance word's shadow are assumed like the other strings'.
- The fader's 1.5 s and the two postings (0.36, 5.36 s) are fitted on one round start; what posts the objective is not found.
- The tactical map's fill flag, its background (none found), and its pad controls (sticks, Circle/Square) unbound.
