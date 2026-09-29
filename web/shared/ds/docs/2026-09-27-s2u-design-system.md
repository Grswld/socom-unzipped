# The s2u design system -- spec and handoff

> Moved 2026-09-29 from scotho `docs/superpowers/specs/` into socom_pc `web/shared/ds/docs/`, with the system. The
> spec is kept as written; its paths map as follows: scotho `apps/s2u/src/ds/` is `web/shared/ds/`, `apps/s2u/public/fonts/`
> is `web/shared/fonts/`, `apps/s2u/tools/{gen-tokens,fetch-fonts,font-metrics}.mjs` are in `web/shared/tools/`, the
> rest of `apps/s2u/` is `web/landing/`, and socom_pc `web/` (the map viewer) is `web/redotcom/`, served at `/redotcom/`.
> The viewer's vendored copy, `ds:sync` and `MANIFEST.json` (phase 3) are gone: both sites read `web/shared/ds/` in place.
> The briefing's source files are in `briefing/` here; the `game/` and `site/` reference pictures stay in the owner's
> scotho history (they show the game, which this repository never carries).

Date: 2026-09-27. Owner: Craig. Written by the socom_pc controller session at the owner's request ("a handoff that
implements a design system for s2u and the map viewer, loosely based off s2u's existing palette and SOCOM
inspiration, highly refined and future-proofed"). Status: APPROVED 2026-09-27 ("good start", then "take this claude UI design, merge it with your plans, and carry the
plan to completion"); revised the same day to merge the owner's **S2U Briefing** design system (section 0). Every
ruling below is the writer's and the owner can overturn any of them.

## 0. Merged with the owner's S2U Briefing design (2026-09-27)

