import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGrid, PLACE_CLAYMORE_ANIM, SEAL_TUNING, THROW_ANIMS, type CollisionOwner, type GridParams, type WorldPoly } from '@s2u/scene';
import { FlyCamera } from '../src/camera';
import { clipsFromPack, motionTableFromArchive } from '../src/motionTable';
import {
  actionRoots, HOLD_CLIPS, HOLD_CODES, HOLD_SECONDS, reloadHold, SCOPED_STICK, TICK, Walker, type HoldClip, type WalkInput,
} from '../src/mover';
import { MoverSim } from '../src/net/moverSim';
import { decodeCommands, encodeCommands } from '../src/net/codec';
import { Button, HOLD_SHIFT, holdBits, holdOf, type Command } from '../src/net/protocol';
import { packGround, WalkMode, type GroundData } from '../src/walk';
import { SCOPE_SLOW } from '../src/zoom';

/**
 * The movement locks (the owner, 2026-09-29: "SOCOM should lock your movement when throwing a grenade or planting
 * certain equipment") and the scoped stick (research 84 section 17). The game's rule, read in the header of
 * `HOLD_CLIPS` (`./mover`): a throw, the claymore's placing and the crouched and prone reloads are one-shots pushed on
 * the actor's action stack (`FUN_00588bc0`); while a one-shot is on top the ground state does not run
 * (`FUN_00550ef0` 418172-418246, `FUN_005870e0` only on a cut), so the SEAL moves by the clip's root alone -- and the
 * stick cuts it only past the clip's `NoInterrupt` (`FUN_00587c20`). The scope's x 0.2 is the controller's, on the move
 * stick before anything reads it (`FUN_005966a0` 453818-453821).
 */

const RUN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures/RUN');
const READERC = resolve(RUN, 'READERC.ZAR'), PACK = resolve(RUN, 'MOTION_P.ZAR');
const noDisc = !existsSync(READERC) || !existsSync(PACK);

function floor(): WorldPoly {
  return {
    modelName: 'worldmodel', path: 'worldmodel/floor', region: 0, ditype: 3, material: 25, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-400, 0, -400, 400, 0, -400, 400, 0, 400, -400, 0, 400]),
  };
}
const PARAMS: GridParams = { atomCount: 8192, posts: 16, cellDim: 200, cellsX: 4, cellsZ: 4, originX: -400, originZ: -400 };
const OWNERS: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/floor0', first: 0, count: 1 }];
const plain = buildGrid(PARAMS, [], [], [floor()], OWNERS);

const FORWARD: WalkInput = { forward: 1, right: 0, boost: false };
const STILL: WalkInput = { forward: 0, right: 0, boost: false };

function walker(): Walker {
  const w = new Walker(plain);
  w.place(0, 10, 0);
  return w;
}

/** The phase a one-shot of `clip` is at `t` seconds in: `t / (playback (n - 1) / n)` (`FUN_0028c4f0`). */
const phaseAt = (clip: HoldClip, t: number): number => t / (HOLD_CLIPS[clip].playback * ((HOLD_CLIPS[clip].frames - 1) / HOLD_CLIPS[clip].frames));

describe.skipIf(noDisc)(`HOLD_CLIPS are the disc's${noDisc ? ' (READERC.ZAR or MOTION_P.ZAR absent)' : ''}`, () => {
  it("motion.rdr's playback and NoInterrupt, MOTION_P.ZAR's key counts and root travel; none a BlendOverlay or looped", () => {
    const table = motionTableFromArchive(new Uint8Array(readFileSync(READERC)))!;
    const names = Object.keys(HOLD_CLIPS) as HoldClip[];
    const clips = new Map(clipsFromPack(new Uint8Array(readFileSync(PACK)), names).map((c) => [c.name, c]));
    for (const n of names) {
      const c = HOLD_CLIPS[n], e = table.get(n)!, clip = clips.get(n)!;
      expect(e, n).toBeDefined();
      expect(e.playback, n).toBeCloseTo(c.playback, 6);
      expect(e.looped, n).toBe(false);
      expect(e.noInterrupt ?? 0, n).toBeCloseTo(c.noInterrupt, 6);
      expect(clip.frameCount, n).toBe(c.frames);
      const root = clip.parts.find((p) => p.name === 'skel_root')!.translations;
      const last = 3 * (clip.frameCount - 1);
      if (root.length > 3) {
        expect(root[last]! - root[0]!, n).toBeCloseTo(c.travel[0], 1);
        expect(root[last + 2]! - root[2]!, n).toBeCloseTo(c.travel[1], 1);
      } else {
        expect(c.travel, n).toEqual([0, 0]);                       // one root key: the throws stand still
      }
    }
    // The moving reload is the upper body's (BlendOverlay): it holds nothing, so it is not a hold.
    expect(table.get('seal_mv_reload')).toBeDefined();
    expect('seal_mv_reload' in HOLD_CLIPS).toBe(false);
  });

  it('every throw clip GetThrowAnim picks and the claymore\'s placing are holds; the root keys reach the sim', () => {
    for (const a of [...Object.values(THROW_ANIMS), PLACE_CLAYMORE_ANIM]) expect(a.clip in HOLD_CLIPS, a.clip).toBe(true);
    const roots = actionRoots(clipsFromPack(new Uint8Array(readFileSync(PACK)), Object.keys(HOLD_CLIPS)));
    expect(roots.has('seal_place_claymore')).toBe(true);
    expect(roots.has('seal_crouch_reload')).toBe(true);
  });
});

