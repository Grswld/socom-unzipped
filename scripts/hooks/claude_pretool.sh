#!/bin/sh
# The Claude Code PreToolUse guard (Sprint 14 G1): Claude Code writes the tool call as JSON on stdin; exit 2 with a
# sentence on stderr refuses it, exit 0 lets it through. Wired in .claude/settings.json; the policy is
# tools_py/hooks/pretool.py and its rules are listed in docs/DEVELOPING.md, "Guards".
#
# Claude Code treats any exit other than 0 and 2 as a non-blocking error, and this script must never block a call
# by accident: no Python, or a repository it cannot find, exits 0 (the call proceeds unguarded) -- never 1, never
# socom_require_python's 2.
#
# The fast path: every Bash rule is about git, `gh pr merge` or the loop lock, and every Edit/Write rule (G2) about
# a script under logs/ or loop_lock.sh, so a call whose JSON names none of `git`, `gh pr`, `loop_lock`, `logs/` or
# `logs\` (case-insensitive) exits 0 here, before Python starts -- the hook runs on EVERY Bash, Edit and Write call.
# The backslash is quoted ('\'): Git Bash's case matched neither `[/\\]` nor an unquoted `\\` against it.
#
# It runs from its OWN repository (the script's directory, two up), not the caller's cwd: the cwd a tool call runs
# in can be any tree, or no tree at all. The cwd that matters for the rules comes in the JSON.
#
# The chain's tree (Sprint 17 G1): while a merged chain runs, an edit of a tracked file in its tree is refused, and
# such an edit names none of the words above. So an editing call (the JSON has a `file_path` or `notebook_path`)
# also reaches Python when logs/.merged_chain.running exists in this script's own tree or in the main tree (a linked
# worktree's `.git` file names it: `gitdir: <main>/.git/worktrees/<name>`) -- a stat or two and a builtin read, no
# process. PRETOOL_CHAIN_TREE, when set, replaces those two trees with the one it names (empty: none) for the tests.
input=$(cat)
here=.
case "$0" in */*) here="${0%/*}/../.." ;; esac
chain=""
if [ "${PRETOOL_CHAIN_TREE+set}" = set ]; then
  [ -n "$PRETOOL_CHAIN_TREE" ] && [ -f "$PRETOOL_CHAIN_TREE/logs/.merged_chain.running" ] && chain=1
elif [ -f "$here/logs/.merged_chain.running" ]; then
  chain=1
elif [ -f "$here/.git" ]; then
  gitdir=""
  { IFS= read -r gitdir < "$here/.git"; } 2>/dev/null
  gitdir="${gitdir#gitdir: }"
  case "$gitdir" in
    */.git/worktrees/*) [ -f "${gitdir%/.git/worktrees/*}/logs/.merged_chain.running" ] && chain=1 ;;
  esac
fi
case "$input" in
  *[Gg][Hh]' '[Pp][Rr]' '*|*[Gg][Hh].[Ee][Xx][Ee]' '[Pp][Rr]' '*) ;;   # `gh pr merge` names no git
  *[Gg][Ii][Tt]*|*[Ll][Oo][Oo][Pp]_[Ll][Oo][Cc][Kk]*|*[Ll][Oo][Gg][Ss]/*|*[Ll][Oo][Gg][Ss]'\'*) ;;
  *'"file_path"'*|*'"notebook_path"'*) [ -n "$chain" ] || exit 0 ;;
  *) exit 0 ;;
esac
cd "$(dirname "$0")/../.." 2>/dev/null || exit 0
. scripts/python_env.sh 2>/dev/null || exit 0
[ -n "${PYTHON:-}" ] || exit 0
printf '%s' "$input" | "$PYTHON" -m tools_py.hooks.pretool
code=$?
[ "$code" -eq 2 ] && exit 2
exit 0
