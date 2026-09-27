# Browser recreation of SOCOM II: scoping, and the GPU-in-the-browser landscape (2026-09-20)

Status: research. No design has been approved; this file records what was found so the design can be argued from
facts. Decisions, once made, belong in a spec under `docs/superpowers/specs/`.

The ask: a browser recreation of SOCOM II, starting with a **map viewer**, with a **replay viewer for live
matches** as the next ambition and, further out, the matches themselves. Everything outside a match (lobby,
menus) is to be rebuilt in the browser, simplified and improved. Gameplay is to be as close to source as possible,
mechanically first, visually a close second, reusing as much of this project's native code as possible. The owner
added that if the full game is the easier route, that is an option.

## 1. What is already in hand

### 1.1 Archive formats: solved
- **ZDB** (`RUN/MP*.ZDB`, `RUN/M*.ZDB`): a flat pack. 0xA0 header (`u32 count @0x98`, `u32 entrySize=0x5C @0x9C`),
  then 92-byte entries `{u32 entrySize; char name[64]; u32 dataOffset; u32 dataSize; u32 reserved[4]}` with
  absolute 2048-aligned offsets. Payloads verbatim: **no compression, no encryption**. libdnas2 encryption applies
  only to the two code blobs inside `APACHE00.ZDB`. Spec: `03-socom2-technical.md`; re-verified live on `MP1.ZDB`
  (53 entries). Multiplayer maps are 8.0 to 12.7 MB each; single-player 14.7 to 17.3 MB.
- **ZAR / ZED**: `11-recom-applicability.md` gives the full layout (100-byte head, string table, 16-byte keys
  `{name_ofs, offset, size, child_count}` in pre-order, aligned data blob; V2 = `0x20002`, retail `flags=0`, plain).
  A `.ZED` is a ZAR whose keys are the node tree. `MP1_GEO.ZED` has 25,945 keys.
- **Not usable**: `research/socom-archive-manager` (Go, compiles to wasm) keys off a V6/V7 header word that retail
  SOCOM II map ZDBs do not have; it silently loads nothing. Do not build on it.

### 1.2 What a map contains (MP1.ZDB)
`MP1.ZED` (world root: `worldmodel, GlobalLighting, NightMission, LensFX_*, MetersPerUnit, ShadowVector, assetlibs,
cameras, light_list, GriddedTerrain, DefaultMaterial`), `MP1_{TXR,PAL,GEO,MDL}.ZED`, `WORL_MDL.ZED`, asset libraries
`FLIB_*` / `CLIB_*`, `CLUTTER.ZAR`, animation ZARs, `AIMAPS.MPS` (AI nav, its own magic), `READERM.ZAR` (rdr
scripts), and shared `RUN\COMMON\*` HUD, weapon and font assets.

### 1.3 Meshes are PS2 DMA chains, not vertex arrays
The GameZ engine source (`research/recom/src/gamez/zVisual/vis_main.cpp`, `zvis.h`) shows `CVisual` holding a
pre-baked **DMA chain of VIF packets** (`m_dmaChain`, `_word128* m_data`, `m_nextGif`) with relocation tags (types
1 to 7) and texture-name references resolved at load (`CVisual::SetBuffer`). A `_GEO` payload is the data VU1
consumes directly. **Decoding a mesh means running the VIF1 unpack and knowing the VU1 microprogram's input
layout**, both of which this project already has:
- `ps2xRuntime/src/lib/ps2_vif1_interpreter.cpp` (VIF1 unpack),
- `ps2xRuntime/src/lib/vu/` (VU1 interpreter) and `vu/native/` plus `vu/generated/` (native translations of the
  SOCOM II microprograms, keyed by image hash and entry pc; `vu1_known_programs.cpp`),
- the world-object and terrain analyses `13-vu1-family-b-world-objects.md`, `15-vu1-fourth-family.md`,
  `tools_py/research/terrain/README.md`,
- GS texture swizzlers `ps2_gs_psmct32/16/psmt8/psmt4.h` for `_TXR` pages and `_PAL` CLUTs.

No byte-level `_GEO` / `_MDL` spec exists in the tree; reCOM (SOCOM 1, same engine, same compiler) is the best
reference and its `zArchive` is complete.

