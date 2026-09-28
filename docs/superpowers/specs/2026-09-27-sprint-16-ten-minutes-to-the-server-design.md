# Sprint 16 design — "ten minutes to the server": the exe-only release, the frame rate measured and fenced, the launcher's face

Date: 2026-09-27 (host clock, 05:20Z), proposed while Sprint 15 is open. **Opens at Sprint 15's close**, off `main` at
the Sprint 15 merge; until then this is a proposal and nothing here changes an open sprint. The plan is
`docs/superpowers/plans/2026-09-27-sprint-16.md` (written 2026-09-27; its task book and the readers' facts beside it).
Scoped with the owner on the evening of 2026-09-26/27 from the Sprint 15 controller's list, the sixteen open issues,
`docs/LATER.md`'s 33 rows and dismissals, `docs/HUMAN_TASKS.md`'s open rows, and the owner's two asks: wrap up the
release-ready work the previous sprints began, and improve the frame rate without degrading the standards that hold.
The proposal was then validated against the research corpus (2026-09-27); §1.3 records what that changed.

**The goal in one line:** a first-time player picks r0004 in the launcher and is playing on the community server ten
minutes later, from a download that carries no game bytes, at a frame rate the gate now refuses to let slip.

## Why this is a sprint and not a task

Three things the project has promised now meet: the owner's legal position (R290: the exe ships in release archives
only, the ELF never ships, the player's disc makes it), the community server's package (R293: the launcher fetches it
and takes the steps), and a release the verify half has never run on. Each stands on one piece of work, the native
first-run decrypt (#70), and nothing else in the release can land before it. Beside that, the frame rate has been
measured but never explained: eight gates read 22.7 to 33.0 ms per guest VBlank in the single-player mission on a host
that should hold 16.7, no profile of today's exe exists, and the one bar written for it (#59) is informational. A
task fixes one issue; a sprint is needed because the release tasks share one implementation and one archive, and
because the frame-rate work has to measure first and then choose, under a fence that refuses a regression.

## 1. What is established (2026-09-27) — **[verified: the tree, the logs and the notes named]**

### 1.1 The release, where it stands

- **The archive still carries the ELF.** `scripts/make_portable.sh` copies `socom2_game.elf` beside `socom2.exe`
  in both the developer and the `--release` folders; `docs/INSTALL.md`'s file list and the exit-68 sentence name it;
  `docs/FAQ.md`'s "Why isn't the ISO included" says the project distributes "no game executable, no recompiled C++",
  and its GAME VERSION answer says the r0004 cell is greyed as "planned". R290 (2026-09-26) rewrote the position:
  the exe ships, the ELF never does, the FAQ's sentence is rewritten under #70.
- **The decrypt is Python under Unicorn.** `scripts/disc_to_elf.sh` reads three files out of the disc tree
  (`SCUS_972.75`, `OVERLAY/REL/DNAS.BIN`, `RUN/RAW/APACHE00.ZDB`), self-decrypts the DNAS overlay's 131 code blocks
  (`tools_py/dnas_selfdecrypt.py`, 2 s, a cipher the note understands: a chain of xor, rotate and byte-swap word
  transforms), then **executes the loader's own libdnas2 routines** under Unicorn for 473 s
  (`tools_py/decrypt_apache.py`). `docs/research/05-code-package-and-harness.md` names the layers those routines
  run: an RSA/MD5 check of a 0x580-byte signed header, a 3DES-like body layer chunked at 0x80, a second "unique"
  layer, then zlib. The Python path reimplements none of them. The console identity the second layer asks for is
  not checked against the content ("any values work", the same note), which KNOWN §1's row of 2026-09-27 confirmed
  on the served r0004 package. The runtime has no EE interpreter (its only interpreter is `VU1Interpreter`); the
  2026-09-15 packaging outline's "run the loader under the MIPS interpreter the runtime already has" was wrong on that
  point. What exists for a native route: the Ghidra function map and decompilation of the self-decrypted DNAS image
  (`game/analysis/DNAS.dec.bin.functions.txt`, 1,980 rows; `DNAS.dec.bin.decomp.c`, both git-ignored), and the
  project's own recompiler.
- **The r0004 package is one file for everyone and needs no identity** (KNOWN §1, 2026-09-27): the r0001 client
  sends `GET /s2/r0004/APACHE00.ZDB` to `patch.psrewired.com`; the served file (1,605,944 bytes) is the disc-path
  form, and the existing r0001 disc decrypt produced an image that differs from the PCSX2-sourced r0004 ELF in
  exactly one code word (the pnach's `jal` at `0x1E70CC`) and 365 runtime-written data bytes. So #71 is fetch, the
  same decrypt, merge; #70's bar point 5 ("one implementation with #71's card path") is moot, and
  `docs/LATER.md` row 33 (rebuild the canonical r0004 image from the served package; retire the pnach remnant and the
  overlay repair) is the same work seen from the r0004 side. The owner's fetched copy is on this machine under
  `game/r0004/served/` (ignored), so the whole path is testable offline against a local HTTP fixture.
- **The launcher's revision plumbing is landing in Sprint 15:** #69's fix (`agent/launch-rev`: the launcher starts
  the chosen GAME VERSION's own pair; the runtime keys "this is SOCOM II" on the revision table, not the file name)
  is reviewed and waiting on its closing run in a window; #75 is PR #79.
- **The release process** (`docs/GIT_STRATEGY.md` §5, `.github/workflows/release-draft.yml`): a `v*` tag creates a
  draft with the checklist; the archives are built here and gated 3/3 on the exe inside them; the verify half runs
  by hand with the tag and appends its verdict. **The recorded default is that the loop builds the archives short of
  the upload and the owner attaches them** (`docs/HUMAN_TASKS.md` O2); the verify half has never run on a real
  archive; the drafts v0.10.0 to v0.14.0 are empty. R295: the player archive drops the debugger and the probes, a
  developer archive keeps them.
- **The launcher's face:** #73 (the profile viewer replacing PROFILE, NAME and PASSWORD; the issue asks for a design
  note first) and #74 (tooltips on the CONTROLLER page) are the owner's asks of the sitting (R295, R296).

### 1.2 The frame rate, where it stands

The host is an i7-14700K, an RTX 4070 SUPER and 32 GB. Read from the logs on 2026-09-27:

| Scene (artefact) | Guest VBlanks/s | Back-pressure wait | EE idle sleeps/s | GL thread `submit=` |
|---|---|---|---|---|
| Online round, two instances on this host (`logs/run_A_20260925_194529.log`, the ladder of 2026-09-25) | 58.4–60.0 | 0–27 ms/s | ~80 | 170–350 ms/s at 125k–213k submit calls/s |
| Single-player gate mission after the HUD (`logs/parity/gate/s14_close1/mission.game.log`) | 41.5 | 289 ms/s | 18.6 | not recorded (the gate sets no stats knob) |
| Eight gates, `FRAME mean=` (KNOWN §2's #59 row and the s14/x51 stamps) | 30–44 (22.7–33.0 ms) | | | |

> Superseded 2026-09-27 at Sprint 16's open (Task 0 Step 5): the `s14_close1` row's 41.5 / 289 ms/s / 18.6 and the
> "29 % of wall time" below came from an every-120th-row pass over the sampler in t=240–360 windows (the author,
> 06:20Z). The stamp's own rows (`mission.game.log:12815` at the HUD step, `:18196` at the last step) give 37.6 guest
> VBlanks/s (the summary's `FRAME mean=26.59` agrees), 369 ms/s of back-pressure wait (37 % of wall) and 14.2 idle
> sleeps/s over the walk; 36.3 / 391 / 15.5 over the whole post-HUD log. The ladder row was computed the same coarse
> way over 60 s windows and is re-read from exact rows before a task cites it. The conclusion stands.

What the table says, and the corpus agrees with: **the GL replay thread is the single-player limiter** (the guest
spends 29 % of wall time waiting for it, the render-thread class of `docs/HAZARDS.md`), and **the EE thread has
headroom in both scenes** (it oversleeps 80 times a second online and still 18 times a second while waiting on the
renderer). So the EE-side levers cannot move the frame rate until the renderer stops being the wall. The rest:

- **No host profile of today's exe exists.** Every `logs/hostprof*.txt` is from 2026-09-08/09, before the native
  VU1 families, the clock fix and the texture-cache fix; they do not symbolise against `dist/socom2.exe` (checked
  2026-09-27). Sprint 13 C8 moved the profiler's entry point and took no profile. The instrument is live:
  `PS2X_HOST_PROF=<ms>` samples the game thread, `PS2X_HOST_PROF_MAIN` the GL thread, `PS2X_HOST_PROF_STACKS=1` the
  stacks; `tools_py/hostprof_symbolize.py` and `hostprof_stacks.py` read them.
- **The draw path's phase split exists and was only ever run on the login screen.** `PS2X_GS_UPLOAD_TRACE` splits a
  flush into `refreshDirtyRows`, the texture resolve and decode, and the draw itself
  (`gs_gl_upload_trace.h`, Sprint 8 Goal 2b); the last large render win (R123, 2026-09-19: the lobby's `transfer=`
  410 → 92 ms/s, fps 52 → 57) came from exactly that split on the menus. The mission was never split. The backend
  already merges consecutive submits under one draw key and flushes on a key change (`executeSubmit`/`flushBatch`),
  so "batching" is not the lever; which flush phase carries the milliseconds is the question.
- **-O2 for the generated code was never measured for speed.** The Sprint 9 Goal 2 matrix lists M1_O2 as "not
  gated"; R151 kept `-O1` on the zip size alone (+4.6 MB, +7.8 %) and 1,640 s of compile. The developer build the gates
  run is `-O1` for the 14,882 generated files (`build.sh`'s `GENOPT` default); the release path defaulted to `-O2`
  for six days without anyone measuring its speed either (`docs/HAZARDS.md`, the R151 row).
- **The generated code stores the guest PC before every instruction** (`function_emitter.cpp:206`, upstream's
  design; 122 stores in a 425-line function), unconditionally; nothing in research/04, 11, 40, 41, 42, 63 or 67
  discusses removing it. An EE-side candidate only, and by the table not today's wall.
- **The VU1 residual is not a cost.** research/15: four of 166 dumps stay on the interpreter, dispatched rarely, one
  (`0x66`) never from the dispatcher. The 195 ms/s of VU1 time research/34 §6 measured on 2026-09-17 is the native
  path's, on the EE thread, and belongs to the profile.
- **#32 as titled contradicts R108b.** Sprint 8 Goal 2 measured the login screen and stopped itself: the GL side
  already uploads whole bands (31–38 calls a second against 8,000 guest uploads), so tile batching had nothing to
  batch; the cost is the CPU-side shadow swizzle per 1 KB tile, and Sprint 13 V2 found 40 % of the remaining uploads
  are identical bytes rewritten (`same_rewritten`). The menus run 58–60 fps under a four-core load since R123, and R125
  let the 60 ms/s proxy go; in a mission uploads cost about 45 ms/s. The issue's title, its bar and Sprint 15's T4
  carry the contradiction.
- **#59's row asks for a quiet host:** three gates on one exe spread 30 % while agents were dispatching; the bar
  waits on three quiet gates agreeing within about 10 % (S13-R3, S13-R13).

### 1.3 What the corpus validation changed (2026-09-27)

The first proposal of the evening had a tile-batching task, put -O2 first among the frame-rate levers, called the GL
work "batching", sized #70 as a port of the cipher and proposed a ruling that the loop uploads the first archives to
a draft. Read against the notes: F3 became conditional and its experiment the identical-bytes skip (R108b, V2); F2
moved to the front and F1 behind it (the idle and back-pressure readings above); F2 reads "split, then the top phase";
R1 opens with a spike between recompiling the decrypt routines and porting from the decompilation (research/05,
the outline's wrong premise); and the upload stays the owner's decision with the recorded default (O2). The VU1
residual left F4 (research/15). §2 is the result.

### 1.4 The validation that exists, which every change here must keep

- The gate: three stages against pinned references, 3/3 with PINS MATCH, gate freshness (exit 5 on a stale exe); the
  fourth leg's twelve held-out references; the merged chain as the unit (`scripts/parity/merged_chain.sh`).
- Pixels: `vu1_replay --vram-diff` 15/15; the console-replay case in `ps2x_tests` (the CPU half in every
  `build.sh test` on a machine with the fixture, the GL half under `PS2X_CONSOLE_REPLAY_GL=1`).
- Audio: `audio_parity.py` 31/48; the dip count 6 over 16 minutes, at most 2 a minute (`audio_dips.py`, research/68).
- Online: the ladder's control bars (research/22's RUNG0 rules, `docs/LADDER.md`).
- Frame pacing: the gate's `FRAME mean= worst1s= n=` line (`tools_py/parity/frame_time.py`), informational today.
- Packaging: the import-closure audit (`tools_py/portable_audit.py`), `SHA256SUMS`, the release leak check, the
  exit-code suite on the release runner, `test_portable_folder`, `test_make_portable*`.
- The record: KNOWN's vocabulary; KNOWN wins.
- **Assumed from Sprint 15** (this sprint opens at its close): T2's code (#67) merged and its Step 3 either run or
  carried; T1b at a recorded outcome; #69's fix merged; #75 merged; the counter past R298. Task 0 of the plan checks
  each and says which did not land; a Sprint 15 task not at its outcome carries into this plan's table (D10).

### 1.5 The rules this sprint keeps

- **Windows (R297):** every build, game run or chain is announced as a window by the session that runs it; game runs
  wait for a window the owner names (O20); nothing heavy is held while the machine is under the runner's memory bar.
- **Merges (R294):** agent code a Fable-class reviewer passed with high confidence, or that tests confirm, merges to
  `main` without a human review until the owner calls stability; every task still gets a fresh reviewer.
- A failing test first, unittest only; RED and GREEN pasted; a performance change's measurement named, with today's
  value, before its branch exists; a stop rule per trial; TRIED, NOT ADOPTED is a recorded outcome.
- KNOWN wins; a finding that moves a row moves it in KNOWN with its artefact, in the commit that carries the evidence.
- Commit with an explicit pathspec; the leak check in the hooks; never `--no-verify`; nothing derived from the disc
  enters the tree (not a byte of `game/`, `recomp/output*/`, `logs/`, a recording, a served package); a count from the
  generated code is cited with its command. The DNAS function map and decompilation stay under `game/`.
- Nothing that is the owner's is performed: no upload the owner has not permitted, no publish, no connection to a
  server that is not ours (the first live fetch from PSRewired is the owner's hand, R293), no upstream filing (O10).
- Rulings from the global counter only; each moved default gets one at the open.

## 2. Goals — four milestones, each with a bar

Markers: **[A]** autonomous, lock-free; **[L]** lock-bound, a window; **[O]** the owner's. Sizes: S under a loop
day, M one to three, L more. "Opus" is bounded work from an exact brief (`implementer`), "Fable" is design or
judgment; every task is reviewed by a fresh agent.

### Milestone R — the exe-only release **[A] mostly** — starts day one

- **R1 #70, the native first-run decrypt.** L, Fable then Opus. Opens with a **half-day spike** (the shape of
  `docs/research/14-gs-render-target-scale-spike.md`: a question, a time box, a recommendation) between (a)
  recompiling the decrypt routines out of the self-decrypted DNAS image with the project's own recompiler into a
  small native helper linked with the runtime's memory model, the driver loop written in C++ after
  `decrypt_apache.py`'s forty lines, the SIF and cdvd answers stubbed as the Python HLE stubs them; and (b) a port
  from the Ghidra decompilation on known OpenSSL primitives. The spike's output names the route, the lines that enter
  the tree, and how the result is verified without disc bytes in the repository (the tracked digests of
  `tools_py/disc_to_elf_expected.json`; a test that runs where the disc is and says "skipped" where it is not, the
  console-replay pattern, R222). Then the build: one implementation in `ps2xShared`, used by the launcher; the DNAS
  self-decrypt ported straight from the 161-line Python; the three files read out of the ISO through the launcher's
  own `iso9660` reader, no 4.2 GB extraction; `socom2_game.elf` written beside the exe and verified against the
  digests; the DISC page gains the step with a progress bar; exit 68's sentence becomes "the program image is not
  built yet: open the DISC page". Bar: the issue's points 1–4 (point 5 is moot, §1.1); the ELF built on this
  machine from the ISO with the time recorded (the belief is seconds to a minute); the digests match; the launcher's
  tests cover the container parsing and the progress states from fixtures, never a real package.
  > Superseded 2026-09-27 at the open (Task 0 Step 5): "the DNAS self-decrypt ported straight from the 161-line
  > Python" — `tools_py/dnas_selfdecrypt.py:10–12` reimplements no transform; it runs the overlay's four core routines
  > (`0x4ef348`, `0x52c330`, `0x53acb8`, `0x540938`) under Unicorn, so the DNAS stage is the spike's question too (the
  > plan's R1a), not a port.
- **R2 #71, the r0004 package.** M, Opus, after R1's implementation. The launcher issues the one GET (the path and
  the User-Agent from KNOWN §1's row), saves the served bytes under the game folder, runs R1's decrypt on the disc
  path, merges the r0004 ELF (digest recorded), and the GAME VERSION row becomes a live toggle over two exes, two
  ELFs, one ISO (#69 made the toggle start the right pair). Tested offline end to end against a local HTTP fixture
  serving the owner's fetched copy; the first live fetch from PSRewired is the owner's hand and a KNOWN row.
  **LATER row 33 folds in:** the canonical r0004 image rebuilt from the served package with `build_revision`, the
  `0x1E70CC` pnach remnant and the overlay repair retired for that image; that is one r0004 recomp, its gate and
  its pins re-accepted after a green run (R283) — one window. Bar: #71's points 1, 2 and 4; the r0004 gate 3/3
  PINS MATCH on the rebuilt image; #57's r0004 leg rides on the same gate (X3).
- **R3 packaging and the words.** S, Opus, in parallel with R1's build. `make_portable.sh --release` leaves the ELF,
  the debugger and the probe binaries out of the player archive and writes a developer archive that keeps them
  (R295); the import-closure audit and `SHA256SUMS` cover both; `docs/FAQ.md` ("Why isn't the ISO included", the
  GAME VERSION answer), `docs/INSTALL.md` (the file list, the exit-68 entry, the first-run step), `README.md` and
  `docs/DEVELOPING.md`'s packaging rows rewritten to what ships. Bar: `portable_audit` and `test_make_portable*`
  green on both archives; `grep -n "no game executable" docs/FAQ.md` finds nothing; the exit-code suite on the
  release runner unchanged.
  > Superseded 2026-09-27 at the open (Task 0 Step 5): no debugger or probe file exists — `make_portable.sh:146–151`
  > copies three binaries and the closure. R295's words (`docs/PLAYTEST.md:138`) name the compile option
  > `PS2X_ENABLE_DEBUG_UI` (`ps2xRuntime/CMakeLists.txt:18`, default ON, never turned off by `build.sh`'s release) and
  > the dump/trace probes compiled in beside it: the split is a second release configuration with its own exe (the
  > plan's R3a), and the ELF's removal is R3b's, with R1.
- **R4 the first archives against a draft.** S, the controller, at the close. The release chain builds both
  archives on the sprint's final exe, gated 3/3 on the exe inside; the exact `gh release upload` command and the
  verify-half invocation are written into the Log and `docs/HUMAN_TASKS.md` O2. **By default the loop stops short of
  the upload (O2's recorded default, D1);** if the owner says the loop may attach, it attaches to the draft and runs
  the verify half, and publishing stays the owner's click. Bar: the archives exist with their sums; the draft's
  checklist can be ticked line by line from the Log; if attached, "Verified" is appended.
- **R5 #69's closing run**, only if Sprint 15 did not get its window: the launcher-started r0004 run whose log names
  r0004. S, [L] one run.
- **R6 a PLAYTEST sitting** on the exe-only build. [O] O8; `docs/PLAYTEST.md`'s block rewritten by the chain.

### Milestone F — the frame rate **[L] then [A]** — F0 on day one, beside R1

- **F0 the baseline and the profile.** S, Fable, one window of about an hour on a quiet host (no agents building,
  the quiet marker): three gates back to back on one exe (T3 carried, #59's Step 1), then one plain single-player
  mission run (not the gate, so the gate's own capture cost is separable) with `PS2X_GS_STATS=1`,
  `PS2X_GS_UPLOAD_TRACE` and `PS2X_HOST_PROF` on the game thread, and one more with `PS2X_HOST_PROF_MAIN` on the GL
  thread, stacks on. Output: a class-S research note, "where a mission frame's time goes", with the two symbolised
  profiles, the flush phases per second in the mission, the three gates' `FRAME` lines, and a ranked list of the top
  three costs with numbers and commands. Bar: the note names the phase or function that carries the largest share
  of the GL thread's second, and says whether the EE thread is within 20 % of the wall after it.
- **F1 -O2 for the generated code, an A/B.** S, Opus, one build (about 50 minutes at the developer parallelism) and
  one gate, after F2 or in a window beside it. Expected result on today's evidence: little change while the renderer
  is the wall, which settles R151's size trade for good. Adopted only if `FRAME mean=` improves 10 % or more against
  F0's baseline and the zip grows under 5 MB (D2); either way the number lands in KNOWN and the build flag's row.
- **F2 the GL thread's top phase.** M, Fable, one build and one gate per attempt, at most two attempts. From F0's
  split: the phase that carries the most of the mission's `submit=`/`transfer=` second (dirty rows, the texture
  resolve and its hash revalidation, the decode, or the draw setup) gets one design and one measured attempt. Bar:
  that phase's ms/s halved on the same scene with the gate 3/3 PINS MATCH, `--vram-diff` 15/15, the console-replay
  case unchanged, the fourth leg green; stop rule: under a 25 % drop after one design, TRIED, NOT ADOPTED with the
  number. A second attempt only if the first adopted and the guest still waits more than 100 ms/s.
- **F3 the upload path, conditional.** S–M, Opus, only if F0 ranks uploads in the mission's top three. The experiment
  is the identical-bytes skip for `same_rewritten` tiles (a byte compare before the swizzle, the GPU-drawn-target
  guard kept), not batching (R108b). Bar: `upload=` halved on the scene F0 named; #32's title and bar corrected in the
  same task whether or not it runs.
- **F4 an EE-side lever, conditional.** M, Fable, only if F0 (or F2's outcome) shows the EE thread within 20 % of the
  wall: the per-instruction PC store made conditional in the emitter (kept before anything that can leave the
  function or fault), or the largest game-thread function the profile names. A recomp; R283's rules; the
  re-derivation job green; pins re-accepted after a green run.
- **F5 the fence.** S, the controller, in the close chain: #59's ceiling written into `scripts/parity/pins.json` as a
  refusal from three quiet gates on the sprint's final exe (the median plus the measured spread; S13-R3), the case in
  `test_gate_frame_time.py` red on a planted slow stage; the before and after (F0's baseline against the final exe)
  in the release notes and KNOWN. If the three do not agree within about 10 %, no rule, the numbers in KNOWN, and
  #59 stays open with the trigger "a quiet host where three gates agree".

**The standards every F change keeps** (the sprint's no-regression bar, D6): the gate 3/3 with PINS MATCH and gate
freshness; the fourth leg; `--vram-diff` 15/15; the console-replay case; audio parity not below 31/48; the dip count
not above 6 (max 2 a minute); a control round's RUNG0 bars. A change that moves a pixel or a score is TRIED, NOT
ADOPTED and written down; nothing is accepted from a failed run.

### Milestone L — the launcher's face **[A]** — after R1's spike, in parallel

- **L1 #73 the profile viewer.** M, Fable designs (a short design note in the plan: what the launcher reads from
  `cards/<profile>` — the persona list and SAVE PASSWORD state by research/38 and Sprint 13 W10's card layout — one
  row per persona with name, the server it was made on, last played; picking a row sets the launch; "new persona"
  stays the game's flow; the typed PASSWORD field goes where the card carries the password), Opus builds. Bar: the
  issue's: the three fields gone from ONLINE; a fresh install shows an empty viewer with one sentence and a working
  new-persona path; a card with two saved personas shows both and launching with either logs in as it
  (`online_login_ours.py --saved-password` covers the launch half); no plain password in `config.json` for a persona
  whose card holds it; the viewer's card read tested from fixtures, never a real card.
  > Superseded 2026-09-27 at the open (Task 0 Step 5): research/38 is the OSK open routine (the UI variables and the
  > MUIS persona calls, lines 92–108, no byte layout) and W10 is a behaviour proof; the card's persona record is an
  > opaque block (`BASCUS-97275SOCOMII` 0x1650–0x17ad, +48 B per persona, no ASCII name) nothing in the tree decodes.
  > D12: a sidecar beside the card, written by the runtime on a successful login. The bar's "a card with two saved
  > personas shows both and launching with either logs in as it" is met for personas recorded through this build; a
  > card whose personas predate it shows the "again" sentence, each appearing after its first login here; "logs in as
  > it" is claimed only after a driven two-persona run shows which persona the game's list gives (the plan's L1b).
- **L2 #74 tooltips.** S, Opus. Bar: the issue's: a half-second hover shows a one-line tooltip on every focusable
  CONTROLLER control, keyboard focus shows the same line in the footer, one string table per page, a `ps2xTest` case
  asserting every focusable control has a non-empty line.

### Milestone X — fillers, lock-free unless marked **[A]** — when an agent slot is free

- **X1 tools/ restored by `scripts/bootstrap_windows.sh`** from the off-tree backup
  (`D:/socom_archive/tools_backup_2026-09-26`; the 2026-09-26 loss, `docs/HAZARDS.md` git): PCSX2, Ghidra and the
  reference trees come back with one flag, verified by a manifest; the toolchain path unchanged. S, Opus. Bar: a
  planted empty `tools/` restored; the manifest test red on a missing entry.
  > Superseded 2026-09-27 at the open (Task 0 Step 5): "the reference trees" — the backup's top level is cmake,
  > ghidra, llvm-mingw, ninja, pcsx2, pcsx2_b; nothing in the tree or the backup names a reference tree (the phrase is
  > `bootstrap_windows.sh:14`'s); the manifest holds what the backup holds.
- **X2 the naming future task** (R296): the matcher run across the Aug 28 2003 beta (`game/beta_scus_973_66/`), its
  placements and counterexamples recorded; the hand read of the five routines and the 148 slot-count namings stay
  parked unless the beta settles one. M, Opus. Bar: research/57's pipeline shape; a note with the counts and commands;
  no name applied without R296's task naming it.
- **X3 #57's r0004 leg**, riding on R2's r0004 gate. S, Opus. Bar: the issue's.
- **X4 #41 the menu-frame fixture**, now that PCSX2 is restored: research/31's recipe for a MENU frame dump, the case
  seen red on a planted pixel change. S, Opus, [L] one PCSX2 run. Bar: the issue's.
- **X5 Dependabot #10** rebased and merged (R294). S, the controller.

### Order, time boxes and the windows budget (D5)

Day one: R1's spike, F0's window, R3, L2, X1. Days two to four: R1's build, R2 behind it, F2 from F0's ranking, L1's
design then build, X2. Days four to six: R2's chain, F1, F3/F4 if fired, X3, X4. The mid-sprint merge to `main`
(D4) once R1 and R3 are reviewed and gated, so the release is not hostage to F. The close by day eight: R4, F5, L
lessons, the PR, the tag. A phase past its box hands what is done to the next and the rest to LATER with a trigger.

Lock-bound steps, each a window the owner names or the session announces: F0 about an hour; F1 one build and one
gate; F2 one build and one gate per attempt; F3 and F4 the same if fired; R2 one r0004 chain; R5 one run if owed;
X4 one PCSX2 run; the mid-sprint chain; the close chain (recomp, runtime, suites, the gate, the fourth leg, audio
parity, the dip count, both archives, PLAYTEST's block). Everything else is lock-free.

## 3. Decisions for the owner — each with the default the sprint proceeds on

Each default gets a ruling from the global counter at the open (from R298 or the next free number); none is numbered
here.

| # | decision | default |
|---|---|---|
| D1 | May the loop attach the first archives to the GitHub draft and run the verify half? | no: the loop builds and gates the archives and writes the exact commands (O2's recorded default); the owner attaches, or says in one line that the loop may; publishing is always the owner's click |
| D2 | F1's adoption threshold, revisiting R151 | `-O2` ships only if `FRAME mean=` improves 10 % or more against F0's baseline and the zip grows under 5 MB; otherwise R151 stands with the speed number written beside it |
| D3 | R1's route | the half-day spike decides between recompiling the decrypt routines and porting from the decompilation; the expected recommendation is the recompile, because the recompiler, the function map and the self-decrypt port are in hand; the spike may recommend neither, in which case R1 stops with the reason and the release keeps the developer-copy path (R290) |
| D4 | A mid-sprint merge to `main` | yes, once R1 and R3 are reviewed and gated (R184's precedent), so the release does not wait on F |
| D5 | Time boxes | six to eight loop days; F0 and R1's spike on day one; the close by day eight; a phase past its box hands its rows to LATER |
| D6 | The no-regression bar for a performance change | the list in §2 F: the gate 3/3 PINS MATCH, the fourth leg, `--vram-diff` 15/15, the console-replay case, audio parity ≥ 31/48, the dip count ≤ 6, RUNG0's bars; nothing accepted from a failed run |
| D7 | Audio in this sprint | no task, unless Sprint 15's T1b chain leaves a lead; then the one candidate is the frame-stamped replay of research/70 §9.4 as an X row |
| D8 | #32's title and bar | corrected to the identical-bytes skip (R108b, V2); the task runs only if F0 names uploads; otherwise LATER row 4 keeps it with that trigger |
| D9 | The sitting's two rulings as constraints | R297 (windows) and R294 (merges) written into the plan's Global Constraints, not re-ruled |
| D10 | Sprint 15's leftovers | a Sprint 15 task not at its recorded outcome at the close (T2's Step 3, T1b's Step 3, T3, T4) carries into this plan's table under the milestone it serves (T3 → F0, T4 → F3), with its Sprint 15 record cited |
| D11 | The r0004 image | the canonical r0004 image is rebuilt from the served package (LATER row 33) inside R2, its pins re-accepted after a green run under a ruling; the PCSX2-sourced image is kept under `game/` as the record |

## 4. The acceptance bar of the sprint

1. **The archive carries no game bytes and a stranger's first run builds them:** the ELF built by the launcher from
   the r0001 ISO on this machine, verified against the tracked digests, with its time recorded; the player archive
   without the ELF, the debugger or the probes; the developer archive beside it; `SHA256SUMS` and the audit green on
   both; the FAQ, INSTALL and README saying what ships.
2. **r0004 is a toggle:** the launcher fetches, decrypts and merges the served package against the offline fixture,
   the canonical r0004 image is the served one, and its gate is 3/3 PINS MATCH; the first live fetch is recorded as
   the owner's hand or as not yet done.
3. **The frame rate is explained, moved and fenced:** F0's note names the top three costs with numbers; F2 reached a
   recorded outcome (ADOPTED with its phase halved, or TRIED, NOT ADOPTED with the number); F1's number is written
   whichever way it went; #59's ceiling is a refusal in `pins.json`, or the three quiet gates' disagreement is in
   KNOWN with the trigger.
4. **No regression:** D6's list holds on the sprint's final exe.
5. **The launcher's face:** #73 and #74 meet their bars.
6. **The record:** every Believed row a task touched is moved with its artefact; LATER re-sorted with the rows this
   sprint promoted or struck (rows 3, 4, 19, 33 at least); the ceilings hold; the release checklist tickable from the
   Log; the owner's rows O2 and O20 updated with what was asked and when.

## 5. What this does not do

Two rooms on our Horizon (#72) until a second person is on it. Anything that waits on PSRewired's answer (O4, O5's
Goal F). A register row or trial for VU1 or any other LATER confidence row. #34, #26, #25, #47, #52, #54, #55,
#58, #60: no visible defect, or an owner's hand. A wholesale take of paraLLEl-GS (LATER row 32; its trigger is
upstream's merge). An installer. A public download: publishing is the owner's click. Any connection to a server that
is not ours by the loop. A performance change accepted from a failed run, or one that changes a pixel. An upstream
filing (O10).

## 6. Pointers

`docs/superpowers/plans/2026-09-27-sprint-16.md` (the plan; `2026-09-27-sprint-16-tasks.md` the task book,
`2026-09-27-sprint-16-tree-facts.md` the readers' facts);
`docs/superpowers/plans/2026-09-26-sprint-15.md` (the open plan and its Log); `docs/superpowers/plans/2026-09-26-owner-sitting.md`
(R290–R297); `docs/research/05-code-package-and-harness.md` (the decrypt layers); `docs/research/34-online-round-freeze-clut-serials.md`
(§3 the submits table, §6 the clock); `docs/research/15-vu1-fourth-family.md` (the residual);
`docs/archive/sprints-7-12/2026-09-19-sprint-8-menu-cost-2b.md` (R108b, the flush split);
`docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-2-release-build.md` (M1_O2, R143, R151);
`docs/research/70-lle-oracle-spike.md` (§9.4); `docs/research/14-gs-render-target-scale-spike.md` (the spike shape);
`docs/superpowers/specs/2026-09-15-game-client-package-and-installer-outline.md` (§4.2, superseded on the interpreter
point); `docs/GIT_STRATEGY.md` §5; `docs/BACKLOG.md`; `docs/LATER.md`; `docs/HUMAN_TASKS.md` (O2, O8, O20);
`docs/KNOWN.md`; `docs/HAZARDS.md`.
