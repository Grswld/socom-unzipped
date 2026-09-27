# Documentation surfaces -- the wiki, Announcements and the tree: a decision record (2026-09-27)

**Snapshot.** Written 2026-09-27 for the owner's question of that day ("is the wiki a better surface for human
documentation or agentic documentation, to thin out our mds"), with the sizes measured at `d96c608e` on `sprint-16`.
The rules it produced live in `docs/DOC_MAINTENANCE.md` §2, §6 and §8 and the `doc-maintenance` skill
(`.claude/skills/doc-maintenance/SKILL.md`); the rulings are R318-R320 in the Sprint 16 plan. Read those for what
holds today; read this for why.

## 1. Context

- The repository is public. GitHub's wiki and Discussions (with an Announcements category) were enabled by the owner
  on 2026-09-27. The wiki's own repository does not exist until its first page is created in the web UI.
- `docs/` held 7,955 KB of markdown: 25 top-level files (about 1 MB), and 7 MB under `research/` (86 files,
  2,180 KB), `archive/` (59 files, 2,983 KB), `audits/` (20 files, 802 KB), `superpowers/plans/` (15 files, 727 KB)
  and `superpowers/specs/` (11 files, 274 KB).
- Every guard and procedure reads from the working tree: the four skills, both agent definitions, the Bash PreToolUse
  hook and the commit-msg hook together name `docs/` files 60 times (`docs/GIT_STRATEGY.md` 18, `docs/HANDOFF.md` 9,
  `docs/HAZARDS.md`, `docs/DOC_MAINTENANCE.md` and `docs/CURRENT_SPRINT.md` 6 each). `tools_py/docmaint.py` runs
  eleven checks over them in the Python suite. "KNOWN wins" is enforceable only while KNOWN is where the checks look.
- What a new controller reads before acting is already bounded: the read-first set was 46,166 bytes of a 160,000
  budget (check 11). The 7 MB of snapshots and archives is not on that path; it is read when cited.

## 2. Decision

**The wiki holds human prose. Everything an agent, a hook or a check reads stays in the tree.** The test for a
page: *it may go to the wiki when deleting it would change nothing any agent, hook or check does.* (R318)

Why not the other way round. A GitHub wiki is a separate repository with its own history: an implementer in an agent
worktree cannot see it; a change to it cannot land in the same commit as the code it describes; no PR reviews it, no
hook fires on it, and the commit-msg rule does not apply to a page saved in the browser. Moving KNOWN, HAZARDS or the
sprint file there would undo Sprint 14's direction ("guards, not sentences") in one move.

**Announcements stand in for patch notes and site announcements for now** (the owner, 2026-09-27). A draft is a
dated file under `docs/announcements/` shaped by `docs/templates/announcement.md`; it is posted by the owner's hand
only, from a row in `docs/HUMAN_TASKS.md`; nothing posts on its own (`CLAUDE.md` Boundaries). (R319)

**Revise, do not append.** In the live documents a fact has one row and an update rewrites that row to what is true
now; the old text lives in git and in the plan's Log entry that made the change. This replaces §6's "blockquote the
old claim, keep the text" for the L documents; blockquoted supersession stays for the narrative documents, and a
ruling is never rewritten, only amended by a new one. (R320)

## 3. The evidence for R320: what agents do without a rule

Two Opus implementer agents were given a KNOWN excerpt (3 proven rows, 2 believed, 1 retracted) and a HAZARDS
excerpt (4 bullets), one task's findings each, ten minutes, and the house rule as it stood. No skill.

| Scenario | Before | After | How the agent explained it |
|---|---|---|---|
| KNOWN: a number moved (21.4 -> 16.9 ms), a belief settled half-right, a gate re-passed | 6 rows, 1.6 KB | 7 rows + 2 blockquoted old rows + 1 new retraction; the frame cost written in three places; two unchanged rows given "more evidence"; 3.5 KB | "rewriting the row would erase history"; "true for its build, so superseded, not retracted"; "recorded twice, because it was half right" |
| HAZARDS: two traps now refused by the hook, one new trigger of an existing mechanism, one new trap | 4 bullets | 6 bullets, a stacked **GUARDED** paragraph under each refused hazard, a third bullet for the same junction mechanism | "retired in place, never deleted, so I left every entry word for word"; "folding would hide a different trigger and date" |

