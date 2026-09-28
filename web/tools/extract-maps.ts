import { copyFileSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { COMMON_ARCHIVES, listMaps, servedIndex } from '@s2u/archive';
import { FsAssetSource } from '@s2u/archive/node';

/**
 * Copies the owner's disc tree into `web/public/maps/` for the viewer to fetch, and three archives into
 * `web/test-fixtures/` for the tests. Both are git-ignored: no game data is committed.
 *
 * The index it writes beside them is `ServedIndex` -- `{ maps, common }`. `maps` is `MapInfo[]` --
 * `{ archive, path, name }` -- not a bare list of paths: the name is the `description` of each archive's
 * own `mission.rdr`, read here, once, by `listMaps`; reading it in the browser instead would mean fetching
 * all 22 archives (224 MB) to draw a menu. `common` names the archives every map shares, copied into
 * `public/maps/RUN/` too: `READERC.ZAR` (the character scripts, `dynamics.rdr` and `motion.rdr`: the
 * SEAL's tuning) and `ZWEAPON.ZAR` (the weapon table) -- web sprint 2, W2.R5 -- and the sound's
 * `SOUNDRDR.ZAR` and `SOUNDS/BNKSTORE.ZAR` (web/docs/research/81).
 */
const web = resolve(import.meta.dirname, '..');
// The repository's own layout: the extracted disc tree beside web/ (docs/DEVELOPING.md); SOCOM_DISC names another.
const disc = process.env.SOCOM_DISC ?? resolve(web, '..', 'game', 'disc');
const run = join(disc, 'RUN');
if (!existsSync(run)) { console.error(`no disc tree at ${disc} (set SOCOM_DISC)`); process.exit(2); }

const mp = readdirSync(run).filter((f) => /^MP\d+\.ZDB$/.test(f)).sort();
const publicMaps = join(web, 'public/maps');
const publicRun = join(publicMaps, 'RUN');
const fixtureRun = join(web, 'test-fixtures/RUN');
mkdirSync(publicRun, { recursive: true });
mkdirSync(fixtureRun, { recursive: true });
for (const f of mp) copyFileSync(join(run, f), join(publicRun, f));
/** A common archive may sit in a directory of its own (`RUN/SOUNDS/BNKSTORE.ZAR`, web/docs/research/81). */
const copyInto = (from: string, to: string): void => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };
for (const path of COMMON_ARCHIVES) copyInto(join(disc, path), join(publicMaps, path));
for (const f of ['MP2.ZDB', 'MP6.ZDB', 'MP72.ZDB']) copyFileSync(join(run, f), join(fixtureRun, f));
// The common archives in the fixtures too: `READERC.ZAR/character.rdr` (the gear, web/docs/research/78 §5), the
// tuning, the weapon table and the motion packs the fixture-backed tests read beside the three maps.
for (const path of COMMON_ARCHIVES) copyInto(join(disc, path), join(web, 'test-fixtures', path));

const maps = await listMaps(new FsAssetSource(publicMaps));
writeFileSync(join(publicMaps, 'index.json'), JSON.stringify(servedIndex(maps), null, 2));
console.log(`copied ${mp.length} archives and ${COMMON_ARCHIVES.join(', ')} to public/maps, 3 fixtures`);
console.log(`indexed ${maps.length} maps: ${maps.map((m) => `${m.name} (${m.archive})`).join(', ')}`);
