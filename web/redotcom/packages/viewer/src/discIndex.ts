import { listMaps, type AssetSource, type MapInfo } from '@s2u/archive';

/**
 * A dropped disc's map list and what would not read in it (PL-11, wave-1 B13's carry-over). `listMaps` offers an
 * archive that will not name itself under its id and hands the reason to `onProblem`; the worker collects those here
 * and sends them with the list, so the page can say which archive failed and why instead of offering it silently.
 * No game behaviour: the page's robustness rule (each failure named, the rest still drawn).
 */

/** One archive `listMaps` could not name: its disc path and the reader's own words. */
export interface IndexProblem { path: string; message: string }

/** Lists a source's maps (`listMaps`), keeping every archive's reason for not naming itself. */
export async function listDiscMaps(source: AssetSource): Promise<{ maps: MapInfo[]; problems: IndexProblem[] }> {
  const problems: IndexProblem[] = [];
  const maps = await listMaps(source, (path, message) => problems.push({ path, message }));
  return { maps, problems };
}

/** `RUN/MP7.ZDB` -> `MP7.ZDB`; the reason without the path when the reader already led with it. */
function problemText({ path, message }: IndexProblem): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const reason = message.startsWith(`${path}: `) ? message.slice(path.length + 2) : message;
  return `${file} unreadable: ${reason}`;
}

/**
 * What the page does with a map list. `open` is false when not one archive named itself (every map would fail to
 * load the same way): the disc page stays up and says why. `note` is the disc page's status line --
 * `listed N of M maps; MP7.ZDB unreadable: ...` -- or null when every archive read; `diagnostics` are the same
 * reasons one a line, for the diagnostics list beside each map's own.
 */
export function indexVerdict(maps: MapInfo[], problems: IndexProblem[]): { open: boolean; note: string | null; diagnostics: string[] } {
  const diagnostics = problems.map(problemText);
  if (problems.length === 0) return { open: maps.length > 0, note: null, diagnostics };
  const named = maps.length - new Set(problems.map((p) => p.path)).size;
  return { open: named > 0, note: `listed ${named} of ${maps.length} maps; ${diagnostics.join('; ')}`, diagnostics };
}
