"""Drive the PCSX2 SOCOM II client from savestate 9 ("LOGIN TO SOCOM II ONLINE") through universe
selection and the persona/login screen against the local Horizon stack.

Only savestate 9 is usable: states saved after any network activity restore with a stuck SMAP
transmit ring or dead input, so every step is scripted from slot 9.

Usage: python -m tools_py.parity.online_login [--name socom] [--password socom] [--out logs/parity/online/login]
"""
import argparse
import os
import subprocess
import time

from . import drive, hostplatform, keys

winshot = hostplatform.shot_module()   # winshot on Windows, x11shot on Linux (Sprint 8 Task 9)

# On-screen keyboard rows as index lists; the cursor moves by index between rows and CAPS/SHIFT/
# accent keys are index 0. ENTER is index 12 of the a-row.
OSK_ROWS = [
    ["~", "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "_", "+", "BCKSPC"],
    ["`", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "-", "=", "[", "]"],
    ["CAPS", "q", "w", "e", "r", "t", "y", "u", "i", "o", "p", "\\"],
    ["CAPS", "a", "s", "d", "f", "g", "h", "j", "k", "l", ";", "'", "ENTER"],
    ["SHIFT", "z", "x", "c", "v", "b", "n", "m", ",", ".", "/", "EXIT"],
    ["ACCENT", "TEAM", "{", "}", ":", "\"", "<", ">", "?", "|", "LEGEND"],
]
OSK_START = (5, 0)  # the keyboard opens with the accent key highlighted
# The column each row's index 0 sits in, for UP and DOWN: the cursor keeps its COLUMN between rows, not its index.
# Sprint 16 L1b Step 0 typed `s16pa` as `s27pa`: the game's panel (tools_py/tests/fixtures/lobby/osk_panel_kbd_lad7.png)
# draws the symbol row over the digit row key for key (~ over `), but the letter block starts one key further right --
# CAPS LOCK is wide, 'q' sits under '2', 'w' under '3' -- and UP from 'w' lands on '3', the key above it. Between the
# letter rows (half a key apart on the panel) the index model stands: every letter walk typed so far proves it.
# tools_py/tests/test_online_login_osk_digits.py measures this off the panel.
OSK_ROW_ORIGIN = (0, 0, 1, 1, 1, 1)


def osk_pos(label):
    for r, row in enumerate(OSK_ROWS):
        if label in row:
            return (r, row.index(label))
    raise KeyError(label)


def osk_moves(cur, dst):
    """Return the d-pad presses that move the cursor from cur to dst (row/index model; a vertical move keeps the
    cursor's column, OSK_ROW_ORIGIN, clamped to the row it lands in).
    Rows 2 and 3 share the CAPS key: moving down out of index 0 of row 2 lands on SHIFT, so
    vertical moves are done at a nonzero index whenever the target is not index 0."""
    moves = []
    r, i = cur
    tr, ti = dst
    if r != tr and i == 0 and ti != 0:
        # step to index 1 first so the CAPS/SHIFT column does not swallow a row change
        moves.append("right"); i = 1
    while r != tr:
        moves.append("down" if tr > r else "up")
        col = i + OSK_ROW_ORIGIN[r]
        r += 1 if tr > r else -1
        i = max(0, min(col - OSK_ROW_ORIGIN[r], len(OSK_ROWS[r]) - 1))
    while i != ti:
        moves.append("right" if ti > i else "left")
        i += 1 if ti > i else -1
    return moves


def osk_type(hwnd, text, shots=None, tag="", target="pcsx2"):
    cur = OSK_START
    for n, ch in enumerate(list(text) + ["ENTER"]):
        dst = osk_pos(ch)
        # Our exe runs the shell at 60 fps since 2026-09-09: a 0.15 s hold spans 9 frames and
        # trips the keyboard's auto-repeat (cursor overshoots, characters lost). 3 frames is enough.
        hold = 0.06 if target == "ours" else 0.15
        for m in osk_moves(cur, dst):
            keys.press(hwnd, m, target, hold_s=hold)
            time.sleep(0.35)
        cur = dst
        keys.press(hwnd, "cross", target, hold_s=hold)
        time.sleep(0.6)
        if shots and ch != "ENTER":
            winshot.capture(hwnd).save(os.path.join(shots, f"{tag}_key{n}_{ch}.png"))


def launch_state9():
    proc = subprocess.Popen([drive.PCSX2, "-batch", "-nogui", "-fastboot", "-state", "9", drive.ISO],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    t0 = time.time()
    hwnd = None
    while hwnd is None and time.time() - t0 < 60:
        hwnd = winshot.find_window(keys.WINDOW_TITLES["pcsx2"])
        time.sleep(1)
    time.sleep(10)
    return proc, hwnd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="socom")
    ap.add_argument("--password", default="socom")
    ap.add_argument("--out", default="logs/parity/online/login")
    ap.add_argument("--hold", type=int, default=40, help="seconds to watch after CONNECT")
    ap.add_argument("--existing", action="store_true", help="the persona is already on the memory card")
    ap.add_argument("--then", default="", help="extra presses after the lobby, e.g. cross:3,down:1,cross:10")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    proc, hwnd = launch_state9()
    shot = lambda n: winshot.capture(hwnd).save(os.path.join(a.out, n + ".png"))
    keys.press(hwnd, "cross", "pcsx2"); time.sleep(25); shot("01_universe")
    keys.press(hwnd, "cross", "pcsx2"); time.sleep(30); shot("02_persona")
    keys.press(hwnd, "cross", "pcsx2"); time.sleep(4)          # persona list
    if a.existing:
        keys.press(hwnd, "cross", "pcsx2"); time.sleep(3)      # first entry = saved persona
        shot("03_name")
    else:
        keys.press(hwnd, "cross", "pcsx2"); time.sleep(4)      # <New Persona> -> name keyboard
        osk_type(hwnd, a.name, a.out, "name"); time.sleep(3); shot("03_name")
    keys.press(hwnd, "down", "pcsx2"); time.sleep(1)           # PASSWORD field
    keys.press(hwnd, "cross", "pcsx2"); time.sleep(4); shot("04_pw_kbd")
    osk_type(hwnd, a.password); time.sleep(3); shot("05_password")
    for _ in range(4):                                         # SAVE PASSWORD, HOMETOWN, GENDER, CONNECT
        keys.press(hwnd, "down", "pcsx2"); time.sleep(0.8)
    shot("06_connect_focus")
    keys.press(hwnd, "cross", "pcsx2"); time.sleep(5); shot("07_after_connect")
    if not a.existing:
        # new persona: "write down your name" -> CONTINUE, save to card? -> YES, slot 1, overwrite -> YES
        keys.press(hwnd, "cross", "pcsx2"); time.sleep(4); shot("07_save_card")
        keys.press(hwnd, "cross", "pcsx2"); time.sleep(4); shot("07_card_slot")
        keys.press(hwnd, "cross", "pcsx2"); time.sleep(4); shot("07_overwrite")
        keys.press(hwnd, "left", "pcsx2"); time.sleep(0.8)
        keys.press(hwnd, "cross", "pcsx2")
    time.sleep(30); shot("08_eula")
    keys.press(hwnd, "cross", "pcsx2")                         # ACCEPT the user agreement
    time.sleep(20); shot("09_lobby")
    for n, step in enumerate(a.then.split(",") if a.then else []):
        b, w = (step.split(":") + ["2"])[:2]
        if b == "type":                                        # type:<text> on an open keyboard
            osk_type(hwnd, w); time.sleep(3); shot(f"10_then_{n:02d}_typed"); continue
        keys.press(hwnd, b, "pcsx2"); time.sleep(float(w)); shot(f"10_then_{n:02d}_{b}")
    for i in range(a.hold // 5):
        time.sleep(5); shot(f"11_hold_{i:02d}")
    hostplatform.kill_process_by_name("pcsx2-qt")


if __name__ == "__main__":
    main()
