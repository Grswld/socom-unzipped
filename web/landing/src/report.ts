/** What a report's reference is for -- word for word with the launcher's copy (bug_report.h's kGithubIssueLine),
    per the owner's ruling O4 I1 (2026-09-26): the invitation excepts security reports. */
export const FOLLOW_UP = "Contributors can also open an issue at github.com/Scotho/socom-unzipped and quote this id -- unless it is a security report: those go through SECURITY.md, never a public issue.";

// REPORT A BUG: the form's state, its checks and the payload for POST /api/bugs (apps/s2u/api).
// Pure; the DOM and the fetch live in main.ts. The launcher's bug page mirrors these fields and words.

export const BUGS_URL = '/api/bugs';

export interface Field { readonly id: 'title' | 'description' | 'contact' | 'send'; readonly label: string; }
export const FIELDS: readonly Field[] = [
  { id: 'title', label: 'TITLE' },
  { id: 'description', label: 'WHAT HAPPENED' },
  { id: 'contact', label: 'CONTACT (OPTIONAL)' },
  { id: 'send', label: 'SEND REPORT' },
];

export interface FormState { readonly index: number; }
export const createForm = (index = 0): FormState => ({ index: Math.min(Math.max(index, 0), FIELDS.length - 1) });
export const moveField = (s: FormState, delta: number): FormState => createForm(s.index + delta);
export const currentField = (s: FormState): Field => FIELDS[s.index];

export interface FormValues { readonly title: string; readonly description: string; readonly contact: string; }

/** '' when the form can be sent; otherwise what to fix. Same limits as the inbox (api/bugs.mjs). */
export function checkForm(v: FormValues): string {
  const title = v.title.trim();
  const description = v.description.trim();
  if (title.length < 4 || title.length > 120) return 'TITLE: 4 TO 120 CHARACTERS.';
  if (description.length < 10) return 'WHAT HAPPENED: AT LEAST 10 CHARACTERS.';
  if (description.length > 4000) return 'WHAT HAPPENED: AT MOST 4000 CHARACTERS.';
  return '';
}

export interface Env { readonly version: string; readonly userAgent: string; readonly language: string; readonly screen: string; }

function platformOf(userAgent: string): string {
  if (/Windows/i.test(userAgent)) return 'Windows';
  if (/Android/i.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iOS/i.test(userAgent)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'macOS';
  if (/Linux|X11/i.test(userAgent)) return 'Linux';
  return 'unknown';
}

export function buildPayload(v: FormValues, env: Env): Record<string, unknown> {
  const context: Record<string, string> = {};
  if (env.language) context.language = env.language;
  if (env.screen) context.screen = env.screen;
  return {
    title: v.title.trim(),
    description: v.description.trim(),
    contact: v.contact.trim(),
    source: 'site',
    version: env.version,
    platform: platformOf(env.userAgent),
    context,
    website: '', // the honeypot: a real form leaves it empty
  };
}

/** One line for the screen. The id is shown only when it looks like one of ours. */
export function replyText(status: number, body: unknown): { ok: boolean; text: string } {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (status === 201 && b.ok === true) {
    const id = typeof b.id === 'string' && /^BR-\d{8}-[0-9a-f]{6}$/.test(b.id) ? b.id.toUpperCase() : '';
    // Sprint 11 Goal 7: a contributor can follow their own report by quoting the id on GitHub.
    return { ok: true, text: id ? `REPORT RECEIVED. REFERENCE ${id}. ${FOLLOW_UP}` : 'REPORT RECEIVED.' };
  }
  if (status === 429) return { ok: false, text: 'NOT SENT. TOO MANY REPORTS FROM HERE; TRY AGAIN IN AN HOUR.' };
  if (status === 400 && typeof b.error === 'string') return { ok: false, text: `NOT SENT. ${b.error.slice(0, 80).toUpperCase()}` };
  return { ok: false, text: 'NOT SENT. THE REPORT SERVICE DID NOT ANSWER; YOUR TEXT IS STILL HERE.' };
}
