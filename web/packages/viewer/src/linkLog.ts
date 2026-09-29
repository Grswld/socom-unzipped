/**
 * Which programs the renderer links, when, and whether a frame waited for it (research 90 §9, issues #21 and #23).
 *
 * three's backends link a render pipeline in `createRenderPipeline(renderObject, promises)`. Under `compileAsync` the
 * `promises` array is given: WebGL2 links with `KHR_parallel_shader_compile` and polls for it once a frame, WebGPU
 * asks for `createRenderPipelineAsync`, and no frame waits. A draw that meets a program nobody compiled passes `null`:
 * WebGL2 reads the link status at once (`_completeCompile`), which blocks until the driver has linked it -- behind
 * every link already in flight -- and that frame is long. So a sync link after the warm-ups is a program the warm set
 * lacks, and this log names it: the object, its material and where it drew.
 */

/** One `createRenderPipeline` call. */
export interface LinkRecord {
  /** `performance.now()` at the call. */
  t: number;
  /** True when no compile promise list was given: a draw's own link, which the frame waits for on WebGL2. */
  sync: boolean;
  /** The object's name (its type when it has none) and its parents' names, innermost first, up to three. */
  object: string;
  /** The material's name (its type when it has none). */
  material: string;
  /** Where it drew: `canvas`, or the target's size and samples. */
  target: string;
  /** Async links still in flight when this one was asked for (what a sync link waits behind). */
  pending: number;
}

/** The part of a render object the log reads (three's `RenderObject`). */
interface RenderObjectLike {
  object?: { name?: string; type?: string; parent?: unknown } | null;
  material?: { name?: string; type?: string } | null;
  context?: { renderTarget?: { width?: number; height?: number; samples?: number } | null } | null;
}

/** The part of a backend the log wraps. */
export interface PipelineBackend {
  createRenderPipeline(renderObject: unknown, promises: Promise<unknown>[] | null): unknown;
}

/** How many records are kept (the oldest drop first). */
const KEEP = 400;

function describeObject(o: RenderObjectLike['object']): string {
  const names: string[] = [];
  let at: RenderObjectLike['object'] | undefined = o;
  for (let i = 0; at && i < 3; i++) {
    names.push(at.name || at.type || '?');
    at = at.parent as RenderObjectLike['object'] | undefined;
  }
  return names.join(' < ');
}

function describeTarget(r: RenderObjectLike): string {
  const t = r.context?.renderTarget;
  return t ? `${t.width ?? '?'}x${t.height ?? '?'}/${t.samples ?? 0}` : 'canvas';
}

export class LinkLog {
  private readonly list: LinkRecord[] = [];
  private inFlight = 0;
  /** Every link since the page came up, and those a frame waited for. */
  total = 0;
  syncTotal = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Wraps `backend.createRenderPipeline` so every link is recorded; the backend's own behaviour is untouched. */
  watch(backend: PipelineBackend): void {
    const original = backend.createRenderPipeline.bind(backend);
    backend.createRenderPipeline = (renderObject, promises) => {
      const before = promises ? promises.length : 0;
      this.record(renderObject as RenderObjectLike, promises === null || promises === undefined);
      const result = original(renderObject, promises);
      if (promises) {
        for (let i = before; i < promises.length; i++) {
          this.inFlight++;
          void Promise.resolve(promises[i]).catch(() => {}).finally(() => { this.inFlight--; });
        }
      }
      return result;
    };
  }

  /** Records one link (the wrapper's; public for the tests). */
  record(r: RenderObjectLike, sync: boolean): void {
    this.total++;
    if (sync) this.syncTotal++;
    this.list.push({
      t: this.now(), sync, object: describeObject(r.object), material: r.material?.name || r.material?.type || '?',
      target: describeTarget(r), pending: this.inFlight,
    });
    if (this.list.length > KEEP) this.list.shift();
  }

  /** The async links in flight now. */
  pending(): number { return this.inFlight; }

  /** The records since `since` (a `performance.now()` time), oldest first. */
  since(since = -Infinity): LinkRecord[] { return this.list.filter((r) => r.t >= since); }
}
