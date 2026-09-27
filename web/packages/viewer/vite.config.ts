import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const webRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The revision the build came from, for the panel's About (`src/revision.ts`): the short hash, with
 * `-dirty` when anything under `web/` differs from it, and `unknown` when git is not there to ask.
 */
function gitRevision(): string {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: webRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const hash = git('rev-parse', '--short', 'HEAD');
    return git('status', '--porcelain', '--', '.') ? `${hash}-dirty` : hash;
  } catch {
    return 'unknown';
  }
}

/** When the build ran, UTC, `YYYY-MM-DD HH:MM:SS` -- the s2u site's footer stamp. */
const buildStamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

/**
 * The viewer is its own Vite root inside the workspace. `publicDir` points at `web/public`, so the
 * extracted disc tree served at `/maps/` is the app's default `AssetSource` without a copy.
 */
/**
 * `VIEWER_BASE` is the path the built site is served under (for example `/map-viewer/`); the dev server
 * and the default build use `/`. The extracted maps are never copied into the build: on a server they are a
 * separate directory mounted beside the site, in dev Vite serves
 * `web/public` itself.
 */
/** `map-viewer`, `/map-viewer` and `/map-viewer/` all mean `/map-viewer/`; unset means `/`. Only the last path
 *  segment counts, because on Windows Git Bash rewrites a leading-slash value into `C:/Program Files/Git/...`. */
function basePath(value: string | undefined): string {
  const parts = (value ?? '').split(/[\/]+/).filter((p) => p.length > 0);
  const name = parts[parts.length - 1];
  return name ? `/${name}/` : '/';
}

export default defineConfig({
  root: here,
  base: basePath(process.env.VIEWER_BASE),
  publicDir: fileURLToPath(new URL('../../public', import.meta.url)),
  server: { port: 5173, strictPort: true },
  build: { outDir: fileURLToPath(new URL('../../dist/viewer', import.meta.url)), emptyOutDir: true, copyPublicDir: false },
  worker: { format: 'es' },
  define: { __VIEWER_REV__: JSON.stringify(gitRevision()), __BUILD_STAMP__: JSON.stringify(buildStamp) },
});
