# Documentation maintenance — the classes, the registry, and the sprint-close review

**Last full review: 2026-09-28 (Sprint 16 close; §5 by a read-only agent's table, 38 findings, the blocking ones fixed in `40defd7b` and Sprint 14's block archived; §7 by a read-only agent's table, the audit clean, four issues carried to Sprint 17 and two to the backlog, two opened, the milestone closed, the backlog regenerated, R271's breaker applied as R321).** Next: at the next sprint's close, by its controller.

> **The first review under this schema, 2026-09-23 (Sprint 10's close), and what it changed.** Step 1: `docmaint`
> OK. Step 2: every L document read for truth by a read-only agent against the tree and the night's ledgers — 56
> findings (README 4, STATUS 4, KNOWN 8, CURRENT_SPRINT 9, HANDOFF 13, HUMAN_TASKS 10, DEVELOPING 2, ROADMAP 4,
> STORY 2, PICTURES 0), every one applied with supersede-in-place (`70759da`, `7a89b8c`, `80e0074`, `37f9bb0`),
> reviewed (four sentence-level Importants, all fixed: `1d86d71`, `ae13cf8`, `dec9af9`, `5aef282`), re-reviewed
> clean. Step 3: README's table rewritten row by row against KNOWN. Step 4: ROADMAP had already regrown a task list
> (its eight-item backlog) one day after the rewrite — moved to CURRENT_SPRINT's filler list; STORY's closing beat
> answered under a dated blockquote. Step 5: nothing archived this time. The sprint's 64 rulings (R181–R244, R229
> deliberately vacant) reconciled into one table in CURRENT_SPRINT. Two lessons for the schema: (1) a class-N
> document regrows live state within a day if the author does not have a filler list to put it in — CURRENT_SPRINT
> now has one; (2) counts must carry their date *and* the same artefact must carry the same number in every row
> (the same capture was "21 minutes" and "twelve-minute" three lines apart).

## 0. Why this exists

On 2026-09-22 `docs/ROADMAP.md` was audited against the tree for the first time since it was written. Nine of its
twenty-five checkable claims still held; two were **wrong in a way that would misdirect an agent** — it told readers to
reorder the standing goals in `LOOP_PROMPT.md`, a file that had been rewritten two days earlier to contain no goals at
all, and it described a knob problem that Sprint 10 had solved. The same pass found three more:

- **`docs/HANDOFF.md` offered "Next free ruling number: **R179**" while R241 was in use.** Not merely stale — an
  agent obeying it would have collided with sixty-two existing rulings, and `docs/CURRENT_SPRINT.md` already records
  that exact failure happening once ("the agent numbered from R200, already taken").
- **`README.md`, the public front page, listed "terrain holes (root cause still open) and a water defect on one map"**
  — both fixed on 2026-09-16, six days before the README's own last edit. It understated the project to strangers.
- **`docs/HANDOFF.md` and `docs/CURRENT_SPRINT.md` both carried the suite baselines `C++ 686/686, Python 1457 OK` on 2026-09-22** —
  true when written on 2026-09-20, four sprints stale by then, and the third and fourth places in the tree to
  hard-code a number that `docs/DEVELOPING.md` already owns. (That sentence keeps its date *on the same line as the
  number*, which is exactly what check 3 asks for.)
- **The ruling counter had two homes that disagreed**: `HANDOFF.md` said the next free number was R242 and
  `CURRENT_SPRINT.md` said R241, while R240 was the highest actually in use.

The documents that stayed true and the ones that rotted did not differ in care. `docs/KNOWN.md` is audited after every
task and stayed true for ten days across six sprints. `ROADMAP.md` was audited by nobody. **The difference is whether
anything could fail.** This file is the schema; `tools_py/docmaint.py` and `tools_py/tests/test_doc_maintenance.py`
are the thing that fails.

## 1. The six classes

Every perpetuating document has exactly one class. The class decides **what may be written in it** and **when it is
checked** — and the first of those matters more, because a document with nothing perishable in it cannot rot.

| Class | Meaning | What it may contain | Checked |
|---|---|---|---|
| **L** — Live | Must be true *right now*; read by every session | Current state, open items, live numbers | **After every task that changes it**, and in full at sprint close |
| **G** — Generated | A tool writes it from a source of truth | Whatever the tool emits — never hand-edited | By its own test, every suite run |
| **N** — Narrative | History, reasoning and pointers | **No live state, no live numbers, no task lists.** Pointers to L documents instead | Sprint close |
| **S** — Snapshot | Frozen at its date | Anything — it is a record of one moment | Never. It is not updated; it is superseded |
| **C** — Contract | Rules that change only by decision | Process, policy, templates | Sprint close, against what actually happens |
| **A** — Archive | Superseded, kept because things cite it | The original text, verbatim, under a banner | Never |

**The rule that does the most work is N's.** The roadmap rotted because it held live state — sprint task lists, test
counts, frame rates, an instruction to go and edit another file. A narrative document that says *"the live queue is
`docs/CURRENT_SPRINT.md`"* cannot be wrong about the queue. Prefer moving a fact to its owning L document and pointing
at it over repeating it.

**S and A are not failures.** A dated snapshot that says what it is costs nothing and is often the most valuable thing
in the tree. The failure mode is a snapshot that *reads as current* — which is why both classes must announce
themselves, and why the checks below enforce exactly that and nothing else about their content.

## 2. What the registry covers

The table in §3 must account for every `.md` file in these locations, one row each:

- the repository root: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, `CLAUDE.md`
- `docs/*.md`, `docs/parity/*.md`, `docs/story/*.md`, `docs/archive/*.md`

Everything else is classified **by location**, and needs no row:

