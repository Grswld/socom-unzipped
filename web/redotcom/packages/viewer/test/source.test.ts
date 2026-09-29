import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DEV_PARAM, devMode, startSource } from '../src/source';

/**
 * Where the page reads the game from (owner, 2026-09-29): the visitor's own disc by default, the served tree only with the
 * developer's `?devmode`.
 */
const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(here, '../src/main.ts'), 'utf-8');

describe('the asset source by the URL', () => {
  it('names the developer parameter devmode', () => {
    expect(DEV_PARAM).toBe('devmode');
  });

  it('by default is none: the page waits on the visitor disc (the disc page)', () => {
    for (const q of ['', '?', '?map=MP2', '?redotcom', '?redotcom&fly', '?map=MP2&redotcom&mp', '?dev', '?devmodes', '?Devmode', '?x=devmode']) {
      expect(devMode(q), q).toBe(false);
      expect(startSource(q, '/maps'), q).toBeNull();
    }
  });

  it('with devmode (its presence is enough) is the served tree at the page maps directory', () => {
    for (const q of ['?devmode', 'devmode', '?devmode=1', '?map=MP2&devmode', '?redotcom&fly&devmode', '?devmode&map=MP6']) {
      expect(devMode(q), q).toBe(true);
      expect(startSource(q, '/map-viewer/maps'), q).toEqual({ kind: 'http', baseUrl: '/map-viewer/maps' });
    }
  });

  it('main.ts asks for the served index only through the devmode source, never the maps path on its own', () => {
    // The one fetch of the served index goes through `served(SERVED)`, and SERVED is `startSource`'s answer.
    expect(main).toMatch(/const SERVED: SourceRequest \| null = startSource\(SEARCH, MAPS\)/);
    expect(main).toMatch(/SERVED \? await served\(SERVED\) : false/);
    expect(main).not.toMatch(/fetch\(`\$\{MAPS\}/);
  });
});
