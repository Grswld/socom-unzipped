# Web sprint 3 — "the round" — implementation plan

> Spec: `../specs/2026-09-29-web-sprint-3-multiplayer-design.md` (§4 the batch, §7 the rulings W3.R1-R7). Written
> 2026-09-29 against `claude/web-viewer-playtest-fixes` (vitest 1389, e2e 39/39 with `?redotcom`). Branch
> **`web-sprint-3-multiplayer`**. Executed by one long-running cloud agent with a **$250 budget**. The Log at the
> foot is the live state, newest first.

**Goal:** a respawn round of up to 16 players plus a FIFO spectator queue on a central Lightsail server, with the
game's hit rules, deaths, respawns, kill lines and scoreboard, and the walk's feel intact under latency.

**Architecture:** a headless sim boundary (`@s2u/sim` or `viewer/src/sim/`) the server and client share; a Node
server package (`web/packages/server`) with a 60 Hz authoritative loop, rooms per map, snapshots down and inputs up
over WebRTC unreliable data channels with a WebSocket for signalling, reliable events and the fallback; the client's
`net/` layer (prediction, reconciliation, interpolation, clock sync) under the existing `WalkMode`/`Play`; the
viewer's `hud.ts`/`scoreboard.ts` fed from the server's state.

## The agent, its model and its strategy

**Main agent: Claude Opus 5.5 (`claude-opus-5-5`), effort `high`.** Why, against the alternatives (per MTok,
input/output: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Fable 5.1 $10/$50):
- The hard parts of this sprint are judgment calls across a large codebase — the sim split without breaking 1,389
  tests, netcode (prediction/reconciliation/lag compensation), reading the decompilation for the round's rules, and
  merging parallel work. That is Opus territory; Sonnet makes more integration mistakes on this shape of task, and
  each mistake costs a debug loop that erases its price advantage.
- Fable 5.1 is stronger still but 2.5x Opus's price: $250 would buy roughly a third of the working hours, too few for
  a sprint of this size. Reserve it for nothing here.
- Opus 5.5's default effort is `medium`; set `high` for the main loop (design, integration, review), `medium` for
  routine steps.

**Subagents:**
- **Sonnet 5.5** (`model: sonnet`) for well-specified, test-first implementation tasks with a precise brief and a
  bounded file set (the quantiser, the snapshot codec, the queue, the rate limiter, the deploy files, the load-test
  bot, e2e specs). Cheap, fast, and the brief carries the judgment.
- **Opus 5.5** subagents for decompilation reading (M1) and anything touching the netcode core or the sim split —
  where a wrong reading is expensive.
- **Parallelism:** at most 3 subagents at once, each in its own git worktree off `web-sprint-3-multiplayer`, merged
  back by the main agent (tests green before and after every merge). The main agent keeps its own context small:
  delegate reading-heavy work, keep the plan's Log and the spec's §6 as the memory.

**Budget ($250), planned split, tracked in the Log at every milestone:**

| Phase | Work | Model mix | Budget |
|---|---|---|---|
| M0-M1 | bring-up, the round's rules from the decomp | Opus main + 2 Opus research subagents | $30 |
| M2 | the sim split | Opus main (+1 Sonnet for mechanical moves) | $30 |
| M3-M4 | server + client netcode | Opus main, Sonnet for codecs/queue/limits | $70 |
| M5-M8 | remote players, hits, spectators, scoreboard, names | Sonnet implementers, Opus review/merge | $60 |
| M9-M10 | load/chaos, deploy, close | Sonnet for bots/deploy, Opus close | $35 |
| Reserve | debugging, the owner's feedback | — | $25 |

**Cost discipline:** prompt caching stays warm by keeping the main agent's context stable (append-only notes; no
re-reading large files — `grep`/`sed -n` ranges); never paste the decompilation or big JSON into the conversation;
read the 15 MB decomp only by `grep -n` + line ranges; run the full e2e only at merges; if the spend passes a phase's
line by 30%, stop, write the Log, and cut scope in this order: WebRTC (ship WebSocket-only, W3.R3 fallback),
spectator camera polish, nameplates, mobile.

## Global constraints

- **Setup:** see the handoff's `HANDOFF.md`. The disc subset goes to a directory outside the repo;
  `SOCOM_DISC=<that dir> npm run extract-maps` from `web/` fills the git-ignored `public/maps/` and `test-fixtures/`.
  Walk mode is behind `?redotcom`.
- **Tests first; every task:** `npm run typecheck && npm test && npm run build` from `web/`; the e2e suite
  (`npx playwright test`, port via `E2E_PORT`) at merges. New server tests run in Node; multi-client e2e drives two or
  more pages against a local server.
- **Commits:** conventional, explicit paths (`git add -- <paths>`), never `-A`, never `--no-verify`; the session's
  co-author trailer.
- **Citations:** as in every web sprint: `FUN_` addresses with decomp line numbers, research notes by number,
  reCOM paths with lines; placeholders named `*_PLACEHOLDER`.
