# Where the data comes from

Every picture, sound, movement and rule the web port shows comes from one of four places: **your own copy of the
disc**, **the game's own code** (read through a decompilation of the executable on that disc), **reCOM** (an
open-source re-implementation of SOCOM 1's engine, used only where the decompilation is silent), and **frames captured
from the console** (for checking the picture). This page lists, for each kind of data, where it comes from, the code in
this repository that reads it, and how it was checked. The same facts, as machine-readable records, are in
[`corpus/`](corpus/llms.txt).

## The stance: your disc, no game data here

- **You supply your own disc.** The page opens your own SOCOM II (US) `.iso` and reads it in the browser: nothing is
  uploaded, nothing is stored on a server. The development tools read an extracted copy of the same files.
- **The repository ships no game data** -- no archives, textures, models, sounds, clips, scripts, executable or
  decompilation. The directories the tools write into (`public/maps/`, `test-fixtures/`) are git-ignored, and a pull
  request that adds game data is closed unread ([`../../../CONTRIBUTING.md`](../../../CONTRIBUTING.md)).
- **The research notes cite, they do not copy.** They name files, give counts, offsets and the few short constants a
  rule needs, and cite decompiled functions by address and line. The decompiled text itself is never quoted into the
  tree.
- **No server reads the disc here.** The online match server (which read the disc files it needed from a private
  directory and never served them) lives in the separate redotcom project since 2026-10-01; the local demo's match
  runs in the page on the visitor's own disc.
- **A development build can serve extracted files from your machine** for your own testing (`?devmode`); that path
  is for development only and is not how the page is meant to be used. **socomunzipped.com serves such a tree today,
  by the owner's choice and for now** (`/redotcom/maps/`, the development mode's reads; the site also plays the game's
  menu movie and HUD sounds, cut from the owner's disc). The page itself still reads the visitor's disc; the move to
  disc-only is the owner's row O28 in `docs/HUMAN_TASKS.md`, and the site's credits say the same
  (`web/landing/src/claims.test.ts`).
- SOCOM II: U.S. Navy SEALs and all of its assets belong to Sony Interactive Entertainment; the game was developed by
  Zipper Interactive. This project is not affiliated with or endorsed by either. Obtain the game only as your own copy.

## Getting the files for development

The page needs nothing but your `.iso`. The tools and the tests need the files on disk:

1. Make an extracted tree from your own disc: mount the `.iso` (double-click on Windows, `hdiutil attach` on macOS,
   `mount -o loop` on Linux) and use its `RUN/` directory, or use the one the PC project's disc chain writes to
   `game/disc/` ([`../../../docs/DEVELOPING.md`](../../../docs/DEVELOPING.md), "From your own disc to a buildable ELF").
2. From `web/`: `SOCOM_DISC=/path/to/disc npm run extract-maps`. It copies the 22 `RUN/MP*.ZDB` map archives and the
   shared archives (`COMMON_ARCHIVES` in `packages/archive/src/mapIndex.ts`) into `public/maps/`, three maps into
   `test-fixtures/`, and writes `index.json` with each map's name read from its own `mission.rdr`.
3. The fixture-backed tests skip themselves when `test-fixtures/` is empty, so the suite runs without a disc.

## The data, kind by kind

The research notes are in [`research/`](research/); `repo/NN` is a note of the PC project's own research
([`../../../docs/research/`](../../../docs/research/)).

### Maps

| data | on the disc | read by | verified by |
|---|---|---|---|
| Containers | `RUN/MP*.ZDB` (22), each a table of ZAR/ZED v2 members | `@s2u/archive` `zdb.ts`, `zar.ts` | research 72 §1 (281 members of five archives, then all 22 maps); `archive/test/zdb.test.ts`, `zar.test.ts` |
| Map names, lighting, units, texture wrap, detail bindings | the map's compiled `.rdr` scripts (`mission.rdr`, `mp<N>_lib.rdr`) | `archive/src/rdr.ts`, `archive/src/mapIndex.ts` | research 72 §2, §7; `archive/test/rdr.test.ts`, `mapIndex.test.ts` |
| Geometry | `WORL_MDL.ZED`, `MP*_MDL.ZED`: PS2 DMA chains of VIF1 packets | `@s2u/mesh` (`dma.ts`, `vif.ts`, `interpret.ts`); lane meanings in `packages/mesh/SEMANTICS.md` | research 72 §3-4, `repo/13`, `repo/15` (the VU1 programs); `mesh/test/*` |
| Textures and palettes | `MP*_TXR.ZED`, `MP*_PAL.ZED`, and the shared `COMMON` libraries | `@s2u/gs` (`decode.ts`, `palette.ts`, `gsState.ts`); `npm run dump-textures` | research 72 §5, research 82 D3/D3b; `gs/test/*` against recorded goldens |
| Placement | `MP*_GEO.ZED` (scene graph), `CLUTTER.ZAR` | `@s2u/scene` `sceneGraph.ts`, `buildScene.ts`, `clutter.ts` | research 72 §2; `scene/test/scene.test.ts`, `clutter.test.ts` |
| Collision and floor | the `di` keys of `MP*_GEO.ZED` | `scene/src/collision.ts`, `probe.ts`, `grid.ts` | research 72 §6, `repo/23`, `repo/24`; the console's actor-measured spawns land within -3..+1 of the probe; `scene/test/probe.test.ts`, `grid.test.ts` |
| Spawn slots, tactical map | `AIMAPS.MPS` (not a ZAR) | `scene/src/aimaps.ts`, `tools/dump-aimaps.ts` | research 75 (read to its last byte; all 1,058 slots stand on the floor); `scene/test/aimaps.test.ts` |
| LOD, fog, scrolling, facades, culling | `READERM.ZAR/lod.rdr`, the world root, node flags, GIFtags | `scene/src/lod.ts`, `viewer/src/fog.ts`, `lodFade.ts` | README "What the picture is made of"; research 82; `viewer/test/fog.test.ts`, `lodFade.test.ts` |
| One map to glTF | any of the above | `npm run export-gltf` | for Blender or a glTF validator |

