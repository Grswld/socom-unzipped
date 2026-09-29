# web/ -- the web half of SOCOM Unzipped

Three parts in one npm workspace (`package.json` here), each with its own README, tests and build. Nothing here needs
the recompilation, and the recompilation needs nothing from here.

| Part | What | Served at |
|---|---|---|
| [`redotcom/`](redotcom/README.md) | **redotcom**: SOCOM II's multiplayer maps decoded from your own disc and drawn in the browser (the map viewer), reCOM mode (walk, fight and play online as a SEAL), and the match server (`redotcom/packages/server`, its deploy in `redotcom/deploy/`) | socomunzipped.com/redotcom/ (`/map-viewer/` redirects there) |
| [`landing/`](landing/README.md) | **the landing site**, socomunzipped.com: the scrolling page, the console menu (`classic.html`), the development story (generated from `docs/STORY.md` at build time), the data page, the design-system gallery (`/ds/`) and the bug and tester inbox (`landing/api/`) | socomunzipped.com |
| `shared/` | what both use: the s2u design system ([`shared/ds/`](shared/ds/README.md), with its spec and briefing under `shared/ds/docs/`), the self-hosted fonts (`shared/fonts/`), the token and font tools (`shared/tools/`), the Vite glue (`shared/vite.ts`) and the site's deploy (`shared/deploy/site/`) | -- |

## Commands (from `web/`)

| command | what it does |
|---|---|
| `npm install` | the whole workspace; redotcom builds with vite 7 / vitest 3, landing and shared with vite 8 / vitest 4 |
| `npm run typecheck` / `npm test` / `npm run build` | all three parts, in turn |
| `npm run dev` | redotcom at `http://localhost:5173` (add `?devmode` to read the extracted maps) |
| `npm run dev:landing` | the landing site at `http://localhost:5180` |
| `npm run extract-maps` | your disc's archives into `redotcom/public/maps/` (git-ignored) |
| `npm run <script> -w @s2u/redotcom` / `-w landing` / `-w shared` | one part's own script (`-w redotcom` by path would select its packages too) |
| `HOST=... KEY=... bash shared/deploy/site/deploy.sh` | the owner's step: build both sites, leak-check the release, ship socomunzipped.com |

## No game data

No SOCOM II asset is ever committed. The extracted maps (`redotcom/public/maps/`), the test fixtures, the landing site's
menu movie and HUD sounds (rendered from your disc and from `tests/fixtures/audio`), the story's copies and every build
are git-ignored (`web/.gitignore`, the root `.gitignore`), and `tools_py/release/leakcheck.py` proves the maps and the
movie ignored on every run. CI is [`.github/workflows/web.yml`](../.github/workflows/web.yml).
