import type { SourceRequest } from './worker';

/**
 * Where the page reads the game from (owner, 2026-09-29). By default **only the visitor's own disc image**: the page opens
 * on the disc page (`index.html` `#disc-page`), and the `.iso` dropped on the window or picked with the file button is
 * read in the browser by the worker (`@s2u/archive`'s `IsoAssetSource`, by range) -- no request is made for the served,
 * extracted tree (`maps/`) at all.
 *
 * `DEV_PARAM` (a developer switch, deliberately not listed anywhere a visitor reads: only here, in the README's
 * developer section and the tests) turns on what the page did before: the served tree from `web/public/maps/`, if
 * `maps/index.json` answers, else the disc page. The e2e specs and the measuring tools add it to their URLs.
 */

/** The URL parameter that lets the page read the served, extracted tree. Its presence is enough. */
export const DEV_PARAM = 'devmode';

/** Whether the served tree may be used, for a query string (with or without its leading `?`). */
export function devMode(search: string): boolean {
  try {
    return new URLSearchParams(search).has(DEV_PARAM);
  } catch {
    return false;
  }
}

/**
 * The source the page asks for its map list first: the served tree at `mapsUrl` with `DEV_PARAM`, else none -- the page
 * waits on the visitor's disc (null).
 */
export function startSource(search: string, mapsUrl: string): SourceRequest | null {
  return devMode(search) ? { kind: 'http', baseUrl: mapsUrl } : null;
}
