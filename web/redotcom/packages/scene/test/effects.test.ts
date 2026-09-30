import { describe, expect, it } from 'vitest';
import { parseZdb, zdbMember, Zar } from '@s2u/archive';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import {
  CmdBytes, decodeEffectOp, lightAt, lightRange, NODE_CALLER, decodeEffectProgram, frictionFactor, keyAt, launchDirection, launchMotion, MOTION,
  parseAnimSets, particleColour, particleFade, particleScale, sourceVelocity, stepMotion, terminalFactor, tracerRound,
  ZANIM_COMMAND_NAMES, ZCMD,
  type EffectProgram, type MotionWorld, type ZAnimLight, type ObjectMotion, type ParticleSource,
} from '../src/index';

/**
 * The zAnim effect commands (web/redotcom/docs/research/89): the numbering, the control-flow and state commands decoded from
 * their bytes, `OBJECT_MOTION`'s launch and flight, `PARTICLE_SOURCE`'s keys and fades -- and, on the game's own
 * archives where the fixtures are, the M4A1 SD's `muzzle_m4SD`, `shell_eject` and `shell_smoke_med` read to the
 * numbers the decomp gives them.
 */

/** A command's bytes: the header (type, size) then `payload`. */
function cmd(type: number, payload: number[]): { set: number; cmd: number; bytes: Uint8Array } {
  const bytes = new Uint8Array(4 + payload.length);
  new DataView(bytes.buffer).setUint32(0, (type & 0xffff) | (bytes.length << 18), true);
  bytes.set(payload, 4);
  return { set: 0, cmd: type & 0xff, bytes };
}
const f32 = (v: number): number[] => Array.from(new Uint8Array(Float32Array.of(v).buffer));
const u32 = (v: number): number[] => Array.from(new Uint8Array(Uint32Array.of(v).buffer));

describe('the command numbering', () => {
  it('is FUN_0025bc20\'s registration order, from 1', () => {
    expect(ZANIM_COMMAND_NAMES[ZCMD.IF]).toBe('IF');
    expect(ZANIM_COMMAND_NAMES[ZCMD.OBJECT_MOTION]).toBe('OBJECT_MOTION');
    expect(ZANIM_COMMAND_NAMES[ZCMD.PARTICLE_SOURCE]).toBe('PARTICLE_SOURCE');
    expect(ZANIM_COMMAND_NAMES[ZCMD.SOUND]).toBe('SOUND');                  // research 81's play-sound, 30
    expect(ZANIM_COMMAND_NAMES[ZCMD.LIGHT]).toBe('LIGHT');
    expect(ZANIM_COMMAND_NAMES[ZCMD.CALL_ANIMATION]).toBe('CALL_ANIMATION');
    expect(ZANIM_COMMAND_NAMES[ZCMD.VALVE]).toBe('VALVE');
  });
});

