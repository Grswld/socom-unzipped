#!/usr/bin/env bash
# Launch a long job (a game run, a build, a gate) detached from the agent's tool call, holding the loop
# lock for exactly as long as the job's PID lives.
#
# Usage: scripts/run_detached.sh [--owner <o>] [--purpose <p>] [--log <path>] [--quiet]
#                                [--wait <minutes> | --wait-seconds <s>] [--class build|run] <script> <marker> [args...]
#
#   - refuses to start (exit 3, before touching the lock) when C: has less than RUN_MIN_FREE_GB
#     (default 4) GB free -- Sprint 5 R46/A5, the host was at ~9 GB. RUN_FREE_GB_CMD overrides the
#     free-space query (a shell command whose last stdout line is the free GB figure) for tests;
#   - refuses the same way (exit 3, "exit=3 REFUSED: only <n> GB memory free (< RUN_MIN_FREE_MEM_GB=<m>)" in
#     <marker>, before touching the lock) when free physical memory is below RUN_MIN_FREE_MEM_GB (default 3)
#     -- Sprint 14 G5. RUN_FREE_MEM_GB_OVERRIDE (a number) replaces the memory query for tests;
#   - refuses the same way (exit 3, "exit=3 REFUSED: the launcher is running (pid <pid>[, ...]): close the
#     launcher window ..." in <marker>, before touching the lock) when --purpose starts with "merged chain" or
#     "build" and socom_unzipped_launcher.exe is running -- Sprint 17: a build's copy of the launcher fails
#     "Device or resource busy" under it (three reds on 2026-09-30/10-01). RUN_LAUNCHER_CHECK_CMD (a command whose
#     output's numbers are the pids; `true` means none) replaces the process query for tests;
#   - takes the loop lock as <owner> (default "detached"); if it is BUSY, writes "exit=75 BUSY ..." to
#     <marker> and exits 75 without launching. With --wait (Sprint 13 H2) it QUEUES instead
#     (`loop_lock.sh wait`: a ticket, served in arrival order) for up to that long, in the foreground --
#     run it in the background of a tool call if the wait may be long -- and only a TIMEOUT writes
#     "exit=75 TIMEOUT ..." to <marker>. Until the lock is had, <marker> does not exist. The ticket's CLASS
#     (Sprint 14 W1's WIP cap) is the one `loop_lock.sh run` would give the job's command, `bash <script>
#     [args...]` -- asked of `loop_lock.sh _class`, so a <script> named build.sh is a build -- unless --class
#     says otherwise (Sprint 14 W2; until then a build queued through here was never capped). A build refused
#     by the cap writes "exit=4 QUEUE FULL ..." to <marker> and exits 4 without launching;
#   - a CHAIN is one run_detached of the chain script: its steps run under that one holding (their own
#     loop_lock.sh take/run are NESTED); a run_detached INSIDE a held lock is refused (exit 2);
#   - launches `bash <script> [args...]` under nohup, stdout+stderr to <log> (default <marker>.log), and
#     returns at once, printing "DETACHED pid=... marker=... log=...";
#   - renews the heartbeat every LOOP_LOCK_DETACHED_RENEW_SEC (300) while the JOB's PID lives -- the
#     renew loop watches the job, never the caller, whose shell dies when its tool call returns;
#   - QUIET MARKER (R46/A8: "no build.sh test, sims, unittest suites... while it exists"): while the
#     job runs, if --purpose (or the lock's default purpose) starts with "launch", or --quiet is given,
#     writes RUN_QUIET_MARKER (default: logs/.quiet of the MAIN tree, beside git's common dir, as the lock
#     itself -- audit H13, Sprint 13: a per-checkout marker let a worktree's launch run beside a main-tree
#     `build.sh test` and vice versa) as one line "<owner> <winpid> <start
#     epoch> <msys pid>" -- the pid field is the WINDOWS pid (via /proc/<msys pid>/winpid), because
#     check_quiet_gate.sh and any other host-side liveness probe (tasklist, Get-Process) work in
#     that domain, not MSYS's; removed on every exit path (normal, failure, or signalled) EXCEPT a
#     SIGKILL of this wrapper itself, which no trap can catch -- see "Known limitations" below;
#   - HOST CPU SAMPLER: while the job runs (unless RUN_CPU_SAMPLER=0), a background PowerShell loop
#     appends one row per second to "<marker>.cpu.csv": timestamp, total % Processor Time, and a
#     "name=pct" list for every running socom2* process (Get-Counter's per-instance suffixing). Killed
#     on exit alongside the job;
#   - when the job exits: releases the lock, stops the CPU sampler, removes the quiet marker, then
#     writes "exit=<code>" to <marker> (release first, so a poller that sees the marker finds the lock
#     free);
#   - on TERM/HUP/INT it kills the job's whole Windows process tree (`taskkill /T /F`), releases, and
#     writes "exit=143";
#   - if a renew finds the lock no longer ours, it writes a "LOCK LOST" line to <log> and to
#     <marker>.LOCK_LOST, stops renewing, and lets the job finish (the final marker line then reads
#     "exit=<code> LOCK_LOST"). The job is not killed.
#
# THE JOB SCRIPT MUST KEEP ITS WORK IN THE FOREGROUND. The lock lives exactly as long as the script's
# own PID: anything it backgrounds (`cmd &`, `nohup`, `Start-Process`) and does not wait for keeps
# running after the lock is released, unrenewed and unguarded (only the busy list stands between it and
# the next build).
#
# Poll the marker (`test -f <marker>`), never the caller. Inside the script, `loop_lock.sh take/release`
# (gate.py's own included) are NESTED no-ops: LOOP_LOCK_HELD is exported to the job.
# A pre-existing <marker> is deleted before launch. Environment: as loop_lock.sh (LOOP_LOCK_PATH, ...),
# plus RUN_MIN_FREE_GB, RUN_FREE_GB_CMD, RUN_MIN_FREE_MEM_GB, RUN_FREE_MEM_GB_OVERRIDE, RUN_LAUNCHER_CHECK_CMD, RUN_QUIET_MARKER,
# RUN_CPU_SAMPLER above.
#
# KNOWN LIMITATIONS
#   - A SIGKILL of the --_child wrapper itself (as opposed to TERM/HUP/INT, which the trap handles)
#     cannot be caught: the quiet marker and the CPU sampler process are both leaked -- the marker
#     goes stale (check_quiet_gate.sh's age check is what recovers a build from it after
#     QUIET_GATE_MAX_AGE_S) and the orphaned sampler keeps a powershell.exe running and appending to
#     "<marker>.cpu.csv" until killed by hand or the machine reboots. Not otherwise guarded against.
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# Always invoked as `bash "$LOCKSH"`: the tracked file mode is 100644, so a fresh clone on Linux
# (CI) cannot exec it -- "Permission denied", exit 75. gate.py calls it the same way.
LOCKSH="$HERE/loop_lock.sh"
RENEW_SEC="${LOOP_LOCK_DETACHED_RENEW_SEC:-300}"
# The machine-wide logs/ (the main tree's, found through git's common dir, as loop_lock.sh finds the lock).
_shared_logs() {
  local common; common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [ -n "$common" ] && [ -d "$common" ]; then echo "$(cd "$common/.." && pwd)/logs"; else echo "$ROOT/logs"; fi
}
QUIET_MARKER="${RUN_QUIET_MARKER:-$(_shared_logs)/.quiet}"

