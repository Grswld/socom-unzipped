# The playtest — one sitting, in order

For the owner: row O8 of `docs/HUMAN_TASKS.md`. This folds the hands-on items into one evening, ordered so that each step sets up
the next and the things you have complained about come while your ears are fresh. One line back per step is enough;
"fine" is an answer. Anything not on this page that annoys you is the most useful note of all. The italic name after
a step is the item as the owner's list first wrote it (`docs/archive/HUMAN_TASKS-to-2026-09-25.md`, which says where each one went).

**This is the script for the next sitting.** The last one was on 2026-09-22, on the 2026-09-21 build; the steps that
sitting answered are struck below with what it found and where each finding went, and what is left open is what the
next sitting is for. *(Rewritten 2026-09-25, Sprint 13 S1, stranger audit S24 and documents audit row 44: this page
still presented the 2026-09-21 build as "Ready" three days after it was played, and its decisions section asked
questions already answered.)*

<!-- build:begin -->
```
build:    2026-09-27T14:25:29Z   commit 6d78365c77bb (sprint-16)
archive:  socom2-portable.zip   [player]   (dist-release/portable/socom2-portable.zip)
          sha256: 58f9c87b65c24224b05073c28d45fe52a06c0e6c6efcde063533c0b203235a2e
exe:      socom2.exe sha256: a706d8b821ef750c4b71049f8619f9543c95d6efa058133fb729d4c01be9745f
```

