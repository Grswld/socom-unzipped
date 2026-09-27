#!/usr/bin/env bash
# Linux build (Sprint 8 Goal 1, design item 1): the same CMake tree as build.sh, with the system
# toolchain instead of tools/llvm-mingw.
#
# Usage: scripts/build_linux.sh [tools|runtime|release|test|all] [--no-runner]
#   tools     configure + build ps2_recomp / ps2_analyzer in build-linux-tools
#   runtime   configure + build the runner (when there is generated code) and the launcher in build-linux
#   release   the release configuration (Sprint 9 Goal 2) in build-linux-release -> dist-linux-release, stripped,
#             symbols kept;
#             PS2X_RELEASE_KIND=player (default: debug UI and probes compiled out) or developer (both in:
#             build-linux-release-dev -> dist-linux-release-dev), as build.sh release (Sprint 16 R3a, R295)
#   test      the Python suite AND ps2x_tests -- both run, both verdicts print, non-zero if either failed
#   all       tools + runtime (the default)
#   --no-runner   build with no generated code at all: PS2X_RUNNER_GENERATED_DIR="", which skips the
#                 ps2EntryRunner target (see ps2xRuntime/CMakeLists.txt). This is the CI shape -- the
#                 recompiled game is produced from the owner's disc and is not in the repository.
#
# What this deliberately does NOT mirror from build.sh:
#   * the recomp step (make_overlay_elf.py / fix_ghidra_csv.py / ps2_recomp over socom2.toml): it needs
#     the owner's disc image and overlays, which no CI machine and no fresh clone has.
#   * scripts/check_quiet_gate.sh: that is the owner's host-quiet gate (a tasklist probe for a running
#     launch on their desk). Nothing here launches the game.
#   * the vu1_replay verify/vram-diff runs: src/tools/vu1_replay.cpp includes <windows.h> unguarded, so
#     the tool does not build on Linux yet. Restore those runs here once it does.
#   * copying the llvm-mingw and FFmpeg DLLs into dist/: that is the Windows runtime layout.
#     scripts/make_portable.sh grows the Linux lib/ layout in a later task (design item 5).
set -euo pipefail

# BASH_SOURCE, not $0: when this file is SOURCED (tools_py/tests/test_build_linux.py drives
# test_step that way) $0 is the shell, and $0/.. would point somewhere else entirely.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/python_env.sh"   # $PYTHON, resolved once for every script
socom_require_python build_linux
CC="${CC:-clang}"
CXX="${CXX:-clang++}"
export CC CXX

PS2R="$ROOT/third_party/ps2recomp"
TOOLBUILD="$PS2R/build-linux-tools"    # ps2_recomp / ps2_analyzer
RTBUILD="$PS2R/build-linux"            # runtime + tests + launcher (+ runner when there is generated code)
GEN="${PS2X_RUNNER_GENERATED_DIR:-$ROOT/recomp/output}"
DIST="$ROOT/dist-linux"
RELBUILD="$PS2R/build-linux-release"    # Sprint 9 Goal 2: the release configuration, its own tree ...
RELDIST="$ROOT/dist-linux-release"      # ... and its own folder
REL_KIND="${PS2X_RELEASE_KIND:-player}" # Sprint 16 R3a (R295): player|developer, see build.sh release()

STEP=""
for arg in "$@"; do
  case "$arg" in
    --no-runner) GEN="" ;;
    tools|runtime|release|test|all) STEP="$arg" ;;
    *) echo "unknown argument $arg" >&2; exit 2 ;;
  esac
done
STEP="${STEP:-all}"

JOBS="$(nproc)"

cmake_configure() {   # $1 = build dir, rest = extra -D flags
  local build_dir="$1"; shift
  cmake -S "$PS2R" -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" "$@"
}

build_tools() {
  cmake_configure "$TOOLBUILD" >/dev/null
  cmake --build "$TOOLBUILD" --target ps2_recomp ps2_analyzer -j "$JOBS"
}

