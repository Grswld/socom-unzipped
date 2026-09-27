import { describe, expect, it } from 'vitest';
import { spreadAcrossFrames, type Frames } from '../src/scheduler';

/**
 * A fake clock and a fake frame pump, so "does it yield?" is a fact rather than a feeling. `pump()`
 * runs whatever the scheduler asked for next and says whether there was anything to run.
 */
interface Harness extends Frames {
  pump(): boolean;
  clock: { t: number };
  frames: number;
}

function harness(): Harness {
  const clock = { t: 0 };
  let pending: (() => void) | null = null;
  let next = 1;
  const h: Harness = {
    clock,
    frames: 0,
    now: () => clock.t,
    requestFrame(run: () => void): number { pending = run; return next++; },
    cancelFrame(): void { pending = null; },
    pump(): boolean {
      const run = pending;
      pending = null;
      if (!run) return false;
      h.frames++;
      run();
      return true;
    },
  };
  return h;
}

describe('spreadAcrossFrames', () => {
  it('does no work before the first frame arrives', () => {
    const h = harness();
    const ran: number[] = [];
    spreadAcrossFrames([0, 1, 2].map((i) => () => ran.push(i)), { frames: h });
    expect(ran).toEqual([]);
    h.pump();
    expect(ran).toEqual([0, 1, 2]);
  });

  it('stops a frame once the budget is spent, and resumes on the next one', () => {
    const h = harness();
    const ran: number[] = [];
    // Each task costs 5 ms on the fake clock against a budget of 8, so two a frame: the budget is
    // checked after a task, so the second starts at 5 ms (inside the budget) and ends at 10 (over it).
    const tasks = [0, 1, 2, 3, 4].map((i) => () => { ran.push(i); h.clock.t += 5; });
    spreadAcrossFrames(tasks, { budgetMs: 8, frames: h });
    h.pump();
    expect(ran).toEqual([0, 1]);
    h.pump();
    expect(ran).toEqual([0, 1, 2, 3]);
    h.pump();
    expect(ran).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops at the count even when every task is free, which is the budget that matters here', () => {
    // A `group.add` costs nothing where it runs and 400 ms in the render that follows, so the clock
    // cannot pace this work and the count has to. Five free tasks, four a frame.
    const h = harness();
    const ran: number[] = [];
    const tasks = [0, 1, 2, 3, 4].map((i) => () => ran.push(i));
    spreadAcrossFrames(tasks, { maxPerFrame: 4, frames: h });
    h.pump();
    expect(ran).toEqual([0, 1, 2, 3]);
    h.pump();
    expect(ran).toEqual([0, 1, 2, 3, 4]);
  });

  it('takes whichever budget runs out first', () => {
    // Four allowed a frame, but each costs 5 ms against a budget of 8: the clock stops it at two.
    const h = harness();
    const ran: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) => () => { ran.push(i); h.clock.t += 5; });
    spreadAcrossFrames(tasks, { budgetMs: 8, maxPerFrame: 4, frames: h });
    h.pump();
    expect(ran).toEqual([0, 1]);
  });

  it('always runs at least one task a frame, however far over budget it goes', () => {
    const h = harness();
    const ran: number[] = [];
    // One task costs ten times the budget. Checking the clock first would never start it.
    const tasks = [0, 1].map((i) => () => { ran.push(i); h.clock.t += 80; });
    spreadAcrossFrames(tasks, { budgetMs: 8, frames: h });
    h.pump();
    expect(ran).toEqual([0]);
    h.pump();
    expect(ran).toEqual([0, 1]);
  });

  it('resolves when the last task has run', async () => {
    const h = harness();
    const spread = spreadAcrossFrames([() => {}, () => {}], { frames: h });
    h.pump();
    await expect(spread.done).resolves.toBeUndefined();
  });

  it('reports progress once a frame, ending at total of total', () => {
    const h = harness();
    const seen: [number, number][] = [];
    const tasks = [0, 1, 2].map(() => () => { h.clock.t += 5; });
    spreadAcrossFrames(tasks, { budgetMs: 8, onProgress: (d, t) => seen.push([d, t]), frames: h });
    h.pump();
    h.pump();
    expect(seen).toEqual([[2, 3], [3, 3]]);
  });

  it('cancels: no further task runs, and the promise still settles', async () => {
    const h = harness();
    const ran: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) => () => { ran.push(i); h.clock.t += 5; });
    const spread = spreadAcrossFrames(tasks, { budgetMs: 8, frames: h });
    h.pump();
    expect(ran).toEqual([0, 1]);
    spread.cancel();
    expect(h.pump()).toBe(false);          // the pending frame was cancelled
    expect(ran).toEqual([0, 1]);
    await expect(spread.done).resolves.toBeUndefined();
  });

  it('an empty list is done immediately, and says so', async () => {
    const h = harness();
    const seen: [number, number][] = [];
    const spread = spreadAcrossFrames([], { onProgress: (d, t) => seen.push([d, t]), frames: h });
    expect(seen).toEqual([[0, 0]]);
    expect(h.pump()).toBe(false);
    await expect(spread.done).resolves.toBeUndefined();
  });

  it('a task that throws costs that task, not the run', () => {
    const h = harness();
    const ran: number[] = [];
    const tasks = [
      (): void => { ran.push(0); },
      (): void => { throw new Error('this prop will not build'); },
      (): void => { ran.push(2); },
    ];
    spreadAcrossFrames(tasks, { frames: h });
    h.pump();
    expect(ran).toEqual([0, 2]);
  });
});
