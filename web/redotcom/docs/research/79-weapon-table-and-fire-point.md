# 79 — The weapon table, the M4A1 SD's model, the fire point and the recoil: what the bodies on hand show (2026-09-28)

Web sprint 2, task W2.4 and the first half of W2.5 (spec `../specs/2026-09-28-web-sprint-2-the-player-design.md`
§4, rulings W2.R2 and W2.R4). The owner's handoff of 2026-09-28 18:30Z (the plan's Log) supplied the recompiler's
bodies of `GetPutativeFirePointW` (0x57fa70), `CTFireWeapon_Parse` (0x5dc800) and `CZSealBody_Tick_0` (0x57a330),
and `RUN/READERC.ZAR`. The bodies are reference only: cited here as `decomp <name>_<address>:line`, never copied (the
fire point's as `decomp CZSealBody_GetPutativeFirePointW` 0x57fa70, with a space: joined, the name reads to the leak
check as a key); a bare `:n` in §3 is a line of that file.
The disc bytes are the owner's extraction under `web/redotcom/public/maps/RUN`; nothing of them is in the tree beyond the
short hex excerpts quoted. No game run.

## 0. The answers

- **The weapon table is not on hand, and `CTFireWeapon_Parse` is not its reader** (§1). `Parse__12CTFireWeaponFP5_zrdr`
  is one of the AI script's task parsers (`CTMove`, `CTLookAt`, `CTFireMode` ... beside it in the name table); its body
  reads one argument into a byte. No file on hand -- `READERC.ZAR`, `MOTION_P.ZAR`, the 22 map archives -- carries a
  weapon record. Step 1 of the task stopped there, with the evidence below; nothing reads a weapon table.
- **The weapon models are the props' form with one twist** (§2). `WEAP_GEO`/`WEAP_MDL` are a `models` graph over
  chunked chains, as `MP*_GEO`/`MP*_MDL` are, and the 59 weapons decode with no diagnostic on all 22 maps (212
  chunks, 19,961 triangles each; the tests pin MP2, MP6 and MP72). The twist: their packets are drawn by command
  `0x70`, whose positions are `ITOF15` times `TOP+3.w`, not the world's `ITOF4` plus `TOP+3.xyz` -- every visual
  node of every weapon lands inside its own bbox that way (102 of 102), none the other. The M4A1 SD (`m4Acarbine_sd`) is drawn from `m4_high`:
  688 vertices, 395 triangles, `m4.tif` and `mark03.tif`; its nodes are `firepoint` (the muzzle, 7.785 along the
  barrel, 0.834 up), `firepoint_shell`, `aimpoint` (the sight, 8.0 behind the muzzle) and `Gun_box`.
- **The fire point is ported** (§3): with a1 true the body picks one of ten constant offsets by the stance code of
  a list at `+0x1c0`, the actor state, the velocity and `m_item`, and carries it through the actor node's matrix;
  with a1 false it adds a cached point at `+0x14b0` to the position. The ten offsets are `.data` the handoff does
  not carry, so the viewer fills them with a named placeholder built from the M4A1 SD's own nodes.
- **The shot** (§4): the left button (the mouse captured) or the hook's `fire()`; a ray from the fire point to
  the point under the crosshair, through the grid; a tracer, a marker, `stats().shots` and `lastShot`.
- **The recoil is not found** in the bodies on hand (§5). `RECOIL_PLACEHOLDER` is no kick. The leads: the body's
  recoil is five motion clips (`seal_recoil` ...); `dynamics.rdr` carries a `CAMERA_WIGGLE`; reCOM names the
  weapon table's kick fields; the demo's `CZSealBody::Recoil` is one of its largest functions, not a small helper.

## 1. The weapon table (step 1: stopped)

### 1.1 What `CTFireWeapon_Parse` is

