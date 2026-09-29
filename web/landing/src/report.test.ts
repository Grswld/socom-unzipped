import { describe, it, expect } from 'vitest';
import { FIELDS, FOLLOW_UP, createForm, moveField, currentField, checkForm, buildPayload, replyText } from './report';

describe('report form', () => {
  it('has the fields the launcher mirrors, in order, ending in SEND', () => {
    expect(FIELDS.map((f) => f.id)).toEqual(['title', 'description', 'contact', 'send']);
    expect(FIELDS.map((f) => f.label)).toEqual(['TITLE', 'WHAT HAPPENED', 'CONTACT (OPTIONAL)', 'SEND REPORT']);
  });

  it('moves between fields and clamps at both ends', () => {
    let f = createForm();
    expect(currentField(f).id).toBe('title');
    f = moveField(f, -1);
    expect(currentField(f).id).toBe('title');
    f = moveField(moveField(moveField(moveField(f, 1), 1), 1), 1);
    expect(currentField(f).id).toBe('send');
  });

  it('checks the same limits as the inbox, with a message a player can act on', () => {
    expect(checkForm({ title: 'abc', description: 'long enough text', contact: '' })).toBe('TITLE: 4 TO 120 CHARACTERS.');
    expect(checkForm({ title: 'A title', description: 'short', contact: '' })).toBe('WHAT HAPPENED: AT LEAST 10 CHARACTERS.');
    expect(checkForm({ title: 'A title', description: 'x'.repeat(4001), contact: '' })).toBe('WHAT HAPPENED: AT MOST 4000 CHARACTERS.');
    expect(checkForm({ title: '  A title ', description: 'long enough text', contact: '' })).toBe('');
  });

  it('builds the payload the inbox expects', () => {
    const p = buildPayload({ title: ' Crash on join ', description: 'It closed when I joined.', contact: ' me#1 ' },
      { version: 'S2U v0.5.0 2026-09-19', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', language: 'en-CA', screen: '2560x1440' });
    expect(p).toEqual({
      title: 'Crash on join',
      description: 'It closed when I joined.',
      contact: 'me#1',
      source: 'site',
      version: 'S2U v0.5.0 2026-09-19',
      platform: 'Windows',
      context: { language: 'en-CA', screen: '2560x1440' },
      website: '',
    });
    expect(buildPayload({ title: 't', description: 'd', contact: '' }, { version: '', userAgent: 'X11; Linux x86_64', language: '', screen: '' }).platform).toBe('Linux');
    expect(buildPayload({ title: 't', description: 'd', contact: '' }, { version: '', userAgent: 'weird', language: '', screen: '' }).platform).toBe('unknown');
  });

  it('turns the reply into one line for the screen', () => {
    expect(replyText(201, { ok: true, id: 'BR-20260919-abc123' })).toEqual({ ok: true, text: `REPORT RECEIVED. REFERENCE BR-20260919-ABC123. ${FOLLOW_UP}` });
    expect(replyText(201, { ok: true, id: '<img src=x>' })).toEqual({ ok: true, text: 'REPORT RECEIVED.' });
    expect(replyText(400, { ok: false, error: 'title: 4 to 120 characters' })).toEqual({ ok: false, text: 'NOT SENT. TITLE: 4 TO 120 CHARACTERS' });
    expect(replyText(429, {})).toEqual({ ok: false, text: 'NOT SENT. TOO MANY REPORTS FROM HERE; TRY AGAIN IN AN HOUR.' });
    expect(replyText(502, null)).toEqual({ ok: false, text: 'NOT SENT. THE REPORT SERVICE DID NOT ANSWER; YOUR TEXT IS STILL HERE.' });
  });
});
