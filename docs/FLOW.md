# Flow: how work moves through this repository

> **Generated -- do not edit.** Written by `python -m tools_py.flow --since 2026-09-01` (Sprint 14 M1, the review's F8; tokens M2) from the git history at the commit named below, the lock's queue log, `docs/BACKLOG.md` and, when SOCOM_CLAUDE_TRANSCRIPTS names a directory, the sums of its transcripts' usage fields. The methods are note 03's (`docs/audits/2026-09-26-autonomy-structure-review/03-git-forensics.md`); each number names the command that reproduces it, and where the method differs from the note's the module docstring says how. Descriptive, not targets. `python -m tools_py.flow --check` exits 1 when this file is not a render of the commit it names; regenerate at the close.

Rendered at commit `7ae9a6394adf80d7256a4466e51dd72d5408dff3` (committer time 2026-09-28T01:24:16Z), since 2026-09-01 (UTC days): 2193 commits, 224 merges.

## The numbers

- **merges per day**: 224 merges on 11 days (mean 20.4 a merge day); `git log --merges` counts 224. Per day below -- command: `python -m tools_py.changelog --rev 7ae9a639` (its merges, changelog.entries()), by UTC committer day; cross-check: `TZ=UTC git log --merges --since=2026-09-01T00:00:00Z --date=format-local:%F --format=%cd 7ae9a639 | sort | uniq -c`
- **fix rounds per merge**: rounds: merges -- 0: 173 (77.2 %); 1: 38 (17.0 %); 2: 9 (4.0 %); 3: 3 (1.3 %); 7: 1 (0.4 %); none: 77.2 %, at most one: 94.2 %. A round counts once, at the first merge whose range brings it in; merge commits and docs(sprint-N) plan commits are not rounds; rounds committed straight on a sprint branch count at the sprint's merge into main (Sprint 11's seven at PR #49) -- command: `git log --no-merges --format=%s P1..P2 | grep -v -E '^docs\(sprint-[0-9]+\)' | grep -c -E 'review round|fix round'` per merge with parents P1 P2, oldest first, less the commits an earlier merge counted (note 03 section 2.2, deduplicated)
- **fix rounds per merge, broad pattern**: matches: merges -- 0: 106 (47.3 %); 1: 63 (28.1 %); 2: 33 (14.7 %); 3: 6 (2.7 %); 4: 5 (2.2 %); 5: 3 (1.3 %); 7: 3 (1.3 %); 8: 1 (0.4 %); 10: 1 (0.4 %); 19: 1 (0.4 %); 28: 1 (0.4 %); 32: 1 (0.4 %); none: 47.3 %, at most one: 75.4 % (an upper bound: every fix(scope) commit counts). The same rule -- command: `git log --no-merges --format=%s P1..P2 | grep -v -E '^docs\(sprint-[0-9]+\)' | grep -c -E 'review round|fix round|fix\(|review'` per merge, oldest first, less the commits an earlier merge counted
- **subjects saying " again"**: 49 of 2193 commits -- command: `git log --since=2026-09-01T00:00:00Z --format=%s 7ae9a639 | grep -ci -- ' again'`
- **docs share of churn, seven days**: 31.2 %: 124005 of 397545 lines added + deleted, 2026-09-21T01:24:16Z to 2026-09-28T01:24:16Z -- command: `git log --numstat --no-renames --since=2026-09-21T01:24:16Z --until=2026-09-28T01:24:16Z --format= 7ae9a639 | awk '$1 ~ /^[0-9]+$/ {t += $1 + $2} $3 ~ /^docs\// {d += $1 + $2} END {print d, t}'`
- **ticket wait**: median 1452 s over 39 tickets -- command: `grep -E 'TICKET [^ ]+ waited [0-9]+' logs/loop_lock.queue.log` (the main tree's), the median of the last field, unstamped lines and lines stamped after 2026-09-28T01:24:16Z or before 2026-09-01 left out
- **open-issue age**: not measured: the open-issues table of docs/BACKLOG.md at `7ae9a639` has no Opened column; the dates live on GitHub (`gh issue list --state open --json number,createdAt`), a network read this page does not make -- command: `git show 7ae9a639:docs/BACKLOG.md`, the Opened column of section 1's table, days to 2026-09-28
- **sessions**: 39 distinct Claude-Session trailers -- command: `git log --since=2026-09-01T00:00:00Z --format=%B 7ae9a639 | grep '^Claude-Session:' | sort -u | wc -l`
- **commits per session**: largest first: 333, 255, 220, 85, 61, 32, 30, 21, 16, 12, 10, 9, 8, 7, 7, 7, 7, 5, 5, 4, 3, 3, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1; median 4 -- command: `git log --since=2026-09-01T00:00:00Z --format=%B 7ae9a639 | grep '^Claude-Session:' | sort | uniq -c | sort -rn`
- **token spend**: not measured: SOCOM_CLAUDE_TRANSCRIPTS is not set. The transcripts are local to the machine that ran the sessions, so the page sums them only when the controller names their directory -- command: `SOCOM_CLAUDE_TRANSCRIPTS=<the transcripts directory> python -m tools_py.flow --usage` (Claude Code's are under ~/.claude/projects/<project-key>/), the `message.usage` fields of each `.jsonl` summed

## Merges per UTC day

| day | merges |
|---|---:|
| 2026-09-08 | 1 |
| 2026-09-18 | 2 |
| 2026-09-20 | 1 |
| 2026-09-21 | 25 |
| 2026-09-22 | 7 |
| 2026-09-23 | 18 |
| 2026-09-24 | 7 |
| 2026-09-25 | 47 |
| 2026-09-26 | 65 |
| 2026-09-27 | 48 |
| 2026-09-28 | 3 |
