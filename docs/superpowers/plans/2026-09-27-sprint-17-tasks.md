# Sprint 17 -- the task book (the bodies of every task; the plan holds the table and the state)

Date: 2026-09-27 23:40Z. Companion of `docs/superpowers/plans/2026-09-27-sprint-17.md` (the table, the rulings, the
Outcome, the Log) and the spec `docs/superpowers/specs/2026-09-27-sprint-17-sixty-and-the-way-back-design.md`. Every
`path:line` is the line at `main` `a3e1c5db` on 2026-09-27 unless it says otherwise; Sprint 16's F2 (`3c76db21` on
`sprint-16`) moves `gs_gl_backend.cpp`'s lines, so an implementer re-reads the range before editing and corrects this
file with a `> Superseded by` blockquote (rule 11). Paths under `third_party/ps2recomp/` are written from there.
Each task: **Files**, **Interfaces** (what it consumes and produces by exact name), the steps, the **Bar**, the
**Verification**. A step that builds or launches is a window (R297) and runs as
`bash scripts/loop_lock.sh run s17-<task> --class <build|run> -- <command>`.

## Task 0: the open

**Files:** `docs/CURRENT_SPRINT.md` (header and an OPEN block), `docs/HANDOFF.md` §2 and §5, the plan's Rulings and
Log, `docs/KNOWN.md`, `docs/LATER.md`, `docs/backlog_ruled_out.txt`, `docs/RULINGS.md` and `docs/SITTING.md`
(regenerated), `docs/BACKLOG.md` (regenerated).

- [ ] **Step 1: the branch.** When the Sprint 16 controller's close notice arrives: from the main tree, `git fetch origin
  && git merge-base --is-ancestor sprint-16 origin/main && echo MERGED`; `git tag --contains $(git rev-parse
  origin/main) | grep v0.16` names the tag. Then `git checkout -b sprint-17 origin/main`; cherry-pick the spec and the
  two plan commits from `claude/mission-frame-drops-7e50ea` (`git log --oneline claude/mission-frame-drops-7e50ea
  ^origin/main` lists them: `15c4c300`, `07b66cff`, `44d3c598` and the plan's); push `sprint-17` from the main tree.
- [ ] **Step 2: the milestone.** `gh api -X POST repos/Scotho/socom-unzipped/milestones -f title='Sprint 17' -f
  description='sixty, and the way back' --jq .number`; `gh issue edit N --milestone 'Sprint 17'` for #59, #32, #41,
  #28, #42, #91, #94, #26 (named by H1, not taken: the comment says so).
- [ ] **Step 3: the rulings.** Nine rulings from the counter (HANDOFF §2's next free number), one per D1–D9, each with the
  decision, the cost and the overturn, in the plan's "Rulings made on the owner's behalf"; the counter line moved;
  `python -m tools_py.rulings` and `python -m tools_py.sitting` run and committed in the same commit.
- [ ] **Step 4: the carry.** Read the Sprint 16 plan's Log and table on `main` and record one line each in this plan's
  Log: F2's outcome and gate number (ADOPTED or not; the `readback=` and `FRAME` before and after); F3 (Step 0 only →
  the upload skip is F1's fourth attempt); F5 (the fence written or not → F6's starting point); X4 (#41 landed or not →
  F6 Step 0); T1b's state (→ A3); R rows left open (they are the owner's release track: named in the Log, not taken
  unless the owner says). The spec's §1.7 assumption list is checked the same way.
- [ ] **Step 5: the record.** In `docs/backlog_ruled_out.txt`: the `q7-render-performance` row struck with "→ Sprint 17
  F1 (the fold) and F2 (the ring), this plan"; the `audio-level-residuals` row cut to the title ring and the movie
  level clauses with "the mission bed is #91 (A4)"; the `gs-local-host-readback` row checked against research/31
  §11-13 (`socom2_lum_readback.h`, `writeGsStoreImagePacket`) and retired with the citation if stale. `python -m
  tools_py.issues backlog` regenerated; `python -m unittest tools_py.tests.test_doc_maintenance` OK.
- [ ] **Step 6: the words.** `docs/CURRENT_SPRINT.md`'s header block names `sprint-17`, this plan and the spec; HANDOFF
  §2's "now" bullet and §5's seats rewritten; the Sprint 16 block moved to CLOSED as its controller left it.

**Bar:** `sprint-17` on `origin` carrying the spec and this plan; the milestone with its issues; nine rulings; the
carry lines in the Log; the doc test OK.
**Verification:** `git log --oneline origin/sprint-17 -3`; `gh api repos/Scotho/socom-unzipped/milestones --jq
'.[].title'`; `python -m unittest tools_py.tests.test_doc_maintenance`.

## Task G1: the chain's guard

**Files:** `tools_py/hooks/precommit.py` (new, or the existing pre-commit entry the leak check uses -- read
`scripts/install_hooks.sh` and `.githooks/` first), `scripts/loop_lock.sh` (read only: the live record's `purpose`),
`tools_py/tests/test_hooks.py`, `docs/DEVELOPING.md` "## Guards" (one bullet), `CLAUDE.md` "## Guards" (one line).

**Interfaces:** consumes the lock's live record (`bash scripts/loop_lock.sh check` prints `HELD: <owner> ... purpose: <text>`).
Produces a pre-commit refusal, exit 1, with the one-line reason `a merged chain holds the lock (<owner>): no commit in
this tree until it releases (Sprint 17 G1)` when the tree is the chain's tree and the purpose starts with `merged chain:`.

- [ ] **Step 1 (RED):** `test_hooks.py`: with a planted lock record whose purpose is `merged chain: ...` and the tree
  path equal to the record's tree, the pre-commit hook exits 1 with the reason; with any other purpose, or another
  tree, exit 0; with no lock, exit 0.
- [ ] **Step 2 (GREEN):** the rule; wired through `scripts/install_hooks.sh` like the leak check; `bash
  scripts/install_hooks.sh` run in the main tree and in this controller's tree.
- [ ] **Step 3:** the DEVELOPING and CLAUDE.md lines; the planted test named in DEVELOPING "## Guards".

**Bar:** the three cases green; a commit attempted in the main tree during a chain refused with the reason (checked once,
by hand, under the first chain's holding).
**Verification:** `python -m unittest tools_py.tests.test_hooks`.

## Task F0: the three instruments

**Files:**
- Create: `ps2xRuntime/include/runtime/gs/gs_frame_histogram.h` (header-only, no GL)
- Modify: `ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`executePresent`, the `++m_frameCounter` site near `:3169`;
  the stats print `:1894-1933`), `tools_py/parity/gate.py:663`, `tools_py/parity/frame_time.py` (a `syncv` reader),
  `scripts/parity/ladder_frostfire.sh` (the env), `tools_py/parity/drive.py:65`
