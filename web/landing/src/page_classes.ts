/* The classes the web page may use beyond the design system's: its own placement and its SVG parts. The guard
   in page_classes.test.ts refuses anything else, so a class the mapping forgot cannot go unstyled in silence. */
export const PAGE_OWN: string[] = [
  'logo', 'hero', 'hero-video', 'hero-shade', 'hero-inner', 'hero-head', 'hero-status', 'hero-note', 'wheel-row', 'hints-row',
  'tile-play', 'game-row', 'game-sub', 't', 'm', 'p', 'callout', 'callout-text', 'form-foot', 'credits-h', 'credits', 'role', 'spk', 'wave', 'x',
];
