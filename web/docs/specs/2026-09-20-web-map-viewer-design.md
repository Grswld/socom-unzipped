# Web map viewer — the browser recreation's first milestone (design)

Written 2026-09-20 by the browser project's overseer, working autonomously through the milestones. The scope
as set: the scoping note (`web/docs/research/71-browser-recreation-scoping.md`) and the code-diet spike, the map order
Frostfire, Desert Glory, Crossroads, two asset sources behind one interface (section 1), and a 30 s first-load
budget. The review gate this process normally puts on a spec before implementation was waived for that night;
the file was reviewed afterwards.

## 1. What this is

A browser application that loads a SOCOM II multiplayer map from the game's own archives and renders it in 3D with a
free camera, textured world geometry, placed props, and overlays for collision and the known spawn positions. It is
the first milestone of the browser recreation (`web/docs/research/71`): the replay viewer for live matches builds on it
(it needs a map to draw actors in), and the eventual match client reuses its archive and asset layers.

It is a **viewer**, not the game. It does not emulate VU1 or the GS. Geometry and textures are decoded exactly from
the archives; lighting is the baked vertex colour; blending and fog are approximated. Where the match itself is
concerned, fidelity means running the recompiled game code, which is the full-game route the code-diet spike gates;
this viewer does not pretend to that.

### 1.1 Why viewer-first tonight
The full-game route (recompiled game as wasm, GS as WebGPU compute) is the only route to mechanically identical
gameplay and stays the target. It is gated on the code-size measurement now running, and even a good number makes it
a months-scale port with no shipped precedent. The viewer route is weeks-scale, every one of its formats is now
specified (`web/docs/research/72-mp-map-archive-anatomy.md`), and its archive, texture and mesh layers are needed by the
replay viewer whichever way the game itself goes. The spike's verdict is recorded in section 9 when it lands.

## 2. Goals and non-goals

**Goals**
1. Frostfire (MP2), then Desert Glory (MP6), then Crossroads (MP72), render with correct geometry and textures from
   the archives alone, verified against in-game reference captures.
2. Every multiplayer map opens; a map that hits an unknown construct degrades (missing prop, untextured chunk) and
   says so in a diagnostics panel instead of failing.
3. Two asset sources behind one interface: pre-extracted archive files over HTTP (a local test setup), and the player's
   own ISO read in the browser (the shipped stance). The second is designed in now and implemented as its own
   milestone; nothing may assume the first.
4. Collision polygons and the known A/B spawn positions as toggleable overlays.
5. WebGPU rendering with automatic WebGL2 fallback; nothing in the viewer requires WebGPU.
6. Verification that does not need a human: unit tests on the real archives when the disc tree is present (skipped
   otherwise, as the Python suite does), decoded textures and rendered frames checked against reference images.

**Non-goals (this milestone)**
- `AIMAPS.MPS` (AI navigation, spawn regions, minimap). Format unknown; spawns come from the measured table in
  `docs/research/33-online-map-coverage.md` until it is decoded.
- Character models (`CLIB_MDL`, a different chain form), animation, weapons, HUD, audio, replay, networking.
- GS-accurate rendering (alpha test order, dithering, texture-function quirks, fog, depth precision).
- The full-game wasm build. Its findings are recorded, not built, here.

## 3. Architecture

Everything lives under `web/` in the repository, one npm workspace, TypeScript throughout, Vite for the app, vitest
for tests, Playwright for rendered-frame checks. No game data is committed: `web/public/maps/` and
`web/test-fixtures/` are git-ignored and populated by a script from the owner's disc tree.

The tree below is the built one (corrected 2026-09-21; the plan's `packages/mesh/src/packet.ts` was never
written -- its work is `vif.ts` and `interpret.ts` -- and `meshData.ts`, `paletteTable.ts`, `node.ts` and
`world.ts` were added as the packages landed).

```
web/
  package.json            workspace root: vite, vitest, typescript, playwright, three
  README.md               how to run it: prerequisites, the commands, the known gaps
  packages/
    archive/              ZDB, ZAR/ZED, compiled .rdr readers; ISO9660 reader; AssetSource interface
      src/{bytes,zdb,zar,rdr,assetSource,fsAssetSource,httpAssetSource,mapIndex,node,index}.ts
    gs/                   GS texture and palette decode (PSMT8, PSMCT16, PSMCT32); CLUT handling
      src/{tex0,texture,palette,paletteTable,decode,index}.ts
    mesh/                 DMA-chain walker, VIF1 unpack, vertex-lane interpretation -> MeshData
      src/{dma,vif,interpret,meshData,index}.ts, SEMANTICS.md
    scene/                world root, scene graph, clutter, collision -> a SceneDescription
      src/{worldRoot,sceneGraph,modelLibrary,clutter,collision,spawns,buildScene,index}.ts
    viewer/               the Vite app: three.js renderer, camera, UI, overlays, diagnostics
      src/{main,renderer,camera,ui,worker,loadMap,overlays,world,hook}.ts, e2e/viewer.spec.ts
  tools/
    extract-maps.ts       disc tree -> web/public/maps/RUN/*.ZDB + index.json (testing source)
    dump-textures.ts      every texture of one map to PNG, both orders, plus contact sheets
    export-gltf.ts        map -> glTF (debugging aid and golden generator); gltf.ts, png.ts are its writers
  test-fixtures/          git-ignored: copies of MP2/MP6/MP72 archives, reference PNGs, screenshots
```

Dependency direction is strictly downward: `viewer -> scene -> mesh, gs -> archive`. `archive`, `gs`, `mesh` and
`scene` have no DOM or three.js dependency and run under node for tests and tools.

