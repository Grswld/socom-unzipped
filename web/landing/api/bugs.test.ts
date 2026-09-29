import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM module, no types
import { validateReport, makeId, RateLimiter, LIMITS } from './bugs.mjs';

const GOOD = {
  title: 'Crash when joining a game',
  description: 'Joined the Frostfire room from the lobby and the game closed.',
  contact: 'player#1234',
  source: 'site',
  version: 'S2U v0.5.0',
  platform: 'Windows 11',
  context: { server: '198.51.100.10', exitCode: '65' },
  website: '',
};

describe('validateReport', () => {
  it('accepts a good report and keeps only known fields', () => {
    const r = validateReport({ ...GOOD, evil: '<script>', __proto__: { x: 1 } });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.report).sort()).toEqual(['contact', 'context', 'description', 'log', 'platform', 'source', 'test', 'title', 'version']);
    expect(r.report.title).toBe(GOOD.title);
    expect(r.report.log).toBe('');
    expect(r.report.test).toBe(false);
    expect(validateReport({ ...GOOD, test: true }).report.test).toBe(true);
    expect(validateReport({ ...GOOD, test: 'yes' }).report.test).toBe(false);
  });

  it('requires a title and a description of a useful length', () => {
    expect(validateReport({ ...GOOD, title: 'abc' })).toEqual({ ok: false, error: 'title: 4 to 120 characters' });
    expect(validateReport({ ...GOOD, title: 'x'.repeat(121) }).ok).toBe(false);
    expect(validateReport({ ...GOOD, description: 'too short' })).toEqual({ ok: false, error: 'description: 10 to 4000 characters' });
    expect(validateReport({ ...GOOD, description: 'x'.repeat(4001) }).ok).toBe(false);
    expect(validateReport({ ...GOOD, title: 42 }).ok).toBe(false);
  });

  it('rejects anything that is not a plain object', () => {
    for (const junk of [null, undefined, 'x', 7, [], [GOOD]]) expect(validateReport(junk).ok).toBe(false);
  });

  it('treats a filled honeypot as a bot, silently', () => {
    expect(validateReport({ ...GOOD, website: 'http://spam' })).toEqual({ ok: false, error: 'rejected', silent: true });
  });

  it('only knows two sources; anything else is "unknown"', () => {
    expect(validateReport({ ...GOOD, source: 'launcher' }).report.source).toBe('launcher');
    expect(validateReport({ ...GOOD, source: 'root' }).report.source).toBe('unknown');
  });

  it('cuts optional fields to length instead of refusing the report', () => {
    const r = validateReport({ ...GOOD, contact: 'c'.repeat(500), version: 'v'.repeat(500), platform: 'p'.repeat(500) });
    expect(r.report.contact.length).toBe(LIMITS.contact);
    expect(r.report.version.length).toBe(LIMITS.short);
    expect(r.report.platform.length).toBe(LIMITS.short);
  });

  it('keeps context as at most 16 short string pairs and drops the rest', () => {
    const ctx: Record<string, unknown> = { nested: { a: 1 }, n: 5, ok: 'yes', ['k'.repeat(40)]: 'long key', big: 'v'.repeat(999) };
    for (let i = 0; i < 40; i++) ctx[`k${i}`] = 'v';
    const r = validateReport({ ...GOOD, context: ctx });
    const keys = Object.keys(r.report.context);
    expect(keys.length).toBeLessThanOrEqual(16);
    expect(r.report.context.ok).toBe('yes');
    expect(r.report.context.nested).toBeUndefined();
    expect(r.report.context.n).toBeUndefined();
    expect(r.report.context.big.length).toBe(256);
    expect(validateReport({ ...GOOD, context: 'nope' }).report.context).toEqual({});
  });

  it('strips control characters, so a report cannot forge lines in a terminal or a log', () => {
    const r = validateReport({ ...GOOD, title: 'bad\u001b[31m title\u0000\r\nsecond', description: 'line one\nline two\u0007 with a bell' });
    expect(r.report.title).toBe('bad[31m title second');
    expect(r.report.description).toBe('line one\nline two with a bell');
  });

  it('takes a log up to 64 KB and refuses a bigger one', () => {
    expect(validateReport({ ...GOOD, log: 'x'.repeat(65536) }).ok).toBe(true);
    expect(validateReport({ ...GOOD, log: 'x'.repeat(65537) })).toEqual({ ok: false, error: 'log: at most 65536 characters' });
  });
});

describe('makeId', () => {
  it('is BR-YYYYMMDD-xxxxxx and safe as a file name', () => {
    const id = makeId(new Date('2026-09-19T20:00:00Z'));
    expect(id).toMatch(/^BR-20260919-[0-9a-f]{6}$/);
    expect(makeId(new Date('2026-09-19T20:00:00Z'))).not.toBe(id);
  });
});

describe('RateLimiter', () => {
  it('allows five an hour per key, then says when to come back', () => {
    const rl = new RateLimiter(5, 3600_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(rl.take('203.0.113.4', t0 + i).ok).toBe(true);
    const denied = rl.take('203.0.113.4', t0 + 10);
    expect(denied.ok).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(3590);
    expect(rl.take('203.0.113.8', t0 + 10).ok).toBe(true);
    expect(rl.take('203.0.113.4', t0 + 3600_001).ok).toBe(true);
  });

  it('forgets idle keys, so it cannot grow without bound', () => {
    const rl = new RateLimiter(5, 1000);
    for (let i = 0; i < 100; i++) rl.take(`k${i}`, 0);
    rl.take('later', 5000);
    expect(rl.size).toBe(1);
  });
});
