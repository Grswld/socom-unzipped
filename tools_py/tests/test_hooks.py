"""The Claude Code PreToolUse guard (Sprint 14 Task G1): every refusal fired once against a planted command, one
allowed neighbour per rule, and the wiring -- scripts/hooks/claude_pretool.sh fed a hook JSON document on stdin.

The rules and their homes are listed in docs/DEVELOPING.md, "Guards".
"""
import json
import os
import subprocess
import tempfile
import unittest

from tools_py.hooks import commitmsg, pretool
from tools_py.tests.shell import BASH

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HOOK_SH = os.path.join(ROOT, "scripts", "hooks", "claude_pretool.sh")

CASES = [  # (command, is_worktree, expect_exit) -- the plan's Step 1 table (a commit names its paths)
    ("git add -A", False, 2), ("git add -- docs/KNOWN.md", False, 0),
    ("git add .", False, 2), ("git add -u", False, 2),
    ("git commit -m 'x'", False, 2), ("git commit --no-edit", False, 2),
    ("git commit -a -m 'x'", False, 2), ("git commit --all -m 'x'", False, 2),
    ("git commit -m 'x' -- docs/KNOWN.md", False, 0), ("git commit -m 'x' -- a", False, 0),
    ("git commit --no-verify -m 'x' -- a", False, 2), ("git push --no-verify", False, 2),
    ("git push origin sprint-14", True, 2), ("git push origin sprint-14", False, 0),
    ("git config remote.origin.pushurl x", True, 2), ("git config --worktree remote.origin.pushurl x", True, 0),
    ("git config --get user.name", True, 0), ("git config user.name x", False, 0),
    ("git worktree remove --force C:/projects/wt-x", False, 2),
    ("bash scripts/agent_worktree.sh remove wt-x", False, 0),
    ("bash scripts/loop_lock.sh take", False, 2), ("bash scripts/loop_lock.sh release", False, 2),
    ("bash scripts/loop_lock.sh check", False, 0), ("bash scripts/loop_lock.sh run -- ./build.sh runtime", False, 0),
]

MORE_CASES = [  # compound commands, quoting, spellings the table does not reach
    ("git status && git add -A", False, 2),
    ("git add -- a; git commit -m x", False, 2), ("git add -- a; git commit -m x -- a", False, 0),
    ("git commit --amend --no-edit", False, 2), ("git commit --amend --no-edit -- a", False, 0),
    ("git commit -m x --pathspec-from-file=list.txt", False, 0),
    ("echo 'git add -A'", False, 0),                        # a quoted string, not a command
    ("git commit -m 'unterminated", False, 0),              # shlex cannot parse it: allowed
    ("git add", False, 2), ("git add --all", False, 2), ("git add -- .", False, 2), ("git add -Av", False, 2),
    ("git add -f -- logs/x.txt", False, 0),
    ("git commit -am 'fix'", False, 2), ("git commit -m 'a -a' -- f", False, 0),
    ("git commit -n -m x -- f", False, 2),                  # -n is commit's --no-verify
    ("git -C /c/projects/wt-x push origin b", True, 2),
    ("git status | grep x || git add -u", False, 2),
    ("git status\ngit add .", False, 2),
    ("git config --list", True, 0), ("git config -l", True, 0), ("git config --get-regexp remote", True, 0),
    ("git config --get-all remote.origin.push", True, 0), ("git config user.name", True, 0),
    ("git worktree prune", False, 2), ("git worktree add ../wt-y", False, 2), ("git worktree list", False, 0),
    ("./scripts/loop_lock.sh take", False, 2), ("bash /c/projects/socom_pc/scripts/loop_lock.sh release", False, 2),
    ("bash scripts/loop_lock.sh wait 5", False, 0), ("bash scripts/loop_lock.sh version", False, 0),
    ("git commit -F - -- f <<'EOF'\ngit add -A\nEOF", False, 0),   # a heredoc body is not a command
]

