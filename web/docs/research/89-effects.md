# 89 — The gunplay's effects: the zAnim effect commands, the casing, the particles, the impacts and the marks (2026-09-28)

The EFFECTS workstream of the walk mode (the owner: "1:1 feel of SOCOM 2"). Everything a round shows around the
rifle: the muzzle effect a weapon record names (`FireAnimName`), the ejected casing, the smoke, the bullet's impact
per surface and its mark. Read-only on the disc (`game/disc/RUN/`, the owner's extraction under `web/public/maps/RUN`)
and on the decomp (`game/analysis/socom2_game.elf.decomp.c`, cited as `decomp <line>` with the `FUN_` address);
reCOM (`research/recom/src/gamez/zAnim/zanim.h`) for the structures' names. No game run. The disc bytes stay out of
the tree; `npx tsx tools/dump-effects.ts MP2 <animation> [--mission] [--decoded]` prints what this note reads.

## 0. The answers

- **The command numbers are the registration order** (§1). `FUN_0025bc20` (decomp 106863) registers the zAnim base
  set one command after another; a command's number in the data is its place, from 1: `IF` 2 … `OBJECT_MOTION` 21,
  `OBJECT_MOTION_FROM_TO` 22, `PARTICLE_SOURCE` 27, `SOUND` 30, `LIGHT` 32, `CALL_ANIMATION` 45, `STOP_SEQUENCE` 51;
  `VALVE` (61) comes from a later module. SOCOM 1's numbers (reCOM's `DATATYPE_*`) are not these.
- **The M4A1 SD's round** (§4): `muzzle_m4SD` calls `shell_eject` and `shell_smoke_med` -- no flash. The casing flies
  to the rifle's right and up at 18.6-26.1 units a second, falls at -98, tumbles, bounces on the hull by its
  material's coefficient with its material's sound (`.BUL_CASE_METAL` on metal …), and **vanishes at rest or at 1.2 s**.
  At most four casings at once take the bouncing flight (the `bullet_ejecting` valve); the rest fly 0.7 s through
  everything. In the aim view (`muzzle_m4SD_zoom`) the casing is `shell_eject_first_person`, **hidden** (it still
  bounces and sounds).
- **The smoke is switched off** (§3). `shell_smoke_med` -- the rifles' and pistols' muzzle smoke -- carries a whole
  particle configuration with flag A `0x1` set and `0x2` clear: "set the source's state to off". It never emits.
  The retail game draws no smoke from the M4A1 SD; the viewer draws none either. `shell_smoke_big` (the shotgun's) is on.
- **The M4A1's flash** (§4): `flash_fire_hider` shows the `muzzle_flash_hider` model at the muzzle along the barrel,
  turned about the barrel by one of eight angles, scaled from 0.1 to 0.9-1.3 over 0.05 s, gone a frame later; a
  dynamic light beside it. **No tracer** for the M4A1 SD: tracers are every fourth round of the SMGs, rifles and MGs,
  the suppressed ones excluded (§4).
- **The impacts are the map's** (§5). A bullet's hit plays `<HitAnimName>_<material>` -- `bullet_hit_metal_thick`,
  `bullet_hit_stone` … -- which live in each map's **`MZANIM.ZAR`** (only the glass ones are in `CZANIM`): sparks and a
  flame linger on metal, dust spurts and spinning chunks on stone, dirt and gravel, a splash and a ring on water, each
  with its sound (`.BUL_METAL`, `.BUL_STONE` …). No C code draws an impact.
- **The marks are per material with no default** (§5): the weapon's `DecalSet` row for the polygon's material, none
  when the material has no row (METAL_GRATE, GRAVEL, WATER, MUD, LEAVES …); square to the round, projected along it onto
  the surface, no turn; 150 kept, oldest recycled; no fade. A polygon whose material byte is 0 takes the map's
  `DefaultMaterial` (Frostfire `METAL_THICK`).

## 1. The zAnim command set

**Numbering** (`FUN_0025bc20`, decomp 106863-106924; `FUN_0026a8e0(0x414bb0, name, parser, begin, tick, end)`):

| # | name | begin / tick | # | name | begin / tick |
|---|---|---|---|---|---|
| 1 | QUAD_ALIGN | – / 0x2679e0 | 19 | OBJECT_ROTATE_STATE | – / 0x263730 |
| 2 | IF | – / 0x25e7a0 | 20 | OBJECT_AIM | 0x2634a0 / 0x2633a0 |
| 3 | ELSEIF | – / 0x25e6d0 | 21 | OBJECT_MOTION | 0x262690 / 0x261370 |
| 4 | ELSE | – / 0x25e6d0 | 22 | OBJECT_MOTION_FROM_TO | 0x25fe70 / 0x25f9b0 |
| 5 | ENDIF | – / 0x25e6a0 | 25 | OBJECT_OPACITY_FROM_TO | 0x25f960 / 0x25f880 |
| 9 | RANGE_TEST | – / 0x25de90 | 27 | PARTICLE_SOURCE | – / 0x266830 |
| 10 | RANDOM_WEIGHT | – / 0x25dcf0 | 30 | SOUND | – / 0x2659c0 |
| 11 | FAIL | – / 0x25dce0 | 32 | LIGHT | – / 0x264cb0 |
| 14 | LOOP | – / 0x25ede0 | 43 | EXPRESSION | – |
| 15 | WAIT | 0x25ed50 / 0x25ec50 | 45 | CALL_ANIMATION | 0x25d5c0 / 0x25d550 |
| 17 | OBJECT_ACTIVE_STATE | – / 0x263aa0 | 51 | STOP_SEQUENCE | – / 0x25d230 |
| 18 | OBJECT_TRANSLATE_STATE | – / 0x263890 | 61 | VALVE | – / 0x353d00 |

The full list is `ZANIM_COMMAND_NAMES` in `@s2u/scene`'s `effects.ts`. 59-60 are `RESET_BODY_PARTS` and
`BODY_FALL_ON_MATERIAL_SOUND` (`FUN_0059ac60`), 61-63 `VALVE`, `VBIT`, `VWATCH` (`FUN_00354470`, decomp 252347).

**Control flow.**
- `IF`/`ELSEIF` carry a u32 count, then their conditions as whole sub-commands.
- `RANDOM_WEIGHT` holds when `rand()·2⁻³¹ <= p` (the f32 at +4; decomp 107832). The flash's eight turns chain them at
  1/8, 1/7, 1/6, 1/5, 1/4: each branch one eighth.
- `RANGE_TEST` compares the squared distance between two points against +0x24 (flags 0x40-0x800 pick the
  comparison, 0x100 "farther than"; decomp 107880).
- `VALVE` (tick `FUN_00353fd0`, decomp 252128): a valve reference (+4; flag 2 at +13 makes it a name index), an
  operand (+8) and an operation (+12): 0 true, 1 !=, 2 ==, 3 >, 4 <, 5 >=, 6 <=, 0x0b set, 0x0c add, 0x0d subtract
  (floored at 0), 0x0e multiply.
- `WAIT` (begin `FUN_0025ed50`): seconds in the f32 at +8, or frames with flag 0x10; flag 0x20 adds a random range.
- `LOOP` (`FUN_0025ede0`): back to the sequence's start until a count (flag 1; -1 never) or a time (flag 2).
- `FAIL` returns 0 from its tick, which stops the animation.
- A sequence's word (`_zsequence`): bits 1-7 its activation. 1 runs at the start. 2 is the activation gate
  `Anim_Params`' second offset names (`FUN_002734b0`, decomp 120743): `shell_eject`'s is "if the camera is more than
  100 units from the caller, FAIL", so no casing is thrown out of sight.

**The context** (`FUN_00272bb0`, typed arguments; `FUN_00272720` reads them):
- Type 3 is the caller's node: the commands' node byte 0xFA (-6). 0xF9 (-7) is the animation's own instance (its root
  model, copied per play: `create_instance`, `Anim_Params` flags bit 7).
