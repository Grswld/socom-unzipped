#!/usr/bin/env bash
# W7 (fix wave A, 2026-09-22): the mission-music instrument. The owner, on tonight's playthrough: "one song
# playing with stutters or skips ... it is not playing linearly ... fine the first while, gets much worse as I
# proceed", and: "You may have to write tests that skip the cutscenes and move faster to catch these issues."
#
# So: reach gameplay by the fast path (scripts/parity/mission_music_fast.txt -- the cinematics skipped, the
# flyover pressed through until the HUD band matches), then HOLD IN THE MISSION for as long as the run asks,
# with the audio captured twice over -- the mixer's own pre-device WAV (PS2X_AUDIO_DUMP) and the WASAPI
# loopback of what Windows actually sends the speaker -- and score the capture minute by minute so the
# degradation the owner describes is a column of numbers rather than an impression.
#
#   scripts/parity/mission_music_long.sh [--minutes N] [--stage mission|briefing|lobby] [--walk] [--target ours|pcsx2]
#                                        [--stamp S] [--max-device-per-minute N] [--no-score] [--dry-run]
#
# --dry-run generates the drive script and prints the lengths, launching nothing: it is how the script itself is
# checked without the loop lock (and how tools_py/tests/test_mission_music_fast.py checks the generated hold).
#
# --walk (fix wave A follow-up, 2026-09-22): the mission hold MOVES. The two-minute proof run showed that a driven
# hold at the insertion point captures almost no music (2-4 s voice cues, the mix at -51 dBFS), while the owner's
# report is the music degrading "as I proceed". So instead of `wait+8.0:NONE` the hold is a repeated short leg --
# `hold+8.0:W` (walk forward 8 s), `wait+2.0:NONE`, `hold+8.0:S` (walk back 8 s), `wait+2.0:NONE` -- the pattern
# gameplay_damage.txt already uses, which returns to the insertion point every 20 s. Walking blind into the level
# meets hostiles, and a death ends the capture and the music with it, so the leg is deliberately SHORT and safe
# rather than the owner's route (which nobody has recorded); the same run serves W6 (the garbled HELP popup) if a
# popup arrives, since every `ifpopup` guard saves the frame it looks at before pressing. Mission stage only.
#
# --stage lobby (Sprint 17 A1, issue #94, 2026-09-29): the ONLINE screens' music, which the owner heard wrong on the
# batch-3 build and described on batch 2 as a "sustained hang or up-pitch every few seconds". The path to SOCOM
# Online's lobby is not a drive.py step script: it is tools_py/parity/online_login_ours.py -- boot_to_online (the
# main menu, ONLINE) and its @staged("login") stage (LOGIN, universe, the saved persona, the prefilled password
# keyboard, CONNECT, the prompts, the EULA, SERVER NEWS closed; `LOBBY class=ok`) -- run with --prefilled
# --existing as the controller's q2 logoff run calls it, against the server scripts/parity/env.sh names (our hosted
# box by default). So the stage writes a shell DRIVER, logs/parity/<stamp>/drive_lobby.sh, which runs that login
# with --hold <minutes*60> and nothing after it (no briefing room, no game), and audio_parity.sh runs a `.sh`
# script in drive.py's place under the same recorder, volume hold, dump and scorers. Unlike the mission stage, the
# lobby capture also carries scripts/parity/env.sh's instruments (PS2X_PC_SAMPLER, the call trace, PS2X_PEEK, the
# input trace) and its server: this wrapper sources env.sh before the issue #38 record, so env_ps2x.txt names what
# the lobby game ran under. The game's own log is pinned beside the capture (PS2X_RUN_LOG=.../run.log) for audio_dips. --target pcsx2 is refused ("not yet"): the console's
# login (tools_py/parity/online_login.py) starts from a savestate against a local Horizon stack with the DNS stub on
# a LAN address, which this script does not drive. --walk is the mission's only.
#
# --max-device-per-minute N: the pin. After the dips scorer runs, its "DEVICE total .. max K in a minute" line is
# read and the run exits 4 when K > N. Unset = report only; the ceiling is pinned once the endpoint A/B has said
# what a clean device looks like (docs/archive/sprints-7-12/2026-09-22-fix-wave-handoff.md).
#
# Exit codes: 0 captured (and pinned, if asked); 2 a refused argument (--target, --stage, --walk off the mission, the
# lobby on pcsx2); 3 the briefing stage found no DEPLOY step; 4 the DEVICE pin failed or could not be judged;
# 5 the lobby stage's login failed (online_login_ours.py's LOBBY_FAIL_EXIT, its own 4, renumbered here so it is not
# read as the pin); anything else is the capture's own rc. MISSION_MUSIC_CAPTURE_SH replaces audio_parity.sh for the
# tests only: the real capture kills every harness driver and game on the host (kill_stale_drivers.ps1).
#
# Run it under the loop lock (it launches a game):
#   scripts/loop_lock.sh run <owner> --purpose "W7 mission music" -- scripts/parity/mission_music_long.sh --minutes 12
#
# --minutes is the IN-MISSION hold (default 12: the owner's "fine the first while, gets much worse as I
# proceed" needs the capture to contain both halves, and W7's bar is at least ten minutes of mission). The hold
# is built by copying mission_music_fast.txt and appending `wait+8.0:NONE` lines to it, so the generated script
# is committed nowhere and is written beside the capture it produced (logs/parity/<stamp>/drive_script.txt) --
# the schedule is an argument, the path is the file.
#
# The capture itself is scripts/parity/audio_parity.sh's, unchanged apart from its new length arguments: the
# loopback recorder, the per-app volume hold (Windows remembers a per-exe session volume that sits BEFORE the
# loopback tap) and drive.py, sequenced as the audio parity runs already sequence them. AUDIO_DUMP is passed
# through to the launched game as PS2X_AUDIO_DUMP, with PS2X_DEV=1 beside it: that knob is Dev-class (R238
# weighed reclassing it Shipping and did not), and a Dev knob needs developer mode to be honoured at all.
#
# Scoring (W7 reuses, it does not invent):
#   * tools_py/parity/audio_envelope.py --segment 60 is the primary read. It is REFERENCE-FREE and its four
#     measurements are the owner's four words: envelope (the loudness curve), oscillation_score ("louder and
#     quieter"), splices ("jumping between tracks" / "not playing linearly") and silences (a stream underrun
#     heard as a skip). One line per minute plus a totals line means "fine at first, much worse later" is read
#     straight off the per-segment column -- which is the thing W7 has to show and which no ours-vs-console
#     score can show, because both machines are scored within one capture over time here.
#   * tools_py/parity/audio_dips.py is the follow-up when the envelope finds dips: it aligns the endpoint
#     recording to the mixer's dump and classifies each dip DEVICE / STARVATION / COMMAND / UNEXPLAINED
#     against the game log, which is what says whether a skip was lost after render() or starved before it.
#   * tools_py/parity/audio_parity.py is deliberately NOT the scorer here: it scores step-aligned windows
#     against a PCSX2 reference pinned per script (scripts/parity/refs/audio_<script>.pcsx2.json), and no such
#     reference exists for this script -- pinning one costs a console run of the same length, and it would
#     still compare ours to the console rather than the capture's start to its end. `audio_parity.sh capture`
#     writes its audio_scores.json anyway as a by-product; it is evidence, not the verdict.
set -u
# Two roots, as scripts/parity/audio_parity.sh (audio-out fix round 1, I3): the DATA root holds the game, the
# capture directories and the run logs (SOCOM_DATA_ROOT, or the tree this script is in); the audio tools and the
# capture script come from beside this script, so a worktree run exercises the worktree's tools.
TOOLS_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="${SOCOM_DATA_ROOT:-$TOOLS_ROOT}"
. "$TOOLS_ROOT/scripts/python_env.sh"    # $PYTHON, resolved once for every script
. "$TOOLS_ROOT/scripts/parity/write_env.sh"   # write_env_ps2x: the PS2X_* record beside a capture (issue #38)
socom_require_python mission_music_long
cd "$ROOT"
# A function, not a variable used unquoted: a tools root with a space in it word-split (fix round 2, R7).
pya() { PYTHONPATH="$TOOLS_ROOT" "$PYTHON" -P "$@"; }

