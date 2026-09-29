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
  refused while scoped; the rifle comes up on **burst** (the kit's spawn set-up; the console frame's three rounds).
- **The zoom** (§7): third person → first person (1.01) → the scope at `ZoomMode[state − 4]` -- **the M4A1 SD's one
  scope level is 3×, the M4A1's 2.5×; `ZoomMode0` (1.5 on every record) is never a magnification**. D-pad Up in, Down
  out, no wrap; the magnification runs linearly at 3× the target a second; the look is divided by it; the move stick
  is × 0.2 scoped.
- **The scoped kick** (§8): `FireRifleKick*` moves the aim pitch **only scoped, only on the first round of a pull** --
  a second round drops the scope to first person. Scoped the cone is a point, moved by the `SniperDist*` sway **divided
  by the magnification** (§17: a third on the SD's 3×).
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
`@s2u/scene`'s `HELD_RIFLE` (and the M4A1's `DEFAULT_RIFLE`), pinned to the file by `weapons.test.ts`.

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
- `+0x5d4 = kit+0x20 × tx × k`, `+0x5d8 = −kit+0x24 × ty × k` (up positive), `+0x5dc = size × ty × 0.707` -- `k` =
  `d_aim / (cam+0x474 × (d_aim − d_fire))`, the depth ratio (≈ 1) **over the magnification** (§17); the radius has no
  `k`. Scoped, see §8.
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
  `MaxFireMode` back to 1, skipping a mode whose flag is off.
- **The mode at spawn:** the kit's set-up (`FUN_005c0250`, 476217-476223) puts the primary slot on **burst** when the
  weapon enables mode 2 (`FUN_003d2a60(slot 1, 2)`) -- which is what the console frame at spawn shows (three
  `firemode.tif` rounds = mode 2, research 87); a mode still 0 is cycled up to `MaxFireMode` (`FUN_005c0fd0`
  476650-476670), and online the player's last mode per weapon is restored (`DAT_0066b580`, not modelled). `controller.rdr` binds it to `LeftStickTap` (L3) in the Default layout (`RightStickTap` in
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
- **What else sets it:** a second round of a pull while scoped → 1 (`FUN_005c5340` 479404); a weapon switch drops
  **only the night vision** to 1 (`FUN_005c4b10` 478813-478833: `if (body+0x200 == 3) ... FUN_005448a0(body, 1)`) --
  what a scope does when a grenade comes up was not traced, and the viewer drops it to first person [reading]; an attached launcher selected → 1 (`FUN_00216770` 70389); death → 0
  (`FUN_00547af0`), the vehicle and ladder paths → 0/1 (`FUN_005463c0`, `FUN_00579720`). Nothing on reload, stance or movement.
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
  ±24 px vertically. Turned by §5's tangents and divided by the magnification (§17) that is up to 0.018 rad at 3× (0.053 at 1×, what
  the viewer used until 2026-09-29) -- 20 PS2 pixels of the scoped frame -- and **no reader of it
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
- **The HUD in a scope** (`FUN_001f6ce0` 56025-56066): when the magnification (`FUN_005be660`, 9 in state 4) is over
  1.01 the HUD writes **`ZOOM: %2.1fx`** (string 0x3e3098) at (20, 420), scale 0.9 -- "ZOOM: 3.0x" on the SD -- and
  hides it otherwise; research 87 found no zoom readout. The reticle's own `RANGE(m): %.0f` line (`DAT_00408e58`,
  `FUN_00216770` 70440-70448) is shown only in the scope, the 9x view and the night vision (`ChangeReticule`: types 5, 7,
  8), placed at (415, 215) in the scope, (515, 40) and (515, 70) in the others (`DAT_003dc528..550`). Neither is drawn
  yet: the HUD workstream's `hud.setZoom` receives the magnification (research 84's request). `FUN_002122a0` (68371)
  hides two more HUD parts whenever the view is first person or scoped (state > 1), not identified.
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
- `main.ts` -- the M4A1 SD's record (`HELD_RIFLE`) drives the fire, the bloom and the zoom; `gunFrame` each frame (the
  bloom off `walk.snapshot()` and `fly.pose()`'s look rates, a look jump over 45° a frame counted as a placement; the
  zoom's run and `fly.setFov(zoom.fov(base))`; the LOOK workstream's `fly.setZoom(magnification, mode4)` when the camera
  has it). **The right mouse button is the zoom's press** (it was the held first-person aim: the game's first zoom step
  is that view, so they are one); first person shows while the zoom is at 1 or more or the pad's aim lane is held.
  **`B` switches the fire mode** (free; not while scoped). The hook: `zoom()`, `zoomIn()`, `zoomOut()`, `cycleZoom()`,
  `fireMode()`, `switchFireMode()`, `accuracy()`, `trigger(down)`.