- `docs/archive/<subdirectory>/**` — **A**. `docs/archive/*.md` at the top level is one document each and gets a row
  each; a subdirectory is a *block* moved whole (`docs/archive/sprints-1-6/` is twelve files that arrived in one
  commit), and a row apiece would say nothing the path does not. **The banner is still owed** — that is the whole
  point of the class, and `tools_py/docmaint.py`'s check 5 holds every file under such a subdirectory to it.
- `docs/research/**` — **S**. A research note is a dated investigation. Supersede, never rewrite.
- `docs/superpowers/specs/**` and `plans/**` — **S**. A spec is what was decided that day; the plan's `## Outcome`
  is where it is reconciled. Their filenames carry the date already.
- `docs/audits/**` — **S**, dated in the filename by convention.
- `docs/announcements/**` — **S**. A dated announcement draft (`<YYYY-MM-DD>-<slug>.md`) shaped by
  `docs/templates/announcement.md` and posted by the owner's hand only (R319, §8); `AnnouncementsTest` in
  `tools_py/tests/test_doc_maintenance.py` holds each to its filename date and its `**Publish:** the owner` line.
- `docs/templates/**` — **C**. The templates (an announcement, a wiki page); `docs/story/release-entry.template.md`
  predates the directory and keeps its row.
- `third_party/**`, `server/horizon-server/**` — vendored. Not ours to maintain; do not edit to match our tree.
- `tools_py/**/README.md`, `tests/fixtures/**/README.md` — **S**, owned by the fixture or tool beside them.

A new document in a covered location with no row **fails the suite**. That is the point: the registry is how a
document gets a class, and an unclassified document is one nobody has decided the rules for.

## 3. The registry

