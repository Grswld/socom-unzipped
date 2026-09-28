# Web sprint 2 — "the SEAL in the world" (design)

> The browser project's second sprint, written 2026-09-28 07:50Z on the owner's word of the same morning: *"we're
> expanding on the walk functionality as much as we realistically can with engine reimplementations. Crosshair, a
> model, the correct height and movement speed as per the game/recom, simple shooting. Prioritize height, speed, stand
> in model, the rest in any order. Take as long as you need, we're going for accuracy"* — and, an hour later, *"turn
> settings into a single cog settings button beside unzipped and give github an icon"*. Plan:
> `../plans/2026-09-28-web-sprint-2.md`. Previous specs, in order: `2026-09-20-web-map-viewer-design.md` (M0-M4),
> `2026-09-26-web-map-viewer-polish-design.md` (the accuracy pass), `2026-09-28-web-sprint-1-the-engines-world-design.md`
> (the grid, the probe, the walk; its §7 and §8 are cited below as "S1 §7", "W1.Rn"). Tree at the write: `agent/web-s1`
> at `e052c109` (PR #100 merged 05:32Z), `web/` at 531 tests in 45 files (528 pass, 1 fails on this host, 2 skip —
> the plan's Task 0 names the failure), three fixture maps under Playwright.

## 1. What was asked, and how it is read

The owner asked for the walk to become the game's player as far as a re-implementation in TypeScript can carry it,
in this order: **the height** and **the speed** as the game has them, then a **stand-in model** for the player's body,
then a **crosshair** and **simple shooting** in any order. "As per the game/recom" names the two authorities: the
game's own data and decompilation (`game/analysis/socom2_game.elf.decomp.c`, the r0001 ELF's strings, the console
memory dump `logs/parity/spawn_pcsx2.rdram`, and the compiled scripts in `RUN/READERC.ZAR`), and reCOM
(`research/recom/`), the SOCOM 1 source reconstruction whose headers name what the decompilation only numbers.
"Accuracy" is read as: every constant the walk uses is the game's, read from the game's own file or measured on the
console, and cited; where a number cannot be had this sprint, the spec says so and the code says so.

**What the game's walk is.** Two findings settle the reading before the batch is cut:

- **The game's player is seen in the third person.** The console frame at spawn (`scripts/parity/refs/console_spawn_slot8.png`,
  640×448) shows the SEAL's back and shoulders low in the frame, the camera behind and above, the reticle a
  yellow-green cross at the frame's centre. Research 17 §1-§3 measured that camera at rest: the look-at target
  **15.38 units over the feet** (skeleton root Y 5.504 + the ramp `5.5 + 4.5 × clamp((rootY − 2.169155) × 0.2914734)`,
  `FUN_0029a950`), the eye **28 units behind** the target before the tether and collision pass (`FUN_0029bf70`), and
  the placed eye **20.107 over the ground, 24.2 behind** the actor. Sprint 1's walk looks from a first-person eye at
  15.4 (W1.R2) because the third-person camera's smoothing "was not that sprint's". This sprint's, it is: **"the
  correct height" is the game's camera, with the body in the frame** — the first-person eye stays as a switch
  (**W2.R1**).
- **The game's speed is a table, not a constant.** `READERC.ZAR/motion.rdr` (decoded 2026-09-28 with
  `@s2u/archive`'s `parseRdr`; the game's own file, not reCOM's SOCOM 1 copy) gives every SEAL locomotion clip a
  `max_velocity` in **metres a second** and a `transition_speed_A/B` band: `seal_walk` 0-2.6, `seal_jog` 1.9-5.0,
  `seal_run` 4.01-6.5, all `max_velocity 6.5`; `seal_walk_bw`/`seal_run_bw` 3.7; the strafes 6.5 (`seal_p_*`, the
  pistol set, 5.5 right and 5.0 left); `seal_crouchwalk` 1.48, `_bw` 1.35, the crouch strafes 1.5; `seal_prone_crawl`
  1.1, the prone strafes 0.55; `seal_climbladder` 1.35. At `MetersPerUnit 0.1` the standing run is **65 units a
  second** — exactly the root-motion velocity research 25 §0 read off `FUN_0028c250` for a forward walk, (0, 0, −65),
  and the backward 3.7 m/s is its (0, 0, +37). Sprint 1's 40 units/s (research 18 finding 3) was a 4 s hold's
  *average* on our recomp, the ramp and the camera's lead included; the same note's "implied steady rate" was 51 and
  it called the number "a burst-sizing heuristic, not a speed". **The speed is 65 at full stick, with the game's
  ramp** (**W2.R2**); how the stick's throttle and `dynamics.rdr`'s `fb_accel 0.01`, `lr_accel 0.01`, `throt_exp 1`,
  `lower/upper_x/z_accel 2/5` shape the approach is the decompilation's to say and the console's to confirm (§4, W2.2).

