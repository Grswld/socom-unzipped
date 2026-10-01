#!/usr/bin/env bash
# End-to-end build: synthetic ELF -> recompiled C++ -> socom2 runner (clang / llvm-mingw).
# Usage: ./build.sh [tools|recomp|runtime|release|test|all] [--no-runner] [--dry-run] [--full-suite]   (default all; release is never part of all)
#   --dry-run     print the steps this would run and exit 0, building nothing (no toolchain needed). Every step but
#                 tools refuses (exit 3) while another holder has the loop lock, unless run as that holder's child.
#   --no-runner   build with no generated code at all (PS2X_RUNNER_GENERATED_DIR=""): the runtime library, the
#                 launcher and the test suite, but not the game. This is what a fresh clone can do on Windows
#                 (Sprint 10 H3): `bash scripts/bootstrap_windows.sh`, then `./build.sh runtime --no-runner`
#                 and `./build.sh test --no-runner`. The recompiled game needs your own disc (README).
#   --full-suite  `test` runs the full Python suite even where it would skip it (a linked worktree, or waiters queued
#                 on the loop lock; python_suite_skip below).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# Python the way every script here finds it (scripts/python_env.sh: PYTHON, else python, else python3), resolved
# once, before the toolchain goes on the PATH; each step that runs it calls socom_require_python first, so a
# runtime-only build still needs no interpreter (Sprint 13 H7, harness audit #32).
. "$ROOT/scripts/python_env.sh"
export PATH="$ROOT/tools/llvm-mingw/bin:$ROOT/tools/cmake/bin:$ROOT/tools/ninja:$PATH"
STEP=""
NO_RUNNER=0
DRY_RUN=0
FULL_SUITE=0
for arg in "$@"; do
  case "$arg" in
    --no-runner) NO_RUNNER=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --full-suite) FULL_SUITE=1 ;;
    tools|recomp|runtime|release|test|all) STEP="$arg" ;;
    *) echo "unknown argument $arg" >&2; exit 2 ;;
  esac
done
STEP="${STEP:-all}"
# Sprint 14 G5: the loop lock is machine-wide (scripts/loop_lock.sh), and a build beside another holder's build or
# game run is the collision it exists to stop. Every step but `tools` refuses while ANOTHER holder has the lock,
# unless this process is that holder's child: `loop_lock.sh run` and run_detached.sh export LOOP_LOCK_HELD="<owner>
# <take_id>", and it must EQUAL the live holder (`loop_lock.sh id`), as the lock script's own nested() demands. A
# value that names another holding is stale -- the grandchild of a lost lock -- and is refused, naming both. A
# FREE lock proceeds, LOOP_LOCK_HELD or not (nothing to collide with), and so does a lock script that is absent or
# cannot answer (a CI runner). Exit 3 is run_detached's refusal code. The consult runs for --dry-run too, so
# tools_py/tests/test_build_sh_lock.py exercises it without building anything.
if [ "$STEP" != tools ] && [ -f "$ROOT/scripts/loop_lock.sh" ]; then
  lock_state="$(bash "$ROOT/scripts/loop_lock.sh" check 2>/dev/null | head -n1 || true)"
  case "$lock_state" in
    HELD:*)
      holder="$(bash "$ROOT/scripts/loop_lock.sh" id 2>/dev/null || true)"
      if [ -n "${LOOP_LOCK_HELD:-}" ] && [ "$LOOP_LOCK_HELD" != "$holder" ]; then
        # re-read once on a miss, as nested() does: a reader can catch a record replace
        sleep 0.2
        holder="$(bash "$ROOT/scripts/loop_lock.sh" id 2>/dev/null || true)"
      fi
      if [ -n "${LOOP_LOCK_HELD:-}" ] && [ "$LOOP_LOCK_HELD" = "$holder" ]; then
        :   # the holder's own child
      elif [ -n "${LOOP_LOCK_HELD:-}" ]; then
        echo "build.sh: LOOP_LOCK_HELD is stale: '$LOOP_LOCK_HELD' vs holder '${holder:-<unreadable>}': build refused; run it under scripts/loop_lock.sh run <owner> --purpose \"...\" -- ./build.sh $STEP" >&2
        exit 3
      else
        [ -n "$holder" ] || holder="$(printf '%s\n' "$lock_state" | cut -d' ' -f2)"
        echo "build.sh: lock held by $holder: build refused; run it under scripts/loop_lock.sh run <owner> --purpose \"...\" -- ./build.sh $STEP" >&2
        exit 3
      fi ;;
  esac
