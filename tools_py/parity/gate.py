"""One command for the three screenshot gates. PASS/FAIL per gate, exit 1 on any FAIL.

  python -m tools_py.parity.gate                     # all three (title ~3 min, transition ~3 min, mission ~11 min)
  python -m tools_py.parity.gate --only title,mission
  python -m tools_py.parity.gate --score-title logs/parity/runs/vr_title     # re-score, no game run
  python -m tools_py.parity.gate --score-mission logs/parity/drive_gameplay_probe5.txt

Runs go to logs/parity/gate/<stamp>/<gate>/ with the drive log beside them and a summary.txt.
Must be run from the repo root (drive.py uses relative paths). Takes scripts/loop_lock.sh.

Refuses to start (exit 3) when C: has less than RUN_MIN_FREE_GB (default 4) free -- Sprint 5 R46/A5:
a launch or a gate run must not be the thing that fills a drive already near capacity. `free_gb()` is
the injectable seam for tests (mock.patch.object(gate, "free_gb", ...)); RUN_FREE_GB_CMD overrides the
query itself with a shell command whose last stdout line is the free space in GB, the same override
scripts/run_detached.sh honours for its own disk refusal. `--score-title`/`--score-mission` (re-score
an existing run, no game launch, nothing large written) are exempt.

The gate states what it measured (Sprint 10 Q1b). Beside the EXE line, summary.txt carries one `PIN <name>
sha256=<hex> ...` line per pinned input -- every reference image and drive script the three stages read
(pinned_files, derived from the scripts and the scorers), the memory card the run boots from, the PS2X_*
environment, the harness revision (record only) and, once the runtime prints it, the input mapping hash --
and a run's pins.json beside it. The committed standard is scripts/parity/pins.json; a launch whose pins do
not match it is REFUSED before anything is launched (exit 7, distinct from a stage FAIL's 1), and so is a
`--baseline` re-score whose recorded pins, or today's reference files, do not match. `--accept-pins` makes the
measured values the standard, written once after the run (the summary says so; a gate the lock refuses
writes nothing -- issue #45); `--pins` is the lock-free dry check.

A run with the mission stage also carries `FRAME mean=<ms> worst1s=<ms> n=<VBlanks>` (Sprint 13 V4): VBlank
pacing -- host ms per guest VBlank, a lower bound on the time between presents, not the present rate (docs/
KNOWN.md §1's two-instance clock row keeps the two apart) -- over the scripted walk (the HUD step to the drive's
last step), from the sampler rows of mission.game.log (tools_py/parity/frame_time.py says which fields and
why), and records the numbers in its pins.json as an informational
`PIN frame` that is never compared (S13-R3: no refusal until three gates agree on its spread).

A launch refuses (exit 5, REFUSE_STALE) when the exe is older than the newest file it is built from (freshness_roots;
Sprint 14 E4); `--stale-ok` proceeds and the summary says so. Every summary and pins.json carries `TREE <head>
dirty=<n>` -- the tree the gate measured.

A fourth leg (Sprint 14 E2) scores a finished stamp against frozen references and launches nothing:
  python -m tools_py.parity.gate --capture-heldout logs/parity/gate/<green stamp>   # once, exit 9 if refused
  python -m tools_py.parity.gate --leg heldout logs/parity/gate/<stamp>             # 0 only at 12/12; 6 before
the captures. See LEG_REFS_DIR below; the name appears in this file and the merged-chain template only.
"""
import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import OrderedDict

import numpy as np
from PIL import Image

from tools_py.parity import (black_rows, compare, console_compare, drive, frame_time, guest_addresses,
                             guest_probe, hostplatform, mission_fail, pins, screen_bands, sp_death_probe)

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_MIN_FREE_GB = 4.0


def free_gb(drive_path=None):
    """Free space on `drive_path`, in GiB (default: hostplatform.free_space_path() -- the C: drive on
    Windows, the repo's own filesystem on Linux, where the C: drive is not a path and disk_usage raises).
    RUN_FREE_GB_CMD, if set, overrides the query with a shell
    command whose last stdout line is the figure (used by tests, and shared with
    scripts/run_detached.sh's own override of the same name); otherwise shutil.disk_usage. Tests
    normally patch this function directly rather than going through RUN_FREE_GB_CMD."""
    cmd = os.environ.get("RUN_FREE_GB_CMD")
    if cmd:
        out = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=True).stdout
        return float(out.strip().splitlines()[-1])
    return shutil.disk_usage(drive_path or hostplatform.free_space_path()).free / (1024.0 ** 3)


TITLE_REF = os.path.join("scripts", "parity", "ref_main_menu_ours.png")
# Calibrated 2026-09-10 on the four stored clean title runs (vr_title, rt_title, gl_title,
# xg_title): the 19 menu captures s00..s18 score 93.2..99.4 against the reference, s19 is the
# fade into the attract movie (83.7..85.1) and s20..s22 are the movie itself (49.5..67.8).
# Every clean run scores exactly 19/23 >= 90.0, so 90.0 sits ~3 points under the menu band and
# ~5 points over the fade, and 16 leaves three captures of headroom. A mission run scored as a
# title run gives 1/36 (negative control, logs/parity/runs/gameplay_probe5).
# [SUPERSEDED 2026-09-25 by the issue #30 block below: the verdict is no longer a count. The three
# captures of headroom sat inside the menu, not at the tail (s7_cpu_fallback2 lost s16..s18 and passed),
# and the "~3 points" band is 2.0 on the full record (lowest window capture 92.0, research/64 command G).
# The scores and the fade/movie reading above still stand.]
#
# Issue #30 (research/64, 2026-09-25): s19..s22 are not menu screens that were lost -- they are the game's idle
# attract sequence (the menu fading to black, then the mission flyovers), already named in the calibration
# above. Of the 165 archived stamps with a title line (native_on 2026-09-10 .. s11_close_gate), 123 score
# exactly 19/23, 7 score 20-21/23 (the attract a capture late) and 14 score 23/23 (no attract inside the
# window; s8_audio_mc_gate2, the issue's "before", is one of those). The count bar hid the one real loss on
# record: s7_cpu_fallback2 froze on the menu-over-black from s16 on (s16..s22 = 82.7-82.9) and PASSED at 16/23.
# So the verdict is positional: every capture the run wrote inside the menu window s00..s18 must score
# >= TITLE_MIN_SCORE (on the record each of those positions matched the reference, and so did the capture
# before it; the lowest window capture on a clean stamp is 92.0, 2.0 over the bar, and the lowest s18 alone
# 93.0, s5_gsbp2c), and the attract tail s19..s22 is printed,
# not counted. Replayed over the 165 stamps this changes one verdict, s7_cpu_fallback2 PASS -> FAIL.
# TITLE_MIN_MATCHES stays as the floor on how many window captures a run must have written (the committed
# fixture tests/fixtures/gate/title holds s00..s15).
TITLE_MIN_SCORE = 90.0      # compare.score of a capture vs the main-menu reference
TITLE_MENU_WINDOW = 19      # s00..s18 are the menu on every clean run; s19.. is the attract sequence
TITLE_MIN_MATCHES = 16      # at least this many menu-window captures must exist (and all of them must match)
HUD_REF_NAME = "ref_hud_ours.png"
MISSION_MIN_HOLDS = 3       # sNN_hold* steps after the HUD: fewer means the probe died on entry
# ... and of their captures (sNN_hold*.png), at least this many must be gameplay by the letterbox-band test
# (screen_bands.gameplay_band). R30, 2026-09-13: from 2026-09-12 14:33 every mission run "reached the HUD"
# with 0 presses on the letterboxed intro cinematic and held W/R1/L/S over it -- s5_task4_dbuff's six hold
# captures are all the cinematic -- and this scorer, which read only the drive log, passed them. Sprint 3's
# s3a (4 presses) has 6/6 gameplay holds, famb 6/6, s3d_2x_host 5/6 (its rejected hold, s36, is a black
# frame); s3b3 2/6 (it held over the "TO ABORT" flyover) FAILs, correctly. False-positive class: the band
# test only says "not the letterbox" -- s3d_2x_host's MISSION FAILURE statistics holds (s38, s40) and dim
# near-black fades (famb s34) read as gameplay.
MISSION_MIN_GAMEPLAY_HOLDS = 3
# Liveness (R34): gameplay on screen is not a live game. s5_gatefix and mission4 passed the band test on
# every hold while the runtime had nearly stopped presenting (latest_frame.png exports after the first
# [guest-fault] line: s5_gatefix 43, mission4 36, native_on 61, against s3a 1393, famb 1529); their holds
# are pixel-identical, so W/R1/L/S never reached a running game. A "live pair" is two consecutive hold
# captures that are both gameplay and differ by a mean absolute RGB difference >= MISSION_LIVE_PAIR_DIFF.
# Measured on the full-size captures (review of 69e2a9d, re-derived here): qualifying pairs s3a 4
# (3.67-22.9), famb 4, native_on 3, s3d_2x_host 2 -> PASS; mission4 1 (3.82), s5_gatefix 0 (max 1.60)
# -> FAIL. Static pairs in live runs read 0.00-0.03 (the player stands still after the last hold), so 3.0
# sits well above a frozen frame and at the bottom of real motion.
MISSION_LIVE_PAIR_DIFF = 3.0
MISSION_MIN_LIVE_PAIRS = 2
# Sprint 6 Task 1 (owner-agreed 2026-09-14): three scorers that look at what the liveness checks cannot.
# 1a mission_fail.detect over every hold capture and final.png FAILS the stage: s5_head_1x_b's holds were
#    gameplay and live while s38/s40/final were the MISSION FAILURE statistics screen.
# 1b console_compare on the spawn capture (mission_spawn_capture) is PRINTED into the detail and does not
#    change the verdict -- R78: the water shards are a known, owned defect, and a gate that fails on them
#    every run teaches nothing; the numbers are on every summary so their trend is visible. It flips to
#    failing in the same commit as the water fix (Task 5a).
# 1c guest_probe over the game's run log (mission_game_log) is SCORED since R80 (2026-09-15): s6_probe on the
#    block-pointer exe read the root node at the console's 5.5039, MoveScale 1.0 and 0 teleports, so a value
#    outside its tolerance fails the stage. NO-DATA fails only a stage the gate launched itself.
GUEST_PROBE_CONSOLE = os.path.join("scripts", "parity", "guest_probe_console.json")
PRISTINE_CARD = os.path.join("game", "disc", "mc0_parity")   # the 2026-09-08 card: no controller config saved, so the boot shows the configuration screens and the save dialog
# What this floor counts: black-screen frames AT OR AFTER the probe script's first `burst` step
# (first_burst_step() below -> black_rows.py --from-step), i.e. frames of the black screen
# between the controller-configuration screens and the mission briefing. It deliberately does not
# count the rest of the run: a boot supplies ten or more black frames of its own before the probe
# has left the memory-card screens, and counting those makes the gate green on a run that never
# reached the briefing at all.
#
# That is not hypothetical -- it is what this gate did between `wcap1` (2026-09-11) and this fix.
# The controller-configuration "save to memory card?" dialog started appearing on boot;
# gameplay_probe.txt guards it with ifref pairs and transition_probe.txt did not, so the probe
# stalled on the dialog. Every run since examined 0 frames at/after its burst step and passed on
# boot black screens alone: wcap1 10 frames / 0 after, wcap2 13 / 0, famb 11 / 0, famc 10 / 0,
# hostdraw_on 11 / 0, hostdraw_fix 9 / 0. Runs from before the dialog did measure the transition
# (gate/first 6 / 5, gate/native_on 4 / 4, runs/gl_transition 8 / 7), which is why the floor of 5
# looked calibrated. All of the stalled runs FAIL under the scorer as it now stands; that is the
# honest record, not a regression.
#
# The same defect came back on 2026-09-12 in its other half. The guards were there, but the burst
# was pinned to step 11 (right after the FIRST guard pair) while the dialog can land on a later
# pair: logs/parity/gate/s4_mb matched it at steps 13/14, so the burst fired on a controller-
# configuration screen and the only frames left of the actual fade were four 1 Hz wait captures --
# FAIL, "4 black-screen frames examined, need 5", three runs running. The burst is now `ifburst`
# (drive.py): one after every guard pair, and only the pair that answered the dialog fires its
# own. score_transition reads the step back off the captures the run wrote (observed_burst_step),
# so the scored frames are the frames after the NO press wherever that press landed. Only bursts at
# a step the script marks `ifburst` count: the probe also ends with an unconditional burst on the
# settled briefing, and a run that answered no dialog but still reached that burst would otherwise
# have it read as "the transition" and pass quietly on it (found in review, 2026-09-12).
#
# transition_probe.txt carries those guards and puts its burst on the NO press, so the fade is
# captured at 5 fps. Calibrated 2026-09-11 on two consecutive clean runs of the fixed probe:
# logs/parity/gate/tfix3 examined 18 frames at/after the burst step and tfix4 17, every frame
# peak 0. Both clear 5 by more than 3x, so the floor stays 5: under it, a run either did not reach
# the fade or lost its captures. black_rows.py exits 0 when it examines nothing, so the exit code
# alone is a vacuous pass and the count is part of the verdict.
# Recalibrated 2026-09-17 (research/34 section 6): with the guest clock on wall time the black screen before
# the briefing lasts about 4 s (s6_clock_gate: 4 wait captures at 1 Hz, all peak 0) where the two-thirds-speed
# clock gave 14 (s6_clutfix_gate). Three keeps the vacuous-pass guard (a stalled run examines 0 or 1).
TRANSITION_MIN_FRAMES = 3

