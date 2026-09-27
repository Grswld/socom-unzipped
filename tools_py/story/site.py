"""Render the story as one page in the site's own chrome: a vertical timeline under the s2u top bar and footer.

Spec 6.2: the site does not re-derive the timeline. This reads `docs/STORY.md` (already checked by the citation
test) and `docs/story/timeline.json`, and writes one HTML file with the CSS and the script inline and the pictures
referenced from `img/`, so the page and its images can be copied anywhere together. It fetches nothing and runs
no git; it is a build step, not a server.

The shared chrome (tokens, top bar, sections, buttons, footer) is the site's `src/ui.css`, with its markup written
down in `src/chrome.md` (both in ../scotho/apps/s2u). The site copy links `/src/ui.css` for Vite to bundle; the
repository's own copy (docs/story/index.html, the artifact preview) inlines it and makes every chrome link absolute
to https://s2u.scotho.com/. Only the timeline's own styles are inline in both. The timeline is a spine down the page with a node per entry and a
band per era; entries reveal as they scroll into view (not at all when the viewer prefers reduced motion), and
each has a stable anchor, `#<date>-<slug>`, which is the per-entry URL shape the spec asks the site for.

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

ROOT = cite.ROOT
_IMG_RE = cite._IMG_RE
_CODE_RE = re.compile(r"`([^`]+)`")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITAL_RE = re.compile(r"(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)")


def slug(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60].rstrip("-")


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


def render_entry(e, repo, img_base, index):
    anchor = "%s-%s" % (e["date"], slug(e["title"]))
    parts = ['<li class="node" id="%s" style="--i:%d">' % (anchor, index),
             '<div class="dot" aria-hidden="true"></div>',
             '<article class="card">',
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
                figure = ('<figure><video controls preload="metadata" playsinline poster="%s">'
                          '<source src="%s" type="video/mp4">%s</video>'
                          '<figcaption>%s</figcaption></figure>'
                          % (media_url(img_base, poster), media_url(img_base, name), html.escape(caption), inline(caption)))
            else:
                figure = ('<figure><img src="%s" alt="%s" loading="lazy">'
                          '<figcaption>%s</figcaption></figure>'
                          % (media_url(img_base, name), html.escape(caption, quote=True), inline(caption)))
        else:
            body.append("<p>%s</p>" % inline(b))
    parts.extend(body)
    if figure:
        parts.append(figure)
    if how:
        parts.append('<p class="how"><span class="lbl">How</span>%s</p>' % how)
    if but:
        parts.append('<p class="but"><span class="lbl">But</span>%s</p>' % but)
    if cited:
        parts.append('<details class="cited"><summary><span class="lbl">Cited</span><span class="n">%d</span></summary>'
                     '<div class="chips">%s</div></details>' % (cited.count('class="cite'), cited))
    parts.append("</article></li>")
    return "\n".join(parts)


CSS = r"""
/* Timeline-only styles. Everything shared with the site (tokens, top bar, sections, cards, buttons, footer) comes
   from the site's ui.css, linked on the site and inlined in the repository's own copy. */
