#!/usr/bin/env python
"""Drive one side (PCSX2 or our exe) through the shared step script and capture each screen.

Script lines: `<mode>+<delay>:<BTN>[+<BTN>]` with mode `stable` (wait until the frame has been
stable for --settle seconds, at most --maxwait, then wait <delay>), `long` (as `stable` with a
150 s cap, for screens behind a slow cinematic), `next` (first wait for the screen to change
since the previous press, then as `stable`), `idle` (press only if the screen stays unchanged for
<delay> s), `until(x0,y0,x1,y1)` (press until that box is highlighted) or `wait` (just wait <delay>);
BTN `NONE` presses nothing. A screenshot `sNN_<btn>.png` is taken right before each press, and a
`wNN_<k>.png` every second of every wait within step NN (so a fade that never settles is still
captured); `manifest.json` records the step, wall time since launch, stability wait and whether the frame
was stable. Screens on both sides align by step index.

Usage: python -m tools_py.parity.drive --target pcsx2|ours --script <file> --out <dir>
"""
import argparse
import collections
import json
import os
import subprocess
import time

import numpy as np
from PIL import Image

from tools_py.parity import hostplatform, keys, screen_bands

# The host's capture primitive: winshot (Windows ctypes) or x11shot (Linux xdotool/import), Sprint 8
# Task 9. The name stays `winshot` so every call below -- and every test that patches
# drive.winshot.grab -- is unchanged.
winshot = hostplatform.shot_module()

# The repo's own image, kept under its old name because gsdump_capture / probe_poll / state_poll /
# online_match import it. Nothing in a LAUNCH reads it any more: the disc is resolved once, at the
# launch, by hostplatform.iso_path() (Sprint 8 Task 10 follow-up (a)) -- a module-level resolve
# would raise at import time on a machine with no disc, which is not the same thing as a run.
ISO = os.path.abspath(os.path.join("game", hostplatform.ISO_NAME))
PCSX2 = os.path.abspath("tools/pcsx2/pcsx2-qt.exe")


def cd_image_env(env, resolve=None):
    """Export the resolved disc image into the launched game's environment as PS2X_CD_IMAGE --
    on EVERY platform, and only when the caller has not set one already.

    The runtime honours PS2X_CD_IMAGE before its own scan (`configureCdImage`), so this replaces a
    guess with the path the harness actually resolved. On Windows it changes nothing today: the
    ELF is `game/disc/socom2_game.elf`, so the scan reads `game/disc/` (no image there) and then
    `game/`, which holds exactly the one file `iso_path()` returns. An operator's own
    PS2X_CD_IMAGE always wins -- that is the only way to drive a different image without moving
    files about, and a run that sets it must not need the repo's own disc to exist."""
    if env.get("PS2X_CD_IMAGE"):
        return env
    env["PS2X_CD_IMAGE"] = (resolve or hostplatform.iso_path)()
    return env


