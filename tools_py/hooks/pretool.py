"""The PreToolUse guard: refuse a Bash call that breaks one of the repository's git or lock rules (Sprint 14 G1).

Claude Code runs `scripts/hooks/claude_pretool.sh` before every Bash tool call (`.claude/settings.json`) and writes
the call on stdin as JSON: `tool_name`, `tool_input` (for Bash, `tool_input.command`), `cwd`, plus session fields
this module ignores. Exit 2 blocks the call and Claude sees stderr; exit 0 lets it through. Any other exit code is
a non-blocking error in Claude Code, so this module never uses one: every failure -- bad JSON, a command shlex
cannot parse, a git that will not answer -- allows the call. A guard with false positives gets switched off.

`decide()` is the whole policy and is what tools_py/tests/test_hooks.py drives; `main()` is the stdin/exit shell
around it. Each rule is one small function over one simple command (the command is split on `;`, `&&`, `||`, `|`,
`&`, parentheses, brace groups and newlines, after heredoc bodies are dropped; wrappers such as `time`, `env`,
`sudo` and `xargs` are stripped; a `bash -c`/`sh -c`/`eval` payload is judged as a command of its own) that
returns None or (rule, sentence, home). `cd`/`pushd`/`popd` and `git -C` move the directory the worktree rules
judge; a subshell's `cd` ends at its `)`. The same tracked directory decides the one merge exception: a `git commit`
without a pathspec passes when that directory's repository has a MERGE_HEAD (git refuses a partial commit
mid-merge), so `cd <worktree> && git commit --no-edit` concludes a merge there whatever the session's own cwd is
(Sprint 14 G2b; the state is asked of git once per directory, and only for a commit).

Known limits, each accepted (nobody writes these by accident, and the hook is a guard against slips, not a sandbox):
- a quoted string that contains `<<WORD` (`echo "a <<EOF"`) is taken for a heredoc and hides the lines after it up
  to a WORD line;
- a `$(...)` inside double quotes, and a backtick substitution (`` `git add -A` `` inside another command), are not
  looked into;
- `eval eval ...` and a `bash -c` inside a `bash -c` are judged one level deep only;
- a file-descriptor number before a redirection is read as an argument (`git commit ... -- 2>&1` takes `2` for a
  pathspec);
- git configuration passed through the environment (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`/`_KEY_n`) is not
  read, so a hooksPath set there is not seen;
- the shell's fast path matches the substrings `git`, `gh pr`, `loop_lock` and `logs/` (or `logs` and a backslash) in
  the JSON (`gh pr` and `gh.exe pr` with one space), so a spelling that hides them (`gi''t`, `gh  pr`) never
  reaches Python;
- `gh pr merge` is found by the word `pr` after `gh` and `merge` right after it; a gh alias hiding them is not seen.

Sprint 14 G2 adds the editing tools (Edit, Write, MultiEdit, NotebookEdit; the path from `tool_input.file_path`,
`notebook_path`, or defensively `path`/`filePath`), judged on `bash scripts/loop_lock.sh check` (asked only for such a
path; the lock is shared by every worktree, so the rules name what is actually running): an EXISTING
`logs/**/*.sh` of a repository that has scripts/loop_lock.sh is refused while the lock is HELD (a new file cannot be
running, and a QUEUED waiter has not started its chain); scripts/loop_lock.sh is refused when a QUEUED waiter's
`blob=` equals the file's `git hash-object` (that waiter reads this copy by offset), or while the lock is HELD and
the file is the main tree's copy (the loop's `run` wrappers start there) -- a worktree's copy passes. An edit through
Bash (`sed -i`, a heredoc) is not seen by this half. Landing the lock script is the Bash half's rule: a
`git commit -- ... loop_lock.sh` is refused until logs/.loop_lock_slow_green (written by a complete green slow lock
suite) is newer than the script, in the repository the commit works in (after `cd`/`git -C`, like the merge
exception; looked at only for a commit naming loop_lock.sh). The marker gates the commit form the loop uses, not
every way the file can land: a glob pathspec (`-- 'scripts/*.sh'`), `git commit -i`, and `git merge` or
`git cherry-pick` of a commit that changes it are not judged.

Sprint 17 G1 adds two things. The chain's tree: while a merged chain runs, its tree's `logs/.merged_chain.running`
names a live pid (tools_py/hooks/chainmark.py), and an editing tool's path that is a TRACKED file of that tree is
refused (pinned_edit) -- the chain reds on any tracked file changed under it, before it looks at HEAD; untracked
files, logs/ and every other tree pass. The shell's fast path starts Python for an editing call when such a marker
exists in the hook's own tree or in the main tree (read from a linked worktree's `.git` file); a chain in a third
tree is judged only when the call reaches Python for another reason. And the PowerShell tool: its `command` is
judged by the Bash rules (`Set-Location`/`sl`/`chdir`, `Push-Location`, `Pop-Location` move the directory as
`cd`/`pushd`/`popd` do); PowerShell's own quoting (the backtick escape) is read as a POSIX shell would read it.
The rules, their homes and their tests: docs/DEVELOPING.md, "Guards".
"""
import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys

from tools_py.hooks import chainmark

GIT_COMMITS = "docs/GIT_STRATEGY.md section 3 (Commits)"
GIT_BRANCHES = "docs/GIT_STRATEGY.md section 2 (Branches)"
AGENT_WORKTREE = "scripts/agent_worktree.sh"
LOOP_LOCK = "scripts/loop_lock.sh"
HANDOFF_RULE_1 = "docs/HANDOFF.md section 4 rule 1"

_PUNCT = "();<>|&\n"
_HEREDOC = re.compile(r"<<(-?)\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\2")

# git's global options that take a separate value (`git -C dir status`)
_GIT_GLOBAL_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"}

