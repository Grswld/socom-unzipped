"""The draw-path bench's reader (Sprint 17 F): run dist/gs_replay_bench.exe on a recording and compare two runs.

A recording is the GL thread's replayed command stream for a window of presents, written by a game run with
PS2X_GS_RECORD=<file>[:<present>|t<seconds>|trig[:<presents>]] (the runtime's gs_gl_replay_file.h). The bench replays
it through the GL backend on a hidden window -- no game, no lock -- and prints one line,

    [gs-replay-bench] recording=<name> per=60frames frames=<n> warmup=<w> batches=<b> elapsed=<ms>ms fps=<x>
        ms_per_frame=<x>ms flushes=<x>/s setup=<x>ms/s dirty_rows= resolve= draw= readback= readbacks=<x>/s ...
        submit=<x>ms/s transfer= upload= wvram= clear= present= readback_cmd= hist_n=<n> le17= ... longest_ms=<x>

with the same numbers in a JSON beside it. The [gs-submit] fields keep submit_split's names; a "ms/s" or "/s" here
is per 60 replayed presents (per second of game at 60 presents a second), not per second of wall, so a field only
moves when its own cost does. Every draw-path attempt is then:

    python -m tools_py.parity.replay_bench run <recording> --json logs/bench/before.json      # on the old exe
    python -m tools_py.parity.replay_bench run <recording> --json logs/bench/after.json       # on the new one
    python -m tools_py.parity.replay_bench compare logs/bench/before.json logs/bench/after.json

`compare` prints one line a field -- name, before, after, the change in percent of before (`n/a` when before is 0)
-- over the fields both summaries hold, in the before summary's order, then fps, elapsed_ms and the histogram. The
bench applies the recording's PS2X_GS_* knobs unless told otherwise (`--knob NAME=VALUE`) and writes what it applied
under `knobs`; when a pair's knobs differ, compare prints a WARNING line per knob on stderr (not a clean A/B) and
still compares. `run` deletes any JSON already at the output path before the bench starts and fails when the bench
writes none, so a summary is never an earlier run's.

Run: python -m tools_py.parity.replay_bench run <recording> [--exe dist/gs_replay_bench.exe] [--json out] [--warmup N] [--frames N]
A relative --exe (and the default) is taken against the repository root and spawned by its absolute path (#117).
"""
import argparse
import json
import os
import re
import subprocess
import sys

SUMMARY_TAG = "[gs-replay-bench]"
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT_EXE = os.path.join("dist", "gs_replay_bench.exe")
TOKEN_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)=(\S+)")
NUMBER_RE = re.compile(r"^(-?[0-9]+(?:\.[0-9]+)?)(ms/s|/s|ms)?$")
HIST_KEYS = ("le17", "le20", "le25", "le33", "le50", "le100", "over", "longest_ms")
INT_TOP = ("frames", "warmup", "batches", "recorder_swizzled")
STR_TOP = ("recording", "per")


def _number(text):
    m = NUMBER_RE.match(text)
    return (float(m.group(1)), m.group(2)) if m else (None, None)


def parse_line(line):
    """The summary dict (the JSON's shape: top-level run facts, `fields`, `ms_fields`, `hist`) from one
    `[gs-replay-bench]` line; None when the line does not carry the tag."""
    at = line.find(SUMMARY_TAG)
    if at < 0:
        return None
    out = {"fields": {}, "ms_fields": [], "hist": {}}
    for name, raw in TOKEN_RE.findall(line[at + len(SUMMARY_TAG):]):
        if name in STR_TOP:
            out[name] = raw
            continue
        value, unit = _number(raw)
        if value is None:
            continue
        if name in INT_TOP:
            out[name] = int(value)
        elif name == "elapsed":
            out["elapsed_ms"] = value
        elif name == "fps":
            out["fps"] = value
        elif name == "hist_n":
            out["hist"]["n"] = int(value)
        elif name in HIST_KEYS:
            out["hist"][name] = value if name == "longest_ms" else int(value)
        else:
            out["fields"][name] = value
            if unit in ("ms/s", "ms"):
                out["ms_fields"].append(name)
    return out


def parse_output(text):
    """The last `[gs-replay-bench]` line of a run's output, parsed; None when there is none."""
    found = None
    for line in text.splitlines():
        s = parse_line(line)
        if s is not None:
            found = s
    return found


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _flat(summary):
    """[(name, value)] in comparison order: the fields, then the run's pace, then the histogram (hist_ prefixed)."""
    rows = [(k, float(v)) for k, v in summary.get("fields", {}).items() if isinstance(v, (int, float))]
    for k in ("fps", "elapsed_ms"):
        if isinstance(summary.get(k), (int, float)):
            rows.append((k, float(summary[k])))
    rows += [("hist_" + k, float(v)) for k, v in summary.get("hist", {}).items() if isinstance(v, (int, float))]
    return rows