REVIEW_CASES = [  # the G1 review's bypass table (round one), each closed by a planted case
    # (1) config writes with at most one positional
    ("git config --unset remote.origin.pushurl", True, 2), ("git config --unset-all remote.origin.push", True, 2),
    ("git config --remove-section remote.origin", True, 2), ("git config --rename-section a b", True, 2),
    ("git config -e", True, 2), ("git config --edit", True, 2), ("git config --add remote.origin.push x", True, 2),
    ("git config --replace-all k v", True, 2), ("git config unset k", True, 2), ("git config set k v", True, 2),
    ("git config --worktree --unset remote.origin.pushurl", True, 0), ("git config --global --unset k", True, 0),
    ("git config --system -e", True, 0), ("git config --file x.cfg --add k v", True, 0),
    ("git config --type bool core.bare", True, 0), ("git config get user.name", True, 0),
    ("git config --unset k", False, 0),
    # (2) abbreviated --no-verify, and core.hooksPath on the command line
    ("git commit --no-verif -m x -- a", False, 2), ("git push --no-v", False, 2), ("git commit --no-ver -- a", False, 2),
    ("git -c core.hooksPath=/dev/null commit -m x -- a", False, 2), ("git -c core.hookspath= push", False, 2),
    ("git -ccore.hooksPath=x commit -m x -- a", False, 2),
    ("git commit --no-edit -- a", False, 0), ("git -c user.name=x commit -m x -- a", False, 0),
    # (3) wrappers, brace groups, bash -c / sh -c / eval payloads
    ("time git add -A", False, 2), ("nice -n 5 git add .", False, 2), ("env FOO=1 git add -A", False, 2),
    ("env -u X git add -A", False, 2), ("sudo git push --no-verify", False, 2), ("command git add -A", False, 2),
    ("ls | xargs -0 git add -A", False, 2), ("{ git status; git add -A; }", False, 2),
    ('bash -c "git add -A"', False, 2), ("sh -c 'git commit -a -m x'", False, 2), ('eval "git add ."', False, 2),
    ('bash -lc "git add -A"', False, 2), ('bash -c "cd x && bash scripts/loop_lock.sh take"', False, 2),
    ('bash -c "git status"', False, 0), ("env git status", False, 0), ("time ./build.sh test", False, 0),
    # (4) a bulk flag limited by a `--` pathspec is not a bulk add
    ("git add -A -- docs/a.md", False, 0), ("git add -u -- a b", False, 0), ("git add -A -- .", False, 2),
    ("git add -A docs/a.md", False, 2),
    # (5) force-push of a shared branch
    ("git push --force origin sprint-14", False, 2), ("git push -f origin main", False, 2),
    ("git push --force-with-lease origin main", False, 2), ("git push --force-if-includes origin sprint-14", False, 2),
    ("git push origin +main", False, 2), ("git push origin +HEAD:sprint-14", False, 2),
    ("git push --force", False, 2), ("git push -f origin", False, 2), ("git push -uf origin HEAD", False, 2),
    ("git push --force origin HEAD:refs/heads/main", False, 2),
    ("git push --force origin agent/s14-g1", False, 0), ("git push -f origin HEAD:fix/x", False, 0),
    ("git push origin +feat/y", False, 0), ("git push --force-with-lease=docs/z:abc origin docs/z", False, 0),
    ("git push -f origin spike/q", False, 0), ("git push origin main", False, 0),
    ("git push origin sprint-14 main", False, 0),
    # round three: more wrappers; deleting or mirroring a shared branch
    ("timeout 60 git add -A", False, 2), ("timeout 120 git push", True, 2), ("timeout -s KILL 5 git add .", False, 2),
    ("timeout -k 5 --signal=TERM 60 git add -A", False, 2), ("nohup git add -A", False, 2),
    ("stdbuf -o L git add -A", False, 2), ("stdbuf -oL git add -A", False, 2), ("ionice -c 3 git add -A", False, 2),
    ("timeout 60 git status", False, 0), ("nohup ./build.sh runtime", False, 0),
    ("git push --delete origin main", False, 2), ("git push -d origin sprint-14", False, 2),
    ("git push origin :main", False, 2), ("git push origin :refs/heads/sprint-13", False, 2),
    ("git push --mirror origin", False, 2), ("git push --mirror backup", False, 2),
    ("git push --delete origin agent/s14-g1", False, 0), ("git push origin :fix/old", False, 0),
]

GH_MERGE_CASES = [  # `gh pr merge --delete-branch` removed a worktree and, through its tools/ junction, the main
    # tree's toolchain (2026-09-26 20:41Z; docs/HAZARDS.md git) -- the hook refuses it and its spellings
    ("gh pr merge 76 --merge --delete-branch", False, 2), ("gh pr merge --delete-branch 76", False, 2),
    ("gh pr merge 76 -d", False, 2), ("gh pr merge 76 --merge -d --admin", False, 2),
    ("git fetch && gh pr merge 76 --delete-branch", False, 2), ("gh pr merge 76 -md", False, 2),
    ("gh pr merge 76 --delete-branch=true", False, 2), ("gh.exe pr merge 76 -d", True, 2),
    ('bash -c "gh pr merge 76 -d"', False, 2), ("gh pr merge -R Scotho/socom_pc 76 -d", False, 2),
    ("gh pr merge 76 --merge", False, 0), ("gh pr merge 76 --squash", False, 0), ("gh pr view 76", False, 0),
    ("gh pr merge --help", False, 0), ("git push origin --delete agent/x", False, 0),
    ("gh pr merge 76 --merge --body '-d'", False, 0), ("gh pr merge 76 -t -d", False, 0),
    ("gh pr merge 76 --delete-branch=false", False, 0), ("gh pr list -d", False, 0),
    ("echo 'gh pr merge 76 -d'", False, 0), ("gh pr create -t merge -d", False, 0),
    ("gh pr view merge -d", False, 0),
]


