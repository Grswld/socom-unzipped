"""Why the native VU1 dispatcher refuses, read from a run log (Sprint 17 F, research/81 §3.4).

What is read. Under PS2X_VU1_NATIVE_REFUSALS=1 (Dev) the runtime prints, once a second, one line per refusal key
whose counters moved in the interval (runtime/vu1_native_refusals.h):

    [vu1-refuse] elapsed=1002ms entry=0x1b50 reason=unknown_command cmd=0x52 n=37 cycles=412345 host_us=5120

n= refusals, cycles= the VU cycles the fallback (generated code or the interpreter) then ran for them, host_us= its
host time, all deltas over the interval. vu1_replay prints the running totals once, at its end, in the same fields:

    [vu1-refuse-total] entry=0x1b50 reason=unknown_command cmd=0x52 n=4 cycles=51234 host_us=610

A log holding total lines is read from those alone (they already sum everything); otherwise the interval lines are
summed. A window (--from/--to, sampler seconds, or --stamp <gate stamp dir> for the scripted walk) keeps the
interval lines whose preceding `[pc-sampler]` row falls inside it, frame_time's idiom for a clock-less line.

    python -m tools_py.parity.vu1_refusals <log> [--by reason|key] [--from <t>] [--to <t>] [--stamp <dir>]

prints a table -- reason (or entry/reason/cmd), entries, share of all refusals, cycles, share of all fallback
cycles, host ms -- sorted by cycles, then a total row, then a WARNING line when an `overflow=` line says the key
table was full (the rows are short by that many refusals); exits 1 when the log has no refusal line. A last line
without its newline (a log cut off, or read while written) is not read.
"""
import argparse
import os
import re
import sys

from tools_py.parity import frame_time

# Anchored at the line's end: a line that runs on into another (two writers, one stream) is not parsed short.
LINE_RE = re.compile(r"\[vu1-refuse(-total)?\]"
                     r"(?: elapsed=[0-9.]+ms)? entry=0x([0-9a-fA-F]+) reason=([a-z_]+) cmd=(-|0x[0-9a-fA-F]+)"
                     r" n=([0-9]+) cycles=([0-9]+) host_us=([0-9]+)\s*$")
# The refusals a full key table could not count (runtime: cumulative, once a second; vu1_replay: once, at its end).
OVERFLOW_RE = re.compile(r"\[vu1-refuse(-total)?\] overflow=([0-9]+) ")


def _finished_lines(text):
    """The log's lines, less a last one without its newline: a log read while it is written, or cut off, ends
    mid-line, and such a line may be cut anywhere (host_us=91 read as host_us=9)."""
    lines = text.splitlines(True)
    if lines and not lines[-1].endswith("\n"):
        lines.pop()
    return lines


def overflow(lines):
    """The refusals not counted because the key table was full: the total line's value if there is one, else the
    largest runtime value (it is cumulative); 0 when no overflow line."""
    total, runtime = None, 0
    for line in lines:
        m = OVERFLOW_RE.search(line)
        if not m:
            continue
        if m.group(1):
            total = int(m.group(2))
        else:
            runtime = max(runtime, int(m.group(2)))
    return total if total is not None else runtime


def rows(lines, t_from=None, t_to=None):
    """[(entry, reason, cmd, n, cycles, host_us)] from one log: the total lines if there are any, else the interval
    lines (inside the window when one is given). entry is an int, cmd an int or None."""
    totals, intervals, t = [], [], None
    windowed = t_from is not None or t_to is not None
    for line in lines:
        s = frame_time.SAMPLER_RE.search(line)
        if s:
            t = float(s.group(1))
            continue
        m = LINE_RE.search(line)
        if not m:
            continue
        cmd = None if m.group(4) == "-" else int(m.group(4), 16)
        row = (int(m.group(2), 16), m.group(3), cmd, int(m.group(5)), int(m.group(6)), int(m.group(7)))
        if m.group(1):
            totals.append(row)
            continue
        if windowed and (t is None or (t_from is not None and t < t_from) or (t_to is not None and t > t_to)):
            continue
        intervals.append(row)
    return totals if totals else intervals