### 3.1 `archive`
- `AssetSource`: `list(): Promise<string[]>` and `read(path): Promise<Uint8Array>` for disc paths like
  `RUN/MP2.ZDB`. Two implementations: `HttpAssetSource` (fetches from `/maps/...`, the testing source) and
  `IsoAssetSource` (a `File`/`Blob` from the File System Access API or drag-and-drop, parsed as ISO9660 from the
  primary volume descriptor at sector 16, path table walked lazily, reads by LBN; `tools_py/iso_lbn.py` is the
  reference). Both return the same bytes for the same path.
- `Zdb`: header at 0xA0, count at 0x98, 92-byte entries, absolute 2048-aligned offsets; `entries`, `get(name)`.
- `Zar`: the v2 layout (100-byte head, string table, 16-byte pre-order keys, aligned data blob); `root`, `find(path)`,
  `data(key)`. Offsets are relative to the data blob. Parsing consumes exactly `key_count` records or throws.
- `Rdr`: the compiled S-expression form (version 1 header, string table, 8-byte nodes) to a nested array/string
  tree; used for `mission.rdr` (name), `mp<N>.rdr` (world params), `mp<N>_lib.rdr` (texture wrap and detail
  bindings).
- `MapIndex`: given an `AssetSource`, lists the 22 MP archives and their display names (from `mission.rdr`).

### 3.2 `gs`
- `TextureRecord` from a `texdat` blob: the 16-byte `TEXTURE_PARAMS`, pixel bytes, and the 9-quadword bind packet;
  the `TEX0` quadword is decoded for `PSM`, `CBP`, `CPSM`, `TW`, `TH`.
- `PaletteRecord` from `par` + `buf`: `gsaddr`, format (CT16 or CT32), 256 entries.
- `decodeTexture(tex, palettes) -> RGBA8 ImageData` for PSMT8 with either palette format, PSMCT16 and PSMCT32
  direct. PS2 alpha (0..0x80) is scaled to 0..255. The two open questions from `web/docs/research/72` (raster versus
  swizzled pixel order; the 32-entry CLUT interleave for 8-bit palettes) are settled empirically in milestone 2 by
  decoding known textures and looking, with the runtime's `ps2_gs_psmt8.h` and `ps2_gs_psmct32.h` as the reference
  for the swizzle if the raster reading is wrong. The decision and its evidence go into this spec's section 9.
- `PaletteTable`: one id-to-palette map over every `*_PAL.ZED` the map loads (ids are global across archives).

### 3.3 `mesh`
- `walkChains(buffer, nodeOffsets) -> Chain[]`: count quadword then N DMA tags; relocation type from tag bits
  16-23; `ADDR` as a byte offset into the same buffer; type 6 is a texture name.
- `unpackVif(chain) -> VifBlock[]`: only NOP, STCYCL, UNPACK, MSCAL, MSCNT; the five UNPACK formats
  (V4-32, V4-16, V4-8 unsigned, V3-16, all `FLG=1`) with STCYCL skipping-write. Anything else throws with the
  offending code, and the viewer reports it per chunk.
- `interpretPacket(blocks) -> MeshData`: positions, UVs, normals, colours, and the triangle order, from the VU1
  family-B semantics. This is the milestone with a real unknown (the fixed-point scale and lane meaning of the
  V4-16 pairs and the V3-16 block, and the strip or fan order the header quadword implies). The authority is the
  translated microprogram `vu/generated/vu1_d418194495c25213.cpp` and `docs/research/13`, `15`; the check is
  `tools_py/research/terrain/patch_dump.py` against a family-B dump, and the rendered Frostfire world against
  `logs/parity/*/refs/map_frostfire.png` and the mission captures.
- `MeshData` is plain typed arrays with a texture name per sub-mesh, so `viewer` builds `BufferGeometry` from it
  without knowing anything about the PS2.

### 3.4 `scene`
- `WorldRoot` from `MP<N>.ZED`: lighting, `MetersPerUnit`, `ShadowVector`, `grid_params`.
- `SceneGraph` from `MP<N>_GEO.ZED`: prototypes, instances (`model_name` + `nparams` matrix), `children`, and the
  `di` collision polygons (12-byte params, `CPnt4D` points) per model.
- `ModelLibrary` from `WORL_MDL.ZED`, `MP<N>_MDL.ZED`, `FLIB_MDL.ZED`: model name to chain buffer and node
  offsets; `worldmodel` is the world.
- `Clutter` from `CLUTTER.ZAR`: model name, 96-byte matrix, inverse scale per instance.
- `SceneDescription`: world mesh, prop instances with world matrices, collision polygons in world space, spawn
  markers (from the measured table), and a diagnostics list of everything that failed to decode.

### 3.5 `viewer`
- three.js `WebGPURenderer` with its WebGL2 fallback; one `Group` per model prototype instanced by matrix; textures
  as `DataTexture` from `gs`, nearest or linear per the record's `m_bilinear`, wrap from `mp<N>_lib.rdr`.
- Fly camera (WASD + mouse, plus touch), map picker listing the 22 maps, toggles for collision, spawns, wireframe,
  and untextured chunks; a diagnostics panel listing decode failures; a coordinate readout in game units and metres
  (`MetersPerUnit`) so positions can be compared with the research tables.
- Asset source chooser: the served `/maps/` index by default when present; an "Open ISO" button that takes the
  player's disc image and uses `IsoAssetSource`. The ISO never leaves the browser.
- Everything renders at any window size; a phone can open it, but the target is a desktop browser.

## 4. Data flow

```
AssetSource.read("RUN/MP2.ZDB") -> Zdb -> member blobs
  MP2.ZED         -> WorldRoot
  MP2_GEO.ZED     -> SceneGraph (+ collision)
  WORL_MDL.ZED,
  MP2_MDL.ZED,
  FLIB_MDL.ZED    -> ModelLibrary -> walkChains -> unpackVif -> interpretPacket -> MeshData per model
  MP2_TXR.ZED,
  *_PAL.ZED       -> PaletteTable, TextureRecords -> decodeTexture -> RGBA
  CLUTTER.ZAR     -> Clutter
  READERM.ZAR     -> Rdr(mission, mp2, mp2_lib)
                  => SceneDescription => three.js scene
```