# wrappers that run the rest of the line as the command: name -> its options that take a separate value
_WRAPPERS = {
    "time": set(), "command": set(), "exec": {"-a"}, "nice": {"-n", "--adjustment"},
    "env": {"-u", "--unset", "-C", "--chdir", "-S", "--split-string"},
    "sudo": {"-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T"},
    "xargs": {"-I", "-i", "-n", "-L", "-l", "-d", "-P", "-s", "-E", "-e", "-a", "--arg-file", "--delimiter",
              "--max-args", "--max-procs", "--max-lines", "--replace", "--max-chars", "--eof"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"}, "nohup": set(),
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "ionice": {"-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"},
}
# wrappers that take positional words before the command: `timeout 60 git ...`
_WRAPPER_POSITIONALS = {"timeout": 1}
_SHELLS = {"bash", "sh", "dash", "zsh", "ksh"}

_PROTECTED_BRANCHES = ("main", "sprint-*")


# ---------------------------------------------------------------------------------------------- parsing

def _drop_heredoc_bodies(command):
    """The lines of a heredoc body are data, not commands: drop them and their delimiter line."""
    out, lines, i = [], command.split("\n"), 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        for m in _HEREDOC.finditer(line):
            if line[m.start():m.start() + 3] == "<<<":
                continue                                  # a here-string, not a heredoc
            delim = m.group(3)
            while i < len(lines) and lines[i].strip() != delim:
                i += 1
            i += 1                                        # the delimiter line itself
    return "\n".join(out)


def items(command):
    """The command as a list of ("cmd", tokens), ("open",) and ("close",) for a subshell's parentheses.

    Raises ValueError when shlex cannot parse it. A redirection's target is dropped with its operator; `{` and `}`
    are separators (a brace group runs in the current shell, so it opens no scope).
    """
    lex = shlex.shlex(_drop_heredoc_bodies(command), posix=True, punctuation_chars=_PUNCT)
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    out, cur, skip_next = [], [], False

    def flush():
        if cur:
            out.append(("cmd", list(cur)))
            del cur[:]

    for tok in lex:
        if tok and all(ch in _PUNCT for ch in tok):
            if ("<" in tok or ">" in tok) and all(ch in "<>&|" for ch in tok):
                skip_next = True                          # `> file`, `2>&1`, `<< EOF`: the next word is the target
                continue
            for ch in tok:
                if ch == "(":
                    flush()
                    out.append(("open",))
                elif ch == ")":
                    flush()
                    out.append(("close",))
                elif ch in ";|&\n":
                    flush()
            continue
        if skip_next:
            skip_next = False
            continue
        if tok in ("{", "}") and not cur or tok == "}":
            flush()
            continue
        cur.append(tok)
    flush()
    return out


def segments(command):
    """The simple commands of a command line, as token lists."""
    return [it[1] for it in items(command) if it[0] == "cmd"]


def _strip_env(seg):
    """`FOO=1 time sudo git push` is a git command: drop leading assignments and wrapper commands with their options."""
    i = 0
    while i < len(seg):
        tok = seg[i]
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", tok):
            i += 1
            continue
        name = os.path.basename(tok)
        if name not in _WRAPPERS:
            break
        with_value = _WRAPPERS[name]
        i += 1
        while i < len(seg) and seg[i].startswith("-") and seg[i] != "-":
            if seg[i] == "--":
                i += 1
                break
            i += 2 if seg[i] in with_value else 1         # `nice -5`, `sudo -E`: one word; `-n 5`, `-u x`: two
        i += _WRAPPER_POSITIONALS.get(name, 0)
    return seg[i:]


def shell_payload(seg):
    """The command string of `bash -c "..."`, `sh -c '...'` or `eval ...`, or None."""
    seg = _strip_env(seg)
    if not seg:
        return None
    name = os.path.basename(seg[0]).lower()
    if name.endswith(".exe"):
        name = name[:-4]
    if name == "eval":
        return " ".join(seg[1:]) or None
    if name not in _SHELLS:
        return None
    for i, a in enumerate(seg[1:], 1):
        if a.startswith("-") and not a.startswith("--") and "c" in a[1:]:
            rest = [b for b in seg[i + 1:] if not b.startswith("-")]
            return rest[0] if rest else None
        if not a.startswith("-"):
            return None                                   # `bash script.sh ...`: a script, not a string
    return None


def git_parts(seg):
    """(global_options, subcommand, args) for a git command, or None when the segment is not one."""
    seg = _strip_env(seg)
    if not seg or os.path.basename(seg[0]).lower() not in ("git", "git.exe"):
        return None
    opts, i = [], 1
    while i < len(seg) and seg[i].startswith("-"):
        opts.append(seg[i])
        if seg[i] in _GIT_GLOBAL_WITH_VALUE and i + 1 < len(seg):
            opts.append(seg[i + 1])
            i += 1
        i += 1
    if i >= len(seg):
        return opts, None, []
    return opts, seg[i], seg[i + 1:]


def _git_dash_c(opts):
    """The directory of the last `git -C <dir>`, or None."""
    d = None
    for k, v in zip(opts, opts[1:]):
        if k == "-C":
            d = v
    return d


def _git_config_overrides(opts):
    """The `key=value` strings of every `-c key=value` / `-ckey=value` / `--config-env key=VAR` global option."""
    out = []
    for k, v in zip(opts, opts[1:] + [""]):
        if k in ("-c", "--config-env"):
            out.append(v)
        elif k.startswith("-c") and len(k) > 2:
            out.append(k[2:])
        elif k.startswith("--config-env="):
            out.append(k.split("=", 1)[1])
    return out


# ---------------------------------------------------------------------------------------------- the rules
# Each: (tokens of one segment, is_worktree, **context) -> None or (rule, sentence, home). The context carries
# merge_in_progress and session_worktree; a rule ignores what it does not use.

_WHOLE_TREE = (".", "./", ":/", ":", "*", ":/*", ":/.")


def rule_bulk_add(seg, wt, **ctx):
    g = git_parts(seg)
    if not g or g[1] != "add":
        return None
    args, bulk_flag, loose, after, after_dd = g[2], None, [], [], False
    for a in args:
        if after_dd:
            after.append(a)
        elif a == "--":
            after_dd = True
        elif a.startswith("--pathspec-from-file"):
            after.append(a)
        elif a in ("--all", "--update", "--no-ignore-removal"):
            bulk_flag = a
        elif a.startswith("-") and not a.startswith("--") and ("A" in a[1:] or "u" in a[1:]):
            bulk_flag = a
        elif not a.startswith("-"):
            loose.append(a)
    for p in loose + after:
        if p in _WHOLE_TREE:                              # the whole tree, spelled as a pathspec
            return _bulk(p)
    if bulk_flag and not after:                           # a bulk flag is limited only by an explicit `-- <paths>`
        return _bulk(bulk_flag)
    if not loose and not after:
        return _bulk("no pathspec")
    return None


def _bulk(what):
    return ("bulk add", "`git add` with %s stages every change in the tree, other sessions' files with it; "
            "name the paths: `git add -- <paths>`, or for a computed list `git add --pathspec-from-file=<list>` "
            "(`xargs git add` shows no pathspec)" % what, GIT_COMMITS)


# commit's short options that take a value; the rest of a cluster after one of them is that value
_COMMIT_SHORT_WITH_VALUE = set("mFcCtuS")


def _commit_short_flags(args):
    """The single-letter flags of a `git commit` argument list, values skipped."""
    flags, skip = set(), False
    for a in args:
        if skip:
            skip = False
            continue
        if a == "--":
            break
        if not a.startswith("-") or a.startswith("--") or a == "-":
            continue
        for j, ch in enumerate(a[1:]):
            flags.add(ch)
            if ch in _COMMIT_SHORT_WITH_VALUE:
                if j == len(a) - 2 and ch in "mFcCt":     # the value is the next argument
                    skip = True
                break
    return flags


def _long_opts(args):
    out = []
    for a in args:
        if a == "--":
            break
        if a.startswith("--"):
            out.append(a.split("=", 1)[0])
    return out


def rule_commit_all(seg, wt, **ctx):
    g = git_parts(seg)
    if not g or g[1] != "commit":
        return None
    if "--all" in _long_opts(g[2]) or "a" in _commit_short_flags(g[2]):
        return ("commit -a", "`git commit -a` commits every tracked change, other sessions' edits with it; "
                "commit named paths: `git commit -m ... -- <paths>`", GIT_COMMITS)
    return None


def _has_pathspec_after_dd(args):
    if any(a.startswith("--pathspec-from-file") for a in args):
        return True
    return "--" in args and args.index("--") < len(args) - 1


def rule_commit_names_paths(seg, wt, merge_in_progress=False, **ctx):
    """A commit without `-- <paths>` takes the whole index, and the main tree's index is shared between sessions.

    Git's one exception: during a merge a partial commit is impossible, so a bare commit passes when MERGE_HEAD exists
    in the directory the commit works in (decide_bash asks merge_probe for it).
    """
    g = git_parts(seg)
    if not g or g[1] != "commit" or merge_in_progress or _has_pathspec_after_dd(g[2]):
        return None
    return ("commit without paths", "a commit names its paths: `git commit -m ... -- <paths>` (a bare commit takes "
            "whatever any session staged)", HANDOFF_RULE_1)


def _is_no_verify(opt):
    """`--no-verify` or any abbreviation git would accept for it, from `--no-v` up (git takes unique prefixes)."""
    return len(opt) >= 6 and "--no-verify".startswith(opt)


def rule_no_verify(seg, wt, **ctx):
    g = git_parts(seg)
    if not g:
        return None
    hit = any(_is_no_verify(a.split("=", 1)[0]) for a in g[0] + _long_opts(g[2]))
    if not hit and g[1] == "commit" and "n" in _commit_short_flags(g[2]):
        hit = True
    if not hit and any(o.split("=", 1)[0].strip().lower() == "core.hookspath" for o in _git_config_overrides(g[0])):
        hit = True
    if hit:
        return ("no-verify", "--no-verify (or -n, or `-c core.hooksPath=`) skips the leak check the hooks run; fix "
                "the hit, or record a reviewed line in tools_py/release/leak_allow.txt", GIT_COMMITS)
    return None


def rule_push_from_worktree(seg, wt, session_worktree=False, **ctx):
    g = git_parts(seg)
    if not g or g[1] != "push" or not (wt or session_worktree):
        return None
    return ("push from a worktree", "an agent worktree does not push, not even through `cd` or `git -C` into the "
            "main tree; the controller pushes from the main tree", GIT_COMMITS)


# push's options that take a separate value
_PUSH_WITH_VALUE = {"--repo", "--receive-pack", "--exec", "-o", "--push-option"}


def _push_target(refspec):
    """The branch a refspec updates, or None when it cannot be told from the words (HEAD, a bare `+`)."""
    ref = refspec.lstrip("+")
    dst = ref.split(":", 1)[1] if ":" in ref else ref
    if dst.startswith("refs/heads/"):
        dst = dst[len("refs/heads/"):]
    if not dst or dst == "HEAD" or dst.startswith("@"):
        return None
    return dst


def _protected(target):
    return target is None or any(fnmatch.fnmatchcase(target, pat) for pat in _PROTECTED_BRANCHES)


def rule_force_push_shared(seg, wt, **ctx):
    g = git_parts(seg)
    if not g or g[1] != "push":
        return None
    force, delete, mirror, positional, skip = False, False, False, [], False
    for a in g[2]:
        if skip:
            skip = False
            continue
        if a == "--":
            continue
        if a.startswith("--"):
            name = a.split("=", 1)[0]
            if name.startswith("--force"):                # --force, --force-with-lease, --force-if-includes
                force = True
            elif name == "--delete":
                delete = True
            elif name == "--mirror":
                mirror = True
            elif name in _PUSH_WITH_VALUE and "=" not in a:
                skip = True
        elif a.startswith("-") and len(a) > 1:
            if "f" in a[1:]:
                force = True
            if "d" in a[1:]:
                delete = True
            if a in _PUSH_WITH_VALUE:
                skip = True
        else:
            positional.append(a)
    refspecs = positional[1:]                             # the first is the remote
    if mirror:
        return ("mirror push", "`git push --mirror` rewrites and deletes every branch on the remote, main with them; "
                "never rewrite main", GIT_BRANCHES)
    gone = [r for r in refspecs if (delete or r.lstrip("+").startswith(":")) and _protected(_push_target(r))
            and _push_target(r) is not None]
    if gone:
        return ("delete of a shared branch", "a push that deletes %s (`--delete`, or an empty-source refspec) removes "
                "a shared branch; never rewrite main or a sprint branch" % gone[0], GIT_BRANCHES)
    if force:
        hits = [r for r in refspecs if _protected(_push_target(r))] if refspecs else ["(the default refspec)"]
    else:
        hits = [r for r in refspecs if r.startswith("+") and _protected(_push_target(r))]
    if not hits:
        return None
    return ("force-push of a shared branch", "never force-push a shared branch (main, sprint-*; an unnamed target may "
            "be one): %s; force only agent/*, fix/*, feat/*, docs/*, spike/* branches" % hits[0], GIT_BRANCHES)


_CONFIG_READ_FLAGS = {"--get", "--get-all", "--list", "-l", "--get-regexp", "--get-urlmatch", "--get-color",
                      "--get-colorbool"}
_CONFIG_WRITE_FLAGS = {"--unset", "--unset-all", "--remove-section", "--rename-section", "-e", "--edit", "--add",
                       "--replace-all"}
_CONFIG_SCOPES_ELSEWHERE = {"--worktree", "--global", "--system", "-f", "--file", "--blob"}
_CONFIG_READ_SUBCOMMANDS = {"get", "list"}
_CONFIG_WRITE_SUBCOMMANDS = {"set", "unset", "rename-section", "remove-section", "edit"}
_CONFIG_WITH_VALUE = {"--type", "--default", "--comment", "--value", "-f", "--file", "--blob"}


def rule_config_in_worktree(seg, wt, **ctx):
    g = git_parts(seg)
    if not g or g[1] != "config" or not wt:
        return None
    opts, positional, skip = [], [], False
    for a in g[2]:
        if skip:
            skip = False
            continue
        if a.startswith("-"):
            name = a.split("=", 1)[0]
            opts.append(name)
            if name in _CONFIG_WITH_VALUE and "=" not in a:
                skip = True
        else:
            positional.append(a)
    if any(o in _CONFIG_SCOPES_ELSEWHERE for o in opts):
        return None                                       # not the shared .git/config
    writes = any(o in _CONFIG_WRITE_FLAGS for o in opts) or (positional and positional[0] in _CONFIG_WRITE_SUBCOMMANDS)
    if not writes:
        if any(o in _CONFIG_READ_FLAGS for o in opts) or (positional and positional[0] in _CONFIG_READ_SUBCOMMANDS):
            return None
        if len(positional) <= 1:                          # `git config key` reads the key
            return None
    return ("config in a worktree", "a `git config` write in a worktree changes the shared .git/config for every "
            "tree; use `git config --worktree ...` or `bash scripts/agent_worktree.sh`", AGENT_WORKTREE)


def rule_worktree_lifecycle(seg, wt, **ctx):
    g = git_parts(seg)
    if not g or g[1] != "worktree":
        return None
    sub = next((a for a in g[2] if not a.startswith("-")), None)
    if sub not in ("remove", "prune", "add"):
        return None
    return ("git worktree %s" % sub, "worktrees are made and removed by `bash scripts/agent_worktree.sh` "
            "(git deletes through a worktree's junctions when they are not removed first)", AGENT_WORKTREE)


def rule_lock_direct(seg, wt, **ctx):
    seg = _strip_env(seg)
    for i, tok in enumerate(seg):
        if tok.replace("\\", "/").rsplit("/", 1)[-1] == "loop_lock.sh" and i + 1 < len(seg) \
                and seg[i + 1] in ("take", "release"):
            return ("loop_lock.sh %s" % seg[i + 1], "take the lock through `bash scripts/loop_lock.sh run` (or "
                    "`scripts/run_detached.sh`), which releases it when the job ends", LOOP_LOCK)
    return None


def _names_lock_script(args):
    """True when a `--` pathspec among a commit's args has loop_lock.sh as its last component."""
    if "--" not in args:
        return False
    after = args[args.index("--") + 1:]
    return any(p.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].rsplit(")", 1)[-1].lower() == "loop_lock.sh"
               for p in after)


