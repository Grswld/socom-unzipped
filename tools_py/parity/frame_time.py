"""The mission stage's VBlank pacing, read from the `[pc-sampler]` rows of its game log (Sprint 13 Task V4).

What is measured. The sampler (PS2X_PC_SAMPLER=1, which the gate's mission stage sets) prints one row a second
with the FreezeFields (socom2_freeze_fields.h): `t=` is host seconds since the sampler's epoch and `vsync=` is
the guest VBlank count (EeScheduler::currentVSyncTick). The guest's VBlank is paced by the host: when the GL
replay falls behind, the GS back-pressure holds the EE at its sync and `vsync=` slows while `bp_wait_ms=`
climbs (research/34). The number is VBlank pacing -- host ms per guest VBlank, a lower bound on the time
between presents:

    host ms per guest VBlank = (t[i+1] - t[i]) * 1000 / (vsync[i+1] - vsync[i])

which is 16.67 at the console's 60. It is NOT the present rate: HostRenderFrame replays every guest frame
recorded since the last replay in one present, so presents can be fewer than VBlanks. docs/KNOWN.md §1's
two-instance clock row keeps the three apart -- the guest VBlank rate (this), the GL presents (`[gs-gl stats]`
`present=`) and the game's own draw rate (`[vu1-stats]` syncv/s). The FRAME line is the first.
Not used here: `ee=` (the guest EE clock, which counts wall time since research/34's fix and so reads ~1.00x
however many VBlanks are delivered), `seq=` (the kernel snapshot's sequence, a staleness marker, not a frame
count) and the `[gs-gl present]` lines (every 600th frame, no timestamp).

The third, the game's own frame rate (Sprint 17 F0): the gate's mission stage sets PS2X_VU_STATS=1, and the
runtime prints a `[vu1-stats]` line a second whose `syncv/s=` field (ps2_vu1_core.cpp, the print after
`s_lastSyncV`) counts the game's own sync calls -- the frames it drew. The line carries no clock, so each one is
attributed to the `[pc-sampler]` row before it (a line before the first row has no time and is not counted), and
the SYNCV line is the mean of the lines whose row falls inside the same scripted walk:

    SYNCV mean=<syncv/s>/s n=<lines>

The stretch is the scripted walk: sampler rows with `t=` from the drive log's step that follows the HUD
untilref match (s28 in gameplay_probe.txt) to the drive's last step (s48). The stage's unscripted tail after
the last step (the game left running until the stage's seconds run out, ~80-160 s at a different rate) is
left out -- it dominated the means when it was counted. The drive's `t=` counts from just after the launch and
the sampler's from after the runtime's start, so a drive time used as a sampler time is at most that start-up
gap later than the moment it names: the stretch starts at or just after the HUD and may end up to that gap
into the tail.

    mean     = total host ms over the stretch / total VBlanks over it
    worst1s  = the slowest sampler window's host ms per VBlank; a window in which vsync did not move is folded
               into the next one that did, so a stall reads as the long frame it was (the cadence is one
               second: a single frame shorter than that is not resolved -- this is the worst one-second mean)
    n        = VBlanks over the stretch

    python -m tools_py.parity.frame_time <stamp dir> [<stamp dir> ...]     # the walk, SYNCV, and the tail
"""
import os
import re
import sys
from collections import namedtuple

HUD_REF_NAME = "ref_hud_ours.png"        # gate.HUD_REF_NAME; a test holds the two equal
SAMPLER_RE = re.compile(r"\[pc-sampler\].*?\bt=([0-9]+(?:\.[0-9]+)?) vsync=([0-9]+)\b")
STEP_RE = re.compile(r"^s\d\d_\S+\s+t=\s*([0-9]+(?:\.[0-9]+)?)s", re.M)
SYNCV_RE = re.compile(r"\[vu1-stats\].*?\bsyncv/s=([0-9]+(?:\.[0-9]+)?)")

FrameTime = namedtuple("FrameTime", "mean_ms worst_ms n windows start_t end_t")
SyncV = namedtuple("SyncV", "mean n")


def hud_walk(drive_text, hud_ref=HUD_REF_NAME):
    """(start, end): the drive `t=` of the first step after the HUD untilref matched and of the drive's last
    step, or None (never matched, or no step after it)."""
    m = re.search(r"untilref\([^)]*%s[^)]*\):.*matched=True" % re.escape(hud_ref), drive_text)
    if not m:
        return None
    steps = [float(s) for s in STEP_RE.findall(drive_text, m.end())]
    return (steps[0], steps[-1]) if steps else None


def samples(lines):
    """[(t, vsync)] from the `[pc-sampler]` rows, in log order."""
    out = []
    for line in lines:
        m = SAMPLER_RE.search(line)
        if m:
            out.append((float(m.group(1)), int(m.group(2))))
    return out


def measure(rows, start_t, end_t=None):
    """FrameTime over the rows with start_t <= t <= end_t (no end: to the last row), or None when fewer than
    two rows or no VBlank."""
    rows = [(t, v) for t, v in rows if t >= start_t and (end_t is None or t <= end_t)]
    if len(rows) < 2:
        return None
    n = rows[-1][1] - rows[0][1]
    if n <= 0:
        return None
    mean = (rows[-1][0] - rows[0][0]) * 1000.0 / n
    worst, held, windows = 0.0, 0.0, 0
    for (t0, v0), (t1, v1) in zip(rows, rows[1:]):
        held += t1 - t0
        if v1 > v0:
            worst = max(worst, held * 1000.0 / (v1 - v0))
            held = 0.0
            windows += 1
    if held > 0.0:                      # the stretch ended in a stall: at least that long a frame
        worst = max(worst, held * 1000.0)
    return FrameTime(mean, worst, n, windows, rows[0][0], rows[-1][0])


