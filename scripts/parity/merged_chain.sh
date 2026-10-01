#!/usr/bin/env bash
# The merged chain -- the gate unit (Sprint 14 Task W2; spec Milestone W, W2). An agent's task is DONE (code) at a
# clean review of its branch; the proof is this chain, run ONCE per batch of merged branches on the sprint branch:
#
#   recomp -> runtime -> suites -> gate (on the exe it just built) -> the fourth leg (E2, scored on the gate's run) -> release build ->
#   the release archive and PLAYTEST's build block (D5: playtest_block.sh --release)
#
# RUN A COPY, NEVER THIS FILE: bash reads a script by offset, and a merge that rewrites the tracked template under a
# running chain breaks it at the edit point. The controller copies it into the tree's (git-ignored) logs/ and
# launches the copy once, under ONE holding of the loop lock:
#
#   cp scripts/parity/merged_chain.sh logs/s14_merged_chain.sh
#   bash scripts/run_detached.sh --owner <o> --purpose "merged chain" --wait <minutes> \
#       logs/s14_merged_chain.sh logs/s14_merged_chain.detached [<gate stamp>]
#
# (or `bash scripts/loop_lock.sh run <o> --wait <minutes> -- bash logs/s14_merged_chain.sh [<stamp>]`). Every step's
# own lock use -- build.sh's check, gate.py's take -- is NESTED under that holding (LOOP_LOCK_HELD; the header of
# scripts/loop_lock.sh). The chain itself takes, waits for and releases nothing: one take per step would leave a gap
# between steps, and the queue grants that gap to its head. Outside a live holding (LOOP_LOCK_HELD unset, or not
# the live record's id) it refuses, exit 2, before anything runs.
#
# THE TREE: the chain refuses (exit 2) a tree with ANY modified tracked file -- it proves a commit, not a working
# copy, and the controller stashes nothing on another session's behalf. After every step it looks again: a step that
# changed a tracked file is red (the PLAYTEST step may change docs/PLAYTEST.md, which it exists to rewrite; the close
# commits that block -- nothing is committed mid-chain). HEAD is checked after every step too: a commit or checkout
# mid-chain is red ("HEAD moved from <h0> to <h1> during <step>") and records nothing.
#
# RED: the first failing step ends the chain with its exit code and prints the merges since the last green chain
# (`git log --merges --first-parent <last green>..HEAD`; the last green is the commit hash in
# logs/merged_chain.last_green, written only at a green end; with no record, the merges since MERGED_CHAIN_BASE,
# default main) and the eviction procedure, docs/GIT_STRATEGY.md "Slices": bisect by branch, evict the culprit with
# `git revert -m 1 <merge>` on the sprint branch, record it in the plan's Log with the reason, re-queue the branch for
# its author.
#
# Records: logs/<this script's name>.done -- "done 0 all-green", "done <rc> <step>" or "done 2 refused-<why>";
# logs/merged_chain.last_green -- the commit a green chain proved; logs/.merged_chain.running -- present exactly while
# the steps run (written after the tree and HEAD0 are fixed, removed by an EXIT trap; never on a refusal or a dry
# run): the hooks refuse a commit, and an Edit/Write of a tracked file, in this tree while it names a live pid
# (Sprint 17 G1; tools_py/hooks/chainmark.py).
#
# Environment: MERGED_CHAIN_DRY_RUN=1 prints the steps and runs none, checks no lock, writes nothing, and exits 3 --
# never 0, so a leaked switch can never make a chain green. For tools_py/tests/test_merged_chain.py:
# MERGED_CHAIN_LOCK_SH (the lock script asked for the live id), MERGED_CHAIN_LEG_REFS (the E2 references' directory,
# default scripts/parity/refs/heldout/), MERGED_CHAIN_BASE (main). PYTHON as scripts/python_env.sh.
set -u
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$ROOT" ] || { echo "merged_chain: $0 is not inside a git work tree"; exit 2; }
cd "$ROOT" || exit 2
NAME="$(basename "$0" .sh)"
STAMP="${1:-${NAME}_$(date -u +%Y%m%d_%H%M%S)}"
DONE="$ROOT/logs/$NAME.done"
LAST_GREEN="$ROOT/logs/merged_chain.last_green"
LOCKSH="${MERGED_CHAIN_LOCK_SH:-$ROOT/scripts/loop_lock.sh}"
LEG_REFS="${MERGED_CHAIN_LEG_REFS:-$ROOT/scripts/parity/refs/heldout}"
BASE="${MERGED_CHAIN_BASE:-main}"
DRY=""; [ "${MERGED_CHAIN_DRY_RUN:-}" = 1 ] && DRY=1
OWNER="${LOOP_LOCK_HELD:-}"; OWNER="${OWNER%% *}"; OWNER="${OWNER:-merged-chain}"
case "$(uname -s)" in
  Linux) EXE="$ROOT/dist-linux/socom2" ;;
  *)     EXE="$ROOT/dist/socom2.exe" ;;