def rule_lock_script_commit(seg, wt, slow_tests_ran=False, **ctx):
    """Sprint 14 G2 (the 2026-09-26 ruling): landing scripts/loop_lock.sh needs a green slow lock suite since its
    last change. Judged by a `--` pathspec whose last component is loop_lock.sh; a directory pathspec
    (`-- scripts/`) or --pathspec-from-file is not looked into. `slow_tests_ran` is the marker of the repository
    the commit works in (decide_bash asks slow_probe for it)."""
    g = git_parts(seg)
    if not g or g[1] != "commit" or slow_tests_ran or not _names_lock_script(g[2]):
        return None
    return ("the lock script lands only after LOOP_LOCK_SLOW_TESTS=1 python -m unittest tools_py.tests.test_loop_lock "
            "is green (the marker)", "a green complete slow run writes %s, and it must be newer than the script"
            % SLOW_MARKER, LOCK_ROLLOUT)


# `gh pr merge`'s options that take a value (pflag: `-b x`, `-bx`, `--body x`, `--body=x`); its short ones as letters
_GH_MERGE_WITH_VALUE = {"--body", "--body-file", "--subject", "--author-email", "--match-head-commit", "--repo"}
_GH_MERGE_SHORT_WITH_VALUE = set("bFtAR")
_GH_FALSE = ("false", "0", "f", "no")


