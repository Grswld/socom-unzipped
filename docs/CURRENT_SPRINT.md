# Current sprint

The loop's aim. The `loop-iteration` skill (`.claude/skills/loop-iteration/SKILL.md`) reads this file instead of carrying a sprint pointer of its own; the controller
updates it when a sprint opens or closes, and whenever the order changes. **If you are a new controller, read
`docs/HANDOFF.md` first** -- it says what is in flight and what is owed (the traps are `docs/HAZARDS.md`); this file says what to do next.

**The goal every sprint serves:** SOCOM II running natively on PC with online play, that a stranger runs by pointing the
launcher at their own r0001 ISO and playing a round against another stranger on a hosted Horizon server -- from a public
repository another person can fork, build and contribute to.

```
branch:       sprint-17 -- OPEN 2026-09-28 03:05Z, cut off main at d77b58c5 (the Sprint 16 merge, PR #97, tagged v0.16.0) by the
              main-tree controller socom-pc-e0 (the owner's ruling of 2026-09-28: one controller seated in C:\Projects\socom_pc,
              every other session in its own worktree; the Sprint 17 seat "Mission frame drop causes" plans, briefs and
              reviews from .claude/worktrees/mission-frame-drops-7e50ea and hands each branch to the controller, who
              alone merges, chains, pushes). Agents work in worktrees on agent/s17-* branches. Sprint 16 CLOSED
              2026-09-28 01:24Z: see "Sprint 16 -- CLOSED" below, then the Sprint 15 CLOSED block.
spec:         docs/superpowers/specs/2026-09-27-sprint-17-sixty-and-the-way-back-design.md (four milestones F, Q, A, H in the
              owner's order; approved by the owner 2026-09-27 ~23:00Z). The Sprint 16, 15, 14, 13, 12 and 11 specs closed
              with v0.16.0 down to v0.11.0.
plans:        docs/superpowers/plans/2026-09-27-sprint-17.md (the task table, the rulings R322-R330 from the global counter, the
              Outcome, the Log newest first; its task book 2026-09-27-sprint-17-tasks.md beside it; GitHub milestone 7).
              The Sprint 16 plan (R299-R321, R314 vacant; docs/superpowers/plans/2026-09-27-sprint-16.md) and the Sprint 15
              plan (R282-R289; R298 the close's window, superseded) with the owner's sitting (R290-R297,
              docs/superpowers/plans/2026-09-26-owner-sitting.md) are closed, their blocks below; the Sprint 14 plan
              (R269-R281) too, its block in docs/archive/CURRENT_SPRINT-closed-sprint-14.md (moved 2026-09-28); the
              Sprint 13 plan's block is in docs/archive/CURRENT_SPRINT-closed-sprint-13.md (moved 2026-09-27); Sprints 12
              and 11 in docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md; Sprint 10's and older in
              docs/archive/CURRENT_SPRINT-sprints-9-to-11.md (the 2026-09-25 split, R268).
issues:       milestone 7 -- #59, #70, #71, #57 (Milestone R, R330), #32, #41, #28, #42, #91, #94, #26 (named by H1, not
              taken).
human tasks:  docs/HUMAN_TASKS.md      playtest script: docs/PLAYTEST.md
git strategy: docs/GIT_STRATEGY.md     contributing: CONTRIBUTING.md
rulings:      indexed in docs/RULINGS.md (generated: every ruling with its status and home, Sprint 10's
              R181-R244 ledger table below included) and numbered from the one counter line, docs/HANDOFF.md
              section 2 (Sprint 14 D2).
baselines:    the suite counts live in `docs/DEVELOPING.md` (the table under "Build, run, verify — a newcomer's first hour", rows 3–4) and nowhere else -- this
              line said C++ 686/686 and Python 1457 from 2026-09-20 to 2026-09-22, four sprints after they stopped
              being true, which is why `tools_py/tests/test_doc_maintenance.py` now refuses an undated count outside
              that file. `./build.sh test` exit 0 on the renamed tree (2026-09-25); last green chain: Sprint 16's batch-3 chain `s16_b3` on `aa030d1a` (2026-09-27 18:57Z-19:56Z: gate 3/3 PINS MATCH, HELDOUT 12/12,
              the player archive); the close gate `s16_b4g` by hand on the batch-4 exe `2430919f…` (2026-09-28 01:00Z-01:16Z: 3/3 PINS MATCH,
              HELDOUT 12/12, FRAME mean 28.82; the chain itself red on HEAD moving under other sessions' commits); the quiet baseline F0's three gates on `4cbbb14f` (median 27.09 ms, spread 7.0 %); before them the Sprint 14
              close chain `s14_close1` on `352fed01` (2026-09-26 15:29Z-16:19Z: gate 3/3 PINS MATCH, HELDOUT 12/12; the
              Sprint 14 plan's Log, 16:20Z); before it (Sprint 13, 2026-09-25): `s13_proof4_gate` 3/3 PINS MATCH (exe f90eeec0..., 22:16Z), `s13_v4_gate1` PASS on the
              same exe (23:51Z), `s13_proof3_gate` 3/3 (r0001, 20:54Z), `s13_names_r0004_gate` 3/3 PINS MATCH (r0004,
              d027546d...); the plan's Log has each; audio parity
              `s16_v0_t1b` 12/48 on the merged tree (2026-09-27, issue #91: the ambient bed 11 dB low; the Sprint 9 capture `s9_q1_parity_ours2` still reads 31/48 under today's compare)
```

