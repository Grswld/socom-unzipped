import { Zar, zdbMember, type ZdbEntry } from '@s2u/archive';
import { PaletteTable, type Rgba } from '@s2u/gs';
import { AN_M8, CLAYMORE, CLAYMORE_RULES, HE, M67, MARK141, parseWorldRoot, WEAPON_MEMBERS, weaponLibrary } from '@s2u/scene';
import { decodeNamedTextures } from './hudBitmaps';
import type { LoadedMesh } from './loadMap';

/**
 * The frag grenade's assets, read in the worker with the map (the grenades workstream; web/docs/research/85 §6):
 *
 * - **The model.** `zweapon.rdr`'s M67 names `ModelName grenade`: `COMMON/WEAP_GEO.ZED`'s `grenade`, 81 vertices and
 *   82 triangles in the weapons' form (`G11b.tif`, `m79.tif`), about 1.3 x 1.8 x 1 units -- drawn in the hand and in
 *   flight. Its textures join the map's decode (`loadMap.ts` lists them with the held weapon's).
 * - **The bitmaps.** The explosion's zAnim `frag_grenade` (`RUN/CZANIM.ZAR`) calls `FRAG_sparks`, `dust_explode_long`,
 *   `light_flash_large`, `bsmoke_explode_large` and `dust_ground_roll`, whose particle commands name bitmaps of
 *   `RUN\COMMON\ALPH_TXR.ZED` (against `ALPH_PAL.ZED`): the fireball, the dust, the smoke, the sparks. The scorch is
 *   `decals.rdr`'s `GRENADE_BLAST` -> `grenade_mark.tif` in `EFFE_TXR.ZED` (`hudBitmaps.ts`' library).
 * - **The map's `DefaultMaterial`** (`MP*.ZED`): what a polygon with material byte 0 bounces as (`FUN_002dc1d0`).
 */
export const GRENADE_BITMAPS = {
  fire: 'explosion2.tif',
  dust: 'effect_dustcloud.tif',
  smoke: 'effect_dustpuff01.tif',
  puff: 'cloudpuff01.tif',
  spark: 'effect_spark01.tif',
  scorch: 'grenade_mark.tif',
} as const;

export interface GrenadeAssets {
  /** The throwables' models (`grenade` for the M67, `HEgrenade` for the HE), each's packets in its own frame. */
  models: { name: string; parts: LoadedMesh[] }[];
  /** `GRENADE_BITMAPS` by file name; a bitmap that would not decode is absent (and a diagnostic). */
  bitmaps: Record<string, Rgba>;
  /** The map's `DefaultMaterial`, '' when the world root has none. */
  defaultMaterial: string;
}

/** Named textures of one `*_TXR.ZED` against its own `*_PAL.ZED`, as `hudBitmaps.ts` reads the reticle's. */
function library(bytes: Uint8Array, toc: ZdbEntry[], txrName: string, palName: string, names: string[], note: (line: string) => void): Record<string, Rgba> {
  try {
    const txr = Zar.parse(zdbMember(bytes, toc, txrName)), pal = Zar.parse(zdbMember(bytes, toc, palName));
    const keys = txr.find('textures')?.children ?? [];
    const texdat = (wanted: string): Uint8Array | null => {
      const key = keys.find((k) => k.name.toLowerCase() === wanted);
      const child = key ? txr.child(key, 'texdat') : undefined;
      return key && child ? txr.data(child) : null;
    };
    const { textures, diagnostics } = decodeNamedTextures(texdat, PaletteTable.fromZars([pal]), names);
    for (const d of diagnostics) note(`grenade: ${d}`);
    return textures;
  } catch (e) {
    note(`grenade: ${txrName}/${palName}: ${e instanceof Error ? e.message : String(e)}`);
    return {};
  }
}

/** The grenade's model, bitmaps and the map's default material; null parts never fail the map. */
export function loadGrenadeAssets(
  bytes: Uint8Array, toc: ZdbEntry[], stem: string, textureKey: (name: string) => string, note: (line: string) => void,
): GrenadeAssets {
  const models: GrenadeAssets['models'] = [];
  try {
    const lib = weaponLibrary(Zar.parse(zdbMember(bytes, toc, WEAPON_MEMBERS.geo)), Zar.parse(zdbMember(bytes, toc, WEAPON_MEMBERS.mdl)));
    for (const name of [M67.model, HE.model, AN_M8.model, MARK141.model, CLAYMORE.model, CLAYMORE_RULES.detonator.model]) {
      try {
        const decoded = lib.decode(name, 'all');
        for (const d of decoded.diagnostics) note(`grenade ${decoded.name}: ${d}`);
        models.push({
          name, parts: decoded.parts.flatMap((part) => part.meshes.map((mesh) => ({
            ...mesh, textureName: mesh.textureName === null ? null : textureKey(mesh.textureName),
            order: 0, orderEnd: 0, alternate: false, scroll: null,
          }))),
        });
      } catch (e) {
        note(`grenade ${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } catch (e) {
    note(`grenade: ${WEAPON_MEMBERS.geo}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const { scorch, ...alpha } = GRENADE_BITMAPS;
  const bitmaps = {
    ...library(bytes, toc, 'ALPH_TXR.ZED', 'ALPH_PAL.ZED', Object.values(alpha), note),
    ...library(bytes, toc, 'EFFE_TXR.ZED', 'EFFE_PAL.ZED', [scorch], note),
  };
  let defaultMaterial = '';
  try {
    defaultMaterial = parseWorldRoot(Zar.parse(zdbMember(bytes, toc, `${stem}.ZED`))).defaultMaterial;
  } catch (e) {
    note(`grenade: DefaultMaterial: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { models, bitmaps, defaultMaterial };
}

/** The typed arrays of `GrenadeAssets`, for the worker's transfer list. */
export function grenadeTransferables(g: GrenadeAssets): Transferable[] {
  const out: Transferable[] = [];
  for (const mesh of g.models.flatMap((m) => m.parts)) {
    out.push(mesh.positions.buffer, mesh.uvs.buffer, mesh.colors.buffer, mesh.indices.buffer);
    if (mesh.normals) out.push(mesh.normals.buffer);
    if (mesh.faceNormals) out.push(mesh.faceNormals.buffer);
  }
  for (const rgba of Object.values(g.bitmaps)) out.push(rgba.data.buffer);
  return out;
}