class PretoolPlantedTest(unittest.TestCase):
    def run_cases(self, cases):
        for cmd, wt, want in cases:
            code, why = pretool.decide("Bash", {"command": cmd}, "C:/projects/socom_pc", wt)
            self.assertEqual(code, want, (cmd, why))
            if want == 2:
                self.assertIn("home:", why)
            else:
                self.assertEqual(why, "")

    def test_each_planted_command(self):
        self.run_cases(CASES)

    def test_compound_and_edge_commands(self):
        self.run_cases(MORE_CASES)

    def test_a_bare_commit_passes_during_a_merge(self):
        # git refuses a partial commit while MERGE_HEAD exists, so the pathspec rule steps aside
        for cmd in ("git commit -m 'x'", "git commit --no-edit"):
            self.assertEqual(pretool.decide("Bash", {"command": cmd}, ".", False, merge_in_progress=True), (0, ""))
        self.assertEqual(pretool.decide("Bash", {"command": "git commit -a --no-edit"}, ".", False,
                                        merge_in_progress=True)[0], 2)

    def test_the_merge_state_is_judged_where_the_commit_runs(self):
        # G2b: MERGE_HEAD belongs to the directory the command works in (cd, git -C), not the session's cwd
        def probe(path):
            return path.replace("\\", "/").rstrip("/").endswith("/projects/wt-x")

        def judge(cmd):
            return pretool.decide("Bash", {"command": cmd}, "C:/projects/socom_pc", False, merge_probe=probe)

        self.assertEqual(judge("cd /c/projects/wt-x && git commit --no-edit"), (0, ""))
        self.assertEqual(judge("git -C /c/projects/wt-x commit --no-edit"), (0, ""))
        self.assertEqual(judge("git commit --no-edit")[0], 2)                      # the session dir: no merge
        self.assertEqual(judge("cd /c/projects/wt-x && git commit -a -m x")[0], 2)  # -a is refused mid-merge too
        self.assertEqual(judge("(cd /c/projects/wt-x); git commit --no-edit")[0], 2)  # the subshell's cd ends

    def test_review_round_one_cases(self):
        self.run_cases(REVIEW_CASES)

    def test_gh_pr_merge_delete_branch_is_refused(self):
        self.run_cases(GH_MERGE_CASES)
        code, why = pretool.decide("Bash", {"command": "gh pr merge 76 --merge --delete-branch"}, ".", False)
        self.assertEqual(code, 2, why)
        for words in ("--delete-branch", "junction", "docs/HAZARDS.md git", "scripts/agent_worktree.sh remove"):
            self.assertIn(words, why)

    def follow(self, cmd, session_wt):
        return pretool.decide("Bash", {"command": cmd}, "C:/projects/socom_pc" if not session_wt else
                              "C:/projects/wt-s14-g1", session_wt, worktree_of=lambda p: "wt-" in p)

    def test_a_subshell_cd_does_not_leak_out(self):
        self.assertEqual(self.follow("(cd /c/projects/wt-x && git status); git push origin sprint-14", False), (0, ""))
        self.assertEqual(self.follow("(cd /c/projects/wt-x && git push origin b)", False)[0], 2)
        # a brace group runs in the current shell: its cd does carry on
        self.assertEqual(self.follow("{ cd /c/projects/wt-x; }; git push origin b", False)[0], 2)

    def test_pushd_is_followed_like_cd(self):
        self.assertEqual(self.follow("pushd /c/projects/wt-x && git push origin b", False)[0], 2)
        self.assertEqual(self.follow("pushd /c/projects/wt-x && popd && git push origin b", False), (0, ""))

    def test_a_worktree_session_never_pushes_even_through_dash_c(self):
        self.assertEqual(self.follow("git -C /c/projects/socom_pc push origin sprint-14", True)[0], 2)
        self.assertEqual(self.follow("cd /c/projects/socom_pc && git push origin sprint-14", True)[0], 2)
        self.assertEqual(self.follow("git -C /c/projects/socom_pc push origin sprint-14", False), (0, ""))

    def test_a_cd_into_a_worktree_is_followed(self):
        seen = []

        def worktree_of(path):
            seen.append(path)
            return "wt-" in path

        code, why = pretool.decide("Bash", {"command": "cd /c/projects/wt-s14-g1 && git push"},
                                   "C:/projects/socom_pc", False, worktree_of=worktree_of)
        self.assertEqual(code, 2, why)
        self.assertTrue(seen)
        code, why = pretool.decide("Bash", {"command": "cd /c/projects/socom_pc && git status"},
                                   "C:/projects/wt-s14-g1", True, worktree_of=worktree_of)
        self.assertEqual(code, 0, why)

    def test_other_tools_and_bad_input_pass(self):
        self.assertEqual(pretool.decide("Read", {"file_path": "x"}, ".", True), (0, ""))
        self.assertEqual(pretool.decide("Bash", {}, ".", True), (0, ""))
        self.assertEqual(pretool.decide("Bash", {"command": None}, ".", True), (0, ""))


