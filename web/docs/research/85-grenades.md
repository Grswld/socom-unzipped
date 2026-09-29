# 85 — The frag grenade: the hold, the throw, the flight, the fuse and the explosion (2026-09-28)

The grenades workstream (the owner's "if time, grenades can be added"). Everything the viewer's M67 does is read here
from the game: the weapon record on the disc, the throw's code and `.data` in the SOCOM II ELF, the materials table,
the motion clips and the effect scripts. The decompilation is reference only: functions are cited by address and
`socom2_game.elf.decomp.c` line (`decomp :n`), never copied; the `.data` values were read out of
`game/disc/socom2_game.elf` by virtual address; short hex constants are quoted as the instructions load them. Names
in quotes after an address are the SOCOM 1 demo's symbol for the function's twin (`SCUS_972.05`, research 44) or
`recomp/socom2_names.csv`'s. No game run, no PCSX2.

Code: `@s2u/scene`'s `packages/scene/src/projectile.ts` (pure, tested in `test/projectile.test.ts`), the viewer's
`packages/viewer/src/grenade.ts` and `grenadeAssets.ts`, the e2e `packages/viewer/e2e/grenade.spec.ts`.

## 0. The answers

- **The throw's power is the fire button's pressure, not a timer** — but a held digital button is pressure 1, so it
  becomes how long it was held (§2). The player controller's update chases the pressure with the power at 3/s rising,
  1.5/s falling, and throws when the pressure falls under 0.15 of the power. Held 0.25 s: power 0.54; 0.5 s: 0.78;
  1 s: 0.95.
- **The aim pitch picks the clip and lifts the arc** (§3, §4): power under 0.6 with `sin(aim)` under 0.3 is the
  underhand toss; the launch pitch is the aim clamped to 0..55 degrees plus 10..12 degrees by power; the speed runs
  from 5 % to 100 % of `ComputeMaxVel`, the speed that carries a 45-degree throw 600 units standing (300 otherwise).
- **The flight is a point under gravity 98 u/s^2 against the hull** (§5): each frame one segment; the nearest hit
  that is not a penetrable material reflects the velocity about the normal and scales it by the material's
  `ELASTICITY_COEFF` (x0.75 more on the first bounce); slower than 5 u/s after a bounce that turned a fall upward, it
  stops. There is **no rolling and no friction term**: a grenade on the ground skids to rest in ever-smaller hops.
- **The fuse is `Timer1` = 3 s from the release** (the grenade cannot be cooked); `Timer2` = 3.1 s removes it (§6).
- **The explosion** (§7): `Explosion_Damage` 10 in full to half of `Explosion_Radius` 15 m = 150 units, falling
  linearly to 0 at 150. Its picture is the zAnim `frag_grenade`: sparks, a long dust, a light flash (radius 100 -> 190
  over 0.5 s), black smoke with a fireball, a ground dust roll, the sound `.GREN_MED`; the scorch `grenade_mark.tif`.
- **The model** is `WEAP_GEO`'s `grenade` (81 vertices, 82 triangles, `G11b.tif` + `m79.tif`), held on the right
  hand's item node through the throw clip, released from the posed hand (§8).
- **The slots** (§9.1): SOCOM II selects a grenade with R2's inventory, or with L1/L2 (`SwapWeapon1/2`) swapping to the
  slot assigned to them. Every hand grenade -- the M67, the HE, the AN-M8 smoke, the Mark141 flashbang -- bounces
  (§9.2); the smoke screens for 40 s (§9.6), the flashbang whites the screen out by distance and facing (§9.5), the
  claymore is set down and waits (§9.7).
- **The claymore is remote** (§9.7.1): no tripwire, no proximity (only the PMN mine has `ProximityDistance`), no fuse.
  R1 plays `seal_place_claymore`; 1.3 s in it is down under the right hand and the kit's **Detonator** (ID 193) comes
  up; R1 with the Detonator sets off the SEAL's claymores within 500 units. Four down at most.
- **The yellow arc** (§11) is the player controller's draw `FUN_005970b0`: from the fire press to the let-go, with a
  hand grenade, outside the 9x view and the scopes, the throw's own parabola from `GetThrowAnim`'s table point at the
  power of the moment -- 100 steps from 1 s before the hand to twice the fall to the feet, (0.78, 0.78, 0) fading from
  alpha 0.75 to 0.1 ((1, 1, 0.8) in the night vision); no collision, no bounce, no impact marker.
- **The bounce materials** (§9.9) resolve on all 22 maps with the archive's own names; the silent metal and asphalt
  bounces are the game's data (MP2's banks have no `.GREN_METAL`; no bank has `.GREN_ASPHALT`).

## 1. The record: `RUN/ZWEAPON.ZAR/zweapon.rdr`

The M67's `ZWEAPON` record and its `ZAMMO` round (`M67 Ammo`, `ID 11`), and what the weapon loader (decomp
322395-322700; the key strings at 0x3fc9f0.. 0x3fcd00) does with each field. `DAT_003dfe10` is `CWorld::m_scale` =
1 / the map's `MetersPerUnit` (set at decomp 217166) = **10**: the loader multiplies the distance fields by it.

| key | M67 | loaded as | where it lands / what reads it |
|---|---|---|---|
| `ID` | 121 (`0x79`, `'y'`) | the type byte `weapon+0x7c` | `HandleIntersections` sends type `'y'` (and 0x97, 0xac, 0xad, 0xb2, 0xb9, 0xba) to `HandleBounce`, every other type to `HandleImpact` (decomp 320032-320041) |
| `Timer1` | 3 | seconds, absent -> 9999999 (never) | `SetProjectile` puts it at the projectile's `+0x8c` (decomp 0x3cb1a0) |
| `Timer2` | 3.1 | seconds | `+0x90` |
| `Muzzle_Velocity` | 0.1 | x10 = **1** (`weapon+0x44`) | `SetProjectile`: `vel = velscale x this + vel` -- the throw's velocity passes unchanged |
| `Gravity_Acceleration` | absent | **9.8 x10 = 98** (decomp 322410-322415) | `weapon+0x48`; `PreTick` subtracts it from `vel.y` each frame |
| `ImpactRadius` | 45 | x10 = 450 (`+0x4c`) | `HandleImpact`'s alert sphere (times the material's `IMPACT_RADIUS_MOD`); not a bounce term |
| `Effective_Range` | 40 | x10 = 400 (`+0x40`) | -- |
| `Maximum_Range` | 10000 | x10 = 100000 (`+0x3c`) | the projectile's `+0x94`: hits beyond it are ignored |
| `Ammo_Capacity` / `NumMags` | 3 / 1 | | three grenades |
| `Sound_Radius` | 700 | raw | -- |
| `ModelName` | `grenade` | | §8 |
| `FireAnimName` | `frag_start` | zAnim | `CZANIM.ZAR` `frag_start`: the sound `.THROW_OBJECT` |
| `HitAnimName` | `grenade_hit` | zAnim stem | `grenade_hit_<material>`: the bounce sounds (§5.4) |
| `DefaultSpecialAnimName` | `frag_grenade` | zAnim | the explosion (§7) |
| `DecalSet` | `GRENADE_BLAST` | | `decals.rdr` (§7.3) |
| `M67 Ammo` `Explosion_Damage` | 10 | raw (`ammo+0x18`) | §7.1 |
| `M67 Ammo` `Explosion_Radius` | 15 | x10 = **150** (`ammo+0x1c`) | §7.1 |
| `M67 Ammo` `ImpactDamage`, `Piercing` | 0.2, 4 | | not read here |

The record's `Reticule_Modifiers` and `FireWait 0.1` are the rifles' shape carried along; nothing in the throw reads
them. The HE grenade (`HE`, `ID 126`, `Explosion_Radius 10`, `Explosion_Damage 11`, model `HEgrenade`) is not in
`HandleIntersections`' bounce list -- it takes `HandleImpact` [reading: not followed further].

