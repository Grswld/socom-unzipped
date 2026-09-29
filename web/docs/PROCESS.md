# How the web project is built

The technology, and the way the work was actually done. For the PC recompilation's side of the same story, see
[`../../docs/HOW_IT_WAS_BUILT.md`](../../docs/HOW_IT_WAS_BUILT.md).

## Built with AI agents, under one person's direction

This project is written by AI agents -- Anthropic's Claude models, run as Claude Code sessions -- working under the
direction of the project's owner. The owner sets the goals and the priorities, plays the builds, and makes the rulings
where the game and the PC differ or where a choice is taste rather than evidence. The agents do the research, write the
code and the tests, review each other's work, and keep the notes. Agent-written commits carry a `Co-Authored-By`
trailer naming the model. Nothing here was merged because an agent said it was right: the rule is a test, a
measurement or a console frame.

## The stack

| part | what | why |
|---|---|---|
| Language | TypeScript (strict), one npm workspace (`web/package.json`) | one language for the page, the tools and the server, so the rules run the same in both |
| Rendering | three.js with `WebGPURenderer`, falling back to its WebGL2 backend; node materials (TSL) | the GS's arithmetic expressed once as a node graph runs on both backends |
| App | Vite (dev server and static build), a Web Worker for decoding, Web Audio for sound, the Gamepad API | a static site: the page needs no server of its own |
| Unit tests | Vitest (with jsdom where a DOM is needed) | fast, per package (`packages/*/vitest.config.ts`, `tools/vitest.config.ts`) |
| Browser tests | Playwright (`packages/viewer/e2e/`), against real maps from your own disc | the picture, the HUD, the walk and multiplayer checked in a real browser |
| Server | Node, `ws` (WebSocket), bundled with esbuild | one authoritative process, one room per map |
| Deploy | a Docker image (non-root, health-checked), Compose with Caddy for HTTPS/WSS, a systemd unit for hosts without Docker, `deploy.sh` | [`../deploy/README.md`](../deploy/README.md) |
| CI | GitHub Actions `.github/workflows/web.yml`: `npm ci`, typecheck, the unit tests, the build, on changes under `web/` | the fixture-backed tests skip in CI, which has no disc |

## Ground truth

A value in the port is only as good as its source. In order of preference:

1. **The disc's data**, read byte for byte by the packages' parsers (the maps, textures, clips, weapon table, sound
   banks, scripts). A parser is written against more than one archive before code depends on it.
2. **The game's code**, through a Ghidra decompilation of the executable on your own disc. Research notes cite it as
   `FUN_<address>` and line numbers; where the decompiler lost an argument, the executable's own instructions were
   disassembled and cited by address.
3. **reCOM**, an open-source re-implementation of SOCOM 1's engine, for names and structures where the decompilation
   is silent.
4. **Console frames and memory**: PCSX2 captures of live rounds and the recompiled PC game, with cameras read from the
   console's own memory, for the picture and for measured positions.

When none of them gives a value, the code says so: a constant named `*_PLACEHOLDER` with a comment saying what was
searched. A reading that has not been measured on a console is called a reading, not a fact.

## Research notes as evidence

Every non-obvious behaviour has a numbered note in [`research/`](research/) (71-91 for the web project; the PC project's
notes are in [`../../docs/research/`](../../docs/research/)). A note opens with its answers, then shows the work: the
file offsets, the counts over all 22 maps, the functions and lines read, what is settled, what is not and what would
settle it, and the placeholders by name. Code comments cite the note and section (`research 84 §3`) and the function
(`FUN_005c2670`), so a reader can go from a line of code to the evidence and back. The
[corpus](corpus/llms.txt) indexes every section of every note and the files that cite it.

## Specs, plans and rulings

Each web sprint has a design spec and a plan (under [`specs/`](specs/) and [`plans/`](plans/)): sprint 1, the engine's
world (the maps as the engine drew them); sprint 2, the SEAL in the world (the player: camera, speeds, clips, weapons,
HUD, sound, effects); sprint 3, the round (respawn multiplayer on a central server). A plan's `## Log` is its live
record. Decisions are numbered rulings (`W3.R1` ...), dated and reasoned, and the owner can overturn any by number.

## Play-tests become rulings and research

The owner plays builds and says what feels wrong ("the jump height and duration is way off", "bullet marks too
light"). Each report either becomes a research round that reads the behaviour in the game's code (research 80's jump,
research 89 §13's marks, which turned out to be shaded by the wall's baked light), or a ruling where the owner chooses
the PC's way over the console's (no first person; tap and hold `C` for the stance). Research 90 records the play-tests
and the release sweeps, issue by issue.

## Parallel workstreams, one integration branch

The work is split into workstreams with clear boundaries -- maps, motion, look and aim, accuracy, grenades, traversal,
HUD, audio, effects, feel parity, multiplayer -- each run by an agent in its own git worktree and branch, cut from an
integration branch. A controller session briefs them, reviews what they report, and merges each branch back into the
integration branch with an explicit merge commit, running the typecheck, the unit tests and the browser tests after
each merge. Where two workstreams implement the same thing, one path is kept. Heavy runs (browser tests, load tests,
builds) take turns with the PC project's game runs on the same host.

## Tests first, and instruments

A change to behaviour starts with a failing test. Beyond the unit and browser tests, the project keeps instruments that
compare the port with the game:

- `tools/console-compare.ts`: the page beside a console frame at the same camera, measured region by region
  (research 82).
- `tools/feel-parity.ts`: the whole walk driven by script, one row per quantity against the console's number
  (research 88).
- `tools/release-sweep.ts` and `tools/playtest.ts`: every map, both presentations, both GPU backends: load times,
  a walk, stance, zoom, weapons, fire, a grenade, errors and screenshot statistics (research 90 §9).
- `tools/mp-bots.ts`: a server under 16 bots and 8 spectators, measuring tick time and prediction corrections.
- The `dump-*` tools: each format printed or rendered (textures to PNG, sounds to WAV, motion, effects, characters).

## Before anything is public

The repository is public. The leak check (`python -m tools_py.release.leakcheck`) runs in the commit and push hooks and
in CI and refuses key material, tokens, private addresses, home directories and files the `.gitignore` refuses; game
data never enters the tree at all. See [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).
