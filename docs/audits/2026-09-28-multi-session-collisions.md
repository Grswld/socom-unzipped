# The Sprint 16 close under several sessions -- the collisions, and the guards that would have refused them

*Class S (a snapshot, 2026-09-28 03:25Z, the Sprint 16 controller): written for the Sprint 17 seat's Task 0. It needs a row in
`docs/DOC_MAINTENANCE.md` §3 when it is committed. The owner's ruling (§3.0) is standing; the guards in §3 are proposals with
planted tests -- designed by three agents from the record in §1, then each argued against by two refuters who read the tree,
the chain logs and the reflog (§5 has what they proved). Nothing here is implemented. Sizes are the refuters' measurements.*

## 1. The record (2026-09-27 22:10Z to 2026-09-28 02:53Z)

The setting: the sprint controller ran in a desktop-app linked worktree on its own branch and fast-forwarded the main tree
(`C:\Projects\socom_pc`, checked out on `sprint-16`) after each commit; the owner's own sessions (web, story, docs surfaces),
a planning seat and agent worktrees worked beside it; one loop lock serialised builds and runs.

1. **The merged chain went red five times on causes outside the code it proved** (~90 min each). (a) The docs session's
   README rewrite, committed straight into the main tree, wrapped one sentence across two lines and a wording test failed at the
   suite step (23:01Z, 50 minutes in). (b) A rerun launched before that fix had landed. (c) The "push seat" session merged
   `origin/sprint-16` into the main tree mid-chain -- two PRs based on `sprint-16` had merged on GitHub, so origin was ahead --
   and the chain went red on `recomp-changed-tracked-files` with 25 staged paths, BEFORE the merge commit `84216bcf` even
   existed (23:06:59Z against 23:07:17Z); that merge moved twelve chain inputs (launcher sources, a runtime header, C++ tests,
   `tools_py/`). (d) The docs-surfaces session merged its branch into the main tree mid-chain. (e) The story session committed
   `28a131a3` (`docs/story/`, `tools_py/story/site.py`, a test) in the main tree at 00:10Z during the suite step: red at
   00:11Z with every suite green; the web session's `d9dc8caa` at 00:50Z under the next rerun. The close proof became the
   chain's suites (rerun 4) plus the gate and the fourth leg by hand on the chain-built exe (`logs/s16_controller/s16_b4_gate.sh`,
   stamp `s16_b4g`).
2. **The push.** The controller's worktree seat cannot push (the hook: an agent worktree never pushes) and the app refuses to
   move a worktree session's directory; the push seat closed at 23:20Z; the owner pushed `sprint-16` by hand three times
   (01:44Z, 01:51Z, 02:37Z) -- the close-out and each CI fix.
3. **CI on the PR went red twice on direct main-tree commits** that no push had CI-tested and no one had reviewed: (a) gitleaks'
   `generic-api-key` on the web session's `web/packages/viewer/src/ds/MANIFEST.json` (`"tokens.css": "<sha256>"`), a digest
   manifest -- an allowlist path fixed it (`80c59e06`); (b) the story session's `site.py` made the repository copy REFUSE (exit 2)
   without the design system at `--ds-dir` -- the sibling default `../scotho/…` itself pre-dated the night (`--ui-css`, since
   Sprint 13, with a warning on absence) -- so a pre-existing test failed on both runners; the session's own suite run had been
   killed by memory pressure; the test now brings its own files (`8644ac8c`).
4. **Shared documents.** `docs/HANDOFF.md` (5,900-byte ceiling) was pushed over twice by peer lines (`91e4191a` took it to 6,068)
   and found at the controller's commit; the web session wrote into the plan's `## Log` (`8166261c`, a cp1252 `0xb7`), so every
   fast-forward needed a byte-level three-way resolve; the controller merged the main tree's `sprint-16` into its branch before
   every fast-forward.
5. Two sessions asked to hold commits complied once the message reached them; one commit landed in between.

## 2. The four causes

- **The tree the chain proves is shared, and the chain reds on a dirtied tracked file first**, on HEAD second. An EDIT of a
  tracked input by anyone seated in that tree is enough; a commit is not needed.
- **Anyone seated in the main tree can land anything on the sprint branch** -- untested, unreviewed, and only CI-tested when
  the branch is finally pushed, by someone else.
- **The seat that runs the sprint could not push**, and the seat that could was a person or a second session.
- **Living documents with ceilings have several writers**, the ceiling is a test rather than a refusal at the commit, and the
  plan's Log is a positional merge conflict by construction.

## 3. The corrections, as repaired by the refuters

