# Web sprint 3 — "the round": respawn multiplayer on a central server (design)

> Written 2026-09-29 by the local controller for a long-running cloud agent. Base: `claude/web-viewer-playtest-fixes`
> (the merged walk: the game's mover, camera, clips, rifle/sidearm, accuracy, grenades, traversal, HUD with the
> scoreboard, sound, effects). The sprint branch is `web-sprint-3-multiplayer`, cut from it. The plan is
> `../plans/2026-09-29-web-sprint-3-multiplayer.md`; its `## Log` is the live state. The game data the agent needs and
> cannot get from git is in the handoff zip (`HANDOFF.md` inside it says how to lay it out).

## 1. What was asked, and how it is read

The owner (Craig), 2026-09-29, verbatim in substance:

- **Full multiplayer** in the viewer's walk mode, **hosted on an AWS Lightsail box as a central server**, using
  whichever technology gives **the fastest and cleanest multiplayer experience**, with **hit mechanics** and a
  **scoreboard**.
- **Respawn matches, up to 16 players.** Everyone past 16 joins as a **spectator**, **queued in order**, and is
  moved in when somebody leaves.
- **The scoreboard roughly matching the game's**, rows cycling out as players leave.
- **No accounts.** Everyone has a **guest name** unless they set one in the settings, **limited to SOCOM's own name
  limits** if they can be found.
- **All assets and UI are the originals**, or highly accurate clones of them.

Read against the repository's standing rules (`web/redotcom/README.md`, the sprint 1-2 specs, the walk's research 80-90):

- **W3.R1 — the game is the reference.** Every rule of a round — damage per weapon and per body part, health,
  death, the respawn delay and where a SEAL respawns, team assignment and balance, the scoring, the kill messages, the
  scoreboard's layout, the name limit — is read from the SOCOM II decompilation (`socom2_game.elf.decomp.c`, in the
  handoff) and the disc's scripts, cited by `FUN_` address and decomp line as every earlier sprint did; reCOM
  (`research/recom` in the handoff) where the decomp is silent. A value not found is a **named placeholder**
  (`*_PLACEHOLDER` const, a comment saying what was searched), never a silent guess.
- **W3.R2 — server-authoritative, the sim shared.** One authoritative simulation on the server at the game's 60 Hz
  (`CGame::Tick`, research 71 §1.5); the clients predict their own SEAL with the **same TypeScript code** (the
  viewer's `Walker`, the collision probe and hull of `@s2u/scene`, `fire.ts`'s round, `accuracy.ts`, the grenade's
  `projectile.ts`) and reconcile, and draw everyone else interpolated. Nothing about movement feel changes for the
  local player: the walk's parity table (research 88) must hold with the network in the loop.
- **W3.R3 — the transport (the agent measures, then rules).** The default is **WebRTC unreliable/unordered data
  channels for the per-tick traffic (inputs up, snapshots down) plus a WebSocket for signalling and the reliable
  events** (join, leave, names, kills, the scoreboard), from a Node server (`node-datachannel` or an equivalent
  maintained binding; `uWebSockets.js` or `ws` for the socket). That is UDP-like delivery with no head-of-line
  blocking, in every current browser, and it is the lowest-latency option a browser has. **WebSocket-only is the
  fallback**, used automatically when the data channel does not open, and is also the first milestone (it is the
  quickest way to a working round). WebTransport is **not** the default: its browser and Node server support is
  still uneven; the agent may revisit it with evidence.
- **W3.R4 — hits are lag-compensated on the server.** A round is the client's `fire.ts` shot re-run on the server
  against the other players' **hit volumes rewound to the shooter's view time** (the shooter's interpolation delay +
  its measured latency, capped at 200 ms), then the game's damage rule. Penetration, the accuracy cone, the M4A1 SD /
  Mark 23 records and grenades all stay the merged code's; the server owns every result.