MINUTES=12
# Which music to capture. `mission` holds at the insertion point, which is what this script was written for.
# `briefing` stops one press EARLIER, on the mission briefing, and holds there -- added 2026-09-22 after the
# two-minute proof run showed why it is needed: standing still in the mission, the only streams that play are
# two-to-four-second voice cues and the mix sits at -51 dBFS, so a twelve-minute in-mission hold captures
# almost no music at all. The briefing's score plays continuously at about -32 dBFS, and it is where the owner
# reported the FIRST half of the fault ("menu music seemed good up until the point i was in the mission
# briefing, i noticed the first few small stutters"). The mission half of their report -- the music degrading
# the longer they played -- needs the drive to MOVE through the mission, which is a route, not a hold; see the
# plan's W7 follow-up.
STAGE=mission
TARGET=ours
STAMP=""
SCORE=1
DRY=0
WALK=0
MAX_DEVICE=""
BASE=scripts/parity/mission_music_fast.txt
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) MINUTES=$2; shift 2 ;;
    --stage) STAGE=$2; shift 2 ;;
    --walk) WALK=1; shift ;;
    --target) TARGET=$2; shift 2 ;;
    --stamp) STAMP=$2; shift 2 ;;
    --script) BASE=$2; shift 2 ;;
    --max-device-per-minute) MAX_DEVICE=$2; shift 2 ;;
    --no-score) SCORE=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,81p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; sed -n '2,81p' "$0"; exit 2 ;;
  esac
