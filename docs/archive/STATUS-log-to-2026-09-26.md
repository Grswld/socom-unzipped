# STATUS.md -- the dated log under the "Current state" block, to 2026-09-26 (archived)

> **ARCHIVED 2026-09-26 (Sprint 14 Task S1, R272) -- superseded by `docs/CHANGELOG.md` for what merged and when**
> (generated from the merge commits and the `v*` tags by `python -m tools_py.changelog`) **and by the sprint plans'
> Logs** (`docs/superpowers/plans/`, each plan's "## Log") **for the reasoning.** `docs/STATUS.md` keeps its
> "## Current state" block and a pointer here. Below the VERBATIM line is everything that stood under that block at
> `04d75f6f`, its line 19 to the end: the dated entries, newest first, from the Sprint 13 close back to
> the first boot (2026-09-05), then the old "Known issues / debt" and "Environment facts" sections. **Nothing below is current and nothing
> is an instruction;** each entry keeps the numbers it was written with (it was class S by paragraph). A STATUS
> entry, section or line cited by date before 2026-09-26 means this file. **Line numbers:** line N of
> `docs/STATUS.md` at `04d75f6f` (N of 19 or more) is line N-5 here.

<!-- VERBATIM below this line: docs/STATUS.md at 04d75f6f, line 19 to the end -->
## 2026-09-26 — the Sprint 13 close bullet, moved from Current state at the Sprint 14 open

- **2026-09-26 04:17Z -- Sprint 13 ("nothing carried twice") is CLOSED on `sprint-13`; PR #61 to `main` is open with every check green and waits on the owner's merge (HUMAN_TASKS O17: the ruleset's extra-approval rule, the gh token's missing `workflow` scope); the tag `v0.13.0` follows the merge.** The record is `docs/CURRENT_SPRINT.md` "Sprint 13 -- CLOSED" and the plan's Outcome. Next: Sprint 14 "guards, not sentences" (its pair is in `docs/superpowers/`, opened by its own controller off `main` after the merge), then Sprint 15. Carried to the owner: #25, #26, #42 (HUMAN_TASKS O16). *(The merge came 2026-09-26 ~05:00Z: `6a82caaa`, a merge commit, the tag on it.)*

### 2026-09-26 — the Sprint 13 open bullet, moved from Current state at the close

- **2026-09-25 08:40Z -- Sprint 13 ("nothing carried twice") is OPEN on `sprint-13`, off `main` at `74fe2a9b`, and closing tonight.** The plan `docs/superpowers/plans/2026-09-25-sprint-13.md` (its Log) is the live state; `docs/CURRENT_SPRINT.md` "Sprint 13 — OPEN" is the block. What Sprint 12 carried in: the r0004 leg of its proof ran green (`s13_proof_gate_r0004` 3/3 PINS MATCH, `2c873710`); the story's five missing days are written (S13 S4, `d4a8f0ea`). The previous bullet (Sprint 12 CLOSED) is the log's 2026-09-25 (morning) entry below.

## 2026-09-25 (morning) — the Current state bullet from the Sprint 12 close to Sprint 13's close review

*(Moved here verbatim on 2026-09-25 at the Sprint 13 close review, R268; it stood as the Current state bullet from the Sprint 12 close until then.)*

**2026-09-25 (morning) -- Sprint 12 ("the readable image") is CLOSED: the proof is green and the sprint merges to `main` as `v0.12.0` behind Sprint 11's `v0.11.0`.** The generated image carries 1,771 readable names with a recorded reason each (the sidecar `recomp/socom2_names.csv`; r0004 1,705 rows through `carry_names`), applied by one tool from ten levers whose rules are code, and proven on this machine: recomp 14,882 files with 1,771 renamed and no extent moved, the runtime rebuilt from scratch, both suites green, the r0001 gate `s12_names_gate` 3/3 with PINS MATCH (exe `804dd172…`, at `cb56fc8`). The sprint ran in a Claude cloud session (plan `docs/superpowers/plans/2026-09-24-sprint-12.md`, research/47–61, rulings S12-R1–R25); the local half was the proof, the merge and the close. Carried: the r0004 leg of the proof, the 518 loose rows, the plan's follow-ups, the story's missing days — `docs/CURRENT_SPRINT.md` "Sprint 12 — CLOSED". Next sprint: not yet planned; the owner names it.

## 2026-09-25 — Sprint 12 closed: the generated image is readable, and two controllers shared one machine for a day

**The local half of Sprint 12 (session socom-pc-6c, 04:40Z onward).** Sprint 12 was fleshed out and executed by a
Claude cloud session on `sprint-12` (2026-09-24/25) under the cloud handoff; what the cloud could not do was build the
Windows game or run the gate. The local controller took the sprint's local half once Sprint 11's last lock-bound
commit (the r0004 rebuild proof, `3bb866f`) was in: a worktree of `sprint-12` merged with that head, one lock hold for
the four commands of the PROOF REQUESTED row — recomp with the 1,840-name sidecar (against the pre-rename census
1,771 files renamed, 0 extents changed, 0 functions dropped, `S12-R11 OK`), the runtime from an empty build tree in
13 min (exe `804dd172…`), `build.sh test` exit 0, and the r0001 gate from the main tree on the worktree's exe:
`GATE PASS (3/3)`, `PINS MATCH (13 compared)` — the result appended to the row (`83e9696c`). Then Sprint 11's
close-out merged (`deb288c2`, `eb190a42`), the two close reviews (a read-only agent's table, the controller's edits:
the "Sprint 12 — CLOSED" block), the suite counts on the renamed tree (C++ 892/892; Python `Ran 2795`, `OK` once the story timeline this close had edited was regenerated), the r0004 leg (`s12_names_r0004_gate` 3/3 with PINS MATCH on the r0004 runtime built with its own sidecar, after the r0004 pin standard was restored from a stray knob `--accept-pins` had written into it — issue #45 (closed)'s class) and the PR to `main`. **The known-issue stack at this close:**
opened 0, closed 0, carried 0 (the `Sprint 12` milestone held no issue and is closed); one issue opened by the
review (#48: `build_revision.sh --out` drops the names sidecar); comments on #25, #28, #40 and #42; highest
issue #48 (closed); the six issues Sprint 11 carried were never in Sprint 12's milestone and are ruled not carried
twice (a single-theme sprint took nothing from the backlog). **The two controllers:** the cloud handoff's §5 held as
written — the Sprint 11 controller pinged at each lock hand-over and the lock serialised the rest — with one lesson:
the lock has no queue (issue #36 (closed)), so the second controller's poller took a gap between the first one's chain
steps once and cost it ten minutes.

## 2026-09-25 (early) — Sprint 11 CLOSED and merged to `main` as `v0.11.0`; Sprint 12 ("the readable image") runs in the cloud on `sprint-12`

- **2026-09-25 (early) -- Sprint 11 CLOSED and merged to `main` as `v0.11.0`; Sprint 12 ("the readable image") runs in the cloud on `sprint-12`.** What the sprint proved: the r0004 build passes the gate 3/3 and plays a scored round on our own server (the reboot was two of PSRewired's capsule words baked into our dumped image; KNOWN §2's r0004 row is the whole chain); ten upstream picks kept on their own 3/3 gates and one combined gate; four runtime subsystems per runtime; the SOCOM 1 demo's symbols matched into our map (987 names, 479 safe proposals — applied in Sprint 12); the two revisions cannot join each other's games by the client's own token filter (Goal F). Suite counts at the close: `docs/DEVELOPING.md`. The §7 stack review: 18 issues opened this sprint (#25–#42, the stack's birth under R252) and three at the close (#45 the accept-pins start-up write, #46 `movie_blocks.py`, #47 VU0 flag latency), 1 closed (#29), 20 open; the 6 in the Sprint 11 milestone carried to the backlog with the `carried` label and a comment each (#25 #26 #33 #37 #38 #42; none is in Sprint 12's plan), the milestone closed and Sprint 12's created; highest issue #47. Owner decisions carried: `docs/archive/HUMAN_TASKS-to-2026-09-25.md` "Sprint 11 close — what needs you" (the old list, archived 2026-09-25).

## 2026-09-23 (the twelve-hour mandate) — Sprint 10 is CLOSED, pending only the merge to `main` and the tag `v0.10.0`; Sprint 11 is open on its plan

- **2026-09-23 (the twelve-hour mandate) -- Sprint 10 is CLOSED, pending only the merge to `main` and the tag `v0.10.0`; Sprint 11 is open on its plan.** Five launches ran back to back overnight and every one produced a result. **The endpoint A/B gave a verdict** (02:43Z, after the per-app routing fix; the first attempt refused to score, rc=5, exactly as designed, because it was still on the JBL): **wired 14 DEVICE dips against Bluetooth 11 over sixteen minutes** -- the mission music's dips SURVIVE a wired endpoint, so they are ours, after the mixer's dump point, and three rows in `docs/KNOWN.md` that blamed the owner's speaker are retracted in place. **W10 split** (launch 1 rc=0, launch 2 rc=4 `login:saved-password:empty`): on a virgin card the persona survives a restart and the saved password does not, so **R237 is rewritten -- the prefilled login stays in the player path** and one clean-exit launch settles which side loses the write. **W7** walked 21 minutes and found 47 DEVICE dips at the JBL, the lead the A/B then superseded. **W6 did not reproduce** -- ten identical clean popups across both walks -- but the owner saw the garbled atlas after the church load, which an in-place walk never reaches, and the capture records no `PS2X_*` environment, so the revalidate-off half is unproven; it is carried rather than closed. **W8 needs no run of its own (R244)**: the ladder exercises the join driver's R240 refresh path. The ladder streak is `docs/LADDER.md`'s, generated, and is filled in at the tag; the 2026-09-23 log entry below is where it is recorded. Also found and fixed: a worktree's copy of `scripts/loop_lock.sh` resolved to a private lock, so a build ran beside a capture -- machine-wide now (`9b39523`). Sprint 10's sixty-four rulings R181-R244 are reconciled into one table in `docs/CURRENT_SPRINT.md` (R229 deliberately vacant), and Sprint 11 is open on `docs/superpowers/plans/2026-09-23-sprint-11.md`.

## 2026-09-23 — Sprint 10 closed: the endpoint is exonerated, the card keeps the persona but not the password, and the sprint's sixty-four rulings are in one table

The owner handed the machine over at 22:10 local with twelve hours and their authority ("proceed with all remaining
sprint 10 work and finish sprint 10 ... Once that's done, formalize and begin sprint 11 autonomously"). This is what
the night produced. Sprint 10 is closed; what is left of it is the merge to `main` and the annotated tag `v0.10.0`.

**Five launches, five results.** Chain 1 ran the queued runs back to back. The endpoint A/B's first attempt refused
to score (rc=5) because the per-app routing fix had not landed yet and the capture was still on the owner's JBL --
which is the instrument doing its job rather than a failure. W10's launch 1 came back rc=0: persona `w10test`
  > Superseded 2026-09-27 15:58Z (the Sprint 16 L1b driver review): the persona was created as `w2-test`, not `w10test` -- the driver's on-screen-keyboard walk landed one key right on the digit row (`OSK_ROW_ORIGIN`, merged 2026-09-27); the frame `logs/parity/w10_virgin_a/03_name.png` shows it.
created on an empty card, SAVE PASSWORD answered LEFT and read back as yes, `LOBBY class=ok`, the card left holding
`BASCUS-97275SOCOMII/SaveGame0-6`. W10's launch 2, booting from that same card with nothing typed, came back rc=4,
`LOBBY-FAIL login:saved-password:empty`. W7 walked twenty-one minutes and scored 47 DEVICE dips at the JBL, peak 31
in a minute, absent from the mixer's dump. W6's A/B ran clean, rc=0, and did not reproduce.

**The endpoint A/B, re-run at 02:43Z on the re-routed endpoint, gave the verdict the whole audio investigation was
waiting on: wired 14 DEVICE dips against Bluetooth 11 over sixteen minutes.** The dips survive the wired device, so
they are ours -- after the mixer's dump point, endpoint-independent
(`logs/parity/endpoint_ab_20260922_232644`, and `endpoint_ab.sh`'s own VERDICT line). Three places in
`docs/KNOWN.md` had blamed the owner's Bluetooth speaker since 2026-09-20: the proven "~41 times a minute" row, the
believed row that named this exact A/B as its settling condition, and the §4 hazard about naming the endpoint. All
three are retracted in place, with their measurements intact -- the numbers were never the problem, the attribution
was. The live question is now narrower and better: what loses about 50 ms between `render()` and the dump's write,
which is a §2 row with a stamped-clock capture attached and a Sprint 11 audio item.

**W10 split the memory-card question in two, and R237 is rewritten because of it.** On a virgin card the persona
survives a restart; the saved password does not. So the game's own supported way in -- a persona with
remember-password -- does not yet reach the lobby unattended, the prefilled login is not redundant, and **it stays on
the player path**. Two candidates remain with no evidence between them: the game writes the password only on a clean
exit, which the driver's kill skips, or our card HLE (or the relaunch's read) drops the field. One launch that quits
through the driver's own exit path, then the same relaunch, settles it. Worth recording beside this: the virgin-card
*save* failure the owner hit on 2026-09-22 was already fixed at the root on that day (`152579a`, PR #23, gate 3/3 --
the game enumerates a fresh card with `..` and our normaliser refused it), and W10's launch 1 is the proof that the
fix holds, since it created a persona on an empty card at all.

**W6 is carried, not closed.** Ten identical, clean HELP popups across both twelve-minute walks, the owner's
"Headquarters has provided you with some HELP" among them. But the owner's sighting was after the church load, which
an in-place walking leg never reaches, and the mission capture writes no environment dump, so
`PS2X_GS_NO_TEX_REVALIDATE=1`'s presence in the second run cannot be proven from the artefact -- the "off" half of
the A/B is not evidenced. A null result from an A/B whose halves cannot be told apart is not a null result; it is an
unrun experiment, and it is now a standing hazard in KNOWN §4 alongside the second thing this night taught: a
worktree's copy of `scripts/loop_lock.sh` resolved to a *private* lock, so a build ran beside a running capture. The
lock follows git's common dir now (`9b39523`), which makes it machine-wide for every worktree, as HANDOFF §5 rule 6
had always claimed it was.

**W8 was answered without a run (R244).** The join driver's R240 path -- REFRESH LIST before JOIN GAME, then a
channel -- is exercised by every ladder run, so the ladder proves it and the two-instance self-join was dropped
rather than scheduled. The ladder streak at the close: `**7 of 7** (runs 5, 6 and 7 KILL on 2026-09-23 at 03:03Z, 03:36Z and 04:21Z, exe 3f3a5011; the bar "seven consecutive runs with no LOBBY-FAIL and no CRASH" met; `docs/LADDER.md` is the ledger)`.

**The close's documentation half.** Every live document was read for truth against the tree
(`docs/DOC_MAINTENANCE.md` §5). Sprint 10's rulings are reconciled into **one** table in `docs/CURRENT_SPRINT.md`:
R181-R244, sixty-four numbers carrying sixty-three rulings, with R229 recorded as deliberately vacant rather than
missing; nothing was renumbered and the free-number counter in `docs/HANDOFF.md` is unchanged. The index paragraph that used to carry that list on a
single 2,700-character line is now a pointer to the table. Four rulings changed state across the sprint -- R236
overturns Sprint 7's R92, R238 was corrected in place after its first telling proved false, R239 was withdrawn by the
very A/B it asked for, and R237 was reversed by W10 -- and all four are visible as such in the ledger.

**What carries to Sprint 11**, which is open on `docs/superpowers/plans/2026-09-23-sprint-11.md` (milestones S, U, R
and P; eighteen tasks; eight owner decisions each with the default the loop proceeds on): Goal 4's per-map kill
routes as [A] filler (R242), Goal 3's tasks 5 and 7, the Linux VM ring that R209 deferred to this close and that did
not run, H7's two owner decisions, the mission music's DEVICE dips as an audio item, a W6 capture over a route that
actually reaches the church, and the harness change that makes every evidential capture write its own `PS2X_*`
environment. One loose citation is named rather than left to rot: R243's `docs/research/40-upstream-divergence.md`
lives on branch `agent/upstream` (`83c02d9`) and reaches this tree when milestone U merges.

---

## 2026-09-21 (all day) — Sprint 10's whole autonomous stack is done and on `main` in four slices; what is left needs the owner's hands or long game runs

- **2026-09-21 (all day) -- Sprint 10's whole autonomous stack is done and on `main` in four slices; what is left needs the owner's hands or long game runs.** After the hardening milestone (slice 1, `92b92c6`), eleven chunks were taken by Opus agents in their own worktrees and paid for in the main tree, each with its gate: **Q1b** the gate pins every input it scores against and refuses to score on drift (`s10_q1b_pins_gate`); **Q6** a latched render stall bounded, 1.45 GB -> 67 MB (`s10_q6_gate`); **the threaded flake** fixed at its root (a lockstep simulated clock, 50/100 -> 0/300); **Q3b + Goal 8** the mapping data path and the remapping UI (`s10_g8_gate`, a Frostfire control round, the mapping hash pinned); **Goal 9** the credentials, end to end after two findings -- the action table dispatches through a thunk, and the runtime's scheduler unwound the wrap mid-open (three `LOBBY class=ok` logins with prefilled keyboards); **Goal 2** the box as a service (daily backups, the restore drill run once, a health line, the money line); **Q2 / Goal 3** knob retirement, the sprint's biggest item: 151 names classified, one accessor, `docs/KNOBS.md` generated and held to the source, developer mode, and a poisoned environment proven inert (`s9_g3_batches_gate`, `s9_g3_gating_gate`, a Foxhunt round); **Q3** the mouse gone and the keyboard narrowed to menus and typing for a player (`s10_q3_gate`, a Foxhunt round, a player-side launch); **Q4** the window switch, the game window's chrome and menu sounds from the player's own disc (`s10_q4_gate`); **Q5** closed under its stop rule with the finding that the game's protocol has no headset button at all; **Q7** four residuals including the console-replay case that had never run (`s10_q7b_gate`, after one revert). Suite now: **Python 1671 OK, ps2x_tests 764/0**; ladder streak 4 of 7. Two regressions were caught by the gate and only by the gate (Goal 9's unwound wrap; the stub-state header sharing per-TU state -- a KNOWN row each), and three process traps are in memory (worktree junctions twice, WSL bash on a Windows runner, docs-only pushes cancelling builds). **Left for the owner** (`docs/HUMAN_TASKS.md`): a pad session on the remapping UI, the prefilled login, Q4's four tries, the disc-derived-bytes decisions, the ladder window. **Left for a quiet machine:** Goal 4's per-map kill routes, Goal 3's tasks 5 and 7, ladder runs 5-7, Q2's Task 8 VM ring, the gate-scored residuals Q7 wrote up.

## 2026-09-21 (10:00 UTC) — the music, round four, closed on the machine's side: sixteen items, eight fixes, three instruments, and the pauses proven to be the game's

- **2026-09-21 (10:00 UTC) -- the music, round four, closed on the machine's side: sixteen items, eight fixes, three instruments, and the pauses proven to be the game's.** After the stereo interleave fix, the decision-level poll of the EE's music state machine on both machines (`music_state_poll --what music`) showed the same stealth playlists with the same ~10 s rests -- the mission's pauses are its design, not ours. The intro/briefing music's dropouts were the MPEG HLE's picture-count gate starving the PCM ring (found by the new per-guest-thread scheduler trace; fixed `619c139`: a stream-time gate, held video, audio every tick; in-stream holes 10 -> 0). Music-only score 6 -> 134 of 177, the remainder being the two walks' timing. The owner's fifth listen (HUMAN_TASKS) is the bar; the plan's task 4 has every item. Next for the loop: Sprint 10 Goals 2 and 4, the ladder streak, and the hosted server work.

## 2026-09-21 (night, 03:00-09:00 UTC) — the hardening is on `main` (PR #6 `92b92c6`, PR #12 `16f0133`); six agent chunks landed and were paid for

- **2026-09-21 (night, 03:00-09:00 UTC) -- the hardening is on `main` (PR #6 `92b92c6`, PR #12 `16f0133`); six agent chunks landed and were paid for.** Merged into `sprint-10` and proven in the main tree: **Q1b** the gate pins its inputs (`s10_q1b_pins_gate` 3/3, PINS MATCH, the env drift refused); **Q6** the latched-stall bound (`s10_q6_gate` 3/3; a 600-frame stall peaks at the cap + one command instead of 1.45 GB); **the threaded flake** at its root (a lockstep simulated clock; 50/100 -> 0/300); **Q3b + Goal 8** the mapping data path and the remapping UI (`s10_g8_gate` 3/3 with the mapping pin accepted, the Frostfire control round clean; the owner's pad session in HUMAN_TASKS); **Goal 9** the credentials -- launcher fields, config, environment, the zip's blanking, the OSK handler named, `--prefilled` in the harness (`s10_g9_gate` 3/3) -- with the driven logins finding two gaps: the thunk the action table calls (fixed, `2bc56ec`) and the keyboard's initial text not being `0x49ec70` (open, an agent on it with a stop rule). **Goal 2** done on the box (backups, the restore drill run once, the health line, the money line). **Goal 1** ladder streak **4 of 7** (runs 2-4 by hand, KILL 4/4 each). Q2 knob retirement is an agent in flight. Suite as of the Goal 9 chain: Python 1641 OK, ps2x_tests 731/0. Two self-inflicted outages, each recovered from the pinned bootstrap in minutes and recorded in memory: removing agent worktrees deleted the toolchain through their junctions (twice); the log archive that made room for a gate orphaned fourteen story witnesses (marked archived).

## 2026-09-21 (02:30 UTC) — the music, round four: the real 989snd decompilation, the music-only instrument, and the owner's ear found the defect the numbers could not

- **2026-09-21 (02:30 UTC) -- the music, round four: the real 989snd decompilation, the music-only instrument, and the owner's ear found the defect the numbers could not.** Ziemas' decompilation (`research/989snd-ziemas/`, audit research/36) overturned the night's still-playing model (bit 31 cleared on deactivate; the EE starts stems fresh) -- four model commits with tests. The music-only capture (both machines through AUDIO OPTIONS with SOUND and DIALOG at zero; eight navigation facts learned one run each; the 620 s recorder; the per-app session volume held after Windows had `socom2.exe` at 3 percent = the '31 dB') went 6 -> 77 -> 126 windows of 177. Then the owner: "it doesn't even sound like music" -- content analysis found every stereo music stem on ours playing its two channels from different places in the song (a two-channel VPK is interleaved per 0xb000 buffer, ours split it per 0x800 chunk; `c6502ea`), which every level instrument had passed; the scorer now carries stereo alignment (`37579aa`). Run 13 on the fixed build: 136/177, no desync. The decision-level poll of the EE music manager on both machines (`music_state_poll`, `2aafc38`) then showed the first three cues lining up to the second and cue 4's stem ending after 9.3 s on ours (a ~79 s file) while the console plays on -- item 13, open, with the PCM ring's 300-400 ms feed stalls (item 11). The owner's fifth listen is queued in HUMAN_TASKS. Plan: `docs/archive/sprints-7-12/2026-09-20-sprint-10-music-round-four.md` task 4.

## 2026-09-21 (early) — milestone H is done but for the owner's two decisions: a fresh clone builds on Windows, the tree is clean of the suite's debris, the licence inventory has a test, the release folder and the bug report pass the gate

- **2026-09-21 (early) -- milestone H is done but for the owner's two decisions: a fresh clone builds on Windows, the tree is clean of the suite's debris, the licence inventory has a test, the release folder and the bug report pass the gate.** H3: `scripts/bootstrap_windows.sh` (llvm-mingw 20260826, CMake 4.4.3, Ninja 1.13.2, each pinned by sha256), `build.sh --no-runner`, `windows.yml`; the bar run as a stranger on this machine (scratch clone, bootstrap 15 s, runtime 5 m 52 s from nothing, Python 1571 OK, ps2x_tests 700/0, VU1 verify OK) and on a bare runner (green on `a175ec7`: bootstrap from nothing, the build in 4 min, Python 1571 OK, ps2x_tests 701/0, the VU1 verify OK; `build-windows` joined `main`'s required checks). H4: the audio suite's 28 fixtures go to the temp directory. H5: `THIRD_PARTY_NOTICES.md` + `LICENSES/` + a test that fails on a dependency, a vendored directory or a release DLL without a row. H6: `make_portable.sh` refuses a folder the leak check flags (proved on its first run by the licence texts' FSF address); `diagnostics::scrub` closes its KNOWN row (any user directory, credential values, peer addresses; six plants RED 700/1 then GREEN 701/0; gate `s10_h6_scrub_gate` 3/3, exe sha256 8a648010). H7: the disc-derived-bytes audit (`docs/audits/2026-09-21-disc-derived-bytes.md`) -- nothing moved; the two decisions are the owner's. H8: `release-draft.yml`, draft on a `v*` tag, a manual run verifies the attached archives, never publishes. Found on the way: the first Windows CI run spawned WSL's bash from thirteen tests (one shared finder now); a docs-only push cancelled the running build (cancel-in-progress off). Next: the Goals resume in the reorganized order (Goal 2 the box as a service -- the server session's; Goal 4 the kill routes; the carried Q items), with the owner's H7 and `simulated.db` decisions and the `windows` check joining `main`'s required set once green there.

## 2026-09-20 (evening) — the repository is PUBLIC; Sprint 10 reorganized around hardening it; the leak gate is in four places

- **2026-09-20 (evening) -- the repository is PUBLIC; Sprint 10 reorganized around hardening it; the leak gate is in four places.** The owner flipped `Scotho/socom-unzipped` public, bypassed the owner gate on the audio listen, and set the priority (hardening the dev build process; no easy player setup yet; nothing sensitive can ever be published). Built the same evening: `tools_py/release/leakcheck.py` (six modes, three exit states, a 28-shape planted control, `leak_allow.txt` as the ledger; the monitor's rules vendored and adapted for a source tree, R183), the pre-commit/pre-push hooks (`scripts/install_hooks.sh`; proven in a throwaway clone), CI `secrets.yml` (the gate over full history plus gitleaks 8.30.1 pinned by sha256), `linux.yml` restructured so `build` always reports and can be required, GitHub secret scanning + push protection + Dependabot alerts (R181), rulesets on `main` and `sprint-*` (R182). Clean on both scanners: the tree, 920 commits of history, the identities, the ignored paths. Found on the way: two tracked decrypt logs with the home directory (untracked), two dangling submodule gitlinks that made every clone warn (**recorded as removed here on 2026-09-20; corrected 2026-09-25 — the removal did not take.** `git ls-files -s server/` still returns `160000` entries for `server/horizon-docker` and `server/horizon-server-database-middleware`, there is still no `.gitmodules`, and every clone and every CI job at `fccf3b5d` still prints `fatal: No url found for submodule path 'server/horizon-docker' in .gitmodules` — the first thing a stranger's `git clone` of a public repository says. **removed for real at the close, 2026-09-25, in `6658d863`** — close-review A3b), and `simulated.db` in public history (the owner's, HUMAN_TASKS). Milestone H's H3-H8 are next; the Goals resume after.

## 2026-09-20 (evening) — controller handoff

- **2026-09-20 (evening) -- controller handoff.** The controller's seat passes to a new agent; `docs/HANDOFF.md` is rewritten as its starting point (the old one is in `docs/archive/`). The sprint stack is reordered around a planned owner playtest: Sprint 9 is cut at the tag `playtest-1` -- the music (Goal 10; root cause found, a fix in progress in another session), the pad driving both windows and the launcher's small defects (Goal 9), Goal 8's close-out and the server by name (Goal 7; `socom.scotho.com` now resolves) come BEFORE knob retirement (Goal 3), the mouse/keyboard change, voice and the residuals; Goal 5 (the scheduled ladder) moves back to Sprint 10; Goal 11 (a latched stall must not eat the machine) is new. Sprint 10 has a spec; Sprint 11's is concrete (git and releases, the history and disc-derived-bytes audit, the bug pipeline, six owner decisions). For a public life: `docs/GIT_STRATEGY.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/` templates and `CODEOWNERS`. `docs/LOOP_PROMPT.md` rewritten to carry no state; `docs/PLAYTEST.md` is the owner's one-sitting script. Pruned: 19 root build logs, stray card folders, three stale handoffs archived, `.gitignore` gaps closed. No code changed: C++ 661/661, Python 1360.

## 2026-09-20 (later) — from the Current state block

- **2026-09-20 (later):** Sprint 9 Goal 2 done -- the portable download is 55.7 MB on Windows (-15%) and 99.4 MB on Linux (-13%), each exactly its import closure with a `SHA256SUMS`, the release exe stripped with symbols kept, gate 3/3 on the release exe itself (`s9_g2_release_gate`); `-O2` compressed worse and was not shipped (R151 -- but see 2026-09-20: the ruling was never applied to `build.sh`, whose release default stayed `-O2` until Sprint 9 P7 caught it). A crouch shortcut landed (R139: the game reads Triangle's pressure; a pad could never crouch). Goals 7 (the server by name) and 8 (the launcher's bug report section over the site's endpoints) are in the spec. C++ 649/0, Python 1360.

## 2026-09-20 (19:40 UTC) — Sprint 10 Goal 3's bar met: the mixed match runs both ways on the hosted server

- **2026-09-20 (19:40 UTC) -- Sprint 10 Goal 3's bar met: the mixed match runs both ways on the hosted server.** The console side (PCSX2) now runs ours' screen-verified lobby flow (`pcsx2_shell`), with references cut from console frames where its ~7% narrower screen needs them (four lobby titles, the Frostfire map row, the READY label edges). Leg 1 (the console joins a game ours hosts) and leg 2 (ours joins a game the console hosts) each reached a running round with both players moving twice in a row -- eleven runs in all, each failure one specific thing (the narrower screen, the READY edges, the 30 s notice, the stick keys, a pad-file crash, the shared peer UDP port 3658, a host ready before the join, one server-side join refusal). What the spec's "seen by the other" still wants is each guest's copy of the peer's position -- recorded as the plan's task 7. Goal 1: streak 1 of 7 clean ladder runs.

## 2026-09-20 (14:50 UTC) — Sprint 10 opened for real: the first clean scheduled-ladder row, and a console client in our hosted game

- **2026-09-20 (14:50 UTC) -- Sprint 10 opened for real: the first clean scheduled-ladder row, and a console client in our hosted game.** Goal 1: the ladder job's first two runs were LOBBY-FAIL create-game:create, and the failing frame showed the GAME LOBBY up -- the title matcher had the channel name "Channel 1" baked into its reference and the hosted box says "US East (Ohio)"; fixed on the title words (calibrated on 106 captures), two job/ledger path bugs with it, and run 3 (`ladder_20260920_101741`) is KILL 4/4, streak 1 of the seven the bar wants (`docs/LADDER.md`). Goal 3: the PCSX2 side now runs ours' screen-verified lobby flow (`Pcsx2Shell`); its first login reached the hosted server's briefing room with every step verified, and in leg 1 the console client joined ours' hosted game within 10 s and the round ran with both -- the joiner's own harness mis-read its GAME LOBBY frame (now kept on every miss) and the movement bar is being measured with a position trail on each side. Plans: `docs/archive/sprints-7-12/2026-09-20-sprint-10-goal-1-scheduled-ladder.md`, `...-goal-3-mixed-match.md`.

## 2026-09-20 (09:00 UTC) — Q0 closed as far as the machine can take it: the bed was a conductor sound; the audio parity check exists and says 31/48; Sprint 9 goes to main

- **2026-09-20 (09:00 UTC) -- Q0 closed as far as the machine can take it: the bed was a conductor sound; the audio parity check exists and says 31/48; Sprint 9 goes to main.** The owner's second listen ("stuttering, skipping, two segments at once") and their ask for "an audio parity test with PCSX2 like our visual parity test" produced the instrument (`scripts/parity/audio_parity.sh`: a WASAPI loopback of the default endpoint under drive.py, scored per step window against a pinned PCSX2 capture) and the instrument produced the finding: every stream the game requests plays its full disc length at the right level, and the console's continuous floor at the mission start is bank M51_AM sound 0x31 -- a CONDUCTOR of child sounds, a register test on the global the game writes every frame, markers, a loop -- whose grain types our mixer skipped. Modelled from the open 989snd reference (R178), pinned by tests on a hand-built conductor and on the real block cut from the disc; suite 686/686, gate `s9_q0_children_gate` 3/3, CI green, parity 10/48 -> 31/48 with no mission window silent. Left open, each with its measurement: the bed 7-12 dB under the console's (the child volume chain against the IRX), the movie audio ~18 dB low at the source (the PCM dump: ring full, samples quiet), the five positioned emitters muted by the EE's own attenuation, Q0b (no arrow while standing still; our burst captured blank frames). Also tonight: the first scheduled ladder run (LOBBY-FAIL create-game:create, ledgered after a path fix), the ladder job and ledger, the PCM dump reader. The owner's ear is next (HUMAN_TASKS, "round three"; now `docs/archive/HUMAN_TASKS-to-2026-09-25.md`).

## 2026-09-20 (07:00) — Q0: the mission music investigated to the device and fixed where the numbers said

- **2026-09-20 (07:00) -- Q0: the mission music investigated to the device and fixed where the numbers said.** The owner failed playtest-1 on the music. Four hours later, established by measurement rather than reading: the owner listens through a Bluetooth speaker Windows routes per executable path, every earlier audio measurement ran on a wired endpoint, and what Windows sent to that speaker dropped out 42 times in one driven mission minute (the mixer's own output: 2; PCSX2 on the same speaker: 0) -- raylib's fixed 10 ms x 3 device under load. The runtime now opens its own device at 20 ms x 4: 42 -> 2 on the same run. Also fixed, test-first: the pan sign (all music ~2.3 dB right), `snd_SetSoundParams` never reaching a stream (positioned voice lines stayed silent). Built: a stream-event trace on the WAV clock (underruns were counted nowhere), a stream-event reader, an envelope/splice/silence scorer, a WASAPI loopback recorder, and the project's first PCSX2 audio reference (its per-app routing override had to be removed and was restored). Ruled out by measurement: R169-R171 (inert on the mission path), reverb (A/B identical), loop flags, master-volume writes, early-done, an EE stall (pop-ups). Gates `s9_q0_trace_gate`, `s9_q0_device_gate` 3/3; 682/682. **Next:** the owner's ear on the new build (HUMAN_TASKS); Q0b the blue arrow; then the queue as ordered.

## 2026-09-20 (early hours) — `playtest-1` is tagged; milestone P is done but for the owner's sitting

- **2026-09-20 (early hours) -- `playtest-1` is tagged; milestone P is done but for the owner's sitting.** P4 closed (flash, alignments, ADVANCED section R176, six focus-driven tooltips), P5 down to the Linux send, P6 done (the server by name, R175: the preset string never reaches the game, so no persona could move; the raw address stays as a fourth preset because a name that will not resolve silently becomes 127.0.0.1). **P7: archive 55,829,577 bytes sha256 `f8f8149c...`, gate `s9_p7_playtest_gate` 3/3 on the exe inside it.** Building it found two defects that would have shipped: `WINHTTP.dll` missing from the portable audit's system allowlist (the closure failed, `build.sh` had already emptied `dist-release/` of DLLs, and the previous archive stayed put looking current), and R151 never applied -- `build.sh` defaulted the release to `-O2`, the value R151 rejected, since `285382e`. The `-O1` rebuild reproduces R151's number independently (62.8 -> 55.8 MB). Generalised as a KNOWN §4 row: a ruling in prose cannot fail; rulings that name a default want a test on the real artefact. Suite C++ 677/677, Python 1370. **Next: P8 is the owner's (`docs/PLAYTEST.md`); the loop goes to Sprint 10 Goal 1 (the scheduled ladder) in the owner's away window, per their instruction of 2026-09-20 -- Q0 (their playtest notes) outranks it the moment they arrive.**

## 2026-09-20 — from the Current state block

- **2026-09-20:** branch `sprint-9` (Sprint 8 merged to develop and main at `0e14323`). **Sprint 9 Goal 1 is done: a failure explains itself** -- one exit-code table shared by the runner, the launcher and Python (65 kept, 66-72 added), a preflight before any window opens, `socom2` with no argument runs from `config.json`, LAST RUN shows the code's sentence, SAVE DIAGNOSTICS writes one scrubbed zip. C++ 641/0, Python 1313 (+1 for the VM prune), gate 3/3 `s9_g1_gate`, the Linux half proven in the VM. The server's name will be `socom.scotho.com` (the owner's A record pending). In progress: the crouch-shortcut controller option (R139). Drafted at the end of the stack: Sprint 11 release hardening, with the progress story.

## 2026-09-19 (late) — P4's first half done; Goal 8's close-out is smaller than it looked; P6 turned out to be the wrong question

- **2026-09-19 (late) -- P4's first half done; Goal 8's close-out is smaller than it looked; P6 turned out to be the wrong question.** **P4 (`1966fa6`, suite 672/672):** the owner's one-frame flash at the top left is not only `rectOf()` answering the origin for an unknown id -- it is that the frame's node list is built BEFORE input and the page changes after it, so the frame draws the new page out of the old page's list and every label lands at (0,0). Fixed at both ends (`ui::nodesForFrame`, and a `drawable()` guard in every primitive, which is what covers the rail click that changes the page mid-draw). **The screenshot walk could not see it and now can:** it used to change pages after a frame was drawn, a moment no player can produce; it now changes them in the input phase, and `--shot-frames 2` captures the first frame of the new page. On a deliberately re-broken build 20 of 38 captures carry the defect, every bbox at (0,0); with the fix, none do. The top bar's two alignment defects are fixed by measuring the capitals' real ink instead of the line box (`ui::capInk` -> `topBarPlaces`), asserted in the pure test. **Goal 8 (P5) audited:** exactly one `/api/stats` reader exists (`main.cpp:298` behind `bug_report.cpp:664`), so Goal 9 needs none; three of the four documentation artefacts already landed in `46956e9`; what is missing is a STATUS record (this one) and two corrections -- the honeypot IS emitted (always empty), and the live proof id was cited in three documents with no artefact in the tree -- since confirmed on the box as `BR-20260919-c6d666`, sent from Windows; it was invisible here because the id is stored lower-case, displayed upper-case, and the local mirror predated it. **P6 (R175):** the persona measurement was withdrawn, not skipped -- the launcher's preset string never reaches the game (`loadHosts()` turns it into a `uint32_t`, `socom2_hostnet.cpp:303-316`), so the switch to `socom.scotho.com` cannot orphan a persona. Four documents that said otherwise are corrected where they were written. A new hazard came out of the same read: a preset name that does not resolve silently becomes 127.0.0.1, with only a `std::cerr` line. Next: the rest of P4 (ADVANCED section, tooltips), then P5, then P6.

## 2026-09-19 (night) — new controller; P1/P2 found already done, P3 landed, the monitor rebuilt as a static snapshot

- **2026-09-19 (night) -- new controller; P1/P2 found already done, P3 landed, the monitor rebuilt as a static snapshot.** The seat changed hands again (Opus 5). The first hour's read found `docs/CURRENT_SPRINT.md` a commit behind the tree: Goal 10's music fixes were not "uncommitted for review" but committed at `eca5450` with gate 3/3 (`s9_p1_gate`), and R172 was declined with a reason rather than left open. Rows corrected. **P3 done (`3b12fa4`, R173):** the pad reaches the launcher through one pure gate, `ui::padIntent`, so while the game runs the launcher reads nothing -- including the stick's repeat clock, which would otherwise have banked steps and spent them the frame the game exits; the foreground half of the owner's defect needed no code, because nothing in the launcher ever stole focus. Suite 669/669. **The monitor is now a static snapshot** (`../socom_monitor` `920e323`): a builder reads the repo read-only, a scrubber redacts, and an independent leak check swept 2,798 files and 568 MB of a real 563-run build for 0 hits, with a planted-secret control firing 8 rules; 162 tests. Nothing deployed, no DNS changed -- publishing is the owner's. Next: P4, the launcher's small visual defects.

## 2026-09-19 — from the Current state block

- **2026-09-19:** branch `sprint-8`. **The project's hosted Horizon server is live (AWS Lightsail, 3.143.65.100, the launcher's default preset) and an online match plays on it over the internet: a full control round, then a ladder of four usable rounds with two kills** (`s8_hosted_control2`, `s8_hosted_kill`). Also landed: the Linux client (merged to develop and main, CI green), the launcher redesign (a second pass from the owner's feedback is in progress: legible type, a drawn controller, a custom top bar, a bolder logo palette), simulated memory cards that persist (a driven save and read-back), the music fade as a timed ramp and the menu stream's first fill (gate title 23/23), a first-time-login path in the harness (the game keeps personas per server address). Goal 2's batching stopped by its measurement (R108b); **Goal 2b found and fixed the root (`759e218`, R123): the texture cache was re-decoded whole every frame because any upload moved a page generation; cached textures now revalidate by a content hash -- lobby decodes 1331 -> 0 /s, fps 52 -> 57, and the login screen holds 58-60 fps under a four-core host load with no back-pressure waiter (R125)**. Voice: the headset opens in a match; no pad button talks (all sixteen bits, both talk routes), so the headset's own button report is Sprint 9's question. r0004 and the community server are a wishlist item. Next: voice through the headset module (planned), the transfer-path trace, bare-run robustness, then the sprint's close-out. Windows: suite green, gate 3/3 (`s8_audio_mc_gate2`).

## 2026-09-19 — what a stranger still lacks (from the Current state block)

- **What a stranger still lacks** (2026-09-19; the audit's §1 list is all done except the two-machine match; a stranger CAN now report a bug from the launcher and see whether the server is up): ~~a server reached by name (Goal 7)~~ **done 2026-09-20 (P6, R175): the launcher's default preset is `socom.scotho.com`**, a first two-machine match over the internet (**owner**; every online result so far is two instances on one host -- still true; carried through Sprints 11 and 12 to the backlog and `docs/HUMAN_TASKS.md`), and -- before the repository is public -- licences, a history audit and install instructions (Sprint 11).

## 2026-09-18 (afternoon) — Sprint 8 Goal 1: the client on Linux, built and booting the same day

The owner asked for Linux support at 11:00 and offered VirtualBox. By 15:20: an Ubuntu 24.04 VM (`socom-linux`) built
unattended and provisioned; a GitHub Actions job on ubuntu-24.04; the port itself in seven slices, each under the rule
that Windows stays byte-for-byte the same -- CMake's UNIX branches with the runner skipped where there is no generated
code, hostnet's BSD half, the launcher's posix_spawn glue, the crash handler and a SIGPROF sampler feeding the same
`[pc-sampler]` line, the replay tool's portability, the tarball with an ldd-driven lib/, the harness's xdotool and
ImageMagick halves. The VM linked the 224 MB runner in about fifteen minutes and the game booted under a bare X session
on Mesa's GL 4.1, the probe passing; its exported boot frame differs from the Windows export by 0.008 grey levels
(bar 3). The first Linux run of the C++ suite paid for itself at once: glibc aborted on a double free in the mixer's
stream-end path (a refused header closed its file twice) that Windows' allocator had never reported -- fixed at the
root under a Windows-observable test, AddressSanitizer clean, Windows gate 3/3. Two VBlank timing tests assumed an
unloaded host and now pay for host lateness. CI is green end to end (Python 1205, C++ 554/554). The tarball (114 MB,
125 libraries: Ubuntu's FFmpeg closure, to slim later) unpacks and self-tests from a fresh directory. Open: the driven
title stage in the VM (the audio bar rides on it, R106: a bare boot sits silent on the controller prompt), the
launcher's real run from the tarball, the close-out. HUMAN_TASKS: the owner's real-Linux or Steam Deck run.

## 2026-09-18 (early) — Goal 8 in the launcher; the lobby misses diagnosed and latched; the owner's sound reports fixed under tests; Task 3 stopped by its own trace

**The launch block** (2b, 2e, 3, 2d): the same-key control round plays (key sharing is not what keeps a second machine
out); no 3-17 s freeze in a quiet or a four-core-loaded round with research/29 §4's fields on the sampler line; the lobby
rate **6/10** with one miss class -- the on-screen keyboard at login typing extra glyphs. Diagnosed from the ten drive
files and the `[socom2-input]` edges: the drive holds a press 90 ms of wall clock, the game sampled the pad file once per
rendered frame, and in every miss the login screen ran at 12-30 fps under GL back-pressure, so presses fell between polls
(dropped, never repeated; the cursor then desynchronised and every backspace typed `!`). Fixed with a 2 ms sampler and a
per-poll OR latch (6b7a2b3, gate 3/3); the slowness itself is a KNOWN §2 row with its lead: the menus upload 7-11k 1 KB
tiles a second at 80-133 ms/s, four to six times gameplay's. Task 3's page trace refuted the page-marking hypothesis
(zero decodes online on the HUD pages; offline the arrow runs decode -> download) and re-measured the "21k" at ~10k/s in
gameplay; stopped (R96), the menus' upload cost is Sprint 8's.

**Goal 8 (owner request):** the Controller panel lists pads and the test area follows the pick, one selector and one dead
zone for all three pad readers; `PS2X_FPS_OVERLAY` draws host fps / guest Hz / frame ms (title gate passes with it on,
the window capture shows it); Sharpest (4x), Match display, a master volume; a Microphone panel with a live level meter,
`PS2X_MIC_DEVICE` into a capture ring with a WAV dump, and the headset spike's row in KNOWN (the game polls Enumerate and
EnumHint against our "no device" answer; serving it is believed bounded, Sprint 8). Voice does not reach another player
yet; HUMAN_TASKS says so. Suite 538, Python 1172.

**The owner's sound reports** (a hands-on session at 01:52; three sentences, one screenshot): the review of the run log
found all three. "Sound stopped altogether" mid-mission: the IOP model never freed a VAG stream slot on snd_StopSound, so
after six plays every play failed -- 237 `no free VAG stream slot` lines. The online menus' splice and buzz: the 989snd
PCM ring had no fill/play interlock; a late fill was skipped (the splice), a missed one looped (the buzz); ruling R97 makes
a block play once per fill and counts underruns on the audio trace line. Also fixed: the CD read-position rule that
5a1b6a8 had described but not implemented; and 971 unknown-bank rejects after a successful load now dump the bank table
once. All four under RED tests (b3e3797), the IOP model reachable from a test for the first time. The reason the fill is
late is the login screen at 12-30 fps (above). The driven dumps that re-measure it and the owner's re-listen are next.

## 2026-09-17 (late night) — Sprint 7 block two: the stranger's machine, the console's scheduler, the instruments

Branch `sprint-7`, eight commits (a843385..e5e447d). What a stranger's machine gets: a GL capability probe that falls back
to the CPU rasterizer with exit code 65 and one line naming what was missing (Task 1a, `s7_gl_gate` 3/3 with the probe
in); a native-VU1 mismatch warning keyed on the program hash, so the supported disc never warns (1d); the render-thread
command queue capped at 64 MB while the back-pressure latch is tripped -- a 30 s title-bar drag mid-mission added 38 MB to
the working set with the cap never engaged, pending bytes under 10 MB (1b, `s7_drag`, ruling R93); FLAG_WINDOW_HIGHDPI, a
1280x896 launcher default and render targets sized from use (1c, ruling R92; `s7_scale_both`: the 2x frame is the 1x frame
scaled, mean |diff| 0.83 vs bar 3); stream chunks pre-decoded on a worker thread so the audio callback never touches the
disc (1e; `s7_audio_title`: the title loop correlates at 1.000 with the disc PCM, constant offset). What the console's
semantics get: equal-priority guest threads are never time-sliced any more (2a, gate 3/3 with it in; the control round and
ladder are in the launch block); a plain sceCdRead no longer moves the CD stream cursor (2c: the RED test showed sector 44
delivered where 11 was due). Instruments: research/29's freeze fields on the pc-sampler line and a net-wait scope (2e), the
lobby rate machine-checked with a ten-launch queue (2d), audio correlation over a time span and on killed dumps, the scale
capture on exported frames. Suite 520 (the one known repo-root VU0 mapping failure), Python green, gate 3/3 (`s7_gl_gate2`).
Running now: the launch block (2b same-key round, 2e quiet and loaded rounds, Task 3's page trace, 2d's ten rounds).
Owner-gated and unchanged: the hosted server's two addresses, the second machine (`docs/HUMAN_TASKS.md`).

## 2026-09-17 (audit) — full audit and code review; the fix wave; the sprint rewritten; Sprints 7–9 drafted

`docs/audits/2026-09-17-audit-and-code-review.md`. Four reviews against the goal sentence. The verdict: the game plays and measures well, but a
stranger could not play for plumbing reasons -- the launcher never passed the verified ISO to the runtime (the portable
folder ships no ISO, so Launch booted a game that could not read the disc), a hostname server address was discarded, the
Horizon configs advertised this machine's LAN IP with no override, and the launcher's default server was loopback. All
four fixed under tests the same day, plus one `SOCOM_SERVER_IP` knob for the harness and, at the owner's request, a
server picker in the launcher (Community / Unzipped / Custom; the two addresses are placeholders until the owner supplies
them). Still open for a stranger: a hosted machine and the two addresses (owner), the first two-machine match (owner),
the GL capability probe and the unbounded command queue on a latched stall (Sprint 7), the equal-priority time slice the
console never has (Sprint 7, before shipping online), the 21k decodes' page-marking cause (Sprint 7). The Sprint 6 ledger
is in the audit's §3; the plan's checkboxes and KNOWN's stale rows are the close-out's work. Opus subagents did the fix
wave's mechanical half (owner rule 2026-09-17).

## 2026-09-17 (late) — Task 8b Step 5 done; Task 7's mixed match: the tooling is in, the first leg did not meet

`scripts/make_portable.sh` builds the portable folder (285 MB, a 63 MB zip; README says "run the launcher"). Task 7:
`tools_py/parity/pcsx2_ctl.py` (the S4 PCSX2 controller, promoted, with `join`/`host`/`ready` macros playing research/18
§1's click path), `online_match_ours --foreign-b` (ours hosts, waits for a joiner it does not drive, readies, walks),
`motion_diff` (is our player seen moving on the console client), `scripts/parity/mixed_match.sh` (leg 1), six tests.
Leg 1 (`mixed_ours_hosts`): ours logged in, hosted and waited 420 s; the PCSX2 macro lost its place at boot -- its
first capture after the recipe's 90 s and four CROSS presses was a MISSION BRIEFING, the boot having been faster than
the recipe's timing, so the presses walked into NEW GAME and the joiner never came (`RESULT ... joiner=none`). The
PCSX2 side needs screen-verified steps like ours: map its 640x480 frame onto the harness's 640x448 detectors and
press on what the screen shows. Next: that, then the leg again, then the reverse leg.

## 2026-09-17 (night) — Sprint 6 Task 8: the harness items, Foxhunt settled, knob retirement pass 1

`docs/HUMAN_TASKS.md` opened for the owner's hands-on checks (the title/intro listen, free play, the launcher with the pad).
Task 8: `gate.py --baseline <stamp>` re-scores a saved stamp (3/3 on `s6_audio_gate20`); `drive.py` fails loudly on a
resized window at capture; `scripts/archive_logs.ps1` (dry-run by default, KNOWN §1's paths protected as patterns; nothing
14 days old yet in 20 GB of logs); the README's five-command contributor section; `PS2X_GUEST_MALLOC_ZERO` and the unset
`_B` variants retired (build.sh test 499/499, gate 3/3 `s6_task8_gate`). The control round's fall guard (a 30 u height
drop: pad neutral, legs turn back, the damage scored apart) settled Foxhunt: `ours_control_foxhunt_guard` ran to its clock
with no health change -- twenty of twenty maps play their control round. `movie_blocks` runs in `build.sh test` against a saved fixture (seven presents of a
title-stage display dump and their furniture baseline; the dump found no missing movie block). Task 8 is complete.

## 2026-09-17 (evening) — title music plays the disc's PCM sample for sample (research/32 §7.1)

The owner's "title audio is really scratchy", then "still nowhere near accurate; the opening video seems okay; mission
audio good". Nineteen instrumented title runs. The sceMpeg HLE fed the game's audio callback out of order, late, and
consumed a packet the callback had refused (the one-byte shift that turned the music to noise); the first fix for that,
stopping the demux at a refusal as the library does, starved the game instead (it drops what a call did not consume and
polls the demux with nothing 340,000 times a second; the audio thread wakes once per served picture and fell to 22 wakes
a second, and the mixer lapped the ring). Final shape: the demux always consumes its input, refused audio is set aside
and re-offered in order, the lookahead is back to eight pictures, overdue pictures are dropped, an idle demux call yields
to any ready thread. Measured on `s6_audio_title19`: 30 audio wakes a second, the ring filled at 192 KB/s, pictures
every 2 fields, and the mixed WAV correlates with the disc's PCM at 0.99 across the intro movie and the title loop with
the offset advancing exactly 1:1. Suite 500 pass, gate 3/3. Owner's listen (Task 6c Step 4) still owed; residual: the
first ten seconds after a stream starts fill short while the pipeline settles.

## 2026-09-17 (afternoon) — ladder s6_ladder12 on the current exe: 4 of 4 rounds usable, kills in 3

`scripts/parity/ladder_frostfire.sh logs/parity/s6_ladder12` (harness `770d5fb`, exe `5255e13c…`, the wall-time clock and the
audio in): rounds 1, 2 and 4 KILL on KillWatch (health → 0.0 on B's actor), round 3 aborted by the harness's own teleport guard
during the aim step (an actor row jumped 48.7 u; a single-round glitch, not repeated). The RUNG0 bar failed on back-pressure
waits (A 351 ≥ 100): the GL thread's 21k texture uploads a second (KNOWN §2) are what it counts, and the bar was calibrated on
a build without them. Gameplay-wise the online result holds: three kills in four rounds on one lobby.

## 2026-09-17 (afternoon) — the launcher, first cut (Task 8b): disc check, video, controller, online, Launch

`dist/socom_unzipped_launcher.exe` (raylib, built by `build.sh runtime`; sources `ps2xLauncher/`): the four panels of the plan,
`config.json` beside it, Launch spawning `socom2.exe socom2_game.elf` with the environment and a log. Test-first for the logic
(ps2x_tests 492/492): SHA-256 against the FIPS vectors, the ISO 9660 root lookup on a synthetic image and the real disc
(SCUS_972.75 = the pinned r0001 digest `0172dc0b…`), config.json round-trips and tolerance, the environment mapping, and the
runtime's new `PS2X_WINDOW_SIZE` parser. Live: `--launch-test 15` started the game through the launcher's own path with the
window knob and mouse look reaching it. Not done from the plan: the diagnostics zip (a folder copy instead), the owner's
hands-on test with the Xbox pad (Step 4), the portable folder (Step 5). Gate `s6_launcher_gate` below.

## 2026-09-17 (midday) — the title music plays: the 989snd PCM stream ring (research/32 §7)

The EE decodes the title music itself and DMAs 16-bit PCM into an IOP ring the IRX plays; the module now forwards every
DMA that lands in the ring to the host mixer and answers `snd_PcmStreamPosition` as the IRX does — the DMA's absolute
address, which the EE masks to 24 bits and subtracts its ring address from. A bare offset gave four refills in 163 s; the
absolute address gives 48 rolling refills and the music through the whole title stage (RMS 5000–6000, `s6_audio_title`).
The ring's layout was measured off the DMAs (sample-interleaved, not 512-byte blocks). ps2x_tests 486/486. Hazard kept:
the ring still sits at the fixed EE address 0x900000 inside the game's memory (KNOWN §4).

## 2026-09-17 (morning) — the mission's voice-overs and music play: VPK and VAGp streams through the mixer (research/32 §6)

`snd_PlayVAGStreamByLoc` now opens the file at `sector * 2048 + offset` in the disc image and plays it as it reads: the
music is VPK (the magic is the little-endian word "VPK ", bytes " KPV"; 0x800-byte interleaved stereo chunks at 32 kHz),
the voice-overs are plain VAGp (22050 Hz mono). Three things the first cut got wrong, each caught by a run and fixed
test-first: the magic bytes, the 32-bit `fseek` that failed on every offset past 2 GB, and the SPU's half-scale voice
volume (the mix clipped at 32768; it peaks at 18572 now). `snd_SoundIsStillPlaying` is answered by the mixer. Gate
`s6_audio_gate5` 3/3 with the dump: all eleven mission streams play. The title music is a **PCM stream** the EE decodes
and DMAs into IOP memory — the next audio step (research/32 §6). The day's one-in-six C++ crash was the routing test's
own buffer overflow; the runner gained `PS2X_TEST_SUITE` / `PS2X_TEST_SKIP` filters and unbuffered stdout.

## 2026-09-17 (night) — first sound: 989snd bank sounds play through a host mixer (Task 6c Steps 2–3, research/32 §5)

The IOP module hands each bank's block and VAG chunks to the host and reports the play family with its own handle;
`snd989::Mixer` runs the grain scripts, the SPU pitch/pan/envelope arithmetic of research/32 §3 and mixes to one 48 kHz
raylib stream. Test-first throughout (ps2x_tests 480/480; the HUDUI bank cut from the disc as fixtures). Title stage with
`PS2X_AUDIO_DUMP`: the menu clicks are in the mix (five windows with signal, peak 13544). Music and voice-overs are VAG
streams, not yet played — the next audio step. Gate `s6_audio_gate` 3/3 (spawn 23.4, water flat 0.185); `build.sh test` green on
its second run — the first died once after the audio tests. **Found the next morning:** the backend routing test rendered 4096
frames into a buffer sized for 2048 (a heap overflow that crashed whatever ran next, one run in six; deterministic with the
suite alone). Fixed; the runner gained `PS2X_TEST_SUITE` / `PS2X_TEST_SKIP` filters and unbuffered stdout for the next hunt.

## 2026-09-17 (later) — the game ran at two thirds speed; the guest clock now follows wall time (research/34 §6)

Misc hardening, item one. The Task 6b sweep's guest-clock column (0.42–0.90 s per wall second on every map) was the
same clock that froze under the CLUT regression, only slower: the scheduler subtracted VU1 time and the render
back-pressure wait from the EE timers (`e163402`, made when the VU1 interpreter ran at 3 fps), and a `[clock]`
accounting line added for the question measured ~195 + ~290 ms of every second gone. SOCOM II integrates all its
timers from T0's dt, so the scheduler now counts wall time by default, capped at 100 ms per gap (`PS2X_CLOCK_EXCLUDE=1`
restores the exclusion; README). Test-first in ps2x_tests (470/470). Gate `s6_clock_gate` title/mission PASS with the
same spawn score (22.6) and larger hold diffs; online `ours_control_frostfire_clockoff` CONTROL-ROUND with both sides
at 1.00 s/s. The transition stage's black-frame floor (5, calibrated on the slow clock's 14 s black screen) is 3 for
the 4 s one (test-first). Task 6c Step 1 research is written: research/32 (the SBlk v3 bank layout read off the disc,
the play-call arguments, the 989snd volume/pitch/envelope arithmetic).

## 2026-09-17 — Task 6b: control rounds on all twenty untested online maps — 18 of 20 play (research/33)

`scripts/parity/online_control_queue.sh`, 00:14 → 04:45, exe `7b3816046a5bae9c` (research/34 fix), one launch per map plus a
retry pass. **Sujo, Enowapi, Shadow Falls, Fish Hook, Crossroads, Sandstorm, Chain Reaction, Guidance, Blizzard, Abandoned,
Desert Glory, Night Stalker, Rat's Nest, Bitter Jungle, Blood Lake, Death Trap, The Ruins and (on retry) The Mixer**: map
verified by reference, both sides READY, both controllable on the precondition, the round ran to its clock with no kill.
- **Foxhunt**: the round ran to its clock, but B took fall damage strafing off a drop (health 1.0 → 0.74 at T+224 s), so the
  negative-control health bar failed — a harness matter (KNOWN §2).
- **Requiem**: B's four holds net 13–38 u against the 40 u bar on both passes; B moves, on a guest clock at 0.38 s per wall
  second (the sweep's slowest). The slow guest clock (research/34 §6), not the map (KNOWN §2).
- Lobby flakes on the first pass (The Mixer: OSK typing; Foxhunt: OSK ENTER) were caught by the retry pass.
- Sweep-wide: the guest clock runs at 0.42–0.90 s per wall second, the joiner often slower than the host.
- Next per the owner's order: misc hardening, then Task 6c audio, Task 8b launcher.

## 2026-09-16 (night) — Task 6b's first maps froze at STARTING ROUND; it was the day's CLUT serials starving the guest clock, fixed

Owner order: the untested online maps, control rounds. The Mixer and Crossroads reached gameplay frozen (banner up, clock running,
nobody moves); Frostfire froze the same way on the same build, so a regression, not a map. Research/34.

- **Bisect by launch** (`scripts/parity/online_control_round.sh frostfire`, one runtime tree per exe): HEAD and `545b85a` freeze,
  `6d05b18` plays (`ours_control_frostfire_bisect3`, CONTROL-ROUND). `6d05b18~1` is not drivable any more (the plugged-in pad).
- **Mechanism**: `[gs-gl stats]` on HEAD — texture cache 414 → 16,353 → 55,483 entries within seconds of the round, uploads 64k/s,
  render 2 fps, back-pressure 25 s/s; `[clock]` 2.5 s of guest time per 42 s. The guest clock (`DAT_004365c0`, fed by timer T0,
  host-paced minus the back-pressure wait) drives every gameplay timer; the HUD round clock is the network's. `3d37abc`'s CLUT
  snapshot serial in the texture key minted a new key for every palette alternation.
- **Fix**: snapshot ids keyed by palette content (FNV-1a over cbp/cpsm/bytes; `m_clutIds`), GL snapshot eviction by recency.
  Test-first: 'a CLUT re-loaded with the same bytes re-uses its snapshot id' (ids A,B,A → 1,2,1; 10,000 alternations → 2 ids).
  ps2x_tests 468/468. Online: `ours_control_frostfire_clutfix` CONTROL-ROUND exit 0, cache 292, 43–45 fps, guest clock 0.74 s/s.
- **Left open** (KNOWN §2): the guest clock at 0.5–0.85 of wall time even when playing (VU1 time excluded by design); 21k texture
  uploads/s in the round. KNOWN §4: a render stall reads as a frozen game with a running clock — check `[gs-gl stats]`/`[clock]` first.
- Next: the twenty-map control-round queue (`scripts/parity/online_control_queue.sh`), research/33's table.

## 2026-09-16 (later) — the water shards run to ground: a GL blend the game uses to brighten every frame, and the exposure readback that asks for it

Owner: "proceed autonomously using your best judgement", water/ground first. Ten mission gates and one offline oracle.

- **The console's own draw list, replayed through our GS.** A PCSX2 GS dump at the slot-8 spawn (`tools/pcsx2/snaps/..._(2).gs`)
  gave the console's uploads, palettes, TEX0 words, per-vertex data and the packet order; `ps2_gs_tests` 'console GS dump
  replays through the CPU rasteriser' feeds its initial VRAM and 5386 packets to `GS::processGIFPacket` and renders the frame
  through the CPU rasteriser and, with `PS2X_CONSOLE_REPLAY_GL=1`, the OpenGL backend on a hidden window; `_STOP=<n>`
  truncates the stream, so a 16 s binary search finds where the two backends part (research/31 §11-12).
- **Cleared on the way** (each by measurement, research/31 §8-11): the trace window (§6 was the intro cinematic, not gameplay);
  the water's texture bytes, palette and draw state (byte-for-byte the console's); the CLUT semantic (§9: the GS on-chip
  CLUT is now modelled, `GSClutLoad`, test-first -- right, but not the cause); the VU1 vertex path (interpreter: same shards);
  the water pass itself (skipping it leaves the slabs: they are the bed pass drawn under it).
- **Cause 1, GL:** the game's post-process draws the half-size frame back over itself with `ALPHA 0x5d00000069` = Cd x (1 +
  93/128): a 1.73x brighten of every pixel. The GL blend table mapped `Cd*C + Cd` to an identity (no destination factor
  above one in GL). Fixed: the fragment shader emits C and the blend is `GL_DST_COLOR, GL_ONE` (§12). Offline: GL water
  flat 0.616 -> 0.130 on the console's packets.
- **Cause 2, guest-side, two HLEs:** the brighten factor comes from the auto-exposure thread's 1x4 frame-pixel readback,
  which builds a libgraph store-image packet, inspects it (PSM at byte 0x23, TRXREG at 0x40/0x44), patches TRXPOS at 0x30
  and DMAs it through the VIF1 reverse FIFO. `sceGsSetDefStoreImage` wrote a private 12-byte struct there (the guest read
  zero sizes and never issued the transfer) and `socom2_LumReadPixel` answered a constant grey pixel (the exposure saw a
  mid-grey scene: FIX 0). Fixed test-first: both image HLEs write libgraph's packet layouts (`writeGsLoadImagePacket`,
  `writeGsStoreImagePacket`, parsed by `readGsImage`) and the readback reads the pixels from GS memory
  (`socom2_lum_readback.h`, asynchronous: one `requestVramReadback` per 100 ms and `PeekVram` for the pixels -- a
  blocking GPU sync per readback, even one per 100 ms, held the single EE host thread and starved the pad, `s6_lum5/6`);
  `s6_lum7`/`s6_lum8`: mission PASS with **the gate's water bar passing for the first time** (`flat 0.20 dark 0.08` against
  the console's 0.19 / 0.08; every earlier run 0.50 / 0.26) and **every gameplay frame lit like the console**
  (trees, terrain, the HUD band -- the HUD reference `ref_hud_ours.png` was re-captured from the new look, and the
  untilref threshold of the three gameplay scripts went 30 -> 40: a lit HUD frame of another run reads 32.6 against the
  new reference, cinematic frames 55+; the dark-look dbuff fixtures keep their day's reference beside them).
- **The slabs are FIXED (evening):** they were VU1 terrain chunks lost because the VIF1 MSCAL/MSCNT path ran programs under a
  65536-cycle budget and let the next MSCNT continue a cut-off program from inside the clipper (research/31 §17). With the
  VIF entry points finishing a pending program first (`executeProgram`/`continueProgram`, test-first), the spawn view draws the
  console's 96 terrain triangles per frame (was 70), the stream bed is continuous, whole-frame score 24.8 (was 27.2), water
  flat 0.248 dark 0.068 (`s6_vifwait1`). HUD reference re-captured from the fixed frame. Left open from the same chase: the
  VU0 macro-mode flag latency (the recompiler lands flags immediately; the game's needs-clipping test relies on the 4-cycle
  delay) -- a small residual, fix in the CTC2/CFC2 translation.
- Also today: the transition stage scored by content (5 fps waits), the pristine memory card, the probe's rest-window
  lowest-sustained-plateau rule (a gradual root-node decay had read 10.4, then an eight-row stall on the way down 10.7), `console_spawn_line` refusing non-HUD frames, the command trace's
  texture / screen-box filters, per-vertex line, `alpha= pabe= fba= fge= fog= texa= tex1= tod=` fields, `PS2X_GS_SKIP_TBP0`,
  `PS2X_GS_DUMP_TEX_*` sampling, and the GL shadow seeded from the initial VRAM at Initialize.

## 2026-09-16 — the owner plays; a gamepad, no sound, a grey hill; three gates lost to a saved controller configuration; the transition scored by content

Owner: "do something fun for me" → a fresh instance on keyboard, then "do you see my controller?" → gamepad support in the
SOCOM host-input path (raylib gamepad 0, XInput/DirectInput, OR-ed with the keyboard; sticks past a 15 % dead zone override the
keyboard axes; `PS2X_HOST_GAMEPAD=0` disables every host gamepad read and every harness script sets it). "I'm getting no
sound": the 989snd HLE never reaches a host audio backend — Task 6c (VAG decoder + voice mixer) is planned, not started. The
owner's screenshots: a flat grey patch of hillside that comes and goes (research/31 form 2) beside the water shards (form 1);
their order for the rest: water/ground, untested online maps, hardening, audio, launcher (`docs/CURRENT_SPRINT.md`).

- **Three full gates lost (`s6_gamepad`..`s6_gamepad3`) to shared state, not to the pad.** The free-play session saved the
  controller configuration onto `game/disc/mc0` (the card every gate booted from); from then on the boot skipped the
  PRECISION SHOOTER CONFIGURATION screens and the "save to memory card?" dialog, and the transition stage — whose burst
  fired on the NO press of that dialog — reported "no transition burst fired". `PS2X_HOST_GAMEPAD=0` made no difference.
  `gate.py` now boots each stage from a fresh copy of the 2026-09-08 card `game/disc/mc0_parity`; free play uses
  `game/disc/mc0_owner` (KNOWN §4).
- **The dialog did not come back on the pristine card (`s6_fade`), and a step-pinned fallback burst could not catch the fade**:
  it happens during the rank press's own settle wait, at a step index that drifts with the boot (s05 there, s07 nominal).
  The stage is now **scored by content** when no burst fired (`gate.score_fade`): every capture in mtime order, the first
  frame whose header band matches `scripts/parity/ref_briefing_ours.png` (0.0 on every briefing frame, 25+ on every other
  screen), the briefing's own ≤ 2 s fade-in skipped, the contiguous black run behind it counted; the transition stage
  captures its waits at 5 fps (`drive.py --wait-period 0.2`). `s6_fade` and `s6_gamepad3` re-score PASS at exactly the
  5-frame floor on their 1 Hz captures; **`s6_gamepad5` gate 3/3** with 14 frames, and the guest probe reading the root
  node at the console's 5.5039 (rest window: the first plateau after the bind pose departs), MoveScale 1, 0 teleports.
- **Also in that batch:** the gameplay probe holds the muzzle up before its first burst (a blind burst had killed a
  teammate → MISSION FAILURE); the harness restores the 640x448 client area before every press.
- **Water, no progress on the cause, two instruments retired:** the CPU-VRAM twin `PS2X_GS_TEX_FROM_CPU=1` renders noise on
  every screen from the boot on and drops to a frame every few seconds (`s6_water_texcpu2`; research/31 §7) — it cannot
  tell VRAM bytes from cache. And `s6_gamepad5`'s spawn capture, a letterboxed cinematic frame with no HUD, scored
  `water flat=0.071` — the only sub-0.5 figure ever printed and a false one; `console_spawn_line` now reports NO-DATA on
  a frame whose gameplay band is under 0.75. Every HUD spawn frame still reads flat 0.503–0.509 → FAIL. Next: the PCSX2
  slot-8 GS dump against our `[gs-pages]` uploads for the 0x38a8/0x3852 texture/CLUT pair (research/31 §5, §7).

## 2026-09-15 (local, night) — first online launches on the block-pointer exe: the kill repeats (4 of 4 rounds), the aim correction fires live, and every blind press in the lobby is made to verify itself

Owner: "proceed autonomously until asked to stop or the goal is reached". Ten two-instance ladder launches on the
block-pointer exe (`1cfef9af…`), the Horizon stack restarted by this session (`server/start-servers.ps1`),
`PS2X_SOCOM2_SERVER=192.168.2.10` confirmed as this host.

- **The result:** `s6_ladder8` (harness `d6e417f`, quiet host) — **KILL on all four rounds** on KillWatch (health
  `+0x1044` → 0.0 on B's intact actor at T+75.2/206.6/324.4/440.5 s), route arrived every round, **round 2 used the
  burst-to-burst lead correction** (`lead=+1.5 steps=1 hits=3`). `verdict_replay --per-round`: rounds 1–2 KILL, round 3
  `NO-KILL unattributed` (the fatal burst from 68.2 units against the pre-registered ≤ 60 bar — the bar stands),
  round 4 `NO-DATA` (the run stopped at the kill; an 8 s tail now keeps the rows, `967bc03`). Against Sprint 5's single
  launch (3 of 4, round 4 never corrected). The plan's 2-of-2 launch bar is not met yet: `s6_ladder9` never started
  its match (below).
- **What it took — ten launches, seven of them lost to one dropped press each** (research/28 §6, KNOWN §4 "every
  blind press"): a starved runtime on the first double launch of the new exe; the OSK's first character (`ocom`); a
  DOWN before CONNECT; an ENTER-walk step; the main menu's ONLINE CROSS; the map walk pressing through a mid-scroll
  frame; a READY search that pressed UP into the started match (B spawned **zoomed 3.0x** — research/30: zoom is D-pad
  UP/DOWN edges in PlayerUpd, view mode at `actor+0x200`); a dropped SWITCH TEAMS leaving both players on SEALs. The
  drop rate is ~1 in 20 at 59 fps on posted keys and the pad file alike. Fixes, each test-first with real-capture
  fixtures (`78a81d1` … `d6e417f`, 1044 Python tests): the OSK typed length read back and retyped; the keyboard mode
  re-read after toggling; CONNECT focus, ENTER, ONLINE, the persona presses and every CREATE GAME / JOIN stage verified
  before and after; the map walk scores all six visible rows and re-reads instead of pressing through; the READY
  search stops when the lobby is gone; `Shell.press` writes the pad file; the next-round wait is 120 s (a clock-ended
  round restarted ~130 rows after 00:00 and the 45 s wait had given up); `lobby_report.py` tabulates a launch's
  outcome, class, re-sends and unverified presses.
- **Runtime observations, none settled:** the mover's per-row movement in `s6_ladder5` read a third of Sprint 5's,
  but a decomp-reading agent was loading the host during that round (confound; `s6_ladder8` on a quiet host arrived
  every round); back-pressure waits (357/384 per rung 0) match Sprint 5's round 1 (443/3).
- **Open:** SWITCH TEAMS verification and the READY label's count suffix (agent in flight); then the second launch for
  the 2-of-2 bar; Task 2's ten-launch lobby rate on the finished harness; Task 3's sampler fields; Task 5a the water.

## 2026-09-15 (local, evening) — the owner's two-hour window: the turn teleport fixed at the block pointer, the depth fix merged, and a gate that can see

The owner gave a two-hour host window ("proceed for the next 2 hours … full authority") and lock-free agents filled the
rest. Everything below is on `develop`.

- **Mission gate, three runs on the depth-fix exe.** `s6_depth_m4` FAIL: the HUD matched at s28, then the "X TO ABORT"
  objective cinematic started and swallowed four holds (bands 0.33) — a second dismissable class beside the HELP pop-up.
  The `ifpopup` step now presses CROSS while `drive.needs_cross()` says the frame is a pop-up or a letterboxed non-black
  cinematic (test-first, 11 tests). `s6_depth_m5`: liveness bar met (5/6 gameplay, 2 live pairs, the step pressed twice at
  two holds) and the stage FAILed only on the **new mission-failure detector**: `s43_holdS.png` was the MISSION FAILURE
  statistics screen after the 3 s right-stick turn — the turn teleport, caught by the gate for the first time. Ruling
  R79 committed the depth fix, the step and the gate wiring on that evidence.
- **Block-pointer fix (`fix/gs-block-pointer` → develop `a81eb74`).** Seven-region round-trip test pasted from the plan:
  RED with every DBP/SBP off by 8 and pieces reading back another piece's bytes (a first GREEN attempt failed on the
  test's own buffers sitting at the guest heap base 0x100000, where the stub mallocs its 256 KiB packet — moved to
  0x1800000). Two-line fix in `GS.cpp` (`vram_addr & 0x3FFF`), 455/455. Pipeline (detached, one restart after a
  tool-timeout kill produced spawn errors 0xC0000142 across the Python suite — environment, not tests): Python 904 OK,
  vram-diff 15/15, **gate PASS 3/3 `s6_blockptr`**, exe sha `1cfef9af028a90fc…`. The mission stage's s43 after the
  same turn was gameplay (bands 0.98) and no failure banner was found. `motion_pack_check` on the 255 s RAM dump:
  `chunk_map=[0..7] corrupt_chunks=0 of 8` (pre-fix images 5 of 8; console identity).
- **Gate wiring (Task 1, `34ed2ac`).** `score_mission_log` fails on a MISSION FAILURE banner in any hold capture or
  `final.png` (`s5_head_1x_b` and `s3d_2x_host` now fail as they should have), prints the console spawn comparison
  (`score=44.7 water flat=0.505 dark=0.302 -> FAIL` on `s6_blockptr`) and the guest-value probe. The probe read
  `NO-DATA (0 rows)` because the runtime prints `[peek]` rows only from the PC sampler thread: `PS2X_PC_SAMPLER=1` is
  now set for the mission stage (test-first); the run that proves it is `s6_probe`.
- **Lock-free agents (five):** gate wiring (above); `freeze_trace.py` (12 tests) reproducing 8c's stalls to the row and
  finding a second shape; research/28 lobby taxonomy over 30 launches (gameplay 14/30; classes counted; five failures
  classified only from captures); lobby verify-then-act (`78a81d1`, 31 tests, 13 named classes, `[lobby]` line per
  press; re-send harmlessness unverified without a launch); research/29 naming both freeze shapes (shape 1 =
  `sceGsSyncV` → `waitVSync` under an alive-but-slow GL thread, unbounded by the back-pressure cap; shape 2 = stale
  sampler rows while `socom2_libnetb::waitReadable` blocks the EE executor for up to 10 s, not excluded from the guest
  clock — a fix candidate). The aim-loop simulation agent (Task 4 Steps 1–2) was still running at the time of writing.
- **Process:** one stopped background job (`TaskStop` on a build pipeline) made every child spawn fail with
  0xC0000142 for the rest of that process's life; long pipelines go through `scripts/run_detached.sh`, never a tool
  call with a timeout.

## 2026-09-15 (local) — audit after the pause; the depth fix verified; the HELP pop-up gate flake fixed in the harness; Sprint 6 drafted; lock-bound work queued for an owner window

Owner returned after the 2026-09-14 pause and asked for an audit, then "proceed as suggested autonomously", then paused
lock-bound work ("lag spikes running this while working") and asked for lock-free tasks to be partitioned out.

- **Depth-precision fix (`fix/gl-depth-precision`, uncommitted):** `./build.sh test` under the lock — Python **845** OK
  (63 skipped), ps2x_tests **454/454**, vram-diff `checked=15 skipped=0`. Title PASS `s6_depth` (19/23), transition PASS
  `s6_depth_r2` were already on disk from 2026-09-14. Mission `s6_depth_m2`: **FAIL on the HELP pop-up class** — 6/6
  hold captures gameplay (bands 0.98), 0 live pairs (diffs 0.01–0.05), `s30_holdW.png` and `final.png` show "You must
  MEET WITH MALLARD … PRESS X TO CONTINUE"; no `STALE FRAME`. Same class as `s5_head_1x` (KNOWN §4).
- **The fix for that class, as KNOWN §4 prescribed:** `drive.py` gains `popup_present(im)` (delegates to
  `sp_death_probe.screen_state`'s prompt test) and an `ifpopup+<delay>:BTN` step that presses only while the prompt is on
  screen (≤ 6 times) and never on a clean frame; `gameplay_probe.txt` carries one before each of its six holds. Written
  test-first: `tools_py/tests/test_drive_popup.py` failed 3 + errored 2 on the old code (an unknown mode pressed blindly
  once), 5/5 after. The mission rerun `s6_depth_m3` reached its last step but its frame file went stale for 176 s while
  the owner was working on the host, and was killed at the owner's request — **one mission gate is owed before either
  commit** (rule: gate green before a commit touching `third_party/` or `scripts/parity/`).
- **Sprint 6 drafted, not opened:** spec and plan under `docs/superpowers/` (owner review pending); order changed from
  ROADMAP §6 to put the gate's correctness leg (mission-failure detection, console-vs-ours spawn score, guest-value
  probe — the owner-agreed 2026-09-14 items) right after the paused fixes, because a fix nobody can measure is not a fix.
  A packaging/launcher/installer outline was written on request
  (`docs/superpowers/specs/2026-09-15-game-client-package-and-installer-outline.md`).
- **Block-pointer fix:** not started in code (TDD: the seven-region test must be watched failing, which needs a build);
  the test is pasted in full into the plan's Task 0b.
- **Process:** `docs/archive/HANDOFF-AUDIT-2026-09-14.md` (the previous session's audit) is now tracked. New standing rule in
  `CURRENT_SPRINT.md`: builds, gates and launches only in a host window the owner names.

## 2026-09-13 (local) — Sprint 5 landed: THE ACCEPTANCE TEST PASSED — Frostfire control fixed, the single-player stall fixed, and a first online kill on three independent rounds

Sprint `2026-09-13-sprint-5-control-readout-and-first-kill`, branch `sprint-5`, Tasks 0-7 plus the
owner-requested broad review (Amendment A, mid-sprint). Every task implemented, independently
reviewed, fixed and re-reviewed; the plan's own `## Outcome` and `## Rulings made on the owner's
behalf` sections carry the full detail this entry summarises. Headline facts, and every retraction,
are in `docs/KNOWN.md`.

### The sentence that matters

**The acceptance test PASSED.** `bash scripts/parity/ladder_frostfire.sh --pinned
logs/parity/s5_t5_ladder2` (HEAD `171290b`, exe sha `234b4772cd0a8bf8`, runtime frozen at `92d30f0`)
scored `KILL killer=A victim=B t=141.33` on round 1 — both KillWatch (actor fields: `+0x1044`
1.0 → 0.298 → 0.0 in 0.25 s, `+0xF7A` 1 → 2, word 0 intact at `006691a0`) and `verdict_replay`
(valves: `total_mp_kills` 0→1 on the killer's own instance, `aiteam_08` 1→0 on both instances within
0.25 s, the killer's R1 burst 0.59 s before the death from 27.9-29.2 units in 3-D, `dy` 0) —
independently re-derived clause by clause by a second reviewer before the sprint declared it met.
Rounds 2 and 3 repeated the kill in the same lobby (t=244.10, t=336.51); round 4 reached rung 2
only (111 in-tolerance bursts, no damage — an aim bias that never corrected, not a broken damage
path). Both screens read "socomc fragged socome with M4A1 / ALL TERRORISTS ELIMINATED / SEALS
VICTORIOUS!", tiled into `docs/research/assets/22-first-kill.png` (`5f1de26`).

### What landed, per task

- **Task 0 (preconditions, `2b7c425`+3 fix rounds).** A heartbeat loop lock (`scripts/loop_lock.sh`)
  that reaps only a stale, idle holder and refuses the stale break while anything is busy;
  `scripts/run_detached.sh` and `kill_stale_drivers.ps1`; `build.sh test` now runs the Python suite
  first (`tools_py/tests`, unittest only); `docs/CURRENT_SPRINT.md` created as the loop's sprint
  pointer.
- **Task 1 (Frostfire control handover, `03d3aa6`/`b625291`/`0118c95`+`b89c4c0`, 8 + 2 over-cap
  launches).** The lead this sprint opened with — an uninitialised "ghost flag" `ng+0xd2` — was
  real but **retracted**: the chain is reachable and verified in the decomp, but it never fired
  (launch 1). The actual stop was `research/23`'s ground probe: at the Frostfire spawn,
  `ProbeEval` returns a miss with candidate count 0 because the ground models are linked into the
  collision grid by their **untranslated** bounds — cell (0,0)/(0,2) instead of the spawn's
  (4,3)/(3,7) — so the local player's `actor+0x420` (last ground-hit time) is never stamped and the
  online snap-back suppresses movement from clock 0.6 s. Root cause: `FUN_003085c0`'s
  `vmaddw.xyz vf9, vf7, vf0w` translation scale reads VU0 `vf0.w`, and `R5900Context()` zeroed
  `vf0` — correct for the main thread's constructed context, wrong everywhere else, because on real
  hardware `vf0` is the constant `(0,0,0,1)`. Every `StartThread`/`GuestThread`/`GuestInvocation`
  context (the level loader runs on one) inherited the zero. **Fixed** by setting `vf0 = (0,0,0,1)`
  in the constructor, authorised without a pre-fix trace because it is correct behaviour regardless
  of cause (R27) — confirmed by a post-fix census (all 48 translated Frostfire props now linked by
  world bounds, 0 of 48 before) and by launch 3, where both sides moved the whole 302 s round
  (MoveScale `f12 = 1.0` throughout, probe hits 1332/1332 and 1428/1428). The knob built as a first
  candidate fix, `PS2X_GUEST_MALLOC_ZERO` (default off), turned out not to be the cause and ships
  unused. The Medley control (launch 8c) supplied the unconditional clock round-end negative
  fixture Task 6 needed, and surfaced 8-17 s guest freezes under host load (parked to Sprint 6).
- **Task 2 (kill readout confirmation, `d0f4ccb`/`e685b82`/`6b0f258`, 4 single-player runs, 3
  usable).** Health `actor+0x1044` and alive `actor+0xF7A` (sourced statically last sprint) were
  armed as harness defaults; a single-player death was **not observed** in 3 usable runs (health
  dropped to 0.392 then the actor left the mission area — MISSION FAILURE, not a death) and this
  half closed "not observed" per the plan's own fallback (R28) — the first online death became the
  sole confirmation. The actor's own heading field was found along the way: quaternion
  `actor+0x70` → a 4×4 matrix at `+0x80..+0xbc`, walk direction `(-m[+0xa0], -m[+0xa8])`, p90 1.57°
  over 17 live holds at rest. The camera cannot supply a heading at all — `atan2(actor-camera)` has
  p90 error 23.85-55° depending on the sample gate — and Task 5 aimed from the actor matrix instead
  (R12).
- **Task 3 (a harness that cannot spend a match proving nothing, `736193c`+3 fix rounds+`24db942`+
  `42b1dd8`, lock-free).** Pure scorers (`verdict_core.py`) for control, contact, starvation and
  round-state, tested against real fixtures before any launch used them. A Sprint 4 reading was
  **retracted** along the way: `kill3`'s "lost mover" (0.00 units across two holds) was the camera
  record `0x416054` freezing while the actor itself walked ~65 and ~39 units on the two holds — the
  camera is not a liveness signal, only the actor's own position words are.
- **Task 4 (HLE and heap liveness audit, `ad32088`/`0cdb9a1`/`03d3aa6`/`3899b1e`/`07ffc0a`,
  zero-run + rides Task 1's build).** `object_diff.py` reproduces the uninitialised-heap signature
  by object rather than address, and corrected three ranges in last sprint's F3 list. A static
  census of all 223 bound HLE stubs (148 zero-call) found `sceGsSetDefDBuff` reading its trailing
  args from the stack where the guest passes them in `$t0-$t2` — **fixed** (the stub now reads `$t0-$t2`), with the clear packet
  now seeded in context 1 and byte-exact against `title_pcsx2`. `PS2X_HLE_STATS=1` ships. The
  remaining ranked stubs (display-environment/zbp divergence, `rem_pio2f` precision) defer to
  Sprint 6 (one-line-fix rule, R20).
- **Tasks 5+6 (merged into one ladder by Amendment A, below).**
- **Task 7 (this close-out).**

### Root causes found

1. **Frostfire's lost control was VU0 `vf0.w = 0` on non-main-thread guest contexts**, not the
   "ghost flag" the sprint opened chasing. See Task 1 above.
2. **The single-player gameplay stall was an unbounded GS command backlog.** `GSGlBackend::record`/
   `Present` appended to `m_pending` with no bound; after the mission loaded, the GL replay thread
   fell to ~14 frames/s against 60/s recorded, so private bytes ran 275 MB → 13 GB in 4 minutes and
   the host presented one frame per 5-25 s. **Fixed** with bounded back-pressure
   (`PS2X_GS_MAX_PENDING_FRAMES`, default 3): the EE waits at `VBlankStart` while more than N frames
   are unreplayed, a consumer-progress heartbeat prevents the wait latching open on a large
   in-flight batch (R40), and the next VBlank deadline is clamped to drop accumulated debt instead
   of letting the guest run up to 4x real time to catch up (R41) — three fix rounds
   (`8281254`/`7448601`/`92d30f0`), the last of which also closed a idle-spin residual (R54).
3. **The mission-gate scorer had been scoring the intro cinematic since 2026-09-12.** `drive.py`'s
   HUD check matched a letterboxed cinematic frame after cropping the bars; **fixed** to require
   lit letterbox bands on the uncropped frame plus ≥ 2 consecutive gameplay hold pairs differing by
   mean ≥ 3.0 (`69e2a9d`/`d2eb932`), which is also what caught defect 2 above — the frozen-hold runs
   the old scorer had been calling PASS.

### Retractions this sprint

- **The uninitialised "ghost flag" `ng+0xd2`** as Frostfire's cause: the chain is real and verified
  in the decomp, but it never fires online (launch 1).
- **The exhausted-collision-grid theory** for the ground-probe miss: the grid is healthy (503 nodes
  + 7689 free = 8192, free head never 0 over ~2000 rows); the real cause is the untranslated-bounds
  linking above.
- **`kill3`'s "lost its second mover"**: the camera record froze, not the actor.
- **The "0.6 s host-clock coincidence"** note on Frostfire's move-path stop: the snap-back genuinely
  fires at guest clock 0.6 s; the "host wall clock" reading was the same threshold seen at coarser
  sampling resolution.

### The broad review and Amendment A

Mid-sprint, on request, an independent broad review (`.superpowers/sdd/…/broad-review.md`) judged
the plan's original Tasks 5-6 "not on track as planned" (~55-65% odds of a kill) against ~85-95%
with changes, on five re-derived facts: spawns are deterministic per map (Frostfire 691 units apart
on two discrete floors, dy 42); mutual standing does **not** starve either side online (~48 s at
full movement scale, contradicting a standing plan assumption); the actor-matrix yaw settles within
one 4 Hz row of a turn release; a clock round end keeps the actor block and resets both players to
spawn, so one lobby success can carry several rounds. **Amendment A** (`8672724`, rulings R42-R52)
merged Tasks 5 and 6 into one 16-launch ladder in which every round is its own acceptance attempt,
pre-registered the acceptance bars in spec §5.1/§5.1.1 before any match was scored, simplified the
default engagement to a host shooter following a recorded route to a standing victim, added launch
hygiene (a pinned harness snapshot per launch, a host CPU sampler, a `logs/.quiet` window, disk
refusal below 4 GB), and pulled a minimal lobby dropped-press re-send forward from Sprint 6. The
acceptance run came from this rewritten path, not the plan's original one.

### The acceptance run and its numbers

Ladder launch 2, one launch, no lobby failure. Per-round: round 1 contact 14.3 s / 58 rows, 1 burst,
victim health 1.0 → 0.298 → 0.0, closest 3-D 23.9 (dy 0); round 2 contact 6.1 s / 25 rows, 1 burst,
closest 20.6; round 3 contact 5.8 s / 24 rows, 2 bursts, closest 19.3; round 4 rung 2 only, 111
bursts at -4.1° aim error (inside the 5.68° tolerance, never corrected), 0/30 ammo twice over.
Frostfire's v2 route (derived from collision geometry, `docs/research/24`) arrived on all 4 rounds
in 77-89 s (9.5-11.3 u/s). `mp_round_count` steps ~33 s after a kill (not the ~5 s spec §5.1.1 had
estimated — corrected, no verdict depended on it); `total_mp_kills` steps on the killer's instance
only and resets to 0 next round.

### Launch counts against caps

| task | cap | used |
|---|---|---|
| Task 1 (Frostfire control) | 3 usable / 8 launches | **8 + 2 over-cap** (R33, the Medley control) |
| Task 2 (SP kill readout) | one run | **4 single-player runs** |
| Tasks 5+6 (merged ladder, Amendment A) | 16 launches | **3 of 16** (launch 1, 1b, 2) |

### Parked to Sprint 6

Per the broad review's revised order (`docs/ROADMAP.md` §6): lobby hardening to completion; the
online freeze root cause (3-17 s guest stops under host load, Task 1's launch 8c); single-player
teleports; the skeleton root decay (re-measured on the post-`vf0` exe first); a gameplay-state probe
as the gate's first correctness leg; the soft-double `exp` chain and `rem_pio2f` against exact
oracles; a mixed ours/PCSX2 match; HLE audit leg three; harness/gate process cleanup; the parity PNG
export off the GL thread; the display-environment/zbp A/B; VU memory aliasing; disk hygiene
automation. Also parked, and named as Sprint 7's headline item rather than Sprint 6's: **the close-
range aim loop has no ammo awareness or re-aim escalation** — round 4 fired 111 bursts at an
in-tolerance miss with no correction, which is exactly the repeatability gap `docs/KNOWN.md` §4
already flags (3 of 4 rounds killed; round 4 missed on an aim tolerance that never corrected).

## 2026-09-13 (local) — Sprint 4 landed: the online movement blocker fixed, the acceptance test built and NOT passed, Frostfire loses control at round start, and the first kill is Sprint 5's

Sprint `2026-09-12-sprint-4-visible-defects-and-first-kill`, branch `sprint-4`, Tasks 1-9 plus
2b, 4b and 4c added mid-sprint; each implemented, independently reviewed, fixed and re-reviewed.
Where reality diverged from the plan is in the plan's own `## Outcome` section; the findings that
outlive the sprint are in the 2026-09-13 "carried findings" entry immediately below; the headline
facts, and every retraction, are in `docs/KNOWN.md`. This entry is the outcome, stated without
flattery.

### The two sentences that matter

1. **The two-week online movement blocker is fixed.** Our HLE answered
   `sceInetInterfaceControl(0x200)` with a **constant**, so the guest's "ms since network activity"
   never reset and the multiplayer movement scale clamped to 0.0 on frame one; pitch survived only
   because it is not one of the three scaled axes (`abf35bb`). Proven by a **same-binary A/B in one
   match** (`5ed29ca`, `PS2X_SOCOM2_NET_STATS_B=0` turning the fix off for instance B only): fix ON,
   movement scale 1.0 on **330/330** calls and **89** distinct player positions; fix OFF, 0.0 on
   **339/339** and **0.46 units** of travel in the whole match. Proven **on Medley only**.
2. **The acceptance test did not reach a kill.** On the corrected measurement — the actor's own
   x/y/z, not the camera+facing reconstruction, which mis-placed players by up to ~50 units — the
   closest true 3-D separation the two players ever reached was **50.0 units**; over the last 400
   rows the median was **67.9** at **43.3°** of elevation, and **0 %** of rows were inside any
   contact gate (45 units in 3-D, 25, or within 10 of each other's height). The rifles fired (96 R1
   injections, ammo 30/30 → 0/30, impacts on the wall ahead of the muzzle) and hit nothing, because
   the players were never in range. **Whether damage was dealt is unknown**: the offsets watched at
   the time (`actor+0x204/+0x208`) were not health.

Not "frozen at round start". That description was retracted this sprint and must not come back:
**the round runs and the local player cannot move** — and on the two maps tried it has had two
different causes, one fixed and one open.

### What landed, in order

**Wave 1 — visible defects and a gate that cannot go quiet.**
- **Intro-movie black macroblocks: fixed at the root** (Task 1, `4a701f1`). Not the byte-accumulator
  case the plan predicted — the count it mandated measured that at zero — but a **cross-thread race
  on `m_currentTransfer`**: the game thread overwrote the transfer the GL mirror was about to mark,
  so the mirror refreshed someone else's rectangle and the real 16×16 block was never pushed. One
  deleted line. Transfer/refresh deficit **3,748 → 0**; `movie_blocks.py` `MISSING` **9 → 0**. The
  new check (`tools_py/parity/movie_blocks.py`, `docs/research/16` §9) went through four review
  rounds because each version could pass harder as the bug got worse; its remaining limits are in
  §9.1.1, and it is wired into nothing.
- **The gate's silent-failure paths closed.** `drive.py` crops the non-black rect before scoring
  (Task 2, `193ed92`, `a6f3cc4`): a deliberately pillarboxed run's title score went **0/23 → 18/23**
  instead of degrading quietly. The transition probe's burst now **follows the save dialog** instead
  of sitting at step 11 (Task 2b, `99c1865`, new `ifburst` script step): a late dialog used to leave
  the burst firing before the transition — too few frames examined, peak 0.
- **`--vram-diff` 15/15** (Task 3, `fc9f185`, `6c017c2`). Blend-amplified rounding and interior
  seams are classified by-design, `vu1dump4_prog_182` rejoins the fixture set at 0.000 %, and the
  seam clause is **budgeted** after review showed the unbudgeted widening made the oracle blind to a
  uniform one-pixel offset (+1 px x now fails 8/15, +1 px y 6/15; `seam=N` printed every run).
- **`rand()` is 31-bit over the guest's own seed** (Task 4b, `ede2096`, `60a19f2`). The stub had
  returned 15 host bits over a `_rand_next` frozen at 41, pinning every `rand`-derived float in the
  game (249 sites) within 1/65536 of its minimum. `docs/research/17` §6.1, including why a fixed
  clock would pin the seed and not the stream.
- **The soft-double ABI stubs re-bound** (Task 4c, `db7a992`): `sin`/`cos`/`tan`/`fabs`/`floor`
  take `$a0` and return `$v0`. A **latent** defect — identity at 19 of 22 sites, the 3 garbage
  sites unreachable — with three live divergences (`FUN_00308020`'s gimbal guard, `FUN_00294070`'s
  projection matrix, `FUN_003C7280`'s `tan`). `docs/research/17` §5.1.
- **"Ground height" reframed as the camera** (Task 4, `docs/research/17`). There is no ground-height
  defect: the player's feet match the console to **0.008**, and the 14.7/20.1 figures were
  camera-eye minus collision-hit. The third-person camera sits ~5.4 low because the player actor's
  skeleton root node decays 11.4845 → 0 while its saved copy holds the console's 5.50391.
  **Localised, not fixed**: two candidates (a lerp dropping its `a·w` term, or a second writer)
  that `research/17` §4.3's single run separates.

**Wave 2 — the online round.**
- **S0 (Task 5, `docs/research/18` §1): runtime implicated.** Two PCSX2 instances against **our own**
  Horizon stack play a full round and advance to round 2. The "PCSX2 golden is frozen too" belief
  that had pointed two weeks of work at the server was two stills of a match with no input sent.
- **S1 (Task 6): fixed**, per sentence 1 above, after five hypotheses were falsified by measurement
  — two of them real divergences whose fixes reached the wire and moved nothing (the advertised peer
  port and a shared RSA keypair, `acb603e`; both fixes kept).
- **S2 (Task 7, `research/18` §3.13): honest partial.** Movement and look calibrated; `--walk-to-b`
  steers and does not arrive — one mover cannot close Medley inside a round (38.6 % closure
  efficiency, ~450 s needed against a ~360 s round). It measured the aim floor: the harness sends
  only full stick deflection, so the shortest usable hold sweeps 35-40° against a body subtending
  15-20° at contact range (the pad file itself accepts 0-255 — a harness limit, not the runtime's).
- **S3 (Task 8, `research/18` §4): honest partial.** Both players walk (`--converge`, then
  `--until-kill`): **1485.5 → 50.0 units in ~127 s**, the first time two online players have been
  in the same place, and no kill (sentence 2). Review found the loop's own distance wrong by tens of
  units, rebuilt contact as 3-D plus height, and **reserved `RESULT PASS` for a kill**: a round
  ending on its clock prints `ROUND-END (unattributed -- NOT a kill)` and exits non-zero, and an
  armed health watch that read nothing fails the run. With no confirmed health offset,
  `--until-kill` **cannot currently print PASS** — the honest state of the instrument.

### Frostfire — the default test map, and neither player moved

The owner set the default test map to **Frostfire** on 2026-09-13 (`--map frostfire`, verified
against a reference crop of the highlighted row before CROSS is pressed; the harness previously
blind-pressed whatever was highlighted, which was Medley). Frostfire's spawns are **692 units
apart** against Medley's **1485**, with a 42-unit height difference. One run, `ours_task8_frost1`:
gameplay reached on both instances, pad reaching the guest, movement scale 1.0, round clock running
— and **neither player moved** (A's record spanned 2.5 units, B's 0.0, over 240 s). The move path
`FUN_00553dc0` ran **18 calls in 0.6 s** at round start and never again across 2634 sampler rows,
where Medley runs it ~18.9/s. That reads as **control never being handed over**, not as a slow map.
(A first reading of the same log said "about one a second": `PS2X_CALL_TRACE` logs the first 300
calls unconditionally, so dividing a short trace's line count by `EVERY` overstated it ~20×.)

**The movement fix above is proven on Medley and is not in question here; Frostfire is a second,
different cause.** One run cannot separate a map-specific defect from a match that never handed over
control, and nothing about the cause is proven yet.

### research/19 — community and engine resources

A research wave over community memory tools, reCOM and other recompilation/HLE projects
(`docs/research/19-community-and-engine-resources.md`, `7e81197`). Every address pinned to
SCUS_972.75 r0001:
- **Health is `actor+0x1044`** (float, 1.0 full, `<= 0` dead) and **`actor+0xF7A` is the alive
  byte** (1 = alive) — two independent community tools, one explicitly r0001, confirmed against our
  decomp's `<= 0.0` / `< 0.2` / `< 0.5` compares. **This retracts `+0x204/+0x208`.** Read in every
  image, ours and the console's; **not yet read live in an online match.**
- **The multiplayer round state is the `CZNetGame` object at `*0x437ce8`**: `total_mp_kills`,
  `mp_round_count`, `mp_game_over`, rounds won and alive per team, and the major/minor/"my"
  round-state bytes at `+0x113..+0x115` — a kill and round-end readout that needs no screenshot.
- **Bytes the game never initialises in that object read `0xAF` on ours and `0x00` on the
  console** — among them `+0xd2`, the flag behind "You are a ghost. You will play the next round as
  a real player", tested by five online routines. The object is allocated per map from our
  replacement heap, so the garbage can differ by map. **This is Sprint 5's first lead for
  Frostfire.** The divergence is measured; the causation is inference.
- Our valve pool sits **0x20 lower** than the console's, so community absolute addresses are right
  for PCSX2 and wrong for us — resolve through the pointer.

It also widens the carried HLE hazard below: a wrong value need not come from a stub at all —
memory the game never initialised, filled differently by our heap, is the same class.

### Not done, and why

- **No kill**, on either map (above). Sprint 5 is built on it.
- **The camera height is not fixed** — localised to one run's distance, deliberately not guessed.
- **The plan's final gate with run-vs-run title scores against `s3_head_1x` was not run** at
  close-out, which was barred from builds and game runs. The current binary's last full gate is PASS
  3/3 (`20260912_192900`); no runtime source changed after it.
- **`build.sh test` still runs no Python tests**, and `movie_blocks.py` is in no automation — both
  are Sprint 5 Task 0.

### New knobs and flags (documented in README "Build and run")

`PS2X_SOCOM2_NET_STATS` (default on; `0` restores the constant and reproduces the defect),
`PS2X_SOCOM2_NET_TRACE_ALL`, `PS2X_SOCOM2_RSA_KEY=b`, `PS2X_RUN_LOG`, and the driver-side
`PS2X_SOCOM2_NET_STATS_B` / `PS2X_SOCOM2_RSA_KEY_B` (instance B only); `online_match_ours.py`
`--converge`, `--until-kill`, `--engage`/`--engage-dy`, `--fight-seconds`, `--kill-timeout`,
`--map`/`--map-scan`, `--health-offset`/`--health-range`, `--no-route`; `drive.py`'s `ifburst`
script step; `python -m tools_py.parity.movie_blocks`.

## 2026-09-13 (local) — Sprint 4 carried findings: the HLE constant-value hazard, and the online-harness rules that cost a run each to learn

Sprint 4's per-task reports live in `.superpowers/sdd/2026-09-12-sprint-4-visible-defects-and-first-kill/`,
which is **gitignored and deleted at close-out**. This entry is the durable copy of the things in
them that outlive the sprint. It is not the "what landed" entry — that is separate. Headline facts
are in `docs/KNOWN.md`; the retractions are marked in place at `HANDOFF.md` item 0 / item 2, the
2026-09-10 20:10 and 2026-09-09 01:30 entries below, and the Sprint 4 spec §1.

### The cross-cutting finding: our HLE returns a constant where the guest expects a live value

**This is the most valuable thing in the sprint and it is a standing hazard, not an anecdote.**
Three defects found independently in three different subsystems turned out to be the same shape —
an HLE boundary handing the guest a value that does not move when the thing it represents moves:

| the HLE | what it returned | what the guest did with it |
|---|---|---|
| `rand()` (`0x00197740`) | `std::rand() & 0x7FFF` — 15 bits, from the **host** CRT, over a guest `_rand_next` frozen at **41** | every `rand`-derived float pinned to within 1/65536 of its minimum, at **249** sites (`grep -c 4.656613e-10` over the decomp). `+0x5c` could not exceed 4.0000458 where the console reads 6.3338 |
| `sceInetInterfaceControl(0x200)` | a constant | `msSinceNetActivity` never reset → the movement scale clamped to **0.0 on frame one**. This is the two-week "the online match is frozen" blocker; pitch survived only because it is not one of the three scaled axes |
| five soft-double routines (litodp/dpmul/dpdiv/exp/dptofp) | a **stale register** — the ABI binding returned `$v0` as it stood | identity at 19 of 22 sites and therefore invisible; genuinely wrong at three live ones, including a gimbal-lock guard that became a control-flow divergence (research/17 §5.1) |

Two properties make this worth a rule rather than three bug entries:

- **Each was invisible to the parity gate.** A frozen seed, a frozen clock and a stale register all
  render perfectly. The gate proves *no worse than the reference*; it has never proved *correct*.
- **Each presented as a game bug**, in a subsystem that had nothing to do with the real cause: a
  capsule radius, a peer-transport handshake, a movement throttle curve. Three sessions, a week of
  server work and a protocol decode were spent inside those wrong subsystems.

**The rule.** Presume remaining gameplay wrongness is this shape until shown otherwise. When a guest
value looks wrong, ask *what feeds it across an HLE boundary, and does that thing change?* before
reading any guest code. The cheap test is the one that caught all three: dump the suspect word from
several of our RDRAM images and from the PCSX2 console image — **a value identical across all of
ours and different on the console's is the signature**, and it costs no run at all. An HLE that
returns a constant is a defect even when nothing visibly breaks today, because the thing that
eventually reads it will be in a different subsystem from the stub.

### Harness rules from Tasks 6-8 — each of these cost at least one run

The online harness is expensive (budget ~two runs per result; the lobby flow reaches gameplay about
four times in ten) and it is very good at producing complete, convincing evidence of nothing.

- **Verify `peek @416054` is non-zero before believing any screenshot or any movement claim.** One
  run drove sixteen stick probes and wrote sixteen screenshots against a **lobby keyboard**; three
  of six runs in that task were unusable. Note the weaker form of the same rule: the liveness check
  counts *non-zero* position rows, not *distinct* ones, so it passes while the player is in-game and
  not yet controllable — `ours_task8_kill3` had 161 in-game rows, movement scale 1.0, and moved
  **0.00** units across a forward hold, a turn and a second forward hold.
- **An instrument that emits zero rows is a FAILED run, not a quiet one.** Task 6's idle-ms trace
  logged nothing for a whole session because it pointed at `0x30be80` while the guest calls the
  thunk at `0x30cd80` — inside the very task that had just written the warning about checks
  attesting to nothing. Zero rows means the instrument is wrong until proven otherwise.
- **A `MediusPlayerReport` in the Medius log is NOT a round end.** It is a periodic client stats
  report. In `ours_task8_kill1` exactly one arrived, at T+156.7 s, with the two players **603 units
  apart**, both still walking and no respawn in either position record — and the harness printed
  `RESULT PASS signal=server` for it. Any round-end signal must require something only a real round
  end produces; `KillWatch` now records the report and never fires on it.
- **A finished `drive.py` taskkills the NEXT run's game.** Its cleanup runs
  `taskkill /F /IM socom2.exe`, so an earlier driver reaching its own end takes down whatever is
  running now: `run_t8probe2` died 66 s in, its log froze at 127 sampler rows, and `drive.py` went
  on screenshotting a dead game for four more minutes. Kill the previous *driver*, not just the
  game, before starting anything.
- **One script per run.** The corollary of the above: overlapping drivers do not merely skew timing,
  they silently void each other's evidence, and the voided run still writes a full set of
  screenshots.

`docs/KNOWN.md` §4 carries these alongside the rest of the standing hazards.

## 2026-09-12 (local) — Sprint 3 landed: `PS2X_GS_SCALE` integer render-target scale (default 1), the fourth VU1 command family and `0x34` (162/166 native), family-C + fourth-family `--vram-diff` coverage, the intro-movie macroblocks localised

Sprint `2026-09-11-sprint-3-render-scale-and-fourth-family`, branch `sprint-3`, Tasks 1-11, each
implemented, independently reviewed, fixed and re-reviewed. Task 5's own S3-d verification entry is
immediately below this one and carries the 2x measurements in full; this entry is the sprint around
it and does not repeat them. What exists now:

- **`PS2X_PRESENT_FILTER=linear|integer|point`** (Task 1, `ps2_runtime.cpp` present block). **Verdict:
  at the 640x448 window the desktop build opens the fit scale is exactly 1.0, so all three modes are
  the same 1:1 blit and none of the perceived softness is presentation.** The default stays `linear`
  and is byte for byte the pre-knob behaviour on both the host and CPU present paths. The knob only
  bites on a stretched window, where it measures real (at 1818x1132: `linear` softest, `point`
  crispest but uneven, `integer` between them) — `python -m tools_py.parity.resize_window <w> <h>`
  was committed for driving that comparison. Gate stamps `pf2_linear` / `pf2_integer` / `pf2_point`,
  all PASS; sheet `logs/pf_runs/s05_sheet.png` (three identical pictures, as the arithmetic predicts).
- **Render-target scale, in four independently shipped stages (Tasks 2-5).**
  *S3-a:* `RenderTarget`'s single size field split into `nativeWidth/nativeHeight` and
  `hostWidth/hostHeight`, with all **37 read sites / 50 field references** classified site by site in
  `docs/research/14-gs-render-target-scale-spike.md` §8 and **seven** native/host hand-offs recorded
  in §8.1 for the later stages. The audit caught research/14 §3 classifying `getDepthTarget`'s size
  as native: following that would have given an incomplete FBO and a black screen at S > 1.
  *S3-b:* a per-target native mirror plus a GPU resolve behind `nativeView()` / `nativeViewFbo()`,
  with `PS2X_GS_SCALE_FILTER=point|box` (`point` = a `GL_NEAREST` blit, `box` = an SxS average);
  inert at 1x by an early return, so it allocates and copies nothing there.
  *S3-c:* **`PS2X_GS_SCALE`, default 1, clamped 1..4**, every `* S` site listed in research/14 §10.2.
  *S3-d:* verification (the entry below).
  **At 1x nothing observable changed at any stage:** a full gate PASS 3/3 after every one of them,
  and every title capture 99.8-100.0 run-vs-run against the pre-scale S3-a baseline
  `logs/parity/gate/s3a` — against a bar of >= 99, and with no capture anywhere in the sprint's 1x
  gates below 99.7 (the attract-movie captures s20-s22 are exempt: they are playback-phase dependent
  and span 85.5-100.0 between any two runs, modified or not). The one number
  that argued otherwise — a transition `rows 396-447 peak 7` — was settled by a ten-run interleaved
  A/B of the parent and scaled binaries: the artefact is run-to-run variance present on the
  **pre-scale** binary too (see the flake list below), and the three peak-7 `w13_001.png` captures
  are byte-identical PNGs across a Task 3 binary and the S3-c binary.
  **At 2x:** `s3d_2x_host` GATE PASS 3/3; the GIF path green on all three legs but **across two
  stamps** — `s3d_2x_gif` (title + mission) and `s3d_2x_gif_t2` (transition, re-run after a
  documented save-dialog probe flake) — so it has *not* passed 3/3 in a single run. The resolve path
  itself was checked directly with `PS2X_GS_SCALE_SELFTEST=1` on full gameplay runs, because no gate
  capture at any scale goes through it: **0 stale mirror reads** under each filter (11,704 reads
  served from an already-clean mirror across the two runs) and 0 of 229,376 x 24 content samples
  outside their host block, `point` `logs/run_20260912_074912.log` and `box`
  `logs/run_20260912_075604.log`.
  **The headline, stated precisely: 2x gives sharper 3D rasterisation and does NOT sharpen the HUD,
  menus or title.** Those are textured quads drawn from native-resolution textures (`uTexSize` stays
  native by design), so scaling the render target cannot add detail to them. Measured on a matched
  mission frame: 3D-region gradient **5.88 -> 3.98** with anti-aliasing fraction **0.133 -> 0.423**,
  against a flat HUD whose glyph raster is identical at 4x zoom. Do not write "2x is sharper"
  unqualified.
  **`S=3` and `S=4` are deliberately untested.** The clamp admits them, but at S=4 a colour target is
  67 MB and `getDepthTarget`'s zero-fill is a 67 MB one-off per ZBP. Documented as a known limit, not
  as tested behaviour.
  Sheets and stamps: `logs/parity/gate/s3c_1x_final/mission_sheet.png` (1x, the default-knob gate),
  `logs/parity/gate/s3d_2x_host/mission_sheet.png` and `logs/parity/gate/s3d_2x_gif/mission_sheet.png`
  (2x), transition from `logs/parity/gate/s3d_2x_gif_t2/`.
- **The VU1 dispatcher went 123/166 -> 162/166 native (Tasks 6-8).** `docs/research/15-vu1-fourth-family.md`
  decodes the fourth command family (`0x70`, `0x52`, `0x66`, `0x40`) and `0x34` to implementation
  level; then native handlers for `0x70` and `0x40` (dump3 `ended` 9 -> 47) and for `0x34`'s
  sphere-map ST and rim alpha (-> 48), each bit-exact against exact-interpreter goldens with
  `--regs all`. Per dump set, entered/ended/handbacks: **dump2 31/31/0, dump3 52/48/4, dump4 83/83/0**.
  **The residual is 4 programs**, all the `52 66 08 40 42` shape: `0x52` emits no GIF packets, ends
  the program (E bit `0x33b8`, end pc `0x33c8`) and its correctness spans two `MSCAL`s, and `0x66` is
  never dispatched from `0x1b50` anywhere in the corpus, so a handler for it could not be verified and
  shipping an unverifiable handler inside the dispatcher was judged the larger risk. That residual is
  a deliberate, documented ruling, not an unfinished task. Gate `fam4` PASS 3/3 after the fourth-family
  handlers; `0x34` needed no gate (no shared path changes behaviour, proven by the unchanged counts).
- **`--vram-diff` went from `checked=10 skipped=2` to `checked=14 skipped=0` (Task 9)**, covering
  family C **and** the fourth family. Diagnosis: the family-C lists' own render-state packets point
  `TEX0` at a texture the dump does not carry, so every texel read back 0 and their `ALPHA_1 = 0x44`
  (`(Cs - Cd) * As + Cd`, `As = 0`) left the framebuffer untouched — the draws happened and wrote
  nothing distinguishable from "not drawn". `vu1_replay` now neutral-fills VRAM outside the frame and
  z buffers, gives the z buffer its own pages, `static_assert`s that the parked texel stays above the
  zeroed region, and warns when a kicked packet points `TEX0` inside it. **`./build.sh test` now fails
  on that warning** instead of letting it scroll past. All ten pre-existing `VRAMDIFF` lines are
  numerically identical before and after. One dump, `vu1dump4_prog_182` (1.488 %), is held out with
  pixel evidence: `hard` misclassifies blend-amplified gouraud rounding (delta 2, not 1) and one-pixel
  shifts of *interior* seams; widening those two buckets — then adding the dump — is a Sprint 4
  follow-up, deliberately not done here because it changes what the check scores.
- **The intro-movie black macroblocks are localised** (Task 10, `docs/research/16-intro-movie-macroblocks.md`),
  at 4-5 % of movie frames with 1-4 blocks each. **The MPEG decode is clean**: 2067 consecutive decoded
  pictures have exactly the black-macroblock census of an offline libavcodec decode of the same file
  (mean |count diff| 0.000), and the guest strip write has no skip path. The loss is in the shadow-VRAM
  -> GL-render-target mirror — `executeUpload` -> `refreshRenderTargetsFromShadow` -> `refreshDirtyRows`
  in `gs_gl_backend.cpp` — with three-layer `PS2X_GS_DUMP_DISPLAY` triples showing shadow 0/48 presents
  affected against the GL target's 3/48, and the exact pictures and block coordinates named in the note.
  **No fix**, correctly under the spike's decision rule: the candidate sits in the file the scale work
  was rewriting, and confirming it needs a transfer-vs-refresh count first.

**Known flakes and harness notes, new this sprint.**

- **Transition gate, intermittency 1 — measured.** Roughly **1 in 5** `--only transition` runs FAIL on
  a one-frame dim residual strip at rows 396-447 in an otherwise black sequence. It is **pre-existing
  and not a scale regression**: a five-pair interleaved A/B of the pre-scale parent binary and the
  scaled branch failed once on each side, the **parent's** instance being the worse of the two
  (parent peak 36, scaled branch peak 18), and counting every stamp on record the rates are
  indistinguishable (Fisher exact p ~ 0.6).
- **Transition gate, intermittency 1's cause — a hypothesis, with no isolation test behind it.** It is
  attributed to `refreshDirtyRows` / `executeClear` ordering because that is the class of artefact the
  ordering fix exists to suppress. Nothing has been run to isolate it; treat the attribution as
  unproven and the ~1-in-5 rate as the measured part.
- **Transition gate, intermittency 2 — the already-known save-dialog probe flake.** `transition_probe.txt`'s
  `ifref` guards match several steps late, the burst runs before the dialog is answered, and the leg
  FAILs for too few frames *examined* with every examined frame at peak 0. Distinguish the two by the
  band peak: **peak 0 with too few frames is (2); a non-zero band peak is (1)**.
- **Harness: 1x and 2x frames must be matched by content, never by step name.** At 2x the mission-load
  `untilref` press loop needs one extra press, which shifts every later step by ~21 s; every step up to
  that point lands within 0.3 s across scales. Comparing `sNN` to `sNN` across scales compares different
  moments and manufactures a spurious regression.
- **The title gate can be silently degraded by a window resize from outside the process** (seen twice in
  Task 1, once taking a 19/23 run to 16/23 — one step off a red gate with a green binary): `drive.py`'s
  `untilref`/`ifref` references are 640x448 frames and never match a pillarboxed window. Cropping to the
  non-black rectangle before the 160x112 resize would fix it.

**Where reality diverged from the plan.**

- Plan Task 7 was scoped as "the fourth-family handlers" generally; the controller ruled it down to
  **`0x70` and `0x40` only**, leaving `0x52` and `0x66` as the documented residual above (research/15
  §9.3). Plan Task 8's `0x34` then landed, so the residual is 4 programs rather than the 5 Task 7 left.
- **The spec's "sharper HUD" expectation was wrong.** Plan Task 5 Step 1 asked for "the HUD text and
  squad panel must be visibly sharper" at 2x. They are not, and cannot be: `uTexSize` stays native, so
  a screen-aligned textured quad is magnified from a native texture and minified straight back. Task 4
  predicted this before it was measured; Task 5 measured it. The gain is in rasterisation only.
- research/14's headline "15 touch points" (quoted in the Sprint 2 entry below) is superseded: the
  authoritative figure for the refactor is **37 read sites / 50 field references**, in research/14 §8.
- Task 10's PCSX2 comparison run was never made (the lock was taken and this task had lowest priority);
  the offline libavcodec decode is a stricter reference and is what the conclusion rests on.

## 2026-09-12 (local) — Sprint 3, Task 5 (S3-d): `PS2X_GS_SCALE=2` verified on both draw paths — sharper geometry, unchanged HUD, **default stays 1**

`PS2X_GS_SCALE=2` was run through the full gate twice on the S3-c binary (`466918b`, no source
change in this task) and through the resolve self-test twice, once per filter.

**Gates.** `s3d_2x_host` (`PS2X_GS_SCALE=2 PS2X_VU1_HOST_DRAW=1 PS2X_VU_STATS=1`) — **GATE PASS
3/3**: title 19/23, transition 17 frames examined at/after the burst step with rows 396-447 peak 0,
mission HUD reached with 6 hold steps. `s3d_2x_gif` (`PS2X_GS_SCALE=2`, host-draw off, i.e. scaled
rasterisation of GIF-path triangles) — title PASS, mission PASS, transition FAIL on the **documented
save-dialog probe flake** (4 frames examined, need 5; `ref_save_prompt_ours.png` matched at s12/s13
instead of s08/s09, and every examined frame peak 0 — the probe arrived late, nothing was drawn into
the band). Re-run of that leg alone, `s3d_2x_gif_t2`: **PASS** — 17 frames examined, rows 396-447
peak 0, the save-dialog `ifref` matching at the early position again. **So the GIF path is green
on all three legs across two stamps** (`s3d_2x_gif` title + mission, `s3d_2x_gif_t2` transition);
it did not pass 3/3 in one go, `s3d_2x_host` did. The two 2x runs agree with each other —
same step, same scene, `compare.score` 99.8 / mad 0.0043 — so the two draw paths rasterise the same
picture at 2x.

**Presentation is inert.** Each 2x title capture scored against its 1x twin in `s3c_1x_final/title`:
s00-s19 **99.6-99.9** (host-draw) and **99.8-99.9** (GIF). The title screen is a render-target-as-
texture display copy sampled at native resolution, so it neither gains nor loses at 2x; research/14
§10.5 also records that a 2x title run performs **no** guest-visible render-target read at all, so
the title leg is a presentation-and-inertness check and proves nothing about the mirror.

**The resolve path, checked directly** (`PS2X_GS_SCALE_SELFTEST=1`, full `gameplay_probe.txt` runs,
because no gate capture at any scale goes through the resolve — the parity captures are
`LoadImageFromScreen()` window screenshots):

| filter | run log | native-view reads | served from an already-clean mirror | STALE | lit content windows (after a resolve / served clean) | samples outside the host block range |
|---|---|---|---|---|---|---|
| `point` | `logs/run_20260912_074912.log` | 39,000+ | 6,352 | **0** | 24 (12 / 12) | **0** of 229,376 x 24 |
| `box` | `logs/run_20260912_075604.log` | 33,000+ | 5,352 | **0** | 24 (12 / 12) | **0** of 229,376 x 24 |

**Sharpness, measured and looked at.** The >= 99 title bar does not apply at 2x, so: mean gradient
energy (`grad`, the Sprint-3 review's metric) plus an anti-aliasing fraction (`aa` — of the pixels
on a real edge, the fraction that are partially covered rather than a hard step; supersampling
raises it). On the matched mission-start frame (1x `s3c_1x_final/mission/s28_none.png` vs 2x
`s3d_2x_host/mission/s29_none.png`), over the 3D region: grad **5.88 -> 3.98**, aa **0.133 ->
0.423**. Same direction on a genuinely identical cutscene frame (grad 7.69 -> 5.79, aa 0.267 ->
0.402), and at population level every 2x gameplay capture scores aa >= 0.419 while 13 of 14 1x
captures score <= 0.32. By eye at 4x zoom the difference is obvious: 1x foliage is stippled with
isolated pixels and hard alpha-test staircases, 2x foliage has continuous edges.

**But the HUD is not sharper, and that is the honest half of the result.** Over the squad panel and
the ammo panel — opaque-backed, fixed-position, directly comparable — grad moves 19.37 -> 20.04 and
10.04 -> 9.54 and aa moves +0.03, i.e. nothing; at 4x zoom the glyphs are the same raster with the
same stair-steps. `uTexSize` stays native by design, so a screen-aligned textured quad is magnified
from a native texture into the 2x target and minified straight back at present. **2x buys
rasterisation, and SOCOM II's HUD, menus, briefings and title are not rasterisation.** (Beware the
radar crop: it appears to improve a lot, but the improvement is the 3D foliage behind the
translucent ring, not the ring.)

**Verdict: `PS2X_GS_SCALE=2` works, is worth having for gameplay, and the default stays 1.** Sheets:
`logs/parity/gate/s3d_2x_host/mission_sheet.png` and `logs/parity/gate/s3d_2x_gif/mission_sheet.png`
against `logs/parity/gate/s3c_1x_final/mission_sheet.png` (structurally identical; sheet tiles are
~60 px and cannot show aliasing — the sharpness judgement is on full-size frames). `S=3` and `S=4`
remain deliberately untested. 1x is unchanged and is `s3c_1x_final`, GATE PASS 3/3, cited not re-run.

**Two gate intermittencies, recorded here for the first time**, both scale-independent and neither
in the flake list until now: (a) the **save-dialog probe flake** — `transition_probe.txt`'s `ifref`
guard matches several steps late, the burst runs before the dialog is answered, and the leg FAILs
for too few frames *examined* (seen at 1x in Task 4's `s3c_1x`, and here in `s3d_2x_gif`); (b) the
**residual-strip artefact** — a one-frame dim strip at rows 396-447 in an otherwise black sequence,
~1 transition gate in 5 on **both** the S3-b parent binary (peak 36) and the S3-c binary (peak 18),
attributed to `refreshDirtyRows` / `executeClear` ordering. (b) did not fire in any of this task's
transition legs. A FAIL with peak 0 is (a); a FAIL with a non-zero band peak is (b).

**Also measured, because it will confuse the next person:** scripted probes drift at 2x. Every step
through s27 lands within 0.3 s of the 1x run; the mission-load `untilref` then needs 4 presses at 2x
instead of 3, which shifts everything after it by ~21 s (s34 at 216.0-217.7 s vs 196.1 s at 1x —
inside the 196.1-218.3 s band 1x runs already show). The same scripted inputs therefore land later
in game time and both 2x mission runs ended in MISSION FAILURE where the 1x run's last capture was
already showing "Leaving designated mission area". Match 1x and 2x frames by content, never by `sNN`.

## 2026-09-12 (local) — Sprint 3, Task 1 (S3-0): `PS2X_PRESENT_FILTER` — the presentation stretch is not where the softness comes from at the shipped window size

`PS2X_PRESENT_FILTER=linear|integer|point` (read once, `ps2_runtime.cpp` present block) picks how
the presented PS2 frame reaches the window: `linear` is the default and byte for byte what the
code did before the knob (one aspect-fit `DrawTexturePro` per read circuit, sampler state left as
whoever created the texture set it — GL_LINEAR for the host render-target copy, GL_NEAREST for the
CPU fallback); `point` samples nearest straight to the window; `integer` point-samples the frame
into an off-screen stage at k = floor(fit scale) times its size and then fits that stage with
linear filtering. Both branches draw the read circuits identically — circuit 1 unblended (the GS
frame's alpha is game data) and the optional PMODE circuit 2 alpha-blended over it — only into a
different target; the `integer` branch's final stage-to-window draw is unblended for the same
reason circuit 1 is.

**Verdict.** At the window the desktop build opens, and for as long as the game presents a full
frame, the knob cannot change a pixel and none of the perceived softness is presentation. The
desktop window is created at `HOST_WINDOW_WIDTH x HOST_WINDOW_HEIGHT` = 640x448
(`ps2_runtime.cpp:45-56`), exactly the frame the title screens present, so the aspect-fit scale is
1.0, k = 1 and all three modes reduce to the same 1:1 identity blit. Two edges to that statement:
`PLATFORM_VITA` opens 960x544, where the scale is 1.21 and the knob does bite; and the fit is
computed from `presentWidth/presentHeight`, which come from the live host texture, so a game state
that presents a rect smaller than 640x448 is also being scaled. Both are outside what the title
gate exercises -- the claim is measured for the desktop build on the screens the gate reaches, not
proved for every frame the game can produce. The measurements agree: title gates `pf_linear`,
`pf_integer` and `pf_point` are all PASS 19/23 with per-capture scores equal to within run noise,
and the three-mode s05 sheet is three identical pictures. The softness on those screens is the
render resolution itself, which is what `PS2X_GS_SCALE` (Tasks 2-5) attacks — this experiment does not
buy any of it back. The knob only bites on a stretched window, and there it measures real: the
same screen captured in all three modes at a 1818x1132 window (fit scale 2.53, k = 2) shows
`linear` softest (every glyph edge a 2-3 pixel ramp), `point` crispest but visibly uneven (a
source pixel lands on 2 or 3 window pixels, so stroke widths wobble and letterforms stair-step),
and `integer` between them — 1-pixel edges with even stroke weight, `point`'s crispness (edge
gradient energy 1.058 vs `linear`'s 1.007, `point`'s 1.057) without its unevenness, 0.44/255 mean
absolute difference from `linear` over the whole frame. **The default stays `linear`**: it is
identical to `integer` at the size the game actually opens at, and the sprint's render-target
scale is the change that matters. `integer` is the one to reach for the moment the window is bigger than the frame -- which is
one drag away, since the window already carries `FLAG_WINDOW_RESIZABLE`.

Gate stamps: `pf_linear` / `pf_integer` / `pf_point`, each `--only title`, each GATE PASS;
`pf_linear`'s menu captures s00..s19 score 99.7-99.9 against `hostdraw_fix/title` (its three
attract-movie captures s20..s22 score 85.5-88.6, inside the 85.5-100.0 band that any two
unmodified runs of this gate show on those frames — the movie is at a different playback phase,
confirmed by eye). The stretched-window captures come from `pfwin_linear` / `pfwin_integer` /
`pfwin_point`, which FAIL the title gate for a harness reason, not a rendering one: `drive.py`'s
`untilref`/`ifref` references are 640x448 frames, and a pillarboxed 1818x1132 window never matches
them at 160x112, so the probe stalls on the controller-configuration "select memory card slot"
dialog and captures that screen 23 times. `python -m tools_py.parity.resize_window <w> <h>` is
that helper, kept for whoever revisits this. After the review fixes (the PMODE overlay texture now
takes the mode's filter too, a guard on a failed stage allocation, a warning on an unrecognised
value) the three title gates were re-run as `pf2_linear` / `pf2_integer` / `pf2_point`, all PASS
19/23, and `pf2_linear`'s menu captures still score 99.7-99.9 against `hostdraw_fix/title`. **Open, worth a look:** the window is resizable and one
run (`pf_point_stuck`) came up at 1818x1132 with nothing in the run asking for it, and so failed
the title gate the same way; the re-run at the default size passed. A gate that can be silently
defeated by a window resize is a gate weakness.

## 2026-09-11 03:45 (local) — Sprint 2 landed: host-space triangle draw behind a knob, family B and C native (123/166), gates hardened and deterministic on a fresh clone
Sprint `2026-09-11-sprint-2-host-render-and-family-b`, branch `sprint-2`, Tasks 1-11, all reviewed.
What exists now:

- **Host-space draw hook.** `GS::submitHostTriangle(const GSPrimReg&, const GSVertex&, const GSVertex&, const GSVertex&)` (gs_frontend.h/.cpp) fills draw state from the live GS context exactly as `buildDrawBatch` does (shared `fillDrawState`) and submits the caller's float vertices straight to the backend; `VU1Interpreter::activeGs()` exposes the GS the dispatcher is running against. Unit tests prove it draws the same pixels as three XYZ2 kicks and honours `prim.ctxt` (Task 1).
- **`PS2X_VU1_HOST_DRAW`.** The native `0x28` packet builder in `socom2_dispatch_0x1b50.cpp` submits each triangle through the hook instead of packing/kicking it when the knob is set (default off — GIF packets still built and kicked otherwise, so every existing golden keeps proving the GIF path); every data-memory write and register update the GIF path performs still happens, so `--regs all` stays identical with the knob on. `vu1_replay --host-draw` sets the env for offline verification; `vu1_replay --no-native` forces the interpreted path for comparison; `vu1_replay --vram-diff <outdir> [--vram-tol <pct>]` re-execs itself once per mode per dump (two processes, since the knob is a read-once static) and diffs the rendered VRAM region, with SKIP accounting for dumps that draw nothing (drawn=0). `./build.sh test` runs the vram-diff check on the dispatch_0x1b50 fixtures (Tasks 2, 7).
- **Render-target scale: NO-GO this sprint.** `docs/research/14-gs-render-target-scale-spike.md` enumerates 15 places the GL backend assumes GS pixels are 1:1 with GL texels (**corrected by Sprint 3 Task 2: the authoritative count is 37 read sites / 50 field references, research/14 §8 — the "15" was never reproducible from the document and is superseded**); both readback paths (RT-to-shadow-VRAM and the title-label texture-set page copies) need a content-altering downsample filter, so `PS2X_GS_SCALE` is deferred to Sprint 3 (RenderTarget size refactor first, a presentation-upscale filter as the cheap win in the meantime) (Task 3).
- **Family B and C native.** `docs/research/13-vu1-family-b-world-objects.md` documents the `0x3618` primitive subroutine and every family-B/C handler. The dispatcher now runs 123/166 lists native across dump2/3/4 (dump2 31/0, dump3 9/43, dump4 83/0 ended/handbacks), bit-exact against the exact-interpreter goldens (`--regs all`). Residual: one 0x34 list (EFU maths plus a same-lane write conflict) and 42 dump3 lists using commands this dispatcher does not implement at all (0x70/0x52/0x66/0x40 — a fourth command family, left for Sprint 3 research) (Tasks 4-6).
- **Per-handler clamps.** Every handler that reads a loop count from the header or the primitive-index list clamps against the measured header maxima (`tools_py/vu1_headers.py`: dump2 50/31, dump3 78/73, dump4 76/44, all well under the 256/256 ceilings) and hands back safely on violation; a synthetic test (`TOP+2.z` rewritten to 300) proves the hand-back matches an exact golden of the modified dump, run by `./build.sh test` (Task 7).
- **Gate hardening.** `drive.py` captures `w{i:02d}_{k:03d}.png` every second during settle waits (not just during scripted bursts); `black_rows.py` counts them alongside `s*.png`. `tests/fixtures/gate/{title,transition,mission}` are committed (title 16 frames, transition 5, mission good/bad `.drive.txt`), so `python -m unittest tools_py.tests.test_gate` (24 tests) runs its positive cases on a fresh clone with no prior run needed. `PS2X_TEST_REPEAT=N ./build.sh test` runs the unit suite N times (5/5 green; no flake reproduced) (Tasks 8-10).
- **The transition gate was vacuous between `wcap1` and the final fix wave, and is now enforced.** The controller-configuration "save to memory card?" dialog started appearing on boot; `gameplay_probe.txt` guards it with `ifref` pairs and `transition_probe.txt` did not, so the transition probe stalled on the dialog and never reached the briefing - while `black_rows.py` counted black frames from anywhere in the run, so the boot's own black screens kept the gate green. Every transition run in that window examined **0** frames at or after its burst step and would now FAIL: `wcap1` (10 black frames, 0 after), `wcap2` (13/0), `famb` (11/0), `famc` (10/0), `hostdraw_on` (11/0), `hostdraw_fix` (9/0). Fixed by porting `gameplay_probe.txt`'s guard pairs into `transition_probe.txt` and putting its burst on the NO press (the press that takes the game to the black screen before the briefing); `black_rows.py --from-step N`, `gate.first_burst_step()` and `score_transition` now examine ONLY frames from that step on. Recalibrated on two consecutive clean runs of the fixed probe, `tfix3` (18 frames at/after the burst step) and `tfix4` (17), both peak 0; `TRANSITION_MIN_FRAMES` stays 5 and `tests/fixtures/gate/transition` is regenerated from `tfix4`'s post-burst frames.
- **Gates.** Last full gate run: title / transition / mission PASS 3/3 (stamps `hostdraw_on`, `famb`, `famc`); the mission HUD with `PS2X_VU1_HOST_DRAW=1` scores >= 95 against the native-default sheet.

Known open, carried forward:
- ~~**Host-draw has no family-C coverage in `--vram-diff`**~~ — closed by Sprint 3 Task 9: the family-C render-state packets pointed TEX0 at a texture the dump does not carry, so every texel read back 0 and their `ALPHA_1 = 0x44` (`(Cs - Cd) * As + Cd`, `As = 0`) left the framebuffer untouched. `vu1_replay` now neutral-fills VRAM outside the frame and z buffers and gives the z buffer its own pages; `checked=14 skipped=0`. **Residual:** `hard` misclassifies two by-design differences on alpha-blended draws — blend-amplified gouraud rounding (max delta 2, not 1) and one-pixel shifts of *interior* seams between adjacent triangles (7-22 steps, drawn in both renderings so not a coverage boundary). `vu1dump4_prog_182` scores 1.488% for exactly those two reasons and is not in the fixture set.
- **Mid-list hand-backs are bit-exact only because no FMAND sits within four pairs of `0x1b60`** in the current fixture/dump set — a program that branches on flags in that window is unverified.
- **Black 16x16 squares on the intro movie** (user report, goal-3 item, not a gate) — unchanged from Sprint 1.
- **Intro-cinematic freeze seen once** (Sprint 1, mission gate run `mission3`) — not reproduced again, still open under goal 3.
- **Flaky VSync scheduler-stop test** — not reproduced in 5 `PS2X_TEST_REPEAT` runs this sprint; kept on watch rather than closed.

## 2026-09-11 00:45 (local) — Sprint 1 landed: the project is testable (`./build.sh test` + one gate command) and the first hand-written native VU1 program (the 0x1b50 dispatcher) is on by default
Sprint `2026-09-10-sprint-1-hygiene-and-native-render`, branch `sprint-1`, Tasks 1-8 plus this
review/fix wave. What exists now:

- **Own repo.** The project is its own git repo, remote `github.com/Scotho/socom-unzipped`.
- **Unit tests.** `ps2x_tests` links and runs under llvm-mingw (`-Wl,--stack`, SOCOM runner link
  stubs): **428/428 pass**, run by `./build.sh test`.
- **VU1 fixture verification.** `dist/vu1_replay.exe --verify <golden> [--native|--no-native]`
  replays committed dumps and compares packets *and* the whole register/data-memory state against
  a golden file. Two fixture sets: `tests/fixtures/vu1/title` (12 title-screen dumps, entry pc 0)
  and `tests/fixtures/vu1/dispatch_0x1b50`. `./build.sh test` runs both sets on both paths.
- **One gate command.** `python -m tools_py.parity.gate` drives the three screenshot scripts and
  scores them numerically: **title / transition / mission, each PASS or FAIL**, non-zero exit on
  any FAIL. It launches `dist/socom2.exe`, so `./build.sh runtime` must precede it — `./build.sh
  test` does not rebuild the exe.
- **Freeze rules.** Emulator speed work (VU1/VU0 interpreter, scheduler batching, GS/GL caching
  and upload performance) is FROZEN for this sprint; 36-42 fps single instance is enough, and the
  two-instance frame rate is a test-rig concern (run the second client in PCSX2). Recorded in
  `docs/LOOP_PROMPT.md` (goal 2) and `docs/HANDOFF.md`.
- **research/12.** `docs/research/12-vu1-entry0-ui-path.md` plus its §f dispatcher addendum:
  microcode **entry 0 is a trivial upload stub**; the program that actually draws is the command
  dispatcher at **entry pc 0x1b50** of image `d418194495c25213`. §f documents the command
  encoding, register roles, the staging array and the hand-back rules.
- **Native registry + the 0x1b50 program.** A registry keyed by (microcode FNV hash, entry pc)
  sits in front of the generated-code dispatch; `socom2_dispatch_0x1b50.cpp` implements the
  dispatcher and all seven **family-A** (UI quad / 2D) handlers natively: **76/76 family-A lists
  run native across dump2/3/4, bit-exact** (packets, registers and VU data memory identical to
  the interpreter). Family B and C lists hand back whole at 0x1b50. It is **on by default**
  (`kVu1NativeDefault`); `PS2X_VU1_NATIVE=0` reverts to the generated/interpreted path.
- **Gate green with native on**: title PASS (19/23 menu captures over threshold), transition PASS,
  mission PASS; in-game `[vu1-stats]` shows `native-ended/s` ~3-9k during gameplay.

Open items carried out of the sprint:
- **Family B/C handlers → Sprint 2.** Family B keeps vi12 (the primitive counter) live across the
  dispatcher back-edge, so mid-list hand-back is unsafe (research/12 §f.3); family C is untouched.
- **The transition gate only captures during drive.py's bursts**, so how many black-screen frames
  a run yields is capture luck, not rendering — the floor is 1. Durable fix: capture during the
  settle waits in drive.py.
- **Intro-cinematic freeze seen once** (mission gate run `mission3`: identical frames s29-s41, no
  fault in the game log; `mission4` played it). 1 in 2 runs. Investigate under goal 3.
- **Flaky VSync scheduler-stop test** (`ps2_runtime_interrupt_tests.cpp`, 80 ms wall-clock
  `waitUntil`) made `./build.sh test` non-deterministic; the budget is now 2000 ms, assertions
  unchanged.

## 2026-09-10 20:35 (local) — peer packets decoded (probe10): the peer transport is ALIVE (acked, sequenced 22-byte packets, ~1/s), not SCERT-framed and not encrypted; the freeze is above the transport
Run ours_match_probe10 (net trace with `udp peer send/recv` hex). Every peer packet has the same
22-byte shape, little-endian: `00 01 0a 00 | 00 00 00 00 | 00 00 00 00 | T 00 02 00 | S 00 Q 00 | P 00`
with T = 0x81 / 0x82 / 0x89 (message type), S = sender index (0 = A the host, 1 = B), Q = a
per-sender sequence number (A 0x3f, 0x40, 0x41..; B 0x30, 0x31..), P = a small payload word
(A always 0x0a; B 0x00 for 0x82, 0x0c/0x05 for 0x89/0x81). The two sides alternate: A 0x81 ->
B 0x82 (ack) ; A 0x89, 0x81 -> B 0x82, 0x81 ; ... at one packet per second each way, every
packet answered. So the game's own P2P reliable channel is up and both peers see each other;
nothing here is an RT_MSG (SCERT) frame and there is no crypto handshake — hypothesis (1) of the
20:10 entry (shared RSA key) is ruled out. What is missing is the game-state stream that a
running round would put on this channel, so the blocker is game logic: the round's "go" (or
the local player's control enable) is never reached on either side, while the HUD timer runs.
Note A also sends the first packet to its own address (192.168.2.10:3658) — the player list
includes itself; harmless.
Next (in order): (a) find the P2P protocol code: grep the decomp/generated code for the header
words (0x00000a0100 / the 0x81/0x82/0x89 type dispatch) or trace the callers of the libnetb_ex
UDP send (FUN_00247fe8) and recv (exUdpRecv's guest caller) with PS2X_CALL_TRACE +
PS2X_CALL_TRACE_DUMP to see the sender's state machine and what 0x81/0x89 carry (0x0a vs 0x05/
0x0c payloads look like state codes: "loading", "ready"?); (b) the local control gate: the pad
floats at pad+0x210.. are produced (RY works), so find the actor/controller flag that ignores
LX/LY/RX online (compare the player actor's state word +0x10 in an online spawn vs the
single-player spawn, 0x6691a0 vtable, PS2X_PEEK on both); (c) if (a) shows a "waiting for
players" state, check what the 1.50 client expects from the host over this channel at round
start (the host is our own instance A, so both ends are ours: trace both).
Session hygiene: the loop cron was stopped and the run lock released at the end of this session;
the run recipe is logs/run_match_probe10.sh (PS2X_SOCOM2_SERVER=192.168.2.10, NET_TRACE,
INPUT_TRACE, PEEK 0x416054:3; --existing-b --hold 60).

## 2026-09-10 20:10 (local) — ~~ONLINE MATCH IS FROZEN AT ROUND START~~ (RETRACTED, see below) on both instances: only camera pitch and fire respond; peer UDP runs at ~1 packet/s (a handshake that never completes), not a game-state stream. Pad-state file injection replaces posted keys.

> **Superseded by `docs/research/18-online-round-start.md` §1 and §4, and FIXED (Sprint 4 Tasks 5-6,
> `abf35bb` + `5ed29ca`).** The match was never frozen and no peer handshake was ever missing.
> **The round runs and the local player cannot move** — that is the whole symptom, and it is local.
> Two facts in this very entry said so and were read past: "the HUD timer runs regardless" (line
> below), and RY working while RX/LX/LY did not — a *transport* failure cannot deliver pitch and
> withhold yaw.
>
> Cause: `sceInetInterfaceControl(0x200)` was HLE'd to a **constant**, so the guest's
> `msSinceNetActivity` never reset and the movement scale clamped to 0.0 on frame one; pitch is not
> one of the three scaled axes. Same-binary A/B in one match (`5ed29ca`): fix ON `MoveScale f12 =
> 1.0` on 330/330 calls, idle max 1490 ms, 89 distinct player x; fix OFF `f12 = 0.0` on 339/339,
> idle 504,210 ms, **0.46 units** of travel.
>
> Retracted with it: **"the PCSX2 golden match is the same frozen state"** (`HANDOFF.md`'s open
> item 0). Two PCSX2 instances against our own Horizon stack play a full round and advance to round 2
> (research/18 §1, `docs/research/assets/18-s0-evidence.png`); that "golden" was two stills of a
> match with **no input ever sent**. The peer-packet decode, the local-IP fix and the input-delivery
> fix below all stand — only the conclusion drawn from them is withdrawn.

Runs ours_match_sweep1..3, probe4..9 (logs/parity/ours_match_*, drive logs drive_match_*.txt,
per-instance run logs with `[peek] @416054` = the local player's camera-orbit position, 1 row/s).
- **Input delivery fixed (2561a29):** posted WM_KEYDOWN/UP reach raylib only when the window
  thread pumps, so scripted holds were dropped or their release was seen only at the next press
  (probe6: J->L->W transitions with no neutral state between). `PS2X_SOCOM2_INPUT_FILE=<path>`
  is read on every pad poll ("b=<hex mask> rx= ry= lx= ly="); the online drivers write
  logs/pad_A.txt / pad_B.txt (Shell.pad / Shell.hold). probe7: every 3 s hold lands as a clean
  press/release pair, twice over.
- **Mapping in the online match (probe7/9, identical twice):** RY (K/I) pitches the camera
  (the 0x416054 record moves 27 units along the facing and 10 in y: it is the orbiting camera,
  not the feet), R1 fires (ammo drops), CROSS/TRIANGLE change the camera/stance. RX, LX, LY do
  NOTHING: no turn, no walk (single-player, same build family: LY walked 137 units in 8 s, RX
  turned the view). OPTIONS -> CONTROLLER PRESETS says "1 - Precision Shooter preset is
  currently selected" (presets_explore sheet), so the preset is right; the player is frozen.
- **Netcode (PS2X_SOCOM2_NET_TRACE=1 + udp send/recv counters, this commit):** during the
  8-minute match each instance sends ~1.5 UDP packets/s in total: DME aux (50000/50001)
  keepalives and ONE 22/32-byte packet per second to the peer (A 3658 <-> B 3660, both
  directions arrive). A real SOCOM II match streams tens of packets/s peer-to-peer. The DME
  TCP side only carries the join/address exchange (APP_SINGLE 0x18 with two NetAddresses per
  client) and a handful of broadcasts at spawn, then silence until disconnect. So both clients
  sit at "STARTING ROUND 1 OF 11" waiting for a peer handshake/sync that never completes; the
  HUD timer runs regardless.
- **Local IP:** the exe derived its own address from the universe-server host (default
  127.0.0.1), so both clients advertised 127.0.0.1:3658 as their first NetAddress (A sent peer
  packets to itself). `PS2X_SOCOM2_SERVER=192.168.2.10` makes it 192.168.2.10 (probe9: no
  loopback sends) — correct, but the match stays frozen. Keep the env in the run scripts.
- Same-team is a dead end (probe4: no SEALs -> the lobby never starts the round). The joiner's
  lobby cursor never leaves NOT READY (sweep2/3: UP and DOWN both ignored); the host's cursor
  moves normally (lobby_select), so `--host-switch` is the way to move players between teams.
- The PCSX2 golden (logs/parity/online/match/A_18_hold05, B_20_hold05) is the same frozen
  state (same spawns, timer 05:04); movement was never verified on the reference, and
  tools/pcsx2_b (client B) no longer exists (data-loss incident).
Next: probe10 dumps the first 16 peer packets in hex (`udp peer send/recv`; SCERT ids:
CLIENT_CONNECT_AUX_UDP 0x16, SERVER_CONNECT_ACCEPT_AUX_UDP 0x19, CLIENT_HELLO 0x24, SERVER_HELLO
0x25, UDP_APP 0x0c, ECHO 0x05, PEER_QUERY 0x27..). Hypotheses in order: (1) both instances use the
same fixed RSA keypair (socom2_rsa_key.h) and the peer SCERT handshake rejects/derives a bad
session with an identical key (PCSX2 clients had distinct random keys) — test by giving instance
B a second key (env-selected); (2) the peer connect message carries an address/port the receiver
validates against the DME address list (sceInetAddress layout in exUdpRecv addrOut/portOut);
(3) the P2P layer needs a libnetb feature the HLE answers wrongly (poll/available on UDP).

## 2026-09-10 18:45 (local) — USER REPORT: black squares still visible on the opening cutscene
The user (watching the live runs) sees black squares in the opening cutscene (the intro movie /
location cinematic). The title-gate sheets show the same on the movie background: 16x16-ish black
rectangles at the frame edges in a few captures (vr_title s00/s01 left of the logo, xg_title s14
right edge). Size and placement say dropped/undecoded MPEG macroblocks (IPU/PSS decode or the
16x16-block upload path, STATUS 2026-09-09 12:10 describes that upload), not a GS/dirty-rect
issue. The user adds they flicker in and out very fast, occasionally: per-frame, so either single
decoded frames miss blocks or the two display buffers alternate a stale block (the 12:10 menu-video
strip flickered every other frame the same way; a `burst` capture at 0.2 s catches it). Open under
goal 3; first step: PS2X_GS_DUMP_DISPLAY over the intro and a PCSX2 burst
capture of the same seconds (transition_probe_pcsx2.txt style), then compare the block grid.

## 2026-09-10 17:40 (local) — VU1 register-file build landed (841a6fc — **does not resolve in this repository**: it predates the move to the project's own repo at `4b0bbf9`; verified 2026-09-20 with `git cat-file -e`, kept because it is the historical record, not a usable pointer); two instances of our exe reach ONLINE GAMEPLAY on it (ours_match_play5); A walks into a wall, next = same-team sweep for the first kill
Picked up the VU1 agent's uncommitted work (stale lock, 26 h): the generated VU1 code keeps the VF
register file in a local (xmm-resident across pairs, written back around interpreter fallbacks),
XGKICK bookkeeping is reset without zeroing the 64 KB packet buffer (`m_xgkick = {}` was ~24% of
the game thread), the VU rounding mode is set through the x87/MXCSR control words instead of
fesetround (142 ns per run(), VU0 macro programs run by the thousand per frame), and VU0 runs skip
the steady_clock reads. Rebuilt (header change, 10 min) and gated on this build:
- title_menu.txt (run vr_title, sheet logs/parity/vr_title_sheet.png): 20 clean captures, labels
  crisp, movie background, 59 syncv/s at the menu.
- gameplay_probe.txt (run vr_gameplay): did NOT reach the mission — not a build regression: this
  boot showed the controller-configuration screens (yesterday's xg_gameplay run skipped them, the
  known drift) and the probe's blind CROSS answered YES to "save to the memory card?", then looped
  on "overwritten data will be lost? [NO]". Fix 7bf0160: drive.py `ifref(<png>,y0,y1,x0,x1,thresh)`
  presses only when the settled screen matches; the probe presses RIGHT (NO) on that prompt
  (ref scripts/parity/ref_save_prompt_ours.png, dist 0 on the prompt, 16 on the overwrite dialog,
  35+ elsewhere; threshold 8).
- **Two-instance online match (logs/parity/ours_match_play5, sheet match_play5_sheet.png), the
  goal-1 run:** A (socomc) hosts test/Medley, B (socome) joins and switches to TERRORISTS, both
  READY -> VIGILANCE -> both in gameplay with HUD, round timer, compass; A fires (27/30 after two
  R1 bursts), B moves. 19-21 syncv/s per instance with both running (two game threads + two GL
  threads on the host). Horizon: world 0 registered, both clients CONNECT_COMPLETE on DME TCP +
  aux UDP (50000/50001), APP_SINGLE/BROADCAST relayed, no faults in either run log. The driver's
  "B_TIMEOUT waiting for persona" at 180 s was spurious: B had already passed the persona screen
  and continued to the EULA/lobby/briefing room (fix the message when touching the driver next).
- A never moved: every A_play frame is the same view (a stone wall 2 m ahead); `hold W 3 s` walks
  into it. B's frames change (it turns/moves). So position feedback is needed for A to hunt.
Next (bounded): `--same-team --sweep 24` in online_match_ours.py (added, untested): B stays on
SEALs so both spawn together; A rotates in place firing a burst per step; both instances run with
`PS2X_PC_SAMPLER=1 PS2X_PEEK=0x416054:3` (local player x/y/z, one row per second in each
logs/run_*.log) so the two positions and any death (B's y / respawn) are readable from the logs.
Then the kill/round-end readout: B's HUD/death screen, and the DME world log slice
(server/logs/console-DME.log from the line count the run script records as dme0=).
Run hygiene: the harness kills long background shells, so runs go through a detached script
(logs/run_match_play5.sh via PowerShell Start-Process) and a `.done` marker; the loop cron fires
every 30 min and skips while `logs/.loop_lock` is held by a live run.

## 2026-09-09 15:05 (local) — online match driver on the 60 fps shell: three timing/matcher fixes; instance A logs in to the lobby, B stalls on a missed press (fixed, re-run queued)
Runs ours_match_play1..4 (logs/parity/ours_match_play*/, drive logs logs/parity/drive_match_play*.txt).
The two-instance driver (tools_py/parity/online_match_ours.py, `--play N` adds a gameplay phase: A
walks + fires, B turns) had not been run since the shell went from ~20 to 59 fps; three things broke:
1. Screen matcher: the renderer now draws the UI ~8 px left and a little darker than the
   scripts/parity/refs bands (raw diff 22 vs an 8 threshold). Shell.diff is now a normalised,
   shift- (+-20/+-6 px) and horizontal-scale- (0.90-1.04) tolerant distance; correct screens
   score 0.26-0.44, wrong ones 0.45+ (prompts 0.5); is_screen also requires the best match among
   references sharing a band. Validated on the play1-4 captures.
2. Key holds: 0.15 s = 9 frames trips the UI's held-button repeat. On-screen keyboard typing lost
   characters and overshot ("9`^h", 3 dots for a 5-char password); CROSS on the SERVER NEWS popup
   closed it and the repeat reopened it 8 times in a row. Keyboard presses hold 0.06 s, all other
   driver presses 0.08 s (5 frames).
3. press_until_gone treated one missed frame as "gone" and skipped the press that connects to
   the universe on instance B; a screen is gone only after two consecutive misses 0.6 s apart.
Also: scripts/loop_lock.sh `take` is BUSY for its own owner too (two chains of one owner
overlapped and stole/released each other's lock); `renew <owner>` refreshes a held lock. Host
memory: ~2.5 GB available of 32 (other apps hold ~70 GB committed); the harness kills background
shell tasks under that pressure, so long game runs are launched detached
(logs/run_match_queued.sh via Start-Process) and polled by file.
State: play4 — A: login -> universe -> persona -> password -> CONNECT -> write-down notice ->
EULA -> SOCOM II ONLINE lobby (SERVER NEWS), Medius AccountLogin MediusSuccess; B: stuck on
SELECT UNIVERSE (fix 3). play5 with all fixes is queued behind the VU1 agent's lock.

## 2026-09-09 13:30 (local) — FIRST MISSION IS PLAYABLE: scripted walk / fire / turn drives the game (enemies spotted, objective failed, squad engaging) at 36-42 frames/s
Run logs/parity/runs/gameplay_probe5 (sheet logs/parity/gameplay_probe5_sheet.png, log
logs/parity/gameplay_probe5.log) with scripts/parity/gameplay_probe.txt on the current build
(ff7bdac + input trace): boot -> NEW GAME -> briefing -> DEPLOY -> mission intro -> HUD detected by
screen state (untilref on the squad panel, 34 CROSS presses through the cinematics) -> hold W 8 s
(player walks: x/z 939,832 -> 940,969, i.e. ~137 units; the actor's y follows the terrain)
-> R1 (fire) x2 -> hold L 3 s (right stick: view turns, "Enemies spotted!") -> hold S 8 s
(walks back: to 774,2047 — the walk-back went somewhere else, fine for a probe) -> R1. The game
responds like the console: JESTER/WARDOG/VANDAL name tags, "OBJECTIVE FAILED: TEAM SPOTTED",
squad status FOLLOWING -> ENGAGING, the first-operation help popup. New PS2X_SOCOM2_INPUT_TRACE=1
logs every pad-state change (buttons mask + axes) so a probe's presses are provable in the log
([socom2-input] state buttons=0800 = R1, ly=00 = stick up, rx=ff = right).
Frame rate ([vu1-stats] syncv/s) in gameplay: 36.5-41.9 (mission intro cinematics 20-28).
Known gaps toward the user's "playable" acceptance (a two-instance match ended by a shot or a
grenade): (1) no kill/round-end readout from guest memory yet — find the round/score state the
DME world reports (server/logs has the Horizon side) or the HUD text; (2) online_match_ours.py
needs the same hold/burst steps and the fixed R1 key; (3) HUD text is slightly soft vs the console
(texture filtering) — parity item, not a blocker. Also seen: the probe's DOWN through the briefing
now needs 34 presses since the faster boot (no functional issue).
Tools: drive.py `hold+<s>:KEY` (W/A/S/D left stick, I/J/K/L right stick, R1/L1... buttons),
`untilref(<png>,y0,y1,x0,x1,loops,thresh)`, `burst+<s>:NONE`; scripts/parity/ref_hud_ours.png.

## 2026-09-09 13:30 (local) — GL thread: cached trace switches, row-span texture decode, buffer pooling, render targets sampled directly (no readback); all three parity gates clean
Commits ff7bdac and 1c63db7 (gs_gl_backend.cpp, after main's 9dbe933 dirty-rect fix, whose
semantics are untouched): traceSkip caches its getenv lookups (4.4% of the GL thread with tracing
off); decodeTexture reads row spans through GSMem::ReadSpan and converts per row (14%); the
executed CommandBuffer is a member swapped with m_pending so both keep their capacity (no per-frame
vector growth on the game thread, ~7% of it); and resolveTexture samples a GPU-drawn render
target's own colour texture when a texel-coordinate, clamp/region-clamp draw textures from exactly
that target in CT32 (pending shadow->GPU rectangles applied first; never for the target being drawn
into) — the readback+decode was 26% of the GL thread. `PS2X_GS_RT_TEXTURE=0` restores the readback.

**Gates.** title_menu.txt (runs gl_title, rt_title): 20 clean title captures (movie background,
crisp LOAD GAME / NEW GAME / ONLINE) then the attract cinematic; transition_probe.txt (gl_transition,
rt_transition): rows 396-447 peak 0 on every black-screen frame (`tools_py/parity/black_rows.py`,
scores only frames whose upper rows are black; main's rects_transition baselines at 0); mission
diag (gl_mission, rt_mission): sheets identical to sched2_1, HUD text / minimap / squad panel crisp.

**Numbers.** [vu1-stats] `proc` minus `thread`: the GL thread went from ~1000 ms/s (a full core,
half of it the vsync wait) to 0-650 ms/s in the mission; main's gameplay probe on this build
reports 36-42 fps (cdd2c4c). Mission frame rate in the diag script varies with the scene (2.4-4.2 M
VU1 cycles per frame between runs), so compare phases by cycles/frame. GL-thread profile of this
build: pending (run glprof_3 queued behind the lock).

## 2026-09-09 12:10 (local) — menu-video strip before the briefing FIXED: shadow->GPU refresh now re-reads exactly the uploaded rectangle, not the enclosing rows
User report (07:45): a strip of the main-menu video at the bottom of the black screen just before
the mission briefing (rows 396-447 of the 448-row frame, flickering every other frame). Console
(PCSX2 burst capture, logs/parity/runs/transition_pcsx2) shows pure black there. Evidence chain
(runs transition1..15, tools: burst step in drive.py, PS2X_GS_DUMP_DISPLAY three-layer dumps of
the displayed buffer, PS2X_GS_TRACE_DIRTY, PS2X_GS_PROBE post-draw pixel reads):
- The game double-buffers at fbp 0 / 0x8c (448 rows each). The letterboxed cinematic
  (alb_aop.pss, 640x368) is uploaded into the display buffer as 16x16 blocks from a base one page
  row below the buffer (dbp 0x12c0 / 0x140), so its last block row lands at rows 384..399.
  VRAM rows 400..447 still hold the main-menu movie's leftovers (the menu movie is uploaded
  through the same path). The game's full-screen black sprite (0,0)-(640,448) does paint the GPU
  target black there (probe: rows 420/440 = 000000 right after every such sprite).
- Our GL backend mirrors uploads into the GPU target lazily: an upload marks the target's rows
  dirty and the next draw/present re-reads them from the shadow VRAM. The dirty window was a
  single merged [first,last) row range, then (this morning) 32-row bands: a 16-row block at rows
  384..399 re-read rows 384..415, i.e. also the stale rows 400..415 the GPU had just painted
  black — and the previous merged-range scheme re-read everything between the topmost and
  bottommost mark. The GPU's own draws are never in the shadow, so any re-read beyond the
  uploaded pixels resurrects old content.
- Fix (gs_gl_backend.cpp): uploads in the target's own layout (same dbw/psm, page-row aligned)
  record an exact DirtyRect (dsax/dsay/rrw/rrh) that refreshDirtyRows re-reads with a
  glTexSubImage2D of just that rectangle; other layouts keep the 32-row band mask (dirtyMask);
  executeClear applies pending rows before clearing. Verified: transition run rects_transition
  (black screen band 0.0, was 8.1), title-menu run rects_title (24 clean captures, movie
  background and labels intact). Mission sheet still to be re-checked by the next mission run.
New switches: PS2X_GS_TRACE_DISPFB=1 (display buffer + clear log), PS2X_GS_NO_DIRTY_REFRESH,
PS2X_GS_NO_ZTEST, PS2X_GS_TRACE_DIRTY=<frame>, PS2X_GS_PROBE=<frame>,
PS2X_GS_DUMP_DISPLAY=<dir>:<t0>:<t1>, PS2X_GS_TRACE_CMDS_FROM/_MAX; drive.py `burst+<s>:NONE`
captures a frame every 0.2 s (transition flashes). Wrong turns worth not repeating: the CPU GS
backend (PS2X_GS_BACKEND=cpu) does not feed PS2X_HOST_SCREENSHOT_LATEST, so it cannot A/B a
display bug; PS2X_GS_TRACE_CMDS=<n> is relative to the movie-start frame (use _FROM for an
absolute frame); PS2X_GS_TRACE_DIRTY without a row filter floods the log and stalls the run.

## 2026-09-09 07:30 (local) — scheduler fast paths, direct XGKICK submit, VU0 fast path: mission gameplay 28.7 frames/s (best 30 s: 31)
Fresh game-thread stack profile after the GS spans (run gtprof_2): startXgkick 9% in memcpy (the
kicked packet was copied VU memory -> kick buffer -> arbiter), processPendingEvents 6% in mutex
calls on every checkpoint return, selectReady 4% self (128 empty priority deques scanned on every
idle wake), VU0 micro programs 4.5% (still the cycle-exact scheduler), GS front end ~12%
(GSGlBackend record/Cmd growth, main's file). Fixes (commit below): the immediate XGKICK path
walks the GIFtags in VU memory and submits the packet from there (the arbiter's copy is the only
one; the copying paths remain for wrapping/overrunning packets), processPendingEvents clears the
checkpoint request without the event mutex when nothing is posted (atomic event count) and no
deadline is due, selectReady returns at once when the ready count is zero, and VU0 micro programs
use the fast path too (`PS2X_VU0_FAST=0` restores the exact scheduler; the semantics are the same
code that is golden-verified on VU1). The mission program was regenerated with the newest
hand-back pcs added to logs/vu1_seeds_mission.txt (900-dump golden green, FMAC check clean).

**Result** (run_20260909_07xx sched2_1, sheet identical): gameplay phase **28.7 syncv/s over the
last 60 s, 31.0 in the best 30 s**, 7.0 ns/cycle, 69 M VU1 cycles/s, 2.4 M VU1 cycles/frame,
hand-backs 33/s (0x3828 now the top one). Progression today: 3 -> 10 -> 13 -> 19 -> 22 -> 29.
GSMem::ReadSpan (row-span texture reads, mirror of WriteSpan) is in for the GL backend's
decodeTexture (per-pixel ReadCT32 today, 14% of the GL thread; main's file).

**07:50 addendum.** GifArbiter::submit now processes a packet straight from the caller's buffer
when its queue is empty (order-preserving: nothing but other submissions happens between a submit
and the drain), which removes the per-XGKICK memcpy (run arb_1: 26-28 frames/s, sheet identical).
The title screen and main menu run the mission VU1 image with entry pc 0 (150 dumps at the title,
all hash 638cb8f0), so the recompiler already covers them (`interp-programs/s=0` at the title);
the title itself runs at ~30 syncv/s with the game thread at 100% and VU1 at 2 ms/s — the menu
movie decode/upload path, not VU1, if that ever matters. Online lobby image: dump in progress.

**08:20 addendum — one VU1 image everywhere.** The online lobby (SELECT UNIVERSE on the local
Horizon universe, run online_dump3, 59 syncv/s) and the title/main menu both run the mission
microcode image (hash 638cb8f0, entry pc 0): 150 dumps each, `interp-programs/s=0`,
`handbacks/s=0`. So the single generated program covers title, menus, mission and lobby. The
fixed-press online scripts no longer line up with the faster boot (they land on NEW GAME);
`scripts/parity/launch_to_online_fast.txt` drives the menu by screen state (`untilref` on the
main-menu reference) and reaches the lobby.

## 2026-09-09 06:20 (local) — VU1 program regenerated from 900 dumps (300 gameplay): hand-backs 850 -> 32/s, mission gameplay 22-29 frames/s
The in-game `[vu1-bail]` histogram showed the generated code handing ~1100 programs/s to the
interpreter at computed-jump targets (command handlers) the 300 intro-window dumps never
reached (0x1c30, then 0x1c70/0x1a78 one hop further). 300 gameplay programs were dumped with
`PS2X_VU1_DUMP=logs/vu1dump4:300 PS2X_VU1_DUMP_AFTER=220`, their exact-interpreter golden
recorded (logs/vu1golden/d4, 1.1 M cycles), and the program regenerated from all 900 dumps plus
the bail pcs (`vu1_replay --gen --seeds logs/vu1_seeds_mission.txt`). The generated code equals
the exact interpreter on all 900 programs (d2/d3/d4 diff 0, FMAC check clean); the gameplay
dumps run at 6.9 ns/cycle offline. In the mission (run_20260909_053430-ish seeds_2, sheet
identical): hand-backs 32/s, 5.9-10.7 ns/cycle, VU1 host 430-480 ms/s incl. GS work, and
**syncv/s 21.8 over the last 60 s, 29.0 in the best 30 s phase** (2.5-3.1 M VU1 cycles/frame).
Remaining hand-back pc 0x3d18 (4211 in the run) is next in the seeds. PS2X_HOST_PROF_MAIN=1
samples the main/GL thread (it uses a full core: next profile target).

## 2026-09-09 05:30 (local) — stage 3: host stack profiler; scheduler clock batching; row-span GS uploads + pooled arbiter -> mission gameplay 12.7 -> 19 frames/s
**Measuring.** `PS2X_HOST_PROF=1` now writes module names for external addresses and runs its
sampler at time-critical priority (the old sampler under-sampled compute and blamed `_setmode`);
`PS2X_HOST_PROF_STACKS=1` unwinds the x64 call stack of every sample (RtlVirtualUnwind) and
`tools_py/hostprof_stacks.py` prints inclusive shares, the exe callers of DLL time and folded
stacks. `[vu1-stats]` prints `thread=`/`proc=` CPU ms/s, `interp-programs/s` (images without
generated code, named once as `[vu1] program image <hash> ... has no generated code`),
`handbacks/s`, and with `PS2X_VU1_BAILHIST=1` the top hand-back pcs (`[vu1-bail]`);
`tools_py/vu1stats_summary.py <log>` summarizes a run by 30 s phase with VU1 cycles per frame.
Frame rate = `syncv/s` (sceGsSyncV, one per presented frame; the game never calls
sceGsSwapDBuff). The game thread is 100% of one core; the process uses ~2 cores (GL thread).

**Profile of the game thread in the mission (run_20260909_043923, stacks).** Inclusive:
EeScheduler::accountCycles 21% (13% inside ntdll: a QueryPerformanceCounter on every recompiled
checkpoint), GS::processGIFPacket 15.5% (GSCpuBackend::UploadImage 9.2% = a std::function call per
pixel into GSMem::WriteP8/P4/CT32; GSGlBackend::record copies 3%; vector<GSGlBackend::Cmd> growth
2.2%), processDueDeadlines 4.6% (mutex + clock per call), dispatchIrq 3.4% (std::getenv per IRQ),
VU1 generated code ~9%, VU1 interpreter ~12% (hand-backs, see below), recompiled EE code ~3%.

**Fixes (commits 9b4212b, 5ef9c5b).** accountCycles converts the host clock once per 5000
estimated guest cycles (~17 us; waitForEvent forces a conversion); processDueDeadlines returns
before m_nextDeadlineCycle without locking; dispatchIrq caches its trace switch; publishSnapshot
(a138ad3) publishes at most every 50 ms of guest time. GSMem::WriteSpan writes host-to-local
transfers in row spans (same PixelStorageTraits<psm>::Write per pixel, inlined, no std::function;
the per-pixel path stays for formats without a span writer) and GifArbiter reuses its packet
slots/buffers. Sheets sched_1 and gsup_1 are identical to vu1gen_1 (title labels, briefing
textures, cinematics, HUD).

**Result.** Gameplay phase of the mission (HUD on screen, ~2.9 M VU1 cycles per frame):
run_20260909_051059 **19.0 syncv/s** at 10 ns/cycle (56 M VU1 cycles/s, VU1 host 560 ms/s incl.
the GS work done inside XGKICK) vs 12.7 before the scheduler/GS changes (the scheduler-only run
sched_1 measured 11.7 in a heavier phase — the phases do not align run to run; compare the
gameplay phase and cycles/frame). Menus 55-57/s.

**Open.** The generated VU1 code hands ~1100 programs/s back to the interpreter at computed-jump
targets the 300 dumps never reached (0x1c30: 200k, 0x1e50: 28k, 0x1d80, 0x1d30, 0x1d90, 0x3d10 ...):
those pcs are now generator seeds (logs/vu1_seeds_mission.txt, `vu1_replay --gen --seeds`) and a
gameplay dump (PS2X_VU1_DUMP_AFTER) is being taken for a second golden. Still in gs_gl_backend.cpp
(main's file, pending its commit): pooled record/Cmd buffers (~5%). Then: what the other core does
(the GL thread is at 100%: decode/upload on the render thread may be the next wall), and the VU1
register file in host registers.

## 2026-09-09 04:05 (local) — VU1 microcode recompiler ("known programs"): 18 -> 12 ns/cycle in the mission, frame rate 10 -> 13 per second; the other 35 ms/frame is now outside VU1
**What landed (commit 6dcf73d, default on; `PS2X_VU1_GEN=0` disables).** `vu1_replay --gen`
turns a dumped 16 KB VU1 code image into one goto-threaded C++ function
(src/lib/vu/generated/vu1_d418194495c25213.cpp for the mission image, md5 638cb8f0, all 300
dumped programs) registered in vu1_known_programs.cpp; the interpreter hashes VU1 code memory
(FNV-1a, only when the VIF MPG generation changes) and runs the matching function. The generated
code is a static unrolling of the fast path with constant register indices and the same shared
SSE FMAC helpers (ps2_vu1_ops.h): flag ring / Q / P timing kept exactly (commits deferred to
readers, loop heads and every 16 pushes on a 64-entry ring), same-pair shadow rule, delay slots
(also a branch inside a delay slot), E-bit end, and a hand-back to the interpreter with
m_state.pc set for anything unsupported (cycle budget, computed-jump targets not seen in the
profile, D/T bits). A dataflow pass over the image (per-lane "pairs since the last write" slack,
"lane holds a normalized value") removes the ready checks and operand normalizations that cannot
matter (1400 -> 62 VF ready checks in the mission image); the MADD/MSUB flag classification has a
proved-exact float fast path (double/long double only near zero, overflow or cancellation; proof
in ps2_vu1_ops.h); ACC stays in a host register across pairs; XGKICK copies whole GIFtag
payloads. Tooling: `--pchist`/`--bailhist`/dispatch counters, `-g1` on the generated file so
`--prof` maps to pairs (scratch script genprof), `[vu1-stats]` now prints `flips/s`
(sceGsSwapDBuff — SOCOM II never calls it) and `syncv/s` (sceGsSyncV = one wait per presented
frame: the frame-rate number).

**Verification.** Offline: identical to the exact interpreter on all 300 dumps (packets,
registers, flags, cycle counts), 0 hand-backs, `PS2X_VU1_FMAC_CHECK=1` clean; 10.0 ns/cycle vs
21.4 (fast interpreter) and 92 (exact) in the same tool. In-game (same build, mission phase,
last 60 s of each run): generated `[vu1-stats]` 45.1 M cycles/s at 12.1 ns/cycle, 27.9k
programs/s, host 546 ms/s, **syncv/s 12.7** (run_20260909_034405, sheet vu1gen_1: title clean,
intro clean, gameplay HUD at s33); `PS2X_VU1_GEN=0` baseline 32.9 M cycles/s at 18.5 ns/cycle,
21.6k programs/s, host 605 ms/s, **syncv/s 10.2** (run_20260909_035139). Menus run at 50-57
syncv/s in both. Yesterday's exact interpreter: 6.9 M cycles/s at 100 ns/cycle.

**Where the time goes now.** The mission issues ~3.3-3.5 M VU1 cycles per presented frame
(~2100 programs), so at 12 ns/cycle VU1 costs ~42 ms/frame and the rest of the runtime (EE
recompiled code, VIF/DMA, GS front end on the game thread) ~35 ms/frame: frame time ~77 ms.
Even a 4 ns/cycle VU1 (14 ms) leaves ~50 ms/frame -> 20 fps, so the next step for frame rate is
a `PS2X_HOST_PROF` profile of the mission with this build to find the non-VU1 hot spots (the
earlier profile, STATUS 2026-09-08 17:30, was taken when VU1 was 70% of the time). VU1 itself:
the generated code's remaining cost is the FMAC flag build/push (~40% of its time), startXgkick
(~5%), fastCommit (~3%); the register file still lives in memory (store-forwarding latency on
dependent pairs), which a per-block register allocator could remove.

**Caveats.** Only the mission image is recompiled; the title/UI and online images run on the
fast interpreter until dumped (`PS2X_VU1_DUMP` at those screens, then `vu1_replay --gen` and a
line in vu1_known_programs.cpp). The generator's DIV/SQRT/RSQRT skip the PS2X_FPU_TRAP
diagnostics. Regenerating needs a bootstrap when the helper signatures change (scratch
regen.sh: remove the generated file and its table entry, build vu1_replay, --gen, restore,
build).

## 2026-09-09 02:40 (local) — VU1 fast path: 100 -> 18 ns/cycle in the mission (5.4x VU1 throughput), default on; the run reaches gameplay with the HUD
The cycle-exact VU1 scheduler (per-instruction ready scan, pending-write queues, long double FMAC
flags) is replaced by a non-cycle-exact fast path (commit 773991c, default on since this entry;
`PS2X_VU1_FAST=0` restores the exact path, a VU trace forces it):
- VF/VI/ACC writes and stores land immediately. Every VF write in the model has the same 4-cycle
  latency and every read stalls on the register, so immediate writes give the same values; the
  same-pair rule (the lower reads the old value of the upper's destination, the upper wins a
  write to the same register) and the one-instruction VI branch bypass are kept.
- The cycle counter still advances by the modeled stalls (per-lane VF and VI ready cycles, Q/P
  and EFU resources, WAITQ/WAITP), so MAC/STATUS/CLIP flags (8-entry ring in issue order,
  +4 cycles), Q (+7/+13) and P land at exactly the cycles the exact path shows them — the
  game's FMAND backface test and FCAND clip tests see the same flags. E-bit, branch delay,
  D/T halts, XGKICK at kick time, the 65536-cycle budget and the flush at program end are
  unchanged.
- FMAC lanes run on SSE2 for the four lanes together. The Z/S/U/O classification comes from the
  chop-rounded float (single ops) or double (product-sum: the float product is exact in double)
  result and drops to the long double computation only when a result lands exactly on FLT_MAX;
  proof sketch in ps2_vu1_upper.cpp (a single chop-rounded op has |r| <= |exact| < |r| + ulp), so
  the flags and stored values are bit-identical to the old long double path. `PS2X_VU1_FMAC_CHECK=1`
  cross-checks every FMAC against that path (0 differences over the 300 dumps). applyDest and the
  vf0 reset store 16 bytes (scalar lane stores followed by the FMAC's vector load stalled store
  forwarding); normalizeOperand/microAddressMask/fastReadyCycle inlined; the decoded-code cache is
  validated once per program instead of per pair.

**Verification.** `dist/vu1_replay.exe --batch <dir> <dumps>` writes a golden per dump (packet
bytes + FNV hash, cycle count, end pc, MAC/STATUS/CLIP/R/Q/P/I, all VI/VF/ACC, VU data memory
hash). The fast path equals the exact interpreter on all 300 dumped mission programs
(logs/vu1dump2 + logs/vu1dump3: 287k cycles, 274k pairs, 118 programs with packets) in every
field, including cycle counts. Timing with `--repeat 100` (`--prof` samples the host pc): exact
92 ns/cycle (same tool; the tool now runs programs from PS2Memory's VU1 buffers so the decoded
cache applies), fast 21.4 ns/cycle. In the mission (logs/run_20260909_021205.log, run
vu1fast_1, sheet logs/parity/vu1fast_1_sheet.png): `[vu1-stats]` 34-37 M cycles/s at 17.7-19.1
ns/cycle, 21-23k programs/s, vs 6.5-8.2 M cycles/s at 93-103 ns/cycle, 6.5-8.7k programs/s in the
last stats run (run_20260908_171207). The host still spends ~650 ms/s in VU1: the game is VU1-
bound and simply runs ~3x more frames (programs/s), so the next speed step is still VU1 (a
block recompiler to host; the interpreter's remaining cost is the per-pair dispatch, the
Windows-ABI xmm save/restore of execUpper and the ready-cycle scan). Screens: title labels clean
(s05/s06), mission loads, the intro cinematics play (s21-s27, no giant polygons), and for the
first time the 420 s run reaches gameplay with the HUD (s34-s37, "RENDEZVOUS WITH MALLARD",
squad status, help popup); same 16 pre-existing guest faults as before; no hang with the VIF1
i-bit stall (16af5ad).

**Not done / caveats.** ps2x_tests does not link on this toolchain (pre-existing: bad
`--stack` link option, then unresolved runner symbols ps2HostProfStart, ps2_stubs::sceVibGetProfile,
socom2_RsaGenerateKeyPair, scePad2GetState), so the VU unit tests were not run; the 300-dump
golden and the FMAC check stand in. The fast path is VU1 only (VU0 micro programs keep the exact
scheduler; they are tiny). The exact path's behaviour of reading the previous I register in an
I-bit pair's upper instruction is preserved (not re-examined). No frame counter exists in the
log; frame rate is inferred from programs/s (~3x) — add a flips/s line to PS2X_VU_STATS next.

## 2026-09-09 02:15 (local) — TITLE LABELS FIXED: VIF1 i-bit stall + prompt IRQ delivery; the console never stops the menu movie (that lead was built on the wrong savestate)
The garbled LOAD GAME / NEW GAME / ONLINE labels are gone: logs/parity/title_stall5_sheet.png
holds 24 main-menu captures over 2+ minutes, all clean (before: logs/parity/title_trace7_sheet.png,
garbled from s10 on). Root cause, established with a PCSX2 GS dump of the real main menu
(savestate slot 21; slot 6 — the "title" image every 03:20 conclusion was built on — is the
SELECT RANK dialog, so "the console has no movie set at the title" was never a valid comparison;
the user confirmed the menu movie is correct and must stay):
- Console per-frame GS order (tools_py/gsdump_timeline.py on tools/pcsx2/snaps/*.gs, captured by
  tools_py/parity/gsdump_capture.py --slot 21): 512x256 background upload -> background sprite ->
  the 11 label textures (set [11], 0x3107..0x3387) -> label draws. Ours (tools_py/gif_submit_timeline.py
  on a PS2X_GIF_TRACE run, which now also prints TEX0 binds): set [11] flush -> background upload
  (to 0x2bc0 every other frame, overlapping the label pages) -> label draws. One step out of phase,
  so the labels were drawn from the background's pixels every other frame.
- The game sequences texture-set uploads against its draw stream with a marker protocol: each
  set flush appends an entry to the render queue at 0x4887c0 (FUN_0033bf30/be70/bd90) and emits
  [FLUSH][DIRECT 1qw][FLUSHA][NOP with the VIF i-bit] into the VIF1 MFIFO ring. VIF1 stalls at the
  i-bit code and raises INTC5; the handler FUN_0033c010 kicks the GIF chain of entry[index++]
  (PATH3 upload), re-bases sets (FUN_00355de0) and writes FBRST.STC to release VIF1. FUN_00339de0
  (frame begin) resets the index. Two runtime defects broke the mapping between markers and entries:
  1. VIF1 never stalled on an i-bit VIFcode (it raised INTC5 and carried on), so the next segment's
     draws ran before the handler kicked their uploads. Fixed: ps2_vif1_interpreter.cpp holds the rest
     of the stream after an i-bit code (STAT.VIS|INT) until FBRST.STC (ps2xVif1StallCancel resumes it);
     PS2X_VIF1_NO_IRQ_STALL=1 restores the old behaviour for A/B.
  2. The 7th (last) marker of a frame is committed to the ring by FUN_00350ab0 with a BYTE store to
     D8_CHCR (0x1000d001); only PS2Runtime::Store32 drained pending INTC causes, so that interrupt
     was delivered at the next 32-bit MMIO store — inside FUN_00339de0, after it had reset the index —
     and every chain of the new frame was kicked one marker early (the label set before the
     background instead of after it). Fixed: Store8/16/64/128 drain completed DMAC/INTC causes too.
  Evidence: tools_py/marker_timeline.py merges FrameBegin/AppendFlush/Vif1Irq call traces, stalls,
  STC, GIF kicks and submissions (run logs/run_20260909_020018.log = before, 020640 = after).
- Also landed: scripts/parity/title_menu.txt reaches the main menu by screen state
  (drive.py `untilref(<png>)` presses CROSS until the frame matches ref_main_menu_ours.png, then
  holds) — boot drift made fixed press counts land on SELECT RANK in 2 of 3 runs.
Not re-verified in this step (the VU1 agent's mission run is next and covers it): the mission
load and online screens with the i-bit stall. If a run ever hangs with VIF1 stalled, the game
did not STC — A/B with PS2X_VIF1_NO_IRQ_STALL=1 and report.

## 2026-09-09 03:20 (local) — title labels (user report 01:50): the label VRAM pages are overwritten by a 512x256 upload from the menu-movie texture set; the console never runs that set at the title
The garbled LOAD GAME / NEW GAME / ONLINE labels are NOT a rounding or GS-decode fault any
more: the label images the EE uploads (128x32 CT32 at blocks 0x3207/0x3247/0x3287 = pages
0x190/0x192/0x194, texture set [11] base 0x2fcc) decode cleanly (PS2X_GS_DUMP_TEX). New
diagnostics `PS2X_GS_TRACE_PAGES=0x190:6` (every upload/copy/refresh/download/draw/decode on
those pages) and `PS2X_GIF_TRACE` (each GIF submission with path, PATH3 mask, GIFtag and
BITBLTBUF) show a PATH3 upload of a 512x256 CT32 image to block 0x2bc0 (pages 0x15e..0x19d,
covering the label pages) every third frame; the label textures are decoded right after it
and hold background pixels until the next label upload. The packet is built by the
texture-set flusher FUN_00356e90 -> FUN_00356d20 (CNT 6 qwords + IMAGE 0x7fff + REF) for a
set object (class vtable 0x6f0330) with base 0x2bc0 / limit 0x33d8 living at 0x7abcc0 on
ours; its image source is the 512x256 double buffer 0x15493b0/0x15c93b0 (stale logo bitmap in
it). PCSX2's title memory (new savestate slot 6 = title; `tools_py/parity/p2s_extract.py`
pulls eeMemory/Scratchpad out of a .p2s) has the same 16 texture-set managers as ours (all
equal, labels in set [11] at the same addresses) but NO set with base 0x2bc0/limit 0x33d8 and
no packet uploading to 0x2bc0 anywhere (main RAM or scratchpad), and its title background is
static for 90 s (captures 6 s apart differ only in the roller box). Both sides hold the dlgMenu
element with `run/movies/common/menuloop.pss`; on ours a live movie element exists (object at
0x7ab940.., "ui/assetlib/uisk..") streaming MENULOOP (sceCdStRead every frame) and pushing
frames through that overlapping set — the set is meant to be used only while the shell set
[11] is not (they overlap in VRAM by design). The CPU backend renders the labels clean only
because the timing of the interleaved uploads differs (title_cpu4); GL runs with extra render
work (title_gl4, texture dumps) were clean for the same reason. In progress (title_trace5):
PS2X_MPEG_TRACE/PIC_TRACE lifecycle at the title to see why our menu movie starts when the
console's does not (candidates: sceMpegIsEnd/GetPicture semantics after the intro skip, or the
attract-mode idle timer). Fix direction: make the menu movie behave like the console (not
running at the title) — not a GS/arbiter change.

## 2026-09-09 01:30 (local) — the collision probe is IDENTICAL to PCSX2's; ~~ground height: the actor rests at a different height above the same hit~~ (RETRACTED, see below)

> **Superseded by `docs/research/17-ground-height.md` §0.1 (Sprint 4 Task 4). The framing of this
> entry is wrong, and the entry contains its own refutation.** "The actor rests 20.11 / 14.69 above
> the hit" is neither the actor nor a height above the ground: both numbers are **camera-eye minus
> collision-hit**, differenced from the *camera* y values this entry prints in the very next
> clause — 20.11 = −126.264 − (−146.371), 14.69 = −131.68 − (−146.371). The **player's feet match
> the console to 0.008** (ours −145.875, console −145.8672; and this entry's own line 829 records
> our −145.875 as a cached ground point). What is 5.4 low is the **third-person camera**, and
> research/17 §4 localises that to the player actor's skeleton root node decaying 11.4845 → 0
> while its saved copy freezes at the console's 5.50391 — an animation-blend defect, not terrain,
> not collision, not the mover.
>
> The cost of the wrong name: "ground height" sent three sessions at terrain, the collision grid
> and the mover's gravity/step logic. Nothing below this line about the probe, the structures or
> the field offsets is retracted — only the sentence that says what the difference *is*.
>
> Also retracted, from line 819 below: **`*0x488de8+0xbc` is the camera's follow pointer, not a
> route to the player actor** — this entry says so correctly ("is null in the spawn images") and it
> was read as an actor route anyway, then carried into later work. The player actor is `*0x408c58`
> (`@408c58` word0 = `017941d0`, `@17941d0` word0 = `006691a0`, `*(actor+0xc0)` = mover
> `006694b0`), verified in five of our RDRAM images, the PCSX2 console image and live online
> (`9c28fe0`, research/18 §4.1).

With the new tracer (`PS2X_CALL_TRACE_DUMP="GroundQuery:a1:16,GroundQuery:a1+0x48*:16"`,
run mission_s19) every GroundQuery (FUN_002d49c0) prints its ray and hit records. The player's
vertical probe at (939.24, 832.6) returns ONE hit at y = -146.371, normal (0.070, 0.997, 0.021)
— exactly PCSX2's (polled live over PINE at savestate 8 with the new
tools_py/parity/probe_poll.py: -146.37, (0.0698, 0.9973, 0.0212)). So terrain, collision grid
and the probe math agree; the 5.5-unit difference is how far the actor rests ABOVE the hit:
PCSX2 20.11 (y = -126.264), ours 14.69 (y = -131.68). At spawn ours is placed at -125.97 (the
console value), drops to -135.9 and settles at -131.7 (s16 peek rows), PCSX2 never drops.
Structures: the player actor (class vtable 0x6691a0, PCSX2 spawn image 0x1713ce0) points at
+0xc0 to its mover (vtable 0x6694b0, 0x170d510) whose +0x90 is the position; the static records
0x416050/0x4160b0/0x416110/0x416170 are four horizontal segment probes cast from that position
(FUN_0029bf70) and never hit on PCSX2 — they do not set the height. The per-frame vertical
GroundQuery via FUN_0031dfd0 only feeds the surface material (+0x2c0 of the actor's +0xb4
object). The height therefore comes from the mover's own gravity/step logic or an animation
root offset. In progress: run mission_s21 dumps RDRAM at rest (400 s and at GroundQuery #350)
to diff the mover object against PCSX2's (candidate fields: +0x88/+0xf8 = 25.0, +0xf0 = 60,
+0x54.. = (4, 3, 6.33)). Gotcha: the camera's follow pointer (*0x488de8+0xbc) is null in the
spawn images; find the actor through the vtable scan instead. spawn_ours3.rdram (s18, 318 s)
was taken before the spawn (boot drift) and holds the post-load position (935.6, -120.0, 834.4),
identical to PCSX2's post-load record.
Update 02:10: mission_s21's 400 s image (logs/parity/rest_ours.rdram) holds the player at rest
(939.24, -131.73, 831.95); the player's actor is the one whose mover has vtable 0x6694b0 (AI
actors' movers use 0x6693f0). Diff against PCSX2's spawn image (scratch moverdiff.py: actor
0x1a5e4b0/mover 0x1785ee0 vs 0x1713ce0/0x170d510): mover +0x5c = 4.0 (PCSX2 6.3338, with
+0x54/+0x58 = 4.0/3.0 on both), +0x70..+0x7c = (-12.43, -39.13, -10.48, -14.29) vs (-11.86,
-41.58, -5.99, -12.96); actor +0x10 state word 0x00080502 vs 0x2, actor +0x24/+0xb8 = 856.39 vs
857.07 (a second position copy with y = 856?), actor +0x2bc..+0x2c4 = (939.24, -145.875, 856.39)
on ours vs zeros on PCSX2 (a cached ground point: -145.875 vs the probe's -146.371). No
constant 6.3338 in the decomp (computed). Parked here: the next step is the mover's update
method (writer of mover+0x90 y / reader of +0x5c) — trace it with PS2X_CALL_TRACE_DUMP on
the mover object — but the title-screen labels come first (user report 01:50).

## 2026-09-09 00:10 (local) — ROOT CAUSE of the giant sky polygons: VU0 macro-mode ops never set the MAC/STATUS flags, so the EE's frustum test called every object "fully inside" and sent it through the no-clip VU1 path
The object at the camera (STATUS 23:10) was the terrain/road strip the camera stands next to
(a 2x5 vertex grid at 90-unit spacing, world space; the transform's eye solves to the camera
position (938.6, -124.4, 832.5), which is also VU constant 30 — not a "player" test). Its VU1
command list [0x68, 6, 0x64, 8, 0x10, 0x28, 0x30] is built by `FUN_003b5f20`: word 8 (0xdf8,
transform without clipping) when the global `DAT_004b4eb0` is nonzero, word 2 (0x1f70 -> the
CLIPw subroutine at 0x3618 + edge clipping at 0x3a90/0x3ad0) when it is zero. The flag is the
third argument of `FUN_003b6b20` and comes from `FUN_00290c30`, the camera-frustum test of the
mesh's bounding box (FUN_003374c0 <- FUN_00338480 path; 2 = culled, 1 = fully inside, 0 =
intersects). That test is VU0 macro code: `FUN_00294ac0` multiplies the 8 corners by the
view-projection, runs VCLIPw and reads the CLIP flag register with CFC2; when a corner is
outside, `FUN_00294a30` does the fine test with two VSUBs and reads the STATUS register's sticky
sign/zero bits (CFC2 vi16 & 0xC0). Our recompiler never updated `vu0_status`/`vu0_mac_flags`
from any VU0 arithmetic (only CTC2 wrote them), so the fine test always returned "no corner
outside" and the near strip went out unclipped with q < 0 vertices. Also found: the macro-mode
VCLIP had the +/- bits swapped (bit0 must be x > +|w|) and compared against w instead of |w|.
Fix (recompiler): `VuTranslator::appendFmacFlags` appends `ps2_vu0_fmac_flags(ctx, res, dest)`
to every FMAC-class emission (ADD/SUB/MUL/MADD/MSUB/OPMULA/OPMSUB, broadcast/i/q/A forms; MAX,
MINI, FTOI/ITOF, MOVE, ABS untouched as on hardware); the helper in ps2_runtime_macros.h
rewrites the MAC flags (Z/S/O per lane) and STATUS (Z/S/O + sticky bits 6-9 ORed until CTC2).
VCLIP fixed to the manual's bit order with |w|. VERIFIED (logs/parity/runs/mission_s16,
logs/parity/mission_s16_sheet.png): the mission intro now renders every shot like the golden
run — helicopter over the valley, the car on the dirt road, the river/bridge scene, the forest —
with no sky-coloured polygons; the title screen (s05) is unchanged. The run ends in the forest
fly-by because the frame rate is still a few fps (item 3 below). CONFIRMED by the dump run
(logs/vu1dump3, mission_s17): 0 of 3164 kicked vertices have q < 0 (was 108 of 1878) and six
of the 150 programs now run the clipping list (word 2) that never appeared before. Gotcha: `PS2X_VU1_DUMP` does not
create its directory — mkdir it first or the run dumps nothing (silent fopen failure).
Remaining in order: ground height (-131.7 vs PCSX2 -126.3 at 0x416054), frame rate (VU1 fast
path / recompiler), then the mission parity report.

## 2026-09-08 23:10 (local) — the behind-camera triangles come from a no-clip object path; player stands 6.6 units lower than on the console
Offline replay of 150 dumped VU1 runs at the gameplay camera (logs/vu1dump2, `dist/vu1_replay.exe`
+ tools_py/gif_packets.py): 108 of 1878 kicked vertices have q < 0, all from four consecutive
frames of ONE object rendered through the 0x1b50 command-list entry (8 triangles, two texture
passes, tbp0 0x3621/0x3661 psm 8-bit, positioned at the player). Its command list is
b20 (vertex decompress: ITOF4 xyz + offset, ITOF15/ITOF12 normals/uv, ITOF0 colour) ->
0x1638 (per-triangle BACKFACE test: FMAND 0x10 on dot(cam - v, n), bit0 of the triangle record)
-> 0x4a8 -> 0xdf8 (transform, DIV Q = 1/w, NO near-plane clipping) -> 0xf90 (lighting) ->
0x1780 (emit: draws when bit0 && (bit1 || global word 39)) -> 0x22a0. The other 27 invocations
of 0x1b50 (a 60-vertex object every frame) and all 119 pc=0 runs are clean. The MAC-flag path
works as the manual says (traced with `PS2X_TRACE_VU_FLAGS=1`: the FMAND four instructions after
the FMAC sees that FMAC's flags). So the microcode is not clipping by design and the console must
never feed it this object in this state: the EE either culls it or gives it other data. Related
EE-side divergence found in the same run: the player stands at y = -132.9 (PCSX2: -126.26) with
x/z equal — the ground height from the collision grid differs by 6.6 units, and this object
(at the player) straddles the near plane. Next: find the EE submitter of the 0x1b50 list with
commands [52,3,50,4,8,20,24,...] (the JR table at 0x1ba0 indexes 340(vi14) words) and its
bounding/visibility test, and chase the ground-height difference (collision query FUN_002d49c0 /
FUN_002d2890 vs PCSX2's spawn image logs/parity/spawn_pcsx2.rdram).

## 2026-09-08 22:30 (local) — title-screen labels: the EE FPU chops; the game thread now rounds toward zero
The garbled LOAD GAME / NEW GAME / ONLINE labels (user report ~21:00) are 128x32 CT32 images the
EE composes and uploads (host->local to dbp 0x3207/0x3247/0x3287/... dbw=2), so the GS was drawing
what it was given; the CPU rasterizer garbles them in every run, the GL backend only when its
texture cache happens to re-decode (the cache made earlier runs look clean). The 8x8 blocks in the
logo's colours are glyph cells fetched from the wrong source: an index computed from a float.
The game writes FCR31 = 0 at entry (`ctc1 $zero`), PCSX2 truncates CVT.W regardless and runs the
EE FPU and VU in "Chop/Zero" rounding, and our host math rounded to nearest — the old
round-to-nearest cvt.w had masked the difference; today's hardware-correct truncating cvt.w
exposed it. Test: `PS2X_EE_ROUND=chop` (host rounding toward zero on the game thread) on the CPU
backend renders the labels correctly (logs/parity/runs/title_chop). Now the default in
ps2_runtime.cpp (game thread `fesetround(FE_TOWARDZERO)`; `PS2X_EE_ROUND=nearest` restores the
old mode). Expect other small parity shifts from this: every EE/VU0 float result now truncates.

## 2026-09-08 21:40 (local) — object geometry appears (XGKICK copied at kick time); behind-camera triangles and a title-screen regression remain
**Root cause of the missing objects.** With `PS2X_GS_TRACE_CMDS` armed at the gameplay camera
(new `PS2X_TRIGGER=lo:hi` on the first PS2X_PEEK word, `trig` mode of the GS/VIF traces), every
object triangle (1700 per frame, one texture, trees/bushes/characters) reached the GS as three
identical vertices at the GS origin with z=0xFFFF: the VU1 program re-templates its output buffer
right after XGKICK, and the per-cycle PATH1 model (one qword per two cycles while the program
runs on) still had the transfer in flight. Copying the packet at the kick (PCSX2's default; commit
089516b, `PS2X_VU1_XGKICK_CYCLE_EXACT=1` restores the old model) brings the objects back: trees
with foliage, and mission_s13's last frame is the road-through-trees scene of the golden run.

**Still wrong in-mission:** ~1/3 of the world triangles have q < 0 (vertices behind the near
plane, z wrapped to ~0xFFxxxx) and straddle the screen as giant sky-coloured polygons. The
microprogram (dumped with `PS2X_VU1_DUMP=<dir>[:count]`, disassembled with tools_py/vu1dis.py)
clips against the near plane geometrically: it forms per-vertex w sums with MULAx/MADDAy/MADDz,
reads the MAC sign flags four instructions later (`FMAND vi, 0x20` = z lane, `0x10` = w lane) and
branches into an edge-clipping path (DIV Q, vf26w, vf25w). Our MAC flag layout and the 4-cycle
flag latency match the manual on inspection, so the offline replay is the next step:
`dist/vu1_replay.exe <dump> --out p.pk` runs a dumped program through the runtime's interpreter
(registers restored from the dump), `tools_py/gif_packets.py p.pk` lists the kicked vertices and
their q sign. The three programs dumped so far (entries 0x0 / 0x1b50 / 0x33c8 of one 16 KB
microprogram) produced no negative q; a 150-program dump run is queued.

**Title-screen regression (reported by the user 21:0x):** since the XGKICK change the main menu's
LOAD GAME / NEW GAME / ONLINE labels render as teal/white noise (mission_s12..s14 s05/s06;
mission_s9, same copy mode via the env var, was clean once). Suspected the GIF arbiter's
priority sort (vendored: stable-sorts all queued packets PATH1 < PATH2 < PATH3 at drain, so a
PATH1 packet overtakes PATH3 uploads queued by the same DMA chain); it now processes packets in
submission order (`PS2X_GIF_PRIORITY_SORT=1` restores the sort) — the text is still garbled, so
that was not it. A/B run with `PS2X_VU1_XGKICK_CYCLE_EXACT=1` on scripts/parity/title_only.txt
in progress. Harness: drive.py `until(x0,y0,x1,y1)+<delay>:BTN` presses until the box shows the
briefing's highlight tint (G-R > 25), on settled screens only, and `long` waits up to 150 s.

## 2026-09-08 17:30 (local) — game state matches PCSX2 in-mission; the render does not (downstream of the EE)
With the SQRT.S fix the whole mission intro replays PCSX2's path: fly-by camera at (-3787,-109,..)
with the same rotation rows, spawn camera (939.4, 3.4, -843.6) / player (939.4, -131.7, 833.3) vs
PCSX2 (939.8, 8.3, -841.3) / (939.4, -126.3, 832.2), second fly-by, hold at (-3328, 282), then the
gameplay camera. The camera object's derived matrices (+0x2f0 world matrix, +0x330 view-projection,
+0x370 projection, +0x3b0 screen: `PS2X_PEEK="*0x488de8+0x2f0:64"`) equal PCSX2's to four
decimals. The picture at that camera is still a few giant flat polygons and sky (mission_s5/s6)
and the *pre-change* run of this morning (mission_z2, 06:54) shows the same frames, while the
online-match urban map rendered correctly on 2026-09-07 (logs/parity/online/match/A_18_hold05.png)
— so this is not a regression of today's float work but a mission-map rendering fault
downstream of the EE: VIF1 unpack, VU1 program or GS. Suspects in order: VIF unpack formats the
urban map does not use (STROW/STMASK/mode offsets for terrain chunks), a VU1 micro path, GS depth.
Discriminators prepared: `PS2X_GS_TRACE_CMDS=t<sec>` (per-batch vertex count + XYZ extents at
host time), `PS2X_TRACE_VIF=t<sec>` (UNPACK format/mode/mask/row histogram), and a
`PS2X_GS_BACKEND=cpu` mission run (GL vs reference rasterizer).

**VU1 interpreter: 158 -> 111 ns/cycle (commit 4960120).** A mission-only host profile
(diff of two PS2X_HOST_PROF dumps, logs/hostprof_mission.txt) put calculatePairReadyCycle at
20%, commitReadyPipelines at 20%, run() 8%, long-double FMAC rounding ~6%, and 15% in DLLs
outside the exe (unsymbolized). The commit scan now early-outs on an "earliest pending cycle",
the readiness scan on a "latest ready cycle", VI reads walk a bit mask, decoded pairs are served
by reference and XGKICK copies a qword at a time. Still ~700 ms of every host second in VU1 at
5 M cycles/s: the next step for frame rate is the fast (non-cycle-exact) path or a recompiler.

## 2026-09-08 16:15 (local) — ROOT CAUSE of the exploding actors: SQRT.S read the wrong register
The recompiler emitted SQRT.S with the *fs* field as its source. On the EE, `sqrt.s fd, ft` reads
**ft** (fs is zero in the encoding) and `rsqrt.s fd, fs, ft` is fs / sqrt(ft). Every square root
in the game therefore computed sqrt($f0) — usually 0.0 — e.g. the axis-angle length in the
quaternion builder FUN_003067b0 (`sqrt.s $f21, $f1` -> sqrt($f0) = 0), so sin(0)/0 saturated to
FLT_MAX and the actor orientations became (2^64, 2^64, ...). Found by the float traps
(`PS2X_FPU_TRAP`): the site divided 0 by 0 right after a `length == 0` guard that could not have
been skipped, and the generated code showed `FPU_SQRT_S(ctx->f[0])` for an instruction the
disassembler had printed as an unknown `c1 0x10544`. Fixed in ps2xRecomp/src/lib/fpu_translator.cpp
(SQRT uses ft; RSQRT takes fs and ft) and FPU_RSQRT_S became two-argument. VERIFIED 16:30
(logs/run_20260908_162132.log, screens logs/parity/runs/mission_s3): the teammate quaternion
node 0x1a83cb0 now holds unit-quaternion values (1.0, 0.707, 0.706) instead of +/-FLT_MAX, the
0x306854 trap site is gone, the collision free list stays non-empty (0xdf3538) and the player
holds y = -120 on the terrain instead of falling. The camera follows the mission intro fly-by at
(-3787, -109, ...) exactly where PCSX2's trace has it at t=202-207 s. The fly-by had not finished
by the end of the 320 s run because the game still runs at a few frames per second (VU1
interpreter); the gameplay camera (939, 8.3, ...) needs a longer run.
Along the way the FPU comparisons now flush denormals (hardware behaviour; not the cause here).

## 2026-09-08 13:30 (local) — the fall through the floor: collision grid collapse traced to exploding actor orientations
Guest-memory comparison against a PCSX2 savestate (`tools/pcsx2` + PINE work locally; the state
file's eeMemory.bin is zstd inside a zip, `logs/parity/spawn_pcsx2.rdram`) versus our
`PS2X_RDRAM_DUMP` images:
- After the level load our collision grid (world+0x684: 36x25 cells, 8192-node pool, cells at
  +0x30, free list at +0x38) is identical to PCSX2's: 3566 nodes, 1262 objects.
- At ~182 s the four squad-member collision nodes get rotation rows saturated to +/-FLT_MAX
  (translation sane), so `FUN_002d7580` inserts each into all 900 cells; the pool drains, the next
  insert links a null node and cuts the cell chain; the terrain leaves the grid, the ground probes
  return nothing and the player sinks (PCSX2 holds the player at y=-126.26, ours rests at -131.4).
  The camera runaway during the intro shots is the same objects (the camera follows them).
- The node matrix is copied from the actor's own matrix (`FUN_00315820`, called from
  `FUN_005483d0` at ra 0x549910); the actor's orientation quaternions (object+0x54/+0x5c and
  +0x74/+0x7c, class vtable 0x6691a0) jump from (-0.383, -0.924) to exactly 2^64 in every
  component. 2^64 == sqrt(FLT_MAX): a saturated maximum went through a square root, i.e. a
  division by zero happened on ours and not on the console.
- Census of saturated words: ours 798 at load / 1306 at rest, PCSX2 18. 33 heap objects of
  class 0x408330 (scene/bone nodes) hold 24 saturated matrix words each already at load.
- The EE FPU trap (`PS2X_FPU_TRAP=1`: divisions by zero, square roots of a saturated operand,
  with the guest pc) fired zero times in a full run, so the overflow originates in VU0 macro-mode
  math or a VU microprogram; traps for those are in the build being tested.
Tools added on the way (commit 91e7588): pointer-chain `PS2X_PEEK`, `PS2X_WATCH` word poller,
`PS2X_WATCH_HUGE` range scanner, `PS2X_HOST_PROF` sampling profiler, `PS2X_VU_STATS`,
`tools_py/parity/cam_poll.py` (PINE chains).

## 2026-09-08 10:30 (local) — intro movie seam fixed; in-mission camera diverges because the VU1 interpreter caps the game at 3 flips/s
**Movie seam (commit df9f8fe).** Render-target downloads wrote all 1024 texture columns back into
VRAM; past FBW*64 the page arithmetic lands in the *next* page row's first columns, so the black GPU
rows 64..96 of the movie staging buffer (FBW 10) overwrote frame rows 96..128 of page columns 0-5
after every upload — the x=384 seam on every intro-movie frame. Downloads now stop at FBW*64.
Found with a per-command shadow-VRAM probe (PS2X_GS_TRACE_PRESENT=-1 arms it from the first
seam-like decode; negative values count from the first movie block upload).

**EE FPU / VU float semantics (uncommitted, needs `./build.sh recomp`).** The generated code used
IEEE math; the EE FPU and the VUs have no infinities or NaNs (overflow saturates to +/-FLT_MAX, x/0
gives +/-FLT_MAX, denormals flush to 0, SQRT takes |x|). FPU_* macros, the DIV/RSQRT emitters, the
PS2_V* macros and the VDIV/VSQRT/VRSQRT emitters now saturate (VRSQRT also ignored its numerator
register before). The archived menu camera showed the effect: fog coefficient
`255 - near * (-255 / (far - near))` with far == near is 255 on the PS2 and NaN under IEEE.

**In-mission picture: camera, not renderer.** PCSX2 (tools/pcsx2, PINE port 28011) runs the
mission script fine — `tools_py/parity/cam_poll.py` reads the camera object (`*(0x488de8)`, static
scene 0x4887c0 + 0x628) over PINE while `drive --target pcsx2` runs; ours uses
`PS2X_PEEK="*0x488de8+0x320:3"` (peek now dereferences pointers). Fog block, frustum, view matrix
and spawn position match PCSX2 word for word at spawn. Then ours lets the camera height decay
(8.8 -> 3.1 in one second; PCSX2 holds 8.35) and the position grows exponentially to +/-FLT_MAX for
~22 s (the scripted shots), returns to spawn, and the later scripted move happens on both sides.
The sky-dome-from-below frames are that runaway camera.

**Root cause of the divergence: frame time.** `FUN_003aff30` (flip) reads T0 as the frame time and
resets it; the camera update `FUN_002998f0` integrates with it. Per-second flip counts (call trace
on 0x3aff30) are 2-16 in the mission (PCSX2: 60). A host-level sampling profiler
(`PS2X_HOST_PROF=<ms>` + `tools_py/hostprof_symbolize.py`) puts ~80% of the game thread in the
VU1 interpreter's cycle-exact bookkeeping (`calculatePairReadyCycle`, `commitReadyPipelines`,
long-double FMAC rounding); `PS2X_VU_STATS=1` measures 4-7 M VU1 cycles/s at 120 ns/cycle,
i.e. ~1 M VU1 cycles per game frame, 0.5-0.8 s of host time per second. Ruled out on the way: the
scratchpad slow store path (fast path added anyway), the GS command queue (no backpressure),
guest-clock overhead. A 60 fps mission needs ~16 ns/VU1 cycle: a VU1 recompiler/JIT, not
interpreter tuning (2-3x at best from mask-based hazard checks and an early-out commit).

**Interim fix in progress:** guest time must exclude the host time spent in the VU1 interpreter
(`ps2GuestClockExcludedNs`, subtracted in `EeScheduler::accountCycles`), so the game sees ~1/60 s
per frame and runs in slow motion instead of integrating a 300 ms step (a per-gap cap did nothing:
the interpreter runs in ~1000-cycle slices). Result: see the next entry.

## 2026-09-08 (local) — our exe completes the SCERT handshake with Horizon; menu movie merged
Two fronts landed since the 22:40 entry.

**Menu background movie (merged to develop, commits 8c01711/1f15173/db44f62).** The runtime already
had an FFmpeg-backed sceMpeg HLE; two protocol gaps (sceMpegCreate not zeroing the libmpeg work
buffer, and GetPicture parking the only feeder thread) stopped every movie. Fixed in
Kernel/Stubs/MPEG.cpp. Main-menu parity 81.0 -> 98.8; the Sony/intro/cinematic movies play too.
Boot now has two more screens than before, so the online script uses five boot presses.

**Exe online netstack (uncommitted until this entry's commit).** From black-screen after the network
IRX loads to a completed SCERT TCP handshake with the real MUIS (10071). Layers:
- SIF sreg handshake echo (socom2_SifSendCmd) and msifrpc init/bind/call/unbind HLE.
- eznetcnf/eznetctl IOP service (ps2xIOP/src/modules/eznetcnf.cpp): one "Setting 1" combination,
  interface always up. DNAS tick (FUN_002cc670) reports done.
- libnetb (socom2_libnetb.cpp): the simple RPCs (sceInetCreate/Open/Recv/Send/Name2Address/poll/
  interface events) and the libnetb_ex ring path (FUN_002472c8/74f8/7738/7d30/7fe8/79b8/7bd8)
  replaced by host Winsock (socom2_hostnet.cpp). Contract: docs/research/10-libnetb-rpc.md.
- rt_crypt on the host (socom2_crypto.cpp): 512-bit RSA modexp (FUN_0062b948), SHA-1 prefix
  (FUN_0062eec0) and the RC4 variant (FUN_0062a638/5a8/720/7c8). The fixed client keypair
  (socom2_rsa_key.h) was regenerated as a FULL 512-bit modulus: a 511-bit N let the server's
  512-bit RC4 session key exceed N and broke the CONNECT_TCP decrypt.
Result: the exe resolves the retail hostnames to PS2X_SOCOM2_SERVER (default 127.0.0.1), connects
TCP to MUIS, the server accepts CONNECT_TCP and sends CONNECT_ACCEPT + CONNECT_COMPLETE, the
client sends the LobbyExt/0x03 universe query and shows SELECT UNIVERSE with the Horizon universe
and its news (2026-09-08). Later the same night the exe logs in (MAS), reaches the lobby (MLS),
joins Channel 1 and hosts a game: GAME LOBBY with a live DME world (TCP + aux UDP), driven by
`tools_py/parity/online_login_ours.py --existing --host`; parity 98-99 vs the PCSX2 golden set.
**02:40 — a full online match between two instances of our exe** (`online_match_ours.py`: A hosts,
B joins and switches team, both READY → VIGILANCE/SUPPRESSION → in mission; Horizon world
WorldStaging → WorldActive). The second instance uses PS2X_WINDOW_TITLE / PS2X_MC_DIR /
PS2X_SOCOM2_UDP_SHIFT. M5 (online lobby + match against our own server) is reached. The earlier stall was the frozen COP0 Count: `mfc0 Count` reads
ctx->cop0_count, which nothing advanced, so SCE-RT's clock stayed at 0 and the connected-state
send gate (30 ms since the last flush) never opened; the runtime now refreshes cop0_count from the
host steady clock at 294.912 MHz on every syscall and scheduler switch-in.
Driver: `python -m tools_py.parity.drive --target ours --script scripts/parity/launch_to_online_ours.txt`
with the Horizon stack up (no dns_stub needed; the exe resolves internally).

Reference: tools/reference/reCOM (git-ignored) and docs/research/11-recom-applicability.md map
~70 of our FUN_ addresses to SOCOM 1 / GameZ names.

## 2026-09-07 22:40 (local) — our exe reaches LOGIN TO SOCOM II ONLINE (netstack bring-up started)
ONLINE on our exe used to go black after loading the network IRX set. Three layers were missing:
- SIF sreg handshake: msifrpc's init sends SETSREG (0x80000001) to the IOP and spins on the EE
  sreg table until the IOP module echoes it. `socom2_SifSendCmd` mirrors the write (sreg table
  at 0x1da6c0). `sceSifGetSreg` is not stubbed — it is the game's own code reading that table.
- msifrpc (multi-SIF RPC, SCE-RT's transport for libnetb, service 0x80001201): init/bind/call/
  unbind (FUN_001bcd80/1bd050/1bd320/1bd200) are replaced by host handlers; the call is answered
  synchronously by `socom2LibnetbCall` (for now every fno logs and returns -1). EE ABI: args 5-8
  in t0-t3.
- eznetcnf/eznetctl (0x75499128/0x75488909) are a new ps2xIOP service
  (ps2xIOP/src/modules/eznetcnf.cpp): one "Setting 1" combination, interface always connected.
- DNAS: FUN_002cc670 bound to ret0 (the pnach's `jr ra` equivalent).
The login screen appears; it still says "No Network Adaptor detected" because libnetb fno 8
(interface list) / fno 9 (interface control) return -1. Reverse-engineering of the libnetb RPC
contract (LIBNETB.IRX decompiled to game/analysis/LIBNETB.IRX.decomp.c, spec going to
docs/research/10-libnetb-rpc.md) is in progress; the socket layer (Winsock) comes next.
Driver: `python -m tools_py.parity.drive --target ours --script scripts/parity/launch_to_online_ours.txt`.
Reference: tools/reference/reCOM (git-ignored clone of NotEnoughPhotons/reCOM, a SOCOM 1/2 +
GameZ decomp with demo-disc symbol names) for naming engine functions.

## 2026-09-07 21:10 (local) — ONLINE MATCH: two PCSX2 clients play VIGILANCE on the local Horizon stack
`python -m tools_py.parity.online_match` logs two retail clients in (socom / socomb), A creates a
game (Medley play list), B joins it, B switches team, both press READY and the match launches:
both screens show VIGILANCE / SUPPRESSION in-game with the round timer (logs/parity/online/match/,
A_18_hold05 and B_20_hold05). DME world with two clients, TCP + aux UDP, broadcasts flowing.

Fixes since the 18:45 entry (commits a2fdc45, 1ce3047, and the match commit):
- Lobby/0xEC channel list request + 0x70-byte 0xED entries (briefing rooms).
- CreateGameRequest1: Attributes optional (1.50 sends 0xD0 bytes).
- Game.OnWorldReport(MediusWorldReport0) copies GameStats — the 1.50 client keeps map/rounds
  there; without it the joiner shows "unknown" and refuses to join.
Second client plumbing (tools/pcsx2_b, git-ignored; templates in scripts/parity/pcsx2/):
- robocopy of tools/pcsx2 with PINESlot 28012, Slot2 memory card disabled.
- Its own savestate 5 of the LOGIN screen made by booting it (main menu → ONLINE): a state copied
  from the other install re-probes the card on load and drops the network configuration.
- Its card already holds A's persona, so the persona list needs Up, Cross, Down, Cross.
- Two guests on one host adapter both bind host UDP 3658/3659 (PCSX2 Sockets mode) and DME replies
  went to the wrong socket; a B-only pnach changes `li a0,0xE4A` at 0x620678 to 3660. (The
  host-only adapter alternative fails: Windows strong-host routing, no admin for weakhost.)
Still unhandled by Horizon and harmless so far: Lobby 0x86, 0xB2, 0xCE, 0xEF, LobbyExt 0x08.

Next: our exe. The PS2 side is now fully characterised (every request/reply the 1.50 client needs
is in server/logs); bring the recomp's inet/netcnf HLE up (Winsock) so socom2.exe reaches the
same screens, scored by the harness against these PCSX2 captures.

## 2026-09-07 18:45 (local) — online: a PCSX2 client logs into Horizon and reaches the SOCOM II ONLINE lobby
Priority is online play (user, 21:30 entry in HANDOFF). Result tonight: the retail client running in
PCSX2 goes LOGIN → LOCATING UNIVERSES → SELECT UNIVERSE ("SOCOM II Local", news text) → CONNECT TO
SOCOM II (persona/password typed on the on-screen keyboard) → ACCOUNT LOGIN → USER AGREEMENT →
SOCOM II ONLINE lobby with the SERVER NEWS popup from Horizon. Screens: logs/parity/online/login/.

Plumbing (all under tools/pcsx2, git-ignored; templates in scripts/parity/pcsx2/):
- DEV9 Sockets on the Realtek adapter, InterceptDHCP, manual DNS = 192.168.2.10 (host LAN IP).
  PCSX2's [DEV9/Eth/Hosts] table was not honoured, so `tools_py/parity/dns_stub.py` answers the
  game's hostnames (socom2-prod[.muis].pdonline.scea.com, gate1.*.dnas.playstation.org) on UDP 53.
- DNAS bypass pnach (unconditional; labelled groups are opt-in and were skipped).
- Memory card recreated with mymcplus (the original was unformatted) and a saved network config.
- Horizon configs advertise 192.168.2.10, not 127.0.0.1 (the guest cannot reach loopback).
- Savestate 9 = the LOGIN TO SOCOM II ONLINE screen. Only this state is usable: states saved after
  any network traffic restore with a stuck SMAP transmit ring (BD_TX storm) or dead input.

Protocol fixes in Horizon (commit e990033), found by reading the 1.50 client library in the decomp:
- Universe query is LobbyExt/0x03 → ExtraInfo list LobbyExt/0x04 (0x338 bytes) **and** a
  UniverseNews reply (Lobby/0xC9); completion needs InfoType == accumulated bits (DAT_006561b0).
- AccountLoginResponse must be exactly 0xC4 bytes: NetConnectionInfo's 2-byte alignment pad is
  now unconditional (the PS2 client sends no CLIENT_HELLO, so Horizon assumed version 108).
- The client's VersionServer request (Lobby/0x86) can stay unanswered: no game callback.

Method that worked: handler ids are assigned sequentially per class by FUN_0063c8a0, so id N of
class 1 is the N-th registration after line 564046 of the decomp; the handler returns the expected
byte count. Reading the slot table over PINE (e.g. 0x686f14) gives the live ids.

Unhandled by Horizon so far (client still proceeds): Lobby 0xB2 FileListFiles (WeapProfile_1.dat),
0xEC ChannelList_ExtraInfo0 (lobby room list — needed next), 0xEF LadderList_ExtraInfo0,
LobbyExt/0x08 GetBuddyInvitations, Lobby 0x86 VersionServer.

Next: close server news → BRIEFING ROOMS (channel list) → create/join a room; then a second
PCSX2 instance (separate ini/memcard/PINE port; the "never two instances" rule is about our exe
sharing logs, but two PCSX2 processes also need distinct DEV9 MACs) and a match through DME.

## 2026-09-07 20:00 — roller renders; mission renders textured; report ours_e
After un-stubbing libvu0 (commit fb97a7b): the main menu shows the 3D roller with LOAD GAME /
NEW GAME / ONLINE (menu 79 → 81; the MENULOOP.PSS movie background is still black), popup 99.6,
select rank 99.0, briefing 96.4, and the mission frame is now textured (rock walls, timber) instead
of flat grey — the same wrong-order matrix maths had been feeding the mission's transforms.
`scripts/parity/align.json` shifted by one step (our side now captures an extra early frame).
Still open on the shell: the menu movie background; the controller-configuration screens (our
step after Select Rank is a black frame where the original shows two screens with 3D controller
models). Mission: camera/HUD/movement not yet looked at.

## 2026-09-07 19:30 — main menu roller: culled by a wrong clip matrix from the libvu0 HLE
Chain of evidence (all at the real main menu, two presses; the earlier "menu" numbers in this file
were taken one press too late, on Select Rank): the roller model loads (23 mesh parts under a
type-2 node with 12 leaf children, bbox ±13.7), is added to the scene (`FUN_0031f240`) and is handed
to the node draw `FUN_0033b110` every frame — identical node/scene state to PCSX2 read over PINE.
The children traversal `FUN_003389c0` then asks the frustum test `FUN_00290c30` and gets 2
("fully outside") every frame, so no leaf part is ever submitted (`xgkick=0` at the menu). The
camera object (static path `0x4887c0+0x628`) matches PCSX2 word for word except the clip matrix at
+0x330: rows 0-1 equal, ours rows 2-3 = `[-320 0 319 1] / [0 0 0.40 0]` vs PCSX2
`[0 0 -1.004 -1] / [-457 0 320.9 320]`. `FUN_00294070` builds it as
`sceVu0MulMatrix(clip, proj, viewInv)` and PCSX2's result is viewInv·proj, so the HLE stub in
`Kernel/Stubs/VU.cpp` multiplies in the wrong operand order (its "ViewScreenMatrix" and friends are
guesses too). Fix: stop hand-emulating libvu0 — the 29 `sceVu0*` stubs are removed from
`recomp/socom2.toml` and the uncovered entry points forced in `recomp/extra_functions.txt`, so
Sony's own VU0-macro code runs (safe now that vf00 writes are ignored). Recomp rebuild pending
verification: popup placement must stay, the roller and the controller-config models should appear.
Side note: camera +0x130 holds NaN on ours vs 255 on PCSX2 (a clamp/lerp path), unexplained.

## 2026-09-07 18:10 — mission thread no longer dies (merged Ghidra range)
With `recomp/merge_ranges.txt` folding 0x510970-0x5109a8 (the while-loop whose body Ghidra had
left in a gap between a "thunk" row and the loop condition), the 400 s mission run shows
`MissionTick` #1560 at 305 s and zero `[guest-branch:missing-target]` (it used to halt ~30 s into
the mission, around tick 660). Geometry keeps flowing (`xgkick` 1.5M by frame 2685) and the frame
stays a flat-shaded blue-grey world from a fixed camera: no textures, no HUD, no visible camera
motion yet — those are the next mission items once the shell screens are scored ≥90.
`tools_py/find_escaping_branches.py` found only two functions with this split-loop shape; the
other (0x534c4c) is a real multi-entry function and is left alone.
Caveat: two 400 s runs of this build overlapped by accident (a background wait loop launched
one 13 s before the hand-started one: `run_20260907_154947.log` and `_155000.log`). Both show
zero `missing-target` and ticks continuing to the end (#1800 / #1560), which is a control-flow
result and holds; their frame-rate and counter values are skewed and should not be quoted.

## 2026-09-07 17:00 — the shell looks like the original (text, placement, palettes fixed)
Parity report `ours_d` (docs/parity/REPORT.md): memory-card popup 99.6, select rank 99.2,
mission briefing 96.2 (all text, tabs, fireteam loadout, typewriter effect), main menu 79.1
(soldier background art and the roller captions still missing), warning screen 78 (animated;
capture timing). Four fixes, each verified with the popup screenshot and then the full run:
1. **vf00 writes** (recompiler, `instruction_translator.cpp`): the game's `qmtc2.i $a0,$vf0` /
   `vaddx vf0,vf0,vf0x` / `lqc2 $vf0` idioms are no-ops on hardware; we executed them and every
   `vmaddw … vf0w` translation term went to garbage — all 2D elements sat at the origin.
2. **Face culling** (`gs_gl_backend.cpp` setupDrawState): raylib's rlglInit enables GL_CULL_FACE
   and the GS backend never disabled it; glyph sprites (second vertex above the first) have the
   opposite winding and were culled. Diagnosed with the new `PS2X_GS_GL_DEBUG_PSM=<psm>` print
   (state, bound texture texel, region readback before/after the draw: "0 of 216 pixels changed").
3. **CSM1 CLUT swizzle** (GL): 4-bit palettes are 8x2 blocks, address bits 3/4 swapped; the GL
   resolver read a linear strip, so the bright half of every 4-bit palette was wrong (dim text).
   The CPU rasterizer already had `swizzleClutIndexCSM1`.
4. **CPU sprites** swap texcoords with corners (text was flipped on the reference rasterizer).
Also: `recomp/merge_ranges.txt` (+ `fix_ghidra_csv.py`) folds the split loop 0x510970-0x5109a8
that killed the mission thread; recomp rebuild pending verification.
Remaining shell gaps (next by score): main menu background art + roller captions; the
controller-configuration screens (our s04 is black where the original shows two screens — likely
the same class as the menu art); the text-only title cards flash past on our side (not captured);
glyphs render slightly heavier than the original (shadow pass alpha?).

## 2026-09-07 — mission draws; parity harness is the grade; two systemic UI bugs found

**Mission (M4):** the "renderer submits nothing" blocker was thread starvation, not rendering.
Thread 2 is the priority-4 auto-exposure thread (`FUN_003b1dd0`) which, once a mission is up, reads
~176 framebuffer pixels per pass with `FUN_003b24c0` (GS local→host through the VIF1 reverse FIFO).
The runtime has no reverse-FIFO path, so each read spun to its 16M-iteration timeout (~0.3 s) and
the main thread got one tick per minute. `FUN_003b24c0` is stubbed at recompile time
(`socom2_LumReadPixel@0x003B24C0`, mid-grey pixel). Result: `MissionTick` ~20/s after the load,
geometry counters climb (xgkick 4k → 700k), flat-shaded world polygons and a night sky on screen —
the first in-mission frames. ~30 s in, the main thread dies at 0x510978: a list-search loop whose
head Ghidra split into an 8-byte "thunk" row, so the backward branch becomes an unwind to an
address no function owns (`[guest-branch:missing-target]`). `tools_py/find_escaping_branches.py`
lists every such branch (35k in 1.1k functions, mostly harmless case chunks); the fix is to merge
rows whose branch target is not another row's entry. Queued behind the shell parity work.

**Parity harness (the new grade, see HANDOFF "The grade"):** `tools_py/parity/` — `winshot.py`
(PrintWindow capture, no focus), `keys.py` (posted keys to PCSX2's Qt window or our raylib window,
both accept them without focus), `drive.py` (one step script for both sides, `next` = wait for a
new settled screen, screens labelled by step index), `compare.py` (score + side-by-side diff +
`docs/parity/REPORT.md`), `pine.py`/`addresses.py` (PCSX2 PINE memory reads, escalation aid),
`montage.py`. PCSX2 2.8.1 in `tools/pcsx2` with PINE on 28011; its card was formatted offline with
`mymcplus` so the save prompts do not loop. First report (`ours_a`): 6 of 20 golden screens have a
matching screen on our side; our sequence skips the loading screen, the "No SOCOM data" notice and
the three text-only title cards (all black), draws the main menu as logo-only, and reaches the
briefing. `scripts/parity/align.json` maps golden steps to ours by content until the sequences
converge.

**What the first side-by-side proved (GS command trace at the memory-card popup):**
1. **Text is submitted, not missing.** Glyphs are tiny textured sprites (4-bit PSMT4 font page
   512x128 at tbp 0x3bf7, CLUT at 0x3bf3) drawn with the second vertex *above* the first. The CPU
   rasterizer drew them vertically flipped because `DrawSprite` swapped the corner coordinates
   without swapping the texture coordinates — fixed (text now upright with `PS2X_GS_BACKEND=cpu`).
   The GL backend still draws nothing for them (decode of the 4-bit page is correct — verified with
   `PS2X_GS_DUMP_TEX`; the difference from the 8-bit box that does draw is not yet understood).
2. **Every 2D element is drawn at the origin.** The popup box is submitted at (0,0)-(340,100) and
   both slot buttons at (0,0); the element drawer (`FUN_003643b0`) transforms its local rect through
   the node matrix with `FUN_00308640`, whose translation term is `vmaddw.xyz vf9, vf7, vf0w`. The
   recompiled game *writes vf00*: `qmtc2.i $a0,$vf0` (an interlock idiom, e.g. 0x30702c/0x3076b4
   right next to the transform helper), `vaddx vf0,vf0,vf0x` and `lqc2 $vf0,…($k1)`. On hardware
   vf00 is the read-only constant (0,0,0,1); we clobbered it, so every translation multiplied by
   garbage. Fix in `instruction_translator.cpp`: writes to vf00 are emitted as comments (recomp
   rebuild in progress at the time of writing — verify with the popup: box centred, logo centred).

**Docs/process:** HANDOFF gained "The grade" (parity loop, rules, escalation triggers) and gotchas
7-9; spec `docs/superpowers/specs/2026-09-07-parity-harness-design.md`, plan
`docs/superpowers/plans/2026-09-07-parity-harness.md` (with the design simplification amendment).


## Milestone board (from the design spec)
| # | Milestone | State |
|---|---|---|
| M1 | Fork + toolchain: merged ELF recompiles, runtime links, `socom2.exe` runs crt0→main | **done** |
| M2 | Loader → game entry → engine init without unimplemented-instruction faults | **done** — engine runs its main loop; audio init + DBCMAN reached |
| M3 | Legal/intro screens + main menu render, pad works, UI sounds | **done for navigation** — first boot runs to the main menu at 60 fps, input drives every shell screen; button captions and the 3D roller still do not draw |
| M4 | Single-player mission playable | **in progress** — the Albania 5-1 mission loads from the briefing screen and its engine, AI and mission scripts run at 60 fps; the in-mission renderer submits no geometry |
| M5 | Online: login/lobby/room on local Horizon, second client joins | server side ready; client side not started |
| M6 | Portable package | not started |

## What works today
- Full plaintext game code recovered (FTSCore.bin @0x1e7000, ZSealEtc.bin @0x4c5380; build id "SOCOM 2 r0001 17:22:21 Oct 11 2003"), see `docs/research/05-code-package-and-harness.md`.
- `./build.sh recomp && ./build.sh runtime` produces `dist/socom2.exe` (~160 MB, 14.7k generated functions). Build cycle: 10 s recomp, ~15 min full compile, ~3 min runtime-only.
- The exe boots the loader: memory-card check (DBCMAN/MCSERV HLE), skips the DNAS decrypt (override), restores the overlays after the loader's bss wipe, runs both overlays' static constructors, jumps to the game entry (0x4c53c0 → FTSCore main 0x1e7040), reads the ISO volume descriptor and builds the engine's disc TOC from the ISO (`IoPaths.cdImage`).
- Diagnostics: `PS2X_PC_SAMPLER=<s>` prints live guest PC + thread table (pc/ra/sp/status/wait) every s seconds; the runner window has a built-in debugger UI (CPU/Threads/Kernel/RPC/GS tabs).
- PCSX2 2.8.1 + BIOS (`tools/pcsx2`) boots the ISO; reference log in `logs/pcsx2_reference_boot.txt` (IRX load order, timings).
- Horizon Private Server runs locally for app id 10472 (`server/README.md`, `server/start-servers.ps1`; simulated DB, account socom/socom; the game's baked-in RSA key matches Horizon's).
- 989snd IOP service first version (`ps2xIOP/src/modules/snd989.cpp`, protocol in `docs/research/06-989snd-rpc.md`): answers all RPCs with correct framing, models banks/voices/streams, serves stream-safe CD reads; no audible output yet (host backend is libsd-only).

## 2026-09-06 02:15 — the first single-player mission loads and runs (M4 opened)

Driving the pad script `8:CROSS,12:CROSS,16:CROSS,20:CROSS,24:CROSS,30:DOWN,32:DOWN,34:DOWN,
36:DOWN,38:DOWN,41:CROSS` now walks the whole single-player entry: first boot → main menu →
NEW GAME → dlgSelectRank → dlgControllerPresetsNewGame → dlgControllerPresetsRG →
dlgAlbaniaCinematic → **dlg_Brief_Alb51** (the Albania 5-1 briefing, which draws its real
photo panels) → five DOWN presses move the briefing selection from `overview_button` to
`deploy_button` → CROSS fires `OnDeployActivate` → `LoadMission` → `LOAD_SCREEN` → the mission's
own systems register (`CClutterAnimManager`, `diTick`, `Mission`, `ParticleTick`, `UnitTick`,
`ai_pre_tick`, `entity_pre_tick`, `weapon_pre_tick`) and the level's AI scripts start
(`Supply1-4_start`, `Informant_start`, `Sniper1/2_start`, `Alarm1-4_start`, `PatrolWatch_start`,
`set_iris`, `otc_init`). Zero `[guest-branch:missing-target]`, and the engine holds 60 fps.

Four fixes got there, in order:

1. **The EE dispatcher mistook a scheduler unwind for a return** (commit 2acef9c).
   `dispatchGuestBranch` decided "the callee returned" by comparing `ctx->pc` with the entry pc it
   dispatched to. A callee that leaves through a scheduler checkpoint while its pc still equals its
   own entry address is indistinguishable that way, so the caller resumed with the *callee's*
   registers. That is what killed the EE thread when dlgMenu loaded: the 2D-node lookup
   `FUN_00315a80` called from `Add2dNode` (`FUN_0036ab20`) came back with s1 = 1 and the caller
   dereferenced `screen+0x60` through `0x1` → `missing-target target=0x14 ra=0x36abc0`. The runtime
   now carries an explicit unwind flag (`markDispatchUnwind` / `clearDispatchUnwind`) that
   `eeCheckpointDue`, the non-call path and the missing-target path set and the scheduler clears
   before every dispatch. 5 of 5 runs reach dlgMenu with all 17 of its controls created.

2. **Interrupt handlers ran on the interrupted thread's stack** (commit 3eb4285).
   `AddIntcHandler`/`AddDmacHandler`, `SetAlarm` and `sceGsSyncVCallback` registered the *caller's*
   sp as the handler's sp, so a handler firing later trampled live frames of whatever that thread
   was doing. They now pass sp = 0, which makes the scheduler allocate its per-(thread, depth)
   invocation stack — the same stack every other invocation kind already uses. This reduced the
   dlgMenu crash rate but was not its root cause (that was item 1); it is still a real bug fixed.

3. **136 function bodies Ghidra never listed** (commit 1754184). `tools_py/find_gap_functions.py`
   walks the gaps between CSV function ranges and reports every gap whose body contains `jr $ra`,
   skipping anything `socom2.toml` stubs. A register-dispatched call into one of these found no
   recompiled target and silently did nothing (gotcha 1). The 4-instruction leaf at 0x346300 was
   hit during "new game" and ended the run. Same commit: `ControlFlowEmitter::emitStaticJump` was
   emitting `goto label_X` for a JAL whose target is one of the function's own entry points, so a
   self-recursive call ran in the caller's host frame and its `jr $ra` returned out of the host
   function — 97k scheduler unwinds in a single 24 s menu run, all from the rdr tree search
   `FUN_0032f0e0`. A JAL is now always emitted as a call.

4. **Six merged Ghidra ranges whose second function is called by pointer** (commit 316dafd).
   `tools_py/find_interior_functions.py` looks inside every CSV range for a `jr $ra` + delay slot
   followed by more code, and keeps the boundary only when that address is actually referenced — as
   a JAL target, as a 32-bit word in the image, or as an address built by a `lui`/`addiu` pair.
   That reference test is what separates a real second function from a second return point: 362 raw
   boundaries reduce to 6 referenced ones. `fix_ghidra_csv.py` now truncates the parent range at a
   forced entry inside it so the two do not overlap. The one that mattered: the static-array
   construct helper at 0x181fb4 calls the element constructor 0x5550c0, which lived inside
   `FUN_005550b0`'s range and blocked the mission load.

**Correction to the previous handoff:** "all UI positions resolve to (0,0)" is wrong. Dumping guest
RAM at the moment dlgMenu's CONTROLS list loads (`PS2X_RDRAM_DUMP_AT`, then `tools_py/rdr_tree.py`)
shows the parsed tree carries the real values — `new_game_button` XPOS 256 YPOS 330, `SplashLogo`
70/45 — the 17 design records built from it hold the same numbers, and the 2D nodes created from
those records have them at +0x30/+0x34 as floats. The SOCOM II logo does draw at its correct
position. What is actually missing on the menu is the button *captions* (their rdr CAPTION is a
single space; the text comes from elsewhere) and the 3D roller.

**Where it stops now:** in the mission, `FUN_001ebed0` (the in-mission tick — the previous handoff
said it is never called, which was true only before the mission could load) runs, but the frame
counters freeze at the values they had in the shell (`vif1codes=399073`, `mscal=22426`,
`xgkick=4421`, `nonBlack=0`), so the in-mission renderer submits no new geometry. The EE main
thread (1) goes dormant when the mission starts and the mission runs on thread 2; sampling shows
that thread spending essentially all its time at the resume point 0x2716e0 inside `FUN_00271650`,
a recursive scene-graph walk, with a *constant* guest sp (so it is not runaway recursion).

New diagnostics this session: `PS2X_JALR_TRACE="0xSRC,..."` (resolved target of the indirect calls
issued from those pcs), `[ret-clobber]`/`[ret-unwound]` lines from the `PS2X_CALL_TRACE` thunk (a
traced function returning with a callee-saved register changed / leaving through a scheduler
unwind, in which case its `[ret] v0` is not its result), `PS2X_RDRAM_DUMP="<path>:<seconds>"` and
`PS2X_RDRAM_DUMP_AT="<path>:<TracedName>#<n>"` (32 MB guest RAM to a file), and
`tools_py/rdr_tree.py` to print a parsed .rdr tree out of such a dump.

## Where the guest is now (2026-09-05 03:20)
Progress today, each a runtime fix: alarm handler discovered (main thread wakes) → all IRX modules load in the PCSX2 order → `lgaud` service answers lgAudInit (version 1.08, no headset) → `usbkb` bind → engine's scratchpad MFIFO renderer path implemented (fromSPR/toSPR DMA + ring drain; see research doc) → 989snd sound-system init runs through the service → `GetRomName` crash fixed (one-argument syscall) → the SCE-RT rt_crypt library generates a 512-bit RSA key pair at startup (two 256-bit primes by trial; takes minutes under recompiled code) → replaced with a fixed precomputed key via a recompile-time stub (`socom2_RsaGenerateKeyPair@0x0062B168` in `recomp/socom2.toml`, key in `socom2_rsa_key.h`).

Lessons: `runtime.replaceFunction()` only affects calls that go through the dispatch table; direct `jal` calls are compiled as direct C++ calls, so hooks on directly-called functions must be recompile-time stubs (`handler@0xADDR` in the TOML, handler name added to `PS2_STUB_LIST` in `ps2_call_list.h`, implementation in namespace `ps2_stubs`), and the recompiler must be rebuilt because it embeds that list (`build.sh recomp` now always rebuilds the tools). The crash reporter (`[crash]` lines with module-relative frames; symbolize with `llvm-nm -n dist/socom2.exe`) and the PC sampler (`PS2X_PC_SAMPLER`) are the two diagnostics that found every issue above.

## Where the guest is now (2026-09-05 08:00) — engine main loop running
Two fixes this session unblocked the boot:
1. **EE INTC I_STAT (0x1000F000) emulation** (`ps2_memory.cpp` `raiseIntcStatBit` + write-1-to-clear read/write; `EeScheduler.cpp` raises bit 2 on VBlankStart, bit 3 on VBlankEnd; `ps2_runtime.cpp` raises the bit for drained INTC causes). The engine's vsync wait `FUN_001a3fb0` clears I_STAT bit 2 and polls until the next vblank sets it.
2. **94 truncated `[mmio]` overrides fixed** (`tools_py/resolve_mmio.py`). A prior auto-generated table had folded many hardware-register accesses to their `lui` high-half (e.g. I_STAT 0x1000F000 → 0x10000000, GS 0x10002010 → 0x10000000, DMAC 0x1000dxxx → 0x10000000), silently routing guest MMIO to EE Timer0. The resolver backward-reconstructs each base register via lui/ori/addiu within its Ghidra function and computes base+imm. The three I_STAT poll sites (0x1a3fcc/0x1a3ff0/0x1a4020) were among them.

Result: the vsync wait completes, thread 1 (main) advances through the frame loop, and the live PC now spreads across engine subsystems (FIFO kick 0x350ab0, render 0x3b7130, 0x33xxxx/0x32xxxx). Threads 2/3 park correctly in `WaitSema`/`SleepThread` waiting for work. The game reaches audio-system init (`snd_StartSoundSystem`, master volumes, reverb, voice groups all set) and calls **DBCMAN** (controller/memory-card manager) — the shell/menu init path. Reproduce: `PS2X_PC_SAMPLER=1 ./run.sh 40`.

## Where the guest is now (2026-09-05 13:00) — intro video plays
**The pad-path wedge is fixed and the game plays its intro** (`PS2X_SOCOM2_PAD=1 ./run.sh 45`: 2445
frames, ~250k/287k non-black pixels per frame, 989snd banks loading, zero guest faults). Commit
db51455; full write-up in `docs/research/08-controller-and-dbcman.md §Resolution`.

Root cause (not the "config loop" the previous status guessed): with the pad reported connected,
the native `sceVibGetProfile` wrapper calls `sceDbcReceiveData` every frame with an
*uninitialised* max-length in the reply buffer's count field (+0x08). Our DBCMAN stub never wrote a
reply, so the wrapper read that garbage back as the received byte count and memcpy'd it out of the
0x1d62c0 RPC buffer into the pad object — running through the heap and overwriting the global
texture registry (0x45c3c0) with loader code bytes. The texture loader (`FUN_00354670`) then
dereferenced code words as pointers → TLB-miss fault → the runtime silently raised a COP0 address
error and re-dispatched the same function forever (the "grind" at 0x32f174/0x3546d0).

Found with **lldb** (ships in `tools/llvm-mingw/bin`): attach or launch under `lldb.exe --batch`,
break on `runtime_error::runtime_error` to get the host stack of the first guest fault (host frames
are named `sub_XXXXXXXX_0xXXXXXX`, so the host stack *is* the guest call chain), peek guest memory
as `$rcx + <guest addr>` at a `sub_*` entry (rcx = rdram, rdx = R5900Context, GPR n at rdx+16*n),
and `watchpoint set expression -s 4 -w write -- $rcx+0x8668c8` to catch the writer. Scripts used:
see the research doc.

Fixes: (1) `ps2xIOP/src/modules/dbcman.cpp` answers every libdbc RPC with a consistent "one DS2 on
socket 0, nothing received" state (count 0 at +0x08 is the crucial part) and publishes the 32-word
link table to the SetWorkAddr address. (2) `ps2_runtime.cpp` Load*/Store* fault handlers now print
a rate-limited `[guest-fault] op vaddr pc ra sp a0-a3 s0-s1 v0 (what)` line — these faults were
100% silent before. (3) `recomp/extra_functions.txt` += 0x3b7cf0, a static-init element ctor
Ghidra missed (the one `[guest-branch:missing-target]` at every boot).

Correction to research 08: `untracked_stubs` in the TOML is **informational only, ignored by the
recompiler** (ps2xAnalyzer/Readme.md) — those functions run natively. That is why
`sceVibGetProfile`/`scePad2GetButtonProfile`/`scePad2DeleteSocket` reached DBCMAN at all.

Step 2 (verified: `./run.sh 60` with the pad on shows only boot-time CheckVersion/SetWorkAddr/DeleteSocket DBCMAN traffic, no guest faults, content drawing, disc streaming): HLE `scePad2GetButtonProfile`,
`sceVibGetProfile`, `sceVibSetActParam` as recompile-time stubs so the pad state machine in
`FUN_002da930` advances 0→1 (GetButtonProfile could never succeed natively: it reads the DMA buffer
that only the native `scePad2CreateSocket` registers) and libdbc stays idle.

## Where the guest is now (2026-09-05 14:30) — menu UI renders, host input works
**Keyboard/mouse/scripted input** (`socom2_host_input.cpp`, commit 7aa0981): arrows = d-pad,
WASD/IJKL = sticks, Enter/Backspace = START/SELECT, ZXCV = Square/Cross/Circle/Triangle, QE/13/24 =
L1R1/L2R2/L3R3; `PS2X_SOCOM2_MOUSE=1` maps motion to the right stick and LMB/RMB to R1/L1;
`PS2X_SOCOM2_INPUT_SCRIPT="8:START,16:DOWN,18:CROSS"` presses buttons at those seconds (log-driven
testing). START at 8 s skips INTRO_2.PSS; the game then streams MENULOOP.PSS.
`tools_py/iso_lbn.py <iso> log <run.log>` maps a run's disc reads to file names.

**The shell UI now draws** (commit 3c790b4): the slot/profile dialog ("SLOT MISSION RANK DATE
TIME") renders over the menu movie; XGKICK fires (6480 kicks by frame 825), no faults, no VU
errors. Three EE→VIF1 delivery bugs were in the way, found with `tools_py/vu1dis.py` + the VU/VIF
traces (details in `docs/research/07 §Resolution 2`):
1. DMAtag upper-half (VIFcode) transfer was unconditional for CNT/NEXT/CALL/RET/END and never for
   REF tags; hardware does it for every tag iff CHCR.TTE. The shell's eye vector (REF tag) never
   arrived, the VU backface cull rejected every UI triangle, no XGKICK.
2. DMAtag ADDR bit 31 (SPR) was dropped.
3. The HLE libdma sent chains with CHCR 0x185 (TIE) instead of 0x145 (TTE).

**Next bottleneck: the CPU rasterizer.** With the UI up the game submits ~370 sprites and ~1M
textured pixels per frame; `GSCpuBackend::SampleTexture` does a swizzled VRAM read plus a CLUT
lookup per texel (×4 when bilinear) so the frame rate drops to 13-17 fps (lldb shows the game
thread inside `DrawSprite`→`SampleTexture` from the guest's DMA kick — it is slow, not stuck).
Options: a decoded-texture cache keyed by (tbp0,tbw,psm,size,CLUT) with page-dirty invalidation,
or the M4 GPU backend. Also visible: the dialog's highlighted row renders as a striped bar
(likely a CLUT/format or alpha issue) — check once the frame rate is fixed.

## Where the guest is now (2026-09-05 16:50) — GPU backend, menu at 60 fps
**OpenGL 3.3 GS backend landed and is the default** (`GSGlBackend`, commits 939655b, f80a93b,
0a208a0; design + status in `docs/superpowers/plans/2026-09-05-gpu-gs-backend.md`). The game
thread records GS commands, the main (GL) thread replays them into per-framebuffer render targets
and presents the RT texture directly; two `GSCpuBackend` instances model VRAM (authoritative on
the game thread, a shadow on the render thread for texture decoding). The shell renders at a
steady 60 fps (`PS2X_GS_STATS=1`), vs 13-17 fps on the CPU rasterizer (`PS2X_GS_BACKEND=cpu`).
Diagnostics: `PS2X_GS_DUMP_TEX=<dir>`, `PS2X_GS_TRACE_CMDS=<skip presents>`, and
`PS2X_FRAME_DUMP` still works (Present blocks for a readback).

Observed with the traces: SOCOM II streams every UI texture through one VRAM slot (texture at
block 0x3bf7, palette at 0x3bf3, re-uploaded before each draw), so the texture cache re-decodes
per draw; the dialog panel textures have alpha-0 palettes and rely on vertex alpha; the only
visible difference from the CPU path is that the title logo stays visible behind the slot dialog
(plausible for the real game; verify against PCSX2 when convenient).

**Open:** the slot/profile dialog does not react to DOWN/CROSS/TRIANGLE/START from the input
script, and its list is empty (no saves). Traced (`PS2X_SOCOM2_PAD_TRACE=1`, commit after
0a208a0): the presses DO reach the game — `scePad2GetButtonInfo` is polled for the digital ids
0x00-0x0f and the pressure ids 0x14-0x1f, and each press shows as 0→1→0 (digital) and 0→ff→0
(pressure). MCSERV (`[MCSERV]` trace) is only ever asked op 0 (Init), 11 times; the shell never
queries card info. **Presentation bug (reported by the user as a smaller frame, black squares and flicker on the GPU
path; fixed 2026-09-05 17:55):** the runner was told the presented texture was 640x448 while the
render target texture is 640x1024, so raylib squeezed the whole target into the display rectangle
(picture squashed into the lower part, unused black rows visible, alternating targets flickering).
`HostFrameTexture` now reports the texture's full size and the runner draws only the top-left
presented rectangle. Depth textures are also cleared to 0 on creation now (were undefined).

The gate is in the shell's UI layer: every UI input site uses the pad only when the current
screen object's +0x114 (local player index) is 0 (`FUN_00592ac0`). Next step and lldb recipe in
HANDOFF. The pad state machine itself (`FUN_002d9ff0`: states 0/1/2/3 + timers) is verified to
work with the HLE input. Pad sockets: only the newest socket reports connected (the boot-time
controller-check socket is deleted by the game; the HLE never sees the delete).

## Where the guest is now (2026-09-05 18:40) — main menu reached, "new game" hand-off stalls
The "+0x114 player-index gate" theory above is dead: the presses work. What the shell shows after
START is the **main menu screen** (`dlgMenu.rdr` in `game/disc/RUN/UI/READERC.ZAR`: buttons
new_game/load_game/multiplayer/options/extras/LAN, the `SavedGames` list box with the
`popup_load.tif` panel, the SplashLogo, a 3D `mainmenu_roller` model). We only see the load-game
panel and the logo; the buttons and the roller are not drawn (open rendering question, see below).
The user confirms that panel is not what the real game shows there.

How it was found (all new diagnostics, env-gated, zero cost when unset):
- `PS2X_CALL_TRACE="0xADDR[:name],..."` (game_overrides_socom2.cpp): logs every call of the
  listed guest functions — time, a0-a3, f12-f14, ra, any argument that points at text — and the
  return value (`[ret] name #n v0=… f0=…`). Works through the dense function table, so direct
  JALs are caught. 320 slots. Traced set that decoded the shell: the **script binding table** at
  ELF 0x3dd4d4..0x3de1c4 (207 `{name, fn, 0, id}` rows, 16 bytes each — SetMission, SwitchMenu,
  SetMenuState, ReadyToLoad, LoadSavedGame, ListSavedGames, GetNumSavedGames, IsMemCardInserted,
  SuspendMenuInput, PlayMPEG, …; dump: `tools_py` one-liner in the 18:40 session, list saved in
  the scratchpad as script_bindings.txt) plus the **animation-sequence command table** registered
  by `FUN_0026a8e0(0x414bb0, "NAME", 0, create, execute, 0)` at decomp lines 106865-106930
  (OBJECT_OPACITY_FROM_TO exec 0x25f880, CALL_ANIMATION 0x25d550, ui::UI_COMMAND 0x2745a0 = the
  dispatcher for the binding table, OBJECT_ACTIVE_STATE 0x263aa0, IF 0x25e7a0 / ELSE 0x25e6d0 /
  ENDIF 0x25e6a0, CALL_SEQUENCE 0x25d270, …). `FUN_0034e6b0(delay, queue 0x49ea50, "event",
  node, arg)` schedules a named script event ("goto_menu", "UiprepMission1" …).
- `PS2X_CD_TRACE=1`: `[cd] SearchFile`/`[cd] Read`/`[fio] open` on stdout (the RUNTIME_LOG
  versions are compiled out). `PS2X_MC_TRACE=1` now prints GetInfo/Sync on stdout.
- `PS2X_PEEK="0xADDR[:words],..."` dumps guest words (hex + float) with every PC-sampler line.
- `PS2X_FRAME_DUMP` pixels were **stale** on the GPU path (the same frame re-reported forever) —
  do not trust the PPMs/`nonBlack` for "what is on screen"; `PS2X_HOST_SCREENSHOT=<dir>[:<s>]`
  saves what the window shows. Display-off presents (PMODE EN1=EN2=0) now blank the dump.

Shell flow observed (call trace, `8:START,16:CROSS`): boot → `do_onstart`, `intro_onstart`,
`load_initial_config`, SwitchMenu → START → `goto_menu` → SwitchMenu(5) → `menu_fade_up`,
`PulseArrows`, `UiStopAttract`, `SetMenuValve`, `has_memcard_changed`, `CleanupMissionMemory`,
`Ensure_MC_Dirs_Fast` (sceMcGetDir root, sceMcChdir, sceMcGetDir "BASCUS-97275SOCOMII" → 0),
GetNumSavedGames (sceMcGetDir SaveGame0..9 → none), `IF GotSaveGames > …` → then a 1.5 s
`has_memcard_changed` poll loop. CROSS = the **new_game_button** → event `UiprepMission1`:
SOUND, `SuspendMenuInput 0.75` (writes shell+0x900, decremented per frame in `FUN_003654c0`),
OBJECT_ACTIVE_STATE ×3 (menu objects → INACTIVE: this is why the screen goes black), then the
sequence engine stops ticking. The engine's main tick `FUN_001ebed0(dt, app)` then runs its
fade-to-mission countdown branch (`app+0xc8 -= dt; f = app+0xc8 * app+0xc4; f < 0 →
FUN_002a9a70(0x4364e0)` → push mission state 0x4086a0 via `FUN_002cf380(0x4084c0, …)`), but
`FUN_002a9a70` never fires (traced, 6 s). Current step: peek app+0xb8..+0xc8 and dt to see why
the countdown does not complete (app object address = a1 of the traced `FUN_001ebed0`).

Other facts: memory card HLE reports a formatted 8 MB card with no `BASCUS-97275SOCOMII` dir;
the game does not try to create it (Mkdir never called) — fine for now. After CROSS no disc
reads or fio opens happen. VU1 keeps running programs (mscal rises) but XGKICKs stop: the UI
packets carry the "no setup kick" flag (header.w bit 1 clear at microcode 0x30) and no vertices.

## 2026-09-05 19:35 — first-boot flow runs end to end; main menu reached (commit 60fe75c — **does not resolve in this repository**, same reason as 841a6fc above: pre-`4b0bbf9` history)
After the full recomp with 0x353d00/0x2a98a0 forced, `PS2X_SOCOM2_INPUT_SCRIPT="8:CROSS,12:CROSS,
16:CROSS"` drives: memory-card slot popup → "loading" warning → "no SOCOM data found" →
StoreOptions → Sony logo (SONY448.PSS) → intro (INTRO_2.PSS) → `goto_menu` → dlgMenu over
MENULOOP.PSS, VU1 kicking, 60 fps. (The pre-fix flow had skipped the whole valve-guarded
memory-card path, which is why it went straight to the menu with a load-game panel.)
Also fixed: the GL present drew the frame with alpha blending, and the menu frame's alpha is 0,
so the window was black while the RT was fine — the present is now drawn opaque
(`rlDisableColorBlend`), plus a full colour mask before the present blit.
Open (see HANDOFF next task): UI positions all at (0,0) (buttons invisible, popups top-left),
an intermittent null-vtable crash in `FUN_0036ab20` when dlgMenu loads, VU1 packets with no
vertices (no 3D roller). Locale archives do load (`LoadLocale "UIMn"` ok), so captions exist.

## 2026-09-05 19:10 — root cause of the stalled "new game": an unrecompiled trampoline
Runner R2 of the `UiprepMission1` animation (three runners: button anim → SOUND, motion,
`SuspendMenuInput`; fade → OBJECT_OPACITY_FROM_TO + OBJECT_ACTIVE_STATE×3; then a sequence of
14 `VALVE` nodes) stays in state 4 with its current node pointer on the first VALVE node
forever. VALVE is registered by `FUN_0026a8e0(0x414bb0, "VALVE", parse=0x3535d0, 0,
exec=0x353d00, 0)` (decomp line 252352) and **0x353d00 is not a function in the Ghidra CSV**: it is
the two-instruction thunk `j 0x353fd0; addiu $a0,$a0,4`. The dispatcher's table call into it
had no recompiled target and returned without doing anything, so the runner never advanced
(`PS2X_CALL_TRACE=0x353d00:VALVE` prints `[call-trace] no function at 0x353d00`).

Scan for the same class (thunks outside every CSV function range) found exactly two: 0x353d00
and 0x2a98a0 (event-completion callback passed to `FUN_0034e6b0`). Both added to
`recomp/extra_functions.txt`; full recomp started 19:05. Also noticed: 0x38e890/0x3b7cf0 were
listed there since 17:00 but the EXE still reported `missing-target 0x38e890` — the forced list
only takes effect with `./build.sh recomp`.

Scan snippet (Python, from `socom_pc/`): parse the ELF program headers, for every executable
segment word `w` with `w>>26 == 2` (j) whose next word is `addiu $a0,$a0,imm` (`>>16 == 0x2484`)
or nop, compute `target = ((w & 0x3ffffff) << 2) | (addr & 0xf0000000)`, and report `addr` when
it is neither a CSV `Start` nor inside any `[Start, End)` range (bisect over the sorted starts).

## Previous blocker (resolved 2026-09-05) — game stayed on a black shell screen
Full render-pipeline diagnosis in `docs/research/07-render-pipeline-diagnosis.md`. Using the new
`PS2X_FRAME_DUMP=<dir>` counters, every layer below the game is proven correct: VIF1 delivers
1.5 MB/frame to `processVIF1Data`, VU1 launches 1047 microprograms and executes 87k instructions,
the software rasterizer writes pixels, the double-buffer flip and presentation work. The gap is
above them: the game loops in its shell render dispatch (`FUN_00339de0`) but only issues per-frame
**black clears** — `xgkick=0` (no VU1 geometry ever emitted), `nbWrites=0` (every rasterized pixel
is black), ~0.45 GS draws/frame. So the game has not advanced to a state that draws content.

**Update:** the controller was the gate. libpad2 (`scePad2*`) HLE now reports a connected
DualShock2 (see `docs/research/08-controller-and-dbcman.md`), and the game advances out of the
attract loop into first-time controller configuration. It now wedges there on a new IOP RPC:
**DBCMAN `rpc=0x8000131a`**, which our DBCMAN stub leaves unanswered. The main thread pins at
guest 0x32f174 inside a config/asset lookup (`FUN_00321390` list-walk → `FUN_00354670` →
`FUN_0032f0e0` recursive string-tree search) that grinds because the config table DBCMAN 0x8000131a
should populate is empty.

**Unified conclusion (2026-09-05, verified by `PS2X_TRACE_VU`):** the render pipeline is *correct*
and the black screen is a **game-state** condition, not a GS/VU bug. Full write-up in
`docs/research/07 §Resolution`. The one render program the game MSCALs (startPC=0x0, ~748× identical)
reads its input command header from double-buffered VU memory at TOP (0x1a8/0x2d4) = `[0,0,0,1]`
(empty/skip) and correctly branches over the XGKICK at 0x50 — the game is feeding it an empty
display list. GS, rasterizer, framebuffer, presentation, VIF1 feed, VU1 execution and XGKICK decode
all work; when the game reaches an interactive screen it will submit real lists and XGKICK fires on
its own (watch `xgkick`/`nbWrites` rise under `PS2X_FRAME_DUMP`).

So the gate to visible graphics is **advancing the game state**, i.e. the controller path. The pad
HLE (`PS2X_SOCOM2_PAD`, default off to keep the fast render loop) makes the game try first-time DS2
configuration through Sony's proprietary **libdbc/DBCMAN** device-bus protocol and wedge on
`rpc=0x8000131a` (sceDbcReceiveData) at guest 0x32f174. Reply-buffer layouts for the DBCMAN RPCs are
decoded in `docs/research/08` (offsets in the 0x1d62c0 buffer).

(Superseded: the DBCMAN replies were implemented — see the 13:00 section above. The "config loop"
theory was wrong; it was heap corruption from an unanswered ReceiveData.)

## Known issues / debt
- Forced entries get `End = next function start`, which spans rodata: unhandled-instruction count rose from 11k to 114k (garbage that never executes, but +1,400 files). Better: hand the list to Ghidra (`MakeFunctions.java`) so real bounds are found, then re-export.
- Missing ctor targets seen at runtime: 0x231a10, 0x2cde70 (added to `extra_functions.txt`). Expect more "guest-branch:missing-target" lines; each is an entry point to add.
- `LoadExecPS2` (self-relaunch with `--menu_state ...`, and the network-config utility `SCUSNGUI.ELF`) is reported and exits; a real implementation (reset scheduler/memory, reload ELF with argv) is needed for error reboots and network setup.
- Controller input is HLE only (`scePad2*`/`sceVib*` stubs in `game_overrides_socom2.cpp`, shared state `g_socom2Pad`, neutral input): host keyboard/gamepad → `g_socom2Pad` injection is not wired yet. DBCMAN answers libdbc with a fixed "one DS2, nothing received" state; no real DS2 protocol.
- Guest memory faults are converted to COP0 address errors and the access returns 0 (silently until the `[guest-fault]` log, first 16 only). A fault inside a function makes the scheduler re-dispatch that function from `ctx->pc`; a repeated identical `[guest-fault]` line means a retry loop like the one fixed on 2026-09-05.
- GS is the CPU rasterizer at 640x448; fine for bring-up, replace with a GPU backend for M4.
- The loader's libcdvd is partly replaced by runtime stubs (sceCd*), partly recompiled; the engine reads sectors by LBN from the ISO (works). VAG streaming later goes through 989snd's stream-safe read path.
- Build hygiene: shell scripts must stay LF (`.gitattributes`); Python on Windows writes CRLF when opened in text mode without `newline='\n'`.

## Environment facts
- Windows 11, RTX 4070 SUPER, 28 threads, 32 GB. No Visual Studio C++ workload; everything uses the portable toolchain in `tools/`. Python 3.13 with `unicorn`, `capstone`, `pyelftools`.
- Repo: since 2026-09-10 this directory is its own git repo (branch `develop`, remote github.com/Scotho/socom-unzipped, project name SOCOM Unzipped). Never `git add -A`; push after committing.
- The user's desktop is often in use (games): do not steal focus or capture the screen repeatedly; prefer logs. The user may pause work when the machine is loaded.
