# macOS arm64 Port (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build SOCOM II from the owner's r0001 disc into a native arm64 macOS program that boots to the title,
walks the menus and plays a mission with picture, sound and movies.

**Architecture:** Extend the repository's existing POSIX/Linux path to Darwin. A new `scripts/build_macos.sh`
drives the same CMake tree with AppleClang and the arm64 Homebrew tools; a handful of `#if` sites gain Darwin
branches; FFmpeg is built from pinned source inside CMake. Renderer stays raylib + OpenGL 3.3 core (GL 4.1 on
macOS).

**Tech Stack:** C++20 (AppleClang 17), CMake 4.3 + Ninja (arm64, `/opt/homebrew`), raylib 5.5 (GLFW, miniaudio),
sse2neon v1.9.1, FFmpeg 7.1.5 (static, source), Python 3.13 + Unicorn/Capstone (venv).

**Spec:** `docs/superpowers/specs/2026-10-01-macos-arm64-port-design.md`

## Global Constraints

- Target: macOS arm64 only (`CMAKE_OSX_ARCHITECTURES=arm64`, `CMAKE_OSX_DEPLOYMENT_TARGET=13.0`).
- Tools come from `/opt/homebrew/bin` (arm64). Nothing from `/usr/local` (Intel Homebrew) is linked or put first on
  `PATH`.
- Compiler: AppleClang, `/usr/bin/clang` and `/usr/bin/clang++`.
- FFmpeg: 7.1.5, `https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz`,
  sha256 `de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f`, LGPL, static, no `--enable-gpl`.
- Disc: `$HOME/SOCOM II - U.S. Navy SEALs (USA).iso` (r0001, verified). Its contents, the overlays and
  the generated C++ are never committed.
- Every `#if` change: widen a plain-POSIX Linux branch to `defined(__linux__) || defined(__APPLE__)`, or add an
  `__APPLE__` branch with the Darwin equivalent. Windows and Linux behaviour must not change.
- Commits: stage with `git add -- <paths>`, commit with `git commit -m "..." -- <paths>` (the repository's rule:
  no bare `git add`, no `-A`, no commit without paths). Never `--no-verify`. Message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Build products go to `dist-macos/` and `third_party/ps2recomp/build-macos*/` (already git-ignored).
- Comment style: match the surrounding code -- short prose comments that say why, citing the task
  ("macOS port, phase 1").

## Review Focus

1. **Retina display:** on a 2x screen the game image fills the whole window, not its bottom-left quarter --
   Task 11 pins it with a screenshot check at the default and a resized window size.
2. **Paths with spaces and parentheses:** the ISO's name has both; `disc_to_elf` and every script quote it --
   Task 9 runs against the real file name.
3. **Running from another working directory:** the runner finds its own files by its executable's folder, not
   the cwd -- Task 5's test asserts `ExeDir::get()` is the binary's folder; Task 10 launches from `/tmp`.
4. **No pad connected:** keyboard still walks the menus and nothing crashes; a pad plugged in later is picked up
   -- Task 12 checks both.