- Type 5 is a position, 6 a velocity, 7 a direction.
- The round's muzzle animation (`FUN_005c5340`, decomp 479430-479480) gets
  `(3, the weapon's node, 5, firepoint+0x30, 6, the fire direction)`. `firepoint+0x30` is the firepoint's place in the
  weapon: `OBJECT_TRANSLATE_STATE` with flag 2 adds it and carries it through the reference node's matrix
  (`FUN_00310980`), which puts the flash at the muzzle.
- A hit (`FUN_003c8920`, decomp 319339) gets `(5, the hit, 7, the surface normal, 6, the round's velocity)`.

**Node state.**
- `OBJECT_ACTIVE_STATE` (+4 u16 1 shows, else hides; node u16 +6).
- `OBJECT_TRANSLATE_STATE` / `OBJECT_ROTATE_STATE`: node +6, reference node +7 (whose world place or rotation the node
  takes), flags +4 (1 set, 2 add, 4 keep), xyz or euler at +8.
- `OBJECT_MOTION_FROM_TO` as the flashes use it (flags 0x300): the time at +0x34, from at +0x38, to at +0x44, the rate
  at +0x50. On all three of `flash_fire_hider`'s the rate is exactly (to − from) / time, which pins the reading.
- `LIGHT`: an RGB in 0..255 at +0x20 and a radius at +0x2c (`zoom_flash_fire`'s muzzle light: 204, 173, 120; 51.2).
- `CALL_ANIMATION`: the name index in the byte at +7.
- `SOUND`: the name index in the u16 at +6 (research 81 §6).

## 2. `OBJECT_MOTION` (21): the thrown node

Begin `FUN_00262690` (decomp 110463), tick `FUN_00261370` (decomp 109820). Offsets from the command's start.

| Off | Type | Meaning |
|---|---|---|
| +4 | u32 | flags (below) |
| +8 | u8 | the node moved (0xF9 the instance, 0xFA the caller) |
| +9 | u8 | the launch frame's node; 0 the world |
| +0xa / +0xb | u8 | a sequence / sound name index for a bounce whose material names none |
| +0xc | f32 | the impact speed at full volume (0: always full) |
| +0x10 | f32 | gravity scale, times the main gravity (-98: `Anim_Main_Params`, 77 §9) |
| +0x14 | f32 | the terminal-velocity k (flag 0x2) |
| +0x18 | f32 | times the caller's velocity (type 6, flag 0x800) |
| +0x1d / +0x1e | s8 / s16 | the material table's count and self-relative offset (12 bytes an entry) |
| +0x20 / +0x22 | s16 | block A `[azimuth°, zenith°, speed, accel]`, block B their random ranges |
| +0x60 | f32 | the default bounce coefficient |
| +0x64 | f32 | the ground tolerance, a fraction of the object's height |
| +0x74 / +0x76 / +0x78 / +0x7a | s16 | the tumble block, the angular velocity block, the scale-rate block, an extra random block |
| +0x7c | f32 | lifetime, seconds (flag 0x1) |

Flags: 0x1 lifetime, 0x2 terminal velocity, 0x8 fixed launch, 0x10 random launch, 0x20 impact sound, 0x40 floor probe,
0x80 swept line probe, 0x100 angular velocity, 0x200 roll, 0x400 tumble, 0x800 add the caller's velocity, 0x1000 /
0x2000 the direction from the caller's type 7 / 6.

**The launch.**
- The direction is `FUN_0025cb00` (decomp 107097): `(−sin az·(1−|e|), e, −cos az·(1−|e|))` with `e = zenith/90`,
  **not normalised**.
- The velocity is that direction times the speed, rotated into the frame node's world matrix, plus the caller's
  velocity times +0x18.
- A material entry is a u32 code, then the reference speed at +4 and the bounce coefficient at +8. The code: bit 0
  uses the reference speed, bit 1 the bounce coefficient; bits 2-9 the material, bits 10-17 the sound's name index,
  bits 18-25 a sequence's. The first match wins.

**The tick.**
- The step is explicit Euler: the position moves `v·dt`, then `v += a·dt`. While falling with flag 0x2, `v.y`'s step
  is scaled by the terminal table `1 − (e^(x) − 1)/(e^10 − 1)`, `x = 0.25·clamp(int(40·v.y·k), 0, 40)`.
- The line probe (flag 0x80, used rising or moving mostly sideways) reflects `v` about the normal and scales it by the
  coefficient `e`.
- The floor probe (0x40, falling) reflects `v` and scales it by `1 − (1 − e)|v̂·n|`, then sets `a.y` back to gravity.
- Each bounce plays the entry's sound (flag 0x20) at volume `min(1, speed/ref)`, full when the reference is 0.
- The command is done when the lifetime runs out, when a bounce leaves the speed under `0.08·|a|` (7.84 at -98), or
  when the object is found below the floor.
- Tumble (0x400): the euler angles (from 0: the rotation the sequence copied from the caller is overwritten) gain
  `dt·rate·(n̂z, 0, −n̂x)`, and the rate gains its acceleration.

**`shell_eject`** (both flights; `effects.test.ts` pins them):

| | the full flight (flags 0x0cf3) | the cheap flight (flags 0x0c13) |
|---|---|---|
| launch | az 170-190°, zenith 30°, speed 25-35 in the caller's frame | the same |
| gravity | 1 × -98 | the same |
| terminal k | -1/980 | the same |
| bounce | 0.30 default; the table below | none: no probes |
| lifetime | 1.2 s | 0.7 s |
| tumble | 30°/s, -5°/s² | the same |

The full flight's material table:

| material | sound | coefficient |
|---|---|---|
| 25-26 metal | `.BUL_CASE_METAL` | 0.35 |
| 7 stone, 22 asphalt | `.BUL_CAS_STONE` | 0.25 |
| 4 grass | `.BUL_CAS_DIRT` | 0.10 |
| 8 dirt | `.BUL_CAS_DIRT` | 0.15 |
| 5 sand | `.BUL_CAS_SAND` | 0.15 |
| 19-20 wood | `.BUL_CAS_WOOD` | 0.27 |

Its sequence: `bullet_ejecting += 1`; show the instance; place and turn it at the caller; if `bullet_ejecting < 5`
the full flight, else the cheap one; `bullet_ejecting -= 1`; hide the instance. So the casing is gone the moment it
stops. The casing model is `EFFE_GEO`'s `bullet_shell_9m`, 0.45 units long (4.5 cm at ten units to the metre),
`shell_gold.tif`. `shell_eject_first_person` (the aim view's) launches at zenith 50° ±20° at 15-20 a second for
0.75 s, and shows nothing: its `OBJECT_ACTIVE_STATE` is 0 at both ends.

## 3. `PARTICLE_SOURCE` (27): the emitters

Tick `FUN_00266830` (decomp 112759); the manager: `FUN_00329b40` emission (226782), `FUN_00327cd0` spawn,
`FUN_003282b0` step, `FUN_003251b0` sprite draw (223925), `FUN_00326350` streak draw (224624). Every field is an
override applied when its bit of flags A (+4) is set; the source's defaults are `FUN_0032ab20`'s (227362).

**Fields.**

| Off | Flag | Meaning |
|---|---|---|
| +0x0c | – | the source's name index (one source per animation and name, `FUN_0026ea20`) |
| +0x0d | A 0x10 / 0x20 | its node (0xFA the caller); 0x10 follows the node, 0x20 adds its origin |
| +0x0e | A 0x10000 | particles per emission event |
| +0x10-0x12 | – | the counts of textures, colour keys, scale keys |
| +0x13 | – | type (low nibble): 0 sprite, 1 rotated, 2 xz, 3 streaked, 4 unchanged |
| +0x14 | A 0x4 | position offset |
| +0x20 | A 0x40 / B | the base velocity in the node's frame; or its f32 scales a context vector (B 0x2 the normal; B 0x40 the velocity; B 0x100 that reflected about the normal; B 0x400 the velocity made a unit) |
| +0x2c | A 0x80 / B | a world velocity, the same with B 0x4 / 0x80 / 0x200 / 0x800 |
| +0x38-0x4c | A 0x100-0x400 | the random velocity box per axis (world; local with B 0x80000) |
| +0x50-0x64 | A 0x800-0x2000 | the random spawn box per axis |
| +0x80 | A 0x8000 / 0x4000 | the emission interval, per second / per unit moved |
| +0x84 | A 0x20000 | acceleration |
| +0x90 | A 0x40000 | friction k |
| +0x9c / +0xa4 / +0xac | A 0x100000 / 0x200000 / 0x400000 | the size (a half-width, units), the starting age, the lifetime (s): min, max |
| +0xb4 / +0xbc | A 0x800000 / 0x1000000 | the near and far fades (distances; compared squared) |
| +0xc4 | B 0x8 | offset of a random position block (base xyz, range xyz) |
| +0xc6 | B 0x1 | the emission events allowed (-1 unlimited) |
| +0xc8 | A 0x4000000 / 0x8000000 | offset of the texture list (`u16` name, f32 t): one at random, or stepped through the life |
| +0xca | A 0x10000000 | offset of the colour keys (t, r, g, b, a) |
| +0xcc | A 0x20000000 | offset of the scale keys (t, multiplier) |
| +0xd0 | type 3 | offset of the streak's two numbers (default 1.0, 0.3) |

Flag A 0x1 sets the source active to A 0x2 (`FUN_00329ac0`); A 0x8 places it at the context's position (type 5).

**Running.**
- The first tick after activation records the source's place and emits nothing.
- Then an accumulator counts events (`int(acc × rate)`), each of `perEvent` particles spread over the frame, until
  the events allowed are spent or the animation ends.
- A particle's size, lifetime and starting age are drawn from their ranges. Its velocity is `Node·base + world +
  U(box)`.
- Each tick: `pos += v·dt`, then `v += a·dt`, then the friction `v = w + (v − w)/P(k·dt)`, where
  `P(x) = 1 + x/2 + x²/3 + … + x⁶`, halved and squared back (about `e^(−k dt/2)`); `w` is the wind, 0 here. It dies at
  its lifetime.

**Drawing.**
- A particle is a GS **sprite**: a screen-aligned square `2·size·scale(t)` across (PRIM 0x0F6, decomp 224013).
- Its colour keys times 128 are the vertex colour, so `MODULATE` leaves the texel at 1.0 and the alpha may go over 1.
  With no keys it is white with alpha `1 − t`.
- The alpha is times the camera fade, linear in d² across the far pair. The particles draw back to front, depth-tested
  with no depth write.
- The blend is the texture's own bind packet: `cloudpuff01.tif` and `effect_dustpuff01.tif` source alpha,
  `effect_spark01.tif`, `explosion2.tif` and `effect_muzzle01.tif` additive.
- A streaked particle (type 3) is a band from where it was a tick ago to where it is. The head is pushed `size` on,
  the tail `size × streak[0]` back, and the tail's alpha is times `streak[1]`. The metal sparks' streak is 10 and 0.7.

**`shell_smoke_med`**: `IF RANDOM_WEIGHT(0.5)`, then source `blue_smoke01` with flags A `0x37ffbfd1`, then `WAIT
0.25`. Bit 1 set with bit 2 clear switches it off (decomp 112833-112838). The configuration it would have run is two
puffs of `cloudpuff01.tif`: 60 units a second along the caller's +x, 0.5-1 s, grey-blue 0.4/0.4/0.5, a half-width of
2-3 growing ×20, out to a 40-60 unit cloud. It looks abandoned. `shell_smoke_big` (the shotgun's `muzzle_shotgun`) is
the same role switched on: `effect_dustpuff01.tif` every 0.03 s for 0.2 s, 1 s each, rising at 20.

## 4. The muzzle and the tracer

**The muzzle effect.** `FUN_005c5340` (decomp 479059, gated on `DAT_003e1538`) plays the weapon's `FireAnimName` per
round, or `<name>_zoom` when the view mode `char+0x200` is above 0 (the aim view; the names are built by
`FUN_003c4700` with `%s_zoom`, and a turret's `%s_zoom_TT`). The M4A1 family:

| animation | calls |
|---|---|
| `muzzle_m4SD` | `shell_eject`, `shell_smoke_med` |
| `muzzle_m4SD_zoom` | `zoom_fire_silent` (= `shell_eject_first_person`), `shell_smoke_med` |
| `muzzle_m4` | `shell_eject`, `flash_fire_hider`, `shell_smoke_med` |
| `muzzle_m4_zoom` | `zoom_flash_fire` (a `LIGHT`), `shell_smoke_med` |

**`flash_fire_hider`** runs four sequences side by side:
- `fire_fix` holds the instance at the caller, turned as the weapon and shown, once a tick (a `LOOP` forever).
- `fire_rotate` turns the `rotate` node about the barrel by ±45°, ±22.5°, 77.5° or 0 (the chained random weights).
- `fire_scale` scales the `scale` node from 0.1 to 1.2, 0.9 or 1.3 (weights 0.33, 0.5, the rest) over 0.05 s, waits
  one frame, stops `fire_fix` and hides the instance.
- `light_at_muzzle` lights the muzzle.

The model, `EFFE_GEO`'s `muzzle_flash_hider`, is five `effect_muzzle01.tif` quads (additive), 6.16 units along +x: an
end-on star and four fins.

**The tracer.**
- The tracer weapons are the SMGs (ids 31-50), assault rifles (51-80), MGs (91-100), heavy (141-144) and turrets
  (205-229) (`FUN_003cb1a0`, decomp 320657).
- The suppressed ids 16, 33, **62 (M4A1 SD)**, 67 and 105 are excluded (`FUN_003c5ac0`, 317147).
- Of the tracer weapons, a round draws one when the shooter's round count is a multiple of 4 (`FUN_003cabe0`, 320545).
- The tracer flies from the muzzle to the hit, accelerating: 400/s², pool 100 (`FUN_003d5030`, 327160).

## 5. The impacts and the marks

**The hit path.**
- `FUN_003c9b70` (decomp 319920) walks a round's hits nearest first. It skips the shooter's own nodes and the materials
  whose `PENETRATION` is 1.0 (ACTION, INVISIBLE_DI, ITEM, the `*_VOL`s), whose hits pass without effect or mark.
- `FUN_003c8920` takes each remaining hit:
  - beyond the remaining range the round stops;
  - the node's damage callback runs;
  - **the mark** (`FUN_003d0ba0`, decomp 323789);
  - an AI noise;
  - **the impact**: the weapon's hit animation for the material, played at the hit with the normal and the round's
    velocity (gated on `DAT_003e1540`, 1 on the disc);
  - the penetration: the range shrinks by the material's `PENETRATION`, and a round through glass goes on to the wall
    behind.
- `RICOCHET` is read and never used; nothing on the disc makes a ricochet.

**The names** (`FUN_003c4700`, decomp 316255): `sprintf("%s_%s", HitAnimName, material)` for every material, looked
up without regard to case in every animation set (`FUN_0026a250`). Every gun's `HitAnimName` is `bullet_hit`
(`zweapon.rdr`), so the M4A1 SD's hits are the map's `bullet_hit_<material>`.

**The mark.**
- The weapon's `DecalSet` (`BULLET_MARK_SMALL`) row for the raw material index; a row without a texture is no mark.
  There is **no default**.
- The size is `min + rand·(max − min)` units across.
- The square is square to the round's direction, its up the world axis least aligned with the normal
  (`FUN_00307810`, decomp 206429): **no random turn**. It is projected along the round onto the surface and clipped
  to the triangles facing the round.
- It goes to the temporary pool: `TEMP_DECAL_POOL` base 150, overflow 50, trimmed back to 150 oldest-first each frame
  (`FUN_003bf110`). A set flagged `PERMENANT` (the grenade's blast) goes to the permanent one. No timed fade was found.

**The material table** (SOILS index = the polygon's `material` byte, research 81 §4; 0 takes the map's
`DefaultMaterial` from `READERM.ZAR/<map>.rdr`'s `world_params` -- `FUN_002dc1d0` reads `DAT_0044f310`,
`FUN_002ddc30` sets it at the load, decomp 152110):

| # | material | mark (BULLET_MARK_SMALL) | impact | its sound | its particles |
|---|---|---|---|---|---|
| 4 | GRASS | sand 1-1.5 | bullet_hit_grass | .BUL_GRASS | firepuff, spinning grass, grass spurts |
| 5 | SAND | sand 1-1.5 | bullet_hit_sand | .BUL_SAND | firepuff, droplets, vapour, streak |
| 6 | MUD | -- | bullet_hit_mud | .BUL_MUD | firepuff, dirt pieces, streaks |
| 7 | STONE | stone 1-1.8 | bullet_hit_stone | .BUL_STONE | firepuff, sparks, spinning rocks ×3, dust spurts |
| 8 | DIRT | sand 1-1.5 | bullet_hit_dirt | .BUL_DIRT | firepuff, dirt pieces, dirt spurts, streaks |
| 9-10, 44-45 | GLASS … | glass 1.1-1.3 | bullet_hit_glass (CZANIM) | .BUL_GLASS | -- |
| 11 | WATER | -- | bullet_hit_water | .BUL_WATER | droplets, vapour, streak, the ripple |
| 13 | PERSON | blood 2-3 | bullet_hit_person | .BUL_INTO_BODY | red flashes and streaks |
| 15 | LEAVES | -- | bullet_hit_leaves | .BUL_LEAVES | grass pieces and spurts |
| 16 | ICE | glass 1.8-3.3 | bullet_hit_ice | .BUL_ICE | ice spurts |
| 17 | SNOW | sand 1-1.8 | bullet_hit_snow | .BUL_SNOW | firepuff, dirt pieces and spurts |
| 18 | GRAVEL | -- | bullet_hit_gravel | .BUL_GRAVEL | as stone |
| 19 / 20 | WOOD_THICK / THIN | wood 2-3.4 | bullet_hit_wood_* | .BUL_WOOD_L_SPL / .BUL_WOOD_SMALL | firepuff, puff, pieces, dirt spurts |
| 21 | RUBBER | -- | bullet_hit_rubber | .BUL_RUBBER | sand spurts |
| 22 | ASPHALT | stone 0.75-1.5 | bullet_hit_asphalt → stone | .BUL_STONE | as stone |
| 23 | LEAFY_TREE | -- | bullet_hit_leafy_tree | .BUL_LEAVES | pieces, grass |
| 25 / 26 | METAL_THICK / THIN | metal 0.75-1.8 | bullet_hit_metal_* | .BUL_METAL / .BUL_TIN | firepuff, sparks ×2-3 (streaked), flame linger |
| 30 | FABRIC_HEAVY | metal 0.75-1.2 | bullet_hit_fabric_heavy | .BUL_FABRIC | blue_smoke01 |
| 31 / 32 | PIPE_STEAM / GASTANK | metal 1.2-1.7 | bullet_hit_pipe_steam / gastank | .BUL_BARREL | steam / gas squirt |
| 35 | THATCH | -- | bullet_hit_thatch | .BUL_WOOD_L_SPL | firepuff, puff, pieces |
| 37 | LEATHER | metal 0.75-1.2 | bullet_hit_leather | .BUL_WOOD_SMALL | puff, pieces |
| 38 | BARREL | metal 0.75-1.8 | bullet_hit_barrel | .BUL_BARREL | as metal |
| 39 / 40 | PLASTER / CARPET | wood 1.2-2.2 / sand 1-1.8 | bullet_hit_plaster / carpet → stone | .BUL_PLASTER + .BUL_STONE | as stone |
| 12, 14, 24, 27-29, 34, 36 | UNDERWATER, BROKEN GLASS, SNOWY_TREE, METAL_RAILING, METAL_GRATE(_THIN), CAMO_NET, CHAINLINK_FENCE | -- | -- | -- | nothing |

The metal, stone, dirt and grass impacts carry a leading `lensfx == 5` gate (the NVG view) for an `NVGPUFF` sprite.
The flash they open with (`fire_flash`: `firepuff`, `explosion2.tif`) is additive.

## 6. In the viewer

- **`@s2u/scene`**:
  - `effects.ts`: the numbering, `decodeEffectProgram` (every command of an animation to an `EffectOp`),
    `decalSetRows`, `tracerRound`;
  - `effectMotion.ts`: `decodeObjectMotion`, `launchMotion`, `stepMotion`, the terminal table;
  - `effectParticles.ts`: `decodeParticleSource`, the keys, the fade, the friction, the context velocities;
  - `effectModels.ts`: the `EFFE_GEO`/`EFFE_MDL` models, each chunk in the position form whose vertices fill its
    node's box -- the casings in the weapons' `0x70` form, the flat quads in the world's `0x68` form;
  - `zanim.ts`: each command now carries its bytes.
- **The viewer**:
  - `effectData.ts` (the worker): both zAnim archives' programs, the effect models, the `EFFE`/`ALPH` textures with
    their GS state, the SOILS names, the `DefaultMaterial`, the `BULLET_MARK_SMALL` rows, the `HitAnimName`s;
  - `effectRunner.ts`: the sequencer (§1's control flow);
  - `effects.ts`: `Effects` -- `onRound`, `play(name, place)`, `marks()`, the casings' flight on the walk's hull;
  - `particles.ts`: the particle manager;
  - `effectMaterials.ts`: the GS arithmetic, `(texel × vertex) clamped × (1 + FIX/128)`, blended by the texture's
    packet.
  - `fire.ts` takes the per-material marks (`setMarks`: the row, the projected square, 150 kept) and the tracer rule
    (`setTracerRule`: none for the M4A1 SD). `main.ts` wires `Fire.subscribe` to `effects.onRound`.
- **The grenades' door**: `effects.play(name, { node?, position?, velocity?, normal? })` runs any animation of the
  map's zAnim archives -- `frag_grenade_stone`, `he_grenade`, `grenade_hit_snow`, `dust_explode_med` -- and answers
  false for a name the map lacks. `impactAnimation(hitAnim, material)` builds the per-material name, and
  `effects.materialName(byte)` resolves a polygon's byte (0 → `DefaultMaterial`).
- **Readings and placeholders**:
  - `MARK_GRAZE_FLOOR` (0.2) bounds a slanting mark's stretch where the game clips to the polygon.
  - The casing's floor probe is the walk's segment test straight down, standing in for `FUN_002a2eb0`'s terrain query.
  - `LIGHT` is drawn as the engine's second pass over the lit world (§10); the body is not re-drawn.
  - The zoom mode is read as the first-person view.
  - The rotated (1) and flat (2) particle types are drawn as the engine draws them (§11).
  - The tracer, where one is due, is still `Fire`'s one-frame line, not the travelling `tracer_ally` model.

## 7. Verification

- `scene/test/effects.test.ts`: the numbering; the small commands from their bytes; the launch direction, the terminal
  table, a casing's flight and bounces on a synthetic floor; the keys, fades, friction and context velocities; the
  tracer rule. On Frostfire's archives: the M4A1 family's calls, `shell_eject`'s every number and table,
  `shell_smoke_med` switched off, the metal sparks' streak.
- `scene/test/effectModels.test.ts`: the form choice (a collapsed point fills nothing), the casing 0.45 long, the
  flash hider's five quads.
- `viewer/test/effectRunner.test.ts`: branches, nesting, waits, loops, timed commands, `FAIL`.
- `viewer/test/effects.test.ts`: on the game's data end to end. A round's casing goes right and up, bounces on a
  metal deck with `.BUL_CASE_METAL` and is gone by 1.2 s. The smoke emits nothing. The flash is at the muzzle along
  the barrel and hides. `bullet_hit_metal_thick` and `BULLET_HIT_STONE` (any case) emit with their sounds.
- `viewer/test/fire.test.ts`: the pool of 150.
- `e2e/effects.spec.ts` (Playwright, `?redotcom`, walk mode):
  - Frostfire at spawn A: a casing in the air, a burst's casings bouncing and gone, the sparks and the metal marks on
    the container (`test-fixtures/screens/effects/frostfire-*.png`).
  - Desert Glory at spawn A: the stone wall's dust, sparks and grey marks against the sand's puff and mark, and the
    M4A1's flash held for its picture (`desert-glory-*.png`).

## 8. Open

- The tracer's travelling model and its `redpuffs` particles.
- Whether a mark's or a footprint's 100.0 lifetime is ever counted down.
- The body (skinned) under a light's pass; the lit visuals' own gate (visual flags 0x4000 and 0x10).
- A `WHILE` with conditions (only the endless form is on the effects' path).
- The round's own path: the `PENETRATION` 1.0 materials passed through, and the penetration into a second surface.
  `Fire` still stops at the first polygon; that is the shot's owner's.

## 9. The grenades' explosions and bounces (round two)

- **The explosion** runs the material's variant, `frag_grenade_<material>`: its own 0.05 s puff, then a call to
  `frag_grenade`. That fires the parts: `FRAG_sparks` (a bare root node thrown by a fixed launch with streaked sparks
  hung on it), `dust_explode_long`, `light_flash_large` (§10), `bsmoke_explode_large`, `dust_ground_roll` and
  `.GREN_MED`. The HE runs `HE_grenade`.
- The grenade's page (`grenade.ts`) emits `explode` and `bounce`. `main.ts` plays their `anim` through `effects.play`
  with a node at the point; the `EXPLOSION_READING` sprites stay only for a map without effect data.
- **`OBJECT_MOTION`'s fixed launch** (flag 0x8, decomp 110654-110911) is block A's speed and pull along the stored
  direction at +0x54. That direction is `FUN_0025cb00` of the block's angles: `FRAG_sparks`' (0, 0.556, -0.444) is
  azimuth 0, zenith 50, pulled at -200 against it.
- An animation rooted at no model still has an instance node (`NODE_ROOT`), which the viewer makes empty. A particle
  source with flag A 0x10 follows its node every tick.

## 10. The lights (`LIGHT`, 32; tick `FUN_00264cb0`, decomp 111906-112214)

**The fields.**

| Off | Flag | Meaning |
|---|---|---|
| +4 | – | flags (u16) |
| +6 | – | the light's node |
| +8 | 0x2 | the node it sits at (0xFA the caller) |
| – | 0x8 | at the context's position |
| +9 | 0x100 | the GS ALPHA selector (default 0x44) |
| +0xc / +0x10 | 0x10 | a static min/max range |
| +0x14 | 0x4 | an offset |
| +0x20 | 0x40 | RGB, 0..255 |
| +0x2c | 0x80 | the pass's opacity, over 128 (default 64); **not a radius** |
| +0x34 / +0x36 | 0x20 | the count and offset of `(t, min, max)` keys, linear, the last held |
| +0x3c | – | the command's length |
| – | 0x400 | on the world's light list |

**The lights on the disc.**

| Light | Colour | Blend | Ranges |
|---|---|---|---|
| `light_flash_large` (frag) | 214, 242, 217 | 0x48, additive | 100/190 shrinking to nothing at 0.5 s |
| `HE_light_flash_large` | 230, 217, 166 | additive | to nothing at 0.7 s |
| `zoom_flash_fire` (a muzzle, at the caller) | 204, 173, 120 | 0x44 | 5/12 -> 15/60 -> 0 in 0.1 s |
| `flash_fire_hider`'s `light_at_muzzle` | the same | 0x44 | 6/26 -> 50/100 |

The M4A1 SD's own muzzle has none.

**How the engine draws a light.** It does not light the vertex colours. It draws a **second pass of every lit
visual in reach**, world, characters and weapons alike:
- `FUN_00339660` gives a node the lights whose sphere meets its own, at most six. `FUN_003b5b90` emits VU1 command
  0x3a once a light.
- The handler at 0x23d8 re-draws the triangles with `light_map.tif` (`EFFE_TXR`: white, alpha 0.94 at the centre
  to 0 at the rim) projected on the surface.
- `L = light - P`, `h = max(L.N, 0)`, `f = 0.5 clamp((max - h)/(max - min))`, `gate = min(h, 1)`, and
  `uv = 0.5 + (L.T, L.B)/max`: a spot `max/2` in radius under the light.
- The colour is `min(1, 2 rgb/255 f)` and the alpha `At opacity f gate / 128`. The blend is the light's:
  `dst += Cs As` for the explosions.
- None of the grenade or muzzle animations uses `BLUR3D`, `IRIS_EFFECT` or `TRUE_COLOR_SCALE`. The flashbang's
  blinding is code (`FUN_00597c00`).

**The viewer** (`effectLights.ts`) draws the pass as overlays sharing the world's and the held weapon's geometry, per
fragment, with the face's normal.

## 11. Particle types, water, footprints, sounds, the pre-warm

**Particle types.**
- **Rotated** (type 1, `FUN_00325580`): a screen square turned by its angle, its half-diagonal the size.
  - Its corner i is at `C + size (cos(t + i pi/2) right + sin(t + i pi/2) down)`.
  - The angle is spun by the source's spin block (+0xce: spin and acceleration min/max). The spin is stopped where it
    would change sign.
  - The starting angle is the pool slot's stale one, random here.
  - The fire, smoke and explosion dust, and the dirt, stone and wood impacts, are this type.
- **Flat** (type 2, `FUN_00325cc0`): a square in the world XZ plane at the particle's height, `2 size` across, u along
  +z. The ripples, the splash's rings and `bullet_hit_water`'s ring are this type.
- **`WHILE`/`END_WHILE`** (39/40): the ripples loop forever until the engine stops them.

**Water** (`FUN_005b52b0`, decomp 469808-469920). The SEAL's ground probe calls it over LIQUID water:
- With the water line across the body, `big_ripple_anim[_walk|_run]` plays by speed class (`|v|^2` at 0.25 and 400).
  With it up to 10 over the top, `small_ripple_anim*`.
- The ripples play on a node moved each frame to the water under the SEAL.
- The first frame in the water in the air plays `seal_fall_in_water` at the water point: the traversal's `waterLand`.
- Walking into water splashes nothing.
- A round on water is `bullet_hit_water` (its flat `theripple`), nothing special.
- The viewer stops the ripples when the SEAL leaves the water. The game's loops ran on where they were: its call
  comes only over water.

**Footfalls.**
- `FUN_005a49f0` looks up `seal_footfall_<MATERIAL>` for every material. **None exists on any map**, so a footfall
  plays no effect.
- `FUN_005a3280` (decomp 460186) prints `decals.rdr`'s `FOOTSTEP_DECALS` (SAND `stamp_footprint01.tif`, SNOW
  `stamp_footprint_snow.tif`) at each footfall, not prone. It is 3.5 across, flat along the ground's normal, and runs
  along the SEAL's forward, in the temporary pool.

**Sounds.** The game resolves a sound by its name's CRC among the loaded banks' sounds: a binary search over one sorted
table (`FUN_00344f30` -> `FUN_00344bf0`), with no fallback bank and no alias. So two effect sounds are silent on the
console. The viewer departs from it deliberately (`SOUND_NAME_FIXES`, `SOUND_FALLBACKS`, `soundFor` in `effects.ts`):
- The casings' metal bounce is named `.BUL_CASE_METAL` in `shell_eject`, `shell_eject_60` and
  `shell_eject_first_person`. No bank and no `sounds.rdr` entry carries it, while `.BUL_CAS_METAL` sits in 16 banks,
  Frostfire's among them. The viewer plays the latter.
- Grass and dirt casings ask for `.BUL_CAS_DIRT`, which Blood Lake's banks lack beside their own `.BUL_CAS_GRASS`.
  The viewer plays the first of `.BUL_CAS_GROUND`, `.BUL_CAS_GRASS`, `.BUL_CAS_SAND` the map holds.
- Night Stalker's `.BUL_STONE` is in `MP7_am` and plays: 4 of 4 stone hits heard at spawn A.

**The pre-warm** (research 90 item 16). When the map's effect data arrives, every effect's program is compiled and
its bitmaps uploaded (`Effects.warmUp`, `renderer.compileAsync`): the models, a particle group per texture, the marks'
and footprints' materials, and the light pass's two programs (its colour and opacity are uniforms). A software-rendered
headless browser measured the first frag's first frame at 127 ms warmed against 400 ms cold on Desert Glory. The
blast's overdraw, not its first use, is the rest there.