Written by `python -m tools_py.playtest_block` from the manifest `scripts/make_portable.sh` wrote with this archive (the chain's last step); play that archive, unzipped to a new folder.
<!-- build:end -->

> Superseded 2026-09-25 (Sprint 13 S1) -- the block that stood here, kept as the record of the last sitting's build:
>
> ```
> build:    2026-09-21 (evening), release at -O1 (R151)   commit: acbc693 (v0.9.0-239-gacbc693, sprint-10; untagged)
> archive:  dist-release/portable/socom2-portable.zip  56,581,263 bytes
>           sha256: c3058d286dd8bb299b2914faceae730128664f7bf3633aad93ffeaa4d7c05003
> gate:     s10_playtest2_gate -- 3/3 (title, transition, mission) on the exe INSIDE that archive:
>           socom2.exe 227,390,464 bytes, sha256 098cf126758b7dbdda175536d9dff34b5f43be594a56c343fd2d4caa2ff54997
>           (the archive also passed the release leak check: 0 hits over the staged folder)
>
> the previous sitting's build, for the record:
>           2026-09-20, tag playtest-1, zip 55,829,577 bytes sha256 f8f8149c..., gate s9_p7_playtest_gate 3/3
> ```
>
> It was followed by "**Ready.**" and a list of what was new since `playtest-1`; the owner played that archive on
> 2026-09-22 ("The playthrough, 2026-09-22" in `docs/CURRENT_SPRINT.md`: eight findings, R236-R240).

**Not ready until the block above is filled.** If you want to play before that, play `dist/` and say which commit
(`git log -1 --oneline`); the notes still count, but step 1 and step 9 only mean something on the archive.

## Before you start
- Close any launcher that is already open (an open one holds the exe locked and you would be testing the old build).
- Pad plugged in; headset if you have one; Steam Input and DS4Windows off for a Sony pad.
- Unzip the archive to a NEW folder, not over an old one. Play from there -- it is what a stranger gets.

## The sitting

0. **Folded in where they fit** -- do them as you reach them, not as a block: at **step 3**, CONTROLLER > BUTTONS:
   rebind one face button (the page's hints walk you through it), take SWAP when it says the button is taken,
   then RESTORE DEFAULTS and confirm (~~press the row, then the button; a countdown runs, hold B or Escape
   cancels~~ -- the rebinding flow became hold-a-button-to-remap in fix wave A, `668c7f5`, W9, so follow the page); AUDIO > LAUNCHER: the menu sounds and their toggle. At **step 7**, press the
   pad's XBOX/guide button while the game runs -- the launcher should come forward, and again send you back (if
   nothing happens, bind SWITCH to another button on the BUTTONS page and say so; on a Sony pad on Sony's own driver
   the PS button is the one measurement the machine could not make). At **step 11**, pick your persona in ONLINE's
   PERSONAS list (NEW PERSONA if it is not there yet) and, if the PASSWORD field shows beside it, type the password:
   the game's password keyboard should open already filled and you only press ENTER; after that login the persona is
   listed, and once a login goes through with nothing typed the field is gone. Say which of
   these did not happen.

1. **The download is whole** *(the release download, c)*. `certutil -hashfile socom2-portable.zip SHA256`
   and compare with `SHA256SUMS`. Did Windows SmartScreen or your antivirus complain when you ran it? What did it say?
2. **Double-click `socom2.exe` with no launcher** *(failures explain themselves, a)*. It should start on the
   launcher's saved settings, or tell you in a sentence why it cannot. No black console window left behind. Quit.
3. **The launcher, by pad only** *(the launcher's look; the launcher with the pad; pick the pad)*. Does it look right?
   Walk every page with the pad. On CONTROLLER: is your pad in the list, does the drawn pad follow it, where did you
   leave the dead zone? Click into a text field on ONLINE, leave it, and check the pad still drives the launcher.
   **Still to confirm from the sitting before (landed 2026-09-20, P4, never reported on):** the flash at the top left
   when you change page should be gone; UNZIPPED should sit level with SOCOM II; "Second instance" should be under
   ADVANCED on ONLINE; "what is a profile?" should be answered where you look for it. Say which of those is NOT fixed.
   ~~*Answered 2026-09-22:* the pad stopped driving the launcher after a text field was clicked; the CONTROLLER
   graphic should be better, with hold-a-button-to-remap.~~ Both fixed in fix wave A (`46a6594`, W1; `668c7f5`, W9)
   -- this step now checks the fixes.
4. **A failure that explains itself** *(b)*. Point DISC at a path that does not exist: the DISC page should say
   `cannot open the file`, and LAUNCH should grey out with the same sentence. Point DISC back
   and let it verify. Then, with the launcher still open, rename your ISO and press LAUNCH: LAST RUN should say the
   disc was not found (exit 66). Rename it back. Press SAVE DIAGNOSTICS, open the zip: your Windows user name should
   be nowhere in it.
   *(Superseded 2026-09-25, Sprint 13 S1: this step said "Point DISC at a path that does not exist, press LAUNCH: LAST
   RUN should say the disc was not found" -- which cannot happen, because the launcher greys LAUNCH out on a disc
   that fails its check (`launchBlockedReason`, stranger audit S11). Exit 66 is reached only when the disc goes away
   after the check.)*
5. ~~**Title and intro, by ear** *(listen to the title screen and the intro)*. Through the logos, the intro movie and
   a minute of the title loop. Clean and continuous?~~ *Answered 2026-09-22:* "excellent from the outset" -- title,
   logos, intro movie. Nothing to do unless it has changed.
6. **THE MUSIC** *(the mission music)*. NEW GAME, the first mission, X through the dialog, walk toward the first two
   targets and keep going: the longer the better. Is it coherent? If not: where, and does it sound like a cut, a
   fade that should not be there, or two pieces of music at once? Those are three different bugs and the word you
   pick sends the next fix to the right place.
   ~~*Answered 2026-09-22:* the first small stutters in the mission briefing, and the mission music "skips worse the
   longer the mission runs".~~ Now two open defects: about a dozen 50 ms dropouts a mission that are ours, not your
   speaker's (issue #42), and the degradation over time (issue #28). Listen again once either says it is fixed.
7. **The pad drives one window** *(Goal 9)*. While the game runs, press d-pad and face buttons: the launcher behind it
   must not move. When you quit the game, the launcher must respond again. "RUNNING" should sit level with its lamp.
8. **Crouch** *(R139)*. In that mission: L-stick click toggles stand/crouch (it acts on release); Y still goes prone
   and back. If you have a Sony pad: CROUCH SHORTCUT = TOUCHPAD, and the touchpad click crouches.
9. **The save** *(the save prompt)*. Start from a card the game has never used (set a new `"profile"` in `config.json` by
   hand -- the ONLINE page has no card field since the PERSONAS list). Pick the difficulty that asks to save, YES, slot 1. Quit the game, start it again: it should not
   ask again, and your progress should be there.
   ~~*Answered 2026-09-22:* the first save on a brand-new card failed at the control-type prompt and worked on the
   second launch.~~ Fixed in `152579a` (a trailing `..` on a fresh card now resolves to the card root, with a
   regression test), and a failing card command now always logs itself (R238) -- this step now checks the fix on a
   virgin card.
10. **Free play, five minutes** *(listen in free play; re-listen after the sound fixes)*. Gunfire, voice-overs, music.
    Does mission sound last the whole five minutes?
11. **Online, on the project server** *(play a match on the hosted server)*. ONLINE page: the status line should say
    the server is up and how many are on. Launch, go online. The preset reaches the server by NAME; that cannot cost
    you your persona, because the name is resolved before the game ever sees it (R175). **If the game cannot connect at all, pick Custom, type
    `3.143.65.100` and try again** -- that is the same box by its raw address, for the case where your network cannot
    resolve the name. Tell me if you had to, because nothing on screen says that is what went wrong. Host a game,
    start the round, walk around. Lag? (The box is in Ohio.) Listen on the screen just after signing in, in CREATE
    GAME and in the lobby: that is where the stray sound was. Also: does the game remember your password after you
    quit and start again? ~~It is not expected to yet (issue #27) -- say what you see.~~ (retracted: #27 closed
    2026-09-25, the password survives)
    ~~*Answered 2026-09-22:* a stray sound on the online screens ("a short and ramping deviation from the note");
    the prefilled login is "the wrong design".~~ The sound was charged to a sound bank and the charge withdrawn by
    measurement (R239: the bank's one-shots are inaudible under the song); what you heard is not yet found, so say
    if you still hear it. ~~The prefill stays, because the game's own saved password does not survive a restart
    (R237 as rewritten 2026-09-23).~~ (retracted: #27 closed 2026-09-25, the password survives)
12. **If a friend on another network is around** *(the first two-machine match -- carried since Sprint 7)*. They unzip
    the same archive, need their own r0001 ISO, pick the same preset, and join you; then swap who hosts. Did you SEE
    their soldier move? Afterwards, from each machine's `logs/` take the newest `run_*.log` and run
    `bash scripts/parity/two_machine_readout.sh <log1> <log2>`; paste the block. With a headset on both sides: could
    you hear each other? (Expected today: **no** -- the launcher's MICROPHONE page says the game does not send your
    voice yet. ~~"the headset's talk button is not wired yet"~~ -- superseded 2026-09-25, Sprint 13 S1: the game's
    protocol has no headset button at all, `docs/KNOWN.md`'s voice row.)
13. **Microphone** *(pick the microphone and watch the meter)*. MICROPHONE page: pick the headset, speak. Does the bar
    move with your voice and rest when you are quiet?
14. **Report a bug from the launcher** *(Goal 8)*. REPORT A BUG: write one real note from tonight, leave the log box
    as you find it (it should be OFF), read what it says it will send, SEND. You should get a `BR-` id. Is the wording
    what you wanted?

## Decisions worth making while it is fresh
- **Who else gets this archive?** For you alone, nothing to decide. For anyone else, decision D2 comes first: the
  archive contains code recompiled from the game, and the game's decrypted ELF (`docs/HUMAN_TASKS.md`, row O1 of its
  table) (answered 2026-09-26, R290: the exe ships, the ELF never).
- ~~**A profile viewer** in the launcher -- wanted?~~ *Answered (R295):* wanted, issue #73 -- the ONLINE page's
  PERSONAS list (Sprint 16 L1b).
- **Should the download drop the built-in debugger and the dump/trace probes** to get smaller? You will get a number
  (megabytes saved) before you have to answer.
- ~~**The keyboard.** Players lose the gameplay keys, the test harness keeps them behind developer mode -- or the
  harness moves to the pad first.~~ *Decided and built 2026-09-21 (R210, Sprint 10 Q3):* players get menus and
  typing, and the gameplay keys work only in developer mode, which every harness launch is.
- ~~**The repository going public** needs six answers from you, D1-D6 in the Sprint 11 spec.~~ *Done:* the repository
  has been public since 2026-09-20 (D1 was made by the flip), and D2-D6 proceed on the defaults in
  `docs/HUMAN_TASKS.md`'s rows O1 and O3 until you change one.

## Where your notes go
Say them to the controller in any form. It files each one as a task, a `docs/KNOWN.md` row (and an issue, when it is
a defect with an artefact) or an answered row in `docs/HUMAN_TASKS.md`, and they go to the top of the open sprint's
queue (`docs/CURRENT_SPRINT.md`). *(Until 2026-09-25 this said "Sprint 9, item Q0".)*