- **Requests.**
  - UI (the pad): **done at the merge** -- `zoom` = d-pad Up → the game's no-wrap step in, `zoomOut` = d-pad Down, and
    `fireMode` = L3 (replacing the launcher's crouch shortcut there; the stance is Triangle); the walk hint reads
    "right click zoom · d-pad up/down zoom · B fire mode". The zoom and the fire mode do nothing while the grenade is up.
  - HUD: draw `ZOOM: %2.1fx` and the scope's `RANGE(m)` line (above) off `hud.setZoom`; `hud.setFireMode` is fed.
  - WEAPON (`rifleKick.ts`): start the kick only when `kickStarts(zoom.state(), accuracy.rounds())` and tick it only when
    `kickTicks(zoom.state())`; unscoped the camera must not kick. **Done at the merge**: `FireGun.kickStarts/kickTicks`
    gate `Fire`'s `RifleKick`, whose per-stance numbers now come off the parsed stances (the parser's inheritance). The two-leg shot should send its muzzle-leg hit to
    the reticle for the accuracy pip (§9).
  - LOOK: `fly.setZoom` is called with `ZoomMode[state − 4]` (1 unscoped) and `mode4`; the move stick's × 0.2 is
    `zoom.moveScale()`.

## 11. Placeholders and readings, by name

| what | value | why |
|---|---|---|
| the aim-to-muzzle depth ratio in the knock clamp and the cone | 1 | `FUN_00290830`'s two depths ≈ equal at range |
| steadiness (`body+0xeb0`) | the exertion, ported (§17) | the pitch stick from the mouse's pitch rate is a reading |
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

## 13. Penetration: what a round goes through

`HandleIntersections` (0x3c9b70, decomp 319920-320067) walks a round's intersections nearest first, from the round's
origin, skipping the shooter's own nodes; `FUN_003c8920` (319339-319527) takes each:

