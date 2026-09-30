"""Pinned inputs: the record of what a measurement was computed against, and the refusal when it drifted.

Sprint 10 Q1b. A gate's summary.txt used to pin one thing, the EXE line, while everything else the score
depends on -- the reference images, the memory card the run boots from, the drive scripts, the harness
revision, the PS2X_* environment -- could change with no record. A silently-changed reference image moves
every score with nothing saying that anything moved: the sibling of the `docs/HAZARDS.md` harness hazard, once HANDOFF trap 4 (the pipeline cannot see
a defect present in every run; it cannot see a change in its own standard either).

This module is the mechanism and knows nothing about the gate: `gate.collect_pins` names the gate's set, and
Q3b's mapping hash rides the same code. A `Pin` is a name, a sha256 (None when the input is missing or
absent) and a human detail. A file pins as its content hash; a directory as the sha256 of its sorted manifest
(`<relative path>\\0<file sha256>\\n` per file, so a rename, a byte or an extra file all move it); an
environment as the sorted `NAME=value` lines of its PS2X_* variables, minus PS2X_MC_DIR (the card's PATH is
not an input, its CONTENTS are, and those are the card pin); the harness as the manifest of the tracked files
of its trees plus the git revision for the record.

`compare` reads a committed expected-pins file (EXPECTED, `{"pins": {name: sha256}}`) and names every
drift: a changed value, a pinned name the run no longer has, an input the run has that the file does not
(an "unpinned" input: a reference sibling that appeared, or the first run that prints the mapping hash).
RECORD_ONLY names are written on every summary and never compared: the file cannot name the revision of the
tree that holds it. A pin whose sha256 is None is absent, not drifted (the mapping line before Q3b lands).

Summary lines are `PIN <name> sha256=<hex> ok|DRIFTED (expected <hex>)|accepted (was <hex>)|recorded (...)`
and `PIN <name> absent (...)`, beside the EXE line, in the same shape. INFORMATIONAL names (Sprint 13 V4: the
mission's frame time, `PIN frame mean_ms=... recorded (informational, S13-R3 ...)`) are measured, printed and
written to the record's "informational" block, and never compared -- S13-R3 sets their refusal rule once three
gates agree on the spread.
"""
import hashlib
import json
import os
import re
import subprocess
import time
from collections import namedtuple

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXPECTED = "scripts/parity/pins.json"                            # relative to ROOT; the committed standard
RECORD_ONLY = ("harness",)
# Informational names (Sprint 13 V4, S13-R3): measured on every run and written to its record under
# "informational", never a Pin, never compared -- a standard that somehow names one is not refused on it. The
# frame-time pin is informational until three gates agree on its spread; the refusal rule is set then.
INFORMATIONAL = ("frame",)
RECORD_NAME = "pins.json"                                        # what a run writes beside its summary.txt
# The runtime (Q3b, socom2_host_input.cpp) prints `[socom2] input mapping hash=<16 hex> (default|custom)`; the
# design said `sha256=<64 hex>`. Both spellings are read, so neither side has to move for the pin to see it.
MAPPING_RE = re.compile(r"\[socom2\] input mapping (?:hash|sha256)=([0-9a-fA-F]{16,64})")

Pin = namedtuple("Pin", "name sha256 detail")
Drift = namedtuple("Drift", "name actual expected")


def file_sha256(path):
    """sha256 of a file's CONTENT: a text file (no NUL in its first 8 KB) is hashed with CRLF folded to LF, so the
    same drive script pins the same from a checkout that wrote it with CRLF (core.autocrlf on Windows) as from one
    that wrote LF -- the first merge of this mechanism refused to score on exactly that. Binary files (the reference
    PNGs, the card's files) are hashed as their bytes."""
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        head = fh.read(8192)
        text = b"\x00" not in head
        fh.seek(0)
        if text:
            digest.update(fh.read().replace(b"\r\n", b"\n"))     # whole, so no CRLF straddles a chunk
        else:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
    return digest.hexdigest()


def tree_sha256(root, files=None):
    """(sha256 of the sorted manifest, file count) of a directory: one `<relpath>\\0<sha256>\\n` line per file,
    relative paths with forward slashes, sorted, so the hash does not depend on walk or creation order.
    `files` restricts the walk to those relative paths (the harness pin passes git's tracked list)."""
    if files is None:
        files = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                files.append(os.path.relpath(os.path.join(dirpath, name), root))
    rels = sorted(f.replace("\\", "/") for f in files)
    digest = hashlib.sha256()
    for rel in rels:
        digest.update(("%s\0%s\n" % (rel, file_sha256(os.path.join(root, rel)))).encode("utf-8"))
    return digest.hexdigest(), len(rels)


