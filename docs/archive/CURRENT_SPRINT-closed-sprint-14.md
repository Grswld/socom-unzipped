# CURRENT_SPRINT.md -- the Sprint 14 CLOSED block (archived 2026-09-28)

> **ARCHIVED 2026-09-28 (the Sprint 16 close, `docs/DOC_MAINTENANCE.md` §5 step 5) -- superseded by the live
> `docs/CURRENT_SPRINT.md`,** which keeps two CLOSED blocks (Sprints 16 and 15 from this close on). Moved out of the
> live file verbatim: the "Sprint 14 — CLOSED" block with its close-out, its "As it stood while open" text and its
> owner-decisions line; the rulings R269-R281 stay in the Sprint 14 plan,
> `docs/superpowers/plans/2026-09-26-sprint-14.md`. **Nothing below is an instruction:** every "next", "owed",
> "carried" and "open" here is superseded. Where the text says "above" or "below", it means the live file as it stood
> at `1d5a73c6`. The live file is `docs/CURRENT_SPRINT.md`; Sprint 13's CLOSED block is
> `docs/archive/CURRENT_SPRINT-closed-sprint-13.md`, Sprints 12 and 11's `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md`,
> Sprints 9 to 11's records `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` and Sprint 8 and earlier
> `docs/archive/CURRENT_SPRINT-to-sprint-8.md`.

## Sprint 14 — CLOSED 2026-09-26 (merged to `main` as `v0.14.0` at `200f3287`, PR #68, 16:55Z; the release waits on the owner's word; the record of the sprint is the block below)

**Close-out (the PR body).** Opened 2026-09-26 05:17Z, closed 2026-09-26 16:28Z: 231 commits, 46 merges (26 agent branches, five
of `main`, the close's three), every task reviewed by a fresh agent. No feature work (R269). Landed: the guards (a Bash and an
Edit/Write PreToolUse hook, the watcher reaper, `build.sh`'s lock check, the memory guard, the commit-msg hook); the read-first
set from 250 KB to 51 KB (`CLAUDE.md`, four skills, HANDOFF transient, HAZARDS split out, a budget check); four generated
pages (rulings, changelog, sitting, flow) each held to its source; the WIP cap (a third build waiter exits 4) and the merged
chain as the gate unit (two chains today: `s14_chain1` and `s14_close1`, both ALL GREEN, gate 3/3, the fourth leg 12/12);
gate freshness (exit 5), the recompiler reference job (red once on a planted change, run 36237829527), PRs to `main` built
on their heads (#61, #65, #66 observed). Rulings R269-R281. Issues since the open at 05:17Z: opened 1 (#67), closed 3
(#51, #53, #56), carried 0; the highest is #67. The DOC_MAINTENANCE §5 review fixed 31 stale claims across nineteen files
and archived two blocks; the §7 stack read found the audit clean, placed one evidence note, labelled four issues. The
owner's word at the close: the release waits; upstream filings wait (`docs/UPSTREAM.md`); candidate work now lives in
`docs/LATER.md`; Sprint 15 re-cut to value (audio first). The Outcome in the plan has the bar row by row.

**As it stood while open:**


Opened by the Sprint 14 controller off `main` at `6a82caaa` (the Sprint 13 merge, `v0.13.0`) on the owner's
instruction of 2026-09-26 ("begin with sprint 14 once sprint 13 is finished, committed, and live on main"). The
sprint came from the structure review `docs/audits/2026-09-26-autonomy-structure-review.md` (nine findings: the
record is the failure surface; rules recur, tools do not; greens that were not; an unbounded ruling log; one host,
many writers; handoffs lose state; the owner loop never closes; nothing measures cost; a thin verification
architecture). **No feature work.** Every rule that has recurred becomes something that fails on its own, every
document a session must read becomes small, generated or loaded on demand, and concurrency is capped until the host
stops corrupting measurements. The owner's word of 2026-09-26 sets aside "visible defects first" for this one sprint
(R269); the order resumes in Sprint 15.

Seven milestones in order, then a filler — **G** guards (a PreToolUse hook refusing the eight recurring git and lock
mistakes; an Edit/Write hook for running chain scripts; a session-end hook that reaps orphaned watchers; agent
definitions; `build.sh` consults the lock; a memory guard), **I** instructions on demand (a root `CLAUDE.md` under
sixty lines; four skills replace the prose procedures; HANDOFF transient under 6 KB; a read-first budget check;
KNOWN's hazards to their own file), **W** the host (the queue refuses a third building agent; the merged chain is the
gate unit, with eviction and ticket waits logged), **D** decisions with status (a generated rulings page; the scope
rule and one counter; a generated owner's sitting page; the circuit breaker; PLAYTEST's build block written by the
chain), **S** the record generated (the changelog; STATUS's log archived; a commit-msg hook; ceilings that ratchet
down; one home each), **E** evidence that is hard to fake (a PR to `main` built on its head; a held-out capture leg;
recompiler re-derivation in CI; gate freshness), **M** measurement (a generated flow page; token spend read locally,
never committed); **X1** the external sweep for Sprint 15, filler when the host is quiet. **Every guard is fired
against a planted violation before it counts as done.** The bar is the spec's section 4; the nine owner defaults and
their rulings R269-R277 are the plan's "Owner decisions" and "Rulings" sections. The plan's Log is the live state;
this block gains its table at the close.