- **W3.R5 — no accounts, no persistence beyond the round.** A guest name is `GUEST####` style (the exact form is
  the agent's, within the game's name limit and character set) and lives in the browser's `localStorage`; the
  settings panel edits it. Names are sanitised server-side (length, charset, profanity is out of scope unless the
  game has a filter the decomp shows).
- **W3.R6 — the owner's boundaries.** No game data in git (the ZDB/ZAR archives, decoded bitmaps, sounds). No
  credentials in git or in the zip. **Provisioning the Lightsail box, buying anything, DNS, TLS certificates on the
  owner's domain and any public deploy are the owner's**: the agent writes the deploy (a Dockerfile, a compose file
  or a systemd unit, a one-command `deploy.sh`, a README section) and a row in `docs/HUMAN_TASKS.md`, and runs it only
  if the owner hands it credentials in the session. The server must not serve the disc's archives publicly: it needs
  only the collision hulls, the tuning and the weapon records, which it loads from a private directory at start.
- **W3.R7 — walk mode stays behind `?redotcom`.** Multiplayer is walk mode's; the flag gates it as it gates walking.

## 2. Where it stands (the data on hand)

- **The player** (`web/redotcom/packages/viewer/src/`): `walk.ts` (the mover: the decomp's stick law, stances, both jumps,
  landings, per-key action root motion, traversal seams), `playerCamera.ts` (`FUN_0029a950`), `look.ts` (the pad's
  look law), `animator.ts` + `locomotion.ts` (the game's pick-and-blend over `MOTION_P.ZAR`), `play.ts` + `bodyView.ts`
  (the SEAL mesh, gear, per-vertex GPU shading), `headLook.ts`, `weaponRaise.ts`/`weaponPose.ts`/`heldItem.ts` (the
  rifle raised to fire), `fire.ts` + `accuracy.ts` + `zoom.ts` + `rifleKick.ts` (rounds, bloom, knock, scope,
  penetration), `grenade.ts` + `@s2u/scene` `projectile.ts` (M67, HE, smoke, flash, claymore), `traversal*.ts`
  (ladders, climbs, peek, dive, water), `hud.ts` (the in-round HUD, **`scoreboard.ts`** — `FUN_0022a8b0`'s layout —
  and the message window `hud.postMessage`), `audio.ts` + `@s2u/sound` (the map's banks, positional, reverb),
  `effects.ts` (zAnim effects, lights), `gamepad.ts` (the PS2 layout incl. Select = scoreboard), `touchWalk` (phone).
- **The research** (`web/redotcom/docs/research/77-90`, `docs/research/`): motion, character mesh, weapons, jump, sounds,
  maps, look, accuracy (84: every M4A1 SD number), grenades (85: damage 10 out to 75, 0 at 150), traversal, HUD (87:
  the scoreboard §12, the message window §14 incl. "%s falls to their death", suicide and frag lines, the respawn fade
  found by motion research 80 §6c: `FUN_005979a0`, `FUN_00599b60`), feel parity (88) and the playtests (90).
- **The console's own multiplayer frames** (handoff `parity/s4_pcsx2/`): two PCSX2 clients, A and B, in one live
  Vigilance round, 260 in-game frames each (`A_ready*`, `B_ready*`), plus the lobby, persona and briefing screens;
  `parity/s11_r0004_round1/` the recompiled game at Frostfire spawns. These are the pixel references for another
  SEAL seen in the world, the scoreboard, and the round start.
- **Not in the tree, in the handoff:** the disc's `RUN/` subset (22 `MP*.ZDB`, `READERC.ZAR`, `ZWEAPON.ZAR`,
  `MOTION_P.ZAR`, `MPZANIM.ZAR`, `SOUNDRDR.ZAR`, `SOUNDS/BNKSTORE.ZAR`, `IRX/LIBSD.IRX`), the decompilation and its
  function and string lists, reCOM's source.

## 3. Goal and bar

**Goal:** open the viewer with `?redotcom` on any of the 22 maps; the page joins the central server's round for that
map (one round per map, or a server-chosen rotation — the agent's call, stated); up to 16 players are SEALs and
Terrorists on the game's teams, walking, shooting, throwing and dying by the game's rules and respawning where the
game respawns them; the 17th and later joiners spectate, see their queue position, and are moved in first-come
first-served when a player leaves; Select/Tab shows the game's scoreboard with everyone's kills, deaths and score,
rows leaving as players do; the message window prints the game's kill lines.

**The bar:**
1. **Feel intact.** Research 88's parity table holds for the local player at 0, 50, 100 and 150 ms of simulated
   latency with 1-2% loss (a test harness that injects both); no rubber-banding on a straight run, a jump or a stance
   change at 100 ms; corrections are smoothed, never snapped, unless the error exceeds a named threshold.
2. **Hits are fair and the game's.** A shot that the shooter's screen shows on a moving target hits on the server
   within the rewind window (tested with scripted bots at 100 ms); damage, head/body/limb multipliers, health, death
   and the kill credit follow the decomp (cited); grenades and claymores damage per research 85 by the same server.
3. **16 + spectators.** A load test of 16 bot players + 8 spectators on the Lightsail size the agent recommends holds
   60 Hz server ticks and the chosen snapshot rate with CPU headroom stated; the queue order is FIFO and survives
   rapid joins and leaves (property test).
4. **Originals only.** Remote players are the map's own character models (the SEAL: `chartype.rdr`'s `mp*_seal*`;
   the Terrorists: the map's own terrorist types) in their own gear, running the game's clips from replicated state;
   their rifles, sounds, muzzle effects and deaths are the game's. The scoreboard, the kill lines, the spectator view
   and the round-start sequence match the game's layout (research 87) and are checked against the s4_pcsx2 frames
   where a frame shows them.
5. **Names.** The game's own limit and character set for a player name (search the decomp and the online UI's
   strings; if not found, a named placeholder of 15 characters, A-Z 0-9 and a small set of symbols), a guest default,
   an editable field in settings, server-side validation, and duplicates resolved deterministically.
6. **Operable.** A deploy the owner can run in one command against a fresh Lightsail Ubuntu instance (TLS for the
   WebSocket on the owner's domain via Caddy or equivalent, the UDP port range the data channels use opened),
   health and metrics endpoints, structured logs, a documented restart. `npm run typecheck && npm test && npm run
   build` green at every merge; the existing e2e suite (39 specs with `?redotcom`) green; new multi-client e2e green.

## 4. The batch (the plan orders and details it)

- **M0 — Bring-up and baseline.** Lay out the handoff's data (`HANDOFF.md`), `npm run extract-maps`, run the whole
  suite and the parity table; record the baseline in the plan's Log.
- **M1 — The round's rules from the decomp** (research, no code): damage model and hit zones, health, death and
  respawn (delay, spawn selection, protection), teams and balance, scoring and kill credit, friendly fire, the kill
  messages, the spectator camera, the name limit, the match timer and end (respawn matches have a time and/or score
  limit — find the defaults). Output: `web/redotcom/docs/research/91-the-round.md`, every value cited.
- **M2 — The shared sim split.** Make the player's simulation runnable headless in Node without three.js/DOM
  (a `@s2u/sim` package or a clean `viewer/src/sim/` boundary): the mover, the probe and hull, the round and its
  accuracy, grenades; the render and audio stay in the viewer. Pinned by the existing tests.
- **M3 — The server** (`web/redotcom/packages/server`, Node/TypeScript): rooms per map, the 60 Hz loop, player/spectator
  sessions, the FIFO queue, input processing, snapshots (delta-compressed, quantised), the transport per W3.R3
  (WebSocket first, then WebRTC data channels with fallback), rate limits, health/metrics.
- **M4 — Netcode in the client:** connect/join/leave, prediction and reconciliation of the local SEAL, interpolation
  of the others, clock sync, the lag/loss test harness.
- **M5 — Remote players drawn 1:1:** the Terrorist models and their clips, the other players' rifles, muzzle effects,
  sounds (positional, the game's), footsteps, deaths, nameplates only if the game draws them.
- **M6 — Hits, damage, death, respawn** on the server (W3.R4), the client's feedback (the game's hit/damage
  indicators -- research 84 mentions the damage-direction markers --, the death and respawn fade, the kill lines).
- **M7 — Spectators and the queue:** the game's spectator view, the queue position UI, the promotion on a leave.
- **M8 — The scoreboard and names:** `scoreboard.ts` fed live (rows cycling), the name setting and validation.
- **M9 — Load, soak and chaos:** 16 bots + spectators, latency/loss matrix, reconnect, a server restart.
- **M10 — Deploy and the close:** the Lightsail deploy, the README, the research notes, the Log, the PR.

## 5. What is not in this sprint

Other game modes (Demolition, Extraction, Breach, Escort — their objects are future work), voice chat, anti-cheat
beyond server authority and rate limits, accounts, persistence across rounds, matchmaking across servers, bots in
live rounds (bots exist only as test clients), mobile-specific netcode tuning beyond what the touch layout already
gives.

## 6. Findings recorded during the sprint

*(dated, newest last — the agent appends here as earlier sprints did)*

- **2026-09-29 — the game has no respawn mode.** Respawn is SUPPRESSION's off-by-default create-game option
  (research 91 §4), and with it on the original's match is one timed round (§18). W3.R11 follows the owner's call:
  one timed match per map at that length.
- **2026-09-29 — the shared sim is exact.** The server's Frostfire hull is byte-identical to the page's and a 10 s
  scripted walk with root motion and traversal matches bit for bit (`simMap.test.ts`); with the command quantised the
  same on both sides, the page's prediction needs no correction under 150 ms and 2 % loss (`netcode.test.ts`).
- **2026-09-29 — the original's vote to remove** is a teammates-only strict majority applied at the round's end, with a
  rejoin refusal (research 91 §17); it has no idle kick (the owner's 3-5 minutes is new).
- **2026-09-29 — performance.** The traversal's climb search walked every grid cell (`ringCells`) and every polygon of
  every nearby object each tick; cached per cell with exact bounding rejects it runs 3x faster on server and page.
- **2026-09-29 — load.** 16 players + 8 spectators on one map: 60 Hz held, 1.1 ms a tick, 28 KiB/s a client.

## 7. Rulings

W3.R1-R7 above. New rulings are `W3.R8` onward, dated, with the reason; the owner can overturn any by number.

- **W3.R8 (2026-09-29) — the command stream.** The client's mover ticks at 60 Hz and every tick becomes one numbered
  command (stick, look, buttons); the server runs each player's commands in order through that player's own `Walker`
  (the same code on the same hull: `test/simMap.test.ts` shows the server's Frostfire hull byte-identical and a 10 s
  scripted walk bit-for-bit equal). The server stays authoritative -- it alone places, damages, kills and respawns --
  but prediction agrees with it by construction, so the local player sees no correction unless a command is refused or
  the sims disagree (then the error is smoothed; snapped past a named threshold). A respawn names the last command run
  on the old mover; the client replays the rest on the new one. *Why:* the walk's feel (research 88) survives latency
  only if the local mover never waits for the server; a lockstep-free command stream is the standard way (Source's
  usercmds), and the shared sim makes it exact.
- **W3.R9 (2026-09-29) — WebSocket first.** Binary frames for the hot path (commands up, snapshots down,
  `viewer/src/net/codec.ts`), JSON text frames for the rare reliable events (`net/protocol.ts`). WebRTC data channels
  stay the plan's second step, only if the measured WebSocket round shows head-of-line stalls under loss (M9).
- **W3.R10 (2026-09-29) — 30 Hz snapshots, full and quantised.** A body is 55 bytes; 15 bodies and one's own state
  are 860 bytes, 26 KB/s a client, 0.6 MB/s for 24 clients -- well inside a Lightsail box's allowance, so no delta
  compression until M9 measures a need (the plan's delta step is deferred, not dropped).
- **W3.R11 (2026-09-29, amended twice the same day by the owner) — one timed respawn match per map, the original's
  length and UI.** Each map is its own match (the owner: "each map is IT'S OWN RESPAWN MATCH"), timed as the original
  times it (the owner, after first asking for endless rounds: "let's go back to timed matches ... with the original ui.
  matching original match length"). The original's SUPPRESSION with RESPAWN on is **one round of the create-game
  default 6 minutes, and that round is the match** (research 91 section 18: the map scripts set `mp_game_over` at its
  end): the clock counts down MM:SS from 06:00 (`"%02d:%02d"`, `FUN_001f6b60`), at 00:00 "TIME EXPIRED" is posted and
  play goes on 15 s, the side with the higher team score wins (equal: a draw), the engine reads the result 3 s later,
  and the game's screens follow -- ROUND COMPLETE with WINNER / LOSER / DRAW per side, FINAL ROUND, GAME COMPLETE /
  FINAL TOTALS -- after which a dedicated server starts the next match on the same map (the original returns to its
  lobby). The round time is the server's `ROUND_SECONDS` (the game's choices are 4-10 minutes). The multi-round match
  (11 rounds, first to 6, the tiebreaker) is the game's rule with respawn off and stays in the room for that case.
  Teams of 8 by the game's join rule (Terrorists if fewer, or SEALs full, or both empty; else SEALs); scoring and the
  kill lines by the game's rules (+2 kill, -2 suicide/fall/team kill, +5 each on the winners, +1 alive at the end);
  respawn pressable 5 s after death once the body has faded (10 s), at the respawn record farthest from its nearest
  enemy (`FUN_002b7ee0`), with a fresh default kit; friendly fire off (the create-game default).
- **W3.R12 (2026-09-29) — names.** At most 30 characters of printable ASCII (research 91 §13; the in-game buffer);
  a guest is the game's own `"Player%d"` default, with a random four-digit number in place of the network index; a
  duplicate takes the lowest free `(2)`, `(3)` suffix within the 30 (the game's server refused duplicates; a refusal
  would strand a guest, so the spec's deterministic resolution wins).
- **W3.R13 (2026-09-29, the owner) — the kicks.** An **idle kick** (the owner's addition: the original has none,
  research 91c section 9): a player who sends no input for the room's kick time (a server setting held to 3-5
  minutes, default 4; the owner's "3-5 minute kick timer") is moved out -- to the back of the spectators' queue when
  anyone is waiting, else disconnected -- so an idle player never holds a slot from the queue. A **team vote to kick,
  as the original's** (research 91c; the owner's "full team vote to kick option pairing the original"): any living
  player toggles "VOTE RETAIN:REMOVE" on a teammate from the radio menu's TEAMMATES page (`FUN_0022f3c0` L81354); the
  vote stands until switched back or the voter leaves; the target sees " Voting: You have %d votes against you."
  (0x3f26c0, `FUN_002ba040` L159747); it passes on **more votes than half the target's team, the target counted**
  (`FUN_002c3550` L164913: 5 of 8, 3 of 4, never in a team of 2) and takes effect at the round's end [inferred from
  SOCOM 1's round-end script]; the kicked player sees UIMnLOC 539 "YOU HAVE BEEN KICKED FROM THIS GAME" and is refused a
  rejoin to that match with UIMnLOC 443 "You have been banned from that game. Please choose another." (by address,
  for 10 minutes: `VOTE_BAN_SCOPE_PLACEHOLDER`, a dedicated room never closes as the original's game did). A unanimous vote was the first reading of "full team"; the
  original's majority is what "pairing the original" asks, and the owner can overturn this by number.
