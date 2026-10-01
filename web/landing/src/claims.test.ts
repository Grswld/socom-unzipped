import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve as p, dirname } from 'path';
import { JSDOM } from 'jsdom';

// The site's public claims about the game's data must be true of what the site serves (launch review MJ-9).
// What ships: the page autoplays the game's menu movie (MOVIES/COMMON/MENULOOP.PSS cut from the owner's disc,
// README "Build inputs") and plays the HUDUI bank's sounds on every data-sfx control; deploy.sh refuses to ship
// without them; and nginx serves redotcom's extracted map archives under /redotcom/maps/ -- the owner's authority,
// temporary until the site goes ISO-only. The viewer itself asks for the visitor's own disc. The port's download
// ships nothing from the game. So the credits say exactly that, and the old blanket denials are gone.
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(p(here, '../index.html'), 'utf-8');
const doc = new JSDOM(html).window.document;
const text = (el: Element | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const nginx = readFileSync(p(here, '../../shared/deploy/site/nginx.conf'), 'utf-8');
const deploy = readFileSync(p(here, '../../shared/deploy/site/deploy.sh'), 'utf-8');

const CREDITS_LEDE =
  "The port and its download ship nothing from the game. This site does: it plays the game's own menu movie and HUD " +
  "sounds, cut from the owner's disc, and for now it serves the map archives redotcom's development mode reads, by the " +
  'owner\'s choice; redotcom itself reads your own disc.';
const GAME_PANEL =
  "The port runs the US retail disc you supply, SCUS_972.75 at revision r0001, and its download distributes nothing " +
  "from it; the menu movie and sounds on this site are the game's, from the owner's disc.";

describe('the site says what it ships', () => {
  it('the facts the claims answer to: the hero plays the menu movie, the controls play the HUD sounds, the maps are served', () => {
    expect(doc.querySelector('video#bg')?.getAttribute('src')).toBe('/media/menuloop.mp4');
    expect(doc.querySelectorAll('[data-sfx]').length).toBeGreaterThan(0);
    expect(deploy).toMatch(/public\/media\/menuloop\.mp4/);
    expect(nginx).toMatch(/location \/redotcom\/maps\//);
  });
  it('the credits lede discloses the movie, the sounds and the served map archives', () => {
    expect(text(doc.querySelector('#credits .s2u-lede'))).toContain(CREDITS_LEDE);
  });
  it('the game panel discloses the movie and sounds', () => {
    const panel = [...doc.querySelectorAll('#credits .s2u-panel')].find((li) => /SOCOM II: U\.S\. Navy SEALs/.test(text(li.querySelector('h4'))));
    expect(text(panel?.querySelector('p'))).toContain(GAME_PANEL);
  });
  it('no blanket denial is left anywhere on the page', () => {
    const body = text(doc.body);
    expect(body).not.toMatch(/Nothing here ships game data/);
    expect(body).not.toMatch(/and distributes nothing from it/);
    expect(body).not.toMatch(/Nothing (here|on this site) (ships|comes from) the game/i);
  });
});