- Test: `ps2xTest/src/ps2_gs_tests.cpp` (the histogram cases), `tools_py/tests/test_gate_frame_time.py` (the
  `syncv` line in the summary), `tools_py/tests/test_online_harness.py` or the drive tests (the no-screenshot env)

**Interfaces:**
- Produces `struct GsFrameHistogram` with `static constexpr uint32_t kEdgesMs[6] = {17, 20, 25, 33, 50, 100};`
  `uint64_t counts[7]; uint64_t longestNs; uint64_t n; void add(uint64_t intervalNs); std::string line() const;`
  `line()` returns `frames n=<n> le17=<c0> le20=<c1> le25=<c2> le33=<c3> le50=<c4> le100=<c5> over=<c6> longest_ms=<x.x>`.
- Produces `frame_time.read_syncv(game_log) -> float | None` (the mean of the `[vu1-stats]` line's `syncv/s` field over
  the walk window) and the summary line `SYNCV mean=<x.x>/s n=<lines>` beside `FRAME`.
- Produces the env `SOCOM_DRIVE_NO_LATEST_FRAME=1`: `drive.py` leaves `PS2X_HOST_SCREENSHOT_LATEST` unset and `grab()`
  falls back to `PrintWindow`.

- [ ] **Step 1 (RED, the histogram):** in `ps2_gs_tests.cpp`, beside the `GsGlUploadReasons` cases (`:6324`):
  ```cpp
  {
      GsFrameHistogram h{};
      for (int i = 0; i < 3; ++i) h.add(16'000'000ull);   // 16.0 ms: le17
      h.add(40'000'000ull);                                 // 40 ms: le50
      h.add(2'500'000'000ull);                              // 2.5 s: over, and longest
      t.Equals(h.n, 5ull, "five intervals");
      t.Equals(h.counts[0], 3ull, "three under 17 ms");
      t.Equals(h.counts[4], 1ull, "one in (33, 50]");
      t.Equals(h.counts[6], 1ull, "one over 100 ms lands in the open bucket, never wraps");
      t.Equals(h.longestNs, 2'500'000'000ull, "the longest is kept");
      t.IsTrue(h.line().find("le17=3 ") != std::string::npos && h.line().find("over=1 ") != std::string::npos
               && h.line().find("longest_ms=2500.0") != std::string::npos, h.line());
  }
  ```
  Build the suite under the lock (`--class build -- ./build.sh test`); paste the failing line (the header does not
  exist) into the Log.
- [ ] **Step 2 (GREEN):** the header:
  ```cpp
  #pragma once
  #include <cstdint>
  #include <string>
  struct GsFrameHistogram {
      static constexpr uint32_t kEdgesMs[6] = {17, 20, 25, 33, 50, 100};
      uint64_t counts[7] = {};
      uint64_t longestNs = 0;
      uint64_t n = 0;
      void add(uint64_t intervalNs) {
          ++n; if (intervalNs > longestNs) longestNs = intervalNs;
          const uint64_t ms = intervalNs / 1'000'000ull;
          int b = 0; while (b < 6 && ms > kEdgesMs[b]) ++b;
          ++counts[b];
      }
      std::string line() const;   // "frames n=.. le17=.. le20=.. le25=.. le33=.. le50=.. le100=.. over=.. longest_ms=.."
  };
  ```
  `line()` inline with `snprintf("%.1f")` for the longest. In `executePresent`, beside `++m_frameCounter`: a
  `std::chrono::steady_clock` stamp; `m_frameHist.add(now - m_lastPresent)` when `m_lastPresent` is set; in the
  stats block print `[gs-gl stats] ` + `m_frameHist.line()` and reset it, under the same `s_stats` guard as the
  other lines (the counts are kept whatever the knob). Suite green; commit `-- <the three files>`.
- [ ] **Step 3 (RED, syncv):** `test_gate_frame_time.py` gets a fixture game log with three `[vu1-stats]` lines whose
  `syncv/s` field reads 29.0, 31.0 and 30.0 inside the walk window and one at 58.0 before it; assert the summary
  carries `SYNCV mean=30.0/s n=3` and `frame_info` gains `syncv_mean` 30.0. Confirm the field's exact token first at
  `ps2_vu1_core.cpp:2836-2900` (the print after the `s_lastSyncV` line) and use it verbatim in the regex.
- [ ] **Step 4 (GREEN):** `frame_time.read_syncv()` and the summary line; `gate.py:663` adds
  `env.setdefault("PS2X_VU_STATS", "1")` beside `PS2X_PC_SAMPLER`; `ladder_frostfire.sh` exports `PS2X_VU_STATS=1`
  beside `PS2X_GS_STATS=1`. The gate's `env` pin changes with the new knob: run `--accept-pins` for the `env` pin only
  in the same gate that records the first `SYNCV` line (the pin's drift is this task's, recorded in the Log).
- [ ] **Step 5 (RED, the player knob):** a drive test: with `SOCOM_DRIVE_NO_LATEST_FRAME=1` in the environment,
  `launch()`'s child env has no `PS2X_HOST_SCREENSHOT_LATEST`; without it, it has the default path. GREEN: the guard
  around `drive.py:65`'s `setdefault`.
- [ ] **Step 5b (RED, the encode off the GL thread; LATER 43):** the screenshot path (`ps2_runtime.cpp:2867-2890`) keeps
  `LoadImageFromScreen` on the GL thread (it is a GL read) and hands the pixels to a worker that runs `ExportImage` and the
  rename; a pure helper `ShotQueue` (new header `ps2xRuntime/include/runtime/shot_queue.h`: `push(Image)`, one in
  flight, a newer frame replaces a waiting one) with a `ps2xTest` case: three pushes while the worker is held leave one
  waiting image, the newest. GREEN: the helper and the wiring; the gate's captures unchanged (the fourth leg's twelve
  references match). Measurement: `ExportImage`'s share of the GL thread in the host profile, 14.9 % -> under 1 %.
