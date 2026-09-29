import { describe, expect, it } from 'vitest';
import { validateSignup, normaliseEmail, signupFileName, makeSignupId, fileSignup, SIGNUP_LIMITS } from './testers.mjs';

describe('validateSignup', () => {
  it('accepts an address and an optional note', () => {
    const v = validateSignup({ email: '  Tester@Example.com ', note: 'have a pad and a disc\r\n', source: 'site', version: 'S2U v1' });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.signup.email).toBe('tester@example.com');
      expect(v.signup.note).toBe('have a pad and a disc');
      expect(v.signup.source).toBe('site');
      expect(v.signup.test).toBe(false);
    }
  });
  it('rejects what is not an address', () => {
    for (const bad of ['', 'nope', 'a@b', 'a b@example.com', 'a@b.c', 'x'.repeat(250) + '@example.com', 42, null]) {
      const v = validateSignup({ email: bad });
      expect(v.ok, String(bad)).toBe(false);
    }
  });
  it('rejects a body that is not an object', () => {
    expect(validateSignup('a@example.com').ok).toBe(false);
    expect(validateSignup(['a@example.com']).ok).toBe(false);
  });
  it('drops the honeypot silently', () => {
    const v = validateSignup({ email: 'a@example.com', website: 'http://spam' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.silent).toBe(true);
  });
  it('caps the note and strips controls', () => {
    const v = validateSignup({ email: 'a@example.com', note: 'x'.repeat(SIGNUP_LIMITS.note + 1) });
    expect(v.ok).toBe(false);
    const w = validateSignup({ email: 'a@example.com', note: 'hi\u0007 there\u001b[31m' });
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.signup.note).toBe('hi there[31m');
  });
});

describe('the file name', () => {
  it('is the same for two spellings of one mailbox', () => {
    expect(signupFileName('Tester@Example.com ')).toBe(signupFileName('tester@example.com'));
    expect(signupFileName('a@example.com')).not.toBe(signupFileName('b@example.com'));
    expect(signupFileName('a@example.com')).toMatch(/^[0-9a-f]{32}\.json$/);
  });
  it('normalises case and whitespace', () => {
    expect(normaliseEmail('  A@EXAMPLE.COM ')).toBe('a@example.com');
  });
});

describe('ids', () => {
  it('look like PT-YYYYMMDD-hex', () => {
    expect(makeSignupId(new Date('2026-09-20T12:00:00Z'))).toMatch(/^PT-20260920-[0-9a-f]{6}$/);
  });
});

// Launch review PL-13: the answer must not say whether an address is already on the list (a membership oracle).
// A repeat is logged on the server and answered exactly like a new signup; nothing is stored twice.
describe('fileSignup', () => {
  const eexist = () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); };
  it('answers a repeat exactly like a new signup', () => {
    const id = 'PT-20260929-abcdef';
    const writes: string[] = [];
    const stored = fileSignup((file: string) => { writes.push(file); }, 'f.json', '{}', id);
    const repeat = fileSignup(eexist, 'f.json', '{}', id);
    expect(stored.stored).toBe(true);
    expect(repeat.stored).toBe(false);
    expect(writes).toEqual(['f.json']);
    expect(repeat.reply).toEqual(stored.reply);
    expect(stored.reply).toEqual({ status: 201, body: { ok: true, id } });
    expect('already' in repeat.reply.body).toBe(false);
  });
  it('the id in either answer looks like a signup id', () => {
    const r = fileSignup(eexist, 'f.json', '{}', makeSignupId());
    expect(r.reply.body.id).toMatch(/^PT-\d{8}-[0-9a-f]{6}$/);
  });
  it('any other write failure is not a signup', () => {
    const eacces = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    expect(() => fileSignup(eacces, 'f.json', '{}', 'PT-20260929-abcdef')).toThrow(/denied/);
  });
});