fi
# Sprint 17, three reds on 2026-09-30/10-01: runtime() copies the launcher into dist/ AFTER the game is built, and
# while the owner's launcher window runs (dist/socom_unzipped_launcher.exe) that `cp` fails "Device or resource
# busy": a lone build reads FAILED and the merged chain's step 2 goes red for a non-code reason. So `runtime`, `all`
# and `release` (which copies the launcher too, into dist-release[-dev]/) refuse up front, exit 3, naming the pid(s)
# and the fix; `tools`, `recomp` and `test` copy no launcher and do not look. The query is by image name
# (tasklist on Windows, pgrep -f on Linux; neither present: nothing is found); BUILD_LAUNCHER_CHECK_CMD replaces it
# for tests (its output's numbers are the pids; `true` means none). It runs for --dry-run too, like the lock
# consult. Twins, the same line: scripts/parity/merged_chain.sh's preflight and scripts/run_detached.sh.
launcher_pids() {   # prints "<pid>[, <pid>...]" or nothing
  local out=""
  if [ -n "${BUILD_LAUNCHER_CHECK_CMD:-}" ]; then
    out="$(eval "$BUILD_LAUNCHER_CHECK_CMD" 2>/dev/null || true)"
  elif command -v tasklist >/dev/null 2>&1; then
    out="$(MSYS_NO_PATHCONV=1 tasklist /FI "IMAGENAME eq socom_unzipped_launcher.exe" /FO CSV /NH 2>/dev/null | tr -d '\r' \
      | awk -F'","' 'tolower($1) == "\"socom_unzipped_launcher.exe" { print $2 }' || true)"
  elif command -v pgrep >/dev/null 2>&1; then
    out="$(pgrep -f '^([^ ]*/)?socom_unzipped_launcher(\.exe)?( |$)' 2>/dev/null || true)"
  fi
  printf '%s\n' "$out" | awk '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) s = s (s == "" ? "" : ", ") $i } END { if (s != "") print s }'
}
case "$STEP" in
  runtime|all|release)
    running="$(launcher_pids)"
    if [ -n "$running" ]; then
      echo "build.sh: REFUSED -- the launcher is running (pid $running): close the launcher window (socom_unzipped_launcher.exe) and run this again; the step's copy of the launcher fails 'Device or resource busy' while it runs" >&2
      exit 3
    fi ;;
esac
# Sprint 17, the owner's rule of 2026-09-28: the full Python suite is the merged chain's bar (and CI's, on
# every push), not a branch build's. Twice that night one `./build.sh test --no-runner` in an agent's worktree ran the
# whole discover under the lock with three holders queued behind it; starved, it held the lock 60-110 minutes and
# blocked the chain. So `test` prints one line and skips the discover -- the C++ tests still run, and the exit code
# is theirs -- in a LINKED worktree (`--git-dir` differs from `--git-common-dir`), or when `loop_lock.sh check` shows
# a live QUEUED waiter. It always runs with --full-suite, and inside the merged chain: the chain's marker in this
# tree (logs/.merged_chain.running, scripts/parity/merged_chain.sh) names this very holding (`held=$LOOP_LOCK_HELD`).
# A branch's bar is the C++ tests plus the module tests its change touched (`python -m unittest <modules>`). Prints
# the skip line, or nothing when the suite runs; tools_py/tests/test_build_sh_lock.py (TestBuildShSuiteGuard).
python_suite_skip() {
  local marker="$ROOT/logs/.merged_chain.running" gdir gcommon queued
  [ "$FULL_SUITE" = 1 ] && return 0
  if [ -n "${LOOP_LOCK_HELD:-}" ] && [ -f "$marker" ] && grep -qxF "held=$LOOP_LOCK_HELD" "$marker"; then
    return 0
  fi
  gdir="$(git -C "$ROOT" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  gcommon="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$gdir" ] && [ -n "$gcommon" ] && [ "$gdir" != "$gcommon" ]; then
    echo "tests: Python suite skipped (linked worktree; the merged chain runs it -- --full-suite to force)"
    return 0
  fi
  if [ -f "$ROOT/scripts/loop_lock.sh" ]; then
    # a STALE ticket is a dead waiter's, dropped at the next grant: it does not count
    queued="$(bash "$ROOT/scripts/loop_lock.sh" check 2>/dev/null | grep '^QUEUED:' | grep -vc '^QUEUED: STALE' || true)"
    if [ "${queued:-0}" -gt 0 ] 2>/dev/null; then
      echo "tests: Python suite skipped ($queued waiter(s) queued on the loop lock; the merged chain runs it -- --full-suite to force)"
    fi
  fi
}
SUITE_SKIP=""
[ "$STEP" = test ] && SUITE_SKIP="$(python_suite_skip)"
# --dry-run prints the plan and builds nothing; it exits before the toolchain check, so it works on a machine with
# no tools/.
if [ "$DRY_RUN" = 1 ]; then
  case "$STEP" in
    all) plan="recomp runtime" ;;
    test) plan="test_step" ;;
    *) plan="$STEP" ;;
  esac
  echo "build.sh --dry-run: step=$STEP no_runner=$NO_RUNNER"
  for s in $plan; do
    case "$s" in
      tools)     echo "  would run: tools -- ps2_recomp and ps2_analyzer in third_party/ps2recomp/build-tools" ;;
      recomp)    echo "  would run: recomp -- overlay ELF, fixed function map, tools, ps2_recomp into recomp/output" ;;
      runtime)   echo "  would run: runtime -- third_party/ps2recomp/build-clang: $([ "$NO_RUNNER" = 1 ] && echo "ps2_runtime (no generated code)" || echo ps2EntryRunner), the launcher, into dist/" ;;
      release)   echo "  would run: release (${PS2X_RELEASE_KIND:-player}) -- third_party/ps2recomp/build-release[-dev], stripped, into dist-release[-dev]/" ;;
      test_step)
        if [ -n "$SUITE_SKIP" ]; then echo "  would run: test -- the quiet gate, the C++ tests"; echo "  $SUITE_SKIP"
        else echo "  would run: test -- the quiet gate, the Python suite, the C++ tests"; fi ;;
    esac
  done
  exit 0