- [ ] **Step 6 ([L], one window the owner names):** the player-condition run, mirroring research/73 §3 minus the
  screenshots: `SOCOM_DRIVE_NO_LATEST_FRAME=1 PS2X_PC_SAMPLER=1 PS2X_GS_STATS=1 PS2X_VU_STATS=1 python -m
  tools_py.parity.drive --target ours scripts/parity/gameplay_probe.txt --seconds 480 --tail 170` under the lock, the
  log copied to `logs/parity/s17_f0/mission_player.log`. Then, in the same window, #67's readout: `python -m
  tools_py.parity.window_drag drag --log <that log> --seconds 10 --stamps logs/parity/s17_f0/drag_stamps.txt` during
  the tail, and `readout`; the before-capture on the `v0.14.0` exe (rebuilt from tag `200f3287` under the lock if
  no archive holds it) the same way. Read research/73 §8's commands [A], [B], [E] on the new log plus the `frames`
  histogram lines and the `SYNCV` line.

**Bar:** the histogram cases green; `SYNCV mean=` in a gate summary; a KNOWN §2 row "the mission in a player's
conditions" with VBlanks/s, presents/s, `syncv/s`, the histogram's `over=` share and `longest_ms`, against research/73's
harness numbers, with the commands; #67's row moved with its readout.
**Verification:** `./build.sh test` exit 0; `python -m unittest tools_py.tests.test_gate_frame_time`; the gate summary
of the run.

## Task F1: the draw path, attempt by attempt

**Files:** `ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`resolveTexture` `:3544-3708`, `textureSourceHash`,
`decodeTexture` `:3302-3540` with `entry.sourceHash = textureSourceHash(...)` inside it, `setupDrawState`
`:3898-3937`, `executeUpload` `:2184`), `ps2xRuntime/src/lib/gs/gs_cpu_backend.cpp` (`UploadImage`, `WriteSpan`),
`ps2xRuntime/src/lib/gs/gs_frontend.cpp` (`processGIFPacket` → `UploadImage`), `ps2xTest/src/ps2_gs_tests.cpp`;
`tools_py/parity/submit_split.py` (new: the reader of `[gs-submit]` lines, mean ms/s per field over a window) with
`tools_py/tests/test_submit_split.py`.

**Interfaces:** consumes the `[gs-submit]` line Sprint 16 F2 added (`flushes=/s setup= dirty_rows= resolve= draw=` ms/s,
`readbacks=/s readback_rows=/s readback_px=/s readback= rt_direct=/s`) and the `[gs-gl stats] reasons` line (`hit
revalidated redecoded new`). Produces `submit_split.read(log, t_from, t_to) -> dict[str, float]` (ms/s per field) so
every attempt's before/after is one command: `python -m tools_py.parity.submit_split <log> --from <t> --to <t>`.

- [ ] **Step 0 (the reader, lock-free):** RED: `test_submit_split.py` with a fixture of three `[gs-submit]` lines and
  their preceding `[pc-sampler]` rows asserts `resolve=` averages elapsed-weighted; GREEN: the module. Commit.
- [ ] **Step 1 (the ranking):** from F0's player log and Sprint 16 F2's post-fix gate log, `submit_split` over the
  post-HUD window; the four fields ranked; the attempt order below re-ordered to that ranking in the Log before any
  branch exists, with today's ms/s written beside each.
- [ ] **Attempt 1 — the hash fold.** Measurement: `resolve=` ms/s and `reasons revalidated=`/s. RED: a `ps2_gs_tests.cpp`
  case on the CPU side — for a planted 64x64 CT32 texture in shadow VRAM, `decodeTexture`'s decode-time hash equals
  `textureSourceHash()` over the same bytes (the fold must keep `hashTexels`' value: KNOWN §2 161 (a) names the risk),
  and the decode reports one walk of the source (a counter `sourceWalks` on the decode result, kept without a knob).
  GREEN: compute the hash inside the decode loop; `entry.sourceHash` set from it; the revalidation path
  (`textureSourceHash` on a generation bump) unchanged. Build, one gate, `submit_split` before/after. Stop rule: under
  25 % off `resolve=` → TRIED, NOT ADOPTED with the number.
- [ ] **Attempt 2 — the unconditional formatting.** Measurement: `setup=` ms/s. RED: none possible without a GL
  context; the RED is the reader's number (today's `setup=`) pasted before the branch, and a review check that the
  two stats tags are still printed under `PS2X_GS_STATS=1`. GREEN: `setupDrawState`'s two `snprintf` and two
  string searches moved under `s_stats` (`:3898-3937`). Build, one gate. Stop rule as above.
- [ ] **Attempt 3 — the double swizzle.** Measurement: `upload=` (GL thread) and `shadow=` (`[gs-upload]`, EE thread)
  ms/s. RED: a `ps2_gs_tests.cpp` case: after `GS::processGIFPacket` uploads a 16x16 tile, `GSCpuBackend`'s VRAM holds
  the swizzled bytes and the GL command buffer's `Upload` command carries a reference to that shadow, not a second
  copy to swizzle (a flag `swizzledByRecorder` on the command, asserted true). GREEN: `executeUpload` skips its own
  `WriteSpan` when the recorder already wrote the shadow. Build, one gate.
