# The landing site -- socomunzipped.com

The public site of SOCOM Unzipped, in `web/landing` since 2026-09-29 (before that, `apps/s2u` in the owner's
`scotho` repository). One of three parts of `web/`: this site, [`../redotcom`](../redotcom/README.md) (the map viewer
and reCOM mode, served under `/redotcom/`) and `../shared` (the design system in [`../shared/ds`](../shared/ds/README.md),
the fonts and the site's deploy). The SOCOM II: U.S. Navy SEALs main menu recreated in the browser, and the pages
around it.
Three pages: `index.html` is the scrolling web site (the default view, `src/home.ts`); `classic.html` is the console
menu (`src/main.ts`, reached by CLASSIC in the web page's bar and footer; its WEB button under the speaker leads back); `story.html` is
the development story, generated from this repository's `docs/STORY.md` at build time (see
`docs/2026-09-20-s2u-web-page.md`). The two share their chrome: the design system and the markup in
`../shared/ds/chrome.md`; `src/home.css` is only the web page's own. `/web.html` still answers, as a redirect to `/`.
Design: the main-menu design of 2026-09-17 (in the owner's scotho history; its rulings are carried in this README).
The web page says what the project is in plain words, not as a product (owner, 2026-09-24): no sales lines, no
release-date promises, and the play-test signup is a notify list ("leave an email to hear when a build is ready",
NOTIFY ME under SETUP, the same `/api/testers` inbox behind it). Its look follows the game's own screens; the rules
are in `../shared/ds/chrome.md`.

## What it does
- Boot screen: the game's two cyan typewriter cards, each typed in, held a beat and faded to black as the
  game does its "PRESENTS" and "DEVELOPED BY" cards: "WELCOME TO / PROJECT UNZIPPED", then "AN OPEN SOURCE
  PROJECT". The menu follows on its own after the second fades (a key, click or pad press skips ahead). The
  cards tick per character with TYPE, the same sound as the briefing panels, where the browser already lets the
  page sound (a return visit in Chrome, say). Otherwise browsers keep a page silent until it is touched, so the
  cards run quiet, the movie starts muted and the first key, click or pad press brings the sound in; until
  then the speaker shows as muted.
- Menu: the looping background movie with its music, the logo, the roller (ABOUT / SETUP GUIDE /
  SERVER / REDOTCOM / BUG REPORT / GITHUB, lit row steadily glowing, no pulse or flash, wrap at both ends; a move rolls
  every row one slot over 0.2 s, growing into the lit slot or shrinking out of it, as the console's wheel
  turns), the footer. ABOUT opens the
  MISSION BRIEFING-styled about screen (tabs, typed text, DEPLOY opens the SETUP GUIDE, GITHUB above it, DEVELOPMENT STORY above that opens `/story.html` in a new tab, BACK returns);
  GITHUB opens the repository in a new tab (`src/github.ts` holds the URL; the briefing's GITHUB button and the web site's links use it); SERVER STATS opens the live view of the hosted Horizon
  server (status, location, players online / in game / in lobby, open games with map, slots and
  roster, uptime, peak players and games hosted since the server started), refreshed every 5 s.
  REDOTCOM opens redotcom, the map viewer (`/redotcom/`), in a new tab (owner, 2026-09-27; renamed from MAP VIEWER
  and `/map-viewer/` on 2026-09-29, which now answers with a permanent redirect). A speaker button (or M) sits top-right inside the
  stage: click mutes, hovering slides out a volume bar (default 70%); both are remembered in localStorage. Every screen works with keyboard, mouse and a controller: Up/Down, W/S, mouse wheel, click
  and gamepad d-pad/stick move; Enter, Space, X, click on the lit row and the gamepad cross button
  select. On a phone the wheel takes a tap (a dim row or an arrow moves, the lit row selects) and a swipe,
  which rolls it one row per 28 px of travel in the finger's direction; a held mouse drags it the same way. Move plays THUNK, select plays DINK, BACK plays BACK, a blocked move plays NEG. While a
  briefing or guide panel's text types in, TYPE ticks per character (HUDUI sound 7, the game's own
  pre-mission briefing typewriter) and stops with the text; it plays at half the level it first shipped at
  (owner, 2026-09-20).
- `?nav=slide` swaps the move sound for SLIDE (the alternative candidate; see below).

## The design system
`../shared/ds/` is the design system this site and redotcom share: the owner's S2U Briefing design made into CSS
(spec `../shared/ds/docs/2026-09-27-s2u-design-system.md`; the gallery at `/ds/`, `ds/index.html` here). The pages link
`/src/ds/index.css`, which `vite.config.ts` aliases to `../shared/ds/`; `src/home.css` imports it by relative path.
`index.html` and `story.html` are built on it; classic stays as it is.

## Build inputs (never committed)
Everything the pages use that is not source is made at build time by `tools/prepare.mjs` (`npm run dev`, `npm test` and
`npm run build` run it first) and is git-ignored:
- `public/story/` and `public/img/logo.webp`: copied from `docs/story/` (the one copy; the SOCOM II UNZIPPED logo is
  `docs/story/img/logo.webp`, matted from the owner's artwork by `tools/build-assets.py logo`).
- `story.html`: generated from `docs/STORY.md` by `python -m tools_py.story.site --full-document` (the procedure for a
  new story entry is `docs/story/UPDATING.md`).
- `public/sfx/*.ogg`: the HUDUI 989snd bank sounds rendered by `tools/render_hudui.py` (a Python port of the runtime's
  snd989 mixer) from the tracked fixtures in `tests/fixtures/audio`, then Vorbis-encoded; `npm run build` renders them
  when missing (needs ffmpeg). Sound 0 DINK is the confirmed select sound (CROSS on the menu plays it in every logged
  run). The move sound was never captured in a log; 2 THUNK is shipped, 3 SLIDE is the other candidate.
- `public/media/menuloop.mp4` (~6.5 MB): `npm run assets -w landing -- video` cuts it from the disc under `game/disc`
  (`MOVIES/COMMON/MENULOOP.PSS`: 640x448 MPEG-2, deinterlaced to 30p, H.264, muxed with the PSS's own PCM music track,
  private stream 1, SShd, 48 kHz stereo, 512-byte L/R blocks, as AAC). The console restarts the movie when it ends, so
  one looping file reproduces video and music together.
- `public/img/intel.jpg` (the About screen's photo, from a local parity golden), `public/img/share.jpg` (the link
  preview) and `art/logo-unzipped*.jpg/webp` (the owner's title artwork): local inputs, kept out of the repository
  because they show the game. The page runs without them; `deploy.sh` refuses to ship without the movie and the sounds.
- `e2e/goldens/home-*` and `story-*`: the home and story goldens show game imagery and stay local; the gallery's are
  tracked.

A missing input is reported by `prepare.mjs`, not fatal. Look: a 0.45 px blur on text plus a faint scanline overlay
soften it towards the console's composite output; the logo is composited normally over the video. On wide windows a
blurred, dimmed copy of the video (painted from a 32x24 canvas) fills the window behind the 4:3 stage, whose sides are
masked to fade into it.

## Develop, test, deploy
From `web/` (one npm workspace for the three parts):

    npm install
    npm run dev -w landing        # http://localhost:5182 (the viewer's dev server is 5173)
    npm test -w landing           # the pages, the gallery and the inbox (vitest, jsdom); npm test -w shared: the system
    npm run build -w landing      # prepare + typecheck + vite build -> web/landing/dist
    npm run e2e -w landing        # Playwright at 1280 and 390 (E2E_PORT overrides the port)
    HOST=... KEY=... bash shared/deploy/site/deploy.sh   # build both sites, leak-check the release, ship it

Deploy target: an nginx container `s2u` (compose project `s2u`, `../shared/deploy/site/`) and the inbox container
`s2u-api`, on a box beside the stack that owns the shared compose network and the Cloudflare tunnel connector that
publishes `socomunzipped.com`. The box's address, its key and the tunnel's configuration are the owner's and are not in
the repository: `deploy.sh` takes `HOST` and `KEY` from the environment. Keep the compose project named: an unnamed
project in a folder called `src` collides with a neighbour's and `--remove-orphans` would remove the other container.

## Server stats
`src/stats.ts` (pure, tested) parses `GET /api/stats` and shapes it for the screen; everything from the
server is cut to length and written with `textContent`. nginx proxies `/api/stats` to the game box's
Medius stats endpoint (the hosted server's `:10080/stats`, `StatsServer.cs` in `server/`), with a
two-second micro-cache and a canned `{"status":"offline"}` when the box does not answer. The game box's
firewall opens 10080 to the site box's address only. Map names: only Medius level
ids seen in a real round are named in `stats.ts` (`MAPS`); add more as they are verified.

## Setup guide
`src/guide.ts` holds the SETUP GUIDE's tabs (requirements, install, go online, trouble, roadmap). It is the
MISSION BRIEFING screen with a second tab set: ABOUT's DEPLOY opens it, and its own bottom button opens
REPORT A BUG. Keep it true to this repository (the portable README, the launcher's pages, the hosted server).

## Report a bug
The REPORT A BUG screen (`src/report.ts`, pure and tested; the form in `main.ts`) POSTs JSON to `/api/bugs`.
`api/` is the inbox: `bugs.mjs` (validation, ids, rate limiting; tested by `api/bugs.test.ts`) and
`server.mjs` (zero-dependency Node HTTP), container `s2u-api` in the same compose project, read-only root,
no capabilities, no host port. nginx proxies `POST /api/bugs` to it (128 KB bodies, a request brake, the
caller's address from Cloudflare). One JSON file per report lands in the deploy directory's `data/bugs/` on the box
(test reports, `"test": true`, in `bugs-test/`), outside `src/` so deploys never touch them; owner uid 10001
(the container), the login user's group read-only, nobody else. **Nothing serves reports back over HTTP.** They are
read over SSH by the `s2u-bug-reports` Claude skill in `.claude/skills/` (git-ignored).
**Deliberate test reports carry `"test": true` AND a `[deploy-check]` or similar bracketed prefix in the title, and
they never contain prompt-injection text.** The first deploy check did (a canary, to prove the reader skill fenced
it), and an audit correctly flagged it as a report addressing the loop as an AI -- which is the finding a REAL
hostile report should produce. A planted example in the inbox means the real one is not the first and may not
stand out, so the canary was deleted and the check re-sent as plain text (2026-09-20).

Contract (the launcher posts the same shape with `"source": "launcher"`): `title` 4-120, `description`
10-4000, optional `contact` <=120, `version`/`platform` <=64, `context` up to 16 short string pairs, optional
`log` <=65536, honeypot `website` empty; replies 201 `{ok,id}`, 400 `{ok:false,error}`, 413, 429 with
`Retry-After` (5 an hour per caller). Every string is stripped of control characters before it is stored.

## Input on every screen
Keyboard (arrows/WS, Enter/Space/X, Esc/Backspace), mouse (every row, tab and button is clickable; the wheel
moves the cursor or scrolls a long panel) and a controller through the Gamepad API (d-pad or left stick, cross
to select, circle or triangle for BACK, right stick scrolls long panels). In the briefing and the guide the
cursor runs through the tabs, then GITHUB, then the action button. REPORT A BUG needs a keyboard to type; a
controller can still move between its fields and press SEND.
