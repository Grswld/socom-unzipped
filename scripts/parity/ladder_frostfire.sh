#!/usr/bin/env bash
# TEMPLATE -- the Sprint 5 engagement-ladder launch on FROSTFIRE (Task 5, Amendment A). Not run by any test except its
# dry runs and --outcome. Every ladder launch is fully armed and plays up to $ROUNDS rounds on one lobby success.
#
#   scripts/parity/ladder_frostfire.sh --dry-run [out_dir]            validate args, route file, peek/trace spec against
#                                                                     the LIVE tree; no game, no lock (prints harness=<sha>-live)
#   scripts/parity/ladder_frostfire.sh --dry-run --pinned [out_dir]   the same against a PINNED snapshot of HEAD in
#                                                                     <out_dir>/harness (default logs/parity/dryrun_pinned_<ts>):
#                                                                     the route resolves inside the snapshot and the line
#                                                                     prints harness=<sha> -- exactly what a launch runs
#   scripts/parity/ladder_frostfire.sh [out_dir]                      pin HEAD into <out_dir>/harness, run the pinned dry
#                                                                     run, then launch DETACHED (scripts/run_detached.sh
#                                                                     --purpose launch-ladder: loop lock, logs/.quiet, 1 s
#                                                                     CPU sampler, refuses below 4 GB free on C:) on THAT
#                                                                     snapshot. A launch is PINNED BY DEFAULT (--pinned is
#                                                                     accepted and changes nothing)
#   scripts/parity/ladder_frostfire.sh --live [out_dir]               the explicit opt-out: launch on the LIVE tree (no
#                                                                     snapshot; RESULT lines print harness=<sha>-live)
#   scripts/parity/ladder_frostfire.sh --outcome <rc> <drive_log>     print the done-marker line for a harness exit code
#
# Pinning (scripts/pin_harness.sh: `git archive HEAD tools_py scripts` into <out_dir>/harness with HARNESS_COMMIT /
# EXE_BUILD) is CHECKED: a non-zero exit, an incomplete snapshot or a pinned import that does not resolve under the
# snapshot (python compares real paths) fails the launch loudly (exit 7, PIN-FAIL) -- never a silent fall back to the
# live tree. The child runs PYTHONPATH=<snapshot> PYTHONSAFEPATH=1 from the repo root, so a 30 min launch is scored by the
# reviewed code and its RESULT lines print harness=<commit> exe=<sha>.
#
# Markers: run_detached.sh writes `exit=<code>` to logs/<name>.detached when the lock is released; the child writes
# logs/<name>.done as its last act: `done <rc> mpexit=<rc> <outcome> harness=<commit> <EXE_BUILD>`, <outcome> one of
# LOBBY-FAIL <class> (exit 4, R47: no round was played -- never a usable round, nothing toward the A1 stop rules),
# KILL (0), NO-KILL (1), NO-DATA (2), NO-CONTROL (3), CRASH (5: an uncaught harness exception -- never NO-KILL),
# PIN-FAIL (7), EXIT-<rc>.
#
# Before a launch (plan Task 5 Step 3): the local Horizon stack running (server/), persona B on game/disc/mc0_b
# (--existing-b), no socom2.exe running, `powershell -File scripts/kill_stale_drivers.ps1`, no other heavy host work.
# SOCOM_SERVER_IP (scripts/parity/env.sh) is the server: the hosted box by name unless set; for a Horizon
# stack on this machine, set it to this machine's LAN address.
#
# Instruments: scripts/parity/online_match_frostfire.sh's (MoveScale + NetIdle at EVERY=10; the actor block, +0x420,
# +0x174, the +0xF7A alive byte (inside the +0xF78 peek), +0x1044 health; CZNetGame + valves with name bytes; mission abort; the round clocks
# 0x4365c0 and 0x408f10) plus PS2X_GS_STATS=1 for rung 0's back-pressure waits (A4) and PS2X_VU_STATS=1 for the
# game's own frame rate (Sprint 17 F0).
#
# Knobs (environment): ROUTE (default: the SNAPSHOT's tools_py/parity/routes/frostfire_v2.json; the live tree's for an
# unpinned --dry-run), ROUNDS (4), MOVER (A), --auto-swap always (R66: a SWAP-MOVER continues with the other mover),
# SECONDS_RUN (2400: ~4 rounds of ~6.5 min + the lobby), PS2X_GS_MAX_PENDING_FRAMES (unset; 0 is the rung-0 A/B knob),
# PIN_HARNESS_SH (scripts/pin_harness.sh; tests substitute a failing one), RUN_DETACHED_SH (scripts/run_detached.sh;
# tests substitute one that records its arguments).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/write_env.sh"    # write_env_ps2x: the PS2X_* record beside a capture (issue #38)
socom_require_python ladder_frostfire
export PATH="/usr/bin:/bin:$PATH"

