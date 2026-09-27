# The announcement -- template (R319)

An announcement is the project's patch note and site announcement for now, posted in GitHub Discussions under
**Announcements**. The loop drafts; **the owner posts** (`CLAUDE.md` Boundaries: no publishing). A draft is a file
`docs/announcements/<YYYY-MM-DD>-<slug>.md` (class S by location, DOC_MAINTENANCE §2), and a row in
`docs/HUMAN_TASKS.md` asks for the click. When posted, the owner or the loop fills the `Posted:` line with the URL
and the date; the file stays as the record. `AnnouncementsTest` in `tools_py/tests/test_doc_maintenance.py` holds
every draft to the date in its filename and to the `Publish:` line below, so a draft cannot lose its gate.

Rules for the text: lead with what a reader can do now; every claim cites a commit, a tag or an issue; a number
carries its date; the honest edge comes from `docs/KNOWN.md` §2 and the component's own known gaps, never softened;
no sentence a player would not understand in the first two sections.

Copy from the line below.

---

# {{title: what a player or contributor can do now that they could not before}}

**Status:** DRAFT
**Publish:** the owner, by hand, in Discussions -> Announcements. Nothing posts this on its own (R319).
**Posted:** {{URL, YYYY-MM-DD -- filled when it is}}
**Audience:** {{players | contributors | both}}
**Cites:** {{commits, tags, PRs, issues -- short SHAs and numbers}}

## What changed

{{2-4 sentences. The one thing first. Say what ships, for whom, and where it is.}}

## Try it

{{The exact steps or the link. What the reader needs (a disc, a browser, a build). What they will see.}}

## What it is not yet

{{The honest edge, in the reader's terms: what is believed rather than proven, what is not modelled, what has never
been tried. Quote `docs/KNOWN.md` §2 or the component's known-gaps list; do not soften.}}

## Milestones so far

- {{YYYY-MM-DD -- one line each, dated, past tense, with its cite}}

## Rough goals next

- {{one line each, undated, no promises of when; point at the issue or LATER row if one exists}}

## Where to report

{{The bug-report route (the site's REPORT A BUG, the launcher's report, GitHub issues) and the Q&A category.}}