- **Its name.** `recomp/socom2_names.csv` row 0x005dc800: `CTFireWeapon_Parse`, mangled `Parse__12CTFireWeaponFP5_zrdr`
  (string-set pass, 0.80). The `CT*` classes with a `Parse(_zrdr*)` in the same table are `CTTeam` 0x5cec40,
  `CTRegion`, `CTRange`, `CTStopAll`, `CTStance`, `CTPursue`, `CTMove`, `CTMacro`, `CTLookAt`, `CTInView`, `CTInState`,
  `CTFireWeapon` 0x5dc800, `CTFireMode` 0x5dcc00, `CTEvent` and `CTComm` 0x5de250: by their names the verbs of
  the AI's scripted tasks (move, look at, pursue, take a stance, fire), each parsed out of a compiled `.rdr`
  (`_zrdr`). A weapon *table* would not be one class per verb.
- **Its body** (`decomp CTFireWeapon_Parse_0x5dc800`, 0x5dc800-0x5dc89c, 39 instructions) builds one task node:
  `func_34EAE0(0x2c, 1, 0, 0)` allocates 44 bytes (:32-62); the half at `+2` becomes `(old & 0xffff0003) | 0xb0`
  and the half at `+0` the word at 0x66b7e0 (:65-111; by its shape a type tag); `func_32EE10(zrdr, 0x65f9d0)` reads the one
  argument after a key whose string is in `.rodata` (:77-116), `func_3D19E0` turns it into a value whose low byte
  is stored as the word at `+8` (:119-142); bit 0 of the byte at `+0xc` is cleared (:143-160); the node is returned.
- **Every field it parses:** one -- a byte-valued argument at `+8`. Its key and what the byte means (a weapon slot?
  a boolean?) are in the ELF's data and the two callees' bodies, none of which is on hand. So there is no
  "`readWeaponTable` per `CTFireWeapon_Parse`" to write: the body describes a one-argument AI command.

### 1.2 Where a weapon table is not

- **`READERC.ZAR`** (1,026,848 B) is 56 compiled scripts: `ai_moves ai_turrets ai_vehicles animset bmode character
  cheats controller damanim decals dynamics fonts global_valves hud materials messages missionlist motion
  motion_range mpeg_subtitles non_mission orders small_messages splash subtitles`, then 31 locale tables (`AlbLOC`
  ... `UIXLOC`). What it says about weapons: `character.rdr`'s `default_weapons` loadouts name weapons by their
  display name (`wep_name "M4A1 SD"` 32 times, with an optional `ammo_count` and `mag_count`), and its
  `body_items` name the attachment parts `rifle`, `pistol`, `grenade`, `weapon`; `animset.rdr` and `motion.rdr` the
  recoil clips (§5); `controller.rdr` binds `R1` to `Fire`; `dynamics.rdr` is the seal tuning table (§5). No rate
  of fire, spread, damage, range or kick for any weapon.
- **The byte search.** The SOCOM 1 weapon archive's own keys (reCOM `zWeapon/zwep_global.cpp:27-92`:
  `WEAPON_ZAR_VERSION`, `Ammunition`, `AMMO:NumEntries`, `ImpactDamage`, `ArmorPierce`, `ExplosionRadius`) and the
  weapon-stance field stems (`ReticuleKnock`, `KickRate`, `FireRifleKick`, `MuzzleVel`) appear nowhere in the 22
  `MP*.ZDB`, `MOTION_P.ZAR` or `READERC.ZAR` (one hit: the locale string `RPG AMMUNITION`). The weapon fixture test
  pins this for `READERC.ZAR`.