class EditWritePlantedTest(unittest.TestCase):
    """Sprint 14 G2: an Edit/Write/MultiEdit/NotebookEdit on a running chain script (an existing logs/**/*.sh while
    the lock is HELD) or on a scripts/loop_lock.sh something runs (a QUEUED waiter's blob, or the main tree's copy
    while HELD) is refused; everything else passes. The file system and git are stood in for by the probes
    (file_exists, blob_of, main_tree_of); PretoolWiringTest runs the real ones."""

    BLOB = "0123456789ab" + "c" * 28

    def edit(self, tool, path, holder=None, slow=False, key="file_path", queued=(), exists=True, blob=BLOB,
             main=True):
        return pretool.decide(tool, {key: path}, ROOT, False, lock_holder=holder, slow_tests_ran=slow,
                              queued_blobs=queued, file_exists=lambda p: exists, blob_of=lambda p: blob,
                              main_tree_of=lambda r: main)

    def test_a_chain_script_under_the_lock_is_refused(self):
        code, why = self.edit("Edit", "logs/s14_chain.sh", holder="chain:s14")
        self.assertEqual(code, 2, why)
        self.assertIn("chain:s14", why)
        self.assertIn("home: docs/HAZARDS.md lock", why)
        self.assertEqual(self.edit("Edit", "logs/s14_chain.sh", holder=None), (0, ""))

    def test_a_chain_script_is_refused_only_when_it_exists_and_the_lock_is_held(self):
        # G2 review: the lock is shared by every worktree; a new file cannot be running, a waiter has not started
        self.assertEqual(self.edit("Edit", "logs/x.sh", holder="agent-x51")[0], 2)            # existing, HELD
        self.assertEqual(self.edit("Edit", "logs/x.sh", holder="queued:1", queued=["0123456789ab"]), (0, ""))
        self.assertEqual(self.edit("Write", "logs/x.sh", holder="agent-x51", exists=False), (0, ""))  # new file

    def test_the_lock_script_is_refused_when_a_waiter_runs_this_copy_or_the_main_copy_is_held(self):
        # the ruling of 2026-09-26: the marker gates LANDING (the commit), not typing; what runs it is refused
        code, why = self.edit("Write", "scripts/loop_lock.sh", holder="queued:1", queued=["0123456789ab"])
        self.assertEqual(code, 2, why)                                   # a waiter runs this exact copy
        self.assertIn("blob 0123456789ab", why)
        self.assertIn("home: scripts/loop_lock.sh header (the rollout procedure)", why)
        self.assertEqual(self.edit("Write", "scripts/loop_lock.sh", holder="queued:1", queued=["ffffffffffff"]),
                         (0, ""))                                        # the waiter runs another copy
        code, why = self.edit("Write", "scripts/loop_lock.sh", holder="chain:s14", main=True)
        self.assertEqual(code, 2, why)                                   # HELD, the main tree's copy
        self.assertIn("chain:s14", why)
        self.assertEqual(self.edit("Write", "scripts/loop_lock.sh", holder="chain:s14", main=False), (0, ""))
        self.assertEqual(self.edit("Write", "scripts/loop_lock.sh", holder=None), (0, ""))

    def test_the_queued_blobs_are_parsed_from_check(self):
        check = ("FREE, but 2 waiter(s) queued: the next grant goes to the first QUEUED line\n"
                 "QUEUED: w1 queued 30 s ago, heartbeat 2 s old (blob=0123456789AB s14 chain) [1]\n"
                 "QUEUED: STALE (dropped at the next grant) w2 queued 900 s ago, heartbeat 400 s old (blob= p) [2]\n"
                 "QUEUED: w3 queued 5 s ago, heartbeat 1 s old (blob=fedcba987654 x) [3]")
        self.assertEqual(pretool.parse_queued_blobs(check), ["0123456789ab", "fedcba987654"])
        self.assertEqual(pretool.parse_queued_blobs("HELD: a taken 1 min ago, (blob=0123456789ab)"), [])
        self.assertEqual(pretool.parse_queued_blobs(""), [])

    def test_the_slow_marker_is_the_one_where_the_commit_runs(self):
        # G2 review: two repositories M (the session's cwd) and W; the marker of the one the commit lands in counts
        def judge(cmd, marker_in):
            def probe(path):
                return path.replace("\\", "/").rstrip("/").endswith("/projects/" + marker_in)
            return pretool.decide("Bash", {"command": cmd}, "C:/projects/m", False, slow_probe=probe)[0]
        in_w = "cd /c/projects/w && git commit -m x -- scripts/loop_lock.sh"
        dash_c = "git -C /c/projects/w commit -m x -- scripts/loop_lock.sh"
        in_m = "git commit -m x -- scripts/loop_lock.sh"
        self.assertEqual(judge(in_w, "w"), 0)          # marker in W only: W's own green run lands W's copy
        self.assertEqual(judge(dash_c, "w"), 0)
        self.assertEqual(judge(in_w, "m"), 2)          # marker in M only: no bypass through cd or -C
        self.assertEqual(judge(dash_c, "m"), 2)
        self.assertEqual(judge(in_m, "m"), 0)
        self.assertEqual(judge(in_m, "w"), 2)

    def test_a_commit_of_the_lock_script_needs_the_slow_marker(self):
        def commit(cmd, slow):
            return pretool.decide("Bash", {"command": cmd}, ROOT, False, slow_tests_ran=slow)
        for cmd in ("git commit -m x -- scripts/loop_lock.sh", "git commit -m x -- docs/a.md scripts/loop_lock.sh",
                    "git commit -m x -- ./scripts/loop_lock.sh", "cd scripts && git commit -m x -- loop_lock.sh"):
            code, why = commit(cmd, False)
            self.assertEqual(code, 2, (cmd, why))
            self.assertIn("LOOP_LOCK_SLOW_TESTS=1", why)
            self.assertIn("home: scripts/loop_lock.sh header (the rollout procedure)", why)
            self.assertEqual(commit(cmd, True), (0, ""), cmd)
        for cmd in ("git commit -m x -- scripts/other.sh", "git add -- scripts/loop_lock.sh",
                    "bash scripts/loop_lock.sh check", "git commit -m 'loop_lock.sh notes' -- docs/a.md"):
            self.assertEqual(commit(cmd, False), (0, ""), cmd)

    def test_neighbours_pass(self):
        self.assertEqual(self.edit("Edit", "logs/notes.md", holder="chain:s14"), (0, ""))
        self.assertEqual(self.edit("Edit", "scripts/other.sh", holder="chain:s14"), (0, ""))
        self.assertEqual(self.edit("Edit", "docs/logs/x.sh", holder="chain:s14"), (0, ""))   # not the root logs/
        self.assertEqual(self.edit("Edit", "scripts/loop_lock.sh.bak"), (0, ""))

    def test_an_absolute_path_and_a_deeper_chain_are_judged(self):
        code, why = self.edit("Write", os.path.join(ROOT, "logs", "x.sh"), holder="chain:s14")
        self.assertEqual(code, 2, why)
        code, why = self.edit("Write", os.path.join(ROOT, "logs", "sub", "y.sh").replace("\\", "/"), holder="h")
        self.assertEqual(code, 2, why)
        self.assertEqual(self.edit("Write", os.path.join(ROOT, "scripts", "loop_lock.sh"), holder="h")[0], 2)

    def test_every_editing_tool_and_path_key_is_judged_alike(self):
        for tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            for key in ("file_path", "path", "filePath", "notebook_path"):
                self.assertEqual(self.edit(tool, "logs/s14_chain.sh", holder="h", key=key)[0], 2, (tool, key))
                self.assertEqual(self.edit(tool, "scripts/loop_lock.sh", holder="h", key=key)[0], 2, (tool, key))

    def test_a_missing_path_and_other_tools_pass(self):
        self.assertEqual(pretool.decide("Edit", {}, ROOT, False, lock_holder="h"), (0, ""))
        self.assertEqual(pretool.decide("Edit", {"file_path": None}, ROOT, False, lock_holder="h"), (0, ""))
        self.assertEqual(pretool.decide("Read", {"file_path": "logs/s14_chain.sh"}, ROOT, False, lock_holder="h"),
                         (0, ""))

    def test_a_path_outside_any_lock_repository_passes(self):
        with tempfile.TemporaryDirectory(prefix="pretool_out_") as d:
            self.assertEqual(self.edit("Edit", os.path.join(d, "logs", "x.sh"), holder="h"), (0, ""))
            self.assertEqual(self.edit("Edit", os.path.join(d, "scripts", "loop_lock.sh"), holder="h"), (0, ""))

    def test_the_holder_is_parsed_from_check(self):
        self.assertEqual(pretool.parse_holder("HELD: chain:s14 taken 3 min ago, heartbeat 0 min (12 s) old, "
                                              "purpose: s14 chain (reapable after 20 min ...)\nQUEUED x"), "chain:s14")
        self.assertIsNone(pretool.parse_holder("FREE"))
        self.assertIsNone(pretool.parse_holder(""))
        queued = ("FREE, but 2 waiter(s) queued: the next grant goes to the first QUEUED line\n"
                  "QUEUED: w1 queued 30 s ago, heartbeat 2 s old (blob=abc p) [1]\n"
                  "QUEUED: STALE (dropped at the next grant) w2 queued 900 s ago, heartbeat 400 s old () [2]")
        self.assertEqual(pretool.parse_holder(queued), "queued:2")
        self.assertEqual(pretool.parse_holder("FREE, but 3 waiter(s) queued: ..."), "queued:3")

    def test_the_slow_marker_counts_only_when_newer_than_the_script(self):
        with tempfile.TemporaryDirectory(prefix="pretool_mk_") as d:
            os.makedirs(os.path.join(d, "scripts"))
            script = os.path.join(d, "scripts", "loop_lock.sh")
            open(script, "w").close()
            self.assertFalse(pretool.slow_tests_green(d))                    # no marker
            os.makedirs(os.path.join(d, "logs"))
            marker = os.path.join(d, "logs", ".loop_lock_slow_green")
            open(marker, "w").close()
            os.utime(script, (1000, 1000))
            os.utime(marker, (2000, 2000))
            self.assertTrue(pretool.slow_tests_green(d))
            os.utime(script, (3000, 3000))                                   # edited after the green run
            self.assertFalse(pretool.slow_tests_green(d))