MODE=launch
PINNED=""
while :; do
  case "${1:-}" in
    --dry-run) MODE=dry; shift ;;
    --pinned) PINNED=1; shift ;;
    --live) PINNED=0; shift ;;
    --child) MODE=child; shift ;;
    --outcome) MODE=outcome; shift ;;
    *) break ;;
  esac
done
# close-out wave: a launch (and its detached child) is pinned unless --live says otherwise; a bare --dry-run stays live
if [ -z "$PINNED" ]; then
  if [ "$MODE" = dry ]; then PINNED=0; else PINNED=1; fi
fi

outcome() {   # outcome <rc> <drive_log> -> the <outcome> words of the done marker
  local rc="$1" log="$2" cls
  case "$rc" in
    4) cls="$(grep -a -o 'RESULT LOBBY-FAIL [^ ]*' "$log" 2>/dev/null | tail -1 | cut -d' ' -f3)"
       echo "LOBBY-FAIL ${cls:-unclassified}" ;;
    0) echo "KILL" ;;
    1) echo "NO-KILL" ;;
    2) echo "NO-DATA" ;;
    3) echo "NO-CONTROL" ;;
    5) echo "CRASH" ;;
    7) echo "PIN-FAIL" ;;
    *) echo "EXIT-$rc" ;;
  esac
}

if [ "$MODE" = outcome ]; then
  rc="${1:?--outcome <rc> <drive_log>}"
  echo "done $rc mpexit=$rc $(outcome "$rc" "${2:-/dev/null}")"
  exit 0
fi

if [ "$MODE" = dry ] && [ "$PINNED" = 1 ]; then
  OUT="${1:-logs/parity/dryrun_pinned_$(date +%Y%m%d_%H%M%S)}"
else
  OUT="${1:-logs/parity/ladder_frostfire_$(date +%Y%m%d_%H%M%S)}"
fi
NAME="$(basename "$OUT")"
ROUNDS="${ROUNDS:-4}"
MOVER="${MOVER:-A}"
SECONDS_RUN="${SECONDS_RUN:-2400}"
PIN_HARNESS_SH="${PIN_HARNESS_SH:-scripts/pin_harness.sh}"
RUN_DETACHED_SH="${RUN_DETACHED_SH:-scripts/run_detached.sh}"

HARNESS=""
pin() {       # pin <out_dir>: snapshot HEAD into <out_dir>/harness and set HARNESS, or fail LOUDLY (exit 7)
  local out rc
  mkdir -p "$1"
  out="$(bash "$PIN_HARNESS_SH" "$1" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "PIN-FAIL pin_harness exit $rc -- not falling back to the live tree:" >&2
    printf '%s\n' "$out" >&2
    exit 7
  fi
  HARNESS="$(printf '%s\n' "$out" | tail -1)"
  if [ ! -s "$HARNESS/HARNESS_COMMIT" ] || [ ! -f "$HARNESS/tools_py/parity/online_match_ours.py" ]; then
    echo "PIN-FAIL incomplete snapshot at '$HARNESS' (no HARNESS_COMMIT or harness code) -- not falling back:" >&2
    printf '%s\n' "$out" >&2
    exit 7
  fi
  # The import check, path-format proof: pin_harness.sh's own prefix match WARNs whenever <out_dir> is relative or an
  # MSYS /c/... path (python prints C:\...), so its "OK" line cannot be the gate. Python compares real paths itself.
  if ! PYTHONPATH="$HARNESS" PYTHONSAFEPATH=1 "$PYTHON" -c "import os, sys, tools_py.parity.online_match_ours as m
h = os.path.normcase(os.path.realpath(sys.argv[1])); f = os.path.normcase(os.path.realpath(m.__file__))
sys.exit(0 if f.startswith(h + os.sep) else 'imported ' + m.__file__ + ', not under ' + sys.argv[1])" "$HARNESS"; then
    echo "PIN-FAIL the pinned import did not resolve under the snapshot '$HARNESS' -- not falling back to the live tree" >&2
    exit 7
  fi
  # ... and the INSTRUMENTS, since Sprint 11 Task 19 (review F13, tightened in fix round 2, N3).
  # PS2X_PEEK and PS2X_CALL_TRACE were rendered when env.sh was sourced at the top of this script, by the
  # LIVE tools_py/parity/guest_addresses.py, while the launch is scored by the SNAPSHOT's code. Identical
  # in practice -- the pin is HEAD -- but a mid-session edit to the address table would change what the
  # rows are cut at without changing harness=<sha>, which is the hole the self-contained literal did not
  # have. So compare what this launch WILL USE against what the snapshot's table renders. That also
  # catches the other way in: an operator-exported PS2X_PEEK wins over env.sh's render by design, and a
  # launch cut by a spec the pinned code did not produce is not a pinned launch either.
  #
  # This runs on the pinned path only, which is every LAUNCH (PINNED defaults to 1 above). A bare
  # `--dry-run` is deliberately live -- it takes no snapshot, so there is nothing to compare.
  local _snap_vals _want_vals
  _snap_vals="$(
    unset PS2X_PEEK PS2X_CALL_TRACE
    eval "$(PYTHONPATH="$HARNESS" PYTHONSAFEPATH=1 "$PYTHON" -m tools_py.parity.guest_addresses --env)"
    printf '%s\n%s\n' "$PS2X_PEEK" "$PS2X_CALL_TRACE"
  )"
  _want_vals="$(printf '%s\n%s\n' "${PS2X_PEEK:-}" "${PS2X_CALL_TRACE:-}")"
  if [ "$_snap_vals" != "$_want_vals" ]; then
    echo "PIN-FAIL the instruments this launch would use are not the ones the snapshot's table renders." >&2
    echo "  The rows would be cut by one and scored by the other. Commit the address table and re-pin," >&2
    echo "  or unset an exported PS2X_PEEK/PS2X_CALL_TRACE so env.sh's render reaches the launch." >&2
    printf 'launch will use:\n%s\nsnapshot renders:\n%s\n' "$_want_vals" "$_snap_vals" >&2
    exit 7
  fi
}

