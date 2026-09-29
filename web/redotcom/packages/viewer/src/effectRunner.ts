import type { EffectCondition, EffectOp, EffectProgram } from '@s2u/scene';

/**
 * The zAnim sequencer for the effect animations (web/docs/research/89 §1), as `CZAnimMain` runs a sequence: each tick
 * a sequence steps its commands from its program counter -- a command's tick answers done (the next command runs in
 * the same tick) or not yet (the sequence resumes there next tick). The sequences of an animation run side by side;
 * the animation ends when every sequence has run off its end, or on `FAIL`.
 *
 * - **IF / ELSEIF / ELSE / ENDIF** nest (77 §9): a false condition skips to the next branch of its own level; the end
 *   of a taken branch skips to its `ENDIF`. An `IF`'s conditions are its sub-commands; the effects' are
 *   `RANDOM_WEIGHT` (`rand() / 2^31 <= p`), `RANGE_TEST` and `VALVE`, which `host.test` answers.
 * - **WAIT** holds for its seconds, or its frames; **LOOP** returns to the sequence's start (forever at -1, as the
 *   flash's `fire_fix` does until `STOP_SEQUENCE` ends it); **STOP_SEQUENCE** ends a named sequence.
 * - Everything else is the host's (`EffectHost.begin`): a node's state, a sound, a particle source, a call, which
 *   answer at once, and the timed ones -- `OBJECT_MOTION` and `OBJECT_MOTION_FROM_TO` -- which return a tick that the
 *   sequence waits on.
 */

/** A timed command's own tick: true when it is done. */
export type OpTick = (dt: number) => boolean;

export interface EffectHost {
  /** Starts a command; a function is its tick (the sequence waits until it answers true), anything else is done. */
  begin(op: EffectOp, run: EffectRun): OpTick | void;
  /** A condition of an `IF` other than a random weight. */
  test(c: EffectCondition, run: EffectRun): boolean;
  random(): number;
}

interface SeqState {
  pc: number;
  done: boolean;
  /** A running timed command's tick, or a wait's time left. */
  tick: OpTick | null;
  waitLeft: number;
  waitFrames: number | null;
  loops: number;
  loopTime: number;
}

/**
 * Where the ops of one sequence jump: an IF/ELSEIF/ELSE's next branch, every branch opener's ENDIF, and a WHILE's
 * END_WHILE (`end`) and back (`next` of the END_WHILE).
 */
function branchTable(ops: readonly EffectOp[]): { next: Int32Array; end: Int32Array } {
  const next = new Int32Array(ops.length).fill(-1), end = new Int32Array(ops.length).fill(-1);
  const stack: number[][] = [];
  const loops: number[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'while') loops.push(i);
    else if (o.op === 'endWhile') {
      const w = loops.pop();
      if (w !== undefined) { end[w] = i; next[i] = w; }
    } else if (o.op === 'if') stack.push([i]);
    else if (o.op === 'elseif' || o.op === 'else') {
      const top = stack[stack.length - 1];
      if (!top) return;
      next[top[top.length - 1]!] = i;
      top.push(i);
    } else if (o.op === 'endif') {
      const top = stack.pop();
      if (!top) return;
      next[top[top.length - 1]!] = i;
      for (const j of top) end[j] = i;
    }
  });
  return { next, end };
}

/** One playing effect animation. */
export class EffectRun {
  private readonly seqs: SeqState[];
  private readonly tables: { next: Int32Array; end: Int32Array }[];
  private failed = false;
  /** Seconds since it started. */
  time = 0;

  constructor(readonly program: EffectProgram, private readonly host: EffectHost, readonly context: unknown = null) {
    this.tables = program.sequences.map((s) => branchTable(s.ops));
    // A sequence of activation 2 that the animation's own `CALL_SEQUENCE` names waits for the call (Frostfire's
    // `firey_flames` turns its vent lights on and off so); one no call names runs from the start, as the activation
    // gate does (`shell_eject`'s range test, `Anim_Params`' second offset) [reading: research 89 §12].
    const called = new Set<string>();
    for (const s of program.sequences) for (const o of s.ops) if (o.op === 'callSequence') called.add(o.sequence);
    this.seqs = program.sequences.map((s) => ({
      pc: 0, done: s.activation === 2 && called.has(s.name), tick: null, waitLeft: 0, waitFrames: null, loops: 0, loopTime: 0,
    }));
  }

  /** `CALL_SEQUENCE`: the named sequence starts again from its top. */
  callSequence(name: string): void {
    this.program.sequences.forEach((s, i) => {
      if (s.name !== name) return;
      Object.assign(this.seqs[i]!, { pc: 0, done: false, tick: null, waitLeft: 0, waitFrames: null, loops: 0, loopTime: 0 });
    });
  }

  /** Paused (`PAUSE_ANIMATION`): alive -- its sources emit, its nodes stay -- with nothing run. */
  paused = false;

  get finished(): boolean {
    return this.failed || (!this.paused && this.seqs.every((s) => s.done));
  }