def file_pin(name, path):
    try:
        return Pin(name, file_sha256(path), "file")
    except OSError as e:
        return Pin(name, None, "missing (%s)" % (e.strerror or e))


def tree_pin(name, root, label=None):
    label = label or root
    if not os.path.isdir(root):
        return Pin(name, None, "%s missing" % label)
    sha, n = tree_sha256(root)
    return Pin(name, sha, "%s, %d file%s" % (label, n, "" if n == 1 else "s"))


def env_pin(env):
    """The PS2X_* environment a launch gets, minus PS2X_MC_DIR: sorted `NAME=value` lines, hashed with a
    newline after each. The detail is the list itself, so the record says what was in force."""
    lines = sorted("%s=%s" % (k, v) for k, v in env.items() if k.startswith("PS2X_") and k != "PS2X_MC_DIR")
    return Pin("env", hashlib.sha256(("".join(l + "\n" for l in lines)).encode("utf-8")).hexdigest(), lines)


def _git(args, cwd):
    try:
        r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return r.stdout


def harness_pin(root, trees, exclude=()):
    """The harness revision: the manifest hash of the tracked files under `trees` (content read from disk, so
    an uncommitted edit moves it) and, for the record, the git revision and whether those trees are dirty.
    `exclude` names files left out of the hash -- the expected-pins file itself, so that accepting a
    standard does not move the harness it was accepted under. Without git the trees are walked."""
    listing = _git(["ls-files", "-z", "--"] + list(trees), root)
    if listing is not None:
        files = [f for f in listing.split("\0") if f and f not in exclude and os.path.isfile(os.path.join(root, f))]
        head = (_git(["rev-parse", "--short", "HEAD"], root) or "?").strip()
        status = (_git(["status", "--porcelain", "--"] + list(trees), root) or "").strip()
        state = "dirty" if status else "clean"
    else:
        files = []
        for tree in trees:
            for dirpath, dirnames, filenames in os.walk(os.path.join(root, tree)):
                dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
                for name in sorted(filenames):
                    rel = os.path.relpath(os.path.join(dirpath, name), root).replace("\\", "/")
                    if rel not in exclude and not name.endswith(".pyc"):
                        files.append(rel)
        head, state = "no git", "unknown"
    sha, n = tree_sha256(root, files)
    return Pin("harness", sha, "git %s, %s; %d files under %s" % (head, state, n, ", ".join(trees)))


def mapping_pin(log_paths):
    """Q3b's hook. The runtime prints `[socom2] input mapping hash=<hex> (default|custom)` on its log;
    the first such line in any of `log_paths` is the pin. No line anywhere: absent (recorded, never refused).
    Two logs that disagree: a finding of its own, pinned as None so it reads as absent-with-a-reason rather
    than as one of the two values."""
    found = {}
    for path in log_paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for line in f:
                    m = MAPPING_RE.search(line)
                    if m:
                        found.setdefault(m.group(1).lower(), os.path.basename(path))
                        break
        except OSError:
            continue
    if not found:
        return Pin("mapping", None, "absent")
    if len(found) > 1:
        return Pin("mapping", None, "differs between stages: " + ", ".join(
            "%s in %s" % (h[:12], src) for h, src in sorted(found.items())))
    (sha, src), = found.items()
    return Pin("mapping", sha, "from %s" % src)


def comparable(pins_):
    """The pins a standard can hold: not RECORD_ONLY, not absent."""
    return {n: p for n, p in pins_.items() if n not in RECORD_ONLY and p.sha256 is not None}


def compare(current, expected):
    """Every way the current pins differ from the expected `{name: sha256}`, in a stable order: changed
    values and missing inputs in the expected file's order, then inputs the file does not name."""
    drifts = []
    for name, sha in expected.items():
        if name in RECORD_ONLY or name in INFORMATIONAL:
            continue
        p = current.get(name)
        if p is None or p.sha256 is None:
            if name == "mapping":
                continue        # the runtime printed no line: absent is recorded, not refused
            drifts.append(Drift(name, None, sha))
        elif p.sha256 != sha:
            drifts.append(Drift(name, p.sha256, sha))
    for name, p in comparable(current).items():
        if name not in expected:
            drifts.append(Drift(name, p.sha256, None))
    return drifts