### The player and the weapons

| data | on the disc | read by | verified by |
|---|---|---|---|
| The SEAL's mesh, skeleton and gear | `CLIB_MDL.ZED`, `CLIB_GEO.ZED`, `FLIB_*`, `READERC.ZAR/character.rdr`, `READERM.ZAR/chartype.rdr` | `mesh/src/skin.ts`, `scene/src/skeleton.ts`, `character.ts`, `viewer/src/body.ts`; `tools/dump-characters.ts` | research 78 (411 meshes, 0 failures; the palette is the bind pose to 0.0017); `scene/test/skeleton.test.ts`, `character.test.ts` |
| Motion clips | `RUN/MOTION_P.ZAR` (the player's 334 clips), `MOTION_S.ZAR` per map | `scene/src/motion.ts`; `tools/dump-motion.ts` | research 77; `scene/test/motion.test.ts` (all 22 maps and the player's pack) |
| Clip playback, speeds, gravity, jump factor | `READERC.ZAR/motion.rdr`, `animset.rdr`, `dynamics.rdr` | `scene/src/tuning.ts`, `viewer/src/motionTable.ts`, `physics.ts` | research 80, 88; `scene/test/tuning.test.ts`, `viewer/test/walk.test.ts`, `feelParity.test.ts` |
| Weapon records | `RUN/ZWEAPON.ZAR/zweapon.rdr` | `scene/src/weapons.ts`, `weapon.ts` | research 84 §1, 85 §1, 91 §1.2; `scene/test/weapons.test.ts` |
| Weapon models, the fire point | `WEAP_GEO.ZED`, `WEAP_MDL.ZED` | `scene/src/firePoint.ts`, `viewer/src/heldItem.ts` | research 79 §2-3 (59 weapons decode on all 22 maps) |
| Kits and default loadouts | `character.rdr`, each map's `chartype.rdr` | `scene/src/character.ts`, `viewer/src/kit.ts` | research 91 §14; `viewer/test/kit.test.ts` |

### Sound

