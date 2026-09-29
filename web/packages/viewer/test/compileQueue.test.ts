import { describe, expect, it } from 'vitest';
import { CompileQueue, firstOfEachKind, type CompileJob } from '../src/compileQueue';

/** A job that finishes when told to, recording when it started. */
function gate(log: string[], name: string, extra: Partial<CompileJob> = {}): CompileJob & { finish(): void } {
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  return { ...extra, run: () => { log.push(name); return done; }, finish: () => finish() };
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('compileQueue: the page\'s compile queue (research 90 item 17)', () => {
  it('keeps no more than its lanes in flight, in the order asked', async () => {
    const log: string[] = [];
    const q = new CompileQueue(2);
    const jobs = ['a', 'b', 'c', 'd'].map((n) => gate(log, n));
    const all = q.add(jobs);
    expect(log).toEqual(['a', 'b']);
    expect(q.active).toBe(2);
    jobs[1]!.finish(); await tick();
    expect(log).toEqual(['a', 'b', 'c']);
    jobs[0]!.finish(); jobs[2]!.finish(); await tick();
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    jobs[3]!.finish();
    await all;
    expect(q.active).toBe(0);
  });

  it('runs a later call behind an earlier one, and a leading call\'s lanes widen the queue for it', async () => {
    const log: string[] = [];
    const q = new CompileQueue(1);
    const first = [gate(log, 'w1', { lanes: 3 }), gate(log, 'w2', { lanes: 3 }), gate(log, 'w3', { lanes: 3 })];
    const second = [gate(log, 'p1')];
    void q.add(first); void q.add(second);
    expect(log).toEqual(['w1', 'w2', 'w3']);
    for (const j of first) j.finish();
    await tick();
    expect(log).toEqual(['w1', 'w2', 'w3', 'p1']);
    second[0]!.finish();
  });

  it('drops a stale job without running it, and a job that throws still settles', async () => {
    const log: string[] = [];
    const q = new CompileQueue(1);
    await q.add([
      { stale: () => true, run: () => { log.push('stale'); return Promise.resolve(); } },
      { run: () => { throw new Error('no'); } },
      { run: () => Promise.reject(new Error('no')) },
      { run: () => { log.push('ok'); return Promise.resolve(); } },
    ]);
    expect(log).toEqual(['ok']);
  });

  it('puts the first of each kind first, the rest behind in their order', () => {
    const items = ['body a', 'body b', 'gear a', 'body c', 'env a', 'gear b'];
    expect(firstOfEachKind(items, (s) => s.split(' ')[0]!)).toEqual(['body a', 'gear a', 'env a', 'body b', 'body c', 'gear b']);
  });
});
