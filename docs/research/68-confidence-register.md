# 68. The audio confidence register: the five audio rows, today's dip count, the experiment per row

Date: 2026-09-26 (the reads 16:58Z-17:23Z by `date -u`). Sprint 15 Task R1 (plan
`docs/superpowers/plans/2026-09-26-sprint-15.md`, spec `docs/superpowers/specs/2026-09-26-sprint-15-borrowed-confidence-design.md`
§1.1, §1.2, §1.4, §2 Milestone R). Lock-free: nothing was built or run; the recordings were read under the main tree's
`logs/` (and one archived run under `D:/socom_archive/parity/`), and only counts and commands leave them.
**The non-audio rows of the spec's walk list are not here: every non-audio subsystem is a row in `docs/LATER.md`
with its confidence and trigger (Sprint 15 D8, R289).** KNOWN wins on any disagreement; where this note reads a
number differently from a KNOWN row, §3 says so with the evidence and KNOWN is not edited here.

> **State at last commit** (R1, 2026-09-26 17:23Z; later tasks update this block, not the tables below):
> - **The no-regression dip count: 6 DEVICE dips, at most 2 in any minute**, on the quiet-endpoint capture
>   `logs/parity/audio_out_20260925_074147` (`sessions_verdict.txt` = clean), by
>   `python -m tools_py.parity.audio_dips logs/parity/audio_out_20260925_074147/endpoint.wav --dump logs/parity/audio_out_20260925_074147/mix.wav --log logs/run_20260925_050653.log`
>   -- per minute `2 2 0 0 2 0 0 0 0 0 0 0 0 0 0 0` (16 endpoint minutes; the game's own callbacks cover 735 s).
>   KNOWN §2's #42 row said 6: confirmed, not replaced. A trial's capture must be clean and read at or below 6 in
>   total and 2 in a minute.
> - **Audio parity: 31/48** windows, re-scored today from the saved run by
>   `python -m tools_py.parity.audio_parity compare scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json D:/socom_archive/parity/s9_q1_parity_ours2/audio_scores.json`
>   (the run KNOWN §1 L40 cites as `s9_q1_parity_ours2`, archived from `logs/parity/`).
> - **Confidence today:** host mixer Believed, snd989 Believed, lgaud Believed, the IOP host's audio path Believed (was
>   Untested; moved 2026-09-26 by T1's oracle replay, research/70), the SPU2 model Believed. No row is Proven as a whole; none is a Hazard.
> - **Open for X1:** the two rows #254's LLE IOP would touch -- the IOP host's audio path and snd989 -- and the SPU2
>   row's reverb.

**How to read the numbers.** Every number names its command, `[C1]` to `[C10]` in §0, run on `agent/s15-r1` at
`29d8173c` (off `sprint-15`). A path under `logs/` is the main tree's (`C:/Projects/socom_pc/logs/`), read-only.
A KNOWN row is cited by section and line of `docs/KNOWN.md` at `29d8173c` (`KNOWN §2 L141` is line 141, in §2).
File paths in the tables are under `third_party/ps2recomp/`.

## 0. The commands

| Id | Command |
|---|---|
| C1 | `git log --oneline 8736759..HEAD -- third_party/ps2recomp/<file> \| wc -l` per file (8736759 is the vendor commit of upstream `14b1e5c`); for the whole tree, `git log --oneline 8736759..HEAD -- third_party/ps2recomp \| wc -l` = 438 |
| C2 | `python -m tools_py.parity.audio_dips <capture>/endpoint.wav --dump <capture>/mix.wav --log <game.log>` per capture (§2's table names each pair) |
| C3 | `python -m tools_py.parity.cb_trace logs/parity/audio_out_20260925_074147/cb_trace.csv --dips <C2's report for that capture>` |
| C4 | `python -m tools_py.parity.audio_parity compare scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json D:/socom_archive/parity/s9_q1_parity_ours2/audio_scores.json` |
| C5 | `grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_150258.md` (and the same for `results_run_20260922_232655.md`) |
| C6 | `grep -c 'tc.Run(' third_party/ps2recomp/ps2xTest/src/<file>` -- the cases per test file |
| C7 | `grep -c -i reverb third_party/ps2recomp/ps2xRuntime/src/lib/snd989_mixer.cpp`, and `grep -c -i gauss` on the same file |
| C8 | `grep -E "snd_SetReverbType\|snd_AutoReverb" docs/research/assets/40-irx-differential/results_run_20260922_232655.md` |
| C9 | `cat logs/parity/audio_out_20260925_074147/loopback.log` -- the recorder's own frame count and clock |
| C10 | `python -m unittest tools_py.tests.test_audio_dips` -- the counter's planted cases: 21 run, OK, 1 skipped (the run-10 case needs `logs/parity/s10_r4k_music_ours`, absent from a worktree) |

A game log is paired with its capture by one fact, read today for all eight: the log's `mix stream open` line
names that capture's own `mix.wav` as its dump (and the endpoint it rendered to). `scripts/parity/mission_music_long.sh` picks the
newest `logs/run_*.log` at scoring time; the pairing here names the log instead.

## 1. The register

| Subsystem and files (commits since the base, C1) | Confidence | Today's number | Gap: what would make ours wrong, what the player hears | The experiment that settles it | Issue |
|---|---|---|---|---|---|
| **The host mixer**: `ps2xRuntime/src/lib/ps2_audio.cpp` (17; upstream's, rewritten), `ps2xRuntime/include/runtime/ps2_audio.h` (6), `mix_device.h` (1, ours), `audio_cb_trace.h` (3, ours), `audio_volume.h` (1, ours) -- the device callback, the gain and the dump | **Believed** -- KNOWN §2 L141 (#42: the device thread cleared on one clean capture, the dips unattributed); KNOWN §1 L28 (the dips are ours, not the endpoint's); KNOWN §1 L42 (our own device at 20 ms x 4); tests `audio_cb_trace_tests.cpp` (6 cases, C6) | **6 DEVICE dips**, max 2 in a minute, all six 0.05 s (one hop of the counter), all in the first 257 s: `python -m tools_py.parity.audio_dips logs/parity/audio_out_20260925_074147/endpoint.wav --dump logs/parity/audio_out_20260925_074147/mix.wav --log logs/run_20260925_050653.log`; 36,756 callbacks, 0 late, 0 dry, max gap 21.5 ms, the six dips cleared: `python -m tools_py.parity.cb_trace logs/parity/audio_out_20260925_074147/cb_trace.csv --dips <that report>` | The dump IS what the callback handed miniaudio (KNOWN §2 L141), so a real hole sits after it: miniaudio's engine, or Windows' mixer and resampler (the JBL endpoint runs at 44.1 kHz, the mix at 48 kHz) -- or there is no hole, and the instrument (the recorder's overflow, the scorer's local alignment) made it. The player hears 50 ms holes in the briefing music | The instrument first, under a planted case: a second, independent recorder and an overflow count, neither of which exists -- `tools_py/parity/loopback_record.py:62` reads with `exception_on_overflow=False` and keeps no count (today's C9 reading, 41,761,792 frames for a 947 s request, shows no net shortfall and cannot rule out an overflow). Then two recorders on one quiet capture: a dip in both is the audio's, a dip in one is the instrument's; and the endpoint set to 48 kHz once, to take the resampler out. This is the #42 row T0 picks from | #42 |
| **snd989**, the 989snd model at the RPC boundary: `ps2xIOP/src/modules/snd989.cpp` (19, ours), `ps2xRuntime/src/lib/snd989_mixer.cpp` (18, ours: its handler, grain, stream and volume half), `ps2xRuntime/include/runtime/snd989_mixer.h` (13) | **Believed** -- KNOWN §1 L27 (the disc's real IRX agrees on 1,775 of 1,794 answers, R245), KNOWN §1 L36 (the decompilation audit, `docs/research/36-989snd-decomp-audit.md`), KNOWN §1 L63 (AutoVol), KNOWN §2 L142 (#28, cause unknown); tests `socom2_audio_tests.cpp` (70 cases, C6) | **19 disagreements in 1,794 answers** on the menus (`grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_150258.md`); **31/48** audio parity windows (`python -m tools_py.parity.audio_parity compare scripts/parity/refs/audio_launch_to_mission_xl.pcsx2.json D:/socom_archive/parity/s9_q1_parity_ours2/audio_scores.json`) | The agreement covers the non-stream, non-transfer half of the API; the streamer is inferred (§4). Ours is wrong if the EE's music manager sees a different world over a long mission -- a poll answering late or early, a fade's shape (research/36 item 4, the integer 7-bit steps, is not landed: `tickVolRamps` interpolates in doubles), a stem re-fired from the same sector (KNOWN §2 L142: `1032ea+1920` seven times). The player hears the mission music "not playing linearly", worse with time | #28's own settle (KNOWN §2 L142): a drive that reaches gameplay fast, then one capture of 10+ minutes in the mission, scored minute by minute against PCSX2 on the same mission -- which needs a per-minute scorer built first under a planted case (the plan's V1); the stem re-fires counted in both logs | #28 |
| **lgaud**, the headset module: `ps2xIOP/src/modules/lgaud.cpp` (7, ours) | **Believed** -- KNOWN §2 L157 (the headset path, as far as it is proven; no pad button talks); tests `socom2_lgaud_tests.cpp` (12 cases, C6) | **12 cases**, `grep -c 'tc.Run(' third_party/ps2recomp/ps2xTest/src/socom2_lgaud_tests.cpp`; **0** gate stages reach it (`grep -c -i lgaud tools_py/parity/gate.py` = 0; the game opens the headset only in an online game session) | Voice, not music: nothing of #42 or #28 passes through it. Ours is wrong where the module's status word, device block or mixer answers differ from the real module's -- and the game does not send your voice today (KNOWN §2 L157), so what a player hears is no voice from the other player | The talk routes' other conditions read in a live round (R221's peek, KNOWN §2 L157's tail) and BACKLOG's `voice-hear-the-other-player` bar (Task 4's round re-run, the number not falling). Not an audio-trial candidate this sprint | none (BACKLOG's `voice-*` rows: no issue) |
| **The IOP host's audio path**: `ps2xRuntime/src/lib/ps2_iop_host.cpp` (7), `ps2xRuntime/src/lib/ps2_iop_host.h` (6), `ps2xIOP/include/ps2x/iop/iop_host.h` (6), `ps2xRuntime/src/lib/Kernel/Syscalls/RPC.cpp` (2) -- upstream's, extended with the audio calls | **Believed** since 2026-09-26 (was Untested): the disc's own 989SND.IRX on #254's LLE IOP with our provider agrees on 12,212 of the mission replay's 13,044 answers and 1,777 of the menus' 1,794 -- every bank load, stream start and sound play (research/70 §9; the artefacts landed under `docs/research/assets/70-lle-oracle/` in T1c: the result tables, the harness, the patch, the replay driver and a README to rebuild from a clone); not against the console -- unit tests: `ps2_sif_rpc_tests.cpp` (7 cases), `ps2_iop_tests.cpp` (7), `socom2_msifrpc_tests.cpp` (6), the `PS2AudioBackend` cases of `socom2_audio_tests.cpp`; one behaviour Proven, KNOWN §1 L74 (`sceSifInitRpc` no longer resets the model) | At mission scale on the LLE oracle: **832 disagreements in 13,044 answers** (research/70 §9: `grep -m1 "Compared answers" docs/research/assets/70-lle-oracle/results_lle_run_20260922_232655.md`), 815 of them stream lifetimes on the replay's clock, at least 655 of the 699 polls the clock's own (research/70 §9.4); on #244's blind oracle it was 12,643 (`grep -m1 "Compared answers" docs/research/assets/40-irx-differential/results_run_20260922_232655.md`) | Every RPC is served inside the EE's call (`RPC.cpp:558`, `PS2IopTransport::handleRpc`), with no IOP clock; the library's 240 Hz tick is counted on the mixer's output frames (`snd989_mixer.cpp:532`), not on an IOP thread. Ours is wrong if the game's music manager depends on an RPC's latency or on the tick's phase against the EE frame. What the player would hear is #28's drift; that link is a hypothesis, and nothing measured points at it | the frame-stamped replay on the LLE oracle (research/70 §7): a one-frame-per-call replay leaves RPC latency and the tick's phase untested; the run log's `[audio] 989snd stream <h> start|done frame=N` lines give the game's frames and the harness's `tick` takes any cycle count, so the oracle can run on the game's clock and the frame at which each stem's poll first answers 0 be compared with ours | #28 (a candidate); not #42 |
| **The SPU2 model**: the voice half of `ps2xRuntime/src/lib/snd989_mixer.cpp` (ADPCM decode, ADSR, pitch, interpolation), `ps2xRuntime/src/lib/ps2_audio_vag.cpp` (1), `ps2xRuntime/include/runtime/ps2_vag.h` (1, ours); `ps2xIOP/src/modules/libsd.cpp` (0: untouched) | **Believed** -- the decode is Proven (KNOWN §1 L62: cues sample-exact against the disc; KNOWN §1 L34: the stereo interleave); the envelope, the interpolation and the missing reverb have no oracle; tests `socom2_audio_tests.cpp` (the `decodeBlocks`, `note2Pitch` and pan cases) | **0 lines of reverb** in the mixer (`grep -c -i reverb third_party/ps2recomp/ps2xRuntime/src/lib/snd989_mixer.cpp`) while the game asks for it -- in one mission `snd_SetReverbType` once (type 3) and `snd_AutoReverb` 18 times, 17 of them fading the depth to 0 and one, at the mission start (log line 7225), ramping it to 0x8f5 (`grep -E "snd_SetReverbType\|snd_AutoReverb" docs/research/assets/40-irx-differential/results_run_20260922_232655.md`); **0 lines of Gaussian interpolation** (`grep -c -i gauss` on the same file: voices interpolate linearly) | Ours is wrong in timbre: dry where the console adds reverb, linear interpolation where the SPU's is a 4-point Gaussian (psx-spx), an envelope from the documented ADSR never compared with the hardware. The player would hear a drier, brighter mix. Not the holes (#42 sits after the dump) and not time-dependent (#28) | The music-only capture pair (SOUND and DIALOG at zero, as in KNOWN §1 L36) with PCSX2's reverb on and then off, to size the reverb's share of the level and spectrum difference before any change; no trial before a listener names it | none |

## 2. The dip count over the existing mission recordings (Step 2)

The instrument first (C10): 21 planted cases, OK. Then C2 over every mission capture under `logs/parity/` that has
both an endpoint recording and a dump. "Saved" is the `DEVICE total` line of the capture's own `dips.txt` (or
`dips_rescored.txt`) from the day it was taken; "today" is C2 on the scorer at `29d8173c`.

| Capture | Game log | Endpoint | Align (corr) | DEVICE per minute, today | Today | Saved |
|---|---|---|---|---|---|---|
| `audio_out_20260925_074147` (clean) | `run_20260925_050653.log` | JBL Flip 6 | 13.61 s (0.99) | `2 2 0 0 2 0 0 0 0 0 0 0 0 0 0 0` | **6 / 16 min** | 6 |
| `endpoint_ab_20260922_232644_wired` | `run_20260922_232655.log` | HyperX QuadCast S | 5.98 s (0.99) | `5 1 0 1 3 0 0 0 0 0 0 0 0 0 0 0` | 10 / 16 (+4 NODUMP) | 14 |
| `mission_music_ours_20260922_024457` (the A/B's Bluetooth half) | `run_20260922_024501.log` | JBL Flip 6 (the log's line) | 2.72 s (0.99) | `1 3 2 4 0 0 0 0 0 1 0 0 0 0 0 0` | 11 / 16 | 11 (rescored) |
| `endpoint_ab_20260922_222223_wired` | `run_20260922_222228.log` | JBL Flip 6 | 3.34 s (0.99) | `0 4 0 0 1 0 0 0 0 0 0 0 0 0 0 0` | 5 / 16 (+2 NODUMP) | 7 |
| `mission_music_ours_20260922_224425` (W7's walk) | `run_20260922_224428.log` | JBL Flip 6 | 2.70 s (0.99) | `2 2 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0` | 5 / 21 (+42 NODUMP) | 47 |
| `mission_music_ours_20260922_023524` | `run_20260922_023527.log` | JBL Flip 6 (the log's line) | 2.55 s (0.99) | `0 1 0 0 0 0 0 0` | 1 / 8 | none saved |
| `audio_out_20260923_065836` (void: a browser on the endpoint) | `run_20260923_040614.log` | HyperX QuadCast S | 5.17 s (0.31) | `29 1 0 2 17 64 10 0 3 13 0 0 0 0 0 0` | 139 / 16 (+423 NODUMP) | 562 |
| `audio_out_20260923_134217` (CONTAMINATED) | `run_20260923_104323.log` | HyperX QuadCast S | 3.56 s (0.47) | `22 0 0 12 0 0 0 0` | 34 / 8 | 34 |

The command for any row: `python -m tools_py.parity.audio_dips logs/parity/<capture>/endpoint.wav --dump logs/parity/<capture>/mix.wav --log logs/<game log>`.
The two `audio_out_20260923_*` captures are not device measurements (`docs/HAZARDS.md` audio: another session on
the endpoint; the envelope correlation 0.31 and 0.47 against 0.99 everywhere else). The number the sprint uses is
the first row's: the only capture with a `clean` session verdict.

## 3. What today's numbers say against KNOWN

- **The quiet capture's 6 is confirmed** (KNOWN §2 L141): the same total, the same per-minute row, and C3 clears all
  six against the callback trace (0 late, 0 dry). Two readings the row does not carry: all six dips are exactly one
  hop of the counter (0.05 s, `DEFAULT_HOP_S` in `tools_py/parity/audio_dips.py`), so their true length below 50 ms
  is not known; and the game's callbacks cover 735 s of the 16 endpoint minutes (C3's first line), so "6 over 16
  minutes" is 6 over about twelve minutes of game, all six in the first 257 s.
- **The endpoint A/B's wired 14 reads 10 today.** Three KNOWN rows carry the 14: §1 L28 ("wired 14 DEVICE dips
  against Bluetooth 11"), §1 L42 ("wired 14 against Bluetooth 11") and §2 L141 ("(14 against 11)", "11-14 before",
  "back near 14"). The four it loses are NODUMP rows, dips past the dump's end, which the scorer counted as DEVICE
  until the audio-out fix round of 2026-09-23 (`9d9da69e`; `docs/HAZARDS.md` audio: "a dip past the dump's end is
  `NODUMP`, never DEVICE"). The A/B's conclusion stands on today's scorer -- the dips survive the wired endpoint, 10
  against 11 -- but its number moved; the three rows are the controller's to amend at the merge. W7's 47 (the same row's tail) reads 5 DEVICE
  and 42 NODUMP today for the same reason.
- **31/48 is reproduced** from the saved scores (C4), not re-captured: it is the Sprint 9 build's number, the only
  audio parity run on record, and a trial's capture is scored against the same reference.

## 4. The RPC model against research/36, and the streamer's inference

**The RPC model.** research/36 (2026-09-20) audited `snd989.cpp` against Ziemas' decompilation of 989snd v3.01 and
the disc's own IRX. Of its diff list, items 1-3 landed with tests (KNOWN §1 L36: `378a87b` the played-out answer and
the slot, `1f6f7be` SetSoundParams on a live stream, `554972e` the square-law group stage); the handle's bit 31 and
`snd_CallExtension` answering 0 landed with R245 (research/40 §9.3 items 1 and 3; `socom2_audio_tests.cpp`: "every
handle the model issues carries bit 31"). **Not landed: item 4** -- the console's AutoVol steps in integer 7-bit
units and finishes early (a 360-tick fade from 127 lands in 254 ticks); ours interpolates linearly in doubles
(`snd989_mixer.cpp`, `tickVolRamps`); every game fade targets 0, which is why research/36 ranked it under the square
law. Item 5's queue semantics are moot for SOCOM by research/36's own reading, and item 6 (a stop lagging a few
ticks) is unmodelled by choice. research/36 item 7 corrects research/32:95: the 240 Hz tick is read from `init.c`,
not inferred -- the spec's §1.4 "the 240 Hz tick inferred" is the older reading. What stays inferred at the RPC
boundary is its **timing**: the model answers inside the EE's call with no IOP clock (§1, the IOP host row), and the
real IRX's answers were compared by value, never by when.

**The streamer's inference.** `stream.c` is signatures only in v3.01 (research/36, "Caveats": `PlayVAGStreamByLocEx`,
`ProcessVAGStreamTick`, `CheckVAGStreamProgress` are all `UNIMPLEMENTED()`), and `989DSTRM.IRX` is not decompiled.
Our streamer -- the VPK reader, the per-buffer interleave, the ring, the queued-stem chaining, the played-out answer
-- rests on four things: (1) the disc IRX's disassembly (research/36 Q1: `FUN_0001107c`, `FUN_000113c8`, the
handler's queued pointer at +0x44); (2) the disc's data layout, measured (KNOWN §1 L34: the 0xb000-byte streaming
buffer's interleave); (3) the decoded output, measured sample-exact against the disc's cues (KNOWN §1 L62); (4) the
EE's view, pinned by the `989snd:` cases of `socom2_audio_tests.cpp`. What it does not rest on is any timing: our
reads happen on a host worker at its own 10 ms cadence straight from the disc image (KNOWN §1 L41), not through the
IOP's CD scheduling, so the seam between stems and the prebuffer are ours; research/36 "What could not be
determined" names the disc-read latency at the seam as unknown; and the differential is blind to the streamer at
mission scale (research/40 §9.3 item 2: every stream's first CD read fails on #244). #28's stems re-firing from
identical sector offsets (KNOWN §2 L142) sit exactly in this unverified half.

## 5. What this note does not do

No capture, build or game run; no KNOWN edit (the §3 readings are the controller's to carry); no non-audio row
(`docs/LATER.md`); no survey of the borrowed answers (Task X1, from this register's non-Proven rows). The
experiment column names what would settle each row; which one is tried is T0's, from X1's shortlist.
