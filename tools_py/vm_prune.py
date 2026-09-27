"""What scripts/vm_sync.sh tree must delete in the guest: files under the synced roots that the host no
longer has. Reads the guest's list on stdin, prints the stale paths; the host's list comes from the tree.

The host's side is `git ls-files` AND a walk of the same roots (Sprint 11 Task 18). git alone would delete
an operator's untracked scratch file from the guest on the next sync; the walk alone missed nothing but was
never asked about docs/, so when fourteen documents moved into docs/archive/ on 2026-09-22 the guest kept
both copies and `python3 -m tools_py.docmaint` failed on every duplicate in the VM.

ROOTS is what may be pruned: the source trees, docs/, tests/ and ghidra_scripts/ -- all of them fully
tracked directories that the tar sends whole. Everything the tar does NOT send is refused outright
(EXCLUDED), so a guest build tree, its logs, its keys, its .git or its extracted disc can never be named
here however the lists are shaped. Root-level files are not pruned: the walk does not descend from the
root, and a renamed README is not the failure this guards.

And there is a floor. "The host has nothing" reads as "delete everything" to stale(), so a host list that
cannot be trusted -- a root missing its directories, an empty list, fewer paths than FLOOR, no README.md
-- stops the run with a sentence instead of producing a longer list (see refuse()). This is the only
thing in the VM ring that deletes, and scripts/vm_sync.sh pipes its output straight into
`xargs -0 rm -f --` behind nothing but `[ -s ]`.
"""
import os
import subprocess
import sys

ROOTS = ("third_party/ps2recomp/ps2xLauncher/", "third_party/ps2recomp/ps2xShared/",
         "third_party/ps2recomp/ps2xRuntime/", "third_party/ps2recomp/ps2xTest/",
         "third_party/ps2recomp/ps2xIOP/", "tools_py/", "scripts/",
         "docs/", "tests/", "ghidra_scripts/")

# What scripts/vm_sync.sh's tar never sends, plus the guest's own git directory and server/. A path under
# any of these is not the host's to manage, and is never printed even if a list somehow names it. server/ is
# synced (its config and its Linux scripts are what three Python tests read) but never pruned: the tar leaves
# server/config/simulated.db behind on purpose, and that file is the guest's own.
EXCLUDED = (".git/", "vm/", "logs/", "game/", "dist/", "dist-release/", "dist-linux/", "dist-linux-release/",
            "dist-release-dev/", "dist-linux-release-dev/",
            "recomp/output/", "tools/", "research/", "node_modules/", "server/",
            "third_party/ps2recomp/build-clang/", "third_party/ps2recomp/build-tools/",
            "third_party/ps2recomp/build-linux/", "third_party/ps2recomp/build-linux-release/",
            "third_party/ps2recomp/build-linux-release-dev/")
SKIP_PARTS = ("__pycache__", "_deps")


def _norm(path):
    path = path.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def _prunable(path):
    parts = path.split("/")
    if path.startswith("/") or ".." in parts or any(p in SKIP_PARTS for p in parts):
        return False
    if path.startswith(EXCLUDED):
        return False
    return path.startswith(ROOTS)


def stale(host_files, guest_files):
    host = {_norm(p) for p in host_files}
    return sorted(p for p in {_norm(g) for g in guest_files} if p and _prunable(p) and p not in host)


def tracked(root):
    """Everything git tracks in this checkout -- including a file the walk below would not reach."""
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=root, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, check=True)
    except (OSError, subprocess.CalledProcessError):
        return []
    return [p for p in out.stdout.decode("utf-8", "replace").split("\0") if p]


def host_files(root):
    """What the host has under the pruned roots: the tracked set, plus whatever is really on disk."""
    out = list(tracked(root))
    for base in ROOTS:
        for dirpath, _dirs, files in os.walk(os.path.join(root, base)):
            out.extend(os.path.relpath(os.path.join(dirpath, f), root) for f in files)
    return out


# A host list this small is not a checkout of this repository, and "the host has nothing" reads as
# "delete everything" to stale(). The real tree carries thousands of files under ROOTS; 100 is far below
# anything a genuine sync could produce and far above an accident.
FLOOR = 100
# ... and one file whose absence means the root is not this repository at all, whatever the count says.
KEYSTONE = "README.md"


def refuse(root, host):
    """Why this host list must not be pruned against, or None. The prune is the only thing here that
    deletes, and scripts/vm_sync.sh pipes its output straight into `xargs -0 rm -f --` behind nothing but
    `[ -s ]` -- so a host list that cannot be trusted has to stop the run, not produce a longer list."""
    missing = [r for r in ROOTS if not os.path.isdir(os.path.join(root, r))]
    if missing:
        return ("these pruned roots are not on the host under %s: %s -- wrong root, or a checkout that "
                "is not this repository" % (root, ", ".join(missing)))
    if not host:
        return "the host list is empty under %s -- wrong root, or git could not run" % root
    if len(host) < FLOOR:
        return ("the host list has %d paths under %s, below the floor of %d -- a partial or wrong "
                "checkout" % (len(host), root, FLOOR))
    if not os.path.isfile(os.path.join(root, KEYSTONE)):
        return "%s is not at %s -- that is not this repository's root" % (KEYSTONE, root)
    return None


if __name__ == "__main__":
    sys.stdout.reconfigure(newline=chr(10))   # the list goes to a Linux xargs: no CR
    _root = sys.argv[1]
    _host = host_files(_root)
    _why = refuse(_root, _host)
    if _why:
        sys.exit("vm_prune: %s -- refusing to prune, nothing deleted." % _why)
    for path in stale(_host, sys.stdin.read().splitlines()):
        print(path)
