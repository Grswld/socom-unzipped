"""`tools_py.story.site` renders the story on the s2u design system (the scotho site's `src/ds/`), in both copies.

The chrome it emits is the markup contract in ../scotho/apps/s2u/src/chrome.md; the timeline's own styles speak
only `--s2u-*` tokens; the repository copy inlines the system's four layer files and the site copy links them once.
"""
import os
import re
import tempfile
import unittest

from tools_py.story import site

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DS = os.path.join(ROOT, "..", "scotho", "apps", "s2u", "src", "ds")

_DOC = """# SOCOM Unzipped: a story

*A first line, the lede.*

A second paragraph of the preface.

## From the creator

Why this exists.

Scotho

## 2026-09-02 .. 2026-09-03 - The first era

*Standing.*

### 2026-09-02 - The first thing

**The hook of the first thing.**

A body with `code`.

*How:* by doing it.

*But:* not all of it.

`Cited:` `abc1234` a subject fragment · docs/README.md · run some_run
"""

_TIMELINE = {"generated": "2026-09-27T00:00:00Z", "head": "deadbee",
             "entries": [{"id": "2026-09-02-the-first-thing", "citations": [{"kind": "commit"}], "picture": None}]}


def _text(x):
    return x if isinstance(x, str) else "".join(x)


class ChromeUsesTheSystem(unittest.TestCase):
    def test_header_and_footer_classes(self):
        head = _text(site.chrome_header(""))
        foot = _text(site.chrome_footer("", "fine"))
        for cls in ["s2u-skip", "s2u-scan", "s2u-progress", "s2u-bar", "s2u-bar__brand", "s2u-bar__nav", "s2u-bar__end",
                    "s2u-tab s2u-tab--nav"]:
            self.assertIn('class="%s"' % cls, head, cls)
        for cls in ["s2u-foot", "s2u-foot__inner", "s2u-foot__brand", "s2u-fine"]:
            self.assertIn('class="%s' % cls, foot, cls)
        self.assertNotIn('class="bar"', head)
        self.assertNotIn('class="foot"', foot)

    def test_the_story_link_is_current_and_the_end_holds_only_classic(self):
        head = _text(site.chrome_header("https://socomunzipped.com"))
        self.assertIn('<a href="https://socomunzipped.com/story.html" class="is-on" aria-current="page">Story</a>', head)
        self.assertIn('href="https://socomunzipped.com/#what"', head)
        self.assertNotIn("s2u-lamp", head)
        self.assertNotIn("s2u-iconbtn", head)
        self.assertIn('<p class="s2u-fine" id="foot-fine">fine</p>', _text(site.chrome_footer("", "fine")))

    def test_timeline_css_speaks_tokens(self):
        self.assertNotRegex(site.CSS, r"var\(--(gold|head|disp|mono|lit|dim|dim2|line|line2|teal|glow|bg|panel|panel2|gold2|ease)\)")
        self.assertNotRegex(site.CSS, r"#[0-9a-fA-F]{3,8}\b|rgba?\(")

    def test_the_display_face_is_always_condensed(self):
        # Saira Condensed is self-hosted at font-stretch 62.5% only: a rule that names the display face without
        # the stretch falls to the fallback face
        for m in re.finditer(r"[^{}]+\{[^{}]*var\(--s2u-font-display\)[^{}]*\}", site.CSS):
            self.assertIn("font-stretch:62.5%", m.group(0).replace(" ", ""), m.group(0))

    def test_the_reveal_on_scroll_is_gone(self):
        self.assertNotIn("translateY", site.CSS)
        self.assertNotIn("IntersectionObserver", site.JS)
        self.assertNotIn("classList.add('in')", site.JS)
        self.assertIn(":target", site.CSS)

    @unittest.skipUnless(os.path.isdir(DS), "scotho not beside this tree")
    def test_inline_copy_carries_the_layers_not_imports(self):
        css = site.design_system_css(DS, absolute="https://socomunzipped.com")
        self.assertTrue(css.startswith("@layer s2u.tokens, s2u.base, s2u.components;"))
        self.assertNotIn("@import", css)
        self.assertIn("url('https://socomunzipped.com/fonts/", css)
        self.assertNotIn("url('/fonts/", css)


class RenderedPage(unittest.TestCase):
    def setUp(self):
        self.doc = site.parse_document(_DOC)

    def test_site_copy_links_the_system_once_and_nothing_from_google(self):
        page = site.render(self.doc, _TIMELINE, "https://x/repo", "/story/img", "/img/logo.webp")
        self.assertEqual(page.count('<link rel="stylesheet"'), 1)
        self.assertIn('<link rel="stylesheet" href="/src/ds/index.css">', page)
        self.assertNotIn("googleapis", page)
        self.assertNotIn("gstatic", page)
        self.assertIn('<meta name="theme-color" content="#000e11">', page)
        self.assertIn('<div class="s2u-scan" aria-hidden="true"></div>', page)

    def test_repository_copy_inlines_the_systems_four_files_in_order(self):
        with tempfile.TemporaryDirectory() as ds:
            for name in site.DS_FILES:
                with open(os.path.join(ds, name), "w", encoding="utf-8") as f:
                    f.write("/* %s */ .x{background:url('/fonts/a.woff2')}\n" % name)
            with open(os.path.join(ds, "index.css"), "w", encoding="utf-8") as f:
                f.write("@import './tokens.css';\n")
            page = site.render(self.doc, _TIMELINE, "https://x/repo", "img", "img/logo.webp",
                               ds_dir=ds, absolute=site.SITE, base=site.SITE)
        self.assertNotIn('<link rel="stylesheet"', page)
        self.assertNotIn("@import", page)
        self.assertLess(page.index("/* tokens.css */"), page.index("/* fonts.css */"))
        self.assertLess(page.index("/* fonts.css */"), page.index("/* base.css */"))
        self.assertLess(page.index("/* base.css */"), page.index("/* components.css */"))
        self.assertLess(page.index("/* components.css */"), page.index(".wrap{"))
        self.assertIn("url('%s/fonts/a.woff2')" % site.SITE, page)
        self.assertIn('href="%s/#what"' % site.SITE, page)

    def test_the_story_wears_system_classes_and_keeps_its_ids(self):
        page = site.render(self.doc, _TIMELINE, "https://x/repo", "/story/img", "/img/logo.webp")
        self.assertIn('class="s2u-title s2u-title--story"', page)
        self.assertIn('class="s2u-kicker"', page)
        self.assertIn('<article class="s2u-panel__body entry">', page)
        self.assertIn('<span class="s2u-label">How</span>', page)
        self.assertIn('<span class="s2u-label">Cited</span>', page)
        for old in ('class="card"', 'class="lbl"', 'class="brief-sub"', 'class="brief-title"', 'class="on"'):
            self.assertNotIn(old, page, old)
        for anchor in ('id="2026-09-02-the-first-thing"', 'id="from-the-creator"', 'id="era-2026-09-02"'):
            self.assertIn(anchor, page, anchor)


if __name__ == "__main__":
    unittest.main()
