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

All six the owner can overturn by number.
