"""Drive OUR exe from boot through ONLINE -> LOGIN -> universe -> persona/password (on-screen
keyboard) -> CONNECT -> EULA -> lobby -> briefing room -> CREATE GAME / JOIN GAME against the local
Horizon stack, mirroring online_login.py / online_match.py (the PCSX2 reference). Every screen
transition is detected against title crops in scripts/parity/refs (refs.json) instead of fixed
waits: the shell eats presses that land during a transition, and transition times vary per run.

Usage: python -m tools_py.parity.online_login_ours [--existing] [--name socomc] [--password socom]
       [--out logs/parity/ours_host] [--seconds 500] [--host] [--then cross:3,...] [--hold 30]
       [--instance B]   (second exe instance: own window title, memory card dir and UDP ports)
       [--prefilled]    (Sprint 10 Goal 9: the name and password go to the game as PS2X_SOCOM2_LOGIN_NAME /
                         _PASS, its keyboards open already holding them, and the harness presses ENTER)
       [--clean-exit]   (Sprint 13 V6: after the hold, close the window -- the runtime's own exit -- not the kill)
"""
import argparse
import contextlib
import functools
import json
import os
import re
import subprocess
import time

import numpy as np
from PIL import Image

from . import drive, hostplatform, keys
from .compare import score
from .online_login import OSK_START, osk_moves, osk_pos, osk_type

# winshot on Windows, x11shot on Linux (Sprint 8 Task 9). The name stays, so every call below and
# every test that patches L.winshot.grab is unchanged.
winshot = hostplatform.shot_module()

T = "ours"
REFS = os.path.join("scripts", "parity", "refs")
OSK_ACCENT_BOX = (20, 396, 96, 428)   # accent-toggle key: accented "aei" in normal mode, "abc" in accent mode

# The keyboard's text row, for reading back what a type() actually put there (2026-09-15 evening, s6_ladder2 and
# s6_ladder_oldharness: at ~32 fps -- two instances on one host -- the password came out as 'ocom', '' and 'xmfû'
# and nothing in the drive log said so; research/28 §5 item 4). Measured on the 640x448 captures: each typed glyph
# is a run of light-grey columns (max 100-200, 3-11 px wide: ';' to 'm') separated by 2-3 dark columns, starting at
# col 31; the cursor block after the text is white (max > 200, 5 px) and BLINKS (absent in 7 of the 12 per-key
# captures of ours_login / ours_match), and the font is proportional ("test;p" ends 20 px short of 6 x 11.3), so
# the count is the number of glyph runs, not the cursor position. Exact on 15 of 15 labelled captures (the 12
# per-key ones, 'xmfû', "test;p", and an empty field with its cursor on).
OSK_TEXT_ROWS = (228, 250)
OSK_TEXT_COLS = (20, 470)
OSK_INK_MIN = 60                 # column max above this is ink (glyph or cursor); the field's ground stays below
OSK_CURSOR_MIN = 200             # column max above this is the cursor block, not counted; glyphs stay below it
OSK_GLYPH_MIN_WIDTH = 2          # a narrower run is a cursor edge, not a glyph (';', the narrowest, is 3 px)
OSK_TYPE_ATTEMPTS = 3            # one type + two retypes before login:keyboard-typing
OSK_ENTER_RETRIES = 2            # re-presses of ENTER while the keyboard stays up, before login:keyboard-enter
OSK_ENTER_SETTLE_S = 3.0         # the keyboard's close after ENTER, before its first read-back (the old WARNING's wait)
OSK_SLOW_HOLD_S, OSK_SLOW_WAIT_S = 0.18, 0.5   # retype pacing: 0.09 s / 0.35 s doubled (5-6 frames at 32 fps)
OSK_CROSS_WAIT_S = 0.6                          # after a key's CROSS, both pacings (the keyboard redraws the field)

# The keyboard panel's title, which says WHICH field it is editing (Sprint 8, the first-login path): bright
# text at y 202-222 starting at column 32. Its right edge separates the two the login stage opens --
# "Enter Player Name" ends at column 163 (s8_hosted_control A_04_pw_kbd), "Enter Player Password" at 195
# (s8_lan_login_check A_04_pw_kbd). Only meaningful with the keyboard up (osk_open_of): the form behind it
# has its own text in this band. A read-back for the log, never a gate -- the field the harness types into
# is decided by the form's lit row, which it read before pressing CROSS.
OSK_TITLE = (202, 222, 24, 400)
OSK_TITLE_LUMA = 140.0
OSK_TITLE_NAME_MAX_EDGE = 180                   # midway between the two measured edges

# Sprint 10 Goal 9 (--prefilled): the runtime opens the login's two keyboards already holding PS2X_SOCOM2_LOGIN_NAME /
# _PASS (game_overrides_socom2.cpp installOskPrefill, research/38; R180: it prefills, never submits), so the harness
# reads the field back and presses ENTER instead of typing -- the dead-reckoned typing walk ('ocom', '', 'xmfû';
# research/28 §5 item 4) leaves the driven login. The caps are the two keyboards' own MaxChars and the character set
# is the keyboard's (OSK_ROWS: printable ASCII without the space; the name keyboard refuses '"', NoDQuote) -- the set
# the launcher's normalizeLoginName / normalizeLoginPassword keep. The harness REFUSES a value outside it rather than
# cutting it as the launcher does: the runtime would cut it too, the keyboard would read back short, and the run
# would stop as login:prefill-missing 90 s in instead of before the launch.
PREFILL_ENV_NAME, PREFILL_ENV_PASS = "PS2X_SOCOM2_LOGIN_NAME", "PS2X_SOCOM2_LOGIN_PASS"
PREFILL_NAME_CAP, PREFILL_PASSWORD_CAP = 14, 12  # research/38: _455_EnterPlayerName_MSG / _604_EnterPassword_MSG


def prefill_text(value, cap, what, double_quote=True):
    """`value` as the game's keyboard could hold it, or a ValueError saying why it could not."""
    if not value:
        raise ValueError(f"{what} is empty (the keyboard refuses an empty field, AllowEmpty=0)")
    for ch in value:
        if not 0x20 < ord(ch) < 0x7F or (ch == '"' and not double_quote):
            raise ValueError(f"{what} holds {ch!r}, which is not a key of the game's keyboard")
    if len(value) > cap:
        raise ValueError(f"{what} is {len(value)} characters; the keyboard holds {cap}")
    return value


def prefill_env(name, password):
    """The two variables for the launched game, checked against the keyboards' caps and character set."""
    return {PREFILL_ENV_NAME: prefill_text(name, PREFILL_NAME_CAP, "the persona name", double_quote=False),
            PREFILL_ENV_PASS: prefill_text(password, PREFILL_PASSWORD_CAP, "the password")}

# Per-instance environment: window title tag (the harness finds windows by title substring),
# memory-card directory and the UDP port shift (two clients on one host must not both bind the
# game's fixed 3658/3659, like PCSX2 client B's 0F6FC6CF.clientB.pnach).
INSTANCES = {
    "A": {"PS2X_WINDOW_TITLE": "SOCOM-A", "PS2X_SOCOM2_INPUT_FILE": os.path.abspath("logs/pad_A.txt")},
    "B": {"PS2X_WINDOW_TITLE": "SOCOM-B", "PS2X_MC_DIR": os.path.abspath("game/disc/mc0_b"), "PS2X_SOCOM2_UDP_SHIFT": "2",
          "PS2X_SOCOM2_INPUT_FILE": os.path.abspath("logs/pad_B.txt"),
          # PS2X_SOCOM2_RSA_KEY: instance B may carry the second precomputed key pair so the two
          # clients do not publish the same RSA public key in their DME 0x18 records (PCSX2's two
          # clients publish distinct random keys). Set PS2X_SOCOM2_RSA_KEY_B=b in the environment
          # to turn it on for a run; unset keeps the historical behaviour.
          "PS2X_SOCOM2_RSA_KEY": os.environ.get("PS2X_SOCOM2_RSA_KEY_B", "")},
}


def launch(seconds, instance=None, prefill=None, mc_dir=None, stdout_path=None):
    """Start the exe; returns (proc, title substring to find its window). `prefill` (prefill_env's dict, --prefilled)
    goes into the game's environment; None adds nothing, the environment is what it was. `mc_dir` (--mc-dir, W10):
    the memory-card folder the game boots from (PS2X_MC_DIR, created empty when absent -- a virgin card); it
    overrides the instance's own. `stdout_path` (Sprint 13 V6): run.sh's own output goes there instead of nowhere --
    its `exit=<rc> log=<path>` line is the game's exit code and the run log it wrote (run_sh_exit)."""
    env = dict(os.environ, PS2X_SOCOM2_PAD="1")
    title = keys.WINDOW_TITLES[T]
    latest = os.path.abspath(os.path.join("logs", "parity", f"latest_frame_{instance or 'A'}.png"))
    env["PS2X_HOST_SCREENSHOT_LATEST"] = latest
    if prefill:
        env.update(prefill)
    if instance:
        env.update(INSTANCES[instance])
        write_pad_file(INSTANCES[instance]["PS2X_SOCOM2_INPUT_FILE"])   # neutral before the exe starts
        title = INSTANCES[instance]["PS2X_WINDOW_TITLE"]
        os.makedirs(env.get("PS2X_MC_DIR", "game/disc/mc0"), exist_ok=True)
    if mc_dir:
        env["PS2X_MC_DIR"] = os.path.abspath(mc_dir)
        os.makedirs(env["PS2X_MC_DIR"], exist_ok=True)
    out = open(stdout_path, "w") if stdout_path else subprocess.DEVNULL
    try:
        proc = subprocess.Popen(["bash", "./run.sh", str(seconds)], env=env,
                                stdout=out, stderr=subprocess.DEVNULL)
    finally:
        if stdout_path:
            out.close()                                          # the child holds its own handle
    proc.latest_frame = latest
    return proc, title


# Sprint 13 V6 (#27): the clean exit. SOCOM II on a PS2 has no quit of its own (the console is switched off), so the
# port's clean exit is the window's close: the runtime reads WM_CLOSE as WindowShouldClose, stops the guest, joins its
# thread and leaves through main's _Exit(ps2ProcessExitCode()) -- where the drive's `taskkill /F` ends it mid-frame.
CLEAN_EXIT_WAIT_S = 60.0
RUN_SH_EXIT = re.compile(r"^exit=(-?\d+) log=(\S+)", re.M)


def run_sh_exit(path):
    """(the game's exit code, its run log) off run.sh's `exit=<rc> log=<path> ...` line, or (None, None)."""
    try:
        with open(path, errors="replace") as f:
            m = RUN_SH_EXIT.search(f.read())
    except OSError:
        return None, None
    return (int(m.group(1)), m.group(2)) if m else (None, None)


RUN_SH_TIMEOUT_RC = 124          # coreutils `timeout` in run.sh: the --seconds budget ended the game, not the close


def clean_exit_verdict(rc):
    """The drive log's CLEAN-EXIT line for clean_exit's answer: only a code the game itself returned is clean."""
    if rc is False:
        return "CLEAN-EXIT none (the game did not leave on the close; killed)"
    if rc == RUN_SH_TIMEOUT_RC:
        return f"CLEAN-EXIT none (rc={rc}: run.sh's timeout ended the game, not the close)"
    return f"CLEAN-EXIT rc={rc}"


def clean_exit(sh, proc, stdout_path=None, wait_s=CLEAN_EXIT_WAIT_S, clock=time.time):
    """Close the game's window and wait for run.sh to return (--clean-exit). Returns the game's exit code as run.sh
    printed it (None when it printed none), or False when the close could not be sent or the game was still running
    `wait_s` later -- the caller's kill then ends it, and the log says which. (0 is a clean rc: test `is False`.)"""
    close = getattr(winshot, "close_window", None)
    t = clock()
    if close is None or not close(sh.hwnd):
        sh.log("[exit] clean: the close request could not be sent -> the kill")
        return False
    try:
        proc.wait(timeout=wait_s)
    except subprocess.TimeoutExpired:
        sh.log(f"[exit] clean: the game is still running {wait_s:.0f}s after the window's close -> the kill")
        return False
    rc, log = run_sh_exit(stdout_path) if stdout_path else (None, None)
    sh.log(f"[exit] clean: the window's close -> run.sh returned after {clock() - t:.1f}s, the game's rc={rc} "
           f"(log {log})")
    return rc


# Pad-state injection (PS2X_SOCOM2_INPUT_FILE, socom2_host_input.cpp): the exe reads this file on
# every pad poll, so holds are exact and never dropped (posted keyboard messages were). Button ids
# are the pad ids (kPad*): SELECT 0, L3 1, R3 2, START 3, UP 4, RIGHT 5, DOWN 6, LEFT 7, L2 8,
# R2 9, L1 10, R1 11, TRIANGLE 12, CIRCLE 13, CROSS 14, SQUARE 15. Axes 0..255, 0x80 = neutral.
PAD_BUTTON = {"SELECT": 0, "L3": 1, "R3": 2, "START": 3, "UP": 4, "RIGHT": 5, "DOWN": 6, "LEFT": 7,
              "L2": 8, "R2": 9, "L1": 10, "R1": 11, "TRIANGLE": 12, "CIRCLE": 13, "CROSS": 14, "SQUARE": 15}
PAD_AXIS = {"J": ("rx", 0), "L": ("rx", 255), "I": ("ry", 0), "K": ("ry", 255),
            "A": ("lx", 0), "D": ("lx", 255), "W": ("ly", 0), "S": ("ly", 255)}


PAD_AXIS_NAMES = ("rx", "ry", "lx", "ly")


def pad_axes(sticks=(), axes=None):
    """{axis: 0..255} for a pad write: stick keys (PAD_AXIS, full deflection 0/255) first, then explicit
    `axes` -- PARTIAL deflection, the only way to aim finer than the ~35-40 deg a full-deflection hold
    sweeps (KNOWN §1: the pad file accepts 0-255 per axis) -- overriding a stick on the same axis.
    Anything but an int in 0..255 on rx/ry/lx/ly is refused: a bad axis silently clamped by the exe
    would aim somewhere nobody asked for."""
    out = {}
    for k in sticks:
        name, value = PAD_AXIS[k.upper()]
        out[name] = value
    for name, value in (axes or {}).items():
        if name not in PAD_AXIS_NAMES:
            raise ValueError(f"pad axis {name!r} is not one of {PAD_AXIS_NAMES}")
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
            raise ValueError(f"pad axis {name}={value!r} must be an int in 0..255")
        out[name] = value
    return out


# ---------------------------------------------------------------------------
# Sprint 8 Goal 3 Task 4 Step B: the PTT probe, as an overlay on every pad write rather than a feature of
# the match driver. SOCOM II's talk button is logical action 0xb (decomp :84210), and which PHYSICAL button
# that is cannot be read statically -- the map is the runtime preset table DAT_004415a8+0x12 (FUN_002c64e0
# :166675). So the probe holds each candidate in turn during ordinary gameplay and the run log says which
# hold produced lgAudStartRecording.
#
# It is an overlay because the control round rewrites the pad file every strafe leg (0.5-0.9 s): OR-ing the
# schedule's current button into whatever the driver is writing keeps it effectively held across legs, and
# the runtime latches everything it sees between polls (socom2_host_input.cpp: "Buttons are OR-ed").
#
# SOCOM_PAD_OVERLAY="start=+150;hold=3.0;gap=2.0;buttons=L3:0x0002,R3:0x0004,..."
#   start   "+<seconds>" = that many seconds after the first pad write (or after set_overlay_epoch), or a
#           bare unix time. hold/gap in seconds. buttons: NAME:mask pairs, held in the order given, once.
# Unset, every byte written is exactly what it is today.
#
# The bit order is the PS2 pad's, verified against PAD_BUTTON above and the runtime's own enum
# (third_party/ps2recomp/ps2xRuntime/src/lib/socom2_host_input.h:38-41): SELECT=0 L3=1 R3=2 START=3
# UP=4 RIGHT=5 DOWN=6 LEFT=7 L2=8 R2=9 L1=10 R1=11 TRIANGLE=12 CIRCLE=13 CROSS=14 SQUARE=15.
# START, SELECT and the face buttons go LAST in a probe list: they open menus and the scoreboard, which
# would wreck the round before the useful candidates were tried.

PAD_OVERLAY_ENV = "SOCOM_PAD_OVERLAY"


def parse_pad_overlay(spec):
    """"start=+150;hold=3;gap=2;buttons=L3:0x0002,R3:0x0004" -> schedule dict, or None when empty/unset.

    Raises ValueError on a malformed spec: a probe that silently held nothing would read as "no button
    starts recording", which is the one conclusion this experiment must never reach by accident."""
    if not spec or not spec.strip():
        return None
    fields = {}
    for part in spec.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise ValueError(f"{PAD_OVERLAY_ENV}: {part!r} is not key=value")
        key, value = part.split("=", 1)
        fields[key.strip()] = value.strip()
    if "buttons" not in fields:
        raise ValueError(f"{PAD_OVERLAY_ENV}: no buttons=")
    buttons = []
    for pair in fields["buttons"].split(","):
        pair = pair.strip()
        if not pair:
            continue
        if ":" not in pair:
            raise ValueError(f"{PAD_OVERLAY_ENV}: button {pair!r} is not NAME:mask")
        name, mask = pair.split(":", 1)
        buttons.append((name.strip(), int(mask, 0)))
    if not buttons:
        raise ValueError(f"{PAD_OVERLAY_ENV}: buttons= is empty")
    start = fields.get("start", "+0")
    relative = start.startswith("+")
    return {"buttons": buttons,
            "hold": float(fields.get("hold", 3.0)),
            "gap": float(fields.get("gap", 2.0)),
            "relative": relative,
            "start": float(start[1:] if relative else start),
            "epoch": None}


def pad_overlay_mask(now, schedule):
    """(mask, name) for `now`. Pure: no clock, no file, no state. (0, None) outside every hold."""
    if not schedule or schedule.get("epoch") is None:
        return 0, None
    begin = schedule["epoch"] + schedule["start"] if schedule["relative"] else schedule["start"]
    step = schedule["hold"] + schedule["gap"]
    offset = now - begin
    if offset < 0 or step <= 0:
        return 0, None
    index = int(offset // step)
    if index >= len(schedule["buttons"]):
        return 0, None                      # the list ran out: never press anything again
    if offset - index * step >= schedule["hold"]:
        return 0, None                      # inside the gap
    name, mask = schedule["buttons"][index]
    return mask, name


def set_overlay_epoch(when):
    """Anchor a relative `start=+N` to `when` (a unix time). Called once, from the round's own start."""
    if _OVERLAY is not None and _OVERLAY.get("epoch") is None:
        _OVERLAY["epoch"] = when
        print(f"[ptt] overlay armed: epoch={when:.3f} start=+{_OVERLAY['start']}s "
              f"hold={_OVERLAY['hold']}s gap={_OVERLAY['gap']}s "
              f"buttons={','.join(n for n, _ in _OVERLAY['buttons'])}", flush=True)


try:
    _OVERLAY = parse_pad_overlay(os.environ.get(PAD_OVERLAY_ENV, ""))
except ValueError as exc:
    raise SystemExit(f"[ptt] {exc}")
_OVERLAY_LAST = [None]


def _overlay_for(path):
    """The overlay applies to instance A only -- B is the listener, and a button held on both sides would
    make "who started recording" unreadable. A's pad file is logs/pad_A.txt (INSTANCES above)."""
    if _OVERLAY is None:
        return 0, None
    if "pad_a" not in os.path.basename(str(path)).lower():
        return 0, None
    if _OVERLAY.get("epoch") is None:
        # NEVER arm on the first pad write. The driver writes the pad all through the menus -- the on-screen
        # keyboard the login types on is driven by the same file -- and a button held there wrecks the login
        # before gameplay is ever reached (s8_voice_round2, LOBBY-FAIL login:keyboard-typing). The epoch is
        # set once, from the control round's own start, when both players are controllable.
        return 0, None
    now = time.time()
    mask, name = pad_overlay_mask(now, _OVERLAY)
    if name != _OVERLAY_LAST[0]:
        _OVERLAY_LAST[0] = name
        elapsed = now - _OVERLAY["epoch"]
        if name is None:
            print(f"[ptt] t={elapsed:.2f} released", flush=True)
        else:
            print(f"[ptt] t={elapsed:.2f} holding {name} mask=0x{mask:04x}", flush=True)
    return mask, name


def write_pad_file(path, buttons=(), axes=None):
    """Write the injected pad state atomically (tmp + replace); buttons by name, axes {rx,ry,lx,ly}."""
    a = {"rx": 0x80, "ry": 0x80, "lx": 0x80, "ly": 0x80}
    a.update(axes or {})
    mask = 0
    for b in buttons:
        mask |= 1 << PAD_BUTTON[b.upper()]
    # Sprint 8 Goal 3 Task 4 Step B: the PTT probe's current candidate, OR-ed into whatever the driver is
    # writing. With SOCOM_PAD_OVERLAY unset this adds 0 and the bytes below are identical to today's.
    overlay, _overlay_name = _overlay_for(path)
    mask |= overlay
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(f"b={mask:04x} rx={a['rx']} ry={a['ry']} lx={a['lx']} ly={a['ly']}" + chr(10))
    # The exe opens this file on every pad poll (60 Hz), and a Windows rename over a file another
    # process has open fails with WinError 5. Rare for a hold (two writes a second or two apart),
    # routine for a keyboard walk (two writes every 0.09 s) -- which crashed a whole run. Retry.
    for attempt in range(40):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.005)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Lobby failure classes, per-stage timeouts, verified re-send (Sprint 5 R47, plan Amendment A6)
