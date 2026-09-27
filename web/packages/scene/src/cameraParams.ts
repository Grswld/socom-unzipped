import { Reader, type Zar } from '@s2u/archive';

/**
 * `cameras/camera` in the map's own `MP*.ZED` — the 144-byte `zdb::tag_CAMERA_PARAMS`
 * (`research/recom/src/gamez/zCamera/zcam.h:67-101`), loaded by `CSaveLoad::Load`
 * (`.../zNode/node_saveload.cpp:303-309`). This is where a map's fog lives; `mission.rdr` does not
 * carry it.
 *
 * The authored source is readable beside it as text — `READERM.ZAR` -> `mp<N>.rdr` — which is what
 * pins every field name here. Frostfire's reads:
 *
 * ```
 * camera (fov (0.6109 0.4276) clip (4 640) mid_clip (640)
 *         fog_standard  (enabled (1) range (200 640) mid (270) RGB (7 7 12))
 *         fog_altitude  (enabled (0) range (100 0) landmark (2450 650))
 *         fog_directional (enabled (0) eRGB (255 255 255) ...))
 * ```
 *
 * Note the ordering trap: the text says `clip (near far)` then `mid_clip`, but the struct order is
 * near, **mid**, far.
 *
 * Fields deliberately not read: `m_fog_mid` (0x6C) and `m_fog_density` (0x78) are constant across all
 * 34 shipped maps and unused; `m_fogA`/`m_fogB` (0x70/0x74) hold garbage on disc because the EE
 * recomputes them every frame; the four directional colours (0x34..0x63) are editor leftovers and
 * their enable bit is zero on all 22 multiplayer maps.
 */
export interface CameraParams {
  /** `m_fog_color`, 0x10, stored 0..1 and always an exact n/255. Returned as the GS's 0..255. */
  fogColor: [number, number, number];
  /** `m_fog_near` / `m_fog_far`, 0x64 / 0x68, in world units. */
  fogNear: number;
  fogFar: number;
  /** `m_fog_top` / `m_fog_bottom`, 0x7C / 0x80: the altitude band, only meaningful when `fogAltitude`. */
  fogTop: number;
  fogBottom: number;
  /** bit 29 of the flags word at 0x8C. Two shipped maps (MP51, MP81) have it clear. */
  fogEnabled: boolean;
  /** bit 31. Six maps use it; the rest park the band below the world so the term clamps to 1 anyway. */
  fogAltitude: boolean;
  /** bit 30. Zero on every multiplayer map. */
  fogDirectional: boolean;
  /** `m_near_plane` / `m_far_plane`, 0x28 / 0x30 — the camera's clip planes, not the fog's. */
  nearPlane: number;
  farPlane: number;
  /** `m_hfov` / `m_vfov`, 0x20 / 0x24, radians. */
  hfov: number;
  vfov: number;
}

const RECORD_BYTES = 144;

/** 0..1 float to the 0..255 the GS register holds. The values on disc are exact n/255. */
const channel = (v: number): number => Math.round(Math.min(Math.max(v, 0), 1) * 255);

/**
 * Reads `cameras/camera` out of a parsed `MP*.ZED`, or null when the key is absent or short — a map
 * without one simply draws unfogged rather than failing to load.
 */
export function parseCameraParams(zar: Zar): CameraParams | null {
  const key = zar.find('cameras/camera');
  if (!key || key.size < RECORD_BYTES) return null;
  const r = new Reader(zar.data(key));

  // `m_flags_unused:29; m_fog_enabled:1; m_directional_fog_enabled:1; m_fog_alt_enabled:1` — on a
  // little-endian target those three land in the top bits, so they are read from 29, 30 and 31.
  const flags = r.u32(0x8c);

  return {
    fogColor: [channel(r.f32(0x10)), channel(r.f32(0x14)), channel(r.f32(0x18))],
    fogNear: r.f32(0x64),
    fogFar: r.f32(0x68),
    fogTop: r.f32(0x7c),
    fogBottom: r.f32(0x80),
    fogEnabled: ((flags >>> 29) & 1) === 1,
    fogDirectional: ((flags >>> 30) & 1) === 1,
    fogAltitude: ((flags >>> 31) & 1) === 1,
    nearPlane: r.f32(0x28),
    farPlane: r.f32(0x30),
    hfov: r.f32(0x20),
    vfov: r.f32(0x24),
  };
}