`test/projectile.test.ts` proves `M67` (the transcription) equals `throwableRecord` of the fixture's `ZWEAPON.ZAR`.

## 2. The power: the player controller's update `FUN_00594cf0`

`FUN_00594cf0` is the player controller's per-frame update (research 21 names it the `PlayerUpd` dispatch target);
its float argument is the frame's `dt` (`mov.s $f20, $f12` at 0x594d40). While a throw is held (0x595ea0-0x595f28):

1. `pressure = FUN_002c6350(pad) x DAT_00650660`: the pad's **pressure byte** for the fire button (0..255; 0x2c6350
   reads byte 0x1d or 0x1a of the pad buffer by the controller config) times `1/255` (`0x3b808081`).
2. **The release**: if `pressure <= power x DAT_00650668` (0.15, `0x3e19999a`) the throw goes (`FUN_005dfe30(body,
   1)` at 0x595f34, the weapon state set to fire; the power is kept).
3. Otherwise the power chases the pressure: `rate = pressure <= power ? DAT_006505d8 (1.5) : DAT_006505e0 (3.0)`,
   `f = dt x rate`, `power = power x (1 - f) + pressure x f` (`MULA.S`/`MADD.S` at 0x595f18-0x595f1c), stored at
   the controller's `+0x11c`.

The power starts at 0 (0x596020 zeroes `+0x11c`, as does `FUN_00592d40`). `CZKit_TickExplosives` reads it back
from `body->controller+0x11c` (decomp 477024). The SOCOM 1 demo did it differently -- `GetThrowAverage__9CSealCtrlFv`
(demo 0x2844a0) returns the peak of the last pressure samples over 255 -- so SOCOM II replaced the peak with this lag.

**What it means for a key or a mouse button**: pressure 1 while held, 0 let go. At 60 Hz the power after n frames is
`1 - 0.95^n`: 0.265 at 0.1 s, 0.537 at 0.25 s, 0.785 at 0.5 s, 0.954 at 1 s, 0.998 at 2 s. On a PS2 pad a light
press holds the power low however long it is held.

`THROW_PARAMS`' `abort_threshold` (0.15) is loaded but its reader was not found by offset; the release's 0.15 is the
`.data` constant above, not the dynamics field [reading]. The flag-bit path at 0x595fc0 (the `+0x170` bit 7 case)
zeroes the power and calls `FUN_005dfe30(body, 2)` -- read as the throw's cancel; not modelled.

## 3. The clip: `GetThrowAnim` (0x57fce0; demo `GetThrowAnim__10CZSealBodyFfR8AnimTypeRfRfR6CPnt3D`)

Arguments: the power, the body; out: the animset type, the release fraction, a zeroed float, the hand's point in
the actor frame. The toss test (decomp 441723-441726): `power < dynamics+0x1a4` and `body+0x1450 < dynamics+0x1a8`, i.e.
`toss_power_threshold` and `toss_aim_threshold` (§3.1). `body+0x1450` is the aim's **sine**: `CZKit_TickExplosives`
takes `asinf` of it (`FUN_001b38c8` -> `FUN_001af178`, a fdlibm `asinf`), and a loaded `toss_aim_threshold` passes
through `sinf` (`FUN_001b3720`) at load.

The body's state short `+0x174` selects the row. The types (`DAT_003deb20`..`DAT_003debe8`) are set at run time from
the animset names (decomp 495211-495236), which fixes the states' meaning: **0 stand, 1 crouch, 2 prone, 3 peek**.

| state | condition | animset type | clip (`MOTION_P.ZAR`) | frames | `motion.rdr` playback | release | hand (x right, y up, z behind) | `.data` |
|---|---|---|---|---|---|---|---|---|
| 0 stand | throw | Throw grenade | `seal_throwgrenade` | 28 | 1.6 | 0.46 | (3.3438, 19.3478, 3.9138) | 0x66b310 |
| 0 stand | toss | Toss grenade | `seal_tossgrenade` | 30 | 1.6 | 0.69 | (3.13, 13.8, -10.5) | 0x66b328 |
| 1 crouch | still (speed^2 <= 225) | Crouch throw grenade | `seal_crouch_throwgrenade` | 19 | 1.1 | 0.70 | (6.05, 15.59, 1.96) | 0x66b340 |
| 1 crouch | moving | Throw grenade | `seal_throwgrenade` | 28 | 1.6 | 0.46 | the standing throw's | 0x66b310 |
| 2 prone | throw | Prone throw grenade | `seal_prone_throwgrenade` | 27 | 1.6 | 0.66 | (6.29, 15.05, -0.97) | 0x66b358 |
| 2 prone | toss | Prone toss grenade | `seal_prone_tossgrenade` | 27 | 1.1 | 0.56 | (2.39, 7.87, -8.53) | 0x66b370 |
| 3 peek | right lean | Peek right toss | `seal_toss_rlean` | 35 | 1.25 | 0.55 | (7.8, 10.13, -5.31) | 0x66b388 |
| 3 peek | left lean | Peek left toss | `seal_toss_llean` | 28 | 1.2 | 0.87 | (-8.83, 11.47, -6.48) | 0x66b3a0 |

The crouch's moving test is `|m_velM|^2 <= DAT_00650578` (225, `0x43610000`: 15 u/s). The peek row tests which lean
clip is playing (`FUN_00577e40` with 0x1d/0x1f and 0x1e/0x20). Clips run at 30 frames a second (research 77).

**The release time.** `FUN_005802b0` returns `0 + fraction x clip(+0x10) x FUN_0028ada0(clip)`. The motion
workstream read both factors (research 80, `viewer/src/locomotion.ts`): a one-shot's `+0x10` is `motion.rdr`'s
`playback` (`FUN_00287620`), `FUN_0028ada0` is `(n - 1) / n`, and the phase runs at `1 / (playback (n - 1) / n)` a
second (`FUN_0028c4f0`) -- so the release is the moment the clip's own phase reaches the fraction:
`release x playback x (n - 1) / n`. The standing throw lets go **0.71 s** after the button (0.46 x 1.6 x 27/28), the
toss 1.07 s, the crouched throw 0.73 s; the whole clip plays in `playback ((n - 1) / n)^2` (1.49 s standing).
`motion.rdr`'s `throw_whoosh` callback (the grunt `.MALE_GRUNT`) at phase 0.45 fires one frame before the 0.46.
`NoInterrupt` (0.49 on the throw, 0.75 on the toss) is not modelled.

`FUN_005499e0` is a line-of-sight check from the hand to a second point per row (e.g. (1.155, 13.354, -15.75)
standing) through the hull (`FUN_0031e250`); its caller was not traced, so the viewer does not refuse a blocked throw.

### 3.1 `THROW_PARAMS`

`CharacterDynamics_Load` (0x59ba80) reads a `THROW_PARAMS` list (key at 0x65ecb0) into the dynamics block at
`+0x198..+0x1a8` (decomp 456874-456884). The shipped `READERC.ZAR/dynamics.rdr` **has no `THROW_PARAMS`**, so the
defaults the static constructor (decomp 328441) sets through `FUN_002ce1a0` stand:

| key (string) | default | bits |
|---|---|---|
| `abort_threshold` (0x65ecc0) | 0.15 | `0x3e19999a` |
| `max_distance_stand` (0x65ecd0) | 600 | `0x44160000` |
| `max_distance_crouch` (0x65ecf0) | 300 | `0x43960000` |
| `toss_power_threshold` (0x65ed10) | 0.6 | `0x3f19999a` |
| `toss_aim_threshold` (0x65ed30) | 0.3 (a sine; loaded values are degrees through `sinf`) | `0x3e99999a` |

The dynamics block is the global at 0x44c250 (`FUN_0058ce60` returns it); `CAMERA_WIGGLE`'s defaults beside it
(`FUN_002ce1e0`: 22, 0.6, 0.1) equal the file's values, which checks the mapping.