_free_gb() {
  if [ -n "${RUN_FREE_GB_CMD:-}" ]; then
    eval "$RUN_FREE_GB_CMD" | tail -n1
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "[math]::Round((Get-PSDrive -Name C).Free/1GB,2)" 2>/dev/null
  else
    # Linux (Sprint 8): the same number from df, whole gigabytes.
    df -BG --output=avail "$ROOT" 2>/dev/null | tail -n1 | tr -d 'G '
  fi
}

# Sprint 14 G5: free physical memory in GB. RUN_FREE_MEM_GB_OVERRIDE (a number) wins, for tests. Windows:
# Win32_OperatingSystem.FreePhysicalMemory (KB; the same figure as the "Available MBytes" counter). Linux:
# /proc/meminfo's MemAvailable (KB), else `free -g`'s available column.
_free_mem_gb() {
  if [ -n "${RUN_FREE_MEM_GB_OVERRIDE:-}" ]; then
    echo "$RUN_FREE_MEM_GB_OVERRIDE"
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,2)" 2>/dev/null
  elif [ -r /proc/meminfo ]; then
    awk '/^MemAvailable:/ { printf "%.2f\n", $2 / 1048576 }' /proc/meminfo
  else
    free -g 2>/dev/null | awk '/^Mem:/ { print $7 }'
  fi
}