def _gh_merge_args(seg):
    """The arguments after `gh ... pr merge`, or None when the segment is not a `gh pr merge`."""
    seg = _strip_env(seg)
    if not seg or os.path.basename(seg[0]).lower() not in ("gh", "gh.exe"):
        return None
    try:
        i = seg.index("pr", 1)
    except ValueError:
        return None
    if i + 1 >= len(seg) or seg[i + 1] != "merge":        # `gh pr create -t merge -d` is no merge
        return None
    return seg[i + 2:]


def rule_gh_merge_delete_branch(seg, wt, **ctx):
    """2026-09-26 20:41Z: `gh pr merge 76 --merge --delete-branch`, with the branch checked out in an agent
    worktree, removed that worktree, and git deleted through its tools/ junction: the main tree's toolchain went
    with it. Refused: `--delete-branch` (bar `=false`), a bare `-d`, and `d` in a short cluster (`-md`) before any
    value-taking letter; a value (`--body -d`, `-t -d`) is skipped. `--help` passes (it only prints)."""
    args = _gh_merge_args(seg)
    if args is None:
        return None
    hit, skip = False, False
    for a in args:
        if skip:
            skip = False
            continue
        if a == "--":
            break
        if a in ("--help", "-h"):
            return None
        if a.startswith("--"):
            name, eq, val = a.partition("=")
            if name == "--delete-branch" and not (eq and val.lower() in _GH_FALSE):
                hit = True
            elif name in _GH_MERGE_WITH_VALUE and not eq:
                skip = True
        elif a.startswith("-") and len(a) > 1:
            for k, ch in enumerate(a[1:]):
                if ch in _GH_MERGE_SHORT_WITH_VALUE:
                    skip = k == len(a) - 2                # `-t x`: the next word; `-tx`: the rest of this one
                    break
                if ch == "d":
                    hit = True
    if not hit:
        return None
    return ("gh pr merge --delete-branch", "never gh pr merge --delete-branch: it removes the worktree that holds the "
            "branch and the tools/ junction takes the main tree's toolchain; remove the worktree with "
            "scripts/agent_worktree.sh remove first, then merge, then git push origin --delete", HAZARDS_GIT)


