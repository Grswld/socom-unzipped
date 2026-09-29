import { type BufferAttribute, type Material, Mesh, type Object3D, Raycaster, Triangle, Vector3, Vector4 } from 'three';

/**
 * The world's drawn vertex colour under a point, rgba with 1.0 the PS2's unity (0x80), or null where nothing drawn lies
 * under it: what a mark placed there is modulated by.
 */
export type SurfaceShade = (point: [number, number, number], normal: [number, number, number]) => [number, number, number, number] | null;

/**
 * How far either side of the hit's plane a drawn triangle still takes the mark, in units: `FUN_003b3ab0` keeps a
 * triangle only when each of its three vertices projects within 4.8 of the mark's plane (`fabs(z) <= 4.8`, decomp
 * 306620). The collision hull and the drawn world are separate meshes, and a hull face can sit a unit or more off the
 * surface drawn over it.
 */
export const MARK_DEPTH = 4.8;

/** Drawn surfaces this close to each other along the probe are one surface's layers (a terrain's blend passes). */
const LAYER_GAP = 0.05;

/**
 * EFFECTS (web/docs/research/89 §5, "the mark's colour"): the game draws a bullet mark -- and a footprint, and a
 * grenade's scorch, all `FUN_003139e0` decals -- with the vertex colour of the world polygon it is clipped to. For every
 * clipped vertex `FUN_003b3ab0` (decomp 306470) keeps a pointer to the world vertex's own 32-bit colour (the vertex
 * walk's `+0x3c`, `FUN_003ba9a0`: the colour array + index x 4), and `FUN_003beca0` (decomp 313065) unpacks the three
 * words (`V4-8`, `0x6e038006`) with the normal (`V3-16`) into the packet the world's VU program finishes (`MSCNT`):
 * `RGBAQ` is the wall's own baked colour, lit as the wall is lit, and the GS modulates the mark's texel by it.
 *
 * The viewer's world holds exactly that colour in each draw's `color` attribute (`./world`, `applyLighting`: the
 * record's colour, lit where the engine lights it). This reads it where a mark lands: a probe along the surface
 * normal through the point, `MARK_DEPTH` either side, over the visible draws with a `color` attribute (not the
 * blended ones where a solid one is met); the drawn surface nearest the point, its triangle's three colours
 * interpolated there. Where several layers lie on that surface (a terrain's layers: `ground_grassy.tif` fading out by
 * its vertex alpha over `cobble_road.tif` on Vigilance), the game puts a copy of the mark on each visual of the node
 * (`FUN_003139e0` walks them all), each faded by its own layer's alpha; the one that shows is the most opaque, so the
 * layer with the highest alpha is taken. One colour for the whole mark stands in for the game's per-vertex colours
 * over the clipped triangles (a mark is 0.75-3.4 units across; a world triangle's colour barely changes over it).
 */
export function surfaceShade(root: Object3D): SurfaceShade {
  const raycaster = new Raycaster();
  const origin = new Vector3(), dir = new Vector3(), out = new Vector4();
  return (point, normal) => {
    dir.set(-normal[0], -normal[1], -normal[2]);
    if (dir.lengthSq() < 1e-12) return null;
    dir.normalize();
    origin.set(point[0], point[1], point[2]).addScaledVector(dir, -MARK_DEPTH);
    raycaster.set(origin, dir);
    raycaster.near = 0;
    raycaster.far = 2 * MARK_DEPTH;
    const drawn: Mesh[] = [];
    const visit = (o: Object3D): void => {
      if (!o.visible || o.userData['effectLightPass'] === true) return;   // a LIGHT's second draw, not a surface (89 §10)
      if (o instanceof Mesh && o.geometry.getAttribute('color')) drawn.push(o);
      for (const c of o.children) visit(c);
    };
    visit(root);
    const hits = raycaster.intersectObjects(drawn, false).filter((h) => h.face && h.barycoord);
    if (hits.length === 0) return null;
    const off = (d: number): number => Math.abs(d - MARK_DEPTH);
    const solid = hits.filter((h) => !((h.object as Mesh).material as Material).transparent);
    const candidates = solid.length ? solid : hits;
    const closest = Math.min(...candidates.map((h) => off(h.distance)));
    let best: [number, number, number, number] | null = null;
    for (const h of candidates) {
      if (off(h.distance) > closest + LAYER_GAP) continue;
      const colour = (h.object as Mesh).geometry.getAttribute('color') as BufferAttribute;
      out.set(0, 0, 0, 1);
      Triangle.getInterpolatedAttribute(colour, h.face!.a, h.face!.b, h.face!.c, h.barycoord!, out);
      const rgba: [number, number, number, number] = [out.x, out.y, out.z, colour.itemSize === 4 ? out.w : 1];
      if (!best || rgba[3] > best[3]) best = rgba;
    }
    return best;
  };
}
