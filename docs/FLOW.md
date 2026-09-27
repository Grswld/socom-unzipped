# Flow: how work moves through this repository

> **Generated -- do not edit.** Written by `python -m tools_py.flow --since 2026-09-01` (Sprint 14 M1, the review's F8; tokens M2) from the git history at the commit named below, the lock's queue log, `docs/BACKLOG.md` and, when SOCOM_CLAUDE_TRANSCRIPTS names a directory, the sums of its transcripts' usage fields. The methods are note 03's (`docs/audits/2026-09-26-autonomy-structure-review/03-git-forensics.md`); each number names the command that reproduces it, and where the method differs from the note's the module docstring says how. Descriptive, not targets. `python -m tools_py.flow --check` exits 1 when this file is not a render of the commit it names; regenerate at the close.

Rendered at commit `8ae047c5e6e11216266c0e62765256cf7e43ca99` (committer time 2026-09-27T06:27:23Z), since 2026-09-01 (UTC days): 1935 commits, 178 merges.

## The numbers

- **merges per day**: 178 merges on 10 days (mean 17.8 a merge day); `git log --merges` counts 178. Per day below -- command: `python -m tools_py.changelog --rev 8ae047c5` (its merges, changelog.entries()), by UTC committer day; cross-check: `TZ=UTC git log --merges --since=2026-09-01T00:00:00Z --date=format-local:%F --format=%cd 8ae047c5 | sort | uniq -c`
- **fix rounds per merge**: rounds: merges -- 0: 131 (73.6 %); 1: 35 (19.7 %); 2: 8 (4.5 %); 3: 3 (1.7 %); 7: 1 (0.6 %); none: 73.6 %, at most one: 93.3 %. A round counts once, at the first merge whose range brings it in; merge commits and docs(sprint-N) plan commits are not rounds; rounds committed straight on a sprint branch count at the sprint's merge into main (Sprint 11's seven at PR #49) -- command: `git log --no-merges --format=%s P1..P2 | grep -v -E '^docs\(sprint-[0-9]+\)' | grep -c -E 'review round|fix round'` per merge with parents P1 P2, oldest first, less the commits an earlier merge counted (note 03 section 2.2, deduplicated)
- **fix rounds per merge, broad pattern**: matches: merges -- 0: 77 (43.3 %); 1: 56 (31.5 %); 2: 27 (15.2 %); 3: 4 (2.2 %); 4: 5 (2.8 %); 5: 2 (1.1 %); 7: 2 (1.1 %); 8: 1 (0.6 %); 10: 1 (0.6 %); 19: 1 (0.6 %); 28: 1 (0.6 %); 32: 1 (0.6 %); none: 43.3 %, at most one: 74.7 % (an upper bound: every fix(scope) commit counts). The same rule -- command: `git log --no-merges --format=%s P1..P2 | grep -v -E '^docs\(sprint-[0-9]+\)' | grep -c -E 'review round|fix round|fix\(|review'` per merge, oldest first, less the commits an earlier merge counted
- **subjects saying " again"**: 45 of 1935 commits -- command: `git log --since=2026-09-01T00:00:00Z --format=%s 8ae047c5 | grep -ci -- ' again'`
- **docs share of churn, seven days**: 29.7 %: 118172 of 398330 lines added + deleted, 2026-09-20T06:27:23Z to 2026-09-27T06:27:23Z -- command: `git log --numstat --no-renames --since=2026-09-20T06:27:23Z --until=2026-09-27T06:27:23Z --format= 8ae047c5 | awk '$1 ~ /^[0-9]+$/ {t += $1 + $2} $3 ~ /^docs\// {d += $1 + $2} END {print d, t}'`
- **ticket wait**: median 1571.5 s over 26 tickets -- command: `grep -E 'TICKET [^ ]+ waited [0-9]+' logs/loop_lock.queue.log` (the main tree's), the median of the last field, unstamped lines and lines stamped after 2026-09-27T06:27:23Z or before 2026-09-01 left out
- **open-issue age**: not measured: the open-issues table of docs/BACKLOG.md at `8ae047c5` has no Opened column; the dates live on GitHub (`gh issue list --state open --json number,createdAt`), a network read this page does not make -- command: `git show 8ae047c5:docs/BACKLOG.md`, the Opened column of section 1's table, days to 2026-09-27
- **sessions**: 19 distinct Claude-Session trailers -- command: `git log --since=2026-09-01T00:00:00Z --format=%B 8ae047c5 | grep '^Claude-Session:' | sort -u | wc -l`
- **commits per session**: largest first: 333, 252, 220, 85, 61, 32, 30, 21, 16, 12, 10, 9, 8, 7, 3, 3, 2, 1, 1; median 12 -- command: `git log --since=2026-09-01T00:00:00Z --format=%B 8ae047c5 | grep '^Claude-Session:' | sort | uniq -c | sort -rn`
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
| 2026-09-27 | 5 |
