// THE NOTIFY LIST (an email for when a build is ready): the form's checks, its payload for POST /api/testers (apps/s2u/api/testers.mjs), and the
// one line the page shows back. Pure; the DOM and the fetch live in home.ts.

export const TESTERS_URL = '/api/testers';

export interface SignupValues { readonly email: string; readonly note: string; }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** '' when the form can be sent; otherwise what to fix. Same rules as the inbox (api/testers.mjs). */
export function checkSignup(v: SignupValues): string {
  const email = v.email.trim();
  if (!email) return 'EMAIL: WE NEED ONE TO REACH YOU.';
  if (email.length > 254 || !EMAIL_RE.test(email)) return 'EMAIL: THAT DOES NOT LOOK LIKE AN ADDRESS.';
  if (v.note.trim().length > 1000) return 'NOTE: AT MOST 1000 CHARACTERS.';
  return '';
}

export function buildSignup(v: SignupValues, version: string): Record<string, unknown> {
  return {
    email: v.email.trim(),
    note: v.note.trim(),
    source: 'site',
    version,
    website: '', // the honeypot: a real form leaves it empty
  };
}

export type SignupState = 'new' | 'bad';

/** One line for the screen, and which outcome it is. A repeat signup is answered like a new one (the inbox never says
 * whether an address is already on the list), so there is no "already" answer to show. */
export function replySignup(status: number, body: unknown): { state: SignupState; text: string } {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (status === 201 && b.ok === true) return { state: 'new', text: "YOU'RE ON THE LIST. ONE EMAIL WHEN A BUILD IS READY TO TRY." };
  if (status === 429) return { state: 'bad', text: 'NOT SENT. TOO MANY TRIES FROM HERE; TRY AGAIN IN AN HOUR.' };
  if (status === 400 && typeof b.error === 'string') return { state: 'bad', text: `NOT SENT. ${b.error.slice(0, 80).toUpperCase()}` };
  if (status === 503) return { state: 'bad', text: 'NOT SENT. THE LIST IS FULL; TRY AGAIN LATER.' };
  return { state: 'bad', text: 'NOT SENT. THE SIGNUP SERVICE DID NOT ANSWER; YOUR ADDRESS IS STILL HERE.' };
}