# ---------------------------------------------------------------------------
# A lobby failure is not an engagement result: it prints `RESULT LOBBY-FAIL <class>` and one
# `LOBBY class=<class>` line, and exits LOBBY_FAIL_EXIT (online_match_ours uses 0 go, 1 FAIL,
# 2 NO-DATA, 3 NO-CONTROL). A launch that reaches gameplay prints `LOBBY class=ok`.
LOBBY_STAGES = ("login", "host", "join", "map_select", "ready", "launch")
LOBBY_STAGE_TIMEOUT_S = 180.0   # kill5 and 8a spent 390-800 s waiting on a lobby that had already failed
LOBBY_FAIL_EXIT = 4
LOBBY_RESEND_MAX = 3
# Frame age for a signature check. Both checked presses wait >= 3 s first, so a frame file younger
# than this was rendered after the press (the runtime rewrites it every ~150 ms).
LOBBY_FRAME_MAX_AGE_S = 1.0
CLASS_OK, CLASS_MAP_CROSS, CLASS_READY = "ok", "map-cross-dropped", "ready-dropped"
CLASS_JOIN, CLASS_HOST = "join-not-reached", "host-not-reached"
CLASS_MAP_SEARCH, CLASS_KEYBOARD = "map-list-search", "login-keyboard"
# Sprint 6 Task 2 (research/28 §4): a window that never reaches the main menu, or never shows the LOGIN
# screen after it (wtb4, 3b), used to exit 1 without a class 120-180 s downstream. A `wait_for` timeout
# anywhere else is `screen:<name>`; a verified fixed press that never lands is `create-game:<step>` or
# `join:<step>` (LOBBY_PRESS_STEPS below), each printed as one `[lobby] <step> press=<btn> verified=<bool>
# attempt=<n>` line per press so the next taxonomy is a grep.
CLASS_PRE_LOGIN = "pre-login"
CLASS_OSK_TYPING = "login:keyboard-typing"   # the keyboard read back the wrong character count three times
# s6_ladder6 (2026-09-15, both instances at ~59 fps; research/28 §5-§6): the runtime drops about one press in twenty,
# and the two blind press runs left in login() each lost one. A: one of the four DOWNs to CONNECT, so CROSS opened
# the gender prompt; B: a step of the walk to ENTER, so the keyboard stayed up. Both timed out the login stage.
CLASS_CONNECT_FOCUS = "login:connect-focus"  # CONNECT never read lit after the DOWNs and their bounded extras
CLASS_CONNECT_PRESS = "login:connect-press"  # the form stayed up with CONNECT lit after the CROSS and its re-sends
CLASS_OSK_ENTER = "login:keyboard-enter"     # the keyboard stayed up after ENTER and OSK_ENTER_RETRIES re-presses
CLASS_PERSONA = "login:persona"              # + ":list" / ":password-keyboard" / ":name-keyboard": that CROSS never registered
CLASS_NEW_PERSONA = "login:persona:new-persona"  # --new-persona: the pick after the DOWNs opened no "Enter Player Name" keyboard
CLASS_OSK_PREFILL = "login:prefill-missing"  # --prefilled: the keyboard opened holding a different count than the string's
# Fix wave W8 (R240, 2026-09-22). Two things the join path could not say before.
#
# (a) An EMPTY GAMES LIST IS NOT A FAILURE. The 2026-09-22 join of the owner's live lobby reached the BRIEFING
# ROOM in 175 s, pressed CROSS on JOIN GAME four times against "There are no games to join." on Channel 1 and
# scored itself LOBBY-FAIL join:list -- a verdict on our client for a lobby that simply had no game in it. That
# is its own outcome now: `RESULT NO-GAMES channel=<n>` and exit LOBBY_NO_GAMES_EXIT, so a mixed-match leg whose
# partner had not created the world yet reads as "nothing to join", never as "the join failed". lobby_report
# already separates the two: `RESULT NO-GAMES` is a RESULT word, and only `RESULT LOBBY-FAIL` is a lobby failure.
#
# (b) `--channel`. The room is chosen one screen earlier, on SOCOM II ONLINE -> BRIEFING ROOMS ("Select a
# Briefing Room", ROOM NAME / # of PLAYERS / ELIGIBLE RANKS), where `to_briefing_room` used to press CROSS on
# whatever row the list opened on. `select_room` walks DOWN to the Nth row first.
CLASS_NO_GAMES = "join:no-games"
CLASS_CHANNEL = "login:channel"              # --channel N: the room list's highlight would not move to row N
CLASS_CURSOR_DRIFT = "join:cursor-drift"     # the briefing room cursor left JOIN GAME between two presses
LOBBY_NO_GAMES_EXIT = 5                      # beside LOBBY_FAIL_EXIT 4: a different thing, a different code
LOBBY_REFRESH_WAIT_S = 6.0                   # after the REFRESH LIST press, before the list is read
# The BRIEFING ROOMS room list: the rows under the column-header bar (which fills y 96..120 and would otherwise
# read as a selected row). The selected room's fill is a median of 38 over x 190..620 against 15-23 for an empty
# row -- identical on all 306 `*10_rooms.png` captures in logs/parity. Every one of those 306 shows exactly ONE
# room, so the list's row PITCH has never been observed and nothing here assumes one: `select_room` presses DOWN
# and requires the highlight's top edge to have MOVED DOWN, which needs no pitch and cannot silently land on the
# wrong room.
ROOMS_LIST_ROWS = (122, 400)
ROOMS_LIST_COLS = (190, 620)
ROOMS_ROW_FILL_MIN = 30.0

# Title band of the four screens the CREATE GAME / JOIN GAME presses move between (full-res 640x448:
# x 20-360, y 18-58), compared as a text mask (map_mask_distance's measure) against
# scripts/parity/refs/lobby/title_<name>.png, cut from launch 8c by
# tools_py/tests/fixtures/lobby/make_screen_fixtures.py. Over the 128 stage captures of the 30 launches
# in research/28 §1 the right screen scores 0.000-0.011, the nearest wrong one 0.385 (CREATE GAME vs
# CREATE GAME PLAY LIST, whose title extends the other's) and every other pair >= 0.658.
LOBBY_TITLE = (slice(18, 58), slice(20, 360))
LOBBY_TITLES = ("briefing_room", "create_game", "play_list", "game_lobby")
LOBBY_TITLE_MAX_DIST = 0.15     # 14x the worst true match, under half the nearest wrong pair
LOBBY_REF_DIR = os.path.join(REFS, "lobby")
# Sprint 10 Goal 1: the GAME LOBBY and BRIEFING ROOM bands carry the server's channel name to the right of the
# title words (x >= 235; the words end at 203), and that name changed from "Channel 1" to "US East (Ohio)" when the
# hosted box was named -- the first scheduled ladder read its own GAME LOBBY at distance 0.225 against a reference
# cut with "Channel 1" in it and failed the run as LOBBY-FAIL create-game:create (ladder_20260920_043246). Those two
# titles compare the words only (215 of the band's 340 columns): on the 106 s7+/ladder captures the worst true match
# is 0.011 and the nearest wrong pair 0.573. CREATE GAME and its PLAY LIST screen share their first words and are
# told apart by the rest of the band, so they keep the full width (0.000 / 0.385).
LOBBY_TITLE_COLS = {"game_lobby": 215, "briefing_room": 215}
# Menu rows the fixed UP presses must light before the CROSS that follows (y0, y1, x0, x1). A lit row is
# a teal fill: its median luminance is 62-68 on every capture, an unlit row's <= 34 (even with the
# game-name keyboard drawn over the menu, cal1). The games-list row is a fainter fill: 36 when JOIN
# GAME activated a list with a game in it (8c, launch1), 15-18 with "There are no games to join."
# The GAME LOBBY's READY row (menu row 2, the cursor detector's band): median 68 with the cursor on it
# (8a A/B, s6_ladder4 B_16), 23 with no cursor drawn (every *_17_game_lobby_ok), 0-8 once in-game.
LOBBY_ROWS = {"create_game": (106, 128, 18, 135),     # BRIEFING ROOM menu row 0
              # Fix wave W8 (R240): the rest of that menu -- CREATE GAME / JOIN GAME / WATCH GAME / PLAYER LIST /
              # REFRESH LIST -- at row 0's own band stepped by the menu's 32 px pitch. Measured on the briefing-room
              # captures in logs/parity: the lit fill spans y 139..161 with JOIN GAME lit
              # (join_owner_lobby/11_briefing_room.png) and y 171..193 with WATCH GAME lit
              # (join_owner_lobby/miss_join_list_2.png), and every row of every capture reads 68 lit against 22-25
              # unlit -- the same two numbers as create_game, which is why they take its threshold unchanged. The
              # console reads the SAME bands (67 lit / 20-22 unlit on s10_pcsx2_login1 B_11 and s10_pcsx2_mapscan
              # A_11): PCSX2's ~7% narrowing of these screens is horizontal, and x 18..135 is inside the menu on
              # both, so pcsx2_shell's joiner needs no sibling geometry here.
              "join_game": (138, 160, 18, 135),       # BRIEFING ROOM menu row 1
              "watch_game": (170, 192, 18, 135),      # row 2
              "player_list": (202, 224, 18, 135),     # row 3
              "refresh_list": (234, 256, 18, 135),    # row 4 -- the press R240 says was never made
              "choose_games": (386, 406, 18, 170),    # CREATE GAME menu's last row
              "games_list": (262, 280, 150, 620),     # first row of the briefing room's games list
              "ready": (158, 180, 22, 165),           # GAME LOBBY menu row 2
              # CONNECT TO SOCOM II form (login): the CONNECT button, bottom left, and the GENDER row. Over
              # every *_06_connect_focus capture the button's median is 68 on the 117 with the cursor on it,
              # 19 (s6_ladder6: cursor on GENDER), 24 or 31 (older Sprint 4 runs) without; GENDER reads 68
              # lit (s6_ladder6) and 23 unlit (s5_t5_ladder2).
              "connect": (366, 390, 20, 160),
              "gender": (226, 246, 20, 160),
              # ... and the four rows above GENDER, 30 px apart, for the first-login path (Sprint 8): the
              # form's rows read exactly like CONNECT and GENDER -- 68 lit, 19-25 unlit on the 2026-09-19
              # reference pair (s8_lan_login_check A_02_persona: PASSWORD lit, PLAYER NAME 23;
              # s8_hosted_control A_02_persona: PLAYER NAME lit, PASSWORD 24).
              "player_name": (106, 128, 20, 160),
              "password": (136, 158, 20, 160),
              "save_password": (166, 188, 20, 160),
              "hometown": (196, 218, 20, 160)}
LOBBY_ROW_LIT_MEDIAN = {"create_game": 50.0, "choose_games": 50.0, "games_list": 27.0, "ready": 50.0,
                        "connect": 50.0, "gender": 50.0, "player_name": 50.0, "password": 50.0,
                        "save_password": 50.0, "hometown": 50.0,
                        "join_game": 50.0, "watch_game": 50.0, "player_list": 50.0, "refresh_list": 50.0}
# The BRIEFING ROOM's left menu, top to bottom: `briefing_focus_row` names the lit one and `briefing_select`
# walks between them. (A sixth row, GAME DETAILS, appears under REFRESH LIST once the games list holds a game;
# nothing presses on it, so it is read by nobody and has no band.)
BRIEFING_MENU = ("create_game", "join_game", "watch_game", "player_list", "refresh_list")
# The BRIEFING ROOM's prompt band, above the menu, and how wide its text runs. Fix wave W8: this band is what
# separates "the JOIN GAME press has not taken" from "the press took and the list is EMPTY", which R240's run
# could not tell apart and scored LOBBY-FAIL for. Three sentences appear there and they differ in LENGTH, so the
# measure is the ink's span, not its position -- which also makes it target-independent, the console drawing
# these screens about 7% narrower (Sprint 10 Goal 3). Over every capture in logs/parity that carries the
# BRIEFING ROOM title (377 of them):
#   "Activate the games list and choose a game to join." / "... to watch."  419-429 px ours, 385 px on PCSX2 (268)
#   "There are no games to join."                                           207 px (9: join_owner_lobby's fail
#                                                                           capture, ours_task6_mp, ours_task7_cal1 ...)
#   "Choose game to join."                                                  179 px (104, every one with a game in
#                                                                           the list: games_list lit at 36)
#   nothing on the band (a fade)                                            0 px (1)
BRIEFING_BANNER = (slice(60, 95), slice(90, 570))
BRIEFING_BANNER_INK = 100.0      # the band's text; the panel behind it never reaches this
BRIEFING_BANNER_WIDE_PX = 300    # between 207 and 385: 1.45x clear of the widest short sentence either side
BRIEFING_BANNER_MIN_PX = 80      # narrower than any of the three: the band is mid-fade and says nothing yet
# The CONNECT TO SOCOM II form top to bottom: `login_focus_row` names whichever one is lit.
LOGIN_ROW_ORDER = ("player_name", "password", "save_password", "hometown", "gender", "connect")
# The PLAYER NAME value strip, right of the row labels and left of the diver photo that fills the panel's
# right half: the glyph-run counter reads 6 columns of glyphs for "socomc" (the LAN card's persona, x
# 181-232), 5 for the "socom" the old path mistyped into it, and 0 on a fresh server's empty field (whose
# brightest column is 51, under the counter's ink floor of 60). 172-400 fits a 20-glyph name.
LOGIN_NAME_VALUE = (106, 128, 172, 400)
# The form's prompt band ("Connect.", "Specify your gender.", "Enter your password.": bright centred text at
# y 74-90) tells the form from what follows the CONNECT: 52-117 columns above 80 within x 230-415 on every form
# capture, 0 on the write-down / save-card / slot notices, 7 on the EULA (a panel edge), and 0 with a keyboard
# drawn over the form (the overlay dims the band).
LOGIN_FORM_PROMPT = (slice(74, 90), slice(230, 415))
LOGIN_FORM_PROMPT_LUMA = 80.0
LOGIN_FORM_PROMPT_MIN_COLS = 40
LOGIN_CONNECT_DOWNS = 4          # PASSWORD -> SAVE PASSWORD, HOMETOWN, GENDER, CONNECT
LOGIN_CONNECT_EXTRA_DOWNS = 3    # more DOWNs while CONNECT reads unlit, before login:connect-focus
LOGIN_GENDER_BACKS = 2           # TRIANGLEs out of a prompt the CROSS opened, before login:connect-focus
# Fix wave W10 (2026-09-22): the SAVE PASSWORD row's two boxes, "YES" and "NO", and the PASSWORD value strip.
# On the 640x448 form (logs/parity/blop_c/02_persona.png, NO ticked): the YES box is an empty outline at x 176-192
# whose inside never rises above 47, the NO box at x 240-254 carries the tick and its inside reads up to 102; the
# label text either side ("YES" from x 202, "NO" from x 268) is 157 and lies outside both boxes. Boxes are
# (y0, y1, x0, x1) of the INSIDE, so the outline itself (47) is not read. The PASSWORD strip is the PLAYER NAME
# strip one row down: five asterisks read max 186 (blop_c 05_password), the empty field 63.
LOGIN_SAVE_YES_BOX = (169, 183, 178, 191)
LOGIN_SAVE_NO_BOX = (169, 183, 242, 253)
LOGIN_SAVE_TICK_MIN = 70.0
LOGIN_PASSWORD_VALUE = (136, 158, 172, 400)
# The PASSWORD strip's own ink floor: with the PASSWORD row lit its highlight spills into the empty strip at 63
# (blop_c 02_persona), over the keyboard counter's 60, which would read an empty field as one glyph on the very
# frame the relaunch proof reads. The asterisks reach 186; nothing but ink reaches 100.
LOGIN_PASSWORD_INK_MIN = 100.0
CLASS_SAVE_TICK = "login:save-password"        # + ":row" / ":tick": SAVE PASSWORD could not be set to YES
CLASS_RELAUNCH_LOGIN = "login:saved-password"  # the relaunch: the card did not bring the persona or its password back
SAVED_FORM_READS, SAVED_FORM_REREAD_S = 3, 1.0     # V6 review: the relaunch form, read up to 3 times 1 s apart
# (the two names above are not *_PASSWORD: the release leak check reads `X_PASSWORD = "..."` as a secret assignment)

# The main menu of the block-pointer exe: NEW GAME / ONLINE / LAN. The lit row's text pulses in size (ONLINE lit spans
# x 267-370 in s6_ladder7's A_lobby_fail_pre-login and 243-394 in wtb4's and 3b's timeout captures, the width of a
# lit NEW GAME), so the rows are read by the median of the text's core: lit 114-146, dim 15-43 over every capture.
# Every timeout capture before the login screen (wtb4, 3b, s6_ladder7 A) shows ONLINE lit: the DOWN had registered
# and the CROSS was dropped. Boxes (y0, y1, x0, x1) as LOBBY_ROWS.
MENU_ROWS = {"new_game": (278, 296, 262, 368), "online": (312, 332, 262, 368), "lan": (348, 364, 262, 368)}
MENU_ROW_LIT_MEDIAN = 80.0
ONLINE_EXTRA_DOWNS = 2           # more DOWNs while ONLINE reads unlit after the first, before pre-login
ONLINE_CROSS_RESENDS = 3         # re-sent CROSSes while the menu still shows ONLINE lit and no login screen
LOGIN_SCREEN_WAIT_S = 40.0       # the login screen after the ONLINE CROSS (0.8-1.3 s on every launch that got there)
# The persona-list CROSS (the first of the two after the universe) is verified by the frame changing: measured over
# s6_ladder7 B, a static screen re-read differs by 0.00-0.05, the cursor moving one row by 1.33, the password
# keyboard opening by 16.5 (16.45-18.04 over 13 launches' 02_persona -> 03_name), a screen change by 12.9.
PERSONA_CHANGED_MIN_DIFF = 4.0   # 3x the cursor move, a quarter of the keyboard
PERSONA_CROSS_WAIT_S = 4.0
# GAME LOBBY menu rows (ARMORY, SWITCH TEAMS, READY) for the cursor read, and the most DOWN/UP presses a
# cursor search may send. s6_ladder4 (research/30): B read no cursor after the host's READY -- the match
# had launched -- and the old unbounded wiggle sent DOWN,UP x4 and a CROSS into the game, where D-pad
# UP/DOWN cycle the scope zoom (FUN_00594cf0): B spawned scoped 3.0x. Every press now needs a fresh
# frame whose title band still reads GAME LOBBY.
LOBBY_CURSOR_ROWS = ((98, 120), (128, 150), (158, 180))
LOBBY_CURSOR_MIN_MEAN = 50.0
LOBBY_CURSOR_PRESSES = 4
# The "READY button will be available in 30 seconds ... CONTINUE" panel: region mean 54 while it is
# up (every *_16_game_lobby capture), 27-28 once CONTINUE dismissed it (*_17_game_lobby_ok).
LOBBY_NOTICE = (slice(152, 265), slice(150, 490))
LOBBY_NOTICE_MIN_MEAN = 40.0

# Map CROSS signature: the SELECTED MAPS panel (x 335-625, y 110-380) is byte-identical when the
# CROSS did not register. 8b's dropped press: mean |diff| 0.00 (A_14b vs A_15, 9 s and a SQUARE
# apart). 8c's live check 4 s after a taken CROSS alone: 3.52 (8.95 once the SQUARE had followed).
# The 8c driver retried below 3.0; 1.0 keeps "byte-identical" and leaves 3.5x margin to that read.
MAP_PANEL = (slice(110, 380), slice(335, 625))
MAP_CROSS_DROPPED_MAX_DIFF = 1.0
# READY signature: the row-2 label's text right edge (x 22-165, y 158-180) is col 48-49 while it still
# reads READY and col 82-84 once NOT READY shows (8a A/B, s6_ladder8/9). The label carries a right-aligned
# count suffix at times ("NOT READY 3", "READY 5": digits at cols 117-131), which the edge ignores
# (READY_COUNT_COL). The text is 127-147 bright with the cursor highlight on the row (teal fill, brightest
# pixel 68) and only 83-85 without it (s6_ladder9 A/B_19_ready: the highlight was off the row 3 s after the
# CROSS, and at luma 110 both checks read [None, None] and took the "lobby gone" branch with the lobby
# still up): a frame with no text at the lit luma is read again at the dim luma, 75, between the fill and
# the dim text. No text at all (8c: the match launched inside 3 s) or any other edge is NOT retried: a
# second CROSS on NOT READY would un-ready.
READY_LABEL = (slice(158, 180), slice(22, 165))
READY_LABEL_LUMA = 110
READY_LABEL_DIM_LUMA = 75
READY_COUNT_COL = 90            # label columns at or beyond this are the count suffix, not the label (an
                                # in-game frame, 8c, lights cols 98-102 and 127-140 at this luma)
