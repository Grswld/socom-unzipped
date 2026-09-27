# 69. The audio survey: #254's LLE IOP answered, the DQ8 fork's sound, the shortlist

Date: 2026-09-26 (the reads 17:41Z-17:55Z by `date -u`). Sprint 15 Task X1 (plan
`docs/superpowers/plans/2026-09-26-sprint-15.md`, spec `docs/superpowers/specs/2026-09-26-sprint-15-borrowed-confidence-design.md`
§1.4, §2 Milestone X, §3 D1). Read-only: nothing was built or run; every network read was a `gh api` GET against a
public repository. It starts where `docs/research/67-external-sweep.md` §3 stopped (the design of #254, its conflict
with #244, its CI of 2026-09-25) and does not repeat it; the forks table, the peers and the ten KEEP notes are out.
The register it serves is `docs/research/68-confidence-register.md` (five audio rows; the non-audio rows are
`docs/LATER.md`'s, R289). The disc's IRX files were read in place under the main tree's `game/disc/RUN/IRX/`, the only
copies on this machine (`git ls-files | grep -i irx` finds none in the tree): **counts only leave them**. **No verdict
here is a decision:** the owner decides whether D1's trial runs (R282); a TAKE over about five hundred lines needs its
own ruling (R287); nothing is filed upstream (R284).

> **State at last commit** (X1, 2026-09-26 17:55Z):
> - **#254 answered:** its LLE kernel does not cover SOCOM II's sound drivers. Of `989SND.IRX`'s 70 imports, 12
>   return zero on it -- all 7 `cdvdman`, all 4 `ioman`, 1 of 4 `sifman` -- and 1 of `989DSTRM.IRX`'s 18 (C4): 13
>   imports unbound, and every call 989snd has to the disc (`cdvdman`, `ioman`) is one of them, so each read is
>   refused at the call. What the driver does next was not read: that is the spike's to see. `LIBSD.IRX`: 19 of 19
>   covered (C4).
> - **The fork is unchanged since research/67:** head `e42efbe`, draft, `mergeable: false`; the five newest fork
>   runs all `failure`, MSVC and GCC at Build, Clang at Tests (C1, C6). The LLE slice itself uses standard headers
>   only; the `ucontext.h` failure is `EeFiber.cpp`'s, outside it (C10). Licence: `LICENSE`, GPL-3.0 (C9), as ours.
> - **The shortlist, ranked** (§6): (1) the IOP host's audio path -- TAKE #254's `ps2xIOP/src/lle/` out of the tree
>   as an oracle in research/40's differential harness, with a `cdvdman` provider of ours; (2) snd989 -- REIMPLEMENT
>   the AutoVol integer schedule (research/36 item 4); (3) the SPU2 model -- BORROW THE IDEA of reverb and the
>   4-point Gaussian, after the register's reverb on/off pair. The bars: the dip count 6 (at most 2 a minute) and
>   audio parity 31/48 (research/68's state block). The host mixer row (#42) gets no borrowed candidate (§4).
> - **D1 argued (§5):** as an oracle the LLE IOP contradicts nothing; as the product it is an interpreter inside a
>   recompilation, a detour from "audio native" unless its end state is the IRX recompiled. Not recommended as the
>   product today; the owner decides.

**How to read the numbers.** Every number names its command, `[C1]` to `[C15]` in §0. "Scratch" is a local
directory outside the tree holding the fork's files as fetched by C2 (nothing fetched is committed). "Ours" is this
tree at `39d5c0ab` (`sprint-15`). File paths of the fork are under `Sinan-Karakaya/PS2Recomp` at `e42efbe`; ours are
under `third_party/ps2recomp/`.

## 0. The commands

| Id | Command (every `gh api` a GET, run 2026-09-26 17:41Z-17:55Z) |
|---|---|
| C1 | `gh api repos/ran-j/PS2Recomp/pulls/254 --jq '{state,draft,mergeable,mergeable_state,commits,changed_files,additions,deletions,updated_at,head:.head.sha}'` |
| C2 | `gh api 'repos/Sinan-Karakaya/PS2Recomp/contents/ps2xIOP/src/lle?ref=e42efbe6434403018b80cda23034abf9644830ec' --jq '.[].name'`; per file `gh api -H "Accept: application/vnd.github.raw" "repos/Sinan-Karakaya/PS2Recomp/contents/<path>?ref=e42efbe6434403018b80cda23034abf9644830ec" > scratch/<file>` for the eleven `lle/` files, `ps2xIOP/src/native_iop.cpp`, `ps2xRuntime/src/lib/ps2_native_iop.cpp`, `ps2xIOP/README.md`; then `wc -l scratch/lle/*` |
| C3 | `grep -oE '\{"[a-z0-9]+", [0-9]+, "[A-Za-z]+"\}' scratch/lle/kernel.cpp \| wc -l` (the kernel's bindings), and `grep -oE '\{"[a-z0-9]+", [0-9]+' scratch/lle/kernel.cpp \| cut -d'"' -f2 \| sort -u` (their libraries) |
| C4 | the import-coverage scan of §A, run from the main tree: `python irx_cover.py scratch/lle/kernel.cpp game/disc/RUN/IRX/SOUND/989SND.IRX game/disc/RUN/IRX/LIBSD.IRX game/disc/RUN/IRX/SOUND/989SND.IRX`, and the same with `989DSTRM.IRX` and `LIBSD.IRX` as the second argument |
| C5 | `gh api -H "Accept: application/vnd.github.raw" repos/ps2dev/ps2sdk/contents/iop/cdvd/cdvdman/include/cdvdman.h \| grep DECLARE_IMPORT`, and the same for `iop/system/sifman/include/sifman.h` (the names ps2sdk gives the ordinals C4 finds unbound) |
| C6 | `gh api 'repos/Sinan-Karakaya/PS2Recomp/actions/runs?per_page=5' --jq '.total_count, (.workflow_runs[] \| "\(.name) \(.head_branch) \(.head_sha[0:7]) \(.conclusion) \(.created_at)")'`; for the newest run on `main` and on `feat/native-iop`: `gh api repos/Sinan-Karakaya/PS2Recomp/actions/runs/<id>/jobs --jq '.jobs[] \| "\(.name) \(.conclusion) \([.steps[] \| select(.conclusion=="failure") \| .name] \| join(","))"'` (the ids are not copied: long numbers trip the leak check) |
| C7 | `gh api repos/Sinan-Karakaya/PS2Recomp/branches --jq '.[] \| "\(.name) \(.commit.sha[0:7])"'`; `gh api 'repos/Sinan-Karakaya/PS2Recomp/contents/ps2xIOP/src?ref=<branch>' --jq '.[] \| select(.name=="lle") \| .sha'` for `feat/native-iop` and `e42efbe` |
| C8 | `gh api repos/Sinan-Karakaya/PS2Recomp/compare/ran-j:main...Sinan-Karakaya:feat/native-iop --jq '"\(.ahead_by) \(.behind_by) \(.files\|length)"'` |
| C9 | `gh api repos/<o>/<r>/license --jq '.path+" "+.license.spdx_id'` for `Sinan-Karakaya/PS2Recomp`, `PCSX2/pcsx2`, `open-goal/jak-project`, `Ziemas/989snd` (the last answers 404; `gh api repos/Ziemas/989snd/contents/ --jq '.[].name'` lists no licence file) |
| C10 | `grep -h '#include' scratch/lle/* scratch/native_iop.cpp scratch/ps2_native_iop.cpp \| sort -u`; `find tools/llvm-mingw -name ucontext.h \| wc -l` (0) |
| C11 | ours: `grep -n kTickHz third_party/ps2recomp/ps2xRuntime/src/lib/snd989_mixer.cpp` (lines 532, 1856); `sed -n 1886,1890p` of the same file (the linear interpolation); `grep -c -i reverb` of the same file (0) |
| C12 | the fork's SPU2: `sed -n 170,218p scratch/lle/spu2.cpp` (the voice step, "Four-point Catmull-Rom" at 210), `sed -n 343,397p` (the reverb), `sed -n 220,275p` (the envelope); the clock: `grep -n kCyclesPerSample scratch/lle/iop.h`, `sed -n 389,398p scratch/lle/iop.cpp` |
| C13 | PCSX2: `gh api -H "Accept: application/vnd.github.raw" repos/PCSX2/pcsx2/contents/pcsx2/SPU2/Mixer.cpp \| sed -n 287,296p` (the 4-tap `interpTable`), `.../pcsx2/SPU2/interpolate_table.h \| head -12`; `gh api repos/PCSX2/pcsx2/contents/pcsx2/SPU2 --jq '.[].name'` |
| C14 | the glue: `sed -n 140,160p scratch/native_iop.cpp` (the EE's wait), `sed -n 190,200p` (render under the lock); `sed -n 20,32p scratch/ps2_native_iop.cpp` (`PS2X_AUDIO_DUMP`), `sed -n 55,60p` (the 1,024-frame stream); `gh api repos/ran-j/PS2Recomp/pulls/254 --jq .body` |
| C15 | ours: `wc -l third_party/ps2recomp/ps2xIOP/src/modules/snd989.cpp third_party/ps2recomp/ps2xRuntime/src/lib/snd989_mixer.cpp` (1,802 and 2,407); `grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_232655.md` (and `..._150258.md`) |

## 1. #254 as it stands, 2026-09-26 17:41Z (what moved since research/67)

Nothing. C1: open, draft, `mergeable: false`, `dirty`, 69 commits, 120 files, +20,730/-3,241, head `e42efbe`,
`updated_at` 2026-09-25T07:45:31Z, 0 comments and 0 review comments. The fork's `main` is still `e42efbe` (C7).
One thing research/67 did not record: the fork keeps the IOP work on a branch of its own, `feat/native-iop` at
`5416450` (C7), 60 ahead of and 3 behind upstream's `main` over 113 files (C8) -- not a smaller split -- and its
`ps2xIOP/src/lle` tree is the same object as at `e42efbe` (`9bfa49f` on both, C7). The eleven `lle/` files are
3,311 lines (C2), as research/67 counted from the PR's file list.

## 2. Does the LLE kernel cover what SOCOM's sound drivers import?

**No: 12 of `989SND.IRX`'s 70 imports and 1 of `989DSTRM.IRX`'s 18 return zero on it** (C4). How the fork resolves
an import (C2, `iop.cpp:475-488`): a library another loaded module exported is jumped to; otherwise the kernel's
table of 99 `(library, ordinal)` bindings over 12 libraries (C3) -- `intrman loadcore sifcmd sifman stdio sysclib
sysmem thbase thevent thmsgbx thsemap timrman` -- gives a handler; anything else is `unknownImport`, which "returns
zero" and logs a line (`kernel.cpp:102-105`). With `LIBSD.IRX` and `989SND.IRX` loaded in the game's order (research/40
§7), C4 reads:

- **`989SND.IRX`:** 13 libraries, 70 imports. 42 bound by the kernel; the 16 `libsd` imports resolve through
  `LIBSD.IRX`'s exports; **12 return zero: `cdvdman` 7 of 7, `ioman` 4 of 4, `sifman` 1 of 4.** By ps2sdk's names
  (C5) the seven `cdvdman` imports include `sceCdRead`, `sceCdSync`, `sceCdGetError` and `sceCdCallback`; the
  `sifman` one is `sceSifSetDmaIntr`.
- **`989DSTRM.IRX`:** 7 libraries, 18 imports. 14 bound; the 3 `snd989` imports resolve through `989SND.IRX`'s
  exports; **1 returns zero**, the same `sifman` call. (One word inside `989SND`'s export table is zero in the file
  and carries a relocation, so the loaded table is not cut there; the fork's `registerLibraryEntries` stops at the
  first zero word, `kernel.cpp:178-183`.)
- **`LIBSD.IRX`:** 5 libraries, 19 imports, **19 bound**.

**What that means for SOCOM.** The game loads its banks by disc location (`snd_BankLoadByLoc`, research/40 §9's
table) and streams its music by location (`snd_PlayVAGStreamByLoc`), and 989snd's only ways to the disc are the
`cdvdman` and `ioman` imports, both unbound -- research/40 §9.3 item 2 already found the streamer blind on #244 for
want of one `cdvdman` form (the callback read). On #254's
kernel `sceCdRead` answers 0, which in `cdvdman`'s convention is a refused read -- and so do the other six:
`sceCdSync` answering 0 reads as "complete", `sceCdGetError` answering 0 as "no error", and an `ioman` open answering
0 is a valid descriptor. A loader that checks the sync or the error rather than the read's own return would carry on
over an unfilled buffer; one that retries would spin. Which of these 989snd does was not read (§7): what is read is
13 imports unbound and every disc read refused at the call. The fork does not need `cdvdman`
because Dragon Quest VIII's drivers do not (§3). **A `cdvdman` provider is the missing piece**, and it is ours to
write in any use of the fork's IOP: 7 calls read against our own disc path. What it cannot borrow is the console's
read timing: the provider's latency is ours, which is research/36's open question at the seam between stems.

The other half of the gap research/40 §9.3 item 2 named -- SPU DMA completion, which stopped bank loads past the
third on #244 -- **is closed in the fork**: its SPU2 raises the transfer-complete status bit LIBSD's handler waits on
(`spu2.cpp:483`) and its DMA channels 4 and 7 run with interrupts (`iop.h`, C2).

## 3. What the DQ8 fork does for sound

The PR body (C14): "The game's own sound modules (LIBSD, SDRDRV, the Standard Kit, PCMPLAY) running unmodified on a
small emulated IOP with both SPU2 cores", for Dragon Quest VIII, "with sound" at the field's 30 FPS cap on an M1 Pro.
**Of those four, SOCOM II loads one, LIBSD.** SDRDRV is on our disc but not in the game's load order (research/40 §7:
`USBD, USBKB, DEV9, LIBSD, 989SND, 989DSTRM, LGAUD, HEADSETO`); the Standard Kit and PCMPLAY are not ours. So the
fork's evidence -- a game with sound -- is evidence for its SPU2 and for LIBSD on its kernel, not for 989snd.

How it is wired (C2, C14): `NativeIop::load` reads a named module through the host's file calls and loads it on the
emulated IOP; `IopSubsystem::handleRpc` gives an RPC to a native server before any high-level service with the same
SID; the IOP heap and EE-to-IOP `sceSifSetDma` move to the emulated IOP's memory. `NativeIop::call` (`native_iop.cpp:150-156`)
**holds the EE until the IOP answers**: it settles the IOP, then waits in 20 ms slices on the audio callback's
progress, stepping the IOP silently in 480-frame steps when no device runs, and gives up after 2 s.
`NativeIop::render` runs the IOP for every output frame **inside the audio callback, under the lock the EE's call
takes** (`native_iop.cpp:190-200`). The output is a raylib `AudioStream` of 1,024 frames on raylib's device
(`ps2_native_iop.cpp:55-60`). **`PS2X_AUDIO_DUMP`** (`ps2_native_iop.cpp:25-31`) writes every frame the callback
produced as raw 48 kHz stereo s16 -- the same place our dump sits (KNOWN §2 L141: "the dump IS what the callback
handed miniaudio"), so it is the same instrument, not a new one.

## 4. The SPU2 cores and the clock, against our mixer and against #42 and #28

Proven parts are out (R285): the ADPCM decode is Proven on ours (KNOWN §1 L62) and the fork uses the same five filter
pairs (`spu2.cpp:11-13`); nothing contradicts the proof.

| Part | The fork (C12) | Ours (C11) | Console reference (C13) |
|---|---|---|---|
| Interpolation | 4-point Catmull-Rom (`spu2.cpp:210`) | linear (`snd989_mixer.cpp:1888-1889`) | PCSX2: a 4-tap table, the Gaussian (`Mixer.cpp:293-296`, `interpolate_table.h`) |
| ADSR | from the voice's ADSR registers, as documented (`spu2.cpp:220-275`) | from the documented ADSR (psx-spx, `snd989_mixer.cpp:198`) | neither compared with hardware; PCSX2 `pcsx2/SPU2/ADSR.cpp` |
| Reverb | both cores, half rate (`spu2.cpp:343-397`), driven by the registers LIBSD writes | none (0 lines) | PCSX2 `pcsx2/SPU2/Reverb.cpp` |
| The 240 Hz tick | the IRX's own hardware timer on IOP cycles: 768 cycles per 48 kHz stereo pair (`iop.h:39`), advanced only by `step()` (`iop.cpp:389-398`) | 200 output frames per tick (`snd989_mixer.cpp:532`, `:1856`) | -- |

**The SPU2.** On the one gap of the SPU2 row that has a number -- reverb, 0 lines while the game asks for type 3
and 18 AutoReverb ramps a mission (research/68's SPU2 row) -- the fork is ahead of us. On interpolation it is no
closer to the console than we are (Catmull-Rom is neither linear nor Gaussian). On the envelope both read the same
documentation. So adopting its SPU2 would move the SPU2 row from "our model, no oracle" to "their model, no oracle",
with reverb gained; its 5 test cases drive no IRX (research/67 §3).

**The clock against #28.** The two clocks are the same idea: both count the 240 Hz tick on frames the device asks
for. The difference is what else runs on it. In the fork every thread, timer and alarm of the real driver runs on
IOP time, so a stream's disc reads, its buffer turns and the poll's answer keep their order against the tick. In
ours the answers are computed inside the EE's call with no IOP clock (`RPC.cpp:558`), and the streamer reads on a
host worker at its own 10 ms cadence (KNOWN §1 L41). If #28 is the streamer's logic drifting over a long mission --
the re-fired stems of KNOWN §2 L142 -- the fork's clock with the disc's own streamer would show it; if it is the
read timing, the `cdvdman` provider of §2 is ours again and would not. **The link from either to #28 is a hypothesis**
(research/68's IOP host row); nothing measured points at it.

**The clock against #42.** It cannot settle it. #42's holes sit after the dump (KNOWN §2 L141: the six on the quiet
capture are in the endpoint and not in the dump, 0 late and 0 dry callbacks); the fork's clock changes what is
rendered before the dump. It adds a risk instead: the IOP interpreter runs inside the callback, whose worst render
today is 3.12 ms (KNOWN §2 L141), and the fork's device is raylib's default -- the class KNOWN §1 fixed with our own
20 ms x 4 device, 42 dropouts a minute down to 2. **The host mixer row gets no borrowed candidate**: its experiment
(research/68: a second recorder and an overflow count) is ours to build.

## 5. D1: does an LLE IOP running the disc's own IRX fit "audio native, the N64-recomp shape"?

The bar (`.claude/skills/loop-iteration/SKILL.md`, "The acceptance bar"): "game logic stays recompiled; renderer,
audio, input and network are native".

**Against.** An R3000A interpreter executing Sony's driver on every output frame is emulation inside a
recompilation, the opposite of "native". The peer the bar names does not do this: Zelda64Recomp **recompiles** its
audio microcode so the game's own sound code runs as host code (research/67 §4); it does not interpret it. The
interpreter would also carry emulation's costs into the product: the EE held on IOP time for any RPC that waits
(§3, up to 2 s, woken in 20 ms slices), an interpreter in the audio callback, and a second memory owner for SIF DMA.
And it retires a model with its evidence: `snd989.cpp` (1,802 lines) and the handler and stream half of
`snd989_mixer.cpp` (2,407 lines in all, C15), and the 70 cases of `socom2_audio_tests.cpp` written against it.

**For.** What would run is the game's own sound code, the unit the N64 shape keeps -- Zelda64Recomp keeps its audio
microcode and makes it native; our HLE replaced SOCOM's with an inference, which is why four of research/68's five
rows are Believed and one Untested. The host side stays native (the device, our mixer and dump if the glue is ours).
The fork's evidence that it works is one game with sound. And it is the only route to the console's streamer short
of decompiling `989DSTRM.IRX`: the reverb, the AutoVol schedule, the square law and the handle rules come with it
unmodelled, because they are the IRX's own. No recompiler change is involved (D2 does not apply).

**The cost against our HLE at the RPC boundary**, if it were the product: the glue REIMPLEMENTED on our side (50 of
#254's 120 files are changed here since the vendoring, research/67 §3), a `cdvdman` provider (§2), the output routed
through our own device, and every `989snd:` case of `socom2_audio_tests.cpp` re-expressed as an RPC-level test
against the IRX. Days, and a TAKE of 3,311 lines (R287 applies).

**What it would settle:** the streamer's inference (research/68 §4) and the RPC answers' order on an IOP clock; the
reverb; the unlanded AutoVol schedule (research/36 item 4). **What it would not:** #42 (after the dump); the disc
read timing (ours, via the provider); the SPU2's own accuracy (their model for ours, §4); and #28 unless its cause is
in the streamer's logic.

**The survey's answer:** as an **oracle** it fits and contradicts nothing -- the product stays HLE and the IRX
checks it, research/40's harness done with an SPU2 and a clock. As the **product** it is a detour from the shape
unless its end state is the IRX recompiled (no IOP recompiler exists here, and the fork's IOP is an interpreter). The survey does not
recommend it as the product today; it ranks the oracle first. The owner decides D1's trial (R282).

## 6. The shortlist

Ranked. The bars are research/68's: **the dip count 6 DEVICE dips, at most 2 in a minute**, on
`audio_out_20260925_074147`, and **audio parity 31/48**. A candidate that changes no runtime code leaves both
unchanged by construction; its validation is its own number, named. The IOP host row's and snd989's commands
reproduce from `docs/research/68-confidence-register.md` §0. No entry is a decision (R282).

| Rank | Register row | Path | Source (repo, path, licence file) | Validation, in our terms, with today's number | A trial's RED test |
|---|---|---|---|---|---|
| 1 | **The IOP host's audio path** | TAKE, out of the tree: #254's LLE IOP run as an oracle, not in the runtime; the host glue and a `cdvdman` provider ours. It also checks the streamer's inference (research/68 §4). **R287:** none of the 3,311 lines enters the tree (they stay in an out-of-tree clone, as #244 did for `docs/research/assets/40-irx-differential/CMakeLists.txt`), but the harness glue and the `cdvdman` provider would enter it as research assets, so whether R287's ruling is needed for a take of this size used as an oracle is **T0's question to ask before T1 is written** | `Sinan-Karakaya/PS2Recomp` at `e42efbe`, `ps2xIOP/src/lle/` (11 files, 3,311 lines), `LICENSE` (GPL-3.0, as ours); built from an out-of-tree clone as `docs/research/assets/40-irx-differential/CMakeLists.txt` builds #244 | The mission replay's oracle is blind today: **12,643 disagreements in 13,044 answers** (`grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_232655.md`), the emulator's own cascade; adopted as an oracle if the same replay on the fork's IOP with the provider reads within the menus' order, **19 in 1,794** (`grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_150258.md`), each remaining disagreement named. Then research/68's experiment: the EE frame each stem's poll first answers 0, IRX against ours, over one mission trace. The runtime is untouched: the dip count stays 6 (max 2), parity 31/48 | The harness's coverage check (§A's scan) on the patched kernel: `989SND.IRX` and `989DSTRM.IRX` with zero unbound imports -- 12 and 1 today (`python irx_cover.py scratch/lle/kernel.cpp game/disc/RUN/IRX/SOUND/989SND.IRX game/disc/RUN/IRX/LIBSD.IRX game/disc/RUN/IRX/SOUND/989SND.IRX`); then a replay case where `snd_BankLoadByLoc` answers a non-zero bank (0 on the unpatched kernel) |
| 2 | **snd989** | REIMPLEMENT: AutoVol in integer 7-bit steps on the IRX's schedule, the target against the play-time volume (research/36 Q5 and item 4, not landed) | The disc's own `989SND.IRX` as research/36 read it, cross-read with `Ziemas/989snd` `iop/autovol.c`, which has no licence file (C9: 404), so nothing is copied; the code is ours under our `LICENSE` (GPL-3.0). OpenGOAL (`open-goal/jak-project`, `LICENSE`, ISC) has no AutoVol and is no reference here | The game's 1.5 s fade lands in **254 ticks** on the IRX's schedule (research/36 Q5, a reading of the decomp: 127 steps x floor(360/127); not a console measurement) and **360** on ours; the case in `socom2_audio_tests.cpp` counts `grep -c 'tc.Run(' third_party/ps2recomp/ps2xTest/src/socom2_audio_tests.cpp` = 70 today and gains one; adopted if the dip count stays at or below **6** (max 2) by `python -m tools_py.parity.audio_dips logs/parity/<capture>/endpoint.wav --dump logs/parity/<capture>/mix.wav --log logs/<game log>` on a clean capture and parity is not below **31/48** by `python -m tools_py.parity.audio_parity compare scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json <run>/audio_scores.json`. Rank 1's oracle, if run, checks it by execution | A `socom2_audio_tests.cpp` case: an AutoVol to 0 over 360 ticks from 127 reaches 0 at tick 254 (127 steps of 1, one every 2 ticks) -- today the ramp lands at 360 |
| 3 | **The SPU2 model** | BORROW THE IDEA: reverb for the game's type-3 request and the 4-point Gaussian in place of linear interpolation -- only after the register's experiment sizes the reverb's share | PCSX2 `pcsx2/SPU2/Reverb.cpp` and `pcsx2/SPU2/interpolate_table.h` (`PCSX2/pcsx2`, `COPYING.GPLv3`, GPL-3.0+); #254's `ps2xIOP/src/lle/spu2.cpp` `mixReverb` as the smaller reading (`LICENSE`, GPL-3.0) | **0 lines of reverb** and **0 of Gaussian** in the mixer (`grep -c -i reverb third_party/ps2recomp/ps2xRuntime/src/lib/snd989_mixer.cpp`; `grep -c -i gauss` on the same file); the music-only pair with PCSX2's reverb on and off gives the share first (research/68's SPU2 row); adopted if audio parity rises above **31/48** (`python -m tools_py.parity.audio_parity compare scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json <run>/audio_scores.json`) and the dip count stays at or below 6 | A `socom2_audio_tests.cpp` case: a voice at a fractional pitch interpolates with the Gaussian's four weights, not two -- today the output is the linear blend; the reverb's case waits for the share |

**Why this order.** Rank 1 is the only entry that touches the two Believed-or-worse rows #28 could live in, and the
only way to test the streamer's inference without decompiling `989DSTRM.IRX`; it costs no runtime change, and its
lock-bound steps are the harness's standalone build. Its first day is a spike by the plan's T0 rule: does the
provider bring the replay into the menus' order. Rank 2 is small, test-first, a known divergence from the IRX as read (research/36),
and present at every fade the game makes. Rank 3 is a timbre question with no reported defect, gated on a measurement nobody has run.

**For O10 (R284, nothing filed):** a note to #254's author that a 989snd driver needs `cdvdman`'s read, sync and
callback forms from the LLE kernel is feedback, not an upstream bug: `docs/research/assets/63-upstream-drafts/NOT-UPSTREAM.md`
is its home, in words that carry no module ordinal (the controller's edit). The `OPEN-PRS.md` row for #254 ("no
verdict") can point here.

## 7. What this note does not do

No build, no run, no harness change, no KNOWN edit (nothing here moves a KNOWN row: every reading is a read of
source, not a measurement of the game). No re-read of the forks, the peers or the ten KEEP notes (research/67). The
VU1 half of #254 is LATER's (R289). Whether `sceCdRead` answering 0 stops 989snd cleanly or loops is not read; the
coverage count is the finding, the behaviour is the spike's to see.

## A. The import-coverage scan (C4)

Counts only: it prints libraries and numbers, never a byte, an ordinal or an address of the file. An import table
is the word `0x41e00000` with the library's name at +12 and `jr $ra; addiu $zero,$zero,<ordinal>` stubs from +20;
an export table is `0x41c00000` with its name at +12 (research/40 §10's method). The kernel's bindings are the
`{"library", ordinal, "handler"}` triples of `kernel.cpp`. Saved as `irx_cover.py` outside the tree:

```python
import re, struct, sys
from collections import defaultdict
def tables(d, magic):
    for m in re.finditer(re.escape(struct.pack("<I", magic)), d):
        if m.start() % 4 == 0:
            yield m.start(), d[m.start() + 12:m.start() + 20].split(b"\0")[0].decode()
def imports(d):
    out = defaultdict(set)
    for o, name in tables(d, 0x41E00000):
        p = o + 20
        while p + 8 <= len(d):
            a, b = struct.unpack_from("<II", d, p)
            if a != 0x03E00008 or b >> 16 != 0x2400:
                break
            out[name].add(b & 0xFFFF); p += 8
    return out
kernel, irx, exporters = sys.argv[1], sys.argv[2], sys.argv[3:]
bound = {(l, int(n)) for l, n in re.findall(r'\{"(\w+)",\s*(\d+),\s*"\w+"\}', open(kernel).read())}
exported = {n for e in exporters for _, n in tables(open(e, "rb").read(), 0x41C00000)}
imp = imports(open(irx, "rb").read())
print("kernel pairs %d; %d libraries, %d imports" % (len(bound), len(imp), sum(map(len, imp.values()))))
for lib in sorted(imp):
    n = len(imp[lib]); k = 0 if lib in exported else sum((lib, o) in bound for o in imp[lib])
    print("%-9s %3d kernel=%3d exported=%3d zero=%3d" % (lib, n, k, n if lib in exported else 0,
                                                         0 if lib in exported else n - k))
```