- [ ] **Attempt 4 — the upload skip (#32), only if Sprint 16 F3 landed short.** Measurement: `upload=` ms/s and
  `reasons same_rewritten=`. The Sprint 16 F3 task body (`docs/superpowers/plans/2026-09-27-sprint-16-tasks.md` <!-- docmaint: future --> "## Task
  F3") is the design; its RED and GREEN as written there; `PS2X_GS_UPLOAD_SKIP` default flipped only on the number.
- [ ] **Step 5:** each attempt ADOPTED or TRIED, NOT ADOPTED in the Log and KNOWN with its two numbers and the gate
  stamp; the milestone's running `FRAME mean=` beside it.

**Bar:** per attempt, the phase's ms/s halved with the gate 3/3 PINS MATCH, `--vram-diff` 15/15, the console-replay
case unchanged, the fourth leg green; for the task, `FRAME mean=` and the `frames` histogram after the last adopted
attempt written against F0's.
**Verification:** `python -m tools_py.parity.submit_split <log> --from <hud t> --to <end>` before and after; the gate
summary; `./build.sh test`.

## Task F2: the read-backs off the frame

**Files:** `ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`downloadRenderTargetToCpu` `:2867-2915`, its `glReadPixels`
`:2879`, `executeReadback` `:2917-2922`, `RequestVramReadback` `:1209-1217`), `ps2xRuntime/src/lib/gs/gs_cpu_backend.cpp`
(`WriteVram`, the mutex `:607-609`), `ps2xRuntime/include/runtime/socom2_lum_readback.h:67`, `ps2xTest/src/ps2_gs_tests.cpp`.

**Interfaces:** produces `GSCpuBackend::WriteVramRows(uint32_t bp, uint32_t bw, uint32_t psm, uint32_t y0, uint32_t rows,
const uint32_t *pixels)` — one lock, one row span per call; consumes the `[gs-submit] readback=` field and `[gs-gl
stats] readback=`.

- [ ] **Step 1 (RED):** `ps2_gs_tests.cpp`: a 64x4 CT32 block written once through `WriteVramRows` reads back
  (`ReadVram`) byte-identical to the same block written pixel by pixel through `WriteVram`. Fails: no such function.
- [ ] **Step 2 (GREEN):** `WriteVramRows`; `downloadRenderTargetToCpu` calls it per row instead of per pixel. Build,
  the suite, one gate; `readback=` before/after.
- [ ] **Step 3 (RED, the ring):** a case on a small pure helper `GsReadbackRing` (new header
  `ps2xRuntime/include/runtime/gs/gs_readback_ring.h`, no GL): two slots; `begin(frame)` returns the slot to fill and
  `ready(frame)` the slot whose fence frame is ≤ frame − 1; for the sequence draw(A) read draw(B) read the second
  `ready` yields B's bytes, never A's (Review Focus 4). GREEN: the header; `executeReadback` issues `glReadPixels`
  into a `GL_PIXEL_PACK_BUFFER` slot and maps the previous slot's bytes into the shadow; the exposure request tolerates
  one frame of latency (`socom2_lum_readback.h:67`, 100 ms apart). `PS2X_GS_READBACK_SYNC=1` (Dev) restores the
  synchronous path for an A/B. Build, one gate.

**Bar:** `readback=` under 5 ms/s on the gate's scene with the luminance the guest reads unchanged (the `[peek]` of the
exposure column identical over the walk between the A/B runs); the gate 3/3.
**Verification:** the two cases; `submit_split` and the stats line before/after; the gate summary.

## Task F3: the unaccounted 145 ms/s

**Files:** `ps2xRuntime/include/runtime/gs/gs_loop_phases.h` (new, header-only), `ps2xRuntime/src/lib/gs/gs_frontend.cpp`
(`latchHostPresentationFrame` `:606-654`), `ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`HostRenderFrame` `:1432-1472`,
the swap under `m_queueMutex`), `ps2xRuntime/src/lib/ps2_runtime.cpp` (the loop `:2660-2962`, around `EndDrawing`),
`ps2xTest/src/ps2_gs_tests.cpp`.

**Interfaces:** produces `struct GsLoopPhases { uint64_t latchNs, swapQueueNs, replayNs, drawNs, endDrawingNs,
otherNs; void add(field, ns); std::string line() const; }` printed as `[gs-loop] latch= swap= replay= draw= end=
other= ms/s` on the stats cadence.

- [ ] **Step 1 (RED):** the header's case: six adds sum to `total()`, `line()` prints each in ms with one decimal.
- [ ] **Step 2 (GREEN):** the header; stamps around the five sections of one loop iteration; `other` = iteration −
  the five. Build, one plain run (F0's recipe), the line read over the post-HUD window.
- [ ] **Step 3:** if a phase is over 30 ms/s: one change named from it (a lock held shorter — `latchHostPresentationFrame`
  posting its Present outside `m_stateMutex`; or the command-buffer swap copying less), its own RED where a pure helper
  exists, one build, one gate. Otherwise the split alone is the outcome.

**Bar:** the remainder split in KNOWN with the command; a change only on a phase over 30 ms/s, measured before/after.
**Verification:** the case; the `[gs-loop]` line; the gate.

## Task F4: the pacing structure (conditional, D2)

**Fires only if, after F1–F3, the guest still waits on back-pressure more than 100 ms/s** (`bp_wait_ms` per second over
the walk, research/73 §8 [E]).

**Files:** `ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`HostRenderFrame`, `executeCommands` `:1579-1934`,
`executePresent`), `ps2xRuntime/src/lib/gs/gs_frame_backpressure.cpp` and `.h`, `ps2xRuntime/src/lib/Kernel/EeScheduler.cpp`
(`reanchorVBlankDeadline` `:1547-1551`, `processDueDeadlines` `:2098-2229`), `ps2xTest/src/gs_frame_backpressure_tests.cpp`,
`ps2xTest/src/ps2_runtime_interrupt_tests.cpp`.

- [ ] **Step 1: the design paragraph** in the Log, one per candidate, in this order, each with the counter that shows
  it: (a) **present the newest, replay the rest for state** — when two or more guest frames are pending, the older
  frames' draw calls are recorded into the render targets as today but only the newest frame's `Present` copies to the
  window (counter: `presents_skipped=`/s); (b) **the decode and hash on a worker** — `decodeTexture`'s CPU half runs
  on a second thread ahead of the replay, keyed by the recorded command index; the replay waits on a ready flag
  (counter: `decode_wait_ms=`); (c) **the re-anchor rule** — a VBlank delivered late because of back-pressure is
  repaid up to N frames instead of re-anchored (`reanchorVBlankDeadline`), with the histogram from F0 as the readout.
- [ ] **Step 2 (RED, per candidate):** (a) a `ps2_gs_tests.cpp` case on the command buffer: three recorded frames replayed
  in one `HostRenderFrame` produce one window copy and three target replays (counted, no GL); (b) a case on the
  worker's queue helper (order kept, a stalled decode does not reorder); (c) `gs_frame_backpressure_tests.cpp`: a wait
  that fires twice re-anchors once and repays one period — the existing R41 cases must still pass unchanged (KNOWN §2
  159: they are load-flaky in the VM only; do not loosen them).
- [ ] **Step 3 (GREEN, [L]):** one candidate at a time, one build and one gate each, the fence; stop rule: under 25 %
  off `bp_wait_ms` per second → TRIED, NOT ADOPTED. A paraLLEl-GS take is not a candidate here (D2).

**Bar:** `bp_wait_ms` under 100 ms/s over the walk with the gate 3/3 and the histogram's `over=` share not risen.
**Verification:** the three suites; research/73 §8 [E] on the run; the gate.

## Task F5: 3x render scale

**Files:** `scripts/parity/pins.json` (unchanged), a scratch pins file for the scaled gate, `tools_py/parity/gate.py`
(`:1197` the `env` pin), `docs/DEVELOPING.md` "Knobs" (the `S=3` sentence), the launcher's VIDEO page wording
(`ps2xLauncher`'s DETAIL row; find it with `grep -rn "DETAIL" third_party/ps2recomp/ps2xLauncher/src`), `docs/KNOWN.md`.

- [ ] **Step 1:** `python -m tools_py.parity.gate --help`: if no flag selects the pins file, add `--pins <file>` (RED in
  `tools_py/tests/test_gate_*.py`: a gate reading a named pins file compares against it; GREEN: the flag). The `env` pin
  drifts by design under `PS2X_GS_SCALE=3`; the scratch file `logs/parity/pins_scale3.json` is accepted on the first
  scaled gate and never committed.
- [ ] **Step 2 ([L]):** three gates with `PS2X_GS_SCALE=3` on the sprint's exe (title, mission, transition; the `S=2`
  recipe of stamps `s3d_2x_host`/`s3d_2x_gif`, `docs/DEVELOPING.md:920`), `--vram-diff` under `S=3` for F2's direct
  render-target path (the mirror the guest reads must be native: a moved pixel here is NOT ADOPTED for the path at
  `S>1`, and the guard returns for `S>1` only); the memory per target logged.
- [ ] **Step 3:** the three `FRAME` / `SYNCV` / `frames` readings at `S=3` beside 1x in one KNOWN row (D6: recorded, not
  fenced); the launcher's DETAIL wording says "3x: sharper geometry, about N % lower frame rate on this class of
  machine" with N from the row; `docs/DEVELOPING.md`'s `S=3` sentence updated.

**Bar:** `S=3` stamped on both draw paths with pins matching under its scratch file; the frame-rate row written.
**Verification:** the three gate summaries; the vram-diff line; the KNOWN row's commands.

## Task F6: the fence re-cut, and the menu pixel guard

**Files:** `tools_py/parity/pins.py:43` (`INFORMATIONAL = ("frame",)`), `pins.py:173-260` (`compare`, `frame_info`),
`tools_py/parity/gate.py:1601-1614`, `scripts/parity/pins.json`, `tools_py/tests/test_gate_frame_time.py:118-134`;
for Step 0: `tools_py/gsdump_extract.py`, `ps2xTest/src/ps2_gs_tests.cpp` (the console-replay case),
`docs/research/31-*.md`'s menu-dump recipe, `game/console_replay/` (git-ignored).

- [ ] **Step 0 (only if Sprint 16 X4 did not land, [L] one PCSX2 run):** #41 — a PCSX2 GS dump of the MAIN MENU frame by
  research/31's recipe, extracted with `gsdump_extract.py` into `game/console_replay/frame_menu.ppm`; the
  console-replay case scores the CPU replay against it under a bar set from the first run; RED first: the case refuses
  a planted pixel change (a one-pixel edit of the fixture's copy) — `PS2X_CONSOLE_REPLAY_GL=1` for the GL half.
- [ ] **Step 1 (RED):** `test_gate_frame_time.py`: (a) a standard with `"frame": {"mean_ms_max": 17.0, "worst_ms_max":
  20.0, "syncv_min": 57.0, "host": "<env pin's host>", "screenshots": "150ms"}` and a summary at 24.24 / 31.25 → the
  gate prints `PIN frame OVER CEILING` and returns 7; (b) a summary from another host, or one without the `SYNCV`
  line → `PIN frame not compared (host differs / no syncv)` and the gate passes (Review Focus 2); (c) `--accept-pins`
  writes the ceiling as median + measured spread from three named summaries, never from one.
- [ ] **Step 2 (GREEN):** `frame` leaves `INFORMATIONAL`; `compare` treats it as a ceiling keyed to the host; `gate.py`
  prints the verdict; the S13-R3 sentence in `pins.py:24-25` and `:42` rewritten.
- [ ] **Step 3 ([L], the close chain):** three quiet gates on the sprint's final exe; the ceiling written from them by
  `--accept-pins`; before and after (F0's harness and player numbers, Sprint 16 F5's three) in one table in the Log
  and KNOWN's #59 row; #59 closed if D1's bar is met, else left open with D9's trigger.

**Bar:** the three cases green; the pin a refusal on this host; #59 at its recorded outcome.
**Verification:** `python -m unittest tools_py.tests.test_gate_frame_time`; the three summaries.

## Task Q0: the spike — how SOCOM II goes back to the main menu

**Files:** `scripts/parity/launch_to_mission.txt`, `scripts/parity/launch_to_online_ours.txt` (read), two new drive
scripts `scripts/parity/quit_mission.txt` and `scripts/parity/quit_online.txt`, `docs/research/<next number>-back-to-the-main-menu.md`
(class S), `logs/parity/s17_q0/`.

**Interfaces:** consumes `PS2X_CALL_TRACE=0x1ACBF8:InitExecPS2,0x1ACCF8:SetArg,0x1ACE88:LoadExecPS2` (the SDK family,
`recomp/socom2.toml:499-503`), `PS2X_CALL_TRACE_DUMP=LoadExecPS2:a2*:8` (argv's eight words), `PS2X_SCHED_TRACE=1`,
`PS2X_PEEK=0x1ACCF8:4` is not needed (SetArg is traced). Produces the two drive scripts and the note.

- [ ] **Step 1 ([L], the offline route, one run):** copy `launch_to_mission.txt` to `quit_mission.txt`; after its
  briefing step (the `ref_briefing_ours.png` match), append the exit presses one at a time with a `shot` capture after
  each (START, then the menu's exit row; the exact rows are read off the captures and written into the script as they
  are found — a discovery step whose product is the script). Run under the lock with the three knobs above and
  `PS2X_HOST_SCREENSHOT_LATEST` set (the harness reads the frame). Keep the log as `logs/parity/s17_q0/mission.log`.
- [ ] **Step 2 ([L], the online route, one run):** the same on `launch_to_online_ours.txt` → `quit_online.txt`: from the
  lobby, the QUIT path; `logs/parity/s17_q0/online.log`.
- [ ] **Step 3 (the reading):** from each log: the `[call-trace]` lines for `InitExecPS2`, `SetArg` and `LoadExecPS2`
  with argv's words decoded as strings (the dump is guest words; `python -c` over the log turns them into text); the
  `[guest-fault]` line and its `pc`/`a0`; the FindAddress trace (`System.cpp:840` prints its window, `:881` returns 0
  on a miss; `:123` of that function's tail returns the match) and `GetSystemCallEntry`'s answer — which of them
  produced the −1 that `kCopy` stored to; `[sched]` around it. Cross-check research/05 §"FTSCore".
- [ ] **Step 4 (the note):** "how SOCOM II goes back to the main menu": the argv of each route (verbatim), the search
  that fails and what the console's kernel would have answered (the SDK's `InitExecPS2` patches `ExecPS2`'s kernel
  entry: name the address range it searches), whether the game *needs* the re-exec or only its argument (a `--menu_state`
  the loader's `main()` parses), and the two fix routes costed for Q2 (in-process restart: which state must reset;
  launcher relaunch: the sidecar and the blink). Under 2,500 words; every number with its command.

**Bar:** the two drive scripts reproduce the exit on demand; the argv of both routes in the note; the failing call
named with its line.
**Verification:** `grep -n "LoadExecPS2\|guest-fault\|call-trace" logs/parity/s17_q0/*.log`; the note's §8-style
command list.

## Task Q1: the kernel-patch prologue completes

**Files:** `ps2xRuntime/src/lib/Kernel/Syscalls/System.cpp` (`FindAddress` `:840-` and `GetSystemCallEntry`'s model),
`ps2xTest/src/ps2_runtime_kernel_tests.cpp`.

**Interfaces:** consumes Q0's finding (which search returned −1 and for what target). Produces a kernel answer such that
the SDK's `InitExecPS2` and `SetArg` run to the `LoadExecPS2` syscall without a fault.

- [ ] **Step 1 (RED):** `ps2_runtime_kernel_tests.cpp`: a case that calls the modelled search with Q0's exact arguments
  (the window and target the trace printed) and asserts the answer is a mapped RAM address inside the window, not 0 and
  not 0xFFFFFFFF; a second case: `kCopy`'s destination derived from that answer is writable (`getMemPtr` non-null).
- [ ] **Step 2 (GREEN):** the smallest model that answers: a planted kernel table entry at the searched target, or the
  syscall-table entry `GetSystemCallEntry` returns pointing at a reserved kernel page the runtime maps; no game code
  changed. Suite green.
- [ ] **Step 3 ([L], one run):** Q0's `quit_mission.txt` again with the trace: `[LoadExecPS2]` reached with the game's
  own argv (not `dlgAfterErrorReboot.rdr`), no `[guest-fault]`; the process still exits 74 (Q2 owns the rest). The
  argv line into the Log and Q0's note.

**Bar:** the two cases green; the run's `[LoadExecPS2]` line carries the game's argv and no fault precedes it.
**Verification:** `./build.sh test`; `grep -c guest-fault <log>` = 0.

## Task Q2: LoadExecPS2 as an in-process restart (D3)

**Files:** `ps2xRuntime/src/lib/Kernel/Syscalls/Thread.cpp:186-223` (`LoadExecPS2`), `ps2xRuntime/src/lib/ps2_runtime.cpp`
(`resetIop` `:675`, `resetGuestHeapLocked` `:1794`, `resetStubRuntimeState` `:3039`, the game-thread spawn `:2626-2654`,
the loop `:2660-2962`), `ps2xRuntime/src/lib/Kernel/EeScheduler.cpp` (`reset()` `:168`), `ps2xRuntime/src/lib/Kernel/Stubs/SIF.cpp`
(`resetSifState` `:443`, the `sceSifRebootIop` model `:722`), `ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`Reset` via
`waitForToken` `:1007-1036`), `ps2xRuntime/src/lib/snd989_mixer.cpp` (a full stop), `ps2xRuntime/src/main.cpp:162-181`
(the ELF path) and the loader it calls, `ps2xShared/include/ps2x/exit_codes.h:37`, `ps2xTest/src/runtime_state_tests.cpp`,
`ps2xTest/src/exit_codes_tests.cpp:55`, `ps2xTest/src/launcher_tests.cpp:572`, the launcher's exit-code table,
`tools_py/parity/drive.py` (a `quit_mission`/`quit_online` step alias for the two Q0 scripts), `docs/FAQ.md`.

**Interfaces:** produces `PS2Runtime::requestGuestRestart(std::string elfPath, std::vector<std::string> argv)` — sets a
flag the game thread honours at its next checkpoint; the loop thread performs `restartGuest()`: stop the scheduler,
`resetIop()`, `resetSifState()`, `resetStubRuntimeState()`, the mixer stopped and cleared, `GS::Reset` (the token
wait), guest RAM zeroed and the ELF reloaded through the same loader `main()` uses, `EeScheduler::reset()`, the
arguments written where the SDK's `SetArg` placed them (Q0's note gives the block; the crt0 reads `argc`/`argv` from
it), the game thread respawned. Consumes Q0's argv and Q1's completed prologue.

- [ ] **Step 1 (RED):** `runtime_state_tests.cpp`: `requestGuestRestart("<test elf>", {"--menu_state", "x.rdr", ""})`
  on a runtime built without a window (the `bare_run_tests.cpp` shape): after `restartGuest()`, guest RAM at the
  argument block reads `argc=3` and the three strings; the scheduler's VBlank tick is 0; the IOP module table is
  empty; the mixer reports no live handles. A second case: `argc=0` restarts with `argc=0` at the block and no fault
  (Review Focus 3). A third: a restart requested twice before the first completes performs one.
- [ ] **Step 2 (GREEN):** the two functions; `Thread.cpp`'s `LoadExecPS2` calls `requestGuestRestart` when the path is
  the game's own ELF (`cdrom0:\SCUS_972.75;1` → the loaded ELF) and keeps the 74 exit for any other path (the fatal
  case stays honest). Suite green.
- [ ] **Step 3 ([L], one build and one run each):** `quit_mission.txt` then `quit_online.txt` under the lock with the
  trace: each ends on the main menu (`ref_main_menu_ours.png` matched by the drive's `untilref`), the log carries
  `[LoadExecPS2] restart ... argv=...` and no exit; three launches each.
- [ ] **Step 4 (the fallback, only if Step 2's reset proves wider than the box after one design):** exit code 75
  `restart-requested` with the argv in `logs/relaunch_args.txt`; the launcher relaunches `socom2.exe` with those
  arguments once; `exit_codes_tests.cpp` and `launcher_tests.cpp` for both.
- [ ] **Step 5:** `exit_codes_tests.cpp:55` and `launcher_tests.cpp:572` rewritten for the surviving meaning of 74; the
  FAQ's sentence on leaving online (if one exists: `grep -n -i "online" docs/FAQ.md`) corrected; KNOWN §1 row.

**Bar:** both routes on the main menu on three launches each; the argument block correct in the unit case; 74 only
for a foreign ELF path.
**Verification:** the three cases; `grep -n "LoadExecPS2\|guest-fault" <logs>`; the drive's final `untilref` match.

## Task Q3: the announcement scroller (D4)

**Files:** `server/config/db.config.json:7-8` (a local copy for the run, never the hosted box), `server/README.md:147-150`
(how simulated mode serves it), `scripts/parity/launch_to_online_ours.txt` → `scripts/parity/announcement_hold.txt`
(new: login, the ANNOUNCEMENT page, a 30 s hold with `shot` every 1 s), `tools_py/parity/pcsx2_shell.py` (`login B`),
`scripts/parity/env.sh` (the harness's server address), `logs/parity/s17_q3/`.

- [ ] **Step 1 (lock-free):** a 1,000-character body in the local config: ten lines of our own sentence ("SOCOM
  Unzipped: this announcement is one thousand characters long so the page's scroller can be watched. Line N.")
  padded to exactly 1000 with a trailing space (Review Focus 5); the local Horizon stack started per
  `server/README.md`; `env.sh` pointing the harness at it. `python -m tools_py.parity.drive --dry-run
  scripts/parity/announcement_hold.txt` validates the script.
- [ ] **Step 2 ([L], ours, one run):** the drive under the lock; the 30 captures into a contact sheet
  (`tools_py/parity/contact_sheet.py` if present, else `black_rows.py`'s montage helper); read: scrolls / wraps / clips
  / runs off / cadence.
- [ ] **Step 3 ([L], the console, one run):** `python -m tools_py.parity.pcsx2_shell login B` against the same local
  server, then the ANNOUNCEMENT page by the shell's screen-verified presses, 30 captures the same way.
- [ ] **Step 4:** the two sheets side by side in KNOWN (the difference, if any, in one sentence); if ours differs: the
  text layout path it names (find it from the string's draw: `PS2X_GS_TRACE_CMDS` over the page, or the
  announcement's guest buffer by `PS2X_WATCH`), a RED on that path's pure part, one fix, one re-run.

**Bar:** both sheets recorded; a fix only on a difference, test-first.
**Verification:** the two contact sheets; the KNOWN row; the hosted server's config untouched (`git status server/`
clean, no deploy).

## Task A0: the owner's listen (O7/O8)

**Files:** `docs/HUMAN_TASKS.md` (O7, O8: the questions rewritten for this sprint), issue #94 (its bar's first step: the
owner's description of the defect), the Log.

- [ ] **Step 1:** one message to the owner, prose (their persona human pass is O25, kept when the Sprint 16 close let O7 lapse by default): the lobby held ten minutes with a headset, then a match, then a long
  session; for each: is the stuttering there, on which screen or minute, and for #94 which track, when, wrong how (a
  missing track, the wrong one, a level, a stall). Nothing in A2–A4 is scheduled before the answer (D5).
- [ ] **Step 2:** the answer written verbatim into #94 and the Log; A2–A4 fired or moved to LATER with the answer as
  the reason.

**Bar:** the owner's words recorded; A2–A4's state set from them.

## Task A1: the lobby's recording, both sides

**Files:** `scripts/parity/mission_music_long.sh` (`--stage lobby`: base script `scripts/parity/launch_to_online_ours.txt`,
the hold after its LOGIN step; refuse when the base has no LOGIN step, as `:139` refuses a missing DEPLOY),
`scripts/parity/audio_parity.sh` (the loopback recorder and `AUDIO_DUMP`), `tools_py/parity/audio_dips.py`,
`tools_py/parity/audio_parity.py`, `tools_py/parity/pcsx2_shell.py`, `tools_py/tests/test_mission_music_fast.py` (the
generated hold), `logs/parity/s17_a1_ours/`, `logs/parity/s17_a1_pcsx2/`.

- [ ] **Step 1 (RED, lock-free):** `test_mission_music_fast.py`: `--stage lobby --dry-run --minutes 10` generates a
  script ending in 10 minutes of `wait+8.0:NONE` after the LOGIN step, and a base without LOGIN is refused with the
  message naming it. GREEN: the stage.
- [ ] **Step 2 ([L], ours, one run):** `MINUTES=10` `mission_music_long.sh --stage lobby --minutes 10 --stamp s17_a1_ours`
  under the lock with `PS2X_AUDIO_TRACE=1 PS2X_AUDIO_CB_TRACE=1` (the dump and the endpoint both recorded); the drive
  passes through the sign-in, CREATE GAME and lobby screens the owner named for the stray sound (PLAYTEST step 11).
- [ ] **Step 3 ([L], the console, one run):** the loopback recorder `audio_parity.sh capture` uses, started around
  `python -m tools_py.parity.pcsx2_shell login B` on the same server and a 10-minute hold on the same screens; the
  per-app route rule in `docs/HAZARDS.md` audio (instance A's override) honoured as `audio_parity.sh` does.
- [ ] **Step 4 (the scores):** `python -m tools_py.parity.audio_dips <endpoint.wav> --dump <mix.wav>` on ours (device
  against dump); `audio_parity.py` windows over the lobby music on both recordings; a listen for the stray ramping
  deviation on both (the envelope correlation and a spectrogram of the sign-in seconds).

**Bar:** two recordings, two scores, the stray sound's verdict, in a KNOWN §2 row "the lobby's sound" with the commands;
#94's bar step 1 met if A0 supplied the description.
**Verification:** the test; the two stamp directories; the KNOWN row.

## Task A2: #28's capture (conditional, D5)

- [ ] **Step 1 ([L], ours):** `mission_music_long.sh --minutes 12 --walk --target ours --stamp s17_a2_ours` under the lock.
- [ ] **Step 2 ([L], the console):** the same `--target pcsx2` (the script supports it; `docs/HAZARDS.md` audio for the
  route).
- [ ] **Step 3:** `audio_dips.py` per minute on ours; `audio_parity.py` window scores of the two against each other over
  the 12 minutes; the degradation the owner described as a column of numbers or its absence.

**Bar:** #28's bar as written (a 10+ minute in-mission capture scored against PCSX2 on the same mission); the issue
closed or its next shape written.

## Task A3: #42 on a quiet host, and T1b (conditional, D5)

**Files:** `scripts/parity/capture_audio_out.sh`, `agent/s15-t1b` (`795c93fe` and its fix round), `ps2xTest/src/socom2_audio_tests.cpp`.

- [ ] **Step 1:** T1b is merged (Sprint 16 V0, `ad5fdaef`, `b00863f7`); nothing to land -- its no-regression count is Step 2's.
- [ ] **Step 2 ([L]):** `MINUTES=11 bash scripts/parity/capture_audio_out.sh` with nothing else on the machine (the quiet
  marker); the dip count against the bar (6 total, 2 a minute).
- [ ] **Step 3:** if the count stays above 6/2: the T1b-revert trial KNOWN §2's T1b row names (the same capture on the
  pre-T1b exe), and the two counts side by side.

**Bar:** #42's count on a quiet host with the command; T1b at a recorded outcome.

## Task A4: #91 the ambient bed (conditional, D5)

**Files:** `ps2xRuntime/src/lib/snd989_mixer.cpp` (`applyVoiceVolume` and the stream mix, `554972e6`),
`ps2xTest/src/socom2_audio_tests.cpp`, `research/989snd-ziemas/` (git-ignored; `vol.c:147-149`, `:434-455`).

- [ ] **Step 1 (RED):** a case: a bank voice at volume 0x400 in group 0 with the master at 0x400 reaches the mixer at
  the gain the IRX chain gives (`snd_MakeVolumes` linear, then `snd_AdjustVolToGroup`), computed in the test from the
  decompiled formulas; a second case at volume 0x200 (the −6 / −12 dB question of `554972e6`). The issue's caveat is
  read first: if the IRX chain as decompiled says the square law is right, the RED is on the other term.
- [ ] **Step 2 (GREEN):** the term the case names; suite green; one capture (`launch_to_mission_xl` with the dump) and
  `audio_parity.py compare` against `scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json`: the fifteen mission
  windows within tolerance, the menu windows unchanged.

**Bar:** the 48-window comparison moves from 12/48 toward the Sprint 9 baseline's 31/48 with the mission windows
in; #91 at a recorded outcome.

## Task H1: the online menus' harness, scoped (D7)

**Files:** `docs/superpowers/specs/<date>-online-menus-harness-scope.md` (new, class S).

- [ ] **Step 1:** one row per screen or flow, each with: the drive steps from the nearest existing script
  (`launch_to_online_ours.txt`; the `@staged` steps of `online_login_ours.py`), the read-back that proves it (a
  reference crop under `scripts/parity/refs/`, a peek, a log line), the console reference (`pcsx2_shell` on our server),
  the cost to build (S/M/L). The rows: the clan pages (create, roster, invite, messages); the online SETTINGS pages;
  the lobby's rooms and the swapping between them (announcement, briefing rooms, clan chat); swapping teams in a game
  lobby; chatting both ways across the line (#26's bar as the first assertion); the microphone across the line.
- [ ] **Step 2:** the microphone row's precondition, in order: the talk action (research/39, unbound in
  `controller.rdr`), the send callback (research/56 §6.1), the audible receive (`voice-hear-the-other-player`, the
  Sprint 8 voice plan's Task 5), `voice-record-gain-and-dme`, `voice-research-35`; the row marked **cannot pass yet**.
- [ ] **Step 3:** the gate the checks run at — "when we need them", the owner's word — and the command shape of a run;
  the first row's cost to LATER with its trigger if the sprint does not build it.

**Bar:** the note with every row of spec §2 H; the doc test OK.

## Task 98: the lessons

- [ ] **Step 1:** the F numbers before and after in one table (F0's harness and player numbers; each attempt's phase
  before/after; the final three gates; `S=3` beside 1x); what Q0 taught (the argv, the search); A's counts.
- [ ] **Step 2:** `docs/LATER.md` re-sorted with the rows this sprint promoted or struck (rows 3, 7, 10, 32, 47 at
  least); `docs/UPSTREAM.md` if F1–F4 found a fork-worthy fix.

## Task 99: the close

- [ ] The `sprint-close` skill (`.claude/skills/sprint-close/SKILL.md`): the two reviews, the merged chain on the final
  exe (F6's three gates inside it), the Outcome, the PR `sprint-17` → `main`, the tag `v0.17.0`; `docs/CURRENT_SPRINT.md`
  and `docs/HANDOFF.md` rewritten; the owner's rows O7, O8, O20 updated with what was asked and when.
