---
name: doc-maintenance
description: Use before writing into a living document -- docs/KNOWN.md, docs/HAZARDS.md, docs/LATER.md, docs/UPSTREAM.md, a sprint file's rows -- to record a finding, a moved number, a settled belief, a retraction or a hazard a guard now refuses; when a document ceiling fires; and when something is meant for readers outside the tree (a wiki page, a GitHub Discussions announcement, a patch note).
---

# Documentation maintenance -- revise, do not append

**A fact has one row. An update rewrites that row to what is true now. History is git's.** The contract is
`docs/DOC_MAINTENANCE.md` (the classes, the registry, the eleven checks, the close review); this skill is the
procedure for the moment of writing. It carries no state.

**Why this exists.** Two agents given the old rule ("blockquote the old claim, keep the text") and one task's
findings turned 3 proven rows into 4 rows, 2 blockquotes and 2 retractions, and stacked a GUARDED paragraph under
every hazard a hook now refuses -- each explained as preserving history. Sixteen sprints of that is 191 KB of KNOWN
and 113 KB of HAZARDS. R320 changed the rule; the record is `docs/audits/2026-09-27-documentation-surfaces.md` §3.

## Writing into an L document (KNOWN, HAZARDS, LATER, UPSTREAM, the sprint file's rows)

1. **Find the row first.** `grep -n` the subject (the path, the number, the knob, the trap) in the document. One
   row exists: the edit is to that row. None exists: one new row. Two exist: merge them into one in the same edit.
2. **The rewritten row says what is true today**, with the newest artefact and its date. The older number stays as
   one clause -- *(was 21.4 ms on 2026-09-24)* -- when the change is itself the finding (a speed-up, a regression) or
   the row's meaning is the comparison. Nothing else of the old text survives in the document.
3. **Confirming evidence changes nothing.** A gate that passed again, a claim re-observed: the row stands untouched.
4. **A number that moved is a revision, not a retraction.** Rewrite the row.
5. **A belief that settled** moves: its one row leaves §2 and appears in §1 (proven, with the measurement) or in §3
   (retracted) -- never in two sections, never as a blockquote under the table it left. A belief that was half right
   is one §1 row carrying both halves, where the measurement now stands. **A §3 row is written only when the false
   belief was acted on** -- work was planned or run on it, or a ruling, an issue or a STORY entry cites it -- and
   then the row is the lesson: what was believed, what killed it, with the date. §3 is allowed; it is not a second
   copy of §1.
6. **A hazard a guard now refuses** becomes one line, struck, in place -- the trap, when it bit (one clause), the
   guard and its date:
   `- ~~HAZARD: a bare git add stages another session's edits~~ (6b7a2b3, 2026-09-21) **guarded since 2026-09-24** by
   the Bash hook (`tools_py/hooks/pretool.py`, `test_hooks.py`); live by hand outside the Bash tool.` That is what
   "retired in place, never deleted" means. The guard's date is the commit that landed it, read from `git log`, not
   the brief. **One mechanism, one bullet:** a new trigger of a known trap is a clause in the
   existing bullet, not a bullet of its own.
7. **The size test before the commit:** `git diff --stat -- docs/KNOWN.md` (or the file you touched). Insertions
   minus deletions must not exceed the number of genuinely new facts. Larger means you appended: go back to step 1.
8. **Say where the old telling went.** The plan's Log entry for the change names the row and what it said before,
   in one clause; `git log -p -- docs/KNOWN.md` has every version. A reader who needs the old text has both.

**Where the old shape still belongs.** Narrative documents (N: `docs/ROADMAP.md` §0, `docs/STORY.md`) supersede
with a dated blockquote, because the reasoning is the content. A ruling is never rewritten: a new ruling amends it
("R317 amends R316"), and `docs/RULINGS.md` is regenerated. HUMAN_TASKS strikes an answered row (the sitting's
record) and archives it when the ceiling fires. `docs/UPSTREAM.md` and `docs/LATER.md` rows leave the file when they
become an issue or a task -- one home per item.

## The reasons agents give, and the answer

| The reason | The answer |
|---|---|
| "Rewriting the row would erase history" | Git holds every version and the Log names the change. The document is the present. |
| "It was true for its build, so it is superseded, not retracted" | Yes: a superseded number is the row rewritten, with the date on the new number. |
| "It was half right, so it goes in two places" | One row, in the section where it stands now, carrying both halves. |
| "Folding it in would hide a different trigger and date" | The bullet lists its triggers; the dates are in git. One mechanism, one bullet. |
| "Guarded rather than retired, because the hook only sees the Bash tool" | Say so in the struck line. Still one line. |
| "I added the new gate as more evidence" | Evidence that changes nothing changes nothing. |
| "The auditors complained about unrecorded findings" | They complained about findings with no row. A rewritten row is recorded. |

**Red flags -- stop and revise:** a blockquote under a table in an L document; "supersedes the row below"; a second
bold label under a bullet; the same path or number typed twice in one edit; `--stat` growth larger than the count of
new facts.

## Ceilings (DOC_MAINTENANCE check 7)

When `python -m tools_py.docmaint` reports a ceiling fired: archive the oldest block (a banner, a registry row, the
citations re-pointed; `docmaint archive-log` for a plan's Log; a struck-rows file for HUMAN_TASKS), then run it again.
**Never raise the number.**

## Outside the tree (R318, R319)

- **The wiki** holds human prose. The test: a page may go there when deleting it would change nothing any agent, hook
  or check does. Draft in the owner's clone of the wiki repository from `docs/templates/wiki-page.md`; leave a
  pointer at a moved document's old path; **the owner pushes**.
- **Announcements** (Discussions -> Announcements) are the patch notes and site announcements for now. Draft
  `docs/announcements/<YYYY-MM-DD>-<slug>.md` from `docs/templates/announcement.md`, add a row to
  `docs/HUMAN_TASKS.md`; **the owner posts**. When posted, fill the draft's `Posted:` line. Nothing posts on its own
  (`CLAUDE.md` Boundaries).

At every sprint close the whole tree is read under `docs/DOC_MAINTENANCE.md` §5, by the `sprint-close` skill.