# Sprint 17: the pids of a running socom_unzipped_launcher.exe, "<pid>[, <pid>...]" or nothing -- build.sh's
# launcher_pids, by image name (tasklist on Windows, pgrep -f on Linux). RUN_LAUNCHER_CHECK_CMD (a shell command whose
# output's numbers are the pids; `true` means none) replaces the query for tests.
_launcher_pids() {
  local out=""
  if [ -n "${RUN_LAUNCHER_CHECK_CMD:-}" ]; then
    out="$(eval "$RUN_LAUNCHER_CHECK_CMD" 2>/dev/null)"
  elif command -v tasklist >/dev/null 2>&1; then
    out="$(MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq socom_unzipped_launcher.exe" /FO CSV /NH 2>/dev/null | tr -d '\r' \
      | awk -F'","' 'tolower($1) == "\"socom_unzipped_launcher.exe" { print $2 }')"
  elif command -v pgrep >/dev/null 2>&1; then
    out="$(pgrep -f '^([^ ]*/)?socom_unzipped_launcher(\.exe)?( |$)' 2>/dev/null)"
  fi
  printf '%s\n' "$out" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) s = s (s == "" ? "" : ", ") $i } END { if (s != "") print s }'
}

# Cheap host CPU sampler: one row/second to $1 (timestamp,total%,name=pct;name=pct) until killed.
# Written as its own .ps1 file (not a -Command string) so it doesn't fight bash's quoting.
_start_cpu_sampler() {
  local csv="$1" ps1="$1.sampler.ps1"
  cat > "$ps1" <<'PS1EOF'
param([string]$Csv)
while ($true) {
  $ts = Get-Date -Format o
  $tot = ""
  try { $tot = [math]::Round((Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples[0].CookedValue, 1) } catch {}
  $procs = ""
  try {
    $pc = Get-Counter '\Process(socom2*)\% Processor Time' -ErrorAction Stop
    $procs = ($pc.CounterSamples | ForEach-Object { "{0}={1:N1}" -f $_.InstanceName, $_.CookedValue }) -join ';'
  } catch {}
  $ws = ""
  try {
    # Whole MB with no thousands separator: "N0" would write 1,450 and split the CSV row in two.
    $ws = (Get-Process socom2* -ErrorAction Stop | ForEach-Object { "{0}={1}" -f $_.ProcessName, [math]::Round($_.WorkingSet64/1MB) }) -join ';'
  } catch {}
  "$ts,$tot,$procs,$ws" | Out-File -FilePath $Csv -Append -Encoding ascii
  Start-Sleep -Seconds 1
}
PS1EOF
  if ! command -v powershell.exe >/dev/null 2>&1; then
    # Linux (Sprint 8): no host sampler yet -- the CSV stays absent and nothing is started.
    echo ""
    return 0
  fi
  powershell.exe -NoProfile -WindowStyle Hidden -File "$ps1" -Csv "$csv" </dev/null >/dev/null 2>&1 &
  echo $!
}

_stop_cpu_sampler() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  local winpid
  winpid=$(cat "/proc/$pid/winpid" 2>/dev/null)
  if [ -n "$winpid" ] && command -v taskkill >/dev/null 2>&1; then
    taskkill //T //F //PID "$winpid" >/dev/null 2>&1
  else
    kill "$pid" 2>/dev/null
  fi
}

