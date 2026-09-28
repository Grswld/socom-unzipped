# Changelog: the merges, by release tag

> **Generated -- do not edit.** Written by `python -m tools_py.changelog` from `git log` (R272): every merge commit on the first-parent line of the history it was rendered from, and on the first-parent line of each branch those merges brought in, grouped by the oldest `v*` tag that contains it. `python -m tools_py.changelog --check` exits 1 when this file is stale; regenerate at every merge to a sprint branch (in the merge's follow-up commit) and at the close. The rules are the module's docstring. The reasoning behind a merge is its commit message and the sprint plan's Log; the hand-written log this page replaced is `docs/archive/STATUS-log-to-2026-09-26.md`.

233 merges (53 on the first-parent line, 180 from the branches they merged) in 13 sections: 12 tags and the merges since the newest. Each line: the date, the merge commit, the head of its subject, [the branch it merged]. An indented line came in on the branch the line above it merged.

## Since v0.16.0

8 merges.

- 2026-09-28 `9df70d17` the screenshot encode off the GL thread, a shot queue (Sprint 17 F0 Step 5b, PASS) [agent/s17-f0b]
- 2026-09-28 `7098c334` submit_split.py scores the [gs-submit] line over a walk window (Sprint 17 F1 Step 0, PASS) [agent/s17-f1]
- 2026-09-28 `d0b68e5b` the chain guard [agent/s17-g1]
- 2026-09-28 `6e4236ba` the three instruments [agent/s17-f0]
- 2026-09-28 `0d498a7e` the online menus' harness scoped, one row per screen (Sprint 17 H1, reviewed PASS) [agent/s17-h1]
- 2026-09-28 `d4863d14` the story page's readability pass and the viewer's vendored design system 1.0.3 (R294, reviewed) [agent/ds-web]
- 2026-09-28 `d2fea276` sprint-16's close record (d7bd44c0, main merged back) into sprint-17 at its open [branch not named]
  - 2026-09-28 `420ec617` main (v0.16.0, d77b58c5) back into sprint-16 after the close [main, main merged in]

## v0.16.0

Tagged 2026-09-27 on `d77b58c5`.

46 merges.

- 2026-09-27 `d77b58c5` Merge pull request #97 from Scotho/sprint-16 [sprint-16]
  - 2026-09-27 `48e26736` merge(sprint-16): the main tree's 279a0766 (the owner's web session: the viewer's chrome on the s2u design system) [branch not named]
  - 2026-09-27 `0f22b555` merge(sprint-16): the main tree's d9dc8caa (the owner's web session: the viewer vendors the s2u design system) [branch not named]
  - 2026-09-27 `56992b66` merge(sprint-16): the main tree's 28a131a3 (the owner's story page on the s2u design system) into the controller branch [branch not named]
  - 2026-09-27 `f5705791` merge(sprint-16): the main tree's 0cda431c (the doc-surfaces merge, R318-R320) into the controller branch [branch not named]
  - 2026-09-27 `7452b8f5` wiki + Announcements (R318-R319), revise-not-append (R320), doc-maintenance skill [agent/doc-surfaces]
  - 2026-09-27 `6702d2ab` merge(sprint-16): the main tree's 84216bcf (the owner's session's merge of origin/sprint-16) into the controller branch [branch not named]
  - 2026-09-27 `84216bcf` merge(sprint-16): origin/sprint-16 at 46b6121e [branch not named]
  - 2026-09-27 `46b6121e` Merge pull request #92 from Scotho/agent/domain-socomunzipped [agent/domain-socomunzipped]
  - 2026-09-27 `65a5081d` Merge pull request #93 from Scotho/agent/web-lod-last [agent/web-lod-last]
  - 2026-09-27 `3c76db21` the [gs-submit] split and the render target served as a texture through any envelope (Sprint 16 F2) [agent/s16-f2]
  - 2026-09-27 `60e37e53` merge(sprint-16): the owner's servers ruling and story commits (c6450bcd) into the controller branch [branch not named]
  - 2026-09-27 `9f8bf567` merge(sprint-16): the main tree's web-session commits (3bb6e986) into the controller branch [branch not named]
  - 2026-09-27 `06b7c3f1` the canvas stays opaque, so the page never shows through the fog (Sprint 16, web) [agent/web-alpha]
  - 2026-09-27 `cae0c692` plain RT frames from the socket to the persona recorder (Sprint 16 L1b, #73) [agent/s16-l1b-seam]
  - 2026-09-27 `500aaf5c` merge(sprint-16): the main tree's web-session commits (8166261c) into the controller branch [branch not named]
  - 2026-09-27 `0ac9f700` _L (dynamically lit) chunk keys resolve, so MP7/MP62/MP83's props draw (Sprint 16, web) [agent/web-lit]
  - 2026-09-27 `81db4d61` the viewer's build revision in the panel and the s2u design language (Sprint 16, web) [agent/web-ui]
  - 2026-09-27 `5d6c8f48` the keyboard's row origins and the persona-list focus walk (Sprint 16 L1b Step 0) [agent/s16-l1b-drv]
  - 2026-09-27 `494e4438` merge(sprint-16): the main tree's b8525708 (the owner's docs(web) move of research 71 and 72) into the controller branch [branch not named]
  - 2026-09-27 `1bf7150e` the capture offset from the recorder's first packet to the drive's own t0 (Sprint 16, LATER row 37) [agent/s16-l37]
  - 2026-09-27 `2b5b8ecc` merge(sprint-16): origin/main at a3e1c5db [branch not named]
  - 2026-09-27 `d5126551` merge(sprint-16): origin/main at a159a19d [branch not named]
  - 2026-09-27 `b3ef4d54` research/74 the first-run decrypt spike [agent/s16-r1a]
  - 2026-09-27 `8b479265` merge(sprint-16): origin/main at c6d49773 [branch not named]
  - 2026-09-27 `b00863f7` a stream's AutoVol target scales its play-time volume, the -4 timer tested (Sprint 15 T1b round 3) [agent/s15-t1b]
  - 2026-09-27 `10f7cd3e` merge(sprint-16): origin/main at 039fc569 [branch not named]
  - 2026-09-27 `7b2e76bc` R179 and R237 superseded by R310 [agent/s16-l1-r237]
  - 2026-09-27 `ad5fdaef` snd_AutoVol steps in 7-bit integers on the IRX's schedule (Sprint 15 T1b, reviewed PASS 08:13Z) [agent/s15-t1b]
  - 2026-09-27 `2e7b0bfa` #32's bar restated, the issues audit exits 0 again (Sprint 16 F3 Step 0, socom-pc-42) [agent/s16-f3-words]
  - 2026-09-27 `8865602f` tools/ restored by one flag from the D: backup, verified by a manifest (Sprint 16 X1) [agent/s16-x1]
  - 2026-09-27 `45cb1b93` merge(sprint-16): origin/main at ac173beb [branch not named]
  - 2026-09-27 `ac61f1a4` merge(sprint-16): origin/main at fbc905b2 [branch not named]