done
case "$TARGET" in ours|pcsx2) ;; *) echo "--target must be ours or pcsx2" >&2; exit 2 ;; esac
case "$STAGE" in
  mission|briefing|lobby) ;;
  *) echo "mission_music_long: --stage must be mission, briefing or lobby, not '$STAGE'" >&2; exit 2 ;;
esac
if [ "$WALK" = 1 ] && [ "$STAGE" != mission ]; then
  echo "mission_music_long: --walk moves through the MISSION; it has no meaning on the '$STAGE' stage" >&2
  exit 2
fi
if [ "$STAGE" = lobby ] && [ "$TARGET" = pcsx2 ]; then
  echo "mission_music_long: --stage lobby --target pcsx2 is not yet driven: the console's login" >&2
  echo "  (tools_py/parity/online_login.py) starts from PCSX2 savestate 9 against a local Horizon stack with the DNS" >&2
  echo "  stub on a LAN address (scripts/parity/env.sh socom_require_ipv4), and this script runs neither. Record ours" >&2
  echo "  with --target ours; the console's lobby is a separate run." >&2
  exit 2
fi
[ -f "$BASE" ] || { echo "no such script: $BASE" >&2; exit 2; }
[ -n "$STAMP" ] || STAMP="mission_music_${TARGET}_$(date +%Y%m%d_%H%M%S)"
OUT="logs/parity/$STAMP"
mkdir -p "$OUT"

HOLD_S=$((MINUTES * 60))
# The base script already ends with one `wait+8.0:NONE`; the rest of the hold is appended here. Eight seconds is
# the hold step every mission script in this directory uses, and a `wait` step is a plain sleep in drive.py (no
# settle poll, one capture at its end), so 8 s of hold costs one PNG rather than eight.
EXTRA=$(( (HOLD_S - 8 + 7) / 8 ))
[ "$EXTRA" -lt 0 ] && EXTRA=0
# An `ifpopup+1.0:CROSS` every POPUP_EVERY hold steps, for the reason music_only_mission.txt interleaves them: an
# in-game HELP pop-up PAUSES the game behind a lit HUD (needs_cross, s5_head_1x / s6_depth_m2). One that arrives at
# minute two and is never answered makes the remaining ten minutes a capture of a paused game -- which would read as
# exactly the degradation W7 is looking for and be an artefact of the harness. An ifpopup over live gameplay costs
# ~2.5 s (wait_stable's 2 s cap, then no press) and takes nothing away from the capture.
POPUP_EVERY=8
SCRIPT="$OUT/drive_script.txt"
case "$STAGE" in
  mission)
    cp "$BASE" "$SCRIPT"
    ;;
  briefing)
    # Everything up to but NOT including the deploy press, so the hold lands on the briefing screen with its
    # score playing. The marker is the deploy line itself, which mission_music_fast.txt keeps on one line.
    awk '/^wait\+2\.0:CROSS[[:space:]]*# deploy/ { exit } { print }' "$BASE" > "$SCRIPT"
    if ! grep -q 'DEPLOY' "$SCRIPT"; then
      echo "mission_music_long: the briefing stage found no DEPLOY step in $BASE -- refusing rather than" >&2
      echo "  capturing some other screen for $MINUTES minutes." >&2
      exit 3
    fi
    echo "# --- briefing stage: the deploy press and everything after it is cut; the hold is on the briefing ---" >> "$SCRIPT"
    ;;
  lobby)
    # The driver is written below, once the run length it hands the login is known; no step script is appended.
    SCRIPT="$OUT/drive_lobby.sh"
    ;;
