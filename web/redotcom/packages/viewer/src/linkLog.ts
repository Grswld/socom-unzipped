/**
 * Which programs the renderer links, when, and whether a frame waited for it (research 90 §9, issues #21 and #23).
 *
 * three's backends link a render pipeline in `createRenderPipeline(renderObject, promises)`. Under `compileAsync` the
 * `promises` array is given: WebGL2 links with `KHR_parallel_shader_compile` and polls for it once a frame, WebGPU
 * asks for `createRenderPipelineAsync`, and no frame waits. A draw that meets a program nobody compiled passes `null`:
 * WebGL2 reads the link status at once (`_completeCompile`), which blocks until the driver has linked it -- behind
 * every link already in flight -- and that frame is long. So a sync link after the warm-ups is a program the warm set
 * lacks, and this log names it: the object, its material and where it drew. A texture upload is the other thing a
 * WebGL2 frame waits for (`texImage2D` copies on the call); the slow ones are logged beside the links.
 */

/** One `createRenderPipeline` call, or one slow texture upload (`kind`). */
export interface LinkRecord {
  kind: 'link' | 'texture';
  /** `performance.now()` at the call. */
  t: number;
  /** How long the call itself took (a sync link on WebGL2 includes the wait for the driver). */
  ms: number;
  /** True when no compile promise list was given: a draw's own link, which the frame waits for on WebGL2. */
  sync: boolean;
  /** The object's name (its type when it has none) and its parents' names, innermost first, up to three; a texture's name and size. */
  object: string;
  /** The material's name (its type when it has none); `texture` for an upload. */
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

/** The part of a texture the log reads. */
interface TextureLike { name?: string; image?: { width?: number; height?: number } | null }

/** The part of a backend the log wraps. */
export interface PipelineBackend {
  createRenderPipeline(renderObject: unknown, promises: Promise<unknown>[] | null): unknown;
  updateTexture?(texture: unknown, options: unknown): unknown;
}

/** How many records are kept (the oldest drop first). */
const KEEP = 400;
/** A texture upload shorter than this is not recorded (counted only). */
const SLOW_TEXTURE_MS = 2;

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
  /** Every texture upload, and the time they took. */
  textures = 0;
  textureMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Wraps the backend's link and texture upload so each is recorded; the backend's own behaviour is untouched. */
  watch(backend: PipelineBackend): void {
    const link = backend.createRenderPipeline.bind(backend);
    backend.createRenderPipeline = (renderObject, promises) => {
      const before = promises ? promises.length : 0;
      const t = this.now();
      const result = link(renderObject, promises);
      this.record(renderObject as RenderObjectLike, promises === null || promises === undefined, t, this.now() - t);
      if (promises) {
        for (let i = before; i < promises.length; i++) {
          this.inFlight++;
          void Promise.resolve(promises[i]).catch(() => {}).finally(() => { this.inFlight--; });
        }
      }
      return result;
    };
    const upload = backend.updateTexture?.bind(backend);
    if (upload) {
      backend.updateTexture = (texture, options) => {
        const t = this.now();
        const result = upload(texture, options);
        this.recordTexture(texture as TextureLike, t, this.now() - t);
        return result;
      };
    }
  }

  /** Records one link (the wrapper's; public for the tests). */
  record(r: RenderObjectLike, sync: boolean, t = this.now(), ms = 0): void {
    this.total++;
    if (sync) this.syncTotal++;
    this.push({
      kind: 'link', t, ms, sync, object: describeObject(r.object), material: r.material?.name || r.material?.type || '?',
      target: describeTarget(r), pending: this.inFlight,
    });
  }

  /** Records one texture upload; only a slow one is kept (the wrapper's; public for the tests). */
  recordTexture(texture: TextureLike, t: number, ms: number): void {
    this.textures++;
    this.textureMs += ms;
    if (ms < SLOW_TEXTURE_MS) return;
    const size = texture.image ? `${texture.image.width ?? '?'}x${texture.image.height ?? '?'}` : '?';
    this.push({ kind: 'texture', t, ms, sync: true, object: `${texture.name || 'texture'} ${size}`, material: 'texture', target: '', pending: this.inFlight });
  }

  private push(r: LinkRecord): void {
    this.list.push(r);
    if (this.list.length > KEEP) this.list.shift();
  }

  /** The async links in flight now. */
  pending(): number { return this.inFlight; }

  /** The records since `since` (a `performance.now()` time), oldest first. */
  since(since = -Infinity): LinkRecord[] { return this.list.filter((r) => r.t >= since); }
}