esac
. "$ROOT/scripts/python_env.sh"   # $PYTHON
N=0

refuse() {   # why message...
  local why="$1"; shift
  echo "merged_chain: REFUSED -- $*"
  [ -n "$DRY" ] || { mkdir -p "$ROOT/logs"; echo "done 2 refused-$why" > "$DONE"; }
  exit 2
}

merges_since() {
  local from="" what="" why="no green chain recorded in $LAST_GREEN"
  [ -f "$LAST_GREEN" ] && read -r from < "$LAST_GREEN"
  # The record starts the range only if it is a commit HEAD descends from: a green on another line (a branch that
  # was reset, a record copied from another tree) would list the wrong batch.
  if [ -n "$from" ]; then
    if git cat-file -e "$from^{commit}" 2>/dev/null && git merge-base --is-ancestor "$from" HEAD 2>/dev/null; then
      what="since the last green chain ($from, $LAST_GREEN)"
    else
      why="the last-green record $from is not on this line (HEAD does not descend from it)"
      echo "$why -- falling back to the merges since $BASE"
      from=""
    fi
  fi
  if [ -n "$what" ]; then :
  elif git rev-parse -q --verify "$BASE^{commit}" >/dev/null 2>&1; then
    from="$BASE"; what="since $BASE ($why)"
  else
    from=""; what="on this branch ($why, and no $BASE)"
  fi
  echo "THE MERGES $what, newest first -- the batch this red belongs to:"
  if [ -n "$from" ]; then git log --merges --first-parent --format='  %h %s' "$from..HEAD"
  else git log --merges --first-parent --format='  %h %s' HEAD; fi
}

red() {   # rc step-id
  echo
  echo "=== RED at step $N: $2 (rc=$1) === $(date -u +%FT%TZ)"
  merges_since
  cat <<'EOF'
EVICTION (docs/GIT_STRATEGY.md, "Slices"): bisect by branch -- rerun this chain with a suspect merge reverted until
it is green; evict the culprit with `git revert -m 1 <merge>` on the sprint branch (a commit naming its paths),
record the eviction in the plan's Log with the reason and this chain's red step, and re-queue the branch for its
author. The last-green record is not moved by a red chain.
EOF
  echo "done $1 $2" > "$DONE"
  exit "$1"
}

step() {   # id title cmd...
  local id="$1" title="$2" rc changed head; shift 2
  N=$((N + 1))
  echo
  echo "=== step $N: $title === $(date -u +%FT%TZ)"
  echo "\$ $*"
  [ -n "$DRY" ] && return 0
  "$@" 2>&1 | grep --line-buffered -vE '^\[[0-9]+/[0-9]+\] '
  rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || red "$rc" "$id"
  changed="$(git status --porcelain --untracked-files=no)"
  [ "$id" = playtest ] && changed="$(printf '%s\n' "$changed" | grep -v ' docs/PLAYTEST\.md$')"
  if [ -n "$changed" ]; then
    echo "TRACKED FILES CHANGED by step $N ($title):"; printf '%s\n' "$changed"
    red 1 "$id-changed-tracked-files"
  fi
  # A commit landing mid-chain (a merge in this tree, a checkout) means the steps did not all build one commit.
  head="$(git rev-parse HEAD)"
  if [ "$head" != "$HEAD0" ]; then
    echo "HEAD moved from $HEAD0 to $head during $id (step $N, $title) -- no commits mid-chain; nothing is recorded"
    red 1 "$id-moved-head"
  fi
}

# ---- before: the lock, the tree -----------------------------------------------------------------------------------
if [ -n "$DRY" ]; then
  echo "merged_chain: DRY RUN -- the steps are printed, none runs; the lock is not checked; nothing is recorded"