5. **Audio device absent or changed:** no output device is non-fatal (the runtime's own rule); switching output
   (e.g. AirPods) mid-run does not crash -- Task 12 checks it.

---

### Task 1: Python venv and `scripts/build_macos.sh` (tools step)

**Files:**
- Create: `scripts/build_macos.sh`
- Modify: `.gitignore` (add `/.venv/`)

**Interfaces:**
- Produces: `scripts/build_macos.sh [tools|recomp|runtime|test|all] [--no-runner]`; build trees
  `$PS2R/build-macos-tools`, `$PS2R/build-macos`; output `dist-macos/`. Later tasks fill `recomp` (Task 9),
  the goldens call (Task 7). The script exports `PYTHON` from `.venv/bin/python` when the venv exists.

- [ ] **Step 1: Create the venv and install the pinned requirements**

```bash
cd $HOME/socom-unzipped
/Library/Frameworks/Python.framework/Versions/3.13/bin/python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -c "import unicorn, capstone, numpy, PIL, zstandard, yaml, platform; print(platform.machine(), unicorn.__version__)"
```

Expected: last line `arm64 2.1.4`.

- [ ] **Step 2: Ignore the venv**

Append to `.gitignore`:

```
# macOS port: the Python venv scripts/build_macos.sh uses (requirements.txt, pinned)
/.venv/
```

Run: `git check-ignore -v .venv/x` — Expected: `.gitignore:<n>:/.venv/	.venv/x`.

- [ ] **Step 3: Write `scripts/build_macos.sh`**

```bash
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
# The venv holds requirements.txt's pins; scripts/python_env.sh honours $PYTHON.
if [ -z "${PYTHON:-}" ] && [ -x "$ROOT/.venv/bin/python" ]; then
  export PYTHON="$ROOT/.venv/bin/python"
fi
. "$ROOT/scripts/python_env.sh"
socom_require_python build_macos

export PATH="/opt/homebrew/bin:$PATH"
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
  cmake_configure "$TOOLBUILD" >/dev/null
  cmake --build "$TOOLBUILD" --target ps2_recomp ps2_analyzer -j "$JOBS"
}

recomp() {
  echo "build_macos: recomp is added in Task 9" >&2
  return 2
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
```

Then: `chmod +x scripts/build_macos.sh`.

- [ ] **Step 4: Run the tools step**

Run: `scripts/build_macos.sh tools && file third_party/ps2recomp/build-macos-tools/ps2xRecomp/ps2_recomp`
Expected: `... Mach-O 64-bit executable arm64`.

- [ ] **Step 5: Commit**

```bash
git add -- scripts/build_macos.sh .gitignore
git commit -m "build(macos): scripts/build_macos.sh, the arm64 build driver (tools step), and the venv ignore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- scripts/build_macos.sh .gitignore
```

---

### Task 2: FFmpeg from source on macOS

**Files:**
- Modify: `third_party/ps2recomp/ps2xRuntime/CMakeLists.txt` (insert an `elseif(APPLE)` branch before the
  `else()` at ~line 205 that holds the pkg-config branch)

**Interfaces:**
- Produces: the same `ffmpeg` INTERFACE target the other branches produce (consumed by `ps2_runtime` at ~line 507).

- [ ] **Step 1: Confirm today's state fails**

Run: `rm -rf third_party/ps2recomp/build-macos && scripts/build_macos.sh runtime --no-runner 2>&1 | grep -iE 'ffmpeg|pkg-config|libavcodec' | head -3`
Expected: the pkg-config branch fails to find arm64 FFmpeg (or finds none).

- [ ] **Step 2: Add the branch**

```cmake
elseif(APPLE)
    # macOS port, phase 1: FFmpeg 7.1.5 (the Windows pin's version) from source, static and LGPL, with only what
    # Kernel/Stubs/MPEG.cpp opens -- the MPEG-2 video decoder and parser -- plus swscale and swresample. Nothing
    # from Homebrew: an Intel Homebrew's dylibs are x86_64 and cannot link into an arm64 runner. The hash is the
    # tarball's from ffmpeg.org, taken 2026-10-01.
    include(ExternalProject)

    set(FFMPEG_PREFIX_DIR "${CMAKE_BINARY_DIR}/ThirdParty/ffmpeg-prefix")
    set(FFMPEG_INSTALL_DIR "${FFMPEG_PREFIX_DIR}/install")
    set(FFMPEG_INCLUDE_DIR "${FFMPEG_INSTALL_DIR}/include")
    set(FFMPEG_LIB_DIR "${FFMPEG_INSTALL_DIR}/lib")
    # An imported target may not name an include directory that does not exist yet at configure time.
    file(MAKE_DIRECTORY "${FFMPEG_INCLUDE_DIR}")

    if(CMAKE_OSX_ARCHITECTURES)
        set(PS2X_FFMPEG_OSX_ARCH "${CMAKE_OSX_ARCHITECTURES}")
    else()
        set(PS2X_FFMPEG_OSX_ARCH "${CMAKE_SYSTEM_PROCESSOR}")
    endif()
    if(PS2X_FFMPEG_OSX_ARCH STREQUAL "arm64")
        set(PS2X_FFMPEG_ARCH aarch64)
    else()
        set(PS2X_FFMPEG_ARCH x86_64)
    endif()
    set(PS2X_FFMPEG_FLAGS "-arch ${PS2X_FFMPEG_OSX_ARCH}")
    if(CMAKE_OSX_DEPLOYMENT_TARGET)
        string(APPEND PS2X_FFMPEG_FLAGS " -mmacosx-version-min=${CMAKE_OSX_DEPLOYMENT_TARGET}")
    endif()

    include(ProcessorCount)
    ProcessorCount(PS2X_FFMPEG_JOBS)
    if(PS2X_FFMPEG_JOBS EQUAL 0)
        set(PS2X_FFMPEG_JOBS 4)
    endif()

    ExternalProject_Add(ffmpeg_external
        URL "https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz"
        URL_HASH SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE
        PREFIX "${FFMPEG_PREFIX_DIR}"
        CONFIGURE_COMMAND <SOURCE_DIR>/configure
            --prefix=${FFMPEG_INSTALL_DIR}
            --cc=/usr/bin/clang
            --arch=${PS2X_FFMPEG_ARCH}
            --extra-cflags=${PS2X_FFMPEG_FLAGS}
            --extra-ldflags=${PS2X_FFMPEG_FLAGS}
            --enable-static --disable-shared --enable-pic
            --disable-programs --disable-doc --disable-network --disable-autodetect
            --disable-everything
            --enable-decoder=mpeg2video --enable-parser=mpegvideo
            --enable-avcodec --enable-avformat --enable-avutil --enable-swscale --enable-swresample
        BUILD_COMMAND make -j${PS2X_FFMPEG_JOBS}
        INSTALL_COMMAND make install
        BUILD_BYPRODUCTS
        "${FFMPEG_LIB_DIR}/libavformat.a"
        "${FFMPEG_LIB_DIR}/libavcodec.a"
        "${FFMPEG_LIB_DIR}/libswscale.a"
        "${FFMPEG_LIB_DIR}/libswresample.a"
        "${FFMPEG_LIB_DIR}/libavutil.a"
    )

    # Static archives: the order is the dependency order (avformat -> avcodec -> swscale/swresample -> avutil).
    set(PS2X_FFMPEG_TARGETS)
    foreach(lib avformat avcodec swscale swresample avutil)
        add_library(ffmpeg_${lib} STATIC IMPORTED GLOBAL)
        set_target_properties(ffmpeg_${lib} PROPERTIES
            IMPORTED_LOCATION "${FFMPEG_LIB_DIR}/lib${lib}.a"
            INTERFACE_INCLUDE_DIRECTORIES "${FFMPEG_INCLUDE_DIR}"
        )
        add_dependencies(ffmpeg_${lib} ffmpeg_external)
        list(APPEND PS2X_FFMPEG_TARGETS ffmpeg_${lib})
    endforeach()

    add_library(ffmpeg INTERFACE)
    target_link_libraries(ffmpeg INTERFACE ${PS2X_FFMPEG_TARGETS})
```

`--extra-cflags=${PS2X_FFMPEG_FLAGS}` contains a space; ExternalProject passes each list element as one argument,
so it arrives as one. Verify in Step 3's configure log (`ThirdParty/ffmpeg-prefix/src/ffmpeg_external-stamp/
ffmpeg_external-configure-*.log`): the line `C compiler` and `ARCH aarch64`.

- [ ] **Step 3: Build and check**

```bash
scripts/build_macos.sh runtime --no-runner || true   # configures; the runtime itself fails on SIMD until Task 3
cmake --build third_party/ps2recomp/build-macos --target ffmpeg_external
P=third_party/ps2recomp/build-macos/ThirdParty/ffmpeg-prefix/install
lipo -info $P/lib/libavcodec.a                      # expected: architecture: arm64
grep -E '^#define CONFIG_MPEG2VIDEO_DECODER 1' $P/../src/ffmpeg_external/config_components.h \
  || grep -rE 'CONFIG_MPEG2VIDEO_DECODER 1' $P/../src/ffmpeg_external-build/config_components.h
```

Expected: arm64; the decoder enabled.

- [ ] **Step 4: Commit**

```bash
git add -- third_party/ps2recomp/ps2xRuntime/CMakeLists.txt
git commit -m "build(ffmpeg): macOS builds FFmpeg 7.1.5 from pinned source -- static, LGPL, MPEG-2 only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- third_party/ps2recomp/ps2xRuntime/CMakeLists.txt
```

---

### Task 3: arm64 SIMD — route every x86 intrinsics include through sse2neon; x87 rounding x86-only

**Files:**
- Modify: `third_party/ps2recomp/ps2xRuntime/include/runtime/ps2_vu1.h:8`
- Modify: `third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_upper.cpp:10`
- Modify: `third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_ops.h:16`
- Modify: `third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_core.cpp:18` and `VuRoundingScope` (~2150-2172)
- Modify: `third_party/ps2recomp/ps2xTest/src/vu1_ops_tests.cpp:22`

**Interfaces:**
- Consumes: `USE_SSE2NEON` (defined by the top-level `CMakeLists.txt` on ARM targets).
- Produces: `ps2_runtime` and `vu1_replay` compile for arm64. No API change.

- [ ] **Step 1: Confirm the failure**

Run: `scripts/build_macos.sh runtime --no-runner 2>&1 | grep -m3 'only meant to be used on x86'`
Expected: matches (`xmmintrin.h:14:2: error: "This header is only meant to be used on x86 and x64 architecture"`).

- [ ] **Step 2: Replace each direct include**

In `ps2_vu1.h`, `ps2_vu1_upper.cpp`, `ps2_vu1_ops.h`, `vu1_ops_tests.cpp`, replace the line `#include <emmintrin.h>`
with:

```cpp
#if defined(USE_SSE2NEON)
#include "sse2neon.h"
#else
#include <emmintrin.h>
#endif
```

In `ps2_vu1_core.cpp`, replace `#include <xmmintrin.h>` with the same block using `<xmmintrin.h>`.

- [ ] **Step 3: Compile the x87 half of `VuRoundingScope` on x86 only**

In `ps2_vu1_core.cpp`, replace the struct body with:

```cpp
    // Saves the x87 control word and MXCSR, sets both rounding controls to "toward zero"
    // (x87 RC = 11b at bits 10-11, MXCSR RC = 11b at bits 13-14) and restores them on request.
    // arm64 (macOS port): there is no x87; long double is double, and sse2neon's _mm_setcsr sets FPCR's
    // rounding mode, which governs scalar and NEON math alike -- so the MXCSR half alone is the whole scope.
    struct VuRoundingScope
    {
        uint16_t x87 = 0;
        uint32_t mxcsr = 0;
        VuRoundingScope()
        {
#if defined(__x86_64__) || defined(__i386__)
            __asm__ __volatile__("fnstcw %0" : "=m"(x87));
            const uint16_t x87Tz = static_cast<uint16_t>(x87 | 0x0C00u);
            __asm__ __volatile__("fldcw %0" : : "m"(x87Tz));
#endif
            mxcsr = _mm_getcsr();
            _mm_setcsr(mxcsr | 0x6000u);
        }
        void restore() const
        {
#if defined(__x86_64__) || defined(__i386__)
            __asm__ __volatile__("fldcw %0" : : "m"(x87));
#endif
            _mm_setcsr(mxcsr);
        }
    };
```

(The x86 order of operations changes only in that `_mm_getcsr` now follows the x87 lines; both are reads/writes of
independent registers, so x86 behaviour is identical.)

- [ ] **Step 4: Build**

Run: `scripts/build_macos.sh runtime --no-runner 2>&1 | grep -E ' error:|FAILED:' | head`
Expected: only `posix_glue.cpp` errors (`pipe2`, `sigtimedwait`) remain — fixed in Task 4. Confirm the runtime
library alone: `cmake --build third_party/ps2recomp/build-macos --target ps2_runtime vu1_replay` exits 0.

- [ ] **Step 5: Verify round-toward-zero really takes on arm64**

Add to `vu1_ops_tests.cpp`, in the suite that tests the FMAC flag path (search `TestSuite` there; add as a new
`tc.Run`), this test:

```cpp
        tc.Run("_mm_setcsr's round-toward-zero bits chop scalar double math (and long double on arm64)", [](TestCase &t)
        {
            // FENV_ACCESS: without it the compiler may move the divisions across the mode switches.
#pragma STDC FENV_ACCESS ON
            const unsigned int saved = _mm_getcsr();
            volatile double one = 1.0, ten = 10.0;
            volatile long double ld1 = 1.0L, ld10 = 10.0L;
            _mm_setcsr(saved | 0x6000u);
            const volatile double q = one / ten;
            const volatile long double lq = ld1 / ld10;
            _mm_setcsr(saved);
            const volatile double qNearest = one / ten;
            // 0.1 rounds UP to nearest in binary64 (0x3FB999999999999A); chopped it is the value below (...99).
            t.IsTrue(q < qNearest, "the scope's MXCSR bits chop a double division");
#if defined(__aarch64__)
            // arm64: long double is double, under the same FPCR -- the reason VuRoundingScope needs no x87 half.
            t.IsTrue(lq < static_cast<long double>(qNearest), "and a long double one");
#else
            (void)lq;
#endif
        });
```

Run: `cmake --build third_party/ps2recomp/build-macos --target ps2x_tests && (cd third_party/ps2recomp/build-macos/ps2xTest && ./ps2x_tests 2>&1 | grep -A2 'round-toward-zero bits chop')`
Expected: `[Passed]`. (`ps2x_tests` links the launcher glue, so it builds once Task 4 lands; run this check at the end of
Task 4.)

- [ ] **Step 6: Commit**

```bash
git add -- third_party/ps2recomp/ps2xRuntime/include/runtime/ps2_vu1.h third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_upper.cpp third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_ops.h third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_core.cpp third_party/ps2recomp/ps2xTest/src/vu1_ops_tests.cpp
git commit -m "fix(vu1): arm64 builds -- x86 intrinsics through sse2neon, the x87 rounding control on x86 only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- third_party/ps2recomp/ps2xRuntime/include/runtime/ps2_vu1.h third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_upper.cpp third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_ops.h third_party/ps2recomp/ps2xRuntime/src/lib/vu/ps2_vu1_core.cpp third_party/ps2recomp/ps2xTest/src/vu1_ops_tests.cpp
```

---

### Task 4: Launcher POSIX glue on Darwin (`pipe2`, `sigtimedwait`)

**Files:**
- Modify: `third_party/ps2recomp/ps2xLauncher/src/posix_glue.cpp` (anonymous namespace ~line 50; call sites ~507,
  512, 574, 670)

**Interfaces:**
- Produces: `bool pipeCloexec(int fds[2])` in `posix_glue.cpp`'s anonymous namespace (file-local).

- [ ] **Step 1: Add the helper at the top of the anonymous namespace (before `onPath`)**

```cpp
    // pipe2(fds, O_CLOEXEC), which Darwin does not have (macOS port): both ends close on exec. The two fcntl
    // calls leave a window a concurrent fork could inherit through; the launcher forks only from this thread.
    bool pipeCloexec(int fds[2])
    {
        if (::pipe(fds) != 0)
            return false;
        ::fcntl(fds[0], F_SETFD, FD_CLOEXEC);
        ::fcntl(fds[1], F_SETFD, FD_CLOEXEC);
        return true;
    }
```

- [ ] **Step 2: Replace the three `pipe2` calls**

`::pipe2(toChild, O_CLOEXEC) != 0` → `!pipeCloexec(toChild)`;
`::pipe2(fromChild, O_CLOEXEC) != 0` → `!pipeCloexec(fromChild)` (two sites).

- [ ] **Step 3: Replace the `sigtimedwait` drain with the portable form**

Replace:

```cpp
            const struct timespec none = {0, 0};
            while (::sigtimedwait(&pipeSet, nullptr, &none) > 0)
            {
            }
```

with:

```cpp
            // Consume a SIGPIPE the write raised while it was blocked. sigpending + sigwait rather than
            // sigtimedwait, which Darwin does not have (macOS port); sigwait returns at once for a pending one.
            sigset_t pending;
            while (::sigpending(&pending) == 0 && sigismember(&pending, SIGPIPE))
            {
                int sig = 0;
                ::sigwait(&pipeSet, &sig);
            }
```

- [ ] **Step 4: Build everything**

Run: `scripts/build_macos.sh runtime --no-runner && cmake --build third_party/ps2recomp/build-macos --target ps2x_tests`
Expected: exit 0; `dist-macos/` has `socom_unzipped_launcher` and `vu1_replay`.

- [ ] **Step 5: The launcher's own tests pass**

Run: `cd third_party/ps2recomp/build-macos/ps2xTest && ./ps2x_tests 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^\[Suite\]: (Launcher|Posix|Win32Glue)' -A40 | grep -E 'Failed' ; echo done`
Expected: no `Failed` lines before `done`. Then run Task 3 Step 5's rounding test.

- [ ] **Step 6: Commit**

```bash
git add -- third_party/ps2recomp/ps2xLauncher/src/posix_glue.cpp
git commit -m "fix(launcher): POSIX glue builds on Darwin -- pipe + FD_CLOEXEC, sigpending/sigwait drain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- third_party/ps2recomp/ps2xLauncher/src/posix_glue.cpp
```

---

### Task 5: `ExeDir` on Darwin (executable path, platform name)

**Files:**
- Modify: `third_party/ps2recomp/ps2xShared/src/exe_dir.cpp`
- Test: `third_party/ps2recomp/ps2xTest/src/bare_run_tests.cpp:139-146`

**Interfaces:**
- Produces: `ExeDir::get()` returns the running binary's folder on macOS; `ExeDir::platformName()` returns
  `"macos"` on Darwin.

- [ ] **Step 1: Write the failing test**

In `bare_run_tests.cpp`, replace line 145's assertion with:

```cpp
            const std::string platform = ExeDir::platformName();
            t.IsTrue(platform == "windows" || platform == "linux" || platform == "macos", "and the platform has a name on every host we build on");
#if defined(__APPLE__)
            t.Equals(platform, std::string("macos"), "Darwin names itself");
            // Review focus 3: the folder is the binary's, not the cwd -- the suite runs from build-macos/ps2xTest.
            t.IsTrue(fs::exists(ExeDir::get() / "ps2x_tests"), "ExeDir::get() is the folder ps2x_tests itself is in");
#endif
```

- [ ] **Step 2: Run it, see it fail**

Run: `cmake --build third_party/ps2recomp/build-macos --target ps2x_tests && (cd /tmp && $HOME/socom-unzipped/third_party/ps2recomp/build-macos/ps2xTest/ps2x_tests 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -A4 "the stamp and the executable's folder")`
Expected: `[Failed]` with `Darwin names itself` and `ExeDir::get() is the folder ps2x_tests itself is in`
(the cwd fallback returns `/tmp`). Running from `/tmp` is deliberate.

- [ ] **Step 3: Implement**

In `exe_dir.cpp`, change the non-Windows include block to:

```cpp
#else
#include <unistd.h>
#if defined(__APPLE__)
#include <climits>
#include <cstdlib>
#include <mach-o/dyld.h>
#endif
#endif
```

Replace the `#else` branch of `get()` (the `readlink` block) with:

```cpp
#elif defined(__APPLE__)
        // macOS port: no /proc. _NSGetExecutablePath may name the binary through a symlink or with "..";
        // realpath makes it the file itself, as /proc/self/exe is on Linux.
        char raw[PATH_MAX];
        uint32_t size = sizeof(raw);
        if (_NSGetExecutablePath(raw, &size) == 0)
        {
            char resolved[PATH_MAX];
            if (::realpath(raw, resolved) != nullptr)
                return std::filesystem::path(resolved).parent_path();
            return std::filesystem::path(raw).parent_path();
        }
#else
        char buf[4096];
        const ssize_t n = ::readlink("/proc/self/exe", buf, sizeof(buf) - 1);
        if (n > 0 && static_cast<size_t>(n) < sizeof(buf))
        {
            buf[n] = '\0';
            return std::filesystem::path(buf).parent_path();
        }
#endif
```

And in `platformName()` add before `#else`:

```cpp
#elif defined(__APPLE__)
        return "macos";
```

- [ ] **Step 4: Run it, see it pass**

Same command as Step 2. Expected: `[Passed]`.

- [ ] **Step 5: Find any other consumer of `platformName()` that lists platforms**

Run: `grep -rn 'platformName()' third_party/ps2recomp tools_py --include='*.cpp' --include='*.h' --include='*.py' | grep -v exe_dir`
For each hit that compares against `"linux"`/`"windows"`, make `"macos"` take the Linux (POSIX) branch where the
code is POSIX, and note it in the commit message. If there are none, say so in the commit message.

- [ ] **Step 6: Commit**

```bash
git add -- third_party/ps2recomp/ps2xShared/src/exe_dir.cpp third_party/ps2recomp/ps2xTest/src/bare_run_tests.cpp
git commit -m "feat(shared): ExeDir on Darwin -- _NSGetExecutablePath + realpath, platform name macos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- third_party/ps2recomp/ps2xShared/src/exe_dir.cpp third_party/ps2recomp/ps2xTest/src/bare_run_tests.cpp
```

---

### Task 6: The C++ suite green on macOS

**Files:** determined by triage. Expected: the 989snd conductor test crash (`ps2xRuntime/src/lib/snd989/*` or
the test in `ps2xTest/src/socom2_audio_tests.cpp`).

**Interfaces:** none new.

- [ ] **Step 1: Run the whole suite in the real tree**

```bash
cd $HOME/socom-unzipped/third_party/ps2recomp/build-macos/ps2xTest
./ps2x_tests > /tmp/ps2x_tests_macos.log 2>&1; echo "exit=$?"
sed 's/\x1b\[[0-9;]*m//g' /tmp/ps2x_tests_macos.log | grep -B1 -A3 'Failed\]'
```

Record the exit code, the pass count (`grep -c Passed`) and every failure.

- [ ] **Step 2: For a crash, get the backtrace**

```bash
lldb --batch -o run -o 'bt 25' -o 'frame variable' -- ./ps2x_tests > /tmp/ps2x_crash.txt 2>&1; tail -60 /tmp/ps2x_crash.txt
```

- [ ] **Step 3: Triage each failure with superpowers:systematic-debugging**

Classify each as (a) port bug — fix it here, with a failing-test-first cycle where the existing test is the
failing test; (b) Windows-only behaviour the test assumes — guard the assertion the way the file already does for
Linux (`#if defined(_WIN32)` blocks); (c) a pre-existing bug that also fails on Linux — fix it if small, record it
otherwise. Never weaken an assertion to make it pass. Known candidates and their likely class:
  - conductor test SIGSEGV: probably (a) — `char` is unsigned on arm64 Linux but **signed** on Apple arm64 like
    x86, so check instead for `long` width, unaligned access through a cast pointer (fine on arm64), uninitialised
    memory, or out-of-bounds reads that x86 tolerates by luck. Read the backtrace before guessing.

- [ ] **Step 4: Re-run until the suite exits 0**

Run Step 1 again. Expected: `exit=0`, no `Failed`. Confirm the FFmpeg-backed tests (Task 2) are among the passes:
`sed 's/\x1b\[[0-9;]*m//g' /tmp/ps2x_tests_macos.log | grep -iE 'mpeg|ipu' | grep -E 'Passed|Failed'` -- every
line `[Passed]`.

- [ ] **Step 5: Commit each fix separately**, one commit per root cause, message naming the test and the cause:

```bash
git add -- <files of this fix>
git commit -m "fix(<area>): <cause> (ps2x_tests '<test name>' on macOS arm64)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <files of this fix>
```

---

### Task 7: VU1 replay goldens on macOS (`scripts/vu1_goldens.sh`)

**Files:**
- Create: `scripts/vu1_goldens.sh`
- Reads (copied from): `build.sh` lines 283-459 (the test step's runs 1-9 and `vram_diff_check`)

**Interfaces:**
- Produces: `bash scripts/vu1_goldens.sh <path-to-vu1_replay>` — exit 0 when every run passes. Consumed by
  `scripts/build_macos.sh test` (Task 1 already calls it when present).

- [ ] **Step 1: Create the script from `build.sh`'s block**

```bash
sed -n '283,459p' build.sh   # read it whole first; confirm it starts at the "Four verify runs" comment and ends at run 9
```

Create `scripts/vu1_goldens.sh` with this header, then the block's lines **verbatim** (comments included), then
nothing else:

```bash
#!/usr/bin/env bash
# The VU1 replay goldens (build.sh's test step, runs 1-9), as one script any platform's build runs with its own
# vu1_replay binary: bash scripts/vu1_goldens.sh <vu1_replay>. macOS port, phase 1: build_macos.sh calls this;
# build.sh keeps its inline copy for now (its Python test copies build.sh alone into a temp tree).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VU1="${1:?usage: vu1_goldens.sh <vu1_replay>}"
mkdir -p "$ROOT/logs"
```

In the pasted block replace every `"$ROOT/dist/vu1_replay.exe"` with `"$VU1"`:

```bash
sed -i '' 's|"\$ROOT/dist/vu1_replay.exe"|"$VU1"|g' scripts/vu1_goldens.sh
grep -c 'vu1_replay.exe' scripts/vu1_goldens.sh   # expected 0 outside comments: inspect any hit
```

If the block defines helper functions (`expect_native`, `vram_diff_check`), they come along verbatim. If the block
references a variable defined earlier in `build.sh`'s `test_step` (check with
`grep -oE '\$\{?[A-Za-z_]+' scripts/vu1_goldens.sh | sort -u`), define it in the header with the same value.

- [ ] **Step 2: Run it**

Run: `bash scripts/vu1_goldens.sh dist-macos/vu1_replay; echo "exit=$?"`
Expected: every verify line `PASS`, the native counts as `build.sh` documents, `exit=0`.

- [ ] **Step 3: If a golden differs**

Use superpowers:systematic-debugging. First suspects, in order: (1) the rounding scope not taking (Task 3 Step 5's
test should already have caught it); (2) an sse2neon op whose NaN/denormal semantics differ from SSE (`_mm_min_ps`,
`_mm_max_ps` NaN order; flush-to-zero); (3) `long double` reaching a path that is not under the scope. Fix the cause
in the runtime; never edit a golden.

- [ ] **Step 4: Commit**

```bash
git add -- scripts/vu1_goldens.sh
git commit -m "test(vu1): scripts/vu1_goldens.sh -- build.sh's replay goldens for any platform's vu1_replay; green on macOS arm64

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- scripts/vu1_goldens.sh
```

---

### Task 8: The Python suite on macOS

**Files:** determined by triage (expected: tests that assume `sys.platform` is `win32` or `linux`).

- [ ] **Step 1: Run it**

```bash
cd $HOME/socom-unzipped
.venv/bin/python -m unittest discover -s tools_py/tests -t . > /tmp/py_suite_macos.log 2>&1; echo "exit=$?"
grep -E '^(FAIL|ERROR):' /tmp/py_suite_macos.log | sort | uniq -c | sort -rn
tail -5 /tmp/py_suite_macos.log
```

- [ ] **Step 2: Triage, one cause at a time**

For each failing test, read it and classify as in Task 6 Step 3. The repository's convention for a test that
cannot run on a platform is `@unittest.skipUnless(sys.platform == "win32", "<why>")` or `skipIf`; match how the
Linux CI skips the same test (`grep -n skip <file>`). A test that asserts Linux-specific behaviour of code that
should work on macOS (e.g. a `sys.platform.startswith("linux")` branch in the code under test) gets the code fixed:
`sys.platform == "darwin"` takes the POSIX branch.

- [ ] **Step 3: Re-run until exit 0** (Step 1). Record pass/skip counts.

- [ ] **Step 4: Commit per cause**

```bash
git add -- <files>
git commit -m "fix(tools_py): <cause> on macOS (<test ids>)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <files>
```

---

### Task 9: Disc to ELF, and the recomp step

**Files:**
- Modify: `scripts/build_macos.sh` (the `recomp()` stub)

**Interfaces:**
- Consumes: `game/overlays/socom2_game.elf`, `game/disc/SCUS_972.75`, `game/overlays/ftscore.bin`,
  `game/overlays/zsealetc.bin` (written by `disc_to_elf`); `recomp/socom2.toml`.
- Produces: `recomp/output/*.cpp` (generated, ignored), `game/disc/socom2_game.elf`.

- [ ] **Step 1: Extract and decrypt from the real ISO (review focus 2: spaces and parentheses in the name)**

```bash
cd $HOME/socom-unzipped
PYTHON=.venv/bin/python bash scripts/disc_to_elf.sh "$HOME/SOCOM II - U.S. Navy SEALs (USA).iso" 2>&1 | tee /tmp/disc_to_elf.log | tail -20
PYTHON=.venv/bin/python bash scripts/disc_to_elf.sh --check
```

Expected: the r0001 line (`extract: SCUS_972.75 is the r0001 boot ELF (sha256 0172dc0bec19c83d...)`), every stage
verified against `tools_py/disc_to_elf_expected.json`, `--check` all done. About ten minutes, 4.2 GB.
If a Unicorn stage fails on arm64, debug with superpowers:systematic-debugging; the expected-hash file says which
product is wrong.

- [ ] **Step 2: Replace the `recomp()` stub**

```bash
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
  build_tools
  (cd "$ROOT/recomp" && "$TOOLBUILD/ps2xRecomp/ps2_recomp" socom2.toml > recomp_run.log 2>&1) \
      || { tail -20 "$ROOT/recomp/recomp_run.log"; exit 1; }
  echo "recomp: $(ls "$GEN" | wc -l | tr -d ' ') files, unhandled=$(grep -c unhandled-instruction "$ROOT/recomp/recomp_run.log" || true), unmapped=$(grep -c unmapped-continuation "$ROOT/recomp/recomp_run.log" || true)"
  grep -E '^ *\[(info|warning)\] names - ' "$ROOT/recomp/recomp_run.log" | sed -e 's/^ *\[warning\] names - /WARNING: names: /' -e 's/^ *\[info\] names - /recomp: names: /' || true
}
```

Before pasting, diff against `build.sh`'s current `recomp()` (`sed -n '/^recomp() {/,/^}/p' build.sh`) and carry
over any line added since this plan was written.

- [ ] **Step 3: Run it and compare with the Windows numbers**

Run: `scripts/build_macos.sh recomp`
Expected: `recomp: N files, unhandled=U, unmapped=M` and `recomp: names: Loaded ... display names`. The
recompiler's output does not depend on the host; compare N/U/M with `docs/KNOWN.md` or `docs/DEVELOPING.md`
(`grep -n 'unhandled=' docs/*.md`) — they must match exactly. A difference is a recompiler portability bug
(e.g. iteration order of an unordered container): debug it before going on.

- [ ] **Step 4: Commit**

```bash
git add -- scripts/build_macos.sh
git commit -m "build(macos): the recomp step -- merged ELF and ps2_recomp, as build.sh's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- scripts/build_macos.sh
```

---

### Task 10: The runner, and `run.sh` on macOS

**Files:**
- Modify: `run.sh`

**Interfaces:**
- Consumes: `recomp/output/` (Task 9), FFmpeg (Task 2).
- Produces: `dist-macos/socom2` (arm64); `./run.sh [seconds]` launches it on macOS.

- [ ] **Step 1: Build the runner, watching memory**

```bash
scripts/build_macos.sh runtime 2>&1 | tee /tmp/runner_build.log | tail -5
file dist-macos/socom2
```

Expected: `Mach-O 64-bit executable arm64`. If the build is killed or the machine swaps hard
(`memory_pressure` reports critical), re-run with `PS2X_MACOS_RUNNER_JOBS=4`; record the value that works in the
script's default and its comment. If a generated file fails to compile, the error is in the runtime headers the
generated code includes, not the generated file: fix the header.

- [ ] **Step 2: Teach `run.sh` the macOS runner and a `timeout` fallback**

Replace the line `EXE="${SOCOM_EXE:-$ROOT/dist/socom2.exe}"` with:

```bash
# macOS port: the runner is dist-macos/socom2 there; the default elsewhere is unchanged.
case "$(uname -s)" in
  Darwin) DEFAULT_EXE="$ROOT/dist-macos/socom2" ;;
  *)      DEFAULT_EXE="$ROOT/dist/socom2.exe" ;;
esac
EXE="${SOCOM_EXE:-$DEFAULT_EXE}"
```

Replace the two lines from `timeout "$SECS" "$EXE" "$ELF" "$@" > "$LOG" 2>&1` through its `echo "exit=$? ..."` with:

```bash
# Base macOS has no timeout(1): use it (or coreutils' gtimeout) when present, else the same thing by hand,
# exiting 124 on expiry as timeout does, so the harness reads one code everywhere.
if command -v timeout >/dev/null 2>&1; then
  timeout "$SECS" "$EXE" "$ELF" "$@" > "$LOG" 2>&1; rc=$?
elif command -v gtimeout >/dev/null 2>&1; then
  gtimeout "$SECS" "$EXE" "$ELF" "$@" > "$LOG" 2>&1; rc=$?
else
  "$EXE" "$ELF" "$@" > "$LOG" 2>&1 &
  pid=$!
  ( sleep "$SECS"; kill -TERM "$pid" 2>/dev/null && : > "$LOG.expired" ) &
  watcher=$!
  wait "$pid"; rc=$?
  kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
  if [ -e "$LOG.expired" ]; then rc=124; rm -f "$LOG.expired"; fi
fi
echo "exit=$rc log=$LOG exe=$EXE lines=$(wc -l < "$LOG")"
```

- [ ] **Step 3: Check the fallback in isolation**

```bash
SOCOM_EXE=/bin/sleep SOCOM_GAME_ELF=30 PATH=/usr/bin:/bin ./run.sh 2   # sleep 30, killed at 2 s
```

Expected: `exit=124 ...`. And `SOCOM_EXE=/usr/bin/true SOCOM_GAME_ELF=x PATH=/usr/bin:/bin ./run.sh 5` prints
`exit=0`.

- [ ] **Step 4: First launch, 30 s, from another directory (review focus 3)**

```bash
cd /tmp && $HOME/socom-unzipped/run.sh 30; cd $HOME/socom-unzipped
grep -E '\[window\]|\[gs\]|depth|dual|GL_VERSION|OpenGL|audio|FATAL|error' logs/latest.log | head -40
```

Expected: a window opens; the log names the GL version (4.1), the depth mode (`Legacy` — no `glClipControl`),
dual-source blending available, the audio device ready; no fatal. Record those lines in the commit message.
If it crashes, use superpowers:systematic-debugging with `lldb -- dist-macos/socom2 game/disc/socom2_game.elf`.

- [ ] **Step 5: Commit**

```bash
git add -- run.sh
git commit -m "run.sh: the macOS runner (dist-macos/socom2) and a timeout(1) fallback exiting 124

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- run.sh
```

---

### Task 11: Retina — the picture fills the window

**Files:**
- Modify: `third_party/ps2recomp/ps2xRuntime/src/lib/gs/gs_gl_backend.cpp:1534`
- Check: `third_party/ps2recomp/ps2xRuntime/src/lib/ps2_runtime.cpp` ~3065-3200 (the present, incl. `integer`)

**Interfaces:** none new.

- [ ] **Step 1: See the bug (review focus 1)**

Launch `./run.sh 40`, and at ~25 s take a window screenshot:

```bash
screencapture -x -o -l "$(osascript -e 'tell application "System Events" to get id of first window of (first process whose name is "socom2")' 2>/dev/null)" /tmp/title_before.png \
  || screencapture -x /tmp/title_before.png
```

Read the PNG. Expected bug: the image occupies the bottom-left quarter of the window (raylib's viewport is reset
in points, the framebuffer is in pixels at 2x).

- [ ] **Step 2: Fix the viewport restore**

At `gs_gl_backend.cpp:1534` replace:

```cpp
    glViewport(0, 0, GetScreenWidth(), GetScreenHeight());
```

with:

```cpp
    // The default framebuffer is in pixels; GetScreenWidth/Height are in points, which differ under
    // FLAG_WINDOW_HIGHDPI on a Retina (2x) display or a scaled Windows desktop (macOS port). raylib sets its own
    // viewport from the render size, so this restores exactly what it expects.
    glViewport(0, 0, GetRenderWidth(), GetRenderHeight());
```

- [ ] **Step 3: Audit the rest of the present path for points-vs-pixels**

Run: `grep -nE 'GetScreenWidth|GetScreenHeight|GetRenderWidth|GetRenderHeight|glViewport|glScissor' third_party/ps2recomp/ps2xRuntime/src/lib/ps2_runtime.cpp third_party/ps2recomp/ps2xRuntime/src/lib/gs/*.cpp`
Rule: raylib drawing calls (`DrawTexturePro`, `BeginTextureMode`) take **points** — leave those; raw `gl*` calls on
the default framebuffer (FBO 0) take **pixels** — use `GetRenderWidth/Height`. Fix any raw call that uses screen
size. The `integer` present stage (`PS2X_PRESENT_FILTER=integer`) computes `k = floor(fit scale)`; if it sizes its
stage from screen points, compute the scale from render pixels so the replication is exact on 2x.

- [ ] **Step 4: Verify at the default size, resized, and with each present filter**

```bash
./run.sh 40 &  sleep 25; screencapture -x /tmp/title_after.png; wait
PS2X_WINDOW_SIZE=1280x896 ./run.sh 40 & sleep 25; screencapture -x /tmp/title_1280.png; wait
PS2X_PRESENT_FILTER=integer ./run.sh 40 & sleep 25; screencapture -x /tmp/title_integer.png; wait
```

Read each PNG: the title image fills the window (letterboxed to aspect), sharp, no quarter-frame. Also drag-resize
the window during one run and confirm the picture follows.

- [ ] **Step 5: Commit**

```bash
git add -- third_party/ps2recomp/ps2xRuntime/src/lib/gs/gs_gl_backend.cpp <any other file fixed in step 3>
git commit -m "fix(gs): restore raylib's viewport in framebuffer pixels, not window points -- Retina showed a quarter frame

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- third_party/ps2recomp/ps2xRuntime/src/lib/gs/gs_gl_backend.cpp <any other file fixed in step 3>
```

---

### Task 12: Play it, and write it down

**Files:**
- Modify: `docs/DEVELOPING.md` (a "macOS (arm64)" subsection beside the Linux build section)
- Modify: `docs/superpowers/plans/2026-10-01-macos-arm64-port.md` (append `## Log` with results)

- [ ] **Step 1: Interactive session, keyboard only, no pad connected (review focus 4)**

Run `PS2X_DEV=1 dist-macos/socom2 game/disc/socom2_game.elf` (no timeout) with the pad unplugged. Walk title →
main menu → single player by keyboard (key map: `docs/FAQ.md`, "keyboard"). Screenshot each screen. Expected: no
crash, menu sounds audible, menu music plays.

- [ ] **Step 2: Pad, hot-plugged (review focus 4)**

With the game at the main menu, connect the owner's pad (USB or Bluetooth). Expected: the pad drives the menu
without a restart; `[pad]`/`[input]` log lines show it detected. Enter a mission; play 2 minutes: movement, aim,
fire, the HUD. Screenshot in mission.

- [ ] **Step 3: The intro movie**

From a fresh launch, let the intro FMV play. Expected: real frames (not the stub pattern), sound in sync.

- [ ] **Step 4: Audio device change (review focus 5)**

During the mission, switch macOS output (System Settings → Sound, or connect AirPods). Expected: no crash. Note
whether sound follows to the new device; if it does not, record it as a phase-2 item (miniaudio device-change
handling), not a phase-1 blocker. Also launch once with `PS2X_AUDIO_DEVICE` pointing at nothing, or with output
muted at the system level, and confirm the "no audio device is non-fatal" rule holds (`grep -i audio logs/latest.log`).

- [ ] **Step 5: Frame time**

Read the runtime's frame-time line from the mission log (`grep -E 'FRAME|frame ms|\[vu1-stats\]' logs/latest.log |
tail`), and record it against Windows' ~27 ms (`docs/KNOWN.md`).

- [ ] **Step 6: Document the Mac build in `docs/DEVELOPING.md`**

Add, next to the Linux build section (`grep -n -i 'linux' docs/DEVELOPING.md | head` to find it):

```markdown
### macOS (Apple Silicon)

Phase 1 of the macOS port: the game from your own disc, offline, native arm64. Needs Xcode Command Line Tools
(AppleClang), and the **arm64** Homebrew at `/opt/homebrew` with `cmake` and `ninja` (`brew install cmake ninja`).
An Intel Homebrew under `/usr/local` is not used and cannot be: its libraries are x86_64.

    python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
    PYTHON=.venv/bin/python bash scripts/disc_to_elf.sh "<your ISO>"
    scripts/build_macos.sh            # tools, recomp, runtime -> dist-macos/socom2
    scripts/build_macos.sh test       # Python suite, ps2x_tests, VU1 replay goldens
    ./run.sh 60                       # or: dist-macos/socom2 game/disc/socom2_game.elf

FFmpeg is built from source by the CMake tree (7.1.5, static, MPEG-2 only) on first configure. The generated
runner compiles with at most `PS2X_MACOS_RUNNER_JOBS` (default <value from Task 10>) jobs to fit 16 GB.
Rendering is OpenGL 4.1 (macOS's ceiling): `glClipControl` is absent, so depth runs the `Legacy` path. Not yet
on macOS: the launcher flow, online, the microphone, an app bundle.
```

- [ ] **Step 7: Write the log and commit**

Append to this plan:

```markdown
## Log

- <date>: phase 1 result -- <title/menu/mission/movie/audio: each ok or the issue>; frame time <n> ms;
  depth mode <Legacy>; ps2x_tests <passes>/<total>; Python <passes>, <skips>; VU1 goldens <ok>;
  runner jobs <n>. Screenshots: <paths>. Open items for phase 2: <list>.
```

```bash
git add -- docs/DEVELOPING.md docs/superpowers/plans/2026-10-01-macos-arm64-port.md
git commit -m "docs: the macOS arm64 build (phase 1) and its result

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- docs/DEVELOPING.md docs/superpowers/plans/2026-10-01-macos-arm64-port.md
```