def table(parsed, by="reason"):
    """[(label, entries, share, cycles, cycle_share, host_ms)] summed by reason or by (entry, reason, cmd), sorted by
    cycles then entries (descending); shares are fractions of the sums over every row."""
    sums = {}
    for entry, reason, cmd, n, cycles, host_us in parsed:
        if by == "key":
            label = "entry=0x%x %s cmd=%s" % (entry, reason, "-" if cmd is None else "0x%x" % cmd)
        else:
            label = reason
        acc = sums.setdefault(label, [0, 0, 0])
        acc[0] += n
        acc[1] += cycles
        acc[2] += host_us
    total_n = sum(v[0] for v in sums.values())
    total_cycles = sum(v[1] for v in sums.values())
    out = []
    for label, (n, cycles, host_us) in sums.items():
        out.append((label, n, n / total_n if total_n else 0.0, cycles,
                    cycles / total_cycles if total_cycles else 0.0, host_us / 1000.0))
    out.sort(key=lambda r: (-r[3], -r[1], r[0]))
    return out


def format_table(result, lost=0):
    """The printed table: a header, one row per label, a total row, and a warning when `lost` refusals overflowed
    the key table (the counts above are then short)."""
    width = max([len("reason")] + [len(r[0]) for r in result])
    head = "%-*s %10s %7s %14s %7s %10s" % (width, "reason", "entries", "share", "cycles", "share", "host_ms")
    lines = [head, "-" * len(head)]
    for label, n, share, cycles, cshare, host_ms in result:
        lines.append("%-*s %10d %6.1f%% %14d %6.1f%% %10.1f" % (width, label, n, 100.0 * share, cycles,
                                                                  100.0 * cshare, host_ms))
    lines.append("%-*s %10d %6.1f%% %14d %6.1f%% %10.1f" % (
        width, "total", sum(r[1] for r in result), 100.0 if result else 0.0, sum(r[3] for r in result),
        100.0 if result else 0.0, sum(r[5] for r in result)))
    if lost:
        lines.append("WARNING: overflow=%d refusals were not counted (the runtime's key table was full); the rows "
                     "above are short" % lost)
    return lines


def _read_lines(log_path):
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            return _finished_lines(f.read())
    except (OSError, TypeError):
        return []


def read(log_path, by="reason", t_from=None, t_to=None):
    """table() over one log file's finished lines; [] when it has no refusal line (or cannot be read)."""
    return table(rows(_read_lines(log_path), t_from, t_to), by)


def read_overflow(log_path):
    """overflow() over one log file's finished lines."""
    return overflow(_read_lines(log_path))


def stamp_window(stamp_dir):
    """(log, t_from, t_to) for a gate stamp: its mission.game.log over the scripted walk (the HUD step to the drive's
    last step, frame_time.hud_walk); None when the drive log is missing or never reached the HUD."""
    try:
        with open(os.path.join(stamp_dir, "mission.drive.log"), encoding="utf-8", errors="replace") as f:
            walk = frame_time.hud_walk(f.read())
    except (OSError, TypeError):
        return None
    if walk is None:
        return None
    return (os.path.join(stamp_dir, "mission.game.log"),) + tuple(walk)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m tools_py.parity.vu1_refusals",
                                 description="The native VU1 dispatcher's refusals: reason, entries, share, cycles.")
    ap.add_argument("log", nargs="?", help="a game log or vu1_replay output with [vu1-refuse] lines")
    ap.add_argument("--by", choices=("reason", "key"), default="reason",
                    help="sum by reason (default) or by entry/reason/cmd")
    ap.add_argument("--from", dest="t_from", type=float, default=None, help="sampler t, seconds (inclusive)")
    ap.add_argument("--to", dest="t_to", type=float, default=None, help="sampler t, seconds (inclusive)")
    ap.add_argument("--stamp", default=None, help="a gate stamp dir: its game log over the scripted walk")
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)
    log, t_from, t_to = args.log, args.t_from, args.t_to
    if args.stamp:
        window = stamp_window(args.stamp)
        if window is None:
            print("no scripted walk in %s (mission.drive.log missing or never reached the HUD)" % args.stamp,
                  file=sys.stderr)
            return 1
        log, t_from, t_to = window
    if not log:
        ap.error("a log or --stamp is required")
    result = read(log, args.by, t_from, t_to)
    if not result:
        print("no [vu1-refuse] line in %s (PS2X_VU1_NATIVE_REFUSALS unset, not in developer mode, or the window is "
              "empty)" % log, file=sys.stderr)
        return 1
    for line in format_table(result, read_overflow(log)):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