describe('the lock: a throw holds the SEAL until the stick may cut it (FUN_00550ef0, FUN_00587c20)', () => {
  it('a standing throw stops a run dead and holds it past the release, to NoInterrupt 0.49', () => {
    const w = walker();
    for (let i = 0; i < 60; i++) w.tick(FORWARD);                  // running
    expect(Math.hypot(w.state.vx, w.state.vz)).toBeGreaterThan(20);
    expect(w.hold('seal_throwgrenade')).toBe(true);
    const x = w.state.x, z = w.state.z;
    let ticks = 0, before = { x: w.state.x, z: w.state.z };
    while (w.holding && ticks < 600) { before = { x: w.state.x, z: w.state.z }; w.tick(FORWARD); ticks++; }
    // Held while the phase is at or under 0.49 (the release is 0.46: the grenade is out before the stick may cut).
    const heldFor = ticks * TICK;
    expect(phaseAt('seal_throwgrenade', heldFor - TICK)).toBeLessThanOrEqual(0.49 + 1e-9);
    expect(phaseAt('seal_throwgrenade', heldFor)).toBeGreaterThan(0.49);
    expect(heldFor).toBeGreaterThan(0.71);                        // the release, 0.46 x 1.6 x 27/28
    // The throw's root does not travel: through the hold the SEAL did not move, whatever the stick asked -- up to the
    // tick that cut it, where the ground state runs again.
    expect(Math.hypot(before.x - x, before.z - z)).toBeLessThan(1e-6);
    // Cut, the ground state runs again: the SEAL moves off.
    for (let i = 0; i < 30; i++) w.tick(FORWARD);
    expect(Math.hypot(w.state.x - x, w.state.z - z)).toBeGreaterThan(1);
  });

  it('held with the stick at rest it runs to the clip\'s end, then lets go by itself', () => {
    const w = walker();
    expect(w.hold('seal_tossgrenade')).toBe(true);
    const n = Math.ceil(HOLD_SECONDS.seal_tossgrenade / TICK);
    for (let i = 0; i < n - 1; i++) w.tick(STILL);
    expect(w.holding?.clip).toBe('seal_tossgrenade');
    w.tick(STILL); w.tick(STILL);
    expect(w.holding).toBeNull();
  });

  it('each throw holds to its own NoInterrupt: the crouched 0.8, prone 0.9, the peeks\' tosses 0.9', () => {
    for (const clip of ['seal_crouch_throwgrenade', 'seal_prone_throwgrenade', 'seal_prone_tossgrenade', 'seal_toss_rlean', 'seal_toss_llean'] as HoldClip[]) {
      const w = walker();
      expect(w.hold(clip), clip).toBe(true);
      let ticks = 0;
      while (w.holding && ticks < 600) { w.tick(FORWARD); ticks++; }
      expect(phaseAt(clip, ticks * TICK), clip).toBeGreaterThan(HOLD_CLIPS[clip].noInterrupt);
      expect(phaseAt(clip, (ticks - 1) * TICK), clip).toBeLessThanOrEqual(HOLD_CLIPS[clip].noInterrupt + 1e-9);
    }
  });

  it('the turn stays free (no NoTurn on these clips), and a turn past NoInterrupt cuts it as the stick does', () => {
    const w = walker();
    w.hold('seal_throwgrenade');
    w.state.yaw = 90;
    w.tick(STILL);
    expect(w.state.yaw).toBe(90);
    expect(w.holding).not.toBeNull();
    while (phaseAt('seal_throwgrenade', w.holding!.t) <= 0.49) w.tick(STILL);
    w.turn = SEAL_TUNING.turnMaxRate * 0.5;
    w.tick(STILL);
    expect(w.holding).toBeNull();
  });

  it('no jump while a hold is on the stack (FUN_0057e1b0 wants a looped top entry)', () => {
    const w = walker();
    w.hold('seal_throwgrenade');
    expect(w.jump()).toBe(false);
  });

  it('placing the claymore holds for 0.9 of its 2.7 s, moving by its root alone', () => {
    const w = walker();
    expect(w.hold('seal_place_claymore')).toBe(true);
    let ticks = 0;
    const x = w.state.x, z = w.state.z;
    while (w.holding && ticks < 600) { w.tick(FORWARD); ticks++; }
    expect(ticks * TICK).toBeGreaterThan(0.9 * 2.7 * (54 / 55));
    expect(ticks * TICK).toBeLessThan(0.9 * 2.7 * (54 / 55) + 2 * TICK);
    expect(Math.hypot(w.state.x - x, w.state.z - z)).toBeLessThan(1);   // the root's 0.4 over the clip, not a run
  });

  it('a hold is refused in the air, and dropped by a new place', () => {
    const w = walker();
    w.hold('seal_throwgrenade');
    w.place(10, 10, 10);
    expect(w.holding).toBeNull();
    w.setAirborne(true, 0);
    expect(w.hold('seal_throwgrenade')).toBe(false);
  });
});