esac
POPUPS=0
# The walk: one leg is `hold+8.0:<dir>` then `wait+2.0:NONE` (10 s of script), the direction alternating W / S so
# the player is back at the insertion point after every pair. LEGS covers the whole hold; the base script's own
# closing `wait+8.0:NONE` is left in place as the settle before the first leg.
LEGS=$(( (HOLD_S + 9) / 10 ))
[ "$STAGE" = lobby ] && { EXTRA=0; LEGS=0; }
[ "$STAGE" = lobby ] || {
  if [ "$WALK" = 1 ]; then
    echo "# --- $LEGS walking legs appended by mission_music_long.sh --walk for a ${MINUTES}-minute in-mission capture:"
    echo "# --- hold W 8 s / settle 2 s / hold S 8 s / settle 2 s, an ifpopup guard every $POPUP_EVERY legs ---"
    i=0
    while [ "$i" -lt "$LEGS" ]; do
      if [ $((i % 2)) -eq 0 ]; then echo "hold+8.0:W          # walk forward 8 s"; else echo "hold+8.0:S          # walk back 8 s"; fi
      echo "wait+2.0:NONE"
      i=$((i + 1))
      if [ $((i % POPUP_EVERY)) -eq 0 ] && [ "$i" -lt "$LEGS" ]; then
        echo "ifpopup+1.0:CROSS"
        POPUPS=$((POPUPS + 1))
      fi
    done
  else
    echo "# --- $EXTRA hold steps appended by mission_music_long.sh for a ${MINUTES}-minute in-mission capture,"
    echo "# --- with an ifpopup guard every $POPUP_EVERY of them ---"
    i=0
    while [ "$i" -lt "$EXTRA" ]; do
      echo "wait+8.0:NONE"
      i=$((i + 1))
      if [ $((i % POPUP_EVERY)) -eq 0 ] && [ "$i" -lt "$EXTRA" ]; then
        echo "ifpopup+1.0:CROSS"
        POPUPS=$((POPUPS + 1))
      fi
    done
  fi
} >> "$SCRIPT"