def compare(before, after):
    """[(name, before, after, percent)] over the names both summaries hold, in before's order; percent is
    (after - before) / before * 100, None when before is 0."""
    a = dict(_flat(after))
    out = []
    for name, b in _flat(before):
        if name not in a:
            continue
        pct = None if b == 0 else (a[name] - b) / b * 100.0
        out.append((name, b, a[name], pct))
    return out


def knob_differences(before, after):
    """[(name, before value, after value)] for every knob the two summaries' `knobs` disagree on, sorted by name;
    a knob one summary does not set is None there."""
    b, a = before.get("knobs") or {}, after.get("knobs") or {}
    return [(k, b.get(k), a.get(k)) for k in sorted(set(b) | set(a)) if b.get(k) != a.get(k)]


def format_compare(rows):
    width = max([len(r[0]) for r in rows] + [5])
    lines = ["%-*s %14s %14s %9s" % (width, "field", "before", "after", "change")]
    for name, b, a, pct in rows:
        lines.append("%-*s %14.2f %14.2f %9s" % (width, name, b, a, "n/a" if pct is None else "%+.1f%%" % pct))
    return lines


def resolve_exe(exe):
    """The absolute path of a string `exe`, a relative one taken against the repository root (issue #117: a
    relative path failed with WinError 2 under the Windows Store Python). RuntimeError, naming the resolved
    path, when no file is there."""
    path = os.path.normpath(exe if os.path.isabs(exe) else os.path.join(REPO_ROOT, exe))
    if not os.path.isfile(path):
        raise RuntimeError("gs_replay_bench not found: %s (build it, or pass --exe)" % path)
    return path


def run(exe, recording, json_out, warmup=None, frames=None, no_stats=False, timeout=3600, knobs=()):
    """Run the bench (`exe` a path, or an argv list) on `recording`, writing `json_out`; the summary dict read
    back from the JSON (from the printed line when the JSON is missing). A string `exe` is resolved by
    resolve_exe (against the repository root); an argv list is spawned as given. RuntimeError when the bench
    is missing or fails."""
    argv = list(exe) if isinstance(exe, (list, tuple)) else [resolve_exe(exe)]
    argv += [recording, "--json", json_out]
    if warmup is not None:
        argv += ["--warmup", str(warmup)]
    if frames is not None:
        argv += ["--frames", str(frames)]
    if no_stats:
        argv.append("--no-stats")
    for kv in knobs:
        argv += ["--knob", kv]
    d = os.path.dirname(os.path.abspath(json_out))
    os.makedirs(d, exist_ok=True)
    if os.path.exists(json_out):
        os.remove(json_out)   # a summary left by an earlier run must never be read as this one's
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        tail = "\n".join((p.stderr or "").strip().splitlines()[-5:])
        raise RuntimeError("gs_replay_bench exited %d: %s" % (p.returncode, tail))
    if not os.path.exists(json_out):
        raise RuntimeError("gs_replay_bench exited 0 but wrote no %s" % json_out)
    return load(json_out)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m tools_py.parity.replay_bench",
                                 description="Run the draw-path bench on a PS2X_GS_RECORD recording; compare two runs.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="replay a recording through dist/gs_replay_bench.exe and print its summary")
    r.add_argument("recording")
    r.add_argument("--exe", default=DEFAULT_EXE)
    r.add_argument("--json", dest="json_out", default=None, help="default: <recording>.bench.json")
    r.add_argument("--warmup", type=int, default=None)
    r.add_argument("--frames", type=int, default=None)
    r.add_argument("--no-stats", action="store_true")
    r.add_argument("--knob", action="append", default=[], help="NAME=VALUE over the recorded value of that knob (repeatable)")
    c = sub.add_parser("compare", help="field by field, in percent: after against before")
    c.add_argument("before")
    c.add_argument("after")
    args = ap.parse_args(sys.argv[1:] if argv is None else argv)
    if args.cmd == "run":
        json_out = args.json_out or args.recording + ".bench.json"
        try:
            s = run(args.exe, args.recording, json_out, args.warmup, args.frames, args.no_stats, knobs=args.knob)
        except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
            print(e, file=sys.stderr)
            return 1
        for name, value in _flat(s):
            print("%s=%.2f" % (name, value))
        print("json=%s" % json_out)
        return 0
    try:
        before, after = load(args.before), load(args.after)
    except (OSError, ValueError) as e:
        print("cannot read a summary: %s" % e, file=sys.stderr)
        return 2
    for name, b, a in knob_differences(before, after):
        print("WARNING: the knobs differ, not a clean A/B: %s before=%s after=%s" % (name, b, a), file=sys.stderr)
    for line in format_compare(compare(before, after)):
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
