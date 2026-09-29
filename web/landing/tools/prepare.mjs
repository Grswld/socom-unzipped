#!/usr/bin/env node
/* The landing site's build-time inputs: everything the pages use that is not source. None of it is committed
   (web/.gitignore); it is made here, from this repository, before `vite` runs.

     node tools/prepare.mjs            # the story (always): copy + generate; then report the game-derived files
     node tools/prepare.mjs --build    # the same, and render the HUD sounds if they are missing (needs ffmpeg)

   1. The story's pictures and data: docs/story/img/* -> public/story/img/, docs/story/timeline.json ->
      public/story/timeline.json, and docs/story/img/logo.webp -> public/img/logo.webp. docs/story is the one copy.
   2. story.html: generated from docs/STORY.md by `python -m tools_py.story.site --full-document` (it links
      /src/ds/index.css, which vite.config.ts aliases to web/shared/ds).
   3. The game-derived media, rendered from the owner's own disc and never committed: public/sfx/*.ogg (the HUDUI
      bank's sounds, from tests/fixtures/audio by tools/render_hudui.py, via `tools/build-assets.py sfx`) and
      public/media/menuloop.mp4 (the menu movie cut from the disc by `tools/build-assets.py video`). public/img/intel.jpg
      and public/img/share.jpg are the owner's local pictures. A missing one is reported, not fatal: the page runs
      without it (silent, or the still fallback), and deploy.sh refuses to ship a site without the movie and sounds. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');            // web/landing
const repo = resolve(app, '../..');         // the repository
const story = join(repo, 'docs', 'story');
const pub = join(app, 'public');
const build = process.argv.includes('--build');

function python(args, opts = {}) {
  const candidates = [process.env.PYTHON, 'python', 'python3'].filter(Boolean);
  for (const py of candidates) {
    const r = spawnSync(py, args, { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts });
    if (r.error && r.error.code === 'ENOENT') continue;
    return r.status ?? 1;
  }
  console.error('prepare: no python on PATH (set PYTHON=...)');
  return 127;
}

// 1. the story's pictures, data and the logo, mirrored from docs/story
rmSync(join(pub, 'story'), { recursive: true, force: true });
mkdirSync(join(pub, 'story', 'img'), { recursive: true });
let n = 0;
for (const f of readdirSync(join(story, 'img'))) {
  if (f === 'logo.webp') continue;
  copyFileSync(join(story, 'img', f), join(pub, 'story', 'img', f));
  n++;
}
copyFileSync(join(story, 'timeline.json'), join(pub, 'story', 'timeline.json'));
mkdirSync(join(pub, 'img'), { recursive: true });
copyFileSync(join(story, 'img', 'logo.webp'), join(pub, 'img', 'logo.webp'));
console.log(`prepare: docs/story -> public/story (${n} pictures, timeline.json) and public/img/logo.webp`);

// 2. story.html from docs/STORY.md
const code = python(['-m', 'tools_py.story.site', '--full-document', '--out', join(app, 'story.html'),
  '--img', '/story/img', '--logo', '/img/logo.webp'], { cwd: repo });
if (code !== 0) { console.error(`prepare: tools_py.story.site failed (exit ${code})`); process.exit(code); }

// 3. the game-derived media: report what is missing, render the sounds when asked to and able
const SFX = ['back', 'dink', 'neg', 'slide', 'thunk', 'type'].map((s) => `sfx/${s}.ogg`);
const missing = () => [...SFX, 'media/menuloop.mp4', 'img/intel.jpg', 'img/share.jpg'].filter((f) => !existsSync(join(pub, f)));
if (build && SFX.some((f) => !existsSync(join(pub, f)))) {
  console.log('prepare: rendering the HUD sounds (tools/build-assets.py sfx, from tests/fixtures/audio; needs ffmpeg)');
  if (python([join(here, 'build-assets.py'), 'sfx'], { cwd: app }) !== 0) console.warn('prepare: the sounds could not be rendered');
}
const still = missing();
if (still.length) {
  console.warn(`prepare: game-derived or local inputs missing (the page runs without them): ${still.map((f) => 'public/' + f).join(', ')}`);
  console.warn('  sounds: npm run assets -w landing -- sfx (ffmpeg); the movie: npm run assets -w landing -- video (the disc under');
  console.warn('  game/disc and ffmpeg); intel.jpg and share.jpg are the owner\'s local pictures (web/landing/README.md, "Build inputs").');
}
