# 84 — Accuracy and recoil: the reticle's size, its climb, the cone, the fire modes, the zoom and the scope (2026-09-28)

The ACCURACY & RECOIL workstream of the walk mode (the owner: "1:1 movement, animations, recoil -- the feel of SOCOM 2
is the most important"). Everything below is read off the SOCOM II disc and its game ELF: `RUN/ZWEAPON.ZAR`'s
`zweapon.rdr`, `READERC.ZAR`'s `controller.rdr`, `HUD2_TXR.ZED`'s bitmaps, and `socom2_game.elf` -- its Ghidra
decompilation `game/analysis/socom2_game.elf.decomp.c` (cited `decomp:line`), the recompiler's per-instruction
listing (`recomp/output/*_0x<addr>.cpp`) and, where the decompiler lost a switch or an argument, the ELF's own words
disassembled (jump tables at 0x65c320, 0x65c360, 0x65c3b0). No game run, no PCSX2. The code is `@s2u/scene`'s
`weapons.ts` (the record), `viewer/src/accuracy.ts` (the model), `viewer/src/zoom.ts` (the views), `viewer/src/reticle.ts`
(the HUD) and `viewer/src/fire.ts` (the round), tested by `scene/test/weapons.test.ts`, `viewer/test/accuracy.test.ts`,
`zoom.test.ts`, `reticle.test.ts`, `fire.test.ts` and `e2e/accuracy.spec.ts`.

The soldier's kit (`CZKit`, reCOM `zSeal/zseal.h:200-260`) lives at SEAL body `+0x5e0`; its fields line up with
reCOM's order from `+0x18`: `m_retposx/y` +0x18/+0x1c, `m_retoffsetx/y` +0x20/+0x24, `m_sniper_posx/y` +0x28/+0x2c,
`m_firerifle_kick_*` +0x38..+0x44, the selected item +0x824, the item list +0xe4, the fire modes +0x6fc, the body
+0x830. SOCOM II adds the reticle's size at +0x84c (and its previous value +0x850, its movement target +0x86c, its max
+0x870 and min +0x874) and the pull's round count at +0x818.

## 0. The answers

- **`m_minsize`/`m_maxsize` do not exist in SOCOM II's HUD.** The reticle's size is the kit's `+0x84c`, in PS2 pixels,
  clamped per weapon and per stance to `TargetMin`/`TargetMax` (the M4A1 SD standing: 1 to 26). The HUD draws the arms
  that many pixels out -- **halved in the third-person view**.
- **The bloom** (§3): movement aims the size at `|v|² / 65 × TargetDilateUponMovementMult + 158.7 × (turn² + pitch²)`
  (rates in radians a second) and opens toward it 1 pixel a 60 Hz tick; it closes at `TargetConstrict` 50 a second; a
  round adds `TargetDilateUponFire` 7 (× 1 + the burst scalar, 0 on the SD). Crouched the speed term is × 13, prone × 63.
- **The recoil unscoped is the reticle, not the camera** (§4): each round moves the **whole reticle up** by
  `ReticuleKnock` (12; the first round of a pull × `KnockEntryStrength` 0.4 = 4.8), capped at `ReticuleKnockMax` 45,
  returning at `ReticuleKnockReturn` 70 a second; the rounds go where the reticle is. The view does not move.
- **The cone** (§5): the size becomes a square of half side `size × 0.707` pixels, turned to tangents by the game's
  own (quirky) `tan(tan(hfov))` law; each axis is `u·|u|` of a uniform `u` -- densest at the centre.
- **Fire modes** (§6): `MaxFireMode 3` = semi, burst, automatic; 1 / 3 / unlimited rounds a pull; the wait `FireWait`,
  × 0.8 in burst and automatic (the SD: 0.14 s semi, 0.112 s = 536 a minute auto). The switch is L3 (`FireMode`),
  refused while scoped; the rifle comes up automatic.
- **The zoom** (§7): third person → first person (1.01) → the scope at `ZoomMode[state − 4]` -- **the M4A1 SD's one
  scope level is 3×, the M4A1's 2.5×; `ZoomMode0` (1.5 on every record) is never a magnification**. D-pad Up in, Down
  out, no wrap; the magnification runs linearly at 3× the target a second; the look is divided by it; the move stick
  is × 0.2 scoped.
- **The scoped kick** (§8): `FireRifleKick*` moves the aim pitch **only scoped, only on the first round of a pull** --
  a second round drops the scope to first person. Scoped the cone is a point, moved by the `SniperDist*` sway.
