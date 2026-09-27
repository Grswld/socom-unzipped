# Human tasks — the owner's sitting

sittings: 2026-09-17, 2026-09-26 (read by tools_py.sitting)

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
| O2 | **The release drafts** (`v0.10.0` to `v0.14.0`, all empty): delete the older drafts or keep them; a private off-machine home for each release's `dist-release/symbols/`; a dry run of the release-draft workflow's verify half on a scratch draft (yes/no); the publish click once the exe-only archive exists (#70, R290). | the drafts stay empty; the loop builds the archives short of the upload; publishing is always your click | carry C2, C3 | 2026-09-20 |
| O4 | **The message to the PSRewired moderator** (the archive, "Send this to the PSRewired moderator"), with O5's Goal F question in the same message. The rest of this row was answered 2026-09-26 (R292): I1 and I2 built, the site's five items in its TODO. | unsent; you send it in the coming days | carry C15, C16 | 2026-09-20 |
| O5 | **PSRewired, what only you can ask** (Goal F): their word on a PC-native client fetching the r0004 package and playing; whether their players carry `mc0:UPDATE.DAT`; the community preset's address, when you say so. The rest was answered 2026-09-26 (R293): the launcher fetches the package itself (#71), two rooms when needed (#72), no r0004 disc, HDD maps far future, connections to their server by your hand only. | the preset stays `COMMUNITY_SERVER_ADDRESS_TBC`; the loop never connects on its own | carry C17, C21–C24, C26 | 2026-09-17 |
| O7 | **Your ears and hands on the current build**, on a quiet machine: one listen to the music against the console (mission, briefing, options); Q4's four tries on a real pad; the CONTROLLER page's hold-to-remap; the prefilled login with your real persona. The profile viewer is wanted and is #73 (R295). | the loop does not wait (the listen gate bypassed since 2026-09-20) | carry C60, C119–C122 | 2026-09-17 |
| O8 | **A PLAYTEST sitting on the current build** (`docs/PLAYTEST.md`), on a quiet machine. **Done 2026-09-27 (quick, the batch-3 build): the drag fixed, the audio much better, the personas OK superficially; the online screens' music is issue #94; a full persona pass still owed.** Its decision: R295 (2026-09-26). | the loop rewrites PLAYTEST for each build it can hand over; the report's log box stays OFF | carry C126; audit F10 | 2026-09-20 |
| O10 | **Public actions upstream**: file the two PS2Recomp issues with their patches, the ten KEEP comments and the two BinExport issues from `docs/research/assets/63-upstream-drafts/` (its README orders them). | file later (owner, 2026-09-26): nothing filed; `docs/UPSTREAM.md` is the register | audit E5; external X9, X10, X20 | 2026-09-25 |
| O15 | **Linux on real hardware** (a Linux PC or a Steam Deck): the tarball's launcher opens, the game boots with music and the pad, the first three `[gs-gl]` lines of the run log, and R107's title-loop correlation. | not yet (owner, 2026-09-26: no such machine at hand); CI and the VM stand in; the VM half is the loop's backlog | carry C123 | 2026-09-18 |
| O20 | **Windows for game runs** (R297): the hours a controller may run a game on this machine. First asked for the Sprint 15 drag test in a mission (#67, code-complete, its run waiting). | no game run by a controller until you name a window; builds are announced as windows | R297 | 2026-09-26 |
| O22 | **A second shipped binary of recompiled Sony code**: the first-run decrypt helper `socom2_build_elf.exe` (Sprint 16 R1b, R316) is the disc loader's own routines recompiled, shipped beside `socom2.exe` in both archives; R290 named the exe alone. | it ships under R290's position | Sprint 16 D3, R316 | 2026-09-27 |
| O23 | **One `git push origin sprint-16` from the main tree, right before the PR to `main`** (the Sprint 15 push seat closed 23:20Z; the controller's worktree seat cannot push, by the guard) — or seat the controller in the main tree. | the PR waits for that push; the close-out commits stay local until then | the Sprint 16 close | 2026-09-27 |
| O21 | **The `ci` label** `.github/dependabot.yml:11` asks for does not exist, so Dependabot warns on every PR: create the label, or say the line goes. | the line stays; the warning is noise; Dependabot PRs merge under R294 (#10 merged 2026-09-27) | Sprint 16 X5 | 2026-09-27 |
| O23 | **The two outside surfaces** (R318, R319): (a) post the first announcement, `docs/announcements/2026-09-27-map-viewer.md`, in Discussions → Announcements and fill its `Posted:` line (or say what to change first); (b) save the wiki's first page (Home, shaped by `docs/templates/wiki-page.md`), which creates the wiki repository the loop then drafts into -- every page is pushed by your hand. | unposted; the wiki stays empty; the loop drafts and never publishes | R318, R319; LATER 49, 50 | 2026-09-27 |

O9 and O17, answered, are in `docs/archive/HUMAN_TASKS-to-2026-09-25.md`; O1, O3, O6, O11, O12, O13, O14, O16, O18, O19, answered, are in `docs/archive/HUMAN_TASKS-answered-to-2026-09-27.md` (their struck rows verbatim, moved 2026-09-27 when this file's ceiling fired, DOC_MAINTENANCE check 7); all reopenable by number.

**How to answer.** One line per decision — "O5: acceptable for v1", "O12: off" — in the next session's prompt or as a
line in the open plan's Log. The loop strikes the row with the date and the ruling that records the answer, and moves
the work it opens into a task.
