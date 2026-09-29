The look of the SOCOM II MISSION BRIEFING screen, carried onto the modern s2u.scotho.com site and the map viewer. The classic menu at `/classic` is **not** a consumer of this system: its standard is the game's own frame, and it imports nothing from here.

## Boundary

- Consumers: the modern site (index, story page) and the map viewer's chrome (settings panel, top bar, fps readout, fullscreen button). Nothing here touches the 3D canvas.
- Not a consumer: the classic menu, the boot screen and its about screen. They keep the game's exact colours, including the ones that fail contrast. A guard test asserts that `sites/s2u/classic/**` imports neither `tokens.css` nor the system's fonts.
- Every value is sampled from the golden frames (`meta.source` in `tokens.json`). Where the site departs from the frame it does so by one step and the token's usage note says why; never move a value back toward the frame without re-running the contrast table.

## Voice

- Screens are briefings. Titles and labels are uppercase military headings: `MISSION BRIEFING`, `SEEDING CHAOS MISSION OVERVIEW`, `DEPLOY`. Body copy is sentence case and plain: "US Special Operations Command has been called upon to assist."
- Say what the game says where it fits (`BACK`, `SELECT`, `DEPLOY`, `MISSION DETAILS`), and say plain web words where it doesn't (`GitHub`, `Development story`). Do not invent military names for web concepts.
- Numbers are facts with a caption under them (`59 ENTRIES`, `300 COMMITS CITED`). No filler stats.
- No emoji. The only glyphs are the four PlayStation face buttons and the block caret.

## Colour

- Ground is `ground`; content sits on `panel`; controls are `tab` at rest and `tab-lit` when current or hovered. The game's lit tab is *dark* teal, so a lit control is barely brighter than a resting one and is told apart mostly by its `gold` label. Do not brighten `tab-lit` to make hover louder.
- `highlight` is the only bright teal and it means "selected in a roller or list". Only `text-strong` goes on it.
- Gold is a label colour, not a fill. `gold` for labels, headings and numbers; `gold-display` only for the screen title with `title-glow`. `gold-source` is the game's own gold and exists so the classic menu and the contrast guard can name it: it fails 4.5:1 everywhere.
- Text: `text` on ground, panel and tab; `text-strong` for the subtitle line and anything on `highlight`; `text-dim` for captions at 13px or larger.
- Hint glyphs use `glyph-square`, `glyph-triangle`, `glyph-cross`. Each is always followed by its word; the colour is never the only signal.
- Contrast table, computed by the guard (`vitest`, `design/contrast.test.ts`): every pair a usage note names is 4.5:1 or better; `panel-edge` is decorative and exempt; `focus` is 3:1 or better on every surface it lands on.

| text on | ground | panel | tab | tab-lit | highlight |
|---|---|---|---|---|---|
| `gold` | 7.91 | 6.21 | 6.66 | 5.39 | — |
| `gold-display` | 10.32 | 8.10 | 8.69 | 7.03 | — |
| `text` | 10.42 | 8.18 | 8.77 | 7.10 | — |
| `text-strong` | 15.28 | 11.99 | 12.86 | 10.41 | 6.29 |
| `text-dim` | 6.71 | 5.26 | 5.65 | 4.57 | — |
| `gold-source` (classic only) | 3.82 | 3.00 | 3.22 | 2.60 | — |

## Type

- Three roles, hosted faces (no font files ship yet; when the real condensed face is licensed, add it under `fonts/` and swap `families.label`): `display` for the two titles, `label` for everything uppercase, `body` for prose, `mono` for viewer readouts only.
- `screen-title` is 44px italic 800 in `gold-display`: one per screen, top-left, with `title-glow`. Under it `subtitle` in `text-strong`.
- Tabs and buttons set `tab`; panel heading strips set `panel-heading`; the hint bar sets `hint`.
- Prose sets `body` at 19/26 in `text`, measure 60–70 characters. The story page's standfirst sets `lede-italic`.
- The viewer never uses `display`; its panel heading is `readout` in uppercase.

## Layout and edges

- No rounded corners on game surfaces (`radius-0`). The viewer alone uses `radius-viewer`, because it is a tool.
- Panels and tabs have a 1px `panel-edge` inset (`panel-inset` shadow) and no drop shadow. The only shadows are the two text glows and `viewer-lift`.
- The briefing grid: a `tab-w` column of stacked tabs with `space-2` gaps, `space-4` to a panel column that fills the rest, a hint bar right-aligned at the bottom. The two columns are the same height (`align-items: stretch`): the panel's image sits at the column's bottom (`margin-top: auto`) and the tab column's bottom group (DEVELOPMENT STORY / GITHUB / DEPLOY) is pushed down the same way with at least `space-8` above it, so DEPLOY's bottom edge lines up with the image's bottom edge as it does in the game. The gap before the bottom group is whatever is left over, never a fixed spacer. Under 720px the tabs become a horizontal scroll strip above the panel and the push is dropped.
- A scanline overlay at `scanline` alpha may sit over ground and panels on the site; never over the viewer canvas and never over body copy under 15px.

## States

- Hover and current: `tab-lit` fill, `gold` label. Keyboard focus: 2px solid `focus` outline, 2px offset, on top of the hover state. Pressed: `highlight-pressed` for one frame, then the new screen.
- Disabled: `disabled` opacity, label stays `text`, no hover change.
- Typed text (`TypedText`) reveals at 40 characters per second and ends with the `caret` block, blinking at 1Hz. Respect `prefers-reduced-motion`: show the full text at once with a steady caret.

## Iconography

- The four face-button glyphs are drawn inline as SVG: a square, a triangle, a cross and a circle at 14px, stroke 2px, in their glyph colours. No icon font, no emoji.
- Everything else is words. The viewer's fullscreen button is the one exception: a 16px corner-bracket glyph in `text` on `panel`.

## Motion

- Tab change: none; the panel content swaps. Roller selection: `highlight` pulses between 100% and 70% over 1.2s. Scanlines are static.
- Nothing moves on the story page except the typed caret.
