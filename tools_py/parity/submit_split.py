"""The draw path's split, read from the `[gs-submit]` lines of a game log (Sprint 17 Task F1 Step 0).

What is read. With PS2X_GS_STATS=1 the runtime prints a `[gs-submit]` line once per stats cadence (Sprint 16 F2):

    [gs-submit] elapsed=1061ms flushes=1/s setup=84.8ms/s dirty_rows=1.7ms/s resolve=0.0ms/s draw=0.0ms/s ...

every field a per-second rate over the line's own `elapsed=` ms -- `<name>=<number>ms/s` (time spent in that phase
per second of wall) or `<name>=<number>/s` (a count per second). The line carries no clock, so each one is attributed
to the `[pc-sampler]` row before it (frame_time's idiom for the `[vu1-stats]` line; a line before the first row has
no time and is not counted), and a window's value of a field is the elapsed-weighted mean of the lines whose row
falls inside [t_from, t_to] -- research/73 §8's command [C]:

    field = sum(value_i * elapsed_i) / sum(elapsed_i)

so a long cadence counts for its length. Every draw-path attempt's before/after is then one command:

    python -m tools_py.parity.submit_split <game log> [--from <t>] [--to <t>]     # sampler seconds, inclusive

which prints one `name=value` per line (ms/s fields with one decimal, /s fields with two), then `elapsed_ms=` (the
summed elapsed) and `lines=` (the count), and exits 1 when no line falls in the window. `from_stamp(stamp_dir)` reads
a gate stamp over the same scripted walk as the FRAME line (the HUD step to the drive's last step).
"""
import argparse
import os
import re
import sys

from tools_py.parity import frame_time

SUBMIT_TAG = "[gs-submit]"
ELAPSED_RE = re.compile(r"\belapsed=([0-9]+(?:\.[0-9]+)?)ms\b")
FIELD_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)=([0-9]+(?:\.[0-9]+)?)(ms)?/s\b")


def samples(lines):
    """[(t, elapsed_ms, [(name, value, is_ms)])]: each `[gs-submit]` line with the `t=` of the `[pc-sampler]` row
    before it, in log order; a line before the first row, or without `elapsed=`, is left out."""
    out, t = [], None
    for line in lines:
        m = frame_time.SAMPLER_RE.search(line)
        if m:
            t = float(m.group(1))
            continue
        at = line.find(SUBMIT_TAG)
        if at < 0 or t is None:
            continue
        body = line[at + len(SUBMIT_TAG):]
        e = ELAPSED_RE.search(body)
        if not e:
            continue
        fields = [(f.group(1), float(f.group(2)), bool(f.group(3))) for f in FIELD_RE.finditer(body)]
        out.append((t, float(e.group(1)), fields))
    return out


def _split(game_log_path, t_from=None, t_to=None):
    """(result, ms_names): read()'s dict, and the names printed as ms/s."""
    try:
        with open(game_log_path, encoding="utf-8", errors="replace") as f:
            rows = samples(f)
    except (OSError, TypeError):
        return {}, set()
    rows = [r for r in rows if (t_from is None or r[0] >= t_from) and (t_to is None or r[0] <= t_to)]
    if not rows:
        return {}, set()
    weighted, weight, ms_names = {}, {}, set()
    for _, elapsed, fields in rows:
        for name, value, is_ms in fields:
            weighted[name] = weighted.get(name, 0.0) + value * elapsed
            weight[name] = weight.get(name, 0.0) + elapsed
            if is_ms:
                ms_names.add(name)
    result = {name: (weighted[name] / weight[name] if weight[name] else 0.0) for name in weighted}
    result["elapsed_ms"] = sum(r[1] for r in rows)
    result["lines"] = len(rows)
    return result, ms_names


def read(log_path, t_from=None, t_to=None):
    """{field: elapsed-weighted mean} over the `[gs-submit]` lines attributed to t_from <= t <= t_to (sampler
    seconds; None = unbounded), keys as printed, plus `elapsed_ms` (the sum) and `lines` (the count); {} when no
    line falls in the window (or no log)."""
    return _split(log_path, t_from, t_to)[0]


def _walk(stamp_dir):
    drive_log = os.path.join(stamp_dir, "mission.drive.log")
    try:
        with open(drive_log, encoding="utf-8", errors="replace") as f:
            return frame_time.hud_walk(f.read())
    except (OSError, TypeError):
        return None


def from_stamp(stamp_dir):
    """read() over a gate stamp's mission.game.log in the scripted walk -- the HUD step to the drive's last step, as
    frame_time.read_stamp takes it; {} when the drive log is missing or never reached the HUD."""
    walk = _walk(stamp_dir)
    if walk is None:
        return {}
    return read(os.path.join(stamp_dir, "mission.game.log"), *walk)


def format_lines(result, ms_names=()):
    """`name=value` lines: ms/s fields with one decimal, /s fields with two, then elapsed_ms and lines."""
    out = []
    for name, value in result.items():
        if name in ("elapsed_ms", "lines"):
            continue
        out.append("%s=%.1f" % (name, value) if name in ms_names else "%s=%.2f" % (name, value))
    out.append("elapsed_ms=%d" % round(result["elapsed_ms"]))
    out.append("lines=%d" % result["lines"])
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m tools_py.parity.submit_split",
                                 description="The [gs-submit] fields, elapsed-weighted over a sampler-t window.")
    ap.add_argument("log", help="a game log with [pc-sampler] rows and [gs-submit] lines")
    ap.add_argument("--from", dest="t_from", type=float, default=None, help="sampler t, seconds (inclusive)")
    ap.add_argument("--to", dest="t_to", type=float, default=None, help="sampler t, seconds (inclusive)")
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)
    result, ms_names = _split(args.log, args.t_from, args.t_to)
    if not result:
        print("no [gs-submit] line after a [pc-sampler] row in the window (PS2X_GS_STATS unset, or the window "
              "is empty)", file=sys.stderr)
        return 1
    for line in format_lines(result, ms_names):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