- **The reticle is SOCOM II's per weapon** (§9): ten sets chosen by the weapon's `ID` and the view; the rifle's arms
  are coloured (200, 200, 24) at rest, green on a teammate, red on an identified enemy; the scope is a full-frame tube.

## 1. The record: `CZWeapon`'s parser (0x3cda30, decomp 322125-322640)

`FUN_003cda30` builds one `CZFTSWeapon` (0x28c bytes, `FUN_003c6320`) per `ZWEAPON` record. The fields this work reads,
with where the parser puts them:

| key | setter | lands at | note |
|---|---|---|---|
| `Reticule_Modifiers STANCE_STAND/CROUCH/PRONE` | loop 322200-322356 | `+0xf8 + 0x74 × stance` (`FUN_003c5a50`) | stance n starts as a **copy of n−1** (322215-322245); stance 0 as `FUN_003c59c0` made it |
| `ReticuleKnock`, `…Return`, `…Max` | `3c61a0`, `3c6190`, `3c6180` | stance +0x00, +0x04, +0x08 | |
| `SniperDistPPFrameX/Y`, `…LimitX/Y`, `SniperDecayRate` | `3c6070`, `3c6060`, `3c6030`, `3c6020`, `3c5ff0` | +0x0c, +0x10, +0x14, +0x18, +0x1c | |
| `TargetDilateUponFire` | `3c6140` | +0x20 | |
| `TargetDilateUponMovement` | `3c6120` | +0x24 (and its square root at +0x2c) | |
| `TargetDilateUponMovementMult` | `3c6110` | +0x28 | default 1.0 (`FUN_003c59c0`) |
| `TargetConstrict`, `TargetMin`, `TargetMax` | `3c6100`, `3c60f0`, `3c60e0` | +0x30, +0x34, +0x38 | |
| `FireRifleKickRate`, `…ReturnRate`, `…BaseDist`, `…RandomDist` | `3c5fd0`, `3c5fc0`, `3c5fb0`, `3c5fa0` | +0x3c, +0x40, +0x44, +0x48 | |
| `ScreenShake xaxis/yaxis` | inline | +0x4c..+0x68 | defaults 2, 1, 2, 2000 / 1, 1, 2, 250 |
| `KnockCount`, `KnockEntryStrength` | `3c5a90`, `3c5a80` | +0x6c, +0x70 | defaults **3** and 1.0 |
| `FireWait` | inline | weapon +0x50 | default 0.1 |
| `NumZoomModes`, `ZoomMode%d` | `3c5e70` (push) | vector +0x280 (count +0x284, data +0x288) | a missing mode is −1 |
| `AccBurstCnt_Min/_Max`, `AccScalar_Min/_Max` | `3c62b0`, `3c6260`, `3c6210`, `3c61c0` | +0x268, +0x26c, +0x270, +0x274 | slope (max−min)/(cntMax−cntMin) kept at +0x278 |
| `Muzzle_Velocity`, `ImpactRadius`, `Effective_Range`, `Maximum_Range` | `3d29b0`… | | **× `DAT_003dfe10` = 10.0** |
| `ID` | inline | +0x7c (byte) | the `EQUIP_ITEM`: the reticle set (§9) |
| `MaxFireMode`; `BurstMode`, `SingleMode`, `AutoMode` | `3d2a80`; `3d2a30`(2, 1, 3) | +0x24; flags +0xd0 + mode | `3d2a80(n)` enables 0..n; a mode key enables its mode and raises +0x24 |
| `RecoilPct` | `3d2010` | +0x6c | a round adds it to body +0x378, capped at 10 (`FUN_0057d510`) |

- **Units.** The file's ranges and speeds are metres: the parser multiplies them by `DAT_003dfe10` = 10.0 (read from the
  ELF's `.data`), the world's units being tenths of a metre (the HUD prints `RANGE(m): %.0f` of a distance / 10,
  decomp 70447). `UNITS_PER_METRE` = 10; the round now flies `Maximum_Range × 10` units (the M4A1 SD: 8,000), where the
  viewer used to fly 1,000.
- **Unread keys.** The records also carry per-stance `AccuracyBurstCnt_Min/_Max` and `AccuracyScalar_Min/_Max`; the ELF
  has no string for them (its strings at 0x3fc6d0-0x3fcd70 list every key the parser reads), so nothing reads them.

