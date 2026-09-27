# Open PRs watched: what each would bring, our read of it -- research, not a report

Written 2026-09-26 (owner's scope, the same day). **Three kinds, three places:** bugs in a vendor's `main` are
`docs/UPSTREAM.md`; feedback that is not a bug is `NOT-UPSTREAM.md` beside this file; research on what waiting
upstream PRs would bring -- this file. Nothing here is for sending. It points at the notes that hold the reading
rather than repeating them: the verdicts and the watch table are `docs/research/63-upstream-triage-2026-09-25.md`
§0-§2, the ten picks' record is `docs/research/42-upstream-cherry-picks.md`, and the 2026-09-26 sweep (upstream's
branches, the forks, #254, the watch rows to add) is `docs/research/67-external-sweep.md` §1, §3 and §5.

All on `ran-j/PS2Recomp`, whose `main` is `75d729c` (2026-09-26). Local status is checked against this tree's
`git log` on 2026-09-26; "our read" is the verdict of the note named.

| PR / branch | what it would bring (one line) | our read | local status | confidence |
|---|---|---|---|---|
| #227, #229, #230, #231, #232, #237, #240, #241, #243, #246 | GS, VIF and SIF fixes (the titles are in `NOT-UPSTREAM.md` §1.1) | KEEP, research/42 | applied in our tree (commits in `NOT-UPSTREAM.md` §1.1) | high: each gated 3/3 on SOCOM II |
| #221 | a ps2autotests harness, plus MOVZ/MOVN and LWU emit fixes | TAKE the LWU hunk only, research/63 §1 | LWU applied at `53d0d50b`; MOVZ/MOVN ours already; the harness not applied (not ours) | high |
| #223 | a zero-QWC END tag completes its DMA chain | TAKE, research/63 §1 | applied at `f5028386` | high |
| #224 | bit 31 of MADR/TADR/tag ADDR selects the scratchpad | TAKE the MADR/TADR half, research/63 §1 | applied at `c7414c2b`; the tag half ours already (`51529462`) | medium: latent for SOCOM II |
| #239 | translated PS2 paths cannot leave their root | TAKE the class, research/63 §1 | our own code at `4eb07b45`, not the PR's | high |
| #253 | generated files declare only the functions they call | TAKE, research/63 §1 | our own implementation at `5d00f29d` (issue #57) | high |
| #206 | an explicit function map overrides the JAL-target scan | TAKE, research/63 §1 | **not applied**: no commit carries it | medium: measured on the recompiler's output, never built |
| #222 | defer EE time-slice preemption while interrupts are disabled | LATER, research/63 §1 (our tree has a wider form of the defect: nothing reads `Status.EIE`; the PR's premise is untrue of upstream's base too) | not applied (a scheduler-semantics change with a deadlock risk) | medium |
| #254 (Sinan-Karakaya, draft) | recorded-then-compiled VU1 programs with a compiled-against-interpreter test, and an LLE IOP running a game's own sound IRX with SPU2 | no verdict (research/67 gives none; Sprint 15's register decides) | not applied: draft, `dirty`, its fork's CI red on three jobs, 50 of its files changed on our side since the vendoring (research/67 §3) | low: read through the API only, never built Sprint 15 X1's read: research/69 (the sound drivers' imports; a note for its author in NOT-UPSTREAM §1.3). *Superseded 2026-09-27 (Sprint 15 close): decided 2026-09-26 -- its LLE IOP is adopted as an out-of-tree oracle for the audio model, never the product (the owner's word, Sprint 15 T1; research/70, `docs/research/assets/70-lle-oracle/`); the VU1 half has no verdict (`docs/LATER.md` row 5).* |
| `feature/performance-patch-1` (a branch, no PR) | paraLLEl-GS as the default GS backend, logs off by default, IOP and VU1 work | no verdict (research/67 §1) | not applicable to our tree (not proposed upstream yet) | low: one WIP commit |

The rest of research/63's 27 rows (ALREADY OURS, NOT OURS, LATER) and research/42's #226-#252 are in those notes and
are not repeated here. New rows come from the watch rows of research/67 §5 as they are read.
