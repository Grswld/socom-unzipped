# HANDOFF.md -- the loop's pick-up history and the pre-playtest sections (archived 2026-09-25)

> **ARCHIVED 2026-09-25 (Sprint 13 Task R1, R268) -- superseded by the live `docs/HANDOFF.md`.** Moved out of the
> live file verbatim: from §2 "Where it stands", the two "Picking up after ..." blockquotes, three stale state bullets and the nine
> "Where the loop is now / was" bullets older than the one it keeps; all of §4 "The work, in order" (Sprint 9's
> milestones P and Q and the Sprint 10-12 shape); all of §10 "What the owner should decide before the playtest"
> (the playtest was 2026-09-22); all of §9 "What the owner said on 2026-09-20" (added the same day,
> after review). **Nothing below is an instruction:** three bullets here say "is now", and none of
> them is. Kept whole and in the order the live file had them, edited only where a citation pointed at a block or a
> path that has since moved. The current pick-up point is `docs/HANDOFF.md` §2; the dated account of each day is
> `docs/STATUS.md`'s log.

## §2, "Where it stands": the pick-up points (the blockquotes first, then the bullets, as they stood)

> **Picking up after Sprint 11's close (2026-09-25)?** `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`'s "Sprint 11" block, its **2026-09-25** paragraph and the worktree table; then the r0004 row in KNOWN §2 — the reboot is solved to its root, the gate is **3/3** (`s11_r0004_probe2`) and the build plays a scored online round on our own server (`s11_r0004_round2c`); the ledger `.superpowers/sdd/2026-09-23-sprint-11/progress.md` names what was running at the hand-back (a probe agent and the repair's fix round, both lock-bound). The lock's priority order is the r0004 critical path first (R255).
>
> **Picking up after the Sprint 11 night (2026-09-23, 14:00Z)?** Start at `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`'s "Sprint 11 —
> OPEN" block: what landed (Tasks 11, 2b, 8a, 8c and 19 followed on 2026-09-23 afternoon), and the table of agent worktrees holding unfinished, part-reviewed work — each row
> says the branch, the last commit, the review verdict and the next step. Then the plan
> (`docs/superpowers/plans/2026-09-23-sprint-11.md`) and, on disk, the ledger
> `.superpowers/sdd/2026-09-23-sprint-11/progress.md` with every report and review beside it. The night ended on the
> session limit, not on a decision: nothing in those worktrees is wrong, it is unfinished. Two harness facts first
> (KNOWN §4): `loop_lock.sh --wait N` is a retry count, and a fresh worktree needs `./build.sh runtime --no-runner`
> before `test`.

- **Sprint 10 is MERGED to `main` (`f15acfa`, `v0.10.0`, 2026-09-23); Sprint 11 is open on branch `sprint-11` and
  closing 2026-09-25.** Sprint 9, "A stranger's first run", is MERGED to `main` (`4415254`, `v0.9.0`, 2026-09-20). Sprint 9 done: Goal 1 (failures explain themselves),
  Goal 2 (release build, import-closure archives, `SHA256SUMS`; Windows zip 55.7 MB), **P1 and P2** (Goal 10's music:
  the queue, the ramp ownership and the stream loop flags, R169-R171, `eca5450`), **P3** (Goal 9's pad gate, R173,
  `3b12fa4`), and **the first half of P4** (`1966fa6`: the page-change flash and the top bar's two alignments).
  Landed but not closed out: Goal 8 (REPORT A BUG and the ONLINE status line) -- see P5, and read its row first,
  because three of its four documentation artefacts turn out to be already written.
- **Where the loop was (2026-09-25 morning; moved here at the Sprint 13 open, 08:40Z) -- Sprint 12 is CLOSED and merges to `main` as `v0.12.0` behind Sprint 11's `v0.11.0`; no sprint is open.** Read `docs/CURRENT_SPRINT.md`'s "Sprint 12 — CLOSED" block (the outcome, the carry, R264 on the `S12-R` names), then its "Sprint 11 — CLOSED" block. The generated image is readable now: `recomp/socom2_names.csv` is the sidecar the recompiler reads (`[general] names`), `tools_py/apply_names.py` its only writer, and `docs/DEVELOPING.md` "Names in the generated code" the contributor's page; the proof is `s12_names_gate` 3/3 with PINS MATCH on the renamed tree (2026-09-25 04:51–05:38Z, the plan's Task 3 Step 4 RESULT). The next sprint is the owner's to name; its inputs are the carry lists of both close blocks and `docs/archive/HUMAN_TASKS-to-2026-09-25.md`'s two "what needs you" sections. Two controllers shared this machine for a day (the cloud handoff `docs/superpowers/plans/2026-09-24-sprint-12-cloud-handoff.md` §5 is the procedure; it held, with one lesson: the lock has no queue, issue #36, so a second controller's poller can take a hand-off gap in the first one's chain).
- **Where the loop was (2026-09-25 early) -- Sprint 11 is CLOSED and on `main` as `v0.11.0`; Sprint 12 runs in the cloud on `sprint-12`.** Read `docs/CURRENT_SPRINT.md`'s "Sprint 11 — CLOSED" block (the outcome table, the carry, the rulings ledger R245–R263) and then the Sprint 12 handoff `docs/superpowers/plans/2026-09-24-sprint-12-cloud-handoff.md`: the cloud session owns Sprint 12 on `sprint-12`; the local half (its PROOF REQUESTED rows, the merges, the mirroring into this file and STATUS) is session socom-pc-6c's; a new local controller starts by asking the owner which of the two it is. This machine's checkout stays on `sprint-11`; nothing lands there any more except a hotfix. The close's own record: `docs/STATUS.md`'s 2026-09-25 entry and `docs/archive/HUMAN_TASKS-to-2026-09-25.md` "Sprint 11 close — what needs you".
- **Where the loop was (2026-09-24 16:30Z) -- `sprint-11` at `07dc937`+, pushed through `2381c8a`; `main` at `a548dd1`.** The second night: Tasks 17, 13, 8b, 6 Step 2, audio-out and the cross-row recompiler fix merged and gate-proven; the r0004 build's reboot traced to two capsule words in our dumped image and repaired (KNOWN §2's r0004 row is the whole chain), and, by 16:30Z, **the r0004 gate 3/3** (`s11_r0004_probe2`) once the gate's harness learned the revision (`tools_py/parity/guest_addresses.py`, one pin standard per revision); one KNOWN row retired from the public docs on both branches at the owner's word. Next: Task 6 Step 3 (the picks gated in research/42 §4's order), then the plan's remaining tasks. Traps this night taught, all in KNOWN §4: `--accept-pins` rewrites the shared standard at gate start-up (even a cancelled gate); a dumped image carries the resident patcher's writes; an agent's bare `git config` killed the main tree's push once more (per-worktree config, `scripts/agent_worktree.sh`).
- **Where the loop is now (2026-09-23 05:10Z) -- Sprint 10 is on `main` (`f15acfa`, PR #24, tag `v0.10.0`);
  `sprint-11` is open off it with seven agent branches merged forward (`4732892`) and its opening chain running
  (the runner rebuilt with the chat wrap and the address table, the suite, gate `s11_open_gate`, the two-instance
  chat proof). Read `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` "Sprint 11 -- OPEN" for what landed overnight and what is next; the plan
  is `docs/superpowers/plans/2026-09-23-sprint-11.md`. Two traps this night taught, both fixed: a worktree's
  `loop_lock.sh` resolved to a private lock (`9b39523`), and `git config` in a worktree writes the SHARED config, so
  the dead push URL disabled the main tree's push too (`4b5eb3f`; per-worktree config now).
- **Where the loop was (2026-09-23 morning) -- Sprint 10 is CLOSED; what is left of it is the merge to
  `main` and the annotated tag `v0.10.0`, and Sprint 11 is open on
  `docs/superpowers/plans/2026-09-23-sprint-11.md`** (eighteen tasks across milestones S, U, R and P; eight owner
  decisions, each with the default the loop proceeds on, in `docs/archive/HUMAN_TASKS-to-2026-09-25.md`'s top block). Overnight, under the
  owner's twelve-hour mandate: the endpoint A/B gave its verdict -- the mission music's DEVICE dips **survive a wired
  endpoint** (wired 14 against Bluetooth 11), so they are ours and three `docs/KNOWN.md` rows that blamed the owner's
  speaker are retracted in place; W10 split the card question -- the persona survives a virgin-card restart, the
  saved password does not, so **R237 is rewritten and the prefilled login stays**; W6 did not reproduce but cannot be
  closed (the walk never reaches the church and the capture wrote no environment); W8 is proven by the ladder
  (R244); and the sprint's sixty-four rulings R181-R244 are reconciled into one table in `docs/CURRENT_SPRINT.md`.
  The full account is `docs/STATUS.md`'s 2026-09-23 entry.
- **Where the loop was (2026-09-21 evening) -- Sprint 10's autonomous stack is DONE and on `main` in four
  slices; `docs/STATUS.md`'s top entry is the list.** Eleven chunks went to Opus agents in their own worktrees and
  were paid for in this tree, each with its gate: Q1b (the gate pins its inputs), Q6 (the stall bound), the threaded
  flake, Q3b+Goal 8 (mapping and the remapping UI), Goal 9 (the credentials, end to end), Goal 2 (the box as a
  service), Q2/Goal 3 (knob retirement and the flip), Q3 (the mouse out, the keyboard narrowed), Q4 (the window
  switch, the window's chrome, menu sounds), Q5 (closed under its stop rule), Q7 (four residuals). The suite counts are `docs/DEVELOPING.md`'s, as the baselines bullet above
  says; the ladder streak is `docs/LADDER.md`'s, generated. **What is left is the owner's hands** (`docs/HUMAN_TASKS.md`: a pad
  session, the prefilled login, Q4's four tries, the disc-derived-bytes decisions, the ladder window) **or a quiet
  machine** (Goal 4's kill routes, Goal 3's tasks 5 and 7, ladder 5-7, Q2's VM ring, Q7's gate-scored residuals).
  **Two traps this day taught, both in KNOWN:** a `replaceFunction` wrap's post-call code runs at the scheduler's
  unwind, not at the return; and a header defining state in an anonymous namespace gives every translation unit its
  own copy -- the stub helpers depended on that, the suite could not see it, the gate could.
- **Where the loop was (2026-09-20 evening) -- the repository is PUBLIC and Sprint 10 is reorganized around
  hardening it.** The owner flipped `github.com/Scotho/socom-unzipped` public after the sweep and the history rewrite,
  bypassed the owner gate on the audio listen, and set the priority: harden the development and build process a
  stranger can now fork; no easy player setup until then; nothing sensitive can ever be published. Read
  `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` "Sprint 10, REORGANIZED" -- milestone H, H1 and H2 done that evening: the leak check
  (`tools_py/release/leakcheck.py`, six modes, three exit states, `leak_allow.txt` the ledger), the git hooks
  (`bash scripts/install_hooks.sh` once per clone -- **do it in your first hour**), CI `secrets.yml` with gitleaks,
  GitHub's secret scanning and push protection and the rulesets (R181-R183). **H3-H8 followed the same night:** the
  Windows toolchain bootstrap and `build.sh --no-runner` with a `windows` workflow (green on `a175ec7`: bootstrap from nothing, the build in 4 min, Python 1571 OK, ps2x_tests 701/0, the VU1 verify OK; `build-windows` joined `main`'s required checks), the
  suite's debris to the temp directory, `THIRD_PARTY_NOTICES.md` + `LICENSES/` with a test, the release folder and
  the bug report's scrubber through the gate (gate `s10_h6_scrub_gate` 3/3), the disc-derived-bytes audit
  (`docs/audits/2026-09-21-disc-derived-bytes.md`, decisions the owner's), the release-draft workflow. Next: the
  Goals resume in the reorganized order; the music thread below is filler now, not the live thread. Two traps
  learned: a GitHub Windows runner resolves `bash` to WSL's from Python (use `tools_py/tests/shell.BASH`), and a
  docs-only push used to cancel the running build (fixed).
- **Where the loop was (2026-09-21 03:00 UTC) -- the music, round four.** Read `docs/archive/sprints-7-12/2026-09-20-sprint-10-music-round-four.md` task 4 top to bottom before touching audio: the real 989snd decompilation (`research/989snd-ziemas/`, audit research/36) corrected the model; the music-only capture pair (`scripts/parity/music_only_mission.txt`, `logs/s10_music_round4_ours_only.sh`, `logs/s10_music_round4_repin.sh`) is the instrument, with stereo alignment and the dip classifier (`tools_py/parity/audio_dips.py`) and the EE cue-sequencer poll (`music_state_poll`); the stereo interleave fix (`c6502ea`) is the day's find and the owner's fifth listen (HUMAN_TASKS) its bar. Open: the mission's 10-27 s music pauses (the stems are fired by the play-sound API's callers :242150/:242232 -- `PS2X_CALL_TRACE` next), the PCM ring's 300-400 ms feed stalls (the PSS demux thread parked in `sceMpegGetPicture`), and why the console's sequencer holds a 9 s voice cue for 120 s. Two traps learned today are in memory: never edit a running chain script; kill a chain's survivors by listed PID, never by pattern.
- **Where the loop is now (2026-09-20 19:40 UTC):** Sprint 10 is under way on `sprint-10`. Goal 1: the ladder job exists, its verifier gap is fixed, streak 1 of 7 (`docs/LADDER.md`); the Task Scheduler entry stays DISABLED until the owner names a window. Goal 3: BAR MET -- both legs of the mixed match run on the hosted server on the verified flow, twice in a row each (the Goal 3 plan has every run and what it found; its task 7 is the one refinement left). Next in the spec's order: Goal 2 (the hosted box as a service -- the server session's work, coordinate), Goal 4 (per-map kill routes), the carried Q items. The owner's ear on the music is still the next input (HUMAN_TASKS round three).
- **Where the loop was at 09:00 UTC:** Sprint 9 is closed on the machine's side and merged to `main` as `v0.9.0`; Sprint 10 is open on `sprint-10`. The last thing done: Q0 -- the mission ambience was a CONDUCTOR sound our mixer never ran (R178), found by the audio parity check the owner asked for; read `docs/archive/sprints-7-12/2026-09-20-sprint-9-q0-mission-music-investigation.md` sections 6d-6f before touching audio: the instrument, the finding, the verdicts (gate 3/3, parity 31/48), and the four things left open with their numbers. **Gates as left:** `s9_q0_children_gate` 3/3 on exe sha256 `b3abebd5...`; suite 686/686 and Python 1457 three times over; CI green `7de8492`; audio parity `s9_q1_parity_ours2` 31/48 -- the check's first PASS is Sprint 10's to earn (the bed's level, the movie audio's level). **The owner's input is next** (HUMAN_TASKS "round three": listen on `dist/socom2.exe` through the JBL; the ladder window; the blue arrow). Sprint 10 Goal 1's job exists and ran once (LOBBY-FAIL, ledgered); its Task Scheduler entry is DISABLED until the owner names a window. Q0b, Q1b-Q7 carried into Sprint 10 -- `docs/CURRENT_SPRINT.md` has the order.
- **Nobody else is known to be in the tree** as of 2026-09-19: `git status` showed only `server/config/simulated.db`,
  which is always modified and is never committed. The Goal 10 session's work is committed; the Goal 3 plan is
  committed and not started.
- **A playtest by the owner is planned.** The order of work exists to make that session worth their time.

## §4 as it stood

## 4. The work, in order

`docs/CURRENT_SPRINT.md` is the list; this is its shape and the reasoning, so you can re-derive it when it changes.

- **Sprint 9, milestone P -- "worth the owner's evening", ends in the tag `playtest-1`:** P1 the music's two bugs
  (queue, ramp) with the confirming trace first; P2 the universal half (stream looping for menus and lobby, a
  concurrency cap and headroom); P3 the pad driving both windows; P4 the launcher's small defects (page-change flash,
  two alignments, ADVANCED section, tooltips); P5 Goal 8's close-out; P6 the server by name (unblocked: the DNS record
  exists); P7 the release candidate, gated and tagged; P8 the owner plays it (`docs/PLAYTEST.md`).
- **Milestone Q -- after the playtest, ends in the merge and `v0.9.0`:** Q0 the owner's notes first; Q1 the audio
  instrument so the music cannot silently return; Q2 Goal 3, knob retirement (a written 9-task plan; the most
  expensive item in the sprint); Q3 the mouse leaves and the keyboard is narrowed (depends on Q2's developer mode --
  see trap 1); Q4 the rest of the launcher (guide button, game window style, menu sounds from the player's ISO, profile
  viewer); Q5 voice, the headset's button; Q6 Goal 11, the latched-stall memory bound; Q7 residual filler; Q8 close.
- **Sprint 10** -- it stays up (the scheduled ladder, moved back from Sprint 9 Goal 5), the hosted box as a service,
  the mixed match with PCSX2 both ways, per-map kill routes, the first two-machine match (owner), a real DB (owner).
- **Sprint 11 -- as run**, four milestones rather than the goal list its spec was drafted as: **S** the chat hole
  closed on both sides; **U** upstream and external (the divergence table, the recompiler fixes, the demo disc's
  names); **R** the r0004 groundwork, which became an r0004 build that gates 3/3 and plays online; **P** the public
  repository's remaining owes (the download, the bug pipeline, the licences, the story, the VM ring). Nineteen tasks
  and **eight** owner decisions, each with the default the loop proceeds on (`docs/HUMAN_TASKS.md`).
  *(This bullet said "six owner decisions (D1-D6)" and listed the spec's draft goals until 2026-09-25.)*
- **Sprint 12, "the readable image"** -- the demo-name rename pass into the function map, vtable slots through RTTI,
  BinDiff as the cross-check, the ccc types with the layout-age caveat. **Closed 2026-09-25**: 1,771 readable names
  from one sidecar, every one with its provenance, proven `s12_names_gate` 3/3 on the renamed tree
  (`docs/superpowers/plans/2026-09-24-sprint-12.md`; run in a Claude cloud session, closed by the local controller).

**Why this order:** by what the owner meets first (the music, every session), then by dependency (the keyboard
narrowing needs Goal 3's developer mode; a public archive needs the
licence inventory), then by cost (Goal 3 is a full generated rebuild, three gates and an online round -- it must not
stand between the owner and a playable build). Sprint 9 was ten goals in the order they were thought of; it is now
eleven in the order they matter. Nothing was dropped.

## §10 as it stood

## 10. What the owner should decide before the playtest

1. **Who plays.** If the archive goes to anyone but the owner, Sprint 11's decision D2 arrives early: the portable
   archive contains `socom2.exe` (code recompiled from the game) and `socom2_game.elf` (the game's decrypted code).
   For the owner alone on their own machine it is not a question.
2. **The keyboard ruling** (trap 1): gameplay keys survive as the harness's path in developer mode, players get menus
   and typing. Overturning it means moving the harness to the pad path first -- a sprint of its own.
3. ~~**The persona switch** (P6)~~ -- **withdrawn 2026-09-19, it was not a real decision.** It asked the owner to
   approve a measurement for a cost that cannot occur: the launcher's preset string never reaches the game
   (R175, KNOWN §4), so switching the default to `socom.scotho.com` orphans nothing. Nothing is owed here. The
   related question that IS the owner's, if they ever want it: whether the hosted server should advertise its
   NAME rather than its IP -- that string is guest-visible, and that one would want measuring first.
4. **Is a friend on another network available for the playtest?** If so, the first two-machine match (carried since
   Sprint 7, and carried past Sprint 10's close) is answered in the same evening. It is the one item on the
   "what a stranger still lacks" list that no amount of machine time can close.
5. **Whether the release build should drop imgui and the dump/trace families** -- decided on Q2's size number, but the
   owner should know the trade: a smaller download against a shipped build that is harder to diagnose.

## §9 as it stood

## 9. What the owner said on 2026-09-20, and where each thing now lives

*States re-checked at the Sprint 10 close, 2026-09-23: nine rows that still read "Open" had landed in P4 (2026-09-20) and Q4 (2026-09-21, gate `s10_q4_gate` 3/3). Only the profile viewer is still a live question, and it is the owner's.*

| The owner said | Where it lives | State |
|---|---|---|
| The music gets louder and quieter and jumps between tracks; research it, fix it universally | Spec Goal 10; sprint P1, P2, Q1; music round four | **DONE on the machine's side 2026-09-21** -- the defect was a stereo VPK interleaved per 0xb000 streaming buffer that we split per 0x800 chunk, so every stem played its two channels from different places in the song (`c6502ea`); the mission's pauses are proven to be the game's own playlist design. What remains is the DEVICE dips, and the 2026-09-23 A/B proved those are ours rather than the owner's speaker (`docs/KNOWN.md` §1) |
| While the game runs the pad drives both windows; the guide button should toggle | Spec Goal 9; P3 (input gate), Q4 (guide toggle) | **DONE 2026-09-21 (Q4, R211-R213):** while the game runs the pad never drives the launcher; the switch is one button, bound in BUTTONS with OFF beside it, the guide by default, read from XInput's ordinal 100 on Windows |
| Live server stats in the launcher | Goal 8's ONLINE line, one reader | Landed; confirm at P5 |
| Style the game window like the launcher; a header button that focuses options | Q4 | **DONE 2026-09-21 as decided, not as asked (R214, R215):** no header bar on the game window in this pass, because the client area is what the gate captures; the window's title became "&lt;game&gt; -- SOCOM Unzipped" and the harness's key moved with it |
| UNZIPPED sits lower than SOCOM II; RUNNING sits above its lamp | P4 (`main.cpp:443-446`, `:463-467`), asserted in tests | **DONE 2026-09-20 (P4, R176's pass)** -- both alignments landed and are asserted in tests |
| Tooltips ("what is a profile?"); should there be a profile viewer? | P4 (tooltips); Q4 (viewer -- the owner's call) | **Tooltips DONE 2026-09-20** (six, focus-driven). **The profile viewer is the one row here that is genuinely still open, and it is the owner's call, not the loop's** |
| Move "Second instance" into an ADVANCED section | P4 | **DONE 2026-09-20 (R176)** -- ADVANCED is a per-page section, it holds one thing today, and it may not hide a setting that is doing something |
| A one-frame flash at the top left on page change | P4 (`1966fa6`) | **DONE 2026-09-20** -- the frame's node list was built before input, so the frame drew the new page with the old list |
| Launcher menu sounds from the game's own bank | Q4 -- decoded from the player's ISO at first run, cached, never shipped | **DONE 2026-09-21 (R216, R217):** the cues play at 0.45 of their rendered level with the setting on AUDIO, and the cache is keyed by content (SHA-256 over the PVD and the bank's first sector), not by path |
| Remove every mouse option; keyboard permanent but for menus and typing only | Q3; trap 1; R210 | **DONE 2026-09-21** (`agent/q3`, merged `0c172a6`): the mouse and its two knobs are gone; the gameplay keys survive in developer mode only, which every harness launch is |
| The debugger must not be open at launch | `2d0463f` (it was `m_visible = true`; F1 toggles) | DONE. Open: whether the release build carries imgui at all -- a size measurement inside Q2 |
| We expose many PS2X options; maybe a private git-ignored dev build -- "unless you agree otherwise" | Spec Goal 3, "the exposure question"; Q2; `SECURITY.md` | Answered no, with reasons; one real vector found and fixed (`f5809c8`, the profile was a path). The owner can still overrule -- as a committed option |
| The server's name is `socom.scotho.com`; "you add it" | `80b1971`; P6 | The DNS-only A record exists and resolves. Next: the persona measurement, then the launcher's default |
| The site must stop claiming keyboard/mouse support | Section 8 relay | Owed to the site session |
| A playtest is planned | Milestone P; `docs/PLAYTEST.md` | Scheduled |
| Make the project public and forkable, with intentional git planning | `docs/GIT_STRATEGY.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/`, Sprint 11 spec Goals 0, 1, 7 | Designed and scheduled; early files landed |

## Moved 2026-09-26 05:17Z at the Sprint 14 open (HANDOFF §2's one "now" bullet, verbatim)

- **Where the loop is now (2026-09-26 04:17Z, LATEST) -- Sprint 13 is CLOSED on `sprint-13` (the close-out commit); PR #61 to `main` is open, green, and waits on the owner's merge (HUMAN_TASKS O17); the loop tags `v0.13.0` on the merge commit after.** Read `docs/CURRENT_SPRINT.md`'s "Sprint 13 -- CLOSED" block and the plan's Outcome (`docs/superpowers/plans/2026-09-25-sprint-13.md`). The next controller opens Sprint 14 ("guards, not sentences", its pair in `docs/superpowers/`) off `main` after the merge; its Task 0 commits the Sprint 14 and 15 pairs and the never-run cloud handoff. Three issues wait on the owner (HUMAN_TASKS O16).

## Moved 2026-09-27 13:55Z by the Sprint 16 controller (HANDOFF §2's one "now" bullet, verbatim)

- **Where the loop is now (2026-09-27 07:00Z, LATEST) -- Sprint 16 ("ten minutes to the server") is OPEN on `sprint-16`,
  off `main` at `d84ffbde` (Sprint 15 merged as `v0.15.0` at `10650369`, PR #81, without its play test). First V0 (the
  Sprint 15 legs, one chain at the end of this block, the desk idle), then R1a's spike and F0's window; L2 (#74) is PR
  #82 in a fix round, L1a's note in one, R3a and X1 in flight. Cloud sessions are allowed for lock-free work (R312).
  The plan `docs/superpowers/plans/2026-09-27-sprint-16.md` (its Log) is the live state.
