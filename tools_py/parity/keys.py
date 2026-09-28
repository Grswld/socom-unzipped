"""Post keyboard messages to a game window without changing focus.

Two key maps: PCSX2's [Pad1] keyboard bindings (tools/pcsx2/inis/PCSX2.ini) and our runner's
socom2_host_input keyboard map (arrows, Enter=START, Backspace=SELECT, Z/X/C/V = Square/Cross/
Circle/Triangle, Q/E = L1/R1, 1/3 = L2/R2)."""
import ctypes
import time

from . import hostplatform

if hostplatform.is_windows():
    from ctypes import wintypes as wt
    user32 = ctypes.windll.user32
else:
    # Linux (Sprint 8 Task 9): ctypes.wintypes does not import and there is no user32; the X twin
    # in x11shot does the injecting, so press() never reaches the PostMessage path below.
    wt = user32 = None
WM_KEYDOWN, WM_KEYUP = 0x0100, 0x0101
_ARROWS = {"UP": 0x26, "DOWN": 0x28, "LEFT": 0x25, "RIGHT": 0x27}
MAPS = {
    "pcsx2": {**_ARROWS, "CROSS": 0x4B, "CIRCLE": 0x4C, "SQUARE": 0x4A, "TRIANGLE": 0x49,
              "START": 0x0D, "SELECT": 0x08, "L1": 0x51, "R1": 0x45, "L2": 0x31, "R2": 0x33,
              "L3": 0x32, "R3": 0x34,
              # analog sticks, from [Pad1] LUp/LDown/LLeft/LRight (W S A D) and
              # RUp/RDown/RLeft/RRight (T G F H). Needed to drive movement on the reference:
              # docs/research/18-online-round-start.md §1 (the S0 verdict) was measured with these.
              "LUP": 0x57, "LDOWN": 0x53, "LLEFT": 0x41, "LRIGHT": 0x44,
              "RUP": 0x54, "RDOWN": 0x47, "RLEFT": 0x46, "RRIGHT": 0x48,
              # Sprint 10: the stick names a step script uses for OURS (W/A/S/D left stick, I/J/K/L right stick),
              # so one script drives both targets -- the same directions, PCSX2's own bindings.
              "W": 0x57, "S": 0x53, "A": 0x41, "D": 0x44, "I": 0x54, "K": 0x47, "J": 0x46, "L": 0x48,
              # W2.2c's light stick: keys 7 and 8 fire [Pad1] macros at a set pressure (a light Triangle, a
              # partial left stick up) that only seal_speed_probe --light writes into a temporary PCSX2.ini.
              "TRIANGLE_LIGHT": 0x37, "W_LIGHT": 0x38},
    "ours": {**_ARROWS, "CROSS": 0x58, "CIRCLE": 0x43, "SQUARE": 0x5A, "TRIANGLE": 0x56,
             "START": 0x0D, "SELECT": 0x08, "L1": 0x51, "R1": 0x45, "L2": 0x31, "R2": 0x33,
             # left stick (W/A/S/D) and right stick (I/J/K/L) in socom2_host_input.cpp keyboard mode
             "W": 0x57, "A": 0x41, "S": 0x53, "D": 0x44, "I": 0x49, "J": 0x4A, "K": 0x4B, "L": 0x4C},
}
# "ours": every title the runner opens ENDS with this (ps2x/host_window.h's kTitleSuffix, pinned by
# tests/test_host_window_title.py). It was "PS2-Recomp" until Sprint 10 Q4 gave the game window the launcher's
# name. The launcher's own window is "SOCOM Unzipped" with no dashes, so this key never picks it.
WINDOW_TITLES = {"pcsx2": "SOCOM II - U.S. Navy SEALs", "ours": "-- SOCOM Unzipped"}


def child_windows(main_hwnd):
    out = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _):
        out.append(h)
        return True

    user32.EnumChildWindows(main_hwnd, cb, 0)
    return out


def press(main_hwnd, button, target, hold_s=0.15):
    if not hostplatform.is_windows():       # Linux: xdotool keydown/keyup on the X window id
        from . import x11shot
        return x11shot.press(main_hwnd, button, target, hold_s)
    vk = MAPS[target][button.upper()]
    scan = user32.MapVirtualKeyW(vk, 0)
    ext = (1 << 24) if vk in _ARROWS.values() else 0   # arrows are extended keys
    for h in [main_hwnd] + child_windows(main_hwnd):
        user32.PostMessageW(h, WM_KEYDOWN, vk, (scan << 16) | ext | 1)
    time.sleep(hold_s)
    for h in [main_hwnd] + child_windows(main_hwnd):
        user32.PostMessageW(h, WM_KEYUP, vk, (scan << 16) | ext | 0xC0000001)
