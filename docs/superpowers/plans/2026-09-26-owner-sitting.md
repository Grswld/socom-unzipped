# The owner's sitting of 2026-09-26 -- every row of HUMAN_TASKS walked, and the rulings that record the answers

The owner walked `docs/HUMAN_TASKS.md` row by row with the controller session "HUMAN_TASKS walkthrough" from about
16:30Z to 20:30Z. Each row was presented with what it was, what the loop had done and why it had stopped short of
deciding; the owner answered in their own words; the controller acted on what could be acted on the same evening and
turned the rest into issues. This file is the home of the rulings R290-R297 (the global counter, `docs/HANDOFF.md`
section 2; the Sprint 15 controller allocates the numbers after them). The struck rows themselves are in
`docs/archive/HUMAN_TASKS-to-2026-09-25.md`, "Struck rows moved from the live table", verbatim.

## The rulings

- **R290 (2026-09-26 17:05Z, the sitting, O1) — `socom2.exe` ships in release archives only, never in the repository;
  `socom2_game.elf` never ships publicly; the ELF is built on the player's machine from their own r0001 ISO by a native
  first-run decrypt inside the launcher (issue #70); no installer; no on-demand download of the exe.** The owner's
  words: "I am leaning towards pushing socom2.exe, but only in the distributed builds"; "D2 seems the safest"; "I
  agree with your suggestions" (the archive, not a fetched exe; the launcher is the installer). Until #70 lands,
  developer copies with the ELF go by the owner's hand. The precedent named: every N64 and Xbox 360 recompilation
  ships the recompiled program and derives the rest from the player's own copy on first run; none ships the original
  binary. The FAQ's sentence "no game executable, no recompiled C++" is rewritten under #70.
- **R291 (2026-09-26 17:20Z, the sitting, O3) — the audio fixtures cut from the disc are regenerated from the
  contributor's disc at test time and dropped from HEAD; the VU1 dump images and every picture of the game's art stay;
  no history rewrite; GPL-3.0 for everything that is ours; the development record stays where it is (the controller's
  call: the story and CONTRIBUTING read it in place); unsigned until a release exists; FFmpeg's 20 % on the Windows
  download accepted.** The owner: "regen audio and keep the rest in 1 and 2. no rewrite"; "GPL-3.0 for everything
  that is ours is fine"; "cert can wait for release"; "also fine on the install size".
- **R292 (2026-09-26 17:35Z, the sitting, O4) — the launcher's post-SEND line excepts security reports ("unless it is a
  security report: those go through SECURITY.md, never a public issue"); the CONTACT field's caption "only if you
  want an answer" is dropped and no reply is promised; the site's five items (the controls claim, the GitHub
  sentence on its form, the canary marked in the inbox, the account id out of the scanner, a data page under the
  stated policy) go to the site session as its own TODO file (`TODO-s2u-2026-09-26.md` under that repository's docs folder); the message to the
  PSRewired moderator stays the owner's, to send in the coming days.** Built the same evening on `agent/launch-rev`
  (the second commit of the #69 worktree).
- **R293 (2026-09-26 18:10Z, the sitting, O5) — the launcher obtains the r0004 package itself and takes the steps
  (fetch, decrypt with no console identity, build the r0004 ELF, switch to the shipped r0004 exe), not the game's own
  update flow (issue #71); the in-game path is not made to work; two rooms by revision on our Horizon when needed
  (#72), our server being a test bed standing in for the community one; the community preset stays a placeholder
  until the owner says otherwise; there is no r0004 disc; the HDD maps are far future; connections to PSRewired's
  server are made only by the owner's hand and with the owner's express permission, each one named, never by the
  loop on its own.** The owner: "I made the decision that ... the launcher should just obtain it and take the required
  steps"; "do NOT point community server yet"; "we'll ask for forgiveness instead of permission". The evening's three
  permitted runs: two traced runs of our client to SELECT UNIVERSE and past DOWNLOAD NOW (the game makes no network
  call after the prompt in our runtime: `logs/psrewired_fetch/run2/run.log`), and one PCSX2 run through a logging
  proxy for the request URL and the served bytes (`logs/psrewired_fetch/pcsx2/`, its result on #71).
- **R294 (2026-09-26 19:10Z, the sitting, O6 and O13) — no nightly ladder: the Task Scheduler entry stays disabled and
  the online tests run when a task needs them; the second machine is not yet; `main` keeps 0 required approvals and
  CODEOWNERS is advisory; agent code that a Fable-class reviewer passed with high confidence, or that tests confirm,
  may merge to `main` without a human review until the owner calls stability; the Dependabot merges are the
  controller's call (#8 and #9 merged 2026-09-26, #10 rebasing); homepage and topics set; SECURITY says "reports are
  read", promising no response time; history untouched.** The owner: "every change is not reviewed by humans at this
  stage. once we've achieved stability i'll make that call"; "our server is just a test bed fill in for the community
  one quite honestly".
- **R295 (2026-09-26 18:40Z, the sitting, O7 and O8) — the player archive drops the debugger and the probe binaries
  and a developer archive keeps them; the report's log box stays off; the listens and the pad hands wait for a quiet
  machine; a profile viewer on the ONLINE page replaces the PROFILE, NAME and PASSWORD fields (issue #73).** The
  owner: "the release can drop debugger and probes"; "I DO want a profile viewer in the launcher to replace the vague
  username/password that exists now".
- **R296 (2026-09-26 19:50Z, the sitting, O11, O12, O14, O16, O18, O19) — the naming defaults D1-D7 stand as the loop
  judged them; the hand read of the five routines and the holding of the 148 slot-count namings become one future
  task, together with running the matcher across the Aug 28 2003 beta now in hand (`game/beta_scus_973_66/`, a
  complete ELF without symbols); the crouch knob's registered default becomes `l3` (the fourth commit of the #69
  worktree) and hover tooltips on the CONTROLLER page are issue #74; the merged-branch sweep was run the same hour
  under the owner's token (the `sprint-*` ruleset lifted, 16 remote branches deleted, the ruleset restored); #25,
  #26 and #42 stay on the backlog (the owner's recollection of a chat line crossing both sides is the harness half
  of #26, which works; the bar left is the receiver a lobby line uses); the private-inputs location is retired
  (issue #75, the site's half in its TODO); the story-site change is committed as the owner's (`83c62d75`).** The
  owner: "I unfortunately don't have enough reverse engineering expertise to offer much support right now ... store
  the rest as a potential future task"; "yes delete the merged cloud branches"; "retire the private input section
  location forsure"; "commit as mine".
- **R297 (2026-09-26 19:25Z, the sitting) — lock-bound work (a build, a game run, a chain) is announced as a window by
  the session that runs it, to the owner and to the other controller sessions on the machine, before it starts; game
  runs wait for a window the owner names; a session holds nothing heavy while the machine is under the runner's
  memory bar.** The owner, with free memory at half a gigabyte and a permitted run refused: "probs sprint 14 work
  may need to communicate a window". Applied the same hour by the Sprint 15 controller (its queued builds dropped
  until the owner's run had passed, then one at a time at `-j 4`, announced).

## Open after the sitting (the live table's rows)

O2 (the release drafts: which to delete, the symbols' home, the verify half's dry run), O4's moderator message, O5's
Goal F conversation, O7 and O8's hands on a quiet machine, O10 (file later), O15 (not yet), and a new row O20: the
windows the owner names for game runs (the first asked: the Sprint 15 drag test in a mission, #67).

## What the evening also produced

Issues #69 (the launcher started `socom2.exe` whatever GAME VERSION said; fixed on `agent/launch-rev`, PASS WITH
FINDINGS, the runtime's ELF-name key widened in its third commit), #70, #71, #72, #73, #74, #75; the beta image and
the European SOCOM 1 demo under `game/` (git-ignored); the site's TODO in the site repository; the repository's
homepage and topics; the sweep; Dependabot #8 and #9 on `main`.