if [ "$1" = "--_child" ]; then
  shift
  owner="$1" log="$2" marker="$3" script="$4"; shift 4
  bash "$script" "$@" >> "$log" 2>&1 </dev/null &
  job=$!

  cpu_pid=""
  if [ "${RUN_CPU_SAMPLER:-1}" != "0" ]; then
    cpu_pid=$(_start_cpu_sampler "$marker.cpu.csv")
  fi
  if [ "${_RUN_DETACHED_QUIET:-0}" = "1" ]; then
    # The marker's pid must be in the WINDOWS pid domain: check_quiet_gate.sh (and any real host
    # tool) probes it with `tasklist`, which knows nothing about MSYS pids ($job here) -- writing
    # $job silently disabled the whole gate (review round 1 Critical, 2026-09-13: bash pid 41367 /
    # winpid 34264, tasklist found nothing, exit 0 against a running launch). /proc/<pid>/winpid is
    # usually populated by the time the job has forked/exec'd; retry briefly for the rare race where
    # it isn't yet. The MSYS pid is kept as a fourth field (unused by check_quiet_gate.sh) since it
    # is what this script's own kill/on_signal path needs.
    job_winpid=""
    if command -v tasklist >/dev/null 2>&1; then   # the winpid file exists only under MSYS; on Linux $job is the pid
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        job_winpid=$(cat "/proc/$job/winpid" 2>/dev/null)
        [ -n "$job_winpid" ] && break
        sleep 0.2
      done
    fi
    mkdir -p "$(dirname "$QUIET_MARKER")"
    printf '%s %s %s %s\n' "$owner" "${job_winpid:-$job}" "$(date +%s)" "$job" > "$QUIET_MARKER"
  fi

  finish() {
    # Release only the lock this job took (a reaped-and-retaken lock of the same owner is not ours).
    bash "$LOCKSH" _release_id "$LOOP_LOCK_HELD" >> "$log" 2>&1
    case $? in
      0) echo "[run_detached] RELEASED" >> "$log";;
      3) echo "[run_detached] release failed: mutex busy; the lock stays held until reaped" >> "$log";;
      *) echo "[run_detached] not released: the lock no longer carries $LOOP_LOCK_HELD" >> "$log";;
    esac
    [ -n "$cpu_pid" ] && _stop_cpu_sampler "$cpu_pid"
    [ "${_RUN_DETACHED_QUIET:-0}" = "1" ] && rm -f "$QUIET_MARKER"
    rm -f "$marker.cpu.csv.sampler.ps1"
    printf 'exit=%s%s\n' "$1" "${lost:+ LOCK_LOST}" > "$marker.tmp" && mv -f "$marker.tmp" "$marker"
  }
  on_signal() {
    local winpid
    winpid=$(cat "/proc/$job/winpid" 2>/dev/null)
    if [ -n "$winpid" ] && command -v taskkill >/dev/null 2>&1; then
      taskkill //T //F //PID "$winpid" >> "$log" 2>&1
    fi
    kill "$job" 2>/dev/null; wait "$job" 2>/dev/null
    echo "[run_detached] signalled: killed the job tree (winpid ${winpid:-?})" >> "$log"
    finish 143; exit 143
  }
  trap on_signal TERM HUP INT
  last=$SECONDS lost=""
  while kill -0 "$job" 2>/dev/null; do
    sleep 1
    if [ -z "$lost" ] && [ $((SECONDS - last)) -ge "$RENEW_SEC" ]; then
      last=$SECONDS
      r=$(bash "$LOCKSH" renew "$owner" 2>&1)
      case "$r" in "not held"*)
        lost=1
        msg="[run_detached] LOCK LOST $(date -u +%Y-%m-%dT%H:%M:%SZ): $LOOP_LOCK_HELD is no longer the live lock (lock now: $(bash "$LOCKSH" check)); renewal stopped, the job keeps running UNGUARDED"
        echo "$msg" >> "$log"; echo "$msg" > "$marker.LOCK_LOST";;
      esac
    fi
  done
  wait "$job"; rc=$?
  finish "$rc"
  exit 0
