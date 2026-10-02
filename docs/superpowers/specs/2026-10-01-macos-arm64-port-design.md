# macOS arm64 port -- design

Date: 2026-10-01. Branch: `macos-port` (fork first, upstream PRs after).

## Goal

The recompiled SOCOM II, built from the owner's own r0001 disc, runs **natively on Apple Silicon macOS**: boots to
the title, walks the menus, enters a mission and plays it with a pad (keyboard for menus), with picture, sound and
the FMV movies. Phase 1 is offline only.

### Success criteria (phase 1)

1. `scripts/build_macos.sh tools`, `runtime --no-runner` and `test --no-runner` succeed on macOS arm64; the C++
   suite (`ps2x_tests`) and the Python suite pass, every skip or failure explained in this document's log.
2. `scripts/disc_to_elf.sh <iso>` completes on the Mac and verifies against `tools_py/disc_to_elf_expected.json`.
3. `scripts/build_macos.sh recomp` and `runtime` produce `dist-macos/socom2`, an arm64 Mach-O.
4. `./run.sh`-equivalent launch reaches the title screen (screenshot), the main menu by keyboard, and a mission by
   pad; audio audible; the intro movie plays (not stub frames).
5. The VU1 replay goldens pass, or every differing golden is explained (see "long double" below).

### Not in phase 1

The launcher (`ps2xLauncher`), online play, the microphone, the parity gate's Windows-only probes, a signed or
notarized `.app`, a Metal renderer, macOS CI. Each is listed under "Later phases".

## Constraints and facts this rests on

- Machine: M2 Pro, 16 GB, macOS 15 (Darwin 24.6), AppleClang 17 (Xcode CLT). Native Homebrew at `/opt/homebrew`
  (arm64 cmake 4.3.1, ninja, pkgconf). An older Intel Homebrew at `/usr/local` is **never** used by this build:
  its libraries are x86_64 and cannot link into an arm64 binary.
- Python 3.13 (universal, runs arm64); the pinned `requirements.txt` in a venv at `.venv/` (git-ignored).
- The disc: `~/SOCOM II - U.S. Navy SEALs (USA).iso`; its `SCUS_972.75` hashes to the r0001 pin
  `kSocom2R0001ElfSha256` (verified 2026-10-01).
- Renderer: raylib 5.5 (GLFW, miniaudio) with the GS backend's GLSL `#version 330 core`. macOS serves a
  forward-compatible 3.3 core request as GL 4.1. Nothing the backend calls is above 3.3 except `glClipControl`
  (4.5), which is probed at runtime and falls back to the existing `GsGlDepth::Mode::Legacy` path.
- Threads: the window, event pump and presentation run on the main thread (`PS2Runtime::run`), the guest on a
  spawned thread -- the shape Cocoa requires. No change.
- SIMD: the runtime uses SSE intrinsics; the top-level CMake already fetches `sse2neon` on ARM and defines
  `USE_SSE2NEON`. Five later files include `<emmintrin.h>`/`<xmmintrin.h>` directly, bypassing that switch --
  the cause of nearly every arm64 compile error (probe build, 2026-10-01).
- No JIT, no `PROT_EXEC`. One inline-asm site: the x87 rounding scope (section 5).
- Probe build (2026-10-01, a scratch copy with the section 2/5 fixes applied): the runtime library, the tools,
  the launcher and `ps2x_tests` all compile and link on arm64; the C++ suite ran 865 passes, 5 fixture-path
  failures from the out-of-tree probe layout, 1 real gap (`ExeDir::platformName`), and a crash in the 989snd
  conductor test to be triaged in the real tree.

## Approach

Extend the existing POSIX (Linux) path to macOS; keep raylib and OpenGL. Rejected: a Metal backend now (largest
work, delays first boot, upstream has no backend seam yet -- phase 2 candidate); x86_64 under Rosetta (slow on a
game already over its frame budget, a dead end, useless upstream).

The port's rule for every `#if`: where the Linux branch is plain POSIX, widen the guard to
`defined(__linux__) || defined(__APPLE__)`; where it uses a Linux-only facility, add an `__APPLE__` branch with the
Darwin equivalent. No new abstraction layers.

## Design

### 1. Build chain

**`scripts/build_macos.sh`** -- modelled on `scripts/build_linux.sh`, its steps plus `recomp`, minus `release`
(phase 2): `tools | recomp | runtime | test | all`.

- `PATH` puts `/opt/homebrew/bin` first; `CC=clang CXX=clang++` (AppleClang); `CMAKE_OSX_ARCHITECTURES=arm64`;
  `CMAKE_OSX_DEPLOYMENT_TARGET=13.0`.
- Jobs: `sysctl -n hw.ncpu` for the library and tools; the generated runner is capped (`PS2X_MACOS_RUNNER_JOBS`,
  default 6) because unity-built generated code at `-O1` peaks at several GB per compiler on a 16 GB machine.