READY_EDGE_DROPPED_MAX = 55
# Sprint 10 Goal 3: the console draws the row ~7% narrower and offset (KNOWN section 2): its READY label's right
# edge reads 65-66 and NOT READY 87 (leg 1b/1c frames) against ours' 48 / 82, so ours' 55 read the console's
# unpressed READY as taken (leg 1c: the console never readied and the round never started). The bar sits between
# the two labels of each target.
READY_EDGE_DROPPED_MAX_BY_TARGET = {"ours": READY_EDGE_DROPPED_MAX, "pcsx2": 76}


def ready_edge_dropped_max(target=None):
    return READY_EDGE_DROPPED_MAX_BY_TARGET.get(target or _current_target, READY_EDGE_DROPPED_MAX)
READY_CONFIRM_GAP_S = 1.0       # R69: the two frames a READY re-send needs are this far apart
READY_REREAD_MAX = 4            # a label-less frame with GAME LOBBY still up is re-read this often ...
READY_REREAD_GAP_S = 0.5        # ... this far apart, before the check gives up (ready:label-unread)
# Team columns: bright text pixels (> 140) in the SEALS (x 180-390) and TERRORISTS (x 405-615) name columns,
# rows 240..300. One name reads 143-144, two in one column 288, none 0 (s6_ladder5/8/9); in-game frames
# leave 3-23 stray pixels. A column holds a name at LOBBY_TEAM_NAME_MIN_PX and both names at
# LOBBY_TEAM_TWO_NAMES_MIN_PX; a single name with the other column empty (the host before the join, s6_ladder8
# A_17; a half-rendered frame) is not a verdict. s6_ladder9: both names under SEALS, and a match never
# starts with an empty team -- the joiner's SWITCH TEAMS is pressed by the read.
LOBBY_TEAM_COLS = ((slice(240, 300), slice(180, 390)), (slice(240, 300), slice(405, 615)))
LOBBY_TEAM_TEXT_LUMA = 140
LOBBY_TEAM_NAME_MIN_PX = 60
LOBBY_TEAM_TWO_NAMES_MIN_PX = 220
LOBBY_SWITCH_MAX = 3            # SWITCH TEAMS presses before join:switch-teams
LOBBY_TEAMS_REREAD_S = 1.0      # wait between two reads that showed no name at all


class LobbyFail(SystemExit):
    """A classified lobby failure; a SystemExit so every existing caller exits LOBBY_FAIL_EXIT."""

    def __init__(self, cls, detail=""):
        super().__init__(LOBBY_FAIL_EXIT)
        self.cls, self.detail = cls, detail

    def __str__(self):
        return f"LOBBY-FAIL {self.cls}" + (f" -- {self.detail}" if self.detail else "")


def lobby_fail(sh, cls, detail=""):
    """Log the RESULT and class lines, capture the screen when possible; returns the exception to raise."""
    sh.log(f"RESULT LOBBY-FAIL {cls}" + (f" -- {detail}" if detail else ""))
    sh.log(f"LOBBY class={cls}")
    sh.stages = ()                        # the failure is decided: nothing after this re-enters the timeout
    try:
        sh.shot(f"lobby_fail_{cls.replace(':', '_')}")
    except (RuntimeError, OSError) as e:  # a stale or missing frame must not hide the classification
        sh.log(f"(no lobby-fail capture: {e})")
    return LobbyFail(cls, detail)


class LobbyNoGames(SystemExit):
    """The briefing room had no game to join. NOT a LobbyFail: a different exit code, a different RESULT word,
    and nothing about it is a verdict on this client (fix wave W8, R240)."""

    def __init__(self, channel, detail=""):
        super().__init__(LOBBY_NO_GAMES_EXIT)
        self.channel, self.detail = channel, detail

    def __str__(self):
        return f"NO-GAMES channel={self.channel}" + (f" -- {self.detail}" if self.detail else "")


def lobby_no_games(sh, channel, detail=""):
    """Log the RESULT and class lines, capture the screen; returns the exception to raise.

    The shape is `lobby_fail`'s on purpose -- same log, same capture, same "the outcome is decided, stop the
    stage clock" -- because the only thing that differs is what it MEANS. `RESULT NO-GAMES ...` is picked up by
    lobby_report as a RESULT (outcome "result"), never as outcome "lobby-fail"."""
    where = channel if channel is not None else "?"
    sh.log(f"RESULT NO-GAMES channel={where}" + (f" -- {detail}" if detail else ""))
    sh.log(f"LOBBY class={CLASS_NO_GAMES}")
    sh.stages = ()
    try:
        sh.shot("lobby_no_games")
    except (RuntimeError, OSError) as e:
        sh.log(f"(no no-games capture: {e})")
    return LobbyNoGames(where, detail)


@contextlib.contextmanager
def lobby_stage(sh, name, timeout=LOBBY_STAGE_TIMEOUT_S):
    """Run a lobby stage under a deadline. Shell.press / pad_press / is_screen / osk_refs check it, so
    an overrun ends as `timeout:<stage>` within one step. A nested stage keeps the outer deadline
    running; the outermost expired stage is the one reported."""
    if name not in LOBBY_STAGES:
        raise ValueError(f"unknown lobby stage {name!r}")
    prev = sh.stages
    sh.stages = tuple(prev) + ((name, sh.clock() + timeout),)
    try:
        yield
    finally:
        sh.stages = prev


def staged(name):
    """Decorator: the lobby function (first argument a Shell) runs as stage `name`."""
    def deco(fn):
        @functools.wraps(fn)
        def run(sh, *a, **k):
            with lobby_stage(sh, name):
                return fn(sh, *a, **k)
        run.lobby_stage = name
        return run
    return deco


def lobby_launch_budget(t_start, clock=time.time):
    """Seconds left of the launch stage (READY -> gameplay rows), which both instances share."""
    return max(1.0, LOBBY_STAGE_TIMEOUT_S - (clock() - t_start))


def lobby_gray_of(im):
    return np.asarray(im.convert("L"), dtype=np.float32)


def lobby_gray(sh):
    """A frame rendered after the press. A StaleFrameError (an instance stall) is waited out under the
    stage deadline, never read as a dropped press. Records the shell's target for the title matchers."""
    global _current_target
    _current_target = getattr(sh, "target", "ours")
    while True:
        try:
            return lobby_gray_of(winshot.grab(sh.hwnd, max_age=LOBBY_FRAME_MAX_AGE_S))
        except winshot.StaleFrameError as e:
            sh.log(f"lobby check: {e} -- waiting for a fresh frame")
            sh.check_stage()


def map_panel_diff(pre, post):
    return float(np.abs(post[MAP_PANEL] - pre[MAP_PANEL]).mean())


def map_cross_dropped(pre, post):
    return map_panel_diff(pre, post) < MAP_CROSS_DROPPED_MAX_DIFF


def ready_label_edge(gray):
    """Right edge (column within READY_LABEL) of the row-2 label text left of the count suffix, or None:
    read at the lit luma (the cursor on the row), else at the dim luma (the cursor elsewhere)."""
    band = gray[READY_LABEL][:, :READY_COUNT_COL]
    for luma in (READY_LABEL_LUMA, READY_LABEL_DIM_LUMA):
        cols = np.where((band > luma).any(axis=0))[0]
        if len(cols):
            return int(cols.max())
    return None


def ready_dropped(gray):
    edge = ready_label_edge(gray)
    return edge is not None and edge <= ready_edge_dropped_max()


def lobby_resend(sh, btn, wait):
    """A re-sent press goes through the injected pad file when there is one (never dropped)."""
    if sh.pad_file:
        sh.pad_press(btn.upper(), wait=wait)
    else:
        sh.press(btn, wait)


def lobby_resend_cross(sh, wait):
    lobby_resend(sh, "cross", wait)


def verify_resend(sh, cls, dropped, resend):
    """Check the press; re-send up to LOBBY_RESEND_MAX times; LobbyFail(cls) if it never registers.
    Returns the number of re-sends it took."""
    for attempt in range(1, LOBBY_RESEND_MAX + 1):
        if not dropped():
            return attempt - 1
        sh.log(f"LOBBY RESEND {cls} attempt={attempt}")
        resend()
    if not dropped():
        return LOBBY_RESEND_MAX
    raise lobby_fail(sh, cls, f"still not registered after {LOBBY_RESEND_MAX} re-sends")


def press_map_cross_verified(sh, wait=4.0):
    """The CROSS that moves the highlighted map into SELECTED MAPS, verified on that panel."""
    pre = lobby_gray(sh)
    sh.press("cross", wait)

    def dropped():
        d = map_panel_diff(pre, lobby_gray(sh))
        sh.log(f"map CROSS check: SELECTED MAPS panel mean |diff| {d:.2f}")
        return d < MAP_CROSS_DROPPED_MAX_DIFF

    return verify_resend(sh, CLASS_MAP_CROSS, dropped, lambda: lobby_resend_cross(sh, wait))


# ---------------------------------------------------------------------------
# Verified fixed presses (Sprint 6 Task 2, research/28 §4 ranks 1-3)
# ---------------------------------------------------------------------------
# Sprint 10 Goal 3: the console (PCSX2) draws the online screens ~7% NARROWER than ours and centred -- the GAME
# LOBBY's title glyphs span x 51..576 on a console frame against 31..595 on ours (PCSX2 honours the CRTC's display
# window; our presentation draws the framebuffer edge to edge, KNOWN section 2). A text mask cut from our renderer
# reads the console's title at 0.54 (best over +-24 px; a 1.06x stretch brings it to 0.17), so a title that a
# console shell must read gets its own reference beside ours', `title_<name>.pcsx2.png`, cut from a console frame
# at the same band. `lobby_gray(sh)` records which target the frame came from; the matchers pick the reference.
_current_target = "ours"


@functools.lru_cache(maxsize=None)
def lobby_title_ref(name, target="ours"):
    path = os.path.join(LOBBY_REF_DIR, f"title_{name}.{target}.png") if target != "ours" else ""
    if not path or not os.path.exists(path):
        path = os.path.join(LOBBY_REF_DIR, f"title_{name}.png")
    return np.asarray(Image.open(path).convert("L"), dtype=np.float32)


def lobby_title_dist(gray, name, target=None):
    """Text-mask distance of the frame's title band to the `name` reference (0 = the same title); the titles that
    carry the channel name compare their words only (LOBBY_TITLE_COLS). `target` defaults to the target of the
    last frame lobby_gray() read."""
    cols = LOBBY_TITLE_COLS.get(name)
    band, ref = gray[LOBBY_TITLE], lobby_title_ref(name, target or _current_target)
    if cols:
        band, ref = band[:, :cols], ref[:, :cols]
    return map_mask_distance(band, ref)


def lobby_title_is(gray, name, target=None):
    return lobby_title_dist(gray, name, target) <= LOBBY_TITLE_MAX_DIST


def lobby_row_median(gray, row):
    y0, y1, x0, x1 = LOBBY_ROWS[row]
    return float(np.median(gray[y0:y1, x0:x1]))


def lobby_row_lit(gray, row):
    return lobby_row_median(gray, row) > LOBBY_ROW_LIT_MEDIAN[row]


def briefing_banner_span(gray):
    """Width in pixels of the ink on the BRIEFING ROOM's prompt band (0 when nothing is drawn on it)."""
    ink = np.where((gray[BRIEFING_BANNER] > BRIEFING_BANNER_INK).any(axis=0))[0]
    return int(ink.max() - ink.min() + 1) if len(ink) else 0


def briefing_banner(gray):
    """What the BRIEFING ROOM's prompt band is saying, by the length of the sentence on it:
    "prompt" (the long "Activate the games list and choose a game to join/watch."), "short" (either of the two
    short answers -- "There are no games to join." or "Choose game to join."), or "dark" (mid-fade, no verdict).
    Only meaningful on a frame that carries the BRIEFING ROOM title."""
    span = briefing_banner_span(gray)
    if span >= BRIEFING_BANNER_WIDE_PX:
        return "prompt"
    return "short" if span >= BRIEFING_BANNER_MIN_PX else "dark"


def join_list_state(gray):
    """What the CROSS on JOIN GAME did, read off one frame (fix wave W8, R240) -- three outcomes, not two:

      "listed"    the games list is up with a game highlighted (the first row's fill lit): the join can go on.
      "none"      the list is up and EMPTY -- "There are no games to join.": the banner has gone short and no
                  row is lit. Not a failure of this client; `lobby_no_games` is the outcome.
      "unpressed" the banner still carries the long "Activate the games list ..." prompt: the press did not
                  register, which is what a re-send is for (R240's first press really was eaten -- the banner in
                  logs/parity/join_owner_lobby/miss_join_list_1.png is still the prompt).
      "unread"    the frame is not the briefing room, or the banner is mid-fade. Never a verdict; read again.
    """
    if not lobby_title_is(gray, "briefing_room"):
        return "unread"
    if lobby_row_lit(gray, "games_list"):
        return "listed"
    banner = briefing_banner(gray)
    if banner == "prompt":
        return "unpressed"
    return "none" if banner == "short" else "unread"


def briefing_focus_row(gray):
    """Name of the lit row of the BRIEFING ROOM's left menu, or None when none or several read lit (a
    transition, or a frame that is not the briefing room). `login_focus_row`'s read, one menu over."""
    lit = [row for row in BRIEFING_MENU if lobby_row_lit(gray, row)]
    return lit[0] if len(lit) == 1 else None


def briefing_rows_detail(gray):
    return "row medians " + ", ".join(f"{r.replace('_', ' ')} {lobby_row_median(gray, r):.0f}" for r in BRIEFING_MENU)


def rooms_fill_top(gray):
    """Top row (y) of the highlighted entry in the BRIEFING ROOMS room list, or None when none is highlighted.
    The column-header bar above the list is excluded by ROOMS_LIST_ROWS, which starts below it."""
    y0, y1 = ROOMS_LIST_ROWS
    x0, x1 = ROOMS_LIST_COLS
    med = np.median(gray[y0:y1, x0:x1], axis=1)
    hit = np.where(med > ROOMS_ROW_FILL_MIN)[0]
    return int(hit[0]) + y0 if len(hit) else None


def login_form_prompt_cols(gray):
    """Columns of bright text in the CONNECT TO SOCOM II form's prompt band."""
    return int((gray[LOGIN_FORM_PROMPT] > LOGIN_FORM_PROMPT_LUMA).any(axis=0).sum())


def login_form_up(gray):
    """The CONNECT TO SOCOM II form is on screen with no keyboard over it."""
    return login_form_prompt_cols(gray) >= LOGIN_FORM_PROMPT_MIN_COLS


def login_focus_row(gray):
    """Name of the CONNECT TO SOCOM II form's lit row, or None when none or several read lit (a transition,
    a keyboard dimming the form, a frame that is not the form at all). The CONNECT button's lit-fill read,
    generalised over the six rows."""
    lit = [row for row in LOGIN_ROW_ORDER if lobby_row_lit(gray, row)]
    return lit[0] if len(lit) == 1 else None


def login_name_glyphs(gray):
    """Glyphs in the form's PLAYER NAME field (0 when it is empty). Only meaningful with the form up and no
    keyboard over it: the keyboard's overlay dims the strip to a brightest column of 26, which also reads 0."""
    return glyph_run_count(gray, LOGIN_NAME_VALUE)


def login_name_empty(gray):
    return login_name_glyphs(gray) == 0


def login_persona_mode(gray):
    """"create" when the form offers no saved persona (PLAYER NAME empty), "saved" when it is prefilled, None
    when this frame is not the form -- the game keeps personas per server, so the same card arrives prefilled
    on the LAN box and empty on a server it has never logged into."""
    if not login_form_up(gray):
        return None
    return "create" if login_name_empty(gray) else "saved"


def login_password_glyphs(gray):
    """Glyphs in the form's PASSWORD field (the asterisks; 0 when it is empty). Form up, no keyboard. Read with
    the strip's own ink floor (LOGIN_PASSWORD_INK_MIN): the lit row's spill must not count as a character."""
    return glyph_run_count(gray, LOGIN_PASSWORD_VALUE, ink_min=LOGIN_PASSWORD_INK_MIN)


def login_save_password(gray):
    """Which SAVE PASSWORD box carries the tick: "yes", "no", or None when neither or both do (a keyboard over
    the form, a transition, a frame that is not the form)."""
    y0, y1, x0, x1 = LOGIN_SAVE_YES_BOX
    yes = float(np.asarray(gray, dtype=np.float32)[y0:y1, x0:x1].max()) > LOGIN_SAVE_TICK_MIN
    y0, y1, x0, x1 = LOGIN_SAVE_NO_BOX
    no = float(np.asarray(gray, dtype=np.float32)[y0:y1, x0:x1].max()) > LOGIN_SAVE_TICK_MIN
    if yes == no:
        return None
    return "yes" if yes else "no"


def set_save_password(sh):
    """Fix wave W10: tick SAVE PASSWORD = YES on the CONNECT TO SOCOM II form, from the PASSWORD row (the password
    keyboard just closed). DOWN to the row, verified lit; then, while the tick is not on YES, LEFT and then CROSS,
    each read back -- which of the two the widget answers to has not been observed, so both are tried and the
    frame decides. Leaves the cursor ON the SAVE PASSWORD row: the caller's walk to CONNECT is one DOWN shorter."""
    press_verified(sh, f"{CLASS_SAVE_TICK}:row", "down", 1.0,
                   lambda g: lobby_row_lit(g, "save_password"), "the SAVE PASSWORD row lit")
    state = login_save_password(lobby_gray(sh))
    sh.log(f"[login] save password: reads {state} before any press")
    for btn in ("left", "cross"):
        if state == "yes":
            break
        sh.press(btn, 1.0)
        state = login_save_password(lobby_gray(sh))
        sh.log(f"[login] save password: reads {state} after {btn}")
    sh.shot("05_save_password")
    if state != "yes":
        raise lobby_fail(sh, f"{CLASS_SAVE_TICK}:tick",
                         f"SAVE PASSWORD did not read YES after LEFT and CROSS (reads {state})")


def lobby_notice_up(gray):
    return float(gray[LOBBY_NOTICE].mean()) > LOBBY_NOTICE_MIN_MEAN


def menu_row_median(gray, row):
    y0, y1, x0, x1 = MENU_ROWS[row]
    return float(np.median(gray[y0:y1, x0:x1]))


def menu_online_lit(gray):
    """The main menu with ONLINE highlighted: its row's text core lit, NEW GAME's and LAN's dim (a transition or a
    bright frame lights all three; the login screen lights none)."""
    return (menu_row_median(gray, "online") > MENU_ROW_LIT_MEDIAN
            and menu_row_median(gray, "new_game") <= MENU_ROW_LIT_MEDIAN
            and menu_row_median(gray, "lan") <= MENU_ROW_LIT_MEDIAN)


def menu_rows_detail(gray):
    return "row medians " + ", ".join(f"{r.replace('_', ' ')} {menu_row_median(gray, r):.0f}" for r in MENU_ROWS)


def frame_diff(pre, post):
    """Mean |difference| of two grey frames (0 for the same static screen)."""
    return float(np.abs(post - pre).mean())


def press_verified(sh, step, btn, wait, check, what):
    """Press `btn`, wait, and verify `check(gray)` on a fresh frame; re-send through the pad up to
    LOBBY_RESEND_MAX times; LobbyFail(step) if the expected screen never appears. One log line per press:
    `[lobby] <step> press=<btn> verified=<bool> attempt=<n>`. Returns the number of re-sends it took.

    The whole CREATE GAME / JOIN GAME flow used to be blind fixed presses, and one eaten press derailed
    the rest silently: wtb3 and kill6 lost the CROSS into CREATE GAME and typed the game name into the
    briefing room; kill4, kill7 and 8b lost the ACCEPT and created nothing; launch1/1b's JOIN never
    entered the lobby -- each classified at the end of the stage (or 500 s later on liveness) with no
    press named. research/28 §4 puts these first at 9 of 16 failures."""
    n = [0]

    def send():
        n[0] += 1
        if n[0] == 1:
            sh.press(btn, wait)
        else:
            lobby_resend(sh, btn, wait)

    def dropped():
        ok = bool(check(lobby_gray(sh)))
        sh.log(f"[lobby] {step} press={btn} verified={ok} attempt={n[0]}")
        if not ok:
            # Sprint 10 Goal 3: the frame the check refused, kept -- a verifier that misses a screen it should
            # know (the console joiner's GAME LOBBY, leg 1, 2026-09-20: four misses, the round then ran) can only
            # be calibrated from what it saw, and a re-send that lands on a screen the check did not recognise
            # presses on into it.
            sh.shot(f"miss_{step.replace(':', '_')}_{n[0]}")
        return not ok

    send()
    try:
        return verify_resend(sh, step, dropped, send)
    except LobbyFail as e:
        # Only this step's own exhaustion gets this sentence. A check may classify something else on the frame it
        # was handed (join_list_check's `join:cursor-drift`), and that failure carries its own explanation.
        if e.cls == step:
            e.detail = f"{what} never showed after {btn.upper()} and {LOBBY_RESEND_MAX} re-sends -- see the capture"
        raise