def _load(drive_log, game_log):
    """((start, end), rows) or (None, why)."""
    try:
        with open(drive_log, encoding="utf-8", errors="replace") as f:
            walk = hud_walk(f.read())
    except (OSError, TypeError) as e:
        return None, "no drive log (%s)" % e
    if walk is None:
        return None, "HUD not reached in the drive log"
    try:
        with open(game_log, encoding="utf-8", errors="replace") as f:
            rows = samples(f)
    except (OSError, TypeError) as e:
        return None, "no game log (%s)" % e
    if not rows:
        return None, "no [pc-sampler] rows in the game log"
    return (walk, rows), None


def read(drive_log, game_log):
    """(FrameTime, None) or (None, why): the scripted walk of a mission stage's drive log and game log."""
    loaded, why = _load(drive_log, game_log)
    if loaded is None:
        return None, why
    (start, end), rows = loaded
    ft = measure(rows, start, end)
    if ft is None:
        return None, "fewer than two moving [pc-sampler] rows in the walk (t %.1f-%.1f s)" % (start, end)
    return ft, None


def read_tail(drive_log, game_log):
    """(FrameTime, None) or (None, why): the unscripted tail, from the drive's last step to the log's end."""
    loaded, why = _load(drive_log, game_log)
    if loaded is None:
        return None, why
    (_, end), rows = loaded
    ft = measure(rows, end)
    return (ft, None) if ft else (None, "no moving [pc-sampler] rows after t=%.1f s" % end)


def syncv_samples(lines):
    """[(t, syncv/s)]: each `[vu1-stats]` line's syncv/s with the `t=` of the `[pc-sampler]` row before it, in log
    order; a line before the first row has no time and is left out."""
    out, t = [], None
    for line in lines:
        m = SAMPLER_RE.search(line)
        if m:
            t = float(m.group(1))
            continue
        m = SYNCV_RE.search(line)
        if m and t is not None:
            out.append((t, float(m.group(1))))
    return out


def syncv(game_log_path, t_from, t_to):
    """SyncV(mean, n) over the `[vu1-stats]` lines attributed to t_from <= t <= t_to, or None when there is none
    (or no game log)."""
    try:
        with open(game_log_path, encoding="utf-8", errors="replace") as f:
            values = [v for t, v in syncv_samples(f) if t_from <= t <= t_to]
    except (OSError, TypeError):
        return None
    return SyncV(sum(values) / len(values), len(values)) if values else None


def read_syncv(game_log_path, t_from, t_to):
    """The mean syncv/s of the `[vu1-stats]` lines inside [t_from, t_to] (sampler seconds), or None."""
    sv = syncv(game_log_path, t_from, t_to)
    return sv.mean if sv else None


def _stamp_logs(stamp_dir):
    return os.path.join(stamp_dir, "mission.drive.log"), os.path.join(stamp_dir, "mission.game.log")


def read_stamp(stamp_dir):
    """read() over a gate stamp's mission.drive.log and mission.game.log."""
    return read(*_stamp_logs(stamp_dir))


def read_syncv_stamp(stamp_dir):
    """(SyncV, None) or (None, why): the `[vu1-stats]` syncv/s over a gate stamp's scripted walk -- the same walk,
    the HUD step to the last step, as the FRAME line's."""
    drive_log, game_log = _stamp_logs(stamp_dir)
    try:
        with open(drive_log, encoding="utf-8", errors="replace") as f:
            walk = hud_walk(f.read())
    except (OSError, TypeError) as e:
        return None, "no drive log (%s)" % e
    if walk is None:
        return None, "HUD not reached in the drive log"
    sv = syncv(game_log, *walk)
    if sv is None:
        return None, ("no [vu1-stats] syncv/s line in the walk (t %.1f-%.1f s; PS2X_VU_STATS unset, or no "
                      "[pc-sampler] row before the lines)" % walk)
    return sv, None


def syncv_line(sv, why=None):
    """The summary's SYNCV line, printed next to FRAME (informational, like it)."""
    if sv is None:
        return "SYNCV NO-DATA (%s)" % why
    return "SYNCV mean=%.1f/s n=%d (the game's own frame rate: [vu1-stats] syncv/s over the scripted walk)" % (
        sv.mean, sv.n)


def line(ft, why=None):
    """The summary's FRAME line."""
    if ft is None:
        return "FRAME NO-DATA (%s)" % why
    return ("FRAME mean=%.2f worst1s=%.2f n=%d (VBlank pacing: host ms per guest VBlank, a lower bound on the "
            "time between presents; the scripted walk, sampler t=%.1f s (the HUD step) to t=%.1f s (the last "
            "step), %d windows)" % (ft.mean_ms, ft.worst_ms, ft.n, ft.start_t, ft.end_t, ft.windows))


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        print("usage: python -m tools_py.parity.frame_time <stamp dir> [<stamp dir> ...]")
        return 2
    rc = 0
    for stamp in argv:
        name = os.path.basename(os.path.normpath(stamp))
        ft, why = read_stamp(stamp)
        print("%s %s" % (name, line(ft, why)))
        print("%s %s" % (name, syncv_line(*read_syncv_stamp(stamp))))
        tail, why = read_tail(*_stamp_logs(stamp))
        if tail:
            print("%s TAIL mean=%.2f worst1s=%.2f n=%d (not the gate's number: sampler t=%.1f-%.1f s, %d windows)"
                  % (name, tail.mean_ms, tail.worst_ms, tail.n, tail.start_t, tail.end_t, tail.windows))
        rc |= 0 if ft else 1
    return rc


if __name__ == "__main__":
    sys.exit(main())