Both agents obeyed the rule they were given. The rule was the defect: "keep the text" makes every update additive,
and 191 KB of KNOWN and 113 KB of HAZARDS is what that produces over sixteen sprints. The `doc-maintenance` skill
answers each of the quoted reasons in its table; DOC_MAINTENANCE §6 now carries the rewritten rule.

## 4. Where the weight is, and the verdict on each

| Location | Size (KB) | Read by | Verdict |
|---|---|---|---|
| `docs/KNOWN.md` | 191 | every task (§1-§3 before a hypothesis) | **Target.** Revise-over-append from today; a one-time dedupe sweep at the close (LATER 48) |
| `docs/HAZARDS.md` | 113 | every hypothesis, by area | **Target.** Same rule; guarded hazards become one struck line each |
| `docs/STORY.md` | 136 | the site build (`tools_py/story/site.py`), the cite test | Stays: it is the site's source and a test holds its citations. Not a wiki page |
| `docs/DEVELOPING.md` | 117 | the controller per need; owns the suite counts | Stays. A contents block and anchors would help a human (LATER 51); no move |
| `docs/RULINGS.md`, `CHANGELOG`, `BACKLOG`, `FLOW`, `SITTING`, `KNOBS` | 81 + | generated | Stay; nobody writes them |
| `docs/GIT_STRATEGY.md` | 31 | the hooks and skills, 18 references | Stays; a contract the guards cite |
| `docs/HOW_IT_WAS_BUILT.md`, `docs/ROADMAP.md` | 19 + 21 | nobody mechanical (N) | **Wiki candidates**, with a pointer left in the tree (LATER 49). The yield is about 40 KB: the wiki is a surface, not a diet |
| `docs/FAQ.md`, `docs/INSTALL.md` | 19 + 13 | players; FAQ quotes `ps2x/exit_codes.h` | Stay: both are L, tied to code that changes them |
| `docs/archive/`, `docs/research/`, `docs/audits/` | 2,983 + 2,180 + 802 | when cited; `max_ruling()` and checks 5-6 read the archive | Stay. They are the evidence store and cost nothing on the read-first path. Moving them breaks citations check 6 exists to protect |
| `docs/superpowers/plans/` (closed) | 727 | when cited | Stay (S: supersede, never rewrite). Check 7 already trims the open plan's Log |

## 5. The targets, by priority

| P | Target | Value | Size | Home |
|---|---|---|---|---|
| 1 | Revise-over-append in the L documents: the rule (§6), the skill, the planted expectation in the skill's table | every task's read; stops the growth at its source | done today | R320, the skill |
| 1 | Announcements, human-gated, the map viewer first | the owner's stand-in for patch notes; a stranger hears what changed | S per draft | R319, `docs/announcements/` |
| 1 | The dedupe sweep of KNOWN §1-§3 and HAZARDS under the new rule | the two files every task reads, smaller and single-voiced | M | LATER 48; the Sprint 16 close's §5 step 2 read |
| 2 | The wiki's first pages: Home, an architecture overview (none exists), HOW_IT_WAS_BUILT moved | a contributor's front door | S-M | LATER 49, after O23 |
| 3 | `docs/DEVELOPING.md` contents and anchors | a contributor lands by area | S | LATER 51 |

Considered and rejected: FAQ and INSTALL to the wiki (they are L, tied to code); the closed plans or the archive out
of the tree (the ruling counter and the citation check read them; the read-first budget already excludes them);
mirroring STORY to the wiki (two homes for the same prose).

## 6. Consequences

- New locations, classified by location in DOC_MAINTENANCE §2: `docs/announcements/**` is S (dated drafts, the
  posted URL recorded in the file), `docs/templates/**` is C.
- The owner's page gains O23: post the first announcement; create the wiki's first page, which creates its repository.
  The struck rows the page had accumulated moved to `docs/archive/HUMAN_TASKS-answered-to-2026-09-27.md` to make
  room under its ceiling, as check 7 prescribes.
- `CLAUDE.md` names a fifth procedure; `SkillsTest` and `ClaudeMdTest` hold it like the other four.
- The `doc-maintenance` skill is the procedure; DOC_MAINTENANCE stays the contract. Neither repeats the other.