class Shell:
    stages = ()                  # active lobby stages ((name, deadline), ...), outermost first
    clock = staticmethod(time.time)
    lobby_role = "host"          # "joiner" once join_game ran: names the teams-unbalanced class in ready()
    # Sprint 10 Goal 3: which window this shell drives -- the keys map (keys.MAPS) and the on-screen keyboard's
    # pacing come from it. "ours" here; tools_py.parity.pcsx2_shell.Pcsx2Shell says "pcsx2" and inherits every
    # verified step, so the console side of the mixed match presses on what its screen shows, as ours does.
    target = T
    press_hold_s = 0.08          # 5 frames at the shell's 60 fps (below); PCSX2's shell wants 0.15

    def check_stage(self):
        # s6_ladder10/11: a resized game window breaks every fixed-box detector; put it back before any press or read.
        if winshot.ensure_client_size(self.hwnd):
            self.log("[window] client area was not 640x448 -- restored")
        now = self.clock() if self.stages else None
        for name, deadline in self.stages:
            if now >= deadline:
                raise lobby_fail(self, f"timeout:{name}", f"stage {name} exceeded {LOBBY_STAGE_TIMEOUT_S:.0f}s")

    def stage_sleep(self, seconds):
        """time.sleep, cut at the active stage deadline (the check then raises)."""
        if self.stages:
            seconds = max(0.0, min(seconds, min(d for _, d in self.stages) - self.clock()))
        time.sleep(seconds)
        self.check_stage()

    def __init__(self, hwnd, out, t0, tag="", pad_file=None):
        self.hwnd, self.out, self.t0, self.tag = hwnd, out, t0, tag
        self.pad_file = pad_file
        self.meta = json.load(open(os.path.join(REFS, "refs.json")))
        self.refs = {n: np.asarray(Image.open(os.path.join(REFS, n + ".png")).convert("L"), dtype=float) for n in self.meta}
        self.menu = Image.open(os.path.join(REFS, "main_menu.png"))
        self.last = None

    def log(self, m):
        print(f"{time.time() - self.t0:6.1f}s {self.tag}{m}", flush=True)

    def shot(self, label, max_age=None):
        """Save the current frame. max_age (s): refuse a frame file older than that --
        winshot.StaleFrameError, which evidence screens (kill, final) use; menus pass none."""
        winshot.grab(self.hwnd, max_age=max_age).save(os.path.join(self.out, f"{self.tag}{label}.png"))

    def press(self, b, wait=1.0):
        """One button press, POSTED as a key even when a pad file exists. The pad file was tried for every press
        on 2026-09-15 (posted keys drop about one press in twenty when the window thread does not pump), and
        s6_ladder10 answered it: three DOWN presses through the pad file left NEW GAME lit on the main menu (row
        medians new game 70, online 34, lan 28) while posted arrows moved that cursor in every earlier launch --
        the shell menus do not read a 0.09 s pad-file press. The OSK walks and holds keep the pad file (they do
        register there); menu drops are caught by the verified steps that re-send.

        0.08 s = 5 frames at the shell's 60 fps: long enough to register, short enough not to trip the UI's
        held-button repeat (a 0.15 s CROSS closed the SERVER NEWS popup and the repeat reopened it, eight times
        in a row, 2026-09-09 play4)."""
        self.check_stage()
        keys.press(self.hwnd, b, self.target, hold_s=self.press_hold_s)
        self.stage_sleep(wait)

    def hold(self, b, seconds, wait=0.3):
        """Hold a key (stick directions W/A/S/D, I/J/K/L; R1 fire) for `seconds`. With a pad file the
        state is injected (exact, never dropped); otherwise a posted keyboard hold."""
        if self.pad_file:
            self.pad(seconds, [b] if b.upper() in PAD_BUTTON else (), [b] if b.upper() in PAD_AXIS else ())
        else:
            keys.press(self.hwnd, b, self.target, hold_s=seconds)
        time.sleep(wait)

    def pad_press(self, b, wait=0.35, hold_s=0.09):
        """One button press through the INJECTED pad file. Posted WM_KEY messages reach raylib only
        when the window thread pumps, so a press in a long scripted burst can be dropped (STATUS
        2026-09-10 20:10) -- which is how a game-name ended up as "eq4P--" in one run and as "test;"
        with the keyboard left open in another, both of which cost a whole 12-minute match.

        0.09 s is ~5-6 frames at the shell's 60 fps: long enough for the pad poll to see it, short
        enough to stay under the keyboard's auto-repeat (0.15 s / 9 frames overshoots the cursor).
        """
        self.check_stage()
        if not self.pad_file:
            # Sprint 10 Goal 3: a shell with no injected pad (the console's) presses the same button as a posted
            # key at the press hold its target wants -- choose_map's walk crashed the console host on the pad
            # file's None path (leg 2c) after every earlier step had gone through press().
            keys.press(self.hwnd, b, self.target, hold_s=self.press_hold_s)
            self.stage_sleep(wait)
            return
        write_pad_file(self.pad_file, [b])
        try:
            self.stage_sleep(hold_s)
        finally:
            write_pad_file(self.pad_file)          # a deadline inside the hold must not leave the button down
        self.stage_sleep(wait)

    def pad(self, seconds, buttons=(), sticks=(), axes=None, abort=None):
        """Inject buttons (names), stick directions (W/A/S/D, I/J/K/L, full deflection) and explicit
        0-255 `axes` ({rx, ry, lx, ly}: partial deflection, overriding a stick on the same axis)
        together for `seconds`, then write neutral.

        `abort` (a threading.Event) releases the pad the moment it is set instead of at the end of
        the hold. The two-mover approach passes the duel's contact flag: a player still walking
        after the OTHER side has called contact overshoots the engagement, which is the geometry
        problem the whole of Task 8 was fighting."""
        axes = pad_axes(sticks, axes)
        write_pad_file(self.pad_file, buttons, axes)
        try:
            if abort is None:
                time.sleep(seconds)
            else:
                abort.wait(seconds)
        finally:
            write_pad_file(self.pad_file)        # an interrupted hold must not leave a stick held (slice (b) review)

    def diff(self, name, im=None, arr=None):
        """Normalised, shift-tolerant distance of the screen's reference band: both crops are
        brightness/contrast-normalised (the 2026-09-09 renderer draws the UI a little darker and
        ~8 px left of the references, which put the raw score at 22 against an 8 threshold), and
        the best offset within +-12 px horizontally / +-3 px vertically counts. Correct screens
        score 0.37-0.44, wrong ones 0.45+ (measured on logs/parity/ours_match_play1)."""
        if arr is None:
            full = (im or winshot.grab(self.hwnd)).convert("L").resize((320, 224))
            arr = np.asarray(full, dtype=float)
        x0, y0, x1, y1 = self.meta[name]["box"]
        best = 1e9
        # The prompt notices are also drawn a few percent narrower than the references: try a
        # few horizontal scales of the reference band (0.61 -> 0.44 on the write-down notice).
        for ref in self.ref_scales(name):
            rn = (ref - ref.mean()) / (ref.std() + 1e-6)
            for dy in range(-6, 7):
                for dx in range(-20, 21):
                    ax0, ay0 = x0 + dx, y0 + dy
                    if ax0 < 0 or ay0 < 0 or ax0 + ref.shape[1] > arr.shape[1] or ay0 + ref.shape[0] > arr.shape[0]:
                        continue
                    c = arr[ay0:ay0 + ref.shape[0], ax0:ax0 + ref.shape[1]]
                    if c.std() < 2.0:
                        continue
                    d = float(abs((c - c.mean()) / (c.std() + 1e-6) - rn).mean())
                    if d < best:
                        best = d
        return best

    def ref_scales(self, name):
        if not hasattr(self, "_scaled"):
            self._scaled = {}
        if name not in self._scaled:
            im = Image.open(os.path.join(REFS, name + ".png")).convert("L")
            out = []
            for sc in (0.90, 0.93, 0.96, 1.0, 1.04):
                w = max(4, int(round(im.size[0] * sc)))
                out.append(np.asarray(im.resize((w, im.size[1])), dtype=float))
            self._scaled[name] = out
        return self._scaled[name]

    PROMPT_THRESH = {"write_down": 0.5, "save_card": 0.5, "card_slot": 0.5}

    def is_screen(self, name, thresh=None):
        self.check_stage()
        if name == "main_menu":
            return score(self.menu, winshot.grab(self.hwnd))["score"] >= (thresh or 90.0)
        arr = np.asarray(winshot.grab(self.hwnd).convert("L").resize((320, 224)), dtype=float)
        d = self.diff(name, arr=arr)
        if d > self.PROMPT_THRESH.get(name, 0.45):
            return False
        # Among the references sharing this band, this screen must also be the best match.
        box = tuple(self.meta[name]["box"])
        for other in self.meta:
            if other != name and tuple(self.meta[other]["box"]) == box and self.diff(other, arr=arr) < d:
                return False
        return True

    def wait_for(self, name, timeout, thresh=None, cls=None, required=True):
        """Wait for screen `name`. A timeout is a classified lobby failure (`cls`, default
        `screen:<name>`): research/28 §4 rank 2 -- it used to log `TIMEOUT waiting for <name>` and return
        False, and every caller pressed on into whatever was on screen (wtb4, 3b, ladder1), so the class
        finally raised named a screen 120-180 s downstream of the miss. `required=False` keeps the old
        log-and-return for the one screen whose reference is known to miss on good runs."""
        if self.screen_within(name, timeout, thresh):
            return True
        if not required:
            return False
        raise lobby_fail(self, cls or f"screen:{name}", f"{name} not on screen within {timeout:.0f}s")

    def screen_within(self, name, timeout, thresh=None):
        """True when screen `name` shows within `timeout` s (polled every 0.5 s); False, logged and captured as
        `timeout_<name>`, when it does not. No class: the caller decides (wait_for fails the run, press_online
        re-sends the CROSS while the menu still shows ONLINE lit)."""
        t = self.clock()
        while self.clock() - t < timeout:
            if self.is_screen(name, thresh):
                self.log(f"screen {name} after {self.clock() - t:.1f}s")
                return True
            time.sleep(0.5)
        self.log(f"TIMEOUT waiting for {name}")
        self.shot(f"timeout_{name}")
        return False

    def press_until_gone(self, b, name, tries=8, wait=3.0, thresh=None):
        """Press `b` until `name` is no longer on screen. "Gone" needs two checks 0.6 s apart:
        a single frame can miss (a fade or a transient overlay), which skipped the press that
        connects to the universe on instance B (2026-09-09, play4)."""
        for i in range(tries):
            if not self.is_screen(name, thresh):
                time.sleep(0.6)
                if not self.is_screen(name, thresh):
                    self.log(f"{name} gone after {i} {b}")
                    return True
            self.press(b, wait)
        return False

    def osk_refs(self):
        """Distance of the accent-toggle key to the two references: which mode the on-screen
        keyboard is in, and (by both distances being large) whether it is on screen at all."""
        self.check_stage()
        return osk_ref_dists(lobby_gray_of(winshot.grab(self.hwnd)))

    # Measured on logs/parity/ours_task7_cal1 (keyboard up: 39.0/43.1 and 6.3/0.0) against the
    # screens behind it (keyboard gone: 59.9 and 74.1). Only used to LOG whether a type() left the
    # keyboard open, so a run that flakes says so in its own drive log instead of silently
    # spending twelve minutes driving a keyboard.
    OSK_OPEN_MAX = 50.0

    def osk_open(self):
        return min(self.osk_refs()) < self.OSK_OPEN_MAX

    OSK_MODE_TOGGLES = 2

    def osk_normal_mode(self):
        """Toggle the keyboard out of accent mode, and READ THE MODE BACK on a fresh frame after each toggle:
        the 2026-09-15 old-harness run toggled once, blind, and typed 'xmfû' for 'socom'. At most two toggles
        (a third would be a dropped press or a mode the references do not know); the mode is logged each read."""
        dn, da = self.osk_refs()
        for toggle in range(self.OSK_MODE_TOGGLES + 1):
            if dn <= da:
                self.log(f"[osk] mode normal ({dn:.1f} vs {da:.1f})")
                return
            if toggle == self.OSK_MODE_TOGGLES:
                self.log(f"[osk] mode accent ({dn:.1f} vs {da:.1f}) after {toggle} toggles -- typing anyway")
                return
            self.log(f"[osk] mode accent ({dn:.1f} vs {da:.1f}) -> toggling" + (" again" if toggle else ""))
            if self.pad_file:
                self.pad_press("CROSS", 0.8)
            else:
                self.press("cross", 0.8)
            dn, da = osk_ref_dists(lobby_gray(self))          # a frame rendered after the press

    def wait_osk(self, timeout=12.0, reopen=True):
        """Wait for the on-screen keyboard to actually be on screen before typing into it.

        Without this the harness types blind: in ours_task7_wtb3 the CROSS that enters CREATE GAME
        landed a screen late, so the CROSS meant to open the game-name keyboard entered CREATE GAME
        instead, and `type("test")` then hammered the CREATE GAME menu -- it changed ROUND COUNT to
        1 and ROUND TIME to 20 minutes, left GAME NAME empty, and the lobby refused to create the
        game ("You must create a playlist before game creation can occur"). Twelve minutes, and
        nothing in any log said what had happened.
        """
        def tap(b, wait):
            if self.pad_file:
                self.pad_press(b.upper(), wait)
            else:
                self.press(b, wait)

        # Escalate in bounded steps: one more CROSS (the press that should have opened it was
        # eaten by a transition), then BACK + CROSS (an unexpected screen is in the way -- in
        # ours_task7_wtb4 a "SELECT A CONTROLLER CONFIGURATION" screen appeared mid-login and
        # swallowed both persona presses). Then give up, loudly, with a screenshot.
        for attempt, recovery in enumerate(([], ["cross"], ["triangle", "cross"])[:1 + (2 if reopen else 0)]):
            for b in recovery:
                tap(b, 2.0)
            if recovery:
                self.log(f"on-screen keyboard not up -> tried {'+'.join(recovery).upper()}")
            t = time.time()
            while time.time() - t < timeout:
                if self.osk_open():
                    if attempt:
                        self.log(f"on-screen keyboard up after recovery {attempt}")
                    return True
                time.sleep(0.5)
            self.log(f"on-screen keyboard still not up after {timeout:.0f}s "
                     f"(accent-box distance {self.osk_refs()})")
        return False

    def type(self, text, shots=None, tag="", prefilled=False):
        if not self.wait_osk():
            self.shot("osk_never_opened")
            stage = self.stages[-1][0] if self.stages else "none"
            raise lobby_fail(self, CLASS_KEYBOARD, f"on-screen keyboard never opened for {text!r} (stage {stage}): "
                                                   f"refusing to type into whatever menu is on screen")
        self.osk_normal_mode()
        if prefilled:
            self.osk_enter_prefilled(text)                       # Sprint 10 Goal 9: the runtime typed it; ENTER only
            return
        if self.pad_file:
            self.osk_type_pad_verified(text, shots, tag)     # reads the field and the ENTER back; fails with a class
            return
        osk_type(self.hwnd, text, shots, tag, target=self.target)
        time.sleep(OSK_ENTER_SETTLE_S)
        if self.osk_open():                                  # the posted-keys path has no cursor to re-walk from
            self.log(f"WARNING: the on-screen keyboard is still up after typing {text!r} through posted keys "
                     f"(accent-box distance {self.osk_refs()}) -- the presses after this one go to "
                     f"the keyboard, not to the menu")

    @staticmethod
    def osk_pacing(slow):
        """(hold, d-pad wait, CROSS wait) of a pad keyboard press: the 0.09 s / 0.35 s / 0.6 s of pad_press, or
        the doubled OSK_SLOW_* for a retype (the same 5-6 frames at the 32 fps two instances on one host run at);
        the CROSS wait stays 0.6 s, already the longer of the two."""
        return (OSK_SLOW_HOLD_S, OSK_SLOW_WAIT_S, OSK_CROSS_WAIT_S) if slow else (0.09, 0.35, OSK_CROSS_WAIT_S)

    def osk_type_pad(self, text, shots=None, tag="", cur=OSK_START, enter=True, slow=False):
        """Type on the on-screen keyboard through the injected pad file rather than posted keys:
        the cursor walk is dead-reckoned from `cur` (the key the cursor is on), so a single dropped
        press mistypes every character after it and, on the last one, presses the key next to ENTER
        instead of ENTER. `enter=False` leaves the field open (the verified typer reads it back first);
        `slow` uses the OSK_SLOW_* pacing for a retype. Returns the key the cursor is on."""
        hold, wait, cross_wait = self.osk_pacing(slow)
        for n, ch in enumerate(list(text) + (["ENTER"] if enter else [])):
            dst = osk_pos(ch)
            for m in osk_moves(cur, dst):
                self.pad_press(m.upper(), wait, hold)
            cur = dst
            self.pad_press("CROSS", cross_wait, hold)
            if shots and ch != "ENTER":
                winshot.grab(self.hwnd).save(os.path.join(shots, f"{tag}_key{n}_{ch}.png"))
        return cur

    def osk_typed(self):
        """Characters in the keyboard's text row, read from a frame rendered after the last press."""
        return osk_typed_count(lobby_gray(self))

    def osk_type_pad_verified(self, text, shots=None, tag=""):
        """Type `text` through the pad WITHOUT the final ENTER, read back how many characters the keyboard
        shows, and only press ENTER when the count matches. A short count (a CROSS dropped at 32 fps: 'ocom',
        an empty field on 2026-09-15) is cleared with one BCKSPC per counted character and retyped at the
        slow pacing; after OSK_TYPE_ATTEMPTS the run fails as login:keyboard-typing with the count in the
        detail, instead of pressing CONNECT with a wrong password and timing out 120 s later on the login
        stage. The cursor stays dead-reckoned between attempts (there is no cursor read-back); the count
        cannot tell a wrong glyph of the right length ('xmfû' is accent mode, which osk_normal_mode guards)."""
        cur, slow = OSK_START, False
        for attempt in range(1, OSK_TYPE_ATTEMPTS + 1):
            cur = self.osk_type_pad(text, shots, tag, cur=cur, enter=False, slow=slow)
            n = self.osk_typed()
            if n == len(text):
                self.log(f"[osk] typed {n} of {len(text)} (attempt {attempt})")
                break
            if attempt == OSK_TYPE_ATTEMPTS:
                self.log(f"[osk] typed {n} of {len(text)} (attempt {attempt})")
                raise lobby_fail(self, CLASS_OSK_TYPING, f"{n} of {len(text)} characters after {attempt} attempts")
            self.log(f"[osk] typed {n} of {len(text)} -> retype (attempt {attempt})")
            slow = True
            cur = self.osk_clear(cur, n, len(text), slow=slow)
        cur = self.osk_type_pad("", None, "", cur=cur, enter=True, slow=slow)    # the walk to ENTER and its CROSS
        self.osk_enter_verified(text, cur)

    def osk_enter_prefilled(self, text):
        """Sprint 10 Goal 9 (--prefilled): the keyboard opened already holding `text` -- the runtime's prefill from
        PS2X_SOCOM2_LOGIN_NAME / _PASS (research/38) -- so read the count back and, only on a match, walk to ENTER
        from the opening cursor (OSK_START, as a fresh keyboard's) and press it, read back like a typed ENTER
        (osk_enter_verified: a lost step is re-pressed). Nothing is typed here (R180: the harness presses, the
        runtime never submits). A count that is not len(text) -- the exe predates the prefill, the variable never
        reached it, or another keyboard opened -- is login:prefill-missing with the count in the detail: typing on
        top of a prefilled field would double it, and ENTER on an empty one puts CONNECT 120 s from a timeout."""
        n = self.osk_typed()
        if n != len(text):
            self.log(f"[osk] prefilled: {n} of {len(text)} in the field")
            raise lobby_fail(self, CLASS_OSK_PREFILL, f"{n} of {len(text)} characters in the field before ENTER "
                                                      f"(the runtime's prefill did not reach this keyboard?)")
        self.log(f"[osk] prefilled: {n} of {len(text)} in the field -> ENTER")
        cur = self.osk_press_key(OSK_START, "ENTER", slow=False)
        self.osk_enter_verified(text, cur)

    def osk_press_key(self, cur, label, slow=True):
        """Walk the cursor from `cur` to the key `label` and press it. Returns the key's position."""
        hold, wait, cross_wait = self.osk_pacing(slow)
        dst = osk_pos(label)
        for m in osk_moves(cur, dst):
            self.pad_press(m.upper(), wait, hold)
        self.pad_press("CROSS", cross_wait, hold)
        return dst

    def osk_enter_verified(self, text, cur):
        """Read the keyboard back after the ENTER press (s6_ladder6 B: the walk to ENTER lost a step at ~59 fps, the
        old code logged a WARNING and the DOWNs meant for CONNECT went to the keyboard until the stage timed out).
        While the keyboard is still up, re-press ENTER from the dead-reckoned cursor at the slow pacing, at most
        OSK_ENTER_RETRIES times; when the field now holds len(text)+1 characters the dropped step was a d-pad move
        and the CROSS typed the key beside ENTER, so BCKSPC once first (the walk to BCKSPC ends on it from ENTER or
        from its left neighbour alike: rows 0-1 are longer than row 3). Still up after that: login:keyboard-enter."""
        self.stage_sleep(OSK_ENTER_SETTLE_S)
        for attempt in range(1, OSK_ENTER_RETRIES + 2):
            gray = lobby_gray(self)
            if not osk_open_of(gray):
                done = attempt - 1
                self.log("[osk] enter: keyboard closed" + (f" after {done} re-press{'es' if done > 1 else ''}" if done else ""))
                return
            n = osk_typed_count(gray)
            if attempt > OSK_ENTER_RETRIES:
                raise lobby_fail(self, CLASS_OSK_ENTER, f"keyboard still up after ENTER and {OSK_ENTER_RETRIES} re-presses "
                                                        f"({n} of {len(text)} characters)")
            if n == len(text) + 1:
                self.log(f"[osk] enter: keyboard still up, {n} of {len(text)} characters -> BCKSPC, re-press (attempt {attempt})")
                cur = self.osk_press_key(cur, "BCKSPC")
            else:
                self.log(f"[osk] enter: keyboard still up -> re-press (attempt {attempt})")
            cur = self.osk_press_key(cur, "ENTER")
            self.stage_sleep(OSK_ENTER_SETTLE_S)

    def osk_clear(self, cur, n, total, slow=True):
        """Walk to BCKSPC (top row, right end) and press it once per counted character, then read the field
        back: a count still above 0 gets that many more presses, once (a dropped BCKSPC); characters left
        after that fail the run as login:keyboard-typing. Returns the key the cursor is on (BCKSPC)."""
        hold, wait, cross_wait = self.osk_pacing(slow)
        dst = osk_pos("BCKSPC")
        for m in osk_moves(cur, dst):
            self.pad_press(m.upper(), wait, hold)
        for extra in (False, True):
            for _ in range(n):
                self.pad_press("CROSS", cross_wait, hold)
            left = self.osk_typed()
            if left == 0:
                self.log(f"[osk] cleared: 0 of {total} left")
                return dst
            if extra:
                raise lobby_fail(self, CLASS_OSK_TYPING, f"{left} of {total} characters still in the field after clearing")
            self.log(f"[osk] cleared: {left} of {total} left -> {left} more BCKSPC")
            n = left
        return dst


