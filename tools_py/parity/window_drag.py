"""Issue #67 (Sprint 15 T2): a scripted title-bar drag of the game window, and the readout of what the guest clock did
through it.

Why. A title-bar drag puts the window's thread in the Win32 modal move loop (WM_ENTERSIZEMOVE to WM_EXITSIZEMOVE).
That thread is the one that replays and presents, and the guest's frame back-pressure waited on it, so before #67's
fix the guest clock stood still for the length of the drag (KNOWN section 1's #67 row; the render-thread stall class
in docs/HAZARDS.md). The fix releases the back-pressure while the runtime is inside that loop; this module is how a
run proves it, on the `[pc-sampler]` rows (PS2X_PC_SAMPLER=<period s>): `t=` is host seconds since the sampler's
epoch and advances whatever the guest does (the sampler has its own thread); `vsync=` is the guest VBlank count, the
number that stands still in a freeze (socom2_freeze_fields.h; frame_time.py reads the same pair).

The drag's window, in the sampler's own `t=`, from (first that exists):
  * the driver's stamps, `[window-drag] begin t=<t> ...` / `[window-drag] end t=<t> ...` -- printed by `drag` below
    on its stdout (and appended to --stamps); `t=` is the last sampler row the driver read in the game log at the
    mouse-down and at the mouse-up, so the window is exact to one sampler period; they may sit in the game log or
    in a file of their own (`readout --stamps <file>`);
  * the runtime's own `[window] move loop entered ...` / `[window] move loop left ...` lines (the fixed exe prints
    them from its window procedure): the window is the sampler rows between the two lines.

The verdict, over the sampler rows inside the window (at least two):
    rate      = vsync advance / host seconds, across the window
    baseline  = the same over the 10 s before the window (59.94/s, the NTSC VBlank, when there are no rows there)
    still     = the longest host span inside the window over which vsync did not move
    FROZEN    rate < 25 % of baseline
    ADVANCING rate >= 75 % of baseline and still < 1.0 s
    SLOWED    anything between (the pre-#67 shape where the 2 s back-pressure cap fires and the guest crawls)
    NO-DATA   fewer than two sampler rows in the window
The `[audio-trace]` counters are read from the last line before the window and the first after it, by position in the
game log: #67's bar wants cb_late, cb_dry and pcm_underruns unchanged through the drag. The line itself needs
PS2X_AUDIO_TRACE=1 (one every 5 s, with pcm_underruns); its `cb_late=`/`cb_dry=` fields are printed only when the
callback trace is on as well, PS2X_AUDIO_CB_TRACE=<csv path> (ps2_audio.cpp). A field that is not on both lines reads
`absent`, never 0, and fails the readout: an absent counter is not an unchanged one.

    python -m tools_py.parity.window_drag readout <game log> [--stamps <file>]
        one DRAG line per window; exit 0 when every window is ADVANCING with its three audio counters present and
        +0, 1 when one is FROZEN or SLOWED or an audio counter is absent or moved, 2 when there is no window or a
        window has no data
    python -m tools_py.parity.window_drag drag --log <game log> [--seconds 10] [--dx 300] [--delay 0]
                                               [--stamps <file>] [--wait-window 120]
        Windows only: finds the game window, presses the left button on its caption (checked by WM_NCHITTEST),
        moves the cursor `dx` pixels out and back over `seconds` by SetCursorPos, releases, puts the window back,
        and prints the two stamps. Whether the drag TOOK (`drag_took`): the press landed on the caption, and then
        the game log's `[window] move loop entered` line after the press when the exe prints them (it announces
        `[window] move-loop hook installed`), else the window rectangle at the path's far point, off the start (the
        rectangle does not follow the cursor when "show window contents while dragging" is off, so it is the
        fallback, not the proof). Exit 0 when it took, 1 when it did not, 3 when the window or its caption was not
        found.
"""
import re
import sys
import time
from collections import namedtuple

SAMPLER_RE = re.compile(r"\[pc-sampler\].*?\bt=([0-9]+(?:\.[0-9]+)?) vsync=([0-9]+)\b")
STAMP_RE = re.compile(r"\[window-drag\] (begin|end) t=([0-9]+(?:\.[0-9]+)?)\b")
LOOP_ENTER_TAG = "[window] move loop entered"
LOOP_LEAVE_TAG = "[window] move loop left"
AUDIO_TAG = "[audio-trace]"
AUDIO_FIELD_RE = {k: re.compile(r"\b%s=(\d+)" % k) for k in ("cb_late", "cb_dry", "pcm_underruns")}
ABSENT = "absent"
HOOK_TAG = "[window] move-loop hook installed"

NTSC_VBLANK_HZ = 59.94
BASELINE_S = 10.0
FROZEN_BELOW = 0.25
ADVANCING_FROM = 0.75
STILL_LIMIT_S = 1.0