else
  [ -n "${LOOP_LOCK_HELD:-}" ] || refuse no-lock "not run under the loop lock (LOOP_LOCK_HELD is unset): launch a" \
    "copy once, queued, through run_detached or the lock's run verb, as this file's header shows"
  live="$(bash "$LOCKSH" id 2>/dev/null)"
  [ "$live" = "$LOOP_LOCK_HELD" ] || refuse no-lock "LOOP_LOCK_HELD='$LOOP_LOCK_HELD' is not the live lock" \
    "('${live:-free}'): the chain runs only inside the holding that launched it"
  socom_require_python merged_chain
  mkdir -p "$ROOT/logs"; rm -f "$DONE"
fi
before="$(git status --porcelain --untracked-files=no)"
if [ -n "$before" ]; then
  refuse dirty-tree "modified tracked files -- the chain proves a commit, and it stashes nothing:"$'\n'"$before"
fi
HEAD0="$(git rev-parse HEAD)"
# The chain's tree is pinned while it runs (Sprint 17 G1): the hooks read this marker -- no commit here
# (tools_py/hooks/precommit.py), no Edit/Write of a tracked file here (tools_py/hooks/pretool.py); the format and the
# liveness test are tools_py/hooks/chainmark.py's. The EXIT trap removes it on every exit a trap sees (a red, a green,
# TERM/HUP/INT); a hard kill leaves it naming a dead pid, which the hooks judge not running.
RUNNING="$ROOT/logs/.merged_chain.running"
if [ -z "$DRY" ]; then
  pid=""
  { [ -r "/proc/$$/winpid" ] && IFS= read -r pid < "/proc/$$/winpid"; } 2>/dev/null   # Git Bash: the Windows pid
  [ -n "$pid" ] || pid=$$
  trap 'rm -f "$RUNNING" "$RUNNING.tmp"' EXIT
  printf 'pid=%s\nstart=%s\nhead=%s\nstamp=%s\nroot=%s\nheld=%s\n' "$pid" "$(date +%s)" "$HEAD0" "$STAMP" "$ROOT" \
    "$LOOP_LOCK_HELD" > "$RUNNING.tmp" && mv -f "$RUNNING.tmp" "$RUNNING"
fi
echo "=== merged chain $NAME: $(git log --oneline -1) on $(git rev-parse --abbrev-ref HEAD), stamp $STAMP, $(date -u +%FT%TZ)"
echo "git status before: clean (tracked files); lock: ${LOOP_LOCK_HELD:-<dry run>}; exe: $EXE"
echo "last green chain: $(cat "$LAST_GREEN" 2>/dev/null || echo "none recorded")"

# ---- the steps ----------------------------------------------------------------------------------------------------
step recomp "recomp" ./build.sh recomp
step runtime "runtime" ./build.sh runtime
if [ -z "$DRY" ]; then
  [ -f "$EXE" ] || { echo "the runtime step left no $EXE"; red 1 runtime-no-exe; }
  sha256sum "$EXE"
fi
step test "test" ./build.sh test
step gate "gate" env SOCOM_EXE="$EXE" "$PYTHON" -m tools_py.parity.gate --stamp "$STAMP" --owner "$OWNER"
if [ -d "$LEG_REFS" ]; then
  step leg "the fourth leg" env SOCOM_EXE="$EXE" "$PYTHON" -m tools_py.parity.gate --leg heldout "$ROOT/logs/parity/gate/$STAMP"
else
  N=$((N + 1))
  echo
  echo "=== step $N: the fourth leg === $(date -u +%FT%TZ)"
  echo "SKIPPED: $LEG_REFS does not exist yet (Task E2 captures its references at the first quiet window);" \
    "nothing is scored and nothing is claimed for this leg"
fi
step release "release" ./build.sh release
step playtest "archive and PLAYTEST block" bash scripts/parity/playtest_block.sh --release

# ---- after --------------------------------------------------------------------------------------------------------
if [ -n "$DRY" ]; then
  echo
  echo "=== DRY RUN: $N steps listed, none run, nothing recorded -- exit 3 (a dry run is never green) ==="
  exit 3
fi
echo
echo "git status after: $(git status --porcelain --untracked-files=no | tr '\n' ' ' | sed 's/ $//')"
echo "$HEAD0" > "$LAST_GREEN"          # every step checked HEAD against HEAD0: the chain built this one commit
echo "done 0 all-green" > "$DONE"
echo "=== ALL GREEN: $HEAD0 proved (stamp $STAMP); $LAST_GREEN updated === $(date -u +%FT%TZ)"
