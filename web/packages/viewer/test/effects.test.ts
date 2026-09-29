import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { buildGrid, type CollisionOwner, type GridParams, type WorldPoly } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { effectsFromDisc, type EffectData } from '../src/effectData';
import { Effects, impactAnimation, markTable, muzzleAnimation, valveApply, valveTest } from '../src/effects';

/**
 * The gunplay's effects (web/docs/research/89): the names a round plays, the valves, the mark table, and -- on the
 * game's own data, where the fixtures are -- the M4A1 SD's round end to end: the casing thrown to the rifle's right,
 * falling at the zAnim gravity and bouncing on the deck with the metal's sound; the flash of the M4A1; the impacts.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../test-fixtures');
const MP2 = fixture('RUN/MP2.ZDB');

describe('what a round plays', () => {
  it('the weapon\'s FireAnimName, its _zoom variant in the aim view, and <HitAnimName>_<material> in lower case', () => {
    expect(muzzleAnimation('muzzle_m4SD', false)).toBe('muzzle_m4SD');
    expect(muzzleAnimation('muzzle_m4SD', true)).toBe('muzzle_m4SD_zoom');
    expect(muzzleAnimation(null, false)).toBeNull();
    expect(impactAnimation('bullet_hit', 'METAL_THICK')).toBe('bullet_hit_metal_thick');
    expect(impactAnimation('bullet_hit', undefined)).toBeNull();
  });

  it('the valves: shell_eject counts its casings up and down and tests fewer than five', () => {
    let v = 0;
    for (let i = 0; i < 5; i++) v = valveApply(v, 0x0c, 1);
    expect(v).toBe(5);
    expect(valveTest(v, 4, 5)).toBe(false);          // the fifth casing takes the cheap flight
    expect(valveTest(4, 4, 5)).toBe(true);
    expect(valveApply(0, 0x0d, 1)).toBe(0);          // subtract stops at zero
    expect(valveTest(5, 2, 5)).toBe(true);           // the NVG gate: lensfx == 5
  });

  it('the mark table: the polygon byte to its SOILS name to its row, byte 0 the map\'s DefaultMaterial, no row no mark', () => {
    const materials = ['UNKNOWN', 'PARTICLE_SYSTEM', 'ACTION', 'INVISIBLE_DI', 'GRASS', 'SAND', 'MUD', 'STONE'];
    const rows = [
      { set: 'S', material: 'STONE', texture: 'bullet_mark_stone.tif', minSize: 1, maxSize: 1.8 },
      { set: 'S', material: 'SAND', texture: 'bullet_mark_sand.tif', minSize: 1, maxSize: 1.5 },
    ];
    const t = markTable(materials, rows, new Map(), 5);
    expect(t.row(7)?.texture).toBe('bullet_mark_stone.tif');
    expect(t.row(0)?.texture).toBe('bullet_mark_sand.tif');
    expect(t.row(6)).toBeNull();                      // MUD has no BULLET_MARK_SMALL row
    expect(t.row(99)).toBeNull();
  });
});

/** A flat deck at y 0 of material `material` over x, z in [-100, 100]. */
function deck(material: number) {
  const poly: WorldPoly = {
    modelName: 'worldmodel', path: 'worldmodel/deck', region: 0, ditype: 2, material, ptcount: 4, cameratype: 0,
    points: Float32Array.from([-100, 0, -100, 100, 0, -100, 100, 0, 100, -100, 0, 100]),
  };
  const params: GridParams = { atomCount: 8192, posts: 16, cellDim: 100, cellsX: 4, cellsZ: 4, originX: -200, originZ: -200 };
  const owners: CollisionOwner[] = [{ modelName: 'worldmodel', path: 'worldmodel/deck0', first: 0, count: 1 }];
  return buildGrid(params, [], [], [poly], owners);
}