def lines(current, drifts, accepted=False, expected=None):
    """One `PIN ...` line per pin, in the pins' order, each saying its state."""
    drifted = {d.name: d for d in drifts}
    out = []
    for name, p in current.items():
        if p.sha256 is None:
            detail = p.detail or "absent"
            if name in drifted:
                note = "%s DRIFTED (expected %s)" % (detail, drifted[name].expected)
            elif name == "mapping" and expected and name in expected:
                note = "%s (expected %s; the runtime printed no mapping line; not compared)" % (detail, expected[name])
            elif name in RECORD_ONLY:
                note = detail
            else:
                note = "%s (not compared)" % detail
            out.append("PIN %s %s" % (name, note))
        elif name in RECORD_ONLY:
            out.append("PIN %s sha256=%s recorded (%s; not compared)" % (name, p.sha256, p.detail))
        else:
            if name in drifted:
                was = drifted[name].expected or "none"
                state = "accepted (was %s)" % was if accepted else "DRIFTED (expected %s)" % was
            else:
                state = "ok"
            # What a name alone does not say -- the card's source and count, the environment's lines --
            # follows on the line, so the summary is readable without the pins.json beside it.
            detail = " ".join(p.detail) if isinstance(p.detail, list) else p.detail
            out.append("PIN %s sha256=%s %s%s" % (name, p.sha256, state, "; " + detail if detail and detail != "file" else ""))
    return out


def load_expected(path):
    """`{name: sha256}` from an expected-pins file, or None when there is no such file."""
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except OSError:
        return None
    return dict(doc.get("pins", {}))


def write_expected(current, path, note=""):
    """Rewrite the standard from the current pins: the comparable ones, with the detail of those whose name
    does not say what they hash (the card's source and count, the environment's lines)."""
    keep = comparable(current)
    doc = {
        "_about": "The gate's standard (Sprint 10 Q1b): sha256 of every input a score is computed against. "
                  "`python -m tools_py.parity.gate --pins` compares the tree to this file without launching; a "
                  "launch or a --baseline re-score whose pins do not match is REFUSED (exit 7) unless "
                  "--accept-pins rewrites this file. A directory pins as the sha256 of its sorted manifest "
                  "(relative path NUL sha256 newline per file); env as the sorted PS2X_* NAME=value lines the "
                  "mission stage is launched with, minus PS2X_MC_DIR. harness (tools_py/parity + scripts/parity) "
                  "is recorded on every summary but never compared: this file cannot name the revision of the tree "
                  "that holds it. mapping joins once the runtime prints its line and a run is accepted.",
        "accepted": "%s%s" % (time.strftime("%Y-%m-%d %H:%M"), (" -- " + note) if note else ""),
        "pins": {n: p.sha256 for n, p in keep.items()},
        "detail": {n: p.detail for n, p in keep.items() if n in ("card", "env", "mapping")},
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")


def frame_info(ft, why=None, syncv=None):
    """The informational frame-time record from a frame_time.FrameTime (or its absence and why), and the game's
    own frame rate (`syncv_mean`, from a frame_time.SyncV) when the log carried it (Sprint 17 F0)."""
    info = ({"frame_absent": why or "absent"} if ft is None else
            {"frame_mean_ms": round(ft.mean_ms, 2), "frame_worst_ms": round(ft.worst_ms, 2), "frame_n": ft.n})
    if syncv is not None:
        info.update(syncv_mean=round(syncv.mean, 1), syncv_n=syncv.n)
    return info


def informational_lines(info):
    """`PIN frame ... recorded (informational, S13-R3: ...)`, or none when the run measured no frame time (a
    stage list without the mission)."""
    if not info:
        return []
    why = "informational, S13-R3: never compared until three gates agree on its spread"
    if "frame_mean_ms" in info:
        return ["PIN frame mean_ms=%.2f worst1s_ms=%.2f n=%d recorded (%s)"
                % (info["frame_mean_ms"], info["frame_worst_ms"], info["frame_n"], why)]
    return ["PIN frame absent (%s; %s)" % (why, info.get("frame_absent", "absent"))]


def write_record(current, path, drifts=(), accepted=False, verdict="", exe="", expected_file="", informational=None):
    """The run's own pins.json beside its summary.txt: every pin (record-only and absent ones included), the
    EXE line, what drifted and the verdict, so a --baseline re-score can compare the record; and the
    informational measurements (frame_mean_ms, frame_worst_ms, frame_n), which nothing compares."""
    doc = {
        "written": time.strftime("%Y-%m-%d %H:%M:%S"),
        "expected_file": expected_file,
        "verdict": verdict,
        "accepted": bool(accepted),
        "drifted": [d.name for d in drifts],
        "exe": exe,
        "pins": {n: p.sha256 for n, p in current.items()},
        "detail": {n: p.detail for n, p in current.items()},
        "informational": dict(informational or {}),
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")


def load_record(path):
    """The pins a run recorded, as `{name: Pin}` (detail from the record when it has one), or None."""
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except OSError:
        return None
    detail = doc.get("detail", {})
    return {n: Pin(n, sha, detail.get(n, "recorded")) for n, sha in doc.get("pins", {}).items()}
