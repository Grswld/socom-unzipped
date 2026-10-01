"""The pre-commit chain guard: no commit in the tree a merged chain runs in (Sprint 17 G1).

git runs `scripts/hooks/pre-commit` (installed by `core.hooksPath scripts/hooks`, scripts/install_hooks.sh) before
the commit is made; that script runs this module BEFORE the leak check, and exit 1 refuses the commit. The finding
behind it (Sprint 16's lesson 1; docs/audits/2026-09-28-multi-session-collisions.md): scripts/parity/merged_chain.sh
checks the tree and HEAD after every step and goes red on "HEAD moved"; five chains went red on 2026-09-27/28 because
another session committed or edited in the tree the chain ran in, and each rerun cost 90 minutes.

The rule, `check(root)`: refuse when THIS tree is the chain's tree -- its `logs/.merged_chain.running` names a live
pid created no later than the marker was written (tools_py/hooks/chainmark.py owns the marker and the liveness
test; the chain writes it at its start and removes it on every exit path). The loop lock's state is not consulted:
the marker says which tree is pinned, a HELD lock does not. Another tree's marker never counts, so an agent worktree
(no chain runs there) never refuses. Cost: one stat and, when the marker exists, one small read and an in-process
pid check -- no git command at all (the hook has already `cd`-ed to `git rev-parse --show-toplevel`).
Anything that goes wrong in here exits 0 with a sentence on stderr: a broken hook must not block commits. The Edit/
Write half of the same guard is tools_py/hooks/pretool.py. The rule's home: docs/DEVELOPING.md "Guards".
"""
import os
import sys

from tools_py.hooks import chainmark

HOME = "docs/DEVELOPING.md Guards"


def check(root, alive=None):
    """(0, "") when the commit may go ahead; (1, reason) when a live merged chain pins the tree `root`."""
    mark = chainmark.running(root, alive)
    if not mark:
        return 0, ""
    return 1, ("a merged chain runs in this tree (stamp %s, pid %s) -- no commit here until it ends; %s "
               "(Sprint 17 G1; home: %s)" % (mark.get("stamp") or "?", mark["pid"], chainmark.STALE_HINT, HOME))


def main():
    try:
        root = chainmark.tree_root(os.getcwd()) or os.getcwd()
        code, why = check(root)
        if code:
            sys.stderr.write("precommit: %s\n" % why)
        return code
    except Exception as e:                               # never block a commit on the hook's own failure
        sys.stderr.write("precommit: the chain guard failed (%s: %s) -- the commit is NOT checked; "
                         "report it (tools_py/hooks/precommit.py)\n" % (type(e).__name__, e))
        return 0


if __name__ == "__main__":
    sys.exit(main())
