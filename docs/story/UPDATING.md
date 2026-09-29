# Updating the story

How `docs/STORY.md` -- the project's development story, published as `/story.html` on socomunzipped.com -- gets a new
entry, end to end. The story is written and cited here; the site is built from it. There is one copy of the story's
data and pictures: this directory.

1. **Write the entries** in `docs/STORY.md`, in date order, one picture per entry. No GS/IOP/VU1 jargon outside the
   *How:* lines. A cite fragment must be words from the real commit subject; a commit from another day gets
   `(YYYY-MM-DD)` after the hash.
2. **The picture.** `git add` any new picture under `docs/story/img/` (`tools_py/story/cite.py` requires it tracked) and
   add its row and the Total line to `docs/story/PICTURES.md`.
3. **Witnesses.** `python -m tools_py.story.witness --captured <date>` freezes witnesses for new run, gate and log
   citations (`docs/story/witnesses.json`).
4. **The timeline.** Regenerate `docs/story/timeline.json` with `python -m tools_py.story.timeline`. Never edit it by
   hand.
5. **The citations.** `python -m tools_py.story.cite`, then `python -m unittest tools_py.tests.test_story_cite`.
6. **The pages.** `python -m tools_py.story.site` rewrites the repository's copy, `docs/story/index.html` (the design
   system from `web/shared/ds` inlined). The site's copy needs no hand step: the landing build
   (`web/landing/tools/prepare.mjs`, run by `npm run dev`, `npm test` and `npm run build -w landing` in `web/`) copies
   `docs/story/img/*`, `docs/story/timeline.json` and the logo into its ignored `public/` paths and generates
   `web/landing/story.html` with `python -m tools_py.story.site --full-document` at build time. The live page changes
   when the site is deployed (`web/shared/deploy/site/deploy.sh`, the owner's step).
7. **Commit** with an explicit pathspec (`git commit -- <paths>`): other sessions edit this tree concurrently.

Where the earliest frames are: `D:\socom_archive` holds nothing before 2026-09-10 (its root `run_*.log` files from the
4th and 5th are text). The evening of 2026-09-05 survives only in `logs/host_cpu` (software rasterizer, 19:20) and
`logs/host` (OpenGL backend, 19:27), and 2026-09-07 in `logs/shots_live` and `logs/parity/runs/ours_*`, all on the
build machine and git-ignored. All three are cited with witnesses, so the citation test notices if they are archived.