fi

# The launch side is ONE brace group, parsed whole before it runs: a --wait can sit here for hours, and a
# landing that rewrites this file meanwhile must not be read by offset into the rest (Sprint 13 H2 review).
{
owner="detached" purpose="" log="" quiet_flag=0 wait_sec="" class_opt=""
_count() { case "$1" in ''|*[!0-9]*) echo "run_detached: $2 takes a whole number, not '$1'"; exit 2;; esac; }
while [ $# -gt 0 ]; do
  case "$1" in
    --owner) owner="$2"; shift 2;;
    --purpose) purpose="$2"; shift 2;;
    --log) log="$2"; shift 2;;
    --quiet) quiet_flag=1; shift;;
    --wait) _count "$2" --wait; wait_sec=$(( $2 * 60 )); shift 2;;
    --wait-seconds) _count "$2" --wait-seconds; wait_sec=$(( $2 )); shift 2;;
    --class) case "$2" in build|run) class_opt="$2";; *) echo "run_detached: --class build|run, not '$2'"; exit 2;; esac
      shift 2;;
    --) shift; break;;
    -*) echo "run_detached: unknown option $1"; exit 2;;
    *) break;;
  esac
done
if [ $# -lt 2 ]; then
  echo "usage: $0 [--owner <o>] [--purpose <p>] [--log <path>] [--quiet] [--wait <minutes> | --wait-seconds <s>] [--class build|run] <script> <marker> [args...]"; exit 2
fi
script="$1" marker="$2"; shift 2
[ -f "$script" ] || { echo "run_detached: no such script: $script"; exit 2; }
log="${log:-$marker.log}"
rm -f "$marker" "$marker.LOCK_LOST"
mkdir -p "$(dirname "$marker")" "$(dirname "$log")"

min_free_gb="${RUN_MIN_FREE_GB:-4}"
free_gb="$(_free_gb | tr -d '\r\n ')"
if ! printf '%s' "$free_gb" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then
  echo "run_detached: cannot read free disk space on C: (got '$free_gb'); refusing to start"
  printf 'exit=3 REFUSED: cannot read free disk space\n' > "$marker"
  exit 3
fi
if awk -v f="$free_gb" -v m="$min_free_gb" 'BEGIN{exit !(f<m)}'; then
  msg="run_detached: REFUSED -- only ${free_gb} GB free on C: (< RUN_MIN_FREE_GB=${min_free_gb}); refusing to start"
  echo "$msg"
  printf 'exit=3 REFUSED: only %s GB free on C: (< RUN_MIN_FREE_GB=%s)\n' "$free_gb" "$min_free_gb" > "$marker"
  exit 3
fi
# The memory guard (Sprint 14 G5), the disk guard's twin: a launch or a build on a host with little RAM left
# swaps and drags every other session with it.
min_free_mem_gb="${RUN_MIN_FREE_MEM_GB:-3}"
free_mem_gb="$(_free_mem_gb | tr -d '\r\n ')"
if ! printf '%s' "$free_mem_gb" | grep -Eq '^[0-9]+(\.[0-9]+)?$'; then
  echo "run_detached: cannot read free memory (got '$free_mem_gb'); refusing to start"
  printf 'exit=3 REFUSED: cannot read free memory\n' > "$marker"
  exit 3
fi
if awk -v f="$free_mem_gb" -v m="$min_free_mem_gb" 'BEGIN{exit !(f<m)}'; then
  msg="run_detached: REFUSED -- only ${free_mem_gb} GB memory free (< RUN_MIN_FREE_MEM_GB=${min_free_mem_gb}); refusing to start"
  echo "$msg"
  printf 'exit=3 REFUSED: only %s GB memory free (< RUN_MIN_FREE_MEM_GB=%s)\n' "$free_mem_gb" "$min_free_mem_gb" > "$marker"
  exit 3
fi

purpose="${purpose:-detached $(basename "$script")}"
# The launcher guard (Sprint 17), the memory guard's shape: a build copies dist/socom_unzipped_launcher.exe, which
# fails "Device or resource busy" while the owner's launcher window runs (three reds on 2026-09-30/10-01, the merged
# chain's step 2 among them). A job whose purpose starts with "merged chain" or "build" is refused while it runs.
case "$purpose" in
  "merged chain"*|build*)
    running="$(_launcher_pids)"
    if [ -n "$running" ]; then
      echo "run_detached: REFUSED -- the launcher is running (pid $running): close the launcher window (socom_unzipped_launcher.exe) and run this again; the step's copy of the launcher fails 'Device or resource busy' while it runs"
      printf 'exit=3 REFUSED: the launcher is running (pid %s): close the launcher window (socom_unzipped_launcher.exe)\n' "$running" > "$marker"
      exit 3
    fi ;;