- **No game data, no credentials in git.** The server reads its archives from a private path given by env.
- **Keep the walk's parity:** `tools/feel-parity.ts` and `tools/playtest.ts` (research 88/90) are the regression
  tools — run them with the network in the loop at M4 and M9.

## Tasks

### M0 — Bring-up and baseline
1. Lay out the handoff (`HANDOFF.md`), `npm install`, `extract-maps`, `typecheck`, `test`, `build`, e2e.
2. Run `tools/feel-parity.ts` (headless) and record the table's summary; run `tools/playtest.ts` on Frostfire.
3. Log the baseline (counts, versions, any failures with cause).

### M1 — The round's rules (research 91)
Search the decomp (`grep -n` on names/strings: damage, health, hit zones/body parts — `CZSealBody`, `CZBodyPart`,
`Damage`, `HeadShot`, respawn, `Respawn`, spectator, `Spectate`, team, score, `kills`, `deaths`, the scoreboard's
`FUN_0022a8b0`, name entry / `persona` / the online UI strings, time limits) and reCOM (`zDamage`, `zSeal`, `zGame`).
Deliver `web/docs/research/91-the-round.md`: every value cited, every unknown a named placeholder with what was
searched. Include the terrorist character types per map (`chartype.rdr`) and their default kits (`character.rdr`).

### M2 — The shared sim
Extract a headless boundary runnable in Node: mover, probe/hull, round + accuracy + penetration, grenade physics,
the stance/jump/action state machine, the timing (60 Hz). No three.js, no DOM, no Web Audio inside it. The viewer
imports it back; all existing tests pass unchanged or are moved with it. Add a Node test that runs 10 s of scripted
input on Frostfire's real hull and matches the browser's `walkFor` result bit for bit.

### M3 — The server
`web/packages/server`: Node LTS, TypeScript. Rooms (one per map; the agent picks rotation vs fixed and rules it),
sessions (player/spectator), the FIFO queue with promotion on leave, team assignment/balance per M1, the 60 Hz loop
consuming inputs (sequence-numbered, redundantly sent), snapshots at 20-30 Hz (the agent measures and rules)
delta-compressed against the last acked snapshot with quantised fields, the transport per W3.R3 (WebSocket first;
then WebRTC data channels via a maintained Node binding, the socket as signalling and fallback), per-client rate
limits, input validation (speed, fire rate against the weapon record), `/health` and `/metrics`, structured logs.
Unit and property tests for the queue, codec, and validation.

### M4 — Client netcode
`viewer/src/net/`: connect/join/leave, clock sync, input packing, prediction of the local SEAL with the shared sim,
reconciliation (replay unacked inputs from the server state; smooth small errors over a named window, snap only past
a named threshold), interpolation of remote entities at a named delay, the lag/loss injector for tests. The walk's
parity table and playtest must pass at 0/50/100/150 ms with 1-2% loss.

### M5 — Remote players, 1:1
Build the other players from the map's character types: the SEAL types and the Terrorist types, their gear and
weapons, running the animator from replicated mover state (stance, velocity, actions, aim pitch, fire/reload
events), their positional sounds and muzzle effects through the existing modules. Compare against `parity/s4_pcsx2`
frames where the other client is in view.

### M6 — Hits, damage, death, respawn
Server-side rounds with lag compensation (W3.R4) against per-body-part hit volumes built from the skeleton (the
game's hit zones per M1), damage per the weapon record and zone, health, death (the game's death clips and the
respawn fade), respawn (delay, spawn selection per M1 from the map's `AIMAPS.MPS` slots), grenade and claymore damage
per research 85. Client feedback: the game's hit/damage indicators, the kill lines in the message window.

### M7 — Spectators and the queue
The game's spectator view (research it in M1), the queue position shown in the game's message/HUD style, promotion
on a leave in order; a spectator never affects the round.

### M8 — Scoreboard and names
`scoreboard.ts` fed from the server (teams, kills, deaths, score per M1, rows removed on leave); the name field in
settings (limit and charset per M1), guest default, server validation, deterministic duplicate resolution.

### M9 — Load, soak, chaos
A headless bot client (Node, the shared sim, scripted movement and fire); 16 bots + 8 spectators on the recommended
Lightsail size; the latency/loss matrix; reconnects; a server restart mid-round; memory over a 1-hour soak.

### M10 — Deploy and close
Dockerfile + compose (or systemd), Caddy (TLS for the socket), the UDP range for the data channels, `deploy.sh`,
env-driven config (archive path, ports, room list), a `docs/HUMAN_TASKS.md` row for the owner's provisioning and DNS,
README sections (running a server, joining, the protocol), research 91 final, the Log's close entry, the PR against
`main` (owner merges).

## Log

*(newest first)*

- **2026-09-29 — opened** by the local controller: spec and plan written; branch `web-sprint-3-multiplayer` cut from
  `claude/web-viewer-playtest-fixes`; the handoff zip built (see `HANDOFF.md`).
