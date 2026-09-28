# Sprint 16 -- what the tree has, per task (the readers' facts the plan's steps rest on)

Date: 2026-09-27. Read by six read-only readers at sprint-15's tip `6f57eb1e` (workflow `wf_416d1e4f-0ba`) and
moved here from the plan `docs/superpowers/plans/2026-09-27-sprint-16.md` to keep it under its ceiling; every
claim keeps its `path:line`. A task's implementer reads its section first; a fact found false is corrected here
with a `> Superseded by` blockquote (rule 11). Class S by location: a record of one moment, not a live state.

## Task F0: the baseline and the profile — one window of about an hour on a quiet host

**Measurement, today:** the last close gate `s14_close1` (2026-09-26 13:17) reads `FRAME mean=26.59 worst1s=33.33
n=2559`; the eight gates in `logs/parity/gate/*/summary.txt` read 22.72–32.99 ms (30.3–44.0 VBlanks/s, median
28.26); the three gates on one exe on a busy host spread 30 % (24.24 / 30.09 / 22.72, KNOWN §2's #59 row); the
`[pc-sampler]` rows of `s14_close1` give 369 ms/s of back-pressure wait (37 % of wall) and 14.2 idle sleeps/s over
the walk. No host profile of today's exe exists (every `logs/hostprof*.txt` is 2026-09-08/09); no `[gs-gl stats]`,
`[gs-upload]` or `[gs-transfer]` line from a mission exists (the gate's `env` pin carries no stats knob; the only
upload-trace logs are the 2026-09-19 login screen's).

## Task F5: the fence — #59's ceiling as a refusal

**Today:** nothing in the gate compares a frame number (`tools_py/parity/pins.py:43` `INFORMATIONAL = ("frame",)`;
`gate.py:1601–1614` reads the line and writes it as informational; `test_gate_frame_time.py:118–134` asserts a
differing time passes; `scripts/parity/pins.json` has no `frame` key — eleven sha256 pins, `card`, `env`, `mapping`).
The rule: three quiet gates on the sprint's final exe agreeing within about 10 % of their median (S13-R3, #59's bar)
give a ceiling — the median plus the measured spread — on `frame_mean_ms` and `frame_worst_ms`, keyed to this host.

## Task L2: #74 tooltips (in flight in the cloud, D14)

**What the tree had:** one global help table `kHelp` (`focus.cpp:308–363`) drawn where the FOCUS is (`Frame::band`,
`main.cpp:692–720`); `app.status` in the bottom bar (:641–647); `hovered()` instantaneous and false under
`--screenshot` (`widgets.cpp:277–284`); 31 CONTROLLER ids (`focus.cpp:195–242`), 9 with a help line; `focus.h:114–117`
records Sprint 9 P4's decision against hover help; `test_launcher_wording.py:143–148` greps `page_controller.cpp`'s
captions; `agent/launch-rev`'s crouch default (`ead36796`) is not in `main`.

## Task R1a: #70 the spike — recompile the decrypt routines, or port them? (half a day, Fable)

**The question:** which route makes the loader's decrypt native on the player's machine, at what cost in lines and
risk. **What the tree has:** `tools_py/disc_to_elf.py` runs the loader's own routines under Unicorn (473 s of 483);
`decrypt_apache.py:1–19` names the passes (`0x534830` init; per blob `0x539d00` the signed header, RSA/MD5 →
`0x539d50` the body, 3DES-like → `0x534848` the "unique" layer → `0x535018` → zlib), `:126–166` the SIF HLE,
`:226–234` the cdvd answers, `:260–309` the boot, `:311–353` the driver; `dnas_selfdecrypt.py:10–12` **ports no cipher
either** — the four core routines (`0x4ef348`, `0x52c330`, `0x53acb8`, `0x540938`) run under Unicorn, so the DNAS
stage is the same question (Task 0 Step 5 corrects the spec). The recompiler takes a MIPS ELF only
(`elf_parser.cpp:1138–1143`; `make_overlay_elf.py:47` wraps an overlay), emits `void f(uint8_t*, R5900Context*,
PS2Runtime*)` (`function_emitter.cpp:89`), and `ps2xShared` may not link `PS2Runtime` (`ps2xShared/CMakeLists.txt:1–4`)
— a recompiled helper lives in the runner (`socom2.exe --build-elf`) or carries a minimal context. The map and
decompilation: `game/analysis/DNAS.dec.bin.functions.txt` (1,980 rows) and `DNAS.dec.bin.decomp.c` (2.0 MB), main
tree only. The verification without disc bytes: `tools_py/disc_to_elf_expected.json`.

## Task R3a: the two archives under R295 (in flight in the cloud, D14) — re-scoped 2026-09-27 06:30Z

**What the tree has:** "the debugger and the probe binaries" are not files — `make_portable.sh:146–151` copies three
binaries and the closure, and `--release` is a folder suffix (`:23`); R295's words (`docs/PLAYTEST.md:138`) name the
imgui debug UI, the CMake option `PS2X_ENABLE_DEBUG_UI` (`ps2xRuntime/CMakeLists.txt:18`, default ON) that
`build.sh`'s `release()` never turns off, and the dump/trace probes compiled in beside it. So the split is **two
release configurations** — a player exe with both off, a developer exe with both on — and the gate scores what ships
(R148, R151). Everything downstream assumes one archive (`write_manifest`, `playtest_block.py:48–55`, the template's
line 11, `test_portable_folder.py:14–19`, `test_make_portable.py:92–97`); the verify half already loops over every
attached zip. Today's archive is 67,725,996 bytes (6 DLLs, FFmpeg 7.1.5), 11 MB above every recorded number,
unrecorded in KNOWN.

## Task R4: the first archives against a draft (D1) — the close

**What the tree has:** a `v*` tag creates the draft with the checklist (`release-draft.yml:28–72`); the verify half is
`gh workflow run release-draft.yml -f tag=<tag>` (`:74–133`: downloads the assets, `portable_audit.py verify assets`,
per-zip audit, leak check and notices, appends the verdict with `gh release edit --draft`); the five drafts
v0.10.0–v0.14.0 have 0 assets; the merged chain gates `dist/socom2.exe` before it builds the release
(`merged_chain.sh:161, 171–172`), so **the exe inside the archive has not been gated since 2026-09-21**
(`s10_playtest2_gate` 3/3 on that archive's exe, `docs/PLAYTEST.md`; `s9_g2_release_gate` on `dist-release/socom2.exe`) —
the checklist's line 9 needs one more gate (`SOCOM_EXE=dist-release/portable/socom2/socom2.exe`, the name must stay `socom2.exe`,
`hostplatform.py:52–59`; about 17 minutes). The Linux tarball the template's line 11 names is built only in the VM
(rule 7 keeps it off): the line is amended to "Windows this release" unless a task turns the VM on.

## Task R5: #69's closing run, and `agent/launch-rev`'s merge

**State:** `agent/launch-rev` at `bca0d0d1` (five commits: the launcher starts the chosen revision's pair, the O4
report line, the runtime and preflight key on the revision table, the crouch knob's `l3` default, the IOP profile /
title / exit-68 sentence) is on no PR and not on `main`; #69's comment of 2026-09-26 21:35Z carries the review
trail (two PASS WITH FINDINGS, one FAIL fixed by the fifth commit, the fifth briefed). Its exit-68 rewrite and
`GameRevision::elfName` are what R1b and R2 build on: **R5's merge comes before R1b's branch.**

## Task X2: the naming future task (R296) — the matcher across the Aug 28 2003 beta

**What the tree has:** the beta under `game/beta_scus_973_66/` (1.3 GB; the ELF built by the capsule tooling, zero
repairs) with **no function map**; the matcher (`tools_py/address_matcher.py:532–538`) needs a Ghidra table for both
images — `scripts/ghidra_export_functions.sh <elf> <out.csv>` (three headless passes, the EE extension present), then
the r0004 recipe of `tools_py/addresses_from_match.py:7–14`; research/58 expects zero new names from an unnamed beta.
The 148 are the `FixedPoints = start..end` rows of `game/demo_symbol_renames_7c.csv` (research/60); the five routines
with addresses are in `docs/archive/HUMAN_TASKS-to-2026-09-25.md:172`.

## Task X4: #41 the menu-frame fixture — one PCSX2 run (to LATER unless a PCSX2 window coincides)

**What the tree has:** `gsdump_capture.py:83` loads a savestate unconditionally and `tools/pcsx2/sstates` is empty;
the console-replay case finds one fixture directory (`ps2_gs_tests.cpp:1594–1597`, fbp `:1639`); the recorded RED is
a flat-grey `reference.ppm` at 94.99 against the bar 16.0; the cold boot reaches the main menu at step 8 of
`launch_to_mission.txt`; `pine.py:69` saves a state.

## Task X5: Dependabot #10 rebased and merged (R294)

**What the packaging reader found:** PR #10 (`actions/cache` 4.3.0 → 6.1.0, one line in `windows.yml:95`) is
MERGEABLE but BLOCKED by `leakcheck`, which fails on the history leg's hit `web/README.md:259` (the git SSH
remote's address on `feat/web-map-viewer`, scanned because the job fetches every branch; the allow row's reason
says it is a hostname in a documented command); the allow row `leak_allow.txt:109`
(`5fcbb0c0`, PR #76) landed at 20:23Z, forty minutes after the branch's last rebase (19:42Z). A fresh rebase turns
it green; `main`'s own `secrets` runs are green.