**The tuning the game reads, now in hand.** `READERC.ZAR` (1,026,848 bytes, 55 compiled scripts) decodes with the
viewer's own `Zar` and `parseRdr` unchanged; `dynamics.rdr` is the `CharacterDynamics::Load` table reCOM
transcribes (`zCharacter/char_dyn.cpp`): `gravity 235`, `jump_factor 0.85`, `ground_touch_distance 8`, `max_slope 50`,
`step_height 6.5`, `FALLING_DAMAGE_LIGHT/HEAVY/DEATH 6.2/9.1/12` (metres), `turn_maxrate 2` (research 22's ω = 2.0 ×
axis), the aim and look limits, `BOBBING_FIRSTPERSON (Walk 6 @ 15, Crawl 4 @ 8)`, `cam_back/side/first/full/peekl/
peekr` offsets (`cam_first_height 20.5, cam_first_dist 13, cam_first_aim (0 20.5 −2)`), `cam_tether_stiff 0.95`,
`cam_peek_decay_rate 6`, `low/med/high_climb_height 1.3/2.15/2.65`, `min_stand_height 1`, `min_jump_height 2` (metres:
the console dump's table at `0x44c250` holds them ×10, research 17 §8). Note that `FUN_0029a950` hard-codes the
28-behind and the 5.5-10 ramp rather than reading the `cam_*` block; the measured console camera is the authority
over the script where they differ. `controller.rdr` names the game's own inputs: `MoveLong` (left stick vertical),
`Strafe`, `Rotate`, `Pitch`, `Fire` (R1), `Jump` (Square), `Action` (X). `hud.rdr` holds no reticle geometry; the
reticle is code (`BitmapReticule` in reCOM `Apps/FTS/hud/hud.h:465-520`: `m_minsize`, `m_maxsize`, ten
`m_reticuleTex`, four `m_floatingreticule` polys, `m_accuracyxtex`) over bitmaps every map archive carries:
`RUN/COMMON/HUD2_TXR.ZED` in every `MP*.ZDB` holds `ret_rifle_01/02.tif`, `ret_sidearm_01/02`, `ret_shotgun_01/02`,
`ret_scope_01/02`, `ret_accuracy.tif`, `ret_threat.tif` and the nav/objective marks, decodable by `@s2u/gs` as any
texture is. `WEAP_GEO.ZED` (weapon models) and `CLIB_GEO.ZED` (the character library) ride in the same archives.

**What is out of reach this sprint, said plainly.** The SEAL's own model is a `CMesh`/`CSubMesh` chain with the
`0x70` skinned unpack (`SEMANTICS.md`'s w-lane row; research 72's `CLIB_MDL` caveat) that no decoder in the tree reads, plus a skeleton
of 32 nodes with parent-relative transforms (the console dump: `actor+0x170` holds the instance inline, 32 nodes
from `0x1715940`, the root's Y 5.504 and the rest fractions — local, not world) and an animation format
(`MPZANIM.ZAR`) nobody has opened. That is a sprint of its own; the owner asked for a **stand-in**, and a stand-in
it is (**W2.R3**). The game's movement collision is not decompiled either (S1 §7, the walls are research 24's
inference); this sprint keeps the probe and the wall slide and adds the vertical the game has.

## 2. Where it stands (2026-09-28)

`walk.ts` (508 lines): a 60 Hz fixed-step mover on the probe's floor, walls at radius 3.5, the fly camera's
velocity model (`ACCEL 14`, `BRAKE 8`) at `WALK_SPEED 40` with a 2.5× boost, `EYE_HEIGHT 15.4`, `MAX_DROP 20` (no
gravity, no fall), `G` and a panel switch, the debug hook's `mode/setMode/walkFor/feet`, a Playwright route from A to
B on Frostfire. `camera.ts` in walk mode looks only (`setWalking`, `moveTo`, `groundWish`). `stand.ts` opens the fly
camera 20 over the probe's floor at A. The page's chrome: a floating `#site-links` bar ("II Unzipped", a GitHub text
tab), the `#panel` overlay under it whose title bar reads "Settings" and folds the panel, About and Advanced
disclosures inside. No crosshair, no HUD, no body, no weapon. Tests: 531 in 45 files; e2e `viewer.spec` (2),
`walk.spec` (1), `iso.spec` (2).

## 3. Goal and bar

**Goal:** a person opens Frostfire, presses the walk key, and sees what the console showed at spawn — the SEAL's
stand-in body from behind, the camera where the game's camera is, the reticle where the game draws it — then runs
at the game's speed and ramp, backs and strafes at the game's speeds, drops off the deck and lands under the game's
gravity, and fires at a wall and sees the hit where the ray met the hull; the settings behind one cog beside the
brand, GitHub behind its mark.

**The bar (section 6 is the check):**

1. Every task lands with a unit test that fails first and reproduces a number from the game's own record — the
   file, the decompilation, the console dump or a console measurement — and the code cites where the number came
   from.
2. `npm run typecheck`, `npm test` and `npm run build` green on CI at every merge; the Playwright e2e green locally
   at the close, the three sprint 1 specs included.
3. **Height:** at rest on Frostfire's spawn A the viewer's third-person eye is within **±0.5 unit** of the console's
   (20.107 over the ground, 24.2 behind, target 15.38 over the feet: research 17 §1 table); the first-person switch's
   eye is the measured head height (W2.3's number), cited.
4. **Speed:** the mover's steady forward speed is **65.0 units/s**, backward 37.0, the strafes 65.0, crouch 14.8 /
   13.5 / 15.0, prone 11.0 / 5.5, from the game's table read off `READERC.ZAR` by the same decoder (a fixture test),
   and the ramp is the decompilation's law; the console measurement (W2.2 step 5, lock-bound) confirms the steady
   forward speed within **5 %** and records the ramp's time to 90 % — a disagreement beyond 5 % is a `docs/KNOWN.md`
   row and the measured value wins (**W2.R7**).
5. Nothing regresses on the 22-map sweep (`tools/map-health.ts`): no map gains a diagnostic, none loses a draw.
6. The README's "Controls" and "Known gaps" rewritten to what is true at the close; every finding dated in §7.

## 4. The batch

Ordered as the owner ordered it — height, speed, body — with the chrome request first because it is an hour old
and small; then the crosshair and the shooting. Sizes are one Opus implementer's sitting: S under two hours, M half
a day, L a day. None needs the build lock except W2.2's console measurement, which is a PCSX2 run and goes under
`loop_lock.sh run` in a window the owner is not working in.

### W2.0 — The chrome: one cog, the GitHub mark (`viewer`, S)

The panel's "Settings" title bar goes; in its place a **cog button in `#site-links` beside "Unzipped"** (an
`s2u-iconbtn`, inline SVG, `aria-label="settings"`, `aria-expanded`, `aria-controls="panel-body"`) that folds and
unfolds the panel exactly as `#panel-toggle` did (`ui.ts` 193-218: the stored choice, the coarse-pointer default,
`panelCollapsed()` for the hook). The panel keeps its kicker as its first line. The **GitHub** tab keeps its text on a
wide screen and gains the GitHub mark (inline SVG, `currentColor`, 16 px) before it; under 480 px the text may go
and the mark stays, `title` and `aria-label` intact. `ds/` is not touched (the manifest guard). The e2e's
`#panel-toggle` click (`viewer.spec.ts:73`), the phone tests (278-300) and the magenta check follow the new ids.
**Visible outcome:** the top-left corner is the brand, a cog and GitHub's mark; the panel is what the cog opens.

### W2.1 — The game's camera (`viewer`, M)

`playerCamera.ts`: the third-person camera as `FUN_0029a950` → `FUN_00297410` → `FUN_0029bf70` → `FUN_0029bc90`
compute it (research 17 §2-§3): the target at `rootY + ramp(rootY)` over the feet (rootY 5.504 standing; W2.2's
stances lower it), the eye 28 behind along the facing before the pass, the lean/peek offset on x (`DAT_004161c0 ×
2.5 / 2.8`), the tether (`cam_tether_stiff 0.95`, `cam_net_pos_smooth`), then the camera-collision pass: four segment
probes against the hull (`FUN_0029bf70`; the implementer reads the decompilation for the probe geometry and the
pull-in rule, and reCOM `zcam.h` for the names), which is what turns 28 behind into the measured 24.2 at spawn. The
mouse turns the body's yaw and the camera's pitch as `Rotate`/`Pitch` do (research 22: ω = `turn_maxrate` × axis; the
pitch through `pitch_rate`, the limits `max/min_look_pitch`); the aim point is what the reticle sits on (W2.4).
**First person** stays as a switch (`V`; the panel's walk row gains it): the eye at the head, W2.3's number.
**Tests:** at spawn A with the hull in place the placed eye is within ±0.5 of (20.107 up, 24.2 behind) and the
target within ±0.05 of 15.38; against a wall behind the actor the eye pulls in and never enters the hull; the ramp at
rootY 5.504, 5.6, 2.169 and 0 gives 9.874, 10.0, 5.5 and 10.0 (the "no root" fallback research 17 §3 names). **The
number the sprint owes research 17:** the tether and the pass are read, not measured; the sprint records how far
the reading gets in §7. **Visible outcome:** the walk looks like the console frame.

### W2.2 — The game's speed, ramp and fall (`scene`, `viewer`, M + L lock-bound)

`tuning.ts` in `@s2u/scene`: the SEAL's numbers as a typed table — the locomotion bands from `motion.rdr`, the
dynamics from `dynamics.rdr` — **transcribed with a fixture test that decodes `game/disc/RUN/READERC.ZAR` with
`parseRdr` and asserts the table equals the file** (the served tree lacks `READERC.ZAR`; `extract-maps.ts` starts
copying it and `ZWEAPON.ZAR` beside the maps, the fixture tests read them there, and the ISO source reads them
now, so a later sprint reads the table live: **W2.R5**). `walk.ts`: the mover's target
velocity from the stick (`MoveLong`/`Strafe`, the keyboard at full deflection, the touch stick analogue) through the
throttle law the decompilation states — the research step names the function (handles: `FUN_00553dc0` MoveScale,
`FUN_00550ef0` the turn law, `FUN_0057a330` → `FUN_0028c250` the root-motion velocity words at `actor+0x2c`, the
tuning table at `0x44c250` +0x110 `fb_accel`, +0x114 `lr_accel`, +0x118 `throt_exp`, +0x44..0x50 the accel limits)
— capped by the band the stance and direction select (forward 65, back 37, lateral 65, crouch 14.8/13.5/15,
prone 11/5.5), the ramp replacing the fly camera's `ACCEL/BRAKE` on the ground. **Stances:** crouch and prone as
states (`C` cycles, as the game's d-pad does), each with its band and its rootY for W2.1's ramp — the standing rootY
is measured (5.504); the crouch and prone rootY are not in the tree and are measured in step 5 or, failing the
window, estimated from `min_stand_height` and marked. **The fall:** `MAX_DROP` goes; a floor further than
`ground_touch_distance` 8 under the feet is a fall under `gravity 235` units/s² until the probe's floor is met
(`step_height` 6.5 climbs, `max_slope` 50° refuses), `Jump` (Space) at `jump_factor` as the decompilation applies it
if the sitting allows, else recorded. **Step 5 (lock-bound, L):** the console measurement — PCSX2 with the r0001
disc, a savestate at Frostfire's spawn, `tools_py/parity/state_poll.py` sampling the actor's position words
(`*0x408c58+0x1c:3`) and the guest clock (`0x4365c0`) over PINE while `drive.py`/`pcsx2_shell.py` hold forward,
back, strafe, then crouch and prone forward, 6 s each with a release between; the slope of the steady segment
against the guest clock, the time to 90 % of it, and the rootY (`*0x408c58+0x2e8*+0x04`) per stance; the table in
§7, the numbers into the tests. Ours (the recomp) is not the reference here: it renders 18.7 game frames a second
(KNOWN). **Visible outcome:** a run across Frostfire takes the time it takes on the console, and the deck's edge is a
fall.

### W2.3 — The stand-in body (`viewer`, S/M)

`body.ts`: a mannequin at the SEAL's proportions drawn under the camera — a capsule torso, a head, two legs that
swing with the speed (the walk/jog/run bands drive the stride rate; a stand-in, not the animation) — in the world's
material path so the fog and the brighten apply; facing the body yaw; the first-person switch hides it. **The
dimensions are measured, not guessed:** the standing height from the console frame at spawn (the camera is known
to the unit from W2.1: the head's top row projects to a height), cross-checked by composing the 32 skeleton nodes'
local transforms from the dump (`0x1715940`, stride and layout to be read off `FUN_0028e040`'s writes, research 17
§8) if the sitting allows; the width from the body radius 3.5 (W1.R2) until measured. The crouch and prone stances
lower it to W2.2's rootY. **Tests:** the mannequin's bounds at each stance; the head height equals the first-person
eye (W2.1). **Visible outcome:** the SEAL's place in the frame is the console's.

### W2.4 — The crosshair (`viewer`, `gs`, S/M)

`reticle.ts`: the game's own `ret_rifle_01.tif` and `ret_rifle_02.tif` from `HUD2_TXR.ZED` (already in every
archive the viewer opens; `HUD2_PAL.ZED` beside it), decoded by `@s2u/gs`, drawn as the HUD quad at the size and
place the console frame shows (measured in 640×448 pixels off `console_spawn_slot8.png`, and scaled with the
PS2/Modern presentation as the frame is), centred on the aim ray's screen point (W2.1). `ret_accuracy.tif`'s bloom
with the run (the `m_minsize`/`m_maxsize` pair) if the sitting allows; the sidearm and shotgun pairs are a switch
for a later sprint. **Tests:** the two bitmaps decode to their known size; the quad's screen rectangle at 640×448
matches the measured one within a pixel. **Visible outcome:** the yellow-green cross of the console frame.

### W2.5 — Simple shooting (`viewer`, `scene`, M)

`fire.ts`: on `Fire` (left click while locked; R1 on a pad; the touch stick's fire button) a hitscan ray from the
aim origin the game uses (the weapon's `firepoint` toward the reticle's aim point) against the collision hull —
every polygon, walls and floors, the same grid the probe walks — at the weapon's cyclic rate from
`RUN/ZWEAPON.ZAR`'s `zweapon.rdr` (the default primary; the field the implementer names; the archive copied beside
the maps under W2.R5) with a tracer line for one frame,
a hit mark decal on the polygon (the game's `decals.rdr` names the bullet-hole bitmaps; `ALPH_TXR.ZED` and
`EFFE_TXR.ZED` carry the effect textures), and an ammo readout in the game's bottom-left box style from the panel's
tokens; no damage, no targets, no recoil beyond the reticle bloom W2.4 draws, no sound (the viewer has none).
**Tests:** the ray against a synthetic hull hits the first polygon along it; the rate limiter fires at the table's
interval; the hit mark lies on the polygon's plane. **Visible outcome:** a wall takes a mark where the cross was.

### The close — W2.9

The README's "Controls" (the new keys: walk `G`, first person `V`, stance `C`, jump `Space`, fire) and "Known gaps"
rewritten; §7 complete and dated; the 22-map sweep and the e2e recorded; `agent/web-s2` merged into `agent/web-s1`
by the controller and the whole carried to `main` by PR (W2.R6); the deploy the owner's word, its line in
`docs/HUMAN_TASKS.md` when the merge lands.

## 5. What is not in this batch, and why

- **The real SEAL model and its animations** — the `0x70` skinned unpack, the 32-node skeleton, `MPZANIM.ZAR`;
  the first candidate for web sprint 3, on the stand-in's seat (W2.R3).
- **The game's movement collision** — not decompiled (S1 §7); the probe and the wall slide stay research 24's.
- **Weapons beyond one rifle**, the inventory, reload, the scope's zoom (`zoom_factor`, the 3.0× table), damage,
  AI, other players — the wasm route's (W1.R1) or later sprints'.
- **The HUD beyond the reticle and the ammo box** — the compass, the team box, the minimap (S1 §5).
- **The engine draw order's flares' pass, region visibility, the LOD twin, animated objects, auto-exposure** —
  sprint 1's carries (its close entry); they wait behind the owner's order of this sprint and are listed for sprint 3.

## 6. Verification

Per task: a failing unit test first (vitest; fixture-backed tests skip without game data and have a synthetic twin),
RED and GREEN in the report, a fresh reviewer, the controller merges. Per merge: CI green (`typecheck`, `test`,
`build`). The bar's numbers (§3 items 3 and 4) are tests, not sentences. At the close: `npm run e2e` against the
three fixtures; `tools/map-health.ts` over 22 maps against Task 0's baseline; the console measurement's table
(W2.2 step 5) in §7 with the run's log path, or the line saying the window did not come and the table stands on the
decompilation alone.

## 7. Findings recorded during the sprint

*(dated, newest last; the convention of the earlier specs)*

### The game's tuning is on the disc and the viewer already decodes it (2026-09-28, the open)

`RUN/READERC.ZAR` decodes with `Zar.parse` and `parseRdr` unchanged: 55 scripts, among them `dynamics.rdr` (3,584 B),
`motion.rdr` (62,744 B), `character.rdr` (150,376 B), `controller.rdr`, `hud.rdr`, `animset.rdr`, `motion_range.rdr`,
`decals.rdr`, `damanim.rdr`, `materials.rdr`; `zweapon.rdr` is not among them — `RUN/ZWEAPON.ZAR` (105,968 B) is the
weapon table's own archive. `motion.rdr`'s SEAL bands (metres/s, `max_velocity` / `transition_speed_A-B`): walk 6.5 /
0-2.6, jog 6.5 / 1.9-5.0, run 6.5 / 4.01-6.5, walk_alert 6.5 / 0-4, jog_alert 6.5 / 2-6.15, walk_bw 3.7 / 0-2.8,
run_bw 3.7 / 2-3.7, rstrafe 6.5 / 0-2.8, lstrafe 6.5 / 0-2.3, rstrafe_fast 6.5 / 1-5, lstrafe_fast 6.5 / 0.9-4.5,
run_90r 6.5 / 3-6.5, run_90l 6.5 / 2.5-6.5, p_rstrafe 5.5, p_lstrafe 5.0 (the pistol set), crouchwalk 1.48 / 0-2,
crouchwalk_bw 1.35, crouchstrafe 1.5, fp_crouchwalk 1.3, fp_crouchwalk_bw 1.0, prone_crawl 1.1 / 0-0.4,
prone_rstrafe/lstrafe 0.55 (playback 0.6), climbladder 1.35, buddycarry_walk 1.7. `dynamics.rdr` as §1 lists it; its
`cam_*` block reads `cam_full 20.5/30/0`, `cam_back 20.5/13/0`, `cam_side 19/8/5`, `cam_first 20.5/13/0`, `cam_peekl
0/0/−70 aim (−30 0 0)`, `cam_peekr 0/0/70 aim (30 0 0)` (height/dist/side), which is the block research 17 §8 could
not name at `+0x12c..0x158`. The console frame's reticle bitmaps are `HUD2_TXR.ZED`'s `ret_rifle_01/02.tif` (72
textures in that library; `HUD_TXR` 37, `HUDW_TXR` 65 weapon icons). The SEAL skeleton instance is inline at
`actor+0x170` (count 32 at `+0x60`, array at `+0x64` → `0x1715940` on the console dump), the root node at
`0x17159d0` with Y 5.504 and the other nodes' translations parent-relative.

### The console's reticle: two bitmaps at one texel per pixel, a 65-pixel cross on the frame's centre (2026-09-28, W2.4)

`HUD2_TXR.ZED`'s `ret_rifle_01.tif` is 64×64: a dark see-through ring (radius 21-27, black at alpha ≤ 44) with a 2×2
white dot at its centre — the fixed part; `ret_rifle_02.tif` is 32×32: one tapered arm pointing down, white at its outer
end, which the game draws four times a quarter turn apart — the floating part; `ret_accuracy.tif` is 16×16 and does not
appear at rest. The bitmaps are white; the yellow-green (about 204, 204, 31 on the frame) is applied at draw time. Their
palette ids cite `HUD2_PAL.ZED`'s own 39 entries (`ret_rifle_01` asks for id 188), research 72's caveat holding for the
HUD pair as for `CLIB`. Measured on `scripts/parity/refs/console_spawn_slot8.png` (yellow-green = min(R, G) − B ≥ 30 and
|R − G| < 30, the middle third of the frame): four arms — top x 318-320 y 192-208, bottom y 240-256, left x 288-303
y 224-226, right x 337-352 — a 65×65 box centred on (320.5, 224.5), the frame's centre to a pixel, each arm's outer end
31 px out: both bitmaps sit on the console at one texel per PS2 pixel. The viewer's HUD layer (`reticle.ts`) draws the
same quads at x 288-352, y 192-256 in the PS2 presentation and scales them by the canvas height / 448 in the native
one; the arms' cores land on one column where the console's blur spread them over two, within the one-pixel bar. The
spread between the rest size and 1.5× is an estimate: `m_minsize`/`m_maxsize` were not found in the sitting.

### The game's movement law: the ramp is on the stick, the speed is linear in it, the fall is 2.4 g (2026-09-28, W2.2b)

*(the implementer's reading, reviewed the same hour: seven of nine claims confirmed, two corrected in place below)*
The stance switch `FUN_005870e0` dispatches on `actor+0x174`: 0 → `FUN_00586570` (stand), 1 → `FUN_00584c60`
(crouch), 2 → `FUN_005845c0` (prone); standing locomotion runs `FUN_00586570` → `FUN_00586c10` → `FUN_00583030` →
`FUN_00583350` (the first reading named `FUN_00584c60` the ground state: corrected). **The ramp is on the stick axes,
not on the speed** (`FUN_00586c10`): each axis moves toward the pad's value at most `lower + (upper − lower) × (1 − (1 − |target|)^8)`
per second — 2 at rest, 5 at full deflection, `lower/upper_x_accel` for the sideways axis and `_z_accel` for forward —
with a snap: a forward axis above 0.9 whose wish changes faster than 9 per second jumps straight to the wish (sideways
0.78 and 7.8), so a released or reversed full stick takes effect at once. **Stick to speed** (`FUN_00583350`): a forward
value within 0.03 is 0 (`DAT_003f3428`); `m = min(1, |stick|)`; `w = asin(|sideways| / |stick|) × 2/π` is how far the
stick points off straight ahead; the forward/back band carries `1 − w` of the speed and the strafe band `w`
(`FUN_00583030`: the forward set only when w < 1 and |fwd| > 0.03, the strafe set only when |lat| > 0.03 and w > 0),
renormalised by `1/√(w² + (1 − w)²)` (`DAT_0064fc80`, applied by `FUN_00309180` inside `FUN_0057a330`), so a 45°
stick in two 65 bands still runs at 65.
**The speed is linear in the stick**: `FUN_0058bdf0` picks the clip as `m × 100 × max_velocity` (cm/s) against the
transition bands, so speed = `m × max_velocity` — 90 % of full on tick 11 (0.18 s), full on tick 12; a half stick is
32.5. **`fb_accel`, `lr_accel` and `throt_exp` shape nothing**: no reader but the initialiser and the loader (the
spec's §1 guess that they set the approach is retracted). **Air control exists only in the Jump state** (`DAT_003deae8`
is the string "Jump"; `FUN_0057a330`'s stick-driven velocity runs there); a walk-off fall keeps the horizontal velocity
it had at the edge. **Gravity is in units/s²**: the fall is integrated in `FUN_0059b440` (`v += g·dt`, then the height
by `v·dt`); the table's static default at `0x44c250` is 98.1 (1 g) and `dynamics.rdr`'s 235 overwrites it through the
loader `FUN_0059ba80`, so the SEAL falls at 2.4 g and a 42-unit drop lands in 0.60 s (the first reading cited
`FUN_0057e770`'s /98.1, which scales an impulse, not the fall: corrected). **Crouch and prone have laws of their
own**, transcribed in the fix round: crouch (`FUN_00584c60`) rescales a stick under 0.838 to magnitude 0.946, so the
crouch walk runs at about 14.0 whatever the deflection, no blend, and at full deflection takes the standing path after
a 19-unit headroom ray (`FUN_0057efe0`); prone (`FUN_005845c0` → `FUN_00583500`) has no ramp, one axis by direction
class, speed = max(|x|, |z|) × band. **No jump this sprint**: `jump_factor × gravity × −0.4` only seeds the landing-speed
record at `actor+0x1364` that fall damage reads; the rise is the jump clip's root motion in `MPZANIM.ZAR`, which nothing
reads. Not modelled: the slope and water slow-down (`FUN_005b56c0`), the clips' 0.2 s blend-in. Estimates marked for
W2.2c: crouch rootY 3.4 (0.62 × 5.504), prone 1.8 (under the camera ramp's floor of 2.169); body columns crouch 6-14,
prone 6-9; prone backward at the crawl's 11 (no backward crawl clip exists — the clip plays reversed). Frostfire's
clean walk-off for the tests: the deck at x 630-675, z 725-815, y 142, east edge onto the 100 floor (B's ramp is walled).

### The SEAL is 19.6 units tall, and the console's spawn dump holds a crouched player (2026-09-28, W2.3)

*(the implementer's reading, under review; the plan's Log records the verdict)* The skeleton in the console dump
(`actor+0x170`, count 32 at +0x60) is reached through a table of 32 node **pointers** at +0x64 (26 live, 6 null), each a
`CZBodyPart` in reCOM's field order — `+0` translation, `+0x0c` its `CNode` (the local matrix; the name at `+0x90`),
`+0x1c` parent, `+0x20` quaternion, `+0x40` id — named `skel_root`, `hips`, `neck`, `head`, `lcalf`, `rcalf`, … (no
eyeball nodes). **The player at spawn is crouched:** its root 5.504 is under the game's own stance test `node[0].y <
9.0` (research 17 §8), and its right knee sits on the ground at 0.54; the five standing actors in the same dump carry
the same bone lengths with `skel_root` at **11.484** and the `head` joint composing to 17.28-17.48 (17.37 at the resting
root). Research 17 §1's "standing idle" 5.504 is therefore the crouch, and its measured camera (target 15.38, eye
20.107 up) is the crouched player's; with the standing root 11.484 the ramp of `FUN_0029a950` saturates (fVar9 = 10) and
the standing look-at target is **21.48** over the feet, which is where `dynamics.rdr`'s `cam_*_aim` y 20.5 sits (W2.1's
camera takes the stance's root, so both cases fall out of one formula; W2.2c measures the standing camera on the
console). The frame: the player is 27.71 units from the smoothed eye along the view (24.91 level, 19.60 below; 26.96
from the unsmoothed eye), the composed head joint projects to x 348.3 against the frame's head at x 351; the helmet's
top at row 269 back-projects, at the head's own depth 29.24, to 12.39 over the feet — 2.23 above the head joint.
**Standing height 17.37 + 2.23 = 19.6 ± 0.3 units (1.96 m at `MetersPerUnit 0.1`)**, the crouch 12.4 measured on the
frame, the shoulders 5.1 (82 px at 0.0618 units/px; the joint span 3.8-4.0 plus 0.6 a side agrees); the neck at 0.84
and the knees at 0.30 of the height (a human's 0.85 and 0.29). Estimates: the eye at 18.3 (0.936 × stature), prone 3.0.

## 8. Rulings

- **W2.R1** — "the correct height" is the game's third-person camera with the body in the frame (research 17's
  measured eye 20.107 up and 24.2 behind, target 15.38, the tether and the collision pass); the first-person eye
  stays as a switch at the measured head height, and sprint 1's 15.4 is retired (§1, W2.1).
- **W2.R2** — the speeds are `motion.rdr`'s bands at `MetersPerUnit 0.1` (65 forward at full stick, 37 back, the
  stance bands) with the decompilation's throttle law; sprint 1's 40 and the 2.5× boost are retired; the boost stays
  off the ground (§1, W2.2).
- **W2.R3** — the body is a stand-in at measured dimensions; the real model and its animations are web sprint 3's
  first candidate (§1, W2.3).
- **W2.R4** — the crosshair is the game's own bitmap at the console frame's size and place; the accuracy bloom is a
  should, the other weapons' pairs a later switch (W2.4).
- **W2.R5** — the tuning table is transcribed into `@s2u/scene` and pinned by a fixture test against `READERC.ZAR`;
  the extractor copies `READERC.ZAR` and `ZWEAPON.ZAR` beside the maps and the ISO source reads them, so a later
  sprint reads the table live (W2.2, W2.5).
- **W2.R6** — the sprint's branch is `agent/web-s2` in `C:\projects\wt-web-s2`, cut from `origin/agent/web-s1` at
  `e052c109` because `main` does not yet carry PR #100; agents' worktrees cut from it and merge back by the
  controller; the whole goes to `main` by PR at the close; this session is not the main-tree controller and commits
  nothing in `C:\projects\socom_pc` (the owner's ruling of 2026-09-28 on one controller per tree).
- **W2.R7** — the console measurement (W2.2 step 5) is lock-bound and runs in a window the owner names; until it
  runs the table stands on the file and the decompilation; a measured disagreement beyond 5 % is a KNOWN row and
  the measured value wins.
- **W2.R8** — the owner's chrome request (one cog beside the brand, GitHub's mark) is W2.0, first out, bounded to
  `index.html`, `ui.ts`, `styles.css` and the e2e; `ds/` untouched.

All eight the owner can overturn by number.