fi
if ! command -v clang >/dev/null 2>&1 || ! command -v cmake >/dev/null 2>&1 || ! command -v ninja >/dev/null 2>&1; then
  echo "build.sh: no toolchain under tools/ -- run: bash scripts/bootstrap_windows.sh" >&2
  exit 2
fi

PS2R="$ROOT/third_party/ps2recomp"
TOOLBUILD="$PS2R/build-tools"      # ps2_recomp / ps2_analyzer
RTBUILD="$PS2R/build-clang"        # runtime + runner with generated code
RELBUILD="$PS2R/build-release"     # Sprint 9 Goal 2: the release configuration -- its own tree, never the developer's
RELDIST="$ROOT/dist-release"       # ... and its own folder; dist/socom2.exe stays the gate's and the harness's default
# Sprint 16 R3a (R295): the release is two kinds. player (the default) builds without the debug UI and stages into
# dist-release/; developer keeps it and stages into dist-release-dev/, from its own tree, so building one kind never
# reconfigures the other's (release() picks them):
# the player exe drops the debug UI; the probes stay in both kinds because the gate reads them (R295's probe half withdrawn by the Sprint 16 controller, 2026-09-27).
# release() writes the kind beside the exe in RELEASE_KIND, which scripts/make_portable.sh --release checks before it
# packages both.
REL_KIND="${PS2X_RELEASE_KIND:-player}"
GEN="$ROOT/recomp/output"
[ "$NO_RUNNER" = 1 ] && GEN=""

build_tools() {
  cmake -S "$PS2R" -B "$TOOLBUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ >/dev/null
  cmake --build "$TOOLBUILD" --target ps2_recomp ps2_analyzer -j "$(nproc)"
}

recomp() {
  local lte
  lte="$(cat "$ROOT/recomp/loader_text_end.txt")"
  socom_require_python build.sh
  "$PYTHON" "$ROOT/tools_py/make_overlay_elf.py" "--loader-text-end=$lte" \
      "$ROOT/game/overlays/socom2_game.elf" "$ROOT/game/disc/SCUS_972.75" \
      "$ROOT/game/overlays/ftscore.bin" "$ROOT/game/overlays/zsealetc.bin"
  cp "$ROOT/game/overlays/socom2_game.elf" "$ROOT/game/disc/socom2_game.elf"
  # The function map is a SOURCE: the fixed rows are a product under the git-ignored recomp/build/, the file
  # recomp/socom2.toml's ghidra_output names (build_revision.sh step 0's rule; Sprint 13 C5 -- until then this
  # rewrote the tracked recomp/socom2_ghidra.csv in place on every recomp). Nothing this step writes is tracked:
  # tools_py/tests/test_build_products.py reads this function and holds that.
  "$PYTHON" "$ROOT/tools_py/fix_ghidra_csv.py" "$ROOT/recomp/socom2_ghidra.csv" "$ROOT/recomp/extra_functions.txt" \
      --out "$ROOT/recomp/build/socom2_ghidra.fixed.csv"
  build_tools   # incremental; the recompiler embeds the runtime call list, keep it in sync
  # The output directory is NOT deleted first (issue #57): ps2_recomp rewrites a file only when its bytes change
  # and removes the .cpp/.h files an earlier run left that this one did not produce, so an unchanged file keeps
  # its timestamp and the runtime build after a rename recompiles only what the rename touched.
  (cd "$ROOT/recomp" && "$TOOLBUILD/ps2xRecomp/ps2_recomp.exe" socom2.toml > recomp_run.log 2>&1) \
      || { tail -20 "$ROOT/recomp/recomp_run.log"; exit 1; }
  # unmapped= counts continuation pcs (a call's return, a syscall's return, a not-taken branch's
  # fallthrough) that no recompiled row owns: each one is a [guest-branch:missing-target] waiting
  # for a thread to reach it. Read, not gated -- like unhandled=.
  echo "recomp: $(ls "$GEN" | wc -l) files, unhandled=$(grep -c unhandled-instruction "$ROOT/recomp/recomp_run.log" || true), unmapped=$(grep -c unmapped-continuation "$ROOT/recomp/recomp_run.log" || true)"
  # The names sidecar's events (#48): "Loaded N display names", or the WARNING that the toml's names path does
  # not resolve (every function then keeps its FUN_/sub_ placeholder). Printed, not gated.
  grep -E '^ *\[(info|warning)\] names - ' "$ROOT/recomp/recomp_run.log" | sed -e 's/^ *\[warning\] names - /WARNING: names: /' -e 's/^ *\[info\] names - /recomp: names: /' || true
}

