# 88 — Feel parity: the walk driven by script, number by number against the console

*(2026-09-28, the feel-parity workstream of the walk; branch `claude/web-feelqa`. The instrument is
`web/redotcom/tools/feel-parity.ts` (+ `web/redotcom/tools/feel/`); its test is `web/redotcom/packages/viewer/test/feelParity.test.ts`. No game
or emulator was run: the console's side is what the logs, the notes and the console's RAM already hold.)*

**Summary.**

- **The harness.** `feel-parity.ts` drives the viewer's *whole* walk -- the keys and the pad into the fly camera, the
  look law, the mover's 60 Hz ticks, the game's camera after each tick, the body's clips and the posed root they hand
  the camera, in `main.ts`'s order -- through scripted holds, and prints one row per quantity: console, viewer, error,
  tolerance, the kind of truth, the owner. Three paths: a synthetic world headless (node or jsdom, 61 rows), the page
  on Frostfire through `window.__viewer` (`--browser`, 12 rows), and research 79's console run replayed hold by hold
  (`--seal-speed`, both sides through one fitter).
- **After the motion merge (section 6): 73 rows, 71 within tolerance.** Every mover, camera, look and motion row
  matches its source; the two left are the native presentation's horizontal field of view (a proposal, section 6.3)
  and a single-byte edge of the look's dead zone (noise).
- **Fixed in this workstream:** the move stick (section 3: the console's per-axis 0.3 dead zone, rescale and x sqrt 2,
  no unit disc -- a pad at three quarters ran 45.8 against 59.0, prone W+D 7.8 against 11); the right stick's corner
  (section 6.2: the pad's pair was clamped to the rim before the look law, a full diagonal turned at 0.622 against
  1.118); the look stepped per display frame (section 6.2: now on the 60 Hz tick, the turn is the same at 30, 60 and
  144 fps).
