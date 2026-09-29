import type { BufferGeometry, Material, Object3D } from 'three';

/**
 * What a draw needs linked and built, as a key (research 90 §9, issues #21 and #23): for the tests that hold a
 * warm-up to what the frame then draws, with no GPU.
 *
 * three builds a material's node graph once per material and links one program per shader source; the source follows
 * from the material, the object's kind (a mesh, a line, points, a sprite; skinned, instanced) and the geometry's
 * attributes (a `color` lane or none is two programs). So a draw whose key -- the material instance, the kind, the
 * attributes with their widths -- is in the warm set's keys links nothing new when it first draws. A key of the same
 * shape with another material instance still builds that material's graph on the frame (a few milliseconds), and may
 * or may not link; the tests hold the warm-ups to the strict key.
 */
export function drawKey(o: Object3D): string | null {
  const f = o as Object3D & {
    isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean; isSkinnedMesh?: boolean; isInstancedMesh?: boolean;
    material?: Material | Material[]; geometry?: BufferGeometry;
  };
  if (!(f.isMesh || f.isLine || f.isPoints || f.isSprite)) return null;
  const materials = Array.isArray(f.material) ? f.material : f.material ? [f.material] : [];
  const attributes = f.geometry
    ? Object.entries(f.geometry.attributes).map(([name, a]) => `${name}:${a.itemSize}`).sort().join(',')
    : '';
  return [o.type, f.isSkinnedMesh ? 'skinned' : '', f.isInstancedMesh ? 'instanced' : '', materials.map((m) => m.uuid).join('+'), attributes].join('|');
}

/** Every drawable under `roots` (the roots included), whatever its visibility. */
export function drawsUnder(roots: readonly Object3D[]): Object3D[] {
  const out: Object3D[] = [];
  for (const r of roots) r.traverse((o) => { if (drawKey(o) !== null) out.push(o); });
  return out;
}

/** The draws under `drawn` whose key no draw under `warm` has: what would link or build on its first frame. */
export function unwarmed(drawn: readonly Object3D[], warm: readonly Object3D[]): Object3D[] {
  const keys = new Set(drawsUnder(warm).map(drawKey));
  return drawsUnder(drawn).filter((o) => !keys.has(drawKey(o)));
}
