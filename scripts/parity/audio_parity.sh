#!/usr/bin/env bash
# The audio parity check (Sprint 9 Q0, owner 2026-09-20: "an audio parity test with PCSX2 like our visual parity
# test"). One target, one capture, one score file; then `compare` against the pinned console reference.
#
#   scripts/parity/audio_parity.sh capture <pcsx2|ours> <stamp> [script.txt] [drive_s] [record_s]   # under the lock
#   scripts/parity/audio_parity.sh compare <stamp> [ref.json]                  # lock-free: PASS/FAIL per step window
#
# The capture records what Windows sends to the DEFAULT output endpoint (WASAPI loopback) while drive.py plays the
# step script on the target -- so it measures the whole path to the speaker, which is what the owner hears and what
# the visual gate's audio dump never could. Reference: scripts/parity/refs/audio_<script>.pcsx2.json, pinned from a
# PCSX2 capture of the same script. Windows routes PCSX2 per app (docs/HAZARDS.md audio): instance A's override silences
# it at every endpoint, so for a pcsx2 capture this script removes that override for the run and restores it after.
#
# W7 (fix wave A, 2026-09-22): `drive_s` (the game's own run length, drive.py --seconds) and `record_s` (the
# loopback recording) are arguments, defaulting to the 600 / 620 the launch_to_mission_xl reference was pinned
# with -- a script that holds in the mission for ten minutes needs both longer, and every earlier invocation
# (three arguments or fewer) behaves exactly as before. AUDIO_DUMP=<path> in the environment is exported to the
# launched game as PS2X_AUDIO_DUMP, so a capture can have the mixer's own pre-device WAV beside the endpoint
# recording (scripts/parity/mission_music_long.sh is the caller that sets it; unset, nothing is written).
# The window offset is on the recorder's first-packet clock (loopback.log's first_packet_epoch, the WAV's frame 0),
# not .capture_started, the recorder's launch a Python start earlier: that cost 0.82 s on s16_v0_t1b (LATER row 37).
set -u
# Two roots (audio-out fix round 1, I3). The game, its data and the capture directories live in the DATA root
# (game/, dist/, logs/): the main tree, or SOCOM_DATA_ROOT -- an agent's worktree never holds game/ (the agent-worktree skill). The
# audio tools come from beside this script (TOOLS_ROOT), so a capture run from a worktree exercises the worktree's
# recorder, monitor and scorers: `python -P` keeps the cwd off sys.path and PYTHONPATH names the tools' tree. The
# drive and run.sh stay the data root's: they find the game by their own tree.
TOOLS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT="${SOCOM_DATA_ROOT:-$TOOLS_ROOT}"
. "$TOOLS_ROOT/scripts/python_env.sh"    # $PYTHON, resolved once for every script
. "$TOOLS_ROOT/scripts/parity/write_env.sh"   # write_env_ps2x: the PS2X_* record beside a capture (issue #38)
socom_require_python audio_parity
# The audio tools, from the tools root, with the cwd kept off sys.path. A function, not a PYA variable used
# unquoted at four call sites: a tools root with a space in it word-split into "env PYTHONPATH=/c/a" and "dir/..."
# and the capture ran the wrong package (fix round 2, R7).
pya() { PYTHONPATH="$TOOLS_ROOT" "$PYTHON" -P "$@"; }
# The scorer's meta for a capture: the target and the script, as TWO arguments. A missing space here glued them
# into `--target ours--script` and every capture this script took recorded `target: "ours--script"` with no script
# key at all, so `compare` fell back to the launch_to_mission_xl reference whatever had been run (R2).
score_meta_args() { META_ARGS=(--target "$1" --script "$(basename "$2")"); }
# The loopback recorder's own pid, from its log (loopback_record.py prints `pid=`); empty when the log has none.
recorder_pid() { grep -m1 -o 'pid=[0-9]*' "$1" 2>/dev/null | cut -d= -f2; }
# The endpoint verdict for a capture: which sessions outside the game rendered while it ran. The recorder's own
# loopback session reads the endpoint's WHOLE mix as its peak, so it is left out by pid -- and when its log
# carries no pid the verdict says so rather than quietly re-acquiring that false positive: the owner is told to
# discard any capture whose verdict is not `clean`, so an unearned word costs a capture either way (R5).
write_sessions_verdict() {   # <capture dir> <the exe that may render>
  local out=$1 exe=$2 pid
  pid=$(recorder_pid "$out/loopback.log")
  : > "$out/sessions_verdict.txt"
  if [ -z "$pid" ]; then
    echo "# no recorder pid in loopback.log -- the loopback recorder's own session is IN this verdict, and its" >> "$out/sessions_verdict.txt"
    echo "# capture stream reads the endpoint's whole mix: an interpreter process here may be this script, not a contaminant." >> "$out/sessions_verdict.txt"
    pya -m tools_py.parity.app_volume contamination "$out/sessions.csv" --allowed "$exe" >> "$out/sessions_verdict.txt" 2>&1 || true
  else
    pya -m tools_py.parity.app_volume contamination "$out/sessions.csv" --allowed "$exe" --ignore-pid "$pid" >> "$out/sessions_verdict.txt" 2>&1 || true
    echo "# the loopback recorder (pid $pid) was left out: its capture stream reads the endpoint's whole mix" >> "$out/sessions_verdict.txt"
  fi
}
# Sourced by tools_py/tests/test_audio_capture_script.py to exercise those four seams without a capture.
if [ "${AUDIO_PARITY_SOURCE_ONLY:-0}" = 1 ]; then return 0; fi
cd "$ROOT"
cmd=${1:-}; shift || true
case "$cmd" in
  capture)
    target=$1; stamp=$2; script=${3:-scripts/parity/launch_to_mission_xl.txt}
    drive_s=${4:-600}; rec_s=${5:-$((drive_s + 20))}
    OUT="logs/parity/$stamp"; mkdir -p "$OUT"
    # The mixer's own dump (W7): only when the caller asked for one, and only for our runtime -- PCSX2 has no
    # such knob, so a pcsx2 capture is the endpoint recording alone whatever AUDIO_DUMP says.
    if [ -n "${AUDIO_DUMP:-}" ] && [ "$target" != pcsx2 ]; then
      export PS2X_AUDIO_DUMP="$AUDIO_DUMP"
      # PS2X_AUDIO_DUMP is a Dev knob (R238 considered making it Shipping and did NOT -- the Shipping class
      # is exactly what the launcher can send, and this has no config.json key). A Dev knob is honoured in any
      # build, including a released one, but only in developer mode -- so without this the dump is silently
      # ignored and the capture is an endpoint recording with nothing to align it to.
      export PS2X_DEV=1
      echo "PS2X_AUDIO_DUMP=$PS2X_AUDIO_DUMP PS2X_DEV=1" > "$OUT/audio_dump.txt"
    fi
    if [ "$target" != pcsx2 ]; then
      # Sprint 11 audio-out: every host audio callback's wall clock, beside the endpoint recording and the dump, so a
      # DEVICE dip can be laid against the callback that was late (tools_py/parity/cb_trace.py). A Dev knob, like
      # the dump; the path is handed over in the native spelling for the same reason the dump's is.
      cb="$ROOT/$OUT/cb_trace.csv"
      if command -v cygpath >/dev/null 2>&1; then cb="$(cygpath -w "$cb")"; fi
      export PS2X_AUDIO_CB_TRACE="$cb"
      export PS2X_DEV=1
    fi
    # (The environment record, env_ps2x.txt, is written just before the drive launches -- below -- so it is what
    # the game ran under and not what this script had assembled so far.)
    restore=""
    if [ "$target" = pcsx2 ]; then
      restore="$OUT/pcsx2_override_backup.txt"
      powershell -NoProfile -Command "\$b='HKCU:\Software\Microsoft\Internet Explorer\LowRegistry\Audio\PolicyConfig\PropertyStore'; Get-ChildItem \$b | ForEach-Object { \$v=(Get-ItemProperty \$_.PSPath).'(default)'; if (\$v -like '*pcsx2-qt*' -and \$v -notlike '*pcsx2_b*') { Add-Content -Path '$restore' -Value (\$_.PSChildName + '|' + \$v) -Encoding utf8; Remove-Item -Path \$_.PSPath -Recurse -Force } }" >/dev/null 2>&1
      PYTHONPATH="$ROOT" "$PYTHON" logs/pcsx2_resize_loop.py 90 > "$OUT/resize.log" 2>&1 &
    fi
    date +%s.%N > "$OUT/.capture_started"
    # 620 s, not 480: the drive runs 600 s and PCSX2 reaches the mission HUD at ~350 s, so a 480 s recording ended
    # 130 s into the console's mission and every later reference window scored digital silence (run 8, 2026-09-20).
    # `record_s` keeps that margin by default (drive_s + 20).
    pya -m tools_py.parity.loopback_record "$OUT/endpoint.wav" "$rec_s" > "$OUT/loopback.log" 2>&1 &
    REC=$!
    # What ELSE renders to the endpoint, sampled every 5 s for the recording's length (state and peak meter per
    # session): a session LIST proves nothing -- pycaw returns idle and expired sessions too -- but a timeline of
    # sessions actually rendering does. The 2026-09-23 audio-out capture scored 562 "DEVICE" events with a browser
    # playing music into the same endpoint; sessions_verdict.txt is what says so (audio-out fix round 1, I5).
    pya -m tools_py.parity.app_volume monitor "$OUT/sessions.csv" --seconds "$rec_s" --interval 5 > "$OUT/sessions_monitor.log" 2>&1 &
    MON=$!
    sleep 1
    # The per-app session volume Windows remembers for the exe on this endpoint sits BEFORE the loopback tap: hold
    # the launched game at 1.0 / unmuted while it runs and log what it was (music round four, 2026-09-20).
    exe=socom2.exe; [ "$target" = pcsx2 ] && exe=pcsx2-qt.exe
    pya -m tools_py.parity.app_volume hold "$exe" --seconds "$drive_s" > "$OUT/app_volume.log" 2>&1 &
    VOL=$!
    # docs/HAZARDS.md harness / issue #38: what the game ran under, written the moment before it launches -- every PS2X_* exported
    # here, the gate's env pin over them, the executable and its digest (the "off" half of an A/B needs the binary's
    # identity, not only the knobs). The shared writer (write_env.sh); run.sh adds PS2X_DEV=1 itself when unset.
    write_env_ps2x "$OUT" "audio_parity.sh capture $target $(basename "$script"); run.sh exports PS2X_DEV=1 when it is unset"
    date +%s.%N > "$OUT/.drive_started"
    # --seconds is OUR game's run length (drive.py defaults to 400): launch_to_mission_xl runs past 400 s, and a game
    # killed at 400 s leaves the last eleven windows as digital silence that reads as a FAIL of the mix (s9_q1_parity_ours).
    "$PYTHON" -m tools_py.parity.drive --target "$target" --script "$script" --out "$OUT" --tail 10 --seconds "$drive_s" > "$OUT/drive.stdout" 2>&1
    rc=$?
    kill $VOL 2>/dev/null
    wait $REC
    if [ -n "$restore" ] && [ -s "$restore" ]; then
      powershell -NoProfile -Command "\$b='HKCU:\Software\Microsoft\Internet Explorer\LowRegistry\Audio\PolicyConfig\PropertyStore'; Get-Content '$restore' | ForEach-Object { \$i=\$_.IndexOf('|'); \$k=\$_.Substring(0,\$i); \$v=\$_.Substring(\$i+1); \$p=Join-Path \$b \$k; if (-not (Test-Path \$p)) { New-Item -Path \$p -Force | Out-Null }; Set-ItemProperty -Path \$p -Name '(default)' -Value \$v }" >/dev/null 2>&1
    fi
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kill_stale_drivers.ps1 >/dev/null 2>&1
    powershell -NoProfile -Command 'Get-Process pcsx2-qt -ErrorAction SilentlyContinue | Stop-Process -Force' >/dev/null 2>&1
    read -r offset offset_from < <(pya -m tools_py.parity.capture_offset "$OUT" | sed 's/offset=//; s/from=//')
    rate=$("$PYTHON" -c "import wave; print(wave.open('$OUT/endpoint.wav').getframerate())")
    wait $MON 2>/dev/null
    # The endpoint's other sessions, with the recorder left out by pid -- or a line saying it was not (R5).
    write_sessions_verdict "$OUT" "$exe"
    echo "target=$target script=$script drive_rc=$rc offset=${offset}s offset_from=$offset_from rate=$rate drive_s=$drive_s record_s=$rec_s dump=${PS2X_AUDIO_DUMP:-none} exe=${SOCOM_EXE:-dist/socom2.exe} tools=$TOOLS_ROOT" > "$OUT/capture.txt"
    cat "$OUT/sessions_verdict.txt"
    score_meta_args "$target" "$script"
    pya -m tools_py.parity.audio_parity score "$OUT/endpoint.wav" "$rate" "$OUT/drive.stdout" "$offset" "$OUT/audio_scores.json" "${META_ARGS[@]}" > "$OUT/scores.txt" 2>&1
    echo "scored -> $OUT/audio_scores.json ($(grep -c ':' "$OUT/scores.txt") windows)"; cat "$OUT/capture.txt"
    exit $rc ;;
  compare)
    stamp=$1; ref=${2:-}
    OUT="logs/parity/$stamp"
    if [ -z "$ref" ]; then
      script=$("$PYTHON" -c "import json; print(json.load(open('$OUT/audio_scores.json'))['meta'].get('script','launch_to_mission_xl.txt'))")
      ref="scripts/parity/refs/audio_${script%.txt}.pcsx2.json"
    fi
    pya -m tools_py.parity.audio_parity compare "$ref" "$OUT/audio_scores.json" | tee "$OUT/audio_parity.txt"
    exit ${PIPESTATUS[0]} ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
