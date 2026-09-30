# Sprint 17 design — "sixty, and the way back": the frame rate to 60 at 1x, the exit from SOCOM Online, the lobby's sound, the online menus' harness

Date: 2026-09-27 22:10Z (by `date -u`). Status: **PROPOSED**, drafted in the worktree `mission-frame-drops-7e50ea`
on the owner's word of this evening; it opens on `sprint-17` off `main` once Sprint 16 is closed and merged, and its
Task 0 carries what Sprint 16 leaves short of an outcome (§1.7). The owner's order, verbatim: **frame rates > the
close leaving SOCOM Online > sound issues**; the harness scoping is the last task, only if time remains before the
owner checks in. The owner's permission, verbatim in substance: the spec may expand scope or change course, knowing
the goal is **60 fps with parity to the original at PS2 resolution (1x render scale)**; 3x render scale with an
adjusted frame rate is the second goal.

The vocabulary is `docs/KNOWN.md`'s; KNOWN wins on any disagreement. Every number in §1 carries the artefact it was
read from, in this worktree or the main checkout on 2026-09-27.

## Why this is a sprint and not a task

Sprint 16 measured the frame rate and fenced it; it did not aim at 60. Its profile (research/73) shows the mission
scene running at a steady 24–47 guest VBlanks a second with about 17 frames a second reaching the window, and it names
the wall: the thread that replays the recorded GS commands through OpenGL. Reaching 60 is not one lever. It is a
sequence of measured attempts on that thread, each with a stop rule, under a fence that refuses a moved pixel, and it
may need a structural change to how the replay thread and the guest are paced — which the owner has allowed. Beside it
sit two defects a player meets in the first ten minutes online (the game exits when they leave SOCOM Online; the
announcement may scroll wrongly when long) and the sound of the lobby, which no capture has ever recorded on either
side. Four milestones, one order, one fence.

## 1. What is established (2026-09-27) — **[verified: the tree, the logs and the notes named]**

### 1.1 The frame rate, where it stands

The model (research/73 §0; `docs/DEVELOPING.md` "The render backlog and the guest clock"): the game thread runs the
recompiled code and *records* GS commands; the thread that owns the window *replays* them (`HostRenderFrame` →
`executeCommands`) and presents through raylib's `EndDrawing`. `PS2X_GS_MAX_PENDING_FRAMES=3` holds the game thread
at `VBlankStart` while more than three guest frames are recorded ahead, and when that wait fires the VBlank anchor
moves to now (R41/R54: no catch-up). The guest's frame rate therefore collapses to the replay thread's rate.

| Reading, the gate's mission scene, post-HUD (research/73 §6; `logs/parity/f0/mission_game.log`) | Number |
|---|---|
| Guest VBlanks a second, 191 one-second windows: 24–31 in 134 of them, 32–47 in 57, none at 48 or above | mean **30.1** |
| Frames presented to the window a second (`present=` count) | **17.1** |
| Replay-thread iterations a second (`[gs-gl stats]` fps) | 19.7–20.3 |
| The game thread's back-pressure wait | **497 ms of every second** |
| Before the HUD (menus, briefing, cinematic) | 57.6 VBlanks a second |
| An online round, two instances on this host (Sprint 16 spec §1.2, `logs/run_A_20260925_194529.log`) | 58.4–60.0 VBlanks a second |

Where the replay thread's second goes in the mission window (research/73 §1, §6; ms of every second):

