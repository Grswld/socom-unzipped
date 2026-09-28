# Project status — "Current state" below is kept current; the dated log that stood under it is archived

## Current state (keep it short; update when it changes)
- **2026-09-28 01:24Z -- Sprint 16 ("ten minutes to the server") is CLOSED on `sprint-16`; the PR to `main` and the tag `v0.16.0` follow the owner's one push of the branch (O24).** Done: V0, R1a, R2a, R3a, R5, L1a, L1b (#73), L2 (#74), F0 (research/73), F2 (ADOPTED: the read-back 123 → 20 ms/s, `submit=` 568 → 541), X1, X3, X5. Not done: the first-run helper (R1b stopped in the package stage, research/76; #70 carried), R2 (#71 carried), F1, F3 (#32 to the backlog), F5's pin (#59 carried). The owner's play test: the drag fixed, the audio much better, the online screens' music open (#94). Live state: `docs/CURRENT_SPRINT.md` "Sprint 16 -- CLOSED"; next: Sprint 17 "sixty and the way back", opened by its own seat off `main`.
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
