# 81 — The walk's sounds: the 989snd banks on the disc, how the game names them, and when it plays a step, a round, a jump and a landing (2026-09-28)

The audio workstream of the walk mode (the owner: "would be lovely if we could play walking sounds / gun fire sounds /
jumping and landing sounds"). Read-only on the disc (`game/disc/RUN/`, the owner's extraction, and the owner's ISO) and
on the decomp (`game/analysis/socom2_game.elf.decomp.c`, cited as `decomp:<line>`; the functions by `FUN_` address).
The 989snd arithmetic is the repository's own model of the IRX -- `third_party/ps2recomp/ps2xRuntime/src/lib/
snd989_mixer.cpp`, `socom2_bank.cpp`, `ps2_audio_vag.cpp`, and research/06, 32, 36 -- cross-read with the 989snd
reference in `research/989snd-ziemas` (`iop/types.h`, `iop/playsnd.c`, `iop/loader.c`). Nothing of the disc is in the
tree; the numbers below are counts, offsets and names.

## 0. The answers

- **The containers** (§1). `RUN/SOUNDS/BNKSTORE.ZAR` (67,433,088 B) is a v2 ZAR of 115 `.bnk` members: `HUDUI.bnk`
  and, for every map and mission, `<map>_am.bnk` (ambience and the body: steps, landings, the jump, impacts),
  `<map>_fx.bnk` (the weapons and explosives) and `<map>_vc.bnk` (the voices). `RUN/SOUNDS/VAGSTORE.ZAR`
  (576,593,920 B, 10,942 `.vag`) is the voice-over and radio streams -- nothing the walk plays. `RUN/SOUNDRDR.ZAR`
  holds `sounds.rdr`, the sound script. Both stores write 0 in the ZAR head's data size (+84), which the engine never
  reads: a zero is "the rest of the file" (`@s2u/archive`'s `Zar.parse` now takes it so).
- **Since the first cut** (§5, §6, §7, §9, §10): material byte 0 is the map's `DefaultMaterial`; the zAnim
  callbacks follow their starts; the reload sound starts with the reload; `.BUL_PASSING` is others' rounds within 20;
  no landing grunt, the hurt voice `.SEAL_DAMAGE`; the SPU2 reverb (libsd mode 3) at the mission's indoor/outdoor
  depths; the beds and the emitters; the sounds a map's banks lack, borrowed.
- **The bank format** (§2) is 989snd's `SBlk` version 3 behind a two-chunk `FileAttributes` head, with **names**:
  every sound of every bank carries a 16-byte name (`.STEP_STONE`, `.M4A1_SIL`, `~AK47_1`, `!SMK_CANISTER`) in the
  block's hashed name table. The samples are headerless SPU ADPCM; a tone's centre note encodes the sample's rate.
- **The lookup** (§3). The game names a sound by that string and turns it into a CRC-32 (`FUN_003a2370`, zlib's);
  `sounds.rdr` files each sound's parameters under the same number -- `RANGE (min max)`, `ONESHOT`, `MED`/`FAR` --
  per bank block. `RANGE` is the distance fall-off (`FUN_00342670`): full inside `min`, linear to 0 at `max`.
- **Footsteps are per surface material** (§4). `READERC.ZAR/materials.rdr`'s `SOILS` list gives each material a
  `STEPSOUND`, `STEALTH_STEPSOUND`, `CRAWLSOUND`, `LANDSOUND` and `FALLSOUND`; the table's index **is** the collision
  polygon's `material` byte, counting from 2 (the engine appends `UNKNOWN` and `PARTICLE_SYSTEM` first). A step fires
  on the locomotion clip's phase -- the left foot entering (0, 0.5), the right entering (0.5, 1) -- not on a clip
  callback (`FUN_005a3570`); the sound is the crawl prone, else the step when the stick is past half, else the stealth
  step (`FUN_005a39b0`).
- **The M4A1 SD** (§5): `zweapon.rdr`'s record names `FireSoundClose .M4A1_SIL` and `ReloadSound .M4A1_SIL_RLD`, and
  no medium or far report (the unsuppressed M4A1 has `.M4A1`, `.M4A1_M`, `.M4A1_F`, `.M4A1_RLD`).
- **The jump** (§6) is the `seal_jump` clip's `zanim_callback (name (jump_whoosh) time (0.4))`; the map's `CZANIM.ZAR`
  zAnim `jump_whoosh` plays `.JUMP_WHOOSH`. **The landing** (`FUN_005ac1f0`) plays the material's `LANDSOUND`
  (`.STONE_JUMP` ...) below the heavy fall-damage speed and `.BONE_BRK_1` above it (both at the deadly one).
- **In the viewer** (§8): `@s2u/sound` decodes and renders; the page reads two to three banks by range (1.1-1.4 MB
  of the 67), renders each sound at the game's volume and pan when it starts and plays it through Web Audio.
  Verified by the hook on Frostfire and Desert Glory, and by rendering the sounds to WAV (§11).

## 1. The containers

| Archive | Bytes | Keys | What |
|---|---|---|---|
| `RUN/SOUNDS/BNKSTORE.ZAR` | 67,433,088 | 116 (115 banks) | `HUDUI.bnk`; `M51..M83`, `M99`, `MP1..MP83`, `MP99`, `T2` x `_am`, `_fx`, `_vc` |
| `RUN/SOUNDS/VAGSTORE.ZAR` | 576,593,920 | 10,943 | `C0_0341A.vag`, `CH_0001.vag` ...: voice-overs, streamed (`snd_PlayVAGStreamByLoc`, research/32 §6) |
| `RUN/SOUNDRDR.ZAR` | 1,897,008 | 2 | `sounds.rdr`, 1,896,864 B compiled |

The head is the viewer's ZAR v2 (web/redotcom/docs/research/72, research/36 §1): flags 0, key count at +4, string-table size
+8, its packed address +12, padding +16 (0x800 here), data size +84 (**0** in both stores), version 0x20002 at +96.
A map's banks sit together: Frostfire's `MP2_am.bnk` at 29,667,072 (986,408 B), `MP2_fx.bnk` 30,653,568 (687,344),
`MP2_vc.bnk` 31,340,928 (176,088). The game loads them by disc location (`snd_BankLoadByLoc`, research/40 §9) from
`RUN\SOUNDS\BNKSTORE.ZAR;1` (ELF string 0x3f76a0).

**Which banks a map loads** (`FUN_00344450`, decomp 242785, from the map's load at 152105): `HUDUI`, `SMUS` and
`TCM_ECHO` (strings 0x3f7860-0x3f7870), then `<map>_vc`, `_fx`, `_am`, `_svo`, `_smu` (`%s_vc` ... at 0x3f7880-0x3f78a0),
then `MULTI` and `HOSTAGE` on a multiplayer map or a mission's cast (`BRAVO_SEAL`, `RUSSIAN` ...). The disc holds only
`HUDUI` and the maps' three: the rest fail to load and nothing asks for them in the walk. **`HUDUI.bnk`** (24 sounds:
`.NV_GOGGLES_ON`/`_OFF`, the countdowns, the menus' and keyboard's) is loaded with every map, and it is where the night
vision's sounds are (`DAT_0044ce30/38 = FUN_00344f30(0x65f568/0x65f580)`, decomp 461033; played without a place,
`vtable+0xc`, at decomp 410944/410948 as the view state enters or leaves 3). None of its names is in any map's bank.

## 2. A bank

`FileAttributes` (989snd): `u32 type` 3, `u32 chunks` 2, then `(offset, size)` per chunk -- `MP2_fx.bnk`:
`(0x18, 0x7df8)` the block, `(0x7e10, 0x9fee0)` the VAG data. The block (`SFXBlock2`, `iop/types.h:428-449`;
research/32 §1 with the `NumSounds` offset corrected there):

| Offset | Field | `MP2_FX` | `MP2_AM` |
|---|---|---|---|
| 0x00 | `DataID` `SBlk` | | |
| 0x04 | `Version` | 3 | 3 |
| 0x08 | `Flags` | 0x104 (bit 8 `BLOCK_HAS_NAMES`) | 0x104 |
| 0x0c | `BlockID` | `20EM` | `20AM` |
| 0x16 | `NumSounds` s16 | 187 | 90 |
| 0x18 | `NumGrains` s16 | 1,215 | |
| 0x1a | `NumVAGs` s16 | 58 | |
| 0x1c / 0x20 | `FirstSound` / `FirstGrain` | 0x40 / 0x904 | |
| 0x34 | `GrainData` (the tone pool) | | |
| 0x38 | `BlockNames` | 0x6c44 | |

A sound is 12 bytes (`s8 Vol, s8 VolGroup, s16 Pan, s8 NumGrains, s8 InstanceLimit, u16 Flags, s32 FirstGrain`), a
grain 8 (`u32 type<<24 | arg24`, `s32 Delay` in 240 Hz ticks), a tone 24 at a TONE grain's `arg24` in the pool
(`s8 Priority, Vol, CenterNote, CenterFine, s16 Pan, s8 MapLow, MapHigh, PBLow, PBHigh, u16 ADSR1, ADSR2, Flags,
u32 sample offset`). **The names** (`SFXBlockNames`, `types.h:324-332`): `BlockName[8]` (`MP2_FX`), then
`SFXNameTableOffset` (0x98, from `BlockName`), three tables SOCOM leaves 0, and 32 `s16` hash-bucket starts; an entry
(`SFXName`) is `char Name[16]`, `s16 Index`. `snd_FindSoundByName` (`playsnd.c:595-650`) hashes `abs(n[0] + n[4] +
n[8] + n[12]) % 32` over signed chars and walks the bucket to the first empty name. All 187 of `MP2_FX`'s, 90 of
`MP2_AM`'s, 8 of `MP2_VC`'s and 24 of `HUDUI`'s sounds are named. The first character is a sigil: `.` a one-shot,
`~` a looping bed or a distant variant (`~AK47_1`, `~OCEAN_SWELL_1`), `!` the smoke canister.

**The samples.** Headerless SPU ADPCM (16-byte blocks: `shift | filter << 4`, flags -- bit 2 loop start, bit 0 end,
bit 1 with it repeat -- 28 nibbles), decoded by the repository's proven recurrence (KNOWN §1, research/32 §3). **The
rate** is not stored: the tone's centre note says it. The SPU plays pitch 0x1000 at 48 kHz, the handler plays note
60, and `sceSdNote2Pitch` (research/32 §3; the centre fine is added) gives `.STEP_STONE`'s tone (centre -80, fine
124: a negative centre is "not a PS1 note") exactly 16,000 Hz; `.BONE_BRK_1` (-74, 66) 22,050; `.M4A1_SIL_RLD`
(-62, 66) 44,100. **Loops**: the step, shot and landing samples end (bit 0 without bit 1); the beds (`~OUTDOOR_AMB`)
loop.

**What a sound is.** `.STEP_STONE` (Vol 107, group 3): `RAND_PB` (a random pitch bend of +-0x46/100 of the tone's
PB range), `RAND_PLAY 10,1` (one of the next ten grains, never the previous pick), ten TONE grains -- ten takes of a
footfall, one voice each. `.M4A1_SIL` (Vol 80): two tones at once, a crack (vol 120) and a body (vol 80).
`.STONE_JUMP`: `RAND_PB` and one tone. `.JUMP_WHOOSH` (Vol 28): one tone.

## 3. How a sound is named and looked up

- **By name.** The game's strings name sounds exactly as the banks do: `.RIFLE_BUTT` (0x65f538), `.BONE_BRK_1`
  (0x65f548), `~LADDER_SLIDE`, `.NV_GOGGLES_ON`, `.GUNTOHOLSTER`, `.FALL_GROUND` (0x65e710); the data files likewise
  (`materials.rdr`, `zweapon.rdr`, the zAnim name tables). `FUN_00344f30` (decomp 243197) hashes the name with
  `FUN_003a2370` (decomp: a table CRC over the bytes, the table built from poly 0x04C11DB7 reflected, init and final
  `~0` -- zlib's CRC-32) and asks `FUN_00344bf0` for the sound object of that hash among the loaded banks' entries.
- **`sounds.rdr`** (`FUN_003435c0`, decomp 242323-242560): `SETS` holds a list per bank block (`SMUS`, `HUDUI`,
  `MP2_VC`, `MP2_AM`, `MP2_FX`, ... 128 sets, 20,812 entries) and `GROUPS` the voice-line groups. An entry is the
  name's CRC-32 (signed: `.STEP_STONE` is 1440126871, `.M4A1_SIL` -1181866505) and keys: `RANGE` (15,162 entries),
  `ONESHOT` (8,633), `MED`/`FAR` (1,150 each: a weapon's distance variants), `SUBTITLE*`, `AMBIENT` (279),
  `DOPPLER` (27), `STREAMING_EFX`, `LINK`, `LOOP`. `RANGE`'s two numbers land as `u16` at +0xc and +0xe; `VOLUME` would be a float at
  +4 (no set uses it). The walk's: `.STEP_STONE` 30-200, `.STEALTH_STONE` 30-130, `.STONE_JUMP` 50-200,
  `.JUMP_WHOOSH` 30-130, `.M4A1_SIL` and `.M4A1_SIL_RLD` 20-200, `.M4A1` 85-1700, `.M4A1_M` 85-1700 `MED`,
  `.M4A1_F` 85-1700 `FAR`.
- **The 3D play** (`FUN_00342670`, decomp 241912-241955): the source into the listener's frame (the matrix at
  0x48dd40, the camera), `d` its length; `gain = 1` for `d <= min`, `1 - (d - min) / (max - min)` to `max`, 0 beyond;
  the play volume `= volume x gain x 1024 x DAT_003e0070` (1.0 in the ELF's data); the pan `= atan2(x, -z)` in whole
  degrees, 0..359 -- 989snd's pan, which its `MakeVolume` turns into the stereo pair through the quarter-wave table
  and the group stage squares (research/36 Q6).

## 4. Footsteps

**The materials.** `FUN_002dde40` (decomp 181253-181468) reads `materials.rdr`'s `SOILS` into the vector at
0x44f350 after `FUN_002de4b0` (decomp 181496-181567) has appended the engine's `UNKNOWN` (0, string 0x3f3800) and
`PARTICLE_SYSTEM` (1, 0x3f3810), neither with a sound. An entry without `NAME` is dropped. Each record: `NAME` +0x00,
`STEPSOUND` +0x08, `STEALTH_STEPSOUND` +0x0c, `CRAWLSOUND` +0x10, `LANDSOUND` +0x14, `FALLSOUND` +0x18 (each a sound
object, `FUN_00344f30` of the name), `STEALTH_FACTOR` +0x34, `FOOT_STEP_OFFSET` +0x38. The table: 2 `ACTION`, 3
`INVISIBLE_DI`, 4 `GRASS`, 5 `SAND`, 6 `MUD`, **7 `STONE`**, 8 `DIRT`, 9 `GLASS`, ... 11 `WATER`, 15 `LEAVES`, 16
`ICE`, 17 `SNOW`, 18 `GRAVEL`, 19-20 `WOOD_THICK/THIN`, 22 `ASPHALT` (the stone's sounds), 25-29 the metals and
grates, 30 `FABRIC_HEAVY` (the carpet's), 39 `PLASTER`, 40 `CARPET` -- 46 in all. **The polygon's byte is that
index**: `DAT_0044f358[m]` is what the ground probe, the step and the landing read, and the hulls agree -- Frostfire's
floors are `METAL_THICK` (374 floor polygons), `UNKNOWN` (197), `STONE` (163), `METAL_GRATE` (74), and its `MP2_am`
bank holds `.STEP_METAL`, `.STEP_STONE`, `.STEP_GRATING`, `.STEP_CARPET`; Desert Glory's are `SAND` (1,056),
`ASPHALT` (578), `STONE` (298), `WOOD_THIN` (158), and `MP6_am` holds `.STEP_SAND`, `.STEP_STONE`, `.STEP_WOOD`.
A material whose sound the map's banks lack (Frostfire's `METAL_THIN` asks for `.STEP_TIN`) is silent, as the
lookup finds no object on the console.

Per material, then, and per map (the `_am` bank's set): `STEP_<M>` and `STEALTH_<M>` walking, `CRAWL_<M>` prone,
`<M>_JUMP` the landing, `FALL_<M>` a body falling (`FUN_0059a8e0`, `BODY_FALL_ON_MATERIAL_SOUND`, a fallback
`.FALL_GROUND`) -- not the SEAL landing.

**When** (`FUN_005a3570`, decomp 460266-460378). While the SEAL moves -- speed squared over 0.25 (the stance 0 test is
`FUN_0058a820`'s class 2 or 3, the same threshold; crouched and prone the same squared speed) or the stick's forward
axis at 0.1 or more -- and while the playing clip carries flag 0x40 (`FUN_005551a0`: the locomotion cycles), the
clip's play position `+0x1c` is taken modulo 1: entering (0, 0.5) the left foot falls (flag `+0x211`, the bone at
`+0x2f0` for the position), entering (0.5, 1) the right (`+0x210`, `+0x2f4`), once until the position leaves the
half. At each fall a footprint zAnim (`seal_footfall_<MATERIAL>`, 0x65f520) and `FUN_005a39b0`; prone, the left
foot's call is skipped, so a crawl sounds once a cycle. There are no footfall `zanim_callback`s in `motion.rdr`.

**Which** (`FUN_005a39b0`, decomp 460385-460434): the material at `+0x20c`; prone (`FUN_0058a720` == 2) its
`CRAWLSOUND`; otherwise `STEPSOUND` when any of the controller's three stick floats is past +-0.5, else
`STEALTH_STEPSOUND` (so a walk at a light stick is the stealth step, standing or crouched); played at the foot with
volume 1.0 (`vtable+0x14`), or without a place (`vtable+0xc`) for the local player when `+0x200` is set.

## 5. The rifle

`zweapon.rdr`'s `ZWEAPON` records (keys `ReloadSound` 0x3fcb50, `FireSoundClose/Med/Far` 0x3fcc50-70): **M4A1 SD**
`FireSoundClose .M4A1_SIL`, `ReloadSound .M4A1_SIL_RLD`, no `Med`/`Far`, `FireWait 0.14`, `Sound_Radius 10`; **M4A1**
`.M4A1` / `.M4A1_M` / `.M4A1_F`, `.M4A1_RLD`, `Sound_Radius 100`. Both banks' sounds are in every map's `_fx.bnk`
(`MP2_FX` 97-102). **The reload sound starts with the reload**: `FUN_005c2a90` (decomp 477484-477537) takes the next
magazine, starts the reload (`FUN_005a82e0`) and in the same step plays the weapon's `+0x98` sound -- the `ReloadSound`
handle `FUN_003c4700` resolved from the name at `+0x9c` -- at the actor (`+0x1c`), volume 1.0. The choice among close,
medium and far for a remote shooter is not traced (the viewer takes the next variant when the listener is past the
previous one's `RANGE`: a reading).

**A round passing** (`FUN_00598000`, decomp 454613-454655): each tick a projectile's segment is taken against an actor's
position (`FUN_00308b00`, the closest approach); within 70 units the actor flinches (`FUN_00572fa0`), within 20 a bullet
plays `.BUL_PASSING` (0x3fc508, `FUN_003c4700` hands it to the projectiles) at the nearest point, volume 1.0; a rocket
within 100 plays `.ROCKET_BY` once. A projectile flagged at `+4` bit 3 is skipped; the player's own rounds leave from
the player, so the rule is for other shooters' rounds (`GameAudio.onRoundPast`), never one's own. Whatever excludes a
round's first segment (the flag, or the shooter test at the head) is the projectile's, so its later segments -- a
penetration's exit, a ricochet -- are excluded with it: the viewer's own rounds play no `.BUL_PASSING` however they go on.

## 6. The jump and the landing

- **The jump.** `motion.rdr`: `seal_jump` `BlendTime 0.32 NoInterrupt 0.7 playback 1.1 zanim_callback (name
  (jump_whoosh) time (0.4))`; `seal_runningjump_launch` and the climbs carry `jump_whoosh` at 0.1-0.5. A callback runs
  the zAnim of its name from the map's `CZANIM.ZAR` (`common` set): `jump_whoosh`'s name table is `NA, jump_whoosh,
  dummy_node, .JUMP_WHOOSH, spinehi` and its one command is set 0 command 30 (32 bytes, the play-sound command) whose
  `u16` at +6 is 3 -- `.JUMP_WHOOSH` -- and +16 names the node (`spinehi`) it sounds at. All 73 such commands of MP6's
  archive index a sound name; of its 67 animations with one, 65 play one sound (`ladder_rung .STEP_LADDER`, `shotgun_pump .SHOTGUN_COCK`,
  `dive_prone .JUMP_TO_PRONE`, `land_sound .FALL_STONE`, the grenades' material hits ...), `law_impact` and
  `RPG_impact` two (`.EXP_1`, `.GREN_FAR`).
- **The landing** (`FUN_005ac1f0`, decomp 464866-464960), called with the contact speed (from `+0x1364` and its
  callers at decomp 466656-466937): the material under the actor (`FUN_002dc1d0(+0x400)`), its `LANDSOUND`; the
  class against `DAT_0044c280/284/288` -- the seal table's `+0x30..+0x38`, reCOM's `m_landSpeed[i] = g sqrt(2
  fallDist[i] / g)` = `sqrt(2 g d)` over `FALLING_DAMAGE_LIGHT/HEAVY/DEATH` (62, 91, 120 units at g 235: 170.7,
  206.8, 237.5 units a second). At or under the light speed: the `LANDSOUND`; to the heavy: the `LANDSOUND`; to the
  deadly: `.BONE_BRK_1` alone; at or over it: both. So a soft landing on stone is `.STONE_JUMP`, a hard one
  `.BONE_BRK_1`. **No landing grunt in the landing code**: `FUN_00578150(0.33 / 0.66)` adds to a float at `+0xeb0`
  capped at 1 (a meter, not a sound). Above the light speed the landing deals damage -- `(speed - light) / (deadly -
  light)` off each of the six body parts' health (`+0xffc`) -- and runs the damage reaction (`FUN_005a54d0`); the hurt
  SEAL's voice is his character's `CHRSND_DAMAGE` (`character.rdr`, `mp_seal1 : mp_seal (sounds (CHRSND_DAMAGE
  (.SEAL_DAMAGE) ...))`). The viewer plays `.SEAL_DAMAGE` with a landing that hurts [reading: the voice's call inside the
  reaction was not traced].

## 7. The surface a polygon is, and the map's `DefaultMaterial`

`FUN_002dc1d0` (decomp 181xxx, the accessor every material read goes through) returns the polygon's material byte
(surface word bits 10-17) -- or, for 0, `DAT_0044f310`: the map's `DefaultMaterial`, the SOILS name on its world root
(`<map>.ZED`; `mp8.rdr` repeats it: `DefaultMaterial (DIRT)`). Byte 0 is common: Crossroads' streets (810 of its floor
polygons), Frostfire's rig (197). Two maps name a default no SOILS entry is spelt as: MP11 `none`, MP64
`stone` (read as `STONE`). The map's load (decomp 152109) sets the default to `FUN_002de9e0` of the name, a lookup in
the SOILS names' table that answers **0** -- `UNKNOWN`, no sounds -- for a name it lacks, so Death Trap's default is
`UNKNOWN`; no floor of Death Trap has byte 0 (0 of 2,252), so nothing is silenced by it. The viewer does the same
(`defaultMaterialIndex`) and no longer lists it as missing (research 90 item 26).

**What each map's banks lack.** A map's `_am` bank holds the material sounds its designers expected; the floors ask for
more. Across the 22 maps the gaps are Rat's Nest's `DIRT` (its `DefaultMaterial`, 85% of its floors; `MP8_am` has no
`.STEP_DIRT`), Crossroads' `SAND`/`THATCH`/`DIRT`, the tin (`METAL_THIN`: `.STEP_TIN`) on seven maps, the metal and
carpet steps on others, and many grenade bounces (`grenade_hit_metal_thick` plays `.GREN_METAL`, which `MP2_am` lacks;
no `grenade_hit_asphalt` zAnim exists at all). The console resolves a name only among the loaded banks
(`FUN_00344f30`), so there the sound is presumably silent -- not established by a capture. The viewer lends the
missing names from another map's bank that holds them (the same recording: §8, `borrowMissing`, a PLACEHOLDER).

**Names the disc holds nowhere**: the casings' `shell_eject` zAnims (CZANIM) name the metal casing `.BUL_CASE_METAL`
where every bank spells it `.BUL_CAS_METAL` (and `.SG_SHELL_TIN`, `.SG_SHELL_SAND` exist in no bank): a spelling slip
in the game's data, so a casing on metal is silent on the console too. `grenade_hit_asphalt` has no play-sound command:
its CALL_ANIMATION (45, the name at +7, `FUN_0025d550`) names `.GREN_ASPHALT` -- no animation and no bank of the disc is
called that, so it is silent too. The viewer mends both (`SOUND_NAME_FIXES`, one table the effects share):
`.BUL_CASE_METAL` plays `.BUL_CAS_METAL`, `.GREN_ASPHALT` the stone's `.GREN_STONE` (asphalt steps like stone in
SOILS) -- departures from the retail game, named. With the lending, every `grenade_hit_<surface>` of a surface a map has
sounds: 200 of 200 over the 22 maps.

## 8. The viewer

- **`@s2u/sound`**: `decodeVag`, `parseBankFile` (the head, block, sounds, grains, tones, names, VAG), `renderSound`
  (the grain sequencer at 240 Hz -- TONE, RAND_PLAY, PLAY_CYCLE, RAND_PB/PB/ADD_PB, RAND_DELAY, the loops, markers,
  registers, children, KEY_OFF/KILL -- voices at `note2Pitch`'s pitch under the psx-spx ADSR, linear interpolation,
  `MakeVolume` with the play pan, the square law, the SPU's half scale, 48 kHz), `parseSoundScript`/`soundHash`,
  `parseSoils`, `weaponSounds`, `callbackSounds`, and the rules above as functions (`FootfallClock`,
  `footstepSound`, `landingClass`/`landingSounds`, `rangeGain`, `panDegrees`). A transliteration of the repository's
  mixer: LFO, XREF and plugin grains are not modelled (none of the walk's sounds carries one) and the global
  registers read 0.
- **The page**: the worker reads the map's three banks and `HUDUI.bnk` (§1, `SOUND_GLOBAL_BANKS`) from `BNKSTORE.ZAR` by range (the head, 3,268 B of key tree,
  the three members: Frostfire's 1.85 MB, beside the 1.9 MB script) -- the served tree over HTTP `Range`, or the player's ISO
  (MP6: 21 reads, 4.1 MB, 66 ms) -- and `GameAudio` renders a sound when it starts, with the play volume and pan
  `FUN_00342670` would give it from the camera, into a stereo buffer for one `AudioBufferSourceNode`. No
  `PannerNode`: its equal-power law and roll-off are not 989snd's. The `AudioContext` is made suspended at page start
  and the first click or key resumes it.
- **The events** (`GameAudio`): `onFootstep(material, position, {stance, stick})`, `onFire(weapon, position)`,
  `onReload(weapon, position)`, `onJump(position)` (the `jump_whoosh` callback now), `onLand(speed | class,
  material, position)`, `onAnimCallback(name, position)`, `play(name, position)`; `setVolume`, `setMuted`; `stats()`
  as `window.__viewer.audio()`. `walkSounds.ts` drives them from the walk today: the cycle clip's `frame / frames`
  as the phase, the mover's speed and the stick's forward axis for the moving test, the stick's larger axis for the
  step/stealth choice, the drawn feet for the position (not the foot bones), the probe's floor under the feet for the
  material, the jump count, the landing speed, the fire count, the reload flag.
- **Placeholders**: `LISTENING_GAIN_PLACEHOLDER` (x4, +12 dB on the whole mix: the console's effects peak at -30 to
  -20 dBFS, a television's knob did the rest); `DEFAULT_RANGE_PLACEHOLDER` (30-200, for a sound `sounds.rdr` does not
  list); `MAX_RENDER_SECONDS_PLACEHOLDER` (4 s, a looping voice nothing keys off); `LOOP_SECONDS_PLACEHOLDER` /
  `LOOP_FADE_SECONDS_PLACEHOLDER` (12 s + 1 s, the ambience loops); `BED_FADE_SECONDS_PLACEHOLDER` (0.5 s);
  **`borrowMissing`**: a step, stealth, crawl or landing sound of a material the map's floors use, a grenade bounce or
  round impact on a surface the map has, an explosion or a casing, that the map's banks lack, lent by the same name from
  the bank of another map that has it (found through `sounds.rdr`: a set is a bank's block) -- 1 or 2 borrowed banks a
  map, every floor of the 22 now sounding. The remote fire variants' chooser and the footprint decals are not traced.
- **The unlock costs nothing** (measured on the dev server, headless Chromium): the first key press used to spend 949 ms
  (Desert Glory), 451 ms (Sandstorm), 133 ms (Frostfire) in the audio unlock -- about 300 ms of it the page's first
  `AudioContext` (the browser's audio service), the rest the reverb's response and the loops' buffers. Now the context
  is made suspended when the map's sound data arrives, the response is computed in the worker, and the convolver
  (~11 ms, the browser's partitioning) and the loops' buffers (a channel a job, shared by a sound's emitters) are built
  from a queue run 4 ms a frame (`PUMP_BUDGET_MS`) before any gesture; the key press only resumes the context: 0.4-0.7 ms
  for the whole event, 0.1 ms in the handler (`stats().timing`). The release sweep (research 90 item 27) then saw
  9-69 ms (887 ms once) on a click that landed before the map's sound data, which made the context itself: the context
  is now made on the task after the page wires `unlockOn` (a `setTimeout 0`, whether or not a map comes), so every
  click only resumes it. Re-measuring is `tools/audio-unlock.ts` (owed: the host's lock).
- **The stats** (`window.__viewer.audio()`): the banks (the borrowed marked), the map's `defaultMaterial`, the reverb
  (loaded, inside, zone, depth), the ambience (the beds, which is up, the emitters and their gains), the dropped plays
  by reason (locked, range, unknown, muted, silent -- a surface or zAnim that names no sound) and `unknownNames`;
  `missing` names what could not be read -- a tree without the sound archives says `RUN/SOUNDS/BNKSTORE.ZAR: ...`, and
  the page logs one warning.
- **The events** added this round: `onRoundPast(from, to, actor, rocket?)` (another shooter's round), `setEnvironment
  (inside, zone)` and `setAmbience(on)` (fed by `walkSounds.frame(camera)`), `setLoops` (the worker's loops).

## 9. The reverb

- **The mode.** `snd_SetReverbType(2, 3)` (`FUN_0033f2a0`, 989snd call 0x0e; decomp 55186, 243346, 243386): core 1,
  libsd mode 3, `SD_REV_MODE_STUDIO_B`. libsd's presets are in `LIBSD.IRX`'s data: nine 0x44-byte blocks of the 32 SPU
  reverb registers (Room first, `dAPF1 0x7D, dAPF2 0x5B`; mode 3 `0xB1, 0x7F`, the PS1 "Studio Medium"), the work
  areas' sizes before them (Studio B 0x908 x 8 bytes). `findReverbPresets` finds them by their shape.
- **Which voices.** SOCOM's `989SND.IRX` sets a voice's effect sends (`SD_S_VMIXEL`/`VMIXER`, 0x1900/0x1b00) from its
  tone's flags **bit 0** (decomp 14339-14345: `DAT_0001cf1c`) and clears its dry mix (`VMIXL`/`VMIXR`) for bit 4
  (14189-14203) -- not the v3.01 reference's bit 1. 200 of `MP2_am`'s 281 tones send (the steps among them).
- **The depth** (`FUN_00341a60`, decomp 241509-241560, each frame): the camera probes the floor under it (`FUN_00295b00`,
  decomp 140035-140058) and keeps the hit polygon's `m_inside` (bit 23, `FUN_002dc180`) and a zone bit (27,
  `FUN_002dc150`); on a change, `snd_AutoReverb(2, depth x 32767, seconds x 240, 3)` (989snd call 0x10) to the
  `IndoorReverb` or `OutdoorReverb` entry of that zone (`FUN_003416b0`/`FUN_00341500` read them from `mission.rdr`:
  `Depth`, `Seconds`), or to 0 over 0xf0 ticks (1 s) when the list has none. Frostfire: indoors 0.45 (the first of two
  `IndoorReverb` keys; the later says 0.3) and 0.2, outdoors 0.07 and 0.2, each over 1 s; the outdoor depths run 0 (Sujo)
  to 0.2 (Chain Reaction). The zone bit is 0 on every floor of the maps looked at, so entry 0 is the one heard.
- **In the viewer**: the preset's reverb (psx-spx's formula, as PCSX2's SPU2 runs it: at 24 kHz, both sides a tick)
  run once on an impulse into each input -- Studio B rings about a second, -20 dB each 0.2 s, 37 ms before the first
  reflection -- a four-channel `ConvolverNode` on a bus the flagged voices' send pair feeds, its output gain (the SPU's
  `EVOL`) ramped linearly to the depth.

## 10. The ambience

The mission script plays it (`MZANIM.ZAR`, `mission` set; the common set carries the same beds):
- **The beds.** `check_camera_inside_state1` (activation 1: it starts with the mission) loops on the camera's inside
  state: stop `outside_noise`, start `inside_noise` (command 46, the stop, names its animation at +4; 45, the start, at
  +7), and the reverse. `outside_noise` plays `~OUTDOOR_AMB`, `inside_noise` `~INDOOR_AMB`, without a place (flags
  0x280). `~OUTDOOR_AMB` (MP2) is two tones panned 270/90 and two child sounds under an LFO.
- **The emitters.** Every self-starting animation (activation 1) whose play-sound command loops a `~` sound at a node
  (flags 0x82/0x282, the node byte at +16, `0xf9` the animation's root node): Frostfire's `~FAN_ROTATE` at `fan1`,
  Desert Glory's insects at its lights and fires in a barrel and the rubble, the waterfalls and rivers of Abandoned,
  Foxhunt and Shadow Falls, dogs, chimes, lapping water, radios, humming equipment, the helicopters (their SoftImage
  path not followed: heard at the node's rest), crickets (whose conductors wait on a global register the game sets, so
  no voice starts in the first seconds). 0 to 18 a map.
- **An emitter's place** (the SOUND command's tick, `FUN_002659c0`, decomp 112317): the place starts at 0, flag 4 adds
  the command's f32 triple at +0x14 (`FUN_00309240`), and flag 2 carries it through the node's matrices to the world
  (`FUN_00310980`) only when the node resolves (`FUN_0026f4e0`, by exact name over the world and the objects,
  `FUN_00269230`); with no node and no offset the sound plays without a place. Three emitters carry an offset: Foxhunt's
  `waterfall1_sprays` (0, at `spray4`), Crossroads' `water_drain` ((0, -60, 30) below `waterpipe`) and Vigilance's
  `water_drain`, a copy of Crossroads' naming a node `pipe` that no model of Vigilance has (no ZED or rdr of MP51 names
  it). The game therefore sounds Vigilance's `~WATER_LEAK` at the bare world point (0, -60, 30), 586 units from the
  nearest floor, past its `RANGE`: inaudible there, and the viewer places it the same (`emitterPosition`).
- **The crickets** set no game register: their conductor counts its burst of chirps in a local register (`SET_REGISTER
  _RAND 0..40`, `INC_REGISTER`, `TEST_REGISTER < 90`) and waits `RAND_DELAY` up to 4000 ticks (16.7 s) between bursts --
  longer than the 12 s loop, so it rendered silent. A loop with no voice in 12 s is rendered over 40 s at 24 kHz
  (`renderLoopAtLeastOneVoice`, `LONG_LOOP_SECONDS_PLACEHOLDER`).
- **Global register 2** is the one the game sets for the ambience: each frame `snd_SetSFXGlobalReg(2, x)` (989snd call
  0x67; `FUN_00341a60`, decomp 241580-241600) with `x = f x 255 - 128`, `f` the camera's height through the mission's
  `elevation (max min)` (`FUN_002aca30`: 0 below, 1 above, linear between). The outdoor beds of Foxhunt, Enowapi, Fish
  Hook, The Mixer (indoor) and Requiem test it (`TEST_REGISTER -2`) to pick their layers; Requiem's ice sounds read
  global 3, which nothing here sets. The viewer renders the beds once, with register 2 at spawn A's camera height
  (`BED_CAMERA_ABOVE_FEET_PLACEHOLDER`, 25 over the floor), not per frame.
- **In the viewer**: each sound rendered once in the worker as a 12 s loop with a 1 s crossfade folded in
  (`LOOP_SECONDS_PLACEHOLDER`), played round; the beds cross over 0.5 s (`BED_FADE_SECONDS_PLACEHOLDER`) as the camera's
  floor goes in and out; an emitter's two channel gains follow the camera each frame -- its `RANGE` fall-off, squared
  by 989snd's law, and the pan pair of its azimuth.

## 11. Verification

`npm run dump-sounds -- MP2 <dir> .STEP_STONE ...` renders to WAV and prints each sound's length, peak and RMS. On
Frostfire, with a seeded random: `.STEP_STONE` 0.641 s, 1 voice, peak 0.027; `.STEALTH_STONE` 0.652 s, 0.012;
`.STONE_JUMP` 0.499 s, 0.076; `.JUMP_WHOOSH` 0.499 s, 0.008; `.BONE_BRK_1` 0.350 s, 0.113; `.M4A1_SIL` 0.168 s, 2
voices, 0.101; `.M4A1_SIL_RLD` 0.336 s, 0.065; `.M4A1` 1.111 s, 4 voices, 0.243. Not noise: the lag-1
autocorrelation is 0.97-0.998 on the steps (white noise is 0), the steps' and shots' envelopes peak in the first 20
ms and decay, the whoosh builds to 140 ms. Half the play volume gives a quarter of the level (the square law), a pan
of 90 nothing on the left. In the browser (Playwright, `e2e/audio.spec.ts`): on Frostfire a 2.5 s run played ten
`.STEP_METAL`, the jump `.JUMP_WHOOSH` then `.METAL_JUMP`, five rounds `.M4A1_SIL`, `R` `.M4A1_SIL_RLD`; on Desert
Glory `.STEP_SAND` and `.SAND_JUMP`; nothing dropped.

## 12. Open

- The clip position at `+0x1c` of the track (what the steps read) against the viewer's `frame / frames`: a cycle
  clip whose last key repeats its first would put the right foot a key early; the foot bones' positions (the viewer
  uses the drawn feet).
- `FALLSOUND` for the body, `.GUN_EMPTY` on a dry trigger, the music (`SMUS`, VPK streams), the LFO grain (the
  outdoor bed's shimmer), the global registers (the crickets' conductors; `snd_SetSFXGlobalReg(2, x)` every frame,
  `FUN_00341a60`, from the camera's height) -- all readable with what is here.
- The Gaussian interpolation (research/69 §4) and the SPU2's reverb down/up-sampling filters: the render interpolates
  linearly and the reverb response holds each 24 kHz tick for two output samples.
- Whether the console is silent where the viewer borrows (a capture on Rat's Nest would say).
