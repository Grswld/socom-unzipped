import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoubleSide, FrontSide, Matrix4, SkinnedMesh, Vector3 } from 'three';
import { FsAssetSource } from '@s2u/archive/node';
import { facingVector } from '@s2u/scene';
import { fixture, FIXTURES_ABSENT } from '../../archive/test/fixtures';
import { bodyYaw, chooseBodyModel, EYE_HEIGHT_W1R2 } from '../src/body';
import { buildBody, HIDDEN_AT_SPAWN } from '../src/bodyView';
import { DEFAULT_LIGHTING } from '../src/lighting';
import { loadMap, type LoadedMap } from '../src/loadMap';

/**
 * W2.1: the player's SEAL in its bind pose at spawn slot A (side 0, slot #0), feet on the slot's floor, facing the
 * slot's facing, in the gear the game hangs on it, textured from `CLIB_TXR`/`CLIB_PAL` (web/redotcom/docs/research/78 §5-§6).
 */
describe('bodyYaw: the model faces -z, facing step 0 (research 75 §11, 78 §3)', () => {
  it('turns the model\'s forward onto every one of the eight facings', () => {
    for (let step = 0; step < 8; step++) {
      const [fx, fz] = facingVector(step);
      const yaw = bodyYaw([fx, fz]);
      // three's turn about y: (x, z) -> (x cos + z sin, -x sin + z cos); the forward is (0, -1)
      expect(-Math.sin(yaw)).toBeCloseTo(fx, 6);
      expect(-Math.cos(yaw)).toBeCloseTo(fz, 6);
    }
  });
});

