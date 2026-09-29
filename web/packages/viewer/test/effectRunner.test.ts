import { describe, expect, it } from 'vitest';
import type { EffectOp, EffectProgram } from '@s2u/scene';
import { EffectRun, type EffectHost } from '../src/effectRunner';

/** The zAnim sequencer the effects run on (web/docs/research/89 §1): control flow, waits, loops, timed commands. */

const program = (...sequences: { name?: string; ops: EffectOp[] }[]): EffectProgram => ({
  name: 't', root: 0, flags: 0, nodes: ['NA'],
  sequences: sequences.map((s, i) => ({ name: s.name ?? `s${i}`, activation: 1, ops: s.ops })),
});
const mark = (n: number): EffectOp => ({ op: 'call', anim: `m${n}` });

function host(randoms: number[] = []): EffectHost & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    begin: (op) => { if (op.op === 'call') log.push(op.anim); },
    test: () => false,
    random: () => randoms.shift() ?? 0.5,
  };
}

describe('the effect sequencer', () => {
  it('takes the first branch whose random weight holds, as flash_fire_hider picks its turn', () => {
    const ops: EffectOp[] = [
      { op: 'if', conditions: [{ kind: 'random', p: 0.125 }] }, mark(1),
      { op: 'elseif', conditions: [{ kind: 'random', p: 0.25 }] }, mark(2),
      { op: 'else' }, mark(3),
      { op: 'endif' }, mark(9),
    ];
    for (const [rolls, want] of [[[0.1], ['m1', 'm9']], [[0.5, 0.2], ['m2', 'm9']], [[0.5, 0.9], ['m3', 'm9']]] as const) {
      const h = host([...rolls]);
      new EffectRun(program({ ops }), h).update(0);
      expect(h.log).toEqual(want);
    }
  });

  it('nests: an inner IF inside a skipped branch is skipped whole', () => {
    const ops: EffectOp[] = [
      { op: 'if', conditions: [{ kind: 'random', p: 0 }] },
      { op: 'if', conditions: [{ kind: 'random', p: 1 }] }, mark(1), { op: 'endif' },
      { op: 'else' }, mark(2), { op: 'endif' },
    ];
    const h = host([0.5]);
    new EffectRun(program({ ops }), h).update(0);
    expect(h.log).toEqual(['m2']);
  });

  it('waits its seconds, then goes on; the run ends with its last sequence', () => {
    const h = host();
    const run = new EffectRun(program({ ops: [mark(1), { op: 'wait', seconds: 0.25, range: 0, frames: null }, mark(2)] }), h);
    run.update(0);
    expect(h.log).toEqual(['m1']);
    run.update(0.2);
    expect(h.log).toEqual(['m1']);
    run.update(0.1);
    expect(h.log).toEqual(['m1', 'm2']);
    expect(run.finished).toBe(true);
  });

  it('WAIT n frames resumes n ticks later', () => {
    const h = host();
    const run = new EffectRun(program({ ops: [{ op: 'wait', seconds: 0, range: 0, frames: 1 }, mark(1)] }), h);
    run.update(0);
    expect(h.log).toEqual([]);
    run.update(1 / 60);
    expect(h.log).toEqual(['m1']);
  });

  it('a LOOP forever repeats its sequence once a tick until another sequence stops it', () => {
    const h = host();
    const run = new EffectRun(program(
      { name: 'fix', ops: [mark(1), { op: 'loop', count: -1, seconds: null }] },
      { name: 'scale', ops: [{ op: 'wait', seconds: 0.05, range: 0, frames: null }, { op: 'stopSequence', sequence: 'fix' }] },
    ), h);
    run.update(0);
    run.update(0.02);
    run.update(0.02);
    expect(h.log).toEqual(['m1', 'm1', 'm1']);
    run.update(0.02);
    expect(run.finished).toBe(true);
    const before = h.log.length;
    run.update(0.02);
    expect(h.log.length).toBe(before);
  });

  it('holds a sequence on a timed command until its tick answers done', () => {
    let left = 0.1;
    const log: string[] = [];
    const h: EffectHost = {
      begin: (op) => (op.op === 'motion' ? (dt: number) => (left -= dt) <= 0 : void log.push(op.op)),
      test: () => false, random: () => 0,
    };
    const run = new EffectRun(program({ ops: [{ op: 'motion', motion: {} as never }, { op: 'active', node: 1, on: false }] }), h);
    run.update(0);
    run.update(0.05);
    expect(log).toEqual([]);
    run.update(0.06);
    expect(log).toEqual(['active']);
    expect(run.finished).toBe(true);
  });

  it('FAIL stops the whole animation', () => {
    const h = host();
    const run = new EffectRun(program({ ops: [{ op: 'fail' }, mark(1)] }, { ops: [{ op: 'wait', seconds: 1, range: 0, frames: null }, mark(2)] }), h);
    run.update(0);
    run.update(2);
    expect(h.log).toEqual([]);
    expect(run.finished).toBe(true);
  });
});