## 4. The launch: `CZKit_TickExplosives` (0x5c1970) and `CDynGrenade`

At the release frame (decomp 477024-477130; instructions 0x5c20f8-0x5c22f4):

1. **The hand's point**: `FUN_002869d0(body+0x170, bone, (2, 0, 0), &out, 0)` carries the point (2, 0, 0) in the hand
   bone's frame (`body+0x300`; `+0x2f8` for the left-lean toss) up the skeleton into the actor frame. The yellow arc
   the held throw shows (`FUN_005970b0`, §11 -- not a debug draw: `DAT_003df1b0` is the player's control flag, 1 in
   `.data`) uses `GetThrowAnim`'s table point instead.
2. **The farthest distance**: `max_distance_stand` when the state is 0, `max_distance_crouch` otherwise.
3. **`ComputeMaxVel`** (0x5976e0, demo `ComputeMaxVel__11CDynGrenadeFffPf`): `t = sqrt(2 (h + 1 x d) / 98)`,
   `speed = d / (0.707107 t)` with `h` the hand's height; `DAT_006505b8` = 1, `DAT_006505c0` = 0.707107. It is the
   speed a 45-degree throw needs to land `d` away from `h` up. Standing (hand 19.35): **238.66 u/s**; crouched (15.59):
   167.2.
4. **The pitch**: `asinf(body+0x1450)` clamped to [0, 0.959931] (0x65e630/0x65e638: 0 and 55 degrees, `FUN_00539b70`),
   plus **`ComputeElevOfs`** (0x5976a0): `(12 power + 10 (1 - power))` degrees (`DAT_006505b0` = 12, `DAT_006505a8` = 10).
5. **The power's speed**: `lerp(0.05 max, max, power)` (`FUN_00597630`, the 0.05 is `0x3d4ccccd`).
6. **`ComputeTimeToImpact`** (0x5975d0): the later root of `-49 t^2 + vy t + h = 0` (`FUN_0050de20` with `0xc2440000`,
   `FUN_00575c50` the max), times `vh`: the range over the ground from the hand.