### The M4A1 SD (`ID 62`, `m4Acarbine_sd`), and the M4A1 beside it

| | M4A1 SD stand | crouch | prone | M4A1 stand / crouch / prone |
|---|---|---|---|---|
| ReticuleKnock / Return / Max | 12 / 70 / 45 | **11** / 75 / 45 | **10** / 75 / 20 | 12/70/45 · 9/75/45 · 8/75/20 |
| TargetDilateUponFire | 7 | 7 | 7 | 7 |
| TargetDilateUponMovement / Mult | 1 / (1) | 1 / 13 | 1 / 63 | same |
| TargetConstrict | 50 | 55 | 50 | same |
| TargetMin / TargetMax | 1 / 26 | **0.75** / 25 | 1 / 24 | 1/26 · 1/25 · 1/24 |
| SniperDistPPFrameX/Y, LimitX/Y | **6 / 6**, 20 / 24 | 5 / 5, 16 / 19 | 4 / 4, 12 / 15 | 5/4 · 4/4 · 4/4 (limits same) |
| SniperDecayRate | −0.04 | −0.05 | −0.2 | −0.06 · −0.06 · −0.2 |
| FireRifleKickRate / Return / Base / Random | 0.5 / 0.18 / 0.09 / 0.015 | … / 0.08 / … | … / 0.06 / … | same |
| KnockCount / KnockEntryStrength | 1 / 0.4 | 1 / 0.4 | 1 / 0.4 | same |

Weapon-wide, SD then M4A1: `FireWait` **0.14** / 0.12; `NumZoomModes` 2, `ZoomMode0` 1.5, `ZoomMode1` **3** / 2.5;
`AccBurstCnt` **5-10** / 4-7; `AccScalar` **0-0** / 0-0.03; `Muzzle_Velocity` 900 / 921; `ImpactRadius` 25 / 30;
`Effective_Range` 550 / 600; `Maximum_Range` 800 / 1000; `Damage_Modifier` 0.15 / 0.3; `Sound_Radius` 10 / 100;
`Ammo_Capacity` 30; `NumMags` 3; `MaxFireMode` 3; `RecoilPct` 0.2; `Rumble` 0.04 / 0.2 / 125 (SD). Transcribed as
`@s2u/scene`'s `M4A1_SD` (and the M4A1's `DEFAULT_RIFLE`), pinned to the file by `weapons.test.ts`.

## 2. The frame the numbers are pixels of

`FUN_003b1200` (decomp 305276) sets the frame `DAT_004a44c4` × `DAT_004a44c8` = 0x280 × 0x1c0 = **640 × 448**; the
HUD centres everything on (320, 224) (`FUN_00216770`, 70421). All the reticle's numbers -- the size, the knock, the
sway -- are pixels of it, which is what the viewer already draws the HUD in (one texel a PS2 pixel, research on W2.4).
The NTSC projection's per-axis scale `DAT_004a44a8/ac` is 1.0 / 1.0 (`FUN_003b14a0`, PAL's 8/7 aside).

## 3. The size: the bloom (`FUN_005c2670`, decomp 477256-477377; `FUN_005c3360`, 477683-477814)

**Each tick** (`FUN_005c0fd0` calls `FUN_005c2670(dt, kit)` every 60 Hz tick):

1. `min = TargetMin`, `max = TargetMax` of the current stance (`FUN_0058a720(body, 1)`: 0 stand, 1 crouch, 2 prone);
   four item ids (0x79, 0x97, 0xbe, 0xc9 -- grenades and the like) use 0 and 0. The size is lifted to `min`.
2. The knock returns (§4).
3. The target: `(vx² + vy² + vz²) × 0.015384615 × Mult + (ωx² + ωy² + ωz²) × 5.29 × 30 + (pitch rate)² × 5.29 × 30`,
   plus, while body `+0x105e` bit 5 is set, `|+0x1350..+0x1358|² / 65` -- the velocity at `+0x2c` is the body's
   `m_velM` (units a second), `+0x44` its `m_velR` (radians a second, reCOM `zEntity/zentity.h:126`), `+0x60` the pitch
   rate `FUN_00594600` writes (`(old − new pitch) / dt`, 452954); `+0x1350` is the carried velocity the air step moves
   by (`FUN_0054d9a0`, 416524-416547) [reading: bit 5 is the airborne bit]. A vehicle's own values stand in when
   mounted. Clamped to `[min, max]`.