runtime() {
  cmake -S "$PS2R" -B "$RTBUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
        -DPS2X_RUNNER_GENERATED_DIR="$GEN" -DPS2X_ENABLE_LTO="${LTO:-OFF}" -DPS2X_GENERATED_OPT="${GENOPT:--O1}" \
        -DPS2X_GAME_REVISION=r0001 >/dev/null
  mkdir -p "$ROOT/dist"
  if [ -n "$GEN" ]; then
    cmake --build "$RTBUILD" --target ps2EntryRunner -j "$(nproc)"
    cp "$RTBUILD/ps2xRuntime/ps2EntryRunner.exe" "$ROOT/dist/socom2.exe"
  else
    # no generated code: the library alone (the CMake tree skips ps2EntryRunner and says so)
    cmake --build "$RTBUILD" --target ps2_runtime -j "$(nproc)"
  fi
  # Task 8b: the launcher, built next to the game (research/32 has the audio; packaging outline section 3 the launcher)
  cmake --build "$RTBUILD" --target socom_unzipped_launcher -j "$(nproc)" && cp "$RTBUILD/ps2xLauncher/socom_unzipped_launcher.exe" "$ROOT/dist/"
  cp "$RTBUILD/ps2xRuntime/"*.dll "$ROOT/dist/" 2>/dev/null || true
  for d in libc++.dll libunwind.dll libwinpthread-1.dll; do
    [ -f "$ROOT/tools/llvm-mingw/bin/$d" ] && cp "$ROOT/tools/llvm-mingw/bin/$d" "$ROOT/dist/"
  done
  if [ -n "$GEN" ]; then echo "built dist/socom2.exe"; else echo "built the runtime library and dist/socom_unzipped_launcher.exe (no generated code: no game)"; fi
}