### 3.0 The owner's ruling (2026-09-28 02:35Z) -- standing, no code

**One controller, seated in the main tree; every other session in its own worktree on its own branch.** The controller
reviews, merges and runs the chain; a peer's work reaches the sprint branch only through the controller (or a PR to `main`
under R294). It removes cause 3 and most of causes 1 and 2 -- as long as it holds; the guards below make it hold. **The
reminder:** at every sprint open, the controller's first message to the owner repeats this (memory
`one-main-controller-in-the-main-tree`).

### 3.1 The chain's tree is pinned at the edit, keyed on the chain's own marker -- `merged_chain.sh` + `pretool.py`

`merged_chain.sh` writes `logs/.merged_chain.running` (`<tree root> <HEAD0> <pid> <lock record path> <stamp>`) right after
HEAD0 and removes it in an EXIT trap (dry runs write nothing; liveness is judged by the lock's record file, never by a child
process -- the memory floor kills children). The PreToolUse hook reads THAT file, not `loop_lock.sh check`: (a) the
Edit/Write half refuses an edit of a tracked chain input in the pinned tree ("a running chain proves this tree; edit in a
worktree") -- the shell fast path in `claude_pretool.sh` gains the marker's existence as a trigger so an ordinary edit still
costs one stat; (b) the Bash half refuses the HEAD-moving verbs (`commit`, `merge`, `pull`, `rebase`, `reset`, `checkout`,
`switch`, `cherry-pick`, `revert`, `am`, `stash pop`) in the pinned tree, including `git -C <main>` from elsewhere. **No
reference-transaction git hook**: a refuter proved with a scratch repo that aborting the ref update leaves the tree dirty
(`M f` with the new content) and the chain reds on `changed-tracked-files` anyway. Would have refused 1(c), 1(d), 1(e)
before they dirtied the tree, and 5 stops being a message. Planted tests: `test_merged_chain.py` (the marker lives exactly as
long as the chain: present in a green run's log, gone at the end, absent on refuse/red/dry run); `test_hooks.py` with a
stubbed marker (the table of verbs refused in the pinned tree, allowed in a worktree; `git status/log/diff/fetch/add` pay
nothing); an Edit of `README.md` refused, of `logs/x.txt` allowed.

### 3.2 The hook judges the PowerShell tool too -- `.claude/settings.json`, `claude_pretool.sh`

The PreToolUse matcher is `Bash` and the edit tools; a refuter ran `git add -A` and a pathless `git commit` through the
PowerShell tool unrefused. Every rule that exists today is a sentence for that tool. Matcher `Bash|PowerShell`; the command
split on `;` and newlines, with `Set-Location`/`sl`/`Push-Location` treated as `cd`/`pushd`. Planted test: `PretoolWiringTest`
with `tool_name="PowerShell"` and `git -C <repo> merge x` under a pinned tree -> refused.

### 3.3 The chain reds on input drift and refuses a rerun nothing changed -- `merged_chain.sh`

A tracked exclude list `scripts/parity/chain_outside.txt` (`docs/`, `web/`, `.github/`, `:(exclude,glob)*.md` at the root,
`.gitleaks.toml`); the input id is `git ls-files -s -- . <excludes>` hashed (`ls-files` honours `:(exclude)`, `ls-tree` does
not) at the start and after each step: an input moved is red as today; a HEAD move outside the inputs ends green with a NOTE
and records `proved at <HEAD0>, HEAD ended at <HEAD1> (outside the inputs)`. Honest reach: 1(d) and `d9dc8caa` -- NOT 1(c),
whose merge moved twelve inputs and stays red, correctly. `last_red` becomes `<HEAD0> <step> <inputs id>` and the chain refuses
to start when `git diff --quiet <last_red_head> HEAD -- . <excludes>` is quiet (nothing a step reads changed since the red:
1(b)'s fifty minutes). Planted tests: the harness's mid-step commit under `docs/` (green + NOTE) and under `tools_py/` (red);
a relaunch after a red with only a docs commit -> refused with the red step named.

### 3.4 The fast subset first -- `merged_chain.sh` step 0

`python -m tools_py.tests.fast` (~84 s, no build) before `recomp`: `test_launcher_wording` is in it and reads README, so 1(a)
would have been red at minute two, not minute fifty (about 47 minutes on the record). Only that -- the "proof ledger" that
skips proved steps was refuted (the builds it skips were 4-6 minutes; the suite is the 35-47-minute step and cannot be skipped).
Planted test: `FAKE_FAIL=fast` -> the steps printed are `["the fast subset"]`, no `build recomp`.

### 3.5 Hermetic tests, and no repository-copy default that reaches a sibling -- `tools_py/tests/__init__.py`, `site.py`

`tools_py/tests/__init__.py` (imported by every unittest entry: discover, one module, the fast subset, `build.sh test`) sets
the hermetic environment -- `SOCOM_SIBLINGS_DIR` to a directory that does not exist unless a test opts in -- so the suite on
the owner's machine sees what a runner sees. `site.py`'s `--ds-dir` loses its default: the repository copy without the flag is
the existing exit-2 refusal ("pass --ds-dir"), deterministic on every machine; the story skill's command line carries the flag
(`C:/projects/scotho/apps/s2u/src/ds`); `tools_py/siblings.py` is the one door for the leak scanners' sibling legs. A lint over
`dirname(ROOT)` defaults was refuted as the wrong half (the default pre-dated the night; the error-on-absence broke it). Would
have failed 3(b) locally the moment the story session ran any test, and refuses the class. Planted tests: the fixed
`test_a_url_path_is_accepted` passes with `--ds-dir` and the copy without it exits 2 on every machine; a test that reads a
sibling without `have()`+`skipTest` fails under the hermetic default.

### 3.6 docmaint at the commit, and the Log as a union-merged file -- `pre-commit`, `.gitattributes`

`python -m tools_py.docmaint staged --repo <toplevel>` measures the STAGED blobs (`git show :<path>`, CRLF normalised) of
every ceiling'd document and refuses over a ceiling with the archive instruction; the hook pins `PYTHONPATH` to its own tree so
a branch without the verb is not refused by `usage:`. `91e4191a` (HANDOFF to 6,068) and `8166261c` (the `0xb7` Log line) would
have been refused at their own commits. The Log's positional conflict leaves the merge layer: the plan's `## Log (newest first)`
moves to `docs/superpowers/plans/<plan>-log.md` with `merge=union` in `.gitattributes` (git keeps both sides' inserted lines,
no markers; entries are dated and stamped, so order is recoverable) and docmaint's Log ceiling follows the file. Planted tests:
a 5,901-byte HANDOFF staged -> exit 1 naming the file; two branches each prepending a Log entry merge clean.

### 3.7 gitleaks runs here, from one binary, and refuses when missing -- `install_hooks.sh`, `pre-commit`, `pre-push`

The pre-push leg `if [ -n "$gl" ]` has skipped silently since `dc392b3d` (2026-09-21): `tools/gitleaks/` never existed in any of
the 18 trees on this host, so the 2026-09-25 pins hit and tonight's MANIFEST hit both reached CI. One pin file
`scripts/gitleaks.lock` (version 8.30.1 and per-platform sha256, read by `secrets.yml` and by `install_hooks.sh`, which fetches
and verifies into the COMMON dir's `tools/gitleaks/` -- linked worktrees have no `tools/`); `pre-commit` runs
`gitleaks git --pre-commit --staged --config .gitleaks.toml` after our scanner, refuses on a hit with the remedy "add a reviewed
`[allowlist]` row with its reason to `.gitleaks.toml` and stage it in the same `-- <paths>`" (and refuses when the toml differs
from the index), and refuses when the binary is missing, naming the install line. `test_leak_allowlists.py` holds only what the
record supports: every allowlist regex matches a path that exists or existed, every row carries a reason, a planted MANIFEST
trips gitleaks off the allowed path and passes on it (SKIP without the binary). Would have caught 3(a) in the web session's own
commit. Cost: one fetch per clone; 1-2 s per commit.

### 3.8 The seat is a session, made a guard -- `scripts/controller_seat.sh`, `pretool.py`, `reap.py`

A seat file `logs/.controller_seat` beside the lock names the controller by SESSION ID (the hook JSON's), not by directory --
tonight's peers sat in the very directory the ruling gives the controller. `take` refuses inside an agent worktree (the dead push
URL, an `agent/*` branch) and while another session holds it; the Bash half refuses `commit`, `merge`, `pull`, `rebase`,
`cherry-pick`, `reset`, `am` on a `sprint-*` branch in the main tree from any other session, and refuses a push from any tree
but the seat's; a worktree-seated controller's `git -C <main> commit|merge` (other than `--ff-only`) is refused too, so the halves
agree; `reap.py` releases the seat only on `SessionEnd` with the matching id (a Stop between turns must not free it). Under the
ruling this is the ruling made a guard; it also closes cause 2 by construction (the seat pushes). The push verb is
`scripts/push_sprint.sh` run by the seated controller by hand (refuses from a linked worktree, under `MERGE_HEAD`, or when
origin has diverged -- an amend after a push must be a new commit); NO schedule (a refuter showed a ten-minute routine stalls
on the first divergence and pushes untested tips whose CI reds nobody reads). Planted tests: `test_controller_seat.py` (take
from an agent worktree refused; a second session refused; SessionEnd frees, Stop does not); `test_hooks.py` (a peer's commit on
`sprint-*` in the main tree refused, the seat's allowed).

### 3.9 A PR based on a sprint branch never merges on GitHub -- `.github/workflows/sprint-pr.yml`, `pretool.py`

`rule_gh_merge_into_sprint` refuses `gh pr merge` of a PR whose base is `sprint-*` (the controller merges the head locally and
pushes). Server side: a workflow on `pull_request` (`opened`, `reopened`, `ready_for_review`) against `sprint-*` that comments
the rule and converts the PR to draft (`gh pr ready --undo`) -- **not a required status check**, which two refuters showed
locks every push to the branch (required checks are evaluated on every ref update). Would have removed the cause of 1(c).

## 4. The order for Sprint 17's Task 0 (a recommendation)

1. 3.0 stands; the reminder at the open. 2. 3.1 -- the guard at the edit, keyed on the chain's marker; it is what would have
saved three of five reds. 3. 3.2 -- without it every hook rule is a sentence for the PowerShell tool. 4. 3.4 (one line, 47
minutes). 5. 3.5 -- the hermetic default and `--ds-dir` without a default. 6. 3.6 and 3.7. 7. 3.3, 3.8, 3.9 as windows allow.

## 5. What the refuters proved (each read the tree, the logs or the reflog; scratch repos where they say so)

- `merged_chain.sh`'s `step()` tests `git status --porcelain --untracked-files=no` BEFORE it tests HEAD: chain 2b's red at
  23:06:59Z was `recomp-changed-tracked-files` on the push seat's 25 staged paths, and its merge commit landed at 23:07:17Z --
  a guard on the ref update prevents nothing; the guard must fire at the edit (3.1) and drop the reference-transaction hook.
- 1(c)'s merge `84216bcf` changed 32 files, twelve inside any sane input set (`ps2xLauncher/src/main.cpp`, `bug_report.h`,
  `knobs.h`, `bug_report_tests.cpp`, `tools_py/`): an input-drift check keeps it red, correctly (3.3's claim narrowed).
- The PreToolUse matcher in `.claude/settings.json` is `Bash` and the edit tools: a `git add -A` and a pathless commit through
  the PowerShell tool passed (3.2). `claude_pretool.sh`'s fast path exits 0 before Python for an Edit JSON that names none of
  `git`, `gh pr`, `loop_lock`, `logs/`: an Edit rule for HANDOFF or the plan needs the fast-path `case` extended and must be
  tested through the script, not `decide()` alone.
- The sibling default in `site.py` (`--ui-css`, `dirname(ROOT)/scotho/…`) has been in the tree since Sprint 13 with CI green,
  because absence was a warning; 3(b) is the error-on-absence plus an unrun suite. A lint on the default's shape refuses the
  wrong half; an environment-variable fallback re-creates the one-machine green (3.5 as written).
- `tools/gitleaks/` exists in none of the 18 trees; the pre-push leg has skipped silently since 2026-09-21; a linked worktree has
  no `tools/` at all (only `agent_worktree.sh` junctions it), so the binary belongs in the common dir's `tools/` (3.7).
- Liveness through a child process (`loop_lock.sh id`) fails under the memory floor (`0xC0000142` at ~1-3 GB free with builds,
  suites and agents running -- the floor tonight killed the story session's suite); the marker must be judged by reading the
  lock's record file, and a hook must never delete the marker (3.1).
- A seat keyed on the directory does not separate the controller from a peer seated in the same directory -- tonight's exact
  case; the seat must be the session id, released only on `SessionEnd` (3.8). A worktree-seated controller's `git -C <main>
  merge` conflicting on HANDOFF or the Log leaves the main tree mid-merge for everyone -- the halves must agree (3.8).
- A required status check on `sprint-*` is evaluated on every push, so the controller's own landings would be refused (3.9).
- A scheduled push routine stalls on the first amend/divergence and publishes tips whose CI reds nobody reads (a
  `test_launcher_wording` red sat unread 22:36Z-23:04Z on the record); the push stays a verb of the seated controller (3.8).
- The proof ledger's savings are fiction on the logs (recomp/runtime 4-6 min; the suite 35-47 min); step 0's fast subset is the
  whole saving the record supports (3.4).