describe('the small commands, from their bytes', () => {
  const names = ['NA', 'anim', 'shell_eject', 'rotate', '.JUMP_WHOOSH'];
  it('CALL_ANIMATION names its animation in the byte at +7', () => {
    expect(decodeEffectOp(cmd(ZCMD.CALL_ANIMATION, [1, 0, 0, 2, ...new Array(12).fill(0)]), names)).toEqual({ op: 'call', anim: 'shell_eject' });
  });
  it('SOUND names its sound in the u16 at +6 (research 81 §6)', () => {
    expect(decodeEffectOp(cmd(ZCMD.SOUND, [0x82, 0, 4, 0, ...new Array(24).fill(0)]), names)).toMatchObject({ op: 'sound', sound: '.JUMP_WHOOSH' });
  });
  it('SOUND carries its own volume: the f32 at +8 with flag 0x10, else 1.0 (FUN_002659c0 112363-112416; research 81 §12)', () => {
    const payload = (flags: number, v: number): number[] => [flags & 0xff, flags >> 8, 4, 0, ...f32(v), ...new Array(20).fill(0)];
    expect(decodeEffectOp(cmd(ZCMD.SOUND, payload(0x92, 3)), names)).toMatchObject({ op: 'sound', sound: '.JUMP_WHOOSH', volume: 3 });
    expect(decodeEffectOp(cmd(ZCMD.SOUND, payload(0x292, 0.6)), names)).toMatchObject({ volume: expect.closeTo(0.6, 6) });
    expect(decodeEffectOp(cmd(ZCMD.SOUND, payload(0x82, 3)), names)).toMatchObject({ volume: 1 });   // no 0x10: the game's 1.0
  });
  it('an IF\'s conditions: RANDOM_WEIGHT\'s probability, as flash_fire_hider picks its turn', () => {
    const rw = [0x0a, 0, 0x22, 0, ...f32(0.125)];
    expect(decodeEffectOp(cmd(ZCMD.IF, [...u32(1), ...rw]), names)).toEqual({ op: 'if', conditions: [{ kind: 'random', p: 0.125 }] });
  });
  it('WAIT: seconds (the f32 at +8), or frames with flag 0x10', () => {
    expect(decodeEffectOp(cmd(ZCMD.WAIT, [9, 0, 0, 0, ...f32(0.25)]), names)).toEqual({ op: 'wait', seconds: 0.25, range: 0, frames: null });
    expect(decodeEffectOp(cmd(ZCMD.WAIT, [0x10, 0, 0, 0, ...u32(1)]), names)).toEqual({ op: 'wait', seconds: 0, range: 0, frames: 1 });
  });
  it('OBJECT_ROTATE_STATE: node +6, reference +7, flags +4, euler +8', () => {
    const op = decodeEffectOp(cmd(ZCMD.OBJECT_ROTATE_STATE, [1, 0, 3, 0, ...f32(Math.PI / 4), ...f32(0), ...f32(0)]), names);
    expect(op).toMatchObject({ op: 'rotate', node: 3, ref: 0, flags: 1 });
    expect((op as { xyz: number[] }).xyz[0]).toBeCloseTo(Math.PI / 4, 6);
  });
  it('reads past a short command as 0 rather than throwing', () => {
    expect(new CmdBytes(new Uint8Array(4)).f32(100)).toBe(0);
  });
});

describe('OBJECT_MOTION\'s arithmetic (FUN_00262690, FUN_00261370)', () => {
  it('the launch direction is FUN_0025cb00\'s, not normalised', () => {
    const d = launchDirection(180, 30);
    expect(d[0]).toBeCloseTo(0, 9);
    expect(d[1]).toBeCloseTo(1 / 3, 9);
    expect(d[2]).toBeCloseTo(2 / 3, 9);                  // az 180: local +z
    expect(Math.hypot(...d)).toBeCloseTo(0.745, 3);
  });

  it('the terminal-velocity table is 1 rising and falls to 0 at |v| = 1/|k|', () => {
    expect(terminalFactor(5, -1 / 980)).toBe(1);           // rising: index 0
    expect(terminalFactor(-100, -1 / 980)).toBeCloseTo(1 - (Math.exp(1) - 1) / (Math.exp(10) - 1), 9);
    expect(terminalFactor(-980, -1 / 980)).toBeCloseTo(0, 9);
  });

  const casing: ObjectMotion = {
    flags: MOTION.LIFETIME | MOTION.TERMINAL | MOTION.RANDOM_LAUNCH | MOTION.IMPACT_SOUND | MOTION.FLOOR_PROBE | MOTION.LINE_PROBE | MOTION.TUMBLE,
    node: -7, frame: -6, direction: [0, 0, 0], launch: { azimuth: 170, zenith: 30, speed: 25, accel: 0 }, range: { azimuth: 20, zenith: 0, speed: 10, accel: 0 },
    gravityScale: 1, terminal: -1 / 980, callerVelocity: 1, bounce: 0.3, tolerance: 0.35, lifetime: 1.2, refSpeed: 0, sound: null,
    tumble: { rate: 0.5236, accel: -0.0873 }, angular: null,
    materials: [{ material: 25, sound: '.BUL_CASE_METAL', sequence: null, refSpeed: null, bounce: 0.35 }],
  };
  const floor: MotionWorld = {
    segment: (a, b) => (b[1] <= 0 && a[1] > 0 ? { point: [a[0] + (b[0] - a[0]) * (a[1] / (a[1] - b[1])), 0, a[2] + (b[2] - a[2]) * (a[1] / (a[1] - b[1]))], normal: [0, 1, 0], material: 25 } : null),
    floor: (from) => ({ point: [from[0], 0, from[2]], normal: [0, 1, 0], material: 25 }),
  };

  it('launches the casing at 25-35 units a second into its frame, at the -98 gravity', () => {
    const s = launchMotion(casing, [0, 10, 0], null, () => 0, -98, 0.14);
    expect(s.velocity[1]).toBeCloseTo(25 / 3, 6);
    expect(s.velocity[2]).toBeCloseTo(-Math.cos((170 * Math.PI) / 180) * (2 / 3) * 25, 6);
    expect(s.accel).toEqual([0, -98, 0]);
    expect(s.halfHeight).toBeCloseTo(0.07, 9);
    expect(s.tolerance).toBeCloseTo(0.049, 9);
  });

  it('falls, bounces on the metal with its coefficient and its sound, and is done at rest or at 1.2 s', () => {
    const s = launchMotion(casing, [0, 10, 0], null, () => 0.5, -98, 0.14);
    const bounces: string[] = [];
    let t = 0;
    while (!s.done && t < 3) {
      for (const b of stepMotion(casing, s, 1 / 60, floor)) bounces.push(b.entry?.sound ?? 'none');
      t += 1 / 60;
    }
    expect(bounces.length).toBeGreaterThan(0);
    expect(bounces[0]).toBe('.BUL_CASE_METAL');
    expect(t).toBeLessThanOrEqual(1.2 + 1e-6);
    expect(s.position[1]).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.abs(s.euler[0]) + Math.abs(s.euler[2])).toBeGreaterThan(0);   // it tumbled
  });

  it('without a world it flies through, its lifetime its end', () => {
    const s = launchMotion(casing, [0, 10, 0], null, () => 0.5, -98, 0.14);
    let t = 0;
    while (!s.done && t < 3) { stepMotion(casing, s, 1 / 60, null); t += 1 / 60; }
    expect(t).toBeCloseTo(1.2, 1);
    expect(s.position[1]).toBeLessThan(0);
  });
});

