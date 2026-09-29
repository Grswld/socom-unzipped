# The shared chrome of the s2u web pages

The look is the design system (`web/shared/ds/`, served to the landing site as `/src/ds/`, the gallery at `/ds/`);
this file is the markup contract between `web/landing/index.html` and the story generator `tools_py/story/site.py`,
which copies these blocks.

## Head

```html
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<meta name="theme-color" content="#000e11" />
<link rel="stylesheet" href="/src/home.css" />
```

`index.html` links only its own stylesheet, which puts the system first (`@import '../../shared/ds/index.css';`, cascade
layers) so its own rules stay unlayered and win every tie. No Google Fonts request: the system's `fonts.css`
self-hosts.

## Body: the fixed parts

```html
<a class="s2u-skip" href="#what">Skip to content</a>
<div class="s2u-scan" aria-hidden="true"></div>
<div id="progress" class="s2u-progress" aria-hidden="true"></div>
```

`body` carries `class="s2u-crt"` (the scanlines and CRT blur). `#progress` sets its own `--s2u-progress` custom
property from the scroll position (`home.ts` does it); without a script it stays at zero width, which is fine.

## The top bar

```html
<header id="bar" class="s2u-bar">
  <a class="s2u-bar__brand" href="#top" aria-label="SOCOM Unzipped, top of page"><span class="s2u-bar__ii">II</span><span class="s2u-bar__word">Unzipped</span></a>
  <nav class="s2u-bar__nav" aria-label="Sections">
    <a href="#what">What</a>
    <a href="#state">State</a>
    <a href="#story">Story</a>
    <a href="#server">Server</a>
    <a href="#setup">Setup</a>
    <a href="#report">Report</a>
    <a href="#credits">Credits</a>
  </nav>
  <div class="s2u-bar__end">
    <span class="s2u-lamp s2u-lamp--small" id="bar-lamp" role="img" aria-label="Server: contacting"></span>
    <a class="s2u-tab s2u-tab--nav" href="/classic.html" title="The original console-menu version of this site">Classic</a>
    <button id="sound" class="s2u-iconbtn" type="button" aria-pressed="false" aria-label="Sound: off. Click for menu sounds.">…</button>
  </div>
</header>
```

**The current link.** `home.ts` toggles `is-on` on the nav link for the section in view as the visitor scrolls
(`.s2u-bar__nav a.is-on`); the story page, which is not this page, keeps `aria-current="page"` on its own link.

**The sound button and the lamp.** `button.s2u-iconbtn#sound` and `span.s2u-lamp#bar-lamp` (lit `is-up` or
`is-down` from the stats poll) belong only to pages that run `home.ts`, which wires them; the design system
assumes nothing about either, so a page without sounds or a poll of its own (the story page) leaves them out
and `s2u-bar__end` holds just the Classic tab.

## A section

```html
<section id="…" class="s2u-section">
  <header class="s2u-head">
    <p class="s2u-kicker">Kicker line</p>
    <h2 class="s2u-title">Section title</h2>
    <p class="s2u-lede">One or two sentences under the title.</p>
  </header>
  …
  <p class="s2u-fine">Small print, `s2u-fine` (the body face, small)</p>
</section>
```

Inside a section: `.s2u-cards--3` / `.s2u-cards--2` of `article.s2u-card` (`h3`, `.s2u-card__body`,
`.s2u-card__how` with `span.s2u-label`; no number stamps), `.s2u-notice` for a boxed remark, `.s2u-list--plain`
and `.s2u-list--steps` lists (`.s2u-list--check.is-done` / `.is-todo` for the objectives screen's check marks,
no `OK`/`TODO` text stamps), a `<p class="s2u-tabs">` of `a.s2u-tab` / `a.s2u-tab.s2u-tab--ghost` for a CTA row.
The logo is `img.logo` (`/img/logo.webp?v=…`, always with a version query: Cloudflare caches `/img/` for a week).
A field is `<div class="s2u-field [s2u-field--area]"><label class="s2u-field__label" for>…control…</div>`; a form's
own container is `.s2u-panel__body`.

## The footer

```html
<footer class="s2u-foot">
  <div class="s2u-foot__inner">
    <div>
      <div class="s2u-foot__brand"><span class="s2u-bar__ii">II</span> SOCOM Unzipped</div>
      <p>Community PC port, licensed GPL-3.0. SOCOM II: U.S. Navy SEALs was developed by Zipper Interactive, Inc. &copy;2003 Sony Computer Entertainment America Inc. This project is not affiliated with or endorsed by Sony or Zipper.</p>
    </div>
    <nav aria-label="Footer">
      <a href="/story.html">The story</a>
      <a href="/classic.html">Classic menu</a>
      <a href="/map-viewer/">Map viewer (experimental)</a>
      <a href="https://github.com/Scotho/socom-unzipped" target="_blank" rel="noopener">GitHub</a>
      <a href="/#report">Report a bug</a>
      <a href="/data.html">Your data</a>
    </nav>
  </div>
  <p class="s2u-fine" id="foot-fine">…</p>
</footer>
```

The GitHub link is the repository's URL from `src/github.ts` (public since 2026-09-22).

The brand block and the licence paragraph are shared word for word. `.s2u-fine#foot-fine` is per page: the root
page puts its version and build stamp there; the story page can say when it was generated and from what.

## A copy that cannot reach `/src/ds/`

A copy of a page rendered somewhere other than this site (the story's `docs/story/index.html` in socom_pc) inlines
the four files of `web/shared/ds/` (`tokens.css`, `fonts.css`, `base.css`, `components.css`, in that order) in one
`<style>`, with `url('/fonts/` rewritten to `url('https://socomunzipped.com/fonts/`, carries the same header and
footer with every link absolute to `https://socomunzipped.com/`, and references the logo by its absolute URL.
Same source, two deliveries.
