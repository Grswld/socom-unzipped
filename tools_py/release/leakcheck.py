#!/usr/bin/env python3
"""The gate that decides whether this repository may face outward -- one command, exit non-zero on any hit.

    python -m tools_py.release.leakcheck tree               every tracked file, as it is in the working tree
                                                            (and, there and in `staged`, any private address)
    python -m tools_py.release.leakcheck staged             what `git commit` is about to take (the pre-commit hook)
    python -m tools_py.release.leakcheck ignored            the paths that hold the real secrets are ignored,
                                                            untracked, and were never committed
    python -m tools_py.release.leakcheck metadata           every commit's author and committer identity
    python -m tools_py.release.leakcheck history [REV..]    every added line of every commit on every ref
    python -m tools_py.release.leakcheck artifact <dir>     an unpacked release archive, or any directory
    python -m tools_py.release.leakcheck external [--require]   the SIBLING repositories' own scanners
    python -m tools_py.release.leakcheck all                tree + ignored + metadata + history + external

Exit codes -- three states, not two: **0** clean, **1** findings, **2** the scanner did not run (a missing
target, a shallow clone in history mode, or the planted control it runs on itself first was missed). A gate
that treats "could not scan" as "nothing found" is worse than no gate, because it reports safety it did not
measure -- so a caller must never read 2 as a pass.

Output is `path:line: rule: <masked excerpt>` on stderr, and `--json` writes one object (`tool`, `target`,
`scanned`, `self_test`, `findings`, `exit`) whose excerpts are masked exactly as the terminal's are: a
machine-readable report is MORE likely to be pasted, logged or attached, not less. `--reveal` prints the
matched text unmasked on the terminal only, for whoever is fixing the hit.

The `external` mode is the sixth leg: three repositories publish from this machine, and the other two carry
their own scanners (`../scotho`'s `scripts/check-secrets.mjs`, `../socom_monitor`'s `leakcheck.py`). It calls
them where they are beside this one and folds their findings into this report, masked. It distinguishes two
ways of not scanning, because only one of them is anybody's fault: a sibling that is simply *absent* (or whose
build output or runtime is) prints SKIPPED and leaves the exit code alone -- CI has neither repository -- while
a sibling that IS there and whose scanner could not scan is exit 2, flags or no flags. `--require` turns the
first into exit 2 as well, for a machine that is supposed to have them. Neither ever prints as clean.

Decisions live in `leak_allow.txt` beside this file (a rule, a path glob, an optional literal, and the reason),
so an allowed hit is a reviewed line in a tracked file and not a comment in the code. Owner-specific literals
live in the git-ignored `leak_extra.txt` (`leakrules.EXTRA_FILE`). Sprint 11 Goal 9 is the design; Sprint 10
pulled it forward the day the repository went public.
"""
import argparse
import fnmatch
import io
import json
import os
import re
import shutil
import subprocess
import sys

from tools_py.release import leakrules as R

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ALLOW_FILE = os.path.join(R.HERE, "leak_allow.txt")
BINARY_SNIFF_BYTES = 8 * 1024 * 1024
TEXT_SNIFF_BYTES = 8 * 1024
MAX_LINE = 4000          # a minified or hex-dump line longer than this is scanned in pieces, never skipped

# The paths that hold the real secrets and the owner's data (HANDOFF §4 rule 2, the Sprint 11 spec Goal 9 item 1).
# "It is git-ignored" is a claim with a shelf life; the gate re-proves it on every run: ignored now, not in the
# index now, and never added by any commit on any ref.
SENSITIVE_IGNORED = (
    "vm/", "vm/keys/", "vm/lightsail/", "logs/", "logs/bug_reports/", "game/", "tools/", "research/",
    "dist/", "dist-release/", "dist-linux/", "dist-linux-release/", "server/config/simulated.db",
    "server/logs/", ".claude/skills/s2u-bug-reports/", "ONBOARDING.md", "ghidra_proj/", "recomp/output/",
    "tools_py/release/leak_extra.txt", "mc0/", "mc1/",
    # Sprint 14 S4: the rest of docs/GIT_STRATEGY.md section 3's never-commit list, one sample path per
    # pattern (`/*.bin`, `/*.wav`, `/build*/`, `/dist*/`, `*.iso`, `*.7z`, the box's pulled tree). Not here:
    # server/horizon-docker/ and server/horizon-server-database-middleware/ -- ignored (a staged file under them
    # is refused as forced-ignored), but `a3cef6ce` added both as gitlinks to their public upstreams, so the
    # history half can never pass; a gitlink is a commit hash, not a secret.
    "out.bin", "out.wav", "build/", "build-clang/", "build-linux/", "dist-r0004/", "dist-foo/", "game.iso",
    "disc.7z", "out/", "server/ops/pulled/", "server/ops/ops.env",
    # web/: the disc data the viewer's extractor writes (293 MB of the game's archives), its test fixtures, and the
    # landing site's menu movie cut from the disc -- at the layout of 2026-09-29 and at the one before it
    "web/redotcom/public/maps/", "web/redotcom/test-fixtures/", "web/landing/public/media/", "web/public/maps/",
    # and the landing's other game-derived inputs (web/landing/README.md "Build inputs"): the HUD sounds, the
    # game-showing images, the owner's artwork and the home/story goldens -- file samples for the goldens, since
    # e2e/goldens/gallery-* is tracked on purpose
    "web/landing/public/sfx/", "web/landing/public/img/intel.jpg", "web/landing/public/img/share.jpg",
    "web/landing/art/", "web/landing/e2e/goldens/home-x.png", "web/landing/e2e/goldens/story-x.png",
)
# Shapes of file that must never be tracked whatever their path (the .gitignore has the same list; this is
# the proof that it held).
SENSITIVE_NAME_RE = R.KEYNAME_PATH_RE


