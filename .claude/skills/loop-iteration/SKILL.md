---
name: loop-iteration
description: One firing of the SOCOM Unzipped loop, for whoever is the controller -- use at the start of every iteration and whenever you ask "what next": look, read the aim, work in bounded steps, green, commit, write it down, next item.
---

# The loop -- one iteration

This skill carries **no state at all**: no sprint, no goal, no number. State lives in CURRENT_SPRINT, KNOWN, HANDOFF:
`docs/CURRENT_SPRINT.md` (what to do), `docs/KNOWN.md` (what is true) and `docs/HANDOFF.md` (what is in flight and owed,
the rules one line each; the traps are `docs/HAZARDS.md`). If you find yourself writing a fact about the project into this file, it belongs
in one of those. Moved from `docs/LOOP_PROMPT.md` on 2026-09-26 (Sprint 14 I2); its old text is
`docs/archive/LOOP_PROMPT-to-2026-09-26.md`.

**How it actually runs.** Nothing in the repository schedules this -- there is no cron, no hook, no ledger. The loop is
a controller session working this page one iteration after another, for as long as the owner leaves it running. The
owner (Craig) is usually away and has given the controller full authority to use its judgement; plans are
suggestions, stop rules and the owner-only list are not.

## Every iteration

1. **Look before you touch.** `git status --short`, `git log --oneline -5`, `bash scripts/loop_lock.sh check`. Other
   sessions share this working tree: a modified file you did not modify is someone else's -- do not edit or stage it.
   If the lock is held, or a `socom2*` / `pcsx2-qt` process is running, start no build and no run; **do not idle** --
   take lock-free work (step 3).
2. **Read the aim.** The first open item in `docs/CURRENT_SPRINT.md`, in its order. `docs/KNOWN.md` §1–§3 before a
   hypothesis, then `docs/HAZARDS.md` by the area -- it is the fastest way to avoid re-deriving a dead one.
   The item's spec section and plan, if it has one, and its issue if it has one (`issue #N` in the row; `gh issue view N --comments`): the comment trail is where the
   last agent left it, and the Closing bar section is what you are trying to meet.
   A new item that needs more than an hour gets a plan first (`docs/superpowers/plans/`, the existing ones are the
   pattern: handoff notes, global constraints, tasks with RED/GREEN steps and exact commands, rulings).
3. **Work in bounded steps:** one hypothesis -> a failing test -> the change -> one build -> one run -> read the
   evidence. Builds and runs go through the lock (the `run-gate` skill; `docs/HANDOFF.md` §4 rule 6),
   `scripts/check_quiet_gate.sh` first, and each is announced as a window before it starts (`run-gate` step 0, R297).
   While one is running, do lock-free work rather than waiting: pure scorers and their tests, reading the decompilation,
   analysis of logs already on disk, documents, the filler list in the sprint file. Never return control to wait on a
   detached run -- poll its marker.
4. **Green before the commit:** `./build.sh test`, and the three-stage gate on the rebuilt exe
   (`./build.sh runtime` first) for anything touching the runtime, `recomp/`, `tools_py/parity/`, `scripts/parity/` or
   `build.sh`. A red gate is fixed before anything else. Never regress: title labels clean, online reaches the lobby,
   a mission loads, the online local player moves.
   **The merged chain is the gate unit (Sprint 14 W2).** An agent's task is DONE (code) at a clean review of its
   branch; the proof is one chain on the sprint branch per BATCH of merges, not one per merge: recomp -> runtime ->
   suites -> gate (on the exe it built) -> the fourth leg (named only in the gate) -> release build -> the release archive and
   PLAYTEST's block.
   Copy the template `scripts/parity/merged_chain.sh` into `logs/` and launch the copy once through
   `scripts/run_detached.sh --wait` (its header), so every step runs under that one holding; it refuses a tree with a
   modified tracked file, so land the batch, then launch. A red step prints the merges since the last green chain
   (`logs/merged_chain.last_green`) -- bisect by branch, evict the culprit by `docs/GIT_STRATEGY.md` "Slices" (a
   recorded `git revert -m 1 <merge>`, the branch re-queued for its author). Between chains, every merge is followed
   by the full Python suite on the sprint branch.
5. **Commit and push** by `docs/HANDOFF.md` §4 rules 1-4 (explicit pathspec; the never-commit list; your session's own
   trailer; `git push origin <sprint branch>`; check CI -- `secrets` runs on every push, `linux` and `windows` when
   anything outside `docs/` moved). **The repository is public:** the hooks (`bash scripts/install_hooks.sh`, once
   per clone) run the leak check before the commit and again before the push, and CI runs it over the full history;
   a hit is fixed, or a reviewed non-secret is recorded with its reason in `tools_py/release/leak_allow.txt`. Never
   `--no-verify`.
