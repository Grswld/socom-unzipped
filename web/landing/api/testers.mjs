// Play-tester signups for socomunzipped.com: validation and ids. Pure, like bugs.mjs.
// A signup is an email address and an optional note from the internet, kept on disk so the owner can mail
// testers when a build is ready. Same rules as reports: typed, cut to length, control characters gone.
import { randomBytes, createHash } from 'node:crypto';

export const SIGNUP_LIMITS = Object.freeze({
  email: 254,
  note: 1000,
  short: 64,
  body: 8192, // the whole POST
});

// Practical, not RFC 5322: one @, something either side, a dot in the domain, no spaces or controls.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(s, multiline) {
  const out = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    : s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return out.trim();
}
const str = (v) => (typeof v === 'string' ? v : '');

/** The address as it is compared and filed: trimmed, lower-cased. Two spellings of one mailbox are one signup. */
export function normaliseEmail(email) {
  return clean(str(email), false).toLowerCase();
}

export function validateSignup(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'body: a JSON object is required' };
  if (str(raw.website) !== '' || (raw.website !== undefined && typeof raw.website !== 'string')) return { ok: false, error: 'rejected', silent: true };
  const email = normaliseEmail(raw.email);
  if (!email || email.length > SIGNUP_LIMITS.email || !EMAIL_RE.test(email)) return { ok: false, error: 'email: that does not look like an address' };
  const note = clean(str(raw.note), true);
  if (note.length > SIGNUP_LIMITS.note) return { ok: false, error: `note: at most ${SIGNUP_LIMITS.note} characters` };
  return {
    ok: true,
    signup: {
      email,
      note,
      source: raw.source === 'site' ? 'site' : 'unknown',
      version: clean(str(raw.version), false).slice(0, SIGNUP_LIMITS.short),
      test: raw.test === true,
    },
  };
}

export function makeSignupId(now = new Date()) {
  const d = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `PT-${d}-${randomBytes(3).toString('hex')}`;
}

/** The file a signup lives in is named by the address's hash, so a second signup from the same mailbox finds the
 * first one there and is answered "already on the list" instead of being stored twice. */
export function signupFileName(email) {
  return `${createHash('sha256').update(normaliseEmail(email)).digest('hex').slice(0, 32)}.json`;
}