describe('the reloads (FUN_005a82e0): still, a one-shot that holds; moving, the upper body\'s overlay', () => {
  it('picks the clip by stance and weapon; standing takes none (seal_reload has no NoInterrupt: the stick cuts it at once)', () => {
    expect(reloadHold('stand', false)).toBeNull();
    expect(reloadHold('stand', true)).toBeNull();
    expect(reloadHold('crouch', false)).toBe('seal_crouch_reload');
    expect(reloadHold('crouch', true)).toBe('seal_p_crouch_reload');
    expect(reloadHold('prone', false)).toBe('seal_prone_reload');
    expect(reloadHold('prone', true)).toBe('seal_p_prone_reload');
  });

  it('crouched and still, the reload holds to NoInterrupt 0.35; moving faster than 20 it is refused (the overlay)', () => {
    const w = walker();
    w.stance = 'crouch';
    expect(w.hold('seal_crouch_reload')).toBe(true);
    let ticks = 0;
    while (w.holding && ticks < 600) { w.tick(FORWARD); ticks++; }
    expect(phaseAt('seal_crouch_reload', ticks * TICK)).toBeGreaterThan(0.35);
    expect(phaseAt('seal_crouch_reload', (ticks - 1) * TICK)).toBeLessThanOrEqual(0.35 + 1e-9);
    const m = walker();
    m.state.vx = 25;
    m.stance = 'crouch';
    expect(m.hold('seal_crouch_reload')).toBe(false);
    // the throws take no speed test: the clip goes on whatever the SEAL was doing
    expect(m.hold('seal_throwgrenade')).toBe(true);
  });
});

describe('the scope\'s x 0.2 on the move stick (FUN_005966a0 453818-453821), in the shared mover', () => {
  it('is the literal 0.2 of FUN_005966a0 453818-453821, the same value as zoom.ts\'s SCOPE_SLOW', () => {
    expect(SCOPED_STICK).toBe(SCOPE_SLOW);
    expect(SCOPED_STICK).toBe(0.2);
  });

  it('a scoped full stick walks exactly as an unscoped stick of 0.2', () => {
    const a = walker(), b = walker();
    a.scoped = true;
    for (let i = 0; i < 120; i++) { a.tick(FORWARD); b.tick({ forward: 0.2, right: 0, boost: false }); }
    expect(a.state.x).toBeCloseTo(b.state.x, 9);
    expect(a.state.z).toBeCloseTo(b.state.z, 9);
    const c = walker();
    for (let i = 0; i < 120; i++) c.tick(FORWARD);
    expect(Math.hypot(a.state.x, a.state.z)).toBeLessThan(0.5 * Math.hypot(c.state.x, c.state.z));
  });
});

