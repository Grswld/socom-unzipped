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
input=$(cat)
case "$input" in
  *[Gg][Hh]' '[Pp][Rr]' '*|*[Gg][Hh].[Ee][Xx][Ee]' '[Pp][Rr]' '*) ;;   # `gh pr merge` names no git
  *[Gg][Ii][Tt]*|*[Ll][Oo][Oo][Pp]_[Ll][Oo][Cc][Kk]*|*[Ll][Oo][Gg][Ss]/*|*[Ll][Oo][Gg][Ss]'\'*) ;;
  *) exit 0 ;;
esac
cd "$(dirname "$0")/../.." 2>/dev/null || exit 0
. scripts/python_env.sh 2>/dev/null || exit 0
[ -n "${PYTHON:-}" ] || exit 0
printf '%s' "$input" | "$PYTHON" -m tools_py.hooks.pretool
code=$?
[ "$code" -eq 2 ] && exit 2
exit 0
