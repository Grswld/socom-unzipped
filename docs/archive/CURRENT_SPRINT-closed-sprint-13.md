# CURRENT_SPRINT.md -- the Sprint 13 CLOSED block (archived 2026-09-27)

> **ARCHIVED 2026-09-27 (the Sprint 15 close, `docs/DOC_MAINTENANCE.md` §5 step 5) -- superseded by the live
> `docs/CURRENT_SPRINT.md`,** which keeps two CLOSED blocks (Sprints 15 and 14 from this close on). Moved out of the
> live file verbatim: the "Sprint 13 — CLOSED" block with its close-out, its "As it stood while open" text and its
> owner-decisions line; the rulings S13-R1..R14 stay in the Sprint 13 plan,
> `docs/superpowers/plans/2026-09-25-sprint-13.md`. **Nothing below is an instruction:** every "next", "owed",
> "carried" and "open" here is superseded. Where the text says "above" or "below", it means the live file as it stood
> at `9fca94b8`. The live file is `docs/CURRENT_SPRINT.md`; Sprints 12 and 11's CLOSED blocks are
> `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md`, Sprints 9 to 11's records
> `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` and Sprint 8 and earlier `docs/archive/CURRENT_SPRINT-to-sprint-8.md`.

## Sprint 13 — CLOSED 2026-09-26 (merged to `main` as `v0.13.0` at `6a82caaa`, PR #61, 2026-09-26 ~05:00Z after the owner granted the gh token the workflow scope; the record of the sprint is the block below)

**Close-out (the PR body).** Opened 2026-09-25 08:40Z, closed 2026-09-26 04:17Z: 285 commits, 43 agent merges, every task
reviewed by a fresh agent. Closed #27, #30, #31, #33, #35, #36, #37, #38, #39, #40, #45, #46, #48; opened #45–#48, #51–#60;
carried #28, #32, #34, #59 once to the backlog and #25, #26, #42 to the owner (S13-R14, HUMAN_TASKS O16). The gate
`s13_merged_gate` 3/3 on the final exe `0633c484`; proofs 1–4 green on r0001 and r0004; CI green. Found unplanned: a
server-to-client memory write refused on the client (U6, SECURITY); the Sprint 11 chat bound is not on the game-lobby
path (O2, SECURITY 'partly fixed', #26 restated); a stub's table slot can hold an owner's resume entry (#60); the
loop lock's queue proven by a night hand-off and a first-time scheduled ladder. Not done on purpose: V5's audio steps
(the client muted), O1's console-peer leg (the owner's hands). Rulings S13-R1..R14. The DOC_MAINTENANCE §5 review
fixed 24 stale claims across nine documents and three KNOWN rows; the §7 stack read found the audit clean, relabelled
two issues, rewrote two bars, and placed three evidence notes. The Outcome in the plan has the bar row by row.

**As it stood while open:**

Opened by the local controller on the owner's instruction of the same night ("audit the entire structure of the
project, compile a master list, clean up docs as you go, and start your own sprint 13"). The audit is
`docs/audits/2026-09-25-project-audit.md` with six reports beside it; the spec is
`docs/superpowers/specs/2026-09-25-sprint-13-nothing-carried-twice-design.md`. Eight milestones in the order the owner
meets them — **V** the player's first ten minutes (#30, #32, #31, a frame-time line, the music #42/#28, #27, #34, the
launcher's wording), **R** the record made true and small (the archive split and R268's ceilings, DEVELOPING as
current truth, the ruling record, HUMAN_TASKS reduced to the owner's sitting, KNOWN in full, one home for the carry),
**H** the harness pays its debts (the lock's queue #36/#35/#37, #45, #38, #46, #41, the per-revision literals, the fast
subset), **C** the code's hygiene and supply chain (CI compiles the overrides, the throwing stubs, the after-return
trap, FFmpeg with a hash, the dead configuration), **U** upstream and outside (research/63's picks, path containment,
#253's emitter change, a server-to-client record refused), **S** the stranger, **N** the naming follow-ups, **O**
online and the box. The bar: nothing leaves the sprint carried twice without a ruling; CI green with the overrides
compiled; the record under its ceilings; the first ten minutes measured; the gate 3/3 plus one ladder run and one
mixed leg on the sprint's final exe. The plan's Log is the live state; this block gains its table at the close.

**Owner decisions:** `docs/HUMAN_TASKS.md` carries them, O1–O15 (reduced by Task R4, `4adbf2bc`, `1ed975a4`), with
the plan's D1–D2; each has the default the loop is on.