| Path | Class | Owner | Note |
|---|---|---|---|
| `README.md` | **L** | controller | The public front page. Its Status paragraph is a live claim (the "Works / Not yet" table it replaced was removed in `f55196a6`) and is the highest-stakes row here — a stranger reads it before anything else |
| `CONTRIBUTING.md` | **C** | controller | |
| `SECURITY.md` | **C** | controller | The "Known: the game's own network code" section is live in spirit; review it whenever the network path changes |
| `THIRD_PARTY_NOTICES.md` | **G** | licence test | A test fails on a dependency, vendored directory or release DLL without a row |
| `CLAUDE.md` | **C** | controller | Loaded into every Claude Code session at start. A map, never state: at most 60 lines, no suite count, the live documents and the four skill names named (`ClaudeMdTest`). Sprint 14 I1 |
| `docs/STATUS.md` | **L** | controller | The "Current state" block (its ceiling is check 7's) and one pointer paragraph: nothing else since 2026-09-26 (Sprint 14 S1, R272). The dated log that stood under the block is `docs/archive/STATUS-log-to-2026-09-26.md`; what merged is `docs/CHANGELOG.md`, why is the plan's Log. Held to the single-source count rule like any L document |
| `docs/KNOWN.md` | **L** | every task | Proven vs believed, with the artefact for each. **It wins on any disagreement.** The model this schema is generalised from |
| `docs/HAZARDS.md` | **L** | every task | The standing hazards by the area each bites -- KNOWN's section 4 until 2026-09-26 (R270, Sprint 14 I5). A hazard is a trap, not a claim; retired in place, never deleted; KNOWN wins on any disagreement |
| `docs/CURRENT_SPRINT.md` | **L** | controller | The live queue and the road to the next tag |
| `docs/HANDOFF.md` | **L** | controller | What a new controller reads first. **Transient since 2026-09-26** (Sprint 14 I3): in flight, owed, the first hour, the rules one line each; rewritten at every handoff under its whole-file `CEILINGS` number (6,000 bytes at Sprint 14 I3, ratcheted since: 5,900 at 2026-09-27; check 7). Holds the **ruling counter**, checked mechanically |
| `docs/HUMAN_TASKS.md` | **L** | controller | The owner's queue |
| `docs/UPSTREAM.md` | **L** | controller | The register of bugs to report upstream, by vendor (owner, 2026-09-26): only a defect located at `path:line` on the vendor's `main`, with its draft and patch in `docs/research/assets/63-upstream-drafts/`, its local status checked against the tree, its confidence, and "not filed" until the owner files it (`docs/HUMAN_TASKS.md` O10). Feedback that is not a bug and the research on open PRs live beside the drafts (`NOT-UPSTREAM.md`, `OPEN-PRS.md`); a vendor's `main` moving or a patch entering the tree changes a row |
| `docs/DEVELOPING.md` | **L** | controller | **Owns the suite counts.** No other registered document may state them |
| `docs/INSTALL.md` | **L** | controller | The player's setup page. Live because it quotes the launcher's own sentences and describes a download that does not exist yet — the "get the archive" paragraph changes the day the distribution decision is answered |
| `docs/FAQ.md` | **L** | controller | The player's failure page. Every exit-code sentence is quoted from `ps2x/exit_codes.h`; a change to that table changes this file |
| `docs/story/PICTURES.md` | **L** | story | The inventory of what `STORY.md` shows; the citation test keeps them honest |
| `docs/KNOBS.md` | **G** | `tools_py.knobs` | Generated from `ps2x/knobs.h`; a test fails on a stale row, an unregistered read or a row nothing reads |
| `docs/LADDER.md` | **G** | `ladder_ledger.py` | One row per ladder run, written from `logs/ladder/ledger.jsonl`, committed by a person. The scheduled ladder is retired (R294, R296: its Task Scheduler entry stays disabled), so rows come from hand-started runs only |
| `docs/BACKLOG.md` | **G** | `tools_py.issues backlog` | The carry's one home (R267): the open issues with their milestone, carried count and closing bar, then `docs/backlog_ruled_out.txt` as a second table. Regenerated and committed at every sprint close (§7 step 5) and whenever the list changes; `backlog --check` exits 1 on a stale file, and the docs test runs its `--offline` half |
| `docs/backlog_ruled_out.txt` | **L** | controller | Not a markdown file, registered because it is the source `docs/BACKLOG.md` renders: one row per unfinished item ruled not to be an issue, with its ruling (an R-number or `no issue`) and its bar. A row leaves it when it becomes an issue or a task |
| `docs/LATER.md` | **L** | controller | The candidates nobody has committed to (the owner, 2026-09-26): one table by value, size and confidence, each row with the trigger that promotes it, then the dismissals the owner confirms or strikes. One home per item: an issue lives in `docs/BACKLOG.md` and a task in its plan, and LATER points at an issue by number. The loop adds a row when a plan, a review or a note names future work; a row leaves when it becomes an issue or a task; the sprint close re-sorts it |
| `docs/RULINGS.md` | **G** | `tools_py.rulings` | Every ruling with its status (active, superseded, retracted, withdrawn, vacant) and its home, global newest first, then the `S13-R<n>` and `S12-R<n>` namespaces; held to `docmaint.ruling_records()` by `rulings --check` (exit 1 on a stale file). Regenerate in the commit that makes or changes a ruling; `--check` in the close. Sprint 14 D1 |
| `docs/CHANGELOG.md` | **G** | `tools_py.changelog` | Every merge commit, grouped by the oldest `v*` tag that contains it, newest first: the first-parent line and the lines of the branches those merges brought in (agent branches, `main` merged into a sprint). Held to `git log` by `changelog --check` (exit 1 on a stale file); the suite holds the page to a render of the commit that last wrote it. Regenerate at every merge to a sprint branch (the merge's follow-up commit) and at the close. Replaced STATUS's hand-written log. Sprint 14 S1, R272 |
| `docs/FLOW.md` | **G** | `tools_py.flow` | How work moves, measured from git with the review's note 03 methods: merges per day, fix rounds per merge (on the merged branch), " again" subjects, the docs share of seven days' churn, the lock's median ticket wait, open-issue age, sessions and commits per session; every number names its command, descriptive, no targets. It names the commit it was rendered at and `flow --check` (and the suite) re-render there (exit 1 on a stale file); `--check --rev HEAD` asks whether it is current. Regenerate at the close. Sprint 14 M1 |
| `docs/SITTING.md` | **G** | `tools_py.sitting` | The owner's sitting page: the open O rows of `docs/HUMAN_TASKS.md` with their defaults and days waited (struck rows listed as answered), the rows past two sittings marked to close by default (R271, §7 step 8), the active rulings since the latest date on HUMAN_TASKS' `last sitting:` / `sittings:` stamp (dated, or placed by the counter or their home's date; the unplaceable counted), the issues at `Carried` 2 or more in `docs/BACKLOG.md`, and the build `docs/PLAYTEST.md` names or **NOT BUILT**. The suite holds it to its sources at the commit that last wrote it; the loop regenerates it when an O row, a ruling or the backlog changes (loop-iteration step 6), and `sitting --check` exits 0 at the close (sprint-close, the known-issue review's step 7). Sprint 14 D3 |
| `docs/ROADMAP.md` | **N** | controller | Narrative and pointers only. Rewritten 2026-09-22; its §0 is the audit of what it replaced |
| `docs/STORY.md` | **N** | story | Every entry cited; `tools_py/story/cite.py` fails on a dead hash or an unwitnessed run |
| `docs/HOW_IT_WAS_BUILT.md` | **N** | controller | How the project was made, for a stranger: the method, the owner's share and the agents', and the process failures worth keeping. Pointers only — the live documents own every current number. `README.md` links it |
| `docs/GIT_STRATEGY.md` | **C** | controller | Branches, slices, releases. Carries the sprint-close step that invokes this file |
| `docs/LOOP_PROMPT.md` | **C** | controller | **A pointer since 2026-09-26** (Sprint 14 I2): under 2,000 bytes, naming the four skills in `.claude/skills/` that hold the procedure now (`SkillsTest` holds both). Carries no state at all — the model for C. Rewritten 2026-09-20 after the old one aimed the loop at Sprint 6 for six days |
| `docs/PLAYTEST.md` | **C** | controller | The owner's one-sitting script |
| `docs/DOC_MAINTENANCE.md` | **C** | controller | This file |
| `docs/story/release-entry.template.md` | **C** | story | A template |
| `docs/story/UPDATING.md` | **C** | story | The procedure for a new story entry, end to end: write, picture, witnesses, cite, then the site built from this directory |
| `docs/parity/REPORT.md` | **S** | — | One parity run from 2026-09-07. Banded 2026-09-22 — it had read as the project's parity status for fifteen days |
| `docs/parity/NOTES.md` | **S** | — | Dated spike notes, append-only |
| `docs/archive/README.md` | **A** | — | |
| `docs/archive/ROADMAP-sprint-4-to-sprint-7.md` | **A** | — | Fifteen files cite it; every `ROADMAP.md §N` written before 2026-09-22 means this file |
| `docs/archive/CURRENT_SPRINT-to-sprint-8.md` | **A** | — | |
| `docs/archive/LOOP_PROMPT-to-2026-09-26.md` | **A** | — | Cut 2026-09-26 (Sprint 14 I2): `docs/LOOP_PROMPT.md` verbatim before it became a pointer, superseded by the four skills. Every "LOOP_PROMPT step N", "Every iteration" or "Lock protocol" cited before that day means this file |
| `docs/archive/HANDOFF-to-2026-09-26.md` | **A** | — | Cut 2026-09-26 (Sprint 14 I3): the whole `docs/HANDOFF.md` verbatim before it became transient -- §5's rules with their reasons, §6's traps (now `docs/HAZARDS.md`), §7's instruments (now DEVELOPING). Every HANDOFF section, rule or trap cited before that day means this file |
| `docs/archive/HANDOFF-loop-history-to-2026-09-25.md` | **A** | — | Cut 2026-09-25 (Sprint 13 Task R1, R268): HANDOFF §2's older pick-up points, §4 and §10, verbatim |
| `docs/archive/HUMAN_TASKS-to-2026-09-25.md` | **A** | — | Cut 2026-09-25 (Sprint 13 Task R4): the owner's queue before it became one table, verbatim, under a disposition for each of its 87 items. Every HUMAN_TASKS section, item or line cited before that day means this file |
| `docs/archive/STATUS-log-to-2026-09-26.md` | **A** | — | Cut 2026-09-26 (Sprint 14 Task S1, R272): everything under STATUS's "Current state" block, verbatim as it stood at `04d75f6f` (the dated log, 2026-09-05 to the Sprint 13 close), superseded by `docs/CHANGELOG.md` and the plans' Logs. Every STATUS entry cited by date before that day means this file; line N there is line N-5 here |
| `docs/archive/KNOWN-section-4-to-2026-09-26.md` | **A** | — | Cut 2026-09-26 (Sprint 14 Task I5, R270): KNOWN's section 4, the 104 standing hazards, verbatim as they stood at the split. Every "KNOWN §4" written before that day resolves to `docs/HAZARDS.md` by headline, or to this file as it was |
| `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` | **A** | — | Cut 2026-09-25 (Sprint 13 Task R1, R268): the Sprint 9-11 records, verbatim. The ruling counter reads it (`max_ruling()` scans all of `docs/archive/`) |
| `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md` | **A** | — | Cut 2026-09-26 (the Sprint 14 close, §5 step 5): the Sprint 12 and Sprint 11 CLOSED blocks with Sprint 11's rulings ledger R245-R263 and the `S12-Rn` table, verbatim. The ruling counter and check 10 read it |
| `docs/archive/CURRENT_SPRINT-closed-sprint-13.md` | **A** | — | Cut 2026-09-27 (the Sprint 15 close, §5 step 5): the Sprint 13 CLOSED block, verbatim, so the live file keeps two CLOSED blocks under its ceiling. The ruling counter and check 10 read it |
| `docs/archive/CURRENT_SPRINT-closed-sprint-14.md` | **A** | — | Cut 2026-09-28 (the Sprint 16 close, §5 step 5): the Sprint 14 CLOSED block, verbatim, so the live file keeps two CLOSED blocks under its ceiling. The ruling counter and check 10 read it |
| `docs/archive/HANDOFF-reference-to-2026-09-13.md` | **A** | — | |
| `docs/archive/HANDOFF-2026-09-08.md` | **A** | — | Banded 2026-09-22 |
| `docs/archive/HANDOFF-AUDIT-2026-09-14.md` | **A** | — | Banded 2026-09-22 |
| `docs/archive/2026-09-26-sprint-14-log-to-2026-09-26.md` | **A** | — | Cut 2026-09-26 (`python -m tools_py.docmaint archive-log`, check 7): the oldest 17 entries of `docs/superpowers/plans/2026-09-26-sprint-14.md`'s Log, verbatim; the Log points here |
| `docs/archive/2026-09-27-sprint-16-log-to-2026-09-27.md` | **A** | — | Cut 2026-09-27 (`python -m tools_py.docmaint archive-log`, check 7): the oldest 13 entries of `docs/superpowers/plans/2026-09-27-sprint-16.md`'s Log, verbatim; the Log points here; from 2026-09-28 also the F2, L1b and R1b state cells as they stood at the close, verbatim (the rows rewritten to their outcomes) |
| `docs/archive/HUMAN_TASKS-answered-to-2026-09-27.md` | **A** | — | Cut 2026-09-27 when `docs/HUMAN_TASKS.md`'s ceiling fired (check 7): its ten struck rows (O1, O3, O6, O11–O14, O16, O18, O19), verbatim; the live file points here. Reopenable by number |
| `docs/archive/2026-09-27-sprint-17-log-to-2026-09-29.md` | **A** | — | Cut 2026-09-29 (`python -m tools_py.docmaint archive-log`, check 7): the oldest 19 entries of `docs/superpowers/plans/2026-09-27-sprint-17.md`'s Log, verbatim; the Log points here |

## 4. What is enforced mechanically

`tools_py/tests/test_doc_maintenance.py`, in the Python suite, so it runs in CI and needs no build. Eleven checks, each
aimed at a rot mechanism that actually bit this project (the seventh and eighth are R268's, the ninth and tenth
Sprint 13 Task R3's, all added 2026-09-25; the eleventh Sprint 14 I4's, 2026-09-26):

1. **Registry completeness** — every covered file has exactly one row; every row points at a file that exists. *Catches
   a new document nobody classified, and a row left behind by a move.*
2. **The ruling counter** — `docs/HANDOFF.md`'s "Next free ruling number: R\<n\>" must be exactly `max(R<n>) + 1` over
   the live documents. *Catches the R179-against-R241 collision, which had already happened once.*
3. **Single-source suite counts** — `Total Tests: <n>`, `Ran <n> tests` and `<n>/<n>` baselines may appear only in
   `docs/DEVELOPING.md` -- or, in any other registered document, with a date on the line or under a dated heading.
   Only A rows are exempt (archives, verbatim records); a registered S row is held to the date rule, and the
   snapshots classified by location (research, plans, audits) have no row and are not read. `docs/STATUS.md` has no
   exemption since its log was archived (2026-09-26, R272). *Catches the 686/686 defect, in all four places it had reached.*
4. **Snapshots are dated** — every S file has a date in its filename or in its first fifteen lines. *Catches a
   `REPORT.md` that reads as the current report.*
5. **Archives announce themselves** — every A file says "archived" or "superseded" in its first fifteen lines, in any
   case. *Catches an archive that reads as live.*
6. **No dangling `docs/` path** — every backticked path starting `docs/` in a markdown file at the root or under
   `docs/`, and in the live procedures -- `.claude/skills/**/SKILL.md` and `.claude/agents/*.md` (Sprint 14 I2) --
   must exist in the tree. *Catches the citation a move left pointing at nothing* — which is why the Sprint 1–6
   specs and plans sat under `docs/superpowers/` for a sprint after they were dead: nobody could move them without
   breaking citations nothing would catch. It found 44 on the tree the day it was written, in fifteen documents.
7. **Ceilings on the appending documents (R268)** -- `docs/CURRENT_SPRINT.md`, the "## 2." section of
   `docs/HANDOFF.md` and the whole of it (its `CEILINGS` number: 6,000 bytes at Sprint 14 I3, ratcheted since, 5,900 at 2026-09-27; the file is transient), the "## Current state"
   block of `docs/STATUS.md` and `docs/HUMAN_TASKS.md` each have a byte
   ceiling (`CEILINGS` in `tools_py/docmaint.py`, counted with LF line ends; the failure prints the measured size). A
   measured heading that has gone fires too, so renaming it cannot switch the ceiling off. *Catches the stack nobody
   retires:* on 2026-09-25 the sprint file was 190 KB with about 12 % of it live, HANDOFF §2 held twelve pick-up
   points and three of them said "now", and STATUS's "keep it short" block was 30 KB. The ceilings were set at that
   day's split (Sprint 13 Task R1) with about 25 % headroom. **When one fires, archive the oldest blocks** (a banner,
   a registry row, the citations re-pointed) -- never raise the number to make it pass; a lower number after a cut
   (Task R4 for HUMAN_TASKS) is the only edit it expects. **The ratchet (Sprint 14 S3): at each close,
   `python -m tools_py.docmaint ratchet` proposes the numbers** (live plus ten percent, rounded up to 100, never above
   the current one); **the close commits them with `ratchet --write`** (it rewrites only the numbers in `CEILINGS`,
   and refuses a rise); **a ceiling never goes up.** S3 added three whole-file ceilings: `docs/LOOP_PROMPT.md` 2,000
   (a pointer since I2), `CLAUDE.md` 4,900 (4,453 plus ten percent, the byte twin of its sixty-line test) and **the
   open plan** -- the plan named on `docs/CURRENT_SPRINT.md`'s `plans:` line, resolved at run time (`OPEN_PLAN`),
   set at 92,000 at the open (the Sprint 14 plan's 83,025 plus ten percent); the ratchet rounds it to 100 like
   the rest, so its first proposal on 2026-09-26 was 90,900. **R279: the open plan's ceiling is one number in
   `CEILINGS` like the others: ratcheted at each close from the closing plan's size (before `docs/CURRENT_SPRINT.md`'s
   `plans:` line switches to the next plan) and carried to the next plan, never raised; when a plan's ceiling fires
   mid-sprint the remedy is `docmaint archive-log` on its Log, never a raise.** The ratchet is the last step before
   the close-out commit, after the close's own edits, and `python -m tools_py.docmaint` must print OK after it.
   **When the plan's ceiling fires,** its
   Log's entries older than the newest ten move verbatim to `docs/archive/<plan>-log-to-<date>.md` (a banner, a
   class A row) and the Log keeps a one-line pointer where they were:
   `python -m tools_py.docmaint archive-log --plan <path> [--keep 10]` does exactly that, leaves the ten newest
   entries byte-identical, and refuses when the Log is not the plan's last `## ` heading. The Log must stay last.