describe('chooseBodyModel: the fallback when character.rdr is not on hand (W2.R4)', () => {
  it('takes seal_A_scuba where the map has it, else the first seal_A that is not a LOD, else the first SEAL', () => {
    expect(chooseBodyModel(['seal_A_scuba', 'seal_A_scuba_1', 'seal_E_scuba', 'al_gman01'])).toBe('seal_A_scuba');
    expect(chooseBodyModel(['seal_A_des', 'seal_A_des_1', 'seal_A_des_2', 'seal_E_desert_flak'])).toBe('seal_A_des');
    expect(chooseBodyModel(['seal_B_woodland', 'seal_B_woodland_1', 'seal_E_woodland', 'seal_A_woodland_1'])).toBe('seal_B_woodland');
    expect(chooseBodyModel(['al_gman01'])).toBeNull();
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, '../../../test-fixtures');
/** The served tree, where the extractor puts `READERC.ZAR` beside the archives (78 §5). */
const SERVED = resolve(here, '../../../public/maps');
const absent = fixture('RUN/MP2.ZDB') === null;
const dressed = existsSync(resolve(SERVED, 'RUN/READERC.ZAR')) && existsSync(resolve(SERVED, 'RUN/MP2.ZDB'));

describe.skipIf(!dressed)('Frostfire\'s SEAL as the game dresses it (served tree with READERC.ZAR)', () => {
  let map: LoadedMap;
  const loaded = async (): Promise<LoadedMap> => (map ??= await loadMap(new FsAssetSource(SERVED), 'RUN/MP2.ZDB'));

  it('is mp2_seal1, seal_A_scuba, in its six pieces of default gear, and the map stays clean', async () => {
    const { body, diagnostics } = await loaded();
    expect(body).toBeTruthy();
    expect(body!).toMatchObject({ character: 'mp2_seal1', model: 'seal_A_scuba', dressedBy: 'character.rdr', missing: [] });
    expect(body!.stats).toMatchObject({ vertices: 2094, triangles: 1523, parts: 26, subMeshes: 7, batches: 56, maxInfluences: 5, fittings: 6 });
    expect(body!.stats.droppedWeight).toBeLessThan(0.05);
    expect(body!.fittings.map((f) => [f.name, f.model, body!.parts[f.part]!.name])).toEqual([
      ['seal_A_right_eye', 'right_eye', 'head'], ['seal_A_left_eye', 'left_eye', 'head'], ['seal_holster', 'gear_holster', 'rthigh'],
      ['seal_scuba_aslt_gear', 'seal_scuba_aslt_gear', 'hips'], ['seal_scuba_knife', 'seal_scuba_knife', 'rcalf'], ['Satchel', 'Satchel', 'spinehi'],
    ]);
    expect(diagnostics).toEqual([]);                           // Frostfire's list stays empty (e2e/viewer.spec.ts)
    // each gear visual keeps its own cull, `FLIB_GEO` vparams bit 3: the eyeball's two packets culled, the lid not
    const eye = body!.fittings.find((f) => f.name === 'seal_A_right_eye')!;
    expect(eye.meshes.map((m) => [m.textureName, m.cull])).toEqual([['brown_eye.tif', true], ['brown_eye.tif', true], ['brown_eye_shut.tif', false]]);
  });

  it('stands at slot A, side 0 slot #0: its feet on the slot\'s floor, facing the slot\'s facing', async () => {
    const { body, slots } = await loaded();
    const a = slots.find((s) => s.side === 0 && s.index === 0)!;
    expect(body!.at).toEqual({ position: a.position, facing: a.facing, yaw: bodyYaw(a.facing), side: 0, index: 0 });
    // the bind pose's lowest vertex is its soles, at the model's y 0 (78 §3): on the floor, to the unit W2.1 asks
    const feet = Math.min(...body!.subMeshes.flatMap((s) => Array.from(s.positions.filter((_, i) => i % 3 === 1))));
    expect(Math.abs(feet)).toBeLessThan(0.001);
    expect(Math.abs(body!.at!.position[1] + feet - a.position[1])).toBeLessThan(1);
  });

  it('is 19.43 tall with its eyes 18.16 over its feet -- not the 15.4 of W1.R2, which is research 17\'s camera target', async () => {
    const { body } = await loaded();
    expect(body!.height).toBeCloseTo(19.431, 3);
    // the eye gear's offset, 0.5302 up the head from its joint at 17.625, 1.01 forward (character.rdr, 78 §5-§6)
    expect(body!.eye!).toBeCloseTo(18.16, 2);
    expect(Math.abs(body!.eye! - EYE_HEIGHT_W1R2)).toBeGreaterThan(1);
  });

  it('is textured from the character and fittings libraries: every texture it names decoded through the GS path', async () => {
    const { body, textures, textureFlags } = await loaded();
    const names = [...body!.subMeshes.map((s) => s.textureName), ...body!.fittings.flatMap((f) => f.meshes.map((m) => m.textureName))];
    expect(names).toContain('seal01_facemap.tif');
    expect(names).toContain('gear_holster.tif');
    for (const n of names) {
      expect(n, 'a named texture').not.toBeNull();
      expect(textures[n!], n!).toBeDefined();
      expect(textureFlags[n!]?.gs, n!).toBeTruthy();
    }
  });

  it('draws as a three SkinnedMesh whose bind pose is the identity pose: every bone matrix is the placement', async () => {
    const m = await loaded();
    const view = buildBody(m.body!, m, DEFAULT_LIGHTING);
    view.group.updateMatrixWorld(true);
    const skinned = view.group.getObjectsByProperty('isSkinnedMesh', true) as SkinnedMesh[];
    expect(skinned).toHaveLength(7);
    const skeleton = skinned[0]!.skeleton;
    expect(skeleton.bones).toHaveLength(26);
    expect(skeleton.bones.map((b) => b.name).slice(0, 3)).toEqual(['skel_root', 'hips', 'rthigh']);
    skeleton.update();
    const placed = new Matrix4().compose(new Vector3(...m.body!.at!.position), view.group.quaternion, new Vector3(1, 1, 1));
    for (let b = 0; b < 26; b++) {
      const bone = new Matrix4().fromArray(skeleton.boneMatrices!, b * 16);
      bone.elements.forEach((x, i) => expect(x).toBeCloseTo(placed.elements[i]!, 3));
    }
    expect(skinned.every((s) => s.geometry.getAttribute('skinIndex').itemSize === 4 && s.geometry.getAttribute('skinWeight').itemSize === 4)).toBe(true);
    expect(view.stats).toMatchObject({ model: 'seal_A_scuba', vertices: 2094, triangles: 1523, parts: 26, fittings: 6 });
    expect(view.group.visible).toBe(false);                    // off by default in W2.1: the play mode wires it later
    view.setVisible(true);
    expect(view.group.visible).toBe(true);
    // the gear rides its parts: the knife under the right calf, placed where character.rdr puts it
    const lid = view.group.getObjectByName('seal_A_right_eye brown_eye_shut.tif') as import('three').Mesh;
    expect((lid.material as import('three').Material).side).toBe(DoubleSide);
    const eyeball = view.group.getObjectByName('seal_A_right_eye brown_eye.tif') as import('three').Mesh;
    expect((eyeball.material as import('three').Material).side).toBe(FrontSide);
    const knife = view.group.getObjectByName('seal_scuba_knife')!;
    expect(knife.parent?.name).toBe('rcalf');
    const at = knife.getWorldPosition(new Vector3()).sub(new Vector3(...m.body!.at!.position));
    expect(at.y).toBeGreaterThan(3.5);                         // below the knee (5.7), above the ankle (1.1)
    expect(at.y).toBeLessThan(5);
    view.dispose();
  });

  it('wears no satchel until it carries the bomb: built, hidden at spawn (FUN_00599f00 -> FUN_0059df60(seal, 0))', async () => {
    const m = await loaded();
    const view = buildBody(m.body!, m, DEFAULT_LIGHTING);
    expect(HIDDEN_AT_SPAWN.has('Satchel')).toBe(true);
    const satchel = view.group.getObjectByName('Satchel')!;
    expect(satchel.parent?.name).toBe('spinehi');
    expect(satchel.visible).toBe(false);
    expect(view.stats.hiddenGear).toEqual(['Satchel']);
    expect(view.stats.fittingNames).toContain('Satchel');           // still hung: the bomb pickup shows it (FUN_005bbf10)
    expect(view.setGearVisible('Satchel', true)).toBe(true);
    expect(satchel.visible).toBe(true);
    expect(view.stats.hiddenGear).toEqual([]);
    expect(view.setGearVisible('no such gear', true)).toBe(false);
    expect(view.group.getObjectByName('seal_holster')!.visible).toBe(true);
    view.dispose();
  });

  it('hangs a prop under a part and poses it after the skeleton\'s own (the rifle under rhand)', async () => {
    const m = await loaded();
    const view = buildBody(m.body!, m, DEFAULT_LIGHTING);
    const rifle = view.addProp('rifle', 'rhand');
    expect(rifle.parent?.name).toBe('rhand');
    const locals = m.body!.parts.map((p) => p.bindLocal);
    view.setPose([...locals, Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1.25, 0.5, -0.25, 1])]);
    expect(rifle.position.toArray()).toEqual([1.25, 0.5, -0.25]);
    view.dispose();
  });
});

describe.skipIf(absent)(`without READERC.ZAR the SEAL is still drawn, bare${absent ? ` (${FIXTURES_ABSENT})` : ''}`, () => {
  it('falls back to seal_A_scuba by name, with no gear and no diagnostic, and says why', async () => {
    const map = await loadMap(new FsAssetSource(FIXTURES), 'RUN/MP2.ZDB');
    if (existsSync(resolve(FIXTURES, 'RUN/READERC.ZAR'))) return;   // an extraction that carries it is dressed
    expect(map.body).toMatchObject({ character: null, model: 'seal_A_scuba', fittings: [], eye: null });
    expect(map.body!.dressedBy).toMatch(/^no RUN\/READERC\.ZAR/);
    expect(map.body!.at).not.toBeNull();
    expect(map.diagnostics).toEqual([]);
  });
});
