# The s2u design system

The tokens, base and components the modern s2u pages and the map viewer share: the owner's **S2U Briefing** design
(a Claude Design artifact; its files are copied under `docs/briefing/` beside this README)
made into CSS. The spec is `docs/2026-09-27-s2u-design-system.md` here; the gallery at `/ds/`
(`web/landing/ds/index.html`) shows every component in every state and computes the contrast table live. Classic
(`classic.html`) is not a consumer, and a test refuses an import.

## Adopt

```css
@import '../../shared/ds/index.css';   /* from a page's own stylesheet (the path from web/landing/src/), which stays unlayered and wins every tie */
```

The `@import` must be the first rule of the page's stylesheet (CSS ignores an `@import` after any other rule, and
the layer order declared at the top of `tokens.css` has to land before the page's own rules). `aria-disabled="true"`
on an `<a class="s2u-tab">` only draws the disabled state: it does not stop navigation. For a control that must not
act, use a `<button class="s2u-tab" disabled>` or drop the `href`.

`body.s2u-crt` turns on the scanlines (needs `<div class="s2u-scan" aria-hidden="true">` first in the body after the
skip link) and the blur on `.s2u-crt-text`. `[data-density="compact"]` on any element scales the type and space
inside it down (the viewer's panel). `typed.ts` exports `typeInto(el, text, cps)` for the typewriter.

## Change a value

Never edit `tokens.css`: it is generated. Change the token in the artifact (or, failing that, in `tokens.json`
here, and say so in the commit), run `npm run tokens -w shared` (from `web/`), bump `VERSION`, run `npm test`. The generator
(`web/shared/tools/gen-tokens.mjs`) inserts `'<family> Fallback'` after the first family of each font stack. The
guard recomputes every contrast pair from the file; the select's chevron carries the gold by hand (`%23c4a04a` in
`components.css`) and changes with `gold`. The icon control (`.s2u-iconbtn`) is a panel-filled control, not a Tab
variant.

## Fonts

`web/shared/fonts/` holds three self-hosted woff2 files and their OFL licences, written once by `npm run fonts -w
shared`: `oswald-normal-variable-latin.woff2` (a variable font, declared `font-weight: 400 600`),
`saira-italic-800-latin.woff2` (declared under the family name `Saira Condensed`, `font-stretch: 62.5%`) and
`jetbrains-mono-normal-variable-latin.woff2` (`400 500`). `fonts.css` declares them and three metric-matched
fallbacks (`Oswald Fallback` from Arial Narrow, `Saira Condensed Fallback` from Arial Narrow Bold Italic,
`JetBrains Mono Fallback` from Consolas) from `npm run fonts:metrics -w shared`. Nothing loads from Google at
runtime; the Playwright run refuses a request to it.

## After a change

`npm test` in `web/` (this directory's tests run as the `shared` workspace), `npm run e2e -w landing` (re-cut goldens with `npm run e2e:update -w landing` only when the change is the point), then look
at `/ds/` at 1280 and 390.

## The two consumers

Since 2026-09-29 the system lives here, `web/shared/ds/` in socom_pc, and both sites read it in place -- no copy,
no sync, no manifest:

- **The landing site** (`web/landing`, socomunzipped.com). Its pages link `/src/ds/index.css`, which its Vite
  config aliases to this directory (`resolve.alias` in `web/landing/vite.config.ts`); its stylesheet and scripts
  import it by relative path (`../../shared/ds/...`). The story page that `tools_py/story/site.py` generates links
  the same `/src/ds/index.css`.
- **The map viewer** (`web/redotcom/packages/viewer`, served at `/map-viewer/`). `index.html` links
  `../../../shared/ds/index.css`.

`fonts.css` names the faces as `/fonts/<file>.woff2`; both Vite configs alias `/fonts/` to `web/shared/fonts/`
(`web/shared/vite.ts`), so the build bundles the three woff2 files and copies their licences beside them. The
guards that refused a hand-edited copy (the viewer's `ds.test.ts` and its MANIFEST) now read this directory
directly: there is one copy, so there is nothing to drift.