8. **"merged to `main` as `vX.Y.Z`" names a tag origin has (R268)** -- every such phrase in an L document is checked
   against `git ls-remote --tags origin`; a struck-through claim is a retraction and is skipped. *Catches a close
   recorded before it happened:* on 2026-09-25 four live documents said Sprint 11 was merged as `v0.11.0` while no such
   tag or merge existed, so nobody was prompted to do either. It needs the network: when origin cannot be reached the
   check is **skipped out loud** (`python -m tools_py.docmaint` prints `tags: SKIPPED` with the reason, and the unit
   test reports a skip), never passed silently.
9. **One number, one ruling (Sprint 13 R3)** -- no ruling number is *defined* twice; the failure prints every
   location. *Catches the collision the counter cannot see:* check 2 proves only that the next number is free, and on
   2026-09-25 the audit found R107, R109 and R110 each issued by two Sprint 8 plans for unrelated decisions (and this
   check found R108 issued twice inside one of them). A second issue is **recorded, not renumbered**: its definition
   line carries "cited as R\<n\>b", the check counts that line as R\<n\>b, and every citation that means it says R\<n\>b.
10. **A cited ruling has a text (Sprint 13 R3)** -- every R\<n\> (and R\<n\>b) cited in the documents check 2 reads,
   up to the highest in use, has a definition, a ledger row, or a vacancy note `R<n> -- vacant: <reason>` in the plan
   or ledger that owns its range. *Catches a decision nobody can find to overturn:* R114, R116 and R124 were cited for
   a week with no findable text; the check also found R112, R113 and R139 in the same state.
