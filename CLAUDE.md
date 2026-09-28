# SOCOM Unzipped -- read this first

SOCOM II (PS2, US) statically recompiled to a native PC executable, with online play through a Horizon server.
The owner is Craig, who sets the priorities and can overturn any ruling the loop makes on the owner's behalf.
The loop is an autonomous controller session that runs the sprints and dispatches implementer agents into worktrees.
This file is a map, not the state: nothing here changes weekly; each line points at the file owning the fact.

## Where the state lives

- `docs/CURRENT_SPRINT.md` -- what to do: the open sprint, its plan and the road to the next tag.
- `docs/KNOWN.md` -- what is true (proven, believed, retracted) with its artefacts; hazards by area: `docs/HAZARDS.md`.
- `docs/HANDOFF.md` -- the transient handoff: in flight, owed, the rules one line each, the ruling counter.
- `docs/HUMAN_TASKS.md` -- the owner's rows: what only Craig can do.
- `docs/DEVELOPING.md` -- the developer reference: build, run, tests, tools, the guards; it owns the suite counts.
- The open sprint's plan under `docs/superpowers/plans/` (CURRENT_SPRINT names it) -- its `## Log` is the live state.

## Guards -- these refuse, they do not advise (the full rules and planted tests: DEVELOPING "## Guards")

Bash rules: the PreToolUse hook `scripts/hooks/claude_pretool.sh` -> `tools_py/hooks/pretool.py`, test
`tools_py/tests/test_hooks.py`; every hook is wired in `.claude/settings.json`.
- Bulk staging: a bare `git add`, `-A`/`--all`, `-u`/`--update`, a whole-tree pathspec (`.`, `-- .`), `git commit -a`
  (`-A`/`-u` limited by `-- <paths>` pass) -- enforced by: the Bash hook; home `docs/GIT_STRATEGY.md` section 3.
- A commit without `-- <paths>` (allowed mid-merge) -- enforced by: Bash hook; home `docs/HANDOFF.md` section 4 rule 1.
- `--no-verify` and its abbreviations from `--no-v` up, commit `-n`, `-c core.hooksPath=` -- enforced by: the Bash
  hook; home `docs/GIT_STRATEGY.md` section 3.
- A push from a linked worktree; a force push, `+refspec` or delete aimed at `main` or `sprint-*`; `--mirror` --
  enforced by: the Bash hook; home `docs/GIT_STRATEGY.md` sections 2 and 3.
- `loop_lock.sh take`/`release` by hand; `git worktree add/remove/prune` (use `scripts/agent_worktree.sh`); in a
  worktree, a writing `git config` unless `--worktree`, `--global`, `--system` or `--file` -- enforced by: the Bash
  hook; home `scripts/loop_lock.sh`, `scripts/agent_worktree.sh`.
- Edit/Write of an existing `logs/**/*.sh` while the lock is HELD (home `docs/HAZARDS.md` lock); of
  `scripts/loop_lock.sh` when a QUEUED waiter's blob equals this copy's, or the lock is HELD and this is the main
  tree's copy -- enforced by: the hook's Edit/Write entry; home the `scripts/loop_lock.sh` header. Bash edits unseen.
- A commit naming `loop_lock.sh` without a slow-suite marker newer than the script -- enforced by: the Bash entry
  (`rule_lock_script_commit`); home the `scripts/loop_lock.sh` header.
- `gh pr merge --delete-branch` (and `-d`) -- enforced by: the Bash hook; home `docs/HAZARDS.md` git.
- Orphaned watchers (`tail`, `grep`, `sleep`) killed at every Stop and SessionEnd -- enforced by: the reaper
  `tools_py/hooks/reap.py`, test `tools_py/tests/test_reap.py`; home DEVELOPING "Guards", the Sprint 14 plan's G3.
- `build.sh` refuses (exit 3) while another holder has the lock, unless run as its child; the `tools` step is exempt
  -- enforced by: test `tools_py/tests/test_build_sh_lock.py`; home DEVELOPING "Build and run" (the `build.sh` refusal), the Sprint 14 plan's G5.

## Procedures, by name

- `loop-iteration` -- every loop firing, steps in order: `.claude/skills/loop-iteration/SKILL.md`.
- `agent-worktree` -- create, brief, review, merge and remove an agent's tree: `.claude/skills/agent-worktree/SKILL.md`.
- `run-gate` -- a build, a game run or the gate, and its record: `.claude/skills/run-gate/SKILL.md`.
- `sprint-close` -- the two close reviews, the PR and the tag: `.claude/skills/sprint-close/SKILL.md`.
- `doc-maintenance` -- writing into a living document; the wiki; an announcement: `.claude/skills/doc-maintenance/SKILL.md`.

## The lock

One build or game at a time, host-wide, only through `scripts/loop_lock.sh run` (or `scripts/run_detached.sh`); its header is the reference.

## Boundaries

KNOWN wins on any disagreement: when a document contradicts `docs/KNOWN.md`, the document is wrong.
Nothing that is the owner's is performed -- no publishing, no money, no permissions or tokens, no change to the site,
no connection to a server that is not ours (a PSRewired one only by the owner's hand, named and permitted each time:
R293); add a line to the owner's row in `docs/HUMAN_TASKS.md` instead.
Everything else -- building, running, testing, the tools and the conventions -- is in `docs/DEVELOPING.md`.