4. `size < target`: `size += TargetDilateUponMovement` (**a tick**, not a second: 60 px/s) up to the target;
   `size > target`: `size −= TargetConstrict × dt` down to it.

**Each round** (`FUN_005c3360(kit, weapon)`, from `FUN_005c5340` 479542): unless scoped (§8), `size += Dilate ×
(1 + s)`, `s` the burst scalar -- `n = count + 1 − AccBurstCnt_Min`, and when positive `min(n, AccBurstCnt_Max) ×
slope` (the cap is on `n`, so the M4A1 reaches 7 × 0.01 = 0.07, not 0.03) -- clamped to `[min, max]`.

What it comes to on the SD (`accuracy.test.ts`): standing still 1; walking 30 units a second 13.8; the standing run
(65, research 71's bands) 65 → pinned at 26; crouch-walking 10 a second 20; a turn of 0.41 rad/s (23°/s) alone pins it
at 26 -- the look is the biggest term; a round +7, closing again in 0.14 s; automatic fire (+7 every 0.112 s against
−5.6 of constriction) climbs 1.4 a round to 26.

## 4. The knock: the recoil you see (`FUN_005c3360` 477755-477790; `FUN_005c2670` 477297-477321)

- A round, not scoped (`body+0x200 < 5 && != 4`): if the pull's count (`kit+0x818`, §6) equals `KnockCount`, `kit+0x24
  −= ReticuleKnock × KnockEntryStrength`; if greater, `−= ReticuleKnock`; below, nothing. The count is incremented
  before (`FUN_005be9a0` 475516), so on the SD the first round climbs 4.8 pixels and each after it 12.
- Clamped to ± `ReticuleKnockMax` × the camera's y scale (`cam+0x474` = the zoom × 1.0, `FUN_0029b2f0`) × the
  aim-to-muzzle depth ratio `(d_aim − d_fire) / d_aim` (`FUN_00290830` of the two points) -- ≈ 1, taken as 1.
  `kit+0x20` (x) is clamped the same way but no round moves it.
- Each tick both offsets return toward 0 at `ReticuleKnockReturn × dt` (70 px/s standing).
- **Where it shows:** the HUD's reticle centre is `(320 + kit+0x18 + kit+0x20, 224 + kit+0x1c + kit+0x24)`
  (`FUN_00216770` 70421-70424), ring (`+0x70`, 70430) and arms alike: the whole reticle jumps up. **Where it goes:**
  `FUN_005bd100` turns the same offsets into the round's aim offset (§5). The camera is not touched.
- Automatic on the SD: +12 against 70 × 0.112 = 7.8 of return a round, so it climbs ~4.2 pixels a round to the cap of
  45 (≈ 6.1° up in the 49° view's tangents) after about ten rounds, and is back in 0.65 s after the trigger lets go.

## 5. The cone: where a round goes (`FUN_005bd100` 474185-474277; `FUN_00592260` 451531-451578)

`FUN_005bd100` (`CZKit_SetCurAccuracy`, named in `recomp/socom2_names.csv`) writes three floats on the body:

- `cam+0x290` = `(W/2) / tan(hfov)` (`FUN_002915f0`: `+0x4b0` = W/2 × `+0x1d8` = 1/tan(`+0x210`)), so `W / cam+0x290` =
  2 tan(hfov); the game then takes **`tanf` of half of it as though it were an angle** (`FUN_001b3808` is `tanf`) and
  divides by the half frame: `tx = tan(tan(hfov)) / 320`, `ty = tan(tan(hfov) × 448/640) / 224`. With the map's
  `hfov` 0.6109: tx = 0.0026346, ty = 0.0023817 per pixel -- ~1.2× the true tangent of a drawn pixel (0.0020342
  vertically), so the cone is a fifth wider than the reticle drawn. Ported as is (`tangentPerPixel`).
- `+0x5d4 = kit+0x20 × tx`, `+0x5d8 = −kit+0x24 × ty` (up positive), `+0x5dc = size × ty × 0.707`. Scoped, see §8.
- `FUN_00592260(seal, dir)` for each round: `right = dir × (0, 1, 0)`, `up = right × dir` (**unnormalised**: cos(pitch)
  long), `a = +0x5d4 + +0x5dc × s1`, `b = +0x5d8 + +0x5dc × s2`, `dir += right·a + up·b`, with `s = u·|u|`, `u =
  (rand() − 0x3fffffff) × 9.313226e-10` in [−1, 1). A square whose corners are on the circle of radius `size`; three
  quarters of the rounds within its inner half (`P(u² < ½) = 0.707` per axis). The same rule serves the AI's aim
  (`FUN_005aa6e0` 464229, scaled by the distance).
- On the SD at rest (size 1) the half side is 0.0017 rad (0.10°): 1.7 units at 100 m; pinned at 26, 0.044 rad
  (2.5°): 4.4 units (0.44 m) at 10 m.

## 6. The fire modes and the trigger (`FUN_005c0940`, `FUN_005c09f0`, `FUN_005c4600`, `FUN_005c0ae0`)

- **Rounds a pull** (`FUN_005c0940`, 476281): mode 1 → 1, 2 → 3, 3 → 10,000, 0 → 0, ≥ 4 → 1.
- **The wait** (`FUN_005c09f0`, 476313): mode 1 `FireWait`; 2 and 3 `FireWait × 0.8`; 0 → 1 s. The SD: 0.14 s semi,
  0.112 s burst and automatic (536 a minute); the M4A1 0.12 / 0.096 (625).
- **The pull's count** `kit+0x818`: +1 per round (`FUN_005be9a0` 475516, before the round leaves); **reset to 0 when the
  trigger (`ctrl+0x118`) is up or just released** (`FUN_005c0ae0` 476382-476400), which also stops a burst mid-way.
- **The switch** (`FUN_005c4600`, 478555): only when the magnification is ≤ 1.01 (not scoped); mode + 1, past
  `MaxFireMode` back to 1, skipping a mode whose flag is off. A weapon comes up in `MaxFireMode` (476650-476670):
  automatic on both M4A1s. `controller.rdr` binds it to `LeftStickTap` (L3) in the Default layout (`RightStickTap` in
  Reverse).

## 7. The views and the zoom (`FUN_005448a0`, `FUN_005445b0`, `FUN_00544400`)

`FUN_005448a0(body, state)` (410927) sets `body+0x200`, keeps the old one at `+0x201`, flags `+0x202`, and sets the
magnification `+0x204` by the jump table at 0x65c3b0: **0** third person 1.0; **1, 2** first person 1.01; **3** night
vision 1.01 (with its effect callbacks); **4** the 9× view (9.0, the `zoom_control` motion, the `ret_binocs` HUD); **5-12**
`FUN_003c5980(weapon, state − 4)` = `ZoomMode[state − 4]` when that index exists (0x544adc: `addiu a1, a1, -0x4`, then
`jal 0x3c5980`; `FUN_003c5980` returns 500.0 for an index past the count). Entering 4 or 5+ resets the kick
(`FUN_005b9180`).

- **Zoom in**, d-pad Up (`FUN_005445b0`, table 0x65c360): 0 → 1 (2 in a turret); 1 → 3 on a night map (`DAT_0045c380
  +0x5dc`), else → 5 with two or more zoom modes, else → 4; 3, 4 → 5 (two or more); 5-11 → s + 1 while `s − 3 <
  NumZoomModes`. **No wrap.** With `NumZoomModes 2` (both M4A1s) the only scope state is 5 = `ZoomMode1`: **3× on the
  SD, 2.5× on the M4A1.** `ZoomMode0` (1.5 on all 86 records) is never a magnification; the sniper rifles' three modes
  give two levels (M40A1 6×, 12×); a sidearm (one mode) zooms from first person into the 9× view.
- **Zoom out**, d-pad Down (`FUN_00544400`, table 0x65c320): 1, 2 → 0; 3, 4 → 1 (clearing the knock, `FUN_005b9020`);
  5 → 1 (3 at night), clearing the knock; s > 5 → s − 1.
- **What else sets it:** a second round of a pull while scoped → 1 (`FUN_005c5340` 479404); a weapon switch → 1
  (`FUN_005c4b10` 478833); an attached launcher selected → 1 (`FUN_00216770` 70389); death → 0 (`FUN_00547af0`), the
  vehicle and ladder paths → 0/1 (`FUN_005463c0`, `FUN_00579720`). Nothing on reload, stance or movement.
- **The run** (`FUN_001f1610`, `FUN_001f0750` 52864-52990): the applied magnification `DAT_003dc338` moves linearly to
  the target `DAT_003dc340` at `DAT_00408c48` = 3 × the target a second in, at least 3 × the old target out (1.01 →
  3 in 0.22 s). `FUN_0029b2f0` puts it on the projection (`cam+0x470/+0x474` = zoom × 1.0): **tan(half FOV) ÷ zoom**
  -- the 49° view becomes 17.3° at 3×.
- **The look** (`FUN_005966a0` 453739): both look axes × 1.72 (`DAT_00650628/30`) then **÷ `FUN_005be660`** =
  `ZoomMode[state − 4]` when the index exists, else 1 -- first person changes nothing, the SD's scope ÷ 3, the 9× view
  ÷ `ZoomMode0` × 0.2 (`DAT_00650638`). The move stick is × 0.2 in states ≥ 4 (453818-453821). The body's pitch rate itself
  is `dynamics+0xf4 × 500 / body+0x1080`, `+0x1080` a constant 500 (0x554c54): no zoom term there.
- **Correction to research 83 §4:** "5 and up the weapon's `ZoomMode(mode − 5)`" and "the M4A1's ZoomMode 1.5 and 2.5"
  as two scope levels are both off by one: the index is `state − 4` and the M4A1 has one scope level, 2.5.

## 8. Scoped: the kick, the drop and the sway

- **The kick starts only scoped, on the first round.** `FUN_005c5340` (479059-479549), the round's leaving: `if
  (body+0x200 > 4 && weapon) { if (kit+0x818 < 2) FUN_005b91c0(kit) /* the kick */ else FUN_005448a0(body, 1) /* drop
  to first person */ }` (479398-479406). There is no other caller of `FUN_005b91c0`.
- **It ticks only scoped:** `FUN_00550ef0` calls `FUN_005b9280` only when `FUN_005b9990 || FUN_005b90f0` -- state > 4 or
  == 4 (418390-418393). So in third person and in the plain first-person view **the camera never kicks**; the recoil there is
  §4's climbing reticle. **The WEAPON workstream's `rifleKick.ts` kicks on every round in every view -- it wants this
  gate** (`accuracy.ts` exports `kickStarts(zoomState, roundOfPull)` and `kickTicks(zoomState)`).
- `FUN_005b9280`'s kick (472095-472135, flag `DAT_00650938` = 1): rising at `FireRifleKickRate` 0.5 rad/s to `BaseDist
  + RandomDist × rand` (0.09-0.105 rad standing, 0.08 crouched, 0.06 prone); falling at `ReturnRate` 0.18 rad/s to the
  pitch it started from, which an upward pitch stick drags along at 0.04 a tick (`DAT_00650980`).
- **In a scope the round is exact but for the sway:** `FUN_005bd100` with `body+0x200 ≥ 4` sets the radius 0 and the
  offsets to `(−sway x, −sway y)` (474217-474226). No bloom and no knock scoped (`FUN_005c3360`'s gate).
- **The sway** (`FUN_005b9280` 472136-472185, flag `DAT_00650940` = 1): per axis `p += dt × ((PP + 0.75)|p/L| + PP +
  0.25)`, `L = SniperDistLimit × (0.8 × steadiness + 0.2)`, and at ±L the sign of `SniperDistPPFrame` flips -- in the
  weapon's own table -- so it swings end to end, a little faster going positive (the +0.75/+0.25). Steadiness is the
  float behind body `+0xeb0` (1 when whole; `FUN_00578150` raises it). The SD standing: ±20 px across at 6.25-13 px/s,
  ±24 px vertically. Turned by §5's tangents that is up to 0.053 rad -- 65 PS2 pixels at 3× -- and **no reader of it
  draws it**: the scope overlay is at fixed frame coordinates (§9), and `kit+0x58/+0x5c`, which accumulate the sway,
  have no reader in the kit's functions. So scoped rounds wander off the scope's cross invisibly [reading: the view's
  own sway, if the game has one, was not found; the viewer ports the rounds' sway as the code has it].

## 9. The reticle SOCOM II draws

- **The sets** (`BitmapReticule_Init` 0x2178c0, decomp 70828-70870: fixed parts at `hud+0x44bc + 4·type`, floating at
  `+0x44e8 + 4·type`): 0 `ret_sidearm_01/02`, 1 `ret_rifle_01/02`, 2 `ret_shotgun_01/02`, 3 `ret_rocket_01/02`, 4
  `ret_grenade_02` (+ `ret_grenade_01`, the throw meter), 5 `ret_scope_02`, 6 `ret_scope_01`, 7 `ret_binocs/ret_binocs2`,
  8 `nvg_part`, 9 `ret_sidearm_01` + `ret_laser_designator`; `ret_accuracy`, `ret_threat`, `noise50` beside them.
- **The choice** (`FUN_005be300` 474894, kept at `kit+0x54`, sent to `ChangeReticule` 0x213e20): state 4 → 7; a
  magnification over 1.01 → 5; a fitted launcher → 3 (or 1 when out of launcher rounds); then the `ID`: 11 → 9, 4-30 →
  0, 31-80 → 1, 81-90 → 2, 91-120 → 1, 121-140 and 151-189 → 4, 190-253 → 0, 151/152 → none. **The M4A1 SD (62) and
  the M4A1 (54) are set 1**, the sidearms (4-16) set 0, the 870/Spas/Jackhammer (81-84) set 2, the snipers (101-106)
  set 1 until scoped. `reticle.ts`'s `reticleType` and `RETICLE_SETS`; all nineteen bitmaps load with the map
  (`hudBitmaps.ts`), the rifle's and the scope's are drawn.
- **The rifle's draw** (`BitmapReticule_UpdateAccuracy` 0x215250, 69706-69905): the drawn size `hud+0x44b4` is the
  kit's `+0x84c` (`FUN_00216770` 70419), **× 0.5 when `body+0x200` is 0** (third person, 69729-69731); each arm's quad
  starts that many pixels from the centre and is the arm bitmap's 32 × 32 (`+0x452c/+0x4530`) -- so an arm's outer end
  is `32 + size` out. The console frame's rest (outer ends 31-32 out, W2.4) is TargetMin 1 halved. The ring and dot
  (`ret_rifle_01`) are drawn at the centre, which the knock moves.
- **The colours** (`FUN_00215c10` 69906-70294, `FUN_003590e0` on the four arms): (200, 200, 24) at rest
  (`DAT_003dc5a0/a8/b0`; the frame's measured (204, 204, 31)); (24, 200, 44) on a teammate within 320 units (500
  scoped); (200, 24, 44) on an identified enemy; (130, 130, 130) past a launcher's range. `reticleTint`; the viewer has
  no targets, so it stays at rest.
- **The scope** (`ChangeReticule` type 5, 69434-69510; `Init` 70870-70940): no ring, no arms; `ret_scope_01` and
  `ret_scope_02` each as four 320 × 320 quads over (0, −96)-(640, 544) with mirrored UVs (0.01-0.99), centred on the
  frame -- not the reticle. Decoded, `ret_scope_01` is the black tube (clear inside a radius of 81 of its 128 texels, 202
  pixels on the frame) with a one-texel grey (79, PS2 alpha 94) cross along the centre lines, dashed for its inner 22
  texels; `ret_scope_02` a soft black ring inside the tube (alpha 255 at 95 texels fading to 0 at 44). The F2000 (ID
  63) skips `ret_scope_02`. `scopeLayout`.
- **The accuracy pip** (`ret_accuracy`, `hud+0x1f0`): placed at the centre + body `+0xe44/+0xe48` (clamped to 200
  pixels), which `FUN_005aa6e0` (464351) sets to the screen position of where the **muzzle's** ray actually lands; hidden
  while that is inside the reticle, faded in and out 32 a frame. It marks an obstructed muzzle. Not drawn yet: it needs
  the WEAPON workstream's muzzle leg (§10).
- **SOCOM 1 against SOCOM II.** reCOM's `BitmapReticule` (`Apps/FTS/hud/hud.h:465-520`; `hud_bitmapreticule.cpp` is
  empty) holds the same family -- `m_reticuleTex[10]`, `m_floatingreticuleTex[10]`, four floating polys, four scope
  polys, eight threat polys, `m_accuracyxtex` -- **plus `m_minsize`/`m_maxsize` on the HUD**. SOCOM II's HUD object has
  no such pair: the range moved into the weapon's per-stance `TargetMin/Max`, the size into the kit, and the draw gained
  the third-person halving and the knock's offset. The viewer's reticle before this work was already SOCOM II's own
  bitmaps at the console's rest place (W2.4); what was not SOCOM II's was its behaviour -- a 0..1 "spread" pushing the
  arms to 1.5× (an estimate), the ring fixed, the knock mapped onto that spread as 12/45 of it, no colours, no sets,
  no scope.

## 10. What the viewer does now, and what others must call

- `accuracy.ts` -- `Accuracy`: `update(dt, {stance, velocity, airborne, yawRate, pitchRate, zoomState})` (60 Hz ticks
  inside), `trigger()` (a press or release: the pull's count restarts), `round(zoomState, stance)` → `{dropZoom, kick}`,
  `cone(zoomState)` (tangents), `reticle(zoomState)` → `{size, offset}` for the HUD, `leaveScope()`, `state()`.
  `perturb(dir, cone)`; `roundsPerPull`, `fireInterval`, `nextFireMode`, `defaultFireMode`; `kickStarts`, `kickTicks`.
- `zoom.ts` -- `Zoom`: `zoomIn()` (d-pad Up), `zoomOut()` (d-pad Down), `cycle()` (the mouse's one button: in, and from
  the last level back to third person -- the viewer's convenience), `set(state)`, `update(dt)`, `state()`, `view()`,
  `target()`, `magnification()`, `fov(baseDeg)`, `lookScale()`, `moveScale()`, `firstPerson()`, `scoped()`.
- `fire.ts` -- `setGun(FireGun)`: `trigger`, `roundsPerPull`, `interval`, `round(dir)`; the range × 10.
- `main.ts` -- the M4A1 SD's record (`M4A1_SD`) drives the fire, the bloom and the zoom; `gunFrame` each frame (the
  bloom off `walk.snapshot()` and `fly.pose()`'s look rates, a look jump over 45° a frame counted as a placement; the
  zoom's run and `fly.setFov(zoom.fov(base))`; the LOOK workstream's `fly.setZoom(magnification, mode4)` when the camera
  has it). **The right mouse button is the zoom's press** (it was the held first-person aim: the game's first zoom step
  is that view, so they are one); first person shows while the zoom is at 1 or more or the pad's aim lane is held.
  **`B` switches the fire mode** (free; not while scoped). The hook: `zoom()`, `zoomIn()`, `zoomOut()`, `cycleZoom()`,
  `fireMode()`, `switchFireMode()`, `accuracy()`, `trigger(down)`.
- **Requests.**
  - UI (the pad): lane `zoom` = d-pad Up, pressed edge → `onZoom()` in `main.ts` (or `zoom.zoomIn()` for the game's
    exact no-wrap step); lane `zoomOut` = d-pad Down → `zoom.zoomOut()`; lane `fireMode` = L3 → `switchFireMode()`
    (W2.7 already reads the fire mode on L3). The hint line could add "right-click zoom · B fire mode".
  - WEAPON (`rifleKick.ts`): start the kick only when `kickStarts(zoom.state(), accuracy.rounds())` and tick it only when
    `kickTicks(zoom.state())`; unscoped the camera must not kick. The two-leg shot should send its muzzle-leg hit to
    the reticle for the accuracy pip (§9).
  - LOOK: `fly.setZoom` is called with `ZoomMode[state − 4]` (1 unscoped) and `mode4`; the move stick's × 0.2 is
    `zoom.moveScale()`.

## 11. Placeholders and readings, by name

| what | value | why |
|---|---|---|
| the aim-to-muzzle depth ratio in the knock clamp and the cone | 1 | `FUN_00290830`'s two depths ≈ equal at range |
| steadiness (`body+0xeb0`) | 1 | whole; the damage that lowers it is not modelled |
| the airborne term | `(vx² + vz²) / 65` while `airborne` | `+0x1350` read as the carried air velocity, bit 5 as airborne |
| the look rates | differences of `fly.pose()` a frame | the body's `+0x44`/`+0x60`; a > 45° jump is a placement |
| the scoped sway | ported, not drawn | no drawing reader found (§8) |
| the kick's stick follow | not applied here | the kick is `rifleKick.ts`'s |
| night maps (state 3) | off | `setNight` exists; the map flag is not read |
| the reticle colour | rest | no targets in the viewer |
| the accuracy pip | not drawn | needs the muzzle leg (§9) |

## 12. Evidence

Screenshots (PS2 presentation, Frostfire spawn A; `web/test-fixtures/screens/accuracy/`, git-ignored, from
`e2e/accuracy.spec.ts`): `1-rest.png` (third person, size 1 drawn at 0.5: the console's 65-pixel cross),
`2-moving.png` (W held: pinned at 26, the arms 45 out), `3-burst.png` (automatic held 0.45 s: the reticle climbed and
opened), `4-first-person.png`, `5-scope.png` (the SD at 3×: the tube and the dashed cross).