- **Verified after the motion workstream's rewrite** (section 6.1): the standing jump is the clip on the floor (the root
  tops at 15.06 against the clip's 15.08, at 0.633 s against 0.627), the running jump rises 12.9 after 0.1 s and lands
  at 0.75 s, a full strafe plays `seal_run_90r` at 1.183x, and the camera stands on the posed root (20.305 in a run,
  2.168 prone, 25.06 at the jump's top). The first pass's jump, strafe-clip and camera-root divergences are closed.
- **What the console has not recorded** (section 5): no timed hold of any kind -- research 79 has not run. Its
  light-stick groups will not read what research 79 section 4 expects: half a stick runs **26.0, not 32.5**; three
  quarters **59.0, not 48.75**; and three quarters crouched **stands and runs**, it does not crouch-walk.

## 1. Method

**The truth, by kind** (the table's `kind` column; `web/redotcom/tools/feel/console.ts` carries every value with its line):

| kind | what it is | strength |
|---|---|---|
| `console` | read off the console: PCSX2's RAM at the slot-8 spawn (`logs/parity/spawn_pcsx2.rdram`) or a PINE poll of it (`probe_pcsx2.txt`, `cam_pcsx2_mission.txt`) | measured |
| `recomp` | a guest *state* word read on ours (an axis, a velocity word, a node weight) -- the console's code wrote it, and it does not depend on ours' frame rate; or a ratio of ours' host-time rates, in which the time cancels | measured on the same code |
| `decomp` | the decompilation's law as the notes read it (the W2.2b and W2.1 findings, research 83), never timed on the console | reading |
| `asset` | the disc's clip decides it and the decompilation says the clip is what plays; computed from the fixtures at run time (W2.R6) | reading + disc |

The logs hold **no timed console motion**: every PCSX2 log with the player in it is a spawn at rest
(`probe_pcsx2.txt`: 15,853 polls of one eye position; `actor_pcsx2.txt`, `player_pcsx2.txt`, `cam_pcsx2*.txt`: 2-5 s
peeks), the `drive_*.txt` scripts are ours' and the menus', and research 79's probe has not run. Research 18 section
3.13 and research 22 section 3 are ours: their *rates* are over host time on a recomp that ran the game at about 41
frames a second then (back 25.30 and strafe 44.30 units per host second are both **0.68** of the console's 37 and 65,
the same time scale), so the table takes their state words and their ratios, never their rates.

**The rig** (`web/redotcom/tools/feel/rig.ts`): the `FlyCamera` and `WalkMode` `main.ts` makes, on a synthetic hull -- a floor
4,000 across and a 42-high deck (Frostfire's drop) -- stepped `fly.update(dt)` then `walk.frame(dt)` at 30, 60 or 144
frames a second; the keys are key events, the pad is a `Gamepad`'s axes through `padInput`, as the page reads them. A
sample per frame: the feet, the drawn feet, the speed, the look, the camera as placed. Under node it gives the fly
camera a global event target (`ensureDom`).

**The fitter** (`web/redotcom/tools/feel/fit.ts`) is `tools_py/parity/seal_speed_fit.py`'s core in TypeScript: rows deduped on the
clock, MoveScale 1.0 or REJECTED, RAMPING under 1 s, the steady speed a least-squares line over the last 60 % of the
hold, t90 from a +-2-row smoothed speed. `--seal-speed` fits the console's rows and the viewer's replay of the same
hold (stance, keys or the light macro as the pad at its push, the same seconds) with it, so a disagreement is the
game's and not the fitters'.

**Run it:**

```
cd web
npx tsx tools/feel-parity.ts                                  # headless; the motion rows need MOTION_P.ZAR + READERC.ZAR in test-fixtures
npx vite --config packages/viewer/vite.config.ts --port 5192  # (another shell) for:
npx tsx tools/feel-parity.ts --browser                        # + Frostfire through window.__viewer
npx tsx tools/feel-parity.ts --seal-speed ../logs/parity/seal_speed_<stamp>.txt ../logs/parity/seal_speed_<stamp>.schedule.json
npx tsx tools/feel-parity.ts --json feel.json                 # the rows as JSON
```

It exits 1 when a mover or camera row diverges. `feelParity.test.ts` runs the headless table in `npm test`: the mover
and camera rows must pass, and any other row must pass or be one of §4's.

## 2. The table (2026-09-28; the first pass after section 3's fix, the rows section 6 changed marked)

Error is |viewer - console| / |console| where the console's value is not 0 and the tolerance is relative, else the
absolute difference in the row's unit. Sources are in the tool's own output and `console.ts`; the short form here.

| quantity | console | viewer | error | | kind | owner | source |
|---|---:|---:|---:|---|---|---|---|
| forward run, W held (steady), u/s | 65 | 65 | 0 % | ok | recomp | mover | velocity words (0, 0, -65), research 25 line 25 |
| forward from rest: time to 90 % of the run, s | 0.183 | 0.183 | 0 | ok | decomp | mover | `FUN_00586c10`: tick 11 |
| W let go: ticks still moving | 0 | 0 | 0 | ok | decomp | mover | `FUN_00586f00` / `FUN_00586570` |
| back run, u/s | 37 | 37 | 0 % | ok | recomp | mover | (0, 0, +37), research 25 line 26 |
| strafe right / left, u/s | 65 / 65 | 65 / 65 | 0 % | ok | decomp | mover | `seal_r/lstrafe` bands, `FUN_00583030` |
| back / strafe (time-free, ours) | 0.571 | 0.569 | 0.33 % | ok | recomp | mover | research 18 lines 985-986 |
| W+D: speed, u/s / heading off the facing, deg | 65 / 45 | 65 / 45 | 0 | ok | decomp | mover | `FUN_00583350` |
| 1 s of W from rest at 30 / 60 / 144 fps: distance, u | 59.042 | 59.042 (all three) | 0 % | ok | decomp | mover | the ramp over 60 ticks |
| crouched, W held (stands and runs), u/s | 65 | 65 | 0 % | ok | decomp | mover | `FUN_00584c60` -> `FUN_00583030` |
| crouched, pad half (byte 64), u/s | 14.0 | 14.0 | 0 % | ok | decomp | mover | `FUN_00584c60` |
| prone, W held / W+D held, u/s | 11 / 11 | 11 / 11 (was 7.78) | 0 % | ok | decomp | mover | `FUN_00583500` |
| pad forward at byte 64 (push 0.5), u/s | 26.006 | 26.006 (was 26.615) | 0 % | ok | console | mover | pad block 0x84a114 + `FUN_002da930` |
| pad forward at byte 32 (push 0.75), u/s | 58.965 | 58.965 (was 45.807) | 0 % | ok | console | mover | the same |
| crouched, pad at byte 32, u/s | 58.965 | 58.965 (was 14.0) | 0 % | ok | console | mover | the same, over the crouch's 0.838 |
| pad push that first reaches the full run, of travel | 0.795 | 0.794 (was 0.999) | 0.0005 | ok | console | mover | 0.3 + 0.7 / sqrt 2 |
| walk off a 42 drop: time in the air, s | 0.598 | 0.600 | 0.002 | ok | decomp | mover | `FUN_0059b440`, g 235 |
| walk off: speed across the ground in the air, u/s | 65 | 65 | 0 % | ok | decomp | mover | no air control outside Jump |
| spawn, crouched, rest pitch: eye over / behind the feet, u | 19.603 / 24.906 | 19.603 / 24.906 | 0.0002 | ok | console | camera | `probe_pcsx2.txt` line 2, research 17 line 77 |
| spawn: look-at target over / ahead of the feet, u | 15.378 / 1.275 | 15.378 / 1.275 | 0.0004 | ok | console | camera | research 17 lines 78, 81 |
| spawn: eye before the pass (`cam+0x2c`) up / behind, u | 19.483 / 24.166 | 19.484 / 24.166 | 0.0003 | ok | console | camera | research 17 line 79 |
| spawn: the pass's distance `DAT_003de268`, u | 26.519 | 26.520 | 0.0003 | ok | console | camera | the dump |
| standing run: eye behind the feet (max drift), u | 24.906 | 24.906 | 0.0004 | ok | decomp | camera | no tether (W2.1) |
| turn in place: the eye's orbit radius, u | 24.91 | 24.906 | 0.004 | ok | recomp | camera | research 18 line 932 |
| root 0 (ours' decayed root): camera elevation over the feet, deg | 29.73 | 29.732 | 0.01 % | ok | recomp | camera | research 22 line 186 |
| vertical field of view, deg | 49.0 | 49.0 | 0 | ok | console | presentation | `cam_pcsx2_mission.txt` line 8 |
| horizontal field of view, PS2 presentation / native at 16:9, deg | 70.0 | 70.005 / **78.03** | 0.005 / **8.0** | ok / **diverges** | console | presentation | the same |
| right stick at bytes 64, 80, 192, 224, 255: turn axis after 1 s | 0.072, 0.004, 0.080, 0.879, 1.118 | 0.072, 0.004, 0.080, 0.879, 1.118 | <= 0.0005 | ok | recomp | look | research 22 lines 127-133 |
| right stick at byte 176: turn axis | 0 | **0.005** | 0.005 | **diverges** | recomp | look | research 22 line 126 |
| right stick full / at 224: turn rate, deg/s | 128.11 / 100.74 | 128.113 / 100.740 | 0 % | ok | recomp | look | research 22 lines 128-129 |
| arrow held: time to the full turn, s | 0.278 | 0.283 | 0.005 | ok | decomp | look | `FUN_002da930`'s ramp |
| 1 s of an arrow from rest at 30 / 60 / 144 fps, deg (section 6.2) | 111.329 | 111.329 (all three; was 112.351 / 111.329 / 110.718) | 0 % | ok | decomp | look | the ramp and the gain, 60 frames |
| arrow up: pitch rate after the ramp, deg/s | 54.448 | 54.448 | 0 % | ok | decomp | look | `pitch_rate` 0.85 x 1.118 |
| right stick in its corner (bytes 255, 0): turn axis (section 6.2) | 1.118 | 1.118 (was 0.622) | 0 | ok | decomp | look | `FUN_002da200` on (1, 1) |
| full run: the clip's keys a second / 30 | 1.1265 | 1.126 (`seal_run`) | 0 % | ok | recomp | motion | node `+0x24`, research 25 line 372 |
| full right strafe: the clip's keys a second / 30 (section 6.1) | 1.183 (`seal_run_90r`) | 1.183 (`seal_run_90r`; was 3.0, `seal_rstrafe`) | 0 % | ok | decomp | motion | the strafe set's band at 65 (research 80) |
| standing jump: the feet's rise, u (section 6.1) | 0 | 0 (was 9.44) | 0 | ok | decomp | motion | `FUN_0057e1b0`, research 80 section 0 |
| standing jump: the posed root's top, u | 15.078 | 15.061 | 0.017 | ok | asset | motion | `seal_jump`'s root at key 12 |
| standing jump: time to the root's top, s | 0.627 | 0.633 (was 0.283) | 0.006 | ok | decomp | motion | `FUN_0028c4f0`: key 12 at phase 0.6 of 1.1 x 19/20 s |
| standing jump: how long the action holds, s | 0.993 | 0.983 | 0.009 | ok | decomp | motion | 1.1 x (19/20)^2 |
| standing jump: the look-at target's top over the feet, u | 25.078 | 25.061 | 0.017 | ok | decomp | motion | `FUN_0029a950` on the posed root |
| running jump: take-off to the first rise, s | 0.1 | 0.1 | 0 | ok | decomp | motion | `actor+0x1360` |
| running jump: the feet's top, u | 12.9 | 12.925 | 0.19 % | ok | decomp | motion | 79.9 up, 235 down, 60 Hz |
| running jump: time in the air on flat ground, s | 0.75 | 0.75 | 0 | ok | decomp | motion | 5 ticks of the wait + 40 of flight (research 80's 0.78 is the closed form) |
| full run: look-at target over the feet, u (section 6.1) | 20.305 | 20.305 (was 21.484) | 0 | ok | asset | motion | `seal_run`'s root 10.305 + 10 |
| prone at rest: the root the camera stands on, u (section 6.1) | 2.168 | 2.168 (was 1.8) | 0 | ok | asset | motion | `seal_prone`'s root |
| Frostfire (page): forward run / t90 / stop / back run | 65 / 0.183 / 0 / 37 | 65 / 0.183 / 0 / 37 | 0 | ok | | mover | as above |
| Frostfire (page): standing eye over / behind the feet, u | 25.709 / 24.906 | 25.709 / 24.906 | 0.0004 | ok | decomp | camera | W2.1 standing |
| Frostfire (page): full run, the clip's keys / 30 | 1.1265 | 1.126 (`seal_run`) | 0 % | ok | recomp | motion | research 25 line 372 |
| Frostfire (page): full run, look-at target over the feet, u | 20.305 | 20.305 | 0.0003 | ok | asset | motion | the posed root |
| Frostfire (page): full right strafe, the clip's keys / 30 | 1.183 | 1.183 (`seal_run_90r`) | 0.06 % | ok | decomp | motion | research 80 |
| Frostfire (page): standing jump, the feet's rise / the camera's root at its top, u | 0 / 15.08 | 0 / 15.061 | 0.019 | ok | asset | motion | research 80 |
| Frostfire (page): off the 142 deck, time in the air, s | 0.598 | 0.600 | 0.002 | ok | decomp | mover | as above |

Two rows are worth a word for what they confirm independently. **The camera on ours' decayed root** (29.73 deg, research
22's run 4) is a second machine's state -- the root at 0, `FUN_0029a950`'s "no root" 10 -- that the viewer's camera
reproduces to 0.002 deg with nothing fitted: the ramp's fallback, the pitch-pulls-in distance and the lead all hold
off the spawn. **The run's clip factor** 1.1265 is a node weight traced on ours, and the viewer's animator lands on it
from the other side (`seal_run`'s root travels 57.7 a second; 65 / 57.7).

## 3. The move stick (fixed: `moveStick.ts`, `camera.ts` `groundWish`, `walk.ts` `Walker.tick`)

`FUN_002da930` (decomp 179484-179878) reads both sticks, `(127.5 - byte) x 0.007843138` a side, and runs each through
its block of settings. The right block is research 83's. The left one, on the spawn dump (pad object `0x849e90`, block
`0x84a114`), read here for the first time:

| pad offset | dump | step | line |
|---|---|---|---|
| `+0x288` | 0.3 | the dead zone, per axis | 179566-179592 |
| `+0x2a0` | 1 | the rescale `(|v| - 0.3) / 0.7`, clamped | 179594-179617 |
| `+0x2a1` | 1 | `FUN_002da200` mode 1 (`DAT_003df240` = 1): x sqrt(1 + |r|), both axes, clamped | 179634 |
| `+0x2a8` / `+0x2a9` | 0 / 0 | no curve (the right's 0.65 x v^3 is off) | 179636-179658 |
| `+0x2a2` | 0 | no ramp (and the ramp needs `+0x2a8` besides) | 179771 |

So one axis pushed `p` of its travel gives `(p - 0.3) / 0.7 x sqrt 2`, full from **0.795**; a full diagonal is (1, 1),
and nothing ever puts the pair back in the unit disc -- the locomotion takes `min(1, |stick|)` standing
(`FUN_00583350`) and one axis prone (`FUN_00583500`). The viewer had the pad's radial 0.15 dead zone and rescale
(`./gamepad`, full only at the rim), the keys summed and the pair normalised into the unit disc in `groundWish`, and
again in `Walker.tick`.

The fix, in the look law's pattern: `groundWish` undoes `./gamepad`'s radial dead zone (as `walkLook` does for the look)
and reads the push through `moveStick`; the keys are a full axis each, and on each axis the larger of the keys and the
stick; `Walker.tick` clamps each axis and no longer normalises. Before and after, the harness: byte 64 26.62 -> 26.01
(console 26.01); byte 32 45.81 -> 58.97 (58.97); the full run from 0.999 -> 0.794 of the travel (0.795); prone W+D
7.78 -> 11 (11); crouched at byte 32 14.0 (the crouch walk) -> 58.97 (it stands and runs, as the console's 0.907 is over
the crouch's 0.838). Keyboard play is unchanged except prone diagonals; the touch stick rides the same law (it shares
`./gamepad`'s shaping). Tests: `test/moveStick.test.ts` (6).

## 4. The first pass's divergences, ranked, with their owners (closed or answered in section 6)

1. **The jump (motion).** The viewer's jump is `jumpImpulse`'s placeholder, sqrt(2 g 10): the feet rise 9.44 (10 under
   the game's own semi-implicit step) and top at 0.28 s. The console's jump is `seal_jump`'s root (web spec section 7,
   W2.2b: `jump_factor` only seeds the landing record): 10.51 -> 15.08, **a rise of 4.57**, topping at key 12 of 20,
   **0.66 s** into the 1.1 s the table's `playback` gives it. The animator also stands the body on the clip's root
   height (`animator.ts`: "the root's height is the clip's"), so the two rises are separate: the placeholder's hop is
   over (0.58 s in the air) before the clip's root tops. The biggest feel gap in the table: a jump twice as high and
   twice as fast as the console's.
2. **The full strafe's clip (motion).** At 65 sideways the viewer plays `seal_rstrafe` (root 14.6 a second) at the
   `RATE_MAX_PLACEHOLDER` cap of 3x -- 90 keys a second, the legs a blur, the feet still sliding. `FUN_00583030` plays
   the strafe *set* at the speed, which `motion.rdr`'s transition bands resolve to `seal_run_90r` (30-65) at 65 / 55.0 =
   1.18x. The same holds for the set's middle: `seal_rstrafe_fast` (10-50) at mid speeds. A reading of the set's
   members (the decompilation names the set's offset, `+0xf0`, not its clips); `anim.strafeFactor`.
3. **The camera's root input (motion).** `FUN_0029a950` stands the target on the **live** skeleton root (research 17
   section 3). Running, that is `seal_run`'s 10.305, so the console's look-at is **20.305** over the feet where the
   viewer keeps the standing idle's 21.484: the console's camera settles about 1.2 lower as the run starts (and the
   eye with it). Prone, `seal_prone`'s root is **2.168** against `walk.ts`'s estimate 1.8 (target 7.668 against
   7.300). Open with it: the idle clips' root x and z (`seal_stand` 1.465 / -1.031, `seal_crouch` -0.387 / 7.488)
   would move `FUN_0029a950`'s target sideways and its 28 -- but the console's crouched spawn shows x 0 and the exact
   lead, so the camera does not see them as the clip stores them; which root the camera reads while a clip plays is the
   motion workstream's question.
4. **The right stick's corner (look / pad).** `./gamepad` clamps a stick's pair to the rim before the look law, so a pad
   whose corner reads (1, -1) reaches the law as (0.707, 0.707): 0.822 a side after the circle, 0.622 after the cube
   and the gain, where the console's (1, 1) gives 1.118 on both axes -- a diagonal flick turns and pitches at **56 %**.
   The move stick has the same shape for a prone diagonal on such a pad (9.0 against 11). The fix is in `padInput`:
   hand the camera the per-axis push, not the disc.
5. **The native horizontal field of view (presentation).** The console's projection is 70 by 49 degrees
   (`cam_pcsx2_mission.txt` line 8: sin and cos of 35 and 24.5). The PS2 presentation matches; the native one keeps the
   49 and widens with the window: 78 at 16:9. A presentation choice, stated so it is one.
6. **The look against the display rate (look).** The look law steps once a display frame; the console's once a 60 Hz
   frame. A second of an arrow from rest turns 1.0 deg more at 30 fps and 0.6 deg less at 144 (the ramp's first 0.28 s
   is summed on a different staircase). Stepping `LookLaw.frame` on the mover's 60 Hz accumulator would remove it.
7. **Byte 176 (look).** The model reads 0.005 where research 22 read 0 on both runs (and 0.004 / 0 at byte 80) -- the
   single-byte edge of the dead zone research 83 section 1 already names. Noise-level.

**What matched and is worth keeping pinned:** the spawn camera to 0.0003 (five quantities, measured), the run, back
run and strafes, the ramp's tick 11, the stop at once, the fall's 0.60 s and carried run, the orbit, the camera on a
root of 0, the six turn axes and two rates, the pitch rate, the run clip's factor, and the whole mover at 30, 60 and
144 frames a second to the unit.

## 5. What the console still owes, and what the table predicts for it

- **Research 79's run.** The one timed console measurement planned. The harness ingests it as it is written
  (`--seal-speed`); every hold then becomes a `console` row beside the viewer's replay of the same hold. Predictions,
  from the pad reader above: `half_fwd` (byte 64) **26.0** (research 79 expects 32.5 and would read the miss as a dead
  zone -- it is one, with the circle's sqrt 2 after it); `--light 0.75` (byte 32) **59.0** (expected 48.75);
  `crouch_walk` at `--light 0.75` **stands and runs at 59.0** (expected 14.0: the reader's 0.907 is over the crouch's
  0.838; the crouch walk needs a byte of 37 or more, a push under 0.715); t90 0.18 s plus the pad latency; the roots
  11.48 / 5.50 and prone about 2.17. `seal_speed_fit.py`'s `expected_speed` takes `push x band`: it should take the
  reader's law before the next run is read.
- **The console's frame rate.** Every per-frame constant is read at 60 Hz (the pad's ramp 0.0389 a frame, the pass's
  0.03 a frame, the shake's fall); a 60 Hz `CGame::Tick` is research 71's reading, not a measurement. Research 79's rows
  carry the guest clock: the median row spacing of a run answers it.
- **A jump, a turn and a camera in motion, timed.** None exists on the console. A PINE poll of the actor's position
  (`*0x408c58+0x1c:3`), `actor+0x48` and `cam+0xd8` through a standing jump, a 1 s right-stick hold and a 2 s run
  would turn §4's items 1, 3 and the look's `decomp` rows into `console` rows; the harness's fitter reads such rows.

## 6. The second pass: after the motion merge (2026-09-28)

`claude/web-viewer-playtest-fixes` at `a4ec6675` merged (the motion rewrite of research 80: the game's two jumps, the
pick-and-blend locomotion `locomotion.ts`, a new animator on the game's play model, the camera on the posed root
through `WalkMode.setPosedRoot`; and the look, weapon, audio, HUD and grenade work). The one conflict, `Walker.tick`:
the motion's action, landing and jump code kept, its unit-disc normalise replaced by section 3's per-axis clamp. The
harness was ported: the rig now steps `./animator` on a one-part skeleton (`skel_root`) after each frame and hands the
walk its posed root, as `./play` does, and the motion rows read the new play model; the running-jump rows need no
fixture.

### 6.1 Verified, not assumed

| first-pass divergence | now | how it was checked |
|---|---|---|
| 1. the jump | **closed**: the standing jump is `seal_jump` on the floor (feet 0; the posed root tops at 15.061 against the clip's 15.078 at 0.633 s against the play model's 0.627; the action holds 0.983 s against 0.993), the running jump rises after 0.1 s to 12.925 (12.9) and lands at 0.75 s | headless, and on Frostfire (`page.jumpFeet`, `page.jumpRoot`) |
| 2. the full strafe's clip | **closed**: `seal_run_90r` at 1.1834x (35.5 keys a second), from the harness's own travel-a-cycle computation of the clip | headless and on Frostfire (`page.strafeClip`) |
| 3. the camera's root input | **closed**: a full run stands the look-at on 20.305, prone on 2.168, the standing jump's top on 25.061 | headless and on Frostfire (`page.runTarget`) |

Two numbers were corrected on the console side, not the viewer's: the standing jump's top is at **0.627 s** in the
play model `FUN_0028c4f0` runs (the first pass's 0.66 was key 12 / 20 x 1.1, not the phase law), and the running
jump's air time at the game's 60 Hz is **0.75 s** (5 ticks of the 0.1 s wait and 40 of flight; research 80 section 0's
0.78 is the closed form 0.1 + 2 x 79.9 / 235). The sub-tick differences (0.006, 0.010 s) are the 60 Hz sampling.

### 6.2 Fixed here

- **The right stick's corner (first pass #4).** `./gamepad`'s `padInput` put each stick through the touch stick's
  shaping *with* its clamp to the rim, so a corner reading (1, -1) arrived at the look law as (0.707, 0.707) whatever
  the undo did. `padStick` keeps the radial dead zone and its rescale but no rim; `padRaw` undoes it exactly (the
  walk's look and move both read through it). A full diagonal now turns and pitches at 1.118 a side, the console's; the
  prone diagonal on such a pad crawls 11. Flying, the fly camera holds the look pair to the disc as it always did.
- **The look against the display rate (first pass #6).** `FlyCamera.walkLook` steps the look law, the pitch and the turn
  on their own 60 Hz clock (`LOOK_TICK`), the console's frame, as the mover steps its ticks; a second of an arrow from
  rest is 111.329 deg at 30, 60 and 144 fps (it was 112.351 / 111.329 / 110.718). The shake and the bob stay per
  frame (their falls are already scaled to 60 Hz). In third person the view is placed from the camera's ticks, drawn
  between them, so nothing steps on screen; in first person the view turns in 60 Hz steps on a faster screen, as the
  console's picture does.

### 6.3 The native horizontal field of view (first pass #5): a proposal, not a change

The console projects 70 x 49 degrees (`cam_pcsx2_mission.txt` line 8) into a 640 x 448 frame that the television shows
at 4:3: the picture is anamorphic, its projection 1.537 wide shown 1.333 wide -- everything on the console's screen is
13 % narrower than it is. It is neither letterboxed nor pillarboxed: the frame fills the 4:3 screen. The viewer's PS2
presentation reproduces exactly that (the projection from the map's half-angles, the frame stretched to 4:3). The
native presentation keeps the vertical 49 and widens the horizontal with the window (Hor+): 70 at 1.54:1, 78 at 16:9,
93.5 at 21:9, with square pixels.

**Proposal: keep Hor+ as the native default.** The vertical angle is what decides how large the SEAL, a target at a
given range and the 65-pixel reticle's cross read on screen, and it is the console's to the hundredth; the extra
4 degrees a side at 16:9 are periphery the console's squeeze hid, not a zoom. The alternatives: *Vert-* (keep 70
across, crop the height: the vertical becomes 43.0 at 16:9, a 16 % zoom-in against the console, the SEAL larger than it
ever was on a television) or *pillarbox to 4:3 at 70 x 49* (the console's framing with bars, but its squeeze undone or
kept -- kept is the PS2 presentation already on the panel). If the owner wants the console's exact horizontal reach in
the native view, a third option is cheap: a native pillarbox at the projection's own 1.537 aspect (70 x 49, square
pixels, bars on a 16:9 screen). The row stays reported (`cam.hfov169`) so the choice is visible.

### 6.4 What else the pass found

- **An end-to-end test fails on the integration branch itself**, not here: `e2e/walk.spec.ts` "the game's camera at
  Frostfire's spawn A" asks for the crouched eye 19.603 over the feet two frames after `setStance('crouch')`, and reads
  **25.706** on `a4ec6675`'s own sources (checked by swapping them in: 25.63 with this branch's) -- the camera now
  stands on the posed root, and the body is still getting down (the stance's transition clip). The test wants the
  settled crouch; the motion workstream's to update (wait for the transition, or read the root once settled).
- **A keyboard diagonal in the standing jump** runs at both sets' top speeds with no renormalisation (research 80:
  `FUN_0057a330` drives the jump by the stick, `DAT_0064fc80` is 1 there): with the pad reader's (1, 1) that is 65 x
  sqrt 2 = 92 across the ground while the clip plays (the harness reads 91.92). That is the reading as written; a console capture of a W+D
  standing jump would confirm it.

## 7. Round 3: the table on `f0f59b1d` (2026-09-28/29)

The integration head with everything in (motion r2 with NoInterrupt, the turn in place, the spine twist and the bank;
traversal; accuracy; grenades; effects; HUD; audio) merged as a fast-forward. The table, headless and on Frostfire:
**73 rows, 71 within tolerance, unchanged** -- the same two reported rows (`cam.hfov169`, a presentation proposal;
`look.axis176`, a single-byte edge). Nothing the later workstreams merged moved a mover, camera, look or motion
number.

The playtest of the same head (web research 90) adds one caution to this table: **the walk-off site** (`page.fall`,
and `walk.spec`'s) is not an open edge. The 142 deck's east side is railed; at its corner x 674-680, z 720-726 the
ground probe returns the top of a box under the deck (the probe's first hit per model), and the SEAL falls *through*
the deck there. The row's 0.600 s is still a 42-unit fall under 235, but it measures a hole; research 90 item 2 asks
for the console's answer at that corner.
