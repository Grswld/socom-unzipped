import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Scene } from 'three';
import { rehearse } from '../src/rehearsal';

/**
 * The walk's first draws, rehearsed before the walk (research 90 §9, #21): only what is asked for is shown for the
 * call, all of it, unculled; every flag is put back after, whatever the call does.
 */

function world(): { scene: Scene; ground: Mesh; body: Group; part: Mesh; weapon: Group; rifle: Mesh; gear: Group; strap: Mesh } {
  const g = new BoxGeometry(1, 1, 1), m = new MeshBasicMaterial();
  const scene = new Scene();
  const ground = new Mesh(g, m);
  const body = new Group();
  const part = new Mesh(g, m);
  const weapon = new Group();
  const rifle = new Mesh(g, m);
  const gear = new Group();
  const strap = new Mesh(g, m);
  weapon.add(rifle);
  gear.add(strap);
  body.add(part, weapon, gear);
  scene.add(ground, body);
  body.visible = false;              // fly mode: the SEAL hidden
  weapon.visible = false;            // the rifle before the first play
  gear.visible = false;              // gear hidden at spawn
  rifle.frustumCulled = true;
  return { scene, ground, body, part, weapon, rifle, gear, strap };
}

describe('rehearsal: the walk\'s first draws before the walk (#21)', () => {
  it('shows the asked subtree whole and unculled, hides the rest of the scene, and puts every flag back', () => {
    const w = world();
    let seen: Record<string, boolean> | null = null;
    rehearse(w.scene, [w.body], () => {
      seen = {
        ground: w.ground.visible, body: w.body.visible, part: w.part.visible, weapon: w.weapon.visible, rifle: w.rifle.visible,
        gear: w.gear.visible, strap: w.strap.visible, rifleCulled: w.rifle.frustumCulled,
      };
    });
    expect(seen).toEqual({ ground: false, body: true, part: true, weapon: true, rifle: true, gear: true, strap: true, rifleCulled: false });
    expect([w.ground.visible, w.body.visible, w.part.visible, w.weapon.visible, w.gear.visible]).toEqual([true, false, true, false, false]);
    expect(w.rifle.frustumCulled).toBe(true);
  });

  it('shows the path down to a deeper object, and puts the flags back when the call throws', () => {
    const w = world();
    expect(() => rehearse(w.scene, [w.weapon], () => {
      expect([w.ground.visible, w.body.visible, w.weapon.visible, w.rifle.visible]).toEqual([false, true, true, true]);
      throw new Error('draw failed');
    })).toThrow('draw failed');
    expect([w.ground.visible, w.body.visible, w.weapon.visible]).toEqual([true, false, false]);
  });

  it('leaves what `skip` names as it is: an effect light\'s overlay beside a body part stays hidden', () => {
    const w = world();
    const overlay = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    overlay.userData.effectLightPass = true;
    overlay.visible = false;
    w.body.add(overlay);
    let shown: boolean | null = null;
    rehearse(w.scene, [w.body], () => { shown = overlay.visible; }, (o) => o.userData.effectLightPass === true);
    expect(shown).toBe(false);
    expect(overlay.visible).toBe(false);
  });

  it('a whole overlay scene: every child shown for the call', () => {
    const hud = new Scene();
    const a = new Mesh(new BoxGeometry(), new MeshBasicMaterial()), b = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    a.visible = false; b.visible = false;
    hud.add(a, b);
    let shown = 0;
    rehearse(hud, hud.children, () => { shown = hud.children.filter((o) => o.visible).length; });
    expect(shown).toBe(2);
    expect([a.visible, b.visible]).toEqual([false, false]);
  });
});