class Hit:
    __slots__ = ("path", "line", "rule", "text", "context")

    def __init__(self, path, line, rule, text, context=""):
        self.path, self.line, self.rule, self.text, self.context = path, line, rule, text, context

    def where(self):
        if self.line:
            return f"{self.path}:{self.line}"
        return f"{self.path}: (file name)" if self.context == "name" else self.path

    def masked_context(self):
        """The line the hit sits on, with the matched text masked -- the context is what lets a reader find
        the hit, and it must not be the thing that leaks it."""
        if not self.context or self.context == "name":
            return ""
        return self.context.replace(self.text, R.mask(self.text)) if self.text else self.context

    def render(self, reveal=False):
        shown = self.text if reveal else R.mask(self.text)
        ctx = (self.context if reveal else self.masked_context()) if self.context != "name" else ""
        return f"{self.where()}: {self.rule}: {shown}" + (f" [{ctx}]" if ctx else "")

    def as_json(self):
        return {"rule": self.rule, "file": self.path, "line": self.line, "excerpt_masked": R.mask(self.text),
                "severity": R.SEVERITY.get(self.rule, "medium"), "context_masked": self.masked_context()}


# --------------------------------------------------------------------------------------------
# the allow list

def load_allow(path=ALLOW_FILE):
    """[(rule, path glob, literal or "", reason)] from `leak_allow.txt`: `rule  glob  [literal]  # reason`.
    A literal with spaces is quoted. A malformed line is a hard error -- an allow list that silently drops a
    line is one that silently allows nothing, or everything."""
    import shlex
    rows = []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return rows
    for n, raw in enumerate(lines, 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        body, _, reason = line.partition("#")
        parts = shlex.split(body)
        if len(parts) not in (2, 3):
            raise ValueError(f"{path}:{n}: expected `rule glob [literal] # reason`, got {raw!r}")
        rule, glob = parts[0], parts[1]
        lit = parts[2] if len(parts) == 3 else ""
        rows.append((rule, glob, lit, reason.strip()))
    return rows


def allowed(hit, allow):
    for rule, glob, lit, _reason in allow:
        if rule != hit.rule and rule != "*":
            continue
        if not (fnmatch.fnmatchcase(hit.path, glob) or fnmatch.fnmatchcase(hit.path, glob.rstrip("/") + "/*")):
            continue
        if lit and lit.lower() not in (hit.text or "").lower() and lit.lower() not in (hit.context or "").lower():
            continue
        return True
    return False


# --------------------------------------------------------------------------------------------
# scanning one file's bytes

def is_binary(blob):
    head = blob[:TEXT_SNIFF_BYTES]
    return b"\x00" in head


def scan_text(rel, text, trules, hits, stats, line_offset=0):
    for i, line in enumerate(text.splitlines(), 1 + line_offset):
        stats["lines"] += 1
        pieces = [line] if len(line) <= MAX_LINE else [line[j:j + MAX_LINE] for j in range(0, len(line), MAX_LINE)]
        for piece in pieces:
            for rule, fn in trules:
                got = fn(piece)
                if got:
                    hits.append(Hit(rel, i, rule, got, piece.strip()[:200]))


def scan_blob(rel, blob, rules, hits, stats):
    trules, brules, nrules = rules
    for rule, fn in nrules:
        got = fn(rel)
        if got:
            hits.append(Hit(rel, 0, rule, got, "name"))
    stats["files"] += 1
    stats["bytes"] += len(blob)
    if is_binary(blob):
        stats["binary_files"] += 1
        text = blob[:BINARY_SNIFF_BYTES].decode("latin-1")
        for rule, fn in brules:
            got = fn(text)
            if got:
                hits.append(Hit(rel, 0, rule, got, "binary"))
    else:
        stats["text_files"] += 1
        scan_text(rel, blob.decode("utf-8", errors="replace"), trules, hits, stats)


# A private address in a TRACKED file (Sprint 13 S6). The `private-ip` text rule runs only on artifacts, and the
# history keeps what it keeps; but a private address in the tree AS IT IS NOW is either a default somebody copies
# (the Horizon configs once advertised the owner's LAN) or a note that has to say why it is there. So `tree` and
# `staged` -- not `history`, which cannot be rewritten -- report each one as `tracked-private-ip`, and every
# allowed one is a row in leak_allow.txt with its reason. An example belongs in RFC 5737's documentation ranges
# (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), which this never reports.
TRACKED_PRIVATE_RULE = "tracked-private-ip"


def scan_private(rel, blob, hits):
    """One `tracked-private-ip` hit per line of a text file that carries an RFC 1918 or link-local address."""
    if is_binary(blob):
        return
    for i, line in enumerate(blob.decode("utf-8", errors="replace").splitlines(), 1):
        m = R.PRIVATE_IP_RE.search(line)
        if m:
            hits.append(Hit(rel, i, TRACKED_PRIVATE_RULE, m.group(0), line.strip()[:200]))


def check_tracked_private(cwd=ROOT, allow=None):
    """The `tracked-private-ip` half of `tree` on its own: every tracked file as it is in the working tree."""
    hits, stats = [], new_stats()
    for rel in tracked_files(cwd):
        full = os.path.join(cwd, rel)
        if os.path.isdir(full):
            continue
        try:
            with open(full, "rb") as fh:
                blob = fh.read()
        except OSError:
            continue
        stats["files"] += 1
        scan_private(rel, blob, hits)
    return _filter(hits, allow), stats


def build_rules(users=None, extras=None, hosted=R.HOSTED_IPS, surface="tree"):
    return (R.text_rules(users, extras, hosted, surface), R.binary_rules(users, extras), R.name_rules(users, extras))


def new_stats():
    return {"files": 0, "text_files": 0, "binary_files": 0, "bytes": 0, "lines": 0, "commits": 0}


# --------------------------------------------------------------------------------------------
# git

def git(args, cwd=ROOT, check=True, binary=False):
    p = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, check=False)
    if check and p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed ({p.returncode}): {p.stderr.decode('utf-8', 'replace').strip()}")
    return p.stdout if binary else p.stdout.decode("utf-8", errors="replace")