# The boot allowance is what the run may spend BEFORE the hold. Measured on our exe (logs/parity/s9_q1_parity_ours,
# launch_to_mission_xl): the DEPLOY press lands at t=87 s and the mission is up by ~137 s; the fast path's untilref
# then presses through the flyover. 240 s leaves that better than a 70% margin. PCSX2 reaches the mission HUD at
# ~350 s on the same script (audio_parity.sh's own note), so the console needs 480.
BOOT_S=240
[ "$TARGET" = pcsx2 ] && BOOT_S=480
# drive.py's --seconds is the game's own run length (run.sh's timeout): the boot, the hold, the --tail 10 the
# capture passes, and 50 s of slack. A game killed mid-hold leaves the rest of the capture as digital silence,
# which reads as a catastrophic FAIL of the mix rather than as a short run (s9_q1_parity_ours).
DRIVE_S=$((BOOT_S + HOLD_S + POPUPS * 3 + 60))
# A hold step costs its 0.5 s post-press sleep and a capture on top of the hold itself; a walk has two steps a leg.
[ "$WALK" = 1 ] && DRIVE_S=$((DRIVE_S + LEGS * 2))
# The lobby hold is online_login_ours.py's own: a 5 s sleep and a capture, HOLD_S/5 times, each capture allowed 1 s.
# The login to the lobby measured 172 s (logs/parity/s17_q2_logoff online1, `LOBBY class=ok`), inside BOOT_S.
[ "$STAGE" = lobby ] && DRIVE_S=$((BOOT_S + HOLD_S + HOLD_S / 5 + 60))
REC_S=$((DRIVE_S + 20))
DUMP="$OUT/mix.wav"
# PS2X_AUDIO_DUMP is read by a NATIVE Windows binary through python and run.sh, and an MSYS "/c/..." path
# does not survive that as an environment variable the way a command-line argument does (the MSYS path
# conversion applies to arguments, MEMORY "MSYS converts /c/ args"). Hand it the native spelling where
# there is one; on Linux cygpath does not exist and the POSIX path is already right.
DUMP_ENV="$ROOT/$DUMP"
if command -v cygpath >/dev/null 2>&1; then DUMP_ENV="$(cygpath -w "$ROOT/$DUMP")"; fi
if [ "$STAGE" = lobby ]; then
  # The lobby driver. audio_parity.sh runs it from the data root in drive.py's place, with PS2X_AUDIO_DUMP, PS2X_DEV
  # and the callback trace already exported; env.sh adds the server and the harness's instruments. The name and the
  # password are the q2 logoff run's (the persona already on instance A's card, hence --existing).
  {
    echo "#!/usr/bin/env bash"
    echo "# Generated by mission_music_long.sh --stage lobby (stamp $STAMP) for a ${MINUTES}-minute hold in SOCOM Online's lobby."
    echo "# The login steps, online_login_ours.py's: boot_to_online (main menu, ONLINE) -> login (@staged \"login\": LOGIN,"
    echo "# universe, persona (saved, --existing), password (prefilled keyboard, ENTER), CONNECT, prompts, EULA, SERVER NEWS"
    echo "# closed; LOBBY class=ok) -> the hold, ${HOLD_S} s in the lobby, one capture every 5 s. Nothing after it."
    echo "set -u"
    echo ". \"$TOOLS_ROOT/scripts/parity/env.sh\""
    echo "export PS2X_RUN_LOG=\"$ROOT/$OUT/run.log\""
    echo "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kill_stale_drivers.ps1 >/dev/null 2>&1"
    echo "\"\$PYTHON\" -m tools_py.parity.online_login_ours --name socomc --password socom --prefilled --existing --instance A --out $OUT/login --seconds $DRIVE_S --hold $HOLD_S"
  } > "$SCRIPT"
  # The same environment in THIS shell, so the issue #38 record below -- and audio_parity.sh's, at the launch --
  # names what the lobby game runs under, not what the wrapper had before the driver sourced it.
  . "$TOOLS_ROOT/scripts/parity/env.sh"
  export PS2X_RUN_LOG="$ROOT/$OUT/run.log"
fi

echo "stamp=$STAMP target=$TARGET stage=$STAGE walk=$WALK minutes=$MINUTES hold=${HOLD_S}s steps=+$EXTRA legs=$LEGS popups=$POPUPS drive=${DRIVE_S}s record=${REC_S}s"
echo "script=$SCRIPT dump=$DUMP env=$DUMP_ENV"
# Issue #38: the PS2X_* this run was started with, beside the capture, before anything else can fail -- the W6 A/B
# (2026-09-23) had two captures of this script and no way to say which one carried PS2X_GS_NO_TEX_REVALIDATE=1. A
# dry run stops with this record; a launch has audio_parity.sh rewrite it at the launch, with the dump and trace
# knobs it adds, so the file always says what the game was handed.
write_env_ps2x "$OUT" "mission_music_long.sh stamp=$STAMP target=$TARGET stage=$STAGE walk=$WALK$([ "$DRY" = 1 ] && echo ' --dry-run: as started; nothing launched')"
if [ "$DRY" = 1 ]; then
  if [ "$STAGE" = lobby ]; then
    echo "--dry-run: nothing launched. the lobby driver $SCRIPT: login, then a ${HOLD_S} s hold, --seconds $DRIVE_S."
    exit 0
  fi
  echo "--dry-run: nothing launched. $(grep -c '^wait+8.0:NONE' "$SCRIPT") hold steps, $(grep -c '^hold+8.0:[WS]' "$SCRIPT") walking legs, $(grep -cv '^[[:space:]]*\(#.*\)\?$' "$SCRIPT") steps in all."
  exit 0
