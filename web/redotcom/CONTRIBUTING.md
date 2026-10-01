# Contributing to the web project

The repository-wide rules are in [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md): the leak check and its hooks, branch
names, one topic per pull request, `type(scope): what and why` commit subjects, licensing of contributions (GPL-3.0
compatible), how to report bugs and security problems, and the conduct section. Everything below is what is particular
to `web/redotcom/` (the landing site's own notes are `../landing/README.md`).

## Setting up

- Node 24 or newer; from `web/` (the workspace root) or `web/redotcom/`: `npm install`.
- Install the repository's hooks once per clone: `bash scripts/install_hooks.sh` (from the repository root).
- Without a disc you can run `npm run typecheck`, `npm test` (the tests that need game files skip themselves) and
  `npm run build`. That is what CI runs.
- With your own disc: `SOCOM_DISC=/path/to/disc npm run extract-maps` (see [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md)),
  then the fixture-backed tests run too, and `npm run e2e` runs the browser tests.

## The rules the code keeps

- **No game data in git.** Not the archives, not decoded bitmaps, sounds, clips or glTF exports, not screenshots of
  the game. `public/maps/` and `test-fixtures/` are ignored; keep it that way.
- **Every value from a source.** A number that reproduces the game cites where it came from: the disc file it is read
  from, or the research note and section that reads it from the game's code (`research 84 §3`, `FUN_005c2670`).
  A value with no source is a `*_PLACEHOLDER` constant with a comment saying what was searched. Do not tune a number
  "until it feels right" without saying so in the name.
- **Research notes are evidence.** A new behaviour read from the game gets a section in the relevant note under
  `docs/research/` (or a new numbered note): what was read, where, what it settles and what it does not. Cite
  decompiled functions by address and line; never paste decompiled text or disc bytes beyond a short constant. After
  editing a note's headings, rebuild the corpus: `npx tsx tools/build-corpus.ts`.
- **Tests first.** A behaviour change starts with a failing test; say in the pull request what it failed with. Pure
  logic goes in a package's `test/`; what only a browser shows goes in `packages/viewer/e2e/`.
- **Keep the sim headless.** Anything the match's room (`packages/viewer/src/net/room.ts`) runs is reached from `packages/viewer/src/sim.ts` and must
  not import three.js, the DOM or Web Audio; `test/simBoundary.test.ts` enforces it.
- **Keep the package boundaries** described in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): `archive` reads bytes,
  `gs`/`mesh`/`sound` decode, `scene` models the engine's world, `viewer` draws and plays.
- **Say what you measured.** A performance or fidelity change gives the number, the command and the number before.

## How the maintainers work

The project's own work is done by AI agents under the owner's direction (see [`docs/PROCESS.md`](docs/PROCESS.md)).
Their conventions are the ones above plus: each workstream in its own git worktree and branch, merged into an
integration branch by a controller; commits stage explicit paths (`git add -- <paths>`, never the whole tree); no
`--no-verify`. Outside contributions follow the repository's pull-request flow in [`../../CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Developer notes

- `?devmode` is a development-only switch; the README's developer section describes it.

## Reading list

1. [`README.md`](README.md): what the viewer is and how to run it.
2. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the packages and their boundaries.
3. [`docs/DATA_SOURCES.md`](docs/DATA_SOURCES.md): where every kind of data comes from.
4. The latest sprint's spec and plan under `docs/specs/` and `docs/plans/`, and the research note for the area you
   are changing.
