import { Reader, type Zar } from '@s2u/archive';

/**
 * `MP*.ZED`, the world root: the handful of scalars a viewer needs out of the 33 keys `CSaveLoad::Load`
 * reads (`research/recom/src/gamez/zNode/node_saveload.cpp:236-341`, 36 section 2).
 */
export interface WorldRoot {
  /** `MetersPerUnit`, one f32; 0.1 on every map read so far (36 section 2). */
  metersPerUnit: number;
  /** `ShadowVector`, three f32. */
  shadowVector: [number, number, number];
  /** `NightMission`, one u32 used as a flag. */
  nightMission: boolean;
  /** `DefaultMaterial`, a NUL-terminated string; `METAL_THICK` on Frostfire. */
  defaultMaterial: string;
  /** `GlobalLighting`, the map's light rig, or null when the key is absent or short. */
  lighting: GlobalLighting | null;
  /**
   * `TextureScroll_Object`: the nodes whose texture scrolls, and by how much. Frostfire's four are
   * `ocean_1..3` and `skyhorizon` (du, dv of 0.02-0.04); most maps have none. The rate's unit is not
   * on the disc: `CScrollingTexture_band` holds `m_du`/`m_dv` and the engine adds them each tick.
   */
  textureScroll: TextureScrollBand[];
}

/** One `CScrollingTexture_band` (`zRender/zrender.h:241`): two 256-byte names and the uv step. */
export interface TextureScrollBand {
  modelName: string;
  nodeName: string;
  du: number;
  dv: number;
}
const SCROLL_BAND_SIZE = 520;

/**
 * `GlobalLighting`: the three directional lights and the ambient the whole map is lit by.
 *
 * On disc it is `struct _globalLight { CPnt4D dir[3]; CPnt4D col[3]; CPnt4D ambient; }`
 * (`zNode/znode.h:66`), 112 bytes, fetched by name at `node_saveload.cpp:289` into `CWorld::m_gLight`.
 * All 34 maps carry one. The engine then hands it to VU1 as data quadwords 16 to 23, and
 * `sub_0031EE00` is the routine that does it: for each direction, multiply by -1, normalise, store as
 * a row, then **transpose** -- so the matrix VU1's lighting command multiplies a normal by has those
 * three directions as its *columns*, and `normal.k` comes out as `dot(direction[k], n)`. Which is to
 * say: three directional lights, not three axis lights.
 *
 * The directions here are already negated and normalised, the way the VU sees them. The colours are
 * the stored floats verbatim; there is no `/255` anywhere, the ZED holds them as fractions of unity.
 *
 * Eleven maps store `dir[2]` and `col[2]` as zero and so run on two lights.
 */
export interface GlobalLighting {
  /** `-normalize(dir[k])`: the direction light `k` shines *from*, so `max(dot(d, n), 0)` is its term. */
  directions: [number, number, number][];
  /** `col[k]`, rgb, on the scale where 1.0 is full brightness. */
  colours: [number, number, number][];
  /** The term every surface takes whichever way it faces. */
  ambient: [number, number, number];
}

/** 112 bytes: seven quadwords of four floats, the fourth lane unused throughout. */
const GLOBAL_LIGHTING_SIZE = 112;

export function parseGlobalLighting(zar: Zar): GlobalLighting | null {
  const key = zar.find('GlobalLighting');
  if (!key || key.size < GLOBAL_LIGHTING_SIZE) return null;
  const r = new Reader(zar.data(key));
  const vec3 = (q: number): [number, number, number] => [r.f32(q * 16), r.f32(q * 16 + 4), r.f32(q * 16 + 8)];
  const directions: [number, number, number][] = [];
  for (let k = 0; k < 3; k++) {
    const [x, y, z] = vec3(k);
    const len = Math.hypot(x, y, z);
    // A zero direction is how a map says "only two lights"; it stays zero and contributes nothing.
    directions.push(len > 0 ? [-x / len, -y / len, -z / len] : [0, 0, 0]);
  }
  return { directions, colours: [vec3(3), vec3(4), vec3(5)], ambient: vec3(6) };
}

/** 36 section 2: the map's own `.ZED`, which every MP archive carries beside its `_GEO`. */
const DEFAULT_METERS_PER_UNIT = 0.1;

export function parseWorldRoot(zar: Zar): WorldRoot {
  const f32 = (name: string, at = 0): number | null => {
    const key = zar.find(name);
    return key && key.size >= at + 4 ? new Reader(zar.data(key)).f32(at) : null;
  };
  const shadow = zar.find('ShadowVector');
  const night = zar.find('NightMission');
  const material = zar.find('DefaultMaterial');
  const r = shadow && shadow.size >= 12 ? new Reader(zar.data(shadow)) : null;
  return {
    metersPerUnit: f32('MetersPerUnit') ?? DEFAULT_METERS_PER_UNIT,
    shadowVector: r ? [r.f32(0), r.f32(4), r.f32(8)] : [0, -1, 0],
    nightMission: night !== undefined && night.size >= 4 && new Reader(zar.data(night)).u32(0) !== 0,
    defaultMaterial: material ? new Reader(zar.data(material)).cstr(0, material.size) : '',
    lighting: parseGlobalLighting(zar),
    textureScroll: parseTextureScroll(zar),
  };
}

function parseTextureScroll(zar: Zar): TextureScrollBand[] {
  const key = zar.find('TextureScroll_Object');
  if (!key) return [];
  const r = new Reader(zar.data(key));
  const out: TextureScrollBand[] = [];
  for (let at = 0; at + SCROLL_BAND_SIZE <= key.size; at += SCROLL_BAND_SIZE) {
    out.push({ modelName: r.cstr(at, 256), nodeName: r.cstr(at + 256, 256), du: r.f32(at + 512), dv: r.f32(at + 516) });
  }
  return out;
}