fi
CAPTURE_SH="${MISSION_MUSIC_CAPTURE_SH:-$TOOLS_ROOT/scripts/parity/audio_parity.sh}"
AUDIO_DUMP="$DUMP_ENV" SOCOM_DATA_ROOT="$ROOT" bash "$CAPTURE_SH" capture "$TARGET" "$STAMP" "$SCRIPT" "$DRIVE_S" "$REC_S"
rc=$?
echo "capture rc=$rc"
# The login's classified failure exits LOBBY_FAIL_EXIT (4), the DEVICE pin's code: the lobby's is 5 here.
if [ "$STAGE" = lobby ] && { [ "$rc" = 4 ] || grep -q "RESULT LOBBY-FAIL" "$OUT/drive.stdout" 2>/dev/null; }; then
  echo "lobby: the login did not reach the lobby (capture rc=$rc) -- rc=5"
  rc=5
fi

# The proof that the hold really was in the mission, not on a cinematic: the fast path's untilref line. In the lobby,
# the login's own verdict: `LOBBY class=ok`, or the classified `RESULT LOBBY-FAIL <class>`.
if [ "$STAGE" = lobby ]; then
  grep -E "LOBBY class=|RESULT LOBBY-FAIL" "$OUT/drive.stdout" 2>/dev/null || echo "(no LOBBY class line in $OUT/drive.stdout)"
else
  grep -E "^untilref\(|^ifpopup:" "$OUT/drive.stdout" 2>/dev/null || echo "(no untilref/ifpopup line in $OUT/drive.stdout)"
fi

if [ "$SCORE" = 1 ]; then
  for wav in "$OUT/mix.wav" "$OUT/endpoint.wav"; do
    [ -s "$wav" ] || { echo "no capture at $wav -- skipping its score"; continue; }
    name=$(basename "$wav" .wav)
    echo "=== audio_envelope --segment 60  $wav ==="
    pya -m tools_py.parity.audio_envelope "$wav" --segment 60 \
      > "$OUT/envelope_$name.txt" 2>&1 || true
    cat "$OUT/envelope_$name.txt"
  done
  if [ -s "$OUT/endpoint.wav" ] && [ -s "$OUT/mix.wav" ]; then
    echo "=== audio_dips  endpoint vs mix ==="
    # The game log pinned beside the capture (the lobby driver's PS2X_RUN_LOG), else the newest run log.
    log="$OUT/run.log"
    [ -s "$log" ] || log=$(ls -t logs/run_*.log 2>/dev/null | head -1)
    pya -m tools_py.parity.audio_dips "$OUT/endpoint.wav" --dump "$OUT/mix.wav" \
      ${log:+--log "$log"} > "$OUT/dips.txt" 2>&1 || true
    tail -40 "$OUT/dips.txt"
    # The endpoint this run rendered to, beside its dips: a DEVICE count that does not name its device proves
    # nothing (docs/HAZARDS.md audio, the endpoint hazard).
    grep -m1 "mix stream open" "$log" 2>/dev/null | tee "$OUT/endpoint_device.txt" || echo "(no mix-stream-open line in $log)" | tee "$OUT/endpoint_device.txt"
    if [ -n "$MAX_DEVICE" ]; then
      worst=$(sed -n 's/^DEVICE total [0-9]* over [0-9]* minutes, max \([0-9]*\) in a minute.*/\1/p' "$OUT/dips.txt")
      if [ -z "$worst" ]; then
        echo "DEVICE pin: the dips report carries no per-minute total -- cannot judge (rc=4)"; [ "$rc" = 0 ] && rc=4
      elif [ "$worst" -gt "$MAX_DEVICE" ]; then
        echo "DEVICE pin: FAIL -- $worst DEVICE events in one minute, the ceiling is $MAX_DEVICE (rc=4)"; [ "$rc" = 0 ] && rc=4
      else
        echo "DEVICE pin: OK -- at most $worst DEVICE events in a minute, ceiling $MAX_DEVICE"
      fi
    fi
  fi
fi
echo "capture and scores in $OUT"
exit $rc
