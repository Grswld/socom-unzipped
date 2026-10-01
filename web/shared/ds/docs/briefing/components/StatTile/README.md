# StatTile

A figure with a caption on a panel, shown in a row. Maps to the live story page's `.stats .stat` and the index page's server-status tiles.

Use it for a handful of facts that summarise a page (entries, commits cited, players online). Four to six in a row; under 720px, two per row.

The consumer provides the figure (a number or a short date) and the caption (uppercase, one or two words).

- Fill `panel`, edge `panel-inset`, corners `radius-0`, padding `space-4` top and sides, `space-3` bottom. Figure in `gold` set in `stat-number`; caption in `text-dim` set in `stat-caption`.
- Figures are left-aligned like the game's tables, not centred.
- Don't animate the numbers; don't add icons; don't use it for a single hero figure.
