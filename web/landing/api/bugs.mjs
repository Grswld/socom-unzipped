// Bug reports for socomunzipped.com and the SOCOM Unzipped launcher: validation, ids, rate limiting. Pure.
// A report is untrusted text from the internet that a person (and an AI agent) will read later: every
// field is typed, cut to length and stripped of control characters here, before it touches the disk.
import { randomBytes } from 'node:crypto';

export const LIMITS = Object.freeze({
  titleMin: 4, title: 120,
  descriptionMin: 10, description: 4000,
  contact: 120, short: 64,
  contextPairs: 16, contextKey: 32, contextValue: 256,
  log: 65536,
  body: 98304, // the whole POST, enforced by server.mjs's readBody (bodyLimit); nginx allows 128k in front
});

const SOURCES = new Set(['site', 'launcher']);

/** Drop C0/C1 controls (incl. ESC and NUL); keep newline and tab only where `multiline`. */
function clean(s, multiline) {
  const out = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    : s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return out.trim();
}

const str = (v) => (typeof v === 'string' ? v : '');

export function validateReport(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body: a JSON object is required' };
  if (str(raw.website) !== '' || (raw.website !== undefined && typeof raw.website !== 'string')) return { ok: false, error: 'rejected', silent: true };

  if (typeof raw.title !== 'string') return { ok: false, error: `title: ${LIMITS.titleMin} to ${LIMITS.title} characters` };
  const title = clean(raw.title, false);
  if (title.length < LIMITS.titleMin || title.length > LIMITS.title) return { ok: false, error: `title: ${LIMITS.titleMin} to ${LIMITS.title} characters` };

  if (typeof raw.description !== 'string') return { ok: false, error: `description: ${LIMITS.descriptionMin} to ${LIMITS.description} characters` };
  const description = clean(raw.description, true);
  if (description.length < LIMITS.descriptionMin || description.length > LIMITS.description) return { ok: false, error: `description: ${LIMITS.descriptionMin} to ${LIMITS.description} characters` };

  const logRaw = str(raw.log);
  if (logRaw.length > LIMITS.log) return { ok: false, error: `log: at most ${LIMITS.log} characters` };

  const context = {};
  if (typeof raw.context === 'object' && raw.context !== null && !Array.isArray(raw.context)) {
    for (const key of Object.keys(raw.context)) {
      if (Object.keys(context).length >= LIMITS.contextPairs) break;
      const value = raw.context[key];
      const k = clean(key, false);
      if (typeof value !== 'string' || k.length === 0 || k.length > LIMITS.contextKey || k === '__proto__') continue;
      context[k] = clean(value, false).slice(0, LIMITS.contextValue);
    }
  }

  return {
    ok: true,
    report: {
      title,
      description,
      contact: clean(str(raw.contact), false).slice(0, LIMITS.contact),
      source: SOURCES.has(raw.source) ? raw.source : 'unknown',
      version: clean(str(raw.version), false).slice(0, LIMITS.short),
      platform: clean(str(raw.platform), false).slice(0, LIMITS.short),
      context,
      log: clean(logRaw, true),
      test: raw.test === true, // end-to-end proofs mark themselves; stored apart from real reports
    },
  };
}

export function makeId(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `BR-${d}-${randomBytes(3).toString('hex')}`;
}

/** Sliding window per key. `take` prunes idle keys as it goes, so memory is bounded by recent callers. */
export class RateLimiter {
  #hits = new Map();
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; }
  get size() { return this.#hits.size; }
  take(key, now = Date.now()) {
    for (const [k, times] of this.#hits) {
      const live = times.filter((t) => now - t < this.windowMs);
      if (live.length === 0) this.#hits.delete(k); else this.#hits.set(k, live);
    }
    const times = this.#hits.get(key) ?? [];
    if (times.length >= this.max) return { ok: false, retryAfterSeconds: Math.ceil((times[0] + this.windowMs - now) / 1000) };
    times.push(now);
    this.#hits.set(key, times);
    return { ok: true };
  }
}
