/** Little-endian scalar reads over a Uint8Array view. Every archive reader goes through this class. */
export class Reader {
  private readonly view: DataView;
  constructor(public readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get length(): number { return this.bytes.byteLength; }
  private check(o: number, n: number): void {
    if (o < 0 || o + n > this.bytes.byteLength) throw new RangeError(`read ${n} at ${o} beyond ${this.bytes.byteLength}`);
  }
  u8(o: number): number { this.check(o, 1); return this.view.getUint8(o); }
  u16(o: number): number { this.check(o, 2); return this.view.getUint16(o, true); }
  u32(o: number): number { this.check(o, 4); return this.view.getUint32(o, true); }
  i32(o: number): number { this.check(o, 4); return this.view.getInt32(o, true); }
  i16(o: number): number { this.check(o, 2); return this.view.getInt16(o, true); }
  f32(o: number): number { this.check(o, 4); return this.view.getFloat32(o, true); }
  u64(o: number): bigint { this.check(o, 8); return this.view.getBigUint64(o, true); }
  cstr(o: number, max: number): string {
    this.check(o, max);
    let end = o;
    while (end < o + max && this.bytes[end] !== 0) end++;
    return String.fromCharCode(...this.bytes.subarray(o, end));
  }
  slice(o: number, n: number): Uint8Array { this.check(o, n); return this.bytes.subarray(o, o + n); }
}