| Cost | ms/s | What it is |
|---|---|---|
| `submit=` — the draw path, `executeSubmit → flushBatch → setupDrawState → resolveTexture` | **568** | 186,969 submits/s, ~3.0 µs each; the GL driver's own self time is 4.3 % of the thread |
| the harness's screenshots (`PS2X_HOST_SCREENSHOT_LATEST`, `drive.py:65`) | **169** | PNG encode + `LoadImageFromScreen` every 150 ms; in every gate number, in no player's run |
| `upload=` | 59 | 10,584 uploads/s, 78.9 % `same_rewritten`, 84.8 % identical bytes; +22 ms/s on the game thread |
| `readback=` (the auto-exposure's `glReadPixels` of every GPU-dirty target, a mutex per pixel) | 29 | at most every 100 ms |
| `transfer=` + `present=` | 30 | |
| unaccounted (swap, poll, the loop; lock contention with the game thread on `m_stateMutex`/`m_queueMutex` is unmeasured) | ~145 | no instrument |

Inside the draw path the largest named function was `downloadRenderTargetToShadow`: a synchronous whole-frame
`glReadPixels` behind a GPU drain plus a 1024×512 decode, **once every frame**, for the game's own post-process copy of
the frame. **Its cause is a regression**: the fast path that serves a render target directly as a texture
(`PS2X_GS_RT_TEXTURE`, `1c301b9b`) has refused every full-frame read since Sprint 7 Task 1c sized targets from use
(`6ea95204`), because a 640×448 buffer can only be declared 1024×512 and the guard compared the envelope. **Sprint 16
F2 has removed the guard** on `agent/s16-f2` (`d3195418` the `[gs-submit]` per-flush split, `6cf07e29` the change,
`cceb8393` the review fix; reviewed PASS WITH FINDINGS, medium; `C:/Projects/wt-s16-f2/logs/f2_design.md`); its build
and gate were queued behind R1b's chain when this was written and **its number does not exist yet**.

The arithmetic for 60 (per guest frame, from the mission window): the replay thread spends 686 / 30 ≈ **23 ms**
replaying each guest frame; the draw path alone is 568 / 30 ≈ **19 ms**. Sixty needs everything on that thread under
**16.7 ms a frame**. If F2's read-back is the third of the draw path the whole-run stacks suggest, the draw path lands
near 12–13 ms a frame and the whole thread near the line, not under it. The next named costs are the texture hash
revalidation (`textureSourceHash`, 6.5 % of the thread whole-run, 1,028 revalidations/s), the decode (4.3 %), two
`snprintf` calls and two string searches per draw state that run **unconditionally** (`gs_gl_backend.cpp:3898-3937`,
2.0 %), every upload swizzled **twice** (`GSMem::WriteSpan` on both threads), and the auto-exposure read-back with its
per-pixel lock. None of these is a GPU cost: the GPU is idle-ish behind a CPU-bound replay.

**What no instrument measures today** (research/73 §7 and this reading):

- no per-frame timestamp or histogram exists anywhere; the sampler's one-second resolution cannot tell a 40 fps
  ceiling from 60 with hitches;
- the game's own frame rate — `sceGsSyncV` calls a second, the `[vu1-stats]` `syncv/s` field — is in **no mission
  log** (`PS2X_VU_STATS` was never set on one); whether one guest VBlank is one game frame is unproven for the
  mission, so "60 VBlanks" and "60 fps" are not yet the same claim;
- no mission has been measured in a player's conditions (without the screenshot knob);
- the replay thread's remaining ~145 ms/s has no instrument; no GPU-side timing exists at all.

The EE-side levers (F1's `-O2`, the per-instruction PC store) cannot move the frame rate while the replay thread is
the wall: the game thread waits about half of every second (research/73 §1; Sprint 16 F4 did not fire).

### 1.2 Leaving SOCOM Online, where it stands

Five run logs on the build machine carry the same sequence, 19 times in all (`grep -l "\[LoadExecPS2\]" logs/*.log`:
`run_20260920_120734`, `run_20260923_233814`, `_234126`, `_234854`, `run_20260924_021655`). Read from
`logs/run_20260923_233814.log:482-496` and `run_20260920_120734.log:5810-5826`:

1. the game tears its online session down: `snd_PcmStreamStop`, `snd_StopAllSounds`, `snd_UnloadBank`,
   `snd_StopSoundSystem`, then `[DBCMAN] DeleteSocket`;
2. an IOP RPC the runtime does not model: `[IOP/RPC trace:unhandled] sid=0x80000006 rpc=0xff ... loadedModules=[headseto.irx; lgaud.irx; ...]`
   (`Kernel/Syscalls/RPC.cpp:129`);
3. a guest fault: `[guest-fault] store8 vaddr=0xffffffff pc=0x1accd0 ra=0x0 ... a0=0xffffffff`. The address is inside
   **`kCopy@0x001ACCB8`** (`recomp/socom2.toml:500`), the SDK's copy helper called by `InitExecPS2@0x001ACBF8` —
   the kernel-patching prologue of the SDK's own `LoadExecPS2@0x001ACE88` wrapper. The destination is −1: a kernel
   address search (`kFindAddress@0x001AC950` / `GetSystemCallEntry@0x001AC9A0`, modelled in
   `Kernel/Syscalls/System.cpp:840`) came back empty against our HLE kernel;
4. the game's fatal handler (research/05 §"FTSCore": `LoadExecPS2("cdrom0:\SCUS_972.75;1", 3, {"--menu_state",
   "dlgAfterErrorReboot.rdr", ""})`) reaches our syscall, which logs `REBOOT requested ... this build cannot re-exec`
   and calls `std::exit(74)` (`Kernel/Syscalls/Thread.cpp:186-223`; `exit_codes.h:37`). The launcher shows the
   exit-74 sentence (`launcher_tests.cpp:572`).

So: **the game leaves SOCOM Online by re-executing itself with arguments the loader's `main()` parses** (the SDK
wrapper is entered before the fault), our kernel model faults inside that wrapper's prologue, and the error path then
asks for the reboot we cannot perform. **The owner's word, 2026-09-27 22:50Z: the same exit happens offline —
leaving a mission after reaching its briefing page closes the game.** No log on the machine records that route (all
five carry the online teardown, `DeleteSocket` included), so the re-exec reads as the game's general "back to the main
menu" mechanism, not an online one; the offline route is the cheaper reproduction (no server, one instance) and Q0
takes it first. Two things are unknown and decide the fix: the **argv the game's own quit path
passes** (hidden behind the fault; only the error path's argv was ever logged), and whether `InitExecPS2` completes
once the kernel search answers. The runtime today passes **no arguments to the guest at boot** (`main.cpp:162-181`
takes only the ELF path), and nothing in it can reset and reload a guest in-process.

### 1.3 The lobby's sound, where it stands

- **No capture of the online lobby's audio exists on either side.** Every audio artefact is the title, the menus,
  the briefing or the mission (`scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json`, `capture_audio_out.sh`,
  `mission_music_long.sh`). The console reference is reachable: PCSX2 logs into **our** hosted server through the
  screen-verified flow (`tools_py.parity.pcsx2_shell login B`, KNOWN §1's row of 2026-09-20), so a console lobby
  capture on the same server is one PCSX2 run.
- **#42** (50 ms holes): Sprint 16 V0 leg 3b read **9 over 11 minutes, max 3 in a minute**, all in the menu and
  briefing minutes, none in the mission windows; T1b's no-regression bar (6 total, 2 a minute) is red on that count,
  measured beside three sessions, not on a quiet host (issue #42, 2026-09-27).
- **#28** (the music degrades with time in a mission): its bar, a 10+ minute in-mission capture scored against PCSX2,
  has **never run** (KNOWN §2 row; the issue's Sprint 13 carry).
- **#91** (new, 2026-09-27): the mission's ambient bed plays **11 dB under the console** since the square-law group
  stage `554972e6` of 2026-09-20; 12/48 audio parity windows within tolerance on the sprint-16 tree.
- **Sprint 15 T1b** (the AutoVol integer step schedule) is DONE (code) on `agent/s15-t1b` with its GREEN build and
  review not landed (Sprint 15 plan Log, 391).
- The owner's word tonight: the stuttering in the online lobby, in matches and over long sessions is still a
  priority, **but has not been confirmed in a recent playtest**. `docs/HUMAN_TASKS.md` O7 (one listen against the
  console) and O8 (a PLAYTEST sitting) are open.

### 1.4 The announcement, where it stands

The server's protocol bound is `ANNOUNCEMENT_MAXLEN = 1000` (`server/horizon-server/RT.Common/Constants.cs:26`; read
and written at that width in `MediusGetAnnouncementsResponse.cs:36,53`). The tracked simulated-mode body is two short
lines (`server/config/db.config.json:7-8`, `SimulatedAnnouncementTitle`/`Body`; `server/README.md:147-150`). The game's
ANNOUNCEMENT page has never been shown a long body under our runtime or under PCSX2 on our server; the "errant
scroller" is the owner's observation, unrecorded. The local Horizon stack the ladder runs against is ours to
configure; the hosted server's config is the owner's hand.

### 1.5 The online menus the harness covers, and the ones it does not

Covered, with a read-back per stage (`tools_py/parity/online_login_ours.py`, its `@staged` steps: `login`,
`map_select`, `host`, `join`, `ready`; `online_match_ours.py` for the match; `docs/DEVELOPING.md` "The online
harness"). Not covered by any driven step: the clan pages (create, roster, invite, messages), the online SETTINGS
pages, the menu swapping between the lobby's rooms (announcement, briefing rooms, clan chat), swapping teams in a
game lobby, chatting (**#26**: no run has shown a received chat line crossing the client bound; the harness cannot
open the chat box), and the microphone across the line. On the microphone: the game **never sends** under our
runtime — the talk action is unbound in the loaded control preset (KNOWN §2 "Voice: the headset path"), the received
voice is only dumped (`micPlaybackWrite`, research/56 §6.1), and the launcher's MICROPHONE page says so
(`test_launcher_wording.py:125-131`). A "real test of the mic across the line" therefore has a precondition the tree
does not meet: the voice path (research/56 §6, "Q5") must exist first.

> Superseded in part, 2026-09-29 (research/80, H1): the harness does open the chat box (`online_match_ours.py
> --chat`, its `chat_line` step, Sprint 13) -- what #26 still lacks is a received line proven across the client
> bound; swapping teams in a game lobby is driven (`--host-switch`, `--same-team`, read by `lobby_teams_of`); and
> "the talk action is unbound" was withdrawn (research/66:192, both talk actions are bound) -- the game still never
> sends under our runtime, so the microphone row stays cannot-pass-yet for that reason.

### 1.6 Render scale, where it stands

`PS2X_GS_SCALE=1..4` (Shipping, the VIDEO page's DETAIL row; `docs/DEVELOPING.md` "Knobs"): every target's GL
texture at S× its native extent, everything the guest can observe through a native-sized mirror. `S=2` is verified
on both draw paths (gate stamps `s3d_2x_host`, `s3d_2x_gif`); `S=3` and `S=4` are admitted by the clamp and **have
no gate stamp**; memory is S² per target (67 MB a colour target at S=4). Two interactions this sprint must check: a
render target sampled as a texture goes through the native mirror, so F2's direct path at S>1 is a new case; and the
HUD, menus and title are textured quads at native texel density, so S sharpens geometry only (KNOWN §2, 197).

### 1.7 The validation that exists, the rules kept, and what is assumed from Sprint 16

Sprint 16 spec §1.4 (the gate 3/3 PINS MATCH, `--vram-diff` 15/15, the console-replay case, `audio_parity` 31/48 and
the dip count, the ladder's control bars, the `FRAME` line, the packaging audits) and §1.5 (windows R297, merges
R294, a failing test first, KNOWN wins, explicit pathspecs, nothing of the disc in the tree, nothing that is the
owner's performed, rulings from the one counter) hold unchanged and are not repeated. **Assumed from Sprint 16:** F2
at a recorded outcome with its gate number; F3 and F5 at theirs; the exe-only release (R) closed or its rows carried;
#59's ceiling in `pins.json`. Task 0 of the plan checks each and carries what did not land into this plan's table
under the milestone it serves (F2/F3 → F, F5 → the fence).

### 1.8 What the backlog already holds on these four fronts, and what this sprint absorbs (reviewed 2026-09-27 22:40Z)

Read: the 23 open issues and their bodies, `docs/BACKLOG.md` §2 (the 38 rows ruled not an issue),
`docs/LATER.md`, `docs/HUMAN_TASKS.md`, `docs/HANDOFF.md` §6, the Sprint 8 review findings filed for later
(KNOWN §2, 161), the Sprint 10 Q7 residuals (`docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` §3),
research/67 §5's watch rows, `docs/PLAYTEST.md` steps 10–13, and the testers' inbox (one report, a test submission of
2026-09-20; nothing to take).

| Item | Where it sits today | Absorbed as |
|---|---|---|
| **#59** the frame-rate bar | open, carried once; Sprint 16 F5 pins it | F6 re-cuts the pin; #59 closes when D1's bar is met, or stays open with D9's trigger |
| **#32** identical tiles re-uploaded (`same_rewritten` 79 %) | open, carried once; Sprint 16 F3 fired on it | Task 0 carries F3's outcome; if short, the upload skip is F1's fourth attempt |
| **The hash fold and the read-back PBO ring** — ruled "no issue" as `q7-render-performance` (BACKLOG §2; Q7 residuals §3: decode microseconds before and after the fold; a PBO ring for the exposure read-back, `glMapBufferRange` a frame later) and KNOWN §2 161 (a) "three walks of the texture source" | parked since 2026-09-21 with their measurements written | F1's first attempt (the fold) and F2 (the ring) **are these rows**; Task 0 strikes the ruled-out row in `docs/backlog_ruled_out.txt` with the citation, since a row with a task is not a "no issue" |
| **#67** the window drag (T2): its Step 3 proof, a drag in a mission with the before-capture on the `v0.14.0` exe | code merged; the run waits for an owner window (O20; HANDOFF §6) | rides on F0 (c)'s window: the same mission run takes the drag readout after its player-condition minute; the before-capture is one more launch in that window |
| **KNOWN §2, 23**: the game's own online frame rate was 19–21 `syncv/s` under two instances (Sprint 5, stale) while VBlanks ran 59.7/s | never re-measured (no `[vu1-stats]` in the 14 ladder logs) | F0 (b) also sets `PS2X_VU_STATS=1` in the ladder template so the next online run reads `syncv/s`; the owner's "in matches" is measured, not assumed |
| **#41** the menu-frame console-replay fixture (Sprint 16 X4) | open; not started | F6's guard: F1–F4 change the GL backend and the pixel fence today is one gameplay frame plus the gate; if X4 did not land, it is F6's first step (one PCSX2 run) |
| **LATER row 10** the EE scheduler and timers ("#59's bar fires on a regression"); **KNOWN §2 159** the back-pressure tests flaky under load | confidence rows, no task | F4's third candidate (the re-anchor rule) makes row 10 live; its design names the `GsFrameBackpressure` cases it must keep honest |
| **The exit-code suite and the launcher's exit-74 sentence** (`exit_codes_tests.cpp:55`, `launcher_tests.cpp:572`) | tests of today's behaviour | Q2 rewrites both: 74 stays for the genuine fatal path; the re-exec has no exit |
| **The stray sound on the online screens** — the owner's 2026-09-22 report, the sound-bank charge withdrawn (R239), "not yet found" (PLAYTEST step 11) | unresolved, no issue | A1's lobby recording is its instrument: the score looks for a short ramping deviation on the sign-in, CREATE GAME and lobby screens, on both sides |
| **#42, #28, #91**; **T1b**'s GREEN build, review and capture (HANDOFF §6) | open; owed | A3, A2, A4; A3 lands T1b |
| **`audio-level-residuals`** ruled "no issue" (BACKLOG §2: the mission bed 7–12 dB under, the title ring −4 to −6.5 dB, the movie audio ~18 dB low at the source) | the mission-bed clause is now **#91** | Task 0 rewrites the row to the two remaining clauses; A4 owns the bed |
| **#26** the received chat line (bar: the client function a lobby line uses; Sprint 13 O2 ruled out the libmedius callback) | open, carried twice; R296: the next plan that names it takes it | H's chat row names it; the first assertion of that row is #26's bar. **Named, not taken:** building it is H's condition (D7) |
| **The voice rows** ruled "no issue": `voice-hear-the-other-player` (the Sprint 8 voice plan's Task 5, the audible half), `voice-record-gain-and-dme` (lgaud 0x0e SetRecordGain; the DME framing around the 32-byte payload), `voice-research-35` | parked | H's microphone row lists them as its precondition, in that order; nothing built |
| **O7, O8** the owner's listen and PLAYTEST sitting | open owner rows | A0 |
| **paraLLEl-GS** (LATER row 32; research/67 §5, upstream's `feature/performance-patch-1` pinned at `3a66c19`) | watch row | F4 names it as the far option, gated on the owner's word (D2) |

Left where they are, with the reason: **#34** (a paused console peer; a mixed-match window, no visible defect
today), **#72** (two rooms; needs a second person), **#60**, **#47**, **#52**, **#54**, **#55**, **#57**, **#58**, **#25**
(no player-visible defect on these fronts); the audio residual rows `cue4-held-silent`, `emitters-at-volume-zero`,
`concurrency-cap` (R172), `unmodelled-grains` (R178), `q7-audio-residuals` (they fire only if A0's listen names their
shape); `gs-local-host-readback` (its stub was replaced by research/31 §11-13's readback; Task 0 checks the row is
stale and retires it); `window-policy-fullscreen` (the owner's playtest list).

## 2. Goals — four milestones in the owner's order, each with a bar

Markers: **[A]** autonomous; **[L]** lock-bound (a build, a run or a chain: a window the session announces or the
owner names); **[O]** the owner's hands, ears or decision; **[C]** cloud-capable.

### Milestone F — sixty at 1x **[L] throughout** — first, from day one

The bar of the milestone (D1): on the gate's mission stage, three quiet gates on one exe, **`FRAME mean=` ≤ 17.0 ms
and `worst1s=` ≤ 20.0 ms**, with the harness's screenshot cost named beside each number; the game's own frame rate
(`syncv/s`) within 5 % of the VBlank rate; the gate 3/3 PINS MATCH, `--vram-diff` 15/15, the console-replay case
unchanged, the fourth leg green. If the sprint ends short of the bar, the recorded outcome is the number reached, the
ranked residual and the next lever, in KNOWN — not a silent carry.

- **F0 the three missing instruments.** S, Opus for the code, one run. (a) A per-frame timestamp on the present
  path: a `[frame]` line on the stats cadence with a histogram of present-to-present intervals (buckets at 16.7, 20,
  25, 33, 50, 100 ms) and the longest gap; kept without the knob so a test can read it, printed with
  `PS2X_GS_STATS`. (b) `PS2X_VU_STATS=1` set by the gate's mission stage so `syncv/s` lands beside `FRAME` in every
  summary. (c) One plain mission run **without** `PS2X_HOST_SCREENSHOT_LATEST`, the same scene, the same knobs as
  F0 of Sprint 16: the player's number; the same window takes #67's drag readout after that minute, and the
  `v0.14.0` before-capture as one more launch (§1.8). (d) `PS2X_VU_STATS=1` in the ladder template too, so the next
  online run reads `syncv/s` beside its 60 VBlanks (KNOWN §2, 23). Bar: the readings in a KNOWN row with their
  commands; the histogram case red on a planted slow present.
- **F1 the draw path, attempt by attempt.** M, Fable designs, Opus builds each attempt; one build and one gate per
  attempt; at most four attempts, each with its measurement named from the `[gs-submit]` split before its branch
  exists and a stop rule (under a 25 % drop of its phase after one design: TRIED, NOT ADOPTED with the number).
  Ranked from §1.1 and re-ranked from F2's post-fix split when it lands: the hash revalidation (fold the hash into
  the decode walk, or hash only the rows the page generation moved — KNOWN §2's Sprint 8 review finding (a) and the
  Q7 residuals' §3 measurement: decode microseconds per texture before and after); the unconditional `snprintf` and
  string searches in `setupDrawState` (behind `s_stats`); the double swizzle (one `WriteSpan` per upload, the
  recorder's shadow the replay reads); the identical-bytes upload skip if Sprint 16's F3 landed short (#32); the
  decode's cache misses. Bar per attempt: the phase halved; the milestone's bar above.
- **F2 the read-backs off the frame.** M, Fable. The auto-exposure's `executeReadback` (a `glReadPixels` per GPU-dirty
  target and a `GSCpuBackend` lock per pixel, `gs_gl_backend.cpp:2867-2915`): one lock per row or per target, and
  the read moved to a pixel-buffer object fenced one frame later (the guest reads a 1×4 column 100 ms apart;
  research/31 §11-13 says which pixels) — the "readback PBO ring" of the Q7 residuals §3, with its measurement
  (readbacks per frame, the 99th-percentile frame time over a 60 s hold). Bar: `readback=` under 5 ms/s with the
  luminance the guest reads unchanged (a unit case on the readback's bytes; the gate's pins).
- **F3 the unaccounted 145 ms/s.** S, Opus. Instrument the loop remainder: time under `m_stateMutex` in
  `latchHostPresentationFrame`, under `m_queueMutex` in `HostRenderFrame`'s swap, the swap and the poll; one
  `[gs-loop]` line. Then the one change the numbers name (a lock held shorter, a copy avoided). Bar: the remainder
  split in KNOWN; a change only if a phase is over 30 ms/s.
- **F4 the pacing structure, if F1–F3 leave the guest waiting** (D2). L, Fable, the owner's permission already
  given: change how the replay thread and the guest are paced rather than what each frame costs. The candidates, in
  order of size: the replay thread stops replaying *every* pending frame per iteration and presents the newest while
  the older frames' draws are replayed for state only (state-correct, fewer GL draws); the texture decode and hash
  moved to a worker thread ahead of the replay (the decode reads the shadow VRAM the recorder wrote; the replay
  waits on a ready flag); `PS2X_GS_MAX_PENDING_FRAMES` and the re-anchor rule revisited with the histogram in hand
  (a repaid frame is not a lost one; the `GsFrameBackpressure` and `PS2RuntimeInterrupt` cases KNOWN §2 159 names
  as load-flaky must stay honest, not be loosened). A wholesale take of paraLLEl-GS (LATER row 32) stays out unless
  the owner says the word. Each candidate gets a design paragraph in the Log, one attempt, a stop rule, the fence.
- **F5 3x render scale — the second goal.** S–M, Opus, after the 1x bar or in the last two days: a gate stamp for
  `S=3` (title, mission, transition, both draw paths — the `S=2` recipe), F2's direct render-target path checked at
  `S=3` against the CPU backend's mirror, the memory in KNOWN, and the **adjusted frame rate**: the same three-gate
  `FRAME`/`syncv` reading at `S=3`, recorded beside 1x (D6: recorded, not fenced). The launcher's VIDEO DETAIL row
  already exposes the knob; its wording says what the number costs.
- **F6 the fence re-cut, and the menu pixel guard.** S, the controller, in the close chain: #59's ceiling in
  `pins.json` re-pinned from the three quiet gates on the sprint's final exe, the screenshot cadence named in the pin
  (Sprint 16 F5's caveat), the `syncv` reading pinned beside it; before and after in one table. Its first step, if
  Sprint 16's X4 did not land: **#41**'s menu-frame fixture from one PCSX2 dump (research/31's recipe), so the
  console-replay case guards a menu frame as well as a gameplay frame while F1–F4 change the backend.

### Milestone Q — the way back from SOCOM Online **[L] for its runs** — second, from day two

The bar of the milestone: a player who leaves SOCOM Online, or leaves a mission from its briefing page, lands on the
main menu, as on the console; the exit code 74 is reached only by the game's genuine fatal path.

- **Q0 the spike.** S, Fable, two runs: first the **offline route** (the owner's report: `launch_to_mission.txt` to
  the briefing, then the game's own exit back toward the main menu — one instance, no server), then the online one
  (`launch_to_online_ours.txt` to the lobby and out through QUIT), both with `PS2X_SCHED_TRACE=1` and a peek on the
  SDK wrapper's argument block; log the argv **before** `InitExecPS2` runs (a trace line at the wrapper's entry, or
  the syscall-entry peek), and the exact kernel search that returns −1 (`FindAddress`'s trace already prints its
  window). Output: a class-S research note, "how SOCOM II goes back to the main menu": the argv of each route, the
  search, whether the console re-execs here (research/05 §"FTSCore" says the loader's `main()` parses
  `--menu_state`), and the two fix routes costed.
- **Q1 the kernel-patch prologue completes.** S, Opus, test-first: `FindAddress`/`GetSystemCallEntry` answer for the
  window `InitExecPS2` searches (a modelled table entry, or the wrapper's `kCopy` made a no-op when the destination
  is −1), so the wrapper reaches our syscall with the game's argv. Bar: the `ps2x_tests` case red on today's answer;
  the run of Q0 reaches `[LoadExecPS2]` with an argv other than `dlgAfterErrorReboot.rdr`, no `[guest-fault]`.
- **Q2 the re-exec.** M, Fable (D3): `LoadExecPS2` as an **in-process restart** — the scheduler stopped, guest RAM,
  the GS frontend and backend, the IOP HLE modules and the audio mixer reset, the ELF reloaded, `argc`/`argv` placed
  where the crt0 reads them (the kernel's argument block; the SDK's `SetArg@0x001ACCF8` shows the layout), the game
  thread restarted; the window, the GL context and the launcher's process untouched. The fallback if the reset
  proves wider than the box: the exe exits with a **new code and the argv in a sidecar file**, and the launcher
  relaunches it with those arguments (the window blinks once). Bar: both Q0 drives end on the main menu with a
  reference match (`ref_main_menu_ours.png`); the harness steps `quit_mission` and `quit_online` green on three
  launches each; the exit-code suite updated; the FAQ's sentence about leaving online, if one exists, corrected.
- **Q3 the announcement scroller.** S, Opus, one run each side (D4): a 1,000-character body in the **local**
  Horizon stack's `db.config.json`; a drive that reaches the ANNOUNCEMENT page and holds it 30 s with captures at
  1 s; the same on PCSX2 against the same local server (`pcsx2_shell login`); the two capture rows compared (does
  the text scroll, wrap, clip, or run off; the cadence). Bar: the difference, if any, in KNOWN with both contact
  sheets; a fix only if ours differs from the console's, test-first on the text layout path it names.

### Milestone A — the lobby's sound **[O] first, then [L]** — third

- **A0 the owner's listen (O7/O8).** The owner plays: the online lobby for ten minutes, a match, a long session,
  and says whether the stuttering is still there and where. Nothing in A2–A4 is scheduled before the answer; A1 runs
  regardless (D5) because the lobby has no recording at all.
- **A1 the lobby's recording, both sides.** S, Opus, two runs: ours — `launch_to_online_ours.txt` to the lobby, held
  N minutes with `PS2X_AUDIO_DUMP` (the mixer's output) and the endpoint capture (`capture_audio_out.sh`'s
  recipe), `PS2X_AUDIO_TRACE=1`, `PS2X_AUDIO_CB_TRACE=1`; the console — PCSX2 logged into the same server, its
  endpoint captured the same N minutes. Scored with `audio_dips.py` (device against dump) and `audio_parity.py`
  windows over the lobby's music; the drive holds the sign-in, CREATE GAME and lobby screens where the owner heard the
  stray "short and ramping deviation" of 2026-09-22 (PLAYTEST step 11; the bank charge withdrawn, R239), and the
  score looks for it on both sides. Bar: the two recordings and the two scores in KNOWN as the lobby's first audio
  row; a dip count, a level delta and the stray sound's verdict, with their commands.
- **A2 #28's capture, at last.** S, one run of 10+ minutes in a mission with the dump exported, scored against the
  PCSX2 reference of the same mission (the issue's bar as written). Fires on A0's word or on A1's count.
- **A3 #42 on a quiet host.** S, one run: the leg-3b capture repeated with nothing else on the machine; then the
  T1b-revert trial the KNOWN row names if the count stays above 6/2. T1b's GREEN build and review land here.
- **A4 #91 the ambient bed.** S, Opus, test-first: the per-voice level term against the IRX chain as decompiled
  (`vol.c:147-149`, `434-455`), the issue's caveat read first; the fix measured on the same 48-window comparison.

### Milestone H — the online menus' harness, scoped **[A]** — last, only if time remains

The owner's word: not a suite that runs every commit or sprint; targeted checks run when we need them, for our
confirmation and the parity goal. This sprint **scopes** it (D7): a design note,
`docs/superpowers/specs/<date>-online-menus-harness-scope.md`, one row per screen or flow with the drive steps, the
read-back that proves it (a reference crop, a peek, a log line), the console reference (PCSX2 on our server), and
what it costs to build. The rows: every clan page (create, roster, invite, messages), the online SETTINGS pages, the
lobby's rooms and the swapping between them (announcement, briefing rooms, clan chat), swapping teams in a game
lobby, chatting both ways across the line (#26's bound is the first assertion), and the microphone across the line.
The microphone row states its precondition plainly: the voice path of research/56 §6 (the talk action, the send
callback, the audible receive) does not exist under our runtime, so the test is written and marked **cannot pass yet**
until a sprint builds Q5 — whose parts are already on record as the ruled-out rows `voice-hear-the-other-player`
(the Sprint 8 voice plan's Task 5), `voice-record-gain-and-dme` and `voice-research-35` (§1.8). The chat row's first
assertion is #26's bar as written. Built only if time remains after F, Q and A; otherwise the note is the deliverable and the
first row goes to LATER with its trigger.

### Order, time boxes and the windows budget (D8)

Day one: Task 0 (the Sprint 16 carry), F0's code, Q0's peek and trace lines, A0 asked of the owner. Days two to five:
F1's attempts one gate at a time, Q1 then Q2 beside them, A1 in the first quiet window the owner names. Days five to
seven: F2, F3, F4 if F1–F3 leave the guest waiting more than 100 ms/s, Q3, A2–A4 on A0's word. The last two days: F5,
F6 in the close chain, H's note, the lessons. Six to eight loop days. Lock-bound windows: F0 one run; F1 one build and
one gate per attempt (four at most); F2, F3 one each; F4 one per candidate; F5 one gate; Q0 one run; Q1, Q2 one build
and one run each; Q3 two runs; A1 two runs; A2, A3 one each; A4 one build. Every game run waits for a window the owner
names (R297).

## 3. Decisions for the owner — each with the default the sprint proceeds on

| # | Decision | Default |
|---|---|---|
| D1 | The statement of "60" | `FRAME mean=` ≤ 17.0 ms and `worst1s=` ≤ 20.0 ms over the gate's walk, three quiet gates on one exe, the screenshot cost named beside the number; `syncv/s` within 5 % of the VBlank rate |
| D2 | Structural pacing changes (F4) | allowed on this spec's word when F1–F3 leave the guest waiting over 100 ms/s; each candidate one design, one attempt, one stop rule, the fence; paraLLEl-GS needs the owner's word |
| D3 | The re-exec route (Q2) | in-process restart first; the launcher-relaunch fallback with the argv in a sidecar if the reset proves wider than the box |
| D4 | The long announcement | on the local Horizon stack; the hosted server's config is the owner's hand and is not touched by the loop |
| D5 | Audio work gated on the owner's listen | A1 runs regardless (the lobby has no recording); A2–A4 wait for A0's word or A1's count |
| D6 | 3x scale's "adjusted frame rate" | recorded beside 1x, not fenced; the launcher's wording names the cost |
| D7 | The harness for the online menus | scoped in a note this sprint; built only if time remains; the microphone row marked cannot-pass-yet |
| D8 | Time boxes | six to eight loop days; a phase past its box hands its rows to LATER with the measured reason |
| D9 | The frame-rate bar reached short | the recorded outcome is the number, the ranked residual and the next lever in KNOWN; #59 stays open with that trigger |

## 4. The acceptance bar of the sprint

1. **Sixty, or the honest distance to it:** F0's three instruments in the gate; D1's bar met on the final exe, or
   the number reached with the ranked residual and the next lever in KNOWN; every attempt at a recorded outcome
   (ADOPTED with its phase halved, or TRIED, NOT ADOPTED with the number); no moved pixel; `S=3` stamped with its
   frame rate recorded.
2. **The way back:** leaving SOCOM Online and leaving a mission from its briefing each land on the main menu on three
   driven launches; the argv and the mechanism of both routes in a research note; the announcement's behaviour with a 1,000-character body recorded against the console, fixed
   if it differed.
3. **The lobby's sound has a record:** both sides' recordings and scores in KNOWN; #28's capture run if A0 or A1 asked
   for it; #42 re-measured on a quiet host; #91 at a recorded outcome.
4. **No regression:** Sprint 16 §1.4's list holds on the final exe.
5. **The harness scoped:** the note exists with every row of §2 H, or the reason it does not.
6. **The record:** every Believed row a task touched moved with its artefact; LATER re-sorted; the two ruled-out rows
   §1.8 names rewritten (`q7-render-performance` struck as a task, `audio-level-residuals` cut to its two remaining
   clauses) and the stale `gs-local-host-readback` row checked; the ceilings hold; the owner's rows updated with what
   was asked and when.

## 5. What this does not do

Build the online menus' harness unless time remains (H). Voice chat itself (Q5): the microphone row is scoped, its
precondition named, nothing sent. A paraLLEl-GS take without the owner's word. A change to the hosted server's
configuration or the site. Any connection to a server that is not ours. A performance change accepted from a failed
gate, or one that moves a pixel or a score. An installer, a publish, an upstream filing. #34, #26 beyond H's row,
#25, #47, #52, #54, #55, #58, #60.

## 6. Pointers

`docs/research/73-mission-frame-time.md` (the profile; §8 the commands; on `sprint-16`, merged with it) <!-- docmaint: future -->; `C:/Projects/wt-s16-f2/logs/f2_design.md`
and `agent/s16-f2` (F2's design and commits); `docs/superpowers/specs/2026-09-27-sprint-16-ten-minutes-to-the-server-design.md`
(§1.2, §1.4, §1.5, Milestone F); `docs/superpowers/plans/2026-09-27-sprint-16.md` (the F rows' statuses; on `sprint-16`) <!-- docmaint: future -->;
`docs/DEVELOPING.md` ("The render backlog and the guest clock", "Knobs", "The online harness", "Instruments and
diagnostics"); `docs/research/05-code-package-and-harness.md` (§"FTSCore", the self-relaunch);
`third_party/ps2recomp/ps2xRuntime/src/lib/Kernel/Syscalls/Thread.cpp:176-223` and `System.cpp:840` (the reboot and
the kernel search); `recomp/socom2.toml:490-505` (the SDK's ExecPS2 family); `docs/research/56-*.md` §6 (what voice
chat needs); `docs/research/14-gs-render-target-scale-spike.md`; `server/README.md:147-150` and
`server/horizon-server/RT.Common/Constants.cs:26` (the announcement); issues #59, #32, #42, #28, #91, #26;
`docs/LATER.md` rows 1, 3, 4, 7, 32; `docs/HUMAN_TASKS.md` O7, O8, O20.
