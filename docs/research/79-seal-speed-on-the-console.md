# 79 -- The SEAL's speeds and stance heights on the console: the method (web sprint 2, W2.2c)

*2026-09-28. The recipe, not the result: the instruments are `tools_py/parity/seal_speed_probe.py` and
`tools_py/parity/seal_speed_fit.py` (tests `tools_py/tests/test_seal_speed_probe.py`, `test_seal_speed_fit.py`, on
synthetic rows only). The measurement is lock-bound and runs in a window the owner names (spec W2.R7).*

What it settles: the bands and ramp of the web sprint 2 design's §7
(`web/docs/specs/2026-09-28-web-sprint-2-the-seal-in-the-world-design.md`) -- forward 65, back 37, strafe 65, the
stick ramp (90 % of full on tick 11, 0.18 s) -- and the skeleton root per stance (W2.R9: standing 11.484, crouched
5.504, prone unknown). Ours is not the reference: it renders 18.7 game frames a second (KNOWN).

## 1. Method

- **Rows.** Over PINE, as fast as it answers: the guest clock, then the local actor's position words 7-9
  (`*player_actor + actor_pos`), the skeleton root's Y (`*(actor + root_node) + 4`), MoveScale (`actor + move_scale`),
  then the clock again; a row whose two clock reads differ straddled a frame and is dropped. Addresses come by name
  from `tools_py/parity/guest_addresses.py`, column r0001 (the console boots the r0001 disc); they are
  `scripts/parity/guest_probe_console.json`'s chains. Time is the **guest clock in seconds**, never the host's and
  never 4 Hz peek rows (research 25 §5); rows sharing a clock value collapse to the last read.
- **Holds.** Full deflection only: `keys.press(hwnd, button, "pcsx2", hold_s=6)` -- drive.py's `hold+` step and
  pcsx2_ctl's `hold` -- posts a key PCSX2's [Pad1] binds: W = LUp, S = LDown, A = LLeft, Triangle = Keyboard/I,
  H = RRight (the step-script name `L`). Default schedule (`--dry-run` prints it, about 63 s): rest 3 s at the spawn;
  **crouch_fwd** (W); Triangle -> prone; **prone_fwd** (W); Triangle -> stand; **fwd** (W), **back** (S), **left**
  (A), **fwd_left** (W+A); 6 s each, 3 s of rest before and after. The order is the brief's reshaped for what a
  keyboard reaches: a full Triangle goes PRONE at once (KNOWN §1, R139: pressure 0.3 or more), so from the
  crouched spawn (design §7, W2.3) the stances run crouch -> prone -> stand and never back to crouch.
- **Fit, per hold** (research 18 §3.13's rules): the steady speed is a least-squares line through x(t), z(t) over
  the last 60 % of the hold's rows (RMS residual over 0.5 units = NOISY); t90 from the hold's start to the first
  centred-difference speed at 0.9 x steady (NaN when rows are sparser than 0.1 s); the heading atan2(vz, vx) and the
  velocity along and across the facing (the **fwd** hold's heading), so **back** reads about -37 along; the root Y
  at rest is the median over the 1 s before the hold; any MoveScale row not exactly 1.0 inside the hold REJECTS it
  (the camera record 0x416054 is not the feet and is not read; the "lead" of research 18's affine response is the
  camera's slack and does not apply to the actor's own words). A hold under half its group's median distance is
  BLOCKED; groups are the name before `#`.
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

The savestate, one lock hold (the drive's step lines go to the log; the save waits for the HUD match, then 20 s for
the script's two pop-up guards):

```
bash scripts/loop_lock.sh run agent-web-s2c --purpose "W2.2c console speed: spawn savestate" -- bash -c '
  python -m tools_py.parity.drive --target pcsx2 --script scripts/parity/mission_music_fast.txt \
      --out logs/parity/w22c_spawn --tail 240 > logs/parity/w22c_spawn.log 2>&1 & d=$!
  until grep -q "matched=True" logs/parity/w22c_spawn.log || ! kill -0 $d 2>/dev/null; do sleep 5; done
  sleep 20
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

Output: `logs/parity/seal_speed_<stamp>.txt` (rows: guest_t x y z root_y move_scale host_t; a header with the torn
and null counts) and `seal_speed_<stamp>.schedule.json`; the table is printed and can be re-made with
`python -m tools_py.parity.seal_speed_fit <rows> <schedule>`:

| hold | rows | speed u/s | along | across | heading deg | rel. deg | t90 s | rootY at rest | distance | resid | status |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|

## 4. Acceptance

- **W2.R7:** fwd, left and fwd_left within 5 % of 65 (61.75-68.25), back within 5 % of 37 along the facing, each
  status OK; a measured value beyond 5 % is a KNOWN row and the measured value wins. crouch_fwd at full push is
  expected near 65 (design §7: the SEAL stands and runs while the stance stays crouch); prone_fwd near 11.
- **W2.R9:** the root Y at rest before crouch_fwd, prone_fwd and fwd, to two decimals (expected 5.50, unknown,
  11.48).
- t90 against 0.18 s (plus the latency), on OK holds only.

**Not measurable from the keyboard** (left to the controller: PINE writes to the pad buffer, or a PCSX2
pressure-modifier binding in the owner's ini): the crouch WALK (a push under 0.838: 14.0 ahead, 12.8 back, 14.2
sideways), the crouch-diagonal 19.8 question, a half stick's 32.5, and the stand/crouch toggle (a light Triangle).

## Results

Not yet run (2026-09-28).
