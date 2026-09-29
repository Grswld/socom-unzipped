# TopNav

The site header: wordmark left, section links, CLASSIC switch right. Maps to the live site's `.nav`, `.nav a`, `.nav .current` and `#classic-link`.

Use it once per page on the modern site. It is the place the 2.98:1 failure lived: the current link is now `gold` on `tab-lit` (5.39:1), the same state as a lit Tab, not a brighter teal.

The consumer provides the link list with `aria-current="page"` on the current one, and the CLASSIC href.

- 48px tall on `ground` with a 1px `panel-edge` rule underneath. Links set `nav` in `text`, 6px × 10px padding; current and hover are `tab-lit` + `gold`.
- The CLASSIC switch is a Tab at `nav` size: `tab` fill, `panel-inset` edge.
- Under 720px the links collapse to a horizontal scroll strip; the wordmark and CLASSIC stay.
- Don't underline links; don't add a bottom border to the current link; don't put icons in it.