HAZARDS_GIT = "docs/HAZARDS.md git"

RULES = [rule_bulk_add, rule_commit_all, rule_no_verify, rule_commit_names_paths, rule_push_from_worktree,
         rule_force_push_shared, rule_config_in_worktree, rule_worktree_lifecycle, rule_lock_direct,
         rule_lock_script_commit, rule_gh_merge_delete_branch]

# Sprint 17 G1: the PowerShell tool's command is judged by the same rules (`.claude/settings.json` matches
# `Bash|PowerShell`); its location cmdlets move the judged directory as `cd`/`pushd`/`popd` do (any case).
SHELL_TOOLS = ("Bash", "PowerShell")
_LOCATION = {"set-location": "cd", "sl": "cd", "chdir": "cd", "push-location": "pushd", "pop-location": "popd"}


# ---------------------------------------------------------------------------------------------- the policy

def _resolve(path, cwd):
    """A path as a Bash command names it, as Python on this host can use it (`/c/x` -> `C:/x` on Windows)."""
    path = os.path.expanduser(path)
    if sys.platform == "win32":
        m = re.match(r"^/([A-Za-z])(/.*)?$", path)
        if m:
            path = m.group(1).upper() + ":" + (m.group(2) or "/")
    return os.path.normpath(os.path.join(cwd, path))


def decide_bash(command, cwd, is_worktree, worktree_of=None, merge_in_progress=False, session_worktree=None,
                depth=0, slow_tests_ran=False, merge_probe=None, slow_probe=None):
    if session_worktree is None:
        session_worktree = is_worktree
    try:
        parsed = items(command)
    except ValueError:
        return 0, ""                                      # unparseable: allowed
    state = [cwd, is_worktree]                            # the directory the next command runs in
    scopes, dirstack = [], []
    for it in parsed:
        if it[0] == "open":
            scopes.append(list(state))
            continue
        if it[0] == "close":
            if scopes:
                state = scopes.pop()                      # a subshell's cd ends with it
            continue
        seg = it[1]
        core = _strip_env(seg)
        verb = _LOCATION.get(core[0].lower(), core[0]) if core else None
        if verb in ("cd", "pushd", "popd"):
            if not worktree_of and not merge_probe and not slow_probe:
                continue
            if verb == "popd":
                if dirstack:
                    state = dirstack.pop()
                continue
            args = [a for a in core[1:] if not a.startswith("-") or a == "-"]
            target = args[0] if args else "~"
            if target != "-":
                if verb == "pushd":
                    dirstack.append(list(state))
                new = _resolve(target, state[0])
                state = [new, bool(worktree_of(new)) if worktree_of else state[1]]
            continue
        payload = shell_payload(seg)
        if payload is not None and depth < 1:
            code, why = decide_bash(payload, state[0], state[1], worktree_of, merge_in_progress, session_worktree,
                                    depth + 1, slow_tests_ran, merge_probe, slow_probe)
            if code:
                return code, why
            continue
        wt = state[1]
        g = git_parts(seg)
        dash_c = _git_dash_c(g[0]) if g else None
        workdir = _resolve(dash_c, state[0]) if dash_c else state[0]   # the directory this git command works in
        if worktree_of and dash_c:
            wt = bool(worktree_of(workdir))
        merging = merge_in_progress
        if merge_probe and g and g[1] == "commit":        # asked only for a commit: the one rule that reads it
            merging = bool(merge_probe(workdir))
        slow = slow_tests_ran
        if slow_probe and g and g[1] == "commit" and _names_lock_script(g[2]):
            slow = bool(slow_probe(workdir))              # the marker of the repository this commit lands in
        for rule in RULES:
            hit = rule(seg, wt, merge_in_progress=merging, session_worktree=session_worktree,
                       slow_tests_ran=slow)
            if hit:
                name, sentence, home = hit
                return 2, "%s: %s; home: %s" % (name, sentence, home)
    return 0, ""


