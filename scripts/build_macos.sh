#!/usr/bin/env bash
# macOS arm64 build (macOS port, phase 1): the same CMake tree as build.sh and scripts/build_linux.sh, with
# AppleClang and the arm64 Homebrew tools under /opt/homebrew.
#
# Usage: scripts/build_macos.sh [tools|recomp|runtime|test|all] [--no-runner]
#   tools     configure + build ps2_recomp / ps2_analyzer in build-macos-tools
#   recomp    the merged ELF from the disc (scripts/disc_to_elf.sh first), then the recompiler -> recomp/output
#   runtime   the runner (when there is generated code), the launcher, vu1_replay -> dist-macos
#   test      the Python suite, ps2x_tests, and the VU1 replay goldens (scripts/vu1_goldens.sh); every verdict
#             prints, non-zero if any failed
#   all       tools + recomp + runtime (the default)
#   --no-runner   no generated code (PS2X_RUNNER_GENERATED_DIR=""): what a Mac without the disc can build.
#
# An Intel Homebrew under /usr/local is never used: its libraries are x86_64 and cannot link into an arm64
# program. FFmpeg is built from source by the CMake tree (ps2xRuntime/CMakeLists.txt, the APPLE branch).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Refused up front, as they would otherwise fail deep inside a build (final review, I5):
# FFmpeg's configure cannot build out of tree from a path with whitespace;
case "$ROOT" in
  *[[:space:]]*) echo "build_macos: the checkout path has whitespace in it ($ROOT); FFmpeg's configure cannot build there -- move the checkout" >&2; exit 2 ;;
esac
# and an x86_64 shell, or no arm64 cmake, falls back to Rosetta and an Intel Homebrew's cmake, which never sees an
# ARM target (no sse2neon) and fails on the first x86 intrinsics header.
if [ "$(uname -m)" != arm64 ] || [ ! -x /opt/homebrew/bin/cmake ] || [ ! -x /opt/homebrew/bin/ninja ]; then
  echo "build_macos: needs an arm64 shell (uname -m: $(uname -m)) and the arm64 Homebrew's cmake and ninja: /opt/homebrew/bin/brew install cmake ninja" >&2
  exit 2
fi
# The venv holds requirements.txt's pins. Its bin/ goes first on PATH -- what activating it does -- so
# scripts/python_env.sh, the one place an interpreter is chosen, finds it, and so do the scripts the suite runs.
if [ -x "$ROOT/.venv/bin/python" ]; then
  export PATH="$ROOT/.venv/bin:$PATH"
fi
. "$ROOT/scripts/python_env.sh"
socom_require_python build_macos

export PATH="/opt/homebrew/bin:$PATH"
# pkg-config's default search path includes /usr/local/lib/pkgconfig, so even the arm64 pkg-config resolves an
# Intel Homebrew's x86_64 libraries; PKG_CONFIG_LIBDIR replaces that default with the arm64 prefix alone.
export PKG_CONFIG_LIBDIR="/opt/homebrew/lib/pkgconfig:/opt/homebrew/share/pkgconfig"
CC="${CC:-/usr/bin/clang}"
CXX="${CXX:-/usr/bin/clang++}"
export CC CXX

PS2R="$ROOT/third_party/ps2recomp"
TOOLBUILD="$PS2R/build-macos-tools"
RTBUILD="$PS2R/build-macos"
GEN="${PS2X_RUNNER_GENERATED_DIR:-$ROOT/recomp/output}"
DIST="$ROOT/dist-macos"
JOBS="$(sysctl -n hw.ncpu)"
# The generated runner is unity-built at -O1: each compiler peaks at several GB, so a 16 GB Mac caps it.
RUNNER_JOBS="${PS2X_MACOS_RUNNER_JOBS:-6}"

STEP=""
for arg in "$@"; do
  case "$arg" in
    --no-runner) GEN="" ;;
    tools|recomp|runtime|test|all) STEP="$arg" ;;
    *) echo "unknown argument $arg" >&2; exit 2 ;;
  esac
done
STEP="${STEP:-all}"

cmake_configure() {   # $1 = build dir, rest = extra -D flags
  local build_dir="$1"; shift
  cmake -S "$PS2R" -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
        -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
        -DPython3_EXECUTABLE="$PYTHON" "$@"
}

build_tools() {
  # The recompiler and analyzer need no FFmpeg; configuring them without it keeps the tools independent of it.
  cmake_configure "$TOOLBUILD" -DPS2X_ENABLE_FFMPEG=OFF >/dev/null
  cmake --build "$TOOLBUILD" --target ps2_recomp ps2_analyzer -j "$JOBS"
}