11. **The read-first budget (Sprint 14 I4)** -- what a new controller reads before acting sums to at most 160,000
   bytes (`READ_FIRST_BUDGET` in `tools_py/docmaint.py`, LF-counted like the ceilings). The set: the pinned
   `READ_FIRST` (`docs/HANDOFF.md`, `CLAUDE.md`, `docs/CURRENT_SPRINT.md`); the "## Log" block of the plan named on
   `docs/CURRENT_SPRINT.md`'s `plans:` line (its first `docs/superpowers/plans/` path), measured from its heading to
   the end of the file (Sprint 14 S3: a `## ` heading added after the Log cannot shrink it; a test holds the real
   plan's Log last) -- §3 sends a controller to
   "the open plan's Log", and the task sections are consulted per task -- or the whole plan when it has no
   "## Log" heading, so renaming the heading cannot shrink the set; and `docs/STATUS.md`'s
   "## Current state" block only. A test holds the "Read ..." step of HANDOFF §3 ("Your first hour") to the pinned
   paths after HANDOFF itself, so a rewording that drops one fails instead of shrinking the set (a path in another
   step, such as KNOWN in "KNOWN wins", is not a member). A `plans:` path that is not a file is a problem too
   (`read_first_missing`: the line is not backticked, so check 6 never sees it). The report prints each member's
   bytes and the sum, then, for information, the whole plan's size beside the Log block that counts. *Catches the
   review's F1:* on 2026-09-26 HANDOFF's "read first" list summed to 975 KB, a quarter-million tokens before the
   first action, with the minimum useful subset at 268 KB. The day it landed the set was 93,021 bytes (the sprint
   file 61,190; the plan's Log 20,281 of its 80,182). **When it fires, shrink or archive** -- the Log's older
   entries archived, the sprint file split -- never raise the number.

**What counts as a definition (checks 9 and 10).** A line in a document where a ruling is *made* -- HANDOFF §4 rule 9:
a plan's rulings, or `docs/CURRENT_SPRINT.md` when there is no plan, and what `docs/archive/` keeps of both -- in a
house shape: `- **R107** (Task 1): ...`, `**R181 -- ...**`, `- **R169 — ...`, `1. **R237, ...`, a list
`- **R265**, **R266** (...)`, or a bold label anywhere on the line, `**R173:**`, `**Ruling R115: ...`, `**R264** (date,
who): ...`. A citation is not one: `R107's`, `(R107)`, `see **R107**`, `**R238 was wrong**`, `chosen by **R143**:`, a
bold range `**R241–R245**`, a quoted line (`> ...`, where a rewritten ruling keeps its first telling) or a code fence.
A restatement elsewhere (HUMAN_TASKS's summary of the plan's rulings) is not one either. A ledger row (`| R181 | ... |`)
*indexes* a definition: it answers check 10 on its own (R209 and R229 have only their rows) and two rows for one number
fire check 9, but a row beside its plan's bullet is not a duplicate. `S12-R<n>` is Sprint 12's own namespace (R264) and
is not R\<n\>.

`max_ruling()` (check 2) reads every file under `docs/archive/`, top level and subdirectories, as well as the live
documents and the plans: a ruling does not stop existing when its block is archived, and a counter that dropped the
newest archived ledger would walk backwards.

**Check 6's exception, and its scope.** A path that does not exist *yet* is legitimate in a plan or a design: put
`<!-- docmaint: future -->` on that line and the check skips it, so the exception is visible in the document itself
rather than in a list somewhere. A struck-through path (`~~`…`~~`) is a retraction and is skipped too. The scan is
deliberately narrow, because a check with false positives gets switched off: a locator is not part of the path
(`docs/KNOWN.md:101` cites a place inside a file that does exist), a glob or a `<placeholder>` names a set rather than
a file, and a token whose last segment has no extension is a directory or the house shorthand for a research note by
number (`docs/research/19`) — a directory named in a design document is a proposal, not a claim. Check 6 is about a
file that moved.

Run it by hand with `python -m tools_py.docmaint`, which prints the registry size, the ruling numbers and every problem.

**Each check is fired once against a planted defect** (`PlantedDefectsTest`: an unregistered document, a row whose file
is gone, a colliding ruling number, an undated count, an undated snapshot, a silent
archive, a silent file in an archive subdirectory, a dangling `docs/` path in a `docs/` file and in a root file, a ruling
defined twice, a cited ruling with no text, a read-first set of 180 KB — plus
the negative controls that must *not* fire, and a clean-tree control for the controls). A gate
that has never failed is not known to work, and this one found two real defects and one bug in its own test on the day
it was written.

**A limitation, stated rather than hidden.** Check 3 guarantees a count has *one home and a date*; it cannot tell
whether the number in that home is still right — the only way to know is to run the suite, which is §5 step 2's job.
This was demonstrated the hour the check was written — on 2026-09-22 the suite came back `Ran 1832 tests` while
`DEVELOPING.md` still carried the previous day's number. That is why the Python row now says **`OK`, with no failures, is the bar** and treats
the count as a dated fact that only grows. Prefer a bar a reader can check over a number they must match.

**One check lives outside the suite on purpose.** `python -m tools_py.issues audit` holds the known-issue stack on
GitHub to the live documents (§7; the conventions are `docs/GIT_STRATEGY.md` §7). It needs the network and the
owner's `gh` login, so it is not a unit test: its logic is tested by `tools_py/tests/test_issues.py` on planted stacks
and saved listings, and its run is a step -- before any commit that touches the stack or a `docs/KNOWN.md` row, and in full at the sprint close.

**What is deliberately *not* enforced.** Nothing here fails on a calendar. A test that reddens because a week has
passed gets disabled within a fortnight, and a disabled check is worse than no check because it reads as coverage.
Cadence is §5, a human step with a stamp. Likewise, "an N document contains no live state" is only half mechanical —
the count half is check 3; the rest is a reading, and §5 is where it happens.

## 5. The sprint-close review

**A sprint does not close until this has run and its result is written into the close-out commit.** It is a step in
`docs/GIT_STRATEGY.md`'s close-out, not an optional tidy. Budget: under an hour; it is mostly reading.

1. **`python -m tools_py.docmaint`** — exit 0. If it fails, fix the document, not the check.
2. **Every L document, read for truth**, in this order — `KNOWN.md` (it is audited per task, so this is a spot check),
   `CURRENT_SPRINT.md`, `HANDOFF.md`, `HUMAN_TASKS.md`, `STATUS.md`'s Current state block, `DEVELOPING.md`,
   `README.md`. For each, three questions: *is every claim still true; is anything the sprint closed still listed as
   open; is anything the sprint opened missing?*
3. **`README.md` gets its own pass**, because it is the only one a stranger reads and the only one where being *behind*
   is as damaging as being wrong. Walk README's Status paragraph, sentence by sentence against `KNOWN.md`.
4. **Every N document, read for live state that has crept in.** A number, a task list, a "next", an instruction to go
   and edit another file: move it to its L document and leave a pointer.
5. **Anything superseded this sprint moves to S or A** with a banner naming what replaced it. A document that is
   *wrong* is archived, never quietly deleted — things cite it. **The appending documents in particular** (R268,
   check 7): keep two CLOSED blocks in the sprint file; the third moves to the archive at the close. HANDOFF §2 keeps
   one "now" bullet and STATUS's Current state one dated bullet; the one they replace moves to the archive or the log.
   An announcement draft (§8) posted this sprint has its `Posted:` line filled; one that has stood unposted for a
   whole sprint is raised in the owner's row -- never posted by the loop.
6. **Stamp this file's "Last full review" line** with the date and the sprint, and name in the close-out commit what
   the review changed. A review that changed nothing says so explicitly; that is a result too.
7. **The known-issue stack, in full** -- §7 below. Its result goes into the same close-out commit, in the same
   sentence as this review's.

**When a document is found wrong, record the wrongness, not just the fix.** The audit table in `ROADMAP.md` §0 is the
pattern: what was claimed, what is actually true, how long it had been wrong. That is the only way the next review
knows which documents to distrust.

## 6. Rules for writing, so there is less to maintain

- **A fact has one home.** Before writing a number, ask which document owns it and link there instead. Four documents
  held the suite count; one was right.
- **Prefer a pointer to a copy**, and prefer a generated file to either. `KNOBS.md` and `LADDER.md` have never been
  wrong, because nobody writes them.
- **A document that tells agents what to do is code.** It gets audited like code. The `loop-iteration` skill is opened first by
  every iteration, so it carries no state; `HANDOFF.md` must carry state, so its one dangerous number is now tested.
- **Date anything that is a moment.** A filename date costs nothing and makes the class obvious at a glance.
- **Revise, do not append (R320, 2026-09-27).** In a live document a fact has one row; an update rewrites that row
  to what is true now, with the newest artefact and its date, and the old text lives in git and in the plan's Log
  entry that made the change. A number that moved is a revision. A retraction is one row in `KNOWN.md` §3, written
  when the belief was acted on, never a second copy of the claim it retracts. A hazard a guard now refuses is one
  struck line in place naming the guard and the date. The procedure at the moment of writing is the
  `doc-maintenance` skill (`.claude/skills/doc-maintenance/SKILL.md`). Blockquoted supersession — say what replaced
  the claim, keep the text — is for the narrative documents, where the reasoning is the content: the archived
  roadmap is readable *because* its wrong turns are still in it. A ruling is never rewritten, only amended by a new
  one. Until 2026-09-27 this bullet read "supersede in place, never rewrite history: blockquote the old claim, keep
  the text" for every document; `docs/audits/2026-09-27-documentation-surfaces.md` §3 shows what that produced.
- **If a claim cannot be checked, do not make it.** "The game runs well" ages badly; "43-45 fps in a mission,
  measured on <date>, against the console's 60" does not — it simply becomes a dated fact.
- **A ruling is narrow, and it has one counter.** A ruling records a moved owner default, a moved acceptance bar or a
  moved spec goal. A threshold, a skipped measurement, a naming choice or a tool's behaviour is not a ruling: it is a
  KNOWN row with its artefact, a knob default in the registry, or a test. From Sprint 14 the global counter is the
  only namespace (R273); a ruling is written in the sprint plan's Rulings section, numbered from `docs/HANDOFF.md`
  section 2 (the one counter line, check 2), with the counter bumped and `docs/RULINGS.md` regenerated
  (`python -m tools_py.rulings`) in the same commit. `docs/RULINGS.md` is the index, generated; nobody keeps one by hand.

## 7. The known-issue stack review — deep, at every sprint close

`docs/GIT_STRATEGY.md` §7 puts every technically well-defined, unresolved defect on GitHub issues, one each, cited
from its `docs/KNOWN.md` row as `issue #N`. Between closes the loop keeps the pair true per task (the `loop-iteration` skill's
step 6). At the close the whole stack is read, because an issue tracker rots exactly the way a document does: a
fixed thing left open, an open thing nobody owns, a bar that no longer says what would close it, a milestone that
became a wish list. This runs beside §5, under the same rule (a sprint without it is not closed), and its result is
written into the same close-out commit. Budget: about an hour for a stack under fifty, which holds only because
step 3's §4 half is limited to the `HAZARD` / `Open:` headlines (the first run of the unlimited scan listed 75 of
§4's 84 bullets, nearly all lessons). A fresh read-only agent can do steps 2-4 and hand back a table; the controller
acts on it.

1. **`python -m tools_py.issues audit --stale-since <the day the sprint opened>`** — exit 0 before anything else. A
   problem is fixed on the side that is wrong: the row, the citation, the label, or the issue. Never the check.
2. **Every open issue, read against the tree.** Four questions each, answered in a comment only when the answer
   changes something. *Is it still true?* — a commit may have met the bar without saying `Closes`: close it with the
   artefact. *Is the bar still the right bar?* — the experiment may have been superseded: rewrite the Closing bar
   section and say why. *Is the evidence still where the body says?* — an archived log moved to `D:`: say where.
   *Is the area right?*
3. **Every KNOWN §2 row and every live hazard in `docs/HAZARDS.md` (by area), the other way round.** Each either
   cites an open issue, cites a closed one and reads as settled, or is ruled not to qualify — and the audit's "rows
   neither cited, settled nor ruled out" list is exactly the set to rule on. A row ruled out says why in a few words
   at its end (*no issue: the owner's ears*; *no issue: a lesson, nothing left to fix*), so the next review does not
   re-ask. In `docs/HAZARDS.md` the audit lists only a bullet whose headline says `HAZARD` or `Open:` — the two forms
   KNOWN already uses for a hazard that is still live — because most of the hazards are lessons, which
   `docs/GIT_STRATEGY.md` §7.1 keeps out of the stack; a hazard that is a live defect is written in one of those two
   forms, or the audit will not ask about it.
4. **Every issue closed this sprint** (`gh issue list --state closed --label known-issue --search "closed:>=<open
   date>"`): its closing comment names an artefact, and the KNOWN row says the same thing. A close with no artefact is
   reopened -- **unless the owner closed it.** An owner's close stands (the owner can overturn the loop, never the
   reverse: `CLAUDE.md`'s opening lines -- no `docs/HANDOFF.md` §4 rule states it; rule 13 is the owner-only
   actions), and the row records their words in place of an artefact, struck and led with the verdict, as
   `docs/KNOWN.md`'s dropped rows are. The audit notes every completed close whose last comment is not the tool's
   "Closing bar met" line, so the reviewer sees the case instead of acting on it blind.
5. **The carry.** What is still open in the closing sprint's milestone either moves to the next sprint's milestone
   (because the next plan names it) or to no milestone (the backlog) — with the `carried` label and one comment
   saying why it did not close. Then the milestone is closed and the next sprint's is created. **An issue carried
   twice is a question for the owner** (`docs/HUMAN_TASKS.md`): keep it, or close it as not planned under a ruling.
   Two commands do it: `python -m tools_py.issues carry N --comment "..." [--milestone "Sprint N+1"]` for each
   issue (label, comment and milestone at once; it refuses an issue already carried twice), then
   `python -m tools_py.issues milestone close "Sprint N" --next "Sprint N+1"` (it refuses while an open issue is
   left in it). A third records it: `python -m tools_py.issues backlog` regenerates `docs/BACKLOG.md` (R267), the carry's one home, and the close-out commit carries it; an
   item ruled not to be an issue goes into `docs/backlog_ruled_out.txt` with its ruling and bar.
6. **Duplicates and contributor handles.** Merge duplicates (close as not planned, "duplicate of #M"; the survivor
   gets the evidence). Put `help wanted` on what a stranger without a disc could take, `good first issue` only where
   the bar is a test they can run themselves.
7. **The record.** The close-out commit and the plan's Log (and STATUS's Current state bullet) say, dated: opened, closed and carried this
   sprint, the highest issue number, and what the review changed. A review that changed nothing says so. The
   first half is `python -m tools_py.issues tally --since <the day the sprint opened>`, one sentence to paste.
8. **The circuit breaker (R271).** An O row that has stood through two sittings without an answer is closed by
   default under a ruling, struck with the date and the default that now stands; the owner can reopen it by number.
   `python -m tools_py.sitting` marks such a row in `docs/SITTING.md` §1 "closes by default at the next close
   (R271)" -- two dates on HUMAN_TASKS' stamp line strictly after its first-asked date (a sitting on the day a row
   is asked has not seen it) -- and only marks. The close strikes each marked row by hand in `docs/HUMAN_TASKS.md` under a new ruling from HANDOFF's counter (the default
   column struck, the second column ending "**Closed by default under R<n>, <date>: <the default>; reopen by
   number.**"), then regenerates the page. The stamp is one line: `last sitting: <date>` after the first sitting,
   `sittings: <date>, <date>, ...` (oldest first) from the second; a sitting appends its date.