# ---------------------------------------------------------------------------------------------- Edit/Write (G2)

EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
# Edit/Write/MultiEdit name the file `file_path`, NotebookEdit `notebook_path`; the other two are defensive
_PATH_KEYS = ("file_path", "notebook_path", "path", "filePath")
LOCK_SCRIPT = "scripts/loop_lock.sh"
SLOW_MARKER = "logs/.loop_lock_slow_green"
RUNNING_CHAIN = "docs/HAZARDS.md lock (the running-chain hazard)"
LOCK_ROLLOUT = "scripts/loop_lock.sh header (the rollout procedure)"


def edit_path(tool_input):
    """The path an editing tool's input names, or None."""
    for key in _PATH_KEYS:
        v = tool_input.get(key)
        if isinstance(v, str) and v.strip():
            return v
    return None


def _toplevel(path):
    """`git rev-parse --show-toplevel` of the nearest existing directory at or above path, or None."""
    d = path if os.path.isdir(path) else os.path.dirname(path)
    while d and not os.path.isdir(d):
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    try:
        p = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=d, capture_output=True, text=True,
                           timeout=10)
        return os.path.normpath(p.stdout.strip()) if p.returncode == 0 and p.stdout.strip() else None
    except Exception:
        return None


def edit_target(tool_name, tool_input, cwd):
    """("chain" | "lock", repository root) when an editing tool's path is one of the two guarded kinds, else None.

    The path is judged relative to the root of the repository that holds it (a main-tree session editing a
    worktree's chain script is judged too), and only a repository that has scripts/loop_lock.sh counts: another
    project's logs/*.sh is none of this guard's business. A cheap string test runs first, so an ordinary edit costs
    no git call.
    """
    if tool_name not in EDIT_TOOLS or not isinstance(tool_input, dict):
        return None
    raw = edit_path(tool_input)
    if raw is None:
        return None
    flat = raw.replace("\\", "/").lower()
    if not (flat.endswith("/loop_lock.sh") or flat == "loop_lock.sh"
            or (flat.endswith(".sh") and ("/logs/" in flat or flat.startswith("logs/")))):
        return None
    full = os.path.realpath(_resolve(raw, cwd or "."))   # realpath: an 8.3 short name (UTILIS~1) vs git's long one
    root = _toplevel(full)
    if not root or not os.path.isfile(os.path.join(root, *LOCK_SCRIPT.split("/"))):
        return None
    rel = os.path.relpath(full, os.path.realpath(root)).replace("\\", "/")
    if sys.platform == "win32":
        rel = rel.lower()
    if rel == LOCK_SCRIPT:
        return "lock", root, full
    if rel.startswith("logs/") and rel.endswith(".sh"):
        return "chain", root, full
    return None


def _held(lock_holder):
    """True when parse_holder named a HELD lock's holder (not None, not "queued:<n>")."""
    return lock_holder is not None and not re.match(r"^queued:\d+$", lock_holder)


def decide_edit(tool_name, tool_input, cwd, lock_holder=None, queued_blobs=(), file_exists=None, blob_of=None,
                main_tree_of=None):
    """`lock_holder`: the lock's holder id, "queued:<n>" when FREE with waiters queued, None when exactly FREE;
    `queued_blobs`: the blob12 each QUEUED waiter runs (parse_queued_blobs).

    Narrowed after the G2 review (the lock is shared by every worktree, so "anyone holds or queues it" refused
    every worktree's own chain and lock-script edits):
    - a chain script (logs/**/*.sh) is refused only when the file already exists (a new file cannot be running)
      AND the lock is HELD -- a QUEUED waiter has not started its chain (`run_detached.sh --wait` launches the
      script only after the grant);
    - scripts/loop_lock.sh is refused when a QUEUED waiter's blob equals this file's `git hash-object` (that waiter
      is a live bash reading this exact copy by offset), or when the lock is HELD and this is the MAIN tree's copy
      (the loop's `run` wrappers and chains start from the main tree); a worktree's copy under HELD passes.
    The slow-suite marker gates LANDING the lock script, which is the Bash half's commit rule, not typing into it.
    """
    target = edit_target(tool_name, tool_input, cwd)
    if target is None or (lock_holder is None and not queued_blobs):
        return 0, ""
    kind, root, full = target
    if kind == "chain":
        if _held(lock_holder) and (file_exists or os.path.isfile)(full):
            return 2, ("a chain script is running under the lock (%s): never edit a running chain script -- bash "
                       "reads by offset; home: %s" % (lock_holder, RUNNING_CHAIN))
        return 0, ""
    if queued_blobs:
        blob = ((blob_of or file_blob)(full) or "")[:12].lower()
        if blob and blob in {b[:12].lower() for b in queued_blobs}:
            return 2, ("the lock script is in use: a QUEUED waiter runs this exact copy (blob %s) by offset; edit it "
                       "when that waiter has left the queue (`bash scripts/loop_lock.sh check`); home: %s"
                       % (blob, LOCK_ROLLOUT))
    if _held(lock_holder) and (main_tree_of or is_main_tree_dir)(root):
        return 2, ("the lock script is in use (%s): never edit the main tree's scripts/loop_lock.sh while the lock "
                   "is HELD -- the loop's `run` wrappers and chains run it by offset; edit a worktree's copy, or "
                   "wait for `bash scripts/loop_lock.sh check` to say FREE; home: %s" % (lock_holder, LOCK_ROLLOUT))
    return 0, ""