### 1.4 Collision and spawns
Collision was recovered from RAM, not files: `CCell` grid, `CDIPoly` / `CDIBBox` surfaces, matrix compose
`FUN_001BFC30` (`24-frostfire-walkability.md`). Spawn positions for all 23 MP maps are tabulated in
`33-online-map-coverage.md`.

### 1.5 The game code and the runtime
- 14,879 functions recompiled to C++ (`recomp/output`: 14,882 files, 12.6 M lines, 576 MB). Zero gameplay
  functions are named in the CSV; the roughly 70 known gameplay addresses live in the research docs and
  `socom2.toml`.
- Engine tick 60 Hz (`CGame::Tick` = `FUN_001E7040`). RNG is newlib `rand` (`17-ground-height.md`).
- Netcode: Medius lobby over TCP plus **host-based peer-to-peer UDP** for match traffic (SCE-RT `rt_net`, header
  decoded in `18-online-round-start.md`; only connect, join, ping and clock-sync types are decoded so far. Actor
  state packets are not).
- The runtime already runs the whole EE on **one host thread** (`EeScheduler`, cooperative) plus a render/main
  thread and audio threads; there is no IOP thread (the IOP is HLE). Windowing and GL via raylib 5.5 (GLFW plus
  GLAD); raylib has an Emscripten `PLATFORM_WEB` target. Two GS backends selected by `PS2X_GS_BACKEND`: a hardware
  GS on OpenGL 3.3 core (`gs_gl_backend.cpp`, 3,927 lines, GLSL `330 core`, one optional ARB extension:
  `GL_ARB_clip_control`) and a software GS (`gs_cpu_backend.cpp`, 2,009 lines, "the reference/fallback"; its speed
  at game resolution has not been measured). Linux build ships. Zero Emscripten references in first-party code.
- x86 dependence: 141 SSE4.1 macros in `ps2_runtime_macros.h`; an ARM path exists via sse2neon (`USE_SSE2NEON`),
  and Android and Vita entry points exist, so a wasm-SIMD shim is a known shape of work.

### 1.6 Gating measurements for the whole game in a browser
| Measurement | Value | Verdict |
|---|---|---|
| Largest recompiled function (`sub_003D57D0`, 0x3d57d0 to 0x408480) | 49,375 MIPS instructions, 15.5 MB of C++ | Under the 7,654,321-byte wasm function-body cap of V8 and SpiderMonkey (estimated 1 to 3 MB of wasm). Only 5 generated files exceed 2 MB. |
| Native `.text` of `dist-release/socom2.exe` | **190.8 MB** (plus 36 MB data) | Far over V8's roughly 150 MB compiled-code cache; compiled code is 5 to 7 times the .wasm; first load would be tens of seconds and recompiled on every visit. This is the real blocker. **Superseded 2026-09-21 by measurement (below): the blocker is not real.** |
| Guest memory | 32 MB EE RAM, 4 MB GS VRAM, 2 MB IOP | Fits wasm32; memory64 not needed. |

The 190 MB is a property of the emitted C++ (a `ctx->pc = ...` store per instruction, one translation unit per
function, no dead-function elimination), not of the game. It is a recompiler diet problem and is measurable with
the recompiler and a compiler alone, before any browser work.

### 1.7 Measured 2026-09-21: the whole recompiled game compiles to wasm and loads in under a second
The code-diet spike compiled all 14,882 generated units with Emscripten 6.0.9 (`-O2 -msimd128 -msse4.1`; the SSE
intrinsic headers map onto wasm SIMD unchanged, no header patches) and linked them into one module. Every number
below is measured, not extrapolated.

| | value |
|---|---|
| linked `.wasm` (`emcc -O2`, then `wasm-opt`) | **180.27 MB** (code section 177.2 MB; 17,027 functions) |
| on the wire | 23.6 MB gzip, **13.7 MB brotli** |
| largest function body | 753 KB, 9.8 percent of the 7,654,321-byte cap; none over |
| Chromium compile, cold | **0.2 s** streaming (lazy, the default); 2.3 s eager (all functions, V8) |
| Chromium compile, warm | the same: the module exceeds the code cache, and it does not matter |
| `-Os` instead of `-O2` | larger, 199 MB linked |
| the `elide_pc_stores` diet | 1.6 percent of wasm size (LLVM already removes the same dead stores), but 36 percent less compile time and no more out-of-memory kills on the multi-megabyte units; kept as an opt-in recompiler flag |
| dead functions | a floor of 0.6 percent with no static references; up to 57 percent unreachable over direct edges only, which vtables and function pointers make optimistic; only a runtime trace settles it |

