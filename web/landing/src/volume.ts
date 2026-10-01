// The one volume the page has: a 0..1 level (default about 70%) and a mute, turned into what the movie and
// the effects are actually set to. Pure; main.ts owns the slider, the storage and the elements.

export const DEFAULT_VOLUME = 0.7;
/** The movie's music is mastered hotter than the HUDUI bank, so at full it sits a little under the effects. */
const VIDEO_TRIM = 0.85;

export function parseVolume(stored: string | null): number {
  if (stored === null || stored.trim() === '') return DEFAULT_VOLUME;
  const v = Number(stored);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_VOLUME;
}

export function levels(volume: number, muted: boolean): { video: number; sfx: number } {
  const v = muted ? 0 : Math.min(1, Math.max(0, volume));
  return { video: v * VIDEO_TRIM, sfx: v };
}
