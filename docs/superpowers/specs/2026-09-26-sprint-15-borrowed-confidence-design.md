# Sprint 15 design — "borrowed confidence": what we replaced in PS2Recomp without the evidence, who else solved it, and the trials that settle each one

> **Re-cut 2026-09-26 (the owner's word): value first** — audio registered and tried, the drag freeze fixed, two
> small measurements if time allows, about three loop days; every other subsystem deferred to `docs/LATER.md`
> with a trigger. The first proposal's shape is summarised at the end ("What the first proposal had and why it was cut").

Date: 2026-09-26 (host clock), proposed while Sprint 14 is open. **Opens at Sprint 14's close** (Sprint 14 decision
D8), off `main` at the Sprint 14 merge; until then this is a proposal and nothing here changes an open sprint. The
plan is `docs/superpowers/plans/2026-09-26-sprint-15.md`. The origin is the cloud research handoff of 2026-09-25,
kept verbatim with a banner at `docs/superpowers/plans/2026-09-25-borrowed-confidence-cloud-handoff.md`: it never ran
and no cloud session is available to the project from 2026-09-26, so this pair rewrites it for the owner's machine.
The owner's direction of 2026-09-26 cut it to value: "we should order it by perceived value and time and scope a few
different tasks ... We don't need to blindly test everything and we should target those that have the highest
value. If confident, some can be dismissed outright."

## Why this is a sprint and not a task

