# Web sprint 1 — "the engine's world" (design)

> The browser project's first sprint of its own, written 2026-09-28 00:30Z on the owner's word of the evening of
> 2026-09-27: *"Pivot to the web browser. Build a sprint of the next batch of tasks that bring us closer to the
> engine reconstruction in JavaScript."* Plan: `../plans/2026-09-28-web-sprint-1.md`. Previous specs, in order:
> `2026-09-20-web-map-viewer-design.md` (M0-M4, and §9's dated findings), `2026-09-26-web-map-viewer-polish-design.md`
> (the accuracy pass; §4's findings). Tree at the write: sprint-16's tip `2bcfbb7a`, `web/` at 311 unit tests in 29
> files, three fixture maps under Playwright.

## 1. What was asked, and how it is read

The owner asked for the next batch of tasks toward **the engine reconstruction in JavaScript**. Two readings exist
and the sprint has to pick one:

- **The wasm route**: the recompiled game in the browser. Its state is measured (research 71 §1.7-1.8): size and
  compile time pass, the runtime compiles 86 of 88 units, and the two real tasks are a software round-toward-zero
  and inverting `EeScheduler::run()` into a frame-driven `step()`. That is C++ work against the runtime, under the
  build lock, and it produces no JavaScript.
- **The viewer growing the engine**: `web/` today re-implements in TypeScript the engine's *load and draw* path — the
  containers, the scene graph and its walk, the VIF1/VU1 vertex decode, the GS texture, state and shading, the fog,
  the LOD bands, the facades and the scrolls — and stops where the engine starts *running*: no grid, no region
  visibility, no player, no ground, no script layer, no spawns of its own. Every one of those is a documented engine
  structure with a reference (reCOM's `zGrid`, `zCamera`, `zRender`; research 23 and 24's verified probe and grid
  layouts; research 17's measured heights) and a verifier already in the tree.

**W1.R1 — this sprint takes the second reading.** "Engine reconstruction in JavaScript" is the viewer acquiring the
engine's runtime structures and per-tick behaviours in TypeScript, task by task, each checked against the game's
own recorded numbers. The wasm route is untouched and unranked by this sprint; research 71 §4's sentence stands
(a hand-written re-implementation is never *mechanically identical*, which is why the matches themselves stay on
the recompiled code). The owner can overturn it.

## 2. Where it stands (2026-09-28)

What the viewer has, with the fact each rests on:

| layer | state | authority |
|---|---|---|
| containers, `.rdr` | ZDB, ZAR/ZED v2, compiled `.rdr` reader; `lod.rdr` read; `mission.rdr` for the name | research 72 §1, §2 |
| scene | graph, walk order, matrices, clutter (5,957 instances), collision polys per model, `LOD_Object`, `TextureScroll_Object`, `GlobalLighting`, camera params, per-node `regionmask`; `grid_params` **present in every world root and unread** | research 72 §2; polish spec §4 |
| mesh, gs | DMA chain, VIF1 unpack, vertex lanes; textures, CLUTs, per-texture GS state | `mesh/SEMANTICS.md`, research 26, 31 |
| draw | the GS's modulate and clamp, fog, brighten, blend by bind packet, cull by visual flag, one state per object, LOD switch at mid-fade, facades, scrolls, line strips, shadow decals, three's sort for blends (the graph order experimental) | polish spec §3, §4 |
| runtime | a fly camera; nothing of the engine runs | — |
| gaps named in `README.md` | grid walk, region culling, LOD fades; animated objects; the `FIX` glow; auto-exposure; **detail pass**; **spawns not from the disc**; **ISO source** | README "Known gaps" |

What the tree already holds for the next layer, unused by `web/`:

- **The grid.** `grid_params` (`tag_GRID_PARAMS`, 20 B) is in every world root; reCOM `CGrid::Read`
  (`research/recom/src/gamez/zGrid/grid_main.cpp:156`) fetches it and `Create` generates the cells at load
  (`:138`); research 23 §2.1 has the live layout of `zdb::CGrid` verified in six images (cell dimension 180.0 and
  36 × 25 cells on the M51 image; 160 and 8 × 9 on Frostfire, research 24 §1.1), the atom pool of 8,192, one atom
  per cell an object's bounds cover (`FUN_002d7580`), and the invariant nodes + free = 8192.
- **The engine's draw order.** `CPipe::RenderWorld` (`zrndr_pipe.cpp:207`) walks `StartTraversalOrdered` /
  `GetNextAtomOrdered` — the cells in rings outward from the camera — and tests `CanSeeRegion(node->m_region_mask)`
  first (`zrndr_pipe.cpp:39`, `zcam_main.cpp:136`); the viewer's `LoadedMesh.order` and `setDiscOrder` are the seam.
- **LOD fades.** `CVisual::DrawLOD` (`vis_main.cpp:305`) scales the opacity by
  `m_minInvDeltaRangeSq * (range - m_minRangeNearSq)` across the fade band; `scene/lod.ts` already has every band.
- **The ground probe.** Research 23 §1.1-1.2 gives the call order, the origin, the per-model gate, the vertical
  line `(x, ±50000, z)`, first hit per model in surface order, and the selection window; research 24 §2 restates it
  as an algorithm and §3 shows it reproduces 1,152 recorded actor rows to a median residual of 0.004. Research 17 §1
  measures the console's look-at target **15.38** above the actor and the player's world position at rest.
- **The spawns.** `AIMAPS.MPS` carries the `PlayerStart` and `spectator` regions (research 72 §6); the format is
  the one documented gap. `scene/spawns.ts` holds 22 maps × 2 measured positions — an oracle for a decoder.
- **The detail pass.** `mp<N>_lib.rdr`'s `detail{name, uv, range, bmode}` per texture (research 72 §6);
  `SEMANTICS.md` §11.6 names the test (`uv` = 4.0 on the surfaces whose VU1 dumps use `0x30`/`0x32`).

## 3. Goal and bar

**Goal:** the viewer holds the engine's world the way the engine holds it — a grid of cells the draw walks and the
probe queries, regions the camera sees or does not, LOD copies that fade, ground the player stands on, spawns read
off the disc, the detail pass on the ground — so that a person opens Frostfire, presses the walk key, and walks
from A's spawn to B's along research 24's route at the SEAL's eye height, over the same floors and against the same
walls the game has, with the draw in the engine's order.

**The bar (section 6 is the check):**

1. Every task lands with a unit test that fails first and a number from the game's own record that it reproduces.
2. `npm run typecheck`, `npm test` and `npm run build` green on CI (`.github/workflows/web.yml`) at every merge;
   the Playwright e2e green locally against the three fixture maps at the close.
3. The ground probe returns the recorded floor within `[−3, +1]` of the actor's y at all 44 measured spawn positions
   (research 24 §3's window), and the 3,318 world-space collision polygons on Frostfire are the viewer's too.
4. Nothing regresses on the 22-map sweep (`tools/map-health.ts`): no map gains a diagnostic, none loses a draw.
5. The README's "Known gaps" list is rewritten to what is true at the close; the specs' §9 / §4 convention (every
   finding dated, in the spec) continues in this spec's §7.

## 4. The batch

Six tasks, ordered visible first (the owner's ordering principle of 2026-09-16), each dispatchable to an Opus
implementer in its own worktree with a failing test named; none needs the build lock, a game run, or the recomp's
toolchain. Sizes are the controller's estimate of one agent's sitting: S under two hours, M half a day, L a day.

### W1.1 — The grid (`@s2u/scene`, S/M)

`grid.ts`: `zdb::CGrid` from `grid_params` — cell dimension, cells wide and high, origin — cells generated at load
as `CGrid::Create` does; every placed model, clutter instance and collision polygon inserted into each cell its
world bounds cover (one atom per covered cell); `cellAt(x, z)`, `cellsCovering(bbox)`, and the **ordered traversal**:
the camera's cell first, then the rings outward (`addOrderedCellAtom`, `GetNextAtomOrdered`), yielding atoms with
their ring number. The census is the test: Frostfire's `grid_params` decodes to dimension 160, 8 × 9, origin 0
(72 cells, research 24 §1.1); the M51 map's to 180.0, 36 × 25 (research 23 §2.1; the task names which archive M51
is); the atoms spent stay under 8,192 on every map; every placed model lands in at least one cell. **Visible
outcome:** none by itself; W1.2 and W1.4 stand on it, which is why it is first.

### W1.2 — The engine's draw order and region visibility (`viewer`, M)

Replace "scene-graph draw order (experimental)" with **"engine draw order"**: per frame, walk W1.1's rings outward
from the camera cell and issue the draws in that order, the shadows and decals in their own pass after
(`RenderWorld`'s shape), depth written under every blend as the console did (research 26 §2). Region visibility:
`CanSeeRegion` masks each node's `m_region_mask` against the camera's set; the task's research step finds where our
binary writes the camera's region set (reCOM transcribes `m_SeeRegions` as a `bool`, which it is not) — the
collision polygon under the camera carries `region`, and the expectation is a per-region visibility table on the
disc or a portal walk; if the writer is not found in the sitting, the order lands and the region test stays a
documented gap. **W1.R3:** the engine order becomes the default only when the 22-map sweep and the three Playwright
poses show no regression; until then it is a switch beside the old one, and the old one goes. **Visible outcome:**
a flare or a shadow quad no longer shows the sky through itself when drawn before the wall behind it; the big maps
draw less.

### W1.3 — LOD fades (`viewer`, `scene`, S)

`lodOpacity(band, rangeSq)` per `DrawLOD`: full inside the band, the ramp `minInvDeltaRangeSq × (rangeSq −
minRangeNearSq)` across the fade, zero outside; the "last copy stays" rule of `e92b071c` kept. The material carries a
per-draw opacity (a uniform per mesh or an instance attribute — the task decides and says why). Tests at the band's
edges, its middle, and the crossover where `railings_high` hands to `railings_low` (100-120 units, polish spec §4).
**Visible outcome:** the railings stop popping.

### W1.4 — The ground probe and the walk (`scene`, `viewer`, L)

`probe.ts`: the engine's probe over W1.1's grid — for `(x, z)`: the cell's atoms, each model gated as
`FUN_002d3030` gates it, the vertical line in model space, first hit per model in surface order, surfaces with bit
18 set skipped, then the selection: origin `y + 5`, the highest candidate at or under `origin + 1`, else the lowest,
rejected over `y + 20` (research 23 §1, research 24 §2 step 2). `walk.ts`: a walk mode beside the fly camera (one
key, one panel switch, the touch stick unchanged): the mover steps at the engine's **60 Hz** on a fixed-step
accumulator independent of the frame rate (`CGame::Tick`; the first thing in `web/` that ticks), stands on the
probe's floor, slides along wall polygons (bit 18 clear, |n_y| < 0.7, research 24 §2 step 3) at body radius 3.5,
and looks from **15.4 units above the feet** (**W1.R2**: the console's look-at target height, research 17 §1; a
first-person eye, because the third-person camera's own smoothing and 5.4 defect are not this sprint's). Tests: (a)
the viewer's world-space polygon set on Frostfire is the 3,318 research 24 extracted, bounds x 120-1200, y 40-241,
z 322-1280 — the type-2 props' own polygons included; (b) the probe at each of the 44 spawn `(x, z)` with origin
`y + 5` returns the spawn's y within `[−3, +1]` (the three fixture maps on CI, all 22 by `tools/`); (c) a walkway
column on Frostfire (x 705-735, z 975-1000) returns two floors, 142 and 100, and the selection from y 100 keeps the
lower. **Visible outcome:** you walk Frostfire from A to B along research 24 §6's route, up B's ramp, and the door
leaf at (576-589, 1117) stops you.

### W1.5 — Spawns from the disc: `AIMAPS.MPS` (`archive` or `scene`, M, research-heavy)

Decode enough of `AIMAPS.MPS` to place the two sides: the header (`version 2`, `map_count`, flags, bbox, counts,
cell sizes, the 32-byte names — research 72 §6), then the region and layer table with `PlayerStart`, `spectator`
and the lettered regions, to each named region's extent. Write-up as research **75** under `web/docs/research/`
(the number is free). **W1.R4:** `spawns.ts` becomes the test oracle and the disc the source only when all 22 maps'
44 measured positions fall inside their decoded `PlayerStart` regions; short of that, the table stays the source,
the note records the layout learned and how far the check got, and the task is still DONE. The 2D briefing overlay
in the same file (the minimap) is named and left. **Visible outcome:** the spawn markers on every map come from the
disc, not a table, and a map never measured opens at its spawn.

### W1.6 — The detail pass from `mp<N>_lib.rdr` (`archive`, `viewer`, M)

Read the texture manifest (`name, dim2, typeU/typeV, pal, detail{name, uv, range, bmode}`); the wrap modes are
already read off the bind packets, so the manifest's value is the detail binding. Draw the second pass: the detail
texture at `uv × scale`, blended per `bmode`, fading over `range`, after the base pass in the same draw order. Test
per `SEMANTICS.md` §11.6: `uv` is 4.0 on the surfaces whose VU1 dumps use `0x30`/`0x32`; the pass count per map
listed by `tools/map-health.ts`. **Visible outcome:** the ground close up has the grain the console had.

### The close — W1.9

The README's "Known gaps" and "What the picture is made of" rewritten to the tree; §7 below holds every dated
finding; the 22-map sweep and the e2e recorded; the branch merged into the sprint branch it was cut from and, at the
owner's word, deployed (the deploy recipe in the memory note stands; the scotho design-system agent's window is
respected).

## 5. What is not in this batch, and why

- **The ISO source (M5)** — the door stays open (`worker.ts` `sourceFor`) and is the first candidate for web sprint
  2: it is infrastructure, and the owner's ordering puts the visible above it. Not shut: `ViewerRequest` will carry a
  `File`, and nothing in W1 assumes a URL.
- **Animated map objects** (`actions.rdr`, `MOTION_S.ZAR`: the doors, the fans) and **the destructible states** —
  a skeletal-motion format nobody has decoded; a sprint of its own once the grid and the tick exist (W1.1, W1.4).
- **Particle effects** and **the `FIX` glow** — driven by game code the viewer does not run; behind the animations.
- **The auto-exposure readback** — a frame-pixel column the viewer could sample; small, but nothing visible pends on it.
- **The wasm route** — W1.R1.
- **The minimap** from `AIMAPS.MPS`'s overlay — named in W1.5, drawn later with the walk's HUD.

## 6. Verification

Per task: a failing unit test first (vitest; the fixture-backed ones skip without game data, so each such test also
has a fixture-free twin on a synthetic input), RED and GREEN in the report, a fresh reviewer, the controller merges.
Per merge: CI green (`typecheck`, `test`, `build`). At the close: `npm run e2e` against the three fixtures with
the magenta check still passing; `tools/map-health.ts` over all 22 maps compared line for line with the pre-sprint
run recorded in the plan's Task 0; the four numbers of section 3's bar item 3 in the Log.

## 7. Findings recorded during the sprint

*(dated, newest last; the convention of the two earlier specs)*

### The LOD record is 32 bytes and the ramp is linear in range squared (2026-09-28, W1.3)

The world root's `LOD_Object` is 32-byte records: `minRangeNearSq`, `minRangeFarSq`, `minInvDeltaRangeSq`,
`maxRangeNearSq`, `maxRangeFarSq`, then a sixth float at +20 that reCOM's `CLOD_band` (`zRender/zrender.h:180-192`,
28 bytes) lacks -- the far fade's own inverse delta -- then the fade bits at +24 (bit 0 `minFade`, bit 1 `maxFade`) and
a pointer-sized word at +28. Each inverse delta is `1 / (far² − near²)`: Frostfire's railings store 1/4400 =
1/(120² − 100²), and on MP2, MP6 and MP72 a fade is flagged exactly where its two ends differ (MP2 10 records, MP6 20,
MP72 3). So `CVisual::DrawLOD`'s opacity, `m_minInvDeltaRangeSq × (rangeSq − m_minRangeNearSq)`, is linear in the range
*squared*: the two copies of a pair sum to 1 across the crossover and each is at half at 110.45 units, not 110. reCOM's
`DrawLOD` as transcribed (`zVisual/vis_main.cpp:305-317`) has its comparisons reversed and its second range test
repeating the first; `GetScaledRangeSquared` is a stub there (`zCamera/zcam.h:181`), so the "scaled" factor is
unknown and the viewer uses the plain distance. The decomp names `zdb_CVisual_DrawLOD` at `0x003b7b90`
(`recomp/socom2_names.csv`) but its body is not in the tree. The engine draws a visual at opacity 1 in place and
defers one below it to the alpha pass (`zRender/zrndr_pipe.cpp:344-364`, down to 1/128); the viewer does the same
with a fading twin per shared material (`viewer/src/lodFade.ts`), the 1/128 floor not copied.

### The grid's record, the origin, the census and the ring (2026-09-28, W1.1)

`grid_params` is reCOM's `tag_GRID_PARAMS` in `zNode/znode.h:109-120`: `s32 m_AtomCnt; s32 m_posts; f32 m_CellDim;
s32 cx; s32 cy` -- 8192 and 16 in the first two words on all 22 maps, then the dimension and the cell counts (Frostfire
160, 8 × 9). No origin is stored: `CGrid::Create` takes the world node's bbox minimum (`zGrid/grid_main.cpp:42-57`) and
the grid is read before the world tree (`node_saveload.cpp:313` against `:337`), so the origin is a fresh node's zero.
The engine's default without the key is 640, 8 × 8 (research 23 §2.3). M51, whose live grid research 23 §2.1 reads as
180.0 and 36 × 25, is a single-player archive (research 03 lists M51-M83), not one of the 22; MP51 is 160, 12 × 10. The
22 grids, dimension then cells x × z: MP1 160 20×26, MP2 160 8×9, MP5 160 12×16, MP6 180 14×15, MP7 180 15×15, MP8 160
16×10, MP9 160 22×15, MP10 256 11×10, MP11 320 6×7, MP12 180 15×14, MP51 160 12×10, MP52 360 14×11, MP53 200 24×28, MP61
160 9×16, MP62 160 18×18, MP64 160 14×19, MP71 180 16×13, MP72 170 14×16, MP73 180 19×18, MP81 160 11×16, MP82 160 16×20,
MP83 360 7×9. Footprints are the bbox's two corners transformed, as `gridAddNodeToGrids` does (`grid_main.cpp:408-431`),
which under-covers a turned node by up to 31 units on about a tenth of the placements; the bound is chopped to single
precision as the EE chops (research 25), the inverse rounded to nearest, the product truncated -- so read, the 129
type-1 world nodes spend 414 atoms without the three `ocean_*` nodes (bit 10, `m_reflective`; why they are left out is
unknown) and the 65 type-2 nodes spend exactly research 24 §1.1's 117; rounded to nearest instead, type-2 is 115 (one
`relieftower` bound at 799.9999981). Collision is filed per owning node (the probe's unit), not per polygon: one atom per
polygon would spend 12,621 on MP72 and 24,514 on MP82 against a pool of 8,192. The ring label is reCOM's
`abs(dx)+abs(dz)` (`grid_main.cpp:351`), a diamond, and `buildOrderedCellAtomList` (`:357-360`) is empty there: W1.R8.
Research 23 §2.1's chain-cut description implies a cell's list reads newest first; the viewer keeps insertion order.

### The detail pass is bound per texture, scaled by the manifest's `uv`, and the engine switches it per visual (2026-09-28, W1.6)

`mp<N>_lib.rdr`'s `detail{name, uv, range, bmode}` is compiled into each visual's 28-byte `detail_buff` (range at +0,
the `ALPHA_1` selector byte at +20, the scale at +24; `CVisual::Read`, reCOM `zVisual/vis_main.cpp:276-296`): binding
by texture is binding by visual, 2,395 of 2,395 visuals drawn with a detail-bound texture carry a record and none
lacks one. The S,T scale is the manifest's `uv`: **8 on Frostfire** (all 61 records; `floor_oilgrime.tif`), 2 to 10
across the disc, 4 the most common (30 of 66) -- SEMANTICS §11.6's "4.0" was the mission dumps' value, now settled
there. `range` is squared (90000 = 300², 250000 = 500²). `bmode` is `COLORBLEND` on 932 records, all `0x44`
`(Cs − Cd)·As + Cd`, and `ADDITIVE` on 68 (MP1 and MP2 only), all `0x48` `(Cs − 0)·As + Cd`; the detail textures' own
bind packets say `0x44` for both, so the blend is the visual record's, and their `TEST_1` is `ZTE=1, ZTST=GEQUAL` on all
65 -- less-or-equal in GL terms, which the viewer uses rather than EQUAL. A name listed twice in a manifest keeps its
first entry (MP1's 56 visuals). The engine does not fade the pass: `CPipe::RenderNode` turns it on for a whole visual
whose centroid is within range (`zRender/zrndr_pipe.cpp:311-322`); the viewer's merged draws have no centroid, hence
W1.R7. 22 detail blocks name 20 files; 21 of 22 maps bind a pass (all but MP7 and MP81).

### `AIMAPS.MPS` is decoded; the spawn list, not `PlayerStart`, holds the 44 (2026-09-28, W1.5)

The layout is in `web/docs/research/75-aimaps-mps.md`: a 0x28-byte head; per sub-map a 0xA8-byte header, 8-byte cells
stored as row spans, and eight counted tables; a trailer with the link block and the file's spawn list; every reference
is a stored cell addressed by `CAiMapLoc` (low 6 bits the sub-map index), and the sub-map count and order match
`aimaps.rdr`'s `map_list` on all 22. `PlayerStart` is a single named cell, not a region (the only records with extents
are 15 `Safety` rectangles on the 7 maps with hostage starts), and holds 0 of the 44 measured spawns. The spawn list is
24 slots a side, each one cell with a side bit and a facing in eighth turns (step k points to (sin 45k°, −cos 45k°): 0
is −z, 2 is +x -- *corrected 2026-09-28, later: the first reading, (−sin 45k°, cos 45k°), was derived assuming the 40
sweep rows lay ahead of the slot; W1.4 showed they are the orbit camera behind the actor, and of sixteen conventions only
this one places all 40 behind a same-side slot, research 75 §11*): 4 measured positions are at a slot's centre within
0.51 (Frostfire's and Vigilance's, KNOWN §1's rows) and 40 are 20.1-28.0 units *behind* one along its facing (median
23.8, across 1.0 to 3.2, the same side for all 40; the sentence read "ahead" until the correction), the other side's
nearest slot at least 824.6 units away -- 44 of 44 accounted for; which of the 24 a player gets is game logic. Research 72 §6's
"briefing overlay" strings (`Opacity( 0.5 )`, `Color( 87 112 176 )`) are leftover memory in an unread 32-byte header
field at +0x88, stale text on 13 sub-maps, not records; the file's only line data is polylines on Blizzard, Frostfire
and Bitter Jungle.

### The spawn slots' order, and the sweep's y is not the feet (2026-09-28, W1.5b)

In the trailer's order of the spawn list, the one slot that accounts for the measured A is side 0's #0 and for B side
1's #1, on all 22 maps (44 of 44; exactly one slot of the side qualifies each time, and #0 and #1 of a side are 22-851
units apart; in the sub-maps' own lists the same slots sit at scattered positions, so only the trailer's order carries
the pattern). A was the host and B the joiner in those rounds; "player n gets slot n of their side" fits all 44 and is
not proven. The slot's y is not in the file. A rough check against the collision hull at each measured position's own
(x, z): 37 of the 40 online-sweep rows (research 33) sit 12.7-38.1 units above the only floor there (median 25.0), 3
have a surface 12-25 units above them, none is inside [−3, +1] of a floor; the 4 KNOWN §1 rows (Frostfire's and
Vigilance's) sit 0.0-1.1 above the floor. With the same 40 rows also 20-28 units displaced horizontally from their
slot, the sweep's actor block may have been read at the third-person camera rather than the feet -- in which case the
facing convention W1.5 derived from "ahead" is turned 180° -- which W1.4's probe decides (W1.R10). The hull check is a
scratch approximation, not the probe.

### The engine's draw order lands; the camera's region set is not in the tree (2026-09-28, W1.2)

The order walks Task 1's rings from the camera's cell over `world.ts`'s draw records; a merged world part sits at the
ring of its nearest node (Frostfire's median part covers 5 cells, the largest all 72; Crossroads' median 27, Desert
Glory's 6), draws with no cell go after the last ring and before the shadows, and the walk runs to the grid's edge (reCOM's
`m_ring < 2` bound would stop at five cells and drop draws). Frostfire's 453 draws by ring from spawn A: 11, 181, 88, 46,
80, 39, 5; from spawn B: 58, 49, 80, 47, 92, 55, 69. The ring label's writer is `zdb_CGrid_addOrderedCellAtom` at
`0x002d7030` (`recomp/socom2_names.csv`, call-graph round 1, score 0.80; 384 bytes), its body not in the tree; reCOM's
`buildOrderedCellAtomList` is empty, so "near to far" is the spec's reading. Landmarks (`m_landmarks`, drawn after the
walk in `RenderWorld` :250-266; Frostfire has `skyhorizon`, `drilltower`, `boom`; MP6 `f18s`) are not held back.
**Regions.** On the disc: `tag_NODE_PARAMS.m_region_shift` (node flag bits 13-17, `znode.h:90`) is non-zero on 8 maps;
on six of them (MP2, MP11, MP52, MP61, MP62, MP81) the `di` polygons' `m_region` words are masks over exactly those
maps' shift bits (Frostfire: shifts 1 and 5, `0x22` on 279 polygons, all on the `deck*` nodes; the floor under both
Frostfire spawns is `0x22`), bit 0 never set; MP6 and MP82 have shifts but all-zero polygon words; the GEO `regionmask`
key appears only on Frostfire's 22 light instances. In reCOM: `CanSeeRegion` (`zcam_main.cpp:136-145`, a zero mask
counts as 1, `m_do_region_test` static true), the three camera fields `m_PlayerCanSeeRegions`, `m_CameraCanSeeRegions`,
`m_SeeRegions` (`zcam.h:213-218`; research 50 §4b reads them as three 4-byte masks at `0x2a0-0x2a8`, unchanged from
SOCOM 1), `InheritRegionMasks` (`node_main.cpp:583-597`, its two arguments swapping at every level as transcribed), and
the script commands `SET/GET_CAMERA_REGION_TEST` whose parse and tick are stubs. In the decomp's names: nothing for
`CanSeeRegion`, `InheritRegionMasks` or `RenderWorld`; `CAppCamera_Tick` at `0x002998f0` the likeliest home of a camera
probe, `anon_fts_mission_LoadMissionMapVisibilities` at `0x002af550` (508 bytes, reads a `CRdrFile`; name only),
`CZSealBody_CheckForRegionTrigger` at `0x005a2f90`. "The camera's set is the region word of the polygon under it" fits
the data but is not the game's code: taken literally at Frostfire's spawn A (`0x22`) it hides nearly all 409 shift-0
placements, with bit 0 added it hides nothing; the missing rule is which polygon (the player's or the camera's) and how
a zero word and bit 0 are read. Not wired; the README's gap line stays.

### The engine order shows the flares' black box; it stays a switch (2026-09-28, W1.2, W1.R3)

With "engine draw order" on -- the rings walked outward from the camera, depth written under every blend -- the 22-map
sweep is identical to the default's and the e2e passes, but Frostfire's lamp flares from 70 units show the polish spec's
black box: the flare's quad, drawn at its near ring before the pipe behind it, keeps that pipe out of the depth buffer
and shows the sky through a rectangle (`flare0-e`: 109,351 of 921,600 pixels differ from the default, 39,333 strongly;
`flare1-s`: 71,619 and 59,319). The agent's prediction (11 of Frostfire's 15 flares share a cell with an unblended
world part later in the walk) held. So near-first with depth under every blend is not what the console did for these
draws: either the flares go to the engine's alpha pass (`m_alpha`, which reCOM shows only for opacity under 0.99) or
the ring walk is not near-first for them (`buildOrderedCellAtomList` is empty in reCOM). W1.R3's answer is OFF: the
switch stays, the default is three's sort, and the flares' pass is the first fidelity question for web sprint 2.

### The probe's world is the engine's: 3,318 polygons, the camera in the sweep, the window's direction (2026-09-28, W1.4)

**3,318.** The viewer's 3,338 on Frostfire were the engine's 3,318 plus the `di` the exporter copies onto nested
instance nodes (ten `…/bigtank/tankrail{2,3,4}=tankrail{N}/railpostfiller` nodes, two polygons each): the engine keeps
both copies only for an instance read from the world's own file (`CreateInstance(sload)` then `ReadDataBegin` adds the
node's own `di`, reCOM `zNode/node_io.cpp:46-51`, `node_saveload.cpp:49-74`), while an instance inside a prototype is
rebuilt from its model by `_Copy` (`node_main.cpp:312-333`) and the file's copy never reaches the world. `worldDi`
drops it; every dropped polygon has a world-space twin that stays. Bounds x 120-1200, y 40-241.1, z 322.5-1280; the
collision column moves on 9 of 22 maps. **Bit 18** of research 23/24's surface flags is `m_cameratype`'s low bit in the
packed `di` params word (ditype bits 0-1, ptcount 2-9, material 10-17, cameratype 18-19); 19 Frostfire polygons carry
it, all ditype 2; ditype's bit 0 is the ground bit. **The sweep's y.** The 40 online-sweep rows of `spawns.ts` are the
third-person orbit camera, not the actor: `tools_py/parity/online_match_ours.py:42-45` peeks `0x416054`, "the local
player's ORBITING CAMERA record" (its `MP51_SEAL_SPAWN` (542.3, 1479.9) against KNOWN §1's actor at (540, 1456)); the
probe finds their floor a median 25.000 below (exactly 25.000 on flat ground; p99 38.1, min 12.7), and 36 of 40 have a
floor at y − 25 on research 18's 23.1-unit orbit ring -- the camera behind and above the actor. The 4 KNOWN §1 rows are
the feet (residuals 0, −1, −1.10, −0.89). W1.5's facing convention, read from "ahead", is therefore turned 180°
(corrected under W1.5b). **The window.** Research 23 §1.1 item 9 rejects a pick more than 20 *above* the feet, not
below: from origin 70 the deck at 42 is taken; the plan's "from 70, nothing" was wrong. Walking off Frostfire's deck is
a 42-unit fall in the game (research 24 §7.4); the mover refuses any drop over 20 (`MAX_DROP`), the conservative
reading, not the game's rule. **The layer mask** read literally as "last surface word 0 | 1" contradicts research 24
§3c (B's ramp `railramp_d8n` has region 0, the y 100 floor `deckv_*` is layer 1; on Guidance every region is 0 while
nodes sit on layers 0 and 1), so the mover probes all layers. **Data facts, all 22 maps:** every `di` polygon lies
inside its own node's bbox in x and z, and every node carrying polygons is active with `m_hasDI` set. The walk runs at
40 units/s (research 18, finding 3); the 2.5× boost is the viewer's own.

### The ISO reads the disc by ranges; 0.34 % of it names every map (2026-09-28, W1.7)

`IsoAssetSource` reads ISO9660's primary volume descriptor at sector 16 (scanning past a boot record to the terminator),
walks the directory tree lazily, strips `;1` and a bare trailing `.` (ECMA-119 §7.5.1; `tools_py/iso_lbn.py` keeps the
dot), and reads files by LBN through `Blob.slice`. A `RangedAssetSource` lets `listMaps` read each archive's 0xA0-byte
head, its table of contents and `READERM.ZAR` only: over an in-memory ISO of all 22 served archives, 66 ranged reads,
788 KiB of 224 MiB (0.34 %), 23 ms under node, name every map. The fixture archives come back sha256-identical to the
served tree per archive and per ZDB member (M5's bar). No SOCOM II image was on the host; images written by pycdlib in
four flavours (plain, Joliet with Rock Ridge, a UDF 2.60 bridge, El Torito) each read 65 of 65 files byte-identical.
Refused by name: a raw 2352-byte `.bin` (CD001 at 16 × 2352 + 16 or + 24), a logical block size other than 2048, a
multi-extent or interleaved file. The page offers `Open your own disc (.iso)` and drag-and-drop through the standard
file APIs (Safari lacks the File System Access API); a 404 on `maps/index.json` opens the panel on that control instead
of "booting" forever.

## 8. Rulings

- **W1.R1** — the sprint reads "engine reconstruction in JavaScript" as the viewer acquiring the engine's runtime
  structures in TypeScript; the wasm route is untouched (§1).
- **W1.R2** — the walk looks from 15.4 units above the feet, body radius 3.5, the probe's windows as research 24 §2
  states them (§4, W1.4).
- **W1.R3** — the engine draw order is a switch until the sweep and the e2e clear it, then the default (W1.2).
- **W1.R4** — `AIMAPS.MPS` becomes the spawn source only at 44 of 44; the note is the deliverable either way (W1.5).
- **W1.R5** — the web project's sprints number from 1 with rulings `W<sprint>.R<n>`, kept in the web plan, not the
  repository's global counter (a separate project, `web/README.md`); the docs live under `web/docs/`; the branch
  is `agent/web-s1` in `C:\projects\wt-web-s1`, cut from sprint-16's tip because `origin/main` lacks the 25 web files
  sprint-16 carries; agents' worktrees are cut from it and merged back by the controller.
- **W1.R6** — Opus implementers do the tasks, Fable reviews the documents and the two judgment calls (W1.2's region
  writer, W1.5's layout); the owner's staffing ruling of 2026-09-20.

- **W1.R7** — the detail pass fades per fragment, linearly to zero at √`range`, where the engine switches the whole
  pass on per visual while the visual's centroid is in range (`zrndr_pipe.cpp:311-322`): the viewer's merged draws have
  no centroid to switch on, and a per-fragment step would draw a hard ring on the ground the engine never shows; revisit
  on a capture that shows the pop (the cloud controller, 2026-09-28, W1.6).
- **W1.R8** — the traversal's ring is reCOM's `abs(dx)+abs(dz)` (a diamond, `grid_main.cpp:351`), not the square the
  plan assumed; Task 2 flips the default and checks the decomp's writer of `GRIDCELLATOM.ring`, keeping the square as
  the neighbourhood query Task 4 uses (the cloud controller, 2026-09-28, W1.1).
- **W1.R9** — W1.R4's condition is not the disc's structure (`PlayerStart` is one cell); the disc's source of the spawns
  is the file's spawn list, 24 slots a side with a facing, which accounts for 44 of 44. The slots become the spawn
  markers (W1.5b) and `spawns.ts` stays the opening stand and becomes the oracle: every measured position lies at, or
  within 30 units *behind* along the facing of, a same-side slot (the ruling read "ahead" until W1.4 showed the sweep
  rows are the orbit camera; corrected 2026-09-28, later). Which slot a player gets is game logic outside this sprint
  (the cloud controller, 2026-09-28, W1.5).

- **W1.R10** — bar item 3 is re-read on W1.5b's finding: the probe lands within [−3, +1] of the recorded y at the 4
  KNOWN §1 rows and at Frostfire's walkway column, and at the 40 online-sweep rows it reports its floor's offset from the
  recorded y (median, p99, max) and whether that offset is consistent, with a reading of what the sweep recorded; the 44
  positions still all return a floor (the cloud controller, 2026-09-28, W1.4).

- **W1.R11** — the ISO source (M5) is pulled into this sprint as W1.7 under the owner's instruction to use the session's
  budget; the plan's §5 line deferring it is superseded. The served tree stays the default where it exists; the disc is
  read with the browser's file APIs (a `File`'s ranges, nothing uploaded), ISO9660's primary volume only (the cloud
  controller, 2026-09-28, W1.7).

All eleven the owner can overturn by number.