PINNED_HOME = "docs/DEVELOPING.md Guards (the chain's tree)"


def is_tracked(root, rel):
    """True when `rel` is in root's index (`git ls-files --error-unmatch`); any error is False (the edit passes)."""
    try:
        p = subprocess.run(["git", "ls-files", "--error-unmatch", "--", rel], cwd=root, capture_output=True,
                           timeout=10)
        return p.returncode == 0
    except Exception:
        return False


def pinned_edit(tool_name, tool_input, cwd, pinned_of, tracked_of=None):
    """Sprint 17 G1: (2, sentence) for an editing tool's path that is a TRACKED file of a tree a live merged chain
    pins (`pinned_of(root)` -> the marker, chainmark.running in main()), else (0, ""). The tree is the edited file's
    own (chainmark.tree_root: the nearest `.git` entry above it, by stat), not the session's; logs/ (the chain's own
    output, never tracked) and untracked files pass. merged_chain.sh reds on `git status` before it looks at HEAD, so
    an edit is enough to lose the chain -- the commit is the pre-commit hook's (tools_py/hooks/precommit.py)."""
    if tool_name not in EDIT_TOOLS or not isinstance(tool_input, dict):
        return 0, ""
    raw = edit_path(tool_input)
    if raw is None:
        return 0, ""
    full = os.path.realpath(_resolve(raw, cwd or "."))
    root = chainmark.tree_root(full)
    if not root:
        return 0, ""
    mark = pinned_of(root)
    if not mark:
        return 0, ""
    rel = os.path.relpath(full, root).replace("\\", "/")
    if rel.startswith("../") or rel.lower() == "logs" or rel.lower().startswith("logs/"):
        return 0, ""
    if not (tracked_of or is_tracked)(root, rel):
        return 0, ""
    return 2, ("the chain's tree: a merged chain runs in this tree (stamp %s, pid %s) and goes red on any tracked "
               "file changed under it -- edit in a worktree, or when it ends; home: %s"
               % (mark.get("stamp") or "?", mark.get("pid"), PINNED_HOME))


def parse_holder(check_output):
    """What `loop_lock.sh check` says is using the lock: the holder id ("HELD: <owner> taken N min ago, ..."),
    "queued:<n>" when it is FREE but n waiters are QUEUED, None when exactly FREE."""
    lines = (check_output or "").splitlines()
    for line in lines:
        m = re.match(r"^HELD: (.+?) taken ", line)
        if m:
            return m.group(1)
    queued = sum(1 for line in lines if line.startswith("QUEUED:"))
    if not queued:
        m = re.match(r"^FREE, but (\d+) waiter", lines[0] if lines else "")
        queued = int(m.group(1)) if m else 0
    return "queued:%d" % queued if queued else None


def parse_queued_blobs(check_output):
    """The blob12 of every QUEUED line of `loop_lock.sh check`. A line reads
    "QUEUED:[ STALE ...] <owner> queued N s ago, heartbeat M s old (blob=<12 hex> <purpose>) [<ticket>]"
    (the ticket file's "<owner> blob=... <purpose>" minus the owner); a line without a blob adds nothing."""
    out = []
    for line in (check_output or "").splitlines():
        if line.startswith("QUEUED:"):
            m = re.search(r"\(blob=([0-9a-fA-F]{12})", line)
            if m:
                out.append(m.group(1).lower())
    return out


def lock_check_in(root):
    """The stdout of root's `bash scripts/loop_lock.sh check`, or "" on any error (read as exactly FREE)."""
    try:
        from tools_py.bashpath import find_bash           # Git Bash, never WSL's launcher (the house finder)
        bash = find_bash()
        if not bash:
            return ""
        p = subprocess.run([bash, LOCK_SCRIPT, "check"], cwd=root, capture_output=True, text=True, timeout=20)
        return p.stdout if p.returncode == 0 else ""
    except Exception:
        return ""


def file_blob(path):
    """`git hash-object <path>` (what loop_lock.sh's script_blob records), or None on any error."""
    try:
        p = subprocess.run(["git", "hash-object", os.path.basename(path)], cwd=os.path.dirname(path),
                           capture_output=True, text=True, timeout=10)
        return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None
    except Exception:
        return None


def is_main_tree_dir(root):
    """True when root is a main working tree: git's --git-dir equals its --git-common-dir. Any error is False."""
    try:
        p = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd=root,
                           capture_output=True, text=True, timeout=10)
        lines = p.stdout.split("\n")
        if p.returncode != 0 or len(lines) < 2 or not lines[0].strip():
            return False
        norm = [os.path.normcase(os.path.normpath(x.strip())) for x in lines[:2]]
        return norm[0] == norm[1]
    except Exception:
        return False


def slow_tests_green(root):
    """True when root's logs/.loop_lock_slow_green exists and is newer than its scripts/loop_lock.sh."""
    try:
        marker = os.path.join(root, *SLOW_MARKER.split("/"))
        script = os.path.join(root, *LOCK_SCRIPT.split("/"))
        return os.path.isfile(marker) and os.path.getmtime(marker) > os.path.getmtime(script)
    except OSError:
        return False