- **What SOCOM 1 had.** reCOM transcribes the demo's weapon record: `CZWeapon` (`zWeapon/zweapon.h:506-556`: name,
  description, texture and icon names, the associated gear, the model name, the decal set, `m_maxfiremode`,
  `m_ammocap`, `m_nummags`, `m_soundradius`, `m_encumb`, `m_maxrange`, `m_effectiverange`, `m_muzzlevel`,
  `m_impactradius`, `m_firewait`, `m_reloadtime`, `m_reloadAfterShot`, `AI_PARAMS` min and max range, the
  `EQUIP_ITEM` id, the fire and hit animation names); `CZWeaponStance` (`:307-355`: `m_reticuleKnock`,
  `m_reticuleKnockReturn`, `m_reticuleKnockMax`, the sniper drift terms, `m_targetDilateUponFire`,
  `m_targetDilateUponMovement`, `m_targetConstrict`, `m_targetMin`, `m_targetMax`, `m_fireRifleKickRate`,
  `m_fireRifleKickReturnRate`, `m_fireRifleKickBaseDist`, `m_fireRifleKickRandomDist`, `m_wiggleReport`,
  `m_knockCount`, `m_knockEntryStrength`); `CZFTSWeapon` (`:559-586`: three zoom levels, rumble, accuracy burst
  counts and scalars, normalised range, slot cost); `CZAmmo` (`:266-303`). The ids: `M4A1_CARBINE_SILENCED` is
  `EQUIP_ITEM` 62 in reCOM's enum (`:72`, the enum at `:31`). These are SOCOM 1's names; which of them SOCOM II
  keeps is unknown.
- **So the table is either another disc file or compiled in.** The disc has more than the two files the owner
  sent -- `RUN/UI/READERC.ZAR` is a different archive of 111 keys (research 11 §1) -- and `ZWepReader::Read` in
  SOCOM 1 takes a `CZAR&`. The ask (§6): `grep -rl WEAPON_ZAR_VERSION game/disc` (and `ReticuleKnock`,
  `ImpactDamage`); if nothing answers, the table is in the ELF and the fields are read from `CZWeaponList`'s
  constructor. **The M4A1 SD's record, its values: not available.** What is on hand of it: its display name
  `M4A1 SD` (`UIMnLOC.rdr` `_120_M4A1Sd_MSG`), the loadouts above, the map's `Enable_M4A1_SD` switch
  (`mission.rdr`), and its model (§2). The name-to-model link (`"M4A1 SD"` to `m4Acarbine_sd`) is itself the table's
  (`m_name` / `m_modelname`).

## 2. The weapon model

### 2.1 The form

- **The props' form, not the characters'.** `WEAP_GEO.ZED` is `models` with 59 `CNode` trees (2,094 keys on MP2),
  `WEAP_MDL.ZED` one chain buffer per model with `N%03d_%03d` children (272 keys) -- research 72 §2's shape, walked
  by research 72 §3's chain walker and `@s2u/scene`'s model library unchanged. No weapon instances another, so the
  chunk keys are `hookupVisuals`' fallback naming, and all 59 key sets are exactly `expectedChunks`' prediction.
- **The position form.** A weapon packet's `TOP+3` is `(0, 0, 0, w)` -- the M4A1 SD's first:
  `00000000 00000000 00000000 40f1e59e`, `w` = 7.55928 -- and its int16 position lanes run to 32767 (its first
  vertex: `32767 3636 -1117`). That is command `0x70`, "`0x68` with two instructions changed: `ITOF15` instead of
  `ITOF4`, and `MULw.xyz` by `TOP+3.w` instead of `ADD.xyz`" (research 15 §0 item 1; SEMANTICS §3 `TOP+3`). The
  first vertex: 32767 / 32768 x 7.55928 = 7.559, `m4_high`'s bbox maximum in x to the third decimal. Over the whole
  library, every visual node's decoded extent lies inside its own `nparams` bbox read this way (102 of 102 on MP2,
  MP6 and MP72) and none read the world's way. `@s2u/mesh`'s `PositionForm` carries the choice
  (`interpretChainPartsAs(chain, 'scale')`); the world and the props keep `'bias'`, bit for bit. `FLIB_MDL` (the
  fittings, 10 of 10 nodes on MP2) and `TURR_MDL` (the turrets, 35 of 35 on MP72) carry the same form; the MP2 and
  MP72 graphs place neither, so no map the viewer draws changes.