7. **The aimed correction** (`DAT_006505c8` = 1 in `.data`, never written): the target is the range straight ahead of
   the actor's **origin**, `(0, -range)`; the ground-plane direction turns from the hand to it (`FUN_00309110`
   normalise, `FUN_0050df10` puts `sin p` in y and scales x, z by `cos p`); **the speed becomes the hand's distance to
   that target**, `sqrt(range^2 + 2 range z + x^2 + z^2)` (`ADDA.S`/`MADD.S` at 0x5c220c/0x5c221c), clamped to
   [0, max]. (Branch 0, unused: direction `(0, sin p, -cos p)` at the power's speed.)
8. The direction goes through the body node's rotation (`FUN_00597530`), the hand through its matrix
   (`FUN_003085c0`), and `FUN_005c5340` fires the weapon with them; `SetProjectile` (0x3cb1a0) takes the velocity x
   `Muzzle_Velocity` (1).

**Step 7's consequence** (a faithful port, worth confirming on a console): the speed is a distance, so the landing
point matches the power's prediction only when the flight lasts about a second -- at low pitch it nearly does. Some
standing throws, the hand's height 19.35 (`throwVelocity`, `impactRange`):

| held | power | aim | launch pitch | speed | power's range | where it lands |
|---|---|---|---|---|---|---|
| tap | 0.000 | 0 | 10.0 | 12.0 | 7.6 | 7.7 |
| 0.1 s | 0.265 | 0 | 10.5 | 59.0 | 55.0 | 43.4 |
| 0.25 s | 0.537 | 0 | 11.1 | 127.6 | 123.6 | 116.0 |
| 0.5 s | 0.785 | 0 | 11.6 | 213.9 | 209.9 | 252.2 |
| 1 s | 0.954 | 0 | 11.9 | 238.7 | 284.0 | 305.3 |
| 1 s | 0.954 | 30 deg | 41.9 | 238.7 | 549.1 | 598.7 |
| 2 s | 0.998 | 30 deg | 42.0 | 238.7 | 596.5 | 598.8 |

A level full throw lands about 305 units out; aimed 30 degrees up it reaches the 600 of `max_distance_stand`. At
mid power and a high aim the speed reaches the max early (0.25 s held, 30 degrees: 443 units).

## 5. The flight: `CZProjectile`

The projectile methods, matched by order and shape to the demo's `CZProjectile` (demo 0x318230-0x319ff0):
`HandleImpact` 0x3c8920, `HandleBounce` 0x3c8f50, `HandleTimers` 0x3c99a0, `HandleIntersections` 0x3c9b70,
`PostTick` 0x3c9fb0 (names.csv), `PreTick` 0x3ca5a0, `SetProjectile` 0x3cb1a0. Fields: `+0x48` the frame's start,
`+0x54` its end, `+0x60` the velocity, `+8` the grenade state, `+10` the projectile state (reCOM's
`PROJECTILE_STATE`: 1 flying, 2 at rest, 3 to be detonated ...), `+0xb` the resting flag, `+4` bit 1 "first bounce".

### 5.1 A frame

1. **`PreTick`** (flying states 1 and 6, a normal shot type): `vel.y -= gravity x dt`; start = the last end; end =
   start + `vel x dt` (`FUN_00309180` scale, `FUN_00309240` add): symplectic Euler. The segment is registered as the
   projectile's intersection query (`FUN_0031dd90`). At rest (state 2) nothing moves.
2. **`PostTick`**: both timers lose `dt`; then `HandleIntersections`.
3. **`HandleIntersections`**: over the query's hits nearest first, beyond the last one handled; a hit on a material
   with PENETRATION exactly 1 is passed over (`fVar15 != 1.0`). The M67's type goes to `HandleBounce`; its answer 1
   ends the frame there, 2 (passed through) searches on; no hit, `FUN_003c9530` takes the segment's end.
4. **`HandleTimers`**: `Timer1 <= 0` sets state 3 (to be detonated, grenade state 2); then `Timer2 <= 0` removal.

### 5.2 The bounce (`HandleBounce` 0x3c8f50)

The material is the table's entry for the polygon's byte (`FUN_002dc1d0`, §5.3). If it is **not LIQUID and its
PENETRATION is under 0.99**:

- `r = v - 2 (v.n) n` (`FUN_00308ef0`, the normal from the intersect record; zero if already resting);
- `v = r x ELASTICITY_COEFF`, and **x 0.75 more on the first bounce** (flag bit 1 of `+4`, set by `SetProjectile`,
  cleared here);
- faster than 10 after it (`10.0 < fVar15`) and not UNDERWATER: the material's hit zAnim plays at the point
  (`FUN_003d22e0` then `FUN_00272bb0`);
- slower than **5** and not already at rest: on PERSON (`DAT_003e14f8`, looked up by name) the damping is undone;
  otherwise, **if the fall was downward before and the new velocity is upward, it stops**: `v = 0`, state 2, `+0xb = 1`;
- the new position is the hit point plus the unit normal x **0.1** (`0x3dcccccd`).

Otherwise (LIQUID, or PENETRATION >= 0.99): `v x= ELASTICITY_COEFF`, and the position is the point plus `v x 0.0001`
(`0x38d1b717`); the search continues along the segment.

No other term touches the velocity: **there is no friction and no rolling**. A grenade on flat ground loses
`1 - e` of its speed at every hop; the hops shorten until one ends under 5 going up. The viewer's normal comes from
the hull polygon, either side; it is turned to face the grenade [reading: the engine's intersect record's normal].

### 5.3 The materials

The table (`DAT_0044f358`, `DAT_0044f354` entries) is built by `FUN_002dde40` from `READERC.ZAR/materials.rdr`'s
`SOILS`: first `FUN_002de4b0` adds **`UNKNOWN`** (ELASTICITY 0.3) and **`PARTICLE_SYSTEM`** (PENETRATION 1,
VOLUMETRIC), then the 44 SOILS in file order -- so a polygon's material byte `i >= 2` is SOILS entry `i - 2`. The fields
(decomp 181349-181420): `+0x20` OPACITY, `+0x24` PENETRATION, `+0x28` RICOCHET, `+0x2c` ELASTICITY_COEFF, `+0x30`
IMPACT_RADIUS_MOD, `+0x34` STEALTH_FACTOR, `+0x38` FOOT_STEP_OFFSET, `+0x3c` bit 0 VOLUMETRIC, bit 1 LIQUID, bit 2
UNDERWATER; the constructor `FUN_002deb30` defaults PENETRATION and ELASTICITY to 0. **Byte 0** is the map's
default (`DAT_0044f310`, set by `FUN_002ddc30` from a name looked up by `FUN_002de9e0`): the world root's
`DefaultMaterial` (`MP*.ZED`, decomp 217160; `METAL_THICK` on Frostfire). The hull's bytes bear it out: Frostfire's
3,318 polygons are 936 byte 0, 1,357 byte 25 (METAL_THICK), 326 byte 7 (STONE), 242 byte 3 (INVISIBLE_DI)...;
Crossroads' 22 is ASPHALT (1,262) and 19 WOOD_THICK.

What a grenade does on each (ELASTICITY / PENETRATION): STONE, METAL_THICK, PLASTER, CARPET, BARREL 0.5; ASPHALT
0.45; DIRT, WOOD 0.3; GRASS 0.2; SAND, MUD 0.1; SNOW, ICE, GRAVEL, LEAVES 0.15; GLASS_THICK, GLASS_OPAQUE 0.8.
Through it goes only WATER (LIQUID, x0.25) and GLASS (PENETRATION 0.99, x0.8); everything under 0.99 bounces, even
GLASS_MEDIUM (0.985), CAMO_NET and CHAINLINK_FENCE (0.98) and METAL_RAILING (0.95); and it never sees the PENETRATION-1
ones (ACTION, INVISIBLE_DI, ITEM, the `*_VOL` vegetation, PARTICLE_SYSTEM). `SOILS` in `projectile.ts` is tested equal to the file's.

### 5.4 The bounce sounds

`CZANIM.ZAR` holds `grenade_hit_<material>` per surface, each one sound: `.GREN_STONE`, `.GREN_SAND`, `.GREN_DIRT`,
`.GREN_GRAVEL`, `.GREN_GRASS`, `.GREN_ICE`, `.GREN_SNOW` (plus effects), `.GREN_TIN` (metal thin), `.GREN_METAL`
(thick, grate), `.GREN_WOOD`, `.GREN_LEAVES`, `.GREN_WATER` (a ripple, spray), `.GREN_CARPET`, `.GREN_ASPHALT`,
`.GREN_PLASTER` (a puff), `.GREN_GRATING`; person, fabric, leather, barrel, rubber borrow bullet sounds. The event
`bounce` carries `anim: grenade_hit_<material>` and `sound` (faster than 10).

## 6. The fuse

`Timer1` 3 s is set at `SetProjectile` -- **the release** -- and counted down in `PostTick`; `HandleTimers`
detonates at 0 wherever the grenade is, in the air or at rest. There is no cooking: the hold only builds power.
`Timer2` 3.1 s removes it. (reCOM's `CZProjectile` layout agrees: `m_time`, `m_removaltime`,
`zWeapon/zweapon.h:588-660`.)

## 7. The explosion

### 7.1 The damage (`CZProjectile::GetDamage`, 0x3c7600, decomp 318700-318760)

For an exploded projectile (states 5, 6): `damage = ammo+0x18 (Explosion_Damage) + weapon+0x64`; `r = distance /
ammo+0x1c (Explosion_Radius)`; `r > 1` -> 0; `r > 0.5` -> `damage x (1 - (r - 0.5) x 2)`; else full. For the M67:
10 out to 75 units, 5 at 112.5, 0 at 150. (`weapon+0x64` is a key not in the M67's record; 0.) The query is a sphere
of the explosion radius registered at the point in `PreTick` state 3 (`FUN_0031dc90` with `FUN_003d4500(ammo)`).
Nothing in the viewer takes damage; the `explode` event carries the damage at the player's feet.

### 7.2 The picture: the zAnim `frag_grenade` (`RUN/CZANIM.ZAR`, the set `common`)

`frag_grenade` calls `FRAG_sparks`, `dust_explode_long`, `light_flash_large`, `bsmoke_explode_large`,
`dust_ground_roll` and plays `.GREN_MED`. Per material there are `frag_grenade_<material>` variants (stone: a flash
and `firepuffStone` with `explosion2.tif`; dirt, grass: dirt thrown up; snow: snow puffs; underwater: `.EXP_WTR` and a
water column), most calling `frag_grenade` or `frag_grenade_stone`.

The particle emitters are set-0 command 0x27 (~300 bytes each), **not decoded field by field**. Read from the floats
that stand out (the viewer's `EXPLOSION_READING`, labelled a reading):

| part | bitmaps (`ALPH_TXR.ZED`) | velocity x / y / z | size | life | grey |
|---|---|---|---|---|---|
| `light_flash_large` (command 0x32) | -- | -- | radius 100 -> 190 | 0.5 s | (214.2, 242.25, 216.75), 64 |
| `bsmoke_explode_large` fire | `explosion2.tif` | +-70 / 0..240 / +-70 | 8-10 | -- | -- |
| its `GreyDustCloudUp`, `BlackDustCloudUp` | `effect_dustpuff01.tif` | -40..40 / 50..100 | 10-12 | 6.5-7.5, 9.5-10.5 | 0.5 -> 0.2 |
| `dust_explode_long` | `effect_dustcloud.tif` | +-15 | 5-10 | 6.5-9.5 | 0.6 |
| `FRAG_sparks` `spark_streak` | `effect_spark01.tif` | +-200 / 110..180 / +-200, pulled by (-560, -1000, -560) | 0.5-0.8 | 0.63-0.65 | -- |
| `dust_ground_roll` `DustRoll` | `cloudpuff01.tif` | +-140 along the ground | 12-15 | 2.6-3.0 | 0.4 |

The flash is a light in the game; the world's materials take no three.js light, so the viewer draws a glow a fifth
of the radius across instead [placeholder].

### 7.3 The scorch: `decals.rdr` `GRENADE_BLAST`

`grenade_mark.tif` (`EFFE_TXR.ZED`) per material, `MIN_SIZE`-`MAX_SIZE` across: SAND 30-50; DIRT, STONE 20.2-30.9;
SNOW, METAL_THICK, METAL_THIN, WOOD_THICK 10.2-20.9; WOOD_THIN, ASPHALT 10.2-16; GLASS 10-13. The viewer lays one
under a grenade that went off at rest (STONE's size for an unlisted material). Its colour: a `FUN_003139e0` decal like a bullet mark (`FUN_003d0ba0`, the permanent pool), so the GS
modulates its texel by the vertex colour of the world triangles under it (research 89 §13, `FUN_003b3ab0` /
`FUN_003beca0`). The viewer draws it with the marks' material (`markMaterial`: texel x vertex colour, brightened) and
paints its corners with `surfaceShade`'s colour straight down under the blast (the 4.8-unit window), asking again each
frame while the ground there is not drawn yet (`GrenadeThrower.setShade`, `stats().scorchShade`).

**The placement (traced 2026-09-29).** `FUN_003c7af0` (decomp 318876, the explosion's damage query, when
`Explosion_Radius` > 0) probes a vertical column at the blast's x and z, `FUN_0031df50(10.0, world, pos)` (a type-2
`DiIntersect`, research 23 §1.3), and `FUN_002d4c20` takes the **highest** candidate whose y is no more than **10**
over the blast's (no floor below). That candidate record -- `point, t, normal, node` -- is `FUN_003d0ba0`'s `param_3`:
the decal set by the candidate surface's material (`FUN_002dc1d0`, the record's `+0xc0` table), the square centred on
the candidate's point, framed along its normal negated (323891, `FUN_00307810`), the node its walk. So the scorch lies
flat on the ground under the blast whatever the slope, as a bullet mark lies on its wall (research 89 §15). The viewer
(`GrenadeThrower.groundUnder`) casts the throw's hull from 10 over the blast to 10 under it, takes the first solid
hit, and frames the clipped scorch on its point along its normal negated; its random turn about the normal is kept
[reading: `FUN_00307810` takes none]. Straight down, as before, Desert Glory's `g157` hillside (39.9 degrees at z
1700) dropped every scorch whole at the 4.8 test (`viewer/test/grenadeScorchSlope.test.ts`). Not followed: the game
marks under a blast in the air too (the column has no floor) and takes the probed surface's material for the size;
the viewer still marks at rest only, sized by the material it lay on.

## 8. The model and the hold

`WEAP_GEO.ZED`'s `grenade` (every map carries it with the weapons, research 79 §2's form): 81 vertices, 82 triangles,
`G11b.tif` and `m79.tif`, bbox (-0.60, -0.80, -0.52)-(0.67, 1.03, 0.52). `character.rdr`'s `body_items` list a
`grenade` attachment part beside `rifle` and `pistol` (research 78 §3.1); the skeleton's hands are `rhand` (17) and
`lhand` (24). The throw clips animate the held item's node `rifle` under `rhand` (`seal_throwgrenade` and the rest
carry a `rifle` track; the crouched and prone ones SOCOM 1's `weapon`), so the viewer hangs the grenade on that node
(`Play.heldNode`, the weapon workstream's `rifle` node) while it is up -- the rifle stowed -- and it rides the hand
through the clip. The release point is the **posed** right hand's (2, 0, 0) (`Play.partPoint('rhand', ...)`; the left
hand's for the left lean), carried into the actor frame for `throwVelocity`: standing, about 23 over the feet at the
release frame, against the table's 19.35. Without a posed body the table's point stands in (`HAND_PLACEHOLDER` for the
hold).

The HE (`HEgrenade`: 56 vertices, 50 triangles, `HEgrenade.tif`, `smoke_grenade02.tif`) is decoded beside it.

## 9. What the viewer does, and asks

### 9.1 How SOCOM II selects a grenade

`READERC.ZAR/controller.rdr`'s `ControllerConfigs` `Default` (and `Reverse`) bind **L1 `SwapWeapon1`, L2
`SwapWeapon2`, R2 `Inventory`**, R1 `Fire`, X `Action`, Square `Jump`, Circle `TeamCommand`, Select `TACMAP`, L3
`FireMode`, R3 `Reload`. The digital results are indexed in the order of the name table at 0x3f2bdc (0 `Action`, 1
`AimMode`, 2 `Fire`, 3 `FireMode`, 4 `Inventory`, 5 `Jump`, 6 `Reload`, 7/8 the strafes, 9 `SwapWeapon1`, 10
`SwapWeapon2`, 11 `TeamCommand`, 12 `TACMAP`); `FUN_002c64e0(result, pad)` answers a result's button state through
the config's byte at `+0x12 + result`.

- **L1 / L2** (the player update `FUN_00594cf0`, 0x595728 and 0x5957d4): a press of result 9 or 10 takes the kit slot
  the controller keeps at `+0x224` (L1) or `+0x228` (L2) -- `FUN_005bdc30` (the slot holds an item), `FUN_005c4fd0`
  (a change is allowed), `FUN_005c4b10(kit, slot)` (the change) -- or plays `FUN_003419c0`'s refusal. `CSealCtrl`'s
  constructor (0x598280) sets them to **slot 0 (the primary) and slot 1 (the sidearm)**.
- **R2** opens the inventory (`FUN_0021bda0`, reached from result 4 in the UI code at 0x219ce4/0x21c2cc): the kit's
  slots listed; in it, the pad's button 0xd assigns the highlighted slot to L1 (`+0x224`), 0xe to L2 (`+0x228`) --
  refused when it is the other's -- and 7 takes it up. So a grenade is selected from the inventory, or put on L1 or
  L2 there and swapped to with one press.
- The kit (`character.rdr` `mp_seal1`): 0 M4A1, 1 Mark 23, 2 M67, 3 HE, 4 Double Ammo Load.

**The viewer** (since the WEAPON workstream's round 3, the owner 2026-09-29): **L1** is the game's `SwapWeapon1`, the
rifle, and **L2** its `SwapWeapon2`, the sidearm (the controller's default slots 0 and 1; `./kit`); R2 is the inventory
as one press a step -- rifle, M67, HE, AN-M8, Mark141, claymore, Detonator (only while a claymore is down) -- in place
of the menu [placeholder]. The PC's number keys: `1` the main weapon, `2` the sidearm, `3` and `4` the kit's first and
second equipment slots in kit order (`equipmentSlots`: the M67 and the HE for `mp_seal1`); the rest of the pouch
(AN-M8, Mark141, claymore, Detonator) is reached through R2's inventory only. The HUD's box shows the item's
HUDW icon (`IconTextureName`: `grenade_frag_icon.tif`, `grenade_he_icon.tif`) and its count.

### 9.2 The HE

**Corrected in round 3.** `HandleIntersections` does not test the ID itself but its **category**: `FUN_003d1e10`
passes the weapon's `+0x7c` through `FUN_003d1a60`, which maps an ID to the first ID of its range (121-140 -> 0x79, the
hand grenades; 151-170 -> 0x97, the charges; `weaponCategory`). So the HE (126), the AN-M8 (122) and the Mark141 (123)
bounce exactly as the M67 does; `HandleImpact` (0x3c8920) -- which does set an explosive round to detonate at its first
non-liquid hit -- is the launched rounds' (0xab-0xb8 but 0xac, 0xad, 0xb2) and the bullets'. Round 2's "the HE goes
off where it lands" was wrong. The HE: `Explosion_Radius` 10 (100 units), `Explosion_Damage` 11, its zAnims `HE_start`
(`.THROW_OBJECT`) and `HE_grenade`.

**Which zAnim goes off** (`HandleDetonateExplosion`, 0x3c8330, decomp 319195-319290): for the AN-M8, 0x7d, 0x7f-0x80,
0xac-0xad, 0xb2, 0xb6 and the claymore, the record's `DefaultSpecialAnimName` on the projectile's own node (the smoke
stays with its canister); for the others a vertical probe under the point (`FUN_0031df50`): with ground less than 10
under it, the material's variant (`FUN_003d2320`: `SpecialMaterialAnimName_<material>`, `frag_grenade_stone` ...), else
the default -- the viewer takes the material the grenade came to rest on [reading]. Then the damage query
(`FUN_003c7af0`, when `Explosion_Radius` > 0), the claymore's model hidden, state 5.

**Since round 3 the explosions run through the EFFECTS workstream's zAnim runner** (`effects.play`: the game's own
particles and models); `GrenadeThrower.setEffectPlayer` takes the door, and a run it starts replaces this file's
placeholder sprites (`ExplosionInfo.byEffects`). The placeholders stay for a map or name the effects cannot play.

### 9.3 The sounds on Frostfire

- `.THROW_OBJECT` is `MP2_am.bnk`'s `.THROW_OBJECT ` -- with a trailing blank the zAnims' name lacks; the audio's
  lookup now finds a bank name by its trimmed form too (`audio.ts`).
- `grenade_hit_metal_thick` (and `_metal_grate`) play `.GREN_METAL`, which **no MP2 bank holds** (`MP2_am` has
  `.GREN_TIN`, `.GREN_STONE`, `.GREN_SNOW`, `.GREN_WOOD`): silent on the console too, where `FUN_00344f30` answers no
  handle. Frostfire's default material is METAL_THICK, so most of its bounces are silent.
- The material explosions (`frag_grenade_metal_thick` ...) reach `.GREN_MED` through a call (set 0 command 0x45) to
  `frag_grenade_stone` and on to `frag_grenade`; the audio's zAnim map lists direct sounds only, so the page falls back
  to the base zAnim (`ExplosionInfo.baseAnim`). Following the calls in `@s2u/sound`'s `callbackSounds` would be the
  audio workstream's fix.
- `MP2_fx.bnk` also holds `.GREN_PIN_PULL1`, `.GREN_NEAR`, `.GREN_FAR`; no zAnim on the disc names them (the ELF may,
  by a computed name): not played.

### 9.5 The flashbang: the white-out's rule

The Mark141 (`FLASHBANG`, ID 123): `Timer1` 1.5 s, `Timer2` 1.6, six carried, no damage, `Explosion_Radius` 15 (150
units), its zAnim `flashcrash_grenade` (`.MARK_141_FLASH`, a dust puff, `explosion_light`, `PhosExplode.tif`). No MP
default kit (`character.rdr`) carries it.

The player controller's flash reaction (vtable slot at 0x669500 -> `FUN_00597c00`, decomp 454528-454585):

- only inside `d^2 < 22500` (150 units); a falloff of 1 to 80 units (`d^2 <= 6400`), `1 - (d^2 - 6400) x 6.2e-5` past;
- `facing` = the actor node's z row against the unit body-to-flash difference -- the SEAL's forward against the
  direction to the flash; `s = 1 - facing x falloff`;
- facing away (`facing <= DAT_0065e640` = 0, or a flag in the body's `+0x104c` object) is level 1; else `s < 0.3`
  level 3, `s < 0.6` level 2, level 1 past it (`flashLevel`);
- it starts the map's `MZANIM.ZAR` animation `blindplayer0<level>` (`FUN_001988d0` with 0x65e668, `FUN_0026a250` on
  the zAnim main at 0x414bb0).

The three animations' `blinded` command (set 0, 0x24) reads [reading of its floats]: a start colour (1, 1, 1), then
keys of (seconds, grey, strength): level 1 (0, 0.9, 25) -> (2, 1, 0); level 2 (0, 0.75, 60), (1.5, 0.75, 60) -> (4, 1,
0); level 3 (0, 0.75, 60), (8, 0.75, 60) -> (10, 1, 0) (`BLIND_KEYS`); their `fadein` (0x21) rises over 0.2 s. The
viewer (`./flash`, `WhiteOut`) draws a white layer over the frame: 60 as full white, 25 as 25/60 [reading], 0.2 s in,
held, back by 2 / 4 / 10 s. The AI's cower (`Flashbang cower` clips, `CAiSStunResponse`) is not the viewer's.

### 9.6 The smoke

The AN-M8 (`SMOKE`, ID 122, `mp_seal2`/`mp_seal4`): `Timer1` 3, `Timer2` 40, no explosion. At 3 s `smoke_grenade`
plays on the canister (sparks, a flash, `!SMK_CANISTER`, and a call to `smoke_stream`), whose two `large_smoke`
particle sources (`cloudpuff01.tif`) throw puffs +-20 across and 0-17 up, 3-4.5 across, living 5-7 s, grey 0.6 and 0.4,
for 20 s twice over -- the 40 s of `Timer2` [reading of the 0x1b commands]. The effects run it; its puffs do not yet
read as a screen there, so the viewer also draws `SMOKE_PLACEHOLDER` (the same numbers, x10 in size, a puff every 0.2 s)
until the EFFECTS workstream's does (`SMOKE_ALWAYS_PLACEHOLDER`). What the smoke hides from the AI (a sight query) is not
the viewer's.

### 9.7 The claymore (and the C4)

The claymore (`mp_seal4`'s kit; ID 153, category 0x97): `Muzzle_Velocity` 0 -- placed, not thrown: `CZKit_TickExplosives`'
branch for 0x98-0x9a and 0x9e calls `FUN_005c2430` (the right hand's point through the vertical probe: the highest
ground at or under it, not VOLUMETRIC) and `FUN_005bc730` (`SetProjectile` there, still, the SEAL's facing); `c4_start`
(`.PLACE_CHARGE`); four carried; no `Timer1`; `Explosion_Damage` 16 to `Explosion_Radius` 25 (250 units), and
`GetDamage` divides it by 32 outside its cone (`FUN_003c7280` with `0x3fbc7edd`: ahead within `along x tan 1.47261`,
84.4 degrees, to the radius; `claymoreCone`). Its zAnim `claymore` (`.M18_CLAYMORE`, sparks, dust, fire, flying bits).

#### 9.7.1 Its trigger: the Detonator (round 4)

The claymore has **no trigger of its own** -- no tripwire, no proximity, no fuse. It is **remote**: the kit's
**Detonator** (`zweapon.rdr` ID 193 = 0xc1, `ModelName detonator`, `IconTextureName detonator_icon.tif`,
`MaxFireMode` 1, no ammo), fired with the fire button (R1).

- **No proximity.** `ProximityDistance` (0x3fcd70) is read by the weapon loader into the ammo's `+0x3c` as its square
  (`FUN_003d4440`, getter `FUN_003d4430`); only `PMN Ammo` carries it (1, i.e. 10 units). The proximity list 0x4b5238
  that the actor tick `FUN_00543930` walks (decomp 410280-410310: an actor within the distance sets `+0xc4` through
  `FUN_003c5730`) gets only type 0x9e (the PMN, `FUN_005bc730` at decomp 474105).
- **No fuse.** `FUN_005bc730` sets the placed charge's `+0xc5` (`FUN_003c51c0`) to `type == 0x99` and `+0xc6`
  (`FUN_003c51a0`) to "has a proximity"; the placed-explosive tick (0x3c5310, decomp 316893-316900) counts `Timer1`
  down and sets `+0xc4` (go off) only when both are clear. The claymore's `Timer1` is 9999999 anyway.
- **The kit.** `FUN_005c74e0` (decomp 480165-480200) appends the Detonator (`FUN_005bdfb0(..., 0xc1)`) to a kit that
  carries a claymore. `FUN_005bdc30` (decomp 474637) makes it selectable only while `FUN_003cc1f0(0x4b5220, owner)`
  -- the SEAL's charges down -- is not 0.
- **Placing** (the fire handler `FUN_005be9a0`, type -0x67 = 0x99, decomp 475306-475337): with 4 or more of the SEAL's
  charges down (`FUN_003cc1f0(...) < 4`) it shows `Unable To Deploy: Max Equipment Items Placed (4)` (0x65f880) with a
  2 s hold (`+0x8` = 2.0); while moving faster than `DAT_003dfe10 x 0.32` (3.2 units/s; `+0xf88`) it does nothing; else
  `FUN_0057d540(actor, DAT_003deb48)` -- the action `Place claymore` (0x661628, resolved at decomp 495216; the pistol's
  `Pistol place claymore` is 0x661640) -- and the timer `+0x87c` = 0x3fa66666 = **1.3 s**. When it runs out (decomp
  476883-477015) `FUN_005c2430` takes the right hand's node (`+0x300`, the one the throw releases from) and the grid
  column's surfaces under it (the highest at or below the hand), and if that ground is above the feet (`+0x404`) less
  `DAT_003dfe10` (10), `FUN_005bc730` sets the charge there with the SEAL's orientation (`+0x50`), counts one off the
  slot, and **selects the Detonator** (`FUN_005c8a20(param_1, 0xc1)`, decomp 474129).
- **Firing the Detonator** (type -0x3f, decomp 475477): `CZKit_DetonateRemoteExplosives` (0x5c0130) walks the placed
  list 0x4b5220 and, for each charge of this SEAL's (`+0xac` = the actor's id) with `+0xc5` up (a claymore) within
  **500 units** of the SEAL (`FUN_003c71d0(0x43fa0000, charge, actor + 0x1c)`), sets `+0xc4` (`FUN_003c5730`): the
  next tick detonates it (`FUN_003c8740`). Then `FUN_005c8a20(param_1, 0x99)` selects the claymore slot again.
- **The clip**: `motion.rdr`'s `seal_place_claymore` -- 55 keys (`MOTION_P.ZAR`), `playback` 2.7, `NoInterrupt` 0.9,
  `NoFire` -- so 2.60 s in all (`playback ((n - 1) / n)^2`), the charge down at 1.3 s (phase 0.49).

`DAT_003dfe10` is not a constant: the world root's load (decomp 217163-217170) sets it to `1 / <key 0x3f6c70>`; its
static 10 is what every MP map gives (the viewer's units are the game's).

**The viewer** (`CLAYMORE_RULES`, `PLACE_CLAYMORE_ANIM` in `projectile.ts`; `grenade.ts`): R2's inventory takes the
claymore up (the number keys reach only the kit's first two equipment slots, §9.1); the trigger starts the placing --
`throwStart` with `PLACE_CLAYMORE_ANIM`, so the page's throw pose layer plays `seal_place_claymore` on the body -- and 1.3 s in the charge goes down under the posed right hand (the
hull cast from the hand to the feet less 10; none there, nothing is placed) and the Detonator comes up (its model on
the held node, its HUDW icon); the trigger with the Detonator sets off the SEAL's claymores within 500 units and puts
the claymore back up (the rifle when none is left -- the game selects the empty slot [reading]). Four down at most:
the fifth is refused with the game's message (the `refuse` event; the page toasts it [placeholder: the game's message
line]); not while moving. R2's inventory offers the Detonator while a claymore is down. `detonateCharges()` (the
hook) is the Detonator's fire.