Markers used below: **[A]** autonomous; **[O]** the owner's hands, ears, money or decision; **[B: x]** blocked on x.
"Lock-bound" means it needs a build or a launch: the loop lock, and a window -- announced by the session for a build,
named by the owner for a game run (the sitting's ruling of 2026-09-26, R297); "lock-free" can run at any time.

---

## Sprint 16 — CLOSED 2026-09-28 (merged to `main` as `v0.16.0` at `d77b58c5`, PR #97, 02:53Z; the record of the sprint is the block below)

**Close-out (the PR body).** Opened 2026-09-27 07:00Z, closed 2026-09-28 01:24Z: one loop day, every merged branch reviewed by a
fresh agent. Landed -- **L**: #73 closed (the persona ledger written on a real login against our Horizon box: a per-descriptor RT
frame walk hands the plain MAS/MLS bodies to the recorder, the login driver's keyboard rows and focus walk fixed; PR #90) and #74
closed (the tooltips, PR #82). **R**: R1a's spike (RECOMPILE, R316, research/74), the download primitive (PR #88), the player and
developer release kinds (PR #85), #69 closed. **F**: F0's note (research/73: three quiet gates on one exe 28.99 / 26.93 / 27.09 ms,
median 27.09, spread 7.0 %; the GL replay thread is the wall -- the draw path's read-back inside `submit=` 568 ms/s, the harness's
screenshots 169, the uploads 81; F4 does not fire) and F2's one measured attempt (the `[gs-submit]` split; the RT fast path's guard
restored after Sprint 7's shrink: ADOPTED: the read-back 123 → 20 ms/s, `submit=` 568 → 541). **X**: `tools/` restored by one flag, #57's r0004 leg (PR #87), Dependabot #10.
**V0**: the Sprint 15 legs -- the chain green, #67's drag proof, T1b's capture (12/48 and nine dips, recorded as #91 and #42's).
Not done: R1b (the first-run helper: eight reviewed regeneration rounds to a byte-exact DNAS stage, stopped in the package stage --
research/76; #70 carried to Sprint 17 at `3d17f192` unmerged), R2/R3b/R4 (#71 carried), F1 (not run), F3 (fired, not started; #32
to the backlog), F5 (numbers only, no pin; #59 carried), X2, X4 (#41 to the backlog). The owner's play test (22:40Z): the drag no
longer freezes, the audio much better, the online screens' music the one lingering defect (#94, Sprint 17), the personas working
superficially. The close proof: the batch-4 chain's suites green in rerun 4 (`ea24b339`) and the gate and the fourth leg by hand on its exe `2430919f…` (`s16_b4g`, 01:16Z): 3/3 PASS, PINS MATCH (13), HELDOUT 12/12, `FRAME mean=28.82` -- the chain itself went red five times on causes outside the code, three of them the main tree's HEAD moving under other sessions' commits. Issues since the open: opened 4 (#91, #94, #95, #96), closed 5 (#67, #69, #73, #74, #75),
carried 6 (#32, #41, #57, #59, #70, #71); the highest is #96. The §5 review fixed 38 findings and archived Sprint 14's block; the §7
read found the audit clean, carried and re-titled, opened #95 and #96, closed the milestone, regenerated the backlog; R271's breaker
closed O2, O4, O5, O7, O8, O10 and O15 by default (R321). The Outcome in the plan has the bar row by row and the numbers.

**As it stood while open:**

Opened by the Sprint 16 controller off `main` at `d84ffbde` (above the Sprint 15 merge `10650369`, `v0.15.0`) on the
owner's word of 2026-09-27 (05:33Z the seat; 05:57Z cloud sessions on the credit and open tasks in the controller's
order; 06:16Z Sprint 15 closes without its play test and this controller runs it at the end). Four milestones with a bar
each -- **R** the exe-only release (#70's native first-run decrypt after a spike, #71's r0004 package, the player and
developer archives under R295, the first archives against a draft), **F** the frame rate (measured on a quiet host, the
GL thread's top phase, the -O2 A/B, the conditional levers, #59's ceiling as a refusal), **L** the launcher's face (#73
the persona viewer, #74 the tooltips), **X** fillers (tools/ restored by one flag, the beta matcher, #57's r0004 leg,
#41's menu frame, Dependabot #10). First: **V0**, the Sprint 15 legs the owner deferred, one chain at the end of this
controller's first block with the desk idle. The defaults D1-D15 are ruled R299-R313 in the plan (R315-R320 followed; R314 was never issued); the bar is the spec's
section 4; no regression (D6, R304). Before the open, on the owner's word: L2 as PR #82, L1a's design note, R3a
re-scoped, X1 reviewed, X5 merged (`d84ffbde`). The plan's Log is the live state; this block gains its table at the
close.

## Sprint 15 — CLOSED 2026-09-27 (merged to `main` as `v0.15.0` at `10650369`, PR #81, 06:52Z; closed without its play test on the owner's word -- the legs are Sprint 16's V0; the record of the sprint is the block below)

**Close-out (the PR body).** Opened 2026-09-26 16:57Z, closed 2026-09-27 06:27Z: one loop day, every task reviewed by a fresh
agent. Adopted #254's LLE IOP as an out-of-tree audio oracle on the owner's word (the disc's own 989SND.IRX with our provider
disagrees with our HLE on 832 of 13,044 mission answers against 12,643 on the old oracle; the harness under
`docs/research/assets/70-lle-oracle/`); the audio register (five rows, the bar 6 dips) and the survey (#254 cannot load a bank
as it stands); merged #67's fix (the back-pressure stands aside for the window's move loop) and the AutoVol integer step
schedule; R280 (stable held-out stamps), R281 (an orphaned working-copy change stashed around chains), R298 (superseded by the
owner's correction). Issues since the open at 16:57Z: opened 6 (#70-#75, none on the stack), closed 0, carried 0; the highest
is #75. The §5 review fixed 23 stale claims (the header's `plans:` line the blocking one) and archived Sprint 13's block; the
§7 read found the audit clean, commented #67 and the three carried-twice issues, regenerated the backlog. The play test (the
close chain, T2's drag proof, T1b's capture) is carried to Sprint 16 on the owner's word of 06:16Z; T3 and T4 unstarted. The
Outcome in the plan has the bar row by row and the carried legs with their bars.

**As it stood while open:**


Opened by the Sprint 14 controller off `main` at `200f3287` (the Sprint 14 merge, `v0.14.0`) on the owner's word of
2026-09-26: the first proposal ("a week of planned work") was cut to what a player runs into and what the owner named --
**audio first** (the register and the survey for the audio rows only; the LLE IOP of upstream PR #254 answered as a candidate;
one trial on #42/#28 with the dip count as its measurement and a stop rule), **#67 the drag freeze beside it** (the modal move
loop on the presenting thread; the bar is the issue's), then **#59 a frame-rate bar and #32 the atlas re-upload if time
allows**. VU1 and every other replaced subsystem wait in `docs/LATER.md` with a confidence and a trigger, or a dismissal the
owner confirms. Four days (R286). The defaults D1-D8 are ruled R282-R289 in the plan; the bar is the spec's §4 as re-cut: the
audio rows with numbers, #254 answered, T1 to a recorded outcome, T2 to its bar, no regression (the gate 3/3, the fourth leg
green, audio parity not below 31/48, the dip count not above the register's number), LATER complete, the ceilings held. The
plan's Log is the live state; this block gains its table at the close.

*Sprint 14's CLOSED block moved verbatim on 2026-09-28 (the Sprint 16 close, `docs/DOC_MAINTENANCE.md` §5 step 5) to `docs/archive/CURRENT_SPRINT-closed-sprint-14.md`.*

*Sprint 13's CLOSED block moved verbatim on 2026-09-27 (the Sprint 15 close, `docs/DOC_MAINTENANCE.md` §5 step 5) to `docs/archive/CURRENT_SPRINT-closed-sprint-13.md`.*

*Sprint 12's and Sprint 11's CLOSED blocks -- with Sprint 11's rulings ledger R245-R263 and the table of Sprint 12's `S12-Rn` rulings that touch Sprint 11 -- moved verbatim on 2026-09-26 (the Sprint 14 close, `docs/DOC_MAINTENANCE.md` §5 step 5) to `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md`.*

## The standing backlog and the Sprint 10 ledger (kept live at the 2026-09-25 split)

*The Sprint 9, 10 and 11 records that stood between here and the Sprint 11 close were moved verbatim on 2026-09-25
(Sprint 13 Task R1, R268) to `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`: "Sprint 11 — the record of the sprint" (the task-by-task record, the worktree table, the timestamped blocks such as 14:30Z, 16:00Z, 02:5xZ and 13:00Z), "The close, 2026-09-22 evening → 2026-09-23 morning", "Sprint 10 — CLOSED 2026-09-23", "The order, reworked 2026-09-20", "Sprint 9, milestone P", "Sprint 9, milestone Q", "Sprint 10, REORGANIZED 2026-09-20" (with its chunk table, its road table and "Rulings (R181-R183)"), "The playthrough, 2026-09-22" (the R236-R240 blocks), the Sprint 10 and Sprint 11 drafts, "Rulings made on the owner's behalf (no plan of their own)" (R174-R178) and "The Sprint 9 record". A citation of any of those block names means that
file. The two blocks below stay because the standing backlog is the filler list this file must keep
(`docs/DOC_MAINTENANCE.md`, the first review's lesson 1) and the ledger says it is the one home of R181-R244;
Sprint 11's ledger R245-R263 stayed above for the same reason until 2026-09-26, when it moved with Sprint 11's CLOSED
block to `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md` (the Sprint 14 close).*

#### Standing backlog, carried from the roadmap 2026-09-23 -- superseded 2026-09-25

**Superseded 2026-09-25 by R265 and R267** (`docs/audits/2026-09-25-project-audit.md` §4). The eight-item filler list
that stood here (moved from `docs/ROADMAP.md` §6 on 2026-09-23; its text is in this file's history before the Sprint 13
close) is no longer the queue: `docs/BACKLOG.md` is the carry's one home (R267), and the rows R265 declined are in
`docs/backlog_ruled_out.txt` with their bars. Where each item went: 1, the EE soft-double chain, **declined** by R265
(`soft-double-chain`); 2, HLE audit leg three, **owned** by Sprint 13 Task C2 (the plan's C2 row); 3, the gameplay-state
probe, **declined as a gate leg** by R265 (`gameplay-state-probe`), and 5, its `rx`-hold teleport count, goes with it;
4, the online freeze, is issue #34 (`docs/HAZARDS.md` network), its `waitReadable` shape bounded by V7 (`160ffdae`) with the
console-peer run as its bar; 6, the two believed render rows, carry R265's retire-or-test bar (`render-believed-rows`);
7, voice, and 8, multiplayer security, are `docs/BACKLOG.md` rows (the `voice-*` rows, `multiplayer-security`).

**Resolved 2026-09-25:** the citation R243 makes, `docs/research/40-upstream-divergence.md` (`83c02d98`), is in this
tree; the note that said it lived only on `agent/upstream` is withdrawn.

#### Sprint 10's rulings ledger, R181-R244 (reconciled at the close; this table is the one home)

Sixty-four numbers, sixty-three rulings: **R229 is deliberately vacant** -- it was declared free in words when Q4's
rulings were renumbered to R211-R217, and no decision was ever issued under it. Nothing here is renumbered. The
working notes behind this table are `.superpowers/sdd/2026-09-22-sprint-10-close/report-rulings.md`.

| R | The decision (its own key words) | Where it is written | Status |
|---|---|---|---|
| R181 | "secret scanning, push protection and Dependabot alerts are **ON**", turned on by the controller under the owner's words | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, "Rulings (R181-R183)" | stands |
| R182 | "rulesets on `main` and `sprint-*` … with one deviation: **no CODEOWNERS review** required and no bypass" | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, "Rulings (R181-R183)" | stands |
| R183 | "the leak check is the monitor's rules **adapted for a SOURCE tree**, not copied" | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, "Rulings (R181-R183)" | stands |
| R184 | "**the mid-sprint merge to `main`**" -- the hardening and the developer setup reach `main` before the sprint closes | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, Sprint 10 reorganized | stands (merged `92b92c6`, PR #6) |
| R185 | "any drift **refuses**, whatever `--only` asked for" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q1b-gate-pins.md` §4 | stands |
| R186 | "the harness is **recorded, never compared**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q1b-gate-pins.md` §4 | stands |
| R187 | "an operator's extra `PS2X_*` variable **is a drift**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q1b-gate-pins.md` §4 | stands |
| R188 | "the first run that prints a mapping hash is **refused until accepted**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q1b-gate-pins.md` §4 | stands |
| R189 | "the state stream is **absorbed, not waited on**" on a latched stall; re-anchor when the window comes back | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q6-latched-stall-bound.md` §5 | stands |
| R190 | "`Present` is **droppable at the cap** on a latched stall" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q6-latched-stall-bound.md` §5 | stands |
| R191 | "the bounds: **512 rectangle pieces, 8 per key, 256 palettes, 4 MB**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q6-latched-stall-bound.md` §5 | stands |
| R192 | "**no launch from this branch**" -- the gate and the stall run are the controller's | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q6-latched-stall-bound.md` §5 | stands |
| R193 | "the mapping is **per profile**, and a default mapping is **not written and not sent**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R194 | "the environment string is **the whole table or nothing**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R195 | "the keyboard table is **data but not rebindable** from the page" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R196 | "the sticks and Triangle's pressure are **not in the table**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R197 | "'per-profile presets' is read as **the mapping saved per profile, nothing more**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R198 | "**bind on RELEASE, B held cancels, a tap of B binds B**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R199 | "the section switch is **launcher state, not a setting**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-goal-8-controller-mapping.md` | stands |
| R200 | "the override is a runtime **`replaceFunction` wrap**, not a `recomp/socom2.toml` stub; **no recompile**" | `docs/archive/sprints-7-12/2026-09-20-sprint-10-goal-9-online-credentials.md` | stands |
| R201 | "the persona name keeps **every character the game's keyboard has**" | `docs/archive/sprints-7-12/2026-09-20-sprint-10-goal-9-online-credentials.md` | stands |
| R202 | "the password is **capped at 12** in the launcher" | `docs/archive/sprints-7-12/2026-09-20-sprint-10-goal-9-online-credentials.md` | stands |
| R203 | "`PS2X_DEV` enters the harness **below the gate's env pin**, and the pin is **not widened** for it" | `docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-3-knob-retirement.md` | stands |
| R204 | "`PS2X_INPUT_MAPPING` is **the eighteenth Shipping name**" | `docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-3-knob-retirement.md` | stands -- and `docs/KNOBS.md` (generated) is the one home of the counts; two L documents that said 151/20 were corrected at this close |
| R205 | "`PS2X_LAUNCHER_API_BASE` is a **Dev** knob read through `ps2x::knob`" | `docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-3-knob-retirement.md` | stands |
| R206 | `SchedTrace.cpp`'s two later helpers "are **migrated under rule 2**"; a no-raw-`getenv` check joins `test_knobs_registry` | `docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-3-knob-retirement.md` | stands |
| R207 | "Every **Path-kind** knob is constrained to the portable folder, or refused -- **but not in this pass**" | `docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-3-knob-retirement.md` | stands; its work is still queued |
| R208 | "the `[knobs]` line **never writes a credential's value**: `PS2X_SOCOM2_LOGIN_PASS` is printed as `[redacted]`" | `docs/archive/sprints-7-12/2026-09-20-sprint-9-goal-3-knob-retirement.md` | stands |
| R209 | "Q2's **Task 8 VM ring deferred** to the sprint close, **CI is the Linux ring**, the VM stays off" | road-table row 6 in `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, which carries its parenthetical ("R209 deferred it here") | stands -- it has no written block of its own; the VM ring did not run at the close and carries to Sprint 11 Task 18 |
| R210 | "the keyboard's **gameplay mapping** is honoured **only in developer mode**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q3-mouse-leaves-keyboard-narrowed.md` | stands; made, and Q3 merged `0c172a6` |
| R211 | "while the game runs the pad drives the launcher **NEVER**; the switch is the one button" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands |
| R212 | "the switch is **a binding, in BUTTONS**, with OFF beside it; **the guide by default**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands |
| R213 | "an Xbox pad's guide button is read from **XInput's ordinal 100** on Windows" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands |
| R214 | "**no header bar on the game window in this pass**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands; deliberately not done |
| R215 | the game window's title is "&lt;game&gt; -- SOCOM Unzipped" and "the harness's key moved with it" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands |
| R216 | "the launcher's cues play at **0.45 of their rendered level**, and the setting lives on AUDIO" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands |
| R217 | "the cache is **keyed by content, not by path**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q4-launcher-rest.md` | stands |
| R218 | "**Goal 4 is closed on its own stop rule, without a launch**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q5-headset-button.md` | stands |
| R219 | "Sprint 8's **R113 stands with its meaning corrected**, and the HLE is not changed for it" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q5-headset-button.md` | stands (it corrects R113, outside this range) |
| R220 | "the HLE's state word **stays at '1 once, then 2'**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q5-headset-button.md` | stands |
| R221 | "the one launch worth making is **a peek, not a proof**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q5-headset-button.md` | stands; still queued |
| R222 | "the console-replay case runs wherever `game/console_replay` exists and **says 'skipped' where it does not**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R223 | "the card's cluster count is walked **once per game-side change, not per poll**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R224 | "a card root that cannot take a file **answers 'no card' and leaves exit 72**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R225 | "a write past the card's capacity is **refused whole with `sceMcResFullDevice` (-3)**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R226 | "the microphone resampler walks the product **`phase + step * k`, not a running sum**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R227 | "the stub helpers live in **namespace `stub_support`** with a global using-directive in the header" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R228 | "the synthetic Linux packaging test asserts the **executable bit on Linux only**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-q7-residuals.md` | stands |
| R229 | -- | this table, and nowhere else since 2026-09-23 (it was declared free in words in the index line this table replaced) | **deliberately vacant**: no ruling was ever issued under this number. It is not missing and it is not reused |
| R230 | "the expectations file holds **sha256 digests of whole game files, in the tree**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-disc-to-elf.md` | stands |
| R231 | "a difference in the image's *shape* is **a note, not a refusal**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-disc-to-elf.md` | stands |
| R232 | "the four **DNAS cipher addresses are recorded rather than derived**" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-disc-to-elf.md` | stands |
| R233 | "the extracted tree is **verified by size** against the image's own directory records" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-disc-to-elf.md` | stands |
| R234 | "`CONTRIBUTING.md` now says **the game build is supported**, on the evidence of one disc image on one machine" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-disc-to-elf.md` | stands |
| R235 | "the from-nothing run **reused the toolchain archives** already in the main tree's bootstrap cache" | `docs/archive/sprints-7-12/2026-09-21-sprint-10-disc-to-elf.md` | **closed** by the genuine clone-to-game run recorded in `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` |
| R236 | "the launcher's **default window is the game's own 640x448**" | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, the R236 block | stands -- it **overturns R92**, Sprint 7's 2x default |
| R237 | "the prefilled login leaves the player path" | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, the R237 block | **Superseded by R310 (Sprint 16 L1, 2026-09-27)** for a persona whose card holds the password: V6 settled that the card keeps it (`docs/KNOWN.md` §3, the W10 row) and D12's persona record lets the launcher stop typing it; before that, **REWRITTEN 2026-09-23 by W10**: the persona survives a virgin-card restart, the saved password does not, so **the prefill stays** until the clean-exit launch settles which side loses the write |
| R238 | "a failure the player can see **must never be silent**"; `setMcCommandResultLocked` prints `[mc] command <n> FAILED …` in every build | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, the R238 block | stands **as corrected in place** -- the first telling (reclassing two Dev knobs to Shipping) was wrong and the correction is kept beside it |
| R239 | "the online blop was charged to bank `0x00a00000`'s one-shots" | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, the R239 block | **withdrawn by its own A/B** -- the bank is cleared |
| R240 | "the join driver **presses REFRESH LIST before JOIN GAME, and takes a channel**" | `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`, the playthrough block | stands; landed in `00d8348`, and R244 proves its path through the ladder |
| R241 | "the four external-repo items … **become Sprint 11 milestone U, early**" | `docs/archive/sprints-7-12/2026-09-22-sprint-10-close.md` | stands |
| R242 | "**Goal 4's per-map kill routes carry to Sprint 11 as [A] filler**; the speed-freeze half is re-measured from existing logs" | `docs/archive/sprints-7-12/2026-09-22-sprint-10-close.md` | stands -- it supersedes road-table row 3 in `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md` |
| R243 | "milestone U item 1's **step (b) is redefined as a differential test**, not a music-parity number" | `docs/archive/sprints-7-12/2026-09-22-sprint-10-close.md` | stands; committed `564ef99`. Its citation `docs/research/40-upstream-divergence.md` was on `agent/upstream`; in this tree since (`83c02d98`) |
| R244 | "**W8's fallback run is not run separately**: the ladder streak proves the join driver's R240 path" | `docs/archive/sprints-7-12/2026-09-22-sprint-10-close.md` | stands; committed `22d1900` |


**Below R181, kept verbatim from the index line this table replaced** (they are Sprint 9's and earlier, and no part
of this reconciliation): R179-R180 are Sprint 10 Goal 9's, recorded in its plan -- the password plain in
`config.json` (R179, superseded by R310 on 2026-09-27 for a persona whose card holds the password, Sprint 16 L1),
and prefill-never-submit; R178 is Q0's conductor grains (child sounds, registers, markers, from the
open reference), in `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`'s "Rulings made on the owner's behalf"; R177 is Q0's mix device buffer, 20 ms x 4, measured, the same block; R176 is P4's ADVANCED section --
what went in it and what did not; R175 is P6's -- the preset switch needs no launch and the server keeps advertising
its IP, the same block; R174 is Goal 12's split -- the mapping data path lands in Sprint 9 Q3, the UI is Sprint 10;
R152-R168 are reserved by the Goal 3 plan; R169-R171 are Goal 10's music fixes, COMMITTED in `eca5450`; R172 is Goal
10's declined proposal -- the concurrency cap, not taken, waiting on Q1's instrument; R173 is P3's, the pad display
staying live while the game runs.

**Three rulings changed state during the sprint and one changed state at the close:** R236 overturns R92 (Sprint 7);
R238 was corrected in place after its first telling was shown false; R239 was withdrawn by the very A/B it asked for;
and R237's premise was reversed by W10 on 2026-09-23. **Collisions: none. Missing: none.**

---

*The "Standing rules" block that closed this file until 2026-09-25 was deleted, not archived: it duplicated
what was then `docs/HANDOFF.md` §5, the one home of the rules (since 2026-09-26 the rules are HANDOFF §4, one
line each, and their reasons `docs/archive/HANDOFF-to-2026-09-26.md` §5), and still said to push to `sprint-9` (the 2026-09-25 audit, D21).*

*Sprint 13's CLOSED block: `docs/archive/CURRENT_SPRINT-closed-sprint-13.md`. Sprints 12 and 11's CLOSED blocks: `docs/archive/CURRENT_SPRINT-closed-sprints-11-12.md`. Sprints 9 to 11: `docs/archive/CURRENT_SPRINT-sprints-9-to-11.md`. Sprint 8 and earlier: `docs/archive/CURRENT_SPRINT-to-sprint-8.md` (the record, unedited; nothing in either is an instruction).*
