# The wiki page -- template (R318)

The wiki holds human prose: pages a stranger or a contributor reads once. **The test:** a page may live in the wiki
when deleting it would change nothing any agent, hook or check does. What fails that test stays in the tree
(`docs/DOC_MAINTENANCE.md` §8). A wiki page is class N in spirit: **no live state, no live numbers, no task lists**
-- it points at the tree's owning document for those, so it cannot be wrong about them.

The wiki is its own git repository (`<repo>.wiki.git`), created the first time the owner saves a page in the web UI.
Drafts are written in the owner's clone of it, from this template; **the owner pushes** -- a push to the wiki is a
publication (`CLAUDE.md` Boundaries). When a tree document moves to the wiki, the tree keeps a one-paragraph pointer
at the old path (things cite it; DOC_MAINTENANCE check 6), and its registry row becomes a pointer row.

Copy from the line below.

---

# {{Title: a noun phrase, two to five words}}

{{One paragraph: what this page explains and who it is for. A reader who stops here knows whether to go on.}}

*Last verified {{YYYY-MM-DD}} against `{{short SHA}}` on `main`. The tree owns every current fact this page names:
{{the owning documents, e.g. `docs/KNOWN.md` for what is proven, `docs/DEVELOPING.md` for how to build}}.*

## {{Section: one idea}}

{{Prose. A diagram or a picture where the mechanism is spatial. Code only as a short, cited excerpt with its path.}}

## {{Section}}

{{...}}

## See also

- {{`docs/<file>.md` in the tree -- what it owns}}
- {{another wiki page -- what it adds}}