The owner built a design system in Claude Design, **S2U Briefing** (`https://claude.ai/artifact/7KdQjoXHidequNDHSPyQZp`,
the owner's private artifact), and asked for it to be merged with this spec. Its files are copied beside this spec
under `2026-09-27-s2u-design-system/briefing/` (`tokens.json`, its README, seven component guidelines with
previews). The merge rule: **the owner's design wins on look, this spec wins on engineering.**

What the artifact decides, now binding:

- **Values.** Its `tokens.json` is the source of truth for every colour, type style, space, radius, shadow and
  opacity. The repo vendors it at `apps/s2u/src/ds/tokens.json` and *generates* `tokens.css` from it
  (`--s2u-<name>`); a guard refuses a hand edit. The writer recomputed its contrast table on 2026-09-27 and every
  number matches to the hundredth. The ground is darker (`#000e11`), the panels opaque, the gold `#c4a04a` with a
  brighter `gold-display` for titles, the body text a cool grey-white; section 4 holds the tables.
- **The lit tab is dark** (`tab-lit #093535`) and is told apart by its gold label, as in the game: no brighter
  hover. `highlight #0d595c` is the only bright teal and means "selected in a roller or list"; only
  `text-strong` reads on it.
- **Edges are an inset shadow** (`panel-inset`, 1px `panel-edge`) rather than a border, so widths stay exact.
- **The focus ring is cyan** (`focus #5fb3bf`, 2px, 2px offset), 3:1 or better on every surface.
- **Faces:** Oswald for labels and body; **Saira** at width 62.5 % italic 800 (the design of Saira Condensed,
  which has no italic of its own) for the two titles; **JetBrains Mono** for the viewer's readouts only. Exo 2 and
  Share Tech Mono are retired.
- **The viewer is a tool:** its panel alone may have `radius-viewer` (6px), the fullscreen button `radius-pill`,
  and the `viewer-lift` drop shadow; its fps readout is `glyph-cross` on `ground` and never turns red or green.
- **Glyphs are inline SVG** (square, triangle, cross, circle; 14px, stroke 2) in the three glyph colours, each
  always followed by its word.
- **Two new components**, TypedText (the briefing's typewriter with the block caret, 40 characters a second,
  reduced motion shows it whole) and the briefing grid (a `tab-w` 230px column of tabs beside a panel column,
  stretched, the bottom tab group pushed down to the panel image's foot).
- **Voice:** titles and labels are uppercase military headings; the game's own words where they fit (BACK,
  SELECT, DEPLOY), plain web words where they do not; no invented military names for web concepts.

What this spec keeps, because the artifact does not speak to it: the file layout, cascade layers and naming
(section 2); the self-hosted fonts (section 5; the artifact says "hosted, no files yet"); the components the site
needs beyond the artifact's seven (cards, tiles, fields, ranges, checks, disclosures, notices, status, loading,
lists, footer, wheel, skip, progress: section 6, restyled onto the artifact's tokens); the density switch; the
gallery and the guards (section 9); the phases (section 10); the review's cuts (section 11).

Rulings the merge forced:

- **No red.** The artifact has no red token and says colours that must be told apart differ in lightness, not hue.
  The server lamp and the status lines use `glyph-triangle` (green) for up and `warn` (amber) for down or an error.
- **Middle dots.** Section 11 cut them from the site's stat lines; the artifact's viewer readouts use them
  (`16,931 triangles · 453 draws`). The site keeps ` / `; the viewer's mono readouts keep ` · `. The artifact
  speaks for the viewer there and this spec for the site.
- **The button is a Tab.** The artifact's Tab "is also used as the site's button"; the class is `s2u-tab`, there is
  no `s2u-btn`.
- **Interactive panels light like a tab** (`tab-lit` fill under a `gold` heading) instead of taking a gold frame:
  gold is a label colour, not a fill or a frame.
- **The wheel's lit row sits in a `highlight` box** in `text-strong`, pulsing 100 % to 70 % over 1.2 s, as SELECT
  RANK lights LIEUTENANT; reduced motion holds it steady.
- **Engineering tokens** the artifact does not define (gutter, max width, measure, durations, ease, z-index,
  the density switch) live in `base.css`, not in `tokens.json`, so `tokens.css` can stay fully generated.

## 1. What this is, and the one boundary

One design system for the two modern surfaces:

- **s2u.scotho.com** -- `apps/s2u/index.html` (the web page), the generated `story.html`, and the data page
  TODO item 5 will add. Today their look is `apps/s2u/src/ui.css` + `src/home.css`, documented in `src/chrome.md`.
- **The map viewer** -- `socom_pc/web/packages/viewer` (its own repo and build), served at `/map-viewer/`. Today its
  look is 240 lines of `styles.css` in a generic grey-and-mint dark theme that shares nothing with the site it
  sits under.

**The classic menu is out (owner, 2026-09-27).** `classic.html` / `src/style.css` recreate SOCOM II's own menu, and
its golden standard is the game's screen, not this system. The system takes its origin colours *from* classic and
gives nothing back. The only permitted touch to classic is none. If a future session finds classic drifting from
the game, the fix is the golden frame, never a design token.

Goal in one sentence: the modern site and the viewer read as one thing, that thing reads as SOCOM II's own
briefing screens, and a third surface (a stats page, a launcher web view, a docs site) can adopt it by copying one
directory.

## 2. Where it lives and how two repos share it

The source of truth is one directory in this repo:

```
apps/s2u/src/ds/
  VERSION            one line, semver, bumped by hand with every visible change (1.0.0 at the first cut)
  tokens.json        the owner's S2U Briefing tokens, vendored whole (section 0)
  tokens.css         @layer s2u.tokens -- GENERATED from tokens.json by tools/gen-tokens.mjs; never edited
  base.css           @layer s2u.base   -- reset, fonts, body, links, focus, motion, forced-colors
  components.css     @layer s2u.components -- every component in section 6
  fonts/             self-hosted woff2 (section 5); copied to public/fonts/ at build
  (the gallery is apps/s2u/ds/index.html, a Vite input, so it lands at /ds/; section 9)
  tokens.test.ts     the guard (section 9)
  README.md          how to adopt, how to bump, how to sync
```

**The viewer vendors a copy**, `web/packages/viewer/src/ds/`, with a `MANIFEST.json` holding the VERSION and a
sha256 per file. `npm run ds:sync -- ../../scotho/apps/s2u/src/ds` in `web/` copies the three CSS files and the
fonts and rewrites the manifest; a vitest test recomputes the hashes and fails when the copy was edited by hand.
The viewer must build offline and from a clone that has no scotho beside it, so a runtime link to
`https://s2u.scotho.com/ds/tokens.css` is refused; so is an npm package, which needs a registry and a publish
step the owner would have to own. If a third consumer arrives, promote the directory to a package then.

Cascade layers are the future-proofing: `@layer s2u.tokens, s2u.base, s2u.components;` declared once at the top
of `tokens.css`. A page's own stylesheet stays unlayered and therefore wins every tie without `!important` and
without the link-order trap chrome.md records from 2026-09-24. No rule in the three files may use `!important`
except inside `prefers-reduced-motion`.

Naming: every custom property is `--s2u-*`, every class `s2u-*` with BEM-ish parts (`s2u-panel`, `s2u-panel__head`,
`s2u-tab--ghost`). The bare names in `ui.css` today (`--gold`, `.card`) go away in phase 2; a `legacy.css` alias
file bridges the migration and is deleted at the end of that phase.

## 3. The look, as rules

From the game's screens (the reference folder of section 12: the golden sheet, frames s07 and s19): a
near-black teal ground; a screen's title in gold condensed italic caps; a white spaced-caps line under it; teal
panels with a one-pixel edge; a lit tab is a dark teal box with a gold label; body text is cool grey-white
condensed type; cyan only for the boot typewriter. Nothing lifts, nothing casts a soft shadow, nothing has a
rounded corner, except the viewer's tool panel.

The rules the system enforces, each testable:

1. **Flat.** `radius-0` on every game surface; the viewer's panel and fullscreen button alone take `radius-viewer`
   and `radius-pill`. The only shadows are the tokens: `title-glow`, `story-glow`, `panel-inset`, `viewer-lift`.
2. **Edges are `panel-inset`.** A panel or tab has no CSS border; its 1px edge is the inset shadow token, so its
   width is its width. The bar's rule is the same 1px in `panel-edge`.
3. **Caps carry hierarchy.** Titles, subtitles, tab labels, nav, hints, stat captions and panel headings are
   uppercase with the tracking their type style names; body text is sentence case and never tracked.
4. **Gold is a label colour, not a fill.** `gold` for labels, headings and figures; `gold-display` for a screen
   title only, with `title-glow`; never a gold fill or frame behind or around text. `highlight` is the only bright
   teal and means selection in a roller or list; `cyan-boot` never leaves the boot screen.
5. **Contrast is a guard, not an intention.** Every pair in section 4.3 holds (4.5:1 text, 3:1 for `focus` and
   for glyphs at their size) and is recomputed from `tokens.json` by `tokens.test.ts`. `gold-source`, the game's
   own gold, fails everywhere and exists so the guard can refuse it in a component.
6. **The CRT is optional and off by default.** Scanlines at the `scanline` alpha are `body.s2u-crt`, a fixed overlay;
   the site turns them on, the viewer never does. (The artifact's "never over body copy under 15px" cannot be
   honoured by a fixed overlay; phase 2 decides per surface if it matters.)
7. **Motion is short and skippable.** The typed caret, the roller pulse and the tab transitions are the whole
   list; `prefers-reduced-motion` removes every transition and animation in one rule and shows typed text whole.
8. **One density switch.** `[data-density="compact"]` scales type and space down for the viewer's panel and any
   dense table; nothing else may hard-code a smaller size.
9. **Fonts are ours.** Oswald, Saira and JetBrains Mono self-hosted as latin woff2, no request to Google at
   runtime, `font-display: swap`, size-adjusted fallbacks so a swap does not reflow the page.
10. **The voice stays** (owner, 2026-09-24, and the artifact's README): plain words, not a product; the game's own
    words where they fit; the gallery's sample copy is the site's own sentences.

## 4. Tokens

The values are the artifact's `tokens.json`, vendored whole at `apps/s2u/src/ds/tokens.json`. `tokens.css` is
generated from it by `apps/s2u/tools/gen-tokens.mjs`: every entry becomes `--s2u-<name>`; each type style becomes
`--s2u-type-<name>` (the `font` shorthand: weight, size/line-height, the family variable), `--s2u-tracking-<name>`
(its letter-spacing, or `0`) and `--s2u-italic-<name>` (`italic` or `normal`). The guard regenerates in memory and
refuses a `tokens.css` that differs.

### 4.1 Colour (one theme, "Briefing")

| Token | Value | Use (the artifact's usage note, shortened) |
|---|---|---|
| `ground` | `#000e11` | the page; the viewer's panel fill and canvas margin |
| `ground-deep` | `#000000` | letterbox and the boot screen only |
| `panel` | `#002933` | content panels, cards, stat tiles |
| `panel-edge` | `#061a1c` | the 1px edge (`panel-inset`); decorative, 1.3:1, exempt |
| `tab` | `#032326` | a resting tab or button |
| `tab-lit` | `#093535` | the current tab, a hovered button; dark on purpose, its label is `gold` |
| `highlight` | `#0d595c` | roller and list selection; only `text-strong` on it |
| `highlight-pressed` | `#305a4a` | the one-frame flash when a tab is chosen; no text contract |
| `gold` | `#c4a04a` | labels, panel headings, lit-tab labels, figures; lifted one step from the game's `#786e3b` |
| `gold-display` | `#dcb85c` | the screen title at 40px+ and its glow |
| `gold-source` | `#786e3b` | the game's own gold: reference only, refused in components |
| `text` | `#b4bfc1` | body copy, unlit tab labels |
| `text-strong` | `#dfe4e5` | the subtitle line, a selected roller row, anything on `highlight` |
| `text-dim` | `#8a9a9c` | captions, stat captions, fine print, key hints; never under 13px |
| `caret` | `#b4bcbe` | the typewriter block after typed text |
| `cyan-boot` | `#3ed1e6` | the boot typewriter only; never a link colour |
| `glyph-square` | `#d06fb0` | the square hint glyph |
| `glyph-triangle` | `#3fae7f` | the triangle hint glyph; also the lamp's up and a status line's ok |
| `glyph-cross` | `#5fb3bf` | the cross hint glyph, the II mark, the viewer's fps readout |
| `warn` | `#e0a35a` | EXPERIMENTAL and dev-build marks; the lamp's down and a status line's error |
| `focus` | `#5fb3bf` | the 2px focus ring, 2px offset, everywhere |

Links in prose are `glyph-cross`; the lede-italic standfirst is `glyph-cross` too (the artifact's `lede-italic`).

### 4.2 Type, space, radius, shadow, opacity

| Family | Value |
|---|---|
| `--s2u-font-display` | the artifact's stack with the fallback face inserted by the generator: `"Saira Condensed", 'Saira Condensed Fallback', "Oswald", Impact, sans-serif` (the self-hosted file is the variable Saira at width 62.5, declared under the family name Saira Condensed; used italic 800 at `font-stretch: 62.5%`) |
| `--s2u-font-label` / `--s2u-font-body` | `"Oswald", 'Oswald Fallback', "Arial Narrow", sans-serif` |
| `--s2u-font-mono` | `"JetBrains Mono", 'JetBrains Mono Fallback', ui-monospace, Menlo, monospace` |

| Style | Family | Size/line | Weight | Tracking | Use |
|---|---|---|---|---|---|
| `screen-title` | display | 44/44 | 800 italic | 0.02em | one per screen, `gold-display`, `title-glow` |
| `story-title` | display | 64/60 | 800 italic | 0 | the story hero, lowercase, `text-strong`, `story-glow` |
| `tab` | label | 18/24 | 600 | 0.08em | tab and button labels, uppercase |
| `panel-heading` | label | 17/24 | 600 | 0.1em | a panel's heading strip, uppercase, `gold` |
| `subtitle` | label | 18/24 | 500 | 0.06em | under the screen title, uppercase, `text-strong` |
| `nav` | label | 13/16 | 500 | 0.18em | the bar's links, uppercase |
| `hint` | label | 16/20 | 600 | 0.1em | hint-bar words, uppercase, `text-strong` |
| `stat-number` | label | 26/28 | 600 | 0 | a stat tile's figure, `gold`, tabular |
| `stat-caption` | label | 11/14 | 500 | 0.16em | a stat tile's caption, uppercase, `text-dim` |
| `body` | body | 19/26 | 400 | 0 | briefing copy, story entries, `text`; measure 60 to 70 characters |
| `body-small` | body | 15/22 | 400 | 0 | captions, footers, legal, `text-dim` |
| `lede-italic` | body | 22/28 | 500 italic | 0 | the story standfirst |
| `readout` | mono | 13/18 | 500 | 0 | viewer stats, fps, key hints, `text` |
| `readout-caption` | mono | 11/16 | 400 | 0 | viewer secondary lines, `text-dim` |

Figures use `font-variant-numeric: tabular-nums`.

| Token | Value | Use |
|---|---|---|
| `space-1` … `space-4` | 4, 8, 12, 16px | glyph gap; stacked-tab gap; tab vertical padding; panel padding and the phone gutter |
| `space-6`, `space-8`, `space-12` | 24, 32, 48px | section gap in a screen; title to tabs; story section spacing |
| `tab-w` | 230px | the briefing grid's tab column |
| `radius-0` | 0 | every game surface |
| `radius-viewer`, `radius-pill` | 6px, 999px | the viewer's panel; its fullscreen button |
| `title-glow` | `0 0 12px #dcb85c66, 0 0 2px #dcb85c99` | text-shadow behind a screen title |
| `story-glow` | `0 0 18px #dfe4e566` | text-shadow behind the story title |
| `panel-inset` | `inset 0 0 0 1px #061a1c` | the edge of every panel and tab |
| `viewer-lift` | `0 8px 24px #00000080` | the viewer's panel over the canvas |
| `scanline` | 0.10 | the CRT overlay's alpha |
| `disabled` | 0.45 | a tab that cannot be chosen |

Engineering tokens, in `base.css` (not in `tokens.json`): `--s2u-gutter clamp(16px, 4vw, 40px)`, `--s2u-max 1080px`,
`--s2u-measure 66ch`, `--s2u-dur-fast 120ms`, `--s2u-dur-base 200ms`, `--s2u-dur-slow 600ms`, `--s2u-ease
cubic-bezier(0.2, 0.7, 0.2, 1)`, `--s2u-z-overlay 30`, `--s2u-z-scan 40`, `--s2u-z-bar 50`, `--s2u-z-progress 60`,
`--s2u-z-skip 100`. `[data-density="compact"]` sets `--s2u-type-body` to the `readout` shorthand, `--s2u-type-tab`
to 13/18 600 and halves `space-3`, `space-4`, `space-6`; nothing else changes.

Breakpoints stay the four the site answers to, named in a comment: phone `≤ 480`, narrow `≤ 720`, mid `≤ 860`,
wide `≤ 960`. Container queries are permitted inside a panel and preferred there over viewport queries.

### 4.3 The contrast table (asserted by the guard)

The artifact's table, recomputed by the writer on 2026-09-27 with the WCAG 2 formula; every number matched.

| Foreground | ground | panel | tab | tab-lit | highlight | Bar |
|---|---|---|---|---|---|---|
| `gold` | 7.91 | 6.21 | 6.66 | 5.39 | (not allowed) | 4.5 |
| `gold-display` | 10.32 | 8.10 | 8.69 | 7.03 | (not allowed) | 4.5 |
| `text` | 10.42 | 8.18 | 8.77 | 7.10 | (not allowed) | 4.5 |
| `text-strong` | 15.28 | 11.99 | 12.86 | 10.41 | 6.29 | 4.5 |
| `text-dim` | 6.71 | 5.26 | 5.65 | 4.57 | (not allowed) | 4.5 |
| `glyph-square` | 6.15 | 4.82 | 5.17 | 4.19 | | 3 (a 14px glyph beside its word) |
| `glyph-triangle` | 7.07 | 5.55 | 5.95 | 4.82 | | 4.5 (it is also status text) |
| `glyph-cross` | 8.11 | 6.36 | 6.83 | 5.53 | | 4.5 (it is also the fps readout and links) |
| `warn` | 8.92 | 7.00 | 7.51 | 6.08 | | 4.5 |
| `focus` | 8.11 | 6.36 | 6.83 | 5.53 | 3.34 | 3 |
| `cyan-boot` on `ground-deep` | 11.47 | | | | | 4.5 |
| `ground` on `gold` (the skip link, the LATEST stamp) | 7.91 | | | | | 4.5 |
| `gold-source` (refused) | 3.82 | 3.00 | 3.22 | 2.60 | | fails, by design |

Exempt: `panel-edge` (decorative), `highlight-pressed` (one frame, no text), `caret` (a block, no text).

## 5. Fonts, self-hosted

Oswald 400/500/600, Saira italic 800 at width 62.5 % (the variable family, one static instance served by the
API; Saira Condensed itself has no italic), JetBrains Mono 400/500 -- all SIL OFL 1.1, so hosting the files is
permitted with the licence beside them. Latin subsets only, woff2, from the Google Fonts static CSS with a
`unicode-range` per face. Each family gets a `@font-face` fallback with `size-adjust`, `ascent-override`,
`descent-override` and `line-gap-override` computed once by `tools/font-metrics.mjs` against the local fallback
(Arial Narrow for Oswald, Arial Narrow Bold Italic for Saira Condensed, Consolas for JetBrains Mono); the generator inserts each `'<family> Fallback'` name after the first family of the artifact's stack, since `tokens.json` stays byte-exact and cannot name them itself and recorded in `fonts.css` with the date.
`font-display: swap`. The Google `<link>` and its two `preconnect`s leave chrome.md's head in phase 2;
`<link rel="preload">` for Oswald 500 and 600 only.

The story copy in socom_pc (`docs/story/index.html`, which inlines the site's CSS and takes every URL absolute)
references the fonts at `https://s2u.scotho.com/fonts/`; `tools_py/story/site.py` already rewrites paths for that
copy and the font URLs go through the same rewrite.

## 6. Components

Each entry: what it is in the game, anatomy, states, the tokens it may use, its accessibility contract, and what
it replaces today (site class / viewer id). Everything not listed is a page's own and lives in the page's stylesheet.

**`s2u-bar`** -- the artifact's TopNav: 48px on `ground` with a 1px `panel-edge` rule under it (an inset shadow).
`s2u-bar__brand` (the II mark italic in `glyph-cross`, the word in `gold` at `nav`), `s2u-bar__nav` (links in
`nav` style, `text`, 6px by 10px padding; the current link `.is-on` and a hovered one are `tab-lit` + `gold`, no
underline, no bottom border), `s2u-bar__end` (the CLASSIC switch as a tab at `nav` size, the sound button, the
lamp). Fixed, `z: --s2u-z-bar`, safe-area padded; `.is-solid` is a no-op kept for the scripts (the bar is always
opaque now). On narrow the links collapse to a side-scrolling strip and the brand and CLASSIC stay. Replaces `.bar .brand .nav .bar-right .ghost .sound`. The viewer's
`#site-links` becomes a two-link `s2u-bar` with no nav, `.is-solid` always, and `body.chrome-hidden` still hides
nothing of it (site navigation is not a viewer control; the viewer's own comment says so).

**`s2u-title`**, **`s2u-kicker`**, **`s2u-lede`**, wrapped by **`s2u-head`** -- the screen title block. The title
is the artifact's `screen-title`: display face at `font-stretch: 62.5%`, 800 italic caps, `gold-display`,
`title-glow`, `text-wrap: balance`; `.s2u-title--story` is `story-title` (64/60, lowercase, `text-strong`,
`story-glow`). The kicker is the `subtitle` style in `text-strong`, drawn *under* the title whatever the source
order (`s2u-head` is a flex column with `order`), with an optional `s2u-blink` square in `gold`. The lede is
`body` in `text-dim`, `max-width: --s2u-measure`. Replaces `.sec-head h2 .brief-sub .sec-lede .hero-title .hero-sub`.

**`s2u-section`** -- `max-width: --s2u-max`, `padding: --s2u-space-18 --s2u-gutter` (`-12` on narrow). Replaces
`.section`.

**`s2u-panel`** -- the artifact's Panel: `__head` (the heading strip, `panel` fill, `panel-inset` edge, `gold` in
`panel-heading`, padding `space-3` by `space-4`) and `__body` (`panel` fill, `panel-inset`, `text` in `body`,
padding `space-4`), two separate boxes with a `space-2` gap as the game draws them; `radius-0`. One strip per
panel; a panel holding only an image has no strip and no padding. An interactive panel (`.is-link`) lights like
a tab when hovered or focused within: `tab-lit` fill under a `gold` heading. Replaces `.panel .panel-head
.panel-body`, and is the base of the card.

**`s2u-briefing`** -- the artifact's briefing grid: a `tab-w` column of stacked `s2u-tab`s with `space-2` gaps
(`s2u-briefing__tabs`, its bottom group `s2u-briefing__tabs-end` pushed down with `margin-top: auto` and at
least `space-8` above it), `space-4` to a panel column that fills the rest (`s2u-briefing__panel`, whose image
sits at the bottom with `margin-top: auto`), both columns stretched to one height, and an `s2u-hint` bar
right-aligned under it. Under 720px the tabs become a horizontal scroll strip above the panel and the push is
dropped.

**`s2u-card`** -- a panel whose `h3` is the heading strip, `p`s in `body`, an optional `__how` line in
`body-small` with an `s2u-label`, and a `__num` stamp (`readout-caption`, `text-dim`, top-right) only when the
cards are a sequence (section 11). A card that is not a link has no hover state. Grid helpers `s2u-cards--2` /
`--3` collapse to one column at mid. Replaces `.card .cards.two .cards.three .num .how`.

**`s2u-tile`** -- the play list's box: a 16:10 `__frame` (image `object-fit: cover`, or `.is-blank` hatched with a
`readout-caption` stamp), `__text` with a `time` in `gold` (`stat-caption` style), an `h3` in `text-strong`, a
clamped `p` in `body-small`, a `__read` line (`nav` style, `text-dim`, no arrow: section 11); the whole tile is the
link (`a::after` inset 0). Hover and `:focus-within` light it like a tab: `tab-lit` fill under the text, the `h3`
to `gold`. `.is-latest::before` is the LATEST stamp (`gold` fill, `ground` text: the one gold fill, a stamp, and
never behind body text). Replaces `.latest`.

**`s2u-tab`** -- the artifact's Tab, which is also the site's button. Rest: `tab` fill, `panel-inset` edge,
`radius-0`, `text` label in the `tab` style, padding `space-3` by `space-4`. Hover, `.is-on`, `[aria-current]`
and `[aria-pressed="true"]` are one state: `tab-lit` fill, `gold` label; no brighter hover. Active:
`highlight-pressed` for the press. `[aria-disabled="true"]` and `[disabled]`: the `disabled` opacity, the label
stays `text`, no hover change, still in the DOM so the layout matches the game. `.is-busy`: `cursor: wait`.
`--ghost`: no fill, no edge, `text-dim`. `--nav`: the
`nav` style at 6px by 12px (the bar's CLASSIC switch). Replaces `.btn .btn.ghost .ghost .sound`, the viewer's
`#look .look` and every `#panel button`.

**`s2u-iconbtn`** -- the one place a glyph stands alone on the site (the sound button): a 32x30 control on `panel`
with `panel-inset`, not a Tab (Tab/README: no icons in a tab), the SVG glyph in `text`, `gold` when pointed at, no
lit state; `aria-label` required. Replaces `.sound`.

**`s2u-fab`** -- the viewer's fullscreen button: 44px, `radius-pill`, `panel` fill, `viewer-lift` + `panel-inset`,
a 16px corner-bracket SVG in `text`. Replaces `#fullscreen`.

**`s2u-tabs`** -- a row or column (`--column`, `tab-w` wide) of `s2u-tab`s with `space-2` gaps, `role="tablist"`
when they switch content. The viewer's `#look` pair are two `s2u-tab`s with a `__what` caption line in
`readout-caption` (`text-dim`; `gold` when pressed).

**`s2u-field`** -- an input, textarea or select: `tab` fill, `panel-inset` edge, `radius-0`, `text` in `body`;
placeholder `text-dim`; focus: the ring, fill to `tab-lit`. `s2u-field__label`: `gold` in `stat-caption`.
`.s2u-field--area` `min-height 150px`, vertical resize. `.is-ok` colours the note `glyph-triangle`, `.is-bad`
colours it `warn` and the control's edge `warn`. A `select` gets the same box and a `gold` chevron drawn with a
background SVG; its popup is `panel`. In the viewer (compact) the control is `readout` in mono. Replaces
`.report-input .report-label .report-text .report-note`, the viewer's `#maps` and `#iso`.

**`s2u-range`** -- `label.s2u-range` with the text, the `input[type=range]` (`accent-color: gold`) and an
`output` in `readout`, tabular, `glyph-cross`, right-aligned, `min-width 56px`. Replaces the viewer's `label.slider`.

**`s2u-check`** -- a checkbox or radio row: a 14px square (`tab` fill, `panel-inset`) that fills `gold` with a
`ground` mark when checked, the text in `text`. The viewer's fourteen toggles (`#grid #collision #spawns
#wireframe …`) are these; the game's objectives `[X]` is the inspiration and `s2u-list--check` (below) is its
read-only form.

**`s2u-colour`** -- `label.s2u-colour` with a 34x20 swatch input in a hairline. Replaces `label.colour`.

**`s2u-disclosure`** -- `details.s2u-disclosure > summary`: `text` in `readout` (the viewer) or `nav` (the site)
with a `text-dim` triangle that rotates open, body indented `space-3`. Replaces `#about #advanced #fog-box
#sliders-box #diagnostics-box` summaries, and the viewer's own `#panel-toggle` is the same triangle.

**`s2u-overlay`** -- the artifact's ViewerPanel: `ground` fill, `radius-viewer`, `viewer-lift` + `panel-inset`,
opaque (no blur), `z: --s2u-z-overlay`, `[data-density="compact"]` by default, a `__toggle` head (a real
`button[aria-expanded]`: `panel` fill, `gold` uppercase in 12/16 600 label at 0.14em, a `text-dim` triangle at
the end) and a scrolling `__body` with `overscroll-behavior: contain`, `readout` in mono. `.is-folded` shows
only the head. The fps readout is `s2u-status--pill`: `readout` in `glyph-cross` on `ground`, `radius-viewer`,
`panel-inset`; it never changes colour. On narrow: full width with `space-4` gutters, body capped at `55vh`.
Replaces the viewer's `#panel #panel-toggle #panel-body` and the `body.panel-collapsed` rules; the ids stay for
the scripts. No scanlines over the canvas or the panel; no display face in the viewer.

**`s2u-stat`** -- the artifact's StatTile: `panel` fill, `panel-inset`, padding `space-4` top and sides,
`space-3` bottom; `__v` the figure in `gold` (`stat-number`, tabular, left-aligned, one line, ellipsis) over `__k`
the caption in `text-dim` (`stat-caption`). `.is-up` colours the figure `glyph-triangle`, `.is-down` `warn`; no
glow. A one-line status (the hero's) joins its parts with ` / `, never a middle dot. Grid helper `s2u-stats`
4-up, 2-up at narrow. Replaces `.stat-row .stats-status`.

**`s2u-lamp`** -- the bezelled LED of the ONLINE header: 16px, `tab` dark until `.is-up` (`glyph-triangle`) or
`.is-down` (`warn`), the bezel a `panel-edge` ring; a 9px `--small` variant for inline status. `role="img"` with
an `aria-label` the script updates ("server up"). Replaces `.led .lamp`.

**`s2u-label`** -- the small caps mark: `stat-caption` style, `text-dim`, `panel-inset` edge, no fill. `--warn`
is the viewer's dev-build badge: `warn` text with a 1px `warn` inset. Replaces `.lbl`, the viewer's `.badge`.

**`s2u-notice`** -- a boxed remark: `panel` fill, `panel-inset`, `b` in `gold`. `--warn` is the viewer's
EXPERIMENTAL line: a 2px `warn` left rule, the `strong` in `warn`, the rest `text-dim`. Replaces `.notice
.callout #warning`.

**`s2u-status`** -- one or more lines of machine text: `readout` in mono, `text`, `white-space: pre-wrap`;
`.is-ok` `glyph-triangle`, `.is-bad` and `.is-warn` `warn`; `aria-live="polite"` on the element the scripts
write. Replaces the viewer's `#status`, `#diagnostics` (a `ul.s2u-status.is-warn`), `#fps` (`.s2u-status--pill`,
fixed top-right, `aria-live="off"`, always `glyph-cross`), and the site's `.stats-updated`.

**`s2u-progress`** -- a 2px `gold` line in a `panel-edge` track, width from `--s2u-progress` (0..1) set by
script; the site's reading progress (fixed, `z: --s2u-z-progress`, safe-area padded) and the viewer's loading
bar (inside `s2u-loading`: a `ground` box with `viewer-lift`, an `s2u-status` line above the bar,
`aria-live="polite"`). Replaces `#progress`, `#loading #loading-what #loading-track #loading-bar`.

**`s2u-list`** -- `--plain` (disc, `b` in `text-strong`), `--steps` (numbered, `gold` markers),
`--check.is-done / .is-todo` (`[X]` / `[ ]` in mono, `gold` or `text-dim`). Replaces `.plain .steps .check`.

**`s2u-hint`** -- the artifact's HintBar: `ul.s2u-hints` right-aligned with 28px between items; each `s2u-hint`
is a button or link holding a 14px inline SVG glyph (`s2u-hint__glyph--square / --triangle / --cross /
--circle`, `fill: none`, stroke 2.2 in its glyph colour) and its word in `hint` style, `text-strong`, `space-2`
apart. The glyph is never the only signal and the order is the game's (square, triangle, cross). Replaces
`.hints .hint .glyph`.

**`s2u-fine`** -- fine print: `body-small` in `text-dim` (mono is for the viewer's lines only; section 11); in
the viewer, `readout-caption`. Replaces `.fine .foot-fine .rights`.

**`s2u-foot`** -- the footer: a 1px `panel-edge` rule on top, `__brand` (`gold` in `nav` style with the II mark),
the licence paragraph (`body-small`, `text-dim`, `62ch`), a `nav` of links in `nav` style, `s2u-fine` under. Two
columns, one at narrow. Replaces `.foot .foot-inner .foot-brand`.

**`s2u-skip`** -- the skip link: `gold` fill, `ground` text, `z: --s2u-z-skip`, visible on focus.

**`s2u-crt`** -- on `body`: the `.s2u-scan` overlay (`z: --s2u-z-scan`, the `scanline` alpha, a 2px repeat) and
`filter: blur(0.45px)` on `.s2u-crt-text`. Off by default; the site sets it over ground and panels; never over
the viewer's canvas; forced-colors and reduced-motion leave it as it is (it does not move).

**`s2u-wheel`** -- the menu roller: rows in the display face (24px 800 italic caps at width 62.5 %) in `text`; the
lit row (`.is-lit`, hover, focus) sits in a `highlight` box in `text-strong` that pulses 100 % to 70 % over 1.2 s
(`prefers-reduced-motion`: steady). The site's alone; listed so the gallery shows it.

**`s2u-typed`** -- the artifact's TypedText: a block of `body` text in `text` revealed by `typed.ts` at 40
characters a second, ending in `s2u-typed__caret` (a 0.55em by 1em block in `caret`, blinking at 1 Hz with a step
function); `--boot` is `cyan-boot` in `readout`, uppercase at 0.2em, on `ground-deep`. The element reserves its
final height (`min-height` from the full text measured once). Reduced motion renders the text whole with a steady
caret. `typed.ts` exports `typeInto(el: HTMLElement, text: string, cps = 40): Promise<void>` and honours
`matchMedia('(prefers-reduced-motion: reduce)')`.

**Touch controls** (the viewer's `#touch`, the stick and the lift buttons) are not components of the system:
they are the viewer's own instrument and keep `styles.css`, with their colours moved to `--s2u-*` tokens (the
mint `rgba(159,230,176,…)` becomes `--s2u-link` at the same alpha).

Global in `base.css`: `*, ::before, ::after { box-sizing: border-box }`; `html { scroll-behavior: smooth;
overflow-x: clip; color-scheme: dark }`; `body` on `ground` in `text`, `body` style; `a` in `glyph-cross`; `code`
in `readout` on `tab`; `:focus-visible` the cyan ring, and *no* `:focus` fallback that hides it; `@media
(prefers-reduced-motion: reduce)` one rule for `*`; `@media (forced-colors: active)` gives `.is-on` /
`[aria-pressed=true]` a 2px outline so the lit state survives Windows High Contrast; `::selection` `gold` on
`ground`. There is no gradient backdrop: the ground is flat `ground`, as the game's is.

## 7. The viewer's adoption -- what changes and what must not

Changes: `styles.css` shrinks to the touch controls, the canvas rules (`#view`, `body.ps2-look`), the
`chrome-hidden` rule and page-level placement (where the overlay sits, where the pill sits); everything else is a
class from `components.css`. The panel becomes `s2u-overlay` at compact density; its selects, buttons, toggles,
ranges and disclosures become the components above; the loading box becomes `s2u-loading`; `#site-links`
becomes a minimal `s2u-bar`; `#fullscreen` becomes `s2u-fab`; `#fps` becomes the `glyph-cross` pill. The colours
move from grey-and-mint to the artifact's ground, panel, tab-lit and gold, exactly as its ViewerPanel preview
draws them (section 12, `briefing/components/ViewerPanel/`). The viewer gets the self-hosted fonts and keeps mono
for its readouts, with ` · ` between the parts. It does not get `s2u-crt`; nothing paints over the canvas.

Must not change: every `id` in `index.html` (the scripts and `e2e/viewer.spec.ts` key off them); the
`body.panel-collapsed`, `body.chrome-hidden`, `body.touch`, `body.ps2-look` switches; the backtick, F and touch
behaviours; the `aria-*` contracts already there (they are better than the site's and the site rises to them);
the `maps/` contract; the build (`VIEWER_BASE=/map-viewer/`). The e2e suite passes unchanged except the
screenshot goldens, which are re-cut once with the new look and reviewed by eye.

## 8. The story page and the generator

`tools_py/story/site.py` in socom_pc reads `../scotho/apps/s2u/src/chrome.md` for the bar and footer markup and
inlines `ui.css` into the repository copy. Phase 2 renames the classes in chrome.md's markup and points the
generator at `src/ds/` for the inline copy (three files concatenated in layer order, `@layer` statement first).
chrome.md stays the markup contract for the two pages; its "look" paragraph is replaced by a pointer to this spec
and the gallery. The story session is told the day the class names change (the socom_pc HANDOFF gets one line).

## 9. The gallery and the guards

`apps/s2u/src/ds/gallery.html`, served at `/ds/` (a Vite input like the other pages; `noindex`): every component
in section 6 in every state, at both densities, on `--s2u-bg`, on `--s2u-surface-2`, and the overlay over a bright
photograph stand-in (a white-to-grey gradient), with the site's own sentences as copy. A "tokens" tab prints every
semantic token as a swatch with its computed contrast against its permitted surfaces, so the owner can read the
table in section 4.3 off the page. `body.s2u-crt` toggles from a control in the corner.

Guards (they refuse, in the repo's spirit):

1. `apps/s2u/src/ds/tokens.test.ts` (vitest): regenerates `tokens.css` from `tokens.json` in memory and refuses
   a file that differs; every pair in section 4.3 is recomputed from `tokens.json` and must meet its bar;
   `gold-source` and `cyan-boot` appear in no component rule; `css.test.ts`: no colour literal outside
   `tokens.css`, no `!important` outside a reduced-motion block, no `border` wider than 1px in a token colour;
   `classic.html`, `src/main.ts` and `src/style.css` import nothing from `ds/` (the boundary of section 1).
2. `apps/s2u/e2e/gallery.spec.ts` (Playwright, added to this repo for the purpose): the gallery at 1280x900 and
   390x844, screenshot against goldens in `apps/s2u/e2e/goldens/` at 0.2 % tolerance; an axe run with zero
   serious or critical violations; no request leaves for `fonts.googleapis.com` or `fonts.gstatic.com`.
3. `web/packages/viewer/src/ds/ds.test.ts` (vitest, socom_pc): the manifest hashes match the files; the
   `VERSION` is the one the viewer's README names.
4. The site's existing tests keep passing; `npm run typecheck && npm run lint` clean; `scripts/check-secrets.mjs`
   runs on the new public files as it does on the rest.

## 10. Handoff -- phases, files, gates

Every phase is one agent worktree and one PR into `develop` (this repo) or `sprint-*` (socom_pc); the gate is the
commands listed, run green, before the PR. Screenshot-diff phases carry a before/after pair in the PR. No phase
touches `classic.html` or `src/style.css`.

**Phase 1 -- the system, alone.** DONE 2026-09-27 (scotho `caddff1`, deployed 21:45Z; the plan beside this spec).
 `apps/s2u/src/ds/{VERSION,tokens.css,base.css,components.css,fonts/,README.md}`,
`gallery.html`, `tokens.test.ts`, Playwright + `gallery.spec.ts` + goldens; the font-fallback metrics recorded.
Nothing on the site changes yet. Gate: `npm test`, `npm run typecheck && npm run lint`, `npx playwright test
apps/s2u/e2e`, the gallery eyeballed on a phone.

**Phase 2 -- the site adopts it.** Plan: `docs/superpowers/plans/2026-09-27-s2u-design-system-phase-2.md`. DONE
2026-09-28 (scotho `674e784a`, see the plan).
 `index.html`, `chrome.md`, `home.css` rewritten to the components; `ui.css`
deleted; the Google Fonts head removed; `legacy.css` present during the phase and gone at its end;
`tools_py/story/site.py` in socom_pc pointed at `ds/` and its class names updated the same day, with the socom_pc
HANDOFF line. Gate: before/after screenshots of every section at both widths, the only diffs being the three
listed corrections (the lit tab, the label teal, the fine-print grey) and the fonts' metrics; every s2u test green.
Deploy with `npm run s2u:deploy` as DEPLOY.md says.

**Phase 3 -- the viewer adopts it.** Plan: `docs/superpowers/plans/2026-09-27-s2u-design-system-phase-3.md`. DONE
2026-09-28 (socom_pc branch `agent/ds-web` at `b027e63a`, worktree `wt-ds-web`; the system at 1.0.2; the viewer's fonts
emitted by the build; deployed 02:25Z). In socom_pc `web/`: `ds:sync` script, the vendored `ds/`, `MANIFEST.json`,
`ds.test.ts`, `index.html` classes added (ids untouched), `styles.css` cut down, e2e goldens re-cut. Gate: `npm
test`, `npm run build`, the e2e suite, the README's "Start here" gaining one line to this spec. Then a s2u deploy
picks up the new `dist/viewer` as `deploy.sh` already does.

**Phase 4 -- the first new page.** Plan: `docs/superpowers/plans/2026-09-27-s2u-design-system-phase-4.md`. DONE
2026-09-28 (scotho `3561341`; `/data.html` live, linked from every footer and the guide; TODO item 5 closed). TODO item 5 (the data page) is built on the system and is the proof that a
new page needs no new CSS beyond its own placement.

Owner rows (`docs/HUMAN_TASKS.md` in socom_pc, or this repo's TODO): none are required. Fonts are OFL and may be
self-hosted; deploy is the existing script; nothing publishes, pays, or touches permissions.

## 11. Review against design guidance, and what it changed

The writer read Anthropic's own frontend-design guidance (the `frontend-design` skill shipped with Claude Code,
and the published version of it) and a pass of current design-handoff checklists, on 2026-09-27, and held the
system against them. Sources: [Anthropic, Improving frontend design through Skills](https://claude.com/blog/improving-frontend-design-through-skills);
[the skill text](https://mcpservers.org/agent-skills/anthropic/frontend-design); [Claude Cookbook, prompting for
frontend aesthetics](https://platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics);
[Storyflow, the design handoff checklist](https://storyflow.so/blog/design-handoff-checklist);
[Eleken, design handoff checklist](https://www.eleken.co/blog-posts/design-handoff-checklist);
[Design Systems Collective, preparing a design system for accessibility](https://www.designsystemscollective.com/preparing-a-design-system-for-accessibility-af9e51015d9c).

The guidance's central point is the one this system is built on: ground the look in the subject's own world and
follow the brief exactly where it pins a direction. It also lists the tells of a generated page. Several of them
are present on the site today. Each was checked against the game's screens; the ones that are the game's stay
and the ones that are only the default go:

| Tell | On the site | Ruling |
|---|---|---|
| A tracked all-caps eyebrow above every heading | the kicker | **Stays**: it is the game's own line under a screen title (OPERATION RAPID KILL: SEEDING CHAOS), drawn *under* the title as the game draws it, never above |
| All-caps labels and buttons | every label, tab, button | **Stays**: the briefing's tabs and hints are caps; body text is never |
| Hairline rules, zero radius | everywhere | **Stays**: the game's panels |
| A monospace face for small data labels | fine print, stamps, the credits' licence lines | **Narrowed**, and the artifact agrees: mono (JetBrains Mono, `readout`) is for the viewer's readouts and the boot text only; the site's fine print and licence lines are `body-small` |
| Numbered markers where the content is not a sequence | the `#1 #2 #3` stamps on the WHAT THIS IS cards | **Cut**: `s2u-card__num` exists only for a real sequence (the setup steps); the three cards lose it |
| Fade-and-slide-up entrance on each section | `.reveal` | **Cut**: one orchestrated moment on load (the hero: logo, title, then the wheel rows rolling in once, as the console's wheel does) and nothing else moves unasked. Motion that answers an action (a disclosure opening, a tab lighting, the progress line) stays |
| Hover transitions on every card | `.card:hover` | **Narrowed**: only an interactive panel (`.is-link`, a tile) brightens; a card that is not a link does nothing on hover |
| Meta strings joined with middle dots | "SERVER ONLINE · 0 OPERATIVES", "ran-j · GPL-3.0 · vendored fork" | **Cut on the site**: the game joins with a slash (MAPS/INTEL) or a gap; the system uses ` / ` in a stat line and a line break in a credit. The viewer's mono readouts keep ` · ` as the artifact draws them (section 0) |
| A `→` or `›` appended to link text | "READ THE ENTRY ›" | **Cut**: the tile is already the link; the read line loses its arrow, and a button says what it does |
| Copy that sells | none found (owner's rule of 2026-09-24) | **Stays** as it is |

What the handoff checklists add, now required in section 6 and section 9:

- **A states matrix per component** in the gallery: rest, hover, focus-visible, active, disabled, busy, selected,
  error, and for content the extremes: empty, one item, the maximum, a long unbroken word, a two-line title.
- **An accessible name and focus order** written next to every interactive component in `components.css` as a
  comment, and the gallery's axe run as the guard.
- **Real copy** only: the gallery uses the site's sentences.
- **A reduced-motion alternative** stated per motion, not one global note: the hero moment becomes a static frame.

## 12. Reference material

Beside this file, `2026-09-27-s2u-design-system/`:

`game/` -- the console's own screens, captured by the parity gate from the real disc under PCSX2 (640x448, exact
colours; do not recompress). These are the origin of every token and the standard the classic menu answers to.

- `golden-sheet.png` -- twenty frames of the boot and menu run on one sheet: the two typewriter cards, the title,
  SELECT RANK, the controller screens, the memory-card dialogs, MISSION BRIEFING.
- `s07-main-menu.png` -- the title screen: the logo, the stretched italic roller, the footer.
- `s19-mission-briefing.png` -- the briefing: the gold title, the kicker, the lit tab, the panel head, the body
  text, the button hints. The single most useful frame for `s2u-head`, `s2u-panel`, `s2u-tab`, `s2u-hint`.
- `s08-select-rank.png` -- the lit row in a list and the one-line sentence panel.
- `s09-controller-config.png` -- two panels side by side with captions; the grey of a disabled area.
- `s05-boot-typewriter.png` -- the cyan machine text on black; `--s2u-machine`.

`briefing/` -- the owner's S2U Briefing design system as read from the artifact on 2026-09-27: `tokens.json`
(the source of truth, vendored into the repo by phase 1), its README (the brand book: boundary, voice, colour,
type, layout, states, iconography, motion) and `components/<Name>/{README.md,preview.html}` for Cover, HintBar,
Panel, StatTile, Tab, TopNav, TypedText and ViewerPanel. Read a component's README before styling its class.

`site/` -- the two surfaces as they are on 2026-09-27 (Playwright, Chromium, JPEG; for comparison, not colour
reference):

- `site-home-1280-full.jpg`, `site-home-390-full.jpg` -- the whole web page at desktop and phone; the before of
  phase 2.
- `site-story-1280-top.jpg` -- the generated story page's head, the shared chrome on a second page.
- `viewer-1280.jpg`, `viewer-390.jpg` -- the map viewer with its panel open over FROSTFIRE; the before of phase 3.
- `classic-1280-reference-only.jpg` -- the classic menu's ABOUT screen, the site's own recreation of the
  briefing; out of scope, kept here because it is the nearest thing to the game the modern pages can measure
  against on the same display.

## 13. Open decisions, ruled here

- **Rename the classes or alias them?** Ruled: rename, in phase 2, because two naming schemes on one site is the
  opposite of refined and the story generator is one file. The alias shim exists only inside the phase.
- **The display face.** Superseded by the artifact: Saira at width 62.5 % italic 800 (Exo 2 retired). A licensed
  Serpentine would be the owner's purchase and is not proposed; the artifact's README leaves the door open
  ("when the real condensed face is licensed, add it under fonts/").
- **Light theme?** Ruled: no. The game has one world and the system declares `color-scheme: dark` on purpose;
  the tokens are still two-layered so a theme could be added under `[data-theme]` without touching a component.
- **Rounded corners anywhere?** The artifact rules: the viewer's panel and fullscreen button only (`radius-viewer`,
  `radius-pill`), because the viewer is a tool; every game surface is `radius-0`.
- **The viewer's mint?** Ruled, and the artifact agrees: gone. Selection is `tab-lit` + `gold` exactly like a Tab;
  live values are `glyph-cross`; the loading bar is `gold` like every progress line.
- **The lit tab.** Superseded by the artifact (section 0): `tab-lit #093535` with the `gold #c4a04a` label,
  5.39:1, darker than either of the writer's candidates and truer to the game.