esac
want_quiet=$quiet_flag
case "$purpose" in launch*) want_quiet=1;; esac

if [ -n "$wait_sec" ]; then
  # The waiter watches THIS process and its CALLER (not the $(...) subshell it is forked from, which a
  # killed parent leaves behind): TaskStop kills the calling shell and leaves run_detached running, so a
  # stopped agent's queued launch must die with its caller, not launch the abandoned job hours later. A
  # Windows-native caller (python) shows as pid 1 and is skipped. The blob is recorded now -- this file is
  # read by offset too.
  watch="$$"; case "$PPID" in ''|0|1) ;; *) watch="$$ $PPID";; esac
  echo "run_detached: queueing for the loop lock as $owner (up to $wait_sec s, watching pids $watch) [run_detached.sh $(git hash-object "$0" 2>/dev/null | cut -c1-12)]"
  # The class `loop_lock.sh run` would give the job's command (Sprint 14 W2): the WIP cap counts builds queued here too.
  class="${class_opt:-$(bash "$LOCKSH" _class -- bash "$script" "$@")}"
  case "$class" in build|run) ;; *) class=run;; esac
  out=$(LOOP_LOCK_WAIT_PARENT="$watch" bash "$LOCKSH" wait "$owner" --wait-seconds "$wait_sec" --purpose "$purpose" --class "$class" --print-id)
else
  out=$(bash "$LOCKSH" take "$owner" --purpose "$purpose" --print-id)
fi
rc=$?
held_id=$(printf '%s\n' "$out" | sed -n 's/^ID: //p')
out=$(printf '%s\n' "$out" | grep -v '^ID: ')
case "$out" in
  *NESTED*)
    # The outer holder would release while this job still runs.
    printf 'exit=2 REFUSED: run_detached inside a held lock (%s)\n' "$LOOP_LOCK_HELD" > "$marker"
    echo "run_detached: REFUSED -- called inside a lock held by '$LOOP_LOCK_HELD'; the job would outlive it"
    exit 2;;
esac
if [ -n "$wait_sec" ] && [ $rc -eq 4 ]; then      # the WIP cap: QUEUE FULL, no ticket, nothing launched
  printf 'exit=4 %s\n' "$out" > "$marker"
  echo "run_detached: $out"; exit 4
fi
if [ $rc -ne 0 ]; then
  printf 'exit=75 %s\n' "$out" > "$marker"
  echo "run_detached: $out"; exit 75
fi
export LOOP_LOCK_HELD="$held_id"
export _RUN_DETACHED_QUIET="$want_quiet"
nohup bash "$0" --_child "$owner" "$log" "$marker" "$script" "$@" </dev/null >/dev/null 2>&1 &
echo "DETACHED pid=$! owner=$owner marker=$marker log=$log ($out)"
exit 0
}
