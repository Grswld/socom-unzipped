#!/usr/bin/env bash
# Run the recompiled game for N seconds and keep the log.  Usage: [SOCOM_EXE=<runner>] ./run.sh [seconds] [extra args]
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SECS="${1:-20}"; shift || true
export PATH="$ROOT/tools/llvm-mingw/bin:$PATH"
mkdir -p "$ROOT/logs"
# PS2X_RUN_LOG=<path> pins the log this run writes, so a driver that has to read the game's own
# output live (the online harness tails "[peek]" rows) knows which file to follow.
LOG="${PS2X_RUN_LOG:-$ROOT/logs/run_$(date +%Y%m%d_%H%M%S).log}"
ln -sf "$LOG" "$ROOT/logs/latest.log" 2>/dev/null || cp /dev/null "$ROOT/logs/latest.log"
# Sprint 9 Goal 2: SOCOM_EXE names another runner (the release build in dist-release/); the default is unchanged.
# macOS port: the runner is dist-macos/socom2 there; the default elsewhere is unchanged.
case "$(uname -s)" in
  Darwin) DEFAULT_EXE="$ROOT/dist-macos/socom2" ;;
  *)      DEFAULT_EXE="$ROOT/dist/socom2.exe" ;;
esac
EXE="${SOCOM_EXE:-$DEFAULT_EXE}"
# Sprint 11 Task 19: SOCOM_GAME_ELF names another overlay image (a revision built by scripts/build_revision.sh,
# copied to a file CALLED socom2_game.elf -- the runtime keys its overrides on that name); the default is unchanged.
ELF="${SOCOM_GAME_ELF:-$ROOT/game/disc/socom2_game.elf}"
# Sprint 9 Goal 3: run.sh is a developer's and the harness's launcher, so it is a developer-mode launch -- the
# probes it is used with (PS2X_PEEK, the exported frame, the pad file) are ignored by the game otherwise.
# PS2X_DEV=0 ./run.sh is a stranger's run.
export PS2X_DEV="${PS2X_DEV:-1}"
# Base macOS has no timeout(1): use it (or coreutils' gtimeout) when present, else the same thing by hand,
# exiting 124 on expiry as timeout does, so the harness reads one code everywhere.
if command -v timeout >/dev/null 2>&1; then
  timeout "$SECS" "$EXE" "$ELF" "$@" > "$LOG" 2>&1; rc=$?
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout "$SECS" "$EXE" "$ELF" "$@" > "$LOG" 2>&1; rc=$?
else
  "$EXE" "$ELF" "$@" > "$LOG" 2>&1 &
  pid=$!
  # The watcher holds none of the caller's stdio and takes its sleep down with it, so a game that exits early
  # never leaves an orphaned sleep keeping a caller's pipe open for the rest of the timeout.
  ( exec >/dev/null 2>&1; sleep "$SECS" & s=$!; trap 'kill "$s" 2>/dev/null; exit 0' TERM; wait "$s"
    kill -TERM "$pid" 2>/dev/null && : > "$LOG.expired" ) &
  watcher=$!
  wait "$pid" 2>/dev/null; rc=$?   # (no "Terminated" job notice: timeout(1) prints none)
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  if [ -e "$LOG.expired" ]; then rc=124; rm -f "$LOG.expired"; fi
fi
echo "exit=$rc log=$LOG exe=$EXE lines=$(wc -l < "$LOG")"
grep -v "^INFO: " "$LOG" | head -60