# Sprint 9 Goal 2. The same sources and the same Release build type as runtime(); what differs is the generated
# code's -O level, the link hygiene (PS2X_RELEASE_LINK), optionally ICF and ThinLTO, and that the two executables
# are stripped with their symbols kept beside them. Every value is an environment variable so the measurement
# matrix (the Goal 2 plan, Task 5) builds each candidate with this one function.
release() {
  # R151, measured in Sprint 9 Goal 2: -O2 makes the generated code 9.9% smaller as an exe and the ZIP
  # 4.6 MB LARGER, and the download is what a stranger pays. The ruling said the release keeps -O1; this
  # default said -O2 from 443238e until Sprint 9 P7 found it, so every release built by running this
  # script plainly had shipped the configuration the measurement rejected.
  local genopt="${REL_GENOPT:--O1}" lto="${REL_LTO:-OFF}" scope="${REL_LTO_SCOPE:-all}" icf="${REL_ICF:-}"
  local fc=() src name debug_ui
  case "$REL_KIND" in
    player) debug_ui=OFF ;;
    developer) debug_ui=ON; RELBUILD="$PS2R/build-release-dev"; RELDIST="$ROOT/dist-release-dev" ;;
    *) echo "build.sh: PS2X_RELEASE_KIND=$REL_KIND -- it is player|developer" >&2; return 2 ;;
  esac
  socom_require_python build.sh      # the import closure below (portable_audit.py) -- before a long build, not after
  rm -f "$RELDIST/RELEASE_KIND"      # written last: a failed build leaves no kind for make_portable.sh to trust
  # Reuse the developer tree's fetched sources read-only (raylib, imgui, ...): a second tree would clone them all again.
  for src in "$RTBUILD"/_deps/*-src; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"; name="${name%-src}"
    fc+=("-DFETCHCONTENT_SOURCE_DIR_$(printf '%s' "$name" | tr 'a-z' 'A-Z')=$src")
  done
  cmake -S "$PS2R" -B "$RELBUILD" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ \
        -DPS2X_RUNNER_GENERATED_DIR="$GEN" -DPS2X_GENERATED_OPT="$genopt" \
        -DPS2X_ENABLE_LTO="$lto" -DPS2X_LTO_SCOPE="$scope" \
        -DPS2X_RELEASE_LINK=ON -DPS2X_LINK_ICF="$icf" -DPS2X_GAME_REVISION=r0001 \
        -DPS2X_ENABLE_DEBUG_UI="$debug_ui" ${fc[@]+"${fc[@]}"} >/dev/null
  cmake --build "$RELBUILD" --target ps2EntryRunner socom_unzipped_launcher -j "${REL_JOBS:-$(nproc)}"
  local stage="$RELDIST/.stage" tag
  tag="$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)"
  rm -rf "$stage"; mkdir -p "$stage" "$RELDIST/symbols"
  cp "$RELBUILD/ps2xRuntime/ps2EntryRunner.exe" "$stage/socom2.exe"
  cp "$RELBUILD/ps2xLauncher/socom_unzipped_launcher.exe" "$stage/"
  cp "$RELBUILD/ps2xRuntime/"*.dll "$stage/" 2>/dev/null || true
  for d in libc++.dll libunwind.dll libwinpthread-1.dll; do
    [ -f "$ROOT/tools/llvm-mingw/bin/$d" ] && cp "$ROOT/tools/llvm-mingw/bin/$d" "$stage/"
  done
  rm -f "$RELDIST"/*.dll
  "$PYTHON" "$ROOT/tools_py/portable_audit.py" closure --system Windows --dir "$stage" \
      "$stage/socom2.exe" "$stage/socom_unzipped_launcher.exe" | tr -d '\r' | while read -r dll; do
    [ -n "$dll" ] && cp "$stage/$dll" "$RELDIST/"
  done
  for exe in socom2.exe socom_unzipped_launcher.exe; do
    # The symbol table leaves the shipped file and stays here: llvm-nm -n symbols/<exe>.debug turns a crash
    # line's module+0x<rva> back into a function, and tools_py/hostprof_symbolize.py --exe takes the same file.
    llvm-objcopy --only-keep-debug "$stage/$exe" "$RELDIST/symbols/$exe.debug"
    llvm-strip --strip-all "$stage/$exe"
    ( cd "$RELDIST/symbols" && llvm-objcopy --add-gnu-debuglink="$exe.debug" "$stage/$exe" )
    cp "$stage/$exe" "$RELDIST/$exe"
    printf '%s %s %s\n' "$tag" "$(sha256sum "$RELDIST/$exe" | cut -d' ' -f1)" "$exe" >> "$RELDIST/symbols/INDEX.txt"
  done
  [ -f "$ROOT/dist/socom2_game.elf" ] && cp "$ROOT/dist/socom2_game.elf" "$RELDIST/"
  rm -rf "$stage"
  printf '%s\n' "$REL_KIND" > "$RELDIST/RELEASE_KIND"   # the kind, one word, beside the exe (make_portable.sh reads it)
  echo "built $(basename "$RELDIST")/socom2.exe, the $REL_KIND kind ($(wc -c < "$RELDIST/socom2.exe") bytes; genopt=$genopt lto=$lto/$scope icf=${icf:-off} debug_ui=$debug_ui; symbols in $(basename "$RELDIST")/symbols)"
}

test_step() {
  # Sprint 5 R46/A5's launch hygiene, write side scripts/run_detached.sh: refuse the whole test step
  # while a launch is running quiet (logs/.quiet, <2h old, live pid) unless FORCE_QUIET=1 -- a launch
  # running for tens of minutes must not share the host with build.sh test's own CPU load.
  if ! bash "$ROOT/scripts/check_quiet_gate.sh"; then
    return 3
  fi
  # Python tests first: no build needed, and the whole parity gate's scorers live here. The one runner is
  # unittest (no pytest); tools_py/tests/test_test_hygiene.py fails on a test file this line would miss.
  # Skipped, with one line, in a linked worktree or behind a queue (python_suite_skip above; --full-suite forces it).
  if [ -n "$SUITE_SKIP" ]; then
    echo "$SUITE_SKIP"
  else
    socom_require_python build.sh
    ( cd "$ROOT" && "$PYTHON" -m unittest discover -s tools_py/tests -t . -v )
  fi
  # gs_replay_bench (Sprint 17 F) is built here so every test run links it; it runs by hand, on a recording
  # (python -m tools_py.parity.replay_bench), never in this step: it needs a desktop session and a recording.
  cmake --build "$RTBUILD" --target ps2x_tests vu1_replay gs_replay_bench -j "$(nproc)"
  # ps2x_tests reads ps2xRecomp/include/ps2recomp/instructions.h relative to its own directory.
  local ps2x_test_repeat="${PS2X_TEST_REPEAT:-1}"
  ( cd "$RTBUILD/ps2xTest" && for i in $(seq 1 "$ps2x_test_repeat"); do
      echo "ps2x_tests run $i/$ps2x_test_repeat"
      if ! ./ps2x_tests.exe; then
        echo "ps2x_tests run $i/$ps2x_test_repeat FAILED"
        exit 1
      fi
    done )
  mkdir -p "$ROOT/dist"
  cp "$RTBUILD/ps2xRuntime/vu1_replay.exe" "$ROOT/dist/vu1_replay.exe"
  cp "$RTBUILD/ps2xRuntime/gs_replay_bench.exe" "$ROOT/dist/gs_replay_bench.exe"
  # Four verify runs over the two fixture sets, then the two host-draw checks. The native registry is ON by default
  # (kVu1NativeDefault), so the path a run takes has to be selected explicitly: --no-native forces
  # the generated/interpreted path, --native forces the registry. Both flags must follow the golden
  # path -- --verify consumes the next argument. Every run prints
  # "[vu1_replay] native entered=.. ended=.. handbacks=..", which says which path actually ran.
  #
  #   1-2 (--no-native): the generated/interpreted path over both sets; both report entered=0.
  #   3   (--native):    the title set enters at pc 0, which no native program claims, so it is a
  #                      no-op for the registry and also reports entered=0 -- this line is a
  #                      regression check that the native programs do NOT intercept the title set,
  #                      not native coverage.
  #   Runs 3-5 pass --regs all (runs 8-9 always did): without it --verify compares only end pc,
  #   data memory and the packets, so a native program that got a register right in the packet and
  #   wrong in the file would pass. The goldens were taken on the interpreted path, so this is the
  #   check that the native path reproduces the whole register file, not just what it kicked.
  #   4   (--native):    the 0x1b50 dispatcher set is the one with native coverage; it reports a
  #                      non-zero entered=.. (entered = ended + handbacks) and must still match the
  #                      same golden packets and registers as run 2.
  "$ROOT/dist/vu1_replay.exe" --verify "$ROOT/tests/fixtures/vu1/title/golden.txt" --no-native "$ROOT"/tests/fixtures/vu1/title/*.bin
  "$ROOT/dist/vu1_replay.exe" --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --no-native "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
  "$ROOT/dist/vu1_replay.exe" --verify "$ROOT/tests/fixtures/vu1/title/golden.txt" --native --regs all "$ROOT"/tests/fixtures/vu1/title/*.bin
  "$ROOT/dist/vu1_replay.exe" --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --regs all "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
  # 5: the same set with PS2X_VU1_HOST_DRAW=1 (command 0x28 draws through GS::submitHostTriangle
  #    instead of kicking its packet). There are no packets to compare then, so this run checks end
  #    pc, VU data memory and the register file -- the knob must not change any of them.
  "$ROOT/dist/vu1_replay.exe" --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --host-draw --regs all "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
  # 6: and what the two paths actually draw, pixel for pixel, into a 640x448 framebuffer. The host
  #    path keeps the sub-1/16-pixel fraction the GIF path truncates, so edge and gouraud-rounding
  #    pixels differ by design; anything past the tolerance means a wrong lane or a wrong context.
  #    The score is hard / drawn, NOT differing / whole frame: these dumps paint 26..3291 pixels of
  #    a 286720-pixel frame, so a frame-relative score tops out at 0.32% here and could not fail at
  #    1% however wrong the drawing was (measured: forcing the host path +8 px in x leaves 9 of the
  #    10 dumps that existed then at 0.0000-0.2570% of frame).
  #    "hard" excludes the two differences the two paths produce by design, both measured on this
  #    fixture set rather than assumed. Each has an opaque form and a form that only appears once
  #    the draw is blended or the seam is interior (Sprint 4 task 3 widened both; before that,
  #    vu1dump4_prog_182 scored 1.488% and was held out of this set):
  #      - rounding: max channel delta <= 1 -- one step of gouraud interpolation -- which is
  #        174/179, 897/922, 67/69 and 63/66 of those dumps' differing pixels. Plus, on a dump
  #        whose kicked packets set PRIM.ABE and only where BOTH passes drew the pixel, max channel
  #        delta <= 2: the blend turns that one source step into two destination steps (the
  #        measured cases are alpha 127 against 128). Gated on ABE because on an opaque draw a
  #        delta of 2 is a real difference -- though note that every dump in this corpus kicks
  #        PRIM 0x7b (prog_31: 0x4b), i.e. ABE = 1, so the gate does not discriminate here yet.
  #      - edge: a differing pixel whose 3x3 neighbourhood is not uniformly drawn in one of the two
  #        renderings, i.e. sub-pixel coverage at a triangle edge (delta 127/128 = drawn vs blank).
  #        Plus the interior form of the same thing: a colour seam between two adjacent triangles
  #        that sits one pixel over with both sides drawn, so the 3x3 is uniformly drawn and no
  #        coverage boundary fires. It is recognised as each rendering's colour at the pixel
  #        appearing within 2 on a DRAWN pixel of the other rendering's eight neighbours, in both
  #        directions (a seam that moved swaps the two sides' colours) and never the centre pixel
  #        (matching the centre would silently mean "delta <= 2 is always fine"). That clause is
  #        BUDGETED at 1% of drawn and reported as seam=N on the VRAMDIFF line: a real seam is a
  #        few pixels along one edge, but a UNIFORM one-pixel offset of the whole drawing
  #        satisfies it EVERYWHERE, so past the budget every pixel it accepted goes back to hard
  #        and the line says OVER-BUDGET. On a clean build the clause is used on three dumps only
  #        -- 4 px on prog_11 (0.12%), 3 on prog_177 (0.24%), 3 on prog_182 (0.50%) -- so the
  #        thinnest margin to the budget is 2x. Thin, and deliberately visible.
  #    What is left on a clean build is 0 on all fifteen dumps. Sensitivity, measured by shifting
  #    the host path inside the hook (dumps over the 1% tolerance, of fifteen, and their range):
  #        +1 px x   8 fail, 1.64-11.65%        +1 px y   6 fail, 1.42-16.74%
  #        +2 px x   7 fail, 1.64-19.01%        +8 px x   9 fail, 7.07-55.48%
  #    The six that never fail are the six whose host path the hook never takes -- their two
  #    renderings are already bit-identical -- so no offset can move them. The +8 px column is
  #    within 0.7 points of what the pre-widening buckets score on the same renders (7.07-56.19%).
  #    Read the +-1 px column as the reason the budget exists: WITHOUT it, the seam clause scores
  #    those same +-1 px renders at 0.00-0.08% and fails NOTHING, and the +8 px experiment alone
  #    would never have shown that -- a systematic one-pixel offset (a wrong XYOFFSET constant, an
  #    off-by-one in the >>4 truncation, a wrong lane feeding x) would have been invisible
  #    corpus-wide. If either bucket is widened again, re-measure +-1 px FIRST: it is the tightest
  #    of these by an order of magnitude. Dropped geometry, colour errors of 4 steps or more and
  #    shifts of 3 px and up are not close calls -- they fail by 7x-84x either way.
  #
  #    Family C (vu1dump4_prog_165 over B, prog_177 and prog_252 over A) used to SKIP here: its
  #    0x64 / 0x30 / 0x32 render-state packets point TEX0 at a texture the dump does not carry, so
  #    every texel read back 0 and the ALPHA_1 = 0x44 those packets also set -- (Cs - Cd) * As + Cd
  #    with As = 0 -- left the framebuffer untouched. vu1_replay now fills VRAM outside the frame
  #    and z buffers with 0x80808080 (so any TEX0 samples a neutral texel, the same identity
  #    MODULATE family A already got from its parked 1x1) and gives the z buffer its own pages
  #    (those packets also switch TEST from ALWAYS to GEQUAL). vu1dump3_prog_31 is the fourth
  #    family, whose 0x40 draws through the host hook with an untextured PRIM 0x4B.
  #    vu1dump4_prog_182 (the fourth C-over-A dump in the corpus) is in this set as of Sprint 4
  #    task 3. It used to score 1.488% because both by-design buckets were calibrated on opaque,
  #    edge-only differences: 6 of its 9 hard pixels were the blend-amplified delta-2 class and 3
  #    were interior seams at 8, 12 and 14 steps. Note for whoever calibrates the buckets again:
  #    the delta-2 class is partly an artifact of this synthetic context, not of the game's blend
  #    alone, because Cd = 0 on a first write and the neutral texel's At = 128 reduce
  #    (Cs - Cd) * As + Cd to Cv * Av >> 7.
  #    Still a known gap: a patterned rather than uniform neutral fill, which is what a uniform
  #    texel cannot cover -- any ST/UV/Q divergence between the two paths is invisible against a
  #    constant texture.
  #    The run also has to be read, not just exited: vu1_replay warns on stderr when a fixture's
  #    TEX0 resolves below the zeroed framebuffer/z region (see warnIfTextureInBlankRegion), which
  #    degrades that dump's comparison silently -- it can go back to drawing nothing and SKIPping,
  #    which is the one failure mode --vram-diff cannot score. Nothing in the fixture set trips it
  #    today, so the check below costs nothing now and turns that into a hard stop the day a
  #    fixture's texture lands in the blank region. Same shape as expect_native: capture, print,
  #    then assert on the output rather than trusting the exit code alone.
  vram_diff_check() {
    local out status=0
    out="$("$@" 2>&1)" || status=$?
    printf '%s\n' "$out"
    if [ "$status" -ne 0 ]; then
      echo "vram diff: FAILED (exit $status)" >&2
      return "$status"
    fi
    if printf '%s\n' "$out" | grep -qF '[vu1_replay] WARNING'; then
      printf '%s\n' "$out" | grep -F '[vu1_replay] WARNING' >&2
      cat >&2 <<'MSG'
vram diff: the dump named above has a TEX0 that resolves below the zeroed framebuffer/z region,
so it samples 0 and that dump's GIF-vs-host comparison is degraded -- at the limit it draws
nothing and SKIPs, which is exactly the blank-frame hole this check exists to keep closed.
Fix the layout, not this assertion: revisit setupReplayGsContext in
third_party/ps2recomp/ps2xRuntime/src/tools/vu1_replay.cpp and move the replay framebuffer and z
buffer (kZBufferPage / kBlankBytes, and kTextureBlock with them, which the static_assert ties
together) so that the fixture's texture lands in the neutral fill above them.
MSG
      return 1
    fi
  }
  vram_diff_check "$ROOT/dist/vu1_replay.exe" --vram-diff "$ROOT/logs/vramdiff_fixtures" "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
  # 7: the work-ceiling refusal path. tests/fixtures/vu1/clamp holds vu1dump4_prog_11 with TOP+2.z
  #    rewritten from 76 to 300 -- above kMaxVertices -- and a golden taken from the microcode path
  #    on that patched dump (which runs 5.6M cycles to produce nothing, i.e. exactly the runaway
  #    the ceiling exists to stop). The native path must refuse it: this run has to report
  #    "entered=1 ended=0 handbacks=1" and still match end pc, VU data memory and every register.
  #    Regenerate with:
  #      python -m tools_py.vu1_headers --set-vertices 300 --out tests/fixtures/vu1/clamp \
  #          tests/fixtures/vu1/dispatch_0x1b50/vu1dump4_prog_11.bin
  #      PS2X_VU1_FAST=0 PS2X_VU1_GEN=0 dist/vu1_replay.exe --batch tests/fixtures/vu1/clamp \
  #          --no-native tests/fixtures/vu1/clamp/*.bin     # then state.txt -> golden.txt
  "$ROOT/dist/vu1_replay.exe" --verify "$ROOT/tests/fixtures/vu1/clamp/golden.txt" --native --regs all "$ROOT"/tests/fixtures/vu1/clamp/*.bin
  # 8-9: the per-handler clamps. Run 7 exercises the PRE-SCAN's ceiling -- a header above it is
  #    refused whole at 0x1b50 and no handler is ever entered -- so it says nothing about the
  #    clamps inside the handlers. Those cannot be reached with data at all: the pre-scan reads
  #    the same two header words first, and vi10 is bounded by the clipper that produces it. They
  #    are reached instead with the two test-only ceiling overrides, which lower the HANDLER-side
  #    ceilings and leave the pre-scan's real constants alone (socom2_dispatch_0x1b50.cpp:
  #    vertexCeiling / triangleCeiling / clippedVertexCeiling). Nothing in the game sets either.
  #
  #    Both runs check against run 4's own unmodified golden, with no new fixture bytes, because
  #    that is the whole claim: a clamp hand-back has to leave exactly the state the microcode then
  #    finishes the list from, so the end state must be the microcode's to the last register.
  #
  #    8: PS2X_VU1_NATIVE_TEST_CEILING=2 trips cmdUnpackVertices' clamp at 0x0b28 (TOP+2.z is 8..76
  #       across the set) on the FIRST command of all fifteen lists, fourteen of which start
  #       68 and one (the fourth family) 70, whose 0x0cb8 unpack clamps on the same count.
  #    9: PS2X_VU1_NATIVE_TEST_CLIP_CEILING=2 leaves every family-A count alone and trips
  #       cmdClippedTransform's clamp at 0x0f38 (vi10) MID-LIST on the six lists that contain
  #       family-B commands -- after 68/06/02 have run and the clipper has written qwords 40-111,
  #       112 and 329.z and left vi8/vi10/vi12/vi15 live. That is the hand-back research/13 6.3
  #       calls the inside of an indivisible unit, and the one this file's whole-state
  #       reproduction is what makes safe; the other nine (family A, C-over-A and the fourth
  #       family) still run to
  #       their E bit, which is what makes the run a two-sided check rather than a blanket refusal.
  expect_native() { # $1 = the exact counts to require, then the command
    local want="$1"; shift
    local out
    out="$("$@" 2>&1)"
    printf '%s\n' "$out" | grep -E 'native entered|PASS|FAIL' || true
    if ! printf '%s\n' "$out" | grep -q "\[vu1_replay\] native $want"; then
      printf 'clamp check: expected "native %s", got: %s\n' \
        "$want" "$(printf '%s\n' "$out" | grep 'native entered')" >&2
      return 1
    fi
    printf '%s\n' "$out" | grep -q '^PASS' || { echo "clamp check: verify did not PASS" >&2; return 1; }
  }
  expect_native "entered=15 ended=0 handbacks=15" \
    env PS2X_VU1_NATIVE_TEST_CEILING=2 "$ROOT/dist/vu1_replay.exe" \
      --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --regs all \
      "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
  expect_native "entered=15 ended=9 handbacks=6" \
    env PS2X_VU1_NATIVE_TEST_CLIP_CEILING=2 "$ROOT/dist/vu1_replay.exe" \
      --verify "$ROOT/tests/fixtures/vu1/dispatch_0x1b50/golden.txt" --native --regs all \
      "$ROOT"/tests/fixtures/vu1/dispatch_0x1b50/*.bin
  echo "tests: ok"
}

case "$STEP" in
  tools)   build_tools ;;
  recomp)  recomp ;;
  runtime) runtime ;;
  release) release ;;
  test)    test_step ;;
  all)     recomp; runtime ;;
  *) echo "unknown step $STEP"; exit 2 ;;
esac
