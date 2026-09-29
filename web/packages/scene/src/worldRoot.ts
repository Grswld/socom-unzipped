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
  /** `grid_params`: the engine's grid of cells (`grid.ts`), or the engine's default when the key is absent. */
  grid: GridParams;
}

/**
 * `grid_params`, `tag_GRID_PARAMS` (`research/recom/src/gamez/zNode/znode.h:109-120`), 20 bytes, which
 * `CGrid::Read` fetches (`zGrid/grid_main.cpp:156`) and `CGrid::Create` builds the cells from (`:35-147`).
 * The header settles the order: `s32 m_AtomCnt; s32 m_posts; f32 m_CellDim; s32 cx; s32 cy` -- the layout
 * research 23 section 2.1 reads live at grid +0x00 (pool 0x2000), +0x08 (dimension), +0x0c / +0x10 (wide /
 * high), `CGrid` inheriting the struct as its head (`zGrid/zgrid.h:51`). All 22 maps carry 8192 and 16 in
 * the first two words; Frostfire's grid is 160, 8 x 9 (research 24 section 1.1).
 *
 * **The origin is not in the 20 bytes.** `Create` takes the world node's bbox minimum (`grid_main.cpp:42-57`),
 * and the grid is read before the world tree (`zNode/node_saveload.cpp:313` against `:337`), when the world
 * is a fresh node whose bbox is zero (`zNode/node_main.cpp:49-50`). So it is (0, 0) on every map -- as research
 * 23 section 2.1 reads it on the M51 image and research 24 section 1.1 on Frostfire -- and carried here so a
 * caller never has to know that.
 */
export interface GridParams {
  /** `m_AtomCnt`: the atom pool, 8,192 on every map (research 23 section 2.1: `0x2000`, nodes + free). */
  atomCount: number;
  /** `m_posts`: 16 on every map. `Create` copies it (`grid_main.cpp:40`); nothing here reads it. */
  posts: number;
  /** `m_CellDim`: a cell's side in world units; `Create` keeps `1 / m_CellDim` as `m_InvCellDim` (`:69`). */
  cellDim: number;
  /** `m_CellCount.cx`: cells along x ("wide"). */
  cellsX: number;
  /** `m_CellCount.cy`: cells along z ("high") -- `Create` steps a cell's z by it (`grid_main.cpp:98-110`). */
  cellsZ: number;
  originX: number;
  originZ: number;
}

export const GRID_PARAMS_SIZE = 20;

/**
 * The grid the engine makes when a root has no `grid_params`: dimension 640, 8 x 8 (`FUN_002d5420`'s
 * defaults, research 23 section 2.3; reCOM's `CGrid::Read` declares the same, `grid_main.cpp:151-154`).
 */
export const DEFAULT_GRID_PARAMS: GridParams = Object.freeze({
  atomCount: 8192, posts: 16, cellDim: 640, cellsX: 8, cellsZ: 8, originX: 0, originZ: 0,
});

/** The 20 bytes of `tag_GRID_PARAMS`, or null when short or when they describe no grid at all. */
export function decodeGridParams(bytes: Uint8Array): GridParams | null {
  if (bytes.byteLength < GRID_PARAMS_SIZE) return null;
  const r = new Reader(bytes);
  const grid: GridParams = {
    atomCount: r.i32(0), posts: r.i32(4), cellDim: r.f32(8), cellsX: r.i32(12), cellsZ: r.i32(16), originX: 0, originZ: 0,
  };
  const usable = Number.isFinite(grid.cellDim) && grid.cellDim > 0 && grid.cellsX > 0 && grid.cellsZ > 0;
  return usable ? grid : null;
}

/** `grid_params` from a world root, or the engine's default grid when it is absent or unusable. */
export function parseGridParams(zar: Zar): GridParams {
  const key = zar.find('grid_params');
  return (key ? decodeGridParams(zar.data(key)) : null) ?? { ...DEFAULT_GRID_PARAMS };
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

/**
 * One `Material_Palette/palEntry_<n>` of the world root that names a reflection texture: the environment-map pass
 * VU1 command `0x34`/`0x36` draws over a visual whose `vparams` byte 7 is `n + 1` (research 15 §6). The 60-byte
 * `dat` is floats and words: `[0..3]` the pass's base colour and alpha (0..255, 128 unity), `[4]` the sphere map's
 * uv scale, `[5]` a kind word (2 on the untextured entries), `[7]` 1 on the textured ones, `[12]`/`[13]` the rim
 * offset and slope, `[14]` a stale pointer. Read against the one live block there is: Seeding Chaos's water at
 * spawn (`logs/vu1dump3/vu1_prog_27.bin`, research 26 §3.2) kicks base (33, 33, 33, 65) and `(1.5, 100, -, 0.01)`
 * -- M51's `palEntry_5`, `tex_name sky01.tif`, word for word. The untextured entries (truck bodies, chrome,
 * lockers; kind 2) are not read here: what the engine draws with them is not established.
 */
export interface EnvMaterial {
  /** The `palEntry` index, 0-based; a visual names it as `index + 1`. */
  index: number;
  rgba: [number, number, number, number];
  uvScale: number;
  rimOffset: number;
  rimSlope: number;
  texture: string;
}

export function parseMaterialPalette(zar: Zar): EnvMaterial[] {
  const out: EnvMaterial[] = [];
  for (const entry of zar.find('Material_Palette')?.children ?? []) {
    const index = Number(/(\d+)$/.exec(entry.name)?.[1] ?? NaN);
    const dat = zar.child(entry, 'dat');
    const tex = zar.child(entry, 'tex_name');
    if (!Number.isFinite(index) || !dat || dat.size < 56 || !tex) continue;
    const r = new Reader(zar.data(dat));
    const texture = new Reader(zar.data(tex)).cstr(0, tex.size).toLowerCase();
    if (!texture) continue;
    out.push({
      index, rgba: [r.f32(0), r.f32(4), r.f32(8), r.f32(12)], uvScale: r.f32(16),
      rimOffset: r.f32(48), rimSlope: r.f32(52), texture,
    });
  }
  return out;
}

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
    grid: parseGridParams(zar),
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