def tracked_files(cwd=ROOT):
    out = git(["ls-files", "-z", "--cached", "--full-name"], cwd=cwd, binary=True)
    return [p.decode("utf-8", "replace") for p in out.split(b"\x00") if p]


def staged_files(cwd=ROOT):
    out = git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], cwd=cwd, binary=True)
    return [p.decode("utf-8", "replace") for p in out.split(b"\x00") if p]


def is_shallow(cwd=ROOT):
    return git(["rev-parse", "--is-shallow-repository"], cwd=cwd).strip() == "true"


# --------------------------------------------------------------------------------------------
# the modes

def check_tree(cwd=ROOT, rules=None, allow=None):
    """Every tracked file, read from the working tree (a tracked file deleted from the tree is skipped: it is
    not going anywhere). Returns (hits, stats)."""
    rules = rules or build_rules()
    hits, stats = [], new_stats()
    for rel in tracked_files(cwd):
        full = os.path.join(cwd, rel)
        if os.path.isdir(full):
            continue                                   # a submodule gitlink: no bytes of ours to scan
        try:
            with open(full, "rb") as fh:
                blob = fh.read()
        except FileNotFoundError:
            continue
        except OSError as e:
            hits.append(Hit(rel, 0, "unreadable", str(e)))
            continue
        scan_blob(rel, blob, rules, hits, stats)
        scan_private(rel, blob, hits)
    return _filter(hits, allow), stats


def check_dir(root, rules=None, allow=None):
    """Any directory: an unpacked release archive, a build output, a fixture tree."""
    rules = rules or build_rules()
    hits, stats = [], new_stats()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d != ".git")
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, root).replace("\\", "/")
            try:
                with open(full, "rb") as fh:
                    blob = fh.read()
            except OSError as e:
                hits.append(Hit(rel, 0, "unreadable", str(e)))
                continue
            scan_blob(rel, blob, rules, hits, stats)
    return _filter(hits, allow), stats


def check_staged(cwd=ROOT, rules=None, allow=None):
    """What the index holds for the next commit: each staged file's staged CONTENT (`git show :path`, not the
    working tree's, which may differ), plus two things no content rule sees -- a staged path that the
    .gitignore says is ignored (someone ran `git add -f`), and a staged path shaped like key material."""
    rules = rules or build_rules()
    hits, stats = [], new_stats()
    files = staged_files(cwd)
    for rel in files:
        # `--no-index`, because a path that is in the index is never reported as ignored without it -- and
        # the whole point is that it was just put there over the .gitignore's objection.
        p = subprocess.run(["git", "check-ignore", "--no-index", "-q", "--", rel], cwd=cwd, capture_output=True)
        if p.returncode == 0:
            hits.append(Hit(rel, 0, "forced-ignored-file", rel, "staged although .gitignore ignores it"))
        blob = git(["show", f":{rel}"], cwd=cwd, binary=True)
        scan_blob(rel, blob, rules, hits, stats)
        scan_private(rel, blob, hits)
    return _filter(hits, allow), stats


def check_ignored(cwd=ROOT, paths=SENSITIVE_IGNORED, allow=None):
    """The paths that hold the real secrets: ignored by the .gitignore, absent from the index, and never
    added by any commit on any ref. The third needs full history, so a shallow clone makes this mode exit 2."""
    hits, stats = [], new_stats()
    if is_shallow(cwd):
        raise ScanNotRun("history is shallow: `git fetch --unshallow` before the ignored-path check")
    index = set(tracked_files(cwd))
    for path in paths:
        stats["files"] += 1
        # the trailing slash stays: `/dist-linux/` in the .gitignore matches only a directory, and a directory
        # that is not on this disk today is still one the gate must prove ignored
        p = subprocess.run(["git", "check-ignore", "--no-index", "-q", "--", path], cwd=cwd, capture_output=True)
        if p.returncode != 0:
            hits.append(Hit(path, 0, "ignored-path-not-ignored", path, ".gitignore does not match it"))
        bare = path.rstrip("/")
        tracked_now = [t for t in index if t == bare or t.startswith(bare + "/")]
        if tracked_now:
            hits.append(Hit(path, 0, "ignored-path-tracked", tracked_now[0],
                            f"{len(tracked_now)} tracked file(s) under an ignored path"))
        ever = git(["log", "--all", "--format=%h", "--diff-filter=A", "--", bare], cwd=cwd).split()
        if ever:
            hits.append(Hit(path, 0, "ignored-path-in-history", bare, f"added in {len(ever)} commit(s), e.g. {ever[-1]}"))
    # and nothing key-shaped anywhere in the index, whatever its directory
    for rel in sorted(index):
        if SENSITIVE_NAME_RE.search(rel):
            hits.append(Hit(rel, 0, "key-file-name", rel, "name"))
    return _filter(hits, allow), stats