The question is unchanged: **which parts of PS2Recomp did we replace, rewrite or extend without the evidence to be
sure of them, who else has solved the same problems, and what happens when we try their answers?** The scope is not:
of the two subsystems the owner first named (VU1 and audio), this sprint registers and tries **one, audio**, because
it is the one with visible defects on it — the 50 ms holes in the mission music (#42) and the music that degrades
with time in a mission (#28). Beside it run the visible defects that need no survey: **the drag freeze (#67)** first,
then, if time allows, two small measured tasks, **the mission frame-rate bar (#59)** and **the menus' atlas
re-upload (#32)**.

The divergence is 438 commits on the vendored recompiler and runtime since the vendor base
(`git log --oneline 8736759..HEAD -- third_party/ps2recomp | wc -l`, 2026-09-26, on `sprint-14` at `352fed01`). What
validates those commits today is the three-stage gate against our own earlier captures, the interpreter as the oracle
for the native VU1 programs, the CPU rasteriser as the oracle for the GL backend, and unit tests that in many
subsystems have no oracle at all — "a regression fence against ourselves" (the 2026-09-26 structure review, F3, F9).
That stays true of every subsystem; what changes is that only audio's rows are written and tried now. Every other
subsystem gets its row in `docs/LATER.md` with a confidence and a trigger — the event that would bring it back — or
a dismissal with its reason (D8).

A task could fix one issue. A sprint is needed because the audio register decides which borrowed answer is tried,
and because the trial runs under a stop rule with its result recorded either way. "Tried, not adopted" is a valid
outcome and is written down.

## 1. What is established (2026-09-26) — **[verified: the tree and the notes named]**

### 1.1 The divergence — the walk list, kept as the record of what was replaced

`docs/research/40-upstream-divergence.md` §2 is the table of what we changed by subsystem against base `14b1e5c`,
with upstream since it one squash (`75d729c`, PR #244). `docs/research/41-cucumber-fork.md` read the
MrCoolTheCucumber fork for design under the owner's ruling "read for design, identify specific pieces, do not merge
wholesale" and set the bar "an overwhelming case" for a large take. `docs/research/42-upstream-cherry-picks.md` and
`docs/research/63-upstream-triage-2026-09-25.md` hold verdicts for PRs #205–#253, and
`docs/research/67-external-sweep.md` (Sprint 14 X1) swept upstream, the forks, PR #254 and the peers on 2026-09-26.
The walk list of everything we replaced, kept here as the record: the VU1 interpreter and the native programs
(`third_party/ps2recomp/ps2xRuntime/src/lib/vu`), the VU0 macro path and the recompiler's VU translator, the FPU
translator, the GS OpenGL backend against the CPU rasteriser, VIF1, the GIF arbiter, the DMAC, the EE scheduler and
timers, SIF/RPC and the IOP host, each IOP module we wrote or changed (`snd989`, `lgaud`, `eznetcnf`, `dbcman`,
`mcserv`), the host mixer, the MPEG/IPU path, the CD/ISO path, the save-state container, memory cards, pads, and the
recompiler's function-boundary and jump-table handling.

**This sprint's register covers the audio rows only:** the host mixer (`ps2_audio.cpp`, the device callback and the
dump), the 989snd model (`ps2xIOP/src/modules/snd989.cpp` at the RPC boundary, `snd989_mixer.cpp`), `lgaud`
(`ps2xIOP/src/modules/lgaud.cpp`), the IOP host's audio path (`ps2_iop_host.cpp`, SIF/RPC as far as the sound
servers use it), and the SPU2 model (the ADPCM decode, the envelopes and the voices in `snd989_mixer.cpp` and
`ps2_audio_vag.cpp`). Every other entry of the walk list is a row in `docs/LATER.md`.

### 1.2 The validation that exists

- The gate: three stages (title, transition, mission) scored against pinned references, `tools_py/parity/gate.py`,
  3/3 with PINS MATCH as the bar; the fourth leg (Sprint 14 E2, the held-out leg) has its twelve references
  (`352fed01`).
- Audio: `tools_py/parity/audio_dips.py` (the dip count on a recording) and `tools_py/parity/audio_parity.py`
  (31/48 since 2026-09-20, unchanged); the 989snd model against Ziemas' decompilation in
  `docs/research/36-989snd-decomp-audit.md` (989DSTRM.IRX's stream engine is signatures only: the streamer is read
  from our own IRX disassembly); the path in `docs/research/32-audio-path.md`. Today's DEVICE number: 6 dips over 16
  minutes on the quiet-endpoint capture of 2026-09-25 (`audio_out_20260925_074147`, KNOWN §2's #42 row), with 0 late
  and 0 dry callbacks — the register re-reads it over the existing recordings (R1).
- The record: `docs/KNOWN.md`'s vocabulary — Proven (§1), Believed (§2), Retracted (§3), and `docs/HAZARDS.md` — is
  the register's vocabulary, and KNOWN wins on any disagreement.
- **Assumed from Sprint 14** (this sprint opens at its close): the fourth leg (E2), gate freshness (E4), the
  recompiler re-derivation in CI (E3), the merged chain as the gate unit (W2), the WIP cap (W1), the guards (G1–G5),
  the skills (I2). If Sprint 14 closes without one of these, the plan's Task 0 says which and the trials' bars fall
  back to the three-stage gate alone, recorded as such.

### 1.3 What running locally changes, against the handoff

- The register cites the generated code and the recordings directly; the dip counter over the existing mission
  recordings is a lock-free read of `logs/`; a new capture is a lock-bound step at a quiet window.
- Lock-free and lock-bound steps sit inside one task, and the lock-bound ones batch through the merged chain
  (Sprint 14 W2) rather than a "Proof requests" section.
- Edits to KNOWN, HUMAN_TASKS and the sprint file are the controller's, made under review, as in any sprint.
- Time boxes replace the dollar budget (D5). The branch, hook and fetch recipe is the `agent-worktree` skill.

### 1.4 The subsystem this sprint registers, and the defects beside it

**Audio.** The 989snd model is an HLE at the RPC boundary (slots, envelopes, the 240 Hz tick inferred), the
streamer is inferred from the IRX alone, something between the mixer and the device loses about 50 ms of the music at
a time (#42: the device thread is exonerated on the quiet capture; the loopback recorder's overflow drops and the
scorer's alignment are what remain), and the music degrades over a long mission (#28: the long in-mission capture
against PCSX2 has never run); `libsd` is untouched and `lgaud` is ours. The borrowed answer on the table is PR #254
(the DQ8 fork, `Sinan-Karakaya/PS2Recomp`): the game's own sound modules run unmodified on a small LLE IOP with both
SPU2 cores, its clock driven by the audio device. research/67 §3 recorded it on 2026-09-26 as a draft, 0 reviews,
`mergeable: false`, its fork's CI failing on MSVC and GCC, GPL-3.0; X1 answers whether it fits us (D1).

**The drag freeze (#67).** The mechanism is named in KNOWN §1: the Win32 modal move loop (`WM_ENTERSIZEMOVE` to
`WM_EXITSIZEMOVE`) runs on the presenting thread and the guest's frame back-pressure waits on those presents, so the
guest clock stops for the length of the drag — the render-thread stall class of `docs/HAZARDS.md`. The fix keeps
presents flowing through the move loop, or decouples the guest's back-pressure from it. No survey is needed.

**The frame-rate bar (#59).** The gate prints `FRAME mean= worst1s= n=` and pins it as informational (S13-R3); three
gates on one exe spread 30 % on a host that was not quiet (KNOWN §2). Measure first, then a bar.

**The atlas re-upload (#32).** The menus upload 7–11k 1 KB tiles a second at 80–133 ms/s; the V2 skip moved `upload=`
about 4 %; the cost is in the `changed` and `same_rewritten` tiles; tile batching is the untested fix (KNOWN §2).

**VU1, deferred.** Four programs on the interpreter, the FTOI NaN rule a fork's rule under a unit test, #47's flag
latency open — and no visible defect on it but #47. Its row goes to `docs/LATER.md` with its experiment written:
`vu1_replay` over the recorded dumps (the inputs never carried), one PCSX2 trace or cited source for FTOI on NaN, and
#47's MiniTest against a PCSX2 trace; its trigger is a visible defect on a VU1-drawn model family or #47's trace
arriving.

### 1.5 The rules this sprint keeps

- A failing test first, unittest only; RED and GREEN pasted; a trial's measurement named before the trial runs, with
  its value today.
- KNOWN wins; a finding that moves a Believed row moves it in KNOWN with its artefact, in the same commit as the
  evidence, never by a silent edit of a research note.
- Commit with an explicit pathspec; the leak check in the hooks; never `--no-verify`; nothing under `game/`, `vm/`,
  `tools/`, `logs/`, `recomp/output*/` or any byte derived from the disc enters the tree; a count from the generated
  code is cited with its command, never pasted as data.
- Nothing about a security mechanism in a tracked file (`SECURITY.md`'s process; S13-R4).
- What only the owner can decide gets its default and a ruling from the global counter at the open; the loop does
  not wait. Nothing that is the owner's is performed.
- No upstream PR is filed from this sprint (D3).

## 2. Goals — five milestones, each with a bar

### Milestone R — the audio register **[A]** — half a day, first

- **R1** `docs/research/<n>-confidence-register.md` (the next free number; class S by the glob): one row per audio
  subsystem of §1.1 — the host mixer, snd989, lgaud, the IOP host's audio path, the SPU2 model. Columns: subsystem
  and files (the commit count since the base, counted); what we replaced and why; how it is validated today (the
  unit tests by file, whether the gate exercises it, whether an oracle exists, the KNOWN row); confidence in KNOWN's
  vocabulary — Proven, Believed, Untested, Hazard; the gap (what would have to be true for ours to be wrong, and what
  the player hears); the experiment that would settle it; the issue. The dip counter (`audio_dips.py`, the R3 of the
  first proposal) run over the existing mission recordings under `logs/` gives the rows their number today, the
  recording named. A header line points at LATER for every non-audio row. Bar: every number names its command;
  every confidence cites the KNOWN row or the test file; the dip count the sprint's no-regression bar uses is written
  here.

### Milestone X — the audio survey **[A]** — one day, from the register's non-Proven rows

- **X1** Starts from `docs/research/67-external-sweep.md` and does not repeat it: the forks table, the peers
  (N64Recomp, XenonRecomp) and the ten KEEP notes (`docs/research/assets/63-upstream-drafts/keep-notes.md`) are out.
  In depth: **#254's LLE IOP as a candidate** — whether its kernel's imports cover what `989SND.IRX` and
  `989DSTRM.IRX` call (research/67 §3: "an import the kernel does not provide returns zero"), its SPU2 cores against
  our mixer, its device-driven clock against #42's holes and #28's degradation; **what the DQ8 fork does for sound**
  (the modules it names: LIBSD, SDRDRV, the Standard Kit, PCMPLAY; its `PS2X_AUDIO_DUMP`); **the licence** (the file
  named); **the MSVC state** re-read (research/67: the fork's CI failed on MSVC and GCC at `e42efbe`; our toolchain
  is llvm-mingw). The question under D1 answered either way: does an LLE IOP running the disc's own IRX fit "audio
  native, the N64-recomp shape" or contradict it. Emulators (PCSX2's SPU2, OpenGOAL's 989snd) only where a register
  row's gap needs a reference, each with its licence file. The note ends with a shortlist of at most three audio
  candidates, each with its register row, its path (TAKE, REIMPLEMENT, BORROW THE IDEA, LEAVE; research/40's rule
  that the IOP tree is an idea, not a patch; research/41's bar, D6) and its validation with today's number. Bar: #254
  answered; every entry's licence file named; docmaint green.

### Milestone T — the trials and the defects **[A] then [L]** — the second and third days

- **T0** The checkpoint: T1 written into the plan from X1's shortlist — the register row it would settle, the
  adoption path, the RED test that fails today, the measurement (the dip count, with today's value from R1) and the
  stop rule, its lock-bound steps. Where X1 could not tell whether the design fits, T1 is a bounded spike (one
  lock-free day, a recommendation as its output). Bar: no trial without a measurement and a stop rule.
- **T1** The audio trial, in its own agent worktree: RED first; the code; the suites; review by a fresh agent; the
  merged chain at a quiet window with the gate 3/3, the fourth leg, `audio_parity.py` and the dip count; the outcome
  ADOPTED (the KNOWN row moves, the register row moves) or TRIED, NOT ADOPTED (the reason and the number, in the
  register and the Log; the branch left unmerged with "throwaway" in its last subject, or reverted).
- **T2** #67 the drag freeze, a defect task beside T1 (it needs no survey and may start on day one): the fix keeps
  presents flowing through the move loop or decouples the guest's back-pressure from it. The bar is issue #67's: a
  scripted drag with the pc-sampler's `t=`/`vsync=` advancing through it, the audio counters unchanged, the gate 3/3,
  and a dragged instance in a control round.
- **T3** #59 the frame-rate bar, if time allows after T1 and T2: measure first — the gate's `FRAME mean= worst1s=`
  line over three gates on one exe on a quiet host, read against the three saved stamps of the three exes (KNOWN
  §2's row); then a bar, as a KNOWN row or a refusal rule under test (S13-R3), or the measurement recorded as why no
  bar holds yet.
- **T4** #32 the atlas re-upload, if time allows after T1 and T2: tile batching on the menus' 1 KB tiles, the
  80–133 ms/s number (the stats line's `upload=` column on the login screen) as the measurement; adopted if it halves
  it with the gate 3/3 (BACKLOG's bar).

T3 and T4 not reached by the fourth day go to LATER with their measurement and a trigger.

### Milestone V — a measurement where a claim has none **[A]** — only if T1 needs it

- **V1** If T1's claim has no measurement in our tools (for #28, the long in-mission capture scored against PCSX2),
  build it first under a planted case, in the docmaint pattern. Bar: it reads a known number on a known input
  before T1 uses it.

### Milestone L — the lessons **[A]** — once, before the close

- **L1** The register updated from the Log; KNOWN rows moved with their artefacts; the audio shortlist re-ranked; the
  next candidate named for Sprint 16 or its row moved to LATER. Bar: the register's confidence column matches KNOWN.

### Time boxes (D5)

R half a day (day one); X one day (day one to day two); T0 at X's end; T1 and T2 the second and third days (T2 may
start on day one: it needs no survey); T3 and T4 only after T1 and T2 have a recorded outcome; the close by the
fourth day. A phase past its box hands what is done to the next and the rest to LATER.

## 3. Decisions for the owner — each with the default the sprint proceeds on

Each default gets a ruling from the global counter at the open; none is numbered here.

| # | decision | default |
|---|---|---|
| D1 | May the survey recommend replacing the 989snd HLE model with an LLE IOP running the disc's own IRX (the DQ8 fork's approach)? | yes, as a candidate, with the acceptance bar ("audio native, the N64-recomp shape") argued for and against; the owner decides whether it becomes a trial |
| D2 | May a candidate that changes the generated image's shape (a recompiler change, a naming change, the function bounds of #55) be a trial? | only with a full recomp, the recompiler re-derivation green, `--accept-pins` after a green run, and a ruling from the global counter |
| D3 | Is upstreaming part of the sprint? | no new upstream PRs; what we could give back is noted per candidate for row O10 |
| D4 | Register rows that are Proven today are excluded from the survey | excluded, unless a source contradicts the proof, and then the artefact it contradicts is named |
| D5 | Time boxes in place of the handoff's dollar budget | R half a day, X one day, T1 and T2 the second and third days, the close by the fourth; T3 and T4 only if time allows |
| D6 | The "overwhelming case" bar for a large take (research/41) | stands; a TAKE over about five hundred lines needs a ruling |
| D7 | The order of the work | audio first, then the drag freeze, then the measurements (#59, #32) |
| D8 | The walk list's non-audio subsystems | deferred to LATER, not registered this sprint; VU1 deferred with its experiment written — the owner's word of 2026-09-26 |

## 4. The acceptance bar of the sprint

1. **The audio register rows exist** — the host mixer, snd989, lgaud, the IOP host's audio path, the SPU2 model —
   each with today's number and its command, each confidence with its artefact.
2. **#254 is answered** either way, the LLE question argued, the licence file named, the MSVC state as it stands.
3. **T1 runs to a recorded outcome** — ADOPTED with the KNOWN row moved, or TRIED, NOT ADOPTED with the number.
4. **T2 meets issue #67's bar:** the scripted drag with `t=`/`vsync=` advancing, the audio counters unchanged, the
   gate 3/3, a dragged instance in a control round.
5. **No regression:** the gate 3/3 with PINS MATCH and the fourth leg green on the sprint's final exe; audio parity
   not below 31/48; the dip count not above the register's number. No Believed row a trial touched is left
   Believed.
6. **LATER holds every deferred row with a trigger and every dismissal with its reason** — the walk list's non-audio
   subsystems, VU1 with its experiment, and T3/T4 if not reached.
7. **The record's ceilings hold**; the register and the survey are class S snapshots, not read-first documents.

## 5. What this does not do

A register row for any non-audio subsystem (they are LATER's, D8). A VU1 trial. A re-read of the forks, the peers or
the ten KEEP notes (research/67 and research/63 hold them). A wholesale merge of any fork (research/41's ruling
stands). Any upstream filing (O10). The naming programme's follow-ups (#55, #57, #58 stay in the backlog). Voice,
the community preset, a public download, anything in HUMAN_TASKS that is the owner's. A trial that fails its stop
rule is recorded and stopped, not extended.

## 6. Pointers

`docs/superpowers/plans/2026-09-26-sprint-15.md` (the plan); `docs/superpowers/plans/2026-09-25-borrowed-confidence-cloud-handoff.md`
(the origin, never run); `docs/superpowers/specs/2026-09-26-sprint-14-guards-not-sentences-design.md` (§1.5, D8,
D9, X1); `docs/research/67-external-sweep.md` (§3, PR #254); `docs/research/40-upstream-divergence.md`,
`41-cucumber-fork.md`, `42-upstream-cherry-picks.md`, `63-upstream-triage-2026-09-25.md`; research/32 and 36;
`docs/audits/2026-09-26-autonomy-structure-review.md` (F3, F9); `docs/BACKLOG.md` (#28, #32, #42, #47, #59, #67);
`docs/KNOWN.md`; `docs/HAZARDS.md`; the deferred rows' home, drafted on `agent/s14-c3`: `docs/LATER.md`.

## What the first proposal had and why it was cut

The first proposal (this file's shape until the re-cut, the same day) asked the same question of the whole walk
list: a register row for every replaced subsystem (R1) with a VU1 paragraph (R2, the replay run here) and an audio
paragraph (R3); a survey in four parts — every fork and peer swept (X1), #254 in depth for both VU1 and audio (X2),
emulators as references for every gap (X3), an adoption framework with an agentic glance and a shortlist of ten
(X4); at least three trials, the first two on VU1 and audio (T0, T<n>), measurements built where missing (V), and
lessons after the first three trials (L); time boxes of a day for the register, two for the survey, T0 on the
third, the close by the seventh. It was cut because the owner, reading it on 2026-09-26, called it a week of planned
work and asked for the work ordered by perceived value and time, with confident rows dismissed outright: a register
of every subsystem is testing everything blindly; VU1 has no visible defect but #47; research/67 (Sprint 14 X1)
already swept the forks and the peers; and the drag freeze, the frame rate and the menus' upload cost are what a
player meets now. Nothing it would have registered is dropped: each row is in LATER with a confidence and a trigger,
or dismissed there with its reason.