Object-file sums overstate the linked size by about 17 percent (relocation placeholders), which is why the interim
216 MB figure was wrong. Like for like on a sample, wasm is 1.29 times the x86-64 size: there is no free win in the
instruction set, and none is needed. The owner's 30 s first-load budget is not close to threatened.

**What this does and does not settle.** Size and compile time were the gate on the full-game route, and they pass.
Three things still stand between this and a playable browser build, none measured here: the runtime port to
Emscripten (the EE scheduler's cooperative switch and the `switch (ctx->pc)` resume mechanism against the browser's
event loop, the GS, VU1, DMAC and IOP services), memory (180 MB of wasm plus its machine code plus 32 MB of guest
RAM in one renderer), and getting the player's disc image to the page. The web map viewer's archive and asset
layers (`web/`) are the start of the third.

### 1.8 Measured 2026-09-21: the runtime almost compiles, and the one real blocker is the rounding mode
A follow-up probe compiled the runtime's translation units for wasm: **86 of 88 unchanged, 88 of 88 with a
20-line patch** (proposed, not applied). What does not port is semantic, not syntactic:

- **Round-toward-zero.** The EE and VU1 paths set the host FPU to chop through the control register
  (`ps2_runtime.cpp:2555`, `ps2_vu1_core.cpp:2044-2061`) with no software fallback. WebAssembly is permanently
  round-to-nearest with no way to change it, and Emscripten's `xmmintrin.h` lists `_mm_setcsr` as unavailable
  (its `_mm_getcsr` returns a constant). That exposes about 19,600 float-op sites in the generated code. The tree
  already records that SOCOM II's title-screen labels only compose correctly under chop
  (`ps2_runtime.cpp:2548-2553`, `PS2X_EE_ROUND=nearest` breaks them). Flush-to-zero is already software
  (`ps2_runtime_macros.h:150-161`, `:750-760`) and ports free.
- **A non-ulp hazard from the same cause.** The VU1 FMAC fast path detects overflow by comparing against
  `0x7F7FFFFF` (`ps2_vu1_ops.h:196-222`), sound only because chop can never exceed `FLT_MAX`; under
  round-to-nearest a product can become `+inf`, the check misses, and an infinity lands in a VU register on a unit
  that has none. Reasoned from source; `vu1_replay` would confirm it.
- **Threads are not the problem.** Of the runtime's twelve host threads only the EE thread is gameplay-essential;
  the rest are env-gated diagnostics, a test fixture, or platform-only, and the IOP creates none. A
  single-threaded wasm build without SharedArrayBuffer is reachable, but `EeScheduler::run()` must be inverted
  from "loop and wait on a condition variable" to a `step()` driven by the browser's frame callback, since all
  three of its waits are illegal on the main thread; presentation already lives there.

So the browser route's honest state: size and compile time are solved (1.7), the runtime almost compiles, and the
two real tasks are **a software chop for the EE FPU and VU float paths** (the correctness-critical one) and **the
scheduler inversion**. Both belong in the runtime-port spec.

## 2. GPU-in-the-browser options (as of 2026-09-20)

Sources: gpuweb Implementation Status wiki (2026-08-13), Chrome "New in WebGPU" posts through 149-150 (2026-06-17),
WebKit Safari 26.x feature posts, Mozilla Gfx blog (2025-07-15), web3dsurvey, webassembly.org features.json, V8
`wasm-limits.h`, SpiderMonkey `WasmConstants.h`, Emscripten 6.0.9 ChangeLog and emdawnwebgpu README, PCSX2 2.8
release notes and `GSDevice.h`, parallel-gs README and Maister's 2024-07-03 write-up.