GATES = {
    "title": dict(script="scripts/parity/title_menu.txt", seconds=170, tail=8),
    "transition": dict(script="scripts/parity/transition_probe.txt", seconds=170, tail=8, wait_period=0.2),
    "mission": dict(script="scripts/parity/gameplay_probe.txt", seconds=480, tail=170),
}


def _score_value(golden, ours):
    """compare.score (compare.py:19) takes two PIL images and returns
    {"score": .., "mad": .., "block": ..}; it may also be a float or a (score, mad, block)
    tuple. Open the paths and normalise the result to a float."""
    with Image.open(golden) as g, Image.open(ours) as o:
        r = compare.score(g, o)
    if isinstance(r, dict):
        return float(r["score"])
    return float(r[0] if isinstance(r, (tuple, list)) else r)


def score_title(run_dir):
    caps = sorted(p for p in glob.glob(os.path.join(run_dir, "s[0-9][0-9]_*.png"))
                  if "burst" not in os.path.basename(p))
    if not caps:
        return False, "no captures in %s" % run_dir
    scores = [(os.path.basename(p), _score_value(TITLE_REF, p)) for p in caps]
    good = sum(1 for _, s in scores if s >= TITLE_MIN_SCORE)
    window = [(n, s) for n, s in scores if int(n[1:3]) < TITLE_MENU_WINDOW]
    tail = [(n, s) for n, s in scores if int(n[1:3]) >= TITLE_MENU_WINDOW]
    lost = [n[:3] for n, s in window if s < TITLE_MIN_SCORE]
    ok = not lost and len(window) >= TITLE_MIN_MATCHES
    notes = []
    if lost:
        notes.append("menu capture(s) under %.1f: %s" % (TITLE_MIN_SCORE, " ".join(lost)))
    if len(window) < TITLE_MIN_MATCHES:
        notes.append("only %d menu-window captures, need %d" % (len(window), TITLE_MIN_MATCHES))
    if tail and all(s >= TITLE_MIN_SCORE for _, s in tail):
        notes.append("attract not reached by s%02d" % int(tail[-1][0][1:3]))
    detail = "%d/%d menu captures >= %.1f (window s00..s%02d: %d/%d)%s; scores: %s" % (
        good, len(scores), TITLE_MIN_SCORE, TITLE_MENU_WINDOW - 1, len(window) - len(lost), len(window),
        "".join("; " + x for x in notes), " ".join("%s=%.1f" % (n[:3], s) for n, s in scores))
    return ok, detail


BURST_CAPTURE_RE = re.compile(r"^s(\d+)_burst_")
# The content-scored transition (s6_fade, 2026-09-16). When no ifburst fired -- a saved controller configuration
# on the card, or a boot that showed no configuration screens -- the fade to black happens during the rank
# press's own settle wait, at a step index that drifts with the number of boot screens (s05 in s6_fade, s07
# nominal), so no step-pinned burst catches it. fade_frames finds the FIRST capture whose header band matches
# the briefing reference (rows 6..18, cols 0..80 of the 160x112 thumbnail: "MISSION BRIEFING"; measured 0.0 on
# every briefing frame of s6_fade/s6_gamepad3, 25.4+ on every other screen, 11.9 on the half-drawn fade-in
# frame), skips the briefing's own fade-in (non-black frames within FADE_IN_MAX_S before it) and counts the
# contiguous black-screen run behind that. The boot's black screens sit behind the main menu, a non-black
# frame, so they can never join the run -- the property the burst step was enforcing.
BRIEFING_REF = os.path.join("scripts", "parity", "ref_briefing_ours.png")
BRIEFING_BAND = (6, 18, 0, 80)
BRIEFING_THRESH = 8.0
FADE_IN_MAX_S = 2.0
CAPTURE_RE = re.compile(r"^[sw]\d+_.*\.png$")


def _script_step_modes(script_path=None):
    """The head mode of every step of a drive.py step script, in drive.parse order.

    drive.py numbers steps by their position among the non-blank, non-comment lines of the script
    and names each capture `s<NN>_*` / `w<NN>_*` after that index, so the list index here is the
    step index there."""
    path = script_path or os.path.join(ROOT, GATES["transition"]["script"])
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    modes = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            modes.append(line.split("+", 1)[0].split(":", 1)[0].strip())
    return modes


def first_burst_step(script_path=None):
    """Index of the first `burst`/`ifburst` step of a drive.py step script, or None.

    In transition_probe.txt the first burst-family step is the one that starts on the "save to
    memory card?" NO press, which is what takes the game to the black screen before the briefing.
    This is the *static* answer -- where the earliest burst could fire. The probe's transition
    bursts are `ifburst` (they fire only behind the guard pair that actually answered the dialog),
    so the answer for a given run is observed_burst_step(); this one is used by
    make_gate_fixtures.py to check that a candidate fixture frame is one the gate would examine."""
    for step, mode in enumerate(_script_step_modes(script_path)):
        if mode in ("burst", "ifburst"):
            return step
    return None


def conditional_burst_steps(script_path=None):
    """The step indices a script marks `ifburst`, i.e. the ones that can only fire on a matched
    "save to memory card?" guard pair -- the transition bursts, and nothing else.

    This set is what keeps the probe's TRAILING unconditional `burst` (the settled briefing, step
    22) from being mistaken for a transition. Without it, a run that answered no dialog at all but
    still reached the briefing would have `s22_burst_*` as its only burst captures, observed_burst
    _step would report 22, and the scorer would count whatever is at the end of the run and call it
    the transition -- a quiet pass if that region happened to read black. Found in review,
    2026-09-12; it is the same failure class this whole enforcement exists to remove."""
    return {step for step, mode in enumerate(_script_step_modes(script_path)) if mode == "ifburst"}


def observed_burst_step(run_dir, script_path=None):
    """Step index of the first *transition* burst that actually fired in a captured run, or None.

    drive.py writes a burst's frames as `s<NN>_burst_<k>.png`, so the run directory records where
    the burst happened even though the step script only says where it *may* happen. The transition
    probe's transition bursts are conditional on the guard pair matching (drive.py `ifburst`), and
    that dialog moves with how many controller-configuration screens the boot shows -- 2026-09-12
    it landed on steps 13/14 instead of 9/10, which put the old fixed burst on a screen that was
    not the transition and left the scorer four 1 Hz wait frames to count (logs/parity/gate/s4_mb).
    Reading the index back off the captures is what makes the scored frames "the frames after the
    NO press" wherever that press landed.

    Only bursts at a step the script marks `ifburst` count (conditional_burst_steps). A script that
    marks none -- an older probe whose bursts are all unconditional -- falls back to every burst it
    finds, which is what such a run means. `None` means no transition burst fired: score_transition
    FAILs on that outright rather than picking some other window."""
    conditional = conditional_burst_steps(script_path)
    steps = []
    try:
        names = os.listdir(run_dir)
    except OSError:
        return None
    for name in names:
        m = BURST_CAPTURE_RE.match(name)
        if m and (not conditional or int(m.group(1)) in conditional):
            steps.append(int(m.group(1)))
    return min(steps) if steps else None


def briefing_dist(path, ref=None):
    r0, r1, c0, c1 = BRIEFING_BAND
    if ref is None:
        ref = drive.thumb(Image.open(BRIEFING_REF))
    t = drive.thumb(Image.open(path))
    return float(np.abs(t[r0:r1, c0:c1] - ref[r0:r1, c0:c1]).mean())


def fade_frames(run_dir):
    """([(name, band_peak), ...] in capture order, first_briefing_name): the black-screen run immediately before
    the first briefing frame of the run, capture order by file mtime (step names drift; capture time does not).
    ([], None) when no capture matches the briefing."""
    try:
        names = [n for n in os.listdir(run_dir) if CAPTURE_RE.match(n)]
    except OSError:
        return [], None
    paths = sorted((os.path.join(run_dir, n) for n in names), key=lambda p: (os.path.getmtime(p), p))
    ref = drive.thumb(Image.open(BRIEFING_REF))
    first = next((k for k, p in enumerate(paths) if briefing_dist(p, ref) <= BRIEFING_THRESH), None)
    if first is None:
        return [], None
    t_first = os.path.getmtime(paths[first])
    k = first - 1
    # The briefing fades in from black: step back over its non-black frames, but only within FADE_IN_MAX_S.
    while k >= 0 and t_first - os.path.getmtime(paths[k]) <= FADE_IN_MAX_S and not black_rows.examine(paths[k])[0]:
        k -= 1
    run = []
    while k >= 0:
        black, peak = black_rows.examine(paths[k])
        if not black:
            break
        run.append((os.path.basename(paths[k]), peak))
        k -= 1
    return run[::-1], os.path.basename(paths[first])


