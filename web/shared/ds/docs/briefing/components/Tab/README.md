# Tab

A briefing tab: the stacked navigation of the MISSION BRIEFING screen, also used as the site's button. Maps to the live site's `.tab`, `.btn` and the about screen's tab list.

Use it for choosing among screens or actions in a briefing layout. Stack them in a `tab-w` column with `space-2` gaps; under 720px lay them in a horizontal scroll strip.

The consumer provides the label (uppercase, one or two words, set in `tab`), `aria-current="true"` on the current one, and the click or route. Disabled tabs take `aria-disabled="true"` and stay in the DOM so the layout matches the game.

- Fill `tab`, label `text` at rest; `tab-lit` and `gold` when current or hovered. Do not add a brighter hover.
- Edge is `panel-inset`, corners `radius-0`, padding `space-3` × `space-4`.
- Focus: 2px `focus` outline at 2px offset. Pressed: `highlight-pressed` for a frame.
- Don't use it for inline links in prose; don't put an icon in it; don't make it wider than `tab-w` in a briefing grid.