The C4 (ID 151, `Timer1` 6, `Explosion_Radius` 5, `IgnoreExplosionDI`) is in no MP SEAL kit: not in the viewer.

### 9.8 The page's API

- **Input**: the fire trigger (left button captured, the touch fire button, R1) holds and throws while a grenade is
  up. R1's analog value is not read (a browser pad's R1 is on or off): the pressure is 1 while held.
- **Events** (`GrenadeThrower.on`): `equip(equipped, item)` -- the rifle stowed while true (`Play.setRifleStowed`);
  `throwStart({ anim, power, releaseIn })` -- the throw clip on the body (`./throwPose`, a pose layer the page adds
  with `Play.addPoseLayer`);
  `place({ item, pos, yaw, fireAnim })` -- the claymore down (audio `c4_start`: `.PLACE_CHARGE`);
  `refuse({ item, text, seconds })` -- the claymore's `Max Equipment Items Placed (4)` (the page toasts it);
  `detonate({ count, from })` -- the Detonator fired;
  `throw(info)` -- audio `.THROW_OBJECT`; `bounce({ material, pos, speed, sound, anim })` -- audio
  `grenade_hit_<material>` when `sound`; `explode({ pos, radius, anim, material, damageToPlayer, distanceToPlayer })`
  -- audio `.GREN_MED`, and the look workstream's shake by distance (a marked `MERGE(look)` call in `main.ts`).