configure_runtime() {
  cmake_configure "$RTBUILD" \
        -DPS2X_RUNNER_GENERATED_DIR="$GEN" \
        -DPS2X_ENABLE_LTO="${LTO:-OFF}" \
        -DPS2X_GENERATED_OPT="${GENOPT:--O1}" >/dev/null
}

runtime() {
  configure_runtime
  mkdir -p "$DIST"
  if [ -n "$GEN" ] && compgen -G "$GEN/*.cpp" >/dev/null; then
    cmake --build "$RTBUILD" --target ps2EntryRunner -j "$JOBS"
    # copy then rename: a running game holds dist-linux/socom2 open ("Text file busy"); mv replaces the name atomically
    cp "$RTBUILD/ps2xRuntime/ps2EntryRunner" "$DIST/socom2.new" && mv -f "$DIST/socom2.new" "$DIST/socom2"
  else
    echo "build_linux: no generated code in '${GEN:-<unset>}' -- building ps2_runtime only (no socom2)"
    cmake --build "$RTBUILD" --target ps2_runtime -j "$JOBS"
  fi
  cmake --build "$RTBUILD" --target socom_unzipped_launcher -j "$JOBS"
  cp "$RTBUILD/ps2xLauncher/socom_unzipped_launcher" "$DIST/socom_unzipped_launcher.new" && mv -f "$DIST/socom_unzipped_launcher.new" "$DIST/socom_unzipped_launcher"
  # The game ELF is produced by the recomp step on the owner's machine; carry it over when it is there.
  if [ -f "$ROOT/dist/socom2_game.elf" ]; then
    cp "$ROOT/dist/socom2_game.elf" "$DIST/"
  fi
  echo "built $DIST: $(ls "$DIST" | tr '\n' ' ')"
}