@functools.lru_cache(maxsize=None)
def osk_mode_refs():
    normal = np.asarray(Image.open(os.path.join("scripts", "parity", "ref_osk_normal.png")).convert("L"), dtype=np.float32)
    accent = np.asarray(Image.open(os.path.join("scripts", "parity", "ref_osk_accent.png")).convert("L"), dtype=np.float32)
    return normal, accent


def osk_ref_dists(gray):
    """(distance to the normal-mode key, distance to the accent-mode key) of a full frame's accent box."""
    x0, y0, x1, y1 = OSK_ACCENT_BOX
    cur = gray[y0:y1, x0:x1]
    normal, accent = osk_mode_refs()
    return float(np.abs(cur - normal).mean()), float(np.abs(cur - accent).mean())


def osk_open_of(gray):
    return min(osk_ref_dists(gray)) < Shell.OSK_OPEN_MAX


def osk_title_edge(gray):
    """Rightmost column of the keyboard panel's title text, or None when the band holds no bright text."""
    y0, y1, x0, x1 = OSK_TITLE
    cols = np.where((np.asarray(gray, dtype=np.float32)[y0:y1, x0:x1] > OSK_TITLE_LUMA).any(axis=0))[0]
    return int(cols.max()) + x0 if len(cols) else None


def osk_title_is_name(gray):
    """The open keyboard is "Enter Player Name" (edge 163) rather than "Enter Player Password" (195)."""
    edge = osk_title_edge(gray)
    return edge is not None and edge <= OSK_TITLE_NAME_MAX_EDGE


def osk_typed_count(gray):
    """Characters in the on-screen keyboard's text row of a full 640x448 grey frame."""
    return glyph_run_count(gray, (OSK_TEXT_ROWS[0], OSK_TEXT_ROWS[1], OSK_TEXT_COLS[0], OSK_TEXT_COLS[1]))


def glyph_run_count(gray, box, ink_min=OSK_INK_MIN):
    """Characters written in a (y0, y1, x0, x1) band of a full 640x448 grey frame: the number of runs of
    glyph columns (max between `ink_min` and OSK_CURSOR_MIN, at least OSK_GLYPH_MIN_WIDTH wide, separated by
    a column with no ink). The blinking white cursor block is not a glyph, so an empty field reads 0 whether
    or not its cursor is on. A space has no ink and is not counted (no harness text carries one).

    Written for the keyboard's text row (OSK_TEXT_ROWS/COLS) and reused unchanged, band and all thresholds,
    for the form's PLAYER NAME value strip (LOGIN_NAME_VALUE) -- the same font on the same ground. The PASSWORD
    strip (W10) passes its own, higher `ink_min`: its lit row spills into the strip."""
    y0, y1, x0, x1 = box
    colmax = np.asarray(gray, dtype=np.float32)[y0:y1, x0:x1].max(axis=0)
    ink, glyph = colmax > ink_min, (colmax > ink_min) & (colmax <= OSK_CURSOR_MIN)
    count, x = 0, 0
    while x < len(ink):
        if not ink[x]:
            x += 1
            continue
        start = x
        while x < len(ink) and ink[x]:
            x += 1
        run = glyph[start:x]
        if run.all() and x - start >= OSK_GLYPH_MIN_WIDTH:      # a run touching a white column is the cursor
            count += 1
    return count


# ---------------------------------------------------------------------------
# Sprint 13 O2 (#26): the chat step.
# ---------------------------------------------------------------------------
# The chat box is opened by R1. Both rooms say so on screen: the BRIEFING ROOM's button bar reads "R1 TEXT CHAT"
# (s11_chat_A/11_briefing_room.png) and the GAME LOBBY's chat panel "R1 Text chat.  L1 and L2 to scroll chat"
# (s11_chat_A/17_game_lobby_ok.png) -- the disc's _518_TextChat_MSG and _343_TextChat_MSG. chain7's `type:hello`
# (R246) waited for a keyboard nothing had opened, and its recovery pressed CROSS and TRIANGLE+CROSS, never R1.
# R1 is a Full-scope key of the host keyboard (socom2_host_input.cpp, Q3): a PS2X_DEV launch -- every harness
# launch -- posts it as 'E'.
#
# The keyboard R1 opens is the UI's GetTextInput with Purpose _361_EnterChatMessage_MSG ("Enter a Chat Message") on
# the soft keyboard ChatSkb (the game lobby, s13_o2_chat round 1; the disc's UI scripts also name PlayerChatSkb --
# research/66). Its layout is not the login keyboards' (CHAT_OSK_* below), so the login's screen references
# (OSK_ACCENT_BOX, the text row) are not used on it: the open is read from the runtime's OSK wrap, which prints one
# `[socom2] on-screen keyboard open: purpose="..." skb="..."` line per open once --prefilled has armed it, and the
# close from the keyboard's key band.
CHAT_PURPOSE = "_361_EnterChatMessage_MSG"
CHAT_OPEN_BUTTON = "r1"
CHAT_OPEN_TIMEOUT_S = 12.0
CHAT_OPEN_PRESSES = 2
OSK_OPEN_LINE_RE = re.compile(r'\[socom2\] on-screen keyboard open: purpose="([^"]*)" skb="([^"]*)"')
# The chat receive wrap's line (game_overrides_socom2.cpp BoundWrapLog::note): the first call always prints, later
# ones only when they changed a field -- so `seen=1` is the first forwarded line the client took, and a second
# plain one prints nothing.
CHAT_SEEN_RE = re.compile(r"\[socom2\] chat receive bound: seen=(\d+) fixed=(\d+) skipped=(\d+)")
CHAT_SEEN_BYTES_RE = re.compile(CHAT_SEEN_RE.pattern.encode("ascii"))
CHAT_ROOM_TITLES = ("game_lobby", "briefing_room")
# The chat keyboard's layout, measured in round 1 (research/66 section 3): OSK_ROWS plus one row below (the accent
# toggle, the space bar, MESSAGE, IGNORE, LEGEND), opening on that row's accent key -- (6, 0) in OSK_ROWS' terms.
# RIGHT then UP lands on TEAM, (5, 1) in both grids; the walk is dead-reckoned from there.
CHAT_OSK_ENTRY = ("right", "up")
CHAT_OSK_ENTRY_KEY = (5, 1)
CHAT_OSK_KEYS_BAND = (268, 290, 25, 465)      # the keyboard's top key row (~ ! @ ... BCKSPC), y0 y1 x0 x1
CHAT_OSK_KEYS_STD_MIN = 20.0                  # up: 32.8-33.4; the game lobby 5.3, the briefing room 8.3


def osk_opens(text):
    """[(purpose, skb)] of every keyboard the OSK wrap reported opening in `text`, in order."""
    return OSK_OPEN_LINE_RE.findall(text or "")


def chat_seen_lines(text, base=0):
    """[(byte offset, seen, fixed, skipped)] of the chat receive wrap's count lines in `text` (a log read from byte
    `base` on; offsets are the log's, so a line can be placed before or after a mark)."""
    raw = text if isinstance(text, bytes) else (text or "").encode("utf-8", errors="replace")
    return [(base + m.start(), int(m.group(1)), int(m.group(2)), int(m.group(3)))
            for m in CHAT_SEEN_BYTES_RE.finditer(raw)]


def log_size(path):
    """Bytes in `path` now (0 when it does not exist yet): the mark a later read starts from."""
    try:
        return os.path.getsize(path) if path else 0
    except OSError:
        return 0


def read_log_bytes(path, offset):
    """The bytes of `path` from byte `offset` (b'' when unreadable)."""
    try:
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read()
    except (OSError, TypeError):
        return b""


def read_log_from(path, offset):
    """The text of `path` from byte `offset` ('' when unreadable)."""
    return read_log_bytes(path, offset).decode("utf-8", errors="replace")


def chat_room_title(sh):
    """Which chat room's title the frame shows ('game_lobby' / 'briefing_room'), or None. NOT a keyboard read: the
    chat keyboard is a panel over the room's lower two thirds, and the title band stays visible above it (round 1,
    research/66 section 3) -- chat_keyboard_up is the read."""
    gray = lobby_gray(sh)
    for name in CHAT_ROOM_TITLES:
        if lobby_title_is(gray, name):
            return name
    return None


def chat_keyboard_up_of(gray):
    """The chat keyboard is on screen: its top key row (~ ! @ ... BCKSPC) is a band of light keys on dark gaps, a
    column-to-column spread the rooms behind it never have. Measured on s13_o2_chat round 1: std 32.8-33.4 with the
    keyboard up (four frames, both instances), 5.3 on the game lobby and 8.3 on the briefing room without it."""
    y0, y1, x0, x1 = CHAT_OSK_KEYS_BAND
    return float(np.asarray(gray, dtype=np.float32)[y0:y1, x0:x1].std()) > CHAT_OSK_KEYS_STD_MIN


def chat_keyboard_up(sh):
    return chat_keyboard_up_of(lobby_gray(sh))


def chat_line(sh, text, run_log=None, open_timeout=CHAT_OPEN_TIMEOUT_S, presses=CHAT_OPEN_PRESSES):
    """Open the chat box with R1 in the room on screen, type `text` on its keyboard and ENTER it.

    Returns a dict: opened (bool), by ('log' | 'screen' | None), skb, room (the title before the press), closed (the
    keyboard gone after ENTER, chat_keyboard_up), exited (the keyboard had to be left through EXIT: nothing sent),
    mark (the run log's size before the press). Never raises for the chat itself -- a keyboard that does not open is
    the finding, logged as `CHAT keyboard not opened`, and the round goes on to the peek.

    The typing is the login's dead-reckoned pad walk at the slow pacing (two instances on one host), from the chat
    keyboard's own opening key: it is the login grid (OSK_ROWS) with one more row below it (the accent toggle, the
    space bar, MESSAGE, IGNORE, LEGEND) and it opens on that row's accent key, one row below the login's OSK_START
    -- round 1 typed 'nd..l' for 'hello' and pressed SHIFT for ENTER, exactly the walk shifted one row down (and
    wrapping right off EXIT). CHAT_OSK_ENTRY (RIGHT onto the space bar, UP onto TEAM) puts the cursor on a key both
    grids share. ENTER not taking is re-pressed once; a keyboard still up after that is left through EXIT so the
    round can go on to READY (round 1's keyboard stayed up and READY's cursor read failed behind it)."""
    rec = {"text": text, "opened": False, "by": None, "skb": None, "closed": False, "exited": False,
           "mark": log_size(run_log)}
    rec["room"] = chat_room_title(sh)
    sh.shot("chat_00_before")
    sh.log(f"CHAT open: {CHAT_OPEN_BUTTON.upper()} in the {rec['room'] or 'unrecognised room'} "
           f"(run log mark {rec['mark']})")
    for attempt in range(1, presses + 1):
        sh.press(CHAT_OPEN_BUTTON, 1.0)
        t = time.time()
        while time.time() - t < open_timeout:
            chats = [o for o in osk_opens(read_log_from(run_log, rec["mark"])) if o[0] == CHAT_PURPOSE] if run_log else []
            if chats:
                rec.update(opened=True, by="log", skb=chats[-1][1])
                break
            if chat_keyboard_up(sh):
                rec.update(opened=True, by="screen")
                break
            time.sleep(0.5)
        if rec["opened"]:
            break
        sh.log(f"CHAT keyboard not up after {CHAT_OPEN_BUTTON.upper()} press {attempt} ({open_timeout:.0f}s)")
    time.sleep(1.0)                                  # the panel's slide-in, before the first walk press
    sh.shot("chat_01_open")
    if not rec["opened"]:
        sh.log(f"CHAT keyboard not opened after {presses} {CHAT_OPEN_BUTTON.upper()} presses "
               f"(no {CHAT_PURPOSE} open line, keys band not up)")
        return rec
    sh.log(f"CHAT keyboard open by {rec['by']} (skb {rec['skb']})")
    hold, wait, _ = sh.osk_pacing(True)
    for m in CHAT_OSK_ENTRY:
        sh.pad_press(m.upper(), wait, hold)
    cur = sh.osk_type_pad(text, shots=sh.out, tag=f"{sh.tag}chat", cur=CHAT_OSK_ENTRY_KEY, enter=True, slow=True)
    time.sleep(OSK_ENTER_SETTLE_S)
    sh.shot("chat_02_entered")
    rec["closed"] = not chat_keyboard_up(sh)
    if not rec["closed"]:
        sh.log("CHAT keyboard still up after ENTER -> one ENTER re-press")
        cur = sh.osk_press_key(cur, "ENTER")
        time.sleep(OSK_ENTER_SETTLE_S)
        sh.shot("chat_03_reenter")
        rec["closed"] = not chat_keyboard_up(sh)
    if not rec["closed"]:
        sh.log("CHAT keyboard still up after the re-press -> EXIT (nothing is sent), so the round can go on")
        sh.osk_press_key(cur, "EXIT")
        time.sleep(OSK_ENTER_SETTLE_S)
        sh.shot("chat_04_exit")
        rec["exited"] = not chat_keyboard_up(sh)
    sh.log(f"CHAT typed {text!r}: keyboard {'closed' if rec['closed'] else 'left by EXIT' if rec['exited'] else 'STILL UP'}")
    return rec


def attach(proc, title, out, tag="", pad_file=None):
    """Find the instance's window (by title substring) and wait for its first frame."""
    t0 = time.time()
    hwnd = None
    while hwnd is None and time.time() - t0 < 90:
        hwnd = winshot.find_window(title)
        time.sleep(0.5)
    if hwnd is None:
        proc.terminate()
        raise SystemExit(f"{tag}game window not found")
    winshot.keep_on_top(hwnd)
    winshot.ensure_client_size(hwnd)
    if getattr(proc, "latest_frame", None):
        winshot.register_frame_file(hwnd, proc.latest_frame)
    last = None
    while last is None and time.time() - t0 < 60:
        try:
            last = drive.frame(hwnd)
        except RuntimeError:
            time.sleep(0.5)
    sh = Shell(hwnd, out, t0, tag, pad_file)
    sh.latest_frame = getattr(proc, "latest_frame", None)
    sh.last = last
    return sh


def boot_to_online(sh):
    """CROSS through the boot screens until the main menu (five or six presses), then ONLINE."""
    for i in range(9):
        drive.wait_stable(sh.hwnd, 1.5, 40.0, changed_from=sh.last)
        time.sleep(1.0)
        if sh.is_screen("main_menu", 90.0):
            sh.log(f"main menu after {i} presses")
            break
        sh.last = drive.frame(sh.hwnd)
        sh.press("cross")
        sh.log(f"boot press {i}")
        for _ in range(12):
            time.sleep(1.0)
            if sh.is_screen("main_menu", 90.0):
                break
    else:
        # research/28 §2: exit 1 with no class was the one failure the taxonomy could not count
        raise lobby_fail(sh, CLASS_PRE_LOGIN, "main menu not reached after 9 boot presses")
    time.sleep(3.0)
    press_online(sh)
    sh.shot("00_login")


def press_online(sh):
    """The DOWN to ONLINE and the CROSS on it, each read back (s6_ladder7 A: the DOWN registered, the CROSS was
    dropped, and the run waited 40 s on a main menu with ONLINE lit; wtb4 and 3b before it timed out on the same
    picture, and the old harness then pressed on and classified the run as login-keyboard 120-180 s later).

    After the DOWN a fresh frame must show ONLINE lit; while it does not, one more DOWN and a re-read, at most
    ONLINE_EXTRA_DOWNS times (`[login] online: lit|not lit attempt k`), then pre-login -- a CROSS never goes to an
    unread menu (NEW GAME would start a campaign). Then CROSS and the login screen within LOGIN_SCREEN_WAIT_S; not
    there and the menu still showing ONLINE lit is a dropped CROSS: re-sent through the pad, at most
    ONLINE_CROSS_RESENDS times (`[login] online cross: login screen after k presses`); the menu gone without the
    login screen, or the re-sends exhausted, is the existing pre-login class."""
    sh.press("down", 1.5)
    for attempt in range(1, ONLINE_EXTRA_DOWNS + 2):
        gray = lobby_gray(sh)
        lit = menu_online_lit(gray)
        sh.log(f"[login] online: {'lit' if lit else 'not lit'} attempt {attempt}")
        if lit:
            break
        if attempt > ONLINE_EXTRA_DOWNS:
            raise lobby_fail(sh, CLASS_PRE_LOGIN, f"ONLINE not lit after 1 DOWN and {ONLINE_EXTRA_DOWNS} more "
                                                  f"({menu_rows_detail(gray)})")
        lobby_resend(sh, "down", 1.5)
    for k in range(1, ONLINE_CROSS_RESENDS + 2):
        if k == 1:
            sh.press("cross", 3.0)                               # ONLINE
        else:
            lobby_resend(sh, "cross", 3.0)
        if sh.screen_within("login", LOGIN_SCREEN_WAIT_S):
            sh.log(f"[login] online cross: login screen after {k} press{'es' if k > 1 else ''}")
            return
        gray = lobby_gray(sh)
        if not menu_online_lit(gray):
            raise lobby_fail(sh, CLASS_PRE_LOGIN, f"login not on screen within {LOGIN_SCREEN_WAIT_S:.0f}s of the ONLINE "
                                                  f"CROSS (press {k}) and the menu no longer shows ONLINE lit "
                                                  f"({menu_rows_detail(gray)})")
        if k > ONLINE_CROSS_RESENDS:
            raise lobby_fail(sh, CLASS_PRE_LOGIN, f"login not on screen within {LOGIN_SCREEN_WAIT_S:.0f}s of the ONLINE "
                                                  f"CROSS and {ONLINE_CROSS_RESENDS} re-sends -- the menu still shows "
                                                  f"ONLINE lit")
        sh.log(f"[login] online cross: no login screen, the menu still shows ONLINE lit -> re-send CROSS (attempt {k})")