class ClaudeDirIgnoreTest(unittest.TestCase):
    """The repository's .gitignore owns .claude/: settings.json, agents/ and skills/ tracked, the harness's local state
    ignored -- even on a machine whose global excludes file ignores `.claude/*` (the owner's does)."""

    def ignored(self, path):
        p = subprocess.run(["git", "check-ignore", "--no-index", "-q", path], cwd=ROOT, capture_output=True, text=True)
        self.assertIn(p.returncode, (0, 1), p.stderr)
        return p.returncode == 0

    def test_tracked_configuration_is_not_ignored(self):
        for path in (".claude/settings.json", ".claude/agents/x.md", ".claude/skills/x/SKILL.md"):
            self.assertFalse(self.ignored(path), path)

    def test_local_state_is_ignored(self):
        for path in (".claude/worktrees/x", ".claude/scheduled_tasks.lock", ".claude/settings.local.json",
                     ".claude/skills/s2u-bug-reports/SKILL.md"):
            self.assertTrue(self.ignored(path), path)


@unittest.skipUnless(BASH, "bash not found")
class PretoolWiringTest(unittest.TestCase):
    """The shell script, fed the JSON document Claude Code writes on stdin, run from somewhere else entirely."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pretool_")
        subprocess.run(["git", "init", "-q", self.tmp.name], check=True, capture_output=True)

    def tearDown(self):
        self.tmp.cleanup()

    def hook(self, command, tool_name="Bash"):
        doc = {"session_id": "t", "cwd": self.tmp.name, "hook_event_name": "PreToolUse",
               "tool_name": tool_name, "tool_input": {"command": command}, "tool_use_id": "toolu_t"}
        # cwd is the temp repo, not this one: the script must find its own repository, not the caller's
        return subprocess.run([BASH, HOOK_SH.replace("\\", "/")], input=json.dumps(doc), capture_output=True,
                              text=True, cwd=self.tmp.name, timeout=60)

    def test_bulk_add_is_refused(self):
        p = self.hook("git add -A")
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("home:", p.stderr)

    def test_status_passes(self):
        p = self.hook("git status")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, "")

    def test_push_is_refused_only_from_a_linked_worktree(self):
        git = ["git", "-C", self.tmp.name, "-c", "user.name=t", "-c", "user.email=t@t"]
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "x"], check=True, capture_output=True)
        linked = os.path.join(self.tmp.name, "linked")
        subprocess.run(git + ["worktree", "add", "-q", linked], check=True, capture_output=True)
        self.assertEqual(self.hook("git push origin x").returncode, 0)          # the main tree
        self.assertTrue(pretool.is_worktree_dir(linked))
        self.assertFalse(pretool.is_worktree_dir(self.tmp.name))
        p = self.hook("cd '%s' && git push origin x" % linked.replace("\\", "/"))
        self.assertEqual(p.returncode, 2, p.stderr)

    def test_bare_commit_refused_then_allowed_mid_merge(self):
        git = ["git", "-C", self.tmp.name, "-c", "user.name=t", "-c", "user.email=t@t"]
        self.assertEqual(self.hook("git commit --no-edit").returncode, 2)
        subprocess.run(git + ["commit", "-q", "--allow-empty", "-m", "base"], check=True, capture_output=True)
        head = subprocess.run(git + ["rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        with open(os.path.join(self.tmp.name, ".git", "MERGE_HEAD"), "w") as f:
            f.write(head + "\n")
        self.assertTrue(pretool.merge_in_progress_in(self.tmp.name))
        p = self.hook("git commit --no-edit")
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_a_bare_commit_in_a_conflicted_worktree_passes_from_the_main_tree(self):
        # G2b: the session's cwd is the main tree (no merge); the command cds into a linked worktree mid-merge
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C"]
        with open(os.path.join(self.tmp.name, "f"), "w") as f:
            f.write("base\n")
        subprocess.run(git + [self.tmp.name, "add", "f"], check=True, capture_output=True)
        subprocess.run(git + [self.tmp.name, "commit", "-q", "-m", "base"], check=True, capture_output=True)
        linked = os.path.join(self.tmp.name, "linked")
        subprocess.run(git + [self.tmp.name, "worktree", "add", "-q", "-b", "side", linked], check=True,
                       capture_output=True)
        for d, text in ((self.tmp.name, "main\n"), (linked, "side\n")):
            with open(os.path.join(d, "f"), "w") as f:
                f.write(text)
            subprocess.run(git + [d, "commit", "-q", "-am", text.strip()], check=True, capture_output=True)
        main_branch = subprocess.run(git + [self.tmp.name, "branch", "--show-current"], check=True,
                                     capture_output=True, text=True).stdout.strip()
        merged = subprocess.run(git + [linked, "merge", main_branch], capture_output=True, text=True)
        self.assertNotEqual(merged.returncode, 0, "the merge should conflict")
        self.assertTrue(pretool.merge_in_progress_in(linked))
        self.assertFalse(pretool.merge_in_progress_in(self.tmp.name))
        self.assertEqual(self.hook("git commit --no-edit").returncode, 2)     # the main tree: no merge there
        p = self.hook("cd '%s' && git commit --no-edit" % linked.replace("\\", "/"))
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_gh_pr_merge_delete_branch_reaches_python(self):
        # the fast path must not wave it through: the JSON of `gh pr merge 76 -d` names no `git`
        p = self.hook("gh pr merge 76 -d")
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("--delete-branch", p.stderr)
        self.assertEqual(self.hook("gh pr view 76").returncode, 0)

    def test_other_tool_passes(self):
        self.assertEqual(self.hook("git add -A", tool_name="Read").returncode, 0)

    def test_fast_path_skips_python_when_no_git_or_lock_is_named(self):
        # PYTHON is a stand-in that leaves a marker and refuses: it must not run for `ls`, and must for `git status`
        marker = os.path.join(self.tmp.name, "ran")
        fake = os.path.join(self.tmp.name, "fakepy.sh")
        with open(fake, "w", newline="\n") as f:
            f.write("#!/bin/sh\ntouch '%s'\nexit 2\n" % marker.replace("\\", "/"))
        os.chmod(fake, 0o755)
        env = dict(os.environ, PYTHON=fake.replace("\\", "/"))

        def run(command):
            doc = {"tool_name": "Bash", "tool_input": {"command": command}, "cwd": "."}
            return subprocess.run([BASH, HOOK_SH.replace("\\", "/")], input=json.dumps(doc), capture_output=True,
                                  text=True, cwd=self.tmp.name, env=env, timeout=60)
        for quiet in ("ls -la", "echo merge", "grep merge x", "bash scripts/parity/merged_chain.sh"):
            self.assertEqual(run(quiet).returncode, 0, quiet)
            self.assertFalse(os.path.exists(marker), quiet)
        for loud in ("gh pr merge 76 -d", "gh.exe pr merge 76 -d"):   # `gh pr` names no git: it must reach Python
            self.assertEqual(run(loud).returncode, 2, loud)
            self.assertTrue(os.path.exists(marker), loud)
            os.remove(marker)
        self.assertEqual(run("GIT status").returncode, 2)
        self.assertTrue(os.path.exists(marker))

    STUB = "#!/usr/bin/env bash\n[ \"$1\" = check ] && cat .check_out 2>/dev/null\nexit 0\n"

    def stub_lock(self, check_text, root=None):
        """A stub scripts/loop_lock.sh in root (the temp repo by default) whose `check` prints root/.check_out,
        which is check_text: the script's own bytes, hence its blob, stay the same whatever `check` says."""
        root = root or self.tmp.name
        os.makedirs(os.path.join(root, "scripts"), exist_ok=True)
        with open(os.path.join(root, "scripts", "loop_lock.sh"), "w", newline="\n") as f:
            f.write(self.STUB)
        with open(os.path.join(root, ".check_out"), "w", newline="\n") as f:
            f.write(check_text + "\n")

    def blob12(self, path):
        return subprocess.run(["git", "hash-object", path], check=True, capture_output=True,
                              text=True).stdout.strip()[:12]

    def linked_worktree(self):
        """Commit the stub lock script in the temp repo (the MAIN tree) and add a linked worktree that has it."""
        git = ["git", "-C", self.tmp.name, "-c", "user.name=t", "-c", "user.email=t@t"]
        self.stub_lock("FREE")
        subprocess.run(git + ["add", "--", "scripts/loop_lock.sh"], check=True, capture_output=True)
        subprocess.run(git + ["commit", "-q", "-m", "stub"], check=True, capture_output=True)
        linked = os.path.join(self.tmp.name, "linked")
        subprocess.run(git + ["worktree", "add", "-q", "-b", "side", linked], check=True, capture_output=True)
        return linked

    def edit_hook(self, path, tool_name="Edit"):
        doc = {"session_id": "t", "cwd": self.tmp.name, "hook_event_name": "PreToolUse", "tool_name": tool_name,
               "tool_input": {"file_path": path, "old_string": "a", "new_string": "b"}, "tool_use_id": "toolu_t"}
        return subprocess.run([BASH, HOOK_SH.replace("\\", "/")], input=json.dumps(doc), capture_output=True,
                              text=True, cwd=self.tmp.name, timeout=60)

    def test_an_edit_of_a_running_chain_script_is_refused(self):
        chain = os.path.join(self.tmp.name, "logs", "s14_chain.sh")
        self.stub_lock("HELD: chain:s14 taken 3 min ago, heartbeat 0 min (5 s) old, purpose: s14")
        p = self.edit_hook(chain)                                              # not on disk: a new file
        self.assertEqual(p.returncode, 0, p.stderr)
        os.makedirs(os.path.dirname(chain))
        with open(chain, "w", newline="\n") as f:
            f.write("echo step\n")
        p = self.edit_hook(chain)                                              # existing, HELD
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("chain:s14", p.stderr)
        self.assertEqual(self.edit_hook(chain.replace("\\", "/"), tool_name="Write").returncode, 2)
        self.stub_lock("FREE, but 1 waiter(s) queued: the next grant goes to the first QUEUED line\n"
                       "QUEUED: w1 queued 30 s ago, heartbeat 2 s old (blob=%s p) [1]"
                       % self.blob12(os.path.join(self.tmp.name, "scripts", "loop_lock.sh")))
        p = self.edit_hook(chain)                                              # QUEUED only: not started
        self.assertEqual(p.returncode, 0, p.stderr)
        self.stub_lock("FREE")
        p = self.edit_hook(chain)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_an_edit_of_the_main_trees_lock_script(self):
        # the temp repo is a MAIN tree: HELD refuses its copy; a waiter refuses only the copy it runs
        script = os.path.join(self.tmp.name, "scripts", "loop_lock.sh")
        self.stub_lock("HELD: chain:s14 taken 3 min ago, heartbeat 0 min (5 s) old")
        p = self.edit_hook(script)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("chain:s14", p.stderr)
        waiter = ("FREE, but 1 waiter(s) queued: the next grant goes to the first QUEUED line\n"
                  "QUEUED: w1 queued 30 s ago, heartbeat 2 s old (blob=%s p) [1]")
        self.stub_lock(waiter % self.blob12(script))
        p = self.edit_hook(script)
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("blob %s" % self.blob12(script), p.stderr)
        self.stub_lock(waiter % "ffffffffffff")
        p = self.edit_hook(script)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.stub_lock("FREE")
        p = self.edit_hook(script)
        self.assertEqual(p.returncode, 0, p.stderr)

    def test_an_edit_of_a_worktrees_lock_script(self):
        # a linked worktree's copy: HELD alone passes (the loop runs the main tree's); a waiter on this copy refuses
        linked = self.linked_worktree()
        script = os.path.join(linked, "scripts", "loop_lock.sh")
        self.stub_lock("HELD: agent-x51 taken 3 min ago, heartbeat 0 min (5 s) old", root=linked)
        p = self.edit_hook(script)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.stub_lock("HELD: agent-x51 taken 3 min ago, heartbeat 0 min (5 s) old\n"
                       "QUEUED: w1 queued 30 s ago, heartbeat 2 s old (blob=%s p) [1]" % self.blob12(script),
                       root=linked)
        p = self.edit_hook(script)
        self.assertEqual(p.returncode, 2, p.stderr)

    def test_a_commit_of_the_lock_script_is_judged_on_the_marker_where_it_lands(self):
        # G2 review: the session's cwd is the main tree M; the commit cds (or -C) into the worktree W
        linked = self.linked_worktree()
        wd = linked.replace("\\", "/")
        in_w = "cd '%s' && git commit -m x -- scripts/loop_lock.sh" % wd
        dash_c = "git -C '%s' commit -m x -- scripts/loop_lock.sh" % wd

        def mark(root, fresh):
            os.makedirs(os.path.join(root, "logs"), exist_ok=True)
            marker = os.path.join(root, "logs", ".loop_lock_slow_green")
            if fresh:
                open(marker, "w").close()
                os.utime(os.path.join(root, "scripts", "loop_lock.sh"), (1000, 1000))
                os.utime(marker, (2000, 2000))
            elif os.path.exists(marker):
                os.remove(marker)
        mark(linked, True)                                                     # marker in W only
        mark(self.tmp.name, False)
        self.assertEqual(self.hook(in_w).returncode, 0)
        self.assertEqual(self.hook(dash_c).returncode, 0)
        self.assertEqual(self.hook("git commit -m x -- scripts/loop_lock.sh").returncode, 2)
        mark(linked, False)                                                    # marker in M only
        mark(self.tmp.name, True)
        self.assertEqual(self.hook(in_w).returncode, 2)
        self.assertEqual(self.hook(dash_c).returncode, 2)
        self.assertEqual(self.hook("git commit -m x -- scripts/loop_lock.sh").returncode, 0)

    def test_a_commit_of_the_lock_script_waits_for_a_fresh_slow_marker(self):
        self.stub_lock("FREE")
        script = os.path.join(self.tmp.name, "scripts", "loop_lock.sh")
        commit = "git commit -m x -- scripts/loop_lock.sh"
        p = self.hook(commit)                                                  # no marker
        self.assertEqual(p.returncode, 2, p.stderr)
        self.assertIn("LOOP_LOCK_SLOW_TESTS=1", p.stderr)
        os.makedirs(os.path.join(self.tmp.name, "logs"), exist_ok=True)
        marker = os.path.join(self.tmp.name, "logs", ".loop_lock_slow_green")
        open(marker, "w").close()
        os.utime(script, (1000, 1000))
        os.utime(marker, (2000, 2000))
        p = self.hook(commit)                                                  # a marker newer than the script
        self.assertEqual(p.returncode, 0, p.stderr)
        os.utime(script, (3000, 3000))
        p = self.hook(commit)                                                  # the script changed after it
        self.assertEqual(p.returncode, 2, p.stderr)

    def test_an_ordinary_edit_skips_python(self):
        fake = os.path.join(self.tmp.name, "fakepy.sh")
        with open(fake, "w", newline="\n") as f:
            f.write("#!/bin/sh\nexit 2\n")
        os.chmod(fake, 0o755)
        doc = {"tool_name": "Edit", "tool_input": {"file_path": "C:/x/docs/notes.md"}, "cwd": "."}
        p = subprocess.run([BASH, HOOK_SH.replace("\\", "/")], input=json.dumps(doc), capture_output=True, text=True,
                           cwd=self.tmp.name, env=dict(os.environ, PYTHON=fake.replace("\\", "/")), timeout=60)
        self.assertEqual(p.returncode, 0)

    def test_garbage_on_stdin_passes(self):
        p = subprocess.run([BASH, HOOK_SH.replace("\\", "/")], input="not json", capture_output=True, text=True,
                           cwd=self.tmp.name, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)


