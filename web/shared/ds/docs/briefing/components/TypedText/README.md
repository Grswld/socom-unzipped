# TypedText

Prose revealed one character at a time, ending in the game's block caret. Maps to the about screen's typed panel text and the boot screen's cyan typewriter.

Use it for the body of a briefing Panel when a screen opens, and for the boot screen. Not for anything the reader needs immediately (navigation, errors, stats).

The consumer provides the full text, an optional speed (default 40 characters per second, the game's pace at 30fps), and the variant: `panel` (`text` in `body`) or `boot` (`cyan-boot` in `readout`, uppercase, letter-spaced, on `ground-deep`).

- The caret is a `.55em` × `1em` block in `caret` (or `cyan-boot`), blinking at 1Hz with a step function, never a fade.
- With `prefers-reduced-motion: reduce` the full text renders at once and the caret holds steady.
- Reserve the final height so the panel does not grow while typing.
- Don't type headings or labels; don't type more than one block at a time; the boot variant never appears on the modern site outside the boot screen.