describe.skipIf(!MP2)(`the M4A1 SD's round on the game's data${MP2 ? '' : ` (${FIXTURES_ABSENT})`}`, () => {
  let data: EffectData | null = null;
  const load = async (): Promise<EffectData> => (data ??= await effectsFromDisc(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB', 'MP2'));

  it('reads the programs of both archives, the models, the textures, the SOILS and the marks with nothing missing', async () => {
    const d = await load();
    expect(d.missing).toEqual([]);
    const names = new Set(d.programs.map((p) => p.name));
    for (const n of ['muzzle_m4SD', 'shell_eject', 'shell_smoke_med', 'flash_fire_hider', 'bullet_hit_metal_thick', 'bullet_hit_stone', 'frag_grenade_stone']) {
      expect(names.has(n)).toBe(true);
    }
    expect(d.models.map((m) => m.name)).toContain('bullet_shell_9m');
    expect(d.materials[25]).toBe('METAL_THICK');
    expect(d.materials[d.defaultMaterial]).toBe('METAL_THICK');     // Frostfire's mp2.rdr
    expect(d.hitAnims).toEqual(expect.arrayContaining([['M4A1 SD', 'bullet_hit'], ['M4A1', 'bullet_hit']]));
    expect(d.marks.find((r) => r.material === 'METAL_THICK')?.texture).toBe('bullet_mark_metal.tif');
    const tex = new Map(d.textures);
    expect(tex.get('cloudpuff01.tif')?.gs?.blend).toBe('source');
    expect(tex.get('effect_muzzle01.tif')?.gs?.blend).toBe('additive');
  });

  it('throws the casing to the rifle\'s right and up, drops it at -98, bounces it on the metal deck and hides it', async () => {
    const d = await load();
    const sounds: string[] = [];
    let r = 0;
    const fx = new Effects(() => ((r = (r * 9301 + 49297) % 233280) / 233280), (name) => sounds.push(name));
    fx.setData(d);
    fx.setWorld(() => deck(25));
    // The weapon 12 units over the deck, its barrel along -x (west), so its right (+z of its frame) is -z.
    const x = new Vector3(-1, 0, 0), y = new Vector3(0, 1, 0), z = new Vector3().crossVectors(x, y);
    const node = new Matrix4().makeBasis(x, y, z).setPosition(0, 12, 0);
    expect(fx.play('muzzle_m4SD', { node, position: [7.8, 0.8, 0], velocity: [-1, 0, 0] })).toBe(true);
    const played = fx.stats().played;
    expect(played['shell_eject']).toBe(1);
    expect(played['shell_smoke_med']).toBe(1);
    const camera = new PerspectiveCamera();
    fx.update(1 / 60, camera);
    const first = fx.stats().lastShell!;
    expect(first.velocity[2]).toBeLessThan(-10);                        // to the rifle's right
    expect(first.velocity[1]).toBeGreaterThan(5);                       // and up
    let t = 0;
    while (fx.stats().shells > 0 && t < 2) { fx.update(1 / 60, camera); t += 1 / 60; }
    expect(t).toBeLessThanOrEqual(1.2 + 1e-6);                          // gone at rest or at its lifetime
    expect(fx.stats().bounces).toBeGreaterThan(0);
    expect(sounds).toContain('.BUL_CAS_METAL');          // the bank's name for the data's .BUL_CASE_METAL
    // The smoke source is switched off in the data: nothing was emitted.
    expect(fx.stats().emitted).toBe(0);
  });

  it('draws the M4A1\'s flash at the muzzle, along the barrel, and scales it up over 0.05 s, then hides it', async () => {
    const d = await load();
    const fx = new Effects(() => 0.9);
    fx.setData(d);
    const node = new Matrix4().makeTranslation(100, 0, 0);          // the barrel along +x
    expect(fx.play('flash_fire_hider', { node, position: [7.8, 0.8, 0] })).toBe(true);
    const camera = new PerspectiveCamera();
    fx.update(0.03, camera);
    expect(fx.stats().shown).toContain('muzzle_flash_hider');
    const box = new Box3().setFromObject(fx.object.children.find((c) => c.name === 'muzzle_flash_hider')!);
    expect(box.min.x).toBeGreaterThan(107);                              // it starts at the muzzle...
    expect(box.max.x - box.min.x).toBeGreaterThan(2);                   // ...and reaches along the barrel
    for (let i = 0; i < 10; i++) fx.update(1 / 60, camera);
    expect(fx.stats().shown).not.toContain('muzzle_flash_hider');
  });

  it('runs a frag grenade explosion: the material puff, then frag_grenade sparks on a thrown node, smoke, dust', async () => {
    const d = await load();
    const sounds: string[] = [];
    let r = 0.3;
    const fx = new Effects(() => ((r = (r * 7 + 0.13) % 1)), (name) => sounds.push(name));
    fx.setData(d);
    const at: [number, number, number] = [10, 0, 10];
    const place = { node: new Matrix4().makeTranslation(...at), position: at, normal: [0, 1, 0] as [number, number, number], velocity: [0, 0, 0] as [number, number, number] };
    expect(fx.play('frag_grenade_stone', place)).toBe(true);
    const camera = new PerspectiveCamera();
    camera.position.set(10, 20, 80);
    camera.updateMatrixWorld();
    for (let i = 0; i < 30; i++) fx.update(1 / 60, camera);
    const s = fx.stats();
    expect(s.played['frag_grenade']).toBe(1);                       // after the stone's own 0.05 s puff
    for (const part of ['FRAG_sparks', 'dust_explode_long', 'light_flash_large', 'bsmoke_explode_large', 'dust_ground_roll']) expect(s.played[part]).toBe(1);
    expect(sounds).toContain('.GREN_MED');
    expect(s.particles).toBeGreaterThan(20);
    expect(s.emitted).toBeGreaterThan(40);
  });

  it('plays the surface\'s impact at the hit: sparks off METAL_THICK, the stone\'s dust and chunks off STONE', async () => {
    const d = await load();
    const sounds: string[] = [];
    const fx = new Effects(() => 0.1, (name) => sounds.push(name));
    fx.setData(d);
    const camera = new PerspectiveCamera();
    expect(fx.play('bullet_hit_metal_thick', { position: [0, 0, 0], velocity: [0, 0, -1], normal: [0, 0, 1] })).toBe(true);
    for (let i = 0; i < 3; i++) fx.update(1 / 60, camera);
    expect(sounds).toContain('.BUL_METAL');
    expect(fx.stats().emitted).toBeGreaterThan(0);
    const metal = fx.stats().emitted;
    expect(fx.play('BULLET_HIT_STONE', { position: [0, 0, 0], velocity: [0, 0, -1], normal: [0, 0, 1] })).toBe(true);
    for (let i = 0; i < 3; i++) fx.update(1 / 60, camera);
    expect(sounds).toContain('.BUL_STONE');
    expect(fx.stats().emitted).toBeGreaterThan(metal);
  });
});