@staged("login")
def login(sh, name, password, existing, prefilled=False, save_password=False, saved_password=False, new_persona=None):
    """LOGIN -> universe -> persona -> password -> CONNECT -> prompts -> EULA -> lobby (news closed).
    `prefilled` (--prefilled): the game was launched with the two variables, so each keyboard is ENTERed, not typed.
    `new_persona` (--new-persona N, Sprint 16 L1b): the card already holds N personas on this server; the game's persona
    list is walked to <New Persona> (press_new_persona) and `name` created there, whatever the form arrived with.
    `save_password` (--save-password, W10): after the password, tick SAVE PASSWORD = YES before CONNECT.
    `saved_password` (--saved-password, W10): the relaunch half of the proof -- the form must arrive with the
    persona AND its password from the card; nothing is typed, and an empty field is the failure, classified."""
    sh.press_until_gone("cross", "login")                        # LOGIN
    sh.wait_for("universe", 60)
    sh.shot("01_universe")
    sh.press_until_gone("cross", "universe")                     # connect to the universe
    # required=False: `TIMEOUT waiting for persona` was logged by 11 launches that reached gameplay
    # (kill1/2, wtb2/6, frost1, launch2/3c, 8c, ladder2 -- `grep -l "liveness OK" logs/parity/drive_*.txt |
    # xargs grep "TIMEOUT waiting for persona"`): the persona reference misses the screen on good runs, so
    # this one timeout stays a log line. Every other screen's timeout occurred only in failed launches.
    sh.wait_for("persona", 60, required=False)
    sh.shot("02_persona")
    if new_persona is not None:
        # The form arrives with the card's first persona in PLAYER NAME, which persona_form_mode reads as "saved":
        # the mode is "create" by the option, never by the read.
        sh.log(f"[login] persona: --new-persona {new_persona} -> creating {name} past the card's saved persona(s)")
        press_new_persona(sh, new_persona)
        create_persona(sh, name, prefilled=prefilled, keyboard_open=True)
        sh.type(password, prefilled=prefilled)
        sh.shot("05_password")
        if save_password:
            set_save_password(sh)
            press_connect(sh, downs=LOGIN_CONNECT_DOWNS - 1)
        else:
            press_connect(sh)
        login_prompts(sh)
        login_to_lobby(sh)
        return
    mode, listed = persona_form_mode(sh, existing)
    if saved_password:
        # Sprint 13 V6 (#27): the form is read AS IT ARRIVED, before any press. W10's relaunch (w10_virgin_b) arrived with the persona, "*****",
        # YES ticked and the game's cursor ON CONNECT: the persona-list CROSS this path used to send first
        # connected, and PASSWORD was then read off the CONNECTING screen -- 0 glyphs, login:saved-password:empty,
        # a failure of the read and never of the card.
        # persona_form_mode also answers "saved" off an open keyboard and off --existing with no form read, so
        # the form is required here (a short bounded re-read) before its PASSWORD is believed: a frame that is not
        # the form fails as its own class, never as :empty -- the misread #27 was.
        for read in range(1, SAVED_FORM_READS + 1):
            gray = lobby_gray(sh)
            if login_form_up(gray):
                break
            sh.log(f"[login] saved password: the form is not on screen (read {read} of {SAVED_FORM_READS}, keyboard "
                   f"{'up' if osk_open_of(gray) else 'down'})")
            if read < SAVED_FORM_READS:
                sh.stage_sleep(SAVED_FORM_REREAD_S)
        else:
            sh.shot("05_password")
            raise lobby_fail(sh, f"{CLASS_RELAUNCH_LOGIN}:no-form",
                             f"the CONNECT TO SOCOM II form was not on screen in {SAVED_FORM_READS} reads (keyboard "
                             f"{'up' if osk_open_of(gray) else 'down'}): PASSWORD was not read, so nothing is known "
                             f"about the saved password")
        if login_persona_mode(gray) == "create":                 # off the form itself, never --existing's guess
            raise lobby_fail(sh, f"{CLASS_RELAUNCH_LOGIN}:no-persona",
                             "the relaunch's form has an empty PLAYER NAME: the card brought no persona back")
        n, state, focus = login_password_glyphs(gray), login_save_password(gray), login_focus_row(gray)
        sh.log(f"[login] saved password: PASSWORD reads {n} glyphs, SAVE PASSWORD reads {state}, "
               f"focus {focus or 'unread'}; typing nothing")
        sh.shot("05_password")
        if n == 0:
            raise lobby_fail(sh, f"{CLASS_RELAUNCH_LOGIN}:empty",
                             f"the relaunch's PASSWORD field is empty (SAVE PASSWORD reads {state}): the saved "
                             f"password did not survive the restart")
        # The DOWNs from the lit row to CONNECT (0 when the game already put the cursor there); an unread focus
        # keeps this path's old assumption, the cursor on PASSWORD, and press_connect's focus search reads the rest.
        press_connect(sh, downs=(LOGIN_ROW_ORDER.index("connect") - LOGIN_ROW_ORDER.index(focus)) if focus
                      else LOGIN_CONNECT_DOWNS)
        login_prompts(sh)
        login_to_lobby(sh)
        return
    if mode == "create":
        sh.log(f"[login] persona: none saved -> creating {name}" + (" (prefilled)" if prefilled else ""))
        create_persona(sh, name, listed, prefilled)
    else:
        sh.log("[login] persona: prefilled -> the saved-persona path")
        press_persona(sh, True, listed)
        sh.shot("03_name")
        sh.shot("04_pw_kbd")
    sh.type(password, prefilled=prefilled)
    sh.shot("05_password")
    if save_password:
        set_save_password(sh)
        press_connect(sh, downs=LOGIN_CONNECT_DOWNS - 1)
    else:
        press_connect(sh)
    login_prompts(sh)
    login_to_lobby(sh)


def login_prompts(sh):
    """Prompts between CONNECT and the EULA vary (write-down notice, save to card?, slot, overwrite?):
    answer whichever is on screen until the EULA shows. A first login adds the account-created notice and
    the save-persona prompts -- all CROSS-to-continue, all answered here."""
    t = time.time()
    seen = set()
    quiet = 0
    while time.time() - t < 120 and not sh.is_screen("eula"):
        for pname in ("write_down", "save_card", "card_slot"):
            if sh.is_screen(pname):
                sh.log(f"prompt {pname}")
                sh.shot(f"07_{pname}")
                seen.add(pname)
                quiet = 0
                sh.press("cross", 3.0)
                break
        else:
            quiet += 1
            if "card_slot" in seen and quiet == 8:               # an unrecognised prompt (overwrite?): YES
                sh.log("unrecognised prompt after the slot -> LEFT, CROSS")
                sh.shot("07_unknown_prompt")
                sh.press("left", 0.8)
                sh.press("cross", 3.0)
                quiet = 0
            time.sleep(1.0)


def login_to_lobby(sh):
    sh.wait_for("eula", 30)
    sh.shot("08_eula")
    sh.press_until_gone("cross", "eula")                         # ACCEPT
    sh.wait_for("lobby_news", 60)
    sh.shot("09_lobby")
    sh.press_until_gone("cross", "lobby_news")                   # close SERVER NEWS
    time.sleep(2.0)
    sh.shot("09_lobby_no_news")


def persona_form_mode(sh, existing):
    """Which login path this server needs -- ("create"|"saved", whether the persona-list CROSS is already
    spent) -- READ off the CONNECT TO SOCOM II form rather than assumed from --existing (Sprint 8,
    s8_hosted_control): the game keeps personas per server, so the card that arrives prefilled on the LAN
    box arrives empty on the hosted Horizon, and the old path typed the password into the empty PLAYER NAME.

    Normally the 02_persona frame IS the form. When it is not, the run is not lost: the `persona` reference
    misses on good launches (see login()'s required=False) and SELECT UNIVERSE can still be up 60 s later
    (s8_lan_login_recheck). The persona-list CROSS, which BOTH paths send first, is then taken here and the
    frame after it read -- the form, or the keyboard that CROSS opened, whose title names the field it edits.
    Only if that frame says nothing either does --existing decide, as it did before this path existed."""
    gray = lobby_gray(sh)
    for listed in (False, True):
        mode = login_persona_mode(gray)
        if mode is not None:
            sh.log(f"[login] persona: PLAYER NAME {login_name_glyphs(gray)} glyphs, "
                   f"focus {login_focus_row(gray) or 'unread'} -> {mode}")
            return mode, listed
        if listed:
            break
        sh.log("[login] persona: the form is not on screen -> reading it after the persona-list CROSS")
        press_persona_list(sh)
        gray = lobby_gray(sh)
    if osk_open_of(gray):
        mode = "create" if osk_title_is_name(gray) else "saved"
        sh.log(f"[login] persona: no form, keyboard title edge {osk_title_edge(gray)} -> {mode}")
        return mode, True
    sh.log(f"[login] persona: form unread and no keyboard -> --existing={existing}")
    return ("saved" if existing else "create"), True


def create_persona(sh, name, listed=False, prefilled=False, keyboard_open=False):
    """The first login on a server that keeps no persona for this card: PLAYER NAME is empty and focused and
    the header reads "Choose a different persona or create a new one." (s8_hosted_control A_02_persona).

    The two persona CROSSes open the "Enter Player Name" keyboard instead of the password one; the name is
    typed and ENTERed by the same verified walk as the password, and then READ BACK OFF THE FORM -- the
    keyboard's own text row can only say what it holds, not that ENTER committed it to the field. A DOWN
    verified on the PASSWORD row's fill and a CROSS verified on the keyboard leave the caller exactly where
    the saved-persona path leaves it: the password keyboard open. `prefilled`: the name keyboard opens holding
    the name (Sprint 10 Goal 9) and is ENTERed, not typed; the form read-back after it is the same.
    `keyboard_open` (Sprint 16 L1b, --new-persona): press_new_persona already opened and verified the name keyboard
    through the game's persona list, so the two persona CROSSes are not sent again."""
    if not keyboard_open:
        press_persona(sh, False, listed)                         # -> the name keyboard
    gray = lobby_gray(sh)
    edge = osk_title_edge(gray)
    sh.log(f"[login] persona: keyboard title edge {edge} -> "
           f"{'Enter Player Name' if osk_title_is_name(gray) else 'NOT Enter Player Name'}")
    sh.shot("03_name_kbd")
    sh.type(name, sh.out, sh.tag + "name", prefilled=prefilled)
    n = login_name_glyphs(lobby_gray(sh))
    sh.log(f"[login] persona: PLAYER NAME reads {n} glyphs, expected {len(name)}")
    if n != len(name):
        raise lobby_fail(sh, f"{CLASS_PERSONA}:name-value",
                         f"the ENTER did not put {name!r} in PLAYER NAME: the field reads {n} glyphs")
    sh.shot("03_name")
    press_verified(sh, f"{CLASS_PERSONA}:password-row", "down", 1.0,
                   lambda g: lobby_row_lit(g, "password"), "the PASSWORD row lit")
    press_verified(sh, f"{CLASS_PERSONA}:password-keyboard", "cross", PERSONA_CROSS_WAIT_S, osk_open_of,
                   "the password keyboard")
    sh.shot("04_pw_kbd")


def press_persona_list(sh):
    """The first of the two persona CROSSes, verified by the frame changing from the one read before it
    (frame_diff over PERSONA_CHANGED_MIN_DIFF) and re-sent through the pad at most LOBBY_RESEND_MAX times.
    Common to both paths, which is why persona_form_mode may spend it before either one starts."""
    pre = lobby_gray(sh)

    def changed(gray):
        d = frame_diff(pre, gray)
        sh.log(f"[login] persona list: frame diff {d:.2f} (min {PERSONA_CHANGED_MIN_DIFF})")
        return d > PERSONA_CHANGED_MIN_DIFF

    press_verified(sh, f"{CLASS_PERSONA}:list", "cross", PERSONA_CROSS_WAIT_S, changed, "a changed screen")


NEW_PERSONA_DOWN_S = 0.8   # between the list's DOWNs: the list moves one row per press (the menus' pace)


def press_new_persona(sh, personas):
    """Sprint 16 L1b (#73; the L1 design note, section 2): walk the game's persona list to <New Persona> on a card that
    already holds `personas` personas on this server. The persona-list CROSS first (press_persona_list: that CROSS
    is what opens the list -- a DOWN before it moves the form's cursor from PLAYER NAME to PASSWORD), then DOWN once
    per saved persona, then the pick CROSS, verified by a keyboard opening; the keyboard must be "Enter Player Name"
    (osk_title_is_name). Anything else -- the password keyboard of a saved persona the pick landed on, or no keyboard
    at all -- is login:persona:new-persona: typing the new persona's password there would log in as the old one."""
    if personas < 1:
        raise ValueError("--new-persona N counts the personas already on the card: 1 or more")
    press_persona_list(sh)
    for _ in range(personas):
        sh.press("down", NEW_PERSONA_DOWN_S)
    press_verified(sh, CLASS_NEW_PERSONA, "cross", PERSONA_CROSS_WAIT_S, osk_open_of, "a keyboard")
    gray = lobby_gray(sh)
    edge = osk_title_edge(gray)
    named = osk_title_is_name(gray)
    sh.log(f"[login] new persona: {personas} DOWN(s) past the saved personas, keyboard title edge {edge} -> "
           f"{'Enter Player Name' if named else 'NOT Enter Player Name'}")
    if not named:
        raise lobby_fail(sh, CLASS_NEW_PERSONA,
                         f"after {personas} DOWN(s) the pick opened a keyboard whose title ends at {edge}, not "
                         f"'Enter Player Name': the pick was not <New Persona>")


def press_persona(sh, existing, listed=False):
    """The two CROSSes after the universe, each read back on a fresh frame and re-sent through the pad (at most
    LOBBY_RESEND_MAX times, then login:persona:<stage>). They were the last blind presses of the login stage.
    `listed`: persona_form_mode already spent the first one to get a frame it could read.

    The first ("list") is verified by the frame changing from the one read before it (frame_diff over
    PERSONA_CHANGED_MIN_DIFF); the second by the keyboard being open (osk_open_of): the saved persona's password
    keyboard, or <New Persona>'s name keyboard. On the launches with a saved persona the "persona" screen the
    reference names is the CONNECT TO SOCOM II form with the cursor on PASSWORD (s6_ladder7 B_02_persona): the first
    CROSS opens the password keyboard and the second lands on its accent key, which osk_normal_mode toggles back --
    so a dropped second CROSS is harmless and a dropped first one is the one this catches."""
    if not listed:
        press_persona_list(sh)
    if existing:
        press_verified(sh, f"{CLASS_PERSONA}:password-keyboard", "cross", PERSONA_CROSS_WAIT_S, osk_open_of,
                       "the password keyboard")
    else:
        press_verified(sh, f"{CLASS_PERSONA}:name-keyboard", "cross", PERSONA_CROSS_WAIT_S, osk_open_of,
                       "the name keyboard")


def press_connect(sh, downs=LOGIN_CONNECT_DOWNS):
    """The DOWNs from PASSWORD to CONNECT and the CROSS on it, each read back (s6_ladder6 A: one of the four blind
    DOWNs was dropped, CROSS opened "Specify your gender." and the login stage timed out). `downs`: from the
    PASSWORD row it is LOGIN_CONNECT_DOWNS; one fewer when the cursor already sits on SAVE PASSWORD (W10).

    After the four DOWNs a fresh frame must show the CONNECT button lit; while it does not, one more DOWN and a
    re-read, at most LOGIN_CONNECT_EXTRA_DOWNS times (`[login] connect focus: lit|not lit (median m) attempt k`);
    a read that shows neither the form nor CONNECT presses nothing more. CROSS goes only to a lit CONNECT. The
    frame after it must no longer show the form: still up with CONNECT lit is a dropped CROSS (re-sent, at most
    LOBBY_RESEND_MAX times, then login:connect-press -- 127 of 127 launches that connected had the form gone at
    the 5 s read); still up with the cursor elsewhere, or a keyboard opened, is a prompt the CROSS opened:
    TRIANGLE backs out of it and the DOWN search resumes, at most LOGIN_GENDER_BACKS times."""
    for _ in range(downs):                                       # SAVE PASSWORD, HOMETOWN, GENDER, CONNECT
        sh.press("down", 0.8)
    extra = backs = resends = crosses = attempt = 0
    while True:
        while True:                                              # the focus search
            attempt += 1
            gray = lobby_gray(sh)
            m = lobby_row_median(gray, "connect")
            lit = m > LOBBY_ROW_LIT_MEDIAN["connect"]
            sh.log(f"[login] connect focus: {'lit' if lit else 'not lit'} (median {m:.0f}) attempt {attempt}")
            if lit:
                break
            if not login_form_up(gray):
                raise lobby_fail(sh, CLASS_CONNECT_FOCUS, f"the CONNECT form is not on screen after {LOGIN_CONNECT_DOWNS} "
                                                          f"DOWN and {extra} more (prompt band {login_form_prompt_cols(gray)} "
                                                          f"columns, keyboard {'up' if osk_open_of(gray) else 'down'})")
            if extra == LOGIN_CONNECT_EXTRA_DOWNS:
                raise lobby_fail(sh, CLASS_CONNECT_FOCUS, f"CONNECT not lit after {LOGIN_CONNECT_DOWNS} DOWN and {extra} "
                                                          f"more (median {m:.0f}, GENDER {'lit' if lobby_row_lit(gray, 'gender') else 'unlit'})")
            extra += 1
            lobby_resend(sh, "down", 0.8)
        sh.shot("06_connect_focus")
        crosses += 1
        if crosses == 1:
            sh.press("cross", 5.0)
        else:
            lobby_resend(sh, "cross", 5.0)
        gray = lobby_gray(sh)
        keyboard = osk_open_of(gray)
        if not login_form_up(gray) and not keyboard:
            sh.shot("07_after_connect")
            return
        if lobby_row_lit(gray, "connect") and not keyboard:
            resends += 1
            if resends > LOBBY_RESEND_MAX:
                raise lobby_fail(sh, CLASS_CONNECT_PRESS, f"the form is still up with CONNECT lit after the CROSS and "
                                                          f"{LOBBY_RESEND_MAX} re-sends")
            sh.log(f"[login] connect press: form still up, CONNECT lit -> re-send CROSS (attempt {resends})")
            continue
        gender = lobby_row_lit(gray, "gender")
        what = "a keyboard opened" if keyboard else "GENDER lit (the gender prompt)" if gender else "cursor elsewhere"
        backs += 1
        if backs > LOGIN_GENDER_BACKS:
            raise lobby_fail(sh, CLASS_CONNECT_FOCUS, f"the CROSS opened a prompt {backs} times ({what})")
        sh.log(f"[login] connect press: form still up, {what} -> TRIANGLE, resume the DOWN search (back {backs})")
        sh.shot("07_gender_prompt" if gender and not keyboard else "07_unexpected_prompt")
        lobby_resend(sh, "triangle", 1.5)


def select_room(sh, channel):
    """Move the BRIEFING ROOMS highlight to the `channel`-th room (1-based) before the CROSS that enters it.
    Returns the number of DOWN presses it took.

    R240 asked for a `--channel`, and the room list IS where the game offers the choice: the SOCOM II ONLINE
    screen's BRIEFING ROOMS page is headed "Select a Briefing Room" over a ROOM NAME / # of PLAYERS / ELIGIBLE
    RANKS table, and the briefing room that follows carries the chosen room's name beside its title ("Channel 1",
    "US East (Ohio)"). What is NOT knowable from this repository is the table's row pitch: all 306 room-list
    captures under logs/parity show exactly one room (the highlight at y 125 on every one of the 273 that really
    are that screen, ours and PCSX2 alike), because every server we have driven has offered one. So
    nothing here is pitched: a press is judged by the highlight having MOVED DOWN, and a press that does not move
    it fails as `login:channel` naming the row it was on. `--channel 1` presses nothing at all and is byte-for-byte
    the old behaviour; `--channel 2` and up is written but UNEXERCISED, and will fail fast on a one-room server
    rather than enter the wrong room quietly."""
    channel = 1 if channel is None else int(channel)
    if channel < 1:
        raise lobby_fail(sh, CLASS_CHANNEL, f"--channel {channel}: the rooms are numbered from 1")
    if channel == 1:
        # The default path presses nothing and must not gain a new way to fail: the highlight is read for the
        # record only, off whatever frame is there, and a read that cannot be taken is logged as such.
        try:
            top = rooms_fill_top(lobby_gray_of(winshot.grab(sh.hwnd)))
        except (RuntimeError, OSError) as e:
            top = f"unread ({e})"
        sh.log(f"[lobby] briefing rooms: channel 1 -- the first room, no press (highlight top y={top})")
        return 0
    for n in range(2, channel + 1):
        before = rooms_fill_top(lobby_gray(sh))
        sh.press("down", 1.2)
        after = rooms_fill_top(lobby_gray(sh))
        sh.log(f"[lobby] briefing rooms: DOWN {n - 1} for channel {channel} -- highlight y {before} -> {after}")
        if before is None or after is None or after <= before:
            sh.shot(f"10_rooms_channel_{n}")
            raise lobby_fail(sh, CLASS_CHANNEL,
                             f"--channel {channel}: the room list's highlight did not move down on press {n - 1} "
                             f"(top y {before} -> {after}); the server is offering fewer rooms than that")
    sh.shot(f"10_rooms_channel_{channel}")
    return channel - 1


