import { Frame, type BodyState, type Command, type CommandBatch, type DoorWire, type OwnState, type Snapshot } from './protocol';

/**
 * The binary frames (web sprint 3, M3): the commands up and the snapshots down, little-endian, quantised where the
 * game's own precision allows (`./protocol` names the steps). Positions stay float32: a map is a few thousand units
 * across, so float32 keeps a thousandth of a unit, and the mover's own state is float64 only in the sim.
 *
 * Sizes: a command is 15 bytes, a batch of 3 is 51; a body is 55 bytes and a door 2, so a snapshot of 15 bodies and one's
 * own is 861 bytes on a map without doors and 867 on Frostfire (three) -- 26 KB/s at 30 Hz per client, before the
 * WebSocket's framing.
 */

class Writer {
  private buf = new ArrayBuffer(256);
  private view = new DataView(this.buf);
  private at = 0;

  private need(n: number): void {
    if (this.at + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.at + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.at));
    this.buf = next;
    this.view = new DataView(next);
  }
  u8(v: number): void { this.need(1); this.view.setUint8(this.at, v); this.at += 1; }
  i8(v: number): void { this.need(1); this.view.setInt8(this.at, v); this.at += 1; }
  u16(v: number): void { this.need(2); this.view.setUint16(this.at, v, true); this.at += 2; }
  i16(v: number): void { this.need(2); this.view.setInt16(this.at, v, true); this.at += 2; }
  u32(v: number): void { this.need(4); this.view.setUint32(this.at, v >>> 0, true); this.at += 4; }
  f32(v: number): void { this.need(4); this.view.setFloat32(this.at, v, true); this.at += 4; }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.at).slice(); }
}