describe('the wire: the server runs the same holds and the same scope (MoverSim, Button.Scope, the hold code)', () => {
  const cmd = (seq: number, buttons: number, forward = 1): Command => ({ seq, forward, right: 0, yaw: 0, pitch: 0, turn: 0, buttons, stance: 0, weapon: 0 });

  it('HOLD_CODES name every hold, in four bits over HOLD_SHIFT, clear of every Button', () => {
    expect(HOLD_CODES.length).toBe(Object.keys(HOLD_CLIPS).length);
    expect(HOLD_CODES.length).toBeLessThanOrEqual(15);
    for (const b of Object.values(Button)) expect(b >> HOLD_SHIFT, `button ${b}`).toBe(0);
    for (const c of HOLD_CODES) expect((holdBits(c) >> HOLD_SHIFT) & 0xf).toBe(HOLD_CODES.indexOf(c) + 1);
    expect(HOLD_SHIFT + 4).toBeLessThanOrEqual(16);                // the command's u16
  });

  it('the bits survive the command frame (a u16 of buttons)', () => {
    const buttons = Button.Scope | Button.Trigger | holdBits('seal_p_prone_reload');
    const [back] = decodeCommands(encodeCommands({ viewTick: 3, commands: [cmd(9, buttons)] })).commands;
    expect(back!.buttons).toBe(buttons);
    expect(holdOf(back!.buttons)).toBe('seal_p_prone_reload');
    expect(holdOf(Button.Scope | Button.Trigger)).toBeNull();
  });

  it('a hold and the scope on the command move the server\'s mover as the page moved its own', () => {
    const page = walker(), server = new MoverSim(walker(), null);
    const script: number[] = [0, 0, Button.Scope, Button.Scope, holdBits('seal_throwgrenade'), 0, 0];
    let seq = 0;
    for (const buttons of script) {
      for (let i = 0; i < 20; i++) {
        seq++;
        const first = i === 0;
        page.scoped = (buttons & Button.Scope) !== 0;
        if (first && (buttons >> HOLD_SHIFT)) page.hold('seal_throwgrenade');
        page.tick(FORWARD);
        server.apply(cmd(seq, first ? buttons : buttons & ~(0xf << HOLD_SHIFT)));
      }
    }
    expect(server.walker.state.x).toBeCloseTo(page.state.x, 9);
    expect(server.walker.state.z).toBeCloseTo(page.state.z, 9);
  });
});

describe('the page: WalkMode sends what its mover did', () => {
  const GROUND: GroundData = packGround(PARAMS, [floor()], OWNERS);
  function rig() {
    const c = document.createElement('canvas');
    c.setPointerCapture = () => undefined;
    c.releasePointerCapture = () => undefined;
    c.hasPointerCapture = () => false;
    const fly = new FlyCamera(c);
    const walk = new WalkMode(fly);
    walk.setGround(GROUND, [0, 0, 0]);
    fly.setPose({ x: 5, y: 40, z: 6, yaw: 0, pitch: 0 });
    walk.setMode('walk');
    fly.groundWish = () => ({ forward: 1, right: 0, boost: false });
    const sent: Omit<Command, 'seq'>[] = [];
    walk.setNetTap((cmd) => sent.push(cmd));
    const tick = (): Omit<Command, 'seq'>[] => { const from = sent.length; walk.frame(1 / 60); return sent.slice(from); };
    for (let i = 0; i < 10; i++) tick();
    return { walk, tick, dispose: () => walk.unbindKey() };
  }

  it('a hold taken sends its code once; a clip that is not a hold is refused and sends nothing', () => {
    const { walk, tick, dispose } = rig();
    expect(walk.hold('seal_reload')).toBe(false);
    expect(tick().every((c) => (c.buttons >> HOLD_SHIFT) === 0)).toBe(true);
    expect(walk.hold('seal_throwgrenade')).toBe(true);
    const [first] = tick();
    expect((first!.buttons >> HOLD_SHIFT) & 0xf).toBe(HOLD_CODES.indexOf('seal_throwgrenade') + 1);
    expect(tick().every((c) => (c.buttons >> HOLD_SHIFT) === 0)).toBe(true);
    dispose();
  });

  it('the scoped move sets Button.Scope on every command and slows the page\'s mover', () => {
    const { walk, tick, dispose } = rig();
    walk.setScopedMove(true);
    const cmds = [...tick(), ...tick()];
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) expect(c.buttons & Button.Scope).toBe(Button.Scope);
    walk.setScopedMove(false);
    for (const c of [...tick(), ...tick()]) expect(c.buttons & Button.Scope).toBe(0);
    dispose();
  });
});
