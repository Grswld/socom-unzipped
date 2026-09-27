# Not upstream's bugs: notes to PR authors, a draft where upstream is right, open questions

Written 2026-09-26 (owner's scope, the same day). **Three kinds, three places:** bugs in a vendor's `main` are
`docs/UPSTREAM.md`; feedback that is not a bug -- this file; research on what waiting upstream PRs would bring --
`OPEN-PRS.md` beside it. Nothing here has been posted: every row's status is **not sent**. Sending a note is the
owner's act, like filing (`docs/HUMAN_TASKS.md` O10), and the AI-assistance point of `docs/UPSTREAM.md` §0 applies
to every note here too. `ran-j/PS2Recomp`'s stance on AI-assisted contributions (none stated) is in
`docs/UPSTREAM.md` §1.

We are not PS2Recomp's maintainers. A note here is feedback to a PR's author or an observation; it asks nothing of
upstream's `main`.

## 1. Notes to PR authors on ran-j/PS2Recomp

### 1.1 The ten KEEP picks (`keep-notes.md`, one comment per open PR)

Each was cherry-picked unchanged (the added and removed lines identical to upstream's, per `keep-notes.md`), gated
on SOCOM II and fast-forwarded into `sprint-11` at `3bb866f4`, an ancestor of `sprint-14`. The per-pick gate record
is `docs/research/42-upstream-cherry-picks.md:162-173`. Each note says "tested downstream"; none reports a defect.

| PR | title (author) | local status: applied in our tree at | confidence | recommendation | status |
|---|---|---|---|---|---|
| #231 | TEXCLUT addressing for CSM1/CSM2 (GTTeancum) | `895643cf` | high: gated 3/3 on SOCOM II, vram diff 15/15 | comment | not sent |
| #229 | GIF IMAGE2 transfers (GTTeancum) | `1bf931b1` | high: gated 3/3, 15/15 | comment | not sent |
| #243 | 128-bit writes to GS privileged registers (GTTeancum) | `8987b64e` | high: gated 3/3, 15/15 | comment | not sent |
| #230 | COLCLAMP during alpha blending (GTTeancum) | `495d4217` | high: gated 3/3, 15/15 | comment | not sent |
| #237 | VIF UNPACK V2/V3 lanes (GTTeancum) | `21d02c2e`, `1279f97f`, `18a318fa` | high: gated 3/3, 15/15; a test-file conflict with #232 noted | comment | not sent |
| #232 | VIF UNPACK V4-5 channels (GTTeancum) | `c58dbbc7` | high: gated 3/3, 15/15, no double scale | comment | not sent |
| #227 | framebuffer rows in interlaced presentation (GTTeancum) | `77570a0d` | medium: gated 3/3, but on the CPU present path our shipped GL backend does not use, so "no harm", not a fix | comment | not sent |
| #240 | route SifSetReg/SifGetReg syscalls (hedgeg0d) | `98e06920` | medium: gated 3/3; whether SOCOM II issues the syscalls is unknown | comment | not sent |
| #241 | raw SIF DMA init handshake (hedgeg0d) | `a65f6f5a` | high: gated 3/3 and an online lobby on our own server, no doubled reply | comment | not sent |
| #246 | reject depth-failing pixels before shading (GTTeancum) | `ec6d948d`, plus our knob row `30cf9510` and `f7a7e206` | high: gated 3/3, 15/15 | comment | not sent |

**How to send.** Post each PR's quoted block from `keep-notes.md` as one comment on that PR; its "Evidence" lines
stay here. Check the PR is still open first (`gh api repos/ran-j/PS2Recomp/pulls/<n>`).

| done | PR | comment URL | date |
|---|---|---|---|
| [ ] | #231 | | |
| [ ] | #229 | | |
| [ ] | #243 | | |
| [ ] | #230 | | |
| [ ] | #237 | | |
| [ ] | #232 | | |
| [ ] | #227 | | |
| [ ] | #240 | | |
| [ ] | #241 | | |
| [ ] | #246 | | |

### 1.2 The adapted picks: #221, #223, #224 (no draft yet)

The drafts README leaves these out ("Not covered here"): they were adapted, so a note would say what we changed.
All three merged into `sprint-13` at `ab6d7ff3` (Sprint 13 U7), an ancestor of `sprint-14`.

| PR | what we took | local status: applied in our tree at | confidence | recommendation | status |
|---|---|---|---|---|---|
| #221 (tge-was-taken) | the LWU hunk only: LWU zero-extends (its MOVZ/MOVN hunk was ours already, `5e3bf6be`) | `53d0d50b` | high: a RED/GREEN codegen and execution test (the commit body) | no draft; a note only if the owner wants one | not sent |
| #223 (GTTeancum) | a data-less END tag completes the chain; the PR's hunks placed on our walker | `f5028386` | high: RED/GREEN on GIF and VIF1 | no draft | not sent |
| #224 (GTTeancum) | the MADR/TADR bit-31 half only; its tag half was ours already (`51529462`) | `c7414c2b` | medium: RED/GREEN, but latent for SOCOM II (no bit-31 start address in its DMA trace, research/63 #224) | no draft | not sent |

### 1.3 A note to #254's author (no draft yet; Sprint 15 X1, research/69)

Feedback, not a bug: the draft PR's LLE kernel binds the libsd side of a 989snd-style driver but returns zero for the
`cdvdman`, `ioman` and one `sifman` import such a driver makes (research/69 §2, counts by command, no ordinals), so a game
whose sound runs through 989SND.IRX cannot load a bank from the disc on it as the PR stands; a `cdvdman` provider (read, sync,
the callback form) would be the missing piece. Status: not sent (R284; the owner's row O10). `OPEN-PRS.md`'s #254 row points here.

## 2. A draft where upstream is right: the export-table walk

| item | what it is | draft / patch | local status | confidence | recommendation | status |
|---|---|---|---|---|---|---|
| export-table walk | `registerExportTable` ends a table at its first zero word (`ps2xIOP/src/emulator/imports/iop_imports.cpp:120` at `main` = `75d729c`, read 2026-09-26), which is the IOP's format; our guard (two zero words) over-reads | `issue-export-table-walk.md` / `ps2recomp-export-table.patch` (REFERENCE ONLY) | **applied in a spike only** (`docs/research/assets/40-irx-differential/pr244-spike-patches.diff`, `2accf38d`), **not in the tree**, and **not to be applied**: it was not the fix for what it was written for | high that upstream is right and our guard over-reads | **do not file as a bug**; optionally post the draft's test-suggestion note; never attach the patch | not sent |

| done | item | URL (or "skipped") | date |
|---|---|---|---|
| [ ] | the test-suggestion note (optional) | | |

## 3. Open questions, not yet anyone's bug

| vendor | item | local status | why no report | stance on AI-assisted reports |
|---|---|---|---|---|
| chaoticgd/ghidra-emotionengine-reloaded | why Ghidra's program-wide block walk stops at an R5900 `sync` (the draft `binexport-r5900-1.md`: "We did not establish why") | not applicable to our tree (no patch; the cause is unknown) | a report needs the cause -- the extension's SLEIGH flow for `sync` or Ghidra's `BasicBlockModel`; finding it is a research task | no stated policy (read `README.md` and `.github/` on 2026-09-26: no CONTRIBUTING, code of conduct or issue templates). Apache-2.0 |
| NationalSecurityAgency/ghidra | the same, if the cause is Ghidra's | as above | as above | "If using "AI" to assist in development, please apply extra scrutiny to its suggestions" (`CONTRIBUTING.md:38`, read 2026-09-26); no CLA, contributions are inbound=outbound under Apache-2.0 (`CONTRIBUTING.md:139-142`); issue templates `bug_report.md`, `feature_request.md`, `question.md` |
| google/bindiff | BinDiff 8's "flow graph already attached" (the B2 row of `docs/UPSTREAM.md`) | not applicable (BinDiff is right to refuse a bad export) | nothing to report | no stated policy (read `README.md`, `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/bug_report.md` on 2026-09-26); the Google CLA for code (`CONTRIBUTING.md:4-6`) |
