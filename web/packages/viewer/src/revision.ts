/**
 * The build's own name: the git revision it came from and when it was built, written in by Vite's
 * `define` (see `../vite.config.ts`), the way the s2u site stamps its footer. Shown in the panel's About
 * so a bug report can say which viewer it was.
 */
declare const __VIEWER_REV__: string | undefined;
declare const __BUILD_STAMP__: string | undefined;

/**
 * `rev a1b2c3d · built 2026-09-27 15:10 UTC`. The stamp is `YYYY-MM-DD HH:MM:SS` in UTC and is shown to
 * the minute; a missing or malformed value reads as unknown rather than as an empty gap.
 */
export function revisionLabel(rev: string, stamp: string): string {
  const name = rev.trim() || 'unknown';
  const minute = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(stamp.trim())?.[0];
  return `rev ${name} · ${minute ? `built ${minute} UTC` : 'build time unknown'}`;
}

/**
 * The label for this build. The `typeof` guards are what keep it safe where nothing was defined --
 * vitest does not run Vite's `define`, and a bare reference to an undefined global would throw.
 */
export function viewerRevision(): string {
  const rev = typeof __VIEWER_REV__ === 'string' ? __VIEWER_REV__ : '';
  const stamp = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : '';
  return revisionLabel(rev, stamp);
}
