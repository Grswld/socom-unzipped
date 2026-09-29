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
(the plan beside them in `docs/plans/`); web sprint 1, "the engine's world", is
[`docs/specs/2026-09-28-web-sprint-1-the-engines-world-design.md`](docs/specs/2026-09-28-web-sprint-1-the-engines-world-design.md)
and its plan [`docs/plans/2026-09-28-web-sprint-1.md`](docs/plans/2026-09-28-web-sprint-1.md); web sprint 2, "the
SEAL in the world" (the player: the game's camera, speeds, fall, a stand-in body, the reticle and the rifle), is
[`docs/specs/2026-09-28-web-sprint-2-the-seal-in-the-world-design.md`](docs/specs/2026-09-28-web-sprint-2-the-seal-in-the-world-design.md)
and its plan [`docs/plans/2026-09-28-web-sprint-2.md`](docs/plans/2026-09-28-web-sprint-2.md), whose Outcome is the
close and whose Log the record of every task and number; the byte-level format authority is the viewer's own
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
  to get them. A player needs neither: since web sprint 1 the page opens the `.iso` itself
  (**Open your own disc**, or drop the file on the page) and reads the archives out of it as ISO9660 in
  the browser, byte for byte what the served tree would hold, nothing uploaded anywhere.

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
| `npm install` | workspace install (six packages plus `tools`) |
| `SOCOM_DISC=/path/to/disc npm run extract-maps` | disc tree → `public/maps/RUN/*.ZDB`, the shared archives beside them (`COMMON_ARCHIVES`: `READERC.ZAR`, `ZWEAPON.ZAR`, the motion packs, and the sound's `SOUNDRDR.ZAR`, `SOUNDS/BNKSTORE.ZAR` and `IRX/LIBSD.IRX`), `index.json`, and three test fixtures. **Run this first.** (`SOCOM_DISC` defaults to `C:/projects/socom_pc/game/disc`.) |
| `npm test` | vitest over every package; the fixture-backed tests skip when the extractor has not run |
| `npm run typecheck` | `tsc` over the six packages, the viewer and `tools` |
| `npm run dev` | Vite at `http://localhost:5173` |
| `npm run build` | the viewer as a self-contained static site in `dist/viewer/` (~830 kB, 220 kB gzipped) |
| `VIEWER_BASE=/map-viewer/ npm run build` | the same, to be served under a path prefix |
| `npm run e2e` | Playwright: loads all three fixture maps, asserts the stats, toggles the overlays, writes screenshots |
| `npm run dump-textures -- RUN/MP2.ZDB` | every texture to PNG, both pixel orders and both CLUT orders, plus contact sheets |
| `npm run dump-sounds -- MP2 [dir] [.STEP_STONE ...]` | a map's 989snd sounds rendered to WAV, with each one's length, peak and RMS (`docs/research/81-sounds.md` §11) |
| `npm run export-gltf -- RUN/MP2.ZDB` | one map's world mesh to a `.glb`, for Blender or a glTF validator |

### Deploying

`dist/viewer/` is a static site: a web server, and beside it a `maps/` directory holding what `extract-maps`
wrote from your own disc (`maps/index.json`, `maps/RUN/*.ZDB`, and since web sprint 2 `maps/RUN/READERC.ZAR` and
`maps/RUN/ZWEAPON.ZAR`, the SEAL's tuning and the weapon table; with the sound, `maps/RUN/SOUNDRDR.ZAR` and
`maps/RUN/SOUNDS/BNKSTORE.ZAR`, and `maps/RUN/IRX/LIBSD.IRX` for the SPU2's reverb presets). The archives are the game's and are never part of the build. The sound banks are read
**by range** -- a map's two or three banks, not the 67 MB store -- so the server must answer HTTP `Range` requests
(nginx and Vite do); one that does not still works, fetching the whole store.

**Deploy the viewer before the maps.** Since web sprint 2 `index.json` is `{ maps, common }` -- the map list and
the shared archives -- rather than a bare array. The new viewer reads both forms; an old viewer fails on the new
index. So a server moving to web sprint 2 takes `dist/viewer/` first and the re-extracted `maps/` after it.

## Layout

Everything below is relative to `web/`.

| Path | What |
|---|---|
| `packages/archive` | ZDB table of contents, ZAR/ZED v2, compiled `.rdr`, and the `AssetSource` the rest read through (`/node` for the file system, `http` for the browser) |
| `packages/gs` | GS texture and palette decode, and the GS state block (`ALPHA`, `TEX1`, `TEST`, `CLAMP`) per texture |
| `packages/mesh` | the DMA-chain walk, the VIF1 unpack, and the vertex-lane interpretation that yields `MeshData` and `LineStrip`; `SEMANTICS.md` is the authority |
| `packages/sound` | the sound (`docs/research/81-sounds.md`): 989snd banks out of `BNKSTORE.ZAR`, SPU ADPCM, the grain sequencer and voices rendered at the game's volume and pan, `sounds.rdr`, the `SOILS` materials' step sounds, the weapons' and zAnim callbacks' sounds, and the rules for when a step, a landing or a round sounds |
| `packages/scene` | world root, scene graph and node matrices, the engine's walk order, clutter, collision, the measured spawn table, the SEAL's tuning off `READERC.ZAR` (`tuning.ts`), the weapon table off `ZWEAPON.ZAR` (`weapons.ts`), the engine's segment test (`segment.ts`), the zAnim effect commands, the thrown casing's flight, the particle sources and the effect models (`effects.ts`, `effectMotion.ts`, `effectParticles.ts`, `effectModels.ts`) |
| `packages/viewer` | the Vite app: renderer, shading graph, fly camera, map picker, overlays, diagnostics panel, the Playwright e2e |
| `tools/` | the extractor and the dump/export tools |
| `docs/specs/`, `docs/plans/` | the viewer's own design specs and plan, kept here rather than in the repository's `docs/superpowers/` so the recomp's agents do not have to read past them |
| `public/maps/`, `test-fixtures/` (ignored) | your extracted game data; never committed |

## Controls

The camera flies like a creative-mode build camera: momentum, not teleporting. The page lists only the controls of the
mode you are in, in the **Controls** popover in the top bar (hover it, focus it, or click or tap it; **Esc** closes it),
and, once a pad is connected, the pad's layout for that mode under them.

**Playing as a SEAL is behind a URL parameter.** Add `?redotcom` (its presence is enough: `?redotcom`, or
`?map=MP2&redotcom`) and the page also has walk mode, the SEAL's body, the rifle, the ammo box and the touch stance and
fire buttons. Without it none of that is rendered, bound or answered: no `G`, no Start, no Fly / Walk switch, no walk in
the Controls popover, and the debug hook's `setMode('walk')` returns false. (`viewer/src/features.ts`, `playEnabled`.)

The settings panel starts folded on every device, so a first visit is the map and a small bar. **Settings** (the cog),
**Controls** and **GitHub** sit together at the right of the bar, one size; the cog folds the panel away and back, and
the choice is remembered. A failed load unfolds the panel so the error is seen.

With `?redotcom` the panel also has a **Sound** section (a volume slider and a mute switch, driving `gameAudio.setVolume` and
`setMuted`) and a **Mouse look** section (raw or the game's stick curve, a sensitivity slider, invert pitch, and equal
pitch, driving `fly.setLookOptions`, `viewer/src/look.ts`). Both are remembered in this browser only (`localStorage`:
`s2u.viewer.volume`, `.muted`, `.mouseLook`) and start from the defaults on a first visit. The **Controls** popover lists
the keyboard and mouse for the current mode in groups (Move, Combat, Stance & traversal, Weapons, General; the fly list is
Move and General), and the pad's layout under them, grouped the same way, once a pad is connected.

### Flying (always)

| input | what it does |
|---|---|
| click the canvas | captures the mouse; look is then free. **Esc** gives it back |
| drag | looks, for touch screens and anywhere pointer lock is refused |
| `W`/`S` | fly along the look direction — nose down and `W` descends |
| `A`/`D` | strafe, always level with the horizon whatever the pitch |
| `Space` / `Shift` | up and down in world space |
| double-tap `W`, held | boost, with the field of view widening to match. **Flying only**: there is no sprint in walk mode from any input (double-tap `W`, the pad's R3, the touch stick's rim-hold). Nothing is bound to `Ctrl`: `Ctrl+W` closes the tab and no page can prevent it |
| wheel | trims the fly speed between 0.1x and 16x; the Controls popover shows the trim |
| `Q`/`E` | down and up, kept from the earlier bindings |
| arrow keys | look, at a steady rate, for a keyboard with no mouse to hand |
| `F` | fullscreen, and back (also the button under the frame counter) |
| `` ` `` | hides and shows the panel and the frame counter, for a clean look at the map; the site bar stays |

### Walking (`?redotcom`)

| input | what it does |
|---|---|
| `G` | walk and fly. Walk stands the SEAL on the game's own collision hull, sliding along walls at a body radius of 3.5, seen through the game's own third-person camera; the panel's **Fly / Walk** switch (the Modern / PS2 switch's own markup) mirrors it, and entering walk drops you onto the floor under the camera, or onto spawn A |
| `W`/`S`, `A`/`D` | run and back up, strafe, at the game's speeds; a touch stick pushed part way is a part stick, as a pad's is |
| mouse (captured) | turns the SEAL (yaw) and tilts the camera (pitch, between the game's aim limits) |
| `Space` | jump |
| `V` | third person, the default, and first person (the eye at the head, the body hidden); `Ctrl+V` stays the browser's |
| `C` | cycles the stance: stand → crouch → prone → stand; on a touch screen, the **C** button beside the lift buttons |
| right button (held) | the aim view, first person from the SEAL's eyes |
| left click (captured) | fires the rifle; held, it fires at the rifle's rate. The click that captures the mouse does not fire. On a touch screen, the round **fire** button |
| `R` | reloads; an empty magazine waits for it |
| walking into a ladder | climbs it, as the game does with no button: the stick climbs and descends at the game's 7.59 a second, the head and the foot step off ([research 86](docs/research/86-traversal.md)) |
| `X` | the action, the pad's Cross: climbs the crate, container or fence the climb icon offers (in the air too: jump, then `X`), and slides down a ladder |
| `Q` / `E` held | peeks left / right, standing still, as the game's d-pad does |
| `Tab` (held) | the round's scoreboard, as SELECT held on the console ([`docs/research/87-hud.md`](docs/research/87-hud.md) §12); the pad's Select too |
| `M` | the tactical map, and back (SELECT on the console; SOCOM II's single-player map over the map's `AIMAPS.MPS`, heading-up, drawn over the world with the HUD hidden: [`docs/research/87-hud.md`](docs/research/87-hud.md) §9); `-` / `=` held zoom it out and in |

### The controller

The Gamepad API's standard mapping, read as the PS2 pad by position. The left stick moves and the right looks, flying and
walking alike. The layout is the owner's word of 2026-09-28 where it says so; a row marked *assumed* in the page is one
neither the owner nor the repository documents (`viewer/src/gamepad.ts`, `PAD_LAYOUT`).

| button | walking (`?redotcom`) | flying |
|---|---|---|
| left stick / right stick | move / look | fly along the look / look |
| Square | jump | up |
| Cross | action: the climb the icon offers, the ladder's slide ([research 86](docs/research/86-traversal.md)) | — |
| d-pad Left / Right (held) | peek left / right, standing still | — |
| R1 | fire (held fires at the rifle's rate; let go stops) | — |
| Triangle | stance: a tap toggles crouch, a hold goes prone, a tap from prone stands up | down |
| L1 (held) | aim view (first person) | — |
| d-pad Up | zoom (scope): the lane is read, the zoom itself is a stub until the accuracy work merges | — |
| Start | fly (as `G`) | walk (as `G`) |
| L3 | crouch toggle on release (the launcher's crouch shortcut) | down |
| R3 | — | boost |

Triangle's hold length is a guess, `STANCE_HOLD_S_PLACEHOLDER` (0.4 s, `viewer/src/play.ts`): the game reads the button's
pressure, which a browser pad does not give.

**Walking is the game's player** (web sprint 2): the camera behind and over the SEAL's shoulder, the game's speeds
and fall, a stand-in body, the game's reticle and rifle. The numbers and where each came from are under
[What the picture is made of](#what-the-picture-is-made-of), "The player". In short: 65 units a second running, 37
backing up, 14 crouched, 11 prone; a step up to 6.5 units is climbed, a drop of more than 8 is a fall. `Space` jumps
as the game does ([research 80](docs/research/80-the-jump.md)): under 15 units a second the standing jump, a clip on the
floor (`seal_jump`, 0.99 s, the body's root and the camera rising 3.6); from 15 the running jump, 79.9 up 0.1 s after
the take-off under the 235 fall -- 12.9 units (1.3 m) high, 0.78 s in the air, the take-off's speed carried; prone cannot. The
clips are the game's pick and blend: the stick's speed picks each set's clip by its transition band, the forward and
strafe sets share the stick's angle, every clip plays at the rate its root needs. While walking, the game's own HUD is drawn
over the picture (`viewer/src/hud.ts`, [`docs/research/87-hud.md`](docs/research/87-hud.md)): the ammo box, the
compass turned by the heading, the info box (health, a static round timer, the range), the stance word on a change and
the context prompt (the climb icon, a door's within its 30 units); the round start as the console plays it (a fade from
black, "STARTING ROUND 1 OF 11", then the objective); the compass's nav marks (the map's own nav points, C..Z); hidden in
flight.

**The walk sounds** with the game's own sounds, decoded from the map's banks (`docs/research/81-sounds.md`): a
footstep per foot of every run or walk cycle, in the sound of the surface underfoot (the collision polygon's material:
metal on Frostfire's rig, sand in Desert Glory), the stealth step at a light stick and the crawl prone; the jump's
whoosh and the landing (the surface's, or a bone's crack from a deadly height); the M4A1 SD's suppressed round and its
reload; the SPU2's own reverb at the mission's indoor and outdoor depths; the mission's ambience beds and its looping
emitters (a fan, a river, insects at a lamp). Where a map's banks lack a sound its floors or grenades ask for, the same
sound is lent from another map's bank (a placeholder, research 81 §7). The browser starts sound on the first click or
key press; `window.__viewer.audio()` reports what played, what was dropped and why.

**The rounds show** with the game's own effects (`docs/research/89-effects.md`). Each round plays the weapon's zAnim
muzzle animation out of the map's `CZANIM.ZAR`. For the M4A1 SD that is the brass casing thrown to the rifle's right,
tumbling, bouncing on the hull with its surface's sound and gone at rest or at 1.2 s. It shows no flash and no tracer,
and no smoke: its smoke source is switched off in the retail data. Where the round lands, the surface's own impact
plays out of the map's `MZANIM.ZAR`: sparks off metal, dust and chunks off stone, a puff off sand, a splash off water.
The surface's own mark comes from `decals.rdr`, the metal's, the stone's, the sand's or the wood's, and none where the
game has none. `window.__viewer.effects()` reports what played; `playEffect(name)` plays any of the map's effects.

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
lands and follows it — and two buttons in the bottom-right corner do what Q and E do. Beside them, for the
walk, a **C** button cycles the stance as `C` does, and a round **fire** button is the trigger: held, the rifle
fires at its rate. The right half is left alone so looking still works while the stick is held. The stick feeds an axis pair into the
same velocity model the keys drive, so the ramp, the glide and the frame-rate independence come out of
that for free; `stickVector` in `viewer/src/touch.ts` is the only arithmetic, and it is unit-tested.

**Walking on a phone** (`?redotcom`) has its own layout, in the PS2 pad's positions, shown while walking on a touch screen
and held sideways (upright, the page asks for a turn and lifts the buttons off the HUD's tall bottom strip). The left
thumb has the stick; the right has a diamond of face buttons at the bottom right -- Triangle the stance (tap crouches, hold
goes prone, as the pad's), Square the jump, Cross the action (climb, ladder slide) -- and a larger **FIRE** (R1) at the edge
beside it. Under the compass are zoom in and out (d-pad Up and Down), **MODE** (fire mode, L3) and **RELOAD**; along the
bottom middle **RIFLE**, **M67** and **NEXT** (L1, L2, R2); at the left edge, over the stick's zone, the two peek buttons
(the d-pad's sides, held) and fullscreen. Every button holds the lane the pad's button holds (`touchInput`, merged with the
pad's in `padFrame`, `viewer/src/touch.ts` `attachWalkTouch`), so the behaviour is the pad's; each owns its pointer, so fire
and jump can be held at once. The HUD keeps its corners: nothing sits on the ammo box, the compass or the range and timer
strip. While walking, the fullscreen button leaves the bottom right for the left edge on every screen, since the HUD owns
that corner. Flying keeps the lift buttons as they were.

They appear on a coarse pointer, or at the first touch event for a hybrid a media query gets wrong,
and not at all on a mouse. A touch drag turns twice as far per pixel as a mouse drag, because a thumb
has a phone's width to work with; the stick held at its rim for 400 ms is the flight's boost, the one gesture a
thumb can make without leaving the stick (on foot, with `?redotcom`, it is simply a full stick: the walk has no boost); and a round fullscreen button sits above the lift buttons,
which on a phone also asks for a landscape lock. The canvas is `100dvh`, so the picture's centre is the
screen's whether or not the browser bar is showing, and the pixel ratio starts at 1.5 on a coarse
pointer and adapts (`main.ts`, `adapt`): frames over 24 ms step it down to 0.75, frames under 12 ms
step it back up.

Everything the viewer draws over the map goes in one strip along the top: the site bar (the back link, then Controls,
Settings and GitHub, one size, each its mark alone under 480px), with the panel or the Controls popover beneath it. The
panel starts folded everywhere, leaving only the bar (a remembered choice still wins), its body scrolls inside itself, and
the status line is two dim lines whose whole text is its tooltip. The lift buttons clear the browser's own bottom
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

- **The world is drawn unlit, and a multiplayer frame is not brightened.** The EE emits the VU1 light command only
  for a node flagged `m_dynamic_motion` or `m_dynamic_light`; on most maps that is nobody, and the
  vertex colours the exporter baked go to the GS untouched (`viewer/src/lighting.ts`). The campaign's post-process
  multiplies every pixel, fog included, by `1 + FIX/128` twice (FIX 89-93 on the Seeding Chaos spawn), but a
  multiplayer round has it switched off -- the exposure block at `0x488e48` reads enable 0 and pass count 0 on a live
  Frostfire round -- and PCSX2's Vigilance and the recompiled Frostfire agree with the bare frame band for band
  (`docs/research/82-map-fidelity-audit.md`, D1). The viewer opens at FIX 0; the slider keeps the campaign's look.
  The rig from `GlobalLighting` is exact and is applied to the flagged nodes only.
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
- **Each placement draws its own baked light.** A model instanced in several places carries a chunk per instance
  context, differing only in its prelit vertex colours; `hookupVisuals` numbers the contexts in load order, the copies
  inside the prototypes first and the world's placements after them (`contextsBefore` in `scene`), and each placement
  draws its own (`instanceShades` in `loadMap.ts`). Frostfire's tank rails drew the prototype's bare material colour
  before, neon beside the prelit bridges (`docs/research/82-map-fidelity-audit.md`, D2).
- **The mip level is the GS's.** A mipmapped texture samples the level `TEX1` gives off the depth,
  `(log2(w) << L) + K` clamped to `0..MXL`, not the GPU's derivative LOD; with the corpus's K of -12 to -6.5 most never
  leave the base level (`gsMipLod`, `world.ts`'s `gsTexel`; research 82, D3).
- **The mip levels are the disc's, and the reflective surfaces get their pass.** A mipmapped texture uploads the records
  its `MIPTBP1` names (a detail texture's level 1 is transparent: the detail fades with distance). A draw whose visual
  names a textured `Material_Palette` entry -- the water, glass, ice -- gets VU1 `0x34`'s environment-map pass: a sphere
  map of the reflected eye ray in the entry's texture and colour, faded by its rim alpha (`world.ts`, `envVertex`).
  The PS2 picture renders with no antialiasing, as the GS did (research 82, D3b, D5, D6).
- **LOD by range.** `READERM.ZAR/lod.rdr` pairs models into bands with fade-in and fade-out ranges
  (`railings_high` out at 100-120 units where `railings_low` comes in, on the same rails), and the
  world root's `LOD_Object` holds the same numbers squared for `CVisual::DrawLOD` to compare the
  camera's range against. Each placement of a banded model is its own mesh and fades across its band as
  `DrawLOD` scales it: the ramp is linear in the range *squared* (the disc stores `1 / (far² − near²)`),
  so the two copies of a pair sum to one across the crossover and each is at half at 110.45 units, not
  110 (`lodOpacity` in `scene`; a copy at rest keeps its shared material and only a fading one takes a
  blended twin, `viewer/src/lodFade.ts`). The "scaled" range `GetScaledRangeSquared` is a stub in
  reCOM, so the plain distance is used.
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
- **The engine's grid is built, and its draw order is a switch.** `grid_params` in every world root is
  reCOM's `tag_GRID_PARAMS` (atom count 8192, posts 16, the cell dimension, the cells across and down; no
  origin is stored, it is always 0): Frostfire is 160 units, 8 × 9. `scene/grid.ts` generates the cells as
  `CGrid::Create` does, files every placement, clutter instance and collision-owning node into each cell its
  bounds cover -- one atom per cell, the bound chopped to single precision as the EE chops it, which is what
  reproduces the console's census of 414 world atoms and 117 prop atoms on Frostfire -- and walks the rings
  outward from a cell in reCOM's diamond (`|dx| + |dz|`). `CPipe::RenderWorld` draws in that walk with depth
  written under every blend (`ZMSK = 0`, research 26 §2); the viewer can ("engine draw order" under
  Advanced, recomputed when the camera crosses a cell, shadows and decals after the last ring). It is off by
  default: the 22-map sweep is identical either way, but near-first with depth under every blend makes a lamp
  flare drawn before the pipe behind it cut a rectangle out of it, so that is not the whole of what the
  console did for the flares, and their pass is the open question. By default blended draws go to three's
  back-to-front sort with no depth written; each draw's place in the scene-graph walk (`LoadedMesh.order`)
  stays as the tie-break.
- **The detail texture pass is drawn.** `mp<N>_lib.rdr`'s `detail{name, uv, range, bmode}` per texture is
  the record the engine compiles into every visual (2,395 of 2,395 visuals with a bound texture carry one);
  the viewer draws a second mesh over the base's geometry with the detail texture at `uv` times the base's
  uvs (8 on Frostfire's oil-grime floor, 2 to 10 across the disc, not the 4.0 the mission dumps showed),
  blended as `bmode` says (`COLORBLEND` is `ALPHA 0x44`, `ADDITIVE` is `0x48`), depth less-or-equal (the
  records' own `GEQUAL`) with no depth write, fading per fragment to nothing at the root of the squared
  `range`. The engine switches the whole pass on per visual by its centroid's range instead; the viewer's
  merged draws have no centroid, so it fades (the sprint's W1.R7). "detail pass" under Advanced.
- **The spawns come from the disc.** `AIMAPS.MPS` -- not a ZAR -- is fully decoded (`scene/aimaps.ts`,
  `docs/research/75-aimaps-mps.md`): a head, per sub-map a header, the cells as row spans and eight counted
  tables, and a trailer with the spawn list of 24 slots a side, each a cell with a side bit and a facing.
  `PlayerStart` turned out to be one named cell, not a region. The slots are drawn under the **spawns** toggle
  as a cell outline and a facing arrow per side, each standing on the probe's floor under its centre (all 1,058
  do), beside the measured A and B; the camera opens at A's (x, z), 20 units over the probe's floor there (on
  the 20 maps whose A is the orbit camera's position that is 12.7-31.2 units lower than the recorded y + 20 it
  used to stand at), and which of the 24 a player gets is game logic (A was always side 0's first slot and B
  side 1's second in the recorded rounds).
- **The ground is the engine's.** `scene/probe.ts` is the game's ground probe (`FUN_002d3030`'s per-model
  gate, the vertical line, first hit per model in surface order, the pick chosen as research 24 §2 says),
  over the grid's collision atoms: 3,318 world-space polygons on Frostfire, the engine's own count once the
  `di` the exporter copies onto nested instance nodes -- which the engine never keeps -- is dropped. The four
  actor-measured spawns land within [−3, +1] of it; the forty online-sweep rows in `spawns.ts` turned out to
  be the orbit camera, 25 units above the floor and 23 behind the actor. The walk (`viewer/src/walk.ts`) is a
  60 Hz fixed-step mover on that floor.
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

### The player

Settled in web sprint 2 (the sprint 2 spec's §7, cited by finding):

**The speeds are the game's file, the ramp and the fall its code** ("The game's movement law: the ramp is on the
stick, the speed is linear in it, the fall is 2.4 g"). `READERC.ZAR/motion.rdr` gives each SEAL clip a
`max_velocity` in metres a second (`scene/src/tuning.ts`, pinned against the disc's file): at `MetersPerUnit` 0.1
that is 65 units a second forward at a full stick, 37 back, 65 strafing; the crouch bands 14.8, 13.5 and 15, which
the crouch plays at 0.946 of them whatever the push (14.0 ahead, 12.8 back, 14.2 aside); prone 11 crawling and 5.5
sideways, along one axis, from the first tick. The ramp is on the stick, not the speed (`FUN_00586c10`): each axis
moves toward the pad at 2 to 5 stick units a second, so a full push is at 90 % on tick 11 and full on tick 12, a
fifth of a second; the speed is linear in the stick (`FUN_0058bdf0`), a released stick stops at once, and a full
push in crouch (0.838 or more, with 19 units of headroom) stands the SEAL up and runs (`FUN_00584c60`). A drop of
more than 8 is a fall under `dynamics.rdr`'s gravity 235 units a second squared, 2.4 g (`FUN_0059b440`), the
horizontal speed held from the edge: a 42-unit drop lands in 0.60 s (`viewer/src/walk.ts`).

**The camera is `FUN_0029a950` and `FUN_0029bf70`, nothing fitted** ("The game's camera: the pitch pulls the eye
in, there is no tether, and the console's eye falls out to 0.001"; `viewer/src/playerCamera.ts`). The target is
the skeleton root's height plus a ramp that saturates at 10 above a root of 5.6; the eye lies along the look,
pitched, `28 − 14 × |n.y|` from it, so it comes in as the camera looks down or up; the rest pitch is
`init_aim_pitch`, −9.167°. There is no tether (`cam_tether_stiff` has no reader): the collision pass pulls the eye
in at once to 0.75 short of the hull and lets it out at 3 % a frame after 1.5 s. Crouched at the spawn that puts
the target 15.378 over the feet and the eye 19.603 over them and 24.906 behind -- the console's placed eye on the
spawn dump, to 0.0003; standing, the target is 21.484 and the eye 25.709 up.

**The stances and the body are measured on the console's dump and frame** ("The SEAL is 19.6 units tall, and the
console's spawn dump holds a crouched player"). The skeleton root is 11.484 over the feet standing (the 24 actors at
the bind pose) and 5.504 crouched -- the dump's player is crouched: its root under the game's own stance test of 9.0,
a knee on the ground; prone 1.8 is an estimate. The body (`viewer/src/body.ts`) is a stand-in at 19.6 units
standing (1.96 m: the standing head joint 17.37 plus the head's 2.23 measured on the frame), 12.4 crouched and 5.1
across the shoulders, in the world's shading with the frame's own colours; the first-person eye, 18.3, is an
estimate.

**The reticle and the rifle are the disc's** ("The console's reticle: two bitmaps at one texel per pixel, a
65-pixel cross on the frame's centre"; "The SEAL's rifle and the game's own bullet mark"). `HUD2_TXR.ZED`'s
`ret_rifle_01.tif` (a 64×64 ring and dot) and `ret_rifle_02.tif` (a 32×32 arm, drawn four times) at the console
frame's size, one texel to a PS2 pixel, scaled by the height / 448 in the Modern picture (`viewer/src/reticle.ts`).
The rifle is `ZWEAPON.ZAR`'s M4A1, first in every `mp_seal1` kit (`scene/src/weapons.ts`): `FireWait` 0.12 s (500
rounds a minute), 30 rounds and three magazines -- the console's "30/30 · 2 MAGS" -- and a 1000-unit ray against
every polygon of the hull (`viewer/src/fire.ts`); where it lands goes `decals.rdr`'s `bullet_mark_stone.tif` off
`EFFE_TXR.ZED`, 1 to 1.8 units wide.

**The gunplay is the game's** ([research 84](docs/research/84-accuracy-and-recoil.md)): the SEAL's M4A1 SD
(`HELD_RIFLE`) fires to `Maximum_Range` x 10 units; its reticle opens with the walk, the look and each round and closes
at the weapon's own per-stance rates (`viewer/src/accuracy.ts`), halved in third person; a round climbs the whole
reticle up the screen (the recoil you see unscoped -- the camera does not kick there) and goes inside it by the
game's cone; semi, burst and automatic (`B`, L3; burst at spawn); the right button steps the view third -> first person -> the 3x
scope and back, d-pad Up and Down step it in and out (`viewer/src/zoom.ts`, the scope's tube and dashed cross off `HUD2_TXR`).

**The rifle is in the SEAL's hands, raised to fire as the game raises it** (the sprint 2 player spec's §6, "The rifle
in the hands, the Fire set, the kick and the satchel"). The body makes a `rifle` node under `rhand` with the rifle in
hand (`FUN_00553290`); the clips' `rifle` track (`weapon` in the few SOCOM 1-named ones) poses it and the M4A1 SD
hangs on it at its grip (`viewer/src/heldItem.ts`). The trigger raises the rifle over 0.1 s and it stays up 5 s after
the last round, then falls over 0.5 s (`FUN_005dfe30`, `FUN_005dfc80`, the controller's 5.0 s at `FUN_00598280`;
`viewer/src/weaponRaise.ts`); while up, each clip's **Fire** version (`seal_fp_stand`, `seal_fp_walk`,
`seal_fp_crouch` ... twelve pairs, `FUN_005e0690`) blends in at that weight (`viewer/src/weaponPose.ts`, a pose layer
over the clips). A round leaves the posed weapon's `firepoint` toward the point under the reticle; in a scope the
first round of a pull kicks the aim's pitch by the stance's `FireRifleKick*` (`FUN_005b91c0`/`FUN_005b9280`, on in the
image, gated to the scope as the game gates it: research 84 section 8; `viewer/src/rifleKick.ts`), and `R` plays the stance's reload clip for its `motion.rdr` playback (1.6 s standing).
The satchel is hung but hidden, as the game hides it until the SEAL picks up the bomb (`FUN_0059df60`). `Fire`'s
`subscribe` is the audio's hook: a `round` event (the weapon's name, id, muzzle animation and sound names, the fire
point in the world, the end, the hit, the rounds left), `reloadStart` (its seconds) and `reloadEnd`.

**The HUD is the game's** ([`docs/research/87-hud.md`](docs/research/87-hud.md)): `CHUD`'s own rectangles read out
of the ELF -- the ammo box's `newweapnbkrnd.tif` over x -10..160, y 364..439, the weapon icon at (20, 389), "30/30" and
"2 MAGS" at scale 0.9 on the baseline 382, the fire-mode rounds at x 10, 51, 87, the compass ring `compass_lo.tif` at
96x96 on (565, 90) turned by the heading, the info box's health bar at (488, 396) -- drawn from `HUD_TXR`, `HUD2_TXR`,
`HUDW_TXR` and `FONT_TXR` (the font a PSMT4 texture `@s2u/gs` now reads, every HUD bitmap stored bottom row first) with
`fonts.rdr`'s `font_text_01` glyphs; each element's pixels within a pixel of the console frame's (`e2e/hud.spec.ts`).

## Known gaps

- **The SEAL is a stand-in.** The body is a mannequin at the measured size whose legs swing by a stride model;
  the real model (`CLIB_GEO.ZED`'s skinned `CMesh` chain, the `0x70` unpack no decoder here reads), its 32-node
  skeleton and its animations (`MPZANIM.ZAR`, unopened) are web sprint 3's first candidate. With them would come
  the jump (a clip's root motion), the clips' 0.2 s blend-in, and the rifle's `firepoint`.
- **The shot's effects are not drawn.** The round leaves the rifle's `firepoint` (above), but the muzzle's CZANIM
  animation (`muzzle_m4`: the shell, the flash hider's flash, the smoke; the M4A1 SD's `muzzle_m4SD` has no flash)
  is not played -- the zAnim command payloads are not decoded (research 77 §10). An empty magazine does not reload by
  itself (`R` does), and no bullet surface class was found, so every polygon stops a round. The scoped sway moves the
  rounds but nothing on screen (no reader of it that draws was found: research 84 section 8).
- **Materials are not modelled.** The stone row's bullet mark is drawn on every surface, the mark is unlit, and
  the material half of the camera's surface test is left out.
- **The walk is the decompilation's reading, not yet measured on the console.** The speeds, the ramp and the fall
  are the game's tables and the decompilation's law (`viewer/src/walk.ts`'s header); the console measurement
  (W2.2c: the instruments and the recipe are in the tree, [research 79](../docs/research/79-seal-speed-on-the-console.md))
  waits for a window the owner names. Until it runs the prone root (1.8), the prone body (3.0), the first-person
  heights (the eye 18.3 standing, and the crouched and prone eyes derived from it) and the crouch and prone body
  columns are estimates, and two numbers are readings only: the crouch diagonal's speed-up along its axis (19.8 at
  45°) and the headroom ray's start (the feet + 14). The slope and water slow-down are not modelled.
- **A kerb between 6 and 6.5 units over a lower floor is passed over.** The floor selection takes the highest
  floor at or under the feet + 6, so such a kerb, climbable by the step rule, is walked under for the floor below
  (inherited from the selection, not the step rule's). The record's layer mask is probed as all layers (the
  literal reading contradicts research 24's own walk); and the slot outlines are drawn without a depth test
  because a slot's cell is flat where its ground is not (362 of 1,058 have a corner more than a unit off the
  floor under the centre).
- **The HUD pass has not been seen under WebGPU.** The reticle's layer is pinned by the e2e, but no one has yet
  looked at it on a WebGPU browser (W2.4's review); that look is owed.
- **Region culling, the flares' place in the engine order, the LOD twin.** The per-node region bits (node flags
  13-17) are on the disc on 8 maps and the collision polygons carry masks over the same bits on 6, but the
  writer of the camera's visible set (`CanSeeRegion`'s other operand) is not in the tree, so nothing is
  culled by region; and the engine draw order stays a switch until the pass that keeps a flare from cutting
  the wall behind it is found (the sprint 1 spec's §7), the LOD twin under that order with it. The two facade
  modes are drawn alike, reCOM's `ComputeFacadeMatrix` being a stub.
- **Animated map objects beyond the uv scrolls are not drawn.** The door animations (`actions.rdr`,
  `MOTION_S.ZAR`), the destructible states, and the particle effects (`COMMON/EFFE_*`:
  `fire_hardedge.tif` and the smoke sprites) are driven by game code the viewer does not run; the
  flames are effect emitters, not map geometry.
- **The one EE-animated `FIX` glow** (`lightglow.tif` on MP61, `(Cs - 0) * FIX + Cd`) is drawn additive:
  its factor is game logic, and at rest it draws nothing.
- **The auto-exposure is a slider.** A multiplayer round never runs it (the viewer opens at FIX 0, as the round
  draws); the campaign meters `FIX` per frame from a grid of frame pixels and applies it twice, which the viewer
  leaves to the slider.
- **The ISO source has met no retail disc yet.** It reads ISO9660 (the primary volume at sector 16, `;1`
  names, files by LBN) and was checked against images written by an independent library in four flavours
  (plain, Joliet with Rock Ridge, a UDF bridge, El Torito), but no SOCOM II image was on the host that built
  it. A raw 2352-byte `.bin` and a multi-extent file are refused by name rather than read.

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

## Multiplayer server (web sprint 3)

`packages/server` is the match server behind the viewer's `?redotcom&mp` mode: one timed respawn match per map, HTTP
`/health` and `/metrics` and a WebSocket on `/ws`, all on one port. It reads `RUN/` (`MP*.ZDB`, `MOTION_P.ZAR`,
`READERC.ZAR`) from `SOCOM_DISC`, your own copy of the disc, which it never serves.

```
SOCOM_DISC=/path/to/disc npm start -w @s2u/server        # PORT 8787; MAPS, IDLE_KICK_MS, ROUND_SECONDS, MAX_ROUNDS
```

Join from the viewer with `?redotcom&mp&server=ws://localhost:8787/ws` (`wss://` behind TLS).

To run it on a host, `deploy/` holds a Dockerfile (an esbuild bundle in a slim Node 22 image, build context `web/`), a
compose file with Caddy for HTTPS, a systemd unit for the no-Docker case, and `deploy.sh`. The owner's steps, the
Lightsail size and the firewall are in [`deploy/README.md`](deploy/README.md). The disc is mounted read-only at run
time and is never part of an image.

### Playing a match

Open the viewer with `?redotcom&mp` (the server at this page's host, `/ws`) or `?redotcom&mp&server=wss://host/ws`, on the
map you want: each map is its own match. The page joins as a SEAL or a Terrorist by the game's join rule (research 91
§7); past 16 players it spectates, and is moved in, first come first served, when a place frees up.

| key | in the match |
|---|---|
| the walk's keys | as in single play: the page predicts its own SEAL and the server agrees (W3.R8) |
| X | respawn, once "Press the X button to respawn." shows (5 s dead; the press counts once the body has faded, 10 s) |
| Tab / Select | the scoreboard: every player, the game's sort, the dead dimmed, the spectators |
| K, then 1-9 | the vote to remove a teammate (TEAMMATES, VOTE RETAIN / REMOVE; passes on more than half the team, at the round's end) |
| Space / V | spectating: the next living player / the free camera |
| Settings > Multiplayer > name | your name, 30 characters at most; blank is the game's `Player####` |

A match is the original's SUPPRESSION with RESPAWN on: one 6-minute round, "TIME EXPIRED" and 15 s more, the side with
more points wins, then FINAL ROUND and GAME COMPLETE, and the next match. `?lag=100&loss=2` runs the page's latency and
loss injector (ms each way, % of frames). `npx tsx tools/mp-bots.ts --spawn-server --disc test-fixtures` measures a
server under 16 bots and 8 spectators.