- **Hook**: `grenade()` (the slot, `held` -- what is in the hand, `'Detonator'` included -- `placed`, `placing`,
  `message`, phase, power, left, the grenades in the air, the last throw, bounces, explosions,
  the M67's numbers, `arc` -- the held throw's yellow arc, §11), `throwGrenade(holdSeconds = 1, immediate = true)` (`immediate` false: the clip plays and the
  hand lets go at its release), `equipGrenade(on?)`, `selectItem(item)` (`'rifle'`, a throwable, `'Detonator'`),
  `detonateCharges()` (the Detonator's fire), `throwClip()`, `grenadeTrail(on)` (a debug
  line along each flight), `resetGrenades()`.
- **Asks**: the peek state, for the lean tosses (the table and clips are in; the walk has no lean yet); the particle
  command 0x27's layout, to replace `EXPLOSION_READING`; `SetModelOrientation` (0x3cabe0) for the grenade's spin in
  flight (`SPIN_PLACEHOLDER` 14 rad/s); the inventory menu's own picture.

### 9.9 The bounce materials on all 22 maps (round 4)

`tools/grenade-materials.ts` runs every `RUN/MP*.ZDB`: each material byte of the hull (`worldCollision`) resolved as
`gridCast` does, the zAnim names built from it, whether the map's `CZANIM.ZAR` holds them, the sounds those play and
whether the map's banks hold them. The game builds the names exactly so: the weapon loader (decomp 316340-316355)
formats `"%s_%s"` (0x3fc540) of `HitAnimName` and each material's name (`FUN_002de440`, which would follow a
`WEAPONANIM` redirect -- `materials.rdr` has none) and looks it up in the zAnim registry (0x414bb0); the bounce plays
the one for the hit's material (`FUN_003d22e0`), none when the lookup failed. The fixture maps (MP2, MP6, MP72) are
tested: every hull byte in the table, byte 0 their `DefaultMaterial`, every `grenade_hit_*` of the archive a name the
code builds (but `grenade_hit_grating`, which no material names).

