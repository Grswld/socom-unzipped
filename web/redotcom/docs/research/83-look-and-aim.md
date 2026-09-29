# 83 — The look and the aim: the pad's law, the body and the camera, the scope, the shake, the bob

*(2026-09-28, the look & aim workstream of the walk; branch `claude/web-look`. Read-only research on the decompilation
`game/analysis/socom2_game.elf.decomp.c` (line numbers below are that file's), the console's RAM at the spawn
`logs/parity/spawn_pcsx2.rdram` (PCSX2; addresses are EE physical), `READERC.ZAR` / `ZWEAPON.ZAR` off the disc, reCOM
`research/recom`, and research 22 §3.1 / §3.2 (the measured turn). No game or emulator was run.)*

**Summary.**

- **The look is a cubic on the stick with a 0.3 dead zone, a x√2 "circle" step and a 0.28 s ramp, then a gain of
  1.72**: at full push the turn axis is 0.65 × 1.72 = **1.118**, the turn **2.236 rad/s (128.1°/s)** and the pitch
  **0.950 rad/s (54.4°/s)**. The model reproduces research 22's four clean measured axes to the third decimal
  (§1). `turn/pitch_throttle_a/b` exist and are **off** on the console.
- **The camera's yaw is the body's.** The stick turns the actor; the camera sits behind the actor matrix. There is no
  upper-body twist before the legs turn and no stand or crouch turn-in-place clip; prone plays `seal_prone_turn`
  while turning. `stand_turn_factor` has no reader (§3).
- **The pitch** moves at `pitch_rate` × axis to the stance's aim limits and not past; outside them (a stance change)
  it comes back at **0.5 rad/s** (§2).
- **Aim.** The first-person views change nothing. The **scope** divides the look by its magnification (the M4A1's
  ZoomMode 1.5 and 2.5), view mode 4 by 5 more, and slows the move stick to 0.2 (§4).
- **`CAMERA_WIGGLE` has no reader in SOCOM II.** The game's shake is a two-axis screen-centre swing, `FUN_002994e0`,
  with three explosion presets by distance and a per-round `ScreenShake` on the machine guns (§5).
- **`BOBBING_FIRSTPERSON`** is a vertical screen shift of 6 × cos(phase) PS2 pixels in first person, the phase at
  15 rad/s × the move stick (prone 4 px at 8) (§6).
- **The mouse** is the viewer's choice: raw angles, one inch at 800 DPI = one second of full stick (0.160°/count), the
  pitch at the game's 0.425 of the turn; a `stick` law that runs the mouse through the game's curve is the purist's
  option (§7).

## 1. The stick to the turn axis

The chain, one frame:

| step | where | what |
|---|---|---|
| read | `FUN_002da930` 179546-179563 | `v = (127.5 − byte) × 0.007843138` per axis; the right stick into pad `+0x218` (x) / `+0x21c` (y) |
| zero-snap | `FUN_002da3a0` 179288-179358 | a stick within 0.01 of centre that stays within 0.0164 for 0.4 s reads 0 (inside the dead zone anyway) |
| dead zone | 179566-179585 | `|v| < +0x2b0` → 0; the right stick's `+0x2b0` = **0.3** on the dump |
| rescale | 179602-179619 | flag `+0x2c8` = 1: `v = sign × (|v| − 0.3) / 0.7`, clamped by `FUN_00267a60` to ±1 |
| circle | `FUN_002da200` 179235-179266 | flag `+0x2c9` = 1, `DAT_003df240` = **1** on the dump: `r = 1`; if `(int)|y| < (int)|x|`, `r = y/x`; if the other way, `r = x/y`; both axes × `√(1 + |r|)`, clamped. Below a full push both integer parts are 0, so **each axis is × √2** |
| curve | 179658-179720 | flags `+0x2d0`/`+0x2d1` = 1: `v = sign × |v × k × v^(n−1)|`, k = `+0x2b8` = **0.65**, n = `+0x2bc` = **3** |
| ramp | 179722-179765 | flag `+0x2ca` = 1, s = `+0x2cc` = **0.75**: a frame of `dt` may grow `|v|` by `(dt + (1 − dt) × 0.13 × (1 − s)) / (s + 0.5)` (0.0389 at 60 Hz); a smaller `|v|` is taken at once; a reversal starts from 0 |
| gain | `FUN_005966a0` 453771-453775 | turn = `−(−v.x) × DAT_00650630`, pitch = `DAT_003df198 × v.y × DAT_00650628`; on the dump both gains **1.72**, `DAT_003df198` **+1** (not inverted) |
| throttle | 453779-453806 | only when `DAT_0066b3e8` ≠ 0 — **0 on the dump**: `|v| ≤ a → v × b/a`, else `b + (1−b)(|v|−a)/(1−a)`; `turn_throttle_a/b` 0.9 / 0.4 (the table's `+0xf8/+0xfc` = `DAT_0044c348/c34c`), `pitch_throttle_a/b` 0.9 / 0.4 (`+0x100/+0x104`) |
| zoom | 453807-453817 | ÷ `FUN_005be660` (the scope's magnification, 1 unscoped); × `DAT_00650638` = 0.2 more in view mode 4 (§4) |
| to the actor | `FUN_00551ec0` 418613-418622 | `actor+0x23c` = the turn × `actor+0x1368` (the movement scale, ≤ 1 by `FUN_00553dc0`); zeroed in the states `FUN_00577e40` names at 418300-418335 and 418626-418701 (climbs, ladders, the `NoTurn` clips of `motion.rdr`: 31, all climbs, hangs, restraints, switches) |
| the turn | 418340 | `actor+0x48 = DAT_0044c290 (turn_maxrate 2) × actor+0x23c`, rad/s |

The pad's settings are `FUN_002da5e0`'s defaults overwritten by `FUN_002da6c0`'s preset 0 (k 0.65, n 3, dead zone 0.3,
ramp 0.75; presets 1 and 2 are 0.82 / 0.16 / 0.5 and 1.0 / 0.16 / 0.25); on the dump the pad object is at
`0x849e90`, its sticks' blocks at `0x84a114` (left: n 1, no curve, no ramp) and `0x84a13c` (right, as above).
`FUN_002da800` shows k as the options menu's slider: `(k − 0.5)/0.5`, then `/0.6` below 0.5 — k 0.65 is the slider's
middle.

**Against research 22 §3.1** (`actor+0x23c` at the end of a 1 s hold, single player, the movement scale 1):

| rx − 0x80 | byte | model | measured |
|---|---|---|---|
| +127 | 255 | 0.65 × 1.72 = **1.118** | 1.118 (both runs) |
| +96 | 224 | (√2 × 0.6527)³ × 1.118 = **0.879** | 0.879 (both runs) |
| +64 | 192 | (√2 × 0.2941)³ × 1.118 = **0.080** | 0.080 (run 3) |
| −64 | 64 | (√2 × 0.2829)³ × 1.118 = **0.072** | 0.072 (both runs) |
| −48 | 80 | **0.0035** | 0.004 (run 3), 0 (run 2) |
| +48 | 176 | 0.0048 | 0 (both runs) — the one miss, in the noise of a single-byte edge |

The √2 is what the decompilation's `(int)` casts in `FUN_002da200` give; with a float compare a pure turn would get
×1 and +96 would read 0.311, not 0.879. So the casts are real and the circle step is, in effect, "× √2 unless one
axis is exactly full". A push saturates each axis at `|v| = 0.3 + 0.7/√2` = **0.795** of the stick's travel.

**The rates.** `ω = 2 × 1.118 = 2.236 rad/s` = 128.1°/s (research 22's peak ω 128.11°/s); the pitch `0.85 × 1.118 =
0.950 rad/s` = 54.4°/s. The ramp reaches the full 0.65 in 0.65 / 0.0389 = 17 frames, **0.28 s at 60 Hz** (the
formula is per game frame; the viewer takes its 60 Hz value per second — a reading, the console's frame rate is
not measured here). Research 22 §3.2's pitch holds (≈25° over 1 s, plateau by 1.2 s) are the camera's elevation
over the actor, not the pitch, and include the ramp and a limit; they do not contradict 54°/s.

## 2. The pitch (`FUN_00594600`, 452781-452958)

- `rate = pitch_rate (+0xf4) × 500 / actor+0x1080 (500 on the dump) × axis`; if the axis is up and the pitch under
  the upper limit, `pitch += rate × dt`, capped at it; if down and over the lower, floored at it. So a stick pushed
  against a limit does nothing, and the limit is never overshot.
- The limits: standing and crouched `max/min_aim_pitch` 60 / −70 (`+0x58` / `+0x5c`); prone `prone_max/min_aim_pitch`
  25 / −20 (`+0x64` / `+0x68`), leaned by the ground's slope under the actor (the `DAT_003f6500` transform, not
  modelled). Not the `look` limits −60 / 80 — those are the head's (`FUN_005adc70`, `max_look_yaw` 89).
- **Out of limits** (a stance change from −70 to prone's −20): the pitch comes back at **0.5 rad/s** (`param_1 × 0.5`),
  not at once.
- A recentre: `DAT_0066b3d8` is set to 1 when input slot 1 is released with the pitch stick centred (453473-453476),
  and to 2 on the next forward push (453776-453777); in mode 2 both limits are `init_aim_pitch` −9.167°, so the pitch
  returns to it at 0.5 rad/s, and mode 2 ends there (452918-452922). Slot 1 is filled from libpad2 button id 0
  (179822-179823) [inference: Select]. Not wired in the viewer (the UI owns the buttons); `stepPitch` with both limits
  at −9.167° is the whole of it.
- Alive, the pitch is held within ±1.4 rad; dead, within −0.4..−0.1 (452925-452936).
- Then `FUN_005af470` writes the look quaternion `actor+0x1070` the camera turns by (`playerCamera.ts`).

## 3. The body, the camera and turning

- **One yaw.** The stick's turn is the actor's own angular velocity (`actor+0x48`, §1); `FUN_00297410` puts the
  camera's eye and target through the actor matrix (a spin of its own only in actor state 8). So the camera's yaw
  *is* the body's facing. There is no free look, and no upper-body twist ahead of the legs.
- **The aim cone** (`FUN_005df600`, 493960-494010): the aim vector (`actor+0x144c`) in actor space is kept inside
  `max_aim_yaw` 85° (`+0x60`, `DAT_0044c2b0`) and the aim pitch limits standing / crouched, `prone_max_aim_yaw` 45°
  prone (`+0x6c`), by `FUN_005ae040`. For the player the aim is the camera's far point, straight ahead in yaw, so the
  twist in yaw is 0; the upper body takes the pitch (the aim nodes) unless the clip carries `NoPitchtwist` (232 clips
  in `motion.rdr`: the transitions, climbs, landings, flinches…).
- **The head** (`FUN_005adc70`, 465653-465740): `max/min_look_pitch` 80 / −60 and `max_look_yaw` 89 limit where the
  *head* turns toward a look target — cosmetic, the motion side's.
- **Turning in place.** `motion.rdr` has one turn clip, `seal_prone_turn` (`playback` 0.7, `BlendTime` 0.9);
  `FUN_0054aa30` (415110) marks the prone turn while `actor+0x48 ≠ 0`, and its collision box is 8 × 6 there. Standing
  and crouched, a turn plays no clip: the body pivots.
- **`stand_turn_factor`** 2.3 (`+0x3c`): read by the loader (`FUN_0059ba80`) and by nothing else (`DAT_0044c28c` has
  only its initialiser; no caller of the table getter `FUN_0058ce60` reads `+0x3c`). Like `fb_accel`, it shapes
  nothing.
- **The run's bank** (`FUN_0057a330`, 439198-439204): with the flag at `actor+0x38` bit 4 and a node at `actor+0x2fc`,
  that node's rotation is pre-multiplied by a turn about its z axis of `−0.000375 × ω × v_z` (`FUN_00307520` builds
  `(0, 0, sin a/2, cos a/2)`): **3.1° into a full turn at the run** (65). Which part `actor+0x2fc` is was not read.

## 4. Aim: the views and the scope

The view mode is the actor's byte `+0x200` (research 30 §1): 0 third person; 1-3 first person (FOV factor 1.01);
4 a 9× view; 5 and up the weapon's `ZoomMode(mode − 5)`. D-pad up zooms in (`FUN_005445b0`: 0 → 1 or 3 → 5 → 6),
down out (`FUN_00544400`).

- **First person changes nothing** in the look: `FUN_005be660` returns 1 unless `mode − 4` indexes the zoom table.
- **Scoped** (mode ≥ 5): the turn and the pitch **÷ the magnification** — the M4A1's `ZoomMode0` 1.5 and `ZoomMode1`
  2.5 (`ZWEAPON.ZAR`; the M4A1 SD 1.5 / 3, the M40A1 1.5 / 6 / 12); mode 4: ÷ 9 and × 0.2.
- **The move stick × 0.2** in any mode ≥ 4 (453818-453822): research 30's "scope speed".
- The scoped aim limits are `min/max_zoom_aim_pitch` −70 / 65, `max_zoom_aim_yaw` 85 (prone −20 / 25, 45).
- `zoom_factor` 5500 / `zoom_rate` 14000 (`+0x124` / `+0x128`) were not traced.

The viewer's aim view (L1, the right button, `walk.ts`) is a first-person view: 1, faithfully. `FlyCamera.setZoom`
takes a magnification for whoever builds the scope.

## 5. The shake: `FUN_002994e0` and `FUN_00299c40`, not `CAMERA_WIGGLE`

`dynamics.rdr`'s `CAMERA_WIGGLE` (amplitude 22, duration 0.6, rate 0.1) is loaded to the table's `+0x18c..0x194`
(`FUN_0059ba80`) and constructed by `FUN_002ce1e0(0x44c3dc)` (328440); nothing reads it. reCOM's
`CAppCamera::TickCameraWiggle` (SOCOM 1) is its reader there; SOCOM II replaced it.

**The shake** is an offset of the projection's screen centre, `cam+0x480` (x) / `+0x484` (y), added to the centre in
`FUN_00294070` (138944-138986) and held within ±200 (`FUN_002915a0`, `FUN_00291550`): the picture moves, the HUD does
not. `FUN_002994e0(baseX, randX, decrX, dpsX, baseY, randY, decrY, dpsY)` (141795-141848) starts one: each rate is
the larger of the new and the running; a new shake takes over only when both its bases beat the running amplitudes,
which become `base + rand × (random % 100) × 0.01`. `FUN_00299c40` (142058-142121), each frame: the phases (degrees)
grow by `dt × dps`; `x = A_x cos(φ_x)`, `y = A_y sin(φ_y)` (`FUN_001b3548` is cos, `FUN_001b3720` sin — `FUN_00307520`'s
quaternion fixes which is which); each amplitude falls by `decr` a frame; at 0 the shake ends and the phases are reset
to 90 or 270 (x) and 0 or 180 (y), a coin each — so a shake starts centred.

- **Explosions** (`FUN_00550ef0` 418098-418110): the pending blast position `DAT_004b51c8` (one-shot flag
  `DAT_004b51d8`, `FUN_003c6990`) within 100 units → the camera's preset 2, 200 → 1, 600 → 0 (`DAT_0064fc88/90/98`
  = 100², 200², 600²). The presets (the camera's constructor, 142906-142929):

  | preset | x: base, rand, decr, dps | y: base, rand, decr, dps |
  |---|---|---|
  | 0 (< 600) | 6, 1, 2, 2000 | 6, 0.5, 2, 250 |
  | 1 (< 200) | 20, 10, 2, 2000 | 10, 5, 2, 2000 |
  | 2 (< 100) | 60, 30, 4, 1000 | 55, 15, 4, 1150 |

- **Rounds** (`FUN_005c5340`, 479245-479263): the stance record of the firing weapon (`FUN_003c5a50`, `+0x4c..0x68`) when both its
  rates are set — `zweapon.rdr`'s `ScreenShake` `xaxis` / `yaxis` (`base`, `rand`, `decr`, `dps`; the reader `FUN_003cda30` at
  322327-322370). Only the **M60E3, the M63A, the PKM and LMG turrets** carry one: 1, 1, 1, 1600 / 1, 1, 1, 2400. The
  M4A1 has none.
- Also through the same two offsets in the scoped modes: the sniper sway (`FUN_005bd100`, `SniperDist*` in the
  weapon's stance) — the weapon workstream's.

## 6. The first-person bob (`BOBBING_FIRSTPERSON`)

`FUN_005966a0` 453823-453849, with `DAT_003df190` (an option, 1 on the dump) set: when the actor's controller
answers its `+0x2c` query, `actor+0xeb8` is 0 and the view mode is 1, 2 or 3 (first person), with a stance under 3
and the move stick not centred: `FUN_005b90c0` adds `amp × cos(phase)` to the offset `(actor+0x5e0)+0x5c` — which
`FUN_005b9030` zeroes at the top of every `PlayerUpd` (453084) and `PlayerUpd` hands to the camera's y offset
(453666-453671) — and the phase (`DAT_0066b3f0`) grows by `push × dt × rate`, wrapping at 2π. The push is one axis'
when the other is 0, else their mean. Standing and crouched: `Walk_Amplitude` 6 px, `Walk_Rate` 15 rad/s (2.4 swings
a second at a full stick); prone: `Crawl_Amplitude` 4, `Crawl_Rate` 8 (`DAT_0044d4e8/ec`, `DAT_0044d4f0/f4`, the
dump agrees). Still, the offset is 0 at once and the phase is kept, so the first frame of a walk drops the view by up
to 6 px. Scoped, the push is × 0.2 first.

## 7. The mouse (the viewer's choice)

The game has no mouse (the PC port maps keys to full axes, `socom2_host_input.cpp:338`). The viewer's mapping,
`LookOptions` in `viewer/src/look.ts`:

- **`raw`** (the default): a count is an angle. **One inch of an 800-DPI mouse turns as far as one second of the
  full stick**, 128.1° — `MOUSE_RADIANS_PER_COUNT` = 2.236 / 800 = 0.00280 rad (0.160°) a count, the fly camera's own
  0.0028 to 0.2 %. `sensitivity` multiplies it. No curve, no ramp, no cap: a mouse's resolution is its own dead zone,
  and a hand's acceleration its own ramp, so running a mouse through the stick's cube and 128°/s cap makes it
  sluggish without making it more like the game.
- **The pitch ratio**: `game` (default) moves the pitch at `pitch_rate / turn_maxrate` = **0.425** of the turn a count
  — the ratio a stick has at every push, so a diagonal sweep traces the stick's path; `uniform` is the PC shooter's
  one angle a count.
- **`stick`**: the mouse *is* the right stick. Its speed over a 50 ms window is a push (full at 800 counts a second ×
  `sensitivity`), past the dead zone, through the circle, the cube, the ramp, the gain and the 128°/s cap; the larger
  of it and the pad's push on each axis. For the purist.
- Both are ÷ the scope's magnification; `invertPitch` flips both the stick and the mouse; `throttle` switches the
  game's own throttle on.

The pad reaches the law raw: `gamepad.ts`'s radial 0.15 dead zone and rescale are undone in `FlyCamera` (the raw
length is `0.15 + 0.85 × len`), so the game's 0.3 per axis is the only dead zone. The arrow keys are a full push.

## 8. What the viewer does now (`look.ts`, `camera.ts`)

Walking: `FlyCamera.update` runs `LookLaw.frame` (§1, the ramp per second at its 60 Hz value), `stepPitch` (§2), the
shake (§5, `decr` scaled to dt × 60) and the bob (§6), and puts the two as a `setViewOffset` shift of the projection
(a PS2 pixel is 1/448 of the frame's height; across, 4:3 of 640); the reticle stays on the frame's centre
(`screenShift`). Flying is unchanged. `lookState()` (the hook's `look()`) is the API for the body: `bodyYaw` (=
`lookYaw`), `pitch`, `turnRate` (rad/s, left positive), `axis`, `turning`, `screen`; `runningLean` and `aimTwist` are
§3's two helpers. The hook also has `setLook`, `setZoom` and `shake(distance)`.

**Placeholders and readings**: the game frame is taken as 60 Hz for the ramp and the shake's fall; the recentre, the
prone slope lean, the scope itself (the zoom modes, the FOV), the sniper sway, the blast event and the machine guns'
per-round shake are exposed (`setZoom`, `shakeScreen`, `MACHINE_GUN_SHAKE`, `explosionShake`) but not triggered by
the viewer yet.
