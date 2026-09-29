# Architecture of the web project

How the browser recreation is put together, which parts are specific to SOCOM II and which are plain PlayStation 2,
and where to start if you want to do the same for another PS2 game. The facts behind every box below are in the
research notes (`docs/research/`); the notes are cited by number.

## The shape in one picture

```
             your own disc (an .iso opened in the page, or an extracted RUN/ tree)
                                         |
                                 @s2u/archive          ISO9660, ZDB, ZAR/ZED v2, compiled .rdr,
                                         |             the AssetSource the others read through
          +---------------+--------------+--------------+----------------+
          |               |              |              |                |
      @s2u/gs        @s2u/mesh      @s2u/sound      @s2u/scene        tools/
   textures, CLUTs  DMA chain, VIF1  989snd banks,   scene graph, grid,  extractors, dump and
   GS state blocks  unpack, vertex   SPU ADPCM,      collision probe,    compare instruments
                    lanes, skinning  reverb, rules   motion, weapons,
          |               |              |          tuning, zAnim,
          |               |              |          projectiles
          +---------------+------+-------+--------------+
                                 |                      |
                          @s2u/viewer               @s2u/server
      three.js (WebGPU, WebGL2 fallback), a        Node + ws: one authoritative
      decode worker, the GS-arithmetic shading,    room per map at 60 Hz, fed by
      the walk, HUD, audio, effects, the net page  the SAME sim modules the page runs
                                 \                      /
                                  +--- src/sim.ts -----+   headless: no three, no DOM, no Web Audio
```

Everything is TypeScript in one npm workspace (`web/package.json`, whose members are `redotcom`, `redotcom/packages/*`,
`redotcom/tools`, the landing site `landing` and the design system `shared`). The packages are
not published to a registry; each exports its `src/index.ts` directly and Vite/`tsx` compile on the fly.

## The packages and their boundaries

| package | depends on | owns | never does |
|---|---|---|---|
| `@s2u/archive` | nothing | Reading bytes: the `AssetSource` interface and its file-system (`/node`), HTTP (with `Range`) and in-browser ISO9660 sources; the ZDB table of contents; ZAR/ZED v2 containers; compiled `.rdr` scripts; the served `index.json` | interpret what a member means |
| `@s2u/gs` | archive | The Graphics Synthesizer's side of a texture: PSMT4/PSMT8 with CT16/CT32 CLUTs, PSMCT16/32, the palette interleave, and the GS state each texture's bind packet sets (`ALPHA`, `TEX1`, `TEST`, `CLAMP`) | touch a GPU |
| `@s2u/mesh` | archive | Geometry as the PS2 sent it: the DMA-chain walk, VIF1 `UNPACK`/`STCYCL`/`MSCAL`, and the interpretation of each VU1 program's vertex lanes into `MeshData`, `LineStrip` and skinned batches. [`packages/mesh/SEMANTICS.md`](../packages/mesh/SEMANTICS.md) is the authority for every lane | know where a model is placed |
| `@s2u/sound` | archive | 989snd `SBlk` banks, headerless SPU ADPCM, the grain sequencer rendered at the game's volume and pan, the SPU2 reverb presets, `sounds.rdr`, the surface-material step table and the rules for when a sound plays | play audio (the viewer does, through Web Audio) |
| `@s2u/scene` | archive, mesh | The engine's world: the world root, the scene graph and its matrices, the engine's walk order and grid, clutter, the collision hull and the ground probe, `AIMAPS.MPS` spawns, LOD bands, the character skeleton and gear, motion clips, the SEAL's tuning, the weapon table, zAnim effect scripts, grenade flight | draw anything |
| `@s2u/viewer` | all of the above, `three` | The Vite app: decoding in a worker, the three.js scene, a shading graph that repeats the GS's arithmetic, the fly camera, the walk (mover, camera, clips, gunplay, grenades, traversal), the HUD, audio, effects, touch and pad input, the multiplayer page | run on the server, except through `src/sim.ts` |
| `@s2u/server` | archive, scene, `ws`, and `viewer/src/sim.ts` by path | One match per map: the lobby, every player's mover run from its command stream, lag-compensated hits, deaths, respawns, scores, 30 Hz snapshots; HTTP `/health` and `/metrics` | serve the disc's files |
| `tools/` | archive, gs, mesh, sound | `extract-maps` and the `dump-*` readers, `export-gltf`, the console-frame and feel-parity instruments, the release sweep, the multiplayer bot load test, `build-corpus` | ship in the page |

### The sim boundary

`packages/viewer/src/sim.ts` is the one module the server imports from the viewer. It re-exports what a match needs to
decide: the mover (`mover.ts`, the `Walker`), traversal, the motion table and clip timings, the tuning and stature, the
round and its accuracy and penetration, the rifle kick, the magazines, and the net protocol, codec, damage, lobby and
deaths. Grenades are already headless in `@s2u/scene` (`projectile.ts`). The page predicts its own SEAL with these
modules and the server runs the same modules authoritatively (spec ruling W3.R2), so there is one implementation of
the rules, not two.