Decoding runs in a Web Worker so a 12 MB archive does not freeze the page; the main thread receives transferable
typed arrays. Per-map work is small (Frostfire's world is 485 KB of chains and 651 KB of textures), so the first
paint is expected well under a second after the archive is in memory.

## 5. Verification

- **Unit tests (vitest, node)** for every reader against synthetic buffers, and against the real archives when
  `web/test-fixtures/` is populated: member counts, key counts (MP2_GEO 10,433; MP2_TXR palettes 53; MP2 world 123
  chunks), zero VIF decode errors on all five dumped maps, `m_ptcount == points/16` for every collision polygon. Tests
  skip with a clear message when the fixtures are absent, so a fresh clone is green.
- **Texture goldens**: a decoded PNG per Frostfire texture written by a tool; the first pass is looked at by the
  implementing agent (the Read tool renders images) and the chosen decode is then frozen as a golden hash.
- **Mesh goldens**: Frostfire's world exported to glTF, its bounding box compared with `grid_params` and the known
  spawn positions (both spawns must lie inside the world's box and near its ground), and a Playwright screenshot of
  the viewer compared by eye against the in-game reference; then frozen as an image-diff golden with a tolerance.
- **App smoke**: Playwright opens the viewer, loads each of the three priority maps from the served source, asserts
  zero diagnostics and a non-empty draw call count.
- Nothing here launches the game, takes the loop lock, or exceeds a few cores.

## 6. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold | `web/` workspace builds and tests green on a clone with no fixtures; `extract-maps` populates fixtures and `public/maps` from the disc tree; CI-style `npm test` documented. |
| M1 | Archive layer | ZDB, ZAR, Rdr, MapIndex pass real-archive tests; the 22-map name table is produced by code, not typed. |
| M2 | Textures | Every Frostfire texture decodes to a PNG that looks right; the swizzle and CLUT questions are answered in section 9; goldens frozen. |
| M3 | World mesh | Frostfire's `worldmodel` renders textured in the viewer and matches the reference by eye; vertex semantics documented in section 9; glTF export works. |
| M4 | Scene | Props placed from the scene graph, collision and spawn overlays, diagnostics panel; Desert Glory (clutter) and Crossroads render. |
| M5 | ISO source | `IsoAssetSource` reads a real ISO in the browser and produces identical bytes to the served source (tested with a hash per member). |
| M6 | All maps | Every one of the 22 MP archives opens; failures are listed, not fatal. |

M0 to M3 are tonight's target; M4 if time allows. Each milestone is a commit or a short series on
`feat/web-map-viewer`, worktree `C:\projects\socom_pc_web`, never touching the tree the sprint-9 agent uses.

## 7. Conventions

- Branch `feat/web-map-viewer` off `main`, per `docs/GIT_STRATEGY.md`; commits with explicit pathspecs and the
  project's subject style; the session's trailer on every commit. No push overnight; the owner sees the branch first.
- No game data committed. `.gitignore` gains `web/node_modules/`, `web/dist/`, `web/public/maps/`,
  `web/test-fixtures/`, `web/**/playwright-report/`.
- TypeScript strict; no `any` in the decoders; every binary layout is a documented `DataView` reader with the byte
  offsets in comments citing `web/docs/research/72`.
- Third-party: three.js (MIT), Vite, vitest, Playwright. Nothing GPL enters `web/` (the runtime is GPL-3.0 and
  stays a reference, not a dependency, for this milestone).

## 8. Risks

| Risk | Mitigation |
|---|---|
| Vertex-lane semantics wrong (positions scaled, UVs swapped, strip order) | The VU1 translation is the authority; verify against a terrain dump and the reference capture before building on it; keep `interpretPacket` isolated so a fix does not ripple. |
| Texture byte order is GS-swizzled | Decode both ways in M2; the runtime's swizzlers exist for the second reading. |
| A map uses a VIF or DMA construct the five dumps did not show | The unpacker throws per chunk; the viewer degrades and reports; M6 sweeps all 22. |
| three.js WebGPU renderer quirks | The WebGL2 fallback is automatic; the viewer needs nothing WebGPU-specific. |
| Overnight host load disturbs the sprint-9 agent | Node and vitest only; Playwright headless for seconds at a time; no parallel native compiles beyond the spike's idle-priority job. |

## 9. Findings recorded during implementation

Filled in as milestones close. Each entry: date, what was decided, the evidence.

- 2026-09-20, route: viewer-first tonight; full-game route pending the code-diet spike (interim: the
  program-counter-store diet shrank native objects 1.4 percent, so the size lever is elsewhere; wasm-to-native
  ratio and full compile pending).
- 2026-09-20, M2 texture bytes: Frostfire's pixels are **raster**, and its 8-bit palettes **are** in the GS
  `csm1` CLUT order. Evidence: `tools/dump-textures.ts` decoded all 65 MP2 textures four ways into
  `web/test-fixtures/textures/MP2/` and I looked at the contact sheets. `sheet-raster.png` is diamond plate,
  concrete, shipping containers and readable signage; `sheet-swizzled.png` is the same bytes as 16x16 block
  hash. The decisive texture is `sign04.tif`: raster it reads "DANGER / FLAMMABLE LIQUID", swizzled it is
  red-and-white noise. For the CLUT, `sheet-raster.png` against `sheet-raster-linear-clut.png`:
  `cuba1a_sky01.tif` is a smooth cloud sky with the 32-entry swap undone and a hard-banded contour map
  without it. `decodeTexture` defaults to `'raster'` and `'csm1'`, keeps both other readings reachable as
  arguments, and its 65 decodes are frozen as sha256-16 goldens in
  `packages/gs/test/goldens/frostfire-textures.json`. Two asides the dump settled for free: all 65 records
  carry a usable TEX0 and every CBP names a loaded palette (no diagnostic fired on Frostfire), and the rows
  are stored bottom-up, so the viewer flips V rather than the decoder flipping rows (superseded by
  the M3 entry: bottom-up rows with `flipY = false` need no extra flip, because that is already
  what GL calls V = 0).
- 2026-09-20, M2 shape: `decodeTexture` returns `{ rgba, diagnostics: string[] }`, not a bare `Rgba`. A record
  with no TEX0 in its bind packet, or a CBP no loaded palette answers, still decodes -- by `m_texelBitSize`
  and by the first palette -- and says so in a string, so the viewer reports a bad texture instead of the
  decoder throwing mid-map.
- 2026-09-20, M3 viewer: Frostfire renders in the browser from the served archive alone, and the two
  screenshots say it is the right map. `frostfire-spawnA.png` (camera at spawn A raised 20 units, looking
  at spawn B) is the industrial compound: corrugated warehouse walls with their ribs vertical, yellow
  handrails on the walkway, rusted elbow pipes, a wet concrete yard, an overcast sky. `frostfire-top.png`
  (straight down from y = 1400 over the spawn midpoint) is a level-shaped footprint -- roofs, two round
  tanks, a container yard, a stair tower -- inside the dark disc of the sky chunk's underside, with the
  distant skirt beyond it. 8,764 triangles in 37 draws (one per cited texture), 53-69 ms to decode the
  8 MB archive, zero diagnostics, zero console errors.
  - **Texture orientation, settled by looking:** the decoder's bottom-up rows are exactly GL's V = 0, so
    the viewer uses `DataTexture` with `flipY = false` and the UVs `interpret.ts` produces, unflipped.
    Nothing is mirrored or rotated in either screenshot -- signage, ribbing and railings all read the
    right way up on the first try, so neither the V flip nor a UV-axis fix was needed.
  - **Vertex colour:** the PS2 writes 128 as full brightness, which a normalised three.js byte attribute
    reads as 0.5; the viewer doubles the three colour bytes (clamped) when it builds the attribute, and
    the map is lit as the reference is rather than at half light. `mesh` had already rescaled alpha.
  - **Placement:** the whole world takes the modal `nparams` translation, read from
    `MP*_GEO.ZED/models/worldmodel/children` at load time rather than typed in -- (960, 0, 800) on
    Frostfire (section 8 of `mesh/SEMANTICS.md`). Standing at spawn A the camera is on the floor, not in
    it, which is the same check the mesh tests make, now made by eye.
  - **Backend:** the renderer is three's `WebGPURenderer` from `three/webgpu`, which bundles under Vite
    without special handling; headless chromium has no adapter, so both screenshots were drawn by its
    **WebGL2 fallback** over ANGLE/SwiftShader (`--enable-unsafe-swiftshader`). The status line reports
    whichever backend `renderer.backend.isWebGPUBackend` names, so a desktop browser saying `webgpu` is
    the same build.
  - **Decode thread:** the archive read, VIF walk and texture decode run in a module Web Worker and come
    back in the transfer list, so nothing is copied and the frame loop never stalls.
- 2026-09-20, M3 review round 1: three findings fixed on top of M4's scene-graph landing. A bad DMA
  chain now costs one chunk, not the map -- the walk happens inside `decoder`'s per-chunk `try` (M4 had
  already moved it there; the same guard was extended to the model archives and to the texture archive,
  so an unreadable `MP*_TXR.ZED` leaves a map drawn in vertex colour rather than no map at all). The
  viewer package joined `npm run typecheck`, appended as `tsc --noEmit -p packages/viewer` because its
  config is `noEmit` and `tsc -b` will not take it. And every worker request now carries a monotonic id
  its answer repeats, so the boot auto-load and the map the player picks a moment later cannot land out
  of order -- the page drops any answer that is not the one it is still waiting for.
- 2026-09-20, M4 close: **all three extracted maps render**, with the collision hull, the measured
  spawns and a diagnostics panel over them. Playwright drove one pass over the three, selecting each by
  the name `mission.rdr` shows, and photographed each from its own spawn A and from 800 units above the
  midpoint of its two spawns:

  | map | triangles | draws | collision polys | diagnostics | load |
  |---|---|---|---|---|---|
  | FROSTFIRE (MP2) | 16,931 | 152 | 3,338 | **0** | 59-78 ms |
  | DESERT GLORY (MP6) | 27,311 | 439 | 5,951 | 6 | 88-113 ms |
  | CROSSROADS (MP72) | 44,279 | 392 | 9,820 | 11 | 104-136 ms |

  What the pictures show. `desert-glory-spawnA.png`: a rock-walled wadi in low sun, the eroded rock
  faces textured and lit, a walled compound and a telegraph pole in the middle distance, an overcast
  sky dome over it. `desert-glory-top.png`: hillside terrain with flat-roofed buildings, a wooden
  walkway, a parked truck and stair flights standing on the ground, not floating over it.
  `crossroads-spawnA.png`: spawn A is **indoors** -- a dark plastered room with a doorway on the right
  opening onto a cobbled street, which is a dull picture but the correct position. `crossroads-top.png`
  is the map that picture belongs to: a north-African town of red-tiled roofs around a square with a
  red-tiled rotunda at its centre, market stalls under awnings, and palms, all placed. `frostfire-overlays.png` is the same
  camera as `frostfire-top.png` with collision and spawns switched on: the hull traces every deck,
  crate, tank and railing of the rig in green (`ditype` 2) and pink (`ditype` 3), and the two spawns
  stand where the sweep measured them: A's blue sphere among the shipping containers under its letter,
  and B's letter over the enclosed deck at the far end, its sphere hidden by the roof above it -- the
  markers are depth-tested, so they sit in the world rather than floating over it, while the letters are
  not, so a spawn is never lost. Nothing is at the origin and nothing floats.

  **The MP6/MP72 chain gap (M6's first work item).** Every diagnostic on the two new maps is one of two
  causes. Five prop chains on Desert Glory and six on Crossroads fail in the `mesh` packet decoder --
  the counted totals are 15 and 29 chains, which the viewer collapses to one line per model-node
  because it decodes a prop group's geometry once. The messages, verbatim:

  ```
  chunk mp6_pole_lines/N000_I000_V00: chunk N000_I000_V00 packet 1: the header claims 2760716326
    triangles from TOP+0 reaching TOP+5521432652, past the 1024 quadwords of VU data memory
  chunk mp6_light_hangout/N000_I000_V00: chunk N000_I000_V00 packet 1: the header claims 1085931520
    vertices reaching TOP+3257794564, past the 1024 quadwords of VU data memory
  chunk tent_beige/N000_I000_V01: chunk N000_I000_V01 packet 2: the header claims 3210739712
    vertices reaching TOP+9632219140, past the 1024 quadwords of VU data memory
  chunk light_bright/N000_I000_V03: chunk N000_I000_V03 packet 1: the header claims 3222274048
    vertices reaching TOP+9666822148, past the 1024 quadwords of VU data memory
  ```

  **[SUPERSEDED 2026-09-20 -- see "Relocation type 1 is LINE_STRIP" below. The walker was never
  wrong; these packets are not meshes.]**

  The counts are the tell: 1040187392 is `0x3E000000`, 3212836864 is `0xBF800000`, 3222274048 is
  `0xC0080000` -- IEEE floats 0.125, -1.0 and -2.125. The decoder is reading vertex floats where it
  expects a packet header, so it entered the packet at the wrong offset rather than misreading a
  header: the chain walk is landing in the middle of the data, which is what 36 section 3's
  relocation-type-1 tags on these two maps predict. The scene package's naming test already rules out
  a placement cause -- every one of the 203 models of the three maps has exactly the key set the N-I-V
  rule predicts. It is a `mesh` gap, and it is not touched here.

  The second cause is textures a map's own `TXR` does not hold: `null_xmas.bmp` on both maps, and
  `afghan2r_rug1..3.tif` and `afghan2r_rug_trim.tif` on Crossroads. The `afghan2r_` prefix is Desert
  Glory's texture family, so these are `FLIB_MDL.ZED` models carrying another mission's texture names;
  where those pixels live is the other M6 question. Those meshes draw in vertex colour, and the
  **highlight untextured** toggle paints them magenta so they can be found: 0 such draws on Frostfire,
  2 on Desert Glory, 6 on Crossroads.

  Three decisions worth keeping. **Spawns are code, not archive** -- `@s2u/scene`'s `spawns.ts` holds
  all 22 maps' measured A/B positions keyed by shown name, with a header saying they are actor readings
  pending `AIMAPS.MPS`; the viewer looks a map up by `mission.rdr`'s name, so the camera stands at spawn
  A on every map, not just Frostfire. **Collision is realised, not stored** -- Frostfire's 2,756 stored
  polygons become 3,338 world-space ones, because an instanced prototype's hull is realised once per
  context, exactly as its chunks are. **`CLUTTER.ZAR` is a second placement root** -- its six Desert
  Glory models are in the scene graph as prototypes that nothing instances from `worldmodel`, so
  `placeInstances` never reaches them; reading the archive adds 110 instances and 1,601 triangles of
  rock and grass that were missing from the ground before.

- 2026-09-21, the code-diet spike's verdict (web/docs/research/71 §1.7): the whole recompiled game is 180.27 MB of
  wasm, 13.7 MB brotli on the wire, and Chromium compiles it in 0.2 s lazily; the size gate on the full-game route
  is open. The viewer route's archive, texture, mesh and scene layers stand as the asset side of that route and of
  the replay viewer. The next design decision is the runtime port (Emscripten: scheduler, GS, VU1, disc delivery),
  which is its own spec.

### Relocation type 1 is `LINE_STRIP`, not a broken walk (2026-09-20)

**Supersedes** the M4-close finding above, which read the absurd vertex counts as the chain walk
entering a packet at the wrong offset. It was not. `dma.ts` needed no change and the offsets were
always right.

A type-1 tag is written byte for byte like a type-2 tag, and `CVisual::SetBuffer`
(`research/recom/src/gamez/zVisual/vis_main.cpp:320-366`) patches types 1, 2, 4 and 7 through the
identical arm. What differs is the **packet**: relocation type 1 marks a GS `LINE_STRIP`. All 194 of
them across the three maps carry `PRIM` type 2 in *both* GIFtag templates (bits 47-57 of the tag), and
no other packet in any map has prim type 2. Tag counts: 31 in MP6, 163 in MP72, 0 in MP2.

The layout is `SEMANTICS` section 4's vertex triple lane for lane, already in floats, with no index
list, no face normal and no `TOP+3` bias: `TOP+0`/`TOP+1` are the templates, then per point a
`V4-32` float `(x, y, z, normal.x)`, a `V4-32` float `(u, v, normal.y, normal.z)` and a `V4-8 USN`
rgba. Point counts run 2 to 9; segment *k* joins point *k* to *k+1*. The mesh decoder was reading
point 0's float position as the counts quadword, which is where `1124466688` came from: `0x43070000`,
the float 135.0.

What they are: Desert Glory's power lines, lamp brackets and handcuff chains; Crossroads' tent guy
ropes and light filaments. 877 segments over 1,071 points in total. **No triangles were ever lost** --
the failing chunks hold only strips, which is why fixing this moved no triangle count. They are decoded
as `LineStrip` and drawn as one `LineSegments` pass; the GS draws them one pixel wide at any distance,
so no width had to be invented.

Diagnostics after: Frostfire 0, Desert Glory 6 -> 1, Crossroads 11 -> 5. Every remaining one is the
second cause already recorded above -- five textures a map cites but its own `_TXR.ZED` does not hold:
`null_xmas.bmp` (MP6) and `afghan2r_rug1..3.tif` plus `afghan2r_rug_trim.tif` (MP72).

### 128 is unity on RGB, not 255 (2026-09-20)

An intermediate change divided RGB by 255 and alpha by 128, on a reading of section 4's "`rgb/255` and
`a/128` are the browser values". That was wrong and made the pipeline 1.992x dark. Every texture in the
three maps binds `TEX0.TFX = MODULATE` -- 241 of 241 TEX0 register writes (`TEX0_1` and `TEX0_2`) over
the 240 textures research/72 counts, measured with `web/tools/dump-bindpacket.ts` --
and MODULATE is `C = (Ct x Cf) >> 7`, so **128 is unity on every lane**. RGB is now `c/128`, unclamped
(the GS clamps the product, not the vertex); alpha is `min(c/128, 1)`. `SEMANTICS` sections 4 and 11
carry the correction.

The vertex colour is a **material** colour, not a lit one: the VU multiplies it by a computed light
before the GS sees it (`staging+1 = record2 * lit`, NAT:1615). Measured over the three maps it averages
0.29 of unity and never exceeds it. The viewer emulates the VU's own model in
`viewer/src/lighting.ts` -- `lit = light[0]*n.x + light[1]*n.y + light[2]*n.z + light[3]` with the
normal clamped componentwise to zero, from dispatcher command `0x18` -> `0x1440` -- using the vertex
normals, which were decoded and then discarded until now. The *values* it needs (the normal/light
matrix in vf5-vf7, the colour block in vf9-vf12) are uploaded by the EE at VU1 entry 0 and are not on
the disc, so the matrix is taken as identity and the four colours are sliders.

### Fog is per map, in `cameras/camera` (2026-09-20)

Not in `mission.rdr`. `MP<N>.ZDB` -> member `MP<N>.ZED` -> ZAR key `cameras/camera`, a 144-byte
`zdb::tag_CAMERA_PARAMS` (`research/recom/src/gamez/zCamera/zcam.h:67-101`): fog RGBA at `0x10` (floats
0..1, always exact n/255), `fog_near`/`fog_far` at `0x64`/`0x68`, `fog_top`/`fog_bottom` at
`0x7C`/`0x80`, flags u32 at `0x8C` with bit 29 fog-enabled, bit 30 directional, bit 31 altitude. The
authored source is readable beside it as text in `READERM.ZAR -> mp<N>.rdr`.

The coefficient is `F = clamp(w * scale + offset, 0, 255)` with `scale = -255/(far-near)` and
`offset = 255 - near*scale`, where `w` is **view depth**, not radial distance -- the radial form in
`sub_002948D0` is the EE's own mirror for CPU-side object fades. The GS blends
`C = (F*C)>>8 + ((255-F)*FOGCOL)>>8`. The framebuffer clears to the fog colour
(`reCOM zrndr_pipe.cpp:157`), so the horizon comes free and there is no separate sky colour.

Two of the 22 multiplayer maps ship fog disabled (MP51, MP81) and six enable altitude fog (MP1, MP7,
MP10, MP62, MP64, MP82). The altitude band is parsed and **not applied** -- no VU1 dump exists from a
map that enables it, so its encoding is the one inferred part of the model -- and a map that enables it
says so in the diagnostics panel.

### The texture pixels start at 32, not 16, and the goldens were regenerated (2026-09-21)

Beside the raster/CLUT decisions above, and not caught by them.

One quadword of the texture's GIF upload packet sits between `TEXTURE_PARAMS` and the texels, so
`parseTextureRecord` was reading 16 bytes of it as image and every texture in the viewer was
shifted -- four texels at 32bpp, sixteen at 8bpp. research/72 section 5 carries the measurement and
the dated retraction of "pixel data follows the header immediately".

The bytes are `08 00 00 00  00 00 00 00  AF AF AF AF  AF AF AF AF`, byte-identical in 83 of 83
direct 32bpp textures across the 22 maps and 53 of 53 palettised textures in MP2
(`web/tools/probe-head.ts`). reCOM names the block only through `texGifPtr`
(`zTexture/ztex_main.cpp:76-79`), whose `m_buffer = &texGifPtr[1]` is `texdat + 16` -- the packet,
not the pixels. No struct for the quadword exists in `zTexture/`; read as a GIFtag it gives
`NLOOP = 8` with an `0xAF` fill where `REGS` would be, which fits a tag patched at upload.

**Why this was not caught earlier.** A 16-byte shift is a fraction of one row, so the M2 contact
sheets -- which settled raster-vs-swizzled and csm1-vs-linear by eye -- looked right either way. It
only became visible on a 32x32 lamp flare, where the four stray texels land on the top edge as two
fully opaque dots and drew the glow as a square with a bright corner.

**The goldens were regenerated, deliberately.** `packages/gs/test/goldens/frostfire-textures.json`
holds sha256 hashes of the decoded RGBA: a regression guard that pinned the old offset rather than
evidence that it was right. All 65 Frostfire textures still decode with zero diagnostics, and the
rendered map was checked before the hashes were replaced. The synthetic record in
`packages/gs/test/records.test.ts` now carries the prefix so its bind packet sits where a real
record puts it.

**The palettes are not affected.** `zTexture/ztex_palette.cpp:29-30` fetches `buf` straight into
`m_buffer` with no prefix, and the CLUT path is unchanged. The `csm1` swap was checked and ruled
out as the cause first: the three glow textures are 32bpp direct PSMCT32 with no CLUT at all.

## Crossroads' awning was a plaid, and the reason is that the hardware culls

2026-09-20. The market awning on Crossroads' raised platform drew as a red-and-green plaid with a
ragged staircase along its lower edge, nothing like the smooth striped canvas of the PS2 capture.
Two guesses were on the table: coplanar layers resolved by draw order, or minification aliasing.
Both were tested at one pose (camera `1860,130,1930`, yaw 39, pitch -19, map CROSSROADS).

**It is not aliasing.** `generateMipmaps = true` with `LinearMipmapLinearFilter` visibly cleaned up
the floor tiles and the rugs at that pose and left the awning's plaid exactly as it was. Mipmaps
were reverted; they are a separate question.

**It is coincident geometry, and it is in the data.** `tent_red`'s chunk `N000_I000_V00` holds four
meshes, two of them on `awning_redstripe.tif`: one of 42 triangles and one of 10. Hiding them one
at a time (`web/tools/zz-isolate.ts` against a temporarily exposed scene) showed the 10-triangle
mesh drawing a clean bright canvas and the 42-triangle mesh drawing a dark one over the same five
quads. Dumping the pair confirms it exactly:

- the same five quads, corner for corner (`25.8/38.1/0.8`, `22.8/38.1/-49.2`, ...), triangulated on
  opposite diagonals -- which is why a triangle-identity test found no duplicates;
- the same texels: the two UV sets differ by exactly `+2.0` in `u`, and the sampler repeats;
- **opposite normals**, each mesh consistently wound against its own;
- and different baked light: mean vertex colour 0.6 on one, 0.2 on the other.

That is a two-sided canvas drawn as two coincident single-sided sheets, a top and an underside,
which is a thing an artist draws only when the hardware culls back faces. Drawn double-sided, the
two sheets z-fight and the canvas comes out as a plaid of top and underside.

**The fix.** SEMANTICS section 6 had already established counter-clockwise = front against the
stored normals, and VU1's cull handler `0x06` (research/13 section 4.2) keeps a triangle when the
eye is on the normal's side. So `FrontSide` is the hardware's behaviour -- but only for the objects
whose command list carries the cull, and that list is built by the EE per draw, not stored on the
disc (a no-cull variant of the world-object program exists: research/12, program 11).

A sweep of all 22 maps from both spawns at four yaws, culled and not (176 pairs), says what a
blanket cull would cost: Bitter Jungle and Blood Lake lose their canopies and The Mixer loses half
its grass, because a leaf card is a single sheet meant to be seen from behind. So the viewer culls
**where the texture is solid** and keeps both faces where it is not (`isOpaque` in `loadMap.ts`,
pinned by `packages/viewer/test/opaque.test.ts`). With that rule, 155 of the 176 pairs move by less
than 0.5 percent of pixels; what does move is the awning, Death Trap's and The Ruins' interiors --
where you could previously see through a wall into a stairwell -- and Sujo's hangar roof, which
stops hiding its own trusses. No vegetation is lost.

## The clutter records that were not matrices are quaternions, and the engine says which is which

2026-09-20. `CLUTTER.ZAR`'s 96-byte `params` comes in two forms under the same key names and the
same size, which is why Abandoned's instances drew streaks when composed as matrices and were then
refused by `isAffineRowVector`. Both forms are now read. 5,957 instances across the 22 maps, 1,198
matrices and 4,759 of the other form; nothing is refused any more.

**The selector is the engine's own.** `FUN_002d9490` (`recomp/output/FUN_002d9490_0x2d9490.cpp`),
the first call of the per-record clutter reader `sub_002D55C0`, does `lbu $v0, 0x4C($a0)` -- byte
+76 -- isolates bit 1, and returns `record + 0x30` when it is clear or `record + 0x20` when it is
set. That is the position, read either from a matrix's translation row at +48 or from the second
form's own position at +32. The caller takes `.x`/`.z` off the returned pointer for its grid lookup.

**The second form** is a decomposed transform: a `CQuat` rotation at +0 (`x, y, z, w`, not
normalised -- `|q|` runs 0.92 to 1.41), an always-identity second quaternion at +16 (the live bend
slot, written empty at export), the world position at +32, the uniform scale at +44 (equal to
`1 / scale_inverse` to 6e-8 on every record) and the model's `repel max_angle` in radians at +48.
Composed as the transpose of the textbook column-vector quaternion matrix -- everything here
multiplies row vectors on the left -- the basis rows come out orthonormal to 6e-8 and the
determinant is the cube of the scale to 1.4e-7, on all 4,759.

**Why there are two.** The decomposed form is used for exactly the models given
`repel (max_angle ...)` in the map's `clutter.rdr`, 114 of 114: foliage that bends when a player
walks through it, and therefore has to keep its rotation apart from its bend. Sandstorm proves the
rule rather than breaking it -- its `grass_thin`/`grass_thick` appear in two templates, one with
`repel` and one without, and the records split along exactly that line.

**Not settled:** whether the stored quaternion is the rotation or its conjugate. Every template's
`rotation_range` is symmetric and half the records are a pure yaw, so the sense is invisible in the
data; if tilted foliage ever leans the wrong way, negate x/y/z.

**Also: `params` is not a `tag_NODE_PARAMS`,** despite the matching 96 bytes. A real `nparams` has a
coherent bbox at +64 and its flags at +92; the clutter record has its flags at +76 and scratch in
the bbox slot -- 508 records carry ASCII text from an `.rdr` there. The `-1.7014e+38` the old
comment called a sentinel is scratch too.

Per map, by the flag: MP62 Enowapi 1,128 (all decomposed), MP73 Sandstorm 1,142 (759), MP12 The
Ruins 471 (347), MP64 Shadow Falls 482 (473), MP82 Guidance 482 (283), MP10 Blood Lake 439 (424),
MP11 Death Trap 397 (392), MP5 Abandoned 363 (324), MP52 The Mixer 344 (all), MP1 Blizzard 211
(none), MP7 193 (all), MP61 Sujo 103 (none), MP6 Desert Glory 110 (none), MP9 92 (all). The other
eight maps carry no clutter.

## The lighting values are on the disc, and the matrix is not the identity

2026-09-20. `viewer/src/lighting.ts` emulated the VU's `lit` with four sliders, because SEMANTICS
section 9 said the numbers behind it were EE state and nowhere on a disc. Both halves of that were
wrong.

**The matrix holds light directions in its columns.** Read against a live VU1 capture of mission
M51, `vf5`-`vf7` are not an identity and not three axis lights: the VU computes
`normal.x = vf5.x*n.x + vf6.x*n.y + vf7.x*n.z`, which is `dot(column0, n)`, so the three columns are
three unit light directions and

```
lit = C0*max(dot(D0,N),0) + C1*max(dot(D1,N),0) + C2*max(dot(D2,N),0) + ambient
```

**The numbers are map data.** `MP*.ZED` carries a 112-byte `GlobalLighting` key on all 34 maps --
`struct _globalLight { CPnt4D dir[3]; CPnt4D col[3]; CPnt4D ambient; }` (`zNode/znode.h:66`), fetched
by name at `node_saveload.cpp:289`. Applying `Dk = -normalize(dir[k])` and taking the colours
verbatim reproduces the captured VU1 quadwords 16 to 23 **bit-exactly, all 32 float words including
the sign of zero**, and only `M51.ZDB`'s record does -- so the derivation is a fingerprint, not a
coincidence. The title screen and lobby capture a different rig, which is `RUN/UI/UI.ZED`'s own
record byte for byte: the shell is just another world. `sub_0031EE00` is the EE routine that does
it (negate, normalise, store as rows, transpose in place), gated on dirty bytes that only map load
sets, which is why the rig is static per map.

`params.y`/`params.z` are 0.0 or 1.0 across 900 captured dumps -- a lighting enable, not a scale --
so there is no hardware gain.

**What the rig fixes.** The old sliders were fitted against a PS2 capture of Frostfire that showed a
vertical wall *brighter* than the up-facing ground (ground 67.8, right wall 95.9), and three axis
lights plus an ambient could not produce that: the fit reached a wall/ground ratio of 0.29. The rig
gives 1.73 against the capture's 1.41, on the first try, because Frostfire's key light is nearly
horizontal (`D0 = (0.81, 0.20, -0.55)` at colour 0.627) with a bounce fill from below and a
near-black top light.

**What it does not fix, and this is the honest part.** The magnitude is about eight times short. At
the sweep pose the rig alone reads ground 7.0 and wall 12.1 where the capture reads 67.8 and 95.9;
at 8x they read 54.9 and 96.7 -- the wall within one percent, the ground nineteen percent low -- and
the two surfaces bracket the true figure between 8 and 10. The viewer takes 8, as `LIT_SCALE`,
because it is a power of two and so the only candidate with a mechanical explanation rather than a
fitted one, and it is carried in the exposure slider so that setting it to 1.00x shows the bare
model. Where the missing shift is has not been found; the obvious suspect, the normal's `ITOF15`, is
ruled out by SEMANTICS section 4, which cites it to the microcode and measures 15,054 of 15,071
Frostfire normals as unit length at `/32768`.

The four sliders are now two trims: an additive ambient, and the exposure. `tools/light-sweep.ts`,
which existed to fit the four, is deleted.

## The map-switch stall was one frame, and it was the first one that drew the map

2026-09-20. Switching maps froze the page. Instrumenting the whole path — the fetch inside the
worker, the decode, the handoff across the boundary, `show()` on the main thread, and then the first
animation frame after it — put the cost somewhere none of the guesses had it:

| | Frostfire | Desert Glory | Crossroads |
|---|---|---|---|
| fetch (warm cache, localhost) | 31 ms | 50 ms | 51 ms |
| worker decode | 44 ms | 80 ms | 94 ms |
| handoff (transfer, no copy) | 13 ms | 27 ms | 12 ms |
| `show()` incl. `buildWorld` | 14 ms | 14 ms | 15 ms |
| **first frame after it** | **633 ms** | **1,581 ms** | **1,703 ms** |
| asked to painted | 892 ms | 2,129 ms | 2,319 ms |

Everything before the last row is off the main thread or too small to see. The last row is three.js
uploading every texture and geometry and compiling every program, which it does the first time an
object is drawn — so adding a whole map's 200-600 draws at once puts all of it in one frame.

**The fix is to hand the objects over a few per frame.** `buildWorld` no longer adds anything to its
group; it returns two queues, the world's meshes and then the props, and `viewer/src/scheduler.ts`
adds them across frames. The previous map stays in the scene until the new one's first meshes land,
so the swap happens between two drawn maps rather than through a blank frame, and it is disposed only
then. The collision hull is held as arrays and built the first time the checkbox asks for it.

**The budget had to be a count, not a clock, and that is worth recording.** The first attempt paced
the work with a time budget and changed nothing: `group.add` costs about a hundredth of a millisecond,
all 37 of Frostfire's world meshes ran in one slice, and the next frame was as long as the frame the
change was meant to break up. The cost is not *in* the task, it is in the render that follows it.
Counting objects works because the cost per object is roughly constant.

After, measured the same way, with `long-animation-frame` entries as the stall the player feels:

| | Frostfire | Desert Glory | Crossroads | Blizzard |
|---|---|---|---|---|
| longest frame | none over 50 ms | none | none | none |
| picker to a drawn world | 265 ms | 358 ms | 476 ms | 212 ms |

The page holds 60 fps throughout, including while the archive is being fetched. On a throttled
connection — which is what the public site actually is — the overlay reads "fetching the archive 6%"
against a real denominator, because `HttpAssetSource.read` streams the body and counts bytes against
`Content-Length` when a caller asks for progress.

One knock-on worth knowing: **the status line is now written when the world is on screen**, not when
the map finishes decoding. Everything that waits for a map — the e2e, `map-health`, the screenshot
tools — waits on that line, and writing it early would have handed them a half-drawn map to
photograph.
