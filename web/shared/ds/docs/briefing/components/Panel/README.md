# Panel

The content panel of a briefing screen: a heading strip in `gold` above a `panel` body in `text`. Maps to the live site's `.panel`, `.panel-head`, `.card` and the about screen's briefing text box.

Use it for the main content beside a Tab column, for story cards, and for any block of prose on the site. One heading strip per panel; a panel may omit the strip when it holds an image.

The consumer provides the heading (uppercase, set in `panel-heading`), the body content (prose in `body`, or an image with no padding), and optionally a `TypedText` body.

- Fill `panel`, edge `panel-inset`, corners `radius-0`, padding `space-4`; the strip pads `space-3` × `space-4` and sits `space-2` above the body, as two separate boxes like the game.
- Body copy is `text`; never `gold` for more than a heading. Measure 60–70 characters.
- Don't nest panels; don't add drop shadows; don't round corners.