Readout = namedtuple("Readout", "verdict t0 t1 source rows vsync_delta rate_hz baseline_hz longest_still_s "
                                "audio_before audio_after audio_delta audio_problem")
AUDIO_KEYS = ("cb_late", "cb_dry", "pcm_underruns")


def samples(lines):
    """[(t, vsync, line index)] from the `[pc-sampler]` rows, in log order."""
    out = []
    for i, line in enumerate(lines):
        m = SAMPLER_RE.search(line)
        if m:
            out.append((float(m.group(1)), int(m.group(2)), i))
    return out


def _driver_windows(lines):
    windows, begin = [], None
    for line in lines:
        m = STAMP_RE.search(line)
        if not m:
            continue
        if m.group(1) == "begin":
            begin = float(m.group(2))
        elif begin is not None:
            windows.append((begin, float(m.group(2))))
            begin = None
    return windows


def _runtime_windows(lines, rows):
    """Sampler rows between an `entered` line and the next `left` line: (t of the first, t of the last)."""
    windows, enter_at = [], None
    for i, line in enumerate(lines):
        if LOOP_ENTER_TAG in line:
            enter_at = i
        elif LOOP_LEAVE_TAG in line and enter_at is not None:
            inside = [t for t, _, idx in rows if enter_at < idx < i]
            windows.append((inside[0], inside[-1]) if inside else (None, None))
            enter_at = None
    return windows


def _audio(line):
    """{field: int or None} from an `[audio-trace]` line (None = the field is not on it), or None for another line."""
    if AUDIO_TAG not in line:
        return None
    tail = line[line.index(AUDIO_TAG):]
    out = {}
    for k, rx in AUDIO_FIELD_RE.items():
        m = rx.search(tail)
        out[k] = int(m.group(1)) if m else None
    return out


def audio_delta(before, after):
    """{field: after - before, or ABSENT when the field is not on both lines}, and the problem (None when all three
    are present and +0)."""
    if before is None or after is None:
        return None, "audio trace absent: set PS2X_AUDIO_TRACE=1 (and PS2X_AUDIO_CB_TRACE=<csv> for cb_late/cb_dry)"
    delta = {}
    for k in AUDIO_KEYS:
        delta[k] = ABSENT if before.get(k) is None or after.get(k) is None else after[k] - before[k]
    missing = [k for k in AUDIO_KEYS if delta[k] == ABSENT]
    if any(k.startswith("cb_") for k in missing):
        return delta, "cb trace absent: set PS2X_AUDIO_CB_TRACE=<csv path>"
    if missing:
        return delta, "%s absent" % ", ".join(missing)
    moved = [k for k in AUDIO_KEYS if delta[k] != 0]
    if moved:
        return delta, "audio counters moved through the drag: %s" % ", ".join(moved)
    return delta, None


def _audio_around(lines, first_idx, last_idx):
    before = after = None
    for i in range(first_idx - 1, -1, -1):
        before = _audio(lines[i])
        if before:
            break
    for i in range(last_idx + 1, len(lines)):
        after = _audio(lines[i])
        if after:
            break
    return before, after


def _longest_still(inside):
    longest, run_start = 0.0, 0
    for k in range(1, len(inside)):
        if inside[k][1] != inside[run_start][1]:
            run_start = k
        longest = max(longest, inside[k][0] - inside[run_start][0])
    return longest


def _rate(rows):
    if len(rows) < 2 or rows[-1][0] <= rows[0][0]:
        return None
    return (rows[-1][1] - rows[0][1]) / (rows[-1][0] - rows[0][0])


def _read_window(lines, rows, t0, t1, source):
    if t0 is None or t1 is None:
        return Readout("NO-DATA", t0, t1, source, 0, 0, None, None, 0.0, None, None, None, None)
    inside = [r for r in rows if t0 - 1e-6 <= r[0] <= t1 + 1e-6]
    before = [r for r in rows if t0 - BASELINE_S - 1e-6 <= r[0] < t0 - 1e-6]
    baseline = _rate(before) or NTSC_VBLANK_HZ
    rate = _rate(inside)
    if rate is None:
        return Readout("NO-DATA", t0, t1, source, len(inside), 0, None, baseline, 0.0, None, None, None, None)
    delta = inside[-1][1] - inside[0][1]
    still = _longest_still(inside)
    ratio = rate / baseline if baseline > 0 else 0.0
    if ratio < FROZEN_BELOW:
        verdict = "FROZEN"
    elif ratio >= ADVANCING_FROM and still < STILL_LIMIT_S:
        verdict = "ADVANCING"
    else:
        verdict = "SLOWED"
    a_before, a_after = _audio_around(lines, inside[0][2], inside[-1][2])
    a_delta, a_problem = audio_delta(a_before, a_after)
    return Readout(verdict, t0, t1, source, len(inside), delta, rate, baseline, still, a_before, a_after, a_delta,
                   a_problem)