5b. **Is it proven? Then it goes to `main` today** -- a frozen slice branch, a PR, the three required checks, a merge
   commit, then `main` merged back into the sprint branch (`docs/GIT_STRATEGY.md` §2, "Slices"). The owner asked for
   this on 2026-09-21 and it is now how the loop works: `main` is never more than one proven item behind, so anyone who
   clones the public repository gets work that has passed its bar. Unproven work stays on the sprint branch.
6. **Write it down where it will be read:** update STATUS's "Current state" block if the state changed; the entry
   goes in the plan's Log; **audit `docs/KNOWN.md`** -- promote, retire or retract every row this step touched -- **and
   the issue behind each such row** (`docs/GIT_STRATEGY.md` §7: a new §2 row or a fixable hazard opens one, a
   settled row closes it with the artefact, a rewritten row gets a comment; `python -m tools_py.issues audit` exits 0
   before the commit); tick the
   plan's boxes; update the item's row in `docs/CURRENT_SPRINT.md`; a numbered ruling for every moved owner default, acceptance
   bar or spec goal; a skipped measurement is a KNOWN row or a test (`docs/DOC_MAINTENANCE.md` §6); `docs/HUMAN_TASKS.md` for anything only the owner can verify; `docs/HANDOFF.md` §2, §5 and §6
   when the pick-up point changes (§2's one "now" bullet is replaced, the old one moved to its archive). **A committed
   sentence found false is corrected the same hour, where it is written**, with a `> Superseded by ...` blockquote --
   never queued for a close-out that may not come.
   **A new document under `docs/` needs a row in `docs/DOC_MAINTENANCE.md` §3 giving it a class** (the suite fails
   without one), and its class decides what may be written in it -- a narrative file that holds live state is how
   `ROADMAP.md` went two sprints out of date. Take a ruling number from `docs/HANDOFF.md` and bump that line in the
   same commit, and run `python -m tools_py.rulings`, committing `docs/RULINGS.md` in the same commit (also when a commit only edits a ledger row); both are
   checked. When an O row, a ruling or the backlog changes, run `python -m tools_py.sitting` beside it and commit
   `docs/SITTING.md` in the same commit (R271, Sprint 14 D3).
7. **Then the next item.** Do not wait on the owner; do not perform what is the owner's (publish, make public,
   permissions, signing, money, the site's deploy, any server that is not ours).

## Delegation

Sub-agents are welcome for bounded work with an exact brief and a verification command: offline and static work
freely; builds of the runtime and game runs are SERIAL and go through the lock whoever starts them; at most two
C++-building agents at once. For any number a decision rests on, have a fresh agent re-derive it rather than re-read
it. A sub-agent never commits a file it was not given, and never stages with `git add -A`. The worktree, the brief,
the review and the merge: the `agent-worktree` skill.

## When the sprint closes

`docs/CURRENT_SPRINT.md`'s close-out item; the two reviews that a close cannot skip -- the documents
(`docs/DOC_MAINTENANCE.md` §5) and, deep, the known-issue stack (`docs/DOC_MAINTENANCE.md` §7: every open issue read
against the tree, every KNOWN row ruled on, the carry, the milestone closed); `docs/GIT_STRATEGY.md` for the merge and
the tag -- the checklist is the `sprint-close` skill; then open the next sprint when the owner names it: its spec is
written (or a draft finished) and agreed, its plan is written against the tree as it then is, its milestone exists on
GitHub, and the sprint file's header block is rewritten -- it is the only sprint pointer in the project. Until then
no sprint branch is open, and a change goes on a topic branch (`docs/GIT_STRATEGY.md` §2).

## The acceptance bar that has never changed (owner, 2026-09-09)

"Playable" means visual accuracy of the game itself, not just the shell, AND an automated test that drives a
two-instance online match to its end by one player killing the other. Both were met in Sprint 5 and must stay met.
Long term: the N64-recomp model -- game logic stays recompiled; renderer, audio, input and network are native.

## The lock

The lock serializes every build and every game run; the lock's rules are `scripts/loop_lock.sh`'s header; the
five-step rollout of a new lock script, which the header only sketches and defers, is the rollout hazard in
`docs/HAZARDS.md`'s lock area. The commands a controller runs: the `run-gate` skill.
