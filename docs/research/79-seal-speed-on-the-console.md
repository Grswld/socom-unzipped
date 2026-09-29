# 79 -- The SEAL's speeds and stance heights on the console: the method (web sprint 2, W2.2c)

*2026-09-28. The recipe, not the result: the instruments are `tools_py/parity/seal_speed_probe.py` and
`tools_py/parity/seal_speed_fit.py` (tests `tools_py/tests/test_seal_speed_probe.py`, `test_seal_speed_fit.py`, on
synthetic rows only). The measurement is lock-bound and runs in a window the owner names (spec W2.R7).*

What it settles: the bands and ramp of the web sprint 2 design's §7
(`web/redotcom/docs/specs/2026-09-28-web-sprint-2-the-seal-in-the-world-design.md`) -- forward 65, back 37, strafe 65, the
stick ramp (90 % of full on tick 11, 0.18 s) -- and the skeleton root per stance (W2.R9: standing 11.484, crouched
5.504, prone unknown). Ours is not the reference: it renders 18.7 game frames a second (KNOWN).

## 1. Method

- **Rows.** Over PINE, as fast as it answers: the guest clock, then the local actor's position words 7-9
  (`*player_actor + actor_pos`), the skeleton root's Y (`*(actor + root_node) + 4`), MoveScale (`actor + move_scale`),
  then the clock again; a row whose two clock reads differ straddled a frame and is dropped. Addresses come by name
  from `tools_py/parity/guest_addresses.py`, column r0001 (the console boots the r0001 disc); they are
  `scripts/parity/guest_probe_console.json`'s chains. Time is the **guest clock in seconds**, never the host's and
  never 4 Hz peek rows (research 25 §5); rows sharing a clock value collapse to the last read.
- **Holds.** Full deflection from the keyboard (a partial push is `--light`, §5):
  `keys.press(hwnd, button, "pcsx2", hold_s=6)` -- drive.py's `hold+` step and pcsx2_ctl's `hold` -- posts a key PCSX2's [Pad1] binds: W = LUp, S = LDown, A = LLeft, Triangle = Keyboard/I,
  H = RRight (the step-script name `L`), D = LRight. Default schedule (`--dry-run` prints it, about 3.5 min): rest
  3 s at the spawn; **crouch_fwd#1-3** (W) alternating with **crouch_back#1-3** (S); Triangle -> prone;
  **prone_fwd#1-3** (W); Triangle -> stand; **fwd#1-3** (W) alternating with **back#1-3** (S); **left#1-3** (A)
  with **right#1-3** (D); one **fwd_left** (W+A); 6 s each, 3 s of rest before and after. Every direction runs three
  times so the blocked rule has a group, and the pairs bring the player back towards the start.
- **Stance.** The decompilation's Triangle handler (PlayerUpd, `game/analysis/socom2_game.elf.decomp.c`
  ~453331-453425; the wished stance is the byte at actor+0x374) reads the press's peak pressure. A **firm** press
  (0.3 or more, every keyboard press) from stand or crouch wishes prone when `FUN_00584b00` allows, and from
  prone it wishes **stand** on every branch. Two caveats from the same branches: when `FUN_00584b00` refuses prone
  and `FUN_005857e0` != 0 with `FUN_00584c10` = 0, a firm press toggles **stand <-> crouch** (so a firm press can
  reach crouch where prone is refused); and when `FUN_005857e0` = 0, every stance goes to stand, firm or light.
  A light press toggles stand <-> crouch and takes prone to crouch -- only while `FUN_005857e0` != 0. What those
  three functions test is not read here (believed: room to lie down, room to crouch). On open ground the firm
  presses therefore cycle stand/crouch -> prone -> stand and do not reach crouch; the order above starts from the
  crouched spawn (design §7, W2.3) for that reason. Before every hold the probe reads the root at rest (standing
  11.48 ± 0.5, crouched 5.50 ± 0.5, prone any root under the crouch band, 5.0; a root between the bands,
  6.0-10.98, or above 11.98 is "unknown"). A stand or prone hold found in another stance gets up to two more firm
  taps, 3 s apart; a crouch hold gets none. The schedule records the stance the root finally read, and the table
  shows that one, not the planned label.