The boundary is enforced, not advised: [`test/simBoundary.test.ts`](../packages/viewer/test/simBoundary.test.ts) walks
every value import reachable from `sim.ts` and fails on `three`, the DOM or Web Audio. A change that makes the mover
touch the renderer fails the suite.

### The data flow of a map load

1. The page picks an `AssetSource`: the user's `.iso` (`IsoAssetSource`, read in the browser, nothing uploaded), or an
   HTTP tree for development.
2. A worker (`viewer/src/worker.ts`) reads the map's ZDB, decodes textures (`gs`), geometry (`mesh`), the scene graph,
   collision, spawns and grid (`scene`), the player's body and clips, the map's sound banks (by byte range) and effect
   scripts, and transfers typed arrays back.
3. The main thread builds three.js objects a few per frame (`scheduler.ts`) so a map switch does not freeze the page,
   and draws them with materials built from each texture's GS state (`materialSpec.ts`, `world.ts`).
4. In walk mode a fixed 60 Hz step (`CGame::Tick`'s rate) drives the mover, the camera and the clips; the page renders
   between steps.

## What is SOCOM-specific, and what is plain PS2

| layer | general to PS2 games | specific to SOCOM II (Zipper Interactive's engine) |
|---|---|---|
| Disc access | ISO9660 reading, the `AssetSource` abstraction, HTTP range reads | the `RUN/` layout, `COMMON_ARCHIVES` |
| Containers | -- | ZDB, ZAR/ZED v2 and compiled `.rdr` (reCOM, a re-implementation of SOCOM 1's engine, reads the same forms); `AIMAPS.MPS` |
| Textures | GS pixel formats, CLUT layouts and interleave, GS register semantics (`TEX0`/`TEX1`/`ALPHA`/`TEST`/`CLAMP`) | the texture and palette records inside `_TXR`/`_PAL` members and how a bind packet points at them |
| Geometry | DMA tags, VIF1 codes and `UNPACK` formats, GIFtags | what each VU1 microprogram does with the lanes (the world family, command `0x52`'s skinning, `0x70`'s scaled form, `0x34`'s environment map) |
| Shading | the GS's modulate `(texel x vertex) >> 7`, `COLCLAMP`, linear fog, alpha test, the blend equations, the 640x448 frame stretched to 4:3 | which post-process a round runs, lighting flags, detail textures, facades, LOD records |
| Sound | SPU ADPCM, SPU2 reverb; 989snd banks are Sony's 989 Studios library, used by other first-party titles | `sounds.rdr`, `BNKSTORE.ZAR`, the material step table, when a step or a round sounds |
| Animation | -- | the clip format in `MOTION_*.ZAR`, `motion.rdr`, the zAnim command numbering |
| Rules | a fixed-step authoritative server with client prediction | every number: speeds, jumps, accuracy, damage, respawn, scoring (research 80-91) |

## Adapting it to another PS2 game

Nothing here is packaged as a general library, and the code uses SOCOM's names throughout. What carries over is the
approach and several modules that do not care which game made the bytes. A path that worked here:

1. **Read the disc in the browser.** `IsoAssetSource` and `HttpAssetSource` are game-agnostic. Keep the user's own
   disc as the only source of data.
2. **Find the containers.** Replace or extend `@s2u/archive` with the target game's archive formats. The notes 72 and
   36 show the level of evidence that paid off: each field confirmed on several archives before code depended on it.
3. **Textures first.** Once you find the game's texture records, `@s2u/gs`'s decoders and GS-state reader apply as
   they are; `npm run dump-textures` shows the kind of instrument that settles pixel order and CLUT interleave.
4. **Geometry through the VIF.** `mesh/src/dma.ts` and `vif.ts` implement the hardware and transfer. The work is the
   interpretation of the vertex lanes, which is fixed by the game's VU1 microcode: read it from a VU1 translation or a
   disassembly, write the lane meanings down as `SEMANTICS.md` does, and test against a known-good dump.
5. **Draw with the GS's arithmetic.** `viewer/src/world.ts` and `materialSpec.ts` show how to express the GS's modulate,
   clamp, fog, alpha test and blend as three.js node materials that run on WebGPU and WebGL2 alike.
6. **Compare with the console early.** `tools/console-compare.ts` (research 82) puts the page beside a console frame at
   the console's own camera; most of the picture's real defects were found this way, not by eye.
7. **Rules last, and shared.** If the game is to be played, keep the rules headless behind a boundary like `sim.ts` so
   a server can run them unchanged.

## Further reading

- [`DATA_SOURCES.md`](DATA_SOURCES.md): every kind of data, where it comes from and how it was verified.
- [`PROCESS.md`](PROCESS.md): the stack and how the work was done.
- [`corpus/llms.txt`](corpus/llms.txt): the same knowledge as structured records for an assistant.
- The design specs and plans under [`specs/`](specs/) and [`plans/`](plans/), one pair per sprint.
