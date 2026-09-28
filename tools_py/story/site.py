"""Render the story as one page in the site's own chrome: a vertical timeline under the s2u top bar and footer.

Spec 6.2: the site does not re-derive the timeline. This reads `docs/STORY.md` (already checked by the citation
test) and `docs/story/timeline.json`, and writes one HTML file with the CSS and the script inline and the pictures
referenced from `img/`, so the page and its images can be copied anywhere together. It fetches nothing and runs
no git; it is a build step, not a server.

The look is the site's design system, `src/ds/` in ../scotho/apps/s2u (tokens, self-hosted faces, base, components,
in cascade layers), with the chrome's markup written down in `src/chrome.md` beside it; this file copies those
blocks. The site copy links `/src/ds/index.css` once for Vite to bundle; the repository's own copy
(docs/story/index.html, the artifact preview) inlines the four layer files (`design_system_css`), with the font URLs
and every chrome link made absolute to https://socomunzipped.com/. Only the timeline's own styles are inline in
both, and they speak in the system's `--s2u-*` tokens alone. The timeline is a spine down the page with a node per
entry and a band per era; the entries sit still (the spec cut per-item reveals), the entry a reader arrived at is
lit through `:target`, and each has a stable anchor, `#<date>-<slug>`, which is the per-entry URL shape the spec asks
the site for.

Usage:
    python -m tools_py.story.site [--story docs/STORY.md] [--timeline docs/story/timeline.json]
                                  [--out docs/story/index.html] [--img img] [--logo img/logo.webp]
                                  [--repo https://github.com/Scotho/socom-unzipped] [--full-document]
    For the site copy, under Git Bash:
        MSYS_NO_PATHCONV=1 python -m tools_py.story.site --full-document
            --out C:/projects/scotho/apps/s2u/story.html --img /story/img --logo /img/logo.webp
    Without MSYS_NO_PATHCONV=1, "/story/img" arrives as "C:/Program Files/Git/story/img" (it did, once, and the live
    page lost every picture); with it, --out must be a Windows path, since "/c/..." is not translated either.
"""
import argparse
import html
import json
import os
import re
import sys

from tools_py.story import cite
from tools_py.story import timeline

ROOT = cite.ROOT
_IMG_RE = cite._IMG_RE
_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITAL_RE = re.compile(r"(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)")


def slug(title):
    """The entry's anchor. One definition, `timeline.slug`, shared with the data file the home page reads: until
    2026-09-27 this copy cut the slug at 60 characters and the data file's did not, so a long title gave the home
    page's LATEST tile a link with no anchor on this page (the owner's report; the site's story_anchors test)."""
    return timeline.slug(title)


def inline(text):
    out = html.escape(text, quote=False)
    out = _CODE_RE.sub(lambda m: "<code>%s</code>" % m.group(1), out)
    out = _BOLD_RE.sub(lambda m: "<strong>%s</strong>" % m.group(1), out)
    out = _ITAL_RE.sub(lambda m: "<em>%s</em>" % m.group(1), out)
    return out


def parse_document(markdown):
    doc = {"title": "", "preface": [], "eras": [], "closing": []}
    section, era, entry, para = "preface", None, None, []

    def flush():
        if not para:
            return
        text = " ".join(x.strip() for x in para).strip()
        del para[:]
        if not text or text == "---":
            return
        if section == "preface":
            doc["preface"].append(text)
        elif section == "era" and entry is not None:
            entry["blocks"].append(text)
        elif section == "era" and era is not None and not era["standing"] and text.startswith("*") and text.endswith("*"):
            era["standing"] = text.strip("*")
        elif section == "closing":
            doc["closing"][-1]["blocks"].append(text)

    for raw in markdown.splitlines():
        if raw.startswith("# "):
            flush(); doc["title"] = raw[2:].strip(); continue
        if raw.startswith("## "):
            flush()
            head = raw[3:].strip()
            m = re.match(r"^(\d{4}-\d{2}-\d{2}) \.\. (\d{4}-\d{2}-\d{2}) [—-]+ (.+)$", head)
            if m:
                section, entry = "era", None
                era = {"start": m.group(1), "end": m.group(2), "title": m.group(3), "standing": "", "entries": []}
                doc["eras"].append(era)
            elif not doc["eras"]:
                section, entry = "closing", None
                doc.setdefault("foreword", {"title": head, "blocks": []})
                doc["closing"].append(doc["foreword"])
            else:
                section, entry = "closing", None
                doc["closing"].append({"title": head, "blocks": []})
            continue
        m = cite._ENTRY_RE.match(raw)
        if m and section == "era":
            flush()
            entry = {"date": m.group(1), "title": m.group(2), "blocks": []}
            era["entries"].append(entry)
            continue
        if raw.strip() == "":
            flush(); continue
        if raw.startswith("```"):
            continue
        para.append(raw)
    flush()
    return doc


MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def pretty_date(d):
    y, m, dd = d.split("-")
    return "%s %d" % (MONTHS[int(m)], int(dd))


def media_url(img_base, name):
    """`<img_base>/<name>?v=<sha256 prefix>` of the file under docs/story/img/ -- the same bust the logo gets, because
    Cloudflare kept serving the first cut of a re-encoded video under its unchanged URL (2026-09-21). A name with
    no file behind it (the tests' fixtures) is left unstamped."""
    src = os.path.join(ROOT, cite.PICTURE_DIR, name)
    if not os.path.isfile(src):
        return "%s/%s" % (img_base, name)
    import hashlib
    with open(src, "rb") as f:
        return "%s/%s?v=%s" % (img_base, name, hashlib.sha256(f.read()).hexdigest()[:10])


def png_size(name):
    """(width, height) of a PNG under docs/story/img/, read from its header; None when the file is absent (the
    tests' fixtures) or not a PNG. The page writes them on every picture so the layout is settled before the
    picture loads: without them a picture is zero pixels tall until its bytes arrive, and a reader who followed
    a link to an entry was carried down the page by every picture above it as it loaded (owner, 2026-09-27; the
    entry landed and then moved 5,000-10,000 px)."""
    src = os.path.join(ROOT, cite.PICTURE_DIR, name)
    if not os.path.isfile(src):
        return None
    with open(src, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n" or len(head) < 24:
        return None
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


def size_attrs(name):
    size = png_size(name)
    return ' width="%d" height="%d"' % size if size else ""


def render_entry(e, repo, img_base, index):
    anchor = "%s-%s" % (e["date"], slug(e["title"]))
    parts = ['<li class="node" id="%s" style="--i:%d">' % (anchor, index),
             '<div class="dot" aria-hidden="true"></div>',
             '<article class="s2u-panel__body entry">',
             '<header><time datetime="%s">%s<span class="yr"> %s</span></time>'
             '<h3><a href="#%s">%s</a></h3></header>' % (e["date"], pretty_date(e["date"]), e["date"][:4], anchor, inline(e["title"]))]
    body, how, but, cited, figure = [], None, None, None, None
    for b in e["blocks"]:
        if b.startswith("**") and b.endswith("**"):
            parts.append('<p class="hook">%s</p>' % inline(b[2:-2]))
        elif b.startswith("*How:*"):
            how = inline(b[len("*How:*"):].strip())
        elif b.startswith("*But:*"):
            but = inline(b[len("*But:*"):].strip())
        elif b.startswith("`Cited:`"):
            try:
                cits = cite.parse_cited(b)
            except ValueError:
                cits = []
            chips = []
            for c in cits:
                if c.kind == "commit":
                    frag = html.escape(c.fragment) if c.fragment else ""
                    chips.append('<a class="cite commit" href="%s/commit/%s"><code>%s</code>%s</a>'
                                 % (repo, c.ref, c.ref, (" " + frag) if frag else ""))
                elif c.kind in ("run", "gate", "log"):
                    chips.append('<span class="cite run" title="a run record; its witness is in docs/story/witnesses.json">%s %s</span>'
                                 % (c.kind, html.escape(c.ref)))
                else:
                    chips.append('<a class="cite path" href="%s/blob/main/%s">%s</a>' % (repo, c.ref, html.escape(c.ref)))
            cited = " ".join(chips)
        elif _IMG_RE.match(b):
            m = _IMG_RE.match(b)
            caption, path = m.group(1), m.group(2)
            name = os.path.basename(path)
            if name.endswith(cite.VIDEO_EXT):
                # a video in the picture slot: the poster is the frame the checker required beside it, and
                # nothing plays until the reader asks (no autoplay, sound as recorded)
                poster = name[:-len(cite.VIDEO_EXT)] + ".png"
                figure = ('<figure><video controls preload="metadata" playsinline%s poster="%s">'
                          '<source src="%s" type="video/mp4">%s</video>'
                          '<figcaption>%s</figcaption></figure>'
                          % (size_attrs(poster), media_url(img_base, poster), media_url(img_base, name),
                             html.escape(caption), inline(caption)))
            else:
                figure = ('<figure><img src="%s" alt="%s"%s loading="lazy">'
                          '<figcaption>%s</figcaption></figure>'
                          % (media_url(img_base, name), html.escape(caption, quote=True), size_attrs(name),
                             inline(caption)))
        else:
            body.append("<p>%s</p>" % inline(b))
    parts.extend(body)
    if figure:
        parts.append(figure)
    if how:
        parts.append('<p class="how"><span class="s2u-label">How</span>%s</p>' % how)
    if but:
        parts.append('<p class="but"><span class="s2u-label">But</span>%s</p>' % but)
    if cited:
        parts.append('<details class="s2u-disclosure cited"><summary><span class="s2u-label">Cited</span><span class="n">%d</span></summary>'
                     '<div class="chips">%s</div></details>' % (cited.count('class="cite'), cited))
    parts.append("</article></li>")
    return "\n".join(parts)


CSS = r"""
/* The timeline's own styles. Everything shared with the site (the tokens, the faces, the bar, panels, labels, tabs,
   the footer) is the s2u design system (../scotho/apps/s2u/src/ds), linked on the site and inlined in the
   repository's copy. These rules speak only in its --s2u-* tokens: test_story_site refuses a literal or an old
   name. The system's layers sit under this unlayered sheet, so a rule here wins every tie without !important. */
html{scroll-padding-top:120px}
.wrap{max-width:calc(900px + 2*var(--s2u-gutter));margin:0 auto;padding:96px var(--s2u-gutter)}
/* the landing region is centred, like the front page's hero (owner, 2026-09-20). It is an s2u-head, so the title
   draws first and the kicker under it, as the game's screens do (spec 6), whatever the source order. */
.story-hero{text-align:center;align-items:center;margin-bottom:0}
.story-hero .logo{display:block;width:min(640px,100%);height:auto;margin:0 auto 6px}
.story-hero .s2u-kicker{justify-content:center}
.story-hero .s2u-title{font-size:clamp(34px,7vw,64px);line-height:.98;margin:0}
.s2u-title--story small{display:block;font:800 clamp(15px,2.6vw,22px)/1.2 var(--s2u-font-display);font-stretch:62.5%;font-style:italic;color:var(--s2u-glyph-cross);letter-spacing:1px;margin-top:8px;text-shadow:none}
.story-hero .s2u-lede{font-style:italic;margin:20px auto 0;max-width:62ch}
.preface{margin-top:22px;display:grid;gap:12px}
.preface p{margin:0;max-width:70ch}
.preface strong{color:var(--s2u-text-strong);font-family:var(--s2u-font-label);font-weight:600;letter-spacing:.4px;font-style:normal}
/* from the creator: a system panel (head and body) with the story's gold stripe down its left */
.foreword{margin:26px 0 0;position:relative}
.foreword::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--s2u-gold),transparent);z-index:1}
.foreword p{margin:8px 0;max-width:70ch}
.foreword .sig{font:600 14px/1.2 var(--s2u-font-label);letter-spacing:1.6px;color:var(--s2u-gold);margin-top:14px}
/* the counts: the system's stat tiles, six across (three on a phone) */
.strip{margin-top:26px;grid-template-columns:repeat(6,minmax(0,1fr))}
/* the era bar: sticky under the top bar, the current era's tab lit (is-on, from the page script) */
nav.eras{position:sticky;top:calc(48px + env(safe-area-inset-top,0px));z-index:5;margin:26px calc(-1*var(--s2u-gutter)) 0;padding:8px var(--s2u-gutter);display:flex;gap:6px;overflow-x:auto;
background:var(--s2u-ground);box-shadow:inset 0 -1px 0 var(--s2u-panel-edge);scrollbar-width:none}
nav.eras::-webkit-scrollbar{display:none}
nav.eras a{flex:none}
.tl{--spine:2px;--rail:64px;position:relative;margin:24px 0 0;padding:0;list-style:none}
.tl::before{content:"";position:absolute;left:calc(var(--rail)/2 - var(--spine)/2);top:0;bottom:0;width:var(--spine);
background:linear-gradient(180deg,transparent 0,var(--s2u-glyph-cross) 40px,var(--s2u-glyph-cross) calc(100% - 40px),transparent 100%);opacity:.7}
.era{position:relative;padding:38px 0 6px var(--rail);margin:0}
.era .mark{position:absolute;left:calc(var(--rail)/2 - 15px);top:44px;width:30px;height:30px;border:2px solid var(--s2u-gold);
background:var(--s2u-ground);transform:rotate(45deg);box-shadow:0 0 0 6px var(--s2u-ground)}
.era .mark::after{content:"";position:absolute;inset:7px;background:var(--s2u-gold)}
.era .span{font:var(--s2u-type-readout);letter-spacing:1.4px;color:var(--s2u-gold);display:block;margin:0 0 6px}
.era h2{font:600 clamp(22px,3.6vw,30px)/1.15 var(--s2u-font-label);letter-spacing:.8px;color:var(--s2u-text-strong);margin:0;text-wrap:balance}
.era .standing{color:var(--s2u-text-dim);font-style:italic;margin:10px 0 0;max-width:66ch}
.node{position:relative;padding:22px 0 0 var(--rail);margin:0}
.dot{position:absolute;left:calc(var(--rail)/2 - 7px);top:36px;width:14px;height:14px;border-radius:50%;background:var(--s2u-ground);
border:2px solid var(--s2u-glyph-cross);box-shadow:0 0 0 5px var(--s2u-ground);transition:border-color var(--s2u-dur-base),background-color var(--s2u-dur-base)}
.node.pic .dot{border-color:var(--s2u-gold)}
.node:target .dot{border-color:var(--s2u-gold);background:var(--s2u-gold)}
/* an entry is a system panel body; the story adds the arrow to the spine, the picture mark and the :target frame */
.entry{position:relative}
.entry::before{content:"";position:absolute;left:-9px;top:14px;border:8px solid transparent;border-right-color:var(--s2u-panel);border-left:0}
.node.pic .entry::after{content:"";position:absolute;right:12px;top:12px;width:8px;height:8px;background:var(--s2u-gold);transform:rotate(45deg);opacity:.7}
.node:target .entry{box-shadow:inset 0 0 0 1px var(--s2u-gold)}
.entry header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.entry time{font:var(--s2u-type-readout);letter-spacing:1.2px;color:var(--s2u-gold);font-variant-numeric:tabular-nums;white-space:nowrap}
.entry time .yr{color:var(--s2u-text-dim)}
.entry h3{font:600 20px/1.2 var(--s2u-font-label);letter-spacing:.4px;margin:0;color:var(--s2u-text-strong)}
.entry h3 a{color:inherit;text-decoration:none}.entry h3 a:hover{color:var(--s2u-gold)}
.hook{font:800 17px/1.4 var(--s2u-font-display);font-stretch:62.5%;font-style:italic;color:var(--s2u-text-strong);margin:10px 0 8px;text-wrap:pretty}
.entry p{margin:9px 0}
.entry code{background:var(--s2u-tab);padding:1px 4px}
.entry .how,.but{font:var(--s2u-type-body-small)}
.but{border-left:2px solid var(--s2u-gold);padding-left:12px}.but .s2u-label{color:var(--s2u-gold);box-shadow:inset 0 0 0 1px var(--s2u-gold)}
.cited{margin-top:10px;color:var(--s2u-text-dim)}
.cited .n{font:var(--s2u-type-readout-caption);color:var(--s2u-text-dim)}
.chips{margin-top:8px;line-height:1.9}
.cite{display:inline-block;margin:0 6px 4px 0;padding:1px 6px;box-shadow:inset 0 0 0 1px var(--s2u-panel-edge);text-decoration:none;color:var(--s2u-text-dim);font:var(--s2u-type-readout)}
.cite.commit code{color:var(--s2u-glyph-cross);background:none;padding:0}
.cite.commit:hover{box-shadow:inset 0 0 0 1px var(--s2u-glyph-cross);color:var(--s2u-text-strong)}
.cite.run{color:var(--s2u-glyph-cross)}
figure{margin:12px 0 4px;box-shadow:var(--s2u-panel-inset);background:var(--s2u-ground-deep);max-width:640px}
figure img,figure video{display:block;width:100%;height:auto;filter:saturate(.95)}
figcaption{padding:8px 10px;font:12.5px/1.45 var(--s2u-font-label);letter-spacing:.4px;color:var(--s2u-text-dim)}
.closing{margin-top:48px;padding:18px 20px;background:var(--s2u-tab);box-shadow:var(--s2u-panel-inset)}
.closing h2{font:600 22px/1.2 var(--s2u-font-label);letter-spacing:1px;color:var(--s2u-gold);margin:0 0 10px}
.closing p{max-width:70ch}
.closing code{font:var(--s2u-type-readout);color:var(--s2u-glyph-cross)}
@media (max-width:720px){.story-hero .logo{width:min(360px,78vw)}.strip{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:560px){.tl{--rail:34px}.entry{padding:12px 12px 10px}.entry header{gap:6px}.era .mark{width:22px;height:22px;left:calc(var(--rail)/2 - 11px);top:48px}
.era .mark::after{inset:5px}.dot{width:12px;height:12px;left:calc(var(--rail)/2 - 6px)}}
"""

JS = r"""
(function(){
  // the repository copy (docs/story/index.html, a fragment the artifact preview wraps) has no <body> tag of its own
  document.body.classList.add('s2u-crt');
  var pb=document.getElementById('progress');
  function onScroll(){var h=document.documentElement,max=h.scrollHeight-h.clientHeight;if(pb)pb.style.setProperty('--s2u-progress',String(max>0?h.scrollTop/max:0));}
  addEventListener('scroll',onScroll,{passive:true});onScroll();
  function hashTarget(){if(!location.hash)return null;var id=location.hash.slice(1);try{id=decodeURIComponent(id);}catch(e){}return document.getElementById(id);}
  // A page opened at an entry (#<date>-<slug>, the home page's LATEST tiles) settles on it once the late layout
  // is in. Two things went wrong here until 2026-09-27: an entry's id starts with its date, and a digit cannot
  // open a CSS id selector, so querySelector(location.hash) threw and nothing below this line ran; and the site's
  // scroll-behavior is smooth, so the browser's own jump to the anchor is an animation whose destination is fixed
  // when it starts, while the web fonts (and, before every picture carried its size, the pictures) arrive and
  // move the anchor while it plays. So: the id is looked up by name, the settle is instant, and it repeats for
  // a few seconds after every font and picture load, unless the reader has already touched the page.
  var settleUntil=Date.now()+4000,moved=false;
  ['wheel','touchstart','keydown','pointerdown'].forEach(function(ev){addEventListener(ev,function(){moved=true;},{passive:true});});
  function settle(){
    if(moved||Date.now()>settleUntil)return;
    var t=hashTarget();if(!t)return;
    var pad=parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)||0;
    var y=Math.max(0,Math.round(t.getBoundingClientRect().top+scrollY-pad));
    if(Math.abs(y-scrollY)>1){try{scrollTo({top:y,left:0,behavior:'instant'});}catch(e){scrollTo(0,y);}}
  }
  addEventListener('load',settle);
  if(document.fonts){if(document.fonts.ready){document.fonts.ready.then(settle);}document.fonts.addEventListener('loadingdone',settle);}
  [].slice.call(document.querySelectorAll('.entry img')).forEach(function(img){if(!img.complete){img.addEventListener('load',settle);}});
  var tick=setInterval(function(){if(moved||Date.now()>settleUntil){clearInterval(tick);return;}settle();},250);
  // the era bar: the tab of the era in view is lit (the system's is-on) and is the current one for a reader
  var links=[].slice.call(document.querySelectorAll('nav.eras a')),eras=[].slice.call(document.querySelectorAll('.era'));
  function current(){var y=scrollY+140,on=null;eras.forEach(function(s){if(s.offsetTop<=y)on=s.id;});links.forEach(function(a){var lit=a.getAttribute('href')==='#'+on;a.classList.toggle('is-on',lit);if(lit){a.setAttribute('aria-current','true');}else{a.removeAttribute('aria-current');}});}
  addEventListener('scroll',current,{passive:true});current();
})();
"""

SITE = "https://socomunzipped.com"
DS_FILES = ("tokens.css", "fonts.css", "base.css", "components.css")


def design_system_css(ds_dir, absolute=None):
    """The design system as one stylesheet for a copy that cannot link it: the four layer files of `ds_dir`
    (scotho's apps/s2u/src/ds) in the order index.css imports them, tokens first so the `@layer` statement that fixes
    the layer order lands before any rule (index.css itself is only `@import`s, which the inlined form cannot carry).
    With `absolute`, the self-hosted fonts' `url('/fonts/...')` are made absolute to that origin, since the copy is
    not served from the site."""
    parts = []
    for name in DS_FILES:
        with open(os.path.join(ds_dir, name), encoding="utf-8") as f:
            parts.append(f.read().rstrip("\n"))
    css = "\n".join(parts) + "\n"
    if absolute:
        css = css.replace("url('/fonts/", "url('%s/fonts/" % absolute.rstrip("/"))
    return css


def chrome_header(base):
    """The site's top bar, the block in apps/s2u/src/chrome.md word for word, with the Story link current
    (`is-on` plus `aria-current="page"`; the front page's script toggles `is-on` on its own links as the reader
    scrolls). `base` is "" on the site and the absolute site origin in a copy that lives elsewhere. Since 2026-09-20
    (evening) the web page is the site's default view, so the section links are /#..., and the console menu is
    /classic.html. No lamp and no sound button: those belong to pages that run home.ts (chrome.md), so the bar's end
    holds the Classic tab alone."""
    w = base + "/"
    lines = [
        '<a class="s2u-skip" href="#main">Skip to content</a>',
        '<div class="s2u-scan" aria-hidden="true"></div>',
        '<div id="progress" class="s2u-progress" aria-hidden="true"></div>',
        '<header id="bar" class="s2u-bar">',
        '  <a class="s2u-bar__brand" href="%s#top" aria-label="SOCOM Unzipped, top of page"><span class="s2u-bar__ii">II</span><span class="s2u-bar__word">Unzipped</span></a>' % w,
        '  <nav class="s2u-bar__nav" aria-label="Sections">',
        '    <a href="%s#what">What</a>' % w,
        '    <a href="%s#state">State</a>' % w,
        '    <a href="%s/story.html" class="is-on" aria-current="page">Story</a>' % base,
        '    <a href="%s#server">Server</a>' % w,
        '    <a href="%s#setup">Setup</a>' % w,
        '    <a href="%s#report">Report</a>' % w,
        '    <a href="%s#credits">Credits</a>' % w,
        '  </nav>',
        '  <div class="s2u-bar__end">',
        '    <a class="s2u-tab s2u-tab--nav" href="%s/classic.html" title="The original console-menu version of this site">Classic</a>' % base,
        '  </div>',
        '</header>',
    ]
    return "\n".join(lines) + "\n"


def chrome_footer(base, fine, repo="https://github.com/Scotho/socom-unzipped"):
    """The site's footer, the block in chrome.md: the brand and the licence paragraph shared word for word, the
    footer nav, and the page's own fine print in `.s2u-fine`."""
    w = base + "/"
    lines = [
        '<footer class="s2u-foot">',
        '  <div class="s2u-foot__inner">',
        '    <div>',
        '      <div class="s2u-foot__brand"><span class="s2u-bar__ii">II</span> SOCOM Unzipped</div>',
        '      <p>Community PC port, licensed GPL-3.0. SOCOM II: U.S. Navy SEALs was developed by Zipper Interactive, Inc. '
        '&copy;2003 Sony Computer Entertainment America Inc. This project is not affiliated with or endorsed by Sony or Zipper.</p>',
        '    </div>',
        '    <nav aria-label="Footer">',
        '      <a href="%s/story.html">The story</a>' % base,
        '      <a href="%s/classic.html">Classic menu</a>' % base,
        '      <a href="%s/map-viewer/">Map viewer (experimental)</a>' % base,
        '      <a href="%s" target="_blank" rel="noopener">GitHub</a>' % repo,
        '      <a href="%s#report">Report a bug</a>' % w,
        '      <a href="%s/data.html">Your data</a>' % base,
        '    </nav>',
        '  </div>',
        '  <p class="s2u-fine" id="foot-fine">%s</p>' % fine,
        '</footer>',
    ]
    return "\n".join(lines) + "\n"


def stamped(logo_url, out_path):
    """The logo URL with ?v=<sha256 prefix> of the file it names, when that file can be found beside the page.

    Cloudflare served a week-old /img/logo.webp to the live story page once, so the site busts its own assets with
    a version query; the story page does the same from the file's hash, not a date. The file is looked for as the
    page would resolve it (`<out dir>/<url>`) and, for the Vite site, under `<out dir>/public/<url>`; when neither
    exists the URL is left alone."""
    if "?" in logo_url:
        return logo_url
    rel = logo_url.lstrip("/")
    out_dir = os.path.dirname(os.path.abspath(out_path)) if out_path and out_path != os.devnull else ""
    for candidate in ([os.path.join(out_dir, rel), os.path.join(out_dir, "public", rel)] if out_dir else []):
        if os.path.isfile(candidate):
            import hashlib
            h = hashlib.sha256()
            with open(candidate, "rb") as f:
                h.update(f.read())
            return "%s?v=%s" % (logo_url, h.hexdigest()[:10])
    return logo_url


def render(doc, timeline, repo, img_base, logo, ds_dir=None, absolute=None, base=""):
    """On the site (`ds_dir` None) the design system is linked once, `/src/ds/index.css`, for Vite to bundle. A copy
    that cannot link it names the system's directory in `ds_dir`: its four layer files are inlined
    (`design_system_css`), the fonts' URLs made absolute to `absolute`, and `base` is the site's origin so every
    chrome link is absolute too."""
    head_sha = timeline.get("head", "")
    generated = timeline.get("generated", "")
    entries = [e for era in doc["eras"] for e in era["entries"]]
    n_commits = sum(1 for e in timeline.get("entries", []) for c in e.get("citations", []) if c.get("kind") == "commit")
    n_pics = sum(1 for e in timeline.get("entries", []) if e.get("picture"))
    first, last = entries[0]["date"], entries[-1]["date"]
    days = (int(last[8:]) - int(first[8:])) + 1 if first[:7] == last[:7] else "?"
    title = doc["title"].replace("SOCOM Unzipped: ", "").replace("SOCOM Unzipped \u2014 ", "")
    fore = doc.get("foreword")
    closing = [c for c in doc["closing"] if c is not fore]
    out = ["<title>SOCOM Unzipped Story: how SOCOM II is becoming a PC game</title>",
           '<meta name="description" content="How SOCOM II is becoming a PC game: the timeline, every claim cited.">',
           '<meta name="theme-color" content="#000e11">',
           # SEO (2026-09-27): one canonical for both copies, and the link-preview tags; the share image is the site's.
           '<link rel="canonical" href="%s/story.html">' % SITE,
           '<meta property="og:type" content="article">',
           '<meta property="og:site_name" content="SOCOM II Unzipped">',
           '<meta property="og:title" content="SOCOM Unzipped Story: how SOCOM II is becoming a PC game">',
           '<meta property="og:description" content="How SOCOM II is becoming a PC game: the timeline, every claim cited.">',
           '<meta property="og:url" content="%s/story.html">' % SITE,
           '<meta property="og:image" content="%s/img/share.jpg">' % SITE,
           '<meta name="twitter:card" content="summary_large_image">']
    if ds_dir is None:
        out.append('<link rel="stylesheet" href="/src/ds/index.css">')
    else:
        out.append("<style>%s</style>" % design_system_css(ds_dir, absolute))
    out.append("<style>%s</style>" % CSS)
    out.append(chrome_header(base))
    out.append('<main id="main"><div class="wrap">')
    # the hero is an s2u-head: the title first and the kicker under it, whatever the source order (spec 6)
    out.append('<header class="s2u-head story-hero">')
    out.append('<img class="logo" src="%s" alt="SOCOM II U.S. Navy SEALs" width="640" height="280" decoding="async">' % logo)
    out.append('<h1 class="s2u-title s2u-title--story">%s<small>Trying to turn a PlayStation 2 game into a PC game. %s days in.</small></h1>'
               % (inline(title), days))
    out.append('<p class="s2u-kicker"><span class="s2u-blink"></span>Mission briefing / the story so far</p>')
    if doc["preface"]:
        out.append('<p class="s2u-lede">%s</p>' % inline(doc["preface"][0].strip("*")))
    out.append("</header>")
    stats = ((len(entries), "entries"), (n_commits, "commits cited"), (len(doc["eras"]), "eras"), (n_pics, "pictures"),
             (pretty_date(first), "first commit"), (pretty_date(last), "latest"))
    out.append('<ul class="s2u-stats strip">%s</ul>'
               % "".join('<li class="s2u-stat"><b class="s2u-stat__v">%s</b><span class="s2u-stat__k">%s</span></li>' % s for s in stats))
    out.append('<section class="preface">')
    for p in doc["preface"][1:]:
        out.append("<p>%s</p>" % inline(p))
    out.append("</section>")
    if fore:
        out.append('<section class="s2u-panel foreword" id="from-the-creator"><h2 class="s2u-panel__head">%s</h2><div class="s2u-panel__body">'
                   % inline(fore["title"]))
        for b in fore["blocks"]:
            if b.strip() in ("Scotho", "Craig") or b.startswith("\u2014") or b.startswith("--"):
                out.append('<p class="sig">%s</p>' % inline(b))
            else:
                out.append("<p>%s</p>" % inline(b))
        out.append("</div></section>")
    out.append('<nav class="eras" aria-label="Eras">')
    for era in doc["eras"]:
        out.append('<a class="s2u-tab s2u-tab--nav" href="#era-%s">%s<span class="s2u-tab__what">%s &ndash; %s / %d</span></a>'
                   % (era["start"], inline(era["title"]), pretty_date(era["start"]), pretty_date(era["end"]), len(era["entries"])))
    out.append("</nav>")
    out.append('<ol class="tl">')
    idx = 0
    for era in doc["eras"]:
        out.append('<li class="era" id="era-%s"><div class="mark" aria-hidden="true"></div>'
                   '<span class="span">%s &ndash; %s</span><h2>%s</h2>' % (era["start"], era["start"], era["end"], inline(era["title"])))
        if era["standing"]:
            out.append('<p class="standing">%s</p>' % inline(era["standing"]))
        out.append("</li>")
        for e in era["entries"]:
            has_pic = any(_IMG_RE.match(b) for b in e["blocks"])
            html_e = render_entry(e, repo, img_base, idx)
            if has_pic:
                html_e = html_e.replace('class="node"', 'class="node pic"', 1)
            out.append(html_e)
            idx += 1
    out.append("</ol>")
    # The closing sections of STORY.md (the night's summary, how the document is checked) stay in the repository
    # copy only: the site page ends on the timeline (owner, 2026-09-26).
    del closing
    out.append("</div></main>")
    # the fine line joins with " / ", the system's separator (a middle dot only survives inside <code> or a chip)
    fine = ("generated %s from docs/STORY.md at %s / %d entries, %d commit citations / checked by tools_py/story/cite.py "
            "/ link to a moment: #&lt;date&gt;-&lt;slug&gt;" % (generated, head_sha, len(entries), n_commits))
    out.append(chrome_footer(base, fine, repo))
    out.append("<script>%s</script>" % JS)
    return "\n".join(out) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render docs/STORY.md as one page in the site's chrome.")
    ap.add_argument("--story", default=os.path.join(ROOT, "docs", "STORY.md"))
    ap.add_argument("--timeline", default=os.path.join(ROOT, "docs", "story", "timeline.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "docs", "story", "index.html"))
    ap.add_argument("--img", default="img", help="the pictures' path relative to the page")
    ap.add_argument("--logo", default="img/logo.webp", help="the site's logo, as the page will reference it")
    ap.add_argument("--repo", default="https://github.com/Scotho/socom-unzipped")
    ap.add_argument("--full-document", action="store_true",
                    help="the site copy: a complete HTML document that links /src/ds/index.css for Vite to bundle")
    ap.add_argument("--ds-dir", default=os.path.join(os.path.dirname(ROOT), "scotho", "apps", "s2u", "src", "ds"),
                    help="the site's design system directory, whose four layer files are inlined into a copy that "
                         "cannot link it (the default docs copy)")
    args = ap.parse_args(argv)
    # Git Bash rewrites an argument that looks like an absolute POSIX path ("/story/img") into a Windows path
    # ("C:/Program Files/Git/story/img") before Python ever sees it. That shipped once: every picture and the logo
    # on socomunzipped.com/story.html pointed at a path on the build machine. A URL path never carries a drive letter,
    # so one that does is refused here rather than rendered.
    for name, value in (("--img", args.img), ("--logo", args.logo)):
        if ":" in value.split("?")[0] and not value.startswith("https://") or "Program Files" in value:
            sys.stderr.write("%s=%r is a filesystem path, not a URL path. Under Git Bash run with MSYS_NO_PATHCONV=1, "
                             "or write the argument as //story/img.\n" % (name, value))
            return 2
    with open(args.story, encoding="utf-8") as f:
        doc = parse_document(f.read())
    with open(args.timeline, encoding="utf-8") as f:
        timeline = json.load(f)
    if args.full_document:
        page = render(doc, timeline, args.repo, args.img.rstrip("/"), stamped(args.logo, args.out))
        head_end = page.index('<a class="s2u-skip"')
        page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">\n' + page[:head_end] +
                '</head>\n<body class="s2u-crt">\n' + page[head_end:] + '</body>\n</html>\n')
    else:
        # the repository's own copy: the design system inlined, the chrome's links absolute, the logo from the site.
        # Without the system the copy would be unstyled, so its absence is an error, not a warning.
        if not all(os.path.isfile(os.path.join(args.ds_dir, name)) for name in DS_FILES):
            sys.stderr.write("%s does not hold the design system (%s); the repository copy inlines it. Pass --ds-dir.\n"
                             % (args.ds_dir, ", ".join(DS_FILES)))
            return 2
        # the logo: the copy's own file beside the page when there is one (docs/story/img/logo.webp travels with the
        # repository and the artifact preview), else the site's, absolute
        logo = args.logo
        if not logo.startswith("http"):
            beside = os.path.join(os.path.dirname(os.path.abspath(args.out)), logo.lstrip("/"))
            if os.path.isfile(beside):
                logo = stamped(logo, args.out)
            else:
                site_logo = os.path.join(args.ds_dir, "..", "..", "public", "img", "logo.webp")
                logo = SITE + "/img/logo.webp"
                if os.path.isfile(site_logo):
                    logo = SITE + stamped("/img/logo.webp", os.path.join(os.path.dirname(site_logo), "..", "..", "x"))
        page = render(doc, timeline, args.repo, args.img.rstrip("/"), logo, ds_dir=args.ds_dir, absolute=SITE, base=SITE)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    print("%s: %d bytes, %d eras, %d entries" % (args.out, len(page.encode("utf-8")), len(doc["eras"]),
                                                  sum(len(e["entries"]) for e in doc["eras"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