@staged("login")
def to_briefing_room(sh, channel=1):
    sh.press("down", 2.0)
    sh.press("cross", 3.0)                                       # BRIEFING ROOMS
    sh.wait_for("rooms", 30)
    sh.shot("10_rooms")
    select_room(sh, channel)                                     # --channel N; 1 presses nothing (the old path)
    sh.press_until_gone("cross", "rooms", wait=5.0)              # enter the highlighted room
    sh.wait_for("briefing_room", 40)
    sh.shot("11_briefing_room")


def require_game_lobby(sh, what):
    """Fail here, in four minutes, rather than after twelve.

    host_game/join_game navigate by fixed presses, and a press that lands a screen late derails the
    rest silently: in ours_task7_wtb5 the CROSS meant to open CHOOSE GAMES was eaten, the play list
    stayed empty, and the lobby answered "You must create a playlist before game creation can
    occur" -- but the driver pressed on, READY did nothing, and the run died on the liveness check
    eight minutes later. The game_lobby reference separates the two outcomes exactly: it scores
    0.287 on every run that launched a match (task6_ab, task7 cal3/wtb1/wtb2) and 0.506-0.509 on
    every run that did not (task7 cal1/wtb3/wtb5).
    """
    if sh.is_screen("game_lobby"):
        return
    sh.shot("17_game_lobby_FAILED")
    raise lobby_fail(sh, CLASS_JOIN if what.startswith("JOIN") else CLASS_HOST,
                     f"{what} did not reach the GAME LOBBY (game_lobby band distance "
                     f"{sh.diff('game_lobby'):.3f}, threshold 0.45) -- see the capture; the match "
                     f"would never have launched")


# ---------------------------------------------------------------------------
# CHOOSE GAMES -- the map list
# ---------------------------------------------------------------------------
# The AVAILABLE MAPS box holds six visible rows and SCROLLS, so the entry a fixed number of presses
# lands on is not knowable from one screen and the old blind `sh.press("cross", 4.0)  # Medley`
# accepted whatever happened to be highlighted. Geometry and thresholds below are MEASURED off the
# 27 captures of logs/parity/ours_task8_mapscan (640x448): text rows start at y=117 with a pitch of
# 20 and a height of 12, x 78..292.
MAP_ROW_TOP, MAP_ROW_PITCH, MAP_ROW_H = 117, 20, 12
MAP_ROW_X0, MAP_ROW_X1 = 78, 292
MAP_ROWS = 6
# The highlighted row is gold-on-teal and its PEAK luminance is 123-125 in all 27 captures; an
# ordinary row's pale text peaks at 168-174 and an empty row at 99-110. A single absolute band
# separates all three with a margin of more than 40 either way, which is why this needs no
# reference image and no assumption about where the cursor starts.
MAP_HILITE_LO, MAP_HILITE_HI = 116.0, 140.0
# Text-mask distance: binarise the row and take (symmetric difference / union) over +-3 px of
# shift. Measured across the same 27 captures against the FROSTFIRE reference: the true row scores
# 0.000 and the nearest other map (ENOWAPI) 0.510, so 0.30 has a margin of 0.21. The
# contrast-normalised band distance `Shell.diff` uses was NOT good enough here -- it put ENOWAPI at
# 0.317 against a 0.42 threshold, i.e. it would have accepted the wrong map.
# The MEDLEY reference (map_medley.png) was cut the same way, from the highlighted row 0 of
# A_mapscan_00 in that scan (2026-09-13, offline, no launch). Against the highlighted row of all 28
# CHOOSE GAMES captures it scores 0.000 on the two Medley frames (A_mapscan_00, A_14_choose_games)
# and >= 0.673 on every other map (Random 0.673, ENOWAPI 0.674, Frostfire 0.777, the last entry
# THE RUINS 0.771). An UNhighlighted row of the same map scores the same mask (Medley 0.046; FROSTFIRE
# 0.041-0.047 at rows 0-5 of A_mapscan_14..19, nearest other row 0.498), which is what lets choose_map
# see the target BEFORE the cursor reaches it: acceptance still needs the HIGHLIGHTED row to match.
MAP_MATCH_THRESH = 0.30
MAP_REF_DIR = REFS
# Launch s6_ladder3 (2026-09-15): with two instances on one host at ~35-55 fps, the read after DOWN 15
# caught a mid-scroll frame with no row in the highlight band, choose_map logged "no highlighted row --
# pressing on" and walked past FROSTFIRE to THE RUINS (Sprint 5, same code at 60 fps, accepted at
# exactly 15). So an unreadable frame is re-read on FRESH captures MAP_REREAD_WAIT_S apart, up to
# MAP_REREADS times (2 s), before it counts as "no highlight"; and every read scores all six rows, so a
# target visible at another row is walked to one press at a time and cannot be overshot.
MAP_REREADS = 4
MAP_REREAD_WAIT_S = 0.5
# Launch ours_control_crossroads (2026-09-16): in a SCROLLED list the cursor stays pinned at row 4 and the content
# moves, so a target seen above the cursor needs several UPs; one mid-scroll read that did not show it sent the walk
# back DOWN and the presses cancelled for 30 presses. Once seen, the direction toward the target is kept through reads
# that do not show it, for up to this many presses, before the walk falls back to DOWN.
MAP_STICKY_PRESSES = 6


def map_row_box(i):
    y0 = MAP_ROW_TOP + MAP_ROW_PITCH * i
    return MAP_ROW_X0, y0, MAP_ROW_X1, y0 + MAP_ROW_H


def map_rows(im):
    a = np.asarray(im.convert("L"), dtype=np.float32)
    out = []
    for i in range(MAP_ROWS):
        x0, y0, x1, y1 = map_row_box(i)
        out.append(a[y0:y1, x0:x1])
    return out


def map_cursor(sh, im=None):
    """Index of the highlighted row in AVAILABLE MAPS, or -1. No reference image needed."""
    rows = map_rows(im or winshot.grab(sh.hwnd))
    cand = [i for i, b in enumerate(rows) if MAP_HILITE_LO <= float(b.max()) <= MAP_HILITE_HI]
    if not cand:
        return -1
    return max(cand, key=lambda i: float(rows[i].std()))


def map_text_mask(band):
    lo, hi = float(band.min()), float(band.max())
    return band > (lo + 0.55 * (hi - lo))


def map_mask_distance(cur, ref):
    """Symmetric difference over union of the two text masks, best over +-3 px of shift."""
    if cur.shape != ref.shape:
        return 1e9
    a, b = map_text_mask(cur), map_text_mask(ref)
    best = 1.0
    for dx in range(-3, 4):
        c = np.roll(a, dx, axis=1)
        u = int((c | b).sum())
        if u:
            best = min(best, float((c ^ b).sum()) / float(u))
    return best


def map_scan(sh, presses=26, tag="mapscan"):
    """Walk AVAILABLE MAPS one DOWN at a time, capturing every screen.

    Costs one single-instance login and NO match launch, and it is what makes a verified map
    selection possible: the reference crop for a map is cut from this scan's own captures.
    The list as scanned on 2026-09-13, in order: Medley, Random, VIGILANCE, THE MIXER, FOXHUNT,
    SUJO, ENOWAPI, SHADOW FALLS, FISH HOOK, CROSSROADS, SANDSTORM, CHAIN REACTION, GUIDANCE,
    REQUIEM, BLIZZARD, **FROSTFIRE**, ABANDONED, DESERT GLORY, NIGHT STALKER, RAT'S NEST,
    BITTER JUNGLE, BLOOD LAKE, DEATH TRAP, THE RUINS.
    """
    seen = []
    for k in range(presses + 1):
        im = winshot.grab(sh.hwnd)
        im.save(os.path.join(sh.out, f"{sh.tag}{tag}_{k:02d}.png"))
        cur = map_cursor(sh, im)
        seen.append(cur)
        sh.log(f"map scan {k:02d}: highlighted row {cur}")
        if k < presses:
            sh.pad_press("down", wait=0.5)
    return seen


# The CREATE GAME PLAY LIST as scanned on 2026-09-13 (logs/parity/ours_task8_mapscan, capture k highlights
# entry k): the order the DOWN presses walk. Every entry has a reference row scripts/parity/refs/map_<slug>.png
# cut from that scan (tests/test_map_refs.py checks presence, size and that none confuses another).
MAP_SCAN_ORDER = ("Medley", "Random", "VIGILANCE", "THE MIXER", "FOXHUNT", "SUJO", "ENOWAPI", "SHADOW FALLS",
                  "FISH HOOK", "CROSSROADS", "SANDSTORM", "CHAIN REACTION", "GUIDANCE", "REQUIEM", "BLIZZARD",
                  "FROSTFIRE", "ABANDONED", "DESERT GLORY", "NIGHT STALKER", "RAT'S NEST", "BITTER JUNGLE",
                  "BLOOD LAKE", "DEATH TRAP", "THE RUINS")