- **Fit, per hold** (research 18 §3.13's rules). Any MoveScale row not exactly 1.0 inside the hold REJECTS it,
  judged before duplicate clock rows merge. A hold shorter than max(1 s, 3 × t90) is RAMPING, with no steady
  number. The steady speed is a least-squares line through x(t), z(t) over the last 60 % of the hold's rows; it is
  NOISY when the RMS residual exceeds 1.5 rows' motion + 0.1 units (so a position that moves on every second clock
  tick still reads OK). t90 runs from the hold's start to the first smoothed speed (a local linear fit over ±2 rows)
  at 0.9 × steady; it is NaN when rows are sparser than 0.1 s, and marked "t90?" -- advisory only -- when the
  steady residual exceeds one row's motion at the fitted speed (a deterministic half-rate staircase, about half a
  row's motion, carries no flag; 1.0 unit of Gaussian noise at 60 Hz does). On synthetic 60 Hz rows t90 stays
  within about 0.03 s of 0.18 at 0.3 units of noise. The heading is atan2(vz, vx), with the velocity along and across the facing
  (the **fwd** holds' heading), so **back** reads about -37 along. The root Y at rest is the median over the 1 s
  before the hold. The camera record 0x416054 is not the feet and is not read; the "lead" of research 18's affine
  response is the camera's slack and does not apply to the actor's own words. A hold is BLOCKED when its distance
  is under half its group's median (groups are the name before `#`) or its speed is under half the expected band
  for its direction and measured stance.
- **t90 includes the input latency** from the key-down to the game's pad read (one or two frames); the ramp itself
  is 0.18 s by the decompilation.

## 2. Getting the console to a spawn

Two routes exist; **the single-player mission is the cheaper**, and is the one recommended:

- **Single player (recommended).** One PCSX2, no server, no network, no build of ours, and MoveScale is 1.0
  throughout single player (`guest_probe_console.json`'s `move_scale` source). `drive.py --target pcsx2` with
  `scripts/parity/mission_music_fast.txt` boots the disc, takes NEW GAME to the first mission, presses through the
  flyover until the HUD band matches with the letterbox lit, and clears the first pop-ups (the same idiom
  `music_only_mission.txt` ran on PCSX2 in Sprint 10, `scripts/parity/refs/audio_music_only_mission.pcsx2.json`).
  Its spawn is the old slot 8's (`scripts/parity/refs/console_spawn_slot8.txt`): the squad kneels, so the player
  starts crouched. **Two traps:** a stream lies ahead of the spawn (research 25 §5: a 6 s forward hold walked into
  it; the water's slow-down, `FUN_005b56c0`, is not what this measures) -- pass `--turn-first 1.4` (roughly half a turn
  at the full-stick 128 deg/s of research 22 §3; check the fwd heading) and read y in the rows (the stream sits at y <= -154); and a HELP pop-up pauses the
  game -- the preflight refuses a frozen clock, exit 3.
- **Online, Frostfire** (`scripts/parity/mixed_match.sh`, `tools_py.parity.pcsx2_shell host/join`, our Horizon
  box). The design names Frostfire's spawn, but this route needs the Horizon stack, the DNS stub, the pnach and a
  networked card, a second client (ours, built, or `tools/pcsx2_b`), and both players moving: a parked opponent
  can starve the mover (KNOWN §2), which a speed hold must never measure. Only if the owner wants Frostfire itself.

**The savestate** (`tools/pcsx2/sstates/` is empty since 2026-09-26): while PCSX2 sits at the HUD, save it over
PINE with `python -m tools_py.parity.seal_speed_probe --save-state 8`; later runs load it with `--slot 8`
(state_poll's path: launch on the disc, PINE, 25 s, load, 4 s). drive.py kills PCSX2 when its script and `--tail`
end, so the save goes inside the tail.

## 3. The commands (under the lock, in the owner's window)

The savestate, one lock hold (the drive's step lines go to the log). The save waits for the step script's LAST step
line (`s24_none` for mission_music_fast.txt's 25 steps, computed below), so every pop-up guard's Cross has already
landed and only the drive's tail -- no presses -- is left; the probe's preflight then wants the guest clock
running at MoveScale 1.0:

```
bash scripts/loop_lock.sh run agent-web-s2c --purpose "W2.2c console speed: spawn savestate" -- bash -c '
  python -m tools_py.parity.drive --target pcsx2 --script scripts/parity/mission_music_fast.txt \
      --out logs/parity/w22c_spawn --tail 360 > logs/parity/w22c_spawn.log 2>&1 & d=$!
  last=$(printf "s%02d_" $(( $(grep -cvE "^[[:space:]]*(#|$)" scripts/parity/mission_music_fast.txt) - 1 )))
  until grep -q "^$last" logs/parity/w22c_spawn.log || ! kill -0 $d 2>/dev/null; do sleep 2; done
  python -m tools_py.parity.seal_speed_probe --save-state 8
  python -m tools_py.parity.seal_speed_probe --turn-first 1.4
  wait $d'
```

(The last probe line is the measurement itself, attached to the drive's PCSX2 inside its tail -- one launch pays
for the savestate and the first run; `grep "untilref"` in the log shows the HUD match was real.) A repeat from the
savestate:

```
bash scripts/loop_lock.sh run agent-web-s2c --purpose "W2.2c console speed" -- \
  python -m tools_py.parity.seal_speed_probe --slot 8 --turn-first 1.4
```

The same with the light-stick groups appended (§5; it swaps and restores the owner's PCSX2.ini, so only with
`--slot`, and only with no pcsx2-qt running):

```
bash scripts/loop_lock.sh run agent-web-s2c --purpose "W2.2c console speed, light stick" -- \
  python -m tools_py.parity.seal_speed_probe --slot 8 --turn-first 1.4 --light
```

and the second light level, when half_fwd misses 32.5 (§4):

```
bash scripts/loop_lock.sh run agent-web-s2c --purpose "W2.2c console speed, light stick 0.75" -- \
  python -m tools_py.parity.seal_speed_probe --slot 8 --turn-first 1.4 --light 0.75
```

Output: `logs/parity/seal_speed_<stamp>.txt` (rows: guest_t x y z root_y move_scale host_t; a header with the torn
and null counts) and `seal_speed_<stamp>.schedule.json`; the table is printed and can be re-made with
`python -m tools_py.parity.seal_speed_fit <rows> <schedule>`:

| hold | stance | rows | speed u/s | expected | along | across | heading deg | rel. deg | t90 s (flag advisory: residual over one row's motion) | rootY at rest | distance | resid | status |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|

## 4. Acceptance

- **W2.R7:** the median of each group's OK holds -- fwd, left, right within 5 % of 65 (61.75-68.25), back within
  5 % of 37 along the facing, fwd_left near 65; a measured value beyond 5 % is a KNOWN row and the measured value
  wins. crouch_fwd and crouch_back print their expected band as "65 (full push stands up; the 14.0 crouch walk
  needs a light stick)" and "37 (... the 12.8 crouch walk ...)": every crouch hold is a full push, which stands
  the SEAL up and runs while the stance stays crouch (design §7 -- that is the test of the claim); a crouch hold
  under half the standing band reads BLOCKED. prone_fwd near 11.
- **W2.R9:** the root Y at rest before crouch_fwd#1, prone_fwd#1 and fwd#1, to two decimals (expected 5.50,
  unknown, 11.48), each with the stance column saying the same.
- t90 against 0.18 s (plus the latency), on OK holds only.

- **The light groups** (`--light`, §5): **half_fwd** -- the median of the OK holds within 5 % of 32.5
  (30.9-34.1). A miss is **first read against the stick's dead zone and calibration, not the throttle law**: the
  game's pad layer shapes the raw byte before the locomotion sees it (reCOM `zInput/zinput.h` 45-56 and 141-147:
  `CStickType`'s `m_absoluteDeadZone`, `m_velocityDeadZone`, `m_minStickVelocity`, and the per-axis
  `m_maxStick`/`m_minstick` a pad learns), so a dead zone rescaled out of the push reads as a slower half stick
  under a linear law. A second light level separates the two: `--light 0.75` (ly 32 = 0x20, expected
  0.75 × 65 = 48.75, crouch_walk still 14.0). A dead zone moves both levels by the same offset in push; a
  non-linear law does not. Only a run at **two** light levels that both miss the linear law (design §7:
  speed = m × max_velocity) is the KNOWN-grade finding, the measured values winning. **crouch_walk** -- within 5 % of
  14.0 (13.3-14.7), the stance column reading crouch; a crouch_walk near 32.5 or 65 means the push reached the
  standing run (the 0.838 threshold or the push is not what §5 says). Both the push and the Triangle pressure are
  printed by `--dry-run --light` and carried in the rows header and the schedule.

**Still not measured**: the crouch walk back (12.8) and sideways (14.2) and the crouch-diagonal 19.8 question --
`--light` binds only a partial stick UP; a second macro (LDown, LLeft) at the same pressure would give them.

## 5. The light stick (`--light`)

**Route taken: PCSX2's own macro buttons, in a temporary PCSX2.ini.** Read from PCSX2's source (master,
`pcsx2/SIO/Pad/PadDualshock2.cpp`, `pcsx2/SIO/Pad/Pad.cpp`, `pcsx2/Pcsx2Config.cpp`, `pcsx2-qt/QtHost.cpp`) and
checked against the strings in `tools/pcsx2/pcsx2-qt.exe` (`Macro{}Binds`, `Macro{}Pressure`, `PressureModifier`,
`AxisScale`, `-datapath`, `portable.ini`, `portable.txt` are all there):

- **The pressure modifier cannot give a partial stick.** `[Pad1] PressureModifier` (the owner's is 0.5) scales
  the pressure of a button while the bindable `Pressure` input ("Apply Pressure") is held; `PadDualshock2::Set`
  skips every analog key when it applies it (`if (i == index || IsAnalogKey(i) || IsTriggerKey(i)) continue`, and
  the analog branch never reads `pressureModifier`). It would give a light Triangle, not a half stick.
- **Macros can.** `[Pad1] Macro<N> = <key>`, `Macro<N>Binds = <input>[&<input>]`, `Macro<N>Pressure = <float>`
  (N = 1..16; `Pad::LoadMacroButtonConfig`); holding the key calls `Pad::ApplyMacroButton` -> `Set(input,
  pressure)`. For a stick half-axis `Set` stores `raw = u8(pressure × AxisScale × 255)` and merges an up push to
  `ly = 127 - raw / 2`; for a face button `raw = u8(pressure × 255)` (the modifier's factor is 1 unless `Pressure`
  is held, and the owner binds no `Pressure`).
- **What `--light` writes** (default stick 0.5, Triangle 0.2; the owner's `AxisScale = 1.33`, `Deadzone = 0`,
  `ButtonDeadzone = 0`): `Macro15 = Keyboard/7`, `Macro15Binds = Triangle`, `Macro15Pressure = 0.201961` (pressure
  byte 51, 0.20 of full, under the handler's 0.3); `Macro16 = Keyboard/8`, `Macro16Binds = LUp`,
  `Macro16Pressure = 0.375940` (raw 127, **ly 64 = 0x40**, 64 of the 128 steps from centre: push 0.500). The
  pressure aims at raw + 0.5 so the float's truncation cannot land a step off, and follows the ini's own AxisScale.
  Keys 7 and 8 are bound nowhere in the owner's ini (the writer refuses one that is). The schedule names them
  `TRIANGLE_LIGHT` and `W_LIGHT` (`keys.MAPS["pcsx2"]`).
- **No ini-path argument.** PCSX2-Qt has `-datapath`, but `EmuFolders::SetDataDirectory` gives portable mode
  "absolute priority" and `tools/pcsx2` carries `portable.ini` and `portable.txt`, so the data root (and its
  `inis/PCSX2.ini`) is always the install directory. So `--light` needs `--slot` (PCSX2 reads the macros at
  launch; an attached PCSX2 has none, refused, and so is a pcsx2-qt already running), copies the owner's
  `tools/pcsx2/inis/PCSX2.ini` to `PCSX2.ini.seal_speed_light.bak` beside it, writes the copy with the two macros
  (every other line byte for byte), launches, and after PCSX2 is killed and waited for puts the original back: in
  a `finally`, on SIGTERM/SIGBREAK/SIGHUP (raised as SystemExit), at interpreter exit, and -- if a run died past
  all of those -- at the start of the next `--light` run, which restores a left-behind backup before it reads.
  Any exception or signal once PCSX2 is spawned (a failed state load, a Ctrl+C in the PINE wait or the boot
  sleep) kills PCSX2 and waits for it before the restore (`guarded_launch`), and the restore **refuses** while a
  pcsx2-qt still runs -- a PCSX2 holding the macros would write them back into the owner's file at its next
  settings save. A refused or failed restore prints the ini's and the backup's paths and "the owner's PCSX2.ini
  is STILL the modified copy", keeps the backup and the exit hook, and raises.
  `--pcsx2-ini` points it elsewhere (the tests use temporary copies of a sample ini, never the owner's file).
- **Levels.** `--light <push>` takes any push in [0.05, 0.838): with d = round(128 × push), ly = 128 - d,
  raw = 2d - 1 and pressure = (raw + 0.5) / (AxisScale × 255). 0.5 -> raw 127, ly 64, `Macro16Pressure =
  0.375940`; 0.75 -> raw 191, ly 32, `0.564647`. The groups keep their names at every level; the report's expected column and the
  rows header carry the push.
- **The schedule** (appended to the default, from standing): half_fwd#1-3 (W_LIGHT, stand, expected 32.5),
  a light Triangle to crouch, crouch_walk#1-3 (W_LIGHT, crouch, expected 14.0), a light Triangle to stand. Each
  hold is followed by a full back hold of kind `return` (played, not fitted: 5.3 s after half_fwd, 2.3 s after
  crouch_walk, the forward distance at the back band 37) so the group stays near where it began. Before a light
  hold the stance check taps a **light** Triangle toward stand or crouch (stand <-> crouch, prone -> crouch) and a
  firm one only toward prone or from prone to stand. The fit's expected band takes the hold's `push`: in crouch
  under 0.838 the crouch walk whatever the push, else push × band; the report prints "32.5 (push 0.50)" and
  "14.0 (crouch walk, push 0.50)".

**Route B (PINE writes into the guest) is not deterministic, and is not taken.** The game rebuilds its pad view
every frame from the pad library's receive buffer (reCOM `zInput/zinput.h`: `CPad::m_DmaBuf`, `m_InData[32]`,
`m_AnalogLeft`, the floats `m_LeftStick[2]`), and that buffer is written by the IOP's pad DMA each vsync; the
locomotion then ramps its own axis copy (`actor+0x240/+0x244`, previous `+0x248/+0x24c`, `FUN_00586c10`) from the
stick every tick. Every word on that path is rewritten each frame from the one before it, so a PINE write from a
host thread with no frame sync lands before or after the game's read by chance and is lost on the next copy. No
guest word was found that the game reads but does not rewrite each frame.

**For the controller in the window, once:** `--dry-run --light` prints what will be written; after the first
`--light` run, check (a) the owner's ini is byte-identical to before (`git diff --no-index` against a copy, or its
hash) and no `.seal_speed_light.bak` is left; (b) the stance column reads crouch after `to_crouch` (a light
Triangle that reads as firm would go prone -- then the macro's pressure did not reach the pad, and the Triangle
pressure path of this PCSX2 build is not the source's); (c) half_fwd moves at all (a macro whose bind name did
not parse logs "Invalid bind" in PCSX2's log and fires nothing).

## Results

Not yet run (2026-09-28).
