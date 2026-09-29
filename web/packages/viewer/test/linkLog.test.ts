import { describe, expect, it } from 'vitest';
import { LinkLog, type PipelineBackend } from '../src/linkLog';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A backend that links async (a promise pushed, finished when told to) when given a list, else at once. */
function fakeBackend(): PipelineBackend & { calls: unknown[]; finish(): void } {
  const finishers: (() => void)[] = [];
  const b = {
    calls: [] as unknown[],
    createRenderPipeline(renderObject: unknown, promises: Promise<unknown>[] | null): void {
      b.calls.push(renderObject);
      if (promises) promises.push(new Promise<void>((resolve) => { finishers.push(resolve); }));
    },
    finish(): void { for (const f of finishers.splice(0)) f(); },
  };
  return b;
}

const ro = (object: string, material: string, parent?: string, target?: { width: number; height: number; samples: number }) => ({
  object: { name: object, parent: parent ? { name: parent, parent: null } : null },
  material: { name: material },
  context: { renderTarget: target ?? null },
});

describe('linkLog: which programs link, and whether a frame waits (research 90 #21, #23)', () => {
  it('records a draw\'s own link as sync and a compileAsync link as async, and still calls the backend', () => {
    let now = 10;
    const log = new LinkLog(() => now);
    const b = fakeBackend();
    log.watch(b);
    const promises: Promise<unknown>[] = [];
    b.createRenderPipeline(ro('body', 'body x.tif', 'SEAL'), promises);
    now = 20;
    b.createRenderPipeline(ro('hud batch', 'hud', undefined, { width: 256, height: 256, samples: 0 }), null);
    expect(b.calls).toHaveLength(2);
    expect(promises).toHaveLength(1);
    expect(log.total).toBe(2);
    expect(log.syncTotal).toBe(1);
    const [a, s] = log.since();
    expect(a).toMatchObject({ t: 10, sync: false, object: 'body < SEAL', material: 'body x.tif', target: 'canvas', pending: 0 });
    expect(s).toMatchObject({ t: 20, sync: true, object: 'hud batch', material: 'hud', target: '256x256/0', pending: 1 });
    expect(log.since(15)).toEqual([s]);
  });

  it('counts the async links in flight until they finish', async () => {
    const log = new LinkLog(() => 0);
    const b = fakeBackend();
    log.watch(b);
    const promises: Promise<unknown>[] = [];
    b.createRenderPipeline(ro('a', 'm'), promises);
    b.createRenderPipeline(ro('b', 'm'), promises);
    expect(log.pending()).toBe(2);
    b.finish();
    await tick(); await tick();
    expect(log.pending()).toBe(0);
  });

  it('keeps the latest 400 records', () => {
    const log = new LinkLog(() => 0);
    for (let i = 0; i < 450; i++) log.record(ro(`o${i}`, 'm'), false);
    expect(log.since()).toHaveLength(400);
    expect(log.since()[0]!.object).toBe('o50');
    expect(log.total).toBe(450);
  });
});