- 2026-09-27 `a3e1c5db` Merge pull request #90 from Scotho/agent/s16-l1b (Sprint 16 L1b, #73) [agent/s16-l1b]
- 2026-09-27 `a159a19d` Merge pull request #86 from Scotho/agent/launch-rev (#69, O4, O12; Sprint 16 R5's merge) [agent/launch-rev]
  - 2026-09-27 `f9d9bb3d` Merge remote-tracking branch 'origin/main' into agent/launch-rev [origin/main, main merged in]
- 2026-09-27 `c6d49773` Merge pull request #89 from Scotho/agent/s16-l1-design (Sprint 16 L1a) [agent/s16-l1-design]
- 2026-09-27 `994b99ca` Merge pull request #87 from Scotho/agent/s16-x3-r0004-leg (Sprint 16 X3) [agent/s16-x3-r0004-leg]
- 2026-09-27 `17b8d719` Merge pull request #88 from Scotho/agent/s16-r2a-download (Sprint 16 R2a) [agent/s16-r2a-download]
- 2026-09-27 `039fc569` Merge pull request #85 from Scotho/agent/s16-r3a-archives [agent/s16-r3a-archives]
- 2026-09-27 `bb675dbd` Merge pull request #82 from Scotho/agent/s16-l2-tooltips [agent/s16-l2-tooltips]
- 2026-09-27 `1d78ce01` Merge pull request #80 from Scotho/agent/web-viewer [agent/web-viewer]
- 2026-09-27 `ac173beb` Merge pull request #84 from Scotho/agent/docs-review [agent/docs-review]
  - 2026-09-27 `82324b19` Merge remote-tracking branch 'origin/main' into agent/docs-review [origin/main, main merged in]
- 2026-09-27 `fbc905b2` Merge pull request #83 from Scotho/agent/hook-delete-branch [agent/hook-delete-branch]
- 2026-09-27 `d84ffbde` Merge pull request #10 from Scotho/dependabot/github_actions/actions/cache-6.1.0 [dependabot/github_actions/actions/cache-6.1.0]

