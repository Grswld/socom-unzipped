# The online menus' harness, scoped (Sprint 17 Task H1)

Date: 2026-09-28 03:39Z (by `date -u`). Status: **the scoping note** Task H1 owes
(`docs/superpowers/plans/2026-09-27-sprint-17-tasks.md:523-539`), against the spec's §1.5 and Milestone H
(`docs/superpowers/specs/2026-09-27-sprint-17-sixty-and-the-way-back-design.md:146-157, 323-337`). It names, one row
per online screen or flow the harness does not drive today, what a targeted check would press, what it would read back,
how the console (PCSX2 on our own server) reaches the same screen, what it costs, and what must be true first. Nothing
here is built; no run was made to write it. Line numbers are this branch's (`agent/s17-h1` off `sprint-17` at
`d2fea276`). KNOWN wins on any disagreement.

The owner's word on when these run: **not a suite that runs every commit or sprint; targeted checks run when we need
them, for our confirmation and the parity goal** (spec, Milestone H). So this is not a gate stage, not a `build.sh test`
entry and not a ladder: each row is one script run by hand under the lock when a reason names it (the last section).
Nor is it the login, host, join, ready and match flow, which the `@staged` steps of
`tools_py/parity/online_login_ours.py` (`login` :1769, `map_select` :2368, `host` :2440, `join` :2622, `ready` :2697)
and `online_match_ours.py` already drive with a read-back per press (`docs/DEVELOPING.md:996-1031`).

## What every row builds on

- **The drive.** `scripts/parity/launch_to_online_ours.txt:5-17` is fixed-wait presses to the LOGIN screen only; the
  verified path is `online_login_ours.py`: `boot_to_online` (:1704), `login` (:1769) ending in `login_to_lobby`
  (:1891-1899: EULA, SERVER NEWS closed, `09_lobby_no_news`), which leaves the game on the SOCOM II ONLINE menu. From
  there `--then` (:2855-2865) sends blind presses with a capture after each (`20_then_NN_<btn>`) -- the only existing
  way onto any page below. The menu's rows are **unknown** as a list: the tree records MESSAGES and IGNORE LIST
  (`docs/research/22-kill-readout.md:278`) and that one DOWN from where it opens reaches BRIEFING ROOMS
  (`to_briefing_room`, :2167-2175); the owner named MESSAGES, BRIEFING ROOM, AUTOPLAY and CLAN pages (`docs/KNOWN.md:131`).
  So the first step every menu row shares is a **menu walk** (a DOWN, a capture, repeated, as
  `scripts/parity/menu_explore.txt` does for the main menu), whose captures name the rows and give the title crops.
- **A new stage** is a `@staged(<name>)` function (decorator :689-699) with `<name>` added to `LOBBY_STAGES` (:378),
  each press through `press_verified` (:990) with a check on a fresh frame, a miss ending in `RESULT LOBBY-FAIL <class>`.
- **Two read-back kinds exist.** Whole-screen references `scripts/parity/refs/<name>.png` with a box in
  `scripts/parity/refs/refs.json`, read by `Shell.is_screen`/`wait_for` (:1182-1215); and title-band crops
  `scripts/parity/refs/lobby/title_<name>.png` (plus a `.pcsx2.png` sibling where the console's ~7% narrower drawing
  moves the words), read by `lobby_title_is` (:798-817), cut by `tools_py/tests/fixtures/lobby/make_screen_fixtures.py`.
- **The console.** `pcsx2_shell.Pcsx2Shell` is the same `Shell` over a PCSX2 window (`tools_py/parity/pcsx2_shell.py:32-37`),
  so any new staged step runs on it; a row adds one macro name (choices :72, dispatch :53-64). `login B` reaches our
  server and the briefing room (:53-56); the console has hosted and joined on the hosted server
  (`docs/KNOWN.md:42-43`). R1 is bound for PCSX2 (`tools_py/parity/keys.py:22`).
