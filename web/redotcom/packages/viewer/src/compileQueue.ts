/**
 * The page's program-compile queue (research 90 item 17), apart from three so it can be tested.
 *
 * three's `compileAsync` links a program with `KHR_parallel_shader_compile` and polls for it once a frame, so one
 * call per draw with a few calls in flight keeps the driver's compiler threads busy without handing it a pile: a draw
 * the render loop must link synchronously waits behind every link already queued in the driver (150 queued at once
 * held one for 1.5 s on Guidance). The jobs run in the order asked, each call's own jobs one-of-each-kind first.
 */

/** One job: its lanes (how many may run while it leads the queue), whether it is still wanted, and its work. */
export interface CompileJob {
  lanes?: number;
  stale?: () => boolean;
  run(): Promise<void>;
}

export class CompileQueue {
  private readonly jobs: { job: CompileJob; resolve: () => void }[] = [];
  private running = 0;

  constructor(private readonly lanes: number) {}

  /** In flight now (for tests and the stats). */
  get active(): number { return this.running; }
  /** Waiting. */
  get waiting(): number { return this.jobs.length; }

  /** Queues `jobs` behind everything already asked for; resolves when all have run or been dropped as stale. */
  add(jobs: readonly CompileJob[]): Promise<void> {
    const done = jobs.map((job) => new Promise<void>((resolve) => { this.jobs.push({ job, resolve }); }));
    this.pump();
    return Promise.all(done).then(() => {});
  }

  private pump(): void {
    while (this.jobs.length > 0 && this.running < (this.jobs[0]!.job.lanes ?? this.lanes)) {
      const { job, resolve } = this.jobs.shift()!;
      if (job.stale?.()) { resolve(); continue; }
      this.running++;
      let work: Promise<void>;
      try { work = job.run(); } catch { work = Promise.resolve(); }
      void work.catch(() => {}).finally(() => { this.running--; resolve(); this.pump(); });
    }
  }
}

/**
 * `items` with the first of each kind moved to the front, in their order, and the rest behind in theirs: the draws
 * that share a program link it once, and the first of each is what a frame needs soonest.
 */
export function firstOfEachKind<T>(items: readonly T[], kindOf: (item: T) => string): T[] {
  const kinds = new Set<string>();
  const first: T[] = [], rest: T[] = [];
  for (const item of items) {
    const k = kindOf(item);
    (kinds.has(k) ? rest : first).push(item);
    kinds.add(k);
  }
  return [...first, ...rest];
}