class Reader {
  private readonly view: DataView;
  private at = 0;
  constructor(bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  private take(n: number): number {
    const at = this.at;
    if (at + n > this.view.byteLength) throw new RangeError(`frame too short: ${this.view.byteLength} bytes`);
    this.at += n;
    return at;
  }
  u8(): number { return this.view.getUint8(this.take(1)); }
  i8(): number { return this.view.getInt8(this.take(1)); }
  u16(): number { return this.view.getUint16(this.take(2), true); }
  i16(): number { return this.view.getInt16(this.take(2), true); }
  u32(): number { return this.view.getUint32(this.take(4), true); }
  f32(): number { return this.view.getFloat32(this.take(4), true); }
  get left(): number { return this.view.byteLength - this.at; }
}

// ---- the quantisers (each exported, so the client can predict with what the server will read) ------------------

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** The stick: -1..1 to 1/127. */
export const qStick = (v: number): number => Math.round(clamp(v, -1, 1) * 127) || 0;
export const dqStick = (q: number): number => q / 127;
/** A yaw, degrees, to 1/182 (0..65535 for a turn); read back in 0..360. */
export const qYaw = (deg: number): number => Math.round((((deg % 360) + 360) % 360) * (65536 / 360)) & 0xffff;
export const dqYaw = (q: number): number => (q * 360) / 65536;
/** A pitch, degrees, -90..90 to 1/100. */
export const qPitch = (deg: number): number => Math.round(clamp(deg, -90, 90) * 100) || 0;
export const dqPitch = (q: number): number => q / 100;
/** A turn rate, radians a second, to 1/1000 (+-32). */
export const qTurn = (v: number): number => Math.round(clamp(v, -32, 32) * 1000) || 0;
export const dqTurn = (q: number): number => q / 1000;
/** A speed, units a second, to 1/64 (+-512). */
const qSpeed = (v: number): number => Math.round(clamp(v, -511.98, 511.98) * 64);
const dqSpeed = (q: number): number => q / 64;
/** Seconds to milliseconds, 0..65534; 65535 is none. */
const qSeconds = (s: number | null): number => (s === null || !Number.isFinite(s) || s < 0 ? 0xffff : Math.min(0xfffe, Math.round(s * 1000)));
const dqSeconds = (q: number): number => (q === 0xffff ? -1 : q / 1000);

/** A command as the server will read it: the quantisers applied (the client predicts with this, not the raw input). */
export function quantiseCommand(c: Command): Command {
  return {
    ...c,
    forward: dqStick(qStick(c.forward)), right: dqStick(qStick(c.right)),
    yaw: dqYaw(qYaw(c.yaw)), pitch: dqPitch(qPitch(c.pitch)), turn: dqTurn(qTurn(c.turn)),
  };
}

// ---- commands ---------------------------------------------------------------------------------------------------

/** `Frame.Commands`: u8 kind, f32 view tick, u8 count, then per command u32 seq, i8 x2, u16 yaw, i16 pitch, i16 turn, u16 buttons, u8 stance|weapon<<4. */
export function encodeCommands(batch: CommandBatch): Uint8Array {
  const w = new Writer();
  w.u8(Frame.Commands);
  w.f32(batch.viewTick);
  const list = batch.commands.slice(-255);
  w.u8(list.length);
  for (const c of list) {
    w.u32(c.seq);
    w.i8(qStick(c.forward)); w.i8(qStick(c.right));
    w.u16(qYaw(c.yaw)); w.i16(qPitch(c.pitch)); w.i16(qTurn(c.turn));
    w.u16(c.buttons & 0xffff);
    w.u8((c.stance & 0x0f) | ((c.weapon & 0x0f) << 4));
  }
  return w.bytes();
}

export function decodeCommands(bytes: Uint8Array): CommandBatch {
  const r = new Reader(bytes);
  if (r.u8() !== Frame.Commands) throw new Error('not a command frame');
  const viewTick = r.f32();
  const n = r.u8();
  const commands: Command[] = [];
  for (let i = 0; i < n; i++) {
    const seq = r.u32(), forward = dqStick(r.i8()), right = dqStick(r.i8()), yaw = dqYaw(r.u16()), pitch = dqPitch(r.i16());
    const turn = dqTurn(r.i16()), buttons = r.u16(), sw = r.u8();
    commands.push({ seq, forward, right, yaw, pitch, turn, buttons, stance: sw & 0x0f, weapon: sw >> 4 });
  }
  return { viewTick, commands };
}

// ---- snapshots --------------------------------------------------------------------------------------------------

function writeBody(w: Writer, b: BodyState): void {
  w.u8(b.id);
  w.f32(b.feet[0]); w.f32(b.feet[1]); w.f32(b.feet[2]);
  w.u16(qYaw(b.yaw)); w.i16(qPitch(b.pitch));
  w.i16(qSpeed(b.vx)); w.i16(qSpeed(b.vy)); w.i16(qSpeed(b.vz));
  w.u16(b.flags);
  w.u8((b.stance & 3) | ((b.landing & 3) << 2) | ((b.ground & 3) << 4) | ((b.weapon & 1) << 6) | (((b.stickSnaps ?? 0) & 1) << 7));
  w.u8(b.jumps & 0xff);
  w.i8(qStick(b.groundForward)); w.i8(qStick(b.groundRight)); w.i8(b.groundCls);
  w.u8(b.action); w.u8(b.actionSerial & 0xff); w.u16(qSeconds(b.actionT)); w.u16(qSeconds(b.actionSeconds < 0 ? null : b.actionSeconds));
  w.u8(b.overlay); w.u16(qSeconds(b.overlayT)); w.u16(qSeconds(b.overlaySeconds));
  w.i16(qTurn(b.turnRate));
  w.u8(b.trav); w.f32(b.travFrame); w.f32(b.travRootY); w.u8(b.travBlend); w.u8(Math.round(clamp(b.travBlendWeight, 0, 1) * 255));
  w.i8(b.peek);
}

function readBody(r: Reader): BodyState {
  const id = r.u8();
  const feet: [number, number, number] = [r.f32(), r.f32(), r.f32()];
  const yaw = dqYaw(r.u16()), pitch = dqPitch(r.i16());
  const vx = dqSpeed(r.i16()), vy = dqSpeed(r.i16()), vz = dqSpeed(r.i16());
  const flags = r.u16();
  const packed = r.u8();
  const jumps = r.u8();
  const groundForward = dqStick(r.i8()), groundRight = dqStick(r.i8()), groundCls = r.i8();
  const action = r.u8(), actionSerial = r.u8(), actionT = dqSeconds(r.u16()), actionSeconds = dqSeconds(r.u16());
  const overlay = r.u8(), overlayT = dqSeconds(r.u16()), overlaySeconds = dqSeconds(r.u16());
  const turnRate = dqTurn(r.i16());
  const trav = r.u8(), travFrame = r.f32(), travRootY = r.f32(), travBlend = r.u8(), travBlendWeight = r.u8() / 255;
  const peek = r.i8();
  return {
    id, feet, yaw, pitch, vx, vy, vz, flags,
    stance: packed & 3, landing: (packed >> 2) & 3, ground: (packed >> 4) & 3, weapon: (packed >> 6) & 1, stickSnaps: (packed >> 7) & 1,
    jumps, groundForward, groundRight, groundCls, action, actionSerial, actionT, actionSeconds, overlay, overlayT, overlaySeconds,
    turnRate, trav, travFrame, travRootY, travBlend, travBlendWeight, peek,
  };
}

/**
 * `Frame.Snapshot`: u8 kind, u32 tick, u8 has-own, [u32 ack, f32 x y z, f32 vx vy vz], u8 count, bodies, then (protocol
 * 2) u8 door count and two bytes a door (`DoorWire`: its valve, its swing's phase). The own state is float32 whole: it
 * is what prediction is compared with, to the thousandth.
 */
export function encodeSnapshot(s: Snapshot): Uint8Array {
  const w = new Writer();
  w.u8(Frame.Snapshot);
  w.u32(s.tick);
  w.u8(s.own ? 1 : 0);
  if (s.own) {
    const o = s.own;
    w.u32(o.ack);
    w.f32(o.x); w.f32(o.y); w.f32(o.z);
    w.f32(o.vx); w.f32(o.vy); w.f32(o.vz);
  }
  w.u8(s.bodies.length);
  for (const b of s.bodies) writeBody(w, b);
  const doors = (s.doors ?? []).slice(0, 255);
  w.u8(doors.length);
  for (const d of doors) { w.u8(clamp(Math.round(d.valve), 0, 255)); w.u8(clamp(Math.round(d.phase), 0, 255)); }
  return w.bytes();
}

export function decodeSnapshot(bytes: Uint8Array): Snapshot {
  const r = new Reader(bytes);
  if (r.u8() !== Frame.Snapshot) throw new Error('not a snapshot frame');
  const tick = r.u32();
  let own: OwnState | null = null;
  if (r.u8()) own = { ack: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), vx: r.f32(), vy: r.f32(), vz: r.f32() };
  const n = r.u8();
  const bodies: BodyState[] = [];
  for (let i = 0; i < n; i++) bodies.push(readBody(r));
  const doors: DoorWire[] = [];
  const d = r.u8();
  for (let i = 0; i < d; i++) doors.push({ valve: r.u8(), phase: r.u8() });
  if (r.left !== 0) throw new Error(`snapshot has ${r.left} trailing bytes`);
  return doors.length ? { tick, own, bodies, doors } : { tick, own, bodies };
}

/** The first byte of a binary frame: its `Frame` kind, or null for an empty frame. */
export function frameKind(bytes: Uint8Array): number | null {
  return bytes.byteLength ? bytes[0]! : null;
}