def launch(target, seconds):
    # Resolved before anything is started: no disc is a launch failure naming the three places it
    # looked, not a black boot (the VM's title stage, twice, with no image under game/).
    iso = hostplatform.iso_path()
    if target == "pcsx2":
        return subprocess.Popen([PCSX2, "-batch", "-nogui", "-fastboot", iso],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # The exe rewrites its current frame to this file; grab() reads it instead of PrintWindow.
    os.environ.setdefault("PS2X_HOST_SCREENSHOT_LATEST", os.path.abspath(os.path.join("logs", "parity", "latest_frame.png")))
    env = hostplatform.dev_env(cd_image_env(dict(os.environ, PS2X_SOCOM2_PAD="1")))
    if not hostplatform.is_windows():
        # Linux: press() injects through the runtime's latched pad file rather than X key events,
        # which the VM's ~3 fps poll drops (x11shot.press). The file must exist and be neutral
        # before the exe starts, and its path must be in BOTH environments -- the child's (it reads
        # it) and ours (press() looks it up there).
        from tools_py.parity import x11shot
        pad_file = env.get("PS2X_SOCOM2_INPUT_FILE") or os.path.abspath(os.path.join("logs", "pad_drive.txt"))
        os.makedirs(os.path.dirname(pad_file), exist_ok=True)
        x11shot.write_pad_state(pad_file)
        env["PS2X_SOCOM2_INPUT_FILE"] = pad_file
        os.environ["PS2X_SOCOM2_INPUT_FILE"] = pad_file
    if hostplatform.is_windows():
        return subprocess.Popen(["bash", "./run.sh", str(seconds)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Linux (Sprint 8 Task 10): run.sh is the Windows launcher -- it puts tools/llvm-mingw on PATH
    # and runs dist/socom2.exe, neither of which exists in the VM. Same contract, nothing else:
    # timeout <seconds> <runtime_exe> game/disc/socom2_game.elf, with the run log where gate.py
    # looks for it (logs/run_<stamp>.log, honouring PS2X_RUN_LOG, plus the logs/latest.log link).
    log = env.get("PS2X_RUN_LOG") or os.path.abspath(
        os.path.join("logs", "run_%s.log" % time.strftime("%Y%m%d_%H%M%S")))
    os.makedirs(os.path.dirname(log), exist_ok=True)
    latest = os.path.join("logs", "latest.log")
    try:
        if os.path.islink(latest) or os.path.exists(latest):
            os.remove(latest)
        os.symlink(log, latest)
    except OSError:
        pass
    handle = open(log, "wb")
    return subprocess.Popen(["timeout", str(seconds), os.path.abspath(hostplatform.runtime_exe()),
                             os.path.abspath(env.get("SOCOM_GAME_ELF") or os.path.join("game", "disc", "socom2_game.elf"))],
                            env=env, stdout=handle, stderr=subprocess.STDOUT)


# untilref's press budget was a COUNT: 12 presses, each followed by a fixed pause, both calibrated on
# the host, where the boot reaches the main menu in 23 s. The VM boots in 119 s at ~1.6 fps, and against
# that the count is marginal in both directions: paced slowly, all twelve presses are spent before the
# menu exists and the reference is never matched; paced quickly, the twelfth is still in flight when the
# menu finally arrives and it walks straight through into SELECT RANK / MISSION BRIEFING (s8_frz_D,
# s8_vm_title3). Off Windows the budget is WALL-CLOCK instead, and a press waits for the screen to hold
# still: a press is never repeated into a transition (the overshoot) and the budget does not run out
# because the boot was slow (the undershoot). Windows keeps the count and the literal sleep -- the
# Windows gate is the daily instrument and nothing about it moves here.
SLOW_HOST_PRESS_FACTOR = 12
SLOW_HOST_PRESS_POLL_S = 1.0
# Two consecutive captures closer than this on the 160x112 grey thumbnail are "the same screen" --
# wait_stable's own `thresh` default, so "stable" means here what it means everywhere else in the drive.
PRESS_STABLE_DIST = 1.0
# A settled screen that swallowed a press is asked again after this many per-press timeouts, and only
# this many times, before the loop goes quiet -- see paced_press_times.
IDLE_REPRESS_FACTOR = 3.0
IDLE_REPRESS_LIMIT = 1

PacedPresses = collections.namedtuple("PacedPresses", "press_times matched")


def press_pacing(env=None, system=None):
    """Which untilref budget this run uses: "fixed-count" (at most <loops> presses, each followed by
    the script's delay: today's Windows instrument, unchanged) or "paced" (the wall-clock budget
    below). Off Windows it is always paced; `SOCOM_DRIVE_SLOW_HOST=1` asks for paced on Windows too,
    which is how the tests exercise it on this host."""
    env = os.environ if env is None else env
    if env.get("SOCOM_DRIVE_SLOW_HOST") == "1":
        return "paced"
    return "fixed-count" if hostplatform.is_windows(system) else "paced"


def untilref_budget(seconds, tail, steps, index):
    """The wall seconds the untilref step at `index` may spend: the run's own length, less its tail
    and less every delay the later steps still need. The stage's `seconds` is already the slow-host
    figure (gate.stage_seconds multiplies it), so this is "the stage's seconds x factor" minus what
    the rest of the script is owed -- a boot that never reaches the reference still leaves the 22
    `wait+6.0` captures of the title script their time instead of eating the whole run."""
    return max(0.0, float(seconds) - float(tail) - sum(float(d) for _m, d, _b in steps[index + 1:]))


def ref_observations(sample, poll_s=SLOW_HOST_PRESS_POLL_S, now=time.time, sleep=time.sleep):
    """(t, distance to the PREVIOUS capture, distance to the REFERENCE) every `poll_s`, forever.

    `sample()` returns (thumbnail, distance-to-reference); a non-match reports `inf`, so a caller
    whose match test is more than a distance (untilref's `lit` band check) still yields one number.
    The first observation has no predecessor and reports `inf` -- never "stable"."""
    prev = None
    while True:
        cur, d_ref = sample()
        yield now(), (float("inf") if prev is None else float(np.abs(cur - prev).mean())), d_ref
        prev = cur
        sleep(poll_s)


def paced_press_times(observations, press, stable_dist=PRESS_STABLE_DIST, ref_dist=14.0,
                      per_press_timeout=12.0, wall_budget=300.0, idle_timeout=None,
                      idle_repress_limit=IDLE_REPRESS_LIMIT):
    """The paced press loop, as a pure function over observations -> PacedPresses(times, matched).

    A press is issued in exactly three situations, and the reference is checked before all of them:

    * **the screen settled on something new** -- this observation is within `stable_dist` of the one
      before it, and the screen has moved since the last press. One press per screen, issued as soon
      as it holds still: never into a transition (the overshoot), and never twice for one screen.
    * **the screen will not hold still** -- `per_press_timeout` since the last press with no settled
      observation at all: the intro movie, which is what a CROSS is for in the first place.
    * **the press was ignored** -- the screen settled, was pressed and has not moved in
      `idle_timeout` (3 x the per-press timeout). At most `idle_repress_limit` of these before the
      loop goes quiet and simply waits, because a settled screen that swallows a press is a guest
      that is LOADING and not polling its pad: the Linux runtime latches the press and hands it to
      the first poll of the NEXT screen. That is how s8_vm_title_paced1 pressed 15 times through a
      120 s boot and walked the main menu into SELECT RANK on the last of them. The boot reaches the
      menu by itself; the budget is there to be waited out, not spent.

    The loop ends on the reference, or when `wall_budget` seconds have passed since the first
    observation -- time, not a count, so a slow boot spends the budget rather than exhausting it.

    `press(t)` is the press callback; `observations` may be infinite (ref_observations is)."""
    if idle_timeout is None:
        idle_timeout = per_press_timeout * IDLE_REPRESS_FACTOR
    press_times = []
    t0 = None
    wait_since = None
    moved = True                 # nothing pressed yet: the screen owes us no transition
    idle_presses = 0
    for t, d_prev, d_ref in observations:
        if t0 is None:
            t0, wait_since = t, t
        if d_ref < ref_dist:
            return PacedPresses(press_times, True)
        if t - t0 >= wall_budget:
            return PacedPresses(press_times, False)
        stable = d_prev < stable_dist
        if not stable:
            moved, idle_presses = True, 0
        waited = t - wait_since
        if stable and moved:
            kind = "settled"
        elif not stable and waited >= per_press_timeout:
            kind = "moving"
        elif stable and idle_presses < idle_repress_limit and waited >= idle_timeout:
            kind = "idle"
        else:
            continue
        press(t)
        press_times.append(t)
        wait_since = t
        if kind == "settled":
            moved, idle_presses = False, 0
        elif kind == "idle":
            idle_presses += 1
    return PacedPresses(press_times, False)


def parse(text):
    steps = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        head, rest = line.split(":", 1)
        mode, delay = head.split("+", 1)
        buttons = [b.strip().upper() for b in rest.split("+") if b.strip() and b.strip().upper() != "NONE"]
        steps.append((mode, float(delay), buttons))
    return steps


def highlighted(hwnd, box):
    """True when the menu box (x0,y0,x1,y1 in the 640x448 frame) shows the selection tint: SOCOM II's
    briefing highlights an item in green-teal, which lifts G at least 25 above R (normal: <= 16)."""
    im = np.asarray(winshot.grab(hwnd).convert("RGB"), dtype=np.float32)
    x0, y0, x1, y1 = box
    reg = im[y0:y1, x0:x1]
    mean = reg.mean(axis=(0, 1))
    return float(mean[1] - mean[0]) > 25.0


def crop_to_content(im, thresh=8):
    """Crop a captured frame to its non-black content rect before thumbnailing. A window that is
    not exactly the game's 640x448 -- because something resized it -- pillarboxes or letterboxes
    the capture with black bars, which shifts every reference comparison and degrades the title
    score smoothly instead of failing it. Computes a per-row and per-column max over the greyscale
    frame and crops to the first/last index above `thresh`. An all-black frame has no index above
    threshold and is returned unchanged -- the transition gate scores black frames on purpose, and
    cropping one away would break it."""
    arr = np.asarray(im.convert("L"), dtype=np.float32)
    rows = np.where(arr.max(axis=1) > thresh)[0]
    cols = np.where(arr.max(axis=0) > thresh)[0]
    if rows.size == 0 or cols.size == 0:
        return im
    return im.crop((int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1))


def thumb(im):
    """The 160x112 grey thumbnail every reference comparison uses (content rect, see crop_to_content)."""
    return np.asarray(crop_to_content(im.convert("L")).resize((160, 112)), dtype=np.float32)


def frame(hwnd):
    return thumb(winshot.grab(hwnd))


def popup_present(im):
    """True when the uncropped 640x448 frame is gameplay carrying a HELP pop-up ("PRESS X TO CONTINUE").
    The prompt test is sp_death_probe.screen_state's (centred prompt line, any row in its range), which
    the death probe already uses to clear pop-ups before its own holds."""
    from tools_py.parity import sp_death_probe
    return bool(sp_death_probe.screen_state(np.asarray(im.convert("RGB")))[1])


def needs_cross(im):
    """(press, reason): is the uncropped frame something a gameplay hold must not be sent over, that CROSS
    dismisses? Two classes, both measured on gate runs: a HELP pop-up (s5_head_1x, s6_depth_m2: the game pauses
    behind a lit HUD) and the letterboxed "X TO ABORT" objective cinematic that starts a few seconds after the
    HUD first shows (s6_depth_m4: bands 0.33, four holds swallowed). A black frame (loading, transition) gets no
    press -- it is waited through."""
    from tools_py.parity import sp_death_probe
    rgb = np.asarray(im.convert("RGB"))
    gameplay, popup, band, dist = sp_death_probe.screen_state(rgb)
    if popup:
        return True, f"HELP pop-up (prompt distance {dist:.3f})"
    if not gameplay and float(rgb.mean()) > 8.0:
        return True, f"letterboxed cinematic (bands {band:.2f})"
    return False, ("black frame" if float(rgb.mean()) <= 8.0 else f"gameplay (bands {band:.2f})")



def ref_for_target(ref_path, target, root=None):
    """The reference a step script names, or its per-target sibling `<stem>.<target>.png` when one exists
    beside it (`ref_main_menu_ours.png` -> `ref_main_menu_ours.pcsx2.png` on the console). One script drives
    both targets; a band that separates the lit menu row (the mid row, 76..86 x 55..105) sits at ~10 between
    the two machines' renderings of the same screen and at ~0.5 within one, so the console needs its own frame
    (music round four, 2026-09-20: the same-row test read 9.9 across and 18.6+ to the next row).
    `root` resolves a relative `ref_path` for the existence test (gate.script_refs pins the file the drive
    would actually read, from the repo root rather than the working directory)."""
    stem, ext = os.path.splitext(ref_path)
    sibling = f"{stem}.{target}{ext}"
    probe = os.path.join(root, sibling) if root and not os.path.isabs(sibling) else sibling
    return sibling if target and os.path.exists(probe) else ref_path

def hud_match(im, ref_thumb, box, thresh, lit):
    """untilref's per-frame test -> (matched, distance, band_fraction or None).

    box = (r0, r1, c0, c1) on the 160x112 thumbnail. With `lit`, a match also needs the letterbox bands of
    the UNCROPPED frame lit (screen_bands.gameplay_band). Without it, the cropped thumbnail of the
    letterboxed intro cinematic (640x230 of picture stretched to 160x112) matched the HUD reference's
    bottom-right at distance 23-29 < 30 with 0 presses, and every mission gate run from 2026-09-12 14:33
    held its W/R1/L/S steps over the cinematic (R30)."""
    r0, r1, c0, c1 = box
    dist = float(np.abs(thumb(im)[r0:r1, c0:c1] - ref_thumb[r0:r1, c0:c1]).mean())
    band = None
    matched = dist < thresh
    if lit:
        ok, band = screen_bands.gameplay_band(im)
        matched = matched and ok
    return matched, dist, band


FRAME_W, FRAME_H = 640, 448   # the frame the game presents; the gate's detectors are boxes in it


def capture_step(hwnd, path, hold):
    """Save the step capture. A hold step asks for a frame file no older than 1 s: a runtime that stopped
    presenting leaves latest_frame.png stale while drive.py holds keys into nothing (s5_gatefix, mission4:
    36-43 exports after gameplay start). A stale frame prints STALE FRAME and the old frame is saved anyway
    -- the drive goes on; gate.score_mission_log's liveness check decides (R34)."""
    size = winshot.client_size(hwnd)
    # a 0x0 client area (minimised, momentarily hidden) says nothing about the exported frame the grab reads;
    # a non-zero area that is not the game's is a resized window, whose exported frame is scaled -- refuse that
    if size is not None and size != (0, 0) and size != (FRAME_W, FRAME_H):
        # s6_ladder10/11: a resized window made every fixed-box detector read garbage for whole runs
        raise winshot.ClientRectError(f"client area is {size[0]}x{size[1]}, not {FRAME_W}x{FRAME_H}, at "
                                      f"{os.path.basename(path)}")
    if hold:
        try:
            im = winshot.grab(hwnd, max_age=1.0)
        except winshot.StaleFrameError as e:
            print(f"STALE FRAME {os.path.basename(path)}: {e}", flush=True)
            im = winshot.grab(hwnd)
    else:
        im = winshot.grab(hwnd)
    im.save(path)


def wait_stable(hwnd, settle, maxwait, thresh=1.0, changed_from=None, change_thresh=0.3,
                on_frame=None):
    """Wait until the frame has been stable for `settle` s (at most `maxwait`). With `changed_from`
    (a reference frame), first wait until the frame differs from it, so a press is only issued on
    a *new* screen (a stable loading screen does not count). `on_frame(elapsed)`, when given, is
    called on every poll (every 0.25 s) with the seconds waited so far, so a caller can record
    what the screen is doing *during* the wait and not only once it settles."""
    t0 = time.time()
    prev = frame(hwnd)
    stable_since = None
    changed = changed_from is None
    while time.time() - t0 < maxwait:
        time.sleep(0.25)
        cur = frame(hwnd)
        if on_frame is not None:
            on_frame(time.time() - t0)
        if not changed:
            if float(np.abs(cur - changed_from).mean()) > change_thresh:
                changed = True
            prev = cur
            continue
        if float(np.abs(cur - prev).mean()) < thresh:
            stable_since = stable_since or time.time()
            if time.time() - stable_since >= settle:
                return True, time.time() - t0
        else:
            stable_since = None
        prev = cur
    return False, time.time() - t0


def wait_capturer(out_dir, hwnd, step, period=1.0):
    """Build an `on_frame` callback for wait_stable that saves a full-resolution capture every
    `period` seconds of the wait as `w<step>_<k>.png`.

    The per-step `s<step>_<btn>.png` captures are of the *settled* screen, so anything that only
    happens while a screen is still changing -- above all the ~1 s fade to black on the way into
    the briefing -- lived entirely inside a settle wait and was captured only when drive.py's
    burst step happened to overlap it (gate.py TRANSITION_MIN_FRAMES). These frames are picked up
    by black_rows.py; the title scorer globs `s[0-9][0-9]_*.png` and so ignores them, and they are
    not recorded in manifest.json (which stays one entry per step).

    Capturing must never take a run down: a failed grab is reported and the wait continues."""
    state = {"k": 0, "next": 0.0, "warned": False}

    def on_frame(elapsed):
        if elapsed < state["next"]:
            return
        try:
            winshot.grab(hwnd).save(os.path.join(out_dir, f"w{step:02d}_{state['k']:03d}.png"))
        except Exception as e:                                  # noqa: BLE001 - diagnostic only
            if not state["warned"]:
                state["warned"] = True
                print(f"w{step:02d}: wait capture failed ({e}); continuing", flush=True)
        else:
            state["k"] += 1
        state["next"] = elapsed + period

    return on_frame


def build_parser():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=("pcsx2", "ours"), required=True)
    ap.add_argument("--script", default="scripts/parity/launch_to_mission.txt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--settle", type=float, default=1.5)
    ap.add_argument("--maxwait", type=float, default=40.0)
    ap.add_argument("--seconds", type=int, default=400, help="our run length (run.sh)")
    ap.add_argument("--tail", type=float, default=8.0, help="seconds to keep capturing after the last step")
    ap.add_argument("--wait-period", type=float, default=1.0, dest="wait_period",
                    help="seconds between the w<step>_<k>.png captures of every settle wait (the gate's "
                         "transition stage uses 0.2 so the fade into the briefing yields enough frames)")
    return ap


def main():
    a = build_parser().parse_args()
    for base in ("socom2", "pcsx2-qt"):
        if hostplatform.process_running(base):
            raise SystemExit(f"{hostplatform.exe_name(base)} is already running; "
                             "refusing to start a second game instance")
    os.makedirs(a.out, exist_ok=True)
    steps = parse(open(a.script).read())
    proc = launch(a.target, a.seconds)
    t0 = time.time()
    # Every step line's t= is measured from this t0, which falls after the process checks and the launch -- 1.3-1.5 s
    # after a caller's own "drive started" stamp. The epoch lets an audio capture lay its WAV against the steps
    # (tools_py/parity/capture_offset.py, LATER row 37); no reader of this stdout takes it for a step.
    print(f"drive_t0_epoch={t0:.3f}", flush=True)
    hwnd = None
    while hwnd is None and time.time() - t0 < 60:
        hwnd = winshot.find_window(keys.WINDOW_TITLES[a.target])
        time.sleep(0.5)
    if hwnd is None:
        proc.terminate()
        raise SystemExit("game window not found")
    winshot.keep_on_top(hwnd)
    manifest = []
    # The window can be found while it is still being created (empty client area); wait it out.
    last = None
    while last is None and time.time() - t0 < 60:
        try:
            last = frame(hwnd)
        except RuntimeError:
            time.sleep(0.5)
            hwnd = winshot.find_window(keys.WINDOW_TITLES[a.target]) or hwnd
    if last is None:
        proc.terminate()
        raise SystemExit("game window never showed a client area")
    try:
        run_steps(a, steps, proc, hwnd, t0, last, manifest)
    finally:
        # Always take the game down, even when a step raises: a stray instance blocks every
        # later drive.py run ("already running"). Git Bash mangles "/F": call taskkill via cmd.
        proc.terminate()
        hostplatform.kill_process_by_name("pcsx2-qt" if a.target == "pcsx2" else "socom2")


def run_steps(a, steps, proc, hwnd, t0, last, manifest):
    # Whether the most recent `ifref` step matched its reference, i.e. whether the dialog it
    # guards was actually on screen and answered. `ifburst` reads it; nothing else does.
    ifref_matched = False
    for i, (mode, delay, buttons) in enumerate(steps):
        stable, waited = (True, 0.0)
        held = "none"
        # One counter per step, shared by every wait the step performs (the until*/ifref modes
        # wait more than once), so the w<step>_<k>.png names never collide.
        cap = wait_capturer(a.out, hwnd, i, period=getattr(a, "wait_period", 1.0))
        if mode == "stable":
            stable, waited = wait_stable(hwnd, a.settle, a.maxwait, on_frame=cap)
        elif mode == "long":
            # Like `stable` with a 150 s cap: for a screen reached only after a cinematic whose
            # length depends on the frame rate (our exe plays the location intro at a few fps).
            stable, waited = wait_stable(hwnd, a.settle, 150.0, on_frame=cap)
        elif mode == "next":
            stable, waited = wait_stable(hwnd, a.settle, a.maxwait, changed_from=last, on_frame=cap)
        elif mode.startswith("until("):
            # until(x0,y0,x1,y1)+<delay>:BTN — press BTN every <delay> s (at most 10 times) until the
            # box is highlighted; makes menu navigation independent of how many presses the boot
            # flow consumed (the briefing's typed text and the optional location cinematic vary).
            box = tuple(int(v) for v in mode[6:-1].split(","))
            presses = 0
            while not highlighted(hwnd, box) and presses < 10:
                # The briefing ignores DOWN while its text is typing: press only on a settled screen.
                wait_stable(hwnd, 2.0, 25.0, on_frame=cap)
                for b in buttons:
                    keys.press(hwnd, b, a.target)
                presses += 1
                time.sleep(delay)
            print(f"until{box}: {presses} presses, highlighted={highlighted(hwnd, box)}", flush=True)
            buttons = []
            delay = 0.5
        elif mode.startswith("untilref("):
            # untilref(<png>)+<delay>:BTN — press BTN on each settled screen (at most 12 times)
            # until the top band of the frame (rows 8..62 of the 160x112 thumbnail: the logo /
            # dialog title) matches the reference image; then hold. Makes "reach the main menu"
            # independent of how many boot screens this run happens to show.
            # untilref(<png>,<y0>,<y1>[,<loops>]) compares thumbnail rows y0..y1 instead (e.g. the
            # HUD band 88..112) and loops up to <loops> times (default 12).
            # Full form: untilref(<png>,<y0>,<y1>,<x0>,<x1>,<loops>,<thresh>) on the 160x112 thumbnail.
            # A trailing `lit` flag -- untilref(<png>,...,lit) -- also requires the letterbox bands of
            # the uncropped frame to be lit (hud_match): the in-game HUD, not the intro cinematic.
            # <loops> is the budget of the FIXED-COUNT pacing only (Windows); off Windows, and with
            # SOCOM_DRIVE_SLOW_HOST=1, the budget is wall-clock instead -- see press_pacing.
            parts = [v.strip() for v in mode[9:-1].split(",")]
            ref_path = ref_for_target(parts[0], a.target)
            lit = "lit" in parts[1:]
            nums = [float(v) for v in parts[1:] if v != "lit"]
            r0, r1 = (int(nums[0]), int(nums[1])) if len(nums) >= 2 else (8, 62)
            c0, c1 = (int(nums[2]), int(nums[3])) if len(nums) >= 4 else (0, 160)
            max_loops = int(nums[4]) if len(nums) >= 5 else 12
            thresh = nums[5] if len(nums) >= 6 else 14.0
            with Image.open(ref_path) as ref_file:
                ref_im = thumb(ref_file)

            def at_ref():
                return hud_match(winshot.grab(hwnd), ref_im, (r0, r1, c0, c1), thresh, lit)[0]

            def press_buttons(_t=None):
                for b in buttons:
                    keys.press(hwnd, b, a.target)

            if press_pacing() == "paced":
                # The slow-host budget: wall clock, one press per settled screen (press_pacing).
                # No wait_stable here, so this step writes no w<step>_<k>.png frames -- its own
                # polling is the diagnostic, and the title scorer reads only s<NN>_*.png.
                def sample():
                    im = winshot.grab(hwnd)
                    matched, dist, _band = hud_match(im, ref_im, (r0, r1, c0, c1), thresh, lit)
                    return thumb(im), (dist if matched else float("inf"))

                paced = paced_press_times(
                    ref_observations(sample), press_buttons, ref_dist=thresh,
                    per_press_timeout=delay * SLOW_HOST_PRESS_FACTOR,
                    wall_budget=untilref_budget(a.seconds, a.tail, steps, i))
                presses = len(paced.press_times)
                # The pacing itself, beside the untilref line: WHEN each press went in, relative to
                # the step. A press close to the match is the overshoot caught in the act.
                base = paced.press_times[0] if paced.press_times else 0.0
                print("untilref pacing: presses at t+%s (step t0+%.1fs)"
                      % (",".join("%.1f" % (p - base) for p in paced.press_times),
                         base - t0), flush=True)
            else:
                presses = 0
                while not at_ref() and presses < max_loops:
                    wait_stable(hwnd, 1.5, 20.0, on_frame=cap)
                    if at_ref():
                        break
                    press_buttons()
                    presses += 1
                    time.sleep(delay)
            final = hud_match(winshot.grab(hwnd), ref_im, (r0, r1, c0, c1), thresh, lit)
            band = "" if final[2] is None else f" bands={final[2]:.2f}"
            print(f"untilref({ref_path}): {presses} presses, dist={final[1]:.1f}{band}, matched={final[0]}", flush=True)
            buttons = []
            delay = 0.5
        elif mode.startswith("ifref("):
            # ifref(<png>[,<y0>,<y1>,<x0>,<x1>,<thresh>])+<delay>:BTN — press BTN once, only if the
            # settled screen matches the reference in that thumbnail region; otherwise skip the
            # press. For dialogs the boot flow shows only sometimes (the controller-configuration
            # "save to memory card?" prompt: a blind CROSS answers YES and loops through
            # slot-select / overwrite? / NO; RIGHT+CROSS answers NO and continues).
            parts = mode[6:-1].split(",")
            nums = [float(v) for v in parts[1:]]
            r0, r1 = (int(nums[0]), int(nums[1])) if len(nums) >= 2 else (8, 62)
            c0, c1 = (int(nums[2]), int(nums[3])) if len(nums) >= 4 else (0, 160)
            thresh = nums[4] if len(nums) >= 5 else 14.0
            ref_im = np.asarray(crop_to_content(Image.open(parts[0]).convert("L")).resize((160, 112)), dtype=np.float32)
            wait_stable(hwnd, 1.5, 20.0, on_frame=cap)
            dist = float(np.abs(frame(hwnd)[r0:r1, c0:c1] - ref_im[r0:r1, c0:c1]).mean())
            matched = dist < thresh
            ifref_matched = matched
            print(f"ifref({parts[0]}): dist={dist:.1f} matched={matched}", flush=True)
            if not matched:
                buttons = []
        elif mode == "ifpopup":
            # ifpopup+<delay>:BTN -- press BTN (CROSS) only while the settled screen is something a hold
            # must not be sent over and CROSS dismisses (needs_cross): an in-game HELP pop-up ("You must
            # MEET WITH MALLARD ... PRESS X TO CONTINUE", which pauses the game behind a lit HUD --
            # s5_head_1x, s6_depth_m2: 6/6 gameplay-band holds, diffs 0.00-0.05) or the letterboxed
            # "X TO ABORT" objective cinematic (s6_depth_m4: it started after the HUD match and swallowed
            # four holds). At most 6 presses, <delay> apart; a live gameplay frame or a black frame gets no
            # press. Put one before every gameplay hold.
            presses = 0
            reason = ""
            while presses < 6:
                wait_stable(hwnd, 0.5, 2.0, on_frame=cap)   # pop-ups and cinematic titles settle; live gameplay never does
                press, reason = needs_cross(winshot.grab(hwnd))
                if not press:
                    break
                for b in buttons:
                    keys.press(hwnd, b, a.target)
                presses += 1
                time.sleep(delay)
            print(f"ifpopup: {presses} presses, now: {reason}", flush=True)
            buttons = []
            delay = 0.5
        elif mode in ("burst", "ifburst"):
            # burst+<seconds>:NONE - capture a frame every 0.2 s for <seconds> (transition flashes
            # that a single per-step capture misses), saved as sNN_burst_<k>.png.
            #
            # ifburst+<seconds>:NONE - the same, but only when the most recent `ifref` step
            # matched; otherwise the step does nothing (no frames, no delay) and says so. This is
            # how a burst follows a dialog that moves: put an ifburst after every ifref guard pair
            # and exactly the one whose pair answered the dialog fires, wherever in the run that
            # lands. A fixed `burst` index instead captures whatever screen happens to sit there
            # (gate.py score_transition / observed_burst_step).
            if mode == "burst" or ifref_matched:
                t_b = time.time()
                k = 0
                while time.time() - t_b < delay:
                    winshot.grab(hwnd).save(os.path.join(a.out, f"s{i:02d}_burst_{k:03d}.png"))
                    k += 1
                    time.sleep(0.2)
                print(f"{mode}: s{i:02d}_burst_*, {k} frames over {delay:.1f}s", flush=True)
            else:
                print(f"ifburst: s{i:02d} skipped (the preceding ifref did not match)", flush=True)
            delay = 0.0
        elif mode == "hold":
            # hold+<seconds>:BTN � hold the key(s) down for <seconds> (stick directions W/A/S/D,
            # I/J/K/L on ours; fire R1), then capture. For gameplay probes.
            for b in buttons:
                keys.press(hwnd, b, a.target, hold_s=delay)
            held = "+".join(f"hold{b}" for b in buttons)
            buttons = []
            delay = 0.5
        elif mode == "idle":
            # Press only if the screen stays unchanged for <delay> seconds (a menu waiting for
            # input); skip the press when it changes (a movie/loading screen already moving on).
            # Makes the boot sequence robust to a movie that sometimes plays to its end.
            t_idle = time.time()
            ref = frame(hwnd)
            skip = False
            while time.time() - t_idle < delay:
                time.sleep(0.5)
                if float(np.abs(frame(hwnd) - ref).mean()) > 1.0:
                    skip = True
                    break
            if skip:
                buttons = []
            delay = 0.5
        time.sleep(delay)
        label = f"s{i:02d}_{'+'.join(buttons) or (held if mode == 'hold' else 'none')}"
        path = os.path.join(a.out, label + ".png")
        capture_step(hwnd, path, mode == "hold")
        last = frame(hwnd)
        for b in buttons:
            keys.press(hwnd, b, a.target)
        manifest.append({"step": i, "label": label, "t": round(time.time() - t0, 1), "stable": stable,
                         "waited": round(waited, 1), "buttons": buttons})
        print(f"{label:24s} t={time.time()-t0:6.1f}s stable={stable} waited={waited:.1f}s", flush=True)
    time.sleep(a.tail)
    winshot.grab(hwnd).save(os.path.join(a.out, "final.png"))
    json.dump(manifest, open(os.path.join(a.out, "manifest.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