- **The same models, repacked, on five maps.** The library is rebuilt per map (the four `WEAP_*` members' bytes
  differ on every map); decoded, all 22 hold 59 weapons in 212 chunks, 19,961 triangles, with no diagnostic, and 17
  agree with MP2 vertex for vertex. MP6 and MP61 differ from it in 24 and 26 weapons (the M4A1 SD among them: 1,067
  vertices over both LODs against 1,107) and MP8, MP52 and MP71 in 11 -- the vertex packing, not the triangles: 395
  and 258 for the M4A1 SD's two LODs on every map.

### 2.2 The M4A1 SD (`m4Acarbine_sd`, W2.R4) and the M9

The weapon's frame: x along the barrel (the muzzle ahead), y up, z to its right; the origin is the grip.

| node | visuals | what | on MP2 |
|---|---|---|---|
| `m4_high` | 2 (`N000_000`, `N000_001`) | the high LOD, drawn | 11 packets, 688 vertices, 395 triangles, `m4.tif` + `mark03.tif`; bbox (-3.471, -1.219, -0.376)-(7.559, 1.594, 0.376) |
| `m4_low` | 2 (`N001_000`, `N001_001`) | the low LOD | 7 packets, 419 vertices, 258 triangles |
| `firepoint` | 0 | the muzzle | (7.7854, 0.8338, 0) (`nparams` row 3: `b7 21 f9 40 f9 70 55 3f 00 00 80 a3`) |
| `firepoint_shell` | 0 | the ejection port | (0.9817, 0.0703, 0.0178) |
| `aimpoint` | 0 | the sight | (-0.2146, 0.8338, 0): on the bore line, 8.0 behind the muzzle |
| `Gun_box` | 0 | the pickup box | the origin; six `di` polygons |

The node flags set `m_dynamic_light` on the LOD nodes, so the viewer lights the weapon with the map's rig. The M9
(`baretta_m9`, the sidearm) draws from `sig226_high`: 4 packets, 133 vertices, 86 triangles, `baretta_m9.tif` +
`mark03.tif`; `firepoint` (1.3959, 0.5831, 0), `aimpoint` (-5.6041, 0.5831, 0). Across the 59, the node names are
`firepoint` on 43 (the RPG-7 spells it `firepont`), `aimpoint` and `Gun_box` on 44, `firepoint_shell` on 36, and
`scope`/`thermal_scope` on four sniper rifles.

## 3. The fire point: `GetPutativeFirePointW` (0x57fa70)

`GetPutativeFirePointW__10CZSealBodyFbbR6CPnt3D(this, bool a1, bool a2, CPnt3D& out)`, 0x57fa70-0x57fce0 (624
bytes). Ported as `@s2u/scene`'s `firePoint(state, offsets)`, `fireSlot` and `stanceCode`, with the body's line
numbers in the comments.

### 3.1 The two bools

