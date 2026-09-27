# Later -- the register of candidate work, by value, size and confidence

Started 2026-09-26 at the owner's direction: order the candidates by value and time, aim at the highest value, and
dismiss outright what we are confident about. **One home per item.** This file holds *candidates* -- work nobody has
committed to. `docs/BACKLOG.md` (generated) holds the open issues and the rows ruled not an issue; the plans under
`docs/superpowers/plans/` hold committed tasks (the open plan, and a proposed one such as Sprint 15's). An item is in
exactly one of the three: a row here points at an issue by number and adds only its value, size and confidence --
the bar is the issue's. The owner's own rows (decisions and hands) are `docs/HUMAN_TASKS.md` and are not candidates.
Research/67 section 5's watch rows are Sprint 15 X1's input and are not repeated. KNOWN wins on any disagreement.

**Columns.** Value: to a player or to the owner. Size: S under a loop day, M one to three, L more. Confidence today:
Proven / Believed / unknown, from `docs/KNOWN.md` (§1 Proven, §2 Believed) or the gap. Trigger: what promotes the row
to an issue with a bar or to a sprint task. **Order:** value, then size; the first five follow the controller's read
of the owner's order (2026-09-26) -- *the controller's read, the owner may strike it*.

| # | Item | Value | Size | Confidence today | Trigger | Source |
|---|---|---|---|---|---|---|
| 1 | The audio pair: #42 (50 ms holes) and #28 (music degrades in a mission) | high: heard in every mission | M | Believed: KNOWN §2 rows #42 (one of three candidates eliminated) and #28 (cause unknown) | Sprint 15 T0 writes the audio trial (its D7) | issues; Sprint 15 spec §1.4 |
| 2 | #67 the window drag freezes the game | high: any player who moves the window | S | Proven mechanism (KNOWN §1 row, the modal move loop); fix untried | the next render slot; the issue's bar | issue |
| 3 | #59 a bar for the mission frame rate | medium: a fence on frame pacing | S | Believed: KNOWN §2, a 30 % spread over three gates on one exe (host not quiet) | three quiet-host gates agree (S13-R3) | issue |
| 4 | #32 the menu atlas re-upload | medium: menu smoothness | S-M | Believed: KNOWN §2, the V2 skip moved `upload=` about 4 %; batching untried | the per-upload breakdown the issue asks for | issue |
| 5 | VU1: four programs on the interpreter, the stalls the native path skips, no oracle for the interpreter | medium, to the owner (named second); no visible defect | L | Believed: native checked against the interpreter by `vu1_replay`; interpreter against hardware unknown | Sprint 15 R2's replay coverage and X2/X3 put it on the shortlist; or a flicker on one model family | Sprint 15 spec §1.4 |
| 6 | #34 the online freeze with a paused console peer | medium: mixed-match players | S | Believed: KNOWN §2; the V7 bound untested against a pause | a mixed-match window at a quiet hour | issue |
| 7 | #26 where the received chat line really enters the client | medium, to the owner | M | Believed: KNOWN §2, the wrap never fired in two rounds | carried twice: `docs/HUMAN_TASKS.md` O16 | issue |
| 8 | The 989snd HLE model and the inferred streamer | low apart from the audio pair | M | Believed: the real IRX agrees on 1,775 of 1,794 calls (R245); 989DSTRM not decompiled | the audio trial lands on the model | Sprint 15 spec §1.2 |
| 9 | SIF/RPC and the IOP host | low: online and audio run through it every gate | M | unknown past `ps2_sif_rpc_tests.cpp`; no oracle | Sprint 15 X2's read of #254's LLE IOP | Sprint 15 spec §1.1 |
| 10 | The EE scheduler and timers | low: no defect beyond #59 and #67 | M | unknown: no console timing oracle; interrupt unit tests only | #59's bar fires on a regression | Sprint 15 spec §1.1 |
| 11 | The FPU translator: plain IEEE, no PS2 clamping | low: no defect seen | M | unknown: no oracle | a numeric defect that points at it (R265's bar) | Sprint 15 spec §1.1 |
| 12 | VU0 macro path: the FTOI NaN rule; #47 the flag latency | low: no defect seen | M | Believed: KNOWN §2 FTOI row (the fork's rule); #47 open | Sprint 15 X3 finds PCSX2's rule differs | issue #47; spec §1.4 |
| 13 | VIF1, the GIF arbiter, the DMAC | low: no defect seen | M | unknown against a console: the gate runs them every frame, pinned to our own captures | a render defect bisected to a transfer | Sprint 15 spec §1.1 |
| 14 | #60 a stub's table slot holds another owner's resume entry | low: no effect seen | M | Believed: the issue's reading of `register_functions.cpp` | a login or SIF defect at the three addresses | issue |
| 15 | Jump-table recovery in the recompiler | low: every gate green | M | unknown: no census of tables found against missed | a crash in a switch the scan split | Sprint 15 spec §1.1 |
| 16 | #54 the nested rows in the r0001 map | low: names, analysis | M | Believed: KNOWN §2 | a recomp is due anyway | issue |
| 17 | #55 map bounds lose to carvings | low: names, analysis | L | Believed: KNOWN §2; moves every pin | Sprint 15 D2's ruling | issue |
| 18 | A claim check for documents: claims about the tree, not only paths | low-medium, to the owner | M | unknown | a close review finds a wrong claim check 6 cannot see | `docs/ROADMAP.md` §5 |
| 19 | #57 the r0004 leg of the header change | low: build time | S | Proven on r0001 (KNOWN §2 row, merged `b3dae300`) | the next r0004 gate | issue |
| 20 | #52 counterexamples for the matcher | low: r0004 only | S-M | Believed: KNOWN §2 | an r0004 defect traced to a placement | issue |
| 21 | #58 BinExport on Ghidra 12.1.3 | low: one toolchain | S-M | Believed: KNOWN §2 | the next naming pass | issue |
| 22 | #25 the VM's suites | low | S-M | Believed: KNOWN §2 | carried twice: HUMAN_TASKS O16 | issue |
| 23 | #41 a menu-frame console-replay fixture | low | S | Believed: the gameplay frame only | a menu render change | issue |
| 24 | `disc_to_elf.sh` on Linux from an ISO | low: a Linux stranger | S | Believed: KNOWN §2 (Windows only, one disc) | a quiet window with the VM | KNOWN §2 |
| 25 | A live bug report sent from Linux | low | S | Believed: KNOWN §2 (CI loopback only) | a VM filler run | KNOWN §2 |
| 26 | The stale `dist-release/` in the VM guest | low | S | unknown: KNOWN §2 | the first release tarball cut in the VM | KNOWN §2 |
| 27 | The Windows-only tools after the Linux port | low: developers | M | Proven list: KNOWN §2 | a Linux developer asks | KNOWN §2 |
| 28 | llvm-mingw 20260922 | low | S | unknown: the exe hash changes | a sprint open, with a gate | research/63 §2 |
| 29 | PCSX2 2.8.2 as the reference | low; moves the goldens | M | unknown | a stable release touching the software renderer, SPU2, PINE or DEV9 | research/63 §2 |
| 30 | Ghidra 12.1.4 | low | S | unknown | an EE-extension release for it | research/63 §2 |
| 31 | Horizon PR #35 | low | S | unknown | the DEV9 error 107 seen in a run | research/63 §2 |
| 32 | Upstream's paraLLEl-GS default (`feature/performance-patch-1`) | unknown | L | unknown | the branch merges to upstream `main` | research/67 §6 item 2 |
| 33 | Rebuild the canonical r0004 image from PSRewired's served package with `build_revision` (a real `disc_r0004` tree holding the served ZDB, not the junctioned one -- the #56 trap), retiring the `0x1E70CC` pnach remnant and the overlay repair for that image | high to the owner: the r0004 path becomes fetch → decrypt → merge with no console identity (KNOWN §1, #71) | M | Proven inputs (the served file decrypts with the r0001 disc decrypt; one code word differs) | the launcher's r0004 fetch (#71) lands, or a Sprint 16 plan names it | the r0004 session, 2026-09-27 |

## Dismissed outright

Each dismissal is *proposed by the controller 2026-09-26; the owner confirms or strikes*. A dismissal is a decision
on record; nothing is deleted from the sources.

| Item | Date | Reason |
|---|---|---|
| The GS OpenGL backend as a confidence row | 2026-09-26 | The CPU rasteriser is its oracle (`--vram-diff`, KNOWN §1) with the console-replay test beside it; its visible defects are issues (#32, #67). |
| The save-state container | 2026-09-26 | Nothing in the runtime calls it (only `ps2_save_state_tests.cpp`), and its byte format is the fork's on purpose: no player-facing value. |
| MCSERV | 2026-09-26 | SOCOM II uses the EE libmc stubs, not MCSERV (KNOWN §1, the empty-card row): the module is not reached. |
| Memory cards (the EE libmc stubs) | 2026-09-26 | The virgin-card defect was fixed at the root (`152579a`, KNOWN §1) and no card defect is open. |
| Pads and DBCMAN | 2026-09-26 | Every gate and ladder run drives the game through the EE-side pad HLE (`pad_input_tests.cpp`); a fault is seen at once; the feel is the owner's O7/O8. |
| The CD/ISO path | 2026-09-26 | Every boot reads the game through it, and a fault refuses rather than degrades; its Linux half is row 24. |
| The MPEG/IPU path | 2026-09-26 | Movies play on every gate's title stage through FFmpeg pinned by hash; the movie audio level is BACKLOG's `audio-level-residuals` row. |
| EZNETCNF | 2026-09-26 | Every online round logs in through it (the acceptance test, KNOWN §1); a fault fails the login, not subtly. |
| LGAUD as a row here | 2026-09-26 | Its open items are BACKLOG's voice rows; a second home would duplicate them. |
| The FFmpeg move (research/63 §2) | 2026-09-26 | Done: `ffmpeg-7.1.5` with a `URL_HASH` in the runtime's `CMakeLists.txt`. |
| raylib 6.0 | 2026-09-26 | No defect traced into raylib, and 6.0 breaks the API (research/63 §2). |
| The aux-UDP channel's content (KNOWN §2) | 2026-09-26 | The round-start freeze it was asked for was the texture cache; nothing waits on it. |
| `sin`/`cos` call sites (KNOWN §2) | 2026-09-26 | It matters only if their binding is wrong, and nothing points at that. |
| The muzzle-pitch timed hold (KNOWN §2) | 2026-09-26 | Owed only if a pitch question decides a result; the ladder's kills land. |
| socomrebirth and socom-native (research/63 §2) | 2026-09-26 | No licence on either: cite-only, nothing to take. |

## How this file is kept

The loop adds a row when a plan, a review or a note names future work that is not an issue or a task; a row leaves
when it becomes an issue (the issue is its home from then) or a sprint task (the plan is). The sprint close reads it
beside `docs/BACKLOG.md` and re-sorts it; a row whose trigger fired is promoted or struck with the reason. A
dismissal is struck, never deleted, if the owner overturns it. The sitting page may show the top five rows.
