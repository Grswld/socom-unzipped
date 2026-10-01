/* The classes the spec names (section 6). css.test.ts checks each exists in the stylesheets and the gallery test
   checks each is shown; Tasks 4 and 5 extend the list. `s2u-crt` and `s2u-crt-text` are not here: the gallery
   does not turn the CRT on (the site does, spec rule 6), so the page-class guard lists them itself. */
export const SELECTORS: string[] = [
  '.s2u-skip', '.s2u-scan', '.s2u-progress',
  '.s2u-bar', '.s2u-bar__brand', '.s2u-bar__ii', '.s2u-bar__word', '.s2u-bar__nav', '.s2u-bar__end',
  '.s2u-head', '.s2u-title', '.s2u-title--story', '.s2u-kicker', '.s2u-blink', '.s2u-lede',
  '.s2u-section',
  '.s2u-briefing', '.s2u-briefing__tabs', '.s2u-briefing__tabs-end', '.s2u-briefing__panel',
  '.s2u-panel', '.s2u-panel__head', '.s2u-panel__body', '.s2u-panel--image', '.s2u-panel.is-link',
  '.s2u-card', '.s2u-card__body', '.s2u-card__num', '.s2u-card__how', '.s2u-cards--2', '.s2u-cards--3',
  '.s2u-tiles', '.s2u-tile', '.s2u-tile__frame', '.s2u-tile__frame.is-blank', '.s2u-tile__text', '.s2u-tile__read', '.s2u-tile.is-latest',
  '.s2u-tab', '.s2u-tab--ghost', '.s2u-iconbtn', '.s2u-tab--nav', '.s2u-tab.is-busy', '.s2u-tab__what',
  '.s2u-tabs', '.s2u-tabs--column',
  '.s2u-field', '.s2u-field__label', '.s2u-field--area', '.s2u-field.is-ok', '.s2u-field.is-bad', '.s2u-field__note',
  '.s2u-range', '.s2u-check', '.s2u-colour', '.s2u-disclosure',
  '.s2u-overlay', '.s2u-overlay__toggle', '.s2u-overlay__body', '.s2u-overlay.is-folded', '.s2u-fab',
  '.s2u-stats', '.s2u-stat', '.s2u-stat__k', '.s2u-stat__v', '.s2u-stat.is-up', '.s2u-stat.is-down',
  '.s2u-lamp', '.s2u-lamp--small', '.s2u-lamp.is-up', '.s2u-lamp.is-down',
  '.s2u-label', '.s2u-label--warn', '.s2u-notice', '.s2u-notice--warn',
  '.s2u-status', '.s2u-status.is-ok', '.s2u-status.is-bad', '.s2u-status.is-warn', '.s2u-status--pill',
  '.s2u-loading', '.s2u-loading__bar',
  '.s2u-list--plain', '.s2u-list--steps', '.s2u-list--check', '.s2u-list--check.is-done', '.s2u-list--check.is-todo',
  '.s2u-hints', '.s2u-hint', '.s2u-hint__glyph', '.s2u-hint__glyph--square', '.s2u-hint__glyph--triangle', '.s2u-hint__glyph--cross', '.s2u-hint__glyph--circle',
  '.s2u-fine', '.s2u-foot', '.s2u-foot__inner', '.s2u-foot__brand',
  '.s2u-wheel', '.s2u-wheel__w', '.s2u-wheel .is-lit',
  '.s2u-typed', '.s2u-typed__caret', '.s2u-typed--boot',
];
