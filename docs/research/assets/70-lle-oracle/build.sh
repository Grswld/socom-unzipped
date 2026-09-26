#!/usr/bin/env bash
# The LLE oracle's build (Sprint 15 T1, research/70 §5; landed in T1c, see README.md beside this file).
# Run it only under the lock, from the repository's root:
#   export SCRATCH=<a directory outside the repository>
#   bash scripts/loop_lock.sh run <holder> --purpose "LLE oracle build" --class build -- bash "$SCRATCH/oracle/build.sh"
# $SCRATCH holds fork/ (the clone of Sinan-Karakaya/PS2Recomp at e42efbe) and oracle/ (this directory's glue, with
# the patched copy of the fork's ps2xIOP/src/lle/ at oracle/lle/). $REPO is the repository whose tools/ carries
# llvm-mingw, CMake and Ninja; it defaults to the directory the script is started from.
: "${SCRATCH:?set SCRATCH to the scratch directory outside the repository (README.md, Rebuild)}"
REPO="${REPO:-$PWD}"
[ -d "$REPO/tools/llvm-mingw/bin" ] || { echo "no toolchain under $REPO/tools (set REPO to the repository root)"; exit 1; }
export PATH="$REPO/tools/llvm-mingw/bin:$REPO/tools/cmake/bin:$REPO/tools/ninja:/usr/bin:/bin:/c/Windows/System32:$PATH"
cd "$SCRATCH/oracle" || exit 1
{
  echo "build start $(date -u +%FT%TZ)"
  clang++ --version | head -1
  cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_COMPILER=clang++ &&
  echo "PRISTINE skipped (build 1: fails on the two missing includes)"
  cmake --build build --target harness_lle -j 4; echo "HARNESS EXIT $?"
  echo "build end $(date -u +%FT%TZ)"
} > build.log 2>&1
tail -1 build.log
grep -E "EXIT" build.log
