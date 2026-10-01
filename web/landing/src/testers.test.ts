import { describe, expect, it } from 'vitest';
import { checkSignup, buildSignup, replySignup } from './testers';

describe('checkSignup', () => {
  it('needs an address that looks like one', () => {
    expect(checkSignup({ email: '', note: '' })).toMatch(/WE NEED ONE/);
    expect(checkSignup({ email: 'nope', note: '' })).toMatch(/DOES NOT LOOK/);
    expect(checkSignup({ email: ' tester@example.com ', note: '' })).toBe('');
  });
  it('caps the optional note', () => {
    expect(checkSignup({ email: 'a@example.com', note: 'x'.repeat(1001) })).toMatch(/1000/);
    expect(checkSignup({ email: 'a@example.com', note: 'x'.repeat(1000) })).toBe('');
  });
});

describe('buildSignup', () => {
  it('trims and carries the honeypot empty', () => {
    const p = buildSignup({ email: ' a@example.com ', note: ' pad, disc ' }, 'S2U v1');
    expect(p).toEqual({ email: 'a@example.com', note: 'pad, disc', source: 'site', version: 'S2U v1', website: '' });
  });
});

describe('replySignup', () => {
  it('tells the outcomes apart', () => {
    expect(replySignup(201, { ok: true, id: 'PT-20260920-abcdef' }).state).toBe('new');
    // the inbox no longer says whether an address was on the list (launch review PL-13); the old answer is not a success
    expect(replySignup(200, { ok: true, already: true }).state).toBe('bad');
    expect(replySignup(400, { ok: false, error: 'email: that does not look like an address' })).toEqual({ state: 'bad', text: 'NOT SENT. EMAIL: THAT DOES NOT LOOK LIKE AN ADDRESS' });
    expect(replySignup(429, {}).state).toBe('bad');
    expect(replySignup(503, {}).text).toMatch(/FULL/);
    expect(replySignup(0, null).text).toMatch(/DID NOT ANSWER/);
  });
});