- **Passed over, no effect:** a material whose `PENETRATION` (material `+0x24`, `materials.rdr` SOILS; the table is
  `@s2u/scene`'s `materialTable`) is exactly 1.0 -- `PARTICLE_SYSTEM`, `ACTION`, `INVISIBLE_DI`, `ITEM`, the `*_VOL`s.
- **Out of range:** a hit farther than the round's remaining range (`projectile+0x94`, squared) ends the round there,
  in the air, unmarked (return 4). The range starts at `Maximum_Range` x 10.
- **Struck:** the node's damage callback, the mark (`FUN_003d0ba0`), an AI noise, the impact (`bullet_hit_<material>`),
  then the penetration: `next = (range + range x Piercing x 0.1) x PENETRATION`, the range becomes `next` when smaller;
  the round goes on (return 2) while this hit lies within the range, else it stops here (4). `Piercing` is the round's
  (`ZAMMO`, ammo `+0x14` by `FUN_003d4520`): **3 for 5.56 x 45mm**, so a round keeps `1.3 x PENETRATION` of its range --
  glass 0.99 (1.287: nothing lost), `GLASS_MEDIUM`/`METAL_GRATE_THIN` 0.985, `CHAINLINK_FENCE`/`CAMO_NET` 0.98,
  `PERSON` 0.97 (1.26), `METAL_RAILING` 0.95, `LEATHER` 0.9, `FABRIC_HEAVY` 0.85, `RUBBER`/`LEAFY_TREE`/`THATCH` 0.8
  (1.04), `SNOWY_TREE` 0.7 (0.91), `WATER` 0.6 (0.78), `BARREL` 0.5 (0.65), `METAL_GRATE` 0.4 (0.52), `METAL_THIN` and
  `PIPE_STEAM` 0.35 (0.455), `WOOD_THIN` 0.25 (0.325); every other material 0 -- stone, dirt, wood and metal thick,
  plaster, glass thick and opaque -- stops it. There is no count limit: only the range.
- A launcher's round (`FUN_003c5d20`) stops at any non-liquid surface; `RICOCHET` is read and never used.

`accuracy.ts`'s `penetrate` is the walk; `Fire.setPenetration` takes the material byte to its `PENETRATION` (`main.ts`:
the effects' material names to `materialTable()`); every surface struck is marked and its impact played (`Shot.through`,
the round event's `through`); the eye's ray to the point under the reticle passes over the 1.0 materials too.

## 14. Night vision

- **Which maps:** the world root's `NightMission` u32 (`FUN_00318da0` 217135: `CWorld+0x5dc`): **MP1 Blizzard, MP5,
  MP7, MP8, MP11, MP61, MP64, MP73 and MP83** (9 of the 22, read off every archive's `MP*.ZED`). On them the zoom's
  first step from first person is state 3 (§7), and a weapon switch drops it to first person.
- **What the game draws** (`FUN_005c1800`, called from the HUD's update 0x205200/0x20a470 in state 3):
  - the goggles: `nvg_part.tif` (256x256: a green inside at PS2 alpha 22, a dark opaque rim), four mirrored 320x224
    quads over the whole frame (`BitmapReticule_Init` 70940-70975), shown by `ChangeReticule` while `kit` is in state 3;
  - the colour: `FUN_003b78d0(0, LensFX_NVG)` loads a colour matrix whose rows are all `(r, g, b) x 0.33` and
    `a x 3.03` of the map's `LensFX_NVG` -- `(0.2, 0.898, 0.2, 0.24)` on every map -- and the camera's colour
    `cam+0xd0` becomes the lens times the fog's; leaving, `FUN_003b78d0(0.25, (1, 1, 1, 0))` eases it back in four steps;
  - `noise50.tif` (64x64), refilled with random texels every frame, over x 5-635, y 75-373 at alpha 64 -- **not drawn**:
    its palette ramp (`FUN_00354a00(tex, 0x42, 0x49, 0x7f)`) is not decoded, and white noise at half alpha is not what
    the frame would show;
  - `.NV_GOGGLES_ON` / `.NV_GOGGLES_OFF` on the way in and out (`DAT_0044ce30/38`, `FUN_005448a0`).
  `LensFX_StarlightScope` (0.3, ...) is the same for a scope on a night map (states 4+) [not ported].
- **The viewer:** the goggles on the reticle's layer (`nightLayout`); the colour as a frame filter on the canvas -- an
  approximation: the game's matrix acts on the lit vertex colours (`0.066 R + 0.296 G + 0.066 B + 0.727`, a lift of
  the night's dark lighting) before the textures modulate them, which only the world renderer can do; the viewer takes
  the rows' weights as a luminance, a gain of 3 for the lift, tinted by the lens. **Request (maps/lighting):** in state 3
  replace each vertex colour's channels by that sum.

## 15. The scope's sway, settled

- `kit+0x58/+0x5c`, which `FUN_005bd100` accumulates the sway into, have **no reader**: the only other writer is
  `FUN_005b9030` (a reset, 471941); every function that touches `+0x58` of a kit-sized pointer was checked
  (`FUN_005be9a0`'s `+0x58` is the body's quaternion).
- The sway is **used**: `FUN_005bd100` runs every frame for the local player (`FUN_00594cf0` 453666, unconditionally)
  and in a scope writes `body+0x5d4/+0x5d8` from `-sway`; each round's direction is perturbed by them through the
  player controller's virtual `+0x74` -- the controller's vtable at 0x4062d0 holds `FUN_00592260` there (0x406344) --
  called by `FUN_005be9a0` for every round. So scoped rounds land off the scope's cross by the sway.
- It is **not drawn**: in a scope (reticle type 5) the tube and its cross are at fixed frame coordinates, the ring and
  arms are hidden; only the damage-direction markers (`hud+0x19b0`), placed about the reticle's centre (`320 + kit+0x20`),
  move with it. The view does not sway. The viewer does the same.

## 16. The sidearm's reticle and numbers

- The kit's sidearm is the **Mark 23** (`mp_seal1`'s second `wep_name`; `ID 15` -> reticle set 0: `ret_sidearm_01`, a
  32x32 dark disc with a 2x2 dot, and `ret_sidearm_02`, a 16x16 arm). `FUN_00215250` draws set 0 as the rifle's
  (type != 2, 3, 9): each arm its own 16x16 quad `size` out from the centre -- `reticleLayout` takes the set's sizes,
  `Reticle.setSet(reticleType(id, state, zoom))`.
- Its record (pinned by the fixture test): `FireWait` 0.2, 12 rounds, `45 ACP` (Piercing 4), `Maximum_Range` 125 m;
  standing `ReticuleKnock` 20 / 60 / 40, `TargetDilateUponFire` 20, `TargetDilateUponMovement` 0.75, `TargetConstrict`
  75, **`TargetMin` 10 / `TargetMax` 30** (prone 14 / 34), `KnockCount` 1 at strength 1 (the first round climbs the
  whole 20), no `FireRifleKick` (no kick even scoped), one fire mode (single), one zoom mode (1.5) -- so d-pad Up from
  first person goes to the 9x view (state 4, `ret_binocs`), not a scope. `accuracy.ts`, `zoom.ts` and the reticle take
  it as they take the SD.

## 17. The zoom's factor on the round (2026-09-29, the owner: "the zoom is supposed to increase accuracy by quite a bit")

- **The rule** (`FUN_005bd100`, decomp 474236-474266): `fVar8 = cam+0x474`; `fVar9 = d_aim / (fVar8 × (d_aim −
  d_fire))` (`FUN_00290830`: a point's depth along the camera's axis; the aim point `+0x1458` and the fire point
  `+0x1c`); `+0x5d4 = kit+0x20 × fVar9 × tx`, `+0x5d8 = −kit+0x24 × fVar9 × ty`; `+0x5dc = size × ty × 0.707` without
  `fVar9`. `cam+0x474` is `FUN_0029b2f0`'s `zoom × DAT_004a44ac` (NTSC 1.0), fed every frame the **running**
  magnification `DAT_003dc338` (decomp 52802). `cam+0x290` (the tangents' `tx`, `ty`) is `W/2 / tan(fov)` of the
  unzoomed `+0x210` (`FUN_002915f0`): no zoom there.
- **So per view:** third person (1.0) -- the cone is the bloom's square, the knock's offset as is; the night vision
  (1.01) -- the same, the offset ÷ 1.01; the scope (state 5+) -- **no cone at all** (the radius is 0: no bloom from
  moving, turning or firing, §8) and the sway's offset **÷ `ZoomMode[state − 4]`: ÷ 3 on the M4A1 SD, ÷ 2.5 on the
  M4A1**; the 9× view (state 4) -- the sway ÷ 9. Stance and movement act on the scope only through the sway's limits
  (`SniperDistLimit` per stance: 20 / 16 / 12 × 24 / 19 / 15 on the SD) and the move stick's × 0.2 (§7).
- **The viewer before** (`accuracy.ts` `cone(zoomState)`): the offsets were never divided, so the SD's scoped rounds
  wandered up to 20 × 0.0026346 = 0.053 rad (3.0°) off the cross -- three times the game's 0.018 -- worse on average
  than walking in third person with the reticle pinned open. **Now** `cone(zoomState, magnification)` takes
  `Zoom.magnification()` (required, so no caller can drop it again); `accuracy.test.ts` "the zoom on the cone" pins
  the third and measures 600 rounds per stance against third person walking. The reticle is unchanged: the arms are
  the size (halved in third person, §9) and the scope's tube is drawn at fixed frame coordinates, the sway undrawn --
  both as the game. The multiplayer server walks the client's already-perturbed direction (`room.ts` `fire`), so it
  applies the same rule by construction.
- **Steadiness is an exertion, not health** (corrects §8 and §11; ported 2026-09-29). `body+0xeb0` points at
  `{cur, target, mode}` made `{1.0, 0, 0}` (decomp 419589-419598). Each tick `FUN_00550ef0` (418340-418390), for the
  body holding a weapon under a player controller:
  - **raises** `cur` (`FUN_00578150`: `+ x`, clamped to 1, nothing at 1) by `|+0x240| + 0.1 × |+0x23c| + |+0x244|`
    and `0.05 × |controller+0x138|`. The three body fields are the controller's `m_throttle[3]` (reCOM
    `zEntity/zentity.h:159-176`, `CEntityCtrl` at `+0x8/+0xc/+0x10`), copied at 418613-418615 and zeroed in the
    held animation states; `FUN_005966a0` (453738-453864, the player controller's tick) fills them from the pad:
    `[2]` = the move stick's long axis (`+0x240`, forward), `[3]` = its strafe (`+0x244`), both × 0.2 in the 9× view
    or a scope; `[4]` = the look's x after × 1.72, the curve and ÷ the zoom (`+0x23c`, the turn: ω = `turn_maxrate` 2 ×
    it, research 83); `+0x138` is the raw pitch stick (`FUN_002c6280`, also the kick's stick follow);
  - **pulls** it toward the target 0: `cur += −rate × dt × (0 − cur)`, `rate` = the stance's `SniperDecayRate`
    (−0.04 / −0.05 / −0.2 on the SD: a decay) or, while `FUN_0058a820` says running (`|v|² ≥ 400`), `1 − |+0x240|`
    (a climb); within the step (or 0.005) of 0 it snaps to 0 (`FUN_0052eb60`).
  A round adds 0.35 (479407, every view); entering the 9× view, or a scope from any state but 6, adds 0.5
  (`FUN_005448a0` 410995/411011 -> `FUN_005b9180` 472025). The sway's limits are `SniperDistLimit × (0.8 cur + 0.2)`
  and it moves only while `cur > 0.2` (472137-472185) -- below, it **stops where it is**, so the rounds keep that last
  offset. The breath sound (`FUN_00592b40`, period `(1 − cur) × 0.24 + 0.3` s, 472076-472095) is not ported.
- **What it does, still in the SD's scope (3×) from entering it** (the sway's offset off the cross, mean / worst,
  mrad, each window up to the time; `accuracy.ts`): standing 9.4 / 21.0 to 2 s, 8.6 / 13.1 at 8-10 s (f 0.67),
  5.0 / 9.8 at 30-40 s, frozen at 40.3 s (f 0.2); crouched frozen at 32 s; **prone 6.3 / 11.1 to 2 s, 3.6 / 5.7 at
  5-8 s, frozen at 8.05 s** (483 ticks: `(1 − 0.2/60)^n ≤ 0.2`). Any move stick pins it back at 1; a look adds 0.1 ×
  the turn axis a tick. Client-only: the server walks the client's deflected direction.
- **Found here, ported since:** the move stick's × 0.2 while scoped (453818-453821) reached the exertion's throttles
  (`main.ts`) but not the mover, which walked at full speed in the scope. Now the shared `Walker` takes it
  (`Walker.scoped`, research 80 section 6e), and the server's from the command's `Button.Scope` (not `Button.Aim`,
  which the night vision sets too).

## 18. The magazines: the ring, the reload, the ammo box (2026-09-29)

The owner's report (2026-09-29, the Mark 23): "10/12 -> reload -> 12/12 -> 8/12 -> reload -> 11/12". The rule, from
the decompilation (`socom2_game.elf.decomp.c`) and reCOM (`src/gamez/zSeal/zseal.h:233-236`):

- **The store.** `CZKit` keeps `s32 m_reloads[30][10]` -- ten magazine slots for each of the kit's thirty item slots,
  each holding its own rounds -- and `s32 m_currentmag[30]`, the index of the magazine in the weapon (SOCOM II's kit:
  `+0x1d4 + slot*0x28 + i*4` and `+0x684 + slot*4`; the item pointers `m_item[30]` at `+0xe4`). There is no pool of
  loose rounds and no separate count "in the gun": the weapon's rounds **are** `m_reloads[slot][m_currentmag[slot]]`.
- **What is carried.** `FUN_005ba3d0` (472706-472775, the fill) and `FUN_005ba5b0` (472779-472830, "can this slot take
  rounds") both bound the magazines at `NumMags` (`CZWeapon+0x2c`) of `Ammo_Capacity` (`+0x28`) each, the slots past
  it set to 0; **doubled when the kit holds item 0xC2** (the Double Ammo Load, `-0x3e` in the loop) for a firearm of
  the categories `FUN_003d1a60` gives as 4, 0x1f, 0x33, 0x51, 0x5b, 0x65 (item ids 4-30 the sidearms -- the Mark 23 is
  15 -- 51-80 the rifles -- the M4A1 54), and never more than 10. The M4A1 SD: 3 x 30; the Mark 23: 3 x 12. [Reading:
  the viewer does not double. `mp_seal1`'s `default_weapons` list the Double Ammo Load (`weapons.ts`), which would
  make these 6 x 30 and 6 x 12, but the console frame of a live spawn (research 87 §6, `console_spawn_slot8.png`)
  shows `30/30  2 MAGS`. The item is 0xC2 in SOCOM II (`zweapon.rdr`'s `Double Ammo Load` is `ID 194`, read
  2026-09-29, with the Mark 23 `ID 15` and the M4A1 SD `ID 62`, both `NumMags 3`), but the path that fills a kit at a
  spawn was not traced -- `FUN_005ba3d0` and `FUN_005ba5b0` are the ammo pickup's -- and that frame's kit is not known
  to be `mp_seal1`'s. `magazinesCarried(numMags, doubleAmmo)` holds the rule; `KIT_DOUBLE_AMMO` (false) is what the
  page and the server pass until a spawn with a known kit settles it.]
- **A round** (`FUN_005c1970` 477038-477042, and `FUN_005bc730` 474123-474126, `FUN_005be9a0` 475621-475623) takes one
  from `m_reloads[slot][m_currentmag[slot]]` when it is above 0, and from nothing else.
- **A reload** (`FUN_005c2a90`, 477379-477560): after the gates (not mid-swap `FUN_005a7ab0`, not in the states
  `FUN_005a7d10` / `FUN_005a78d0` refuse), when any of the slot's ten holds rounds, it walks from `m_currentmag + 1`
  round the ring (wrapping at 10) back to `m_currentmag`, skipping the slots `< 1`, and **takes the first slot with
  rounds** (477462-477476) -- whole or part-spent, whichever is next in order, not the fullest. The swap is made **at
  the reload's start**: `m_currentmag = next` (477483), then the reload animation (`FUN_005a82e0`) and the sound. The
  magazine taken out keeps its rounds in its slot; nothing is topped up, nothing moved between magazines. So the total
  -- the rounds in the weapon plus those in the other magazines -- only falls, by the rounds fired. With no other slot
  holding rounds the walk finds nothing and no reload starts (the `DAT_0045a0c1` branch, 477486-477505, refills the
  current magazine instead; the same flag hides MAGS in the ammo box, `FUN_00237760` 85181-85188, 85192 -- read as an
  unlimited-ammo mode, not identified further and not modelled).
- **The request.** `R` (the pad's reload, `FUN_002c64e0(6)` in `FUN_00594cf0`, 453459-453463) arms the kit's reload
  timer (`FUN_005c32b0`: `kit+0x820` = the weapon's `ReloadDelay`, 0.01 by default); `FUN_005c0fd0`'s frame (476549-476561)
  runs it down and calls `FUN_005c2a90`. **The automatic reload**: `FUN_005c5340` (479297-479320) arms the same timer
  when the magazine in the weapon is empty (not for the grenades and the other non-firearms, the item-id list there).
  The viewer refuses `R` on a full magazine (the page's; the game's own gate for it is not traced -- `FUN_005b4340`
  may be it -- so a full-magazine `R` stays a no-op here).
- **The ammo box** (`FUN_00237760`, 85128-85201): `"%d/%d"` (0x3e66b8) is `FUN_005c3890` -- the magazine in the
  weapon, `m_reloads[slot][m_currentmag]` (477877-477910) -- over `FUN_005c3ce0`, `Ammo_Capacity`. `"%d MAG%c"`
  (0x3e66c0) is `FUN_005c49b0() - 1`, where `FUN_005c49b0` (478716-478770) **counts the slots with rounds, the one in
  the weapon among them**; hidden below 1, `'S'` unless 1. So with rounds in the weapon MAGS is the other magazines
  holding rounds; with the weapon empty it is one fewer than they (three magazines, the first spent: `0/12  1 MAG`
  until the reload swaps -- then `12/12  1 MAG`).

**Where the 11 comes from.** The page already kept the ring (`fire.ts` since the sidearm round), and from a fresh
Mark 23 the report's steps give `10/12 -> 12/12 -> 8/12 -> 12/12`: the second reload takes the third, whole, magazine.
An 11 needs a magazine left at 11: one round fired from the first magazine and a reload before the report's `10/12`
(that 10 is then the second magazine, and the second reload comes round the ring past the third to the first, as it
was left). That is the game's rule -- a part-spent magazine is kept and comes back in order -- and `magazines.test.ts`
replays both sequences. What was wrong beside it, and is fixed with this section (`magazines.ts`, shared by the page
and the server):

- the **server** (`room.ts`) counted differently from the page -- a reload dropped the part-spent magazine
  (`spare - 1`, the weapon refilled to capacity), so after two reloads it held no spare while the page still had two
  part-spent magazines, and every round the page fired from them was refused by the server; it now keeps the same
  ring and takes the same next magazine;
- the **MAGS** figure was "the other magazines with rounds" -- one more than the game's with the weapon empty;
- `fire.ts`'s header still said a part-spent magazine is dropped.

The counts are pinned by `viewer/test/magazines.test.ts` (the ring, the box, the owner's sequences for both weapons,
the automatic reload, an empty pouch, a swap mid-reload, and the total falling only by the rounds fired over a random
run of rounds, reloads and swaps) and `server/test/room.test.ts` (the server's ring against the same sequence).