def map_slug(name):
    """'RAT'S NEST' -> 'rats_nest', 'The Mixer' -> 'the_mixer', 'frostfire' -> 'frostfire'."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower().replace("'", "")).strip("_")


def map_ref_path(name, target=None):
    # Sprint 10 Goal 3: a console frame's map rows sit narrower and offset (KNOWN section 2), so a console shell
    # reads `map_<slug>.pcsx2.png` when one has been cut, ours' reference otherwise -- as the lobby titles do.
    target = target or _current_target
    if target != "ours":
        console = os.path.join(MAP_REF_DIR, f"map_{map_slug(name)}.{target}.png")
        if os.path.exists(console):
            return console
    return os.path.join(MAP_REF_DIR, f"map_{map_slug(name)}.png")


def map_ref(name):
    return np.asarray(Image.open(map_ref_path(name)).convert("L"), dtype=np.float32)


def map_row_distances(im, ref):
    """Text-mask distance of each of the six visible rows to the reference (highlighted or not)."""
    return [map_mask_distance(b, ref) for b in map_rows(im)]


def map_frame(sh):
    """A fresh frame of the list. A StaleFrameError (an instance stall) is waited out under the stage
    deadline, as lobby_gray does -- never read as a frame without a highlight."""
    while True:
        try:
            return winshot.grab(sh.hwnd, max_age=LOBBY_FRAME_MAX_AGE_S)
        except winshot.StaleFrameError as e:
            sh.log(f"map search: {e} -- waiting for a fresh frame")
            sh.stage_sleep(MAP_REREAD_WAIT_S)


def map_read(sh, ref, k):
    """One reading of AVAILABLE MAPS: (highlighted row or -1, the six row distances). A frame with no row
    in the highlight band is re-read on fresh frames MAP_REREAD_WAIT_S apart, up to MAP_REREADS times."""
    for n in range(MAP_REREADS + 1):
        if n:
            sh.stage_sleep(MAP_REREAD_WAIT_S)
        im = map_frame(sh)
        cur = map_cursor(sh, im)
        if cur >= 0:
            return cur, map_row_distances(im, ref)
        if n < MAP_REREADS:
            sh.log(f"map search {k:02d}: no highlighted row (re-read {n + 1})")
    sh.log(f"map search {k:02d}: no highlighted row after {MAP_REREADS} re-reads -- pressing on")
    return -1, map_row_distances(im, ref)


@staged("map_select")
def choose_map(sh, name, presses=30):
    """Select `name` in AVAILABLE MAPS, VERIFYING the highlighted row before pressing CROSS.

    A blind index that silently lands on the wrong map produces a whole class of runs whose
    position rows mean nothing -- and the mined waypoint corridor is map-specific, so the harness
    has to KNOW which map it is on rather than assume. Returns the row index it accepted; raises
    LobbyFail (CLASS_MAP_SEARCH) with a capture if the map is never highlighted in `presses` presses.

    The walk is DOWN by default; once the target's text is visible at row j (pale or highlighted), each
    press is one step toward j and the next read decides again, so the cursor cannot run past it.
    """
    ref_path = map_ref_path(name)
    if not os.path.exists(ref_path):
        raise SystemExit(f"{sh.tag}no reference for map '{name}' at {ref_path} -- run the map scan "
                         f"(--only A --map-scan 26) once and cut the highlighted row from its "
                         f"captures; accepting whatever is highlighted is not an option")
    ref = map_ref(name)
    downs = 0                                                    # DOWN presses so far (the acceptance line's count)
    sticky, sticky_left = "down", 0                              # the direction a seen target set, and its budget
    for k in range(presses + 1):                                 # k = presses sent so far, DOWN or UP
        cur, dist = map_read(sh, ref, k)
        if cur >= 0 and dist[cur] <= MAP_MATCH_THRESH:
            sh.log(f"map '{name}' highlighted at row {cur} after {downs} DOWN (text-mask distance "
                   f"{dist[cur]:.3f} <= {MAP_MATCH_THRESH}) -- accepting")
            sh.shot(f"14b_map_{map_slug(name)}")
            press_map_cross_verified(sh, 4.0)                    # R47: re-sent while SELECTED MAPS does not move
            return cur
        seen = [j for j, d in enumerate(dist) if d <= MAP_MATCH_THRESH]
        btn = "down"
        if cur >= 0 and seen:
            j = min(seen, key=lambda j: abs(j - cur))
            btn = "up" if j < cur else "down"
            sticky, sticky_left = btn, MAP_STICKY_PRESSES
            sh.log(f"map '{name}' visible at row {j}, cursor at {cur} -> {btn}")
        elif sticky_left > 0:
            btn = sticky                                         # a read that lost the target does not undo the walk
            sticky_left -= 1
        elif cur >= 0 and k % 5 == 0:
            sh.log(f"map search {k:02d}: row {cur} is not '{name}' (distance {dist[cur]:.3f})")
        if k < presses:                                          # exactly `presses` presses, presses + 1 reads
            sh.pad_press(btn, wait=0.45)
            downs += btn == "down"
    sh.shot(f"14_map_{map_slug(name)}_NOT_FOUND")
    raise lobby_fail(sh, CLASS_MAP_SEARCH, f"map '{name}' was never highlighted in {presses} presses of DOWN -- "
                     f"see the capture. Accepting whatever is highlighted would put the run on an "
                     f"unknown map, and the whole point of this check is that it cannot.")


def open_choose_games(sh, game_name="test"):
    """Briefing room -> CREATE GAME -> game name -> CHOOSE GAMES. Split out of `host_game` so the
    map scan can reach the list without creating a world.

    Every press is verified on a fresh frame and re-sent (press_verified); the class names the press.
    research/28 §3: wtb3 and kill6 lost the CROSS into CREATE GAME (12_create_game still BRIEFING ROOM),
    wtb3's cursor then drifted to RANK RESTRICTIONS, cal1 typed the up/down/cross presses into the
    name keyboard."""
    press_verified(sh, "create-game:select", "up", 2.0,
                   lambda g: lobby_row_lit(g, "create_game"), "the CREATE GAME row lit")
    press_verified(sh, "create-game:enter", "cross", 6.0,
                   lambda g: lobby_title_is(g, "create_game"), "the CREATE GAME screen")
    sh.shot("12_create_game")
    press_verified(sh, "create-game:name-keyboard", "cross", 5.0, osk_open_of, "the game-name keyboard")
    sh.type(game_name)
    sh.shot("13_game_name")
    press_verified(sh, "create-game:choose-games-select", "up", 2.5,
                   lambda g: lobby_row_lit(g, "choose_games"), "the CHOOSE GAMES row lit")
    press_verified(sh, "create-game:choose-games", "cross", 6.0,
                   lambda g: lobby_title_is(g, "play_list"), "the CREATE GAME PLAY LIST screen")
    sh.shot("14_choose_games")


@staged("host")
def host_game(sh, game_name="test", game_map="frostfire"):
    # The default is the owner's default map and matches online_match_ours --map. Both Frostfire
    # and Medley have a committed reference (scripts/parity/refs/map_<name>.png); any other map
    # aborts in choose_map until one is cut from a map scan.
    open_choose_games(sh, game_name)
    row = choose_map(sh, game_map)                               # VERIFIED, not a blind CROSS
    sh.log(f"map list: accepted '{game_map}' at row {row}")
    # kill4, kill7 and 8b: 15_play_list still showed the play list (the ACCEPT was eaten), so the CREATE
    # SQUARE landed on a menu with an empty PLAY LIST and the lobby never appeared (band distance 0.521).
    press_verified(sh, "create-game:accept", "square", 5.0,
                   lambda g: lobby_title_is(g, "create_game"), "CREATE GAME with the play list accepted")
    sh.shot("15_play_list")
    press_verified(sh, "create-game:create", "square", 25.0,
                   lambda g: lobby_title_is(g, "game_lobby"), "the GAME LOBBY")
    sh.shot("16_game_lobby")
    press_verified(sh, "create-game:continue", "cross", 4.0,
                   lambda g: not lobby_notice_up(g), "the 30 s notice dismissed")
    sh.shot("17_game_lobby_ok")
    require_game_lobby(sh, "CREATE GAME")


def lobby_cursor_of(gray):
    """(index of the highlighted GAME LOBBY menu row -- 0 ARMORY, 1 SWITCH TEAMS, 2 NOT READY/READY --
    or -1 when nothing is highlighted, the three row means). A fresh lobby shows no cursor until the
    first press; the highlighted row is a teal fill (mean ~70 vs ~30)."""
    means = [float(gray[y0:y1, 22:165].mean()) for y0, y1 in LOBBY_CURSOR_ROWS]
    i = int(np.argmax(means))
    return (i if means[i] > LOBBY_CURSOR_MIN_MEAN else -1), [round(m, 1) for m in means]


def lobby_teams_of(gray):
    """(seals, terrorists) bright text pixels in the two name columns: who is where."""
    return tuple(int((gray[box] > LOBBY_TEAM_TEXT_LUMA).sum()) for box in LOBBY_TEAM_COLS)


def lobby_teams(sh):
    """lobby_teams_of on a fresh frame."""
    return lobby_teams_of(lobby_gray(sh))


def lobby_teams_state(seals, terrorists):
    """'ok' (a name in each column), 'one-sided' (both names in one column, the other empty), 'unread'
    (no name, or one name only: the names had not rendered -- s6_ladder8 A_16 (0, 0), A_17 (143, 0) -- never
    a verdict)."""
    named = [px >= LOBBY_TEAM_NAME_MIN_PX for px in (seals, terrorists)]
    if all(named):
        return "ok"
    if any(px >= LOBBY_TEAM_TWO_NAMES_MIN_PX for px in (seals, terrorists)):
        return "one-sided"
    return "unread"


def lobby_select(sh, row, label, lit_row=None, presses=LOBBY_CURSOR_PRESSES, on_lobby=None):
    """Move the lobby cursor to `row` by reading the highlight (no assumption about wrap-around or
    where the cursor starts: the old fixed 'down, cross' for SWITCH TEAMS landed on NOT READY).

    Every DOWN/UP is preceded by a fresh frame that must still carry the GAME LOBBY title: once it is
    gone (the match launched, a loading screen) nothing more is pressed and False is returned -- the
    caller must not press CROSS either. At most `presses` presses. Returns True when the cursor reads
    on `row`, or when it never did but `lit_row` (a LOBBY_ROWS key) reads lit on the last frame; raises
    LobbyFail `<label>:cursor-not-found` (with the row means it read) when the lobby is still up and
    neither holds, rather than pressing CROSS blind. `on_lobby(gray)` is called once, with the first
    frame that carries the title and before any press (ready() reads the team columns on it: one frame,
    two reads); it may raise LobbyFail."""
    cls = f"{label.lower().replace(' ', '-')}:cursor-not-found"
    prev, key, reads = None, None, []
    for n in range(presses + 1):
        g = lobby_gray(sh)
        if not lobby_title_is(g, "game_lobby"):
            sh.log(f"[lobby] game lobby gone during {label} search -- no more presses")
            return False
        if on_lobby is not None:
            on_lobby(g)
            on_lobby = None
        cur, means = lobby_cursor_of(g)
        reads.append(means)
        if cur == row:
            sh.log(f"lobby cursor {cur} for {label}")
            return True
        if n == presses:
            break
        # Prefer the short way; if the last press did not move the cursor (sweep2: UP from
        # NOT READY did nothing), go the other way round (the menu wraps on DOWN).
        want = "down" if cur < row else "up"
        if cur == prev and key is not None:
            want = "down" if key == "up" else "up"
        sh.press(want, 1.0)
        sh.log(f"lobby cursor {cur} -> {want}")
        prev, key = cur, want
    why = (f"cursor never read on {label} (row {row}) in {presses} presses; "
           f"row means (ARMORY, SWITCH TEAMS, READY) per read: {reads}")
    if lit_row is not None and lobby_row_lit(g, lit_row):
        sh.log(f"lobby cursor {cur} for {label} -- {lit_row} row lit by median, pressing on it; {why}")
        return True
    raise lobby_fail(sh, cls, why)


def briefing_select(sh, step, want):
    """Walk the BRIEFING ROOM's left menu to `want` (a BRIEFING_MENU name), one VERIFIED press per row, and
    return the number of presses. Each press is `press_verified`'s -- the same machinery, the same
    `[lobby] <step> press=<btn> verified=<bool> attempt=<n>` line and the same re-send -- with the check being
    "the next row down (or up) is now lit", so a dropped press is re-sent on the row it failed on rather than
    landing the walk one row short.

    The menu is read before the first press, never assumed: R240's run pressed CROSS on what it believed was
    JOIN GAME four times and the second capture (logs/parity/join_owner_lobby/miss_join_list_2.png) shows the
    cursor was on WATCH GAME by then -- the banner on it reads "... choose a game to watch." That the cursor had
    moved at all is unexplained by anything in this file; reading it costs one frame and removes the question."""
    g = lobby_gray(sh)
    if not lobby_title_is(g, "briefing_room"):
        raise lobby_fail(sh, step, f"the BRIEFING ROOM is not on screen (title band distance "
                                   f"{lobby_title_dist(g, 'briefing_room'):.3f})")
    here = briefing_focus_row(g)
    if here is None:
        raise lobby_fail(sh, step, f"no single row of the BRIEFING ROOM menu reads lit -- {briefing_rows_detail(g)}")
    i, j = BRIEFING_MENU.index(here), BRIEFING_MENU.index(want)
    if i == j:
        sh.log(f"[lobby] {step}: {want.replace('_', ' ').upper()} already lit")
        return 0
    btn, direction = ("down", 1) if j > i else ("up", -1)
    for k in range(i + direction, j + direction, direction):
        row = BRIEFING_MENU[k]
        press_verified(sh, f"{step}:{row.replace('_', '-')}", btn, 1.2,
                       lambda g, row=row: lobby_row_lit(g, row),
                       f"the {row.replace('_', ' ').upper()} row lit")
    return abs(j - i)


def refresh_games_list(sh):
    """REFRESH LIST, then back to JOIN GAME (R240: the driver never pressed it, so it could only ever see the
    list the room happened to open with).

    The CROSS on REFRESH LIST is the one press on this path that CANNOT be verified by what it produces: a
    refresh leaves no mark on the screen -- same title, same banner, same menu -- and the only readable
    difference it could make is the very games list the JOIN GAME press is about to read. So it is not sent
    through `press_verified`: a re-send there would be a CROSS pressed into whatever screen the check had just
    failed to recognise, which is the thing this file's verified presses exist to stop. It is pressed once, and
    the frame after it is read and logged in the same line format -- if the press took us off the briefing room,
    that is `join:refresh` and the run stops here instead of pressing on into a screen nobody named."""
    presses = briefing_select(sh, "join:refresh-select", "refresh_list")
    sh.press("cross", LOBBY_REFRESH_WAIT_S)
    g = lobby_gray(sh)
    still = lobby_title_is(g, "briefing_room")
    sh.log(f"[lobby] join:refresh press=cross verified={still} attempt=1 "
           f"(row {briefing_focus_row(g)}, banner {briefing_banner_span(g)} px, after {presses} select presses)")
    if not still:
        raise lobby_fail(sh, "join:refresh", "the REFRESH LIST press left the BRIEFING ROOM (title band distance "
                                             f"{lobby_title_dist(g, 'briefing_room'):.3f}) -- see the capture")
    sh.shot("11b_refresh_list")
    briefing_select(sh, "join:list-select", "join_game")


def join_list_check(sh, channel):
    """`press_verified`'s check for the CROSS on JOIN GAME, with the empty list taken out of the failure path.

    True only for "listed". "unpressed" is False, so the press is re-sent exactly as before. "none" -- the list
    came up EMPTY -- raises LobbyNoGames straight out of press_verified: re-sending CROSS at an empty list is
    what R240's run did four times, and the fourth press is one press away from opening WATCH GAME.

    And a re-send is refused outright once the cursor has left JOIN GAME. Between R240's first and second press
    the highlight moved to WATCH GAME and the banner with it ("... choose a game to watch.",
    logs/parity/join_owner_lobby/miss_join_list_2.png) -- nothing in this file presses DOWN there and the move is
    unexplained, but a CROSS re-sent onto that row opens the WATCH list, and the run would then be driving a
    screen nobody named. `join:cursor-drift` says so instead."""
    def check(g):
        state = join_list_state(g)
        row = briefing_focus_row(g)
        # Its own step word: `[lobby] join:list <...>` would be read as a press line by lobby_report and by
        # the tests' press_lines(), and this is a READ, not a press.
        sh.log(f"[lobby] join:list-read -> {state} (row {row}, banner {briefing_banner_span(g)} px, "
               f"first row median {lobby_row_median(g, 'games_list'):.0f})")
        if state == "none":
            raise lobby_no_games(sh, channel, 'the briefing room answered "There are no games to join."')
        if state == "unpressed" and row is not None and row != "join_game":
            raise lobby_fail(sh, CLASS_CURSOR_DRIFT,
                             f"the briefing room cursor is on {row.replace('_', ' ').upper()}, not JOIN GAME: "
                             "a re-sent CROSS would open that menu instead of the games list")
        return state == "listed"
    return check


@staged("join")
def join_game(sh, switch=True, channel=None, refresh=True):
    # join:refresh -- REFRESH LIST before anything else (R240). join:list -- JOIN GAME activates the games list
    # and highlights the host's game; a list that is up but EMPTY is `RESULT NO-GAMES`, not a failure
    # (join_list_check), and the re-sends now only fire for a press that did not register at all, giving a host
    # who is still creating the world up to 3 x 8 s more. join:enter -- launch1/1b's CROSS on the game left the
    # list on screen (band distance 0.577) although Medius had answered the join (research/21 §6.1).
    if refresh:
        refresh_games_list(sh)      # ends with the cursor READ back onto JOIN GAME, not assumed there
    # --no-refresh is the pre-R240 path exactly: no REFRESH LIST, no menu read, CROSS where the cursor already is.
    press_verified(sh, "join:list", "cross", 8.0,
                   join_list_check(sh, channel), "a game highlighted in the games list")
    sh.shot("12_games_list")
    press_verified(sh, "join:enter", "cross", 25.0,
                   lambda g: lobby_title_is(g, "game_lobby"), "the GAME LOBBY")
    sh.shot("16_game_lobby")
    press_verified(sh, "join:continue", "cross", 3.0,
                   lambda g: not lobby_notice_up(g), "the 30 s notice dismissed")
    sh.shot("17_game_lobby_ok")
    require_game_lobby(sh, "JOIN GAME")
    sh.lobby_role = "joiner"
    if switch:
        # --same-team: a match never starts with an empty team (s6_ladder9 sat on it until the liveness
        # timeout), so the flag no longer presses SWITCH TEAMS blind; the team read below decides.
        sh.log("[lobby] --same-team is superseded: the team read decides (one name per column)")
    join_balance_teams(sh)


def join_balance_teams(sh):
    """One name in each team column, or a SWITCH TEAMS press (cursor verified on its row) and a re-read, up
    to LOBBY_SWITCH_MAX presses; LobbyFail join:switch-teams when the names stay in one column.

    s6_ladder9: the joiner was auto-assigned to the host's team ("teams (seals, terrorists text px) (288, 0)";
    s6_ladder5/8 read (143, 144)) and the harness logged it and moved on; both instances then readied up and
    waited 200 s for a match that cannot start with an empty team. A frame with no name at all is re-read,
    never pressed on. Returns the number of SWITCH TEAMS presses it took."""
    seals = terrorists = 0
    state = "unread"
    for attempt in range(1, LOBBY_SWITCH_MAX + 2):
        seals, terrorists = lobby_teams(sh)
        state = lobby_teams_state(seals, terrorists)
        verdict = "switch" if state == "one-sided" else state
        sh.log(f"[lobby] teams: seals={seals} terrorists={terrorists} -> {verdict} (attempt {attempt})")
        if state == "ok":
            return attempt - 1
        if attempt > LOBBY_SWITCH_MAX:
            break
        if state == "unread":
            sh.stage_sleep(LOBBY_TEAMS_REREAD_S)
            continue
        if not lobby_select(sh, 1, "SWITCH TEAMS"):
            raise lobby_fail(sh, "join:switch-teams", "the game lobby was gone before the SWITCH TEAMS press "
                             f"(seals={seals} terrorists={terrorists})")
        sh.press("cross", 4.0)
        sh.shot("18_switched")
    if state == "unread":
        sh.log("[lobby] teams unread on every frame -- not pressing SWITCH TEAMS on it")
        return 0
    raise lobby_fail(sh, "join:switch-teams", f"both names still in one column after {LOBBY_SWITCH_MAX} SWITCH TEAMS "
                     f"presses: seals={seals} terrorists={terrorists} text px")


def ready_teams_check(sh, gray):
    """The team columns on the frame the READY search starts from: names in one column only is
    `<role>:teams-unbalanced` (host:... for the host, who cannot fix it but must not ready up and wait
    200 s for a match that never starts -- s6_ladder9); fewer than two names read is not a verdict."""
    seals, terrorists = lobby_teams_of(gray)
    state = lobby_teams_state(seals, terrorists)
    sh.log(f"[lobby] teams before READY: seals={seals} terrorists={terrorists} -> {state}")
    if state == "one-sided":
        raise lobby_fail(sh, f"{sh.lobby_role}:teams-unbalanced",
                         f"names in one team column only (seals={seals} terrorists={terrorists} text px); "
                         "a match never starts with an empty team")


@staged("ready")
def ready(sh):
    if not lobby_select(sh, 2, "READY", lit_row="ready",     # menu: ARMORY, SWITCH TEAMS, READY
                        on_lobby=lambda g: ready_teams_check(sh, g)):
        sh.shot("19_ready")                                  # the screen the search stopped on
        return
    sh.press("cross", 3.0)

    def read_label():
        """(edge, gone) on a fresh frame. No label with GAME LOBBY still up is an unread frame (s6_ladder9:
        the highlight off the row, the text dim) -- re-read up to READY_REREAD_MAX times READY_REREAD_GAP_S
        apart; `gone` only when the title band no longer reads GAME LOBBY."""
        for k in range(READY_REREAD_MAX + 1):
            g = lobby_gray(sh)
            edge = ready_label_edge(g)
            if edge is not None:
                return edge, False
            if not lobby_title_is(g, "game_lobby"):
                return None, True
            if k < READY_REREAD_MAX:
                sh.log(f"READY check: no row-2 label but GAME LOBBY still up -- re-read {k + 1}/{READY_REREAD_MAX}")
                sh.stage_sleep(READY_REREAD_GAP_S)
        return None, False

    def pair():
        """Two fresh frames READY_CONFIRM_GAP_S apart -> 'dropped' (both READY), 'taken' (neither),
        'gone' (no label on either and the lobby has been left), 'unread' (no label on either with the
        lobby still up), 'unsure'."""
        edges, gone = [], False
        for k in range(2):
            if k:
                sh.stage_sleep(READY_CONFIRM_GAP_S)
            edge, left = read_label()
            edges.append(edge)
            gone = gone or left
        sh.log(f"READY check: row-2 label right edges {edges} (READY ~48, NOT READY ~82)")
        if edges == [None, None]:
            return "gone" if gone else "unread"
        flags = [e is not None and e <= ready_edge_dropped_max() for e in edges]
        return "dropped" if all(flags) else "taken" if not any(flags) else "unsure"

    def dropped():
        # R69: READY is a toggle row, so a re-send on a late registration un-readies it. Press only when
        # both frames still read READY; on disagreement wait and re-check once, never press.
        state = pair()
        if state == "unsure":
            sh.stage_sleep(READY_CONFIRM_GAP_S)
            state = pair()
        if state == "unsure":
            raise lobby_fail(sh, CLASS_READY, "READY label frames disagree twice -- not pressing a toggle blind")
        if state == "unread":
            raise lobby_fail(sh, "ready:label-unread", f"no row-2 label on {2 * (READY_REREAD_MAX + 1)} frames "
                             "with GAME LOBBY still up -- not pressing a toggle blind")
        if state == "gone":
            sh.log("[lobby] game lobby gone during READY check -- no more presses")
        return state == "dropped"

    def resend():
        if lobby_select(sh, 2, "READY", lit_row="ready"):
            lobby_resend_cross(sh, 3.0)

    verify_resend(sh, CLASS_READY, dropped, resend)             # R47: re-sent while READY still shows
    sh.shot("19_ready")


def parse_args(argv=None):
    """The command line (a function so the option checks are tested, Sprint 16 L1b)."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="socomc")
    ap.add_argument("--password", default="socom")
    ap.add_argument("--out", default="logs/parity/ours_host")
    ap.add_argument("--seconds", type=int, default=500)
    ap.add_argument("--hold", type=int, default=30)
    ap.add_argument("--existing", action="store_true", help="the persona is already on the memory card")
    ap.add_argument("--host", action="store_true", help="after the briefing room: CREATE GAME (Frostfire, verified)")
    # Sprint 10 Goal 3 leg 2: ours as the JOINER of a game a console client hosts -- the briefing room, JOIN GAME
    # (verified), READY once the notice allows it, then the hold and the walk bursts (--hold / --play), as the
    # foreign-joiner host does in online_match_ours.
    ap.add_argument("--join", action="store_true", help="after the briefing room: JOIN GAME (verified), READY, hold, walk")
    ap.add_argument("--play", type=int, default=4, help="with --join: 3 s W bursts after the hold")
    # Fix wave W8 (R240): the room is chosen on BRIEFING ROOMS, one screen before the briefing room itself.
    # 1 is the old behaviour exactly (the list's first row, no press). See select_room for what 2+ costs.
    ap.add_argument("--channel", type=int, default=1,
                    help="which BRIEFING ROOMS entry to enter, 1-based (default 1: the first room)")
    ap.add_argument("--no-refresh", dest="refresh", action="store_false",
                    help="with --join: do NOT press REFRESH LIST before JOIN GAME (the pre-R240 path)")
    ap.add_argument("--instance", default="", help="A or B: window title, memory card dir and UDP ports of that instance")
    ap.add_argument("--then", default="", help="extra presses after the lobby, e.g. cross:3,type:test; chat:<text> "
                                               "opens the chat box with R1 and types <text> (Sprint 13 O2)")
    # Sprint 10 Goal 9: the name and password reach the game as the launcher's ONLINE fields would (PS2X_SOCOM2_LOGIN_NAME
    # / _PASS), its keyboards open already holding them, and the login presses ENTER on each instead of typing.
    ap.add_argument("--prefilled", action="store_true",
                    help="export --name / --password to the game and ENTER the prefilled keyboards instead of typing")
    # Fix wave W10 (R237 re-decided): the game's OWN remember-password, proven on a virgin card in two launches --
    # the first creates the persona with SAVE PASSWORD = YES, the second must log in with nothing typed.
    ap.add_argument("--save-password", action="store_true",
                    help="tick SAVE PASSWORD = YES on the form before CONNECT (the first launch of the W10 proof)")
    ap.add_argument("--saved-password", action="store_true",
                    help="type nothing: the form must arrive with the persona and its password from the card "
                         "(the relaunch of the W10 proof; an empty field fails as login:saved-password)")
    ap.add_argument("--mc-dir", default="", help="memory-card folder (PS2X_MC_DIR), created empty when absent")
    # Sprint 13 V6 (#27): end the run through the window's close (the runtime's own exit) instead of the kill.
    ap.add_argument("--clean-exit", action="store_true",
                    help="after the hold, close the game's window and wait for it to leave (CLEAN-EXIT rc=<n>); "
                         "the kill runs only if it has not")
    # Sprint 16 L1b (#73): a second (third, ...) persona on a card that already holds N on this server.
    ap.add_argument("--new-persona", type=int, default=None, metavar="N",
                    help="walk the game's persona list past the card's N saved personas to <New Persona> and create "
                         "--name there (fails as login:persona:new-persona when the pick is not the name keyboard)")
    a = ap.parse_args(argv)
    if a.save_password and a.saved_password:
        ap.error("--save-password and --saved-password are the two launches of one proof, not one launch")
    if a.new_persona is not None and a.new_persona < 1:
        ap.error("--new-persona N counts the personas already on the card: 1 or more")
    if a.new_persona is not None and a.saved_password:
        ap.error("--new-persona creates a persona; --saved-password logs in with one the card holds")
    a.prefill = None
    if a.prefilled:
        try:
            a.prefill = prefill_env(a.name, a.password)
        except ValueError as e:
            ap.error(f"--prefilled: {e}")                        # before any game starts: the runtime would cut it
    return a


def main():
    a = parse_args()
    prefill = a.prefill
    os.makedirs(a.out, exist_ok=True)
    if not a.instance and hostplatform.process_running("socom2"):
        raise SystemExit(f"{hostplatform.exe_name('socom2')} is already running; "
                         "refusing to start a second game instance")
    run_sh_out = os.path.join(a.out, "run_sh.txt")
    proc, title = launch(a.seconds, a.instance or None, prefill, **({"mc_dir": a.mc_dir} if a.mc_dir else {}),
                         **({"stdout_path": run_sh_out} if a.clean_exit else {}))
    sh = None
    try:
        sh = attach(proc, title, a.out)
        boot_to_online(sh)
        login(sh, a.name, a.password, a.existing, a.prefilled,
              **{k: True for k, v in (("save_password", a.save_password), ("saved_password", a.saved_password)) if v},
              **({"new_persona": a.new_persona} if a.new_persona is not None else {}))
        if a.host:
            to_briefing_room(sh, a.channel)
            host_game(sh)
        elif a.join:
            to_briefing_room(sh, a.channel)
            join_game(sh, channel=a.channel, refresh=a.refresh)
            time.sleep(35)                                   # READY becomes available
            ready(sh)
            for i in range(a.hold // 10):
                time.sleep(10)
                sh.shot(f"hold{i:02d}")
            for i in range(a.play):
                sh.hold("W", 3.0)
                sh.shot(f"play{i:02d}")
            sh.log("RESULT MIXED-MATCH host=foreign joiner=ours lobby=ok")
        sh.log(f"LOBBY class={CLASS_OK}")
        for n, step in enumerate(a.then.split(",") if a.then else []):
            b, w = (step.split(":") + ["2"])[:2]
            if b == "type":
                sh.type(w)
                sh.shot(f"20_then_{n:02d}_typed")
                continue
            if b == "chat":                                  # Sprint 13 O2: R1 opens the chat box, then type:<w>
                chat_line(sh, w, run_log=os.environ.get("PS2X_RUN_LOG"))
                continue
            sh.press(b, float(w))
            sh.shot(f"20_then_{n:02d}_{b}")
        for i in range(a.hold // 5):
            time.sleep(5)
            sh.shot(f"30_hold_{i:02d}")
        sh.shot("final")
        if a.clean_exit:
            rc = clean_exit(sh, proc, run_sh_out)
            sh.log(clean_exit_verdict(rc))
    finally:
        # V6 review: the kill says so, so a killed launch's log is self-describing beside a CLEAN-EXIT line
        note = ("[exit] kill: run.sh had already returned, the kill below is a no-op" if proc.poll() is not None
                else "[exit] kill: the game is ended by the harness (run.sh terminated, then the game's process)")
        (sh.log if sh is not None else print)(note)
        proc.terminate()
        if a.instance:
            # 2026-09-22 (the hosted join, 14:53): with --instance another socom2.exe on this PC may be the
            # owner's own launcher game, and `taskkill /F /IM socom2.exe` ended it with ours. Kill only the
            # game this run drove -- the process behind its window, else the launch's own process tree.
            pid = winshot.window_pid(sh.hwnd) if sh is not None else 0
            hostplatform.kill_process_tree(pid or proc.pid)
        else:
            hostplatform.kill_process_by_name("socom2")     # the guard above admitted no other instance


if __name__ == "__main__":
    main()
