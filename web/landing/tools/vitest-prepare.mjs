/* vitest's globalSetup for the landing tests (vitest.config.ts): run tools/prepare.mjs once before any test file
   loads, so the generated, git-ignored inputs the page tests read (story.html, public/story/timeline.json) exist
   for every run -- `npm test`, a bare `npx vitest run`, a targeted file, an IDE run -- not only for the npm script
   that used to call prepare first (release review MJ-10: a targeted run failed page_classes and story_anchors at
   collection with ENOENT). A failure throws here, so a missing python reads as itself and not as an ENOENT two
   files later. Pinned by src/inputs.test.ts. */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default function setup() {
  const r = spawnSync(process.execPath, [join(here, 'prepare.mjs')], { stdio: 'inherit' });
  if (r.error) throw new Error(`vitest-prepare: tools/prepare.mjs did not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`vitest-prepare: tools/prepare.mjs failed (exit ${r.status ?? r.signal})`);
}