| data | on the disc | read by | verified by |
|---|---|---|---|
| Banks | `RUN/SOUNDS/BNKSTORE.ZAR` (989snd `SBlk` v3 banks: per map `_am`, `_fx`, `_vc`, and `HUDUI`) | `@s2u/sound` `bank.ts`, `vag.ts` (SPU ADPCM), `render.ts`; read by HTTP range: the map's three banks and `HUDUI` (about 1.9 MB for Frostfire), plus a lent bank or two | research 81 §1-2; `repo/06`, `repo/36` and the PC project's 989snd model; `sound/test/sound.test.ts`; `npm run dump-sounds` renders any sound to WAV with its length, peak and RMS (research 81 §11) |
| Per-sound parameters | `RUN/SOUNDRDR.ZAR/sounds.rdr` (looked up by the CRC-32 of the sound's name) | `sound/src/script.ts`, `catalog.ts` | research 81 §3 |
| Footsteps and landings per surface | `READERC.ZAR/materials.rdr` (`SOILS`), the polygon's material byte | `sound/src/materials.ts`, `rules.ts`, `viewer/src/walkSounds.ts` | research 81 §4, §7; `viewer/test/audio.test.ts` |
| Reverb | `RUN/IRX/LIBSD.IRX` (the SPU2 presets) | `sound/src/spuReverb.ts` | research 81 §9 |

### Effects and the HUD

| data | on the disc | read by | verified by |
|---|---|---|---|
| Muzzle, casing, impacts, explosions, lights | zAnim scripts in `RUN/CZANIM.ZAR`, each map's `MZANIM.ZAR`, `RUN/MPZANIM.ZAR` | `scene/src/zanim.ts`, `effects.ts`, `effectMotion.ts`, `effectParticles.ts`; `tools/dump-effects.ts` | research 77 §9, research 89; `scene/test/zanim.test.ts`, `effects.test.ts` |
| Bullet marks and scorches | `decals.rdr` (`TEMP_DECAL_POOL` 150 + 50, `PERM_DECAL_POOL` 30 + 0: the scorch pool), `EFFE_TXR.ZED` | `viewer/src/markClip.ts`, `effects.ts`, `grenade.ts` | research 89 §5, §13-15; `viewer/test/markClip.test.ts`, `markShade.test.ts`, `grenadeScorchPool.test.ts`, `grenadeScorchSlope.test.ts` |
| HUD bitmaps and font | `HUD_TXR`, `HUD2_TXR`, `HUDW_TXR`, `FONT_TXR` (each with its `_PAL`), `READERC.ZAR/fonts.rdr` | `viewer/src/hud.ts`, `hudFont.ts`, `hudAssets.ts` | research 87 §2-3, §6: each element within a pixel of the console frame's; `viewer/test/hud.test.ts`, `e2e/hud.spec.ts` |

### Rules read from the game's code

Behaviour the data files do not hold -- how the stick becomes a speed, when a jump leaves the floor, how the reticle
opens, where a round goes, how much damage it does, when a player respawns, how the score is kept -- is read from the
game's code. The executable comes off your own disc (the PC project's `scripts/disc_to_elf.sh`); a headless Ghidra
export (`ghidra_scripts/ExportAll.java`) writes its decompilation. Neither is in the repository. The notes cite
functions as `FUN_<address>` with the decompilation's line numbers, and reCOM's source by file and line where the
decompilation is silent.

| subject | research | pinned by |
|---|---|---|
| Movement law, stances, falls | 80 §4, 88 §3, `repo/79` | `viewer/test/walk.test.ts`, `moveStick.test.ts` |
| The jump and the landings | 80 §2 | `viewer/test/walk.test.ts` |
| The look and the camera | 83, 80 §2.5, `repo/17` | `viewer/test/look.test.ts`, `playerCamera.test.ts` |
| Accuracy, recoil, fire modes, zoom, magazines | 84 | `viewer/test/accuracy.test.ts`, `zoom.test.ts`, `magazines.test.ts`, `e2e/accuracy.spec.ts` |
| Grenades: throw, flight, fuse, blast, arc | 85 | `scene/test/projectile.test.ts`, `throwArc.test.ts`, `viewer/test/grenade.test.ts` |
| Ladders, climbs, peek, water | 86 | `viewer/test/traversal.test.ts`, `e2e/traversal.spec.ts` |
| Damage, death, respawn, teams, score, names | 91 | `viewer/test/netDamage.test.ts`, `netLobby.test.ts`, `room.test.ts` |
| The blast on the player (reach, fragments, knock, ringing ears); the offline match | 85 §12, 91 §20 | `viewer/test/netBlast.test.ts`, `knock.test.ts`, `loopback.test.ts`, `ringingEars.test.ts`, `server/test/roomBlast.test.ts` |
| The room's fire and reload checks (rate, cone, reload lock) | 84 §18, 91 §16 | `viewer/test/room.test.ts`, `viewer/test/shotCone.test.ts`, `weapon.test.ts` |

A value no source gives is a named `*_PLACEHOLDER` constant with a comment saying what was searched, and a reading
the viewer had to choose is a named `*_READING`; each note lists its own by name in a section whose heading says
placeholders or readings. `tools/test/placeholderLedger.test.ts` holds the two in step: every such name in the viewer
(the match's room with it), scene and sound sources is in a note's section, and a name a note lists that no source holds any more is marked
there as resolved, retired or note only.

### The look, checked against the console

The picture is checked against frames the console drew, not against memory of it: PCSX2 captures of a live Vigilance
round and of the first campaign mission at a camera read out of the console's own memory, and frames of the recompiled
game at Frostfire's spawns. `tools/console-compare.ts` draws the page from the same camera and measures the difference
region by region; research 82 ranks every divergence found and how each was fixed. Most of those frames live on the
maintainer's machine; the small set the PC project's parity gate compares against is under `scripts/parity/refs/`.

## Confidence

The notes and the [corpus](corpus/llms.txt) use three levels:

- **proven**: measured on the disc's bytes or a console frame, and held by a test;
- **reading**: read from the decompilation or reCOM, consistent with the tests, not yet measured on a console;
- **placeholder**: no source found; a named constant stands in until one is.
