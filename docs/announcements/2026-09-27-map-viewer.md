# The map viewer is open source, and lives in this repository

**Status:** DRAFT
**Publish:** the owner, by hand, in Discussions -> Announcements. Nothing posts this on its own (R319).
**Posted:** not yet
**Audience:** both
**Cites:** `14b1ef61` (PR #80, 2026-09-27) the viewer under `web/`; `b8525708` research notes 71 and 72 under `web/docs/research/`; `80b48e8c` the site's design language on the panel; `web/README.md`

## What changed

The browser map viewer, which draws SOCOM II's multiplayer maps from your own disc, is now part of this repository
under `web/`, GPL-3.0 like the rest. It reads the game's own `RUN/MP*.ZDB` archives byte for byte (the containers,
the scene graph, the DMA/VIF geometry, the GS textures and palettes, lighting and fog) and draws them with three.js
as close to the console's picture as a browser allows, without emulating the game. Nothing is pre-baked and no game
asset is committed: you supply the disc.

## Try it

- **Just look:** [socomunzipped.com/map-viewer](https://socomunzipped.com/map-viewer/). Fly camera on a desktop
  (WASD and the mouse; the controls are listed in `web/README.md`), touch controls on a phone.
- **Build it yourself:** Node 24 or newer, a US retail SOCOM II disc (SCUS-97275) mounted or extracted, then in
  `web/`: `npm install`, `npm run extract-maps -- <your disc tree>`, `npm run dev`. The extractor reads only the 22
  map archives, about 224 MB. The full steps are `web/README.md` "Build".
- **Read the format:** `web/docs/research/72-mp-map-archive-anatomy.md` is the byte-level account of the map
  archives, and `web/packages/mesh/SEMANTICS.md` the meaning of every vertex lane.

## What it is not yet

From the viewer's own known-gaps list (`web/README.md`): the engine's grid walk, region culling and LOD fades are not
modelled; animated map objects beyond the UV scrolls (doors, destructibles, particle effects) are not drawn; the
auto-exposure is a slider set to one measured value; the detail-texture pass is not drawn; spawns are a measured
table, not read from the disc; the viewer loads only a served `maps/` tree, not an ISO from the page. The
recompiled game and the viewer share the disc and the research, and nothing else: the viewer needs no build, no
toolchain and no emulator.

## Milestones so far

- 2026-09-20 -- scoping research (note 71) and the first design spec: a map viewer first, a replay viewer for live
  matches as the next ambition, the matches themselves further out.
- 2026-09-26 -- the polish design: the panel, the chrome and the site's design language.
- 2026-09-27 -- the viewer moves from the site's repository into this one under `web/` as a separate project with
  its own tests and CI (`web.yml`), and stays live at `/map-viewer/` on the newly named socomunzipped.com.

## Rough goals next

- Load a map straight from an ISO chosen in the page, with no extraction step.
- Draw what the engine animates: doors, destructible states, the effect emitters.
- Model the engine's grid walk and LOD fades so the picture matches the console's at distance.
- A replay viewer for live matches, once the game's network path is settled; the matches themselves are far out.

## Where to report

REPORT A BUG on [socomunzipped.com](https://socomunzipped.com/), or a GitHub issue on this repository. Questions go
to the Q&A category here.
