import { describe, expect, it } from 'vitest';
import { MESSAGE_ERROR_TEXT, reportDecodeFailure, wireWorkerFailure, type DecodeFailureUi } from '../src/decodeFailure';

/**
 * A decode worker that fails without a reply (its module will not load, an exception outside a request's `try`, a
 * reply the page cannot read) reaches the page as a message, not a hang on "reading the disc image ..."
 * (`../src/decodeFailure`).
 */

function fakeUi(discPage: boolean) {
  const calls: string[] = [];
  const ui: DecodeFailureUi = {
    setLoading: (on) => { calls.push(`loading ${on}`); },
    discPageShown: () => discPage,
    setDiscState: (text, kind = 'ok') => { calls.push(`disc ${kind}: ${text}`); },
    setStatus: (text, kind = 'ok') => { calls.push(`status ${kind}: ${text}`); },
  };
  return { ui, calls };
}

describe('the decode worker\'s failures on the page', () => {
  it('an error event on the disc page: the overlay down, the disc page\'s line an error, the page told first', () => {
    const { ui, calls } = fakeUi(true);
    const worker = new EventTarget();
    let failed = 0;
    wireWorkerFailure(worker, ui, () => { failed++; });
    worker.dispatchEvent(new ErrorEvent('error', { message: 'boom' }));
    expect(failed).toBe(1);
    expect(calls).toEqual(['loading false', 'disc error: the decoder stopped: boom', 'status ok: the decoder stopped: boom']);
  });

  it('messageerror: the fixed line', () => {
    const { ui, calls } = fakeUi(true);
    const worker = new EventTarget();
    wireWorkerFailure(worker, ui);
    worker.dispatchEvent(new Event('messageerror'));
    expect(calls).toContain(`disc error: ${MESSAGE_ERROR_TEXT}`);
  });

  it('off the disc page the status line says it, as an error; an error with no message says so', () => {
    const { ui, calls } = fakeUi(false);
    const worker = new EventTarget();
    const off = wireWorkerFailure(worker, ui);
    worker.dispatchEvent(new Event('error'));
    expect(calls).toEqual(['loading false', 'status error: the decoder stopped: unknown error']);
    off();
    worker.dispatchEvent(new Event('error'));
    expect(calls).toHaveLength(2);                              // unsubscribed
  });

  it('the worker\'s own error reply goes the same way', () => {
    const { ui, calls } = fakeUi(false);
    reportDecodeFailure(ui, 'failed while reading the disc image: bad');
    expect(calls).toEqual(['loading false', 'status error: failed while reading the disc image: bad']);
  });
});
