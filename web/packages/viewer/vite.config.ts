import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

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
});
