// Pure helpers for the landing page: the story's timeline.json shaped for the "latest" strip, and small formatting.
// No DOM, no fetch; tested in home_data.test.ts.

export interface TimelineEntry {
  readonly id: string;
  readonly date: string;
  readonly title: string;
  readonly hook: string;
  readonly picture?: { readonly path: string; readonly caption: string };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

function toEntry(raw: unknown): TimelineEntry | null {
  const r = rec(raw);
  if (!r) return null;
  const id = str(r.id, 120);
  const date = str(r.date, 10);
  const title = str(r.title, 160);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !id || !title) return null;
  const pic = rec(r.picture);
  const picture = pic && str(pic.path, 300) ? { path: str(pic.path, 300), caption: str(pic.caption, 400) } : undefined;
  return picture ? { id, date, title, hook: str(r.hook, 400), picture } : { id, date, title, hook: str(r.hook, 400) };
}

/** What the strip shows for an entry's picture: the file itself, or, for a video, the poster frame the story keeps
 * beside it (`<name>.png`), with a flag so the tile can say there is something to play. */
export function tileImage(path: string): { src: string; video: boolean } {
  const name = path.split('/').pop() ?? '';
  const video = name.endsWith('.mp4');
  return { src: `/story/img/${video ? name.slice(0, -4) + '.png' : name}`, video };
}

/** The last `n` entries of the timeline, newest first, preferring ones with a picture when the tail has more than
 * `n` on its last day, so the strip has something to show. Anything malformed is dropped, never thrown. */
export function latestEntries(raw: unknown, n: number): TimelineEntry[] {
  const r = rec(raw);
  const list = r && Array.isArray(r.entries) ? r.entries : [];
  const entries = list.map(toEntry).filter((e): e is TimelineEntry => e !== null);
  const tail = entries.slice(-Math.max(n * 2, n)).reverse();
  const withPic = tail.filter((e) => e.picture);
  const without = tail.filter((e) => !e.picture);
  return [...withPic, ...without].slice(0, n).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** "3d 4h", "4h 12m", "12m", "45s": the server's uptime for the hero lamp. */
export function uptimeText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}D ${h}H`;
  if (h > 0) return `${h}H ${m}M`;
  if (m > 0) return `${m}M`;
  return `${s}S`;
}