html{scroll-padding-top:120px}
.wrap{max-width:900px;margin:0 auto;padding-block:96px 96px}
/* the landing region is centred, like web.html's hero (owner, 2026-09-20); the logo's size and glow come from ui.css */
.story-hero{text-align:center}
.story-hero .logo{margin:0 auto 6px}
.story-hero .brief-sub{justify-content:center}
.story-hero .brief-title{margin-inline:auto}
.brief-title{font:800 clamp(34px,7vw,64px)/.98 var(--disp);font-style:italic;letter-spacing:.5px;color:var(--lit);margin:0;
text-shadow:0 0 2px rgba(127,217,230,.9),0 0 18px rgba(127,217,230,.35);text-wrap:balance}
.brief-title small{display:block;font:700 clamp(15px,2.6vw,22px)/1.2 var(--disp);font-style:italic;color:var(--glow);letter-spacing:1px;margin-top:8px;text-shadow:none}
.lede{color:var(--dim);font-style:italic;margin:20px auto 0;max-width:62ch}
.preface{margin-top:22px;display:grid;gap:12px}
.preface p{margin:0;max-width:70ch}
.preface strong{color:var(--lit);font-family:var(--head);font-weight:600;letter-spacing:.4px;font-style:normal}
.foreword{margin:26px 0 0;padding:20px 22px 16px;background:linear-gradient(180deg,rgba(10,38,44,.9),rgba(10,30,36,.78));border:1px solid var(--line);position:relative}
.foreword::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--gold),transparent)}
.foreword .brief-sub{margin-bottom:8px}
.foreword p{margin:8px 0;max-width:70ch;font-size:16.5px;line-height:1.6}
.foreword .sig{font:600 14px/1.2 var(--head);letter-spacing:1.6px;color:var(--gold);margin-top:14px}
.strip{display:flex;flex-wrap:wrap;gap:10px;margin:26px 0 0;padding:0;list-style:none}
.strip li{flex:1 1 130px;padding:10px 12px;background:var(--panel2);border:1px solid var(--line)}
.strip b{display:block;font:600 24px/1 var(--head);color:var(--gold2);font-variant-numeric:tabular-nums}
.strip span{font:600 11px/1.3 var(--head);letter-spacing:1.6px;text-transform:uppercase;color:var(--dim)}
nav.eras{position:sticky;top:calc(52px + env(safe-area-inset-top,0px));z-index:5;margin:26px -16px 0;padding:8px 16px;display:flex;gap:6px;overflow-x:auto;
background:rgba(8,18,22,.88);backdrop-filter:blur(6px);border-bottom:1px solid var(--line2);scrollbar-width:none}
nav.eras::-webkit-scrollbar{display:none}
nav.eras a{flex:none;padding:6px 10px;border:1px solid var(--line2);color:var(--dim);text-decoration:none;
font:600 11px/1.2 var(--head);letter-spacing:1.4px;text-transform:uppercase;transition:color .15s,border-color .15s}
nav.eras a small{display:block;font:10px/1.2 var(--mono);letter-spacing:.3px;color:var(--dim2);text-transform:none;margin-top:2px}
nav.eras a:hover,nav.eras a.on{color:var(--lit);border-color:var(--gold)}
.tl{--spine:2px;--rail:64px;position:relative;margin:24px 0 0;padding:0;list-style:none}
.tl::before{content:"";position:absolute;left:calc(var(--rail)/2 - var(--spine)/2);top:0;bottom:0;width:var(--spine);
background:linear-gradient(180deg,transparent 0,var(--teal) 40px,var(--teal) calc(100% - 40px),transparent 100%);opacity:.7}
.era{position:relative;padding:38px 0 6px var(--rail);margin:0}
.era .mark{position:absolute;left:calc(var(--rail)/2 - 15px);top:44px;width:30px;height:30px;border:2px solid var(--gold);
background:var(--bg);transform:rotate(45deg);box-shadow:0 0 0 6px var(--bg),0 0 18px rgba(217,178,58,.5)}
.era .mark::after{content:"";position:absolute;inset:7px;background:var(--gold)}
.era .span{font:12px/1.2 var(--mono);letter-spacing:1.4px;color:var(--gold);display:block;margin:0 0 6px}
.era h2{font:600 clamp(22px,3.6vw,30px)/1.15 var(--head);letter-spacing:.8px;color:var(--lit);margin:0;text-wrap:balance}
.era .standing{color:var(--dim);font-style:italic;margin:10px 0 0;max-width:66ch}
.node{position:relative;padding:22px 0 0 var(--rail);margin:0}
.dot{position:absolute;left:calc(var(--rail)/2 - 7px);top:36px;width:14px;height:14px;border-radius:50%;background:var(--bg);
border:2px solid var(--teal);box-shadow:0 0 0 5px var(--bg);transition:border-color .3s,box-shadow .3s}
.node:target .dot,.node.in .dot{border-color:var(--glow);box-shadow:0 0 0 5px var(--bg),0 0 14px rgba(127,217,230,.55)}
.node.pic .dot{border-color:var(--gold)}
.entry{position:relative;padding:16px 18px 14px;background:var(--panel);border:1px solid var(--line2);
transition:border-color .25s,transform .5s var(--ease),box-shadow .25s}
.entry:hover{border-color:var(--line);box-shadow:0 8px 30px rgba(0,0,0,.35)}
.entry::before{content:"";position:absolute;left:-9px;top:14px;border:8px solid transparent;border-right-color:var(--line2);border-left:0}
.node.pic .entry::after{content:"";position:absolute;right:12px;top:12px;width:8px;height:8px;background:var(--gold);transform:rotate(45deg);opacity:.7}
.node:target .entry{border-color:var(--gold);box-shadow:0 0 0 1px rgba(217,178,58,.3)}
.entry header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
.entry time{font:12.5px/1.2 var(--mono);letter-spacing:1.2px;color:var(--gold);font-variant-numeric:tabular-nums;white-space:nowrap}
.entry time .yr{color:var(--dim2)}
.entry h3{font:600 20px/1.2 var(--head);letter-spacing:.4px;margin:0;color:var(--lit)}
.entry h3 a{color:inherit;text-decoration:none}.entry h3 a:hover{color:#fff;text-shadow:0 0 6px rgba(127,217,230,.6)}
.hook{font:700 17px/1.4 var(--disp);font-style:italic;color:#fff;margin:10px 0 8px;text-wrap:pretty}
.entry p{margin:9px 0;max-width:68ch}
.entry code{background:rgba(0,0,0,.35);padding:1px 4px}
.entry .how{font-size:14.5px}
.but{border-left:2px solid var(--gold);padding-left:12px;font-size:15px}.but .lbl{color:var(--gold);border-color:rgba(217,178,58,.5)}
details.cited{margin-top:10px;font-size:12.5px;color:var(--dim2)}
details.cited summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;color:var(--dim)}
details.cited summary::-webkit-details-marker{display:none}
details.cited summary .n{font:11px var(--mono);color:var(--dim2)}
details.cited summary::after{content:"+";font:600 14px var(--head);color:var(--teal)}
details[open].cited summary::after{content:"\2212"}
.chips{margin-top:8px;line-height:1.9}
.cite{display:inline-block;margin:0 6px 4px 0;padding:1px 6px;border:1px solid var(--line2);text-decoration:none;color:var(--dim)}
.cite.commit code{color:var(--glow);background:none;padding:0}
.cite.commit:hover{border-color:var(--glow);color:var(--lit)}
.cite.run{font-family:var(--mono);font-size:12px;color:var(--teal)}
figure{margin:12px 0 4px;border:1px solid var(--line2);background:#000;max-width:640px}
figure img,figure video{display:block;width:100%;height:auto;filter:saturate(.95)}
figcaption{padding:8px 10px;font:12.5px/1.45 var(--head);letter-spacing:.4px;color:var(--dim)}
.closing{margin-top:48px;padding:18px 20px;background:var(--panel2);border:1px solid var(--line)}
.closing h2{font:600 22px/1.2 var(--head);letter-spacing:1px;color:var(--gold);margin:0 0 10px}
.closing p{max-width:70ch}
.closing code{font:13px var(--mono);color:var(--glow)}
@media (prefers-reduced-motion:no-preference){
 .entry{transform:translateY(14px)}
 .node.in .entry,.node:target .entry{transform:none;border-color:var(--line)}
}
@media (prefers-reduced-motion:reduce){.entry{transform:none}}
@media (max-width:560px){.tl{--rail:34px}.entry{padding:12px 12px 10px}.entry header{gap:6px}.era .mark{width:22px;height:22px;left:calc(var(--rail)/2 - 11px);top:48px}
.era .mark::after{inset:5px}.dot{width:12px;height:12px;left:calc(var(--rail)/2 - 6px)}}
"""

JS = r"""
(function(){
  var bar=document.getElementById('bar'),pb=document.querySelector('#progress i');
  function onScroll(){var h=document.documentElement,max=h.scrollHeight-h.clientHeight;if(pb)pb.style.width=(max>0?(h.scrollTop/max*100):0)+'%';if(bar)bar.classList.toggle('solid',scrollY>40);}
  addEventListener('scroll',onScroll,{passive:true});onScroll();
  var nodes=[].slice.call(document.querySelectorAll('.node'));
  var reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduce&&'IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{rootMargin:'0px 0px -12% 0px',threshold:0.08});
    nodes.forEach(function(n){io.observe(n);});
    if(location.hash){var t=document.querySelector(location.hash);if(t){t.classList.add('in');}}
  } else { nodes.forEach(function(n){n.classList.add('in');}); }
  var links=[].slice.call(document.querySelectorAll('nav.eras a')),eras=[].slice.call(document.querySelectorAll('.era'));
  function current(){var y=scrollY+140,on=null;eras.forEach(function(s){if(s.offsetTop<=y)on=s.id;});links.forEach(function(a){a.classList.toggle('on',a.getAttribute('href')==='#'+on);});}
  addEventListener('scroll',current,{passive:true});current();
})();
"""

SITE = "https://s2u.scotho.com"
FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link href="https://fonts.googleapis.com/css2?family=Exo+2:ital,wght@1,700;1,800&family=Oswald:wght@400;500;600;700'
         '&family=Share+Tech+Mono&display=swap" rel="stylesheet">')


def chrome_header(base):
    """The site's top bar, from apps/s2u/src/chrome.md, with STORY current. `base` is "" on the site and the
    absolute site origin in a copy that lives elsewhere. Since 2026-09-20 (evening) the web page is the site's
    default view, so the section links are /#..., and the console menu is /classic.html."""
    w = base + "/"
    lines = [
        '<a class="skip" href="#main">Skip to content</a>',
        '<div id="scan" aria-hidden="true"></div>',
        '<div id="progress" aria-hidden="true"><i></i></div>',
        '<header id="bar" class="bar">',
        '  <a class="brand" href="%s#top" aria-label="SOCOM Unzipped, top of page"><span class="ii">II</span><span class="word">UNZIPPED</span></a>' % w,
        '  <nav class="nav" aria-label="Sections">',
        '    <a href="%s#what">WHAT</a>' % w,
        '    <a href="%s#state">STATE</a>' % w,
        '    <a href="%s/story.html" class="on" aria-current="page">STORY</a>' % base,
        '    <a href="%s#server">SERVER</a>' % w,
        '    <a href="%s#setup">SETUP</a>' % w,
        '    <a href="%s#report">REPORT</a>' % w,
        '    <a href="%s#credits">CREDITS</a>' % w,
        '  </nav>',
        '  <div class="bar-right">',
        '    <a class="ghost" href="%s/classic.html" title="The original console-menu version of this site">CLASSIC</a>' % base,
        '  </div>',
        '</header>',
    ]
    return "\n".join(lines) + "\n"


def chrome_footer(base, fine, repo="https://github.com/Scotho/socom-unzipped"):
    w = base + "/"
    lines = [
        '<footer class="foot">',
        '  <div class="foot-inner">',
        '    <div>',
        '      <div class="foot-brand"><span class="ii">II</span> SOCOM UNZIPPED</div>',
        '      <p>Community PC port, licensed GPL-3.0. SOCOM II: U.S. Navy SEALs was developed by Zipper Interactive, Inc. '
        '&copy;2003 Sony Computer Entertainment America Inc. This project is not affiliated with or endorsed by Sony or Zipper.</p>',
        '    </div>',
        '    <nav aria-label="Footer">',
        '      <a href="%s/story.html">The story</a>' % base,
        '      <a href="%s/classic.html">Classic menu</a>' % base,
        '      <a href="%s" target="_blank" rel="noopener">GitHub</a>' % repo,
        '      <a href="%s#report">Report a bug</a>' % w,
        '    </nav>',
        '  </div>',
        '  <div class="foot-fine">%s</div>' % fine,
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


def render(doc, timeline, repo, img_base, logo, ui_css_inline=None, base=""):
    """`ui_css_inline` is the text of the site's ui.css for a copy that cannot link it (then `base` is the site's
    origin and every chrome link is absolute); on the site itself it is None and the stylesheet is linked."""
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
    out = ["<title>SOCOM Unzipped Story</title>",
           '<meta name="description" content="How SOCOM II is becoming a PC game: the timeline, every claim cited.">',
           '<meta name="theme-color" content="#08121a">',
           FONTS]
    if ui_css_inline is None:
        out.append('<link rel="stylesheet" href="/src/ui.css">')
    else:
        out.append("<style>%s</style>" % ui_css_inline)
    out.append("<style>%s</style>" % CSS)
    out.append(chrome_header(base))
    out.append('<main id="main"><div class="wrap">')
    out.append('<header class="story-hero">')
    out.append('<img class="logo" src="%s" alt="SOCOM II U.S. Navy SEALs" width="640" height="280" decoding="async">' % logo)
    out.append('<p class="brief-sub"><span class="blink"></span>Mission briefing &middot; the story so far</p>')
    out.append('<h1 class="brief-title">%s<small>Trying to turn a PlayStation 2 game into a PC game. %s days in.</small></h1>'
               % (inline(title), days))
    if doc["preface"]:
        out.append('<p class="lede">%s</p>' % inline(doc["preface"][0].strip("*")))
    out.append("</header>")
    out.append('<ul class="strip"><li><b>%d</b><span>entries</span></li><li><b>%d</b><span>commits cited</span></li>'
               '<li><b>%d</b><span>eras</span></li><li><b>%d</b><span>pictures</span></li><li><b>%s</b><span>first commit</span></li>'
               '<li><b>%s</b><span>latest</span></li></ul>' % (len(entries), n_commits, len(doc["eras"]), n_pics, pretty_date(first), pretty_date(last)))
    out.append('<section class="preface">')
    for p in doc["preface"][1:]:
        out.append("<p>%s</p>" % inline(p))
    out.append("</section>")
    if fore:
        out.append('<section class="foreword" id="from-the-creator"><p class="brief-sub">%s</p>' % inline(fore["title"]))
        for b in fore["blocks"]:
            if b.strip() in ("Scotho", "Craig") or b.startswith("\u2014") or b.startswith("--"):
                out.append('<p class="sig">%s</p>' % inline(b))
            else:
                out.append("<p>%s</p>" % inline(b))
        out.append("</section>")
    out.append('<nav class="eras" aria-label="Eras">')
    for era in doc["eras"]:
        out.append('<a href="#era-%s">%s<small>%s &ndash; %s &middot; %d</small></a>'
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
            html_e = render_entry(e, repo, img_base, idx).replace('<article class="card">', '<article class="entry">', 1)
            if has_pic:
                html_e = html_e.replace('class="node"', 'class="node pic"', 1)
            out.append(html_e)
            idx += 1
    out.append("</ol>")
    # The closing sections of STORY.md (the night's summary, how the document is checked) stay in the repository
    # copy only: the site page ends on the timeline (owner, 2026-09-26).
    del closing
    out.append("</div></main>")
    fine = ("generated %s from docs/STORY.md at %s &middot; %d entries, %d commit citations &middot; checked by tools_py/story/cite.py "
            "&middot; link to a moment: #&lt;date&gt;-&lt;slug&gt;" % (generated, head_sha, len(entries), n_commits))
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
                    help="the site copy: a complete HTML document that links /src/ui.css for Vite to bundle")
    ap.add_argument("--ui-css", default=os.path.join(os.path.dirname(ROOT), "scotho", "apps", "s2u", "src", "ui.css"),
                    help="the site's shared stylesheet, inlined into a copy that cannot link it (the default docs copy)")
    args = ap.parse_args(argv)
    # Git Bash rewrites an argument that looks like an absolute POSIX path ("/story/img") into a Windows path
    # ("C:/Program Files/Git/story/img") before Python ever sees it. That shipped once: every picture and the logo
    # on s2u.scotho.com/story.html pointed at a path on the build machine. A URL path never carries a drive letter,
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
        head_end = page.index('<a class="skip"')
        page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">\n' + page[:head_end] +
                '</head>\n<body>\n' + page[head_end:] + '</body>\n</html>\n')
    else:
        # the repository's own copy: the site's stylesheet inlined, the chrome's links absolute, the logo from the site
        ui_css = ""
        if os.path.isfile(args.ui_css):
            with open(args.ui_css, encoding="utf-8") as f:
                ui_css = f.read()
        else:
            sys.stderr.write("warning: %s not found; the copy will carry the timeline styles only\n" % args.ui_css)
        # the logo: the copy's own file beside the page when there is one (docs/story/img/logo.webp travels with the
        # repository and the artifact preview), else the site's, absolute
        logo = args.logo
        if not logo.startswith("http"):
            beside = os.path.join(os.path.dirname(os.path.abspath(args.out)), logo.lstrip("/"))
            if os.path.isfile(beside):
                logo = stamped(logo, args.out)
            else:
                site_logo = os.path.join(os.path.dirname(args.ui_css), "..", "public", "img", "logo.webp")
                logo = SITE + "/img/logo.webp"
                if os.path.isfile(site_logo):
                    logo = SITE + stamped("/img/logo.webp", os.path.join(os.path.dirname(site_logo), "..", "..", "x"))
        page = render(doc, timeline, args.repo, args.img.rstrip("/"), logo, ui_css_inline=ui_css, base=SITE)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    print("%s: %d bytes, %d eras, %d entries" % (args.out, len(page.encode("utf-8")), len(doc["eras"]),
                                                  sum(len(e["entries"]) for e in doc["eras"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