## v0.15.0

Tagged 2026-09-27 on `10650369`.

17 merges.

- 2026-09-27 `10650369` Sprint 15: borrowed confidence, re-cut (#81) [sprint-15]
  - 2026-09-27 `8ae047c5` merge(sprint-15): the close's section 5 review fixes [branch not named]
  - 2026-09-27 `510ba0ee` merge(sprint-15): origin/main at ef199808 [branch not named]
  - 2026-09-27 `68eb6c25` merge(sprint-15): origin/main at b534bd3f [branch not named]
  - 2026-09-26 `892f3cf5` merge(sprint-15): origin/main at 48dae28f [branch not named]
  - 2026-09-26 `297e43da` merge(sprint-15): T1c the LLE-oracle harness landed under docs/research/assets/70-lle-oracle (the owner's word) [branch not named]
  - 2026-09-26 `94a9cb84` merge(sprint-15): T1 the LLE IOP as an oracle [branch not named]
  - 2026-09-26 `87d9796b` merge(sprint-15): origin/main at 715e8149 [branch not named]
  - 2026-09-26 `f84f4f66` merge(sprint-15): T2 #67 the drag freeze [branch not named]
  - 2026-09-26 `6d5f53cc` merge(sprint-15): X1 the audio survey [branch not named]
  - 2026-09-26 `39d5c0ab` merge(sprint-15): R1 the audio confidence register [branch not named]
- 2026-09-27 `ef199808` Merge pull request #79 from Scotho/agent/private-inputs [agent/private-inputs]
- 2026-09-27 `b534bd3f` Merge pull request #78 from Scotho/agent/known-69 [agent/known-69]
- 2026-09-26 `48dae28f` Merge pull request #77 from Scotho/agent/hazard-entry [agent/hazard-entry]
- 2026-09-26 `715e8149` Merge pull request #76 from Scotho/agent/sitting-docs [agent/sitting-docs]
- 2026-09-26 `24ffe56f` Merge pull request #9 from Scotho/dependabot/github_actions/actions/upload-artifact-7.0.1 [dependabot/github_actions/actions/upload-artifact-7.0.1]
- 2026-09-26 `c1ea15d2` Merge pull request #8 from Scotho/dependabot/github_actions/actions/setup-python-7.0.0 [dependabot/github_actions/actions/setup-python-7.0.0]

## v0.14.0

Tagged 2026-09-26 on `200f3287`.

48 merges.

- 2026-09-26 `200f3287` Sprint 14: guards, not sentences (#68) [sprint-14]
  - 2026-09-26 `17400817` merge(sprint-14): Sprint 15 re-cut to value [branch not named]
  - 2026-09-26 `e760bc75` merge(sprint-14): docs/LATER.md [branch not named]
  - 2026-09-26 `d8b6075e` merge(sprint-14): the close's documentation review fixes [branch not named]
  - 2026-09-26 `01650b22` merge(sprint-14): the upstream register docs/UPSTREAM.md (bugs in the vendors' main only); the close chain's block [branch not named]
  - 2026-09-26 `3bdf80e8` merge(sprint-14): E2 the fourth leg's tooling [branch not named]
  - 2026-09-26 `37ca3511` merge(sprint-14): W2 the merged chain as the gate unit [branch not named]
  - 2026-09-26 `f6858d24` merge(sprint-14): X1 the external sweep for Sprint 15 [branch not named]
  - 2026-09-26 `9617c69b` merge(sprint-14): E3 recompiler re-derivation in CI [branch not named]
  - 2026-09-26 `a3f84dba` merge(sprint-14): W1 the queue's WIP cap [branch not named]
  - 2026-09-26 `d13b9c34` merge(sprint-14): M2 token spend, local only [branch not named]
  - 2026-09-26 `c387f166` merge(sprint-14): D4 the circuit breaker [branch not named]
  - 2026-09-26 `e7cd70dd` merge(sprint-14): D3 the owner's sitting page [branch not named]
  - 2026-09-26 `d751bc7f` merge(sprint-14): M1 the flow page [branch not named]
  - 2026-09-26 `b99708e2` merge(sprint-14): D5 PLAYTEST's build block written by the chain [branch not named]
  - 2026-09-26 `c6e6b83f` merge(sprint-14): S3 the ceilings ratchet [branch not named]
  - 2026-09-26 `72889b31` merge(sprint-14): origin/main at b3dae300 (PR #66, #57 open for the r0004 leg); E4's row and #56's note [branch not named]
  - 2026-09-26 `018a7489` merge(sprint-14): E4 gate freshness [branch not named]
  - 2026-09-26 `6c3d9a58` one home each [agent/s14-s4]
  - 2026-09-26 `41ef8678` the generated changelog from merge commits and tags; STATUS's log archived (S14 S1, R272) [agent/s14-s1]
  - 2026-09-26 `edf2a0df` check 11, the read-first budget over HANDOFF, CLAUDE.md, CURRENT_SPRINT, the Log, STATUS (S14 I4) [agent/s14-i4]
  - 2026-09-26 `73f0f0f8` origin/main (123dd1c5, PR #65 the CD group and g_iopHeapNext runtime-owned, #51 closed) into sprint-14 [origin/main, main merged in]
  - 2026-09-26 `d26aaa48` HANDOFF transient under 6 KB [agent/s14-i3]
  - 2026-09-26 `d09ee23d` merge sprint-14 into agent/s14-i3: S2's commit-msg hook, D1's RULINGS page, D2's scope rule [sprint-14]
  - 2026-09-26 `da20068c` the ruling scope rule in DOC_MAINTENANCE section 6; one counter line (Sprint 14 D2) [agent/s14-d2]
  - 2026-09-26 `ca7cac84` the commit-msg hook caps the subject at 120 characters (Sprint 14 S2) [agent/s14-s2]
  - 2026-09-26 `635eeabf` the generated rulings page with a status per ruling, held by --check (Sprint 14 D1) [agent/s14-d1]
  - 2026-09-26 `8f4fab53` Merge branch 'sprint-14' into agent/s14-d1 [sprint-14]
  - 2026-09-26 `696d0618` loop-iteration, agent-worktree, run-gate and sprint-close as project skills; LOOP_PROMPT a pointer, its text archived (Sprint 14 I2) [agent/s14-i2]
  - 2026-09-26 `71936e76` Merge branch 'sprint-14' into agent/s14-i2 [sprint-14]
  - 2026-09-26 `2b600679` KNOWN's section 4 moves verbatim to docs/HAZARDS.md by area; the citers re-pointed; the audit reads both (Sprint 14 I5, R270) [agent/s14-i5]
  - 2026-09-26 `d3a9b0c4` Merge branch 'sprint-14' into agent/s14-i5 [sprint-14]
  - 2026-09-26 `99bf35af` the root CLAUDE.md under sixty lines [agent/s14-i1]
  - 2026-09-26 `becaa43a` the Edit/Write guard [agent/s14-g2]
  - 2026-09-26 `90a0a234` Merge branch 'sprint-14' into agent/s14-g2 [sprint-14]
  - 2026-09-26 `2ff45fab` the SessionEnd/Stop reaper [agent/s14-g3]
  - 2026-09-26 `ac411c01` origin/main (9b566459, PR #64 build_revision --out reads the tree's map and reuses current overlays, #56 closed) into sprint-14; KNOWN's #56 row settled [origin/main, main merged in]
  - 2026-09-26 `c48e6ec5` implementer and reviewer agent definitions under .claude/agents, with a test (Sprint 14 G4) [agent/s14-g4]
  - 2026-09-26 `b021f988` Merge branch 'sprint-14' into agent/s14-g4 [sprint-14]
  - 2026-09-26 `a22fd799` the Bash PreToolUse guard [agent/s14-g1]
  - 2026-09-26 `ddb1a503` build.sh consults the loop lock (exit 3 unless the holder's own child); a memory guard in run_detached (Sprint 14 G5) [agent/s14-g5]
  - 2026-09-26 `e2d0caf6` origin/main (6f5d98b3, PR #63 README's plainer front page) into sprint-14 [origin/main, main merged in]
  - 2026-09-26 `eeabc16d` origin/main (25828e1c, PR #62 the path stubs contained, #53 closed) into sprint-14; KNOWN's #53 row settled [origin/main, main merged in]
- 2026-09-26 `b3dae300` recomp: each generated file declares only its callees; the recomp rewrites only changed files (#66) [branch not named]
- 2026-09-26 `123dd1c5` fix(runtime): the CD group and g_iopHeapNext runtime-owned, not per-TU (#65) [branch not named]
- 2026-09-26 `9b566459` fix(build_revision): --out reads the tree's map and reuses its current overlays (#64) [branch not named]
- 2026-09-26 `6f5d98b3` docs(README): a plainer front page (#63) [branch not named]
- 2026-09-26 `25828e1c` fix(stubs): contain the fopen and sceCdSearchFile path stubs (#62) [branch not named]

## v0.13.0

Tagged 2026-09-26 on `6a82caaa`.

44 merges.

- 2026-09-26 `6a82caaa` Sprint 13: nothing carried twice (#61) [sprint-13]
  - 2026-09-26 `263f15a1` Sprint 13 O2, #26: the chat step [agent/s13-o2]
  - 2026-09-25 `3804d10b` Sprint 13 V2, #32: the VRAM upload gate [agent/s13-v2]
  - 2026-09-25 `e9e7b4cc` Sprint 13 C4, #33 and #40: the three FTOI sites through Ps2VuFtoiScalar with the NaN rule; a J to a stub goes through the function table so the HLE stats see... [agent/s13-c4]
  - 2026-09-25 `5dcb7c9e` Sprint 13 C2: the throwing stubs [agent/s13-c2]
  - 2026-09-25 `084e2202` Sprint 13 close, DOC_MAINTENANCE §5: the 24 findings of the document truth read fixed [agent/s13-close5]
  - 2026-09-25 `413439d3` Sprint 13 V3, #31: the premise was fixed on 2026-09-16 by 545b85a1 and never recorded; readGsImage no longer scans past the load packet into the caller's sta... [agent/s13-v3]
  - 2026-09-25 `d5220e0b` Sprint 13 V4, the harness half: the mission stage's FRAME line (VBlank pacing over the scripted walk), an informational frame-time pin never compared (S13-R3... [agent/s13-v4]
  - 2026-09-25 `2a0f513a` Sprint 13: the control rounds [agent/s13-rounds]
  - 2026-09-25 `160ffdae` Sprint 13 V7, #34: waitReadable holds the EE executor one guest tick at most [agent/s13-v7]
  - 2026-09-25 `9ac07da6` Merge sprint-13 into agent/s13-v7 (C8's msifrpc move; V7's two hunks ported into socom2_msifrpc.cpp) [sprint-13]
  - 2026-09-25 `6b9cf650` Sprint 13 C8: ps2HostProfStart weak in the runtime and g_ps2xTraceArmed defined once, the test stand-in file gone; the libpad2, msifrpc, lum and crypto handl... [agent/s13-c8]
  - 2026-09-25 `e7a8af3c` Sprint 13 C3, the lock-free half: the after-return trap closed [agent/s13-c3]
  - 2026-09-25 `a517291a` Sprint 13 N2, the lock-free half: build_revision --out keeps the names sidecar and the unresolved-names line is a warning build.sh surfaces (#48); the genera... [agent/s13-n2]
  - 2026-09-25 `6ff8229f` Sprint 13 V6: #27 was the login driver pressing before reading the relaunch form, not a lost password [agent/s13-v6]
  - 2026-09-25 `49d6fba2` Sprint 13 H2: the lock's ticket queue (#36), --wait in minutes (#35), run_detached --wait, ladder_job waits for the lock (#37), the quiet marker at the main... [agent/s13-h2]
  - 2026-09-25 `b7e13676` Sprint 13 O3: the hosted box's backup, health and off-box pull tracked under server/ops with every secret in an ignored env file, the build id served on /sta... [agent/s13-o3]
  - 2026-09-25 `55c565d6` Sprint 13 N1: the runtime's own names into the sidecars as 31 Pass=hand rows (17 carried to r0004 at exact placements), research/50's four offsets named besi... [agent/s13-n1]
  - 2026-09-25 `7c24ac44` Sprint 13 C5: build products out of the source tree [agent/s13-c5]
  - 2026-09-25 `69619550` Sprint 13 C6: the supply chain pinned [agent/s13-c6]
  - 2026-09-25 `be4654bb` Sprint 13 H7: the fast lock-free subset, requirements.txt with CI installing from it, build.sh through python_env.sh, fix_ghidra_csv under test with its forc... [agent/s13-h7]
  - 2026-09-25 `3f043ff5` Sprint 13 C7: the dead configuration removed [agent/s13-c7]
  - 2026-09-25 `0cf4bfa0` Sprint 13 C1: CI compiles game_overrides_socom2.cpp and socom2_crypto.cpp and links the runner against a synthetic generated set on every code push; RED x3 a... [agent/s13-c1]
  - 2026-09-25 `5565f2ca` Sprint 13 V8+S2: the launcher's wording defects (stranger rows 9-15, F53) with tests; a server name that does not resolve is a LAST RUN notice (S13-R9); revi... [agent/s13-v8]
  - 2026-09-25 `82dd90da` Sprint 13 U2: a guest path cannot leave the game, disc or memory-card folder [agent/s13-u2]
  - 2026-09-25 `b59daa0d` Sprint 13 C9: every Shipping and Switch knob's line names the code's effect, each cites its read site, a test ties them; NET_STATS corrected; review PASS WIT... [agent/s13-c9]
  - 2026-09-25 `cf444ee7` Sprint 13 S6: no private address as a tracked default [agent/s13-s6]
  - 2026-09-25 `1dcaa57b` Sprint 13 S4: the story's five missing days [agent/s13-s4]
  - 2026-09-25 `461cfa0d` Sprint 13 U6: a server-to-client record that writes game memory, and one that reads it back, are refused on the client, every time; 899/899 tests; gate s13_u... [agent/s13-u6]
  - 2026-09-25 `936c9231` Sprint 13 H1: a docs-only push starts no build run, the docs workflow runs the doc checks, the pull-request changes filter compares the merge base three-dot;... [agent/s13-h1]
  - 2026-09-25 `727f8afc` Sprint 13 U4: the upstream drafts for O10 [agent/s13-u4]
  - 2026-09-25 `e29ff7e0` Sprint 13 R6: the codex audit's six assignments dispositioned [agent/s13-r6]
  - 2026-09-25 `ab6d7ff3` Sprint 13 U7: three upstream picks [agent/s13-u7]
  - 2026-09-25 `33fa5940` Sprint 13 R7: one home for the carry [agent/s13-r7]
  - 2026-09-25 `490d0fe8` Sprint 13 H4: the 28 uninvoked tools_py modules dispositioned [agent/s13-h4]
  - 2026-09-25 `a7121138` Sprint 13 R5: KNOWN read in full [agent/s13-r5]
  - 2026-09-25 `74de313a` Sprint 13 H3: --accept-pins writes the standard only after a run whose every stage passed (S13-R5); every capture writes its PS2X_* environment beside itself... [agent/s13-h3]
  - 2026-09-25 `82e9d9fc` Sprint 13 R4: HUMAN_TASKS reduced to the owner's sitting [agent/s13-r4]
  - 2026-09-25 `00dc0ccc` Sprint 13 R3: the ruling record [agent/s13-r3]
  - 2026-09-25 `65c86daf` Sprint 13 H6: six r0001 statics into the per-revision table with derived r0004 values, three left unplaced with their instruments refusing on r0004, a test t... [agent/s13-h6]
  - 2026-09-25 `bab6e5d0` Sprint 13 R2+S1: DEVELOPING as current truth with a map of every tools_py module; README, INSTALL, FAQ, PLAYTEST, GIT_STRATEGY, LOOP_PROMPT, ROADMAP, STORY,... [agent/s13-r2]
  - 2026-09-25 `3cccb780` Sprint 13 R1: the archive split of the sprint file, HANDOFF and STATUS; R268's ceilings and the tag check in docmaint [agent/s13-r1]
  - 2026-09-25 `b1a91c36` Sprint 13 U1: research/63, the triage of 27 upstream PRs and the external-watch table [agent/s13-u1]
  - 2026-09-25 `5fadad9a` Sprint 13 V1: the title scorer holds every menu-window capture to the bar; research/64 [agent/s13-v1]

## v0.12.0

Tagged 2026-09-25 on `74fe2a9b`.

7 merges.

- 2026-09-25 `74fe2a9b` Sprint 12 to main [sprint-12]
  - 2026-09-25 `30d4b74d` 173608a: Sprint 11 merged as v0.11.0 [origin/main, main merged in]
  - 2026-09-25 `7f71e928` 29bc22c: the accept-pins bed states its revision, the r0004 pin standard restored verbatim [origin/sprint-11]
  - 2026-09-25 `eb190a42` 7bd3c6e: the two upstream pick authors allowed in the leak ledger, the wrapper-path test [origin/sprint-11]
  - 2026-09-25 `deb288c2` d1c0a10: Sprint 11's close-out, the twelve-test CI fix, the python shim [origin/sprint-11]
  - 2026-09-25 `cb56fc83` Merge origin/sprint-11 (3bb866f: the ten upstream picks, the r0004 online harness) into sprint-12 before the local proof [origin/sprint-11]
  - 2026-09-24 `6d0e259c` Merge remote-tracking branch 'origin/sprint-11' into sprint-12 [origin/sprint-11]

## v0.11.0

Tagged 2026-09-25 on `173608af`.

26 merges.

- 2026-09-25 `173608af` Merge pull request #49 from Scotho/sprint-11 [sprint-11]
  - 2026-09-25 `378d97d1` Merge branch 'agent/ci-fix' into sprint-11 [agent/ci-fix]
  - 2026-09-25 `3bb866f4` Merge branch 'agent/cherry' into sprint-11 [agent/cherry]
  - 2026-09-24 `2e84984a` Merge remote-tracking branch 'origin/main' into sprint-11 [origin/main, main merged in]
  - 2026-09-24 `4c8ad5e3` Merge branch 'agent/bugpipe' into sprint-11 [agent/bugpipe]
  - 2026-09-24 `ae862a85` Merge branch 'agent/audio-out' into sprint-11 [agent/audio-out]
  - 2026-09-24 `f4a2f870` Merge branch 'agent/baggage' into sprint-11 [agent/baggage]
  - 2026-09-23 `fdeae125` Merge branch 'agent/issues' into sprint-11 [agent/issues]
  - 2026-09-23 `11dd6fa6` Task 13's committed half from agent/bugpipe (the label script with its test, the triage pointer in HANDOFF and HUMAN_TASKS) [branch not named]
  - 2026-09-23 `b554c12b` Merge branch 'agent/savestate' into sprint-11 [agent/savestate]
  - 2026-09-23 `438aeb5b` Merge branch 'agent/chatrec' into sprint-11 [agent/chatrec]
  - 2026-09-23 `00f7648f` Merge branch 'agent/recompfix' into sprint-11 [agent/recompfix]
  - 2026-09-23 `4d624b4c` Merge branch 'agent/r0004' into sprint-11 [agent/r0004]
  - 2026-09-23 `a4f70518` Merge branch 'agent/launcher' into sprint-11 [agent/launcher]
  - 2026-09-23 `5a2dc44d` Merge branch 'agent/linuxring' into sprint-11 [agent/linuxring]
  - 2026-09-23 `d56fdd45` Merge branch 'agent/revision' into sprint-11 [agent/revision]
  - 2026-09-23 `3615dbbf` Merge branch 'agent/links' into sprint-11 [agent/links]
  - 2026-09-23 `47328922` Merge branch 'agent/howbuilt' into sprint-11 [agent/howbuilt]
  - 2026-09-23 `31251bc7` Merge branch 'agent/install' into sprint-11 [agent/install]
  - 2026-09-23 `7001d7e4` Merge branch 'agent/leak' into sprint-11 [agent/leak]
  - 2026-09-23 `86ace5f6` Merge branch 'agent/server' into sprint-11 [agent/server]
  - 2026-09-23 `c5c0764c` Merge branch 'agent/matcher' into sprint-11 [agent/matcher]
  - 2026-09-23 `0151783b` Merge branch 'agent/chat' into sprint-11 [agent/chat]
  - 2026-09-23 `45e5fce9` Merge branch 'agent/upstream' into sprint-11 [agent/upstream]
- 2026-09-24 `e63f9ba9` Merge pull request #44 from Scotho/docs/readable-image-notes [docs/readable-image-notes]
- 2026-09-24 `a548dd1a` Merge pull request #43 from Scotho/docs/scrub-main [docs/scrub-main]

## v0.10.0

Tagged 2026-09-23 on `f15acfab`.

33 merges.

- 2026-09-23 `f15acfab` Sprint 10 to main [sprint-10]
  - 2026-09-22 `e6855b53` main into sprint-10 after fix wave A slice 2 (PR #23) [main, main merged in]
- 2026-09-22 `15e06e1a` Merge pull request #23 from Scotho/fixwaveB-to-main [fixwaveB-to-main]
  - 2026-09-22 `76111c6f` main into sprint-10 after fix wave A slice 1 (PR #22) [main, main merged in]
- 2026-09-22 `a36029b5` Merge pull request #22 from Scotho/fixwaveA-to-main [fixwaveA-to-main]
- 2026-09-21 `a139c03c` Sprint 10 to main (7) [sprint-10]
  - 2026-09-21 `6c2e7388` Merge remote-tracking branch 'origin/main' into sprint-10 [origin/main, main merged in]
- 2026-09-21 `ab58f0fc` Sprint 10 to main (6) [sprint-10]
  - 2026-09-21 `6946a93c` Merge remote-tracking branch 'origin/main' into sprint-10 [origin/main, main merged in]
- 2026-09-21 `d0a4f568` the dev chain's record [branch not named]
- 2026-09-21 `1839d85e` Sprint 10 to main (5) [sprint-10]
  - 2026-09-21 `6dfa2c4d` the new-developer build chain closed: scripts/disc_to_elf.sh takes a stranger's ISO to the buildable ELF in one idempotent, self-verifying command (43 tests;... [agent/disc]
- 2026-09-21 `9fb1a509` Sprint 10 to main (4) [sprint-10]
  - 2026-09-21 `4afb802e` Q7's lock-light residuals: the console-replay case runs for real (the dump extracted from PCSX2's .gs captures), the Linux packaging branch tested on Windows... [agent/q7]
  - 2026-09-21 `6c9067f1` origin/main (PR #14, the third Sprint 10 slice) into sprint-10 [origin/main, main merged in]
- 2026-09-21 `01c8f86d` Sprint 10 to main (3) [sprint-10]
  - 2026-09-21 `5d9b7613` Q5 closed under the spec's stop rule: no headset button exists in lgaud's protocol (both listing passes negative, LGAUD.IRX decompiled for the first time); t... [agent/q5]
  - 2026-09-21 `0c172a6e` Q3, the mouse leaves the launcher and the game (its two knobs deleted with their code), the keyboard is menus and typing only for a player and the full gamep... [agent/q3]
  - 2026-09-21 `f2cf73bc` Q4, the rest of the launcher: the guide/window switch (XInputGetStateEx on Windows, BTN_MODE on Linux, a bindable second key), the game window's name, icon a... [agent/q4]
- 2026-09-21 `b9a0e251` Sprint 10 to main (2) [sprint-10]
  - 2026-09-21 `8ac0e357` Q2 Task 7's code: enforcement on, the eight switches to Flag, the pad on by default, the launcher's inherited environment filtered, the knobs line in the zip... [agent/flip]
  - 2026-09-21 `a7afbcc6` Q2 knob retirement, the mechanical tasks: the registry (149 rows), docs/KNOBS.md and its test, --dev and the [knobs] line, every read migrated in eight batch... [agent/knobs]
  - 2026-09-21 `3f27025c` Goal 9 Task 6: --prefilled, the harness logs in from the launcher's variables and presses ENTER instead of typing (17 tests; suite 1639 OK); the two driven l... [agent/g9t6]
  - 2026-09-21 `38579a3a` Goal 9's lock-free tasks: the OSK open handler named (FUN_0038d770, buffer 0x49ec70, caps 14/12), the prefill wrap, the config fields and environment, PLAYER... [agent/goal9]
  - 2026-09-21 `f4cdcbac` Q3b the mapping data path (one config-resolved table, defaults byte-for-byte today's, hash logged) and Goal 8 the CONTROLLER page's remapping UI (press-to-bi... [agent/input]
  - 2026-09-21 `7bd89eab` origin/main (PR #12, the Dependabot identity allowance) into sprint-10 [origin/main, main merged in]
  - 2026-09-21 `33f2fefd` the threaded fire-window flake fixed at its root: the simulated Clock runs its threads in lockstep, the endgames join through the injected wait (50 failed /... [agent/flake]
  - 2026-09-21 `ac80085b` Q6, a latched render stall is bounded: past the cap the state-carrying commands are absorbed into the game's VRAM and re-anchored when the latch clears (ps2x... [agent/stall]
  - 2026-09-21 `a66bf5f3` Merge remote-tracking branch 'origin/main' into sprint-10 [origin/main, main merged in]
  - 2026-09-21 `dd48d73e` Q1b, the gate states what it measured (PIN lines, the committed standard scripts/parity/pins.json, refuse-to-score on drift, --accept-pins) [agent/gatepin]
- 2026-09-21 `16f01333` allow Dependabot's commit identity in the leak check (PR #12) [branch not named]
- 2026-09-21 `92b92c6d` Sprint 10 hardening to main [sprint-10]
  - 2026-09-21 `3850080e` origin/main into sprint-10 [origin/main, main merged in]

## v0.9.0

Tagged 2026-09-20 on `4415254b`.

1 merge.

- 2026-09-20 `4415254b` A stranger's first run (v0.9.0) [sprint-9]

## v0.8.0

Tagged 2026-09-23 on `0e14323c`.

1 merge.

- 2026-09-18 `b65fe46d` Merge sprint-7 close-out docs (Task 7 Steps 6-7) [sprint-7]

## v0.7.0

Tagged 2026-09-23 on `d2700227`.

1 merge.

- 2026-09-18 `d2700227` two strangers, two machines, one hosted server [sprint-7]

## v0.6.0

Tagged 2026-09-23 on `8f57cbd6`.

0 merges.

## v0.5.0

Tagged 2026-09-23 on `c3cbad3f`.

1 merge.

- 2026-09-07 `9305c72c` SOCOM II movies through the sceMpeg HLE (menu background, intros) [feat/menu-movie]
