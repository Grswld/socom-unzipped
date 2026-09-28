# 73. Where a mission frame's time goes (Sprint 16 F0)

Date: 2026-09-27 (the three gates' summaries written 14:24Z, 15:21Z and 15:35Z; the two profiled runs ended 15:43Z
and 15:52Z; this reading 16:00Z-16:55Z, the fix round 17:00Z-17:20Z, by `date -u`). Sprint 16 Task F0 (`docs/superpowers/plans/2026-09-27-sprint-16-tasks.md`
"## Task F0"; its facts in `2026-09-27-sprint-16-tree-facts.md` "## Task F0"). Class S by location
(`docs/DOC_MAINTENANCE.md` §2). One exe throughout: `dist/socom2.exe` sha256 `4cbbb14f698b645c…` (tree `d8af118c`; the
first gate ran under `6d78365c`'s harness, same exe). Every number carries the letter of the command in §8 that
produced it, run from the main tree. Nothing of the disc is here.

The model: the game (EE) thread runs the recompiled code and *records* GS commands (`GSGlBackend::record`, `Submit`,
`UploadImage`, into a shadow VRAM); the thread that called `PS2Runtime::run` *replays* them (`HostRenderFrame` ->
`executeCommands`) and presents through raylib's `EndDrawing`. `PS2X_GS_MAX_PENDING_FRAMES=3` holds the EE at
`VBlankStart` while more than three frames are recorded ahead (`docs/DEVELOPING.md`, "The render backlog and the
guest clock"); `bp_wait_ms=` counts that wait.

## 1. The reading

The top three costs of a mission second, ranked by ms of the GL thread's wall over the post-HUD window (game-thread
run, its GL thread unsampled, §3); rank 3 also shows the upload path's EE-thread half:

| # | Cost | Number | Command |
|---|---|---|---|
| 1 | **The draw path**: `executeSubmit` -> `flushBatch` -> `setupDrawState` -> `resolveTexture` -- the `submit=` bucket of the `[gs-gl stats] calls=` line | **568 ms/s** at 186,969 submits/s (whole-run stacks: 68 % of `flushBatch` under `resolveTexture`, 37 % under `downloadRenderTargetToShadow`) | [A], [S] |
| 2 | **The driver's screenshots**: `ExportImage` (PNG) + `LoadImageFromScreen` every 150 ms on the GL thread (`PS2X_HOST_SCREENSHOT_LATEST`, set at `drive.py:65` for the gate too) | **16.9 % of the GL thread's samples, 169 ms/s**: the union of `ExportImage` (which calls `SaveFileData`) and `LoadImageFromScreen`, 45,869 samples, at a fixed cadence | [S] |
| 3 | **The texture uploads**: `upload=` on the GL thread; the recorder's `shadow=` swizzle and `record=` on the EE thread | **58.8 ms/s on the GL thread** (third, above `readback=` 29.2); both threads, 59 + 18 `shadow=` + 4 `record=` = **81 ms/s**; 10,584 uploads/s, 78.9 % `same_rewritten`, 84.8 % identical bytes | [A], [D], [B], [C] |

Then `readback=` 29 ms/s (75 over the walk, 4 over the tail; 14 ms GPU syncs), `transfer=` 22.5, `present=` 7.0 [A].

**The phase that carries the largest share of the GL thread's second is the draw path -- `GSGlBackend::flushBatch` ->
`setupDrawState` -> `resolveTexture`, the `submit=` bucket at 568 ms/s in the post-HUD window -- and inside it the
largest named function is `GSGlBackend::downloadRenderTargetToShadow`, the GPU-to-CPU read-back of a render target a
texture is sourced from (11.4 % of the GL thread's whole-run samples, 5.8 % of them waiting on the driver in
`NtWaitForSingleObject`) [S], [N].** None of the task book's five phases is the top: of `dirty_rows=`, `decode=`,
`draw=`, `shadow=`, `gl=` the largest is `decode=` at 20.2 ms/s [C], 3 % of the replay -- the trace arms them only
for the flush a *transfer* interrupts (`gs_gl_backend.cpp:1774-1792`), and the mission's flushes come from
`executeSubmit`.

**The EE thread is not within 20 % of the wall: over the post-HUD window it waited on back-pressure 497 ms of every
second (440 in the GL-thread run, where it ran unsampled), so its non-waiting share is at most 503-560 ms/s -- at most
56 % of the wall, while the GL thread's replay alone took 686 ms/s -- and F4 does not fire [E], [B], [A].** Per frame:
30 guest frames a second inside 503 ms is at most 16.8 ms each, against the GL thread's 33.3 ms.

The triggers:

- **F2 fires**, on the `submit=` bucket -- `resolveTexture` and its `downloadRenderTargetToShadow` -- not on a named
  phase; its design must first add the counter (arm the flush phases for every `flushBatch`, or split `submit=`), or
  the halving cannot be measured.
- **F3 fires**: uploads rank third (second among the game's own costs): 78.9 % `same_rewritten`, 84.8 % identical
  bytes [B], [C].
- **F4 does not fire**: the EE thread is at most 56 % of the wall.
- F5: the three quiet gates spread **7.0 %** of their median, under S13-R3's ~10 % (§2).

## 2. The three quiet gates

Line 4 of each `summary.txt`, one exe, the desk idle, no agent building [G]:

```
s16_b2       FRAME mean=28.99 worst1s=38.46 n=2209 (... sampler t=313.2 s (the HUD step) to t=377.2 s (the last step), 64 windows)
s16_f0_gate2 FRAME mean=26.93 worst1s=37.04 n=2489 (... sampler t=296.2 s (the HUD step) to t=363.2 s (the last step), 67 windows)
s16_f0_gate3 FRAME mean=27.09 worst1s=35.71 n=2549 (... sampler t=256.2 s (the HUD step) to t=325.2 s (the last step), 69 windows)
```

Spread = the largest distance from the median, over the median: means 28.99 / 26.93 / 27.09, median **27.09**, largest
distance 1.90 -> **7.0 %**. Worst seconds 38.46 / 37.04 / 35.71: median 37.04, spread 3.8 %. All three: `PINS MATCH
scripts/parity/pins.json (13 compared)`.

## 3. The runs, the sampler, the tools

Two plain runs of the gate's scene (`scripts/parity/gameplay_probe.txt`, 480 s, `--tail 170`), one with
`PS2X_HOST_PROF=1 PS2X_HOST_PROF_STACKS=1` on the game thread (`logs/hostprof_f0_game.txt`, `logs/parity/f0/mission_game.log`),
one with `PS2X_HOST_PROF_MAIN=1` on the thread that called `PS2Runtime::run` (`logs/hostprof_f0_gl.txt`,
`mission_gl.log`), both under `PS2X_PC_SAMPLER=1 PS2X_GS_STATS=1 PS2X_GS_UPLOAD_TRACE=1`. **The post-HUD window**: the
first sampler row at or after the HUD step (drive step s28, t=293.6 s game run / 297.3 s GL run) to the log's end --
`t=294.18`-`484.30` (190.12 s) and `t=298.19`-`481.31` (183.12 s) [E], the bounds in §8; the walk to s48 (361.9 /
368.4 s) where it differs. Stats blocks carry no clock and sit at the sampler row before them (their cumulative
`elapsed=` runs 0.80 s short (game) and 0.51 s over (GL)).

The GL thread's `[gs-gl stats]` clocks are the **game-thread run's**, where it ran unsuspended; the EE-side `shadow=`,
`record=` and `bp_wait_ms` come from both, the GL-thread run's in brackets. A sampled thread's clocks are perturbed:
`transfer=` 22.5 ms/s unsampled, 43.9 sampled; `present=` 7.0 and 24.9; the replay total within 2 % (686 / 677) [A].

The sampler is nominally 1 ms; it landed 269,713 samples over 484.3 s (1.80 ms) and 271,972 over 481.3 s (1.77 ms):
`SuspendThread`, `GetThreadContext`, a 24-frame walk, `std::this_thread::sleep_for(periodMs)`
(`game_overrides_socom2.cpp:2290-2470`, the sleep at :2340). It keeps at most 20,000 distinct stacks: the game
profile hit the cap (244,428 of 269,713 samples have a stack; the 9.4 % missing are the rarest, i.e. work, so §5's
work share is a floor), the GL profile did not (11,555). The profiled runs' own FRAME over the walk read 28.35 (game
run) and 27.98 ms (GL run) [F]: inside the gates' spread, and **not baselines** -- the sampled thread stops every
1.8 ms.

`tools_py/hostprof_symbolize.py` fails on a `PS2X_HOST_PROF_STACKS=1` histogram (`int('stack', 16)`, line 72); the
self-time figures come from a copy without the `stack` lines [S1]. The exe is unstripped; every exe frame resolved.

## 4. The GL thread's second (whole run, 271,972 samples)

Inclusive, from the stacks [S]:

| Function | % | Function | % |
|---|---|---|---|
| `HostRenderFrame` = `executeCommands` | 44.1 | `downloadRenderTargetToShadow` | 11.4 |
| `EndDrawing` | 38.0 | `executeUpload` | 8.3 |
| `flushBatch` / `executeSubmit` | 30.6 / 27.7 | `textureSourceHash` / `decodeTexture` | 6.5 / 4.3 |
| `setupDrawState` / `resolveTexture` | 27.4 / 20.9 | `GSCpuBackend::UploadImage` / `refreshDirtyRows` | 3.3 / 2.9 |
| `ExportImage` (PNG) / `LoadImageFromScreen` | 14.9 / 1.9 | `downloadRenderTargetToCpu` / `snprintf` | 2.1 / 2.0 |

Self [S1]: `<ext> ntdll.dll` 52.7 %, `stbi_zlib_compress` 11.9, `<ext> ucrtbase.dll` 5.7, `<ext> nvoglv64.dll` 4.3,
`textureSourceHash` 3.9, `GSMem::ReadSpan` 3.4, `GSMem::WriteSpan` 3.2, `executeUpload` 3.1.

**The ntdll time** [N] (nearest export at or below each offset; `Nt*+0x14` is a syscall stub's return point):

- `NtDelayExecution+0x14`: 92,860 samples, **34.1 %**, 91,816 under `EndDrawing` -- `Sleep()` in raylib's `WaitTime`:
  `SetTargetFPS(60)` (`ps2_runtime.cpp:841`) pads every iteration shorter than 16.7 ms (`rcore.c:947`; its busy tail
  is the 3.1 % of `glfwGetTime`). **Idle, and the menus'**: before the HUD the replay took 290 ms/s ([A] on
  `mission_gl.log`, this run's own log, *to* its HUD row; the game-thread run's reads 265) and the screenshots 169,
  so the thread slept ~540 ms/s for 297 s = 160 s, the run's whole 164 s of `NtDelayExecution` (92,860 x 1.77 ms); in
  the mission the iterations run 49 ms (20.3 command buffers a second [A]) and the pacing never engages.
- `NtWaitForSingleObject+0x14`: 25,239, **9.3 %** -- the driver waiting for the GPU: 15,731 under
  `downloadRenderTargetToShadow`, 2,367 `refreshDirtyRows`, 2,330 `rlReadScreenPixels`, 1,983 `executePresent`,
  1,435 `downloadRenderTargetToCpu`, 583 `swapBuffersWGL`.
- Minor: `RtlQueryPerformanceCounter` 2.0 %, `NtQueryInformationThread` 1.9 %, `RtlAllocateHeap` 0.8 %,
  `NtFreeVirtualMemory` 0.7 %.
- `ucrtbase.dll` 5.7 %: copies (unexported routines past the `strncpy`/`memcpy` exports) under the read-back,
  `decodeTexture` and the PNG; 1.5 % of `_free_base`/locale calls under `snprintf`. `nvoglv64.dll` 4.3 % (11,683
  samples) and `opengl32.dll` 0.18 % (494) under `flushBatch`/`setupDrawState`: the GL calls themselves.

Two cheap findings: `setupDrawState` formats two stats tags and searches two strings per draw state
**unconditionally** (`gs_gl_backend.cpp:3898-3937`; `s_stats` guards only the print), 2.0 % of the GL thread on every
gate; and `GSMem::WriteSpan` under `GSCpuBackend::UploadImage` runs on **both** threads (3.15 % under
`executeUpload`, 3.35 % under `GS::processGIFPacket` on the EE, §5): every upload is swizzled twice.

## 5. The EE thread's second (whole run, 269,713 samples; 244,428 with stacks)

`NtWaitForAlertByThreadId`: 146,478 samples (146,477 at `+0x14`), **54.3 %** -- the syscall under
`std::condition_variable::wait_until` [N]. The stacks [S] split the 63.5 % under `wait_until` in two: **40.4 %**
`EeScheduler::waitForEvent` (idle: no guest thread runnable) and **23.2 %** `GsFrameBackpressure::frameRecorded` <-
`GSGlBackend::GuestFrameBoundary` <- `processDueDeadlines` (the back-pressure wait). Cross-check: 56,729 samples x
1.80 ms = 102 s against the sampler's cumulative `bp_wait_ms=104420` at t=484.30 [E], within 3 %. The idling is the
run's shape, not the mission's: 59 idle waits a second before the HUD, 13.2 after [E].

Work, 36.5 % of the stacked samples (a floor, §3): `PS2Runtime::dispatchGuestBranch` 31.4 % inclusive -- the
recompiled code and its HLE; `sceMpegDemuxPssRing` 9.2 % of it is the intro movie and briefing cinematic, before the
HUD; `PS2Memory::processPendingTransfers` 12.9 % -- VIF1 to `VU1Interpreter::run` 7.0 %, GIF to
`GS::processGIFPacket` 7.3 %, under it `GSGlBackend::UploadImage` -> `GSCpuBackend::UploadImage` -> `GSMem::WriteSpan`
3.35 %, the recorder's shadow swizzle. Self [S1]: `GSMem::WriteSpan` 3.05 %, `vu1gen_d418194495c25213` 2.90 % (a VU1
microprogram's generated code), `dispatchGuestBranch` 1.22, `sub_0030A860` 1.15 (recompiled, unnamed),
`GS::loadClutIfNeeded` 0.96; `ucrtbase!memcmp` 1.84 % (4,960 samples: by stacks 2,756 under the `vector` insert of
`writeIORegister`/`record`, 1,055 under `PS2Runtime::guestFree`, 627 under `allocateGuestBlockLocked`).

## 6. The post-HUD window, per second

Game-thread run, `t=294.18` to `484.30`; the GL-thread run's readings in brackets.

**The sampler** [E]: 5,703 VBlanks in 190.12 s = **30.0 a second, 33.3 ms each** [33.3 / 30.0 ms]; `bp_wait_ms`
9,830 -> 104,420 = **497.5 ms/s** [11,348 -> 91,912 = 440.0]; `idle` 17,369 -> 19,885 = **13.2 idle waits a second**
[14.3]; `bp_pending=4` in 95 of the 191 rows. The `backpressure` lines agree [B]: 496.8 ms/s, 7.13 waits/s, 30.06
guest frames/s.

**The replay** [A] (ms of every second inside `executeCommands`): `submit=` **568.3** (186,969/s), `upload=` **58.8**
(10,584/s), `readback=` **29.2** (2.1/s), `transfer=` **22.5** (10,584/s), `present=` **7.0** (17.1/s); total **686**
[677]. With the screenshots' 169 that is 855 ms of the GL thread's second; the remaining ~145 (the swap, the poll, the
loop) no instrument splits.

**The flush phases** [C], elapsed-weighted over 64 blocks (transfer-interrupted flushes only, 23,673 real of
2,003,836): `flush=` 21.4 ms/s = `decode=` **20.2** + `draw=` 1.06 + `dirty_rows=` **0.00**; `body=` 0.43; 2,483
decodes. **The upload phases** [D]: `shadow=` **18.4 ms/s** (1.74 us an upload) [20.2], `record=` **4.1** [4.4],
`mark=` 0.04; 13.0 `gl_calls` a second at `convert=` 172 us + `gl=` 26 us = 2.6 ms/s. **The reasons** [B], 2,004,204
uploads: `same_rewritten` **78.9 %** [84.1], `changed` 15.2, `same_free` 5.9 [0.6], `same_gpu` 0.0, `new` 0.1;
`identical=` 84.8 % of the transfers repeated the last bytes to their rectangle [C]. Textures [B]: `hit` 157,802/s,
`revalidated` 1,028/s, `redecoded` 34/s, `rt` 12/s.

Walk against tail (the same commands to the `t=361.22` row, then from it): 28.35 -> 36.87 ms a VBlank [F]; `submit=`
480 -> 616; `readback=` 75 -> 4; back-pressure 410 -> 545 ms/s ([E] 545.3, [B] 545.1); uploads unchanged: the tail is
the heavier scene. Before the HUD ([A]-[E] run *to* the HUD row): 57.6 VBlanks a second, replay 265 ms/s (`submit=`
130, `upload=` 96.5 at 11,179 uploads/s, 9,950 `gl_calls`/s), back-pressure 32 ms/s, `same_rewritten` 30.6 %,
`same_gpu` 14.7 %, `same_free` 20.1 %.

## 7. What the profiles cannot tell

- **No window.** One histogram covers the whole run, so §4 and §5 are the 480 s and the `submit=` bucket's split (§1)
  is a whole-run ratio on a mission bucket; the mission's own split needs F2's counter.
- **The harness is in every number.** 169 ms of the GL thread's second is the PNG encoding and read-back of the
  drive's captures; the gates carry it, a player's run does not. F5's ceiling fences the harness's frame.
- **The EE's non-waiting share is a bound.** `bp_wait_ms` is milliseconds; `idle=` is a count of waits; the sampler's
  `running=` is not a busy flag (non-zero in 54 % of the rows while the thread waits 50 %).
- **The GL thread's remainder** (~145 ms/s) has no instrument in the window; whole-run it is the sleep §4 places
  before the HUD and 1.0 % of `NtWaitForSingleObject` under `executePresent`/`swapBuffersWGL`.

## 8. Commands

From `C:/Projects/socom_pc`. `$L` is `logs/parity/f0/mission_game.log` and the row `t=294\.18`; for the GL-thread run
`mission_gl.log` and `t=298\.19` (66 complete blocks, the last 4,301 ms = 2.3 % of the window, counted). The window
bounds, re-derived: the HUD step `s28` at drive t=293.6 s (game run) / 297.3 s (GL run); the first sampler row at or
after it `t=294.18` / `298.19`; the last rows `484.30` / `481.31`; 190.12 s / 183.12 s of window.

- **[G]** `for g in s16_b2 s16_f0_gate2 s16_f0_gate3; do sed -n 4p logs/parity/gate/$g/summary.txt; done`
- **[S]** `python -m tools_py.hostprof_stacks logs/hostprof_f0_gl.txt --exe dist/socom2.exe --top 30`, and on
  `logs/hostprof_f0_game.txt`.
- **[S1]** `grep -v '^stack ' logs/hostprof_f0_game.txt > $TMP/game.txt && python tools_py/hostprof_symbolize.py
  $TMP/game.txt --top 40 --exe dist/socom2.exe`, likewise for `logs/hostprof_f0_gl.txt` (the documented
  `python tools_py/hostprof_symbolize.py logs/hostprof_f0_game.txt --top 40 --exe dist/socom2.exe` exits on the
  `stack` lines).
- **[N]** `tools/llvm-mingw/bin/llvm-objdump.exe -p C:/Windows/System32/ntdll.dll` (and `ucrtbase.dll`): the nearest
  export at or below each `ext` offset of [S1]'s file; callers by folding each `stack` line's leaf to its first exe
  frame with `hostprof_symbolize.symbols()`.
- **[A]** `awk '/\[pc-sampler\] live.* t=294\.18 /{on=1} on&&/\[gs-gl stats\] elapsed=/{match($0,/elapsed=[0-9]+/);E+=substr($0,RSTART+8,RLENGTH-8)} on&&/\[gs-gl stats\] calls=/{for(i=1;i<=NF;i++)if($i~/^(submit|transfer|upload|present|readback)=/){split($i,a,/[=\/]/);S[a[1]]+=a[2];N[a[1]]+=a[3]}} END{for(k in S)printf "%s=%.1f ms/s (%.1f/s)\n",k,S[k]/E*1000,N[k]/E*1000}' $L`
- **[B]** `awk '/\[pc-sampler\] live.* t=294\.18 /{on=1} on&&/\[gs-gl stats\] elapsed=/{match($0,/elapsed=[0-9]+/);E+=substr($0,RSTART+8,RLENGTH-8)} on&&/\[gs-gl stats\] backpressure/{for(i=1;i<=NF;i++)if($i~/^(guest_frames|waits|wait_ms)=/){split($i,a,"=");B[a[1]]+=a[2]}} on&&/\[gs-gl stats\] reasons/{for(i=1;i<=NF;i++)if($i~/^(new|changed|same_rewritten|same_gpu|same_free)=/){split($i,a,"=");R[a[1]]+=a[2];T+=a[2]}} END{printf "wait_ms=%.1f ms/s waits=%.2f/s guest_frames=%.2f/s\n",B["wait_ms"]/E*1000,B["waits"]/E*1000,B["guest_frames"]/E*1000; for(k in R)printf "%s=%.1f%% ",k,100*R[k]/T; printf "of %d\n",T}' $L`
- **[C]** `awk '/\[pc-sampler\] live.* t=294\.18 /{on=1} on&&/\[gs-transfer\]/{match($0,/elapsed=[0-9]+/);e=substr($0,RSTART+8,RLENGTH-8);E+=e;for(i=1;i<=NF;i++){if($i~/^(flush|body|dirty_rows|decode|draw)=/){split($i,a,/[=m]/);P[a[1]]+=a[2]*e} if($i~/^(whole|identical|flush_real|flush_empty|decodes)=/){split($i,a,/[=\/]/);C[a[1]]+=a[2]}}} END{for(k in P)printf "%s=%.2f ms/s\n",k,P[k]/E; printf "identical=%d of %d (%.1f%%) flush_real=%d flush_empty=%d decodes=%d\n",C["identical"],C["whole"],100*C["identical"]/C["whole"],C["flush_real"],C["flush_empty"],C["decodes"]}' $L`
- **[D]** `awk '/\[pc-sampler\] live.* t=294\.18 /{on=1} on&&/\[gs-upload\]/{match($0,/elapsed=[0-9]+/);e=substr($0,RSTART+8,RLENGTH-8)/1000;E+=e;match($0,/uploads=[0-9]+/);u=substr($0,RSTART+8,RLENGTH-8)*e;U+=u;match($0,/gl_calls=[0-9]+/);g=substr($0,RSTART+9,RLENGTH-9)*e;G+=g;for(i=1;i<=NF;i++){if($i~/^(shadow|mark|record)=/){split($i,a,"=");P[a[1]]+=a[2]*u} if($i~/^(convert|gl)=/){split($i,a,"=");P[a[1]]+=a[2]*g}}} END{printf "uploads=%.0f/s gl_calls=%.1f/s\n",U/E,G/E;for(k in P)printf "%s=%.2f ms/s\n",k,P[k]/E/1000}' $L`
- **[E]** `grep -E '\[pc-sampler\] live.* t=(294\.18|484\.30) ' $L | grep -oE ' t=[0-9.]+ vsync=[0-9]+|idle=[0-9]+|bp_wait_ms=[0-9]+'`, then the differences (GL run `298\.19|481\.31`; whole run: first and last rows).
- **[F]** `python -c "from tools_py.parity import frame_time as f; print(f.line(*f.read('logs/parity/f0/mission_game.drive.log','logs/parity/f0/mission_game.log'))); print(f.read_tail('logs/parity/f0/mission_game.drive.log','logs/parity/f0/mission_game.log'))"` (walk, then tail).