- **a1** (`decomp CZSealBody_GetPutativeFirePointW` 0x57fa70 `:51`, `beqz $a1`): true takes the stance table through
  the actor's node matrix; false takes the cached point at `+0x14b0..+0x14b8` (the zero point when the word at
  `+0x14bc` is 0, :664-733) and adds the actor's position at `+0x1c` with `FUN_00309240(out, this+0x1c, out)`
  (:740-752). `FUN_00309240` is the third of the `CPnt3D` helpers at 0x309180 (a scalar multiply, research 22 §3.1)
  and 0x309200 (a difference, research 25 §2's `key[idx+1] - key[idx]`); research 23 §1.2 reads it as an add.
- **a2** (kept in `$s1`, :48): for stance codes 0, 1 and 2 it picks the second row of three offsets (:457-617). Its
  meaning is not in the body. The six fit a stand / crouch / prone row twice over, and `MOTION_P.ZAR` has both
  `seal_fp_*` and `seal_pfp_*` (rifle and pistol first-person) clips -- a2 could be either "pistol" or "first
  person"; the callers, which would say, are not on hand.

### 3.2 The inputs

| input | where | read at | source of the name |
|---|---|---|---|
| the stance list | `*(+0x1c0)`, entries 0..`*(+0x1c8)`, each entry's byte at `+0x2b` | :67-153 | named by offset |
| the actor state | `(short) +0x174` | :206 | research 21 (the state the control guard tests; 1 walking and standing, research 25) |
| the byte at `+0x375` | `(signed char)` | :222 | named by offset |
| `m_velM` | `+0x2c..+0x34`, the velocity in the actor's frame | :287-355 | research 50 §4a |
| `m_item` | `(unsigned char) +0xf79` | :395 | research 50 §4a |
| `m_node` | `*(+0x28)`, its matrix at `node+0` | :632 | research 50 §4a; research 21 §7.7 and 24 §1.1 for the matrix |
| the position | `+0x1c..+0x24` | :740 | research 50 §4a |
| the cached point | `+0x14b0..+0x14bc` | :664-699 | named by offset |

### 3.3 The branches

1. **The stance code** (:67-153): walk the list from its top entry down; skip entries whose byte is 3; the first
   other byte is the code. An empty list, or one of nothing but 3, gives 0.
2. **Code 2** reads 0x65d058 (a2 false) or 0x65d088 (a2 true); **code 1** 0x65d048 or 0x65d078; **any code other
   than 0, 1, 2** the zero point at 0x3f64c0 (:153-201, :512-628).
3. **Code 0 in actor state 3** reads 0x65d0a8 when the byte at `+0x375` is -1, else 0x65d098, a2 aside (:206-276).
4. **Code 0 moving**: `|m_velM|^2 > 400` (20 units a second, `lui 0x43c8`), `z != 0` and `|x / z| < 0.5` (`lui
   0x3f00`, `fabsf` at 0x1b3620) -- faster than 20 and mostly along the actor's z, forwards or backwards -- reads
   0x65d0b8 when `m_item == 1`, else 0x65d0c8, a2 aside (:284-449).
5. **Code 0 otherwise** reads 0x65d038 (a2 false) or 0x65d068 (a2 true) (:456-505).
6. **The point**: `FUN_003085c0(m_node, &constant, out, 1)` (:631-644), `(x, y, z, 1)` through the node's row-vector
   matrix -- research 21 §7.7's bounds transform, whose `vmaddw` adds the translation row -- so the constants are
   offsets in the actor's own frame.

The zero point is read as (0, 0, 0): `Tick_0` resets `m_velM` from the same address (`decomp
CZSealBody_Tick_0_0x57a330:7201-7209`, `:7920-7952`), and :625-628 pass its address where the others pass an
offset's. The ten constants sit 16 bytes apart at 0x65d038-0x65d0c8, which is data; the handoff has none of it.

### 3.4 What the viewer passes (all placeholders but the port)

- **The actor frame** (`viewer/src/shot.ts` `actorMatrix`): the mover's feet as the position, the camera's yaw as the
  facing, local z the facing (the axis the moving test measures along), y up, x = y cross z (the actor's left).
  Which way the game's local z points is W2.1's to confirm from the bind pose.
- **`VIEWER_FIRE_ARGS`**: a1 true, a2 false. **`VIEWER_ACTOR_PLACEHOLDER`**: actor state 1 (research 25's standing
  and walking value), `+0x375` -1, `m_item` 0, an empty stance list (code 0). `m_velM` from the frames' positions.
- **`HOLD_PLACEHOLDER`** (right 1.5, down 2, relief 1): all ten offsets take one value -- the M4A1 SD held with its
  sight point 1 ahead of the eye, 1.5 to its right and 2 under it, the muzzle where the weapon's own nodes then put
  it: (x -1.5, y 13.4, z 9.0) in the actor frame (15.4 - 2 up, W1.R2's eye; 1 + 8.0 ahead).
- **The actor's position** is the drawn eye less 15.4, not the last tick's feet, so the weapon does not shake against
  the view between ticks.

## 4. The shot

- **The ray** (`@s2u/scene`'s `castRay`, beside the probe): the first hull polygon along a segment, walked through
  the grid's cells in the order the segment crosses them (a DDA on the ground plane; a cell off the grid is the
  edge cell it clamps to, as `CGrid` files an object off it), each collision owner tested once and gated by the
  probe's `modelGate`, surface bit 18 skipped as the probe skips it, both faces counting. The nearest hit whatever
  a cell's order. **Not the engine's routine**: `CZProjectile_PostTick` 0x3c9fb0 and
  `CZSealBody_HandleWeaponIntersect` 0x549f30 are named, not decompiled here.
- **The aim**: the eye's ray along the camera's look finds the point under the crosshair (reCOM's `m_aim_point`,
  `zSeal/zseal.h:785`); the shot leaves the fire point toward it, so it lands under the crosshair unless something
  is in the way, and runs to `SHOT_RANGE_PLACEHOLDER` (5,000 units; the table's `m_maxrange` is not on hand) when
  nothing is there. The convergence is the viewer's reading.
- **The input**: the left button once the mouse is captured (the capturing click is the camera's, `camera.ts`),
  in walk mode. The hook: `fire()` fires one shot from the current pose and returns it; `stats().shots` counts the
  shots on the map on screen and `stats().lastShot` is `{ from, to, hit, slot }`.
- **What is drawn**: the tracer from the fire point to the end, a marker at a hit, and the M4A1 SD itself with
  its `firepoint` node on the fire point and its barrel along the aim -- in front of the camera in first person,
  lower right, as a placeholder until W2.1's skeleton puts it in the hand. It is lit once, in its own frame.
- **Measured on Frostfire** from spawn A's stand (the fixture): the first shot, with the grid built, 5-11 ms; a
  shot after it under 1 ms. Facing B level, the shot meets the wall 30 units from the muzzle; 45 degrees down, the
  floor at y 100, 14.9 units from it.

## 5. The recoil (W2.5's first half): not found in the bodies on hand

Where it was looked for, and what each place gave:

- **`decomp CZSealBody_Tick_0_0x57a330`** (0x57a330-0x57b510): its 51 direct callees -- named in the table only
  `GetFractionalRotations` 0x287210, `CZSealBody_HomingTick` 0x5b2d20, `CZSealBody_ApplyLookAnim` 0x5ad5b0,
  `CQuat_MakeZRot`, `CQuat_Mul` and `rand` -- and five indirect calls (two through `vtbl[0x88]`, research 23 §1.2's
  bone getter, three through a pointer in `$v0`). The fields it writes: `m_velM` (from the root motion over `dt`, :7792-7892), `+0x14c0` (the root's last
  position), `+0x44..+0x4c`, `+0x248/+0x24c`, `+0xf68/+0xf6c` (a -99.0 sentinel), `+0xfa8`, `+0x105f` bits, and
  `+0x12e4`, a timer reset to `6 x rand() / 2^31` seconds when it runs out (:8874-8998) beside
  `func_5AD870(this+0x1270, 1)` -- the look/blink cluster at 0x5ad400-0x5ad920 around `ApplyLookAnim`
  (`dynamics.rdr` has `max_blink_rate`). It reads `m_item` only as an argument to `func_58C9E0` (three times), never
  touches `m_weapons` at `+0x1170`, and writes no aim angle: no kick.
- **`GetPutativeFirePointW`**: no recoil term (§3). **`CTFireWeapon_Parse`**: the AI task (§1.1).
- **The name tables**: `Recoil__10CZSealBodyFv` is in neither `recomp/socom2_names.csv` nor the demo symbol table
  (the owner's own search, the handoff's README). Research 50 §4a notes a *reverse twin* of the demo's `Recoil`
  reading demo `+0x280` (the sixth of the 25 body-part pointers), but the twin's r0001 address is not recorded in
  the tree; research 49 §5 lists `CZSealBody::Recoil` among the twelve largest demo functions -- a large routine,
  not the small helper the owner's note guessed.
- **The data on hand**: the body's recoil is a motion -- `animset.rdr` binds `Rifle recoil` to `seal_recoil`,
  `Pistol recoil` to `seal_p_recoil`, and the crouch and prone forms; `motion.rdr` gives `seal_recoil`
  `looped 0`, `playback 1`, `transition_speed_A 0`, `transition_speed_B 0.1`; all five clips are in `MOTION_P.ZAR`
  (W2.2's). `dynamics.rdr` (the tuning table, `CharacterDynamics_Load` 0x59ba80) carries `CAMERA_WIGGLE`
  (`Amplitude 22`, `Duration 0.6`, `Rate 0.1`) -- a camera shake whose trigger is not known -- and the aim's limits
  (`init_aim_pitch -9.167`, `max_aim_pitch 60`, `min_aim_pitch -70`, `max_aim_yaw 85`). reCOM keeps a
  `m_recoilParam` float on the body (`zSeal/zseal.h:576`, zeroed at `seal.cpp:20`) and a `m_do_weapon_recoil` bit
  on the entity (`zEntity/zentity.h:147`).
- **The table's recoil fields** (if SOCOM II keeps SOCOM 1's): `m_reticuleKnock`, `m_reticuleKnockReturn`,
  `m_reticuleKnockMax`, `m_knockCount`, `m_knockEntryStrength` (the reticle's knock), `m_fireRifleKickRate`,
  `m_fireRifleKickReturnRate`, `m_fireRifleKickBaseDist`, `m_fireRifleKickRandomDist` (the kick), `m_wiggleReport`
  (reCOM `zWeapon/zweapon.h:334-354`) -- per `CZWeaponStance`, so per stance.

So the kick stays a placeholder: **`RECOIL_PLACEHOLDER` = 0 degrees of pitch per shot**, wired (the page adds it to
the aim's pitch after a shot) and tested as zero; its return is not wired.

## 6. Asks

1. **The ten offsets**: the 160 bytes at 0x65d038-0x65d0d7 and the 16 at 0x3f64c0 of the r0001 image (ten
   `CPnt3D` and the zero point) -- a `dd` of the ELF's data, or a memory dump's. They replace `HOLD_PLACEHOLDER`.
2. **The callers of `GetPutativeFirePointW`** (the call graph names them): what a1 and a2 are passed, and so what a2
   means.
3. **The weapon table**: `grep -rl WEAPON_ZAR_VERSION game/disc` (then `ReticuleKnock`, `ImpactDamage`); if none,
   `CZWeaponList`'s loader in the ELF. `CTFireWeapon_Parse`'s key string at 0x65f9d0 is a by-product.
4. **`Recoil__10CZSealBodyFv`**: the twin finder's r0001 answer for it (research 50's method), or the body of
   whatever calls `SaveFireMessage` 0x2bbf10 (the fire path's message) -- the kick is likely near.

## 7. The placeholders, by name

| name | value | stands for | until |
|---|---|---|---|
| `HOLD_PLACEHOLDER` | right 1.5, down 2, relief 1 | the ten stance offsets at 0x65d038..; where the weapon is drawn | ask 1; W2.1's hand |
| `VIEWER_FIRE_ARGS` | a1 true, a2 false | the callers' arguments | ask 2 |
| `VIEWER_ACTOR_PLACEHOLDER` | state 1, `+0x375` -1, `m_item` 0, no stance list | the body's fields the mover lacks | W2.1, W2.3a |
| `SHOT_RANGE_PLACEHOLDER` | 5,000 units | `m_maxrange` | ask 3 |
| `RECOIL_PLACEHOLDER` | 0 degrees a shot | the kick | ask 4, W2.5 |