def check_metadata(cwd=ROOT, allow=None):
    """Author and committer identities across all history. A private repository's `user.email` is often a
    personal one; the public one should be deliberate. Every identity is a finding until `leak_allow.txt`
    names it -- the allow list is the record of that decision."""
    hits, stats = [], new_stats()
    out = git(["log", "--all", "--format=%an%x09%ae%x09%cn%x09%ce"], cwd=cwd)
    seen = {}
    for line in out.splitlines():
        stats["commits"] += 1
        an, ae, cn, ce = (line.split("\t") + ["", "", "", ""])[:4]
        seen.setdefault(("commit-author", f"{an} <{ae}>"), 0)
        seen[("commit-author", f"{an} <{ae}>")] += 1
        seen.setdefault(("commit-committer", f"{cn} <{ce}>"), 0)
        seen[("commit-committer", f"{cn} <{ce}>")] += 1
    for (rule, ident), n in sorted(seen.items()):
        hits.append(Hit("<git metadata>", 0, rule, ident, f"{n} commit(s)"))
    return _filter(hits, allow), stats


def check_history(cwd=ROOT, revs=None, rules=None, allow=None):
    """Every ADDED line of every commit reachable from every ref (or from `revs`, a `git log` range), and the
    path of every file each commit adds. Binary diffs are not expanded; their paths are still checked by name.
    Needs full history: a shallow clone exits 2 rather than reporting a clean scan of half the past."""
    rules = rules or build_rules()
    trules, _brules, nrules = rules
    hits, stats = [], new_stats()
    if not revs and is_shallow(cwd):
        raise ScanNotRun("history is shallow: `git fetch --unshallow` before the history scan")
    # `--cc`: a merge shows only what differs from EVERY parent -- the lines a conflict resolution wrote, which no
    # parent's diff carries. `--no-renames`: a moved file is an add, so its content is read again.
    args = ["log", "-p", "--cc", "--no-color", "--no-renames", "--format=%x01commit %H", "--diff-filter=AM"]
    args += list(revs) if revs else ["--all"]
    p = subprocess.Popen(["git"] + args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    commit, path, lineno = "", "", 0
    reader = io.TextIOWrapper(p.stdout, encoding="utf-8", errors="replace", newline="\n")
    for raw in reader:
        line = raw.rstrip("\n")
        if line.startswith("\x01commit "):
            commit = line[8:20]
            stats["commits"] += 1
            path = ""
            continue
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else ""
            lineno = 0
            if path:
                stats["files"] += 1
                for rule, fn in nrules:
                    got = fn(path)
                    if got:
                        hits.append(Hit(path, 0, rule, got, f"name @{commit}"))
            continue
        if line.startswith("@@"):
            try:
                lineno = int(line.split("+", 1)[1].split(",")[0].split(" ")[0]) - 1
            except (IndexError, ValueError):
                lineno = 0
            continue
        if not path or not line.startswith("+") or line.startswith("+++"):
            if line.startswith(" ") or line.startswith("+"):
                lineno += 1
            continue
        lineno += 1
        stats["lines"] += 1
        body = line[1:]
        pieces = [body] if len(body) <= MAX_LINE else [body[j:j + MAX_LINE] for j in range(0, len(body), MAX_LINE)]
        for piece in pieces:
            for rule, fn in trules:
                got = fn(piece)
                if got:
                    hits.append(Hit(path, lineno, rule, got, f"@{commit} {piece.strip()[:160]}"))
    p.wait()
    if p.returncode != 0:
        raise ScanNotRun("git log failed: " + p.stderr.read().decode("utf-8", "replace").strip())
    return _filter(hits, allow), stats


class ScanNotRun(Exception):
    """The scanner could not do its job. Exit 2, never 0."""


def _filter(hits, allow):
    if allow is None:
        allow = load_allow()
    return [h for h in hits if not allowed(h, allow)]


# --------------------------------------------------------------------------------------------
# the sixth leg: the siblings' own scanners
#
# Each sibling result is a report in THIS tool's `--json` shape -- `tool`, `target`, `scanned`, `findings`,
# `exit` -- with `tool` naming the external scanner, plus two fields the aggregation needs: `state`
# (`clean` / `findings` / `not_run`) and `skipped` (the sibling was not there to be scanned, as against its
# scanner having failed). `self_test` is present ONLY when the sibling reported a control of its own: absent
# means no control was seen, which is exactly what a caller must be able to tell.
#
# A sibling is named by its directory (`scotho`), never by where it lives on this disk. A report is the thing
# most likely to be pasted into a chat or attached to a job, and an absolute path is a home directory.

SIBLINGS_ENV = "SOCOM_LEAK_SIBLINGS"
EXTERNAL_TIMEOUT = 900

EXTERNALS = (
    {"dir": "scotho", "tool": "check-secrets",
     "target": "the published site (scotho.com, socomunzipped.com, the bug inbox)",
     "script": "scripts/check-secrets.mjs", "runtime": "node", "prefix": "",
     "argv": ["scripts/check-secrets.mjs", "--json"], "json": True, "needs": ()},
    {"dir": "socom_monitor", "tool": "monitor-leakcheck",
     "target": "the built monitor snapshot (out/site, as build.py leaves it)",
     "script": "leakcheck.py", "runtime": None, "prefix": "out/site",
     "argv": ["leakcheck.py", "out/site"], "json": False, "needs": ("out/site",)},
)

# The monitor's scanner has no `--json`, so its terminal lines are read: `path:line: rule: text` (or
# `path: (file name): rule: text`), and a stats line on stdout. Its excerpts are NOT masked -- masking them
# before they enter this report is this end's job.
EXT_HIT_RE = re.compile(r"^(?P<file>\S.*?):(?:(?P<line>\d+)|\s*\(file name\)):\s(?P<rule>[a-z0-9_-]+):\s(?P<text>.*)$")
EXT_STATS_RE = re.compile(r"(\d+) files \((\d+) text, (\d+) binary\), (\d+) lines, (\d+) bytes")


_SAFE_RULES = None


def _safe(text, limit=200):
    """A line of a sibling's own error output, fit to repeat: truncated, and with anything our own rules
    recognise masked. A message about why a scan did not happen is usually harmless and occasionally a path."""
    global _SAFE_RULES
    if _SAFE_RULES is None:
        _SAFE_RULES = R.text_rules(surface="artifact")
    out = " ".join(text.split())[:limit]
    for _rule, fn in _SAFE_RULES:
        for _ in range(4):
            got = fn(out)
            if not got or R.mask(got) == got:
                break
            out = out.replace(got, R.mask(got))
    return out


def _ext_result(spec, state, code, skipped=False, reason="", findings=None, scanned=None, self_test=None):
    out = {"tool": spec["tool"], "repo": spec["dir"], "target": spec["target"], "state": state,
           "skipped": skipped, "scanned": scanned or new_stats(), "findings": findings or [], "exit": code}
    if reason:
        out["reason"] = reason
    if self_test is not None:
        out["self_test"] = self_test
    return out


def _ext_finding(spec, rule, path, line, excerpt, severity=None):
    rel = "/".join(p for p in (spec["dir"], spec["prefix"], (path or "").replace("\\", "/")) if p)
    return {"rule": rule, "file": rel, "line": line, "excerpt_masked": excerpt,
            "severity": severity or R.SEVERITY.get(rule, "medium"), "tool": spec["tool"]}


def _ext_stats(files=0, text_files=0, binary_files=0, lines=0, nbytes=0):
    s = new_stats()
    s.update(files=files, text_files=text_files, binary_files=binary_files, lines=lines, bytes=nbytes)
    return s


def _last_line(text):
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return lines[-1] if lines else ""


def _read_json_report(spec, code, out, err):
    """A sibling that speaks `--json` (the site's `check-secrets`): one object on stdout, excerpts already
    masked by it, `self_test` and `exit` inside the report on purpose."""
    try:
        rep = json.loads(out.strip() or "{}")
    except ValueError:
        rep = None
    if not isinstance(rep, dict) or "findings" not in rep:
        return _ext_result(spec, "not_run", 2, reason=f"exit {code}: no readable --json report on stdout"
                           + (f"; {_safe(_last_line(err))}" if err.strip() else ""))
    scanned = _ext_stats(files=int(rep.get("scanned", {}).get("files", 0) or 0),
                         nbytes=int(rep.get("scanned", {}).get("bytes", 0) or 0))
    st = rep.get("self_test") if isinstance(rep.get("self_test"), dict) else None
    findings = [_ext_finding(spec, f.get("rule", ""), f.get("file", ""), f.get("line", 0) or 0,
                             f.get("excerpt_masked", ""), f.get("severity"))
                for f in rep.get("findings", []) if isinstance(f, dict)]
    if code not in (0, 1):
        return _ext_result(spec, "not_run", 2, reason=f"exit {code}: its own report says it did not finish"
                           + (f" ({_safe(', '.join(st.get('failures', [])))})" if st and st.get("failures") else ""),
                           scanned=scanned, self_test=st)
    if findings or code == 1:
        return _ext_result(spec, "findings", 1, findings=findings, scanned=scanned, self_test=st)
    return _ext_result(spec, "clean", 0, scanned=scanned, self_test=st)


def _read_text_report(spec, code, out, err):
    """A sibling that only prints (the monitor's `leakcheck.py`): its stats line on stdout, one line per hit
    on stderr, and every excerpt masked here before it goes any further."""
    m = EXT_STATS_RE.search(out)
    scanned = _ext_stats(*(int(g) for g in m.groups())) if m else new_stats()
    findings = []
    for raw in err.splitlines():
        line = raw.rstrip()
        if not line or line.startswith("leakcheck:") or line.startswith("... and "):
            continue
        hit = EXT_HIT_RE.match(line)
        if hit:
            findings.append(_ext_finding(spec, hit.group("rule"), hit.group("file"), int(hit.group("line") or 0),
                                         R.mask(hit.group("text").strip())))
    if code not in (0, 1):
        return _ext_result(spec, "not_run", 2, reason=f"exit {code}: {_safe(_last_line(err)) or 'no reason given'}",
                           scanned=scanned)
    if code == 1 and not findings:
        return _ext_result(spec, "not_run", 2, scanned=scanned,
                           reason="exit 1, but it printed no line this end could read as a finding")
    if findings:
        return _ext_result(spec, "findings", 1, findings=findings, scanned=scanned)
    # Exit 0 and nothing read is NOT a clean result: a text-parsed sibling whose wording has moved on looks
    # exactly like one that scanned a clean tree. The stats line is the proof that this end still understands
    # it -- without it, nothing is known about what it scanned, and that is the third state, not the first.
    if scanned["files"] < 1:
        return _ext_result(spec, "not_run", 2, scanned=scanned,
                           reason="exit 0, but its output was not parseable: no stats line, so nothing is "
                                  "known about what it scanned")
    return _ext_result(spec, "clean", 0, scanned=scanned)


def run_external(spec, siblings_root):
    """One sibling. Never raises: every way of not scanning comes back as a `not_run` result, `skipped` telling
    the two apart -- absent (nothing to scan, and nobody's fault) against present and broken (exit 2, always)."""
    repo = os.path.join(siblings_root, spec["dir"])
    if not os.path.isdir(repo):
        return _ext_result(spec, "not_run", 2, True, f"{spec['dir']}/ is not beside this repository")
    if not os.path.exists(os.path.join(repo, *spec["script"].split("/"))):
        return _ext_result(spec, "not_run", 2, True, f"{spec['dir']}/{spec['script']} is not there")
    for need in spec["needs"]:
        if not os.path.exists(os.path.join(repo, *need.split("/"))):
            return _ext_result(spec, "not_run", 2, True,
                               f"{spec['dir']}/{need} is not there: its build has not run")
    if spec["runtime"]:
        exe = shutil.which(spec["runtime"])
        if not exe:
            return _ext_result(spec, "not_run", 2, True,
                               f"no {spec['runtime']} on this machine to run {spec['dir']}/{spec['script']}")
    else:
        exe = sys.executable
    try:
        p = subprocess.run([exe] + list(spec["argv"]), cwd=repo, capture_output=True, timeout=EXTERNAL_TIMEOUT)
    except subprocess.TimeoutExpired:
        return _ext_result(spec, "not_run", 2, reason=f"it did not finish within {EXTERNAL_TIMEOUT}s")
    except OSError as e:
        return _ext_result(spec, "not_run", 2, reason=f"could not be started: {_safe(str(e))}")
    out = p.stdout.decode("utf-8", "replace")
    err = p.stderr.decode("utf-8", "replace")
    reader = _read_json_report if spec["json"] else _read_text_report
    return reader(spec, p.returncode, out, err)


def run_externals(siblings_root, specs=EXTERNALS):
    return [run_external(spec, siblings_root) for spec in specs]


def external_line(e, require=False):
    """One line per sibling, on stdout, saying which of the three things happened. "Did not run" is never
    spelled in a way that could be skim-read as a pass."""
    head = f"leakcheck[external]: {e['tool']} ({e['repo']}, {e['target']}): "
    if e["state"] == "not_run":
        if not e["skipped"]:
            tail = " -- its scanner ran and could not scan: exit 2"
        elif require:
            tail = " -- did not run, and `--require` says it had to: exit 2"
        else:
            tail = " -- did not run; `--require` makes this exit 2"
        return head + f"{'SKIPPED' if e['skipped'] else 'DID NOT RUN'} -- {e.get('reason', 'no reason given')}{tail}. NOT a clean result."
    st = e.get("self_test")
    control = (f"control {st.get('caught')}/{st.get('planted')}" if isinstance(st, dict)
               else "its scanner reports no control of its own")
    s = e["scanned"]
    body = f"{s['files']} files, {s['bytes']} bytes"
    if e["state"] == "clean":
        return head + f"CLEAN -- {body} ({control})"
    return head + f"{len(e['findings'])} finding(s) in {body} ({control})"


def siblings_root(arg=None):
    """Where the other repositories are: `--siblings-root`, else `$SOCOM_LEAK_SIBLINGS`, else beside this one."""
    return arg or os.environ.get(SIBLINGS_ENV) or os.path.dirname(ROOT)


# --------------------------------------------------------------------------------------------
# the control: a scanner that finds nothing is indistinguishable from a broken one

PLANTED = [
    ("private-key-block", "-----BEGIN OPENSSH PRIVATE KEY-----"),
    ("vendor-token", "const k = \"AKIAIOSFODNN7EXAMPLE\";"),
    ("vendor-token", "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
    ("jwt", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u"),
    ("cf-access-client-id", "CF-Access-Client-Id: 0123456789abcdef0123456789abcdef.access.example"),
    ("cf-access-client-secret", "CF-Access-Client-Secret: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
    ("bearer-token", "Authorization: Bearer QWxhZGRpbjpvcGVuIHNlc2FtZQ12345678"),
    ("secret-assignment", "accessToken=hunter2hunter2"),
    ("opaque-secret", "key Zk8Qw2ePlRt7YuIoAs3DfGhJkL9xCvBnMq4Zz here"),
    ("aws-account-id", "arn:aws:iam::123456789012:role/monitor"),
    ("key-file-name", "ssh -i socom_linux.pem ubuntu@host"),
    ("key-file-name", "copied vm/keys/id_rsa to the box"),
    ("home-directory-path", "the disc is at C:\\Users\\craigs\\iso\\socom.iso"),
    ("home-directory-path", "the disc is at /c/Users/craigs/iso/socom.iso"),
    ("home-directory-path", "the disc is at /home/craigs/iso/socom.iso"),
    ("private-ip", "client 192.168.1.50 joined"),
    ("ip-address", "home 86.21.44.190 reached"),
    ("street-address", "delivered to 12 Mulberry Lane, Reading"),
    ("postcode", "posted to SW1A 2AA"),
    ("email", "mail some.person@somewhere-else.org for the key"),
    ("ssh-public-key-body", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx me@box"),
]
PLANTED_NAMES = [
    ("key-file-name", "vm/keys/id_ed25519"),
    ("key-file-name", "deploy/.secrets/socom_linux.pem"),
    ("key-file-name", "server/.env.production"),
    ("key-file-name", "site/credentials.json"),
]
PLANTED_USER = "Testowner"
PLANTED_EXTRA = "Chateau Griffondor"


def self_test():
    """Run every planted secret through the rules it must trip. Returns {"planted", "caught", "missed": [...]}.
    The rules run with a synthetic owner name and literal so the control does not depend on whose machine it is."""
    # the artifact surface carries every rule the tree surface does, plus private-ip; the control runs on it and
    # then checks the tree surface still catches everything but that one
    trules = R.text_rules(users=[PLANTED_USER], extras=[PLANTED_EXTRA], surface="artifact")
    tree_rules = R.text_rules(users=[PLANTED_USER], extras=[PLANTED_EXTRA], surface="tree")
    nrules = R.name_rules(users=[PLANTED_USER], extras=[PLANTED_EXTRA])
    cases = list(PLANTED) + [("owner-user-name", f"built by {PLANTED_USER} on the PC"),
                             ("owner-literal", f"the place is called {PLANTED_EXTRA}")]
    missed = []
    for rule, body in cases:
        fired = {r for r, fn in trules if fn(body)}
        if rule not in fired:
            missed.append(f"text {rule}: {R.mask(body)}")
        if rule != "private-ip" and rule not in {r for r, fn in tree_rules if fn(body)}:
            missed.append(f"text(tree) {rule}: {R.mask(body)}")
    for rule, name in PLANTED_NAMES:
        fired = {r for r, fn in nrules if fn(name)}
        if rule not in fired:
            missed.append(f"name {rule}: {name}")
    # and the negative half: the project's own identifiers must NOT fire, or the gate gets switched off
    clean = ("harness=dc6a625571d778883146da3911413fe22a69a7f8 "
             "sha256=d6e30021123456789012ababababababababababababababababababababab "
             "hosted 3.143.65.100 / socom.scotho.com, exit 65, 1.2.3.400, mpexit=0, 127.0.0.1:8775 "
             "img/run-s8_voice_open/A_03_name_and_more_here.png best=864.288313900726 "
             "Co-Authored-By: Claude <noreply@anthropic.com> C:\\Users\\<you>\\socom.iso %USERPROFILE%\\x "
             "password: <your password> token=[redacted] PS2X_SOCOM2_LOGIN_PASS=${PASS}")
    false_alarm = [r for r, fn in trules if fn(clean)]
    if false_alarm:
        missed.append("false alarm on the project's own identifiers: " + ", ".join(sorted(set(false_alarm))))
    # The product-word exception, both directions. The rules above are built with an explicit `users=`,
    # so nothing else here reaches drop_product_words -- and it is the one piece of this gate that can
    # switch a whole rule off. A regression in either direction has to fail the control the pre-commit
    # hook runs, not only a unit test somebody may not be running.
    if R.drop_product_words(["socom"], log=False):
        missed.append("owner-user-name: the product's own name is still hunted as this machine's user")
    if R.drop_product_words([PLANTED_USER], log=False) != {PLANTED_USER}:
        missed.append("owner-user-name: a real user name was dropped as a product word")
    # Sprint 13 S6: the tracked-tree address check fires on a private address and never on a documentation one
    got = []
    scan_private("planted", b"lan 10.20.30.40 and 172.20.0.9\n", got)
    if [h.rule for h in got] != [TRACKED_PRIVATE_RULE]:
        missed.append("tracked-private-ip: a private address in a tracked file was not reported")
    got = []
    scan_private("planted", b"example 192.0.2.10, 198.51.100.5, 203.0.113.7, 127.0.0.1\n", got)
    if got:
        missed.append("tracked-private-ip: an RFC 5737 documentation address was reported")
    total = len(cases) + len(PLANTED_NAMES) + 5
    return {"planted": total, "caught": total - len(missed), "missed": missed}


# --------------------------------------------------------------------------------------------
# main

MODES = ("tree", "staged", "ignored", "metadata", "history", "artifact", "external", "all")
# what `all` runs: the four that read this repository, then the siblings. External last -- it starts other
# processes, and a local hit should be on the terminal before that happens.
ALL_MODES = ("tree", "ignored", "metadata", "history", "external")


def run_mode(mode, args, cwd, rules, allow):
    if mode == "tree":
        return check_tree(cwd, rules, allow)
    if mode == "staged":
        return check_staged(cwd, rules, allow)
    if mode == "ignored":
        return check_ignored(cwd, allow=allow)
    if mode == "metadata":
        return check_metadata(cwd, allow)
    if mode == "history":
        return check_history(cwd, args, rules, allow)
    if mode == "artifact":
        if len(args) != 1 or not os.path.isdir(args[0]):
            raise ScanNotRun("artifact: give one directory that exists")
        return check_dir(args[0], build_rules(surface="artifact"), allow)
    raise ScanNotRun(f"unknown mode {mode}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=MODES)
    ap.add_argument("args", nargs="*", help="history: a rev range; artifact: the directory")
    ap.add_argument("--json", metavar="FILE", help="write the report as JSON (excerpts masked); `-` for stdout")
    ap.add_argument("--reveal", action="store_true", help="print matched text unmasked on the terminal")
    ap.add_argument("--max-report", type=int, default=80, help="how many hits to print (all are counted)")
    ap.add_argument("--allow", default=ALLOW_FILE, help="the allow list (default: leak_allow.txt beside the tool)")
    ap.add_argument("--repo", default=ROOT, help="the repository to scan (default: this one)")
    ap.add_argument("--siblings-root", default=None,
                    help=f"external: where ../scotho and ../socom_monitor are (default: ${SIBLINGS_ENV}, "
                         "else the directory holding this repository)")
    ap.add_argument("--require", action="store_true",
                    help="external: a sibling that is not there is exit 2, not a SKIPPED line")
    ap.add_argument("--no-self-test", action="store_true", help="skip the planted control (tests only)")
    a = ap.parse_args(argv)
    err = sys.stderr

    report = {"tool": "leakcheck", "target": a.mode, "scanned": {}, "self_test": {}, "findings": [], "exit": 2}

    def finish(code):
        report["exit"] = code
        if a.json:
            text = json.dumps(report, indent=2)
            if a.json == "-":
                print(text)
            else:
                with open(a.json, "w", encoding="utf-8") as fh:
                    fh.write(text + "\n")
        return code

    if not a.no_self_test:
        st = self_test()
        report["self_test"] = {"planted": st["planted"], "caught": st["caught"], "missed": st["missed"]}
        if st["missed"]:
            print(f"leakcheck: SELF-TEST FAILED -- {len(st['missed'])} of {st['planted']} planted controls missed:", file=err)
            for m in st["missed"]:
                print("  " + m, file=err)
            print("leakcheck: the scanner is broken; this is NOT a clean result.", file=err)
            return finish(2)
    try:
        allow = load_allow(a.allow)
    except ValueError as e:
        print(f"leakcheck: {e}", file=err)
        return finish(2)
    rules = build_rules()
    modes = list(ALL_MODES) if a.mode == "all" else [a.mode]
    hits, totals = [], new_stats()
    ext_findings, ext_skipped, ext_broken = [], [], []
    try:
        for mode in modes:
            if mode == "external":
                report["external"] = run_externals(siblings_root(a.siblings_root))
                for e in report["external"]:
                    print(external_line(e, a.require))
                    ext_findings += e["findings"]
                    if e["state"] == "not_run":
                        (ext_skipped if e["skipped"] else ext_broken).append(f"{e['tool']} ({e['repo']})")
                continue
            mh, ms = run_mode(mode, a.args, a.repo, rules, allow)
            hits += mh
            for k, v in ms.items():
                totals[k] += v
            print(f"leakcheck[{mode}]: {ms['files']} files ({ms['text_files']} text, {ms['binary_files']} binary), "
                  f"{ms['lines']} lines, {ms['bytes']} bytes, {ms['commits']} commits; {len(mh)} hit(s)")
    except ScanNotRun as e:
        print(f"leakcheck: did not run -- {e}", file=err)
        return finish(2)
    except RuntimeError as e:
        print(f"leakcheck: did not run -- {e}", file=err)
        return finish(2)
    report["scanned"] = totals
    report["findings"] = [h.as_json() for h in hits] + ext_findings
    # the hits, ours and the siblings', before any verdict: whoever is fixing them needs them printed even when
    # the run is going to exit 2 for a scanner that never got started
    by_rule = {}
    for h in hits:
        by_rule[h.rule] = by_rule.get(h.rule, 0) + 1
    for h in hits[:a.max_report]:
        print(h.render(a.reveal), file=err)
    if len(hits) > a.max_report:
        print(f"... and {len(hits) - a.max_report} more", file=err)
    for f in ext_findings[:a.max_report]:
        by_rule[f["rule"]] = by_rule.get(f["rule"], 0) + 1
        print(f"{f['file']}:{f['line']}: {f['rule']}: {f['excerpt_masked']}  [{f['tool']}]", file=err)
    if by_rule:
        print("leakcheck: " + ", ".join(f"{k}={v}" for k, v in sorted(by_rule.items())), file=err)

    # "did not run" outranks both verdicts: a scan that did not happen cannot be reported as either result.
    blocked = list(ext_broken) + (list(ext_skipped) if a.require else [])
    if blocked:
        print(f"leakcheck: did not run -- {len(blocked)} external scanner(s) did not scan: "
              f"{', '.join(blocked)}. This is NOT a clean result" +
              (f", and {len(report['findings'])} finding(s) above still stand." if report["findings"] else "."),
              file=err)
        return finish(2)
    n = len(report["findings"])
    if not n:
        if ext_skipped:
            print(f"leakcheck: 0 hits here, but {len(ext_skipped)} external scanner(s) DID NOT RUN "
                  f"({', '.join(ext_skipped)}) -- nothing is claimed about what they cover; `--require` makes "
                  f"that exit 2 (self-test {report['self_test'].get('caught', '-')}/"
                  f"{report['self_test'].get('planted', '-')})")
        else:
            print(f"leakcheck: 0 hits -- clean ({', '.join(modes)}; self-test "
                  f"{report['self_test'].get('caught', '-')}/{report['self_test'].get('planted', '-')})")
        return finish(0)
    where = len({h.path for h in hits} | {f["file"] for f in ext_findings})
    print(f"leakcheck: FAILED -- {n} hit(s) in {where} file(s). Do not publish.", file=err)
    return finish(1)


if __name__ == "__main__":
    sys.exit(main())
