# 80 -- The online menus' harness: every screen and flow, what drives it today, what a green is (Sprint 17 H1)

*2026-09-29 04:39Z (by `date -u`). A scoping note: nothing built, no run made. Line numbers are this branch's
(`agent/s17-h1` off `sprint-17` at `c1b66d0d`). KNOWN wins on any disagreement.*

**Relation to the earlier H1 note.** Task H1's deliverable already exists:
`docs/superpowers/specs/2026-09-28-online-menus-harness-scope.md` (commits `ce6a45e4`, `0f5aa2bd`, merged in batch 1:
the Sprint 17 plan's Log 06:14Z). That note covers only the flows **no** driven step reaches (clan, SETTINGS, rooms,
team swap, chat, microphone), each with its console reference and exact handler lines. This note is the **whole map**:
one row for every online screen or flow, the covered ones included, so that "what is green today" and "what one loop
day buys" read from one table. Where a row's detail is in the earlier note it says so rather than repeating it.

## 1. Purpose

The online menus' harness would prove, per screen, that our exe reaches it, draws it as the console does, and that
the server saw what the screen claims: a persona made, a game hosted, a line sent, a clan written. It is not a suite
(the owner's word, spec Milestone H: "targeted checks run when we need them"); each row is one script run by hand under
the lock. The server is **ours only**: the local Horizon stack (`server/README.md`, simulated mode, a throwaway
`config/simulated.db`) for any row that writes, or the hosted project box for a read-only row whose bar names it --
the hosted box's configuration is the owner's hand (spec D4). Never a community server (R293, `CLAUDE.md`
"Boundaries"). The console reference is PCSX2 on the same server through `tools_py/parity/pcsx2_shell.py`, which runs
the same staged steps over a PCSX2 window (its docstring, :1-20; macros `login`, `host`, `join`, `ready`, :72).

## 2. The harness's vocabulary (what "driven steps" means below)

- **Screen-verified presses** (`tools_py/parity/online_login_ours.py`, the `Shell`): `wait_for(<ref>, <s>)` polls the
  reference every 0.5 s and a timeout is `RESULT LOBBY-FAIL screen:<ref>` (:1197-1221); `press_until_gone(<btn>,
  <ref>)` presses until two reads 0.6 s apart both miss the reference (:1223-1235); `press_verified` checks a fresh
  frame after each press (:990). A stage is a `@staged(<name>)` function (:689-699) named in `LOBBY_STAGES` (:378:
  `login`, `host`, `join`, `map_select`, `ready`, `launch`). The references: `scripts/parity/refs/refs.json` (boxes for
  `login`, `universe`, `persona`, `eula`, `lobby_news`, `rooms`, `briefing_room`, `game_lobby`, ...) and the title
  crops `scripts/parity/refs/lobby/title_*.png`.
- **Blind presses:** `--then <btn>:<s>,...` after the lobby -- a fixed wait and a capture `20_then_NN_<btn>` each, plus
  `type:<text>` and `chat:<text>` (:2855-2865). No settle, no verify: the only way onto a page no stage reaches.
- **The offline drive:** `tools_py/parity/drive.py` scripts, `<mode>+<delay>:<BTN>` with `stable`/`long`/`next`/`idle`/
  `until`/`wait` (:4-8), a settle of `--settle` s (default 1.5, :433) within `--maxwait` (40, :434). Online it stops at
  the LOGIN screen: `scripts/parity/launch_to_online_ours.txt` is fixed waits to LOGIN only.
- **The gate has no online stage:** `GATE_STAGES = ("title", "transition", "mission")` (`tools_py/parity/gate.py:798`).

## 3. The rows

Cost: S = a run and a crop, M = a new stage or macro, L = a runtime change first. Bare `:NNNN` = `online_login_ours.py`.

| row | driven steps (settle rule) | what a green looks like | exists today | cost / blocked by |
|---|---|---|---|---|
| **Login** (persona select, password) | `boot_to_online` (:1704), `login` (:1769): `press_until_gone(cross, login)`, `wait_for(universe, 60)`, the persona CROSSes, the password on the OSK (or `--prefilled` :2788, `--saved-password` :2794), `press_connect` (:2065), `login_to_lobby` (:1891-1899) | `LOBBY class=OK` (:2854) and `09_lobby_no_news.png`; the form read-backs `login_name_glyphs`, `login_password_glyphs` (:906, :925) | **Yes**: stage `login`; PLAYTEST step 11 by hand (`docs/PLAYTEST.md:109-117`); the console: `pcsx2_shell login` (`docs/KNOWN.md:44`) | -- (green on every lobby run) |
| **Persona create** | `login` with no saved persona: `create_persona` (:1933) opens the name keyboard, types, reads the name back off the form; a second persona: `--new-persona N` (:2803) walks the list (`press_new_persona` :2017); a virgin card: `--mc-dir` (:2797) | the name read back off the form after ENTER; the persona ledger `<card>.personas.json` written (`docs/KNOWN.md:18`); server side: the account in `seed-simulated-db.ps1 -Show` | **Yes** (Sprint 16 L1b) | -- ; the launcher's row does not steer the game's list (`docs/LATER.md` row 46) |
| **The SOCOM II ONLINE menu** (the lobby's own menu) | after `login_to_lobby`: `--then down:2,...`, one DOWN and a capture per row, then back UP | one capture per row naming it; a title crop per page for the rows below | **Partly**: `to_briefing_room` knows one DOWN reaches BRIEFING ROOMS (:2166-2175); MESSAGES and IGNORE LIST are on record (`docs/research/22-kill-readout.md:278`); the full row list is not | S, no code; it blocks clan, SETTINGS, friends |
| **The room list** (BRIEFING ROOMS) and **the games list** | `to_briefing_room`, `select_room` (:2126, `--channel N` :2779); in the room `refresh_games_list` (:2569), `join_list_check` (:2593) | `rooms` and `briefing_room` references; an empty list is `RESULT NO-GAMES channel=<n>` (:657-664), not a failure | **Yes** for room 1; `--channel 2` never exercised: every capture shows one room (:2126-2141) | S for room 1; M for a second room (the local stack offers one channel: the earlier note, "Rooms") |
| **Hosting a game lobby** | `open_choose_games` (:2417), `host_game` (:2440), `choose_map` (:2368), which verifies the map row against `scripts/parity/refs/map_<name>.png` | the `game_lobby` title (`lobby_title_is`); the map verified before CROSS (`docs/DEVELOPING.md` "The online harness"); server side: the game in `GET /stats` when `StatsPrefix` is set (`server/README.md:153-159`) | **Yes**: stages `map_select`, `host`; console `pcsx2_shell host` | -- |
| **Joining a game lobby** | `join_game` (:2622) after a REFRESH; `join_balance_teams` (:2650) | the `game_lobby` title; one name in each team column (`lobby_teams_of` :2471) | **Yes**: stage `join`; console `pcsx2_shell join` | -- ; a host first (two instances, or one plus PCSX2) |
| **Swapping teams** in a game lobby | `lobby_select` row 1, SWITCH TEAMS (:2493); `online_match_ours.py --host-switch` (:4552), `--same-team` (:4549) | the presser's column empties on **both** screens (`lobby_teams_of` on A and B) | **Yes** as the join's balance and the two flags; a deliberate swap-and-back read on both sides is not a step | S (the earlier note, "Swapping teams") |
| **Chat line** (#26) | `online_match_ours.py --chat <text>` (:4542) -> `chat_exchange` (`online_match_ours.py:4455`) -> `chat_line` (:1612): R1, wait for the `ChatSkb` open line or the keys band, the pad walk, ENTER; wrapper `scripts/parity/control_round_chat.sh` | **Can prove:** the keyboard opened (log or screen), the line typed and the keyboard closed, the line on the other side's panel (captures), the verdict `control_round_readout.chat_round` (:615 of that file). **Cannot prove:** that the line crossed the client **bound** -- the wrap's `chat receive bound: seen=` line never printed while lines crossed both ways (`docs/KNOWN.md:150`); the receiving function is not identified (`docs/research/66-chat-step-rounds.md:197-201`) | **Yes** (Sprint 13 O2). The spec §1.5's "the harness cannot open the chat box" is #26's 2026-09-23 text, overtaken | S for the on-screen half; L for #26's bar: find the receiver and wrap it first (`docs/LATER.md` row 7) |
| **Briefing and launch** into a mission from the lobby | `ready` (:2697): READY verified by the label edge on two frames; the BRIEFING ROOM band read by `briefing_banner` (:835) | `liveness OK: <n> in-game peek rows` on both sides (`online_match_ours.py:716-721`, under `lobby_launch_budget` :4847 of that file) | **Yes**: stage `ready`; PLAYTEST 11 ("Host a game, start the round") | -- |
| **Return to the lobby** after a mission | the match to its end (`--rounds N` plays its rounds on one lobby success, `docs/DEVELOPING.md` "The online harness"), then wait for the post-match screens and press through | the `game_lobby` title on both instances within a budget after the match's end; neither process exits | **Nothing**: no step waits past the match's end | M; a match must end on its own -- the ladder's `--control-round` (round ends on its clock) is the nearest |
| **Clan pages** (create, roster, invite, messages) | the ONLINE menu walk to CLAN, then a new `@staged("clan")` step per page; the name and message keyboards' layouts are unknown | a title crop per page; server side: `seed-simulated-db.ps1 -Show` lists the clan, members, invitations, messages (`server/horizon-server/Server.Database/DbController.cs:1510` create, :1714 invite) | **Nothing** (the earlier note, four clan rows with the MLS handler lines) | M each, create first; the menu walk; a throwaway local database |
| **Online SETTINGS** | the menu walk, then per page: enter, change one value, leave, re-enter | the value reads back changed after re-entry | **Nothing**; which pages exist and where a value is kept are unknown | M |
| **Friends list** | the menu walk to it (its row is not on record); A adds B by name; B opens its list | both lists show the other's name; server side: the account's `Friends` in `-Show` (`DbController.cs:807` `AddBuddy`; handlers `MediusAddToBuddyListRequest` and `MediusGetBuddyList_ExtraInfoRequest`, `server/horizon-server/Server.Medius/Medius/MLS.cs:543`, :627) | **Nothing**: no step, no PLAYTEST step, no reference; the client's friends/ignore family is named only as classes (`docs/research/55-class-inventory.md:378`) | M; two personas online at once |
| **Microphone / voice** | a round with two instances (the headset opens only in a game session, `docs/KNOWN.md:167`); A fed `scripts/parity/refs/voice_ref.wav` and holding talk; B dumping its playback | B's playback correlated with the reference by `tools_py/parity/audio_corr.py --ref-wav` at the Sprint 8 plan's `--bar 0.90` (`docs/archive/sprints-7-12/2026-09-19-sprint-8-voice-headset.md:946`) | **Nothing** that can pass. PLAYTEST 12-13 ask by ear, expected **no** (`docs/PLAYTEST.md:123-131`) | **cannot-pass-yet.** (1) No capture device in the harness: only the fake input `PS2X_MIC_FAKE` (`scripts/parity/refs/make_voice_ref.py:4`); whether the PCSX2 setup presents a headset is unknown. (2) No voice relay proven: the game never sends under our runtime -- the talk flag never moves with any pad bit held (`docs/KNOWN.md:167`) though both talk actions are bound (`docs/research/66-chat-step-rounds.md:192`); the send callback records only in talk state 3 (`docs/research/56-sase-codec.md` §6.1); the received voice is only dumped (`micPlaybackWrite`, `third_party/ps2recomp/ps2xRuntime/src/lib/ps2_iop_host.cpp:330`). Q5 first: `voice-hear-the-other-player`, `voice-record-gain-and-dme`, `voice-research-35` (`docs/BACKLOG.md:62-65`). L |
| **Logoff** (Q2's route) | `online_login_ours.py --prefilled --existing --then triangle:5,triangle:5,left:2,cross:8` after the lobby (`docs/research/78-back-to-the-main-menu.md:53-57`) | the main menu matched against `scripts/parity/ref_main_menu_ours.png` (the spec's §2 Q bar, its line 295); no exit 74, no `[guest-fault]` | **Partly**: the route as `--then` presses. The spec names a harness step `quit_online`; no such step exists (only `scripts/parity/quit_mission.txt` and `quit_mission_ingame.txt`, both offline) | S once Q2 lands; blocked: the restarted guest presents no frame (`docs/KNOWN.md:130`, Q2b) |
| **Announcement scroller** (Q3) | login with a 1,000-character body in a local copy of `server/config/db.config.json`; hold on the page, a capture a second | the contact sheet against PCSX2's on the same server; today's `lobby_news` is the SERVER NEWS box closed at login (:1895-1897) | **Partly**: `lobby_news` is waited for and closed; no hold, no long body (Q3 NOT STARTED, the Sprint 17 plan's row Q3) | S; Q3 builds the drive; the local stack only (D4) |

## 4. What one loop day buys

Every row is lock-bound (a game run), so a "day" is a window the owner names under R334's rules (`docs/DEVELOPING.md`
"Measuring a change without a chain"), one instance per run where the row allows. The three cheapest rows not green
today, in order:

1. **The SOCOM II ONLINE menu walk** -- one instance, no code: `online_login_ours.py --existing --prefilled --then
   down:2,...` with a capture per row. Green: the row list and a title crop per page, committed under
   `scripts/parity/refs/lobby/`. First, because clan, SETTINGS and friends all start from it.
2. **Swapping teams, both sides read** -- two instances, `online_match_ours.py --host-switch` with no `--play`: A
   swaps, both read `lobby_teams_of`, A swaps back. Green: the column moves on both screens, twice. The read exists;
   the step is a few lines.
3. **The room list, leave and re-enter** -- one instance: `to_briefing_room`, BACK, CROSS, read `briefing_room`
   again. Green: the title read twice and the room's name span identical. The second-room swap waits for a second
   channel on the local stack.

The chat row's on-screen half is already green (research/66 rounds 2 and 3); the logoff and the announcement ride
Q2b and Q3 rather than a harness day.

## 5. Not covered, and why

- **Voice by ear.** Only a human ear says the voice is intelligible; the correlation bar says only that the samples
  arrived (PLAYTEST 12).
- **Two machines across real NATs.** The harness runs two instances on one host; a second network is a PLAYTEST
  sitting with a friend (step 12, `scripts/parity/two_machine_readout.sh`).
- **Timing-dependent screens.** The scroller's speed, a slow host's dropped presses: the harness reads settled frames,
  so moving text is captured, not judged; Q3 compares the two sheets side by side.
- **The online screens' music** (#94, `docs/BACKLOG.md:30`): the owner's ear first; the harness can only drive the
  screens a capture needs (the clan row does that).
- **Anything on a server that is not ours** (R293): PSRewired's lobby is reached by the owner's hand only.
- **The launcher's ONLINE page and persona viewer**: not a game screen; the launcher's own tests own it.