- Build trees `third_party/ps2recomp/build-macos{,-tools,-release}`, output `dist-macos/` (`socom2`,
  `ps2_recomp`, ...). No `.exe` suffix anywhere.
- `recomp` reuses `build.sh`'s recomp body (`make_overlay_elf.py`, `fix_ghidra_csv.py`, `ps2_recomp socom2.toml`);
  where `build.sh` hard-codes `ps2_recomp.exe`, the macOS script uses the suffix-less name.
- The loop lock (`scripts/loop_lock.sh`) is not consulted, as `build_linux.sh` does not: it guards the
  maintainer's shared Windows host, and a single-developer Mac has nothing to collide with.
- The VU1 replay goldens (`build.sh` test step, runs 1-9) move into `scripts/vu1_goldens.sh <vu1_replay>` for the
  macOS script; `build.sh` keeps its inline copy in phase 1 (its Python test copies `build.sh` alone into a
  temp tree), and adopting the shared script there is an upstream-phase change.

**FFmpeg** -- a new `elseif(APPLE)` branch in `ps2xRuntime/CMakeLists.txt` beside the Windows prebuilt one:
FFmpeg **7.1.5 from source** (the Windows pin's version), `ExternalProject_Add`, URL pinned by sha256, configured
`--disable-everything --disable-programs --disable-doc --disable-network --disable-autodetect --enable-static
--disable-shared --enable-pic --arch=aarch64 --enable-decoder=mpeg2video --enable-parser=mpegvideo` -- the only
codec and parser the runtime opens (`Kernel/Stubs/MPEG.cpp`: `AV_CODEC_ID_MPEG2VIDEO`, `av_parser_init`,
`sws_getContext`) -- with `avformat` (no demuxers), `swscale`, `swresample` built for the existing link list.
LGPL only (no `--enable-gpl`), static, no extra frameworks (`--disable-autodetect` keeps VideoToolbox and
AudioToolbox out). It produces the same five libraries the Linux `pkg_check_modules` branch imports, exposed as
the same `ffmpeg` INTERFACE target, so nothing downstream changes. `-DPS2X_ENABLE_FFMPEG=OFF` remains the escape
hatch.

**Python** -- `.venv` from `requirements.txt`; `scripts/python_env.sh` already honours `$PYTHON`.

### 2. Platform shims (Darwin equivalents of Linux-only code)

| Site | Linux | macOS |
|---|---|---|
| `ps2xShared/src/exe_dir.cpp`, `ps2xLauncher/src/posix_glue.cpp`, `vu1_replay.cpp` | `readlink("/proc/self/exe")` | `_NSGetExecutablePath` + `realpath` |
| `ps2xLauncher/src/posix_glue.cpp` (process lookup) | `/proc/<pid>/exe` | `proc_listallpids` + `proc_pidpath` (libproc) |
| `game_overrides_socom2.cpp` thread names / enumeration | `/proc/self/task/<tid>/comm`, `opendir("/proc/self/task")` | `task_threads` + `pthread_from_mach_thread_np` + `pthread_getname_np`; tid = `pthread_threadid_np` |
| `ThreadNaming.h` | `pthread_setname_np(thread, name)` | `pthread_setname_np(name)` (self only) -- already has an `__APPLE__` branch; verify |
| `vu1_replay.cpp` `--prof` (SIGPROF ring) | `__linux__ && __x86_64__` | not ported in phase 1; the flag reports "unsupported on this platform" |
| `vu1_replay.cpp` unguarded `<windows.h>` | -- | guard it (also unblocks Linux, per `build_linux.sh`'s note) |
| `host_window_chrome_*`, `host_move_loop_win32` | no-op stubs | reuse the POSIX no-op stubs |
| `socom2_hostnet.cpp`, `plugin_loader.cpp`, `bare_run.cpp`, `process_fatal.cpp`, `personas.cpp`, `ps2_save_state.cpp`, `ps2_iop_host.cpp`, `Runtime.h` | POSIX | widen guards; Darwin differences to watch: `MSG_NOSIGNAL` (use `SO_NOSIGPIPE`), `SOCK_CLOEXEC`/`SOCK_NONBLOCK` (use `fcntl`), `dlopen` suffix `.dylib`, `clock_gettime` present, `pipe2` absent |

The full list is produced at implementation time by building and fixing; the table is the expected shape, not a
bound.

### 3. Renderer

- raylib on macOS requests a 3.3 core **forward-compatible** context for `GRAPHICS_API_OPENGL_33`; confirm the
  runtime's raylib build selects it (it is raylib's default desktop API).
- `glClipControl`: unavailable on macOS; the probe returns null and depth runs `Legacy`. Record the chosen mode
  from the log at first boot. If the legacy path shows z-fighting the Windows path does not, that is a phase-2
  item (a reversed-Z or depth-remap shader path), not a phase-1 blocker.
- Dual-source blending (`glBindFragDataLocationIndexed`, `GL_MAX_DUAL_SOURCE_DRAW_BUFFERS`): GL 3.3 core, Apple
  supports 1 buffer -- probe already exists; confirm it passes.
- **Retina**: `FLAG_WINDOW_HIGHDPI` gives a framebuffer 2x the window's points on macOS. Every `glViewport`,
  `glScissor`, `glBlitFramebuffer` and `glReadPixels` that targets the default framebuffer must use
  `GetRenderWidth/Height` (pixels), not `GetScreenWidth/Height` (points). Audit the presentation path; this is the
  one renderer bug I expect to have to fix.
- Deprecation warnings: `-DGL_SILENCE_DEPRECATION` for the runtime target on APPLE.

### 4. Audio and input

- Audio: raylib's miniaudio picks Core Audio. The mix device's period sizing (`mix_device.h`) was tuned for WASAPI;
  measure callback cadence from the existing `audio_cb_trace` at first boot, adjust only if it underruns.
- Microphone: out of scope (needs `NSMicrophoneUsageDescription` in an `.app`); the runtime must start with no mic.
- Pad: GLFW gamepad on macOS (IOKit HID / GameController). `socom2_host_input.cpp`'s Sony vendor check reads the
  GLFW GUID -- same SDL-style layout on macOS; verify with whatever pad the owner uses.
- Keyboard: raylib, unchanged.

### 5. Arithmetic: `long double` and the rounding mode

On Apple arm64 `long double` is `double` (53-bit mantissa), not x87's 64-bit. `ps2_vu1_core.cpp` uses it to
compute "exact" FMAC results, inside `VuRoundingScope`, which sets **round toward zero** on the x87 control word
(`fnstcw`/`fldcw` inline asm -- x86 only, and the one thing that stops `vu1_replay` linking on arm64) and on
MXCSR. Under round-toward-zero the narrower type does not change the answer: chopping the exact value to double
and then to float equals chopping it straight to float, because every float is a double and truncation is
monotone toward zero. So on arm64 the x87 lines are compiled out and the MXCSR half stays: sse2neon's
`_mm_setcsr` maps the rounding bits onto FPCR via `fesetround`, and FPCR governs scalar double, `long double`
and NEON alike. The VU1 replay goldens confirm it; if any differ, the cause is found, never the golden
special-cased.

### 6. Verification

In order, each gate before the next:

1. `build_macos.sh tools` -- `ps2_recomp`, `ps2_analyzer` build; `ps2_recomp --help` runs.
2. `build_macos.sh runtime --no-runner` + `test --no-runner` -- the C++ suite and VU1 replay goldens; the Python
   suite in the venv. Failures triaged as port bug / pre-existing / platform-inapplicable (Windows-only tests
   already skip on Linux; match that).
3. `disc_to_elf.sh` against the ISO -- its own verification against the expected-hash JSON.
4. `build_macos.sh recomp` + `runtime` -- `file dist-macos/socom2` says arm64.
5. Launch for 60 s with the log kept (`run.sh` taught the macOS path: base macOS has no `timeout`, so when
   neither `timeout` nor `gtimeout` is on `PATH`, `run.sh` runs the game in the background and kills it after
   the given seconds), screenshot at title; then interactive: menu by keyboard,
   mission by pad, audio heard, intro movie plays. Screenshots attached to the log.

### 7. Repository hygiene (upstream readiness)

- The repo's own hooks installed (`scripts/install_hooks.sh`): the leak check runs before every commit.
- Commits name their paths (`git commit -- <paths>`), per `CLAUDE.md`.
- Nothing from the disc, the overlays, or the generated C++ is ever committed (`game/`, `recomp/output/`,
  `recomp/build/` are already ignored, and so are `dist-macos/` and `build-macos*/` by the existing `/dist*/` and
`build*/` rules; `.venv/` is not and is added to `.gitignore`).
- Commits are kept split by concern (build script, FFmpeg, each shim, renderer fix) so each maps to a PR.

## Later phases

- **Phase 2:** the launcher on macOS (it is raylib + ImGui; needs the posix_glue shims above); an `.app` bundle
  with Info.plist (mic usage string), ad-hoc signed; online play against the project's test server; macOS CI
  (`macos-14` runner, no-runner build + suites).
- **Phase 3:** a Metal GS backend behind a backend seam, if GL on macOS proves the bottleneck or buggy; Developer
  ID signing and notarization at public release.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Generated-code compile exhausts 16 GB | medium | capped jobs; `PS2X_GENERATED_OPT=-O1` as Windows; drop unity batch size |
| A Windows-assumed type size (`long` 32-bit on Win64, 64-bit on macOS) in the runtime | medium | Linux already has 64-bit `long`; its build passing is evidence this is handled |
| macOS GL driver quirk in the GS backend | medium | `GL_SILENCE`, log every shader compile/link error; the legacy depth path |
| sse2neon semantic gap (e.g. denormals, rounding mode `_MM_SET_ROUNDING_MODE`) | low-medium | the VU1 goldens and the C++ suite catch it; FPCR set explicitly if needed |
| Unicorn decryption stage differs on arm64 | low | `disc_to_elf` verifies every product by hash |
