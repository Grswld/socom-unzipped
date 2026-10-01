# ViewerPanel

The map viewer's settings panel, top bar, fps readout and fullscreen button, re-skinned in the system's colours without changing its structure. Maps to the viewer's `#settings`, `#hud`, `#fps`, `.mode-card`, `.badge` and `#fullscreen`.

Use it only in the viewer. It is the one place the system allows rounded corners (`radius-viewer`, `radius-pill`), a lifted shadow (`viewer-lift`) and the `mono` face, because the viewer is a tool over a 3D canvas rather than a game screen. Everything it paints still comes from the tokens: `ground` panel, `panel` header strip with a `gold` uppercase heading, `tab` controls, `tab-lit` + `gold` for the pressed mode card, `focus` ring on every control.

The consumer provides the map list, the readout string, the two mode cards with `aria-pressed`, the collapsible sections, and the key-hint line. The disclaimer text is fixed.

- The green selection and the grey `#1d2027` panel of the current viewer are gone: selection is `tab-lit`/`gold`, exactly like a Tab.
- `warn` is for the EXPERIMENTAL line and the dev-build badge only; it is text, so it stays ≥4.5:1 on `ground` and `panel`.
- The fps readout is `readout` in `glyph-cross` on `ground` (8.4:1); it never turns red or green, the number is the signal.
- No scanlines over the canvas or the panel. Don't apply `display` type anywhere in the viewer.
- On phones the panel is full-width with `space-4` gutters and the fullscreen button keeps its 44px hit target.
