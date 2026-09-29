# Human tasks — the owner's sitting

sittings: 2026-09-17, 2026-09-26, 2026-09-27 (read by tools_py.sitting)

What only the owner can decide or do, in one table. Every row stands on a default: the loop proceeds on it and never
waits. Rewritten 2026-09-25 (Sprint 13 Task R4) from the project audit's owner sitting
(`docs/audits/2026-09-25-project-audit.md` §3, rows O1–O13), with two rows that audit missed (O14, O15).

**The rule.** The loop adds a row only when it reaches a step it cannot verify or a decision that is not its to make;
it writes the default it proceeds on beside it and moves on. Anything the loop can do itself (a window on this machine,
a capture, a VM run, a draft, a document) is a sprint task or a backlog row, never a row here -- except the window
itself: a game run's window is the owner's (O20, R297).

**Numbers.** `O<n>` is a row of this table. A Sprint 13 task in milestone O is written "S13 O1". The old decision
numbers are named by their sprint — "Sprint 11 D2", "naming D1–D7" (Sprint 12), "r0004 D1" — because the list this
replaced used bare D-numbers for three different tables (documents audit D61).

**Before 2026-09-25.** The list this replaced — its "Start here" blocks, the "Sprint 11 close" and "Sprint 12 close"
sections, the numbered items and the `## Open` checkboxes — is `docs/archive/HUMAN_TASKS-to-2026-09-25.md`, verbatim,
under a table that gives each of its 87 items a disposition. Any citation of this file's sections, items or line
numbers written before that day means the archive.

| O | the decision or the hand | the default the loop is on | settles | first asked |
|---|---|---|---|---|
| O20 | **Windows for game runs** (R297): the hours a controller may run a game on this machine. First asked for the Sprint 15 drag test in a mission (first asked for issue #67 (closed)'s drag test, run 2026-09-27 under the owner's word). Named 2026-09-28 03:20Z: "the next 12-13h" -- 03:20Z to 15:00Z (R331); again 15:53Z, "go ahead now i'll interrupt if need be", open until the owner interrupts (R332); closed 2026-09-29 02:33Z ("playing games, lock work has to stop"), reopened 03:24Z ("The machine is yours again, proceed"), and at 07:35Z "You have the next 10ish hours, a web agent is working but should never collide with you" -- to ~17:30Z (R335). | no game run by a controller until you name a window; builds are announced as windows | R297 | 2026-09-26 |
| O22 | **A second shipped binary of recompiled Sony code**: the first-run decrypt helper `socom2_build_elf.exe` (Sprint 16 R1b, R316) is the disc loader's own routines recompiled, to ship beside `socom2.exe` in both archives once R1b lands (unmerged at the Sprint 16 close); R290 named the exe alone. | it ships under R290's position | Sprint 16 D3, R316 | 2026-09-27 |
| O25 | **The persona viewer's full human pass** (your word of 2026-09-27 22:40Z: "Personas still need a full human test pass"; R321 struck O7, which carried it) | the ledger is proven by L1b's Step 0b on a real login against our box; the viewer's look, the CONNECT flow, CREATE ON CARD and the second persona are yours to judge on the batch-4 archive (2026-09-29, the chain `s17_b4d`'s release step, the persona creator merged -- PLAYTEST's ONLINE steps; a reordered two-persona card is the case #111 names); nothing in the loop waits on it; a defect you find becomes an issue | Sprint 17's sitting | 2026-09-28 |
| O21 | **The `ci` label** `.github/dependabot.yml:11` asks for does not exist, so Dependabot warns on every PR: create the label, or say the line goes. | the line stays; the warning is noise; Dependabot PRs merge under R294 (#10 merged 2026-09-27) | Sprint 16 X5 | 2026-09-27 |
| O23 | **The two outside surfaces** (R318, R319): (a) post the first announcement, `docs/announcements/2026-09-27-map-viewer.md`, in Discussions → Announcements and fill its `Posted:` line (or say what to change first); (b) save the wiki's first page (Home, shaped by `docs/templates/wiki-page.md`), which creates the wiki repository the loop then drafts into -- every page is pushed by your hand. | unposted; the wiki stays empty; the loop drafts and never publishes | R318, R319; LATER 49, 50 | 2026-09-27 |
| O27 | **A quiet hour for the slow lock suite, or the second machine** (2026-09-29, issue #110): the fix for the lock waiter's heartbeat (a waiter behind a chain, a game run or a build makes 2 process starts a minute instead of 24; written, measured, uncommitted in `wt-i110-lock-heartbeat`) needs one green run of `LOOP_LOCK_SLOW_TESTS=1 python -m unittest tools_py.tests.test_loop_lock` (~40 min) for the commit hook's marker, and the suite's stale-mutex timing tests failed twice today on this host with 16 node and 45 bash processes from other sessions alive (15:33Z and 17:00Z) -- the loop cannot close another session's processes. Either name an hour with every other session and dev server closed, or run the suite on the second machine (R334) and hand the marker over. | the fix stays uncommitted on its branch; the waiter starvation (#110) stands in HAZARDS | #110, R334 | 2026-09-29 |
| O26 | **The design system's two branches** (the s2u design-system session, 2026-09-28): (a) scotho branch `s2u-design-system` (phases 1-4 + the confirmed TODO items; deployed to socomunzipped.com by the session) needs your push and its merge (the account-id file is tracked since your 2026-09-28 ruling; no repository secret); (b) socom_pc branch `agent/ds-web` (worktree `C:\projects\wt-ds-web`: the viewer on the system, the story generator's footer) goes to `main` by its own PR under R294 after v0.16.0, or to Sprint 17's branch -- never `--delete-branch` while the worktree holds it; until it is on main, a site deploy passes `VIEWER=C:/projects/wt-ds-web/web/dist/viewer` (the main tree's dist is the pre-system viewer); (c) cleanup at your hand: the `C:\projects\socom_pc_web` worktree is superseded (`git worktree remove`), and `/opt/s2u/private.htpasswd.bak-20260926` on the box. | the branches stay local; the live site already runs them | the design-system spec §13; scotho's TODO-s2u note of 2026-09-26 | 2026-09-28 |

O9 and O17, answered, are in `docs/archive/HUMAN_TASKS-to-2026-09-25.md`; O1, O3, O6, O11, O12, O13, O14, O16, O18, O19, answered, are in `docs/archive/HUMAN_TASKS-answered-to-2026-09-27.md` (their struck rows verbatim, moved 2026-09-27 when this file's ceiling fired, DOC_MAINTENANCE check 7); O2, O4, O5, O7, O8, O10, O15 (closed by default 2026-09-27, R321) and O24 (done 2026-09-28) are in the same file, moved 2026-09-28 when the ceiling fired again; all reopenable by number.

**How to answer.** One line per decision — "O5: acceptable for v1", "O12: off" — in the next session's prompt or as a
line in the open plan's Log. The loop strikes the row with the date and the ruling that records the answer, and moves
the work it opens into a task.