def readouts(lines, stamp_lines=None):
    """One Readout per drag window. The driver's stamps (in `lines` or `stamp_lines`) win over the runtime's lines."""
    lines = [line.rstrip("\r\n") for line in lines]
    rows = samples(lines)
    windows = _driver_windows(list(stamp_lines or []) + lines)
    if windows:
        return [_read_window(lines, rows, t0, t1, "driver") for t0, t1 in windows]
    return [_read_window(lines, rows, t0, t1, "runtime") for t0, t1 in _runtime_windows(lines, rows)]


def format_readout(r):
    if r.t0 is None or r.t1 is None:
        return "DRAG (the runtime's move-loop lines hold no sampler row, from the %s): NO-DATA" % r.source
    head = "DRAG t=%.2f-%.2f s (%.1f s, from the %s's %s): %s" % (
        r.t0, r.t1, r.t1 - r.t0, r.source, "stamps" if r.source == "driver" else "move-loop lines", r.verdict)
    if r.rate_hz is None:
        return head + " -- %d sampler row(s) in the window, two needed" % r.rows
    pct = 100.0 * r.rate_hz / r.baseline_hz if r.baseline_hz else 0.0
    text = head + " -- vsync +%d over %d rows (%.1f/s against %.1f/s before, %.0f %%), longest still %.2f s" % (
        r.vsync_delta, r.rows, r.rate_hz, r.baseline_hz, pct, r.longest_still_s)
    if r.audio_delta is not None:
        text += "; audio " + " ".join(
            "%s %s" % (k, ABSENT if r.audio_delta[k] == ABSENT else "+%d" % r.audio_delta[k]) for k in AUDIO_KEYS)
    if r.audio_problem:
        text += "; AUDIO FAIL: " + r.audio_problem
    return text


def exit_code(results):
    if any(r.verdict in ("FROZEN", "SLOWED") for r in results):
        return 1
    if not results or any(r.verdict == "NO-DATA" for r in results):
        return 2
    if any(r.audio_problem for r in results):
        return 1
    return 0


# ---- the driver --------------------------------------------------------------------------------------------------

def last_sampler_t(text):
    """The `t=` of the last complete `[pc-sampler]` row in `text`, or None."""
    last = None
    for m in SAMPLER_RE.finditer(text):
        last = float(m.group(1))
    return last


def _tail(path, nbytes=262144):
    with open(path, "rb") as fh:
        fh.seek(0, 2)
        size = fh.tell()
        fh.seek(max(0, size - nbytes))
        return fh.read().decode("utf-8", "replace")


def drag_path(x, y, dx, seconds, step_s):
    """Cursor points from (x, y) out `dx` pixels to the right and back, one per `step_s`, over `seconds`."""
    n = max(2, int(round(seconds / step_s)))
    return [(x + int(round(dx * (1.0 - abs(2.0 * i / n - 1.0)))), y) for i in range(n + 1)]


def caption_point(window_rect, client_top):
    """A point on the caption: a third of the way across (clear of the icon and the buttons), half way between the
    window's top edge and the client area's."""
    left, top, right, _ = window_rect
    return left + (right - left) // 3, top + (client_top - top) // 2


def drag_took(log_since_press, log_has_hook, rect_start, rect_far):
    """(took, how) for a press that already landed on the caption (WM_NCHITTEST = HTCAPTION, checked before).
    `log_since_press` is the game log's text written after the mouse-down; `log_has_hook` says the exe announces
    its move-loop lines; `rect_far` is the window rectangle at the path's far point."""
    if "[window] move loop entered" in log_since_press:
        return True, "move-loop line"
    if log_has_hook:
        return False, "the exe prints move-loop lines and none followed the press"
    if rect_far != rect_start:
        return True, "window rectangle moved"
    return False, "no move-loop line (older exe) and the rectangle did not move (window contents while dragging off?)"


def _stamp(text, stamps_path):
    print(text, flush=True)
    if stamps_path:
        with open(stamps_path, "a", encoding="utf-8") as fh:
            fh.write(text + "\n")