def score_transition(run_dir, script_path=None):
    """black_rows.py prints one "<file>  black screen, rows <y0>-<y1>: peak <n>" line per frame it
    actually examines and exits 1 only when one of them is not black. Zero examined frames also
    exits 0, so the count is part of the verdict, not just the exit code.

    Only frames at or after the run's transition burst are examined (--from-step): those are the
    transition, everything before them is the boot. The step is taken from the captures the run
    actually wrote (observed_burst_step), so a probe whose dialog landed late is still scored from
    its NO press. A run that fired no transition burst never saw the dialog (a saved controller
    configuration on the card, s6_gamepad..s6_fade 2026-09-16): its fade happened during the rank
    press's own settle wait at a drifting step index, so it is scored by CONTENT instead
    (score_fade: the black run immediately before the first briefing frame). There is deliberately
    no fallback to a step index: that would let the run's other black frames -- the boot's, or the
    trailing briefing burst's -- stand in for a fade that was never captured."""
    burst = observed_burst_step(run_dir, script_path)
    if burst is None:
        return score_fade(run_dir)
    scope = " at/after the burst step (s%02d, fired)" % burst
    cmd = [sys.executable, "tools_py/parity/black_rows.py", run_dir, "--from-step", str(burst)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    examined = [ln for ln in r.stdout.splitlines() if "black screen, rows " in ln]
    bad = [ln for ln in examined if "NOT BLACK" in ln]
    peaks = [int(m.group(1)) for m in (re.search(r"peak\s+(\d+)", ln) for ln in examined) if m]
    # One check, not two: "examined nothing" and "examined fewer than the floor" are the same
    # condition -- a separate `if not examined` above this was unreachable.
    if len(examined) < TRANSITION_MIN_FRAMES:
        return False, ("transition not captured (%d black-screen frames examined%s, need %d)"
                       " in %s" % (len(examined), scope, TRANSITION_MIN_FRAMES, run_dir))
    if bad or r.returncode != 0:
        return False, "%d black-screen frames examined%s; non-black band: %s" % (
            len(examined), scope,
            "; ".join(" ".join(ln.split()) for ln in bad[:5]) or r.stderr.strip()[:200])
    return True, "%d black-screen frames examined%s, rows 396-447 peak %d" % (
        len(examined), scope, max(peaks, default=0))


def score_fade(run_dir):
    """The content-scored transition for a run that fired no ifburst (see fade_frames)."""
    run, first = fade_frames(run_dir)
    if first is None:
        return False, ("transition not captured (0 black-screen frames examined: no transition burst fired and "
                       "no briefing frame was captured, so nothing marks where the fade ends) in %s" % run_dir)
    scope = " before the first briefing frame (%s)" % first
    if len(run) < TRANSITION_MIN_FRAMES:
        return False, ("transition not captured (%d black-screen frames examined%s, need %d) in %s"
                       % (len(run), scope, TRANSITION_MIN_FRAMES, run_dir))
    bad = [(n, p) for n, p in run if p > 8]
    if bad:
        return False, "%d black-screen frames examined%s; non-black band: %s" % (
            len(run), scope, "; ".join("%s rows 396-447 peak %d <-- NOT BLACK" % b for b in bad[:5]))
    return True, "%d black-screen frames examined%s, rows 396-447 peak %d" % (
        len(run), scope, max((p for _, p in run), default=0))


# How much longer a stage's game may live off Windows. `seconds` is the run length the drive gives the
# exe, calibrated on the host: the title stage's 23 captures end at t=156 s there, inside 170. The VM
# has no GPU and boots to the main menu in 119 s against the host's 23 (s8_vm_title3 vs s7_final_gate),
# so the same 23 captures run past 170 and the game dies mid-stage -- 15 of the 23 captures of the first
# VM run are one frozen frame. The multiplier only lengthens a timeout; the drive still takes the game
# down itself when the script ends, so a fast Linux box pays nothing for it.
SLOW_HOST_SECONDS_FACTOR = 3


def stage_seconds(name, system=None):
    cfg = GATES[name]
    return cfg["seconds"] if hostplatform.is_windows(system) else cfg["seconds"] * SLOW_HOST_SECONDS_FACTOR


def drive_command(name, out_dir):
    """drive.py's command line for a stage; the transition stage captures its settle waits at 5 fps."""
    cfg = GATES[name]
    cmd = [sys.executable, "-m", "tools_py.parity.drive", "--target", "ours",
           "--script", cfg["script"], "--out", out_dir,
           "--seconds", str(stage_seconds(name)), "--tail", str(cfg["tail"])]
    if cfg.get("wait_period"):
        cmd += ["--wait-period", str(cfg["wait_period"])]
    return cmd


def mission_run_dir(drive_log):
    """run_gate writes <root>/mission.drive.log beside <root>/mission/; anything else has no known captures."""
    suffix = ".drive.log"
    if drive_log.endswith(suffix):
        d = drive_log[:-len(suffix)]
        if os.path.isdir(d):
            return d
    return None


def mission_game_log(drive_log):
    """run_gate copies the game's own run log (the newest logs/run_*.log, where the runtime prints its
    [peek] rows) to <root>/mission.game.log beside <root>/mission.drive.log; None when there is none."""
    suffix = ".drive.log"
    if drive_log.endswith(suffix):
        p = drive_log[:-len(suffix)] + ".game.log"
        if os.path.isfile(p):
            return p
    return None


def mission_spawn_capture(drive_log, run_dir):
    """The spawn-view capture the console reference was taken at: the first `s<NN>_none` step the drive
    log records after the HUD untilref matched (s28 in gameplay_probe.txt: the untilref step itself,
    captured once the HUD is on screen, before the 2 s wait and the first hold). Read off the log rather
    than pinned to 28 so the step moving in the script does not silently score a different frame. None
    when the log names no such step or its capture is missing."""
    try:
        with open(drive_log, encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    hud = re.compile(r"untilref\([^)]*%s[^)]*\):.*matched=True" % re.escape(HUD_REF_NAME))
    seen_hud = False
    for line in lines:
        if not seen_hud:
            seen_hud = bool(hud.search(line))
            continue
        m = re.match(r"^(s\d\d_none)\b", line)
        if m:
            p = os.path.join(run_dir, m.group(1) + ".png")
            return p if os.path.isfile(p) else None
    return None


def console_spawn_line(drive_log, run_dir):
    """`CONSOLE spawn score=<s> water flat=<f> dark=<d> -> PASS|FAIL` for the spawn capture, or
    `CONSOLE spawn NO-DATA`. Print-only (R78)."""
    cap = mission_spawn_capture(drive_log, run_dir)
    if cap is None:
        return "CONSOLE spawn NO-DATA (no s??_none capture after the HUD match)"
    # s6_gamepad5 (2026-09-16): the capture after the HUD match was the letterboxed location cinematic (gameplay
    # band 0.56; HUD frames read 0.92) and the water statistics scored it flat=0.071 -- a figure no HUD frame has
    # ever produced. A frame that is not a HUD frame is NO-DATA, never a verdict.
    try:
        with Image.open(cap) as im:
            is_hud, band = screen_bands.gameplay_band(im.convert("RGB"))
    except OSError as e:
        return "CONSOLE spawn NO-DATA (%s: %s)" % (os.path.basename(cap), e)
    if not is_hud:
        return "CONSOLE spawn NO-DATA (%s is not a HUD frame: gameplay band %.2f < %.2f)" % (
            os.path.basename(cap), band, screen_bands.GAMEPLAY_MIN)
    try:
        s = console_compare.score(cap)
        ok, _ = console_compare.water_verdict(cap)
        st = console_compare.water_stats(cap)
    except (OSError, ValueError) as e:
        return "CONSOLE spawn NO-DATA (%s: %s)" % (os.path.basename(cap), e)
    return "CONSOLE spawn score=%.1f water flat=%.3f dark=%.3f -> %s (%s vs %s)" % (
        s, st["flat"], st["dark"], "PASS" if ok else "FAIL", os.path.basename(cap), console_compare.CONSOLE_REF)


def probe_lines(run_log, revision=None):
    """One `PROBE <name> PASS|FAIL <detail>` per guest_probe result over the game's run log, or a single
    `PROBE NO-DATA` when there is no log to read.

    `revision` is the address column the run's [peek] ROWS are in -- for a live stage, the column
    launch_env built PS2X_PEEK in; for a --baseline re-score, the column the stamp's own record says
    (stamp_revision). Left out, it falls back to what the runtime's log says it installed.

    The two are not the same question, and when they disagree the gate says so before the PROBE lines
    (review F8). It is not hypothetical: s11_r0004_gate2 launched an r0004 image whose resident overlay
    made the runtime pick r0001, and all that reached the summary was a plain NO-DATA.
    """
    if not run_log or not os.path.isfile(run_log):
        return ["PROBE NO-DATA (no game run log beside the drive log)"]
    head = []
    try:
        with open(run_log, "r", errors="replace") as f:
            lines = f.readlines()
    except OSError as e:
        return ["PROBE NO-DATA (%s)" % e]
    try:
        installed, how = guest_addresses.log_revision(lines)
    except ValueError:
        installed, how = None, None
    if revision is None and installed is None:
        # Nothing said which column these rows are in -- not the caller, not the runtime. That is a
        # different silence from "0 reads of N rows" (which means the addresses were read and found
        # nothing), and it must not be the verdict of a re-score: score_mission_log treats this line as
        # print-only (review F1).
        return ["PROBE UNKNOWN-REVISION (the run does not say which address column its [peek] rows are "
                "in, so they were not read; pass --revision, or re-score a stamp that recorded its "
                "PS2X_PEEK)"]
    if revision and installed and installed != revision:
        head.append("PROBE COLUMNS DISAGREE: the rows are %s chains, the runtime installed %s (%s) -- "
                    "the image the gate launched is not the image the runtime read" % (revision, installed, how))
    try:
        results = guest_probe.evaluate(lines, GUEST_PROBE_CONSOLE, revision)
    except (OSError, ValueError, KeyError) as e:
        return head + ["PROBE NO-DATA (%s)" % e]
    return head + ["PROBE %s %s %s" % (r.name, "PASS" if r.ok else "FAIL", r.detail) for r in results]


def score_mission_log(drive_log, run_dir=None, run_log=None, probe_required=False, revision=None):
    """HUD matched in the drive log, >= MISSION_MIN_HOLDS hold steps, one capture per logged hold,
    >= MISSION_MIN_GAMEPLAY_HOLDS of the hold captures gameplay, and >= MISSION_MIN_LIVE_PAIRS live pairs
    (consecutive gameplay captures that differ: the game was running while the holds were sent). A log alone
    proves the script ran, not what the holds were held over, so missing captures are FAIL with NO-DATA,
    never a PASS.

    Then (Sprint 6 Task 1): no hold capture or final.png may be the MISSION FAILURE screen (FAIL), and the
    console spawn comparison and the guest-value probe are appended to the detail, print-only (R78).
    `run_log` is the game's own run log for the probe; default mission_game_log(drive_log)."""
    try:
        with open(drive_log, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:
        return False, str(e)
    m = re.search(r"untilref\([^)]*%s[^)]*\):.*matched=(True|False)" % re.escape(HUD_REF_NAME), text)
    if not m:
        return False, "no HUD untilref result in %s" % drive_log
    if m.group(1) != "True":
        return False, "HUD never matched (mission not reached)"
    holds = len(re.findall(r"^s\d\d_hold", text, re.M))
    if holds < MISSION_MIN_HOLDS:
        return False, "HUD reached; %d hold steps captured (need %d)" % (holds, MISSION_MIN_HOLDS)
    run_dir = run_dir or mission_run_dir(drive_log)
    caps = sorted(glob.glob(os.path.join(run_dir, "s[0-9][0-9]_hold*.png"))) if run_dir else []
    if len(caps) != holds:
        return False, ("NO-DATA: HUD reached, but %d hold captures for %d logged holds in %s"
                       % (len(caps), holds, run_dir))
    frames = []
    for p in caps:
        with Image.open(p) as im:
            rgb = im.convert("RGB")
            frames.append((os.path.basename(p)[:3], screen_bands.gameplay_band(rgb), rgb))
    good = sum(1 for _, (ok, _), _ in frames if ok)
    diffs = []
    for (_, (ok_a, _), a), (_, (ok_b, _), b) in zip(frames, frames[1:]):
        if b.size != a.size:
            b = b.resize(a.size, Image.BOX)
        d = float(np.abs(np.asarray(a, dtype=np.float32) - np.asarray(b, dtype=np.float32)).mean())
        diffs.append((d, ok_a and ok_b and d >= MISSION_LIVE_PAIR_DIFF))
    live = sum(1 for _, q in diffs if q)
    detail = ("HUD reached; %d hold steps; %d/%d hold captures are gameplay (need %d; bands %s); "
              "%d live hold pairs (need %d; diff >= %.1f: %s)" % (
                  holds, good, len(frames), MISSION_MIN_GAMEPLAY_HOLDS,
                  " ".join("%s=%.2f" % (n, f) for n, (_, f), _ in frames),
                  live, MISSION_MIN_LIVE_PAIRS, MISSION_LIVE_PAIR_DIFF,
                  " ".join("%.2f" % d for d, _ in diffs)))
    if not (good >= MISSION_MIN_GAMEPLAY_HOLDS and live >= MISSION_MIN_LIVE_PAIRS):
        return False, detail
    # 1a: a live game can still have failed the mission. The band and liveness tests read the MISSION
    # FAILURE statistics screen as gameplay (s5_head_1x_b), so every hold capture and the final frame
    # is checked for its banner.
    final = os.path.join(run_dir, "final.png")
    for p in caps + ([final] if os.path.isfile(final) else []):
        failed, reason = mission_fail.detect(p)
        if failed:
            return False, "MISSION FAILED on screen: %s (%s); %s" % (reason, os.path.basename(p), detail)
    # 1b: printed, not scored (R78) until the water is fixed. 1c: scored since R80 (s6_probe read the root node at
    # the console's 5.5039, MoveScale 1.0 and 0 teleports on the block-pointer exe) -- a probe value outside its
    # tolerance fails the stage; NO-DATA fails it only when the gate launched the stage itself (probe_required:
    # run_gate set PS2X_PEEK and the sampler, so rows must exist), never on a --score-mission re-score of an
    # older run that carries no game log.
    lines = [detail, console_spawn_line(drive_log, run_dir)]
    probes = probe_lines(run_log or mission_game_log(drive_log), revision)
    lines += probes
    failed = [l for l in probes if " FAIL " in l and ("NO-DATA" not in l or probe_required)]
    failed += [l for l in probes if l.startswith("PROBE NO-DATA") and probe_required]
    failed = [l for l in failed if not l.startswith("PROBE UNKNOWN-REVISION")]
    if failed:
        head = failed[0].split(" ", 2)
        name = head[1] if len(head) > 1 else "?"
        return False, "GUEST PROBE FAILED: %s; %s" % (name, "; ".join(lines))
    return True, "; ".join(lines)


def _lock(cmd, owner):
    try:
        return subprocess.run(["bash", "scripts/loop_lock.sh", cmd, owner], capture_output=True, text=True)
    except OSError as e:
        raise SystemExit("gate: cannot run scripts/loop_lock.sh (%s). Run the gate from Git Bash at "
                         "the repo root." % e)


def launch_env(name, card_dir, base=None, default_ok=False):
    """The environment a stage's drive is launched with: `base` (default os.environ) plus the gate's own
    knobs. drive.py launches the exe with its own environment, so PS2X_* set here reach the runtime.
    Pure -- the card copy is run_gate's -- so that collect_pins can hash exactly what a launch would get.

    `default_ok` is passed through to gate_revision: collect_pins takes it (a checkout with no disc assets
    still has to be able to hash the launch environment), a launch does not (review F3)."""
    env = dict(os.environ if base is None else base)
    # A gate run is defined as a boot with NO controller: with an Xbox pad plugged in the libpad HLE reported a
    # configured controller and the game skipped its PRECISION SHOOTER CONFIGURATION screens and the 'save to
    # memory card?' dialog the transition stage keys on (s6_gamepad, s6_gamepad2, 2026-09-16).
    env.setdefault("PS2X_HOST_GAMEPAD", "0")
    # ... and from a PRISTINE memory card. The owner's free play (2026-09-16) saved the controller configuration
    # onto game/disc/mc0, the card every gate booted from, and the boot stopped showing the configuration screens
    # and the 'save to memory card?' dialog the transition stage keys on (s6_gamepad .. s6_gamepad3, three gates
    # lost). Each stage now boots from a fresh copy of game/disc/mc0_parity in the stamp directory; an operator's
    # own PS2X_MC_DIR wins.
    if not env.get("PS2X_MC_DIR"):
        env["PS2X_MC_DIR"] = card_dir
    if name == "mission":
        # The mission stage needs the guest-value probe's chains in PS2X_PEEK (Task 1c) for probe_lines to read
        # anything; an operator's own PS2X_PEEK (a wider spec, e.g. the ladder's) is left alone.
        if not env.get("PS2X_PEEK"):
            # ... in the addresses of the REVISION this launch will run (Task 19): the console json is
            # written in r0001's, and on an r0004 image every one of them is somebody else's memory
            # (s11_r0004_reg2: 0 [peek] reads of 479 rows, the whole mission lane FAILed on it). The
            # revision comes from the build banner in $SOCOM_GAME_ELF, the image drive.py/run.sh launch.
            env["PS2X_PEEK"] = guest_probe.peek_spec(GUEST_PROBE_CONSOLE,
                                                     gate_revision(env, default_ok=default_ok))
        # The runtime prints its [peek] rows from the PC sampler's thread, one row per sample
        # (game_overrides_socom2.cpp, PS2X_PC_SAMPLER=<seconds>): without it PS2X_PEEK yields nothing --
        # s6_blockptr's mission stage read "PROBE ... NO-DATA (0 reads of 0 rows)". One row per second
        # is the ladder's cadence and costs nothing measurable.
        env.setdefault("PS2X_PC_SAMPLER", "1")
        # Sprint 17 F0: the [vu1-stats] line a second, whose syncv/s is the game's own frame rate -- the SYNCV
        # line beside FRAME (frame_time.read_syncv_stamp). A new knob in the env pin: the first gate after it
        # accepts the env pin's drift.
        env.setdefault("PS2X_VU_STATS", "1")
    return env


def card_source(base=None):
    """The memory card a launch boots from: the operator's PS2X_MC_DIR when set, else the pristine card
    run_gate copies. Its CONTENTS are the `card` pin (`docs/HAZARDS.md` harness, once HANDOFF trap 5: the card is shared state, and a saved
    controller configuration on it changes the boot flow the transition stage keys on)."""
    env = os.environ if base is None else base
    return env.get("PS2X_MC_DIR") or PRISTINE_CARD


def run_gate(name, out_root):
    cfg = GATES[name]
    out_dir = os.path.join(out_root, name)
    os.makedirs(out_dir, exist_ok=True)
    # A reused stamp kept the previous run's frames under this one's: s17_b6, rerun three times on 2026-10-01,
    # left 76 captures of the first run in transition/, fade_frames (mtime order) took a stale w04_011.png for
    # the first briefing frame, and the stage FAILED twice on frames the game never showed in that run.
    # Everything drive.py writes here -- the s/w/burst captures, final.png, manifest.json -- goes first.
    stale = [n for n in os.listdir(out_dir) if CAPTURE_RE.match(n) or n in ("final.png", "manifest.json")]
    for n in stale:
        os.remove(os.path.join(out_dir, n))
    if stale:
        print("gate: %s: removed %d capture(s) of a previous run from %s" % (name, len(stale), out_dir), flush=True)
    for p in glob.glob(os.path.join("logs", "parity", "latest_frame.png*")):
        os.remove(p)
    drive_log = os.path.join(out_root, name + ".drive.log")
    # The copy of the pristine card is per stamp (not per stage) -- the game writes SCRATCHPAD.DAT at boot.
    card = os.path.join(out_root, "mc0")
    if not os.environ.get("PS2X_MC_DIR"):
        shutil.copytree(PRISTINE_CARD, card, dirs_exist_ok=True)
    env = launch_env(name, os.path.abspath(card))
    with open(drive_log, "w", encoding="utf-8") as log:
        subprocess.run(drive_command(name, out_dir), stdout=log, stderr=subprocess.STDOUT, env=env)
    # The game's own run log (where the runtime prints its [peek] rows) lands beside the drive log as
    # <name>.game.log; score_mission_log's probe reads it back from there (mission_game_log).
    newest = sorted(glob.glob(os.path.join("logs", "run_*.log")), key=os.path.getmtime)
    if newest:
        shutil.copyfile(newest[-1], os.path.join(out_root, name + ".game.log"))
    subprocess.run([sys.executable, "-m", "tools_py.parity.montage", out_dir,
                    os.path.join(out_root, name + "_sheet.png")], capture_output=True)
    if name == "title":
        return score_title(out_dir)
    if name == "transition":
        return score_transition(out_dir)
    # The probe reads the rows with the column launch_env built PS2X_PEEK in -- the chains ARE the
    # addresses in the rows. probe_lines compares that with what the runtime says it INSTALLED and prints
    # a line when they disagree (review F8).
    return score_mission_log(drive_log, run_log=mission_game_log(drive_log), probe_required=True,
                             revision=gate_revision(default_ok=False))


def score_baseline(stamp, revision=None):
    """Sprint 6 Task 8: score a saved run directory (a stamp name under logs/parity/gate, or a path) without
    launching anything -- each stage it holds through the same scorer the live gate used; nothing written.
    Prints the gate's lines and summary; returns the gate's exit code, 4 when there is nothing to score,
    7 when the stamp's recorded pins or today's pinned files do not match the standard (baseline_pins)."""
    out_root = stamp if os.path.isdir(stamp) else os.path.join("logs", "parity", "gate", stamp)
    # Which addresses are this ARCHIVED run's rows in? From the stamp's own record -- never from whatever
    # image game/disc holds today, and never assumed (review F1). Before this, a re-score of any stamp
    # written before the runtime printed its revision line scored the mission lane as a FAIL on
    # "PROBE NO-DATA", discarding eight standards including s10_close_gate and s11_open_gate.
    try:
        if revision:
            how = "--revision"
        else:
            revision, how = stamp_revision(out_root)
        print("REVISION %s (%s) [baseline %s]" % (revision, how, out_root))
    except ValueError as e:
        # Unknown is not r0001. The stage is still scored -- a re-score that refuses outright discards a
        # standard over a question it does not need answered to check the screens -- but the probe says
        # UNKNOWN-REVISION rather than reading a column nobody proved (review F1). The pin standard falls
        # back to r0001's file, which is the only one a stamp with no record can have been made under.
        revision, how = None, None
        print("REVISION unknown (%s)" % e)
    refused = baseline_pins(out_root, revision or "r0001")
    if refused is not None:
        return refused
    results = []
    title_dir = os.path.join(out_root, "title")
    if os.path.isdir(title_dir):
        results.append(("title",) + tuple(score_title(title_dir)))
    transition_dir = os.path.join(out_root, "transition")
    if os.path.isdir(transition_dir):
        results.append(("transition",) + tuple(score_transition(transition_dir)))
    drive_log = os.path.join(out_root, "mission.drive.log")
    if os.path.isfile(drive_log):
        results.append(("mission",) + tuple(score_mission_log(drive_log, run_log=mission_game_log(drive_log),
                                                              probe_required=True, revision=revision)))
    if not results:
        print("gate: nothing to score in %s (no title/, transition/ or mission.drive.log)" % out_root)
        return 4
    failed = 0
    for name, ok, detail in results:
        print("%s %s (%s)" % ("PASS" if ok else "FAIL", name, detail), flush=True)
        failed += 0 if ok else 1
        if name == "mission":
            print(frame_time.line(*frame_time.read_stamp(out_root)), flush=True)   # informational (S13-R3)
            print(frame_time.syncv_line(*frame_time.read_syncv_stamp(out_root)), flush=True)
    print("GATE %s (%d/%d) [baseline %s]" % ("FAIL" if failed else "PASS", len(results) - failed, len(results), out_root))
    return 1 if failed else 0


# Sprint 14 E2 -- the heldout leg (the spec's D6: frozen scene references the agents never see). Twelve step captures
# the three stages already take are frozen once, from a green 3/3 gate stamp, into LEG_REFS_DIR (`--capture-heldout`,
# the controller's, at a quiet window); `--leg heldout <stamp>` then scores a stamp the chain made against them. It
# never launches, never locks, never reads the disk: it reads two directories. The name lives in this file and the
# merged-chain template only -- tools_py/tests' isolation test fails on any other file that mentions it (docs/ aside),
# so no skill, brief or DEVELOPING paragraph can name it.
#
# The stamps: drive.py writes exactly one `s<NN>_<buttons>.png` per step of a stage's script (the settled screen;
# the `s<NN>_burst_<k>.png` frames and the `w<NN>_<k>.png` waits are other files), under <stamp>/<stage>/. The
# buttons part moves with the run (an `ifref` step is `s12_RIGHT` when its dialog showed, `s12_none` when not), so a
# reference is filed by stage and step only: <stage>_s<NN>.png.
#
# The scorer and the bar: the one comparison of a capture against a reference image the gate already makes --
# score_title's, compare.score through _score_value, at TITLE_MIN_SCORE. The other stages' scorers are structural
# (black_rows' band peak, the briefing band, the gameplay band, live pairs) and compare no capture with a reference,
# so there is no other bar to take; and no new threshold is set here (a threshold is a KNOWN row or a test).
LEG_REFS_DIR = os.path.join("scripts", "parity", "refs", "heldout")
LEGS = ("heldout",)
# The twelve are R280's (the E2 review, 2026-09-26), chosen for stability across green runs: over 36 archived green
# stamps the plan's first choice (transition s02 s05, mission s01 s04) scored 12/12 on at most 11 of the other 35,
# because those steps land on boot screens that shift by one screen between runs (s02: main menu or select rank;
# mission s01: attract or menu; s04: black or briefing). Every step from 6 on in both stages, and title s00..s18,
# scores 35/35. So the leg covers the menu and the briefing; the transition's own structure is score_transition's.
LEG_STAMPS = (
    ("title_s03", "title", 3), ("title_s09", "title", 9), ("title_s15", "title", 15),
    ("transition_s06", "transition", 6), ("transition_s08", "transition", 8),
    ("mission_s06", "mission", 6), ("mission_s08", "mission", 8), ("mission_s10", "mission", 10),
    ("mission_s12", "mission", 12), ("mission_s16", "mission", 16), ("mission_s20", "mission", 20),
    ("mission_s24", "mission", 24),
)
# 6 and 9: free in this file and in run_detached.sh (2 lock busy, 3 disk, 4 nothing to score, 5 stale exe, 7 pin drift,
# 8 unknown revision). 6: the references do not exist yet, so the leg cannot run -- not a FAIL of the exe. 9: a
# capture refused (the directory exists: a re-capture is a deliberate delete first; or the stamp is not a green 3/3
# with every stamp present).
REFUSE_NO_REFS = 6
REFUSE_CAPTURE = 9
GATE_STAGES = ("title", "transition", "mission")


def leg_refs_root():
    return os.path.join(ROOT, LEG_REFS_DIR)


def leg_ref_name(ref):
    """The pin name of a reference: its path as LEG_REFS_DIR spells it, forward slashes (repo-relative in the tree)."""
    return _rel(os.path.join(LEG_REFS_DIR, ref + ".png"))


def stamp_capture(run_dir, stage, step):
    """<run_dir>/<stage>/s<NN>_<buttons>.png, the step's own capture (never a burst frame), or None."""
    caps = sorted(p for p in glob.glob(os.path.join(run_dir, stage, "s%02d_*.png" % step))
                  if "_burst_" not in os.path.basename(p))
    return caps[0] if caps else None


def run_is_green(run_dir):
    """(ok, why): does <run_dir>/summary.txt record a green 3/3 -- a PASS line for each of the three stages, no FAIL,
    a pin verdict of MATCH or ACCEPTED, and no --stale-ok acceptance (a reference must be of the exe its tree says)."""
    try:
        with open(os.path.join(run_dir, "summary.txt"), encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError as e:
        return False, "no summary.txt (%s)" % (e.strerror or e)
    missing = [s for s in GATE_STAGES if not any(l.startswith("PASS %s (" % s) for l in lines)]
    if missing:
        return False, "no PASS line for %s" % ", ".join(missing)
    failed = [l.split(" (", 1)[0] for l in lines if l.startswith("FAIL ")]
    if failed:
        return False, "; ".join(failed)
    if not any(l.startswith(("PINS MATCH", "PINS ACCEPTED")) for l in lines):
        return False, "its pins did not match (no PINS MATCH or PINS ACCEPTED line)"
    if any("STALE exe accepted" in l for l in lines):
        return False, "it ran a stale exe (--stale-ok)"
    return True, "green 3/3"


def capture_leg(run_dir):
    """--capture-heldout: freeze the twelve stamps of a green 3/3 stamp as the leg's references, and pin them."""
    root = leg_refs_root()
    if os.path.exists(root):
        print("gate: %s already exists -- refusing to capture over it (a re-capture is a deliberate delete first)"
              % _rel(LEG_REFS_DIR))
        return REFUSE_CAPTURE
    ok, why = run_is_green(run_dir)
    if not ok:
        print("gate: %s is not a green 3/3 gate stamp (%s) -- refusing to capture" % (run_dir, why))
        return REFUSE_CAPTURE
    found = [(ref, stamp_capture(run_dir, stage, step), stage, step) for ref, stage, step in LEG_STAMPS]
    gaps = ["%s s%02d" % (stage, step) for _, cap, stage, step in found if cap is None]
    if gaps:
        print("gate: %s has no capture for %s -- refusing to capture" % (run_dir, ", ".join(gaps)))
        return REFUSE_CAPTURE
    os.makedirs(root)
    try:
        pinned = OrderedDict()
        for ref, cap, _, _ in found:
            dst = os.path.join(root, ref + ".png")
            shutil.copyfile(cap, dst)
            pinned[leg_ref_name(ref)] = pins.file_sha256(dst)
            print("CAPTURED %s <- %s" % (ref, _rel(cap)))
        doc = {
            "_about": "The references of the gate's fourth leg (Sprint 14 E2): sha256 of each frozen capture, the "
                      "shape of scripts/parity/pins.json. The leg refuses to score (exit 7) while any reference "
                      "differs from its pin. Captured once; a re-capture is a deliberate delete first.",
            "accepted": "%s -- gate --capture-%s, stamp %s" % (time.strftime("%Y-%m-%d %H:%M"), LEGS[0],
                                                               os.path.basename(os.path.normpath(run_dir))),
            "pins": pinned,
        }
        with open(os.path.join(root, pins.RECORD_NAME), "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
            f.write("\n")
    except BaseException:
        shutil.rmtree(root, ignore_errors=True)       # never a half-captured directory
        raise
    print("CAPTURE %d references -> %s (from %s)" % (len(found), _rel(LEG_REFS_DIR), _rel(run_dir)))
    return 0


def leg_pin_drifts(root):
    """The references that are missing or differ from the directory's pins.json, as printable names."""
    expected = pins.load_expected(os.path.join(root, pins.RECORD_NAME))
    if expected is None:
        return ["%s (no pins.json)" % _rel(LEG_REFS_DIR)]
    bad = []
    for ref, _, _ in LEG_STAMPS:
        name = leg_ref_name(ref)
        path = os.path.join(root, ref + ".png")
        if name not in expected:
            bad.append("%s (unpinned)" % name)
        elif not os.path.isfile(path):
            bad.append("%s (missing)" % name)
        elif pins.file_sha256(path) != expected[name]:
            bad.append("%s (sha256 differs from its pin)" % name)
    return bad


def score_leg(run_dir):
    """--leg heldout: (rc, summary line). Each stamp against its reference at TITLE_MIN_SCORE; exit 0 only at 12/12.
    The summary line replaces any earlier one of this leg in <run_dir>/summary.txt."""
    root = leg_refs_root()
    tag = LEGS[0].upper()
    if not os.path.isdir(root):
        print("gate: no references captured yet (%s absent) -- the %s leg cannot run" % (_rel(LEG_REFS_DIR), tag))
        return REFUSE_NO_REFS
    if not os.path.isdir(run_dir):
        print("gate: nothing to score: %s is not a directory" % run_dir)
        return 4
    drifts = leg_pin_drifts(root)
    if drifts:
        print("gate: %s REFUSED -- references off their pins: %s" % (tag, "; ".join(drifts)))
        return 7
    passed, parts = 0, []
    for ref, stage, step in LEG_STAMPS:
        cap = stamp_capture(run_dir, stage, step)
        if cap is None:
            print("%s %s MISSING (no s%02d capture in %s/)" % (tag, ref, step, stage))
            parts.append("%s=missing" % ref)
            continue
        s = _score_value(os.path.join(root, ref + ".png"), cap)
        # TITLE_MIN_SCORE measured 2026-09-26 against 36 archived green stamps at the R280 steps: 35/35 at >= 90 (the bar); the lowest pairwise score 95.3 (transition s06, mission s06).
        ok = s >= TITLE_MIN_SCORE
        passed += ok
        print("%s %s %s %.1f (%s/%s)" % (tag, ref, "PASS" if ok else "FAIL", s, stage, os.path.basename(cap)))
        parts.append("%s=%.1f" % (ref, s))
    total = len(LEG_STAMPS)
    line = "%s %d/%d %s (>= %.1f: %s)" % (tag, passed, total, "PASS" if passed == total else "FAIL",
                                          TITLE_MIN_SCORE, " ".join(parts))
    summary = os.path.join(run_dir, "summary.txt")
    try:
        with open(summary, encoding="utf-8") as f:
            kept = [l for l in f.read().splitlines() if not l.startswith(tag + " ")]
    except OSError:
        kept = []
    with open(summary, "w", encoding="utf-8") as f:
        f.write("".join(l + "\n" for l in kept + [line]))
    print(line)
    return 0 if passed == total else 1


def exe_line(env=None):
    """Which runner this gate scores: path, size, SHA-256. Sprint 9 Goal 2 gates the release build through
    $SOCOM_EXE (hostplatform.runtime_exe), and a record that does not say which binary it ran proves nothing."""
    path = hostplatform.runtime_exe(env=env)
    full = path if os.path.isabs(path) else os.path.join(hostplatform.ROOT, path)
    try:
        digest = hashlib.sha256()
        with open(full, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        return "EXE %s bytes=%d sha256=%s" % (path, os.path.getsize(full), digest.hexdigest())
    except OSError as e:
        return "EXE %s UNREADABLE (%s)" % (path, e.strerror or e)


# Sprint 14 E4 -- the structure review's F3, "stale greens: a gate run that predates the last edit". The gate
# launches whatever exe is on disk and `./build.sh test` does not rebuild it, so a PASS could be the verdict on a
# binary built before the change it is quoted for. A launch refuses (REFUSE_STALE) when the exe is older than the
# newest file it is built from; `--stale-ok` proceeds and says so on the console and in summary.txt. The merged-chain
# template (Sprint 14 W2) never passes --stale-ok: a chain's gate measures the exe the chain just built, or nothing.
# 5, not 3: 3 is the disk refusal here and in run_detached.sh, 4 a --baseline with nothing to score, 7 a pin
# drift, 8 an unknown revision -- a caller reading the code must be able to tell "rebuild" from all of them.
REFUSE_STALE = 5
# What a rebuild depends on, repo-relative (E4 review 1). Every revision's exe is ps2EntryRunner linked from
# ps2_runtime, which links ps2_iop (ps2xIOP), ps2x_shared (ps2xShared) and ps2x_snd989 (whose three sources are
# ps2xRuntime/src/lib) -- ps2xRuntime/CMakeLists.txt, the target_link_libraries of ps2_runtime; the CMake files that
# decide what is compiled (the top level's add_subdirectory set and each library's, ps2xRuntime/cmake's modules);
# the recompiler's own sources (ps2xRecomp: a recompiler change means the generated code should be regenerated;
# build.sh's recomp step rebuilds it first); build.sh itself, and the two tools its recomp step runs before
# ps2_recomp (make_overlay_elf.py, fix_ghidra_csv.py, which reads merge_ranges.txt beside the extra-functions list).
# Not ps2xLauncher, ps2xAnalyzer or ps2xTest: the exe links none of them. Not the hand name proposals or the name
# holds: apply_names.py and bindiff_lever.py read those, the build does not.
FRESHNESS_COMMON = (
    "third_party/ps2recomp/CMakeLists.txt",
    "third_party/ps2recomp/ps2xRuntime/CMakeLists.txt", "third_party/ps2recomp/ps2xRuntime/src",
    "third_party/ps2recomp/ps2xRuntime/include", "third_party/ps2recomp/ps2xRuntime/cmake",
    "third_party/ps2recomp/ps2xIOP/CMakeLists.txt", "third_party/ps2recomp/ps2xIOP/src",
    "third_party/ps2recomp/ps2xIOP/include",
    "third_party/ps2recomp/ps2xShared/CMakeLists.txt", "third_party/ps2recomp/ps2xShared/src",
    "third_party/ps2recomp/ps2xShared/include",
    "third_party/ps2recomp/ps2xRecomp/CMakeLists.txt", "third_party/ps2recomp/ps2xRecomp/src",
    "third_party/ps2recomp/ps2xRecomp/include",
    "build.sh", "tools_py/fix_ghidra_csv.py", "tools_py/make_overlay_elf.py",
    "recomp/loader_text_end.txt", "recomp/merge_ranges.txt",
)
# ... and per revision, only that revision's inputs: `./build.sh recomp` for r0001 (recomp/output, git-ignored,
# is the code the runtime compiles; the overlay ELF under game/ is what ps2_recomp reads, never tracked, its mtime
# only is read); scripts/build_revision.sh for r0004 (recomp/output_r0004, build_revision.sh:141; its tracked toml
# is DERIVED from recomp/socom2.toml by revision_toml.py and rewritten on every run, so socom2.toml counts for r0004
# too). Per revision, so that build_revision.sh r0004 rewriting socom2_r0004.toml never refuses an r0001 gate.
FRESHNESS_BY_REVISION = {
    "r0001": ("recomp/output", "recomp/socom2.toml", "recomp/socom2_ghidra.csv", "recomp/socom2_names.csv",
              "recomp/extra_functions.txt", "game/overlays/socom2_game.elf"),
    "r0004": ("recomp/output_r0004", "recomp/socom2.toml", "recomp/socom2_r0004.toml",
              "recomp/socom2_ghidra_r0004.csv", "recomp/socom2_names_r0004.csv", "recomp/extra_functions_r0004.txt",
              "scripts/build_revision.sh", "tools_py/revision_toml.py", "tools_py/overlay_repair.py",
              "tools_py/disc_to_elf.py", "tools_py/decrypt_apache.py", "game/overlays_r0004/socom2_game_r0004.elf"),
}
EXE_REVISION_RE = re.compile(r"(?:^|[-_])(r\d{4})$")


def freshness_roots(root=ROOT, revision="r0001"):
    """The directories and files an exe of `revision` is rebuilt from, under `root` (FRESHNESS_COMMON and that
    revision's FRESHNESS_BY_REVISION row)."""
    rel = FRESHNESS_COMMON + FRESHNESS_BY_REVISION.get(revision, FRESHNESS_BY_REVISION["r0001"])
    return [os.path.join(root, *r.split("/")) for r in rel]


def exe_revision(exe_path):
    """Which revision an exe was built for, from its own path: build_revision.sh writes dist/socom2_<rev>.exe, and a
    runner launched through $SOCOM_EXE must be called socom2[.exe] (hostplatform.runtime_exe), so it sits in a
    folder named for it (dist-r0004/socom2.exe). Neither says a revision: r0001, `./build.sh runtime`'s.
    (A launch has no --revision: that flag is --baseline's, and the image's banner says which game it RUNS, not
    which generated code the exe was built from.)"""
    p = exe_path.replace("\\", "/").rstrip("/").split("/")
    stem = os.path.splitext(p[-1])[0]
    for name in (stem, p[-2] if len(p) > 1 else ""):
        m = EXE_REVISION_RE.search(name)
        if m and m.group(1) in FRESHNESS_BY_REVISION:
            return m.group(1)
    return "r0001"


def exe_tree(exe_path, default=ROOT):
    """The checkout an exe was built in: the nearest directory above it holding build.sh -- so a gate run from the
    main tree against a worktree's exe ($SOCOM_EXE) compares it with that worktree's sources, not this one's. No
    such directory: `default`."""
    d = os.path.dirname(os.path.abspath(exe_path))
    while True:
        if os.path.isfile(os.path.join(d, "build.sh")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return default
        d = parent


def freshness(exe_path, source_roots):
    """(stale, newest_path, newest_mtime): is `exe_path` older than the newest file under `source_roots` (each a
    directory, walked, or a file; a missing one is skipped). Pure: no printing, no globals. A missing exe is not
    stale -- the EXE line already records it UNREADABLE and the drive fails on it; this is not that refusal."""
    newest_path, newest_mtime = None, None
    for src in source_roots:
        if os.path.isfile(src):
            candidates = [src]
        else:
            candidates = (os.path.join(d, n) for d, _, names in os.walk(src) for n in names)
        for p in candidates:
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            if newest_mtime is None or m > newest_mtime:
                newest_path, newest_mtime = p, m
    try:
        exe_mtime = os.path.getmtime(exe_path)
    except OSError:
        return False, newest_path, newest_mtime
    return newest_mtime is not None and exe_mtime < newest_mtime, newest_path, newest_mtime


def _stamp_time(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t))


def stale_message(exe_mtime, newest_path, newest_mtime, root=ROOT):
    try:
        rel = os.path.relpath(newest_path, root) if os.path.isabs(newest_path) else newest_path
    except ValueError:          # another drive on Windows
        rel = newest_path
    if rel.startswith(".."):
        rel = newest_path
    return "gate: exe older than source (%s < %s %s): rebuild, or --stale-ok" % (
        _stamp_time(exe_mtime), _rel(rel), _stamp_time(newest_mtime))


def exe_staleness(env=None):
    """The call site's half: the launch's exe (hostplatform.runtime_exe, $SOCOM_EXE honoured) against its own
    checkout's (exe_tree) sources for its own revision (exe_revision). None when fresh, else the refusal line."""
    path = hostplatform.runtime_exe(env=env)
    full = path if os.path.isabs(path) else os.path.join(hostplatform.ROOT, path)
    root = exe_tree(full)
    stale, newest, newest_mtime = freshness(full, freshness_roots(root, exe_revision(full)))
    if not stale:
        return None
    return stale_message(os.path.getmtime(full), newest, newest_mtime, root)


TREE_EXCLUDED = ("logs/", "game/")


def dirty_count(porcelain):
    """The lines of a `git status --porcelain` output whose path is outside logs/ and game/ (a rename counts by
    its destination)."""
    n = 0
    for line in porcelain.splitlines():
        if len(line) < 4:
            continue
        path = line[3:].split(" -> ")[-1].strip().strip('"')
        if not path.startswith(TREE_EXCLUDED):
            n += 1
    return n


def tree_line(root=ROOT):
    """`TREE <head> dirty=<n>`: which tree this gate measured -- `git rev-parse --short HEAD` and the count of
    `git status --porcelain` lines outside logs/ and game/ (Sprint 14 E4). `TREE unknown (<why>)` off a
    repository."""
    try:
        head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=root, capture_output=True, text=True,
                              check=True).stdout.strip()
        status = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True, text=True,
                                check=True).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        why = (getattr(e, "stderr", None) or str(e)).strip().splitlines()
        return "TREE unknown (%s)" % (why[0] if why else "git failed")
    return "TREE %s dirty=%d" % (head, dirty_count(status))


def elf_line(env=None):
    """Which GAME IMAGE this gate ran, and which revision it names: path, size, SHA-256, banner revision.
    The EXE line says which recompiled runtime was launched; it does not say which pressing of the game
    that runtime loaded, and since Task 19 those are two independent choices ($SOCOM_EXE and
    $SOCOM_GAME_ELF). A 3/3 record that does not name the image proves nothing about the revision."""
    env = os.environ if env is None else env
    path = env.get(guest_addresses.GAME_ELF_ENV) or guest_addresses.DEFAULT_GAME_ELF
    full = path if os.path.isabs(path) else os.path.join(ROOT, path)
    try:
        digest = hashlib.sha256()
        with open(full, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        try:
            revision = guest_addresses.revision_of_image(full)
        except ValueError as e:
            revision = "NO BANNER (%s)" % e
        return "ELF %s bytes=%d sha256=%s %s" % (_rel(path), os.path.getsize(full), digest.hexdigest(), revision)
    except OSError as e:
        return "ELF %s UNREADABLE (%s)" % (_rel(path), e.strerror or e)


# Sprint 10 Q1b -- what a score is computed against, beyond the EXE. Each stage reads its drive script, the
# references that script names (untilref/ifref, resolved the way drive.py resolves them) and the files its
# scorer and its drive-side checks read:
#   title       score_title against TITLE_REF (the same file the script's untilref names)
#   transition  score_transition/score_fade against BRIEFING_REF; black_rows is code (the harness pin)
#   mission     drive's ifpopup reads sp_death_probe.PROMPT_REF; score_mission_log reads console_compare's
#               CONSOLE_REF (print-only, R78, but on every summary), mission_fail's BANNER_REF, and
#               GUEST_PROBE_CONSOLE (the probe's tolerances AND the source of PS2X_PEEK)
# ref_hud_ours.png is named by the mission script (untilref), so it arrives through script_refs.
STAGE_INPUTS = {
    "title": [TITLE_REF],
    "transition": [BRIEFING_REF],
    "mission": [sp_death_probe.PROMPT_REF, console_compare.CONSOLE_REF, mission_fail.BANNER_REF, GUEST_PROBE_CONSOLE],
}
HARNESS_TREES = ("tools_py/parity", "scripts/parity")
SCRIPT_REF_RE = re.compile(r"^(?:untilref|ifref)\(\s*([^,)]+)")


def _rel(path):
    return path.replace("\\", "/")


def script_refs(script_path):
    """The reference images a drive.py step script reads, repo-relative with forward slashes, in script order,
    each resolved through drive.ref_for_target("ours") so a `<stem>.ours.png` sibling -- the file the drive
    would actually read if one appeared -- is what gets pinned, under its own name."""
    out = []
    with open(script_path, encoding="utf-8") as f:
        text = f.read()
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        m = SCRIPT_REF_RE.match(line)
        if m:
            rel = _rel(drive.ref_for_target(m.group(1).strip(), "ours", root=ROOT))
            if rel not in out:
                out.append(rel)
    return out


def pinned_files():
    """Every file the three stages read, in stage order, deduplicated: the drive script, the references it
    names, then STAGE_INPUTS. This is the exact set; a change to any of them moves a score."""
    out = []
    for name, cfg in GATES.items():
        for rel in [cfg["script"]] + script_refs(os.path.join(ROOT, cfg["script"])) + [_rel(p) for p in STAGE_INPUTS[name]]:
            if rel not in out:
                out.append(rel)
    return out


def collect_pins(base=None, game_logs=()):
    """Every pinned input of a gate launched from environment `base` (default os.environ), as
    `OrderedDict(name -> pins.Pin)`: the files (pinned_files), the card the launch boots from, the PS2X_*
    environment the mission stage (the widest) gets, the harness (record only), and the mapping hash read
    from `game_logs` (absent until Q3b's runtime prints it)."""
    out = OrderedDict()
    for rel in pinned_files():
        out[rel] = pins.file_pin(rel, os.path.join(ROOT, rel))
    src = card_source(base)
    out["card"] = pins.tree_pin("card", src if os.path.isabs(src) else os.path.join(ROOT, src), label=_rel(src))
    out["env"] = pins.env_pin(launch_env("mission", "<the stamp's copy of the card>", base=base,
                                         default_ok=True))
    out["harness"] = pins.harness_pin(ROOT, HARNESS_TREES, exclude=_pins_files())
    out["mapping"] = pins.mapping_pin(game_logs)
    return out


# Exit 8: the gate cannot say which revision it is about to run (or re-score), so it cannot say which
# addresses its probes read or which pin standard to compare against. Distinct from the disk refusal (3),
# the busy lock (2) and a drifted pin (7) -- and a refusal line rather than the traceback launch_env's
# ValueError used to produce out of collect_pins, i.e. out of EVERY lane including title (review F9).
REFUSE_REVISION = 8


def gate_revision(base=None, default_ok=False):
    """Which revision a launch from this environment would run, for the pin standard and the probe column.
    `default_ok` is guest_addresses.launch_revision's one relaxation, asked for by name (review F3):
    collect_pins takes it (a bare clone has no image and no launch to make), a launch does not."""
    return guest_addresses.launch_revision(os.environ if base is None else base, default_ok=default_ok)


def expected_pins_rel(revision):
    """The committed pin standard for a revision.

    r0001's is pins.EXPECTED -- scripts/parity/pins.json, byte for byte the file it has always been --
    and every other revision gets its own beside it. PS2X_PEEK is part of the `env` pin and is now
    revision-dependent, so with ONE standard an r0004 gate necessarily drifts, and the --accept-pins that
    lets it run REWRITES THE r0001 STANDARD. That is not a hazard in the abstract: on 2026-09-24 at 10:25
    an unattended `gate --accept-pins --stamp s11_r0004_reg3` replaced this file's r0001 env pin with the
    r0004 spec and dropped the mapping pin, exactly as review F2 predicted it would. Two files, and
    neither revision's gate can reach the other's (docs/HAZARDS.md harness, the accept-pins hazard, closed)."""
    if revision == "r0001":
        return pins.EXPECTED
    stem, ext = os.path.splitext(pins.EXPECTED)
    return "%s_%s%s" % (stem, revision, ext)


def expected_pins_path(revision):
    rel = expected_pins_rel(revision)
    return rel if os.path.isabs(rel) else os.path.join(ROOT, rel)


# Every revision's standard lives under scripts/parity, which is a HARNESS_TREES member: a new
# pins_r0004.json must not move the harness hash of an r0001 run, and vice versa.
def _pins_files():
    return tuple(_rel(expected_pins_rel(r)) for r in guest_addresses.REVISIONS)


STAMP_PEEK_RE = re.compile(r"PS2X_PEEK=(\S+)")


def stamp_revision(out_root):
    """(revision, how) -- which address column an ARCHIVED run's [peek] rows are in, read from the stamp's
    OWN record, never from whatever image game/disc holds today (review F1).

    1. The PS2X_PEEK the run was launched with -- its pins.json record's `detail.env`, else the `PIN env`
       line in summary.txt. The chains ARE the addresses in the rows, so this is the strongest evidence
       there is, and every stamp on disk carries it, including the eight from before the runtime printed
       a revision line at all (s10_close_gate, s11_open_gate and six more).
    2. Else what the runtime said it installed, off the stage's own game log.

    Neither: raise. A re-score that cannot establish the column does not fall back to r0001."""
    record = pins.load_record(os.path.join(out_root, pins.RECORD_NAME)) or {}
    texts = []
    env = record["env"].detail if "env" in record else None
    if env:
        texts.extend(env if isinstance(env, list) else [env])
    summary = os.path.join(out_root, "summary.txt")
    if os.path.isfile(summary):
        with open(summary, encoding="utf-8", errors="replace") as f:
            texts.extend(f.readlines())
    for text in texts:
        m = STAMP_PEEK_RE.search(text)
        if m:
            try:
                return guest_addresses.revision_of_peek_spec(m.group(1)), "the stamp's own PS2X_PEEK"
            except ValueError:
                pass
    for name in ("mission", "title", "transition"):
        log = os.path.join(out_root, name + ".game.log")
        if os.path.isfile(log):
            with open(log, "r", errors="replace") as f:
                try:
                    rev, how = guest_addresses.log_revision(f.readlines())
                    return rev, "%s.game.log (%s)" % (name, how)
                except ValueError:
                    pass
    raise ValueError("gate: %s does not say which address column its rows are in (no PS2X_PEEK in its "
                     "pins.json or summary.txt, and no revision line in its game logs) -- it cannot be "
                     "re-scored without one" % out_root)


def pins_verdict(drifts, accepted, compared, revision="r0001", when=""):
    """(word, line): the PINS line of a summary -- MATCH, ACCEPTED (the standard was rewritten) or DRIFTED
    (refused) -- and its one-word form for the record. The line names the revision's OWN standard, so a
    summary says which file it was measured against; `when` (a launch's " after the run") says when an
    accepted standard was written."""
    standard = expected_pins_rel(revision)
    names = ", ".join(d.name for d in drifts)
    if not drifts:
        return "MATCH", "PINS MATCH %s (%d compared)" % (standard, compared)
    if accepted:
        return "ACCEPTED", "PINS ACCEPTED: %s -> %s rewritten%s" % (names, standard, when)
    return "DRIFTED", ("PINS DRIFTED: %s -- refused to score (pass --accept-pins to make the measured values the "
                       "standard in %s, or restore the input)" % (names, standard))


def accepted_standard(current, path):
    """What an --accept-pins write puts in `path`: every pin `current` MEASURED, and, for a pin `current`
    carries but could not measure (sha256 None -- `mapping` before a stage has run and the runtime has
    printed its line), the value the standard already holds.

    Carry rather than "one write, at the end", because a pin can be unmeasurable at EVERY moment a given
    path could write: `gate --pins --accept-pins` never launches, so its `mapping` is absent whenever it
    writes. Only a write that starts from the previous standard cannot drop a pin.

    It has already dropped one. On 2026-09-25 at 01:32 the r0004 rebuild (stamp s11_r0004_rebuild1)
    drifted on `env` alone: the write before the launch rebuilt the standard out of the measured set,
    where `mapping` was still absent, and the write after the run only fires when `mapping` itself
    drifted -- which it had not. scripts/parity/pins_r0004.json lost its mapping pin while the very
    summary of that run printed `PIN mapping sha256=c393b87b99732a1f ok`, and the next gate on that
    revision was REFUSED (exit 7) for an unpinned input. A standard that silently loses a pin is the
    failure this mechanism exists to make impossible (pins.py's opening note).

    Carrying is not hoarding: a name the tree no longer pins at all is not in `current`, so it is still
    dropped -- that is what --accept-pins is for. Only a name the run carries and cannot measure is kept."""
    held, detail = {}, {}
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        held = dict(doc.get("pins", {}) or {})
        detail = dict(doc.get("detail", {}) or {})
    except (OSError, ValueError):
        pass                    # no standard yet (or an unreadable one): there is nothing to carry
    out = OrderedDict()
    for name, p in current.items():
        if p.sha256 is None and held.get(name):
            out[name] = pins.Pin(name, held[name], detail.get(name, p.detail))
        else:
            out[name] = p
    return out


def check_pins(current, accept=False, note="", revision="r0001"):
    """(drifts, expected, accepted) for `current` against THIS REVISION's committed standard; with
    `accept`, a drift rewrites that standard from `current` -- carrying forward any pin `current` cannot
    measure yet (accepted_standard) -- and is reported as accepted rather than refused. An r0004 gate
    reads and writes scripts/parity/pins_r0004.json and can no more reach r0001's file than an r0001 gate
    can reach its (review F2)."""
    path = expected_pins_path(revision)
    expected = pins.load_expected(path) or {}
    drifts = pins.compare(current, expected)
    accepted = bool(drifts) and accept
    if accepted:
        pins.write_expected(accepted_standard(current, path), path, note=note)
    return drifts, expected, accepted


def baseline_pins(out_root, revision="r0001"):
    """The pin checks of a --baseline re-score, printed; None when it may proceed, else the exit code.
    Two questions: was the run made under the standard (its recorded pins.json, every pin it recorded --
    a stamp from before Q1b has none and is scored with a line saying so), and is the standard what is on
    disk now (today's pinned FILES: the re-score reads today's reference images; today's card and shell
    boot nothing and are not asked)."""
    expected = pins.load_expected(expected_pins_path(revision)) or {}
    record = pins.load_record(os.path.join(out_root, pins.RECORD_NAME))
    if record is None:
        print("PINS unrecorded (no %s in the stamp: a run from before Q1b)" % pins.RECORD_NAME)
    else:
        drifts = pins.compare(record, expected)
        for line in pins.lines(record, drifts, expected=expected):
            print(line)
        if drifts:
            print("PINS DRIFTED (recorded): %s" % ", ".join(d.name for d in drifts))
            print("GATE REFUSED (recorded pins drifted: %s) [baseline %s]" % (", ".join(d.name for d in drifts), out_root))
            return 7
    files = pinned_files()
    current = OrderedDict((n, p) for n, p in collect_pins(base={}).items() if n in files)
    # (files only: the re-score reads today's reference images, but today's card and shell boot nothing)
    drifts = pins.compare(current, {n: s for n, s in expected.items() if n in files})
    if drifts:
        for line in pins.lines(current, drifts, expected=expected):
            if "DRIFTED" in line:
                print(line)
        print("GATE REFUSED (pins drifted: %s) [baseline %s]" % (", ".join(d.name for d in drifts), out_root))
        return 7
    print("PINS MATCH %s (%d recorded, %d files on disk)"
          % (expected_pins_rel(revision), len(record or {}), len(current)))
    return None


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="title,transition,mission")
    ap.add_argument("--owner", default="gate")
    ap.add_argument("--stamp", default=time.strftime("%Y%m%d_%H%M%S"))
    ap.add_argument("--score-title")
    ap.add_argument("--score-mission")
    ap.add_argument("--mission-frames", help="capture dir for --score-mission (default: <log minus .drive.log>)")
    ap.add_argument("--baseline", help="re-score a saved stamp (a logs/parity/gate/<stamp> name or a path) without "
                                       "launching: every stage it holds, through the live gate's scorers; writes nothing")
    ap.add_argument("--revision", choices=sorted(guest_addresses.REVISIONS),
                    help="with --baseline: the address column the stamp's [peek] rows are in, when the stamp "
                         "itself does not say (it normally does -- its recorded PS2X_PEEK names it)")
    ap.add_argument("--pins", action="store_true",
                    help="compare the tree's pinned inputs to this revision's standard (%s for r0001) and exit "
                         "(0 match, 7 drifted); no launch, no lock" % pins.EXPECTED)
    ap.add_argument("--accept-pins", action="store_true",
                    help="a launch (or --pins) whose pins drifted rewrites the standard from the measured values "
                         "instead of refusing -- a launch writes it once, after a run whose every stage PASSed "
                         "(S13-R5), never before the lock; the summary says so. It rewrites THIS REVISION's file "
                         "only -- an r0004 gate cannot reach %s" % pins.EXPECTED)
    ap.add_argument("--stale-ok", action="store_true",
                    help="launch an exe older than its sources (its own checkout's runtime, IOP, shared and "
                         "recompiler sources, CMake files and build.sh, and its revision's generated code and "
                         "recompiler inputs) instead of refusing with exit %d; the summary says so. The "
                         "merged-chain template never passes it" % REFUSE_STALE)
    ap.add_argument("--leg", nargs=2, metavar=("LEG", "RUN_DIR"),
                    help="score a finished gate stamp's leg %s against its frozen references; no launch, no lock"
                         % "/".join(LEGS))
    ap.add_argument("--capture-" + LEGS[0], metavar="RUN_DIR", dest="capture_leg",
                    help="freeze a green 3/3 stamp's twelve step captures as the leg's references (once)")
    args = ap.parse_args(argv)

    # The fourth leg reads two directories and writes a summary line: exempt from the disk refusal, the freshness
    # check, the pins and the lock, like the re-scores below.
    if args.leg or args.capture_leg:
        if args.accept_pins or args.baseline or args.revision:
            ap.error("--leg and --capture-%s take no other flag" % LEGS[0])
        if args.capture_leg:
            return capture_leg(args.capture_leg)
        if args.leg[0] not in LEGS:
            ap.error("--leg: unknown leg %r" % args.leg[0])
        return score_leg(args.leg[1])

    if args.baseline:
        if args.accept_pins:
            ap.error("--accept-pins is a launch flag: a --baseline re-score compares the record, it does not set the standard")
        return score_baseline(args.baseline, args.revision)
    if args.revision:
        ap.error("--revision is a --baseline flag: a launch reads its revision from the image it launches")

    if args.pins:
        try:
            # A dry check launches nothing, so it is allowed the bare-clone default -- CI runs it with no
            # disc assets at all.
            revision = gate_revision(default_ok=True)
            current = collect_pins()
        except ValueError as e:
            print("gate: %s" % e)
            return REFUSE_REVISION
        print("REVISION %s (standard %s)" % (revision, expected_pins_rel(revision)))
        drifts, expected, accepted = check_pins(current, args.accept_pins, note="gate --pins --accept-pins",
                                                revision=revision)
        for line in pins.lines(current, drifts, accepted, expected):
            print(line)
        print(pins_verdict(drifts, accepted, len(pins.comparable(current)), revision)[1])
        return 7 if drifts and not accepted else 0

    # --score-title/--score-mission re-score an existing run: no game launch, nothing large written
    # -- exempt from the disk refusal (review round 1 item 3, 2026-09-13), and checked first so
    # free_gb() is never even called on this path.
    if args.score_title:
        ok, detail = score_title(args.score_title)
        print("%s title (%s)" % ("PASS" if ok else "FAIL", detail))
        return 0 if ok else 1
    if args.score_mission:
        ok, detail = score_mission_log(args.score_mission, args.mission_frames)
        print("%s mission (%s)" % ("PASS" if ok else "FAIL", detail))
        return 0 if ok else 1

    min_free = float(os.environ.get("RUN_MIN_FREE_GB", DEFAULT_MIN_FREE_GB))
    free = free_gb()
    if free < min_free:
        print("gate: refusing to start: %.2f GB free on %s < RUN_MIN_FREE_GB=%.2f GB"
              % (free, hostplatform.free_space_path(), min_free))
        return 3

    # Sprint 14 E4: an exe older than its sources is refused before anything is written or locked (the chain
    # template never passes --stale-ok; see REFUSE_STALE).
    stale_lines = []
    stale = exe_staleness()
    if stale is not None:
        print(stale, flush=True)
        if not args.stale_ok:
            return REFUSE_STALE
        stale_lines = [stale, "gate: STALE exe accepted (--stale-ok)"]
        print(stale_lines[-1], flush=True)

    # Make the output root before taking the lock: a makedirs failure must not leak the lock.
    out_root = os.path.join("logs", "parity", "gate", args.stamp)
    os.makedirs(out_root, exist_ok=True)
    exe = exe_line()
    print(exe, flush=True)
    elf = elf_line()
    print(elf, flush=True)
    tree = tree_line()
    print(tree, flush=True)
    # Which revision is this? It decides the probes' address column AND which pin standard is the
    # standard. A launch does not get the bare-clone default: it has an image, and if it cannot be read
    # the gate refuses with its own line rather than a traceback out of collect_pins (review F3, F9).
    try:
        revision = gate_revision(default_ok=False)
    except ValueError as e:
        print("gate: %s" % e)
        return REFUSE_REVISION
    print("REVISION %s (probe addresses and pin standard %s)" % (revision, expected_pins_rel(revision)), flush=True)
    # The pins are checked BEFORE the lock and the launch: a drifted standard refuses without spending a
    # run. The record (pins.json) and the summary are written either way, so the refusal is on file.
    # They are only CHECKED here: with --accept-pins the standard is written once, after the run, when
    # every pin (the late `mapping` too) has been measured -- never before the lock wait, where a gate
    # queued and then cancelled used to rewrite it anyway (issue #45: s11_r0004_node1, s11_r0004_rebuild1).
    current = collect_pins()
    drifts, expected, _ = check_pins(current, False, revision=revision)
    # `pending`: a drift --accept-pins will accept IF the run completes; `accepted`: it has been written.
    pending = bool(drifts) and args.accept_pins
    accepted = False
    compared = len(pins.comparable(current))

    def write_summary(stage_lines, all_drifts, frame_lines=(), info=None):
        """summary.txt (stage lines, the FRAME line, EXE, PIN lines, the informational PIN frame, PINS verdict)
        and pins.json; returns the PIN lines (the informational one last) and the verdict."""
        word, verdict = pins_verdict(all_drifts, accepted, compared, revision, when=" after the run")
        pin_lines = pins.lines(current, all_drifts, accepted, expected) + pins.informational_lines(info)
        with open(os.path.join(out_root, "summary.txt"), "w", encoding="utf-8") as f:
            f.write("".join(l + "\n" for l in stage_lines + list(frame_lines) + [exe, elf, tree] + stale_lines
                            + pin_lines + [verdict]))
        record = os.path.join(out_root, pins.RECORD_NAME)
        pins.write_record(current, record, all_drifts, accepted, word,
                          exe, expected_pins_rel(revision), informational=info)
        # The TREE line (and a --stale-ok acceptance) in the record too: pins.write_record's shape is pins.py's,
        # so the keys are added here rather than there.
        with open(record, encoding="utf-8") as f:
            doc = json.load(f)
        doc["tree"] = tree
        if stale_lines:
            doc["stale"] = stale_lines[0]
        with open(record, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)
            f.write("\n")
        return pin_lines, verdict

    if drifts and not pending:
        pin_lines, verdict = write_summary([], drifts)
        for line in pin_lines + [verdict]:
            print(line)
        print("GATE REFUSED (pins drifted: %s) -> %s" % (", ".join(d.name for d in drifts), out_root))
        return 7
    # Printed as they stand (DRIFTED), not as accepted: nothing is accepted until the run has completed,
    # and a lock refusal below must not follow lines that say otherwise.
    for line in pins.lines(current, drifts, False, expected):
        print(line, flush=True)
    if pending:
        print("PINS ACCEPT PENDING: %s -- %s is written after the run, and only if every stage PASSes"
              % (", ".join(d.name for d in drifts), expected_pins_rel(revision)), flush=True)
    take = _lock("take", args.owner)
    if take.returncode != 0:
        print("gate: lock busy: " + take.stdout.strip())
        if args.accept_pins:
            print("gate: nothing ran, nothing accepted -- %s standard unchanged" % expected_pins_rel(revision))
        return 2
    wanted = [g.strip() for g in args.only.split(",") if g.strip()]
    results = []
    rc = 1
    completed = False
    try:
        for name in wanted:
            ok, detail = run_gate(name, out_root)
            line = "%s %s (%s)" % ("PASS" if ok else "FAIL", name, detail)
            print(line, flush=True)
            results.append((ok, line))
        completed = True
    finally:
        # Release the lock and leave a summary even when a gate raises part-way through.
        _lock("release", args.owner)
        for name in wanted[len(results):]:
            results.append((False, "FAIL %s (gate did not run)" % name))
        failed = [line for ok, line in results if not ok]
        # Q3b's hook: the mapping hash is only known once a stage has run and the runtime has printed its
        # line into <stage>.game.log. It is compared against the standard like every other pin -- a value
        # the standard does not hold (the first run that prints one, or a changed table) refuses the score
        # unless --accept-pins -- and an absent line is recorded as absent, never refused.
        current["mapping"] = pins.mapping_pin([os.path.join(out_root, name + ".game.log") for name in wanted])
        late = [d for d in pins.compare(current, expected) if d.name == "mapping"]
        all_drifts = drifts + late
        if all_drifts and args.accept_pins and completed and not failed:
            # The one write of an accepted standard (issue #45): after the run, with every pin measured
            # that can be; accepted_standard still carries any the run could not (fccf3b5d). Only a run
            # whose every wanted stage reached a PASS may write it (S13-R5): a standard is the measured
            # input set of a run that passed. A stage that raised, or a Ctrl-C after the lock, is the
            # cancelled gate #45 names; a FAILed run says nothing about whether its inputs are right, and
            # accepting them would bake a broken input into the standard. Both leave it as they found it.
            path = expected_pins_path(revision)
            pins.write_expected(accepted_standard(current, path), path,
                                note="gate --accept-pins, stamp %s" % args.stamp)
            accepted = True
        elif all_drifts and args.accept_pins and not completed:
            print("PINS NOT ACCEPTED: the run did not complete (%d of %d stages reached a verdict) -- %s unchanged"
                  % (len([1 for _, l in results if "(gate did not run)" not in l]), len(wanted),
                     expected_pins_rel(revision)))
        elif all_drifts and args.accept_pins:
            print("PINS NOT ACCEPTED: %d of %d stages FAILed -- %s unchanged"
                  % (len(failed), len(results), expected_pins_rel(revision)))
        refused = bool(all_drifts) and not accepted
        # The mission's frame time (Sprint 13 V4): printed and recorded, never compared (S13-R3).
        frame_lines, info = [], None
        if "mission" in wanted:
            ft, why = frame_time.read_stamp(out_root)
            sv, sv_why = frame_time.read_syncv_stamp(out_root)
            frame_lines = [frame_time.line(ft, why), frame_time.syncv_line(sv, sv_why)]
            info = pins.frame_info(ft, why, syncv=sv)
        pin_lines, verdict = write_summary([line for _, line in results], all_drifts, frame_lines, info)
        for line in frame_lines:
            print(line)
        # the mapping line, now that the game logs exist, and the informational frame pin after it
        for line in pin_lines[-1 - len(pins.informational_lines(info)):]:
            print(line)
        print(verdict)
        if refused:
            print("GATE REFUSED (pins drifted: %s) -> %s" % (", ".join(d.name for d in all_drifts), out_root))
            rc = 7
        else:
            print("GATE %s (%d/%d) -> %s" % ("FAIL" if failed else "PASS",
                                             len(results) - len(failed), len(results), out_root))
            rc = 1 if failed else 0
    return rc


if __name__ == "__main__":
    sys.exit(main())