if [ "$PINNED" = 1 ]; then
  if [ "$MODE" = child ] && [ -s "$OUT/harness/HARNESS_COMMIT" ]; then
    HARNESS="$OUT/harness"                 # the snapshot the launch's pinned dry run validated
  else
    pin "$OUT"
  fi
  ROUTE="${ROUTE:-$HARNESS/tools_py/parity/routes/frostfire_v2.json}"
  PY=(env PYTHONPATH="$HARNESS" PYTHONSAFEPATH=1 "$PYTHON" -m tools_py.parity.online_match_ours)
else
  ROUTE="${ROUTE:-tools_py/parity/routes/frostfire_v2.json}"
  PY=("$PYTHON" -m tools_py.parity.online_match_ours)
fi

# Instruments come from scripts/parity/env.sh (sourced above); these three are this script's own.
export PS2X_SOCOM2_RSA_KEY_B=b
export PS2X_GS_STATS=1       # rung 0's back-pressure waits (A4)
export PS2X_VU_STATS=1       # the game's own frame rate, [vu1-stats] syncv/s (Sprint 17 F0)

ARGS=(--existing-b --hold 30 --until-kill --map frostfire --route "$ROUTE" --rounds "$ROUNDS" --mover "$MOVER"
      --auto-swap --fight-seconds 150 --kill-timeout 470 --out "$OUT" --seconds "$SECONDS_RUN")

case "$MODE" in
  dry)
    exec "${PY[@]}" --dry-run "${ARGS[@]}"
    ;;
  launch)
    mkdir -p logs/parity "$(dirname "$OUT")"
    "${PY[@]}" --dry-run "${ARGS[@]}" || exit $?
    rm -f "logs/${NAME}.done"
    LIVE_FLAG=()
    [ "$PINNED" = 1 ] || LIVE_FLAG=(--live)
    exec bash "$RUN_DETACHED_SH" --purpose launch-ladder --log "logs/parity/detached_${NAME}.txt" \
         "$0" "logs/${NAME}.detached" --child "${LIVE_FLAG[@]}" "$OUT"
    ;;
  child)
    mkdir -p "$OUT"
    # Issue #38: the PS2X_* this launch is handed (env.sh's instruments and this script's own), beside its output,
    # the moment before it starts; the driver adds only per-instance plumbing (screenshot path, card dir) on top.
    write_env_ps2x "$OUT" "ladder_frostfire.sh --child rounds=$ROUNDS mover=$MOVER harness=${HARNESS:-live}"
    "${PY[@]}" "${ARGS[@]}" > "logs/parity/drive_${NAME}.txt" 2>&1
    rc=$?
    if [ "$PINNED" = 1 ]; then
      ident="harness=$(cat "$HARNESS/HARNESS_COMMIT" 2>/dev/null) $(cat "$HARNESS/EXE_BUILD" 2>/dev/null)"
    else
      ident="harness=$(git rev-parse HEAD 2>/dev/null)-live"
    fi
    echo "mpexit=$rc $ident" >> "logs/parity/drive_${NAME}.txt"
    echo "done $rc mpexit=$rc $(outcome "$rc" "logs/parity/drive_${NAME}.txt") $ident" > "logs/${NAME}.done"
    exit $rc
    ;;
esac
