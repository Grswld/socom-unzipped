# 70. The LLE IOP as an oracle -- the spike (Sprint 15 T1)

Date: 2026-09-26 (reading 18:15Z-19:25Z; build 1 19:27:28Z-19:27:36Z; build 2 20:25:10Z-20:25:19Z; the replays
20:25Z-20:27Z; by `date -u`). Sprint 15 Task T1 (plan `docs/superpowers/plans/2026-09-26-sprint-15.md` "## Task T1"),
the spike on the shortlist's first entry of `docs/research/69-audio-survey.md` §6. Class S, the shape of
`docs/research/14-gs-render-target-scale-spike.md`: a question, a time box, a decision up front. No game run; nothing
of #254's 3,311 lines, nothing of the disc and nothing of the scratch glue is in the tree. The fork's head and the
glue live under `C:/projects/scratch-s15-t1/` ("scratch"): `fork/` (a depth-1 clone of `Sinan-Karakaya/PS2Recomp` at
`e42efbe`), `oracle/` (the patched slice, the harness with the provider, its CMake and build script, the replay
driver, the result tables). The disc's IRX files were read in place in the main tree under `game/disc/RUN/IRX/`, by
command, counts and behaviour only.

> **State at last commit** (T1, 2026-09-26 20:28Z):
> - **Recommendation: ADOPT AS ORACLE** (out of the tree, never the product): on the mission replay the disc's own
>   989SND.IRX on #254's LLE IOP with our provider disagrees with our HLE on 832 of 13,044 answers, where #244's blind
>   oracle disagreed on 12,643; on the menus' replay on 17 of 1,794 (19 on #244). Every bank load, stream start and
>   sound play agrees (§9).
> - **N = 832** of 13,044: `grep -m1 "Compared answers" C:/projects/scratch-s15-t1/oracle/results_lle_232655.md`,
>   after the replay of C10. 815 of the 832 are stream lifetimes read on the replay's clock, not the game's -- 706
>   polls on 12 handles and 109 parameter calls on 12 other handles (§9.2); the review found at least 655 of the 699
>   "the IRX stopped first" polls to be that clock, so they are not a #28 lead (§9.4). 17 are the menus' three classes.
> - **The build:** build 1 (the slice as shipped) stopped on two missing `#include <cstdlib>` in the fork
>   (`kernel.cpp:328` `std::strtol`, `spu2.cpp:73` `std::abs`); the controller amended the stop rule by one build;
>   build 2 with the two lines added linked (`HARNESS EXIT 0`, last line `build end 2026-09-26T20:25:19Z`, C6).
> - **After a refused read, 989SND.IRX fails cleanly; it does not spin** -- read from the IRX (§2) and then seen by
>   execution with the provider off (§9.3): 5 of 5 mission bank loads answer 0 (cause 61, then cause 14 "Done...
>   ERROR reading file!"), no call runs more than 586 IOP instructions.
> - **A correction to research/40 §9:** the "cdvdman safe-read form (the callback form)" #244 lacked is `sifman`'s
>   `sceSifSetDmaIntr`, the IOP-to-EE DMA with a completion callback (§3). The minimal provider is cdvdman's 7 imports
>   plus that one.
> - **R287:** nothing of the 3,311 lines would enter the tree; about 650 lines of our own glue would, carrying 92
>   lines of the fork's code as diff context (§6). The register row "the IOP host's audio path" moves Untested ->
>   **Believed** with the scratch artefacts named (research/68). The owner's D1 line is in §7.

## Decision (short)

**Recommendation: ADOPT AS ORACLE.** The plan's bar: adopted as an oracle "if the same replay on the fork's IOP with
the provider reads within the menus' order, 19 in 1,794, ... each remaining disagreement named", or clearly better than
our 12,643. The menus' replay reads 17 in 1,794, every one of them named; the mission replay reads 832 in 13,044,
fifteen times fewer than 12,643, with 815 in one class that is the very thing the oracle exists to examine (stream
lifetimes, research/68's streamer inference) and 17 in the menus' three known classes. As the product it is not
recommended (research/69 §5 stands: an interpreter inside the recompilation); the runtime is untouched. The owner
decides D1 (R282): the sentence for the owner is in §7.

## 0. The commands

| Id | Command (local unless a `gh api` GET; 2026-09-26) |
|---|---|
| C1 | `git init fork && git -C fork fetch --depth 1 origin e42efbe6434403018b80cda23034abf9644830ec` (origin `https://github.com/Sinan-Karakaya/PS2Recomp.git`), checkout `FETCH_HEAD`; `wc -l fork/ps2xIOP/src/lle/*` (3,311 over 11 files); `head -3 fork/LICENSE` (GPL-3.0) |
| C2 | research/69 C4's coverage scan re-run on the clone: `python irx_cover.py fork/ps2xIOP/src/lle/kernel.cpp game/disc/RUN/IRX/SOUND/989SND.IRX game/disc/RUN/IRX/LIBSD.IRX game/disc/RUN/IRX/SOUND/989SND.IRX` and the same for `989DSTRM.IRX` (12 and 1 imports returning zero, as research/69 read) |
| C3 | the names of the unbound imports: `gh api -H "Accept: application/vnd.github.raw" repos/ps2dev/ps2sdk/contents/iop/cdvd/cdvdman/include/cdvdman.h \| grep DECLARE_IMPORT`, the same for `iop/system/sifman/include/sifman.h` and `iop/system/ioman/include/ioman.h` |
| C4 | the static reading, a scratch script on capstone 5.0.7 (`python irxdis.py 989SND.IRX callers <stub>` / `dis <from> <to>` / `func <addr>`) that disassembles the IRX's text in memory and prints to the terminal only: call sites per import (`sceCdRead` 4, `sceCdGetError` 5, `sceCdSync` 6, `sceCdCallback` 4, `sceCdBreak` 3, `sceSifSetDmaIntr` 6), then the code after each `sceCdRead` and in the bank loader that calls it |
| C5 | the decomp's error table: `sed -n 360,381p research/989snd-ziemas/iop/error.c` (cause 61 "snd_KickDataRead: Error calling sceCdRead()!", 62 the same for `snd_KickVAGRead`, 66 "snd_VAGStreamLoadDoneThread: Error DMAing data to EE memory!!!"); cause 14 "snd_BankLoad: Done... ERROR reading file!" in the same file; `grep -n sceSifSetDmaIntr research/989snd-ziemas/iop/*.c` (5 call sites in v3.01) |
| C6 | the builds. Build 1: `bash scripts/loop_lock.sh run agent-s15-t1 --purpose "T1 spike: the lle slice" --class build --wait 240 -- bash C:/projects/scratch-s15-t1/oracle/build.sh`; `grep -nE "error:\|EXIT" C:/projects/scratch-s15-t1/oracle/build.log`: `PRISTINE EXIT 1`, `HARNESS EXIT 1`, the same 3 errors in each. Build 2 (the stop rule amended by the controller): `bash scripts/loop_lock.sh run agent-s15-t1 --purpose "T1 spike: the lle slice, build 2" --wait 30 --class build -- bash C:/projects/scratch-s15-t1/oracle/build.sh`; `tail -2 C:/projects/scratch-s15-t1/oracle/build2.log`: `HARNESS EXIT 0`, `build end 2026-09-26T20:25:19Z` |
| C7 | #244's `sifman`: `sed -n 28,131p research/ps2recomp-244/ps2xIOP/src/emulator/services/iop_rpc.cpp` (`dispatchSifManImport`: cases 4, 5, 7, 8, 29; `default:` answers 0 at line 128) |
| C8 | today's numbers: `grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_232655.md` (13,044 and 12,643) and the same on `results_run_20260922_150258.md` (1,794 and 19) |
| C9 | the glue's size: `diff --strip-trailing-cr fork/ps2xIOP/src/lle/<f> oracle/lle/<f>` per patched file; `wc -l oracle/harness_lle.cpp oracle/CMakeLists.txt oracle/build.sh oracle/oracle-patch.diff`; `grep -c "^ " oracle/oracle-patch.diff` (92 context lines); `diff docs/research/assets/40-irx-differential/replay.py oracle/replay_lle.py \| grep -c "^[<>]"` (19) |
| C10 | the replays, from the main tree: `python C:/projects/scratch-s15-t1/oracle/replay_lle.py --log logs/run_20260922_232655.log --harness C:/projects/scratch-s15-t1/oracle/build/harness_lle.exe --out C:/projects/scratch-s15-t1/oracle/results_lle_232655.md > C:/projects/scratch-s15-t1/oracle/replay_232655.out`; the same with `run_20260922_150258` (the menus); the same mission replay with `ORACLE_NO_PROVIDER=1` to `results_lle_232655_noprovider.md`; each `grep -m1 "Compared answers"` of its table |
| C11 | the classes: `grep DISAGREE C:/projects/scratch-s15-t1/oracle/replay_232655.out \| awk '{print $2}' \| sort \| uniq -c`; the polls grouped by handle and by which side answered 0 first (a scratch one-liner over the same file); `grep -o "cause -\?[0-9]*" <out> \| sort \| uniq -c`; `grep "^#[0-9]" C:/projects/scratch-s15-t1/oracle/replay_232655_noprovider.out \| grep -o "instr=[0-9]*" \| cut -d= -f2 \| sort -n \| tail -1` (586: the per-call lines, which the driver prints for every disagreeing call; the unrestricted grep also meets the boot SNAP line's 22501) |

## 1. The question and the time box

The question (the plan's T1): can #254's LLE IOP run this game's `989SND.IRX` to its first bank load as an oracle out
of the tree, given a minimal `cdvdman` provider (read, sync, the callback form) -- and what does the driver do after a
refused read, which research/69 §2 left open because `sceCdSync` 0 and `sceCdGetError` 0 read as success and a retry
loop would spin. The number: of the mission replay's 13,044 answers, how many the oracle disagrees on.

The box: one lock-free day of reading plus ONE build of the `lle/` slice under the lock. Spent: the reading and the
writing 18:15Z-19:25Z; build 1 waited on the queue's WIP cap (ten refusals from 18:29Z, queued 18:59Z) and ran 8 s at
19:27Z; its stop fired on two missing includes, not on anything the spike asks, and the controller amended the stop
rule by one build; build 2 ran 9 s at 20:25Z in a window the controller named. The two replays took seconds each.

## 2. What 989SND.IRX does after a refused read -- the reading

Read from the disc's own IRX (C4), cross-read with the decomp's error strings (C5). On #254's unpatched kernel every
`cdvdman` import answers 0 (research/69 §2), which is what a refused read looks like to the driver.

- **At the read.** Each of the two read kick functions (the data read behind bank loads and the VAG read behind
  streams) tests `sceCdRead`'s own return before anything else. On 0 it asks `sceCdGetError`; **an answer of 0 there
  is replaced by -1** before it is stored, so "no error" never survives a refused read. The data kick then reports
  cause 61 (and a console line unless the driver's quiet flag is set), clears its in-progress state, wakes the thread
  waiting on the read and hands the error to a registered requester; the VAG kick sets an error bit on the stream's
  record, reports cause 62 and drops the request. Neither calls `sceCdRead` again.
- **In the bank loader.** The loader reads a bank in sector runs through the stream-safe read. When that read
  refuses, or the stored error after its sync is non-zero, it stops: it reports the error (0x30, cdvdman's read error,
  or the kick's -1) to its caller, signals its semaphore and returns 0. `snd_BankLoadByLoc` answers 0 -- a clean
  failure the EE sees, not a hang and not a silent success over an unfilled buffer.
- **Where `sceCdSync` 0 would matter.** Only after a read that was accepted: the loader trusts sync and error then. A
  provider that accepts a read must make both honest -- `sceCdSync(1)` 1 while the read is in flight, `sceCdGetError`
  the read's own result -- or the loader would parse a buffer the provider has not filled. The scratch provider does.

§9.3 confirms this by execution. research/69 §2's worry does not hold for this driver.

## 3. A correction to research/40 §9: the "callback form" is `sceSifSetDmaIntr`

research/40 §9.1 attributed run 1's seven `snd_StreamSafeCdRead` disagreements and run 2's stream failures to "the safe-read
path's cdvdman call (... the callback form)", and §9.3 item 2 named "#244's cdvdman safe-read form" as one of the two
gaps. The IRX's own import table (C4) places the sifman stub research/40 §9 names in the `sifman` import block, fourth of four, and ps2sdk's name for that import is `sceSifSetDmaIntr` (C3): a SIF DMA from IOP to
EE memory with a completion callback -- `(descriptors, 1, callback, data)` is exactly its signature. The cause the
failure prints, 66, is "Error DMAing data to EE memory" (C5). #244's `sifman` answers 0 for every import but five,
and this is not one of the five (C7). research/40's reading is left as written (the plan's rule: a disagreement is
stated with its evidence, not by editing the note); research/69 §2's "for want of one `cdvdman` form (the callback
read)" inherits the same slip. The minimal provider is therefore **cdvdman's seven imports plus `sifman`'s
`sceSifSetDmaIntr`**; `ioman`'s four serve by-name loads, which neither replay reached (0 opens, C10's SNAP line).
With that import served, research/40's seven `snd_StreamSafeCdRead` disagreements still stand, but no longer as a gap:
the IRX answers `0x84000002` in 175-293 IOP instructions with no error cause, and ours answers 1 -- a **model
difference** in what that call returns (§9.1), not the emulator's.

## 4. The provider, the patch and the harness (scratch, not in the tree)

- **The oracle patch** to five of the slice's files (`oracle/oracle-patch.diff`, +124/-2 lines, C9): an `EeLink`
  hook for a host to claim an import the kernel does not bind, the stub-to-import map and one kernel handler that
  dispatches a claimed import to the host; deferred host work serviced on the IOP clock (a read or a DMA completing);
  a work counter; `printf` rendering `%d %u %x %s %c %p`, so "989snd Error: cause N" says which N (research/40's
  patch 2 found the same need on #244); and the two `#include <cstdlib>` lines build 1 lacked.
- **The provider** in `oracle/harness_lle.cpp` (487 lines with the REPL): `sceCdRead` fills IOP memory from the disc
  image after 1 ms plus 4 MB/s (the latency is ours, research/69 §2) and refuses while busy; `sceCdSync` blocks or
  polls by its mode's bit 0; `sceCdGetError` returns the read's result; `sceCdCallback` stores the function and its
  `$gp` and the completion calls it with the read code; `sceCdStop`/`sceCdBreak` cancel; `sceCdStatus` answers read or
  pause; `sceSifSetDmaIntr` writes the descriptors to EE memory at once and calls the completion a SIF round trip later;
  `ioman` open/close/read/lseek on the extracted disc. `ORACLE_NO_PROVIDER=1` leaves them all unbound.
- **The harness** speaks research/40's line protocol (`load`, `rpc`, `tick`, `peek`, `snap`), so research/40's
  `replay.py` runs against it; the scratch copy `oracle/replay_lle.py` changes only its root, its title and a `--no-usb`
  switch (19 diff lines; not used). A `tick` of 4,920,000 EE cycles steps the IOP 800 or 801 samples and reports the
  SPU2's peak. An RPC waits on the IOP clock up to 2 s, as #254's `NativeIop::call` does.

## 5. The builds (C6)

llvm-mingw's clang 23.1.0, CMake and Ninja from `tools/`. **Build 1** (8 s): target 1, the slice as #254 ships it --
`cpu.cpp`, `irx.cpp`, `iop.cpp` compile; `spu2.cpp` (line 73, `std::abs`) and `kernel.cpp` (line 328, `std::strtol`) do
not: neither includes `<cstdlib>`, and libc++ does not reach it through `<algorithm>`, `<cstring>` or `<cstdio>`.
Target 2, the patched copy plus the harness: the same two errors and no other. research/69 C10's "the LLE slice itself
uses standard headers only" stands; it did not ask whether they are the right ones. **Build 2** (9 s, the stop rule
amended by one build): the two includes added to the patch; `spu2.cpp` and `kernel.cpp` compile, `harness_lle.exe`
links. Last line: `build end 2026-09-26T20:25:19Z`, after `HARNESS EXIT 0`.

## 6. R287: what would enter the tree

As research/40's assets did for #244, the glue would enter under `docs/research/assets/` and the take would not:

| What | Lines | Whose |
|---|---|---|
| #254's `lle/` slice (11 files) | 3,311 | the fork's; stays in an out-of-tree clone, as `docs/research/assets/40-irx-differential/CMakeLists.txt` points at #244's |
| the oracle patch, as a diff | 244 (+124/-2 changed; 92 lines of the fork's code as context) | ours, over theirs |
| the harness with the provider | 487 | ours |
| CMake and the build script | 14 + 15 | ours |
| the replay driver's change | 19 diff lines (or a `--harness`-agnostic option in research/40's `replay.py`) | ours |
| **sum** | 487 + 14 + 15 + 126 + 19 = **661**; 687 with the patch's own lines (the review's count) | |

**The answer:** the TAKE entering the tree is zero lines; what enters is 661 lines of our own glue (C9; 687 with the
patch's own lines) and 92 lines
of the fork's GPL-3.0 code as diff context (the same licence as ours). R287's bar ("a TAKE over about five hundred
lines needs a ruling") is not crossed by the take. If the controller counts the glue as part of the take, it is over
five hundred and needs a ruling; this note reads R287 as written and does not ask for one.

## 7. The register, the owner, the next step

- **The register row** ("the IOP host's audio path", research/68) moves **Untested -> Believed** in this commit: the
  oracle ran two replays; the artefacts are `C:/projects/scratch-s15-t1/oracle/results_lle_232655.md` and
  `results_lle_150258.md` today, landing under `docs/research/assets/70-lle-oracle/` in T1c (landed there as
  `results_lle_run_20260922_232655.md` and `results_lle_run_20260922_150258.md`, T1c). Believed, not Proven: the oracle is the disc's driver on an emulated IOP
  with our provider's timing, not the console.
- **The one line for the owner (D1, R282), as sent:** "The spike recommends using #254's LLE IOP as an out-of-tree
  oracle for the audio work -- the disc's own sound driver checks our model (832 disagreements in 13,044 answers,
  against 12,643 on the old oracle); 661 lines of our own harness would enter `docs/research/assets/`, carrying 92
  lines of #254's GPL-3.0 code as diff context and none of its files, the game unchanged -- do you want it adopted
  (yes/no)?" **The owner's answer (2026-09-26 evening, via the controller): "yes, adopt it as an oracle if it has
  proven value"**; the controller judges it has, on the review's re-run. The landing under
  `docs/research/assets/70-lle-oracle/` is T1c, a separate task.
- **The next experiment:** a frame-stamped replay. The run log already carries `[audio] 989snd stream <h> start|done
  frame=N` lines and the harness's `tick` takes any cycle count, so the replay can advance the IOP by the game's own
  frames between calls instead of one frame per call; then compare the frame at which each stem's poll first answers 0.
  RPC latency and the tick's phase stay untested until then.

## 8. What this note does not do

No game run and no runtime change: the dip count stays 6 (max 2 a minute) and audio parity 31/48 by construction. No
edit to research/40 or 69, to KNOWN or to `docs/HUMAN_TASKS.md`. Nothing is filed upstream (R284); the two missing
includes and the unbound `sceSifSetDmaIntr` are notes for #254's author in O10's words, not issues. The static reading
of §2 names behaviour, error causes from the public decomp and the one stub address research/40 already printed; the
replay tables quote the RPC arguments and answers research/40's tables already carry, and stay in scratch.

## 9. The replays (C10, C11)

### 9.1 The menus: `run_20260922_150258`, 2,007 calls, **17 in 1,794**

Every one of the 17 is a class research/40 §9.1 named on #244, one of them re-read: `snd_StreamSafeCdRead` 7 (the
IRX answers `0x84000002` where ours answers 1 -- with `sceSifSetDmaIntr` served and no error cause, a model
difference, not research/40's emulator gap, §3), `snd_CallExtension(0x12c4e67a, 6)` 6 (the IRX 0: nothing registered under that id
without a headset; ours invents 1), `snd_PcmStreamPosition` 4 (an SPU2 transfer position on the IRX, a clock on ours).
The two that research/40 charged to the register bag -- the 5th and 6th `snd_BankLoadByLoc` -- now agree: #254's SPU2
completes the DMA. All 6 bank loads, the stream start, 3 PCM opens and all 1,764 polls agree.

### 9.2 The mission: `run_20260922_232655`, 16,607 calls, **N = 832 in 13,044**

The provider served 293 reads (5,067 sectors, none refused, 271 completion callbacks) and 80 `sceSifSetDmaIntr`
transfers; the IRX printed cause 59 ("already a data load in progress") 3 times and no other error. All 5 bank loads,
all 29 `snd_PlayVAGStreamByLoc`, all 24 `snd_PlaySoundVolPanPMPB`, 2 `snd_InitVAGStreamingEx`, 6 PCM opens, 340
`snd_StreamCdIdle` and 21 `snd_GetMasterVolume` agree -- on #244 the heap was gone after the third bank load and every
stream died at its first read. The 832:

| Class | Answers | Reading |
|---|---|---|
| `snd_SoundIsStillPlaying`, the IRX answers 0 while ours still plays | 699, over 5 stream handles (569, 51, 49, 24, 6 polls) | the IRX's stream played out first on the oracle's clock |
| `snd_SoundIsStillPlaying`, ours answers 0 one poll before the IRX | 7, over 7 handles (1 poll each) | a one-poll phase difference at the end of a stream |
| `snd_SetSoundParams` | 109, on 12 other stream handles (36, 20, 15, 9, ... calls) -- none of the polled 12 | still stream lifetimes on the replay's clock: a handle ours keeps alive is already gone on the IRX (e.g. one set at call 5044 inside our life of calls 4912-5509) |
| `snd_StreamSafeCdRead`, `snd_CallExtension`, `snd_PcmStreamPosition` | 7, 6, 4 | the menus' three classes (§9.1) |

**The caveat on the 815.** The replay advances the IOP one NTSC frame per logged call (research/40's `--tick`), not
per frame the game ran: the calls carry no frame stamps (only the stream start and done lines do), so the oracle's
clock is the call sequence's. A stream's
life on the oracle is therefore not its life in the game, and the 699 are not yet a verdict on our streamer -- they
are where it and the IRX part on this clock. Twelve handles end at a different
poll; every other polled handle ends on the same one. The experiment that turns the class into a finding is §7's frame-stamped trace. The IRX logged no error on any
of the five long-disagreeing handles.

### 9.3 The refused-read case by execution: `ORACLE_NO_PROVIDER=1`, 12,619 in 13,044

With the provider off, every cdvdman call answers 0 as on #254's kernel as it stands. All 5 mission bank loads answer
0 (ours `0xa00000`-class), each after cause 61 (7 in all) and cause 14 "snd_BankLoad: Done... ERROR reading file!" (5);
streams start (29 of 29 `snd_PlayVAGStreamByLoc` agree) and then report stopped. The largest disagreeing RPC (every other call
agreed) ran 586 IOP instructions and the whole replay 34 million, against 250 million with the provider: **no spin**, the clean failure of
§2 as read.

### 9.4 The reviewer's reading of the 699 (T1 review, 2026-09-26)

The review read the stream lives against the run log's own `[audio] 989snd stream <h> start|done frame=N` lines. The
replay ticks one NTSC frame per logged call, while the game issued 76-161 calls a second during those lives, so the
oracle's clock runs ahead of the game's. Measured in seconds each way, five of the six polled lives have the same
length on both sides (46.0/46.0, 2.9/3.0, 9.1/9.3, 7.0/7.2 and 1.6/1.7 s); one, our handle `0x4010355`, lives 28.9 s
in the game and 58.0 s on the oracle, unexplained. "Our streamer never reports a stream's end" is ruled out: every
stream has a done line. **At least 655 of the 699 are the replay's clock**, so the 815 stream-lifetime disagreements
are not a #28 lead as §9.2 first put it; the frame-stamped replay of §7 is what would make any remainder one.