describe('PARTICLE_SOURCE\'s keys and fades', () => {
  const src = {
    colours: [[0, 0.4, 0.4, 0.5, 1], [0.1, 0.4, 0.4, 0.5, 1.1], [0.6, 0.4, 0.4, 0.5, 0.05], [1, 0.4, 0.4, 0.5, 0]] as ParticleSource['colours'],
    scales: [[0, 0.1], [0.7, 20], [1, 20]] as ParticleSource['scales'],
    nearFade: null, farFade: [200, 800] as [number, number],
  };
  it('interpolates the keys linearly, clamped at both ends; no colour keys is white fading with its life', () => {
    expect(keyAt(src.scales, -1, 1)).toBeCloseTo(0.1, 6);
    expect(particleScale(src, 0.35)).toBeCloseTo(0.1 + (20 - 0.1) * 0.5, 4);
    expect(particleColour(src, 0.05)[3]).toBeCloseTo(1.05, 6);          // the game's alpha goes over 1
    expect(particleColour({ colours: [] }, 0.25)).toEqual([1, 1, 1, 0.75]);
    expect(particleScale({ scales: [] }, 0.5)).toBe(1);
  });
  it('fades on squared distance across the far pair', () => {
    expect(particleFade(src, 100 ** 2)).toBe(1);
    expect(particleFade(src, 900 ** 2)).toBe(0);
    expect(particleFade(src, 500 ** 2)).toBeCloseTo((800 ** 2 - 500 ** 2) / (800 ** 2 - 200 ** 2), 9);
  });
  it('the friction factor is FUN_003282b0\'s 1/P(k dt), about exp(-k dt / 2) when small', () => {
    expect(frictionFactor(0, 1)).toBe(1);
    expect(frictionFactor(0.1, 0.1)).toBeCloseTo(Math.exp(-0.005), 4);
    expect(frictionFactor(60, 1 / 60)).toBeLessThan(1);
  });
  it('a velocity from the context: the normal, the round\'s direction made a unit, or that reflected', () => {
    const ctx = { velocity: [0, 0, -10] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    expect(sourceVelocity('normal', [0, 0, 0], 5, false, ctx)).toEqual([0, 0, 5]);
    expect(sourceVelocity('velocity', [0, 0, 0], 2, true, ctx)).toEqual([0, 0, -2]);
    expect(sourceVelocity('reflected', [0, 0, 0], 2, true, ctx)).toEqual([0, 0, 2]);
    expect(sourceVelocity('fixed', [1, 2, 3], 9, false, ctx)).toEqual([1, 2, 3]);
  });
});

describe('the light pass (the VU1 handler at 0x23d8)', () => {
  it('falls off with the light height over the surface and is gated by the side it faces', () => {
    expect(lightAt([0, 10, 0], [0, 1, 0], [0, 100])).toEqual({ f: 0.5 * 0.9, gate: 1 });
    expect(lightAt([0, 150, 0], [0, 1, 0], [0, 100]).f).toBe(0);
    expect(lightAt([0, -10, 0], [0, 1, 0], [0, 100]).gate).toBe(0);  // behind the surface
    expect(lightAt([0, 0.5, 0], [0, 1, 0], [0, 100]).gate).toBe(0.5);
  });
});

describe('the tracers (FUN_003cb1a0, FUN_003c5ac0, FUN_003cabe0)', () => {
  it('every fourth round of a tracer weapon, never the suppressed ones', () => {
    expect([1, 2, 3, 4, 5, 8].map((r) => tracerRound(54, r))).toEqual([false, false, false, true, false, true]);   // M4A1
    expect([4, 8].map((r) => tracerRound(62, r))).toEqual([false, false]);                                       // M4A1 SD
    expect(tracerRound(10, 4)).toBe(false);                                                                       // a pistol
  });
});

const MP2 = fixture('RUN/MP2.ZDB');

describe.skipIf(!MP2)(`the M4A1 SD's muzzle effect on Frostfire's CZANIM${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  const programs = new Map<string, EffectProgram>();
  if (MP2) {
    const toc = parseZdb(MP2);
    for (const member of ['CZANIM.ZAR', 'MZANIM.ZAR']) {
      for (const set of parseAnimSets(Zar.parse(zdbMember(MP2, toc, member))).sets) for (const a of set.anims) if (!programs.has(a.name)) programs.set(a.name, decodeEffectProgram(a));
    }
  }
  const ops = (name: string) => programs.get(name)!.sequences.flatMap((s) => s.ops);

  it('muzzle_m4SD calls shell_eject and shell_smoke_med; muzzle_m4 adds flash_fire_hider; the _zoom variants', () => {
    expect(ops('muzzle_m4SD')).toEqual([{ op: 'call', anim: 'shell_eject' }, { op: 'call', anim: 'shell_smoke_med' }]);
    expect(ops('muzzle_m4').map((o) => (o.op === 'call' ? o.anim : o.op))).toEqual(['shell_eject', 'flash_fire_hider', 'shell_smoke_med']);
    expect(ops('muzzle_m4SD_zoom').map((o) => (o.op === 'call' ? o.anim : o.op))).toEqual(['zoom_fire_silent', 'shell_smoke_med']);
    expect(ops('muzzle_m4_zoom').map((o) => (o.op === 'call' ? o.anim : o.op))).toEqual(['zoom_flash_fire', 'shell_smoke_med']);
  });

  it('shell_eject: 170-190 degrees, 30 up, 25-35 a second, -98 x 1, bounce 0.3, 1.2 s, the per-material table', () => {
    const [full, cheap] = ops('shell_eject').filter((o) => o.op === 'motion').map((o) => (o as { motion: ObjectMotion }).motion);
    expect(full!.flags).toBe(0x0cf3);
    expect(full!.launch).toEqual({ azimuth: 170, zenith: 30, speed: 25, accel: 0 });
    expect(full!.range).toEqual({ azimuth: 20, zenith: 0, speed: 10, accel: 0 });
    expect(full!.gravityScale).toBe(1);
    expect(full!.bounce).toBeCloseTo(0.3, 6);
    expect(full!.lifetime).toBeCloseTo(1.2, 6);
    expect(full!.tumble!.rate).toBeCloseTo(Math.PI / 6, 4);
    expect(full!.materials.map((m) => [m.material, m.sound, +m.bounce!.toFixed(2)])).toEqual([
      [25, '.BUL_CASE_METAL', 0.35], [26, '.BUL_CASE_METAL', 0.35], [7, '.BUL_CAS_STONE', 0.25], [22, '.BUL_CAS_STONE', 0.25],
      [4, '.BUL_CAS_DIRT', 0.1], [8, '.BUL_CAS_DIRT', 0.15], [5, '.BUL_CAS_SAND', 0.15], [19, '.BUL_CAS_WOOD', 0.27], [20, '.BUL_CAS_WOOD', 0.27],
    ]);
    expect(cheap!.flags).toBe(0x0c13);
    expect(cheap!.lifetime).toBeCloseTo(0.7, 6);
    expect(cheap!.materials).toEqual([]);
    // The valve around them: bullet_ejecting counted up, tested under 5.
    expect(ops('shell_eject')[0]).toEqual({ op: 'valve', valve: 'bullet_ejecting', operation: 0x0c, operand: 1 });
  });

  it('shell_smoke_med\'s source is switched off in the data (flags A 0x37ffbfd1: bit 1 set, bit 2 clear)', () => {
    const src = ops('shell_smoke_med').find((o) => o.op === 'particles') as { source: ParticleSource };
    expect(src.source.flagsA).toBe(0x37ffbfd1);
    expect(src.source.setActive).toBe(false);
    expect(src.source.name).toBe('blue_smoke01');
    expect(src.source.texture).toBe('cloudpuff01.tif');
    expect(src.source.lifetime.map((v) => +v.toFixed(2))).toEqual([0.5, 1]);
    // shell_smoke_big, the same role, is on.
    const big = ops('shell_smoke_big').find((o) => o.op === 'particles') as { source: ParticleSource };
    expect(big.source.setActive).toBe(true);
  });

  it('the lights: light_flash_large adds a 100-190 spot shrinking to nothing by 0.5 s; zoom_flash_fire is at the caller', () => {
    const big = ops('light_flash_large').find((o) => o.op === 'light') as { light: ZAnimLight };
    expect(big.light.blend).toBe(0x48);                               // additive
    expect(big.light.atContext).toBe(true);
    expect(big.light.rgb.map((v) => +v.toFixed(2))).toEqual([214.2, 242.25, 216.75]);
    expect(big.light.opacity).toBe(64);
    expect(big.light.duration).toBe(1);
    expect(lightRange(big.light, 0)).toEqual([100, 190]);
    expect(lightRange(big.light, 0.25)).toEqual([50, 95]);
    expect(lightRange(big.light, 0.6)).toEqual([0, 0]);
    const muzzle = ops('zoom_flash_fire').find((o) => o.op === 'light') as { light: ZAnimLight };
    expect(muzzle.light.node).toBe(NODE_CALLER);
    expect(muzzle.light.blend).toBe(0x44);
    expect(muzzle.light.ranges.map((k) => k.map((v) => +v.toFixed(2)))).toEqual([[0, 5, 12], [0.05, 15, 60], [0.1, 0, 0]]);
  });

  it('FRAG_sparks throws its spark node by a fixed launch: +0x54 is the direction, block A the speed and the pull', () => {
    const m = ops('FRAG_sparks').find((o) => o.op === 'motion') as { motion: ObjectMotion };
    expect(m.motion.flags).toBe(0x0b);
    expect(m.motion.direction.map((v) => +v.toFixed(3))).toEqual([0, 0.556, -0.444]);
    const s = launchMotion(m.motion, [0, 0, 0], null, () => 0, -98, 0);
    expect(s.velocity).toEqual([0, 0, 0]);                           // speed 0
    expect(s.accel[1]).toBeCloseTo(0.5556 * -200 - 98, 1);           // pulled along the direction by -200, and gravity
    expect(s.accel[2]).toBeCloseTo(-0.4444 * -200, 1);
  });

  it('bullet_hit_metal_thick sparks (streaked, reflected off the surface); bullet_hit_asphalt calls bullet_hit_stone', () => {
    const sparks = ops('bullet_hit_metal_thick').filter((o) => o.op === 'particles').map((o) => (o as { source: ParticleSource }).source)
      .find((s) => s.name === 'sparks')!;
    expect(sparks.type).toBe(3);
    expect(sparks.baseFrom).toBe('reflected');
    expect(sparks.atContext).toBe(true);
    expect(sparks.texture).toBe('effect_spark01.tif');
    expect(ops('bullet_hit_asphalt')).toEqual([{ op: 'call', anim: 'bullet_hit_stone' }]);
  });
});