What it found:

- **The strings match.** Every material the hulls use resolves (no byte past the table), and `grenade_hit_<material>`
  / `frag_grenade_<material>` are the archive's names wherever the archive has them.
- **The silent bounces are the game's own data**, not a name mismatch:
  - **metal**: `grenade_hit_metal_thick` / `_metal_grate` play `.GREN_METAL`, which MP2 (Frostfire, `DefaultMaterial`
    METAL_THICK: 2 293 of its polygons), MP5-MP12, MP62, MP73 and MP83 do not have in their banks (`MP2_am.bnk`
    has `.GREN_TIN` and `.GREN_STONE` only). The maps whose banks have it (MP1, MP51-53, MP61, MP71-72, MP81-82)
    sound it.
  - **asphalt**: `grenade_hit_asphalt` names `.GREN_ASPHALT` with command 45 (0x2d), not the play-sound command 30 the
    audio's `callbackSounds` reads -- and no bank of `BNKSTORE.ZAR`'s 115 holds `.GREN_ASPHALT`. Silent in the game.
  - likewise `.GREN_DIRT`, `.GREN_SAND`, `.GREN_GRASS`, `.GREN_PLASTER`, `.BUL_FABRIC`, `.GREN_LEAVES`, `.GREN_SNOW`
    are missing from some maps' banks (the tool lists each).
- **No anim at all** for ACTION, INVISIBLE_DI (PENETRATION 1: never hit), UNDERWATER (LIQUID: passed through), GLASS,
  GLASS_THICK, GLASS_MEDIUM, GLASS_OPAQUE, METAL_RAILING, METAL_GRATE_THIN, CHAINLINK_FENCE, MUD, SNOWY_TREE, GASTANK: the game
  looks up `grenade_hit_glass` etc., finds none, and plays nothing; so does the viewer.
- **MP11**'s world root says `DefaultMaterial none` and **MP64**'s `stone` (lower case). The table's keys are `materials.rdr`'s names as
  written and the lookup is a byte compare (`FUN_002de9e0` -> `FUN_002ded30` -> `FUN_002dee30` -> `FUN_00195768`,
  memcmp), so the game finds neither, leaves slot 0 UNKNOWN (`FUN_002ddc30(0)`), and byte-0 polygons there (69 and 80)
  bounce as UNKNOWN (ELASTICITY_COEFF 0.3) with no anim. `surfaceMaterial` does the same [reading: `FUN_002396f0`, the string's constructor, was
  not read for a case fold].

## 10. The placeholders and readings, by name