### 2.1 WebGPU
- **Shipping**: Chrome and Edge on Windows, Mac, ChromeOS, Android, Linux Intel Gen12+ (144) and NVIDIA on Wayland
  (147); Safari 26 (2025-09-15) on macOS, iOS, iPadOS and visionOS, and Apple now calls it "preferred for new
  sites"; Firefox on Windows (141) and Apple-Silicon Mac (145), Linux and Android behind flags. Field data: a
  working adapter in **82%** of reports (Firefox 58%, Linux 17%) against WebGL2's 97%.
- **Compatibility mode** (Chrome 146, opt-in) runs on GLES 3.1 devices; not in Firefox or Safari.
- **Guaranteed limits**: maxBufferSize 256 MiB, storage binding 128 MiB, uniform binding 64 KiB, workgroup
  256x256x64, 256 invocations, 16 KiB shared, 8 storage buffers per stage, 8 colour attachments, 2D textures 8192.
- **Has**: compute plus storage buffers, subgroups (ballot and shuffle; no clustered ops), timestamp queries (100 us
  quantised), BC, ETC2 and ASTC as optional features, dual-source blending, stencil, `primitive-index`,
  `shader-f16`, push constants (`setImmediates`, Chrome 149), OffscreenCanvas in workers (Chrome 144+, Safari 26+,
  Firefox partial).
- **Lacks**: bindless (proposal; the plan is two browsers behind flags first), texture barrier, framebuffer fetch,
  rasterizer-ordered views, provoking-vertex control, logic ops, general 64-bit or float atomics, i8 and i16
  storage.
- **Readback**: `mapAsync` only; small mappings are disproportionately slow in Chrome; Firefox's IPC path is the
  slow one; Safari has the smallest buffer ceilings.

### 2.2 WebGL2
97% availability, no deprecation signal; WebGL 2.0 Compute is officially obsolete and never shipped. No compute,
SSBO, image load/store, texture barrier, framebuffer fetch, logic ops or map-buffer. `WEBGL_multi_draw` is
effectively absent on Firefox (1.3%). A safe fallback for a *viewer*; a dead end for a GS. Emscripten's GLES3
emulation maps GLSL ES 300 onto it; there is no GLES 3.1 (compute) path.

