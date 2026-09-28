# SOCOM Unzipped map viewer — SOCOM II's multiplayer maps, decoded from the disc and drawn in a browser

Goal: every SOCOM II: U.S. Navy SEALs multiplayer map, read byte for byte out of the game's own
`RUN/MP*.ZDB` archives — container, scene graph, DMA/VIF geometry, GS textures and palettes, lighting,
fog, collision — and drawn again with three.js as close to the console's own picture as a browser
allows, without emulating the game. Nothing is pre-baked and no asset is committed; **you supply your
own disc**. It runs at [socomunzipped.com/map-viewer](https://socomunzipped.com/map-viewer/).

It is a spin-off of [**SOCOM Unzipped**](../README.md), the static recompilation of the game for PC,
and lives in that repository's `web/` directory as **a separate project**: its own npm workspace,
tests, docs and CI, building alone and deploying as a static site. It needs nothing from the
recompilation and the recompilation needs nothing from it (see
[What the viewer takes from the rest of the repository](#what-the-viewer-takes-from-the-rest-of-the-repository)).
An agent working on the recomp can skip this directory entirely.

**Start here if you are a new agent or contributor:** the design and the findings recorded as the
viewer was built are in [`docs/specs/2026-09-20-web-map-viewer-design.md`](docs/specs/2026-09-20-web-map-viewer-design.md)
and [`docs/specs/2026-09-26-web-map-viewer-polish-design.md`](docs/specs/2026-09-26-web-map-viewer-polish-design.md)
(the plan beside them in `docs/plans/`); the byte-level format authority is the viewer's own
[`docs/research/72-mp-map-archive-anatomy.md`](docs/research/72-mp-map-archive-anatomy.md), and the
meaning of every vertex lane is [`packages/mesh/SEMANTICS.md`](packages/mesh/SEMANTICS.md). Comments in
the code cite `docs/research/NN` and `FUN_00xxxxxx` decompilation addresses: the research notes (the viewer's own two, 71 and 72, live in `docs/research/` here; the rest are the repository's)
and its Ghidra function names. The behaviour every change is checked against, maps and pictures
included, is pinned down in [`packages/viewer/e2e/viewer.spec.ts`](packages/viewer/e2e/viewer.spec.ts)
(`npm run e2e`); the viewer's chrome is the s2u design system, vendored under
`packages/viewer/src/ds/` by `npm run ds:sync` (the manifest test refuses a hand edit).

## How it works (one paragraph)

`@s2u/archive` reads the ZDB table of contents and the ZAR/ZED containers inside it. `@s2u/scene`
reads the map's scene graph (`MP*_GEO.ZED`) into nodes with matrices, walks it the way the engine did,
and places every model, plus the clutter from `CLUTTER.ZAR` and the collision hull. `@s2u/mesh` walks
each model's DMA chain, decodes the VIF1 unpacks into vertices exactly as VU1 would have, and reads the
GIFtag templates for what the packet was (a mesh, a line strip) and how it was to be drawn.
`@s2u/gs` decodes the textures and palettes (PSMT8 with CT16/CT32 CLUTs, PSMCT16 and PSMCT32) and the
GS state block each texture's bind packet sets. `viewer` builds three.js objects from all of that in a
worker, draws them with a shading graph that does the GS's own arithmetic (modulate, clamp, fog,
brighten, blend) in the order the engine drew them, and puts a fly camera in front of it.

## Build

### Prerequisites

- **Node 24** or newer (the tools use `import.meta.dirname` and top-level `await`).
- **A disc tree**: a directory with `RUN/MP*.ZDB` in it, from your own SOCOM II disc (US retail,
  SCUS-97275). The viewer needs only those 22 archives, about 224 MB. See the next section for where
  to get them.

### What the viewer takes from the rest of the repository

The viewer needs **no recompiled game, no toolchain and no emulator** — nothing from the
recompilation's build (`build.sh`, `recomp/`, `third_party/`, `tools/`). What it does take:

1. **The disc tree.** The recompilation's launcher and tooling read the game out of your own ISO into
   `game/disc/` ([the root README](../README.md), "The user supplies their own disc image");
   `tools/extract-maps.ts` defaults to that location. You do not have to go through the
   recompilation to get one: mounting the ISO (double-click on Windows, `hdiutil` on a Mac,
   `mount -o loop` on Linux) gives you the same `RUN/` directory, and that is all the extractor reads.
2. **The research.** The format is documented in [`docs/research/`](../docs/research/) — `36` for the
   archives, `13` for the VU1 world-object program the vertex decode mirrors, `31` for the brighten
   and the blend equations, `26` for the GS state — and the design specs in `web/docs/`. The code
   cites the notes by number.
3. **reCOM**, the open-source re-implementation of the engine vendored under `recom/`, which is where
   the engine's draw order (`zRender/zrndr_pipe.cpp`) and the scene-graph hookup
   (`zVisual/vis_main.cpp`) were read.

### Commands

Run from `web/`:

| command | what it does |
|---|---|
| `npm install` | workspace install (five packages plus `tools`) |
| `SOCOM_DISC=/path/to/disc npm run extract-maps` | disc tree → `public/maps/RUN/*.ZDB` + `index.json`, and three test fixtures. **Run this first.** (`SOCOM_DISC` defaults to `C:/projects/socom_pc/game/disc`.) |
| `npm test` | vitest over every package; the fixture-backed tests skip when the extractor has not run |
| `npm run typecheck` | `tsc` over the five packages, the viewer and `tools` |
| `npm run dev` | Vite at `http://localhost:5173` |
| `npm run build` | the viewer as a self-contained static site in `dist/viewer/` (~830 kB, 220 kB gzipped) |
| `VIEWER_BASE=/map-viewer/ npm run build` | the same, to be served under a path prefix |
| `npm run e2e` | Playwright: loads all three fixture maps, asserts the stats, toggles the overlays, writes screenshots |
| `npm run dump-textures -- RUN/MP2.ZDB` | every texture to PNG, both pixel orders and both CLUT orders, plus contact sheets |
| `npm run export-gltf -- RUN/MP2.ZDB` | one map's world mesh to a `.glb`, for Blender or a glTF validator |

### Deploying

`dist/viewer/` is a static site: a web server, and beside it a `maps/` directory holding what `extract-maps`
wrote from your own disc (`maps/index.json` and `maps/RUN/*.ZDB`). The archives are the game's and are never
part of the build.

## Layout

Everything below is relative to `web/`.

| Path | What |
|---|---|
| `packages/archive` | ZDB table of contents, ZAR/ZED v2, compiled `.rdr`, and the `AssetSource` the rest read through (`/node` for the file system, `http` for the browser) |
| `packages/gs` | GS texture and palette decode, and the GS state block (`ALPHA`, `TEX1`, `TEST`, `CLAMP`) per texture |
| `packages/mesh` | the DMA-chain walk, the VIF1 unpack, and the vertex-lane interpretation that yields `MeshData` and `LineStrip`; `SEMANTICS.md` is the authority |
| `packages/scene` | world root, scene graph and node matrices, the engine's walk order, clutter, collision, the measured spawn table |
| `packages/viewer` | the Vite app: renderer, shading graph, fly camera, map picker, overlays, diagnostics panel, the Playwright e2e |
| `tools/` | the extractor and the dump/export tools |
| `docs/specs/`, `docs/plans/` | the viewer's own design specs and plan, kept here rather than in the repository's `docs/superpowers/` so the recomp's agents do not have to read past them |
| `public/maps/`, `test-fixtures/` (ignored) | your extracted game data; never committed |

## Controls

The camera flies like a creative-mode build camera: momentum, not teleporting.

| input | what it does |
|---|---|
| click the canvas | captures the mouse; look is then free. **Esc** gives it back |
| drag | looks, for touch screens and anywhere pointer lock is refused |
| `W`/`S` | fly along the look direction — nose down and `W` descends |
| `A`/`D` | strafe, always level with the horizon whatever the pitch |
| `Space` / `Shift` | up and down in world space |
| double-tap `W`, held | boost, with the field of view widening to match. Nothing is bound to `Ctrl`: `Ctrl+W` closes the tab and no page can prevent it |
| wheel | trims the fly speed between 0.1x and 16x; the panel shows the trim |
| `Q`/`E` | down and up, kept from the earlier bindings |
| arrow keys | look, at a steady rate, for a keyboard with no mouse to hand |
| `F` | fullscreen, and back (also the button under the frame counter) |
| `` ` `` | hides and shows the panel and the frame counter, for a clean look at the map |

The mouse is captured with `unadjustedMovement` where the browser offers it, so the OS's pointer
acceleration stays out of the look. `?map=MP7` opens a map by its archive, the picker writes the URL,
and the last map picked is remembered for the next visit.

Starts ramp and stops glide rather than snapping. The velocity is integrated in closed form, so the camera
covers the same ground per second at 30 fps as at 240 — and `setCamera` from the debug hook clears the
momentum outright, which is what keeps the Playwright poses exact. `test/camera.test.ts` pins the motion
model — ramp, glide, frame-rate independence, which axis each key moves along — rather than the tuning
constants, which are meant to be tuned.

## On a touch screen

A one-finger drag looks around, which the canvas gives for free. Moving is the part a phone had no way
to do, so the left half of the screen is a virtual stick — a circle that appears wherever the thumb
lands and follows it — and two buttons in the bottom-right corner do what Q and E do. The right half
is left alone so looking still works while the stick is held. The stick feeds an axis pair into the
same velocity model the keys drive, so the ramp, the glide and the frame-rate independence come out of
that for free; `stickVector` in `viewer/src/touch.ts` is the only arithmetic, and it is unit-tested.

They appear on a coarse pointer, or at the first touch event for a hybrid a media query gets wrong,
and not at all on a mouse. A touch drag turns twice as far per pixel as a mouse drag, because a thumb
has a phone's width to work with; the stick held at its rim for 400 ms is the boost, the one gesture a
thumb can make without leaving the stick; and a round fullscreen button sits above the lift buttons,
which on a phone also asks for a landscape lock. The canvas is `100dvh`, so the picture's centre is the
screen's whether or not the browser bar is showing, and the pixel ratio starts at 1.5 on a coarse
pointer and adapts (`main.ts`, `adapt`): frames over 24 ms step it down to 0.75, frames under 12 ms
step it back up.

Everything the viewer draws over the map goes in one strip along the top: the back link, then the
panel's title bar beneath it. The panel opens folded on a coarse pointer (a remembered choice still
wins), its body scrolls inside itself, and the status line drops the draw and collision counts and
abbreviates the rest so it fits on one row at 360px. The lift buttons clear the browser's own bottom
bar with `env(safe-area-inset-bottom)`.

## Loading a map without freezing the page

Switching maps used to take one 690–1,703 ms frame, and the whole of it was the *first frame that drew
the new map*: `buildWorld` costs 14–20 ms, and then three uploads every texture and geometry and
compiles every program at once. So the build still happens in one go and what is spread out is the
showing — `buildWorld` returns its objects in two queues and `viewer/src/scheduler.ts` hands them to
the scene a few per frame. The world's own meshes go first and the previous map stays up until they
start landing; the props follow behind a map that is already drawn and flyable.

The budget that does the work is a **count**, not a clock: adding a mesh to a group costs about a
hundredth of a millisecond, and the 400 ms is spent in the render that follows, where a time budget
cannot see it. The collision hull — tens of thousands of segments on the larger maps, and off by
default — is likewise held as arrays and only made into an object the first time it is switched on.

Meanwhile the overlay says what is happening: bytes fetched (the archive is read a chunk at a time so
the bar has a real denominator), then the worker's own stages, then the scene build. The map picker is
the only control taken away while a load runs.

## What the picture is made of

Settled on 2026-09-26 (the polish spec linked at the top):

- **The world is drawn unlit, then the frame is brightened.** The EE emits the VU1 light command only
  for a node flagged `m_dynamic_motion` or `m_dynamic_light`; on most maps that is nobody, and the
  vertex colours the exporter baked go to the GS untouched (`viewer/src/lighting.ts`). The game's
  post-process then multiplies every pixel, fog included, by `1 + FIX/128`, `FIX` being its
  auto-exposure's reading (93 on the console dump). That is the "factor of eight" the earlier notes
  could not place. The rig from `GlobalLighting` is exact and is applied to the flagged nodes only.
- **The GS state is read off each texture's bind packet** (`gs/src/gsState.ts`, `viewer/src/materialSpec.ts`):
  the blend equation (source alpha, additive on 212 glows, none on the cutouts), the alpha test and its
  reference (`GREATER 64`, exactly half), the filtering and mipmap request, and the wrap mode per axis.
  Nothing about a texture's alpha is guessed from its pixels any more, except whether it has any.
- **Fog is the GS's linear ramp with the altitude band**, as a fog node of its own (`viewer/src/fog.ts`):
  `F = clamp(w*scale + offset) * clamp((y - bottom)/(top - bottom))`, the second term read off the EE's
  own setup and parked at the engine's off values (`-10000`, `0.001`) on the sixteen maps without it.
  A packet whose GIFtag clears `FGE` — every sky, moon, star, water plane and self-lit surface on every
  map (`tools/dump-fge.ts`) — takes no fog, which is what puts the horizon back.
- **The camera is the map's**: a 49° vertical field (`m_vfov`, a half-angle of 24.5°), 46° on Rat's Nest.
- **The PS2 picture** (the Modern / PS2 switch at the top of the panel): the 640×448 frame the console
  drew, projected with the map's own half-angles and stretched onto a 4:3 box the way the television
  did. The choice is remembered. Everything else the panel offers is under **Advanced**.
- **Backface culling is the visual's own flag.** Bit 3 of each visual's `vparams` word is the cull
  the EE emits (`FUN_003b5f20`, `flags & 8`; `VISUAL_FLAG_CULL` in `scene`). Across the maps it is
  clear on exactly the things drawn from both sides -- Frostfire's ladders, whose rungs used to vanish
  from behind, grates, fan blades, Bitter Jungle's foliage, Desert Glory's grass, rugs, the glow quads
  -- and set on the solid objects. It replaces the old rule that culled wherever the texture was solid.
- **One state per object.** A map's graph holds every state of a destructible (`healthy` beside
  `whats_left` and the debris `parts`), a lamp beside its `nolight` copy, and the crates' pulsing
  objective ribbon. The game switches them by play; drawn together they z-fight. The viewer draws the
  intact, lit ones and hides the rest (`LoadedMesh.alternate`, "alternate states" in `options` shows them).
- **LOD by range.** `READERM.ZAR/lod.rdr` pairs models into bands with fade-in and fade-out ranges
  (`railings_high` out at 100-120 units where `railings_low` comes in, on the same rails), and the
  world root's `LOD_Object` holds the same numbers squared for `CVisual::DrawLOD` to compare the
  camera's range against. Each placement of a banded model is its own mesh and is shown by its
  distance from the camera, switching at the middle of each fade (`lodVisible` in `scene`).
- **Facades face the camera because the disc says so.** `m_facade` (node flags bits 8-9) marks the
  lamp flares, the stars, the moon and the sun -- 41 nodes over 22 maps -- and applies to everything
  under a flagged node, as the engine's matrix stack does. It replaces the old guess that turned
  every graded single quad, which also turned the drop shadows.
- **Scrolling textures scroll.** The world root's `TextureScroll_Object` names the nodes whose uvs
  the engine steps each tick (Frostfire's `ocean_1..3` and `skyhorizon`, by 0.02-0.04); those chunks
  get a uv offset the viewer advances at the field rate (`SCROLL_TICKS_PER_SECOND`, an assumption
  until a capture settles it).
- **Drop shadows are a decal pass** ("prop shadows" in `options`, on by default): every draw whose
  texture is a `shadow*.tif`, blended source-over after the world with no depth written and a polygon
  offset off its ground, whatever the draw-order mode.
- **The draw order is three's, by choice.** reCOM's `CPipe::RenderWorld` walks the engine's *grid*
  outward from the camera (`StartTraversalOrdered`), with decals and shadows in passes of their own,
  and writes depth under every blend (`ZMSK = 0`, research 26 §2). The viewer records each draw's
  place in the scene-graph walk (`LoadedMesh.order`, the merge cut at every blended chunk so no opaque
  draw straddles one) and can draw in it -- "scene-graph draw order (experimental)" -- but that is not
  the grid walk either, and a shadow quad or a flare drawn before the wall behind it shows the sky
  through itself. So by default blended draws go to three's back-to-front sort with no depth written.
- **The shading is the GS's modulate, in the GS's order** (`world.ts`): `(texel * vertex) >> 7`, the
  product clamped by `COLCLAMP` *before* the fog is mixed in, then the post-process's `1 + FIX/128` as a
  uniform on every material rather than a factor baked into the vertex — so an overbright vertex under
  fog comes out as the hardware had it, and moving the brighten slider rewrites nothing. The
  `(Cd - 0) * As + Cd` light maps are drawn with their own equation: the shader emits `As` and the blend
  is `Cs * Cd + Cd`, the fix the game's own GL backend made (research 31 §12).
- **The line strips are drawn** (`options`, on by default): one pixel wide, textured along the strip
  with the uvs the packet carries (they run well past 0..1, so the texture repeats along a rope),
  gouraud, fogged and blended — `PRIM = IIP|TME|FGE|ABE` on all 194 packets — as one `LineSegments`
  per (texture, fog) with the same shading graph the meshes use. Desert Glory's power lines and lamp
  brackets, Crossroads' tent ropes and light filaments.

## Known gaps

- **The engine's grid walk, region culling and LOD fades are not modelled.** `RenderWorld` walks the
  grid outward from the camera and `CanSeeRegion` skips whole nodes by region mask; `DrawLOD` fades a
  copy's opacity across its band where the viewer switches at the middle. The two facade modes are
  drawn alike, reCOM's `ComputeFacadeMatrix` being a stub.
- **Animated map objects beyond the uv scrolls are not drawn.** The door animations (`actions.rdr`,
  `MOTION_S.ZAR`), the destructible states, and the particle effects (`COMMON/EFFE_*`:
  `fire_hardedge.tif` and the smoke sprites) are driven by game code the viewer does not run; the
  flames are effect emitters, not map geometry.
- **The one EE-animated `FIX` glow** (`lightglow.tif` on MP61, `(Cs - 0) * FIX + Cd`) is drawn additive:
  its factor is game logic, and at rest it draws nothing.
- **The auto-exposure is a slider.** `FIX` is computed per frame from a column of frame pixels; the
  viewer opens at the one value measured (93) and leaves the readback unmodelled.
- **The detail texture pass is not drawn** (SEMANTICS §11.6).
- **Spawns are not on the disc.** `AIMAPS.MPS` is the file that would hold them and no reader for it exists;
  `scene/spawns.ts` carries the measured table instead, so a map that was never measured opens on its own
  extent rather than at a spawn.
- **The ISO source is M5.** Only the served `public/maps/` tree loads today. The seam is `sourceFor` in
  `packages/viewer/src/worker.ts`, which builds an `HttpAssetSource` per base URL; an ISO source needs a
  `File` from the page, so `ViewerRequest` will have to carry one rather than a `baseUrl` string.

## No game data in the repository

`public/maps/` and `test-fixtures/` are git-ignored, and so is everything the tools write into them —
archives, PNGs, `.glb` files and Playwright screenshots. They are regenerated from the disc by
`npm run extract-maps`, never committed. SOCOM II: U.S. Navy SEALs and all of its assets — models,
textures, maps, audio — are the property of Sony Interactive Entertainment, developed by Zipper
Interactive. This project is not affiliated with, endorsed by, or connected to Sony Interactive
Entertainment.

## Licence

GPL-3.0, the repository's ([`LICENSE`](../LICENSE)). CI for this directory is
[`.github/workflows/web.yml`](../.github/workflows/web.yml), which runs only when `web/` changes.
