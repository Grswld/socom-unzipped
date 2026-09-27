---
name: agent-worktree
description: Give an implementer agent its own worktree and take its work back -- use whenever the controller dispatches a task to an agent: create, brief, fresh review, merge by the controller, suite on the merged tree, remove, delete the branch.
---

# An agent's worktree, from create to remove

The controller does every step here except the agent's own work. Sources: `docs/archive/HANDOFF-to-2026-09-26.md` §5 "Giving an agent a
worktree", the open sprint plan's Global Constraints, `scripts/agent_worktree.sh`'s header, `docs/GIT_STRATEGY.md` §2.

*Why a script and not a recipe (the archived HANDOFF §5, 2026-09-21):* a worktree is a second tree with the same scripts in it.
One agent pushed and merged to `main` three times against an explicit "do not push"; `git worktree remove` deleted
the toolchain THROUGH a surviving junction twice. The script makes both impossible; the Bash hook refuses
`git worktree add/remove/prune` by hand.

## Steps

1. **Create**, from the main tree, off the sprint branch:
   `bash scripts/agent_worktree.sh create <name> [base-ref]` -- `C:\projects\wt-<name>`, branch `agent/<name>` off
   the base (default `HEAD`); the push URL dead (`no-push://agent-worktree`, set with `git config --worktree`, never
   a bare `git config`, which would write the shared `.git/config`); `tools/` junctioned in and nothing else -- never
   `game/`; `logs/` made. `bash scripts/agent_worktree.sh list` shows what exists.
2. **The brief** (dispatch by name: `.claude/agents/implementer.md`). It names:
   - the worktree -- "work ONLY in `C:\projects\wt-<name>`; never edit the main tree";
   - the files it may touch, and the exact verification command;
   - the commit form: `git commit -m "type(scope): what and why" -- <paths>` -- explicit pathspec, never
     `git add -A`, never a bare commit (the Bash hook refuses both); the session's own `Co-Authored-By` trailer;
   - **no push**: the URL is dead and the Bash hook refuses a push from a linked worktree; never `--no-verify`;
   - a failing test first, unittest only, **RED and GREEN pasted** into the report;
   - no build, game or lock unless the task is lock-bound (then `bash scripts/loop_lock.sh run agent-<name>
     --purpose "..." -- ./build.sh test --no-runner`, one at a time, at most two C++-building agents at once);
   - the **four-block report**: what changed (files, counts); RED and GREEN pasted; what is not done or changed
     against the brief, and why; the reviewer's command and the commit hash.
3. **The review** -- a fresh agent that did not write it, dispatched by name: `.claude/agents/reviewer.md`
   (read-only; re-runs the verification, re-derives every number, findings as `file:line`, one verdict line:
   PASS, PASS WITH FINDINGS, or FAIL). Diffs for it under `.superpowers/sdd/<plan>/` (git-ignored). Fix rounds go
   back to the same agent in the same worktree until a clean re-review. The task is DONE (code) at that clean
   review; record it in the plan's row and Log.
4. **The merge, by the controller** (never the agent), in the main tree on the sprint branch, when no main-tree
   chain is running on the files it changes:
   `git merge --no-ff agent/<name> -m "merge agent/<name>: <what> (Sprint N <task>)"`. A conflict is resolved in the
   main tree; the commit during a merge may omit `-- <paths>` (the hook allows it mid-merge).
   Then `python -m tools_py.changelog`, and `docs/CHANGELOG.md` goes in the merge's follow-up commit (R272).
5. **Or the PR to `main`** (R294, `docs/GIT_STRATEGY.md` section 2), when the branch goes to `main` by pull
   request instead of through the sprint branch, in this order: `bash scripts/agent_worktree.sh remove <name>`
   FIRST, then `gh pr merge <n> --merge` WITHOUT `--delete-branch`, then `git push origin --delete agent/<name>`
   and `git branch -D agent/<name>`. *Why:* `--delete-branch` on a branch checked out in a worktree tears down that
   checkout, and through its `tools/` junction the main tree's toolchain with it (2026-09-26 20:41Z,
   `docs/HAZARDS.md` git).
6. **The suite on the merged tree** before the push: `python -m unittest discover -s tools_py/tests -t .` --
   `OK` with no failures is the bar (a long run goes under `nohup` to a `logs/` file; read its last line, never a
   `tail` that masks the exit code), plus the gate by the `run-gate` skill if the task touched the runtime,
   `recomp/`, `tools_py/parity/`, `scripts/parity/` or `build.sh`. Then `git push origin <sprint branch>` and
   `gh run list --commit <sha>`.
7. **Remove**: `bash scripts/agent_worktree.sh remove <name>` -- it deletes every junction first through
   PowerShell's `Delete()` and verifies both sides before `git worktree remove`; it stops if the main tree's
   `tools/` is damaged. Never `rmdir` a junction and never `git worktree remove` by hand.
8. **Delete the branch** once merged: `git branch -D agent/<name>` (the script keeps it on purpose).