- **The server side.** Our Horizon runs in simulated mode (`server/README.md:213-218`): clans are implemented and
  persisted to `config/simulated.db` (`server/horizon-server/Server.Database/DbController.cs:1510-1537` create,
  :1714 invite, :1822 respond, :1986 post message), which `server/seed-simulated-db.ps1 -Show` decrypts and prints
  (:60-71). Every row that writes to the server runs against the **local** stack with a throwaway database, never the
  hosted box (the owner's hand).

## The rows

| flow | drive steps (nearest script, the step it extends) | read-back that proves it | console reference | cost | precondition |
|---|---|---|---|---|---|
| **Clan: create** | `online_login_ours.py` after `login_to_lobby` (:1891): a new `@staged("clan")` step -- walk to the CLAN row, CROSS, CREATE, the clan name typed with `Shell.type` (:1308); the clan-name keyboard's layout is **unknown** (the chat keyboard's was not the login's: `CHAT_OSK_*` :1544-1550) | crop `scripts/parity/refs/lobby/title_clan_create.png` from the walk's capture; the server's record: `seed-simulated-db.ps1 -Show` lists the clan with our persona as leader (`DbController.cs:1522-1531`); handler `MediusCreateClanRequest` `MLS.cs:1471` | `pcsx2_shell clan B` (new macro): the same step on the console, its own persona and clan name | M | the menu walk; local Horizon stack with a fresh `simulated.db` (the create persists: `DbController.cs:1537`) |
| **Clan: roster** | the `clan` step extended: CLAN -> the member list, one capture per page | crop `title_clan_roster.png`; the member count off the list rows (a row-lit read like `lobby_row_lit` :825); the server's list `MediusGetClanMemberList_ExtraInfoRequest` `MLS.cs:1671` beside `-Show`'s members | `pcsx2_shell clan B` reading its own roster; after the invite row, both sides read the same two names | S (after create) | a clan exists; two members for a roster worth reading (the invite row) |
| **Clan: invite** | two instances as `online_match_ours.py` runs them (`INSTANCES` `online_login_ours.py:99`): A (leader) invites B by name; B opens its invitations and accepts | crops for the invite and the invitation pages; `-Show`: B's account in `ClanMemberAccounts`; handlers `MLS.cs:1927` (invite), `:1518` (check invitations), `:1966` (respond) | one instance plus PCSX2 (`scripts/parity/mixed_match2.sh:75` launches it): ours invites the console's persona, then the reverse | M | a clan (create row); two personas logged in at once |
| **Clan: messages** | the `clan` step on both sides: A posts a line (the keyboard as in create), B opens clan messages | crop `title_clan_messages.png`; B's page carries the line (a crop of the posted line, cut on the first good run); `-Show`: the clan's `ClanMessages`; handlers `MLS.cs:2176` (send), `:2080` (get mine) | the console as the reader of ours' post, and the reverse | S (after invite) | a two-member clan |
| **Online SETTINGS pages** | the menu walk, then one staged step per page: enter, change one value, leave, re-enter | a crop per page; the round trip: the value reads back changed after leaving and re-entering; whether a value is kept on the card or the server is **unknown**, so which of a card read or `-Show` proves it is unknown | `pcsx2_shell` with the same step: the console's page set is the reference for ours | M (the page list is unknown) | the menu walk; which pages SETTINGS holds, and whether it is a lobby row or a page under another, is **unknown** |
| **Rooms: ANNOUNCEMENT** | Task Q3's new `scripts/parity/announcement_hold.txt` (from `launch_to_online_ours.txt`: login, the page, 30 s held, a capture each second -- tasks `:421-444`) | the contact sheet Q3 makes; `lobby_news` (`scripts/parity/refs/lobby_news.png`, box `refs.json:38-46`) is the SERVER NEWS box closed at login (:1895-1897); whether it shows the same text as this page is **unknown**; a crop `title_announcement.png` from Q3's first capture | Q3 Step 3: `pcsx2_shell login B`, then the page by screen-verified presses (tasks `:436-437`) | S (Q3 builds the drive) | Q3's local body (`server/config/db.config.json:7-8`, 1,000 characters) |
| **Rooms: BRIEFING ROOMS, and swapping between rooms** | `to_briefing_room` (:2167-2175) with `--channel N` (`select_room` :2126); extended: leave the room (the BRIEFING ROOM's own back), re-enter, then enter room 2 and back to room 1 | `rooms` (`scripts/parity/refs/rooms.png`) and `lobby_title_is(g, "briefing_room")`; the room's name is in the title band right of x 235 (:442-449), so a per-room crop of that span proves which room; Medius's `GET /stats` lists lobby channels and who is in the lobby, when `StatsPrefix` is set (locally `http://127.0.0.1:10080/`, `server/README.md:153-159`) | `pcsx2_shell login B` already enters room 1 (:56); a `--channel` for the console is a one-line pass-through | S for leave/re-enter; M for the swap | the swap needs a server offering two rooms: all 306 room-list captures show one (:2130-2141), `--channel 2` is written and never exercised; how the local stack offers a second channel is **unknown** (`SimulatedChannelName` names one; `MediusCreateChannelRequest` `MLS.cs:3077` exists) |
| **Rooms: clan chat** | the menu walk to the clan's room; then `chat_line` (:1612) typed there | the room's crop; the line on the other member's screen (a crop, as for chat below); the server's generic-chat handler routes Broadcast and Whisper and logs `Unhandled generic chat message type` for any other (`MLS.cs:4118-4149`, `:4179-4187`) -- a line of the Medius console log (`server/start-servers.ps1:16`: `logs\console-<component>.log` under the server folder) | the console as the second member | M | a two-member clan (invite row); where the clan room sits in the menu, and which chat type the game sends there, are **unknown** |
| **Swapping teams in a game lobby** | `join_balance_teams` (:2650-2681) already presses SWITCH TEAMS when both names sit in one column; extended: from a balanced lobby, each side presses SWITCH TEAMS (`lobby_select` :2493, row 1) and back | `lobby_teams_of` (:2471-2473): the (seals, terrorists) text-pixel counts, read on **both** instances after each press -- the presser's column empties on both screens; no new crop | `pcsx2_shell join B` already runs the join's balance step (:60, `join_game` default `switch=True`); a `switch` macro adds the deliberate press | S | a host and a joiner in one game lobby (`host` and `join` stages) |
| **Chat, both ways across the line** | exists: `scripts/parity/control_round_chat.sh` -> `online_match_ours.py --chat` (:4542, :4797-4805) -> `chat_exchange` (:4455) -> `chat_line` (`online_login_ours.py:1612`); extended to the BRIEFING ROOM (`CHAT_ROOM_TITLES` :1543 already names it) and in-round | **first assertion, #26's closing bar as written:** "The function that receives a game-lobby chat line on the client found (Sprint 13 O2 showed it is not libmedius's MediusChatFwdMessage callback that the Sprint 11 wrap bounds: two rounds carried lines both ways on screen while the wrap never fired), bounded there with a unit test and the gate 3/3; then `scripts/parity/control_round_chat.sh` (A hosts, B joins, A types, B replies) with B's log showing the new bound entered (`seen=1`) and the line on B's screen; briefing-room and in-round chat covered or named as untested; the server-side path of the line read from the Horizon MLS/DME log." Then: the receiver's shot `chat_<A>_to_<B>` (:4477) with the line, and the reverse; the verdict `control_round_readout.py` `chat_round` (:615) -> `VERDICT.txt` | ours types to PCSX2 and PCSX2 types back (R1 bound, `keys.py:22`); the console's side reads on screen only -- it has no wrap | S (the drive exists) | #26's receiver: the wrap's `seen=` line (`CHAT_SEEN_RE` :1541) never printed while lines crossed both ways (`docs/KNOWN.md:149`, `docs/research/66-chat-step-rounds.md`); finding it is `docs/LATER.md` row 7 (M). The spec's "the harness cannot open the chat box" (§1.5) is #26's 2026-09-23 text; Sprint 13 O2 built that step |
| **The microphone across the line** | `control_round_chat.sh`'s shape: A hosts, B joins, both READY into a round (the headset opens only in a game session, `docs/KNOWN.md:166`); A launched with `PS2X_MIC_FAKE` = `scripts/parity/refs/voice_ref.wav` (`make_voice_ref.py:1-19`), A holds the talk action; B with `PS2X_MIC_DUMP_PLAYBACK` | B's playback dump correlated with the reference: `tools_py/parity/audio_corr.py --ref-wav` (`tools_py/tests/test_audio_corr_refwav.py:1-6`), the Sprint 8 plan's bar `min_corr >= 0.90` (`docs/archive/sprints-7-12/2026-09-19-sprint-8-voice-headset.md:942-948`); a `PS2X_PEEK` of the route words `DAT_004130a8`, `DAT_004130a0`, `DAT_0045a0c1` (r0001, `docs/KNOWN.md:166`) and the voice object's `+0x4a` (its base is not in `guest_addresses.py`: **unknown** here); then by ear, `docs/PLAYTEST.md:127-129` | **none known possible**: whether the tree's PCSX2 setup presents a USB headset is **unknown**, and no route to talk is known on either side | L (the path), M (the check) | **In order:** (1) **the talk action** -- research/39 read it unbound in the loaded preset `controller.rdr` (`docs/research/39-headset-talk-button.md:89-117`); KNOWN withdrew that on 2026-09-26: both talk actions are bound (0x0a -> slot 0x0d, 0x0b -> slot 0x07) and the flag never moved under sixteen held pad bits, so the gate is one of the routes' other conditions, unidentified (`docs/KNOWN.md:166`, `docs/research/66-chat-step-rounds.md:92-102`); (2) **the send callback** -- `voice_net_fill_cb` 0x30f990, which the network library calls and which records and encodes only in talk state 3 (`docs/research/56-sase-codec.md:328-345`); with the talk flag never moving, that state was never entered under our runtime (inferred from `docs/KNOWN.md:166`); (3) **the audible receive** -- `micPlaybackWrite` only dumps (`third_party/ps2recomp/ps2xRuntime/src/lib/ps2_iop_host.cpp:330`), `voice-hear-the-other-player`, the Sprint 8 voice plan's Task 5 (`docs/BACKLOG.md:64`; plan `:198`); (4) `voice-record-gain-and-dme` (`docs/BACKLOG.md:65`); (5) `voice-research-35` (`docs/BACKLOG.md:67`). **This row cannot pass yet: the game does not send your voice under our runtime, so the check is written and marked cannot-pass until a sprint builds the voice path (Q5).** |

`docs/PLAYTEST.md` steps 11-13 (:109-131) are the manual side of the last three rows: a hosted match, the question
"could you hear each other?" with **no** as the expected answer, and the launcher's meter, which proves capture on one
machine only. The launcher says the same sentence (`tools_py/tests/test_launcher_wording.py:123-131`).

## When it runs and how

**The gate is "when we need them"**, the owner's word: before a play test that will exercise the online menus (a
`docs/PLAYTEST.md` sitting, `docs/HUMAN_TASKS.md` O8), after a change to the online path (`online_login_ours.py`'s
stages, the chat or voice wraps in the runtime, `lgaud`, the server's config or handlers), when an issue's bar names a
row (#26 names the chat row; #94's bar, `docs/BACKLOG.md:30`, needs the MESSAGES, BRIEFING ROOM, AUTOPLAY and CLAN pages
driven against the console), and at a sprint close whose plan names rows. Never per commit, never in the gate chain.

**A run** is one script under the lock, as `control_round_chat.sh` is (:15-17):
`bash scripts/loop_lock.sh run <owner> --wait <min> -- bash scripts/parity/<row>.sh [out]`, the script never taking
the lock itself, sourcing `scripts/parity/env.sh` (the server address `PS2X_SOCOM2_SERVER` :43, the per-revision
`PS2X_PEEK`), writing `logs/<name>.done` as its last act. Two instances of ours (`online_match_ours.py`, A and B), or
one instance plus PCSX2 (`mixed_match2.sh`'s shape: `pcsx2_ctl launch B`, then `pcsx2_shell <macro> B`); the artefacts
under `logs/parity/<stamp>/`: each side's captures, the drive log, the run logs' byte marks, the server's `-Show`
output where the row writes to it, and one `RESULT` line. Every row that writes to a server uses the local stack.

**If this sprint does not build a row** (Milestone H builds only if time remains after F, Q and A), the first row goes
to `docs/LATER.md`: **clan: create, size M** (the menu walk, a `clan` stage and a macro, the clan-name keyboard, crops for
both targets, a throwaway local database); value to the owner: a named online page covered, and the drive #94's capture
needs; confidence: the server side is implemented (`MLS.cs:1471`), the client side undriven. **Trigger:** the first of
#94's capture task being planned (it needs the CLAN page driven), a play-test report of a clan-page defect, or a sprint
plan naming clans.

## Unknown, as written above

The SOCOM II ONLINE menu's rows and order; where CLAN, SETTINGS, AUTOPLAY and the clan room sit; the clan-name and
message keyboards' layouts; whether SERVER NEWS and the ANNOUNCEMENT page show one text; where SETTINGS values are kept; how the local stack offers a second channel; which chat type
the game sends in the clan room; whether the Medius console log records each request at the tracked level; the voice
object's base address for the `+0x4a` peek; whether the PCSX2 setup presents a headset; the condition that gates talk.