  /** Stops the whole animation (`FAIL`, or its owner). */
  stop(): void {
    this.failed = true;
  }

  /** Ends the sequence named `name` (`STOP_SEQUENCE`). */
  stopSequence(name: string): void {
    this.program.sequences.forEach((s, i) => { if (s.name === name) this.seqs[i]!.done = true; });
  }

  /** One tick of `dt` seconds for every sequence (the first tick with `dt` 0 runs the timeless commands at once). */
  update(dt: number): void {
    if (this.finished || this.paused) return;
    this.time += dt;
    this.program.sequences.forEach((seq, i) => this.step(i, seq.ops, dt));
  }

  private step(index: number, ops: readonly EffectOp[], dt: number): void {
    const s = this.seqs[index]!, table = this.tables[index]!;
    let budget = 512;                               // a runaway guard: a sequence that loops without waiting
    while (!s.done && !this.failed && budget-- > 0) {
      if (s.tick) {
        if (!s.tick(dt)) return;
        s.tick = null;
        dt = 0;
        s.pc++;
        continue;
      }
      if (s.waitFrames !== null || s.waitLeft > 0) {
        if (s.waitFrames !== null) {
          if (--s.waitFrames > 0) return;             // WAIT n frames resumes n ticks after it began
          s.waitFrames = null;
        } else {
          s.waitLeft -= dt;
          if (s.waitLeft > 1e-9) return;
          s.waitLeft = 0;
        }
        dt = 0;
        s.pc++;
        continue;
      }
      if (s.pc >= ops.length) { s.done = true; return; }
      const op = ops[s.pc]!;
      switch (op.op) {
        case 'if': case 'elseif': {
          // Reached in order an ELSEIF closes a taken branch: on to the ENDIF.
          if (op.op === 'elseif') { s.pc = table.end[s.pc]! >= 0 ? table.end[s.pc]! + 1 : s.pc + 1; continue; }
          s.pc = this.branch(ops, table, s.pc);
          continue;
        }
        case 'else': s.pc = table.end[s.pc]! >= 0 ? table.end[s.pc]! + 1 : s.pc + 1; continue;
        case 'endif': s.pc++; continue;
        case 'wait': {
          if (op.frames !== null) s.waitFrames = op.frames;
          else s.waitLeft = op.seconds + (op.range ? op.range * this.host.random() : 0);
          if (s.waitFrames === null && s.waitLeft <= 0) s.pc++;
          else if (s.waitFrames !== null && s.waitFrames <= 0) { s.waitFrames = null; s.pc++; }
          else return;
          continue;
        }
        case 'loop': {
          s.loops++;
          s.loopTime += dt;
          const doneLooping = (op.count !== null && op.count !== -1 && s.loops >= op.count) || (op.seconds !== null && s.loopTime >= op.seconds);
          if (doneLooping) { s.pc++; continue; }
          s.pc = 0;
          return;                                   // once a tick: the sequence runs again from its start next tick
        }
        case 'stopSequence': this.stopSequence(op.sequence); s.pc++; continue;
        case 'callSequence': this.callSequence(op.sequence); s.pc++; continue;
        case 'pauseAnimation':
          // Index 0 (`NA`) names the animation itself (the torches'): paused, it stays alive with its sources.
          if (op.anim === this.program.name || op.anim === 'NA') { this.paused = true; s.pc++; return; }
          this.host.begin(op, this);
          s.pc++;
          continue;
        case 'while': {
          // Only the endless form is on the effects' path (the ripples); a conditional one is taken as false.
          s.pc = op.forever || table.end[s.pc]! < 0 ? s.pc + 1 : table.end[s.pc]! + 1;
          continue;
        }
        case 'endWhile': {
          const back = table.next[s.pc]!;
          if (back < 0) { s.pc++; continue; }
          s.pc = back;
          return;                                   // once a tick
        }
        case 'fail': this.stop(); return;
        default: {
          const tick = this.host.begin(op, this);
          if (typeof tick === 'function') { s.tick = tick; continue; }
          s.pc++;
          continue;
        }
      }
    }
  }

  /** From an IF at `at`: the first branch whose conditions hold, or the ELSE, or past the ENDIF. */
  private branch(ops: readonly EffectOp[], table: { next: Int32Array; end: Int32Array }, at: number): number {
    let i = at;
    for (;;) {
      const op = ops[i]!;
      if (op.op === 'else') return i + 1;
      if (op.op === 'endif') return i + 1;
      if ((op.op === 'if' || op.op === 'elseif') && this.holds(op.conditions)) return i + 1;
      const n = table.next[i]!;
      if (n < 0) return ops.length;
      i = n;
    }
  }

  private holds(conditions: readonly EffectCondition[]): boolean {
    // Several conditions are joined by the operators after them; the effects carry one each.
    return conditions.every((c) => (c.kind === 'random' ? this.host.random() <= c.p : this.host.test(c, this)));
  }
}