release() {   # Sprint 9 Goal 2: see build.sh release(); same switches, the system toolchain, ELF strip
  local genopt="${REL_GENOPT:--O2}" lto="${REL_LTO:-OFF}" scope="${REL_LTO_SCOPE:-all}" icf="${REL_ICF:-}"
  local fc=() src name objcopy tag debug_ui probes
  case "$REL_KIND" in
    player) debug_ui=OFF; probes=OFF ;;
    developer) debug_ui=ON; probes=ON; RELBUILD="$PS2R/build-linux-release-dev"; RELDIST="$ROOT/dist-linux-release-dev" ;;
    *) echo "build_linux: PS2X_RELEASE_KIND=$REL_KIND -- it is player|developer" >&2; return 2 ;;
  esac
  for src in "$RTBUILD"/_deps/*-src; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"; name="${name%-src}"
    fc+=("-DFETCHCONTENT_SOURCE_DIR_$(printf '%s' "$name" | tr 'a-z' 'A-Z')=$src")
  done
  cmake_configure "$RELBUILD" -DPS2X_RUNNER_GENERATED_DIR="$GEN" -DPS2X_GENERATED_OPT="$genopt" \
        -DPS2X_ENABLE_LTO="$lto" -DPS2X_LTO_SCOPE="$scope" \
        -DPS2X_RELEASE_LINK=ON -DPS2X_LINK_ICF="$icf" \
        -DPS2X_ENABLE_DEBUG_UI="$debug_ui" -DPS2X_ENABLE_PROBES="$probes" ${fc[@]+"${fc[@]}"} >/dev/null
  objcopy="${OBJCOPY:-$(command -v llvm-objcopy || command -v objcopy)}"
  tag="$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)"
  mkdir -p "$RELDIST/symbols"
  local built=()
  if [ -n "$GEN" ] && compgen -G "$GEN/*.cpp" >/dev/null; then
    cmake --build "$RELBUILD" --target ps2EntryRunner -j "${REL_JOBS:-$JOBS}"
    cp "$RELBUILD/ps2xRuntime/ps2EntryRunner" "$RELDIST/socom2.new"; built+=(socom2)
  fi
  cmake --build "$RELBUILD" --target socom_unzipped_launcher -j "${REL_JOBS:-$JOBS}"
  cp "$RELBUILD/ps2xLauncher/socom_unzipped_launcher" "$RELDIST/socom_unzipped_launcher.new"; built+=(socom_unzipped_launcher)
  for exe in "${built[@]}"; do
    "$objcopy" --only-keep-debug "$RELDIST/$exe.new" "$RELDIST/symbols/$exe.debug"
    "$objcopy" --strip-all "$RELDIST/$exe.new"
    ( cd "$RELDIST/symbols" && "$objcopy" --add-gnu-debuglink="$exe.debug" "$RELDIST/$exe.new" )
    mv -f "$RELDIST/$exe.new" "$RELDIST/$exe"
    printf '%s %s %s\n' "$tag" "$(sha256sum "$RELDIST/$exe" | cut -d' ' -f1)" "$exe" >> "$RELDIST/symbols/INDEX.txt"
  done
  # The game ELF comes from the recomp step on the owner's machine. In the VM there is no dist/ (the
  # tree sync leaves it on the host), so fall back to the developer Linux folder's copy -- it is the same
  # platform-neutral file, and without it scripts/make_portable.sh --release has nothing to package.
  for elf in "$ROOT/dist/socom2_game.elf" "$DIST/socom2_game.elf"; do
    [ -f "$elf" ] || continue
    cp "$elf" "$RELDIST/"; break
  done
  echo "built $RELDIST, the $REL_KIND kind: $(ls "$RELDIST" | tr '\n' ' ') (genopt=$genopt lto=$lto/$scope icf=${icf:-off} debug_ui=$debug_ui probes=$probes)"
}

verdict() {   # $1 = what ran, $2 = its exit code
  if [ "$2" -eq 0 ]; then echo "$1: ok"; else echo "$1: FAILED (exit $2)"; fi
}

test_step() {
  # BOTH suites run, both verdicts are printed, and the step exits non-zero if either failed.
  #
  # Until Sprint 11 Task 18 the Python line was bare under `set -e`, so a Python failure ended the step
  # and the C++ result was simply not measured. That is what the socom-linux VM's run produced on
  # 2026-09-22: 18 failures and 7 errors in Python, and nothing at all known about ps2x_tests -- a
  # second trip through a 20-minute cycle to learn something the first trip could have said.
  # scripts/build.sh on Windows still stops at the first failing suite; when that is fixed, this is the
  # shape to copy.
  #
  # Python first, exactly as build.sh runs it: one runner, unittest (no pytest), discovered from
  # tools_py/tests with the repo root as the top-level directory.
  local py_rc=0 cxx_rc=0
  ( cd "$ROOT" && "$PYTHON" -m unittest discover -s tools_py/tests -t . -v ) || py_rc=$?
  # ps2x_tests reads ps2xRecomp/include/ps2recomp/instructions.h relative to its own directory.
  local repeat="${PS2X_TEST_REPEAT:-1}"
  if configure_runtime && cmake --build "$RTBUILD" --target ps2x_tests -j "$JOBS"; then
    ( cd "$RTBUILD/ps2xTest" && for i in $(seq 1 "$repeat"); do
        echo "ps2x_tests run $i/$repeat"
        if ! ./ps2x_tests; then
          echo "ps2x_tests run $i/$repeat FAILED"
          exit 1
        fi
      done ) || cxx_rc=$?
  else
    cxx_rc=2
    echo "build_linux: ps2x_tests did not build -- the C++ suite did not run (exit 2 is 'did not measure')"
  fi
  verdict "tests: Python" "$py_rc"
  verdict "tests: C++   " "$cxx_rc"
  if [ "$py_rc" -ne 0 ] || [ "$cxx_rc" -ne 0 ]; then
    return 1
  fi
  echo "tests: ok"
}

# Sourced by tools_py/tests/test_build_linux.py to drive test_step with its four moving parts
# stubbed -- the same testability knob scripts/make_portable.sh carries for MAKE_PORTABLE_SYSTEM
# and LDD. A real run sets it nowhere, and it stops before anything is configured or built.
if [ -n "${BUILD_LINUX_SOURCE_ONLY:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

case "$STEP" in
  tools)   build_tools ;;
  runtime) runtime ;;
  release) release ;;
  test)    test_step ;;
  all)     build_tools; runtime ;;
  *) echo "unknown step $STEP"; exit 2 ;;
esac
