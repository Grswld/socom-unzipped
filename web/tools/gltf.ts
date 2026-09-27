/**
 * A minimal glTF 2.0 **binary** (`.glb`) writer: enough of the format to carry indexed triangle meshes with
 * embedded PNG textures, and nothing else. No dependency.
 *
 * Container (glTF 2.0 §4.4.3): a 12-byte header (`glTF`, version 2, total length), then chunk 0 `JSON`
 * padded to 4 with **spaces**, then chunk 1 `BIN\0` padded to 4 with **zeros**. Every buffer view this
 * writer hands out starts 4-aligned inside the BIN chunk, so every accessor's byteOffset is a multiple of
 * its component size (all of which are 1, 2 or 4) without further care.
 */

/** Accessor component types (glTF 2.0 §5.1.3). */
export const FLOAT = 5126, UNSIGNED_BYTE = 5121, UNSIGNED_SHORT = 5123, UNSIGNED_INT = 5125;
/** Buffer view targets (§5.11.4). */
export const ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;
/** Sampler filters and wrap modes (§5.26). */
export const NEAREST = 9728, LINEAR = 9729, REPEAT = 10497;

export type AccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';
const COMPONENTS: Record<AccessorType, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES: Record<number, number> = { [UNSIGNED_BYTE]: 1, [UNSIGNED_SHORT]: 2, [FLOAT]: 4, [UNSIGNED_INT]: 4 };

/** A glTF object literal. The writer owns the arrays it indexes; the caller fills the rest by hand. */
export type Json = Record<string, unknown>;

const MAGIC = 0x46546c67, VERSION = 2, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const HEADER_BYTES = 12, CHUNK_HEADER_BYTES = 8, ALIGN = 4;
const pad = (n: number) => (ALIGN - (n % ALIGN)) % ALIGN;

export class GlbWriter {
  readonly bufferViews: Json[] = [];
  readonly accessors: Json[] = [];
  readonly images: Json[] = [];
  readonly samplers: Json[] = [];
  readonly textures: Json[] = [];
  readonly materials: Json[] = [];
  readonly meshes: Json[] = [];
  readonly nodes: Json[] = [];
  /** Indices into `nodes` that the single scene lists as its roots. */
  readonly roots: number[] = [];
  readonly extensionsUsed: string[] = [];

  private readonly bin: Uint8Array[] = [];
  private binLength = 0;

  constructor(private readonly generator = 's2u web/tools/export-gltf') {}

  /** Appends `bytes` to the BIN chunk, 4-aligned, and returns the new buffer view's index. */
  addBufferView(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.binLength;
    this.bin.push(bytes);
    this.binLength += bytes.byteLength;
    const fill = pad(this.binLength);
    if (fill > 0) { this.bin.push(new Uint8Array(fill)); this.binLength += fill; }
    const view: Json = { buffer: 0, byteOffset, byteLength: bytes.byteLength };
    if (target !== undefined) view['target'] = target;
    return this.bufferViews.push(view) - 1;
  }

  /** `min`/`max` are required by the spec on POSITION and harmless elsewhere (§5.1.1). */
  addAccessor(
    bufferView: number, componentType: number, count: number, type: AccessorType,
    opts: { normalized?: boolean; min?: number[]; max?: number[] } = {},
  ): number {
    const stride = COMPONENTS[type] * (COMPONENT_BYTES[componentType] ?? 0);
    const view = this.bufferViews[bufferView];
    if (view === undefined) throw new RangeError(`accessor cites buffer view ${bufferView}, which does not exist`);
    if (count * stride !== view['byteLength']) {
      throw new RangeError(`accessor of ${count} ${type} (${count * stride} B) does not fill buffer view ${bufferView} (${String(view['byteLength'])} B)`);
    }
    const accessor: Json = { bufferView, componentType, count, type };
    if (opts.normalized) accessor['normalized'] = true;
    if (opts.min) accessor['min'] = opts.min;
    if (opts.max) accessor['max'] = opts.max;
    return this.accessors.push(accessor) - 1;
  }

  /** Embeds an already-encoded PNG as an image backed by a buffer view (§5.15). */
  addImage(png: Uint8Array, name?: string): number {
    const image: Json = { bufferView: this.addBufferView(png), mimeType: 'image/png' };
    if (name !== undefined) image['name'] = name;
    return this.images.push(image) - 1;
  }

  /** Declares an extension once; repeated names collapse. */
  useExtension(name: string): void {
    if (!this.extensionsUsed.includes(name)) this.extensionsUsed.push(name);
  }

  /** The finished `.glb` bytes. The writer is not reusable afterwards only in the sense that a second call
   *  re-serialises the same state; nothing is consumed. */
  finish(): Uint8Array {
    const bin = new Uint8Array(this.binLength);
    let at = 0;
    for (const part of this.bin) { bin.set(part, at); at += part.byteLength; }

    const doc: Json = { asset: { version: '2.0', generator: this.generator } };
    if (this.extensionsUsed.length > 0) doc['extensionsUsed'] = this.extensionsUsed;
    doc['scene'] = 0;
    doc['scenes'] = [{ nodes: this.roots }];
    for (const [key, array] of [
      ['nodes', this.nodes], ['meshes', this.meshes], ['materials', this.materials], ['textures', this.textures],
      ['images', this.images], ['samplers', this.samplers], ['accessors', this.accessors], ['bufferViews', this.bufferViews],
    ] as const) {
      if (array.length > 0) doc[key] = array;               // §3.6: a present array must not be empty
    }
    if (bin.byteLength > 0) doc['buffers'] = [{ byteLength: bin.byteLength }];

    const json = new TextEncoder().encode(JSON.stringify(doc));
    const jsonPadded = json.byteLength + pad(json.byteLength);
    const binPadded = bin.byteLength + pad(bin.byteLength);   // already aligned, but the spec asks explicitly
    const total = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonPadded + (binPadded > 0 ? CHUNK_HEADER_BYTES + binPadded : 0);

    const out = new Uint8Array(total).fill(0x20, HEADER_BYTES + CHUNK_HEADER_BYTES, HEADER_BYTES + CHUNK_HEADER_BYTES + jsonPadded);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, MAGIC, true); dv.setUint32(4, VERSION, true); dv.setUint32(8, total, true);
    dv.setUint32(12, jsonPadded, true); dv.setUint32(16, JSON_CHUNK, true);
    out.set(json, HEADER_BYTES + CHUNK_HEADER_BYTES);
    if (binPadded > 0) {
      const chunk = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonPadded;
      dv.setUint32(chunk, binPadded, true); dv.setUint32(chunk + 4, BIN_CHUNK, true);
      out.set(bin, chunk + CHUNK_HEADER_BYTES);
    }
    return out;
  }
}