## 8. The surfaces outside the tree — the wiki and Announcements (R318, R319, 2026-09-27)

The repository's wiki and its Discussions were enabled by the owner on 2026-09-27. Neither is part of the tree: the
wiki is its own git repository, created the first time a page is saved in the web UI; a Discussion is a post. Nothing
an agent, a hook or a check reads can live on either, because an implementer in a worktree cannot see them, a change
there cannot land in the commit that changes the code, and no guard fires on them. The decision and its evidence are
`docs/audits/2026-09-27-documentation-surfaces.md`.

**The wiki holds human prose (R318).** The test for a page: *it may go to the wiki when deleting it would change
nothing any agent, hook or check does.* Candidates are the N documents a stranger reads once (`docs/HOW_IT_WAS_BUILT.md`,
`docs/ROADMAP.md`) and pages the tree has never had (an architecture overview). `docs/STORY.md` is not one: the site
builds from it and a test holds its citations. A page is shaped by `docs/templates/wiki-page.md`: no live state, no
live numbers, no task lists — it points at the tree's owning document. A moved document leaves a one-paragraph
pointer at its old path (things cite it; check 6) and its registry row says so. **The owner pushes**: drafts are
written in the owner's clone of the wiki repository, and a push to it is a publication (`CLAUDE.md` Boundaries).

**Announcements stand in for patch notes and site announcements for now (R319).** A draft is
`docs/announcements/<YYYY-MM-DD>-<slug>.md`, shaped by `docs/templates/announcement.md`: what a reader can do now,
how to try it, the honest edge from `docs/KNOWN.md` §2 and the component's own gaps, dated milestones, undated
goals, where to report. The loop drafts and adds a row to `docs/HUMAN_TASKS.md`; **the owner posts**, in
Discussions → Announcements; the draft's `Posted:` line then takes the URL and the date and the file stays as the
record. `AnnouncementsTest` holds every draft to its filename date and its `**Publish:** the owner` line, so a draft
cannot lose its gate by editing. The first draft is the map viewer's, `docs/announcements/2026-09-27-map-viewer.md`.
