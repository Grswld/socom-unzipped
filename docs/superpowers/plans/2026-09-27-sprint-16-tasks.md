# Sprint 16 -- the task book (the bodies of every task; the plan holds the table and the state)

Date: 2026-09-27. Split from the plan `docs/superpowers/plans/2026-09-27-sprint-16.md` at the open so the plan
fits the open-plan ceiling (59,100 bytes after the Sprint 15 close's ratchet, R279); the plan's table and Log are
the live state, this file is what an implementer is dispatched with. The readers' facts each task rests on:
`docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`. Class S by location. A body found false is corrected
here with a `> Superseded by` blockquote (rule 11); a task's state lives only in the plan's table.

## Task 0: the open

**Files:** `docs/CURRENT_SPRINT.md` (header and an OPEN block), `docs/HANDOFF.md` §2 (the one "now" bullet, the
counter) and §5 (who is in the tree), this file's Log and Rulings, the spec (two `> Superseded by` blockquotes),
`docs/KNOWN.md` (the V0 row), `docs/RULINGS.md` and `docs/SITTING.md` (regenerated).

- [ ] **Step 1:** when the Sprint 15 controller's line arrives with the tag: `git fetch origin && git tag -l v0.15.0
  && git merge-base --is-ancestor v0.15.0 origin/main && echo CLOSED`. The Sprint 15 controller's session ended its
  turn at 06:27Z with PR #81 open on its checks: if it does not return to merge and tag, this controller does both
  from the main tree (`gh pr merge 81 --merge`; `sha=$(gh pr view 81 --json mergeCommit -q .mergeCommit.oid)`; `git
  tag -a v0.15.0 $sha -m "Sprint 15: borrowed confidence, re-cut"`; `git push origin v0.15.0`; the CLOSED heading's
  hash in the sprint file). Then, from a tree that may push (the main tree, checked out to `sprint-16` by whichever
  session tags; this plan's worktree is for reading from then on): `git checkout -b sprint-16 origin/main` if the
  branch does not exist yet, then this plan's commit
  cherry-picked onto it (`git cherry-pick <sha>`; the worktree's `git log --oneline -1 --
  docs/superpowers/plans/2026-09-27-sprint-16.md` names it), then the pre-open branches that merged to `main`
  are already in (R3a, L2, L1a, X1 as the table's state column says at that hour).
- [ ] **Step 2:** the GitHub milestone: `gh api -X POST repos/Scotho/socom-unzipped/milestones -f title='Sprint 16'
  -f description='ten minutes to the server' --jq .number`; the sprint's issues (#70, #71, #73, #74, #59, #32, #57,
  #41, #69) moved onto it with `gh issue edit N --milestone 'Sprint 16'`.
- [ ] **Step 3:** fifteen rulings from the global counter (its next free number on), one per D1–D15, each with the decision, the
  cost and the overturn, in this file's "Rulings made on the owner's behalf"; HANDOFF §2's counter line moved;
  `python -m tools_py.rulings` and `python -m tools_py.sitting` run and their pages committed in the same commit.
- [ ] **Step 4:** the Sprint 15 assumptions (spec §1.4) checked and recorded in the Log, one line each: T2's code
  merged (`f84f4f66`, yes); T1b at a recorded outcome (no: DONE (code) on `agent/s15-t1b`, `795c93fe` plus the fix
  round, its GREEN build and review not landed before the close — its merge and its chain step are V0's);
  #69's fix merged (no: `agent/launch-rev` at `bca0d0d1` has no PR — R5 carries its run and
  its merge); #75 merged (PR #79 — its state that hour); the counter past the Sprint 15 controller's window ruling
  (HANDOFF §2 names the next free number). The four legs the owner
  deferred are copied from the Sprint 15 plan's Outcome into V0 verbatim, bars included.
- [ ] **Step 5 (rule 11):** two corrections in the spec, each a `> Superseded by` blockquote under the sentence it
  corrects, with the readers' evidence: (a) §1.2's table row for `s14_close1` — the stamp's rows
  (`mission.game.log:12815` and `:18196`) give 37.6 guest VBlanks/s, 369 ms/s of back-pressure wait (37 % of wall)
  and 14.2 idle sleeps/s over the walk, not 41.5 / 289 / 18.6 and 29 % (the author confirmed 06:20Z: an every-120th-row
  pass; the ladder row was computed the same way and is re-read from exact rows before a task cites it); the
  conclusion stands; (b) §1.1's and L1's "research/38
  and Sprint 13 W10 have the card's persona layout" — research/38 is the OSK routine and W10 a behaviour proof; the
  record is opaque (D12). Issue #73 gets the same comment. (c) R1's "the DNAS self-decrypt ported straight from the
  161-line Python" — `tools_py/dnas_selfdecrypt.py:10–12` reimplements no transform: it runs the overlay's four core
  routines under Unicorn, so the DNAS stage is the spike's question too (R1a). (d) R3's "the debugger and the probe
  binaries" — no such files exist; the words name the compile option `PS2X_ENABLE_DEBUG_UI` (`ps2xRuntime/CMakeLists.txt:18`)
  and the probes compiled in beside it, so the split is a second release configuration with its own exe (R3a).
  (e) X1's "PCSX2, Ghidra and the reference trees come back" — the backup's top level is cmake, ghidra, llvm-mingw,
  ninja, pcsx2, pcsx2_b; nothing in the tree or the backup names a reference tree (the phrase is
  `bootstrap_windows.sh:14`'s), so the manifest holds what the backup holds. (f) L1's bar and §4 item 5 cite #73's
  "a card with two saved personas shows both and launching with either logs in as it" — met under D12 for personas
  recorded through this build; a card whose personas predate it (or were made on a console) shows the "again"
  sentence and each appears after its first login here; the decode that would show them at once is a LATER row.
  Issue #73 gets that restated bar as a comment.
  Also the issues audit must exit 0 before the open: #71 cited as a known issue in KNOWN §1 without the
  `known-issue` label (the label, or the KNOWN wording).
- [ ] **Step 6:** the sprint file's header block rewritten (branch, spec, plans, next sprint, baselines) and the
  Sprint 16 OPEN block; the Sprint 15 CLOSED block left as the Sprint 15 controller wrote it; HANDOFF §2's bullet
  and §5's rows (this controller in the main tree; the peers); the `docmaint: future` markers off the spec's plan
  references; the next free research number read (`ls docs/research | sort -n | tail -3` → 73); KNOWN §2 gains the
  V0 row ("v0.15.0's T2 code unproven by a game run until V0; T1b's branch unmerged, its review, merge and capture
  in V0"); commit with the pathspec; push; `gh run list
  --commit` shows only `secrets` and `docs`.

**Verification:** `python -m tools_py.docmaint; echo $?` (OK and 0; the rulings line names the new highest);
`python -m tools_py.issues audit; echo $?` (0).

## Task V0: the Sprint 15 legs (D13) — one chain, the end of the first session block

**The owner's word (2026-09-27 06:16Z):** "it can close it's session without the play test and YOU run the play test at
the end." The legs, with their bars, verbatim from the Sprint 15 plan's Outcome (closed 06:27Z):

1. **The close chain on the merged tree** (`scripts/parity/merged_chain.sh`, one lock): the gate 3/3 PINS MATCH and the
   fourth leg 12/12 on the exe it builds; audio parity not below 31/48; the dip count at or below 6 (at most 2 in any
   minute) on a mission capture with the dump (research/68's state block has the commands) — this is also T1b's Step 3.
2. **T2's Step 3 (#67):** a ten-second title-bar drag in a mission with `PS2X_PC_SAMPLER=0.25 PS2X_AUDIO_TRACE=1
   PS2X_AUDIO_CB_TRACE=<csv>`: `python -m tools_py.parity.window_drag drag --log <game.log> --seconds 10 --stamps <file>`
   then `readout` must print ADVANCING with `cb_late +0 cb_dry +0 pcm_underruns +0` (exit 0); the before-capture on the
   pre-fix exe `logs/s15_t2_before_352fed01.exe` (needs `--stale-ok` — `gate.py`'s flag; a plain `drive.py` run of the
   stale exe checks no freshness) must read FROZEN or SLOWED; then a control round with one instance dragged mid-round;
   then KNOWN's #67 row moved and the issue closed on its bar. Watch the frames right after `WM_EXITSIZEMOVE` (a
   readback that returned early during the drag leaves stale VRAM for a frame or two).
3. **T1b at DONE (code) on `agent/s15-t1b`** (`795c93fe` plus the fix round, its GREEN build and review not landed
   before the close) — its merge and its chain step carried.
4. **T3 (#59) and T4 (#32):** unstarted; their rows stay in LATER with triggers (F0/F5 and F3 here).

V0's gate doubles as F0's first gate when the exe is the same and the host was quiet (the same instrument, the same
`FRAME` line); F0 then owes two more.

**Files:** `logs/s16_v0_chain.sh` (a copy of `scripts/parity/merged_chain.sh`), `logs/parity/gate/s16_v0/`,
`docs/KNOWN.md` (#67's row, the T1b register row, the V0 row), `docs/research/68-confidence-register.md` (the state
block), issue #67, `docs/PLAYTEST.md` (the chain writes its block).

- [ ] **Step 1 (the window):** announced in the Log and to the peer sessions with the hour; the desk idle 15 minutes
  or more (`GetLastInputInfo` through PowerShell, the run-gate skill's check); `bash scripts/check_quiet_gate.sh`;
  `bash scripts/loop_lock.sh check` free; `powershell -NoProfile -ExecutionPolicy Bypass -File
  scripts/kill_stale_drivers.ps1`; more than 3 GB free.
- [ ] **Step 2 (the chain):** on `sprint-16` with `main` at `v0.15.0` merged and no modified tracked file: `cp
  scripts/parity/merged_chain.sh logs/s16_v0_chain.sh && bash scripts/run_detached.sh --owner s16-v0 --purpose
  "launch: V0 the Sprint 15 legs" --wait 90 --class run logs/s16_v0_chain.sh logs/s16_v0_chain.marker s16_v0` — recomp,
  runtime, `./build.sh test` (the Python suite, `ps2x_tests`, `--vram-diff` 15/15), the gate on the exe it built, the
  fourth leg, the release build, PLAYTEST's block; poll the marker, never wait in the foreground. Leg 1's bar: the
  gate summary's `PINS MATCH` line and the leg's `12/12`.
- [ ] **Step 3 (T2's drag, leg 2):** under the same lock holding or the next: a mission run with
  `PS2X_PC_SAMPLER=0.25 PS2X_AUDIO_TRACE=1 PS2X_AUDIO_CB_TRACE=<csv>`, `python -m tools_py.parity.window_drag drag
  --log <game.log> --seconds 10 --stamps <file>` after the HUD, then `readout`: ADVANCING with `cb_late +0 cb_dry +0
  pcm_underruns +0` (exit 0); the frames right after `WM_EXITSIZEMOVE` looked at; the before-capture on the pre-fix
  exe `logs/s15_t2_before_352fed01.exe` reads FROZEN or SLOWED; then a control round (the ladder's RUNG0 rules,
  `docs/LADDER.md`) with one instance dragged mid-round: both instances finish the round, the kill lands.
- [ ] **Step 4 (T1b, legs 1 and 3):** T1b's branch first: its fix round's GREEN build (`bash scripts/loop_lock.sh run
  s16-v0 --class build -- ./build.sh test`), a fresh review, the merge into `sprint-16` — or, if its review fails,
  the branch stays out and the Log says so; then the mission capture with the endpoint recording
  (`scripts/parity/audio_parity.sh`'s live capture, WASAPI loopback, the desk idle) on the merged exe: `python -m
  tools_py.parity.audio_parity compare scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json
  <capture>/audio_scores.json` ≥ 31/48; `python -m tools_py.parity.audio_dips <capture>/endpoint.wav --dump
  <capture>/mix.wav --log <game.log>` ≤ 6 DEVICE dips, at most 2 in any minute (research/68's commands). If T1b
  merged after the chain of Step 2, the chain's gate is re-run on the exe that carries it.
- [ ] **Step 5:** KNOWN moved with the artefacts (#67's row to fixed; the T1b register row; the V0 row retired or
  kept with the failing leg); issue #67 closed on its bar; research/68's state block; the Log; commit. A red leg is
  a KNOWN row and an issue, never a silent carry (a red gate blocks every later chain until fixed).

**Verification:** the chain's marker `exit=0` and `logs/merged_chain.last_green` moved; the gate's summary line;
the drag readout; the two audio numbers with their commands; `python -m tools_py.docmaint; echo $?`.

## Task F0: the baseline and the profile — one window of about an hour on a quiet host

**The window:** the three gates and the two plain runs are game runs — a window the owner names (O20), or the owner's
word of 2026-09-27 (D13) if the desk stays idle after V0; V0's gate counts as the first of the three when the exe is
the same.

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task F0 section.

**Files:** `docs/research/73-mission-frame-time.md` <!-- docmaint: future --> (new, class S by the glob; "where a mission frame's time goes"),
`tools_py/tests/test_mission_frame_note.py` (new), `logs/parity/gate/s16_f0_gate{1,2,3}/`, `logs/parity/f0/`,
`logs/hostprof_f0_game.txt`, `logs/hostprof_f0_gl.txt`, `docs/KNOWN.md` (#59's row: the three numbers).

- [ ] **Step 1 (RED):** `test_mission_frame_note.py`: the note names three costs ranked with a number and a
  command each; names the phase or function that carries the largest share of the GL thread's second; says in one
  sentence whether the EE thread is within 20 % of the wall; carries the three gates' `FRAME` lines and the spread
  against the median; cites `hostprof_symbolize.py` and `hostprof_stacks.py` runs by command. Run while the note is
  absent: it fails; paste the run.
- [ ] **Step 2 [L] (the three gates):** the window announced; the desk idle; no agent building. `bash
  scripts/loop_lock.sh run s16-f0 --purpose "launch: F0 three gates" --wait 60 -- bash -c 'for i in 1 2 3; do
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kill_stale_drivers.ps1; python -m tools_py.parity.gate
  --stamp s16_f0_gate$i --owner s16-f0 || exit $?; done'`; each `summary.txt` line 4 is the `FRAME` line; the spread
  is the largest distance from the median over the median (S13-R3's ~10 %).
- [ ] **Step 3 [L] (the plain run, game thread):** the gate's scene by hand (a plain run, not the gate — a knob in
  the gate's mission env drifts the `env` pin, exit 7): `mkdir -p logs/parity/f0 && cp -r game/disc/mc0_parity
  logs/parity/f0/mc0 && bash scripts/loop_lock.sh run s16-f0 --purpose "launch: F0 mission profile (game thread)"
  --wait 60 -- env PS2X_MC_DIR="$PWD/logs/parity/f0/mc0" PS2X_HOST_GAMEPAD=0 PS2X_PC_SAMPLER=1 PS2X_GS_STATS=1
  PS2X_GS_UPLOAD_TRACE=1 PS2X_HOST_PROF=1 PS2X_HOST_PROF_STACKS=1 PS2X_HOST_PROF_OUT=logs/hostprof_f0_game.txt
  PS2X_RUN_LOG="$PWD/logs/parity/f0/mission_game.log" python -m tools_py.parity.drive --target ours --script
  scripts/parity/gameplay_probe.txt --out logs/parity/f0/mission_game --seconds 480 --tail 170`. The log carries
  `[host-prof] sampling every 1 ms -> ...`, the `[gs-gl stats] ... submit= transfer= upload= ...` line every 60
  command buffers, the backpressure and reasons lines, `[gs-upload] ... shadow= mark= record= convert= gl=` and
  `[gs-transfer] ... flush= body= dirty_rows= decode= draw=` (ms/s), and the sampler rows. The profiled run's own
  `FRAME` line is not a baseline (the sampler suspends the thread every millisecond).
- [ ] **Step 4 [L] (the plain run, GL thread):** the same with `PS2X_HOST_PROF_MAIN=1
  PS2X_HOST_PROF_OUT=logs/hostprof_f0_gl.txt PS2X_RUN_LOG=.../mission_gl.log --out logs/parity/f0/mission_gl`
  (`PS2X_HOST_PROF_MAIN` samples the thread that called `PS2Runtime::run`, the GL replay thread).
- [ ] **Step 5 (lock-free):** symbolise against the exe that ran (the unstripped `dist/socom2.exe`, `llvm-nm` under
  `tools/llvm-mingw`): `python tools_py/hostprof_symbolize.py logs/hostprof_f0_game.txt --top 40 --exe
  dist/socom2.exe`; `python -m tools_py.hostprof_stacks logs/hostprof_f0_gl.txt --exe dist/socom2.exe --top 30`; the
  phases per second from the `[gs-transfer]` and `[gs-upload]` lines over the post-HUD window; the sampler's
  `bp_wait_ms=` and `idle=` differences (cumulative counters) per second; the `same_rewritten` share from the
  reasons line. The note: the two symbolised profiles, the flush phases per second, the three `FRAME` lines and the
  spread, the top three costs ranked with numbers and commands, the EE-thread sentence, and the F2/F3/F4 triggers
  it fires or does not.
- [ ] **Step 6 (GREEN):** the test passes; review by a fresh agent (every number re-run from its command); KNOWN's
  #59 row gains the three gates and the spread; commit `docs(research): where a mission frame's time goes -- two
  profiles, the flush split, three quiet gates (Sprint 16 F0)`.

**Bar:** the note names the phase or function that carries the largest share of the GL thread's second, and says
whether the EE thread is within 20 % of the wall after it; the three gates' spread is written whether or not it is
under 10 % (F5 decides on it).

**Verification:** `python -m unittest tools_py.tests.test_mission_frame_note 2>&1 | tail -3`; the three summary lines;
`python -m tools_py.docmaint; echo $?`.

## Task F1: `-O2` for the generated code, an A/B (D2)

**Measurement:** `FRAME mean=` on one gate against F0's median; the zip size against R151's numbers (release matrix
M1_O2: exe −9.9 %, zip +4.6 MB, 62,787,774 vs 58,221,191 bytes; 1,640 s wall; never gated — KNOWN §2's R151 row).
Adopted only if the mean improves 10 % or more and the zip grows under 5 MB; otherwise R151 stands with the speed
number beside it. Expected: little change while the renderer is the wall.

**Files:** `build.sh` (`GENOPT` at :130 for the developer runtime, `REL_GENOPT` at :158 for the release),
`tools_py/tests/test_make_portable.py:123–125` (pins `${REL_GENOPT:--O1}`, the release default only; nothing pins the
developer default at :130 — a new assertion), `docs/KNOWN.md` (the R151 row), `docs/HAZARDS.md` (the R151 row).
**When:** after F2's first attempt has a number, in F2's window or the next — not before (the expected null result
would cost 67 minutes for a number while the renderer is the wall).

- [ ] **Step 1 (RED, only if adopting):** the release-default assertion fails when `REL_GENOPT`'s default moves, and
  a new assertion pins the developer default; paste them. If not adopting, no code changes and Step 1 is the number
  alone.
- [ ] **Step 2 [L]:** `bash scripts/loop_lock.sh run s16-f1 --purpose "build: F1 -O2 runtime" --wait 120 -- env
  GENOPT=-O2 ./build.sh runtime` (about 50 minutes at `-j 4`; 983 s at the developer parallelism for `-O1`), then one
  gate on `dist/socom2.exe`: `python -m tools_py.parity.gate --stamp s16_f1_gate --owner s16-f1` — 3/3 PINS MATCH is
  the no-regression bar; the `FRAME` line is the number. The size half only if the speed half passes: `REL_GENOPT=-O2
  ./build.sh release` and the zip's bytes.
- [ ] **Step 3:** the outcome in KNOWN's R151 row (ADOPTED with both defaults moved and the pinning test updated, or
  TRIED, NOT ADOPTED with the number) and HAZARDS' row; the developer exe rebuilt at `-O1` if not adopted before any
  later gate; commit.

**Verification:** the two `FRAME` lines side by side; the gate summary; the zip's byte count.

## Task F2: the GL thread's top phase — one design, one measured attempt, at most two

**Measurement:** the phase F0 ranks first among `dirty_rows=`, `decode=`, `draw=` (the `[gs-transfer]` line) or
`shadow=`/`gl=` (the `[gs-upload]` line), in ms/s on the mission scene; today's number is F0's. Bar: that phase's
ms/s halved on the same scene with D6's bar green; stop rule: under a 25 % drop after one design, TRIED, NOT ADOPTED
with the number. A second attempt only if the first adopted and the guest still waits more than 100 ms/s
(`bp_wait_ms=` per second).

**Files:** `third_party/ps2recomp/ps2xRuntime/src/lib/gs/gs_gl_backend.cpp` (`executeSubmit` :3751–3775 merges
consecutive submits under one `DrawKey` and `flushBatch` :4052–4062 draws through `setupDrawState` →
`refreshDirtyRows` / `resolveTexture` :3546), `include/runtime/gs/gs_gl_upload_trace.h` (the phase accumulators
:48–80), `third_party/ps2recomp/ps2xTest/src/ps2_gs_tests.cpp` (the case), the design paragraph in this Log.

- [ ] **Step 1:** the design, one paragraph in the Log, from F0's note: which phase, why it costs what it costs (the
  hash revalidation, the row refresh granularity, the decode's cache misses, the draw setup's state churn), the one
  change, and the counter that will show it (a `gs_gl_upload_trace.h` accumulator or a reasons-line field).
- [ ] **Step 2 (RED):** a `ps2_gs_tests.cpp` case on the CPU backend or the trace counters that fails today and
  passes when the change is in (the phase's work counted, not its time: e.g. rows refreshed per flush for a planted
  scene, decodes per texture change); paste the run through `bash scripts/loop_lock.sh run s16-f2 --class build --
  ./build.sh test`.
- [ ] **Step 3 (GREEN, [L]):** the change; `./build.sh test` (the case, `--vram-diff` 15/15, the console-replay case;
  `PS2X_CONSOLE_REPLAY_GL=1 ./build.sh test` for its GL half); review by a fresh agent; then one plain mission run
  with the trace as F0's Step 3 and one gate: the phase's ms/s before and after on the same scene, the gate 3/3 PINS
  MATCH, the fourth leg.
- [ ] **Step 4:** ADOPTED or TRIED, NOT ADOPTED in KNOWN (a new §2 row with the phase, the two numbers and the
  stamps) and in the Log; a moved pixel or score is NOT ADOPTED whatever the number.

**Verification:** the two `[gs-transfer]`/`[gs-upload]` readings; the gate summary; `./build.sh test` exit 0.

## Task F3: the upload path, conditional (D8) — the identical-bytes skip for `same_rewritten` tiles

**Runs only if F0 ranks uploads (`upload=`, the shadow swizzle term) in the mission's top three.** Either way, #32's
title and bar are corrected in this task to the identical-bytes skip (R108b: the GL side already uploads whole bands;
Sprint 13 V2: 40 % of the remaining uploads are `same_rewritten`, the skip knob stays off because R122's guard refused
84 % of identical uploads).

**Measurement:** `upload=` on the scene F0 named (mission: about 45 ms/s at 10k uploads/s, KNOWN §2; login: 106–115
ms per 60-call window, V2's A/B). Bar: halved on that scene with D6's bar green; stop rule: under 25 % after one
design, TRIED, NOT ADOPTED.

**Files:** `third_party/ps2recomp/ps2xRuntime/include/runtime/gs/gs_gl_upload_reasons.h` (`Gate::decide` :217–240,
the order New / Changed / SameRewritten / SameUnderGpu / SameFree; `same_gpu` :18–20 is R122's guard and stays ahead of
any skip), `src/lib/gs/gs_gl_backend.cpp` (the term-(a) block :2186–2200 calls the shadow's swizzle),
`src/lib/gs/gs_cpu_backend.cpp` (`GSCpuBackend::UploadImage` :1471, the swizzle), `ps2xTest/src/ps2_gs_tests.cpp`,
issue #32, `docs/LATER.md` row 4, `docs/KNOWN.md` (#32's rows).

- [ ] **Step 0:** `gh issue edit 32 --title "The menus and the mission re-upload identical tiles: the identical-bytes
  skip for same_rewritten tiles is the untested fix"` and the bar rewritten in a comment (the skip, the same scene,
  `upload=` halved, the gate 3/3); LATER row 4's trigger; KNOWN's row. If F0 did not fire the task, stop here with
  the trigger "F0 names uploads in the top three".
- [ ] **Step 1 (RED):** a `ps2_gs_tests.cpp` case: a tile uploaded twice with identical bytes while its blocks were
  written between (today `same_rewritten`, swizzled again) is decided `skip` when the bytes compare equal and the
  GPU-drawn-target guard does not fire; and a tile under a GPU-drawn target is never skipped. Fails today; paste.
- [ ] **Step 2 (GREEN):** the byte compare of the incoming tile against the shadow before the swizzle (a 1 KB
  `memcmp` per `same_rewritten` tile; the cost is the number to watch), `decide()` extended after `SameUnderGpu`;
  the case passes; `./build.sh test`; review.
- [ ] **Step 3 [L]:** a plain run on the scene with `PS2X_GS_STATS=1 PS2X_GS_UPLOAD_TRACE=1` before and after; the
  gate 3/3 and the fourth leg; the outcome in KNOWN and #32.

**Verification:** the case; the two `upload=` readings; the gate summary.

## Task F4: an EE-side lever, conditional — the per-instruction PC store

**Runs only if F0 (or F2's outcome) shows the EE thread within 20 % of the wall.** The store is
`third_party/ps2recomp/ps2xRecomp/src/lib/function_emitter.cpp:206–207` (`ctx->pc = 0x...u;` before every translated
instruction, unconditional; 122 stores in a 425-line function); the emitted `ctx->pc` is what `[pc-sampler] dpc=`, the
`[guest-fault]` lines, the peeks and the mission probe read, so the conditional form keeps the store before anything
that can leave the function or fault (a call, a syscall, a memory access that can trap, a branch out) and drops it
before pure register arithmetic only.

**Files:** `function_emitter.cpp`, `tests/fixtures/recomp_ref/expected/` (regenerated in the same commit — the
`recomp-ref` CI job re-derives it, `.github/workflows/linux.yml:162–202`), the recompiler's tests, `recomp/socom2.toml`
if a knob is added, `docs/KNOWN.md`.

- [ ] **Step 1 (RED):** a recompiler test: for a planted function of N pure ALU instructions between two memory
  accesses, the emitted C++ carries stores only before the accesses; fails today (every instruction stores).
- [ ] **Step 2 (GREEN):** the emitter change; the test; the reference fixture regenerated
  (`ps2_recomp recomp_ref.toml` and `diff -r`); review.
- [ ] **Step 3 [L] (R283):** the full recomp (273 s) and runtime build (983 s) under the lock; `./build.sh test`; the
  gate — the pins are expected to drift (the generated image changes shape): a green run, then `--accept-pins`
  under a ruling; the `FRAME` line against F0's; the fourth leg; the `recomp-ref` job green on the push.
- [ ] **Step 4:** the outcome in KNOWN (the EE-thread share before and after) and the Log.

**Verification:** the recompiler test; `diff -r` of the fixture; the gate summary and the ruling number for the pins.

## Task F5: the fence — #59's ceiling as a refusal

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task F5 section.

**Files:** `scripts/parity/pins.json` (a new top-level `frame` block: `mean_ms_ceiling`, `worst1s_ms_ceiling`,
`from` — the three stamps — and `host`, the harness string the gate already records), `tools_py/parity/pins.py`
(`load_expected` accepts the block without treating it as a drifted pin; a `frame_ceiling()` reader), `gate.py` (the
refusal beside `refused` at :1601–1614 when the harness matches, and the baseline re-score at :752),
`tools_py/tests/test_gate_frame_time.py`, `docs/KNOWN.md` (#59's row), issue #59, `docs/LATER.md` row 3.

- [ ] **Step 1 (RED):** two cases: a mission stage whose `FRAME mean=` is over the ceiling on the same host is
  refused (exit 7 with a `FRAME OVER CEILING` line) — today it passes; and the same run under a differing harness
  block prints the informational line and passes (Review Focus 5). Paste the failing run.
- [ ] **Step 2 [L] (the close chain):** the three gates on the final exe (V0's or the close chain's exe; the third
  and second may be the close chain's own gate plus two more under the same holding); the median and the spread.
- [ ] **Step 3 (GREEN):** if the three agree within about 10 %: the block written into `pins.json` with the three
  stamps, the cases pass, `--accept-pins` never writes it (the ceiling is a ruled number, not an accepted pin);
  KNOWN's row moved to fixed with the stamps, F0's baseline against the final exe in the release notes and KNOWN;
  #59 closed. If they do not: no rule, the three numbers and the spread in KNOWN's row, LATER row 3 keeps #59 with
  the trigger "a quiet host where three gates agree".

**Verification:** `python -m unittest tools_py.tests.test_gate_frame_time 2>&1 | tail -3`; the three summary lines;
`python -m tools_py.parity.gate --baseline` printing the ceiling line.

## Task L1a: #73 the design note (in flight in the cloud, D14)

**Files:** `docs/superpowers/plans/2026-09-27-sprint-16-l1-profile-viewer-design.md` <!-- docmaint: future --> (the cloud session's one file,
branch `agent/s16-l1-design`), this file (the D12 ruling and L1b's steps sharpened from the note).

- [ ] **Step 1:** the note lands (the six sections: what the card holds, the viewer, the password, the fixtures, the
  files, the open questions with defaults) with `path:line` for every claim and "not in the tree" where a fact is
  missing.
- [ ] **Step 2:** review by a fresh local agent against the L reader's findings: the record is opaque
  (`BASCUS-97275SOCOMII` 0x1650–0x17ad, +48 B per persona, no ASCII name on either persona-bearing card under
  `logs/`); nothing decodes it; `config.json` holds `loginName`/`loginPassword` (`launcher_config.cpp:154–155`) and
  exports `PS2X_SOCOM2_LOGIN_NAME/PASS` only when non-empty (:549–554); `PS2X_MC_DIR` is `cards/<profile>[_b]` (:545)
  so `profile` stays the folder key; the ONLINE nodes (`focus.cpp:251–278`) and the height budget under the fields
  (:275–277, the second-instance toggle at y+188/y+224).
- [ ] **Step 3:** the D12 ruling written with the note's answer (the ledger, or the decode spike if the note names
  the serialiser from research/38's `FUN_00276af0` / `GetMUISPersonaInfo` rows); L1b's file list and cases updated
  from the note; merge the note to `main` (docs only, R294).

**Verification:** `python -m tools_py.docmaint; echo $?` with the note in the tree.

## Task L1b: #73 the build

**The shape (D12; the authority is L1a's note after its fix round, `docs/superpowers/plans/2026-09-27-sprint-16-l1-profile-viewer-design.md` <!-- docmaint: future -->):**
the **runtime** holds a record from the login request (the `rc4EncryptFn` seam, `socom2_crypto.cpp:311`; class 0x01,
type 0x07, Username at payload offset 40, Password at 72 — `server/horizon-server/RT.Models/Lobby/MediusAccountLoginRequest.cs`,
read-only; the fallback seams are the hostnet `send`/`recv` pair, `socom2_hostnet.cpp:577/:587`, a TCP stream
carrying the WIRE form — the RT header (id|0x80, a 2-byte length, a 4-byte hash) then RC4 ciphertext — so a fallback
reassembles by RT header AND decrypts with the session key and the header's hash (`rc4SetKeyHash`,
`socom2_crypto.cpp:294-302`) before it can read class 0x01 type 0x07; the RC4 seams, which see the clear text, are
the first choice) and **commits it on the success response** (type 0x08, StatusCode at offset 26, `rc4DecryptFn`
`:318–323`, matched by MessageID) to `cards/<profile>.personas.json` **beside the card** (a trailing separator on
`PS2X_MC_DIR` stripped first, else the ledger lands inside the card and the game lists it), atomically, through
`ps2x_shared`'s `personas.cpp`; **one record per (name, server)** (the game keeps personas per server, KNOWN §1) with
the **instance** (`a`/`b`) recorded in the record, never inferred from a `_b` suffix; `savedPassword` per login = no
password keyboard opened since the last **committed success** (the observer installed unconditionally; the flag
cleared on a committed success, not per request, so a failed CONNECT's retry under SAVE PASSWORD NO stays false) and a
non-empty Password; the JSON reader's `\u` branch maps 0x80–0xFF to the byte so an accented name round-trips; the
launcher lists the records under PERSONAS (three rows visible, the list scrolling inside itself, NEW PERSONA its last
row, the ADDRESS row re-anchored), newest first, the server label by matching `kServerPresets[i].address` against the
record's server; `LayoutInputs` gains the row count, the scroll, the selected index and a "password shown" flag, and
a row narrows while the field shows; picking a row sets `profile` and `loginName` and clears the typed password — a
name that does not survive `normalizeLoginName` unchanged leaves `loginName` empty; the three fields go; a masked
PASSWORD (`online.persona.password`) beside the selected row when its record says the card does not hold one **or
there is no record**, and for NEW PERSONA; `config.json` writes `loginPassword` only then and otherwise keeps the key
empty (`diagnostics_tests.cpp:109` requires the key). **Step 0 [L]:** a driven two-persona card (`online_login_ours.py`,
V0's window or the next) records which persona the game's list gives the form, and lists the card's files before and
after the first create (is `SaveGame*` a persona?); the driver as it is cannot make the second persona —
`persona_form_mode` reads a filled PLAYER NAME as "saved" (`:914-920`, `:1882-1910`) and nothing walks the list to
`<New Persona>`, so a second create-persona login on the same card and server logs in as A typing B's password —
so Step 0 first adds a new-persona path through the game's list (an option, the presses, the assertion that the
form opens empty), or is recorded as a hand-driven step; then the runtime steers the list or a ruling re-words the
bar's "logs in as it" (the row says "pick <name> in the game's list"). Rule 11 in this task: `knobs.h:164`'s "plain
in the player's config.json" (then `python -m tools_py.knobs write`); the R237/R179 rows already read "superseded
by R310" (merge `7b2e76bc`, 08:29Z); `docs/INSTALL.md` and `docs/PLAYTEST.md` were corrected by PR #84 already.

**Files:** `third_party/ps2recomp/ps2xLauncher/src/ui/page_online.cpp` (:77–108 the three fields, the rows),
`src/ui/focus.cpp` (:251–278 the ONLINE nodes: `online.persona.N`, `online.persona.new`, `online.persona.password`;
the help rows at :308–363), `src/ui/focus.h` (`LayoutInputs`: the row count, the scroll, the selected index, the
password-shown flag), `third_party/ps2recomp/ps2xShared/include/launcher/personas.h` and `src/personas.cpp` (new, in
`ps2x_shared`: `readLedger`, `readLedgers`, `toJson`, `fromJson`, the atomic write), `ps2xRuntime/src/lib/socom2_persona_record.cpp`
(new: the request parsed at the seam, the record committed on the success response), `ps2xShared/src/launcher_config.cpp`
(:154–155 the conditional write, the key kept; :549–554 the env from the selection; `findServerPreset` at
`launcher_config.cpp:39–45`, declared `.h:262`, made a match by address), `ps2xShared/src/json_reader.h` (:71–74 the
`\u` branch, pinned by the personas writer's round trip — the config writer's `quote` writes 0x80+ raw, so a config
round trip can never be RED), `third_party/ps2recomp/ps2xTest/src/launcher_tests.cpp` (the cases; the portable
disk-fixture pattern of `preflight_tests.cpp:24`, never a real card), `tools_py/parity/online_login_ours.py` (Step
0's new-persona path; `--saved-password` proves a card-held password logs in untyped),
`docs/KNOBS.md` (regenerated for `knobs.h:164`), `docs/FAQ.md`'s login answer.

- [ ] **Step 1 (RED):** `launcher_tests.cpp` cases from fixtures under a temp folder (the portable pattern of
  `preflight_tests.cpp:24`, not the POSIX-only block): an absent, empty (0 bytes and `[]`) or corrupt (truncated)
  ledger reads as empty with the one sentence, the NEW PERSONA node and its `online.persona.password` field present
  and no `online.name`/`online.password`/`online.profile` node; a ledger with two personas builds two rows and
  selecting the second sets the launch's name and clears the password; a fourth persona scrolls; a name with every
  name-keyboard character (0x21–0x7E but the double quote, including the backslash, braces, colon and comma) and an
  accented name round-trip through `toJson`/`fromJson` byte for byte and are shown, not refused (Review Focus 4); a
  name `normalizeLoginName` would change leaves `loginName` empty; two records with one name on two servers are two
  rows; the writer parses a synthetic 104-byte request (class, type, length, the two fields) and a response, commits
  only on success, keys by (name, server) with the instance, and writes temp-then-rename; `config.json` saved from a
  Config whose selected persona's record reads `savedPassword: true` carries `"loginPassword": ""`, one whose record
  reads false or is absent keeps the typed value; the writer, fed a login request after the password keyboard OPENED,
  writes `savedPassword: false`, and a request retried after a failed CONNECT under SAVE PASSWORD NO stays false (the
  flag clears only on a committed success). Paste the failing run (`bash scripts/loop_lock.sh run s16-l1b --class
  build --wait 60 -- ./build.sh test`).
- [ ] **Step 2 (GREEN):** the ledger, the page, the nodes, the config change, the help rows (the ≥ 25-character rule of
  `launcher_tests.cpp:1428`); the suites; review by a fresh agent; the height budget (`focus.cpp:43–47`: the caption
  four units above the body's floor) holds with three rows, the list capped and scrolled beyond.
- [ ] **Step 3 [L]:** the launch half: `python -m tools_py.parity.online_login_ours --saved-password --mc-dir
  <card with a saved persona>` on a launcher-started run proves the card-held password logs in untyped; "as the
  picked persona" is claimed only from Step 0's two-persona run; a screenshot of the viewer with two rows for the
  record (`--screenshot` sets `ctx.fake`, so a focus-based capture).
- [ ] **Step 4:** KNOWN's rows (the card and password rows: R237's prefill superseded), #73 closed on its bar, the
  Log; commit.

**Bar (D12's restatement of #73's, the "two saved personas" clause):** the three fields gone from ONLINE; a fresh
install shows the empty viewer's one sentence and a working new-persona path; two personas recorded in the sidecar
show both and either launches as itself (Step 0's two-persona run settles the mechanism; `--saved-password` proves
the untyped login); a card with personas and no sidecar shows the "again" sentence (an inference to be confirmed by
Step 0's card listing) and each appears after its first login through this build; `config.json` keeps no plain
password for a persona whose record says the card holds it (the key stays, empty); the sidecar read tested from
fixtures, never a real card.
**Verification:** `ps2x_tests` through `./build.sh test` under the lock; the login driver's `login:saved-password`
class line; a fresh `config.json` after a saved-password launch reads `"loginPassword": ""`.

## Task L2: #74 tooltips (in flight in the cloud, D14)

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task L2 section.

**Files:** `page_controller.cpp`, `focus.cpp`/`focus.h` (the per-page tables, `helpFor` reading the page's table
first), `widgets.h`/`widgets.cpp` (`Ctx` gains `hoverSince`/`hoverId`; a `tooltip()` drawn near the control after
about 500 ms), `main.cpp` (the band shows the focused control's line; the hover tooltip drawn last),
`ps2xTest/src/launcher_tests.cpp` (the case: every focusable CONTROLLER id in SETUP, BUTTONS and the dialog has a
non-empty line in the page's table; the `helpedIds` ≥ 25-character rule kept for the rows it lists), `docs/DEVELOPING.md`
(the `ps2x_tests` count).

- [ ] **Step 1:** the cloud session's PR (`agent/s16-l2-tooltips` → `main`) with RED and GREEN pasted from
  `scripts/build_linux.sh test --no-runner`.
- [ ] **Step 2:** review by a fresh local agent against the hazards above (the bottom bar, as #74's "footer" says —
  this line's "the band, not the bar" was wrong, corrected 2026-09-27 09:08Z on the round-2 review; `ctx.fake`; the
  wording test; the 25-character floor; the crouch cell's line says what the current value means, e.g. "L3: press the
  left stick to crouch; the game's own crouch key stays"); fix rounds in the cloud or locally; then the Windows build
  and `./build.sh test` under the lock before the merge (the cloud proved Linux only).
- [ ] **Step 3:** merge under R294; #74 closed on its bar; `focus.h:114–117`'s rationale rewritten in the same
  change; the Log.

**Verification:** `ps2x_tests` on both platforms; a screenshot of one tooltip for the record (a forced-hover path
under `--screenshot`, or the focus band).

## Task R1a: #70 the spike — recompile the decrypt routines, or port them? (half a day, Fable)

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task R1a section.

**Files:** `docs/research/74-first-run-decrypt-spike.md` <!-- docmaint: future --> (new; the research/14 shape:
the decision first, the enumeration, the cost, the outline, the open questions), `tools_py/tests/test_decrypt_spike_note.py`
(new), a scratch toml and CSV under `recomp/build/` (ignored) for the experiment.

- [ ] **Step 1 (RED):** the test: the note's first section is the decision (recompile / port / neither) with the
  reason; both routes carry a line count that enters the tree and the HLE each needs (the SIF, cdvd and kernel
  answers `decrypt_apache.py` stubs); the verification names the digests file and the "skipped where the disc is
  not" pattern (R222); the helper's home is named (the runner or `ps2xShared`). Fails while the note is absent.
- [ ] **Step 2 (route a, the experiment, lock-free):** from the function map, the call graph reachable from the five
  loader entries and the four DNAS cores as a CSV of only those rows; a helper ELF from the loader and
  `DNAS.dec.bin` by `make_overlay_elf.py`; `ps2_recomp helper.toml` (seconds, no build) — the generated function
  count, the syscalls and SIF/cdvd calls they make (the HLE surface), the R5900-only encodings the runner already
  handles. If the box allows, one compile of the generated files against the runtime's headers under the lock
  (`--class build`, announced) to prove they link; otherwise the count decides.
- [ ] **Step 3 (route b, reading):** the decompilation's size for the same graph (lines); which layers are known
  primitives (RSA/MD5, a 3DES variant, zlib) and which are the loader's own (the "unique" layer, the four DNAS
  cores); the risk that a port is not bit-exact and only the digests catch it.
- [ ] **Step 4 (GREEN):** the note with the decision, the lines that enter, the HLE, the helper's home, how the
  DISC page drives it (a subprocess with progress lines on stdout, or a `Worker` thread in the launcher), the
  verification plan, the open questions with defaults; the test passes; review by a fresh agent (the counts re-run
  by command); the D3 ruling's text in the Log. If the answer is neither, R1b, R2 and R3b stop with the reason and
  the release keeps the developer-copy path (R290).

**Bar:** the note names the route, the lines that enter the tree, and how the result is verified without disc bytes.
**Verification:** `python -m unittest tools_py.tests.test_decrypt_spike_note 2>&1 | tail -3`; `python -m tools_py.docmaint; echo $?`.

## Task R1b: #70 the build

**Depends on:** R1a's route (D3's ruling) and R5's merge (`agent/launch-rev` rewrites exit 68's sentence and adds
`GameRevision::elfName`; branch after it). **What the tree has:** the `iso9660` reader walks the root only
(`ps2xShared/src/iso9660.cpp:47–88`; port `tools_py/iso_lbn.py:24 parse_dir`); the DISC page (`page_disc.cpp`; the
six sentences `focus.h:187–196`; the nodes `focus.cpp:164–168`) has no progress state; the background-job pattern is
`Worker` (`main.cpp:324–371`); exit 68 is `exit_codes.h:31` (≤ 120 characters, no double quote), quoted by
`docs/INSTALL.md:52-54`, `docs/FAQ.md:60-66`, `docs/DEVELOPING.md:613`; the preflight emits it at `preflight.cpp:81–87`.

**Files:** `ps2xShared/src/iso9660.cpp` and `include/launcher/iso9660.h` (`findFile(read, "OVERLAY/REL/DNAS.BIN", out)`),
`ps2xShared/include/launcher/first_run.h` + `src/first_run.cpp` (new: `readInputs(iso, out)`, `verifyInputs(out)`
against a tracked table generated from `disc_to_elf_expected.json`, `buildElf(...)` per the route, `writeVerified(path, bytes, sha)`
— a temporary name, renamed only after the digest matches), the decrypt helper where R1a put it (route a: the runner,
`socom2.exe --build-elf <iso> <out>` printing `progress <n>/<m> <stage>` lines; route b: `ps2xShared/src/decrypt/*.cpp`),
`page_disc.cpp` + `focus.cpp:164–168` + `focus.h:187–196` (a fourth node `disc.build` BUILD PROGRAM IMAGE; the
sentences `kDiscBuilding`, `kDiscBuilt`, `kDiscBuildFailed`; a progress bar drawn like the hold bar), `main.cpp` (the
Worker or the subprocess, the progress), `exit_codes.h:31` ("The program image is not built yet: open the DISC page.")
and its three doc homes (R3b), `ps2xTest/src/first_run_tests.cpp` (new), `ps2xTest/src/launcher_tests.cpp` (the
DISC nodes and sentences), `tools_py/disc_to_elf_expected.json` (unchanged: the truth).

- [ ] **Step 1 (RED):** C++ cases on synthetic fixtures under `temp_directory_path()` (the `launcher_tests.cpp:2447–2454`
  pattern; the Python `SyntheticIsoTest` ported for a two-level ISO): the directory walk finds a file under
  `A/B/`; a fixture whose input digests differ from the table is refused before any write (Review Focus 1); a
  partial file at the output name is discarded and the build starts over (Review Focus 2); the progress states
  advance building → built / failed; the ZDB container's entries parsed from a synthetic header (count at 0x98,
  entries from 0xa0, name at +4, offset and length at +0x44). One real-disc case: where `game/disc/` or the ISO
  is, the whole build runs and matches the ELF's tracked sha with its wall time printed; elsewhere it prints
  `first run: skipped -- no disc` and passes (R222). Paste the failing run (`bash scripts/loop_lock.sh run s16-r1b
  --class build --wait 120 -- ./build.sh test`).
- [ ] **Step 2 (GREEN):** the walk, the orchestration, the helper, the page, the sentence; `./build.sh test`; review
  by a fresh agent; the real-disc case's time in the Log (the belief: seconds to a minute; today's Python 473 s).
- [ ] **Step 3:** the Python path stays as the developers' reference (`scripts/disc_to_elf.sh`; its digests are the
  oracle); `docs/DEVELOPING.md`'s "From your own disc" section gains the native line; KNOWN §1 gains the row with the
  time; #70's points 1 and 2 met, 3 and 4 by R3b.

**Bar:** #70's points 1–4 (5 is moot, spec §1.1); the ELF built on this machine from the ISO with the time recorded;
the digests match; the launcher's tests cover the container parsing and the progress states from fixtures, never a
real package.
**Verification:** `ps2x_tests` under the lock; the real-disc case's line; `python -m tools_py.docmaint; echo $?`.

## Task R2: #71 the r0004 package, and the canonical r0004 image (D11)

**Depends on:** R1b and R5. **What the tree has:** the launcher's HTTP caps the body at 1 MiB with its own User-Agent
(`win32_glue.cpp:553, 601`; POSIX spawns curl) — the 1,605,944-byte file needs a stream-to-file GET in both glues; the
loopback seam pattern is `bug_report.h:32`. KNOWN §1's #71 row: `GET /s2/r0004/APACHE00.ZDB` on `patch.psrewired.com`
(User-Agent `sceHTTPLib-1.2.42`); the served file decrypts on the r0001 disc path with no identity and merges to a
5,016,064-byte image one code word (`0x1E70CC`) from the PCSX2-sourced ELF; its sha is recorded nowhere.
`scripts/build_revision.sh` builds a revision's image and exe; `overlay_repair.py` is an identity for a served image.
#71's point 1 is restated by its comment 1: fetch → the r0001 disc decrypt → merge.

**Files:** `win32_glue.cpp`/`posix_glue.cpp` (`httpDownload(url, path, userAgent, timeoutMs)`),
`ps2xShared/include/launcher/patch_fetch.h` + `src/patch_fetch.cpp` (new: the URL behind `PS2X_LAUNCHER_PATCH_BASE`
for tests, the save under `<game dir>/r0004/APACHE00.ZDB`, the size and sha checks, then R1b's decrypt on the disc
path and the merge to `socom2_game_r0004.elf` beside `socom2_r0004.exe`), `launcher_config.h:38–48` (the r0004
row is "installed" when both files exist; `elfName` from R5), `page_play.cpp`/`page_online.cpp` (the GAME VERSION
cell's "planned" caption becomes the fetch step), `tools_py/disc_to_elf_expected.json` (an `r0004` section: the
served ZDB 1,605,944 B sha `d9f67b53…`, the image's sha computed from `game/r0004/served/socom2_game_served.elf`;
`disc_to_elf.py:94–110`'s `load_expected`/`check_value` are section-keyed, so the r0001 checks are untouched),
`ps2xTest/src/patch_fetch_tests.cpp` (new), `tools_py/tests/test_patch_fixture_server.py` (new: a loopback
`http.server` fixture the C++ case is pointed at), `scripts/parity/pins_r0004.json`, `docs/LATER.md` row 33,
`docs/FAQ.md:192-199, 256–264` (the two "planned" answers), `docs/HUMAN_TASKS.md` O5 (the first live fetch).

- [ ] **Step 1 (RED):** cases against the loopback fixture: 200 with a synthetic body → saved, its size and sha
  checked, handed to the decrypt seam; 404, a body shorter than `Content-Length`, a wrong size, a wrong sha → refused
  with one sentence, nothing written beside the exe, the toggle stays r0001 (Review Focus 3). The offline end to end:
  where `game/r0004/served/APACHE00.ZDB` is, the fixture serves the owner's fetched copy and the built image matches
  the recorded sha; elsewhere skipped. Paste the failing run.
- [ ] **Step 2 (GREEN):** the download, the fetch step, the toggle, the two FAQ answers; `./build.sh test`; review.
- [ ] **Step 3 [L] (LATER row 33, one window):** `bash scripts/build_revision.sh r0004 game/r0004/served/APACHE00.ZDB
  --game game/disc_r0004` (a real tree, never the junctioned one — the #56 trap) → the canonical r0004 image from
  the served package, no pnach restore, the overlay repair an identity for it; then the r0004 recomp and runtime
  (`dist/socom2_r0004.exe`) and the gate on it (`pins_r0004.json`; `--accept-pins` after a green run under the D11
  ruling); X3 rides the same chain.
- [ ] **Step 4:** KNOWN §1's r0004 rows moved (the canonical image is the served one; the PCSX2-sourced image kept
  under `game/` as the record); LATER row 33 struck as done; O5 gains the line "the first live fetch from PSRewired
  is yours to run: GAME VERSION → r0004 on the community preset; say when"; #71 closed on points 1, 2 and 4 once the
  owner's live fetch is recorded, else left open with the KNOWN row "not yet done".

**Bar:** #71's points 1, 2 and 4 as restated; the r0004 gate 3/3 PINS MATCH on the rebuilt image; #57's r0004 leg
(X3) on the same gate.
**Verification:** the fixture cases; the r0004 gate summary; `python -m tools_py.docmaint; echo $?`.

## Task R3a: the two archives under R295 (in flight in the cloud, D14) — re-scoped 2026-09-27 06:30Z

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task R3a section.

**Files:** `build.sh` (`release()` gains `PS2X_RELEASE_KIND=player|developer`: the player passes
`-DPS2X_ENABLE_DEBUG_UI=OFF` into `dist-release/`, the developer keeps it ON into `dist-release-dev/`; the probes
stay in both kinds, R315 — PR #85's `PS2X_ENABLE_PROBES` option is dropped in its round 2; `release()` writes the
kind as one word in `RELEASE_KIND` beside the exe, which `make_portable` refuses to mismatch),
`scripts/make_portable.sh` (a `--kind` or a second run: `socom2-portable.zip` and `socom2-developer.zip`, the manifest
with both), `tools_py/playtest_block.py` (both archives), `tools_py/portable_audit.py` (unchanged: run per folder),
`.github/release-notes-template.md:11` (both zips), `tools_py/tests/test_make_portable.py`, `test_portable_folder.py`
(the developer folder in FOLDERS), `test_playtest_block.py`, `docs/DEVELOPING.md:44-47, 794–797`, `docs/KNOWN.md`
(the 67.7 MB row; the megabytes the player exe saves — the number PLAYTEST.md:139 promised).

- [ ] **Step 1:** the cloud session's PR as briefed (a copy-list split) is reviewed against this scope: what it
  built that stands (the manifest, the sums and the audit over two archives, the template, the tests' shape) is
  kept; the copy-list reading is replaced by the two configurations in a fix round (the cloud can build the Linux
  runtime with the option off — `scripts/build_linux.sh release` — but not the Windows exe: the Windows builds are
  Step 3's window).
- [ ] **Step 2 (RED then GREEN, lock-free):** `test_make_portable.py`: two archives from one invocation with the
  fake dist carrying both exes; the player's manifest names its exe's sha and kind; `test_playtest_block.py`: the
  block shows both. The CMake option's presence pinned by a test that greps the release configure line.
- [ ] **Step 3 [L]:** two full release builds (re-budgeted 08:16Z on PR #85's review: the player kind flips
  `PS2X_ENABLE_DEBUG_UI` to OFF in `build-release/`, which recompiles the runner; the developer kind is a fresh
  `build-release-dev/`; about 50 minutes each at `-j 4`) and both archives; the megabytes saved recorded in KNOWN
  beside the 67,725,996-byte row; the player exe's gate is R4's (its probes stay: R315). Both builds sit in the
  close chain (Task 99); R3a's own window is needed only if the D4 slice wants the archives earlier. The window's
  reviewer reads: the CMake cache OFF in `build-release/` and ON in `build-release-dev/`; `llvm-nm
  symbols/socom2.exe.debug | grep -c ImGui` 0 against more than 0; `wc -c` of both exes and zips; the launcher's
  `--diagnostics` from each folder with only System32 on PATH exits 0; the player runner with `--home <empty>`
  exits 68; the `[knobs]` line of the player exe run with `PS2X_DEV=1 PS2X_PEEK=…` shows `dev=1` with the peek; a
  title-stage gate on the player exe; the manifest's `exe_sha256` equal to the new `symbols/INDEX.txt` hash.

**Bar:** `portable_audit` and `test_make_portable*` green on both archives; the exit-code suite on the release runner
unchanged (`SOCOM_EXE=dist-release/socom2.exe python -m unittest tools_py.tests.test_runner_exit_codes`); the
player exe carries no debug UI (a `--diagnostics` or `strings` check named in the test).

## Task R3b: the ELF leaves the player archive; the words

**With R1b (D4).** **Files:** `scripts/make_portable.sh:146–151` and `:77–79, 84` (the ELF required and copied only
for the developer kind), `build.sh:196` (unchanged: the developer folder keeps the ELF), `scripts/build_linux.sh:120-140`
(PR #85's review F1: the `RELEASE_KIND` marker is written even when `--no-runner` or a missing `recomp/output` left
the game exe unbuilt, so a stale debug-UI exe ships labelled player — write it only when `socom2` is in `built`,
else say so and write nothing, so `make_portable` refuses; one `ReleaseKindTest` line), `tools_py/tests/test_make_portable.py:52`
(the player archive has no ELF, the developer's has), `docs/FAQ.md:172` ("no game executable" → the R290 position:
the exe ships, the program image is built on your machine from your disc on the first run) and `:60–66` (exit 68's
new sentence), `docs/INSTALL.md:50-54` (the file list without the ELF; the first-run step: the DISC page builds it,
with the time), `README.md:47, 60–62` (what a player gets), `docs/DEVELOPING.md:44-47, 613`; the GAME VERSION and
community answers (`FAQ.md:192–199, 256–264`) are R2's.

- [ ] **Step 1 (RED):** the test cases above fail; `grep -n "no game executable" docs/FAQ.md` finds line 172.
- [ ] **Step 2 (GREEN):** the script, the words; the tests pass; the grep finds nothing; docmaint OK; review; the
  D4 mid-sprint slice with R1b (a frozen slice branch, the PR, the three checks, the merge, `main` merged back).

**Bar:** #70's points 3 and 4; the exit-code suite on the release runner unchanged.

## Task R4: the first archives against a draft (D1) — the close

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task R4 section.

- [ ] **Step 1 [L] (in the close chain's window):** after the chain: the player archive's gate as above (stamp
  `s16_release_gate`); both archives' `SHA256SUMS` and audit; the manifest's commit equals the tagged commit.
- [ ] **Step 2:** the exact commands into the Log and O2: `gh release upload v0.16.0
  dist-release/portable/socom2-portable.zip dist-release/portable/socom2-developer.zip
  dist-release/portable/SHA256SUMS dist-release/portable/THIRD_PARTY_NOTICES.md --clobber` and `gh workflow run
  release-draft.yml -f tag=v0.16.0`; **the loop stops short of the upload** (D1); if the owner says in one line that
  the loop may attach, it attaches, runs the verify half and appends "Verified"; publishing stays the owner's click.

**Bar:** the archives exist with their sums; the draft's checklist can be ticked line by line from the Log; if
attached, "Verified" is appended.

## Task R5: #69's closing run, and `agent/launch-rev`'s merge

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task R5 section.

- [ ] **Step 1:** a fresh review of the fifth commit against the FAIL's list (`ps2xIOP/src/builtin_profiles.cpp:26`,
  `host_window.cpp:10`, `exit_codes.h:31`) and the pure tests (`gameFilesFor`, `gameRevisionForElfName`,
  `BareRun::plan(home, "r0004")`, the IOP profile for the r0004 name); a fix round if owed.
- [ ] **Step 2:** the merge to `main` by PR under R294 (`gh pr create --base main --head agent/launch-rev`; the three
  checks; `gh pr merge --merge`; the worktree `wt-launch-rev` removed by `scripts/agent_worktree.sh remove` BEFORE
  any branch deletion), then `main` into `sprint-16`.
- [ ] **Step 3 [L]:** one launcher-started r0004 run (with V0's window or R2's chain) whose log reads `revision guard:
  executable r0004, image r0004` with the `[ps2xIOP]` lines for 989snd, lgaud and eznetcnf; the lines quoted in
  #69's closing comment; KNOWN's #69 row moved; #69 closed.

## Task X1: `tools/` restored by one flag (in flight locally, socom-pc-42)

**What the X reader found:** `scripts/bootstrap_windows.sh` fetches only llvm-mingw, CMake and Ninja (`:24–31`, pinned by
version and sha256) and has one flag, `--check`; its seam is `SOCOM_TOOLS_DIR` (`tools_py/tests/test_bootstrap_windows.py:163–164`).
The backup `D:/socom_archive/tools_backup_2026-09-26/` holds six entries (cmake, ghidra 877 MB, llvm-mingw, ninja,
pcsx2, pcsx2_b; no manifest; no `pcsx2/sstates`, `snaps` or `cache`) and was synced 2026-09-27 01:51Z, before
PCSX2 wrote its ini and memory card again (03:46–03:52Z): **a whole-directory copy would roll them back — copy per
entry, only what is absent.** "The reference trees" and `tools/rbuild` exist in neither place and no document says
what they were: the manifest holds what the backup holds, and the HAZARDS line says so.

**Files (as committed at `4776a634` on `agent/s16-x1`):** `scripts/bootstrap_windows.sh` (`--restore-owner-tools
[--dry-run]`; an unknown argument now exits 2 instead of falling through to the fetch), `scripts/tools_backup_manifest.txt`
(three rows: ghidra 5,255 files with `ghidraRun.bat`'s size and sha; pcsx2 252 and pcsx2_b 248 files with
`pcsx2-qt.exe`'s), `tools_py/tests/test_bootstrap_restore.py` (11 cases on a temporary root: the seams
`SOCOM_TOOLS_BACKUP`, `SOCOM_TOOLS_MANIFEST`), `docs/HAZARDS.md` (one sentence in the git entry).

- [ ] **Step 1:** the fresh review (running at 06:25Z): the manifest verified before any copy, a failure copies
  nothing, an existing entry left alone, the backup never written, a junction at `tools/<entry>` never followed or
  replaced, the dry run writes nothing, the tests never touch a real `tools/`.
- [ ] **Step 2:** the fix round if owed; the merge into `sprint-16` at the open (`git merge --no-ff agent/s16-x1`);
  the worktree removed by `scripts/agent_worktree.sh remove s16-x1`. No restore is run against the main tree by the
  loop: `tools/` is restored today (PCSX2 by the HUMAN_TASKS session, the toolchain by the bootstrap); the flag is
  for the next loss.

**Bar:** a planted empty `tools/` (a temporary root) restored; the manifest test red on a missing entry.
**Verification:** `python -m unittest tools_py.tests.test_bootstrap_restore tools_py.tests.test_bootstrap_windows -v 2>&1 | tail -3`;
`bash -n scripts/bootstrap_windows.sh`; `python -m tools_py.docmaint; echo $?`.

## Task X2: the naming future task (R296) — the matcher across the Aug 28 2003 beta

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task X2 section.

**Files:** `recomp/build/beta_scus_973_66.csv` (ignored), `game/beta_scus_973_66/match.json` (ignored),
`docs/research/75-beta-matcher-run.md` <!-- docmaint: future --> (new), `tools_py/tests/test_beta_matcher_note.py` (new).

- [ ] **Step 1 (RED):** the note's test: the counts per pass (exact, hash+callees, relinked-body) with the command
  each; the five routines' and the 148's placements or "no match" each; at least one counterexample (a pair the
  matcher pairs that the bodies refute) recorded with its addresses; no name applied.
- [ ] **Step 2 (the Ghidra export, announced as a window — CPU-heavy, lock-free):** `bash scripts/ghidra_export_functions.sh
  game/beta_scus_973_66/beta_scus_973_66.elf recomp/build/beta_scus_973_66.csv`; the row count.
- [ ] **Step 3:** `python -m tools_py.address_matcher game/disc/socom2_game.elf recomp/socom2_ghidra.csv
  game/beta_scus_973_66/beta_scus_973_66.elf recomp/build/beta_scus_973_66.csv --out game/beta_scus_973_66/match.json`,
  then the seeded pass per the r0004 recipe; the counts; the five and the 148 looked up; the counterexamples.
- [ ] **Step 4 (GREEN):** the note; the test; review (the counts re-run); O11's line updated; commit.

**Bar:** research/57's pipeline shape; a note with the counts and commands; no name applied without R296's task
naming it.

## Task X3: #57's r0004 leg, riding on R2's r0004 gate

**Files:** `scripts/build_revision.sh:468` (`rm -rf "$GEN"`, GEN `recomp/output_<rev>` at `:137, 141` — the
delete-first that defeats the per-file includes' incremental rebuild), `tests/fixtures/synthetic_recomp/` (five files
still carrying the old preamble; regenerated with the new emitter), `tools_py/tests/test_build_revision.py`,
`docs/KNOWN.md:130` (#57's row), `docs/LATER.md` row 19.

- [ ] **Step 1 (RED):** a `test_build_revision.py` case: a second run of the recomp step with one name changed
  keeps the untouched output files (their mtimes) — fails while the delete stands; the synthetic fixture's preamble
  compared with the emitter's current one — fails today.
- [ ] **Step 2 (GREEN):** the delete removed (the emitter's own output is the truth); the fixture regenerated;
  `./build.sh test` (the synthetic link job compiles it); review.
- [ ] **Step 3 [L]:** the r0004 gate of R2's chain 3/3 PINS MATCH on the r0004 exe; #57 closed on its bar; KNOWN's
  row moved; LATER row 19 struck.

## Task X4: #41 the menu-frame fixture — one PCSX2 run (to LATER unless a PCSX2 window coincides)

**Box:** runs only if X2's Ghidra window and a PCSX2 run fall on the same quiet evening; otherwise LATER with the
trigger "a PCSX2 window opens for another reason" and #41 stays as it is.

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task X4 section.

**Files:** `tools_py/parity/gsdump_capture.py` (a `--no-state` path, or a savestate made first), `ps2_gs_tests.cpp`
(a second case over `game/console_replay_menu` with its own candidate list and `PS2X_CONSOLE_REPLAY_FBP`),
`tools_py/gsdump_extract.py` (unchanged), `game/console_replay_menu/` (ignored, disc-derived), `docs/KNOWN.md` (#41's
row), issue #41.

- [ ] **Step 1 [L] (the window, announced):** `python -m tools_py.parity.drive --target pcsx2` to the main menu (or
  `gsdump_capture.py --no-state` after a cold boot), a savestate saved there for next time, the GS dump of two
  frames (`--frames 2`), `python tools_py/gsdump_extract.py <dump.gs> game/console_replay_menu --frames 2`.
- [ ] **Step 2 (RED):** the second case with a flat-grey `reference.ppm` in place: fails over the bar; paste it.
- [ ] **Step 3 (GREEN):** the real reference; the case passes on the CPU half and, under `PS2X_CONSOLE_REPLAY_GL=1`,
  the GL half; the numbers in the Log; #41 closed on its bar; KNOWN's row moved.

## Task X5: Dependabot #10 rebased and merged (R294)

**What the tree has:** `docs/superpowers/plans/2026-09-27-sprint-16-tree-facts.md`, the Task X5 section.

- [ ] **Step 1 (done 2026-09-27 06:3xZ):** `gh pr comment 10 --body '@dependabot rebase'` (the owner's own
  convention on that PR).
- [ ] **Step 2:** when `leakcheck` is green: `gh pr merge 10 --merge` (the merge-commit shape of #8 and #9; never
  `--delete-branch`); the Log line. The `ci` label `.github/dependabot.yml:11` names does not exist (Dependabot warns
  on every PR): a repository setting, the owner's — one line in HUMAN_TASKS, or the line dropped in a later task.

## Task 99: the close

- [ ] **Step 1 (the two reviews, lock-free):** the `sprint-close` skill: DOC_MAINTENANCE §5 (docmaint exit 0, and
  `python -m tools_py.docmaint archive-log --plan docs/superpowers/plans/2026-09-27-sprint-16.md --keep 10` if the
  ceiling fires; the L documents read; the stale claims fixed; two CLOSED blocks kept in the sprint file, the
  third archived; "Last full review" stamped) and §7 (`python -m tools_py.issues audit --stale-since <the open's
  date>` exit 0; every open issue read against the tree; `gh issue list --state closed --label known-issue --search
  "closed:>=<open date>"`; the carry; `python -m tools_py.issues milestone close "Sprint 16" --next "Sprint 17"`;
  `issues backlog` and `--check`; `rulings --check`; `changelog --check`; `python -m tools_py.flow` and `--check`;
  `issues tally --since <open date>`; `python -m tools_py.sitting` and `--check`; the R271 breaker); the ratchet
  last, while `plans:` still names this plan (`ratchet`, `ratchet --write`, docmaint OK).
- [ ] **Step 2 [L] (the close chain, one window):** `cp scripts/parity/merged_chain.sh logs/s16_close_chain.sh && bash
  scripts/run_detached.sh --owner s16-close --purpose "launch: the Sprint 16 close chain" --wait 120 --class run
  logs/s16_close_chain.sh logs/s16_close_chain.marker s16_close1` — recomp, runtime, the suites (`--vram-diff` 15/15,
  the console-replay cases), the gate 3/3 PINS MATCH, the fourth leg, both release builds, both archives and
  PLAYTEST's block; then F5's two more gates and R4's archive gate under the same or the next holding; the audio
  numbers (research/68's commands) on V0's capture or a new one if a change touched audio; `logs/merged_chain.last_green`.
- [ ] **Step 3:** the Outcome section (the acceptance bar of spec §4 row by row; the tasks by outcome; the numbers
  before and after); the close-out commit with an explicit pathspec; `git push origin sprint-16`; `gh run list
  --commit <sha>`; `gh pr create --base main --head sprint-16 --title "Sprint 16: ten minutes to the server"` with the
  close-out block as the body; the three checks; `gh pr merge --merge`; `git fetch origin`; `sha=$(gh pr view <N>
  --json mergeCommit -q .mergeCommit.oid)`; `git rev-list --parents -n 1 $sha` (three hashes); `git tag -a v0.16.0
  $sha -m "Sprint 16: ten minutes to the server"`; `git push origin v0.16.0`; the CLOSED heading "merged to `main` as
  `v0.16.0` at <hash>, PR #M"; HANDOFF rewritten; the next sprint named when the owner names it.

**Verification:** the gate's summary lines; `python -m tools_py.docmaint; echo $?`; `gh run list --commit <head>`.