| name | value | stands for |
|---|---|---|
| `HAND_PLACEHOLDER` | (3.5, 12.5, -4) | the hold, only without a posed body |
| release point | `GetThrowAnim`'s table | the posed hand, only without a posed body |
| `L2_SLOT_PLACEHOLDER` | the M67 | the slot the player assigns to L2 (default the sidearm) |
| R2 | one press a step | the inventory menu |
| the throw clip's blend out | 0.4 s | the play after a throw |
| `SMOKE_PLACEHOLDER` / `SMOKE_ALWAYS_PLACEHOLDER` | §9.6 | the effects' `large_smoke` as a screen |
| the white-out's scale | 60 = full white | the `blinded` command's strength |
| `PEEK_THROW` | 0.5 | the lean clip test in `GetThrowAnim` |
| the Detonator after the last claymore | the rifle | the game selects the empty claymore slot |
| the refusal's message | the page's toast | the game's message line |
| `FLIGHT_TICK` | 1/60 | the projectile runs on the frame's dt |
| `SPIN_PLACEHOLDER` | 14 rad/s | `SetModelOrientation` |
| `EXPLOSION_READING` | §7.2 | the particle commands |
| the flash glow | a fifth of 100 -> 190 | the light |
| the scorch | at rest only, the rest material's size | the column under any blast, its surface's material (§7.3) |
| hull surfaces | bit 18 skipped (`isShotSurface`) | the projectile query's class |
| `ARC_DEPTH_TEST_PLACEHOLDER` | true | the translucent line list's (`FUN_003373b0`) Z test (§11) |

## 11. The yellow arc (round 5)

The owner's request: while a grenade is held, a yellow arc shows where it will go. It is the player controller's own
draw, not a debug aid, and it is the throw's parabola, not a trace.

**Who draws it.** `FUN_005970b0` is a slot of `CSealCtrl`'s vtable (the pointer at 0x6694ec, beside the flash
reaction's 0x669500; also at 0x40630c and 0x669a2c), the per-frame draw of the player's controller. Its gate
`DAT_003df1b0` is **1 in `.data`**; `FUN_00598840` writes it, cleared when a scripted camera takes the player's
control (decomp 78454) and set back after (78609, `FUN_005cf800`) -- the same flag gates `FUN_00596f10` beside it. The
draw proper is `FUN_00598860`, the SOCOM 1 demo's `ai::DrawFunc<CDynGrenade>(LINE_TYPE, float, float, uint,
CDynGrenade)` (research 44's matches); its lines go through `FUN_005fff40` (the running point `DAT_0066bac8`, the colour
`DAT_0066bae0`, the alpha `DAT_00650d48`) to `FUN_0033b5f0`, the renderer's line (clipped to the view by
`FUN_0035f9c0`; an alpha under 0.992 goes to the translucent line list `FUN_003373b0` at 0x488df8, else
`FUN_00360030`'s packet: `PRIM` 0x49 -- a Gouraud line, blended, no fog -- and `TEST_1` 0x5000c, the Z test on).

**When.** Every frame, if all hold (the instructions 0x5970d4-0x597130, 0x597424):

- `DAT_003df1b0` (the player has control) and `DAT_006505f0` (the segment count, 100) are not 0;
- the controller's `+0x170` **bit 6 is set and bit 7 is clear**. Bit 6 is set in the player update (`FUN_00594cf0`,
  decomp 453627) on the fire button's press (the fire state 2) when the item is a hand grenade (category `'y'` = 0x79,
  §9.2) with one left (`FUN_005bdb00`); bit 7 is set at the release (decomp 453534, where the pressure falls under
  0.15 of the power and `FUN_005dfe30(body, 1)` fires); a weapon switch clears bit 6 (decomp 473853, 478914, 481592).
  So **the arc shows from the press to the let-go** -- through the whole power build-up, and gone as the throw clip
  starts, before the hand opens. The claymore (0x97) and the Detonator never show it; there is no cooking (§6).
- the view mode (`body+0x200`, research 83 §4) is **under 4** (`FUN_005b90f0`: not 4; `FUN_005b9990`: not above 4):
  third person and first person, not the 9x view nor a scope.

**What.** The throw the release would make now, worked out as `CZKit_TickExplosives` does (§4, instruction for
instruction: `GetThrowAnim` at 0x597178, `ComputeMaxVel` 0x597194, the aim's `asinf` clamped and `ComputeElevOfs`,
`lerp(0.05 max, max, power)`, `ComputeTimeToImpact`, the aimed correction under `DAT_006505c8`), from the controller's
power `+0x11c` as it is this frame -- **except the point**: `GetThrowAnim`'s table point (§3) through the body node's
matrix, where the release takes the hand bone's (2, 0, 0). Then (0x59732c-0x5974b0):

- `t_fall` = the later root of `-49 t^2 + vy t + h = 0` (`FUN_0050de20` with `0xc2440000`, `FUN_00575c50`), with
  `vy` the world velocity's y (sp+0x70) and `h` the table point's height: the time to fall to the feet's level.
- The impact point `p + v t_fall + (0, -49 t_fall^2, 0)` is worked out (sp+0xb0) and **never read**: no marker.
- `FUN_00598860(-1.0, 2 t_fall, 0, 100, {p, v})`: the curve `p + v t + (0, -49 t^2, 0)` from **t = -1 s** (the
  `lui 0xbf80` at 0x597498) to **`DAT_00650608` (2) x t_fall**, in `DAT_006505f0` = **100** steps. It is the analytic
  parabola: **no hull query, no bounce, no stop at the first collision**; it runs on under the ground to twice the
  fall, and starts a second back down the curve, behind and below the SEAL -- the Z test hides what is underground.
- The step is a float added up while under 1 (`add.s` 0x598a9c, `c.lt.s` 0x598aac): 100 steps of 0.01 reach
  0.99999934, and a closing segment ends on `t1` -- 101 segments. Each segment takes the alpha of its far end,
  `FUN_006000a0(f)` = `0.1 f + 0.75 (1 - f)` (`FUN_006000f0(DAT_006505f8 0.75, DAT_00650600 0.1)`), clamped to 0..1:
  **0.75 at the start fading to 0.1 at the end**.
- **The colour** (0x59742c-0x59747c): **(0.78, 0.78, 0)** -- `0x3f47ae14` twice and 0: the yellow -- or **(1, 1,
  0.8)** when the view mode is 3, the night vision (`FUN_005c80f0`). The colour is pushed (`FUN_00600190`) and popped
  (`FUN_00600150`) around the draw.

**The viewer** (`@s2u/scene` `throwArc.ts`: `THROW_ARC`, `throwArcTime`, `arcPoint`, `throwArc`; `viewer/src/grenade.ts`
`drawArc`): the same gate (holding, a thrown throwable with one left, `GrenadeSource.viewState` -- `./zoom`'s state --
under 4, pale in 3), the same launch as the release's through one function (`launchOf`, which `letGo` now uses too)
with the table point, and the strip as a `LineSegments` of 101 segments with per-vertex RGBA, blended, depth-tested,
unfogged, one pixel wide as the GS draws a line. The hook's `grenade().arc` gives its colour, segments, launch and ends.

**Does the toss follow it?** `test/throwArc.test.ts` flies `stepGrenade` from the arc's launch over an empty hull: every
frame's x and z are the arc's to 1e-6, and y sits exactly `g t dt / 2` under it (the flight is symplectic Euler, the
arc the closed form -- 0.8 units a second into the flight at 60 Hz, as in the game); the drawn strip is within 1.5
units of every frame to the fall. Without a posed body the throw that follows the let-go leaves from the arc's point at
its velocity (`test/grenade.test.ts`). With the posed body the release is the hand bone's, as in the game, so the toss
starts a few units off the arc's start (about 23 over the feet at the release frame against the table's 19.35, §8) --
the game's own mismatch, kept.

**Not found / not traced**: no console frame of the arc is in `scripts/parity/refs/` or `logs/parity/` (no grenade
frame at all); reCOM has no `CDynGrenade` or arc code. The translucent line list's own Z test (`FUN_003373b0`'s
renderer) is taken from the opaque path's (`ARC_DEPTH_TEST_PLACEHOLDER`). The line is one pixel of the PS2's 512x448
frame, which reads thinner on a large canvas; WebGL lines are one pixel wide, so the viewer's is thinner still at
high resolution. `FUN_005c9b30`, called first in the draw, was not read (it does not touch the arc's inputs).