def decide(tool_name, tool_input, cwd, is_worktree, worktree_of=None, merge_in_progress=False, lock_holder=None,
           slow_tests_ran=False, merge_probe=None, slow_probe=None, queued_blobs=(), file_exists=None, blob_of=None,
           main_tree_of=None, pinned_of=None, tracked_of=None):
    """(0, "") to allow the call, (2, "<rule>: <sentence>; home: <file or script>") to refuse it.

    `is_worktree` is the session's cwd (the hook JSON's): a worktree session never pushes, wherever it `cd`s.
    `worktree_of(path) -> bool`, when given, re-answers is_worktree for `cd`/`pushd <dir>` and `git -C <dir>`.
    `merge_in_progress` (MERGE_HEAD exists in cwd) lets a commit without a pathspec through: git refuses a partial
    commit during a merge. `merge_probe(path) -> bool`, when given, replaces it: it is asked, for each `git commit`,
    about the directory that commit works in (after `cd`/`pushd`/`popd`, a subshell's scope, and `git -C`).
    For the editing tools (EDIT_TOOLS): `lock_holder` is what uses the loop lock (parse_holder; None when exactly
    FREE), `queued_blobs` the QUEUED waiters' blob12s (parse_queued_blobs); `file_exists(path)`, `blob_of(path)` and
    `main_tree_of(root)` default to os.path.isfile, file_blob and is_main_tree_dir (see decide_edit).
    For Bash: `slow_tests_ran` says the slow lock suite went green after scripts/loop_lock.sh was last changed (a
    commit naming the lock script needs it); `slow_probe(path) -> bool`, when given, replaces it for each such
    commit, asked about the directory that commit works in (as merge_probe is). The PowerShell tool (SHELL_TOOLS) is
    judged as Bash is. `pinned_of(root)` (Sprint 17 G1), when given, returns the live merged-chain marker of a tree
    or None, and `tracked_of(root, rel)` says whether a file is tracked (default is_tracked): an editing tool's
    tracked file in a pinned tree is refused (pinned_edit). Without pinned_of nothing is pinned, so the tests stay
    hermetic when a chain runs this suite in its own tree; main() passes chainmark.running.
    """
    try:
        if not isinstance(tool_input, dict):
            return 0, ""
        if tool_name in SHELL_TOOLS:
            command = tool_input.get("command")
            if not isinstance(command, str):
                return 0, ""
            return decide_bash(command, cwd or ".", is_worktree, worktree_of, merge_in_progress,
                               slow_tests_ran=slow_tests_ran, merge_probe=merge_probe, slow_probe=slow_probe)
        if tool_name in EDIT_TOOLS:
            if pinned_of is not None:
                code, why = pinned_edit(tool_name, tool_input, cwd, pinned_of, tracked_of)
                if code:
                    return code, why
            return decide_edit(tool_name, tool_input, cwd, lock_holder, queued_blobs, file_exists, blob_of,
                               main_tree_of)
        return 0, ""
    except Exception:                                     # never break a tool call
        return 0, ""


def is_worktree_dir(cwd):
    """True when cwd is inside a linked worktree: git's --git-dir differs from its --git-common-dir."""
    try:
        p = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], cwd=cwd,
                           capture_output=True, text=True, timeout=10)
        lines = p.stdout.split("\n")
        if p.returncode != 0 or len(lines) < 2:
            return False
        norm = [os.path.normcase(os.path.normpath(x.strip())) for x in lines[:2]]
        return norm[0] != norm[1]
    except Exception:
        return False


def merge_in_progress_in(cwd):
    """True when cwd's repository has a MERGE_HEAD (`git rev-parse -q --verify MERGE_HEAD`); any error is False."""
    try:
        p = subprocess.run(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], cwd=cwd, capture_output=True,
                           text=True, timeout=10)
        return p.returncode == 0 and bool(p.stdout.strip())
    except Exception:
        return False


def cached_merge_probe():
    """merge_in_progress_in with a per-directory cache: one git call per directory a command commits in."""
    seen = {}

    def probe(path):
        key = os.path.normcase(os.path.normpath(path))
        if key not in seen:
            seen[key] = merge_in_progress_in(path)
        return seen[key]
    return probe


def cached_slow_probe():
    """slow_tests_green of the repository holding a directory, cached per directory; False outside a repository."""
    seen = {}

    def probe(path):
        key = os.path.normcase(os.path.normpath(path))
        if key not in seen:
            root = _toplevel(os.path.realpath(path))
            seen[key] = bool(root) and slow_tests_green(root)
        return seen[key]
    return probe


def main():
    try:
        doc = json.loads(sys.stdin.read())
        cwd = doc.get("cwd") or os.getcwd()
        tool_name = doc.get("tool_name", "")
        tool_input = doc.get("tool_input") or {}
        if tool_name in EDIT_TOOLS:
            # the chain's tree first: a stat for the marker, and git only when a live chain pins the file's tree
            code, why = pinned_edit(tool_name, tool_input, cwd, chainmark.running)
            if not code:
                target = edit_target(tool_name, tool_input, cwd)
                if target is None:
                    return 0                              # an ordinary edit: no lock check, no git beyond the root
                check = lock_check_in(target[1])
                code, why = decide(tool_name, tool_input, cwd, False, lock_holder=parse_holder(check),
                                   queued_blobs=parse_queued_blobs(check))
        elif tool_name in SHELL_TOOLS:
            code, why = decide(tool_name, tool_input, cwd, is_worktree_dir(cwd), worktree_of=is_worktree_dir,
                               merge_probe=cached_merge_probe(), slow_probe=cached_slow_probe())
        else:
            return 0
        if code == 2:
            sys.stderr.write("refused by the PreToolUse guard (tools_py/hooks/pretool.py) -- %s\n" % why)
            return 2
        return 0
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main())