recomp() {
  # build.sh's recomp step, with this platform's recompiler binary (no .exe).
  local lte
  lte="$(cat "$ROOT/recomp/loader_text_end.txt")"
  "$PYTHON" "$ROOT/tools_py/make_overlay_elf.py" "--loader-text-end=$lte" \
      "$ROOT/game/overlays/socom2_game.elf" "$ROOT/game/disc/SCUS_972.75" \
      "$ROOT/game/overlays/ftscore.bin" "$ROOT/game/overlays/zsealetc.bin"
  cp "$ROOT/game/overlays/socom2_game.elf" "$ROOT/game/disc/socom2_game.elf"
  "$PYTHON" "$ROOT/tools_py/fix_ghidra_csv.py" "$ROOT/recomp/socom2_ghidra.csv" "$ROOT/recomp/extra_functions.txt" \
      --out "$ROOT/recomp/build/socom2_ghidra.fixed.csv"
  build_tools   # incremental; the recompiler embeds the runtime call list, keep it in sync
  (cd "$ROOT/recomp" && "$TOOLBUILD/ps2xRecomp/ps2_recomp" socom2.toml > recomp_run.log 2>&1) \
      || { tail -20 "$ROOT/recomp/recomp_run.log"; exit 1; }
  echo "recomp: $(ls "$GEN" | wc -l | tr -d ' ') files, unhandled=$(grep -c unhandled-instruction "$ROOT/recomp/recomp_run.log" || true), unmapped=$(grep -c unmapped-continuation "$ROOT/recomp/recomp_run.log" || true)"
  grep -E '^ *\[(info|warning)\] names - ' "$ROOT/recomp/recomp_run.log" | sed -e 's/^ *\[warning\] names - /WARNING: names: /' -e 's/^ *\[info\] names - /recomp: names: /' || true
}

configure_runtime() {
  cmake_configure "$RTBUILD" \
        -DPS2X_RUNNER_GENERATED_DIR="$GEN" \
        -DPS2X_ENABLE_LTO="${LTO:-OFF}" \
        -DPS2X_GENERATED_OPT="${GENOPT:--O1}" \
        -DPS2X_GAME_REVISION=r0001 >/dev/null
}

install_exe() {   # $1 = built file, $2 = name in dist-macos; copy then rename, so a running copy is never torn
  cp "$1" "$DIST/$2.new" && mv -f "$DIST/$2.new" "$DIST/$2"
}

runtime() {
  configure_runtime
  mkdir -p "$DIST"
  if [ -n "$GEN" ] && compgen -G "$GEN/*.cpp" >/dev/null; then
    cmake --build "$RTBUILD" --target ps2EntryRunner -j "$RUNNER_JOBS"
    install_exe "$RTBUILD/ps2xRuntime/ps2EntryRunner" socom2
  else
    echo "build_macos: no generated code in '${GEN:-<unset>}' -- building ps2_runtime only (no socom2)"
    cmake --build "$RTBUILD" --target ps2_runtime -j "$JOBS"
  fi
  cmake --build "$RTBUILD" --target socom_unzipped_launcher vu1_replay -j "$JOBS"
  install_exe "$RTBUILD/ps2xLauncher/socom_unzipped_launcher" socom_unzipped_launcher
  install_exe "$RTBUILD/ps2xRuntime/vu1_replay" vu1_replay
  echo "built $DIST: $(ls "$DIST" | tr '\n' ' ')"
}

verdict() {   # $1 = what ran, $2 = its exit code
  if [ "$2" -eq 0 ]; then echo "$1: ok"; else echo "$1: FAILED (exit $2)"; fi
}

test_step() {
  # Every suite runs and every verdict prints (build_linux.sh's shape); non-zero if any failed.
  local py_rc=0 cxx_rc=0 vu_rc=0
  # The harness scripts the Python suite drives (the loop lock, the launch templates, the server box's ops)
  # assume what Git Bash and Linux CI provide: bash >= 4.4 and GNU coreutils (stat -c, date -d). macOS ships
  # bash 3.2 and BSD tools; the arm64 Homebrew's bash (first on PATH above) and coreutils' unprefixed names
  # stand in, for this step only: brew install bash coreutils.
  local gnubin=/opt/homebrew/opt/coreutils/libexec/gnubin
  if [ ! -x /opt/homebrew/bin/bash ] || [ ! -d "$gnubin" ]; then
    echo "build_macos: the Python suite needs the arm64 Homebrew's bash and coreutils: brew install bash coreutils" >&2
    return 2
  fi
  export PATH="$gnubin:$PATH"
  ( cd "$ROOT" && "$PYTHON" -m unittest discover -s tools_py/tests -t . -v ) || py_rc=$?
  if configure_runtime && cmake --build "$RTBUILD" --target ps2x_tests vu1_replay -j "$JOBS"; then
    # ps2x_tests reads ps2xRecomp/include/ps2recomp/instructions.h relative to its own directory.
    ( cd "$RTBUILD/ps2xTest" && ./ps2x_tests ) || cxx_rc=$?
    mkdir -p "$DIST"
    install_exe "$RTBUILD/ps2xRuntime/vu1_replay" vu1_replay
    if [ -f "$ROOT/scripts/vu1_goldens.sh" ]; then
      bash "$ROOT/scripts/vu1_goldens.sh" "$DIST/vu1_replay" || vu_rc=$?
    else
      echo "build_macos: scripts/vu1_goldens.sh not there yet -- goldens not run"; vu_rc=2
    fi
  else
    cxx_rc=2; vu_rc=2
    echo "build_macos: ps2x_tests did not build -- the C++ suite did not run (exit 2 is 'did not measure')"
  fi
  verdict "tests: Python " "$py_rc"
  verdict "tests: C++    " "$cxx_rc"
  verdict "tests: VU1    " "$vu_rc"
  if [ "$py_rc" -ne 0 ] || [ "$cxx_rc" -ne 0 ] || [ "$vu_rc" -ne 0 ]; then
    return 1
  fi
  echo "tests: ok"
}

case "$STEP" in
  tools)   build_tools ;;
  recomp)  recomp ;;
  runtime) runtime ;;
  test)    test_step ;;
  all)     build_tools; recomp; runtime ;;
  *) echo "unknown step $STEP"; exit 2 ;;
esac