### 2.3 WebAssembly platform
- Universal: threads (needs cross-origin isolation, COOP plus COEP, or Chrome 137's Document-Isolation-Policy),
  SIMD, final exception handling, tail calls, GC.
- Chrome and Firefox only: memory64 (16 GiB cap, 10 to 100% slower), JSPI (Chrome 137, Firefox 153 on 2026-07-21;
  Safari behind a flag with an engineer assigned), relaxed SIMD.
- Limits (both engines): module 1 GiB, function body 7,654,321 bytes, 50,000 locals, 1,000,000 functions.
- Compile: `compileStreaming` plus Liftoff baseline then tier-up; V8 code cache about 150 MB; Safari 26 added an
  in-place interpreter for large modules. No published numbers for a 200 to 500 MB module; expect tens of seconds.

### 2.4 Toolchains
- **Emscripten 6.0.9** (2026-09-01). WebGPU via `--use-port=emdawnwebgpu` (Dawn-maintained `webgpu.h`); the old
  `-sUSE_WEBGPU` was removed in 4.0.18. GL: a WebGL-friendly GLES 2/3 subset, `-sFULL_ES3` for client arrays and
  copy-based map-buffer, **no GLES 3.1+**. Off-main-thread rendering via `-sOFFSCREENCANVAS_SUPPORT` or
  `-sOFFSCREEN_FRAMEBUFFER` with `-sPROXY_TO_PTHREAD`. `-sJSPI` non-experimental since 6.0.8; Asyncify costs
  about 50% in size and speed. raylib builds for `PLATFORM_WEB` with Emscripten.
- **Rust wgpu 30** targets WebGPU and WebGL2 from one codebase (it is Firefox's implementation). Zig: no
  first-party WebGPU. WASI-SDK: no GPU.
- **Engines**: three.js r186 `WebGPURenderer` with automatic WebGL2 fallback (still "experimental" per its manual
  but widely used); Babylon.js 9.0 WebGPU and WebGL2 first-class; PlayCanvas WebGPU beta; Filament web is WebGL2;
  Bevy via wgpu (one wasm per backend); Godot 4 web is WebGL2 only; Unity 6.6 WebGPU production.

### 2.5 Alternatives
- **Pixel streaming**: 80 to 150 ms in native clients, over 300 ms measured in browsers; a T4 or L4 box is $380 to
  $590 a month serving a handful of sessions. A spectator tool at best, and out of character for a $12-a-month
  project.
- **Browser emulators of comparable machines**: Play!.js (WebGL2, "an experiment"), wasm-dolphin (software
  rasterizer, WebGPU used only to present, Chrome-only, Melee "can approach 100%"), PPSSPP-web, N64 via
  ParaLLEl-RDP in wasm. No PCSX2-in-wasm, no N64Recomp-in-wasm, and nobody has shipped a hardware-accelerated
  PS2 GS in a browser.

### 2.6 Porting a GS to WebGPU
- **PCSX2's hardware GS** needs texture barriers, framebuffer fetch or ROV for accurate blending; WebGPU has none,
  so a port lands on the `multidraw_fb_copy` copy-loop tier everywhere, PCSX2's slowest, universal path.
- **parallel-gs** (compute rasterizer, Vulkan): VRAM as one 4 MiB SSBO, tile-based deferred, hazard tracking at
  256-byte blocks, subgroup ballots. Needs bindless, 8 and 16-bit storage, subgroup size control. On WebGPU:
  subgroups yes, `subgroup-size-control` in the spec draft, 8 and 16-bit via pack/unpack, and **bindless is
  avoidable** because all of GS VRAM fits one storage binding and can be sampled by hand. parallel-rdp is the
  bit-exact proof of the approach. Nobody has done it for WebGPU yet.

## 3. Options matrix

| Option | Today | In 12 months | Key risk |
|---|---|---|---|
| A. Map and replay viewer in three.js or Babylon (WebGPU with WebGL2 fallback), geometry decoded from the ZDBs by new code | Yes, all browsers | Same | Getting the mesh decode right without the game's own code |
| B. Map decoder as a C++ library reusing the runtime's VIF1, VU1 and GS code, compiled to wasm, rendered by A | Yes on all browsers (the decoder is CPU-side wasm) | Same | Emscripten build of a slice of the runtime; SSE shim |
| C. Whole recomp in the browser, existing GL 3.3 GS via Emscripten GL emulation (WebGL2), or the software GS with the GPU as a blitter | Code size measured fine (1.7); the GL path loses clip-control and any barrier-class feature; the software path's speed is unmeasured | WebGL2 gains nothing | Runtime port, throughput |
| D. Whole recomp in the browser, GS rewritten as WebGPU compute (parallel-gs design) | Code size measured fine (1.7); Chrome, Edge, Safari and Firefox Windows/Mac; needs COOP/COEP, worker rendering, JSPI or Asyncify | Bindless behind flags; Safari JSPI plausible; Firefox Linux and Android | Largest item on the list; no precedent |
| E. Pixel-stream the desktop build | Yes; latency and $400 to $600 a month per box | Better transports | Not a way to play; recurring cost |
| F. Server renders replays to video | Yes | Same | Not interactive |

## 4. Facts that bear on the design
- The decoder is where "as close to source as we can get" is won for a viewer: the only faithful mesh decode is
  the VIF and VU1 path the game runs. Rendering a static map is not where fidelity is at stake; running the
  simulation later is.
- "Mechanically identical" gameplay in a browser has exactly one route: run the recompiled game code (C or D). A
  hand-written JavaScript re-implementation can never be identical. Both are gated on the code diet in 1.6, which
  is measurable with the recompiler alone and is worth measuring before any other browser work, because a good
  result makes the map viewer free (the game renders the map) and a bad one settles the question for a year.
- The project's legal stance is that the player supplies the disc. A browser client that keeps that stance reads
  the user's ISO locally (File System Access API or drag-and-drop) and parses ISO9660 in the browser
  (`tools_py/iso_lbn.py` has the logic; the guest already does exactly this from raw sectors). Nothing
  copyrighted is hosted. Hosting pre-extracted maps on s2u would be a change of stance.
- Replay capture needs actor-state packet decoding that does not exist yet; the match model is host-based P2P, so
  a replay recorder is either a participating peer or a tap on the DME relay. This is research, not engineering,
  and belongs after the viewer.
