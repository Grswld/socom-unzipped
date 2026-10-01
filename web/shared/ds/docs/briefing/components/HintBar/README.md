# HintBar

The face-button legend at the foot of a briefing screen: glyph plus word, right-aligned. Maps to the live site's `.hints` and the about screen's BACK / SELECT row.

Use it at the bottom of any briefing layout to name the available actions. On the web the words are the buttons; the glyphs are decoration that keep the game's grammar.

The consumer provides one to four actions, each a glyph name (`square`, `triangle`, `cross`, `circle`) and an uppercase word, and the handler for each.

- Words in `text-strong` set in `hint`; glyphs 14px inline SVG, stroke 2px, in `glyph-square`, `glyph-triangle`, `glyph-cross`; gap `space-2` inside an item, 28px between items.
- The glyph is never the only signal: keep the word, and keep the order the game uses (square, triangle, cross, left to right).
- Don't use it as a general button row; don't colour the words.
