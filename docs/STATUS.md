# Project status — "Current state" below is kept current; the dated log that stood under it is archived

## Current state (keep it short; update when it changes)
- **2026-09-27 06:27Z -- Sprint 15 ("borrowed confidence", re-cut) is CLOSED on `sprint-15` without its play test, on the owner's word; the PR to `main` and the tag `v0.15.0` follow (the release waits).** Adopted: #254's LLE IOP as an out-of-tree audio oracle (832 of 13,044). Merged code: #67's fix, the AutoVol step schedule. Carried to Sprint 16: the chain (gate, fourth leg, parity, dips), T2's drag proof, T3, T4. Live state: `docs/CURRENT_SPRINT.md` "Sprint 15 -- CLOSED"; next: Sprint 16 "ten minutes to the server" (its controller session).
- Older state bullets: the twenty that stood under the one above (2026-09-19 to 2026-09-25 early) became dated
  entries of the log on 2026-09-25, verbatim (Sprint 13 Task R1, R268); that log is
  `docs/archive/STATUS-log-to-2026-09-26.md` since 2026-09-26 (R272). This block has a byte ceiling
  (`tools_py/docmaint.py` `CEILINGS`): when the state changes, replace the bullet above; a superseded bullet goes
  to the plan's Log.
- Build: `./build.sh all`; tests `./build.sh test` (the Python suite first, then `ps2x_tests` + the VU1 fixture verify + `--vram-diff`). Gate: `python -m tools_py.parity.gate` -- title/transition/mission, the mission stage requiring live gameplay.
- Next: `docs/CURRENT_SPRINT.md`'s `branch:` line says which sprint is open, and its top block what to do; this line
  carries no sprint number any more. New controller: `docs/HANDOFF.md` first. (This line read "Sprint 9 milestone P"
  from 2026-09-20 to 2026-09-23 -- a milestone that had ended in the `playtest-1` tag two sprints earlier -- and then
  "Sprint 10 is CLOSED, what is left is the merge and `v0.10.0`" from 2026-09-23 to 2026-09-25, through Sprint 11's
  whole life and its close review: twice the single most misleading sentence in any live document, which is why it
  now points instead of stating.)



## Where the log went

Until 2026-09-26 a dated log stood here, newest first, about 2,500 lines back to the first boot; it is archived
verbatim in `docs/archive/STATUS-log-to-2026-09-26.md` (Sprint 14 Task S1, R272), and a STATUS entry cited by date
before that day means that file. What merged and when is `docs/CHANGELOG.md`, generated from the merge commits and
the `v*` tags (`python -m tools_py.changelog`); why is the merge commit's message and the open sprint's plan, its
"## Log" (`docs/superpowers/plans/`, the plan `docs/CURRENT_SPRINT.md` names). Nothing is appended below this
paragraph any more: where the block above said (until 2026-09-26) "the log below" or "make the old one an entry", a superseded state
bullet goes to the plan's Log.