class CommitMsgTest(unittest.TestCase):
    """Sprint 14 S2: the commit-msg hook caps the subject at 120 characters (the review's 03-git-forensics.md
    section 5: median 126, 42 % of merge subjects over 200). Each exemption is planted once."""

    SENTENCE = "put the finding in the body; home: docs/GIT_STRATEGY.md section 3"

    @staticmethod
    def subject(n, prefix="feat(x): "):
        return (prefix + "a" * n)[:n]

    def test_121_is_refused_with_the_sentence(self):
        code, why = commitmsg.check(self.subject(121) + "\n")
        self.assertEqual(code, 1)
        self.assertIn("subject over 120 chars (121)", why)
        self.assertIn(self.SENTENCE, why)

    def test_120_and_119_pass(self):
        self.assertEqual(commitmsg.check(self.subject(120)), (0, ""))
        self.assertEqual(commitmsg.check(self.subject(119) + "\n\nbody\n"), (0, ""))

    def test_merge_default_is_exempt_only_with_a_body(self):
        merge = ("Merge branch '" + "b" * 100 + "' into sprint-14" + "x" * 130)[:130]
        self.assertEqual(len(merge), 130)
        self.assertEqual(commitmsg.check(merge + "\n\nThe finding.\n")[0], 0)
        self.assertEqual(commitmsg.check(merge + "\n")[0], 1)
        # a trailer block and comment lines are not a body
        self.assertEqual(commitmsg.check(merge + "\n\n# Conflicts:\n#\tx\n\nCo-Authored-By: A <a@b>\n")[0], 1)
        for head in ("Merge remote-tracking branch 'origin/", "Merge pull request #12 from "):
            m = (head + "c" * 130)[:130]
            self.assertEqual(commitmsg.check(m + "\n\nbody\n")[0], 0, head)
            self.assertEqual(commitmsg.check(m)[0], 1, head)

    def test_the_house_merge_prefix_is_not_a_default(self):
        m = self.subject(130, "merge agent/s14-i5: ")
        self.assertEqual(commitmsg.check(m + "\n\nbody\n")[0], 1)

    def test_revert_default_with_a_body_passes(self):
        r = ('Revert "' + "r" * 130)[:129] + '"'
        self.assertEqual(len(r), 130)
        self.assertEqual(commitmsg.check(r + "\n\nThis reverts commit 0123456789abcdef.\n")[0], 0)
        self.assertEqual(commitmsg.check(r + "\n")[0], 1)

    def test_fixup_follows_the_wrapped_subject(self):
        code, why = commitmsg.check("fixup! " + self.subject(125) + "\n")
        self.assertEqual(code, 1)
        self.assertIn(self.SENTENCE, why)
        self.assertEqual(commitmsg.check("squash! " + self.subject(118))[0], 0)
        merge = ("Merge branch '" + "b" * 130)[:130]
        self.assertEqual(commitmsg.check("fixup! " + merge + "\n\nbody\n")[0], 0)

    def test_only_comments_passes(self):
        self.assertEqual(commitmsg.check("# Please enter the commit message\n#\n# " + "x" * 200 + "\n"), (0, ""))
        self.assertEqual(commitmsg.check(""), (0, ""))

    def test_leading_comments_and_blank_lines_are_skipped(self):
        self.assertEqual(commitmsg.check("# c\n\n" + self.subject(121) + "\n")[0], 1)

    def test_the_subject_is_the_first_paragraph(self):
        # git's subject (%s, --oneline, GitHub) is the lines up to the first blank line, joined with spaces
        code, why = commitmsg.check("a" * 100 + "\n" + "b" * 100 + "\n\nbody\n")
        self.assertEqual(code, 1)
        self.assertIn("subject over 120 chars (201)", why)
        self.assertEqual(commitmsg.check("c" * 120 + "\n"), (0, ""))
        self.assertEqual(commitmsg.check("a" * 60 + "\n" + "b" * 59 + "\n\nbody\n"), (0, ""))   # 60 + 1 + 59

    def test_reapply_default_with_a_body_passes(self):
        r = ('Reapply "' + "r" * 130)[:129] + '"'
        self.assertEqual(commitmsg.check(r + "\n\nThis reverts commit 0123456789abcdef.\n")[0], 0)
        self.assertEqual(commitmsg.check(r + "\n")[0], 1)

    def test_a_bom_is_not_a_character(self):
        import contextlib
        import io
        with tempfile.NamedTemporaryFile("wb", suffix=".msg", delete=False) as f:
            f.write(b"\xef\xbb\xbf" + b"d" * 120 + b"\n")
        try:
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                code = commitmsg.main(["commitmsg", f.name])
        finally:
            os.unlink(f.name)
        self.assertEqual(code, 0, err.getvalue())

    def test_a_trailer_block_needs_a_known_trailer(self):
        merge = ("Merge branch '" + "b" * 130)[:130]
        # a last paragraph shaped like `Token: value` but naming no known trailer is a body
        self.assertEqual(commitmsg.check(merge + "\n\nNote: the finding\n")[0], 0)
        # every line token-shaped and one of them known: a trailer block, not a body
        self.assertEqual(commitmsg.check(merge + "\n\nNote: x\nSigned-off-by: A <a@b>\n")[0], 1)
        # a line that is not token-shaped makes the paragraph a body
        self.assertEqual(commitmsg.check(merge + "\n\nCo-Authored-By: A <a@b>\nand a sentence\n")[0], 0)

    def test_main_on_a_broken_input_passes_and_says_so(self):
        import contextlib
        import io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = commitmsg.main(["commitmsg", os.path.join(tempfile.gettempdir(), "no_such_msg_file_s14s2")])
        self.assertEqual(code, 0)
        self.assertIn("commit-msg", err.getvalue())


@unittest.skipUnless(BASH, "bash not found")
class CommitMsgWiringTest(unittest.TestCase):
    """scripts/hooks/commit-msg on a temp message file, run from the repository root (where git runs hooks)."""

    HOOK = os.path.join(ROOT, "scripts", "hooks", "commit-msg")

    def run_hook(self, message):
        with tempfile.NamedTemporaryFile("w", suffix=".msg", delete=False, encoding="utf-8", newline="\n") as f:
            f.write(message)
        try:
            return subprocess.run([BASH, self.HOOK.replace("\\", "/"), f.name.replace("\\", "/")],
                                  capture_output=True, text=True, cwd=ROOT, timeout=60)
        finally:
            os.unlink(f.name)

    def test_long_subject_is_refused(self):
        p = self.run_hook("feat(x): " + "a" * 121 + "\n")
        self.assertEqual(p.returncode, 1, p.stderr)
        self.assertIn("subject over 120 chars (130)", p.stderr)

    def test_short_subject_passes(self):
        p = self.run_hook("test: a short subject\n")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(p.stderr, "")


if __name__ == "__main__":
    unittest.main()