def drag(log_path, seconds=10.0, dx=300, delay=0.0, stamps_path=None, wait_window_s=120.0, step_s=0.05):
    if sys.platform != "win32":
        raise RuntimeError("window_drag drag drives the Win32 modal move loop; this host is %s" % sys.platform)
    import ctypes
    import ctypes.wintypes as wt
    from tools_py.parity import keys, winshot

    user32 = ctypes.windll.user32
    user32.SetProcessDPIAware()   # physical pixels, as the game's HIGHDPI window reports them
    user32.SendMessageTimeoutW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM, wt.UINT, wt.UINT,
                                           ctypes.POINTER(ctypes.c_size_t)]
    user32.SendMessageTimeoutW.restype = ctypes.c_size_t
    WM_NCHITTEST, HTCAPTION, SMTO_ABORTIFHUNG = 0x0084, 2, 0x0002
    LEFTDOWN, LEFTUP = 0x0002, 0x0004

    deadline = time.time() + wait_window_s
    hwnd = None
    while time.time() < deadline and not hwnd:
        hwnd = winshot.find_window(keys.WINDOW_TITLES["ours"])
        if not hwnd:
            time.sleep(0.5)
    if not hwnd:
        print("[window-drag] error: the game window never appeared", flush=True)
        return 3
    if delay > 0:
        time.sleep(delay)

    def rect():
        r = wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        return r.left, r.top, r.right, r.bottom

    start = rect()
    origin = wt.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    x, y = caption_point(start, origin.y)
    hit = ctypes.c_size_t(0)
    lparam = ((y & 0xFFFF) << 16) | (x & 0xFFFF)
    user32.SendMessageTimeoutW(hwnd, WM_NCHITTEST, 0, lparam, SMTO_ABORTIFHUNG, 1000, ctypes.byref(hit))
    if hit.value != HTCAPTION:
        print("[window-drag] error: (%d, %d) is not the caption (WM_NCHITTEST=%d)" % (x, y, hit.value), flush=True)
        return 3
    user32.SetForegroundWindow(hwnd)
    user32.SetCursorPos(x, y)
    time.sleep(0.3)
    import os
    press_offset = os.path.getsize(log_path)
    has_hook = HOOK_TAG in _tail(log_path, nbytes=press_offset or 1)
    rect_far = start
    t_begin = last_sampler_t(_tail(log_path))
    user32.mouse_event(LEFTDOWN, 0, 0, 0, 0)
    _stamp("[window-drag] begin t=%s wall=%.3f x=%d y=%d seconds=%.1f dx=%d"
           % ("%.2f" % t_begin if t_begin is not None else "?", time.time(), x, y, seconds, dx), stamps_path)
    try:
        path = drag_path(x, y, dx, seconds, step_s)
        far = len(path) // 2
        for i, (px, py) in enumerate(path[1:], start=1):
            user32.SetCursorPos(px, py)
            time.sleep(step_s)
            if i == far:
                rect_far = rect()
    finally:
        user32.mouse_event(LEFTUP, 0, 0, 0, 0)
    t_end = last_sampler_t(_tail(log_path))
    time.sleep(0.5)   # the runtime's "left" line and the last rows reach the file
    with open(log_path, "rb") as fh:
        fh.seek(press_offset)
        since = fh.read().decode("utf-8", "replace")
    took, how = drag_took(since, has_hook, start, rect_far)
    _stamp("[window-drag] end t=%s wall=%.3f took=%s (%s)"
           % ("%.2f" % t_end if t_end is not None else "?", time.time(), "yes" if took else "no", how), stamps_path)
    if rect() != start:
        user32.MoveWindow(hwnd, start[0], start[1], start[2] - start[0], start[3] - start[1], True)
    return 0 if took else 1


def main(argv):
    if not argv or argv[0] not in ("readout", "drag"):
        print(__doc__.strip().splitlines()[0])
        print("usage: python -m tools_py.parity.window_drag readout <game log> [--stamps <file>]")
        print("       python -m tools_py.parity.window_drag drag --log <game log> [--seconds 10] [--dx 300] "
              "[--delay 0] [--stamps <file>] [--wait-window 120]")
        return 2
    args, opts = [], {}
    rest = list(argv[1:])
    while rest:
        a = rest.pop(0)
        if a.startswith("--") and rest:
            opts[a[2:]] = rest.pop(0)
        else:
            args.append(a)
    if argv[0] == "readout":
        if len(args) != 1:
            print("readout takes one game log")
            return 2
        with open(args[0], encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
        stamp_lines = None
        if "stamps" in opts:
            with open(opts["stamps"], encoding="utf-8", errors="replace") as fh:
                stamp_lines = fh.readlines()
        results = readouts(lines, stamp_lines)
        if not results:
            print("DRAG none: no [window-drag] stamps and no [window] move-loop lines in the log")
        for r in results:
            print(format_readout(r))
        return exit_code(results)
    if "log" not in opts:
        print("drag needs --log <game log> (the sampler rows it stamps from)")
        return 2
    return drag(opts["log"], seconds=float(opts.get("seconds", 10.0)), dx=int(opts.get("dx", 300)),
                delay=float(opts.get("delay", 0.0)), stamps_path=opts.get("stamps"),
                wait_window_s=float(opts.get("wait-window", 120.0)))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
