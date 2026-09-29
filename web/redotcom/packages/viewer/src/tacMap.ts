import { zdbMember, type ZdbEntry } from '@s2u/archive';
import { aiCellCentre, aiZoneRect, parseAiMaps, type AiLoc, type AiMaps } from '@s2u/scene';
import { FONT_TEXT_01, layoutText } from './hudFont';
import type { HudQuad, HudTri } from './hud';

/**
 * SOCOM II's tactical map (`CZNewHudMap` with its `CZLineMap`; web/docs/research/87-hud.md §9), drawn as the HUD
 * pass's layer 1. **The game has it in single player only**: in a multiplayer round SELECT holds the scoreboard
 * instead, and the map object is neither made nor ticked while the multiplayer flag `DAT_0045a0c1` is set (L56700,
 * `FUN_001fb420` L57630). The viewer walks multiplayer maps, so this is the single-player map over their data --
 * which is the same file: the map's `AIMAPS.MPS` (research 75), whose polylines, zones and named points are what
 * `CZLineMap` (`FUN_0020ebd0` L66383) draws. Only Blizzard, Frostfire and Bitter Jungle carry polylines; the other
 * 19 show the grid, the player and the nav points alone -- as the game would.
 *
 * Opened by SELECT (`controller.rdr`: `Select` -> `TACMAP`, a toggle: `FUN_00209ae0` L64434, `FUN_0020a780` opens,
 * `FUN_0020a470` closes); in the viewer `M`, and `-`/`=` held zoom out and in (the right stick's 24 units a tick).
 * Opening hides the HUD and the compass (`FUN_001f71c0`); closing brings them back through the 1.5 s fade-in
 * (`FUN_001f7030`).
 */

/** The map's box, centre and the rest of `FUN_0020a780`/`FUN_0020b2c0`'s layout, PS2 pixels. */
export const TAC_LAYOUT = {
  box: { x0: 232, x1: 628, y0: 62, y1: 365 },
  centre: [430, 213.5] as [number, number],
  /** The world width across the box's 396 pixels: `mission.rdr`'s `TacMapZoom` defaults (1, 2.2, 0.55) x 1000... */
  zoom: { open: 2200, min: 1300, max: 4000, perTick: 24 },
  /** 7 horizontal lines 38.125 apart from y 62, 9 vertical 40.85 apart from x 230; each wipes in over 1 s, 0.1 s apart. */
  grid: { horizontal: 7, dy: 38.125, vertical: 9, dx: 40.85, x0: 230, y0: 62, wipe: 1, stagger: 0.1 },
  /** The north arrow (`FUN_0020be00`): three strokes round (600, 100); the "N" at (596, 107), scale 1. */
  north: { x: 600, y: 100, text: { x: 596, y: 107, scale: 1 } },
  /** The player: `teammate_health.tif` at 8x8 and `FOV.tif`'s cone 72 pixels long (`FUN_002222e0`). */
  player: { dot: 8, cone: 72 },
  /** Markers at 20x20 in the compass's bitmap and colour (`FUN_0020e750`). */
  marker: 20,
  /** `hud_arrow_off2.tif` at the box's edges: top at y 60 on x 430, left at x 230, right at 620 - w, bottom at y 365. */
  arrows: { top: 60, left: 230, right: 620, bottom: 365, pulse: 1.5, idle: 32 / 128 },
} as const;

/** `READERC.ZAR/hud.rdr`'s `TacMap { Lines }` per polyline type (`word & 0x1f`): RGB 0-255, opacity, width. */
export const TAC_LINES: Record<number, { rgb: [number, number, number]; opacity: number; width: number }> = {
  0: { rgb: [255, 255, 255], opacity: 1, width: 1 },
  1: { rgb: [0, 240, 0], opacity: 0, width: 1 },
  2: { rgb: [148, 126, 91], opacity: 0.4, width: 1 },
  3: { rgb: [81, 176, 110], opacity: 0.5, width: 1 },
  4: { rgb: [87, 112, 176], opacity: 0.5, width: 1 },
  5: { rgb: [255, 139, 40], opacity: 0.5, width: 1 },
  6: { rgb: [176, 60, 161], opacity: 0, width: 1 },
  7: { rgb: [130, 130, 20], opacity: 0.3, width: 3 },
  8: { rgb: [176, 60, 161], opacity: 0.5, width: 1 },
};
/** Zones (kind 1 or 5) as rectangle outlines, (200, 0, 200) at alpha 100 (`FUN_0020df70`). */
export const TAC_ZONE = { rgb: [200, 0, 200] as [number, number, number], alpha: 100 / 128 };
/** The team mate's colour on the map (`DAT_003e50b0`): the viewer's SEAL is drawn in it. */
export const TAC_PLAYER_RGB: [number, number, number] = [82, 205, 205];
/** The linked sub-maps' lines are drawn at 0.3 of their alpha. */
export const LINKED_ALPHA = 0.3;

/** A map's AIMAPS data as the tactical map draws it, world (x, z). */
export interface TacData {
  lines: { points: [number, number][]; type: number; sub: number }[];
  zones: { minX: number; minZ: number; maxX: number; maxZ: number; kind: number; name: string }[];
  points: { name: string; kind: number; x: number; z: number }[];
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

const world = (ai: AiMaps, loc: AiLoc, fallback: number): [number, number] => {
  const sub = ai.maps[loc.map] ?? ai.maps[fallback]!;
  return aiCellCentre(sub, loc.x, loc.z);
};

/** The tactical map's data out of a map archive's `AIMAPS.MPS`; empty with a diagnostic when it will not read. */
export function readTacData(bytes: Uint8Array, toc: ZdbEntry[]): { data: TacData | null; diagnostics: string[] } {
  let ai: AiMaps;
  try { ai = parseAiMaps(zdbMember(bytes, toc, 'AIMAPS.MPS')); } catch (e) {
    return { data: null, diagnostics: [`tacmap: AIMAPS.MPS: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const lines: TacData['lines'] = [], zones: TacData['zones'] = [], points: TacData['points'] = [];
  ai.maps.forEach((sub, i) => {
    for (const l of sub.lines) lines.push({ points: l.locs.map((loc) => world(ai, loc, i)), type: l.value & 0x1f, sub: i });
    for (const z of sub.zones) if (z.kind === 1 || z.kind === 5) zones.push({ ...aiZoneRect(sub, z), kind: z.kind, name: z.name });
    for (const p of sub.points) { const [x, z] = world(ai, p.loc, i); points.push({ name: p.name, kind: p.kind, x, z }); }
  });
  const base = ai.maps[0]!;
  return { data: { lines, zones, points, bounds: { minX: base.min[0], minZ: base.min[2], maxX: base.max[0], maxZ: base.max[2] } }, diagnostics: [] };
}

/**
 * A nav point's compass/map bitmap: the name's first letter C..Z is `ret_nav_01..24` (type = letter - 0x55,
 * `FUN_002acad0`; ret_nav_01 is "C", the green box part of the bitmap). Null for a name that is not one.
 */
export function navBitmap(name: string): string | null {
  const c = name.toUpperCase().charCodeAt(0);
  if (c < 67 || c > 90) return null;
  return `ret_nav_${String(c - 66).padStart(2, '0')}.tif`;
}
/** The nav marks' colour (`FUN_002126f0`'s table: 32, 62, 32 for types 14-37). */
export const NAV_RGB: [number, number, number] = [32, 62, 32];

/** What the map shows now. */
export interface TacView {
  /** The player's feet (x, z) and the camera's yaw at opening (degrees: the map is heading-up, fixed while open). */
  player: [number, number]; yaw: number;
  /** The camera's live yaw: the player's cone turns with it. */
  look: number;
  zoom: number;
  /** The map's centre in the world, or null for the player. */
  pan: [number, number] | null;
  /** Seconds since it opened: the grid's wipe. */
  age: number;
}

type Rgba4 = [number, number, number, number];

/** Liang-Barsky: the part of a segment inside the box, or null. */
function clip(x0: number, y0: number, x1: number, y1: number, b: { x0: number; x1: number; y0: number; y1: number }): [number, number, number, number] | null {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 - b.x0], [dx, b.x1 - x0], [-dy, y0 - b.y0], [dy, b.y1 - y0]] as const) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [x0 + t0 * dx, y0 + t0 * dy, x0 + t1 * dx, y0 + t1 * dy];
}

/**
 * The map's quads and triangles on a frame (layer 1 of the HUD pass): pure, for the tests. `sizes` are the HUD's
 * bitmaps (a missing one is not drawn). Anchored on the frame's centre line, scaled by height / 448 like the HUD.
 */
export function tacMapLayout(
  frame: { width: number; height: number }, data: TacData | null, view: TacView,
  sizes: Record<string, { width: number; height: number }>, time = 0,
): { quads: HudQuad[]; tris: HudTri[]; project: (x: number, z: number) => [number, number] } {
  const s = frame.height / 448;
  const X = (x: number): number => frame.width / 2 + (x - 320) * s, Y = (y: number): number => y * s;
  const quads: HudQuad[] = [], tris: HudTri[] = [];
  const B = TAC_LAYOUT.box, [cx, cy] = TAC_LAYOUT.centre;
  const k = 396 / view.zoom;
  const yaw = (view.yaw * Math.PI) / 180;
  // Heading-up (`FUN_0020ae50`): the camera's forward up, its right to the right; north is -z, east +x.
  const f: [number, number] = [-Math.sin(yaw), -Math.cos(yaw)], r: [number, number] = [Math.cos(yaw), -Math.sin(yaw)];
  const [ox, oz] = view.pan ?? view.player;
  const project = (x: number, z: number): [number, number] => {
    const dx = x - ox, dz = z - oz;
    return [cx + (dx * r[0] + dz * r[1]) * k, cy - (dx * f[0] + dz * f[1]) * k];
  };
  const box = { x0: B.x0, x1: B.x1, y0: B.y0, y1: B.y1 };
  const seg = (x0: number, y0: number, x1: number, y1: number, width: number, rgba: Rgba4): void => {
    const c = clip(x0, y0, x1, y1, box);
    if (!c || rgba[3] <= 0) return;
    const [a, b, e, g] = [X(c[0]), Y(c[1]), X(c[2]), Y(c[3])];
    const len = Math.hypot(e - a, g - b) || 1, hw = (width * s) / 2;
    const nx = (-(g - b) / len) * hw, ny = ((e - a) / len) * hw;
    tris.push({ layer: 1, p: [a + nx, b + ny, e + nx, g + ny, e - nx, g - ny], rgba });
    tris.push({ layer: 1, p: [a + nx, b + ny, e - nx, g - ny, a - nx, b - ny], rgba });
  };
  const bitmap = (texture: string, x: number, y: number, w: number, h: number, rgba: Rgba4, turn = 0, element: HudQuad['element'] = 'tacmap'): void => {
    const size = sizes[texture];
    if (!size || rgba[3] <= 0) return;
    quads.push({ element, texture, x: X(x), y: Y(y), w: w * s, h: h * s, turn, u0: 0, v0: 0, u1: size.width, v1: size.height, rgba, layer: 1 });
  };

  // The grid, wiping in line by line.
  const G = TAC_LAYOUT.grid, gridRgba: Rgba4 = [1, 1, 1, (24 / 128) * (129 / 255)];
  let n = 0;
  for (let i = 1; i <= G.horizontal; i++, n++) {
    const t = Math.min(1, Math.max(0, (view.age - n * G.stagger) / G.wipe));
    if (t > 0) seg(B.x0, G.y0 + G.dy * i, B.x0 + (B.x1 - B.x0) * t, G.y0 + G.dy * i, 1, gridRgba);
  }
  for (let i = 1; i <= G.vertical; i++, n++) {
    const t = Math.min(1, Math.max(0, (view.age - n * G.stagger) / G.wipe));
    if (t > 0) seg(G.x0 + G.dx * i, B.y0, G.x0 + G.dx * i, B.y0 + (B.y1 - B.y0) * t, 1, gridRgba);
  }

  // The map's own lines and zones.
  if (data) {
    for (const l of data.lines) {
      const style = TAC_LINES[l.type] ?? TAC_LINES[0]!;
      const a = (style.opacity * 127) / 128 * (l.sub === 0 ? 1 : LINKED_ALPHA);
      const rgba: Rgba4 = [style.rgb[0] / 255, style.rgb[1] / 255, style.rgb[2] / 255, a];
      for (let i = 1; i < l.points.length; i++) {
        const [x0, y0] = project(...l.points[i - 1]!), [x1, y1] = project(...l.points[i]!);
        seg(x0, y0, x1, y1, style.width, rgba);
      }
    }
    for (const z of data.zones) {
      const c = [project(z.minX, z.minZ), project(z.maxX, z.minZ), project(z.maxX, z.maxZ), project(z.minX, z.maxZ)];
      const rgba: Rgba4 = [TAC_ZONE.rgb[0] / 255, TAC_ZONE.rgb[1] / 255, TAC_ZONE.rgb[2] / 255, TAC_ZONE.alpha];
      for (let i = 0; i < 4; i++) seg(...c[i]!, ...c[(i + 1) % 4]!, 1, rgba);
    }
    // The nav points, 20x20 in their compass bitmaps and colour.
    for (const p of data.points) {
      const nav = p.kind === 1 ? navBitmap(p.name) : null;
      if (!nav) continue;
      const [x, y] = project(p.x, p.z);
      if (x < B.x0 || x > B.x1 || y < B.y0 || y > B.y1) continue;
      const m = TAC_LAYOUT.marker;
      bitmap(nav, x, y, m, m, [NAV_RGB[0] / 128, NAV_RGB[1] / 128, NAV_RGB[2] / 128, 1]);
    }
    // The edge arrows: pulsing where more of the map lies beyond the box, else dim.
    const corners = [project(data.bounds.minX, data.bounds.minZ), project(data.bounds.maxX, data.bounds.minZ),
      project(data.bounds.maxX, data.bounds.maxZ), project(data.bounds.minX, data.bounds.maxZ)];
    const more = {
      top: corners.some(([, y]) => y < B.y0), bottom: corners.some(([, y]) => y > B.y1),
      left: corners.some(([x]) => x < B.x0), right: corners.some(([x]) => x > B.x1),
    };
    const A = TAC_LAYOUT.arrows, pulse = 0.5 - 0.5 * Math.cos(2 * Math.PI * A.pulse * time / 2);
    const aw = sizes['hud_arrow_off2.tif']?.width ?? 32, ah = sizes['hud_arrow_off2.tif']?.height ?? 32;
    const alphaOf = (on: boolean): Rgba4 => [1, 1, 1, on ? pulse : A.idle];
    bitmap('hud_arrow_off2.tif', cx, A.top + ah / 2, aw, ah, alphaOf(more.top), 0);
    bitmap('hud_arrow_off2.tif', cx, A.bottom - ah / 2, aw, ah, alphaOf(more.bottom), Math.PI);
    bitmap('hud_arrow_off2.tif', A.left + aw / 2, cy, aw, ah, alphaOf(more.left), -Math.PI / 2);
    bitmap('hud_arrow_off2.tif', A.right - aw / 2, cy, aw, ah, alphaOf(more.right), Math.PI / 2);
  }

  // The player: the view cone from the feet along the live look, and the dot on the feet.
  const [px, py] = project(...view.player);
  if (px >= B.x0 && px <= B.x1 && py >= B.y0 && py <= B.y1) {
    const turn = ((view.look - view.yaw) * Math.PI) / -180;
    const rgb: Rgba4 = [TAC_PLAYER_RGB[0] / 128, TAC_PLAYER_RGB[1] / 128, TAC_PLAYER_RGB[2] / 128, 1];
    const L = TAC_LAYOUT.player.cone;
    // FOV.tif's apex is at the bitmap's foot: its centre sits half a cone ahead of the feet, along the look.
    bitmap('fov.tif', px + (L / 2) * Math.sin(turn), py - (L / 2) * Math.cos(turn), L, L, rgb, turn);
    const d = TAC_LAYOUT.player.dot;
    bitmap('teammate_health.tif', px, py, d, d, rgb, turn);
  }

  // The north arrow (`FUN_0020be00`): three strokes of FOV.tif's white round (600, 100), and the "N". The code takes
  // n = -(the camera matrix's third row) -- the look, (a1, a2) -- so the first stroke and the barb point north.
  const N = TAC_LAYOUT.north;
  const [a1, a2] = [f[0], f[1]];
  const white: Rgba4 = [1, 1, 1, 129 / 255];
  const strokes: [number, number, number, number][] = [
    [N.x - 10 * a1, N.y + 10 * a2, N.x - 30 * a1, N.y + 30 * a2],
    [N.x + 10 * a1, N.y - 10 * a2, N.x + 30 * a1, N.y - 30 * a2],
    [N.x - 20 * a1 - 10 * a2, N.y + 20 * a2 - 10 * a1, N.x - 30 * a1, N.y + 30 * a2],
  ];
  for (const [x0, y0, x1, y1] of strokes) {
    const [a, b, e, g] = [X(x0), Y(y0), X(x1), Y(y1)];
    const len = Math.hypot(e - a, g - b) || 1, hw = s / 2, nx = (-(g - b) / len) * hw, ny = ((e - a) / len) * hw;
    tris.push({ layer: 1, p: [a + nx, b + ny, e + nx, g + ny, e - nx, g - ny], rgba: white });
    tris.push({ layer: 1, p: [a + nx, b + ny, e - nx, g - ny, a - nx, b - ny], rgba: white });
  }
  if (sizes[FONT_TEXT_01.texture]) {
    const { glyphs } = layoutText('N', N.text.x, N.text.y, N.text.scale);
    for (const g of glyphs) {
      quads.push({ element: 'tacmap', texture: FONT_TEXT_01.texture, x: X(g.x + g.w / 2), y: Y(g.y + g.h / 2), w: g.w * s, h: g.h * s,
        turn: 0, u0: g.u0, v0: g.v0, u1: g.u1, v1: g.v1, rgba: [1, 1, 1, 80 / 128], layer: 1 });
    }
  }
  return { quads, tris, project };
}

/**
 * The map's state: open or not, its zoom and pan, and the `M` / `-` / `=` keys (walking only). The page reads
 * `open()` to hide the HUD, feeds `frame()` and hands `layout()` to the HUD pass.
 */
export class TacMap {
  private open_ = false;
  private zoom: number = TAC_LAYOUT.zoom.open;
  private pan: [number, number] | null = null;
  private yaw = 0;
  private age = 0;
  private time = 0;
  private held = new Set<string>();
  private bound: EventTarget | null = null;
  /** Called on every open and close (the page restarts the HUD's fade on a close, as `FUN_001f7030` does). */
  onToggle: ((open: boolean) => void) | null = null;

  constructor(private readonly enabled: () => boolean) {}

  isOpen(): boolean { return this.open_; }
  /** Opens (heading fixed at the camera's `yaw`, the zoom back to its opening 2200) or closes the map. */
  setOpen(open: boolean, yaw = this.yaw): void {
    if (open === this.open_) return;
    this.open_ = open;
    if (open) { this.yaw = yaw; this.zoom = TAC_LAYOUT.zoom.open; this.pan = null; this.age = 0; }
    this.onToggle?.(open);
  }
  toggle(yaw: number): void { this.setOpen(!this.open_, yaw); }
  /** The zoom by `units` of world width (the right stick's 24 a tick), clamped to 1300..4000. */
  zoomBy(units: number): void {
    this.zoom = Math.min(TAC_LAYOUT.zoom.max, Math.max(TAC_LAYOUT.zoom.min, this.zoom + units));
  }
  /** Pans by (dx, dz) world units from wherever the map is centred (the left stick's 36 a tick). */
  panBy(dx: number, dz: number, from: [number, number]): void {
    const [x, z] = this.pan ?? from;
    this.pan = [x + dx, z + dz];
  }
  /** Back on the player (the game's Square). */
  centre(): void { this.pan = null; }
  /** Steps the wipe and the held zoom keys (60 ticks a second of the right stick's 24). */
  frame(dt: number): void {
    this.time += dt;
    if (!this.open_) return;
    this.age += dt;
    const ticks = dt * 60;
    if (this.held.has('Minus')) this.zoomBy(TAC_LAYOUT.zoom.perTick * ticks);
    if (this.held.has('Equal')) this.zoomBy(-TAC_LAYOUT.zoom.perTick * ticks);
  }
  state(): { open: boolean; zoom: number; pan: [number, number] | null; yaw: number; age: number } {
    return { open: this.open_, zoom: this.zoom, pan: this.pan, yaw: this.yaw, age: this.age };
  }
  /** The layer-1 shapes for the HUD pass, or null while closed. */
  layout(frame: { width: number; height: number }, data: TacData | null, player: [number, number], look: number,
    sizes: Record<string, { width: number; height: number }>): { quads: HudQuad[]; tris: HudTri[] } | null {
    if (!this.open_) return null;
    const { quads, tris } = tacMapLayout(frame, data, { player, yaw: this.yaw, look, zoom: this.zoom, pan: this.pan, age: this.age }, sizes, this.time);
    return { quads, tris };
  }

  bindKey(target: EventTarget = globalThis, yaw: () => number = () => 0): void {
    this.unbindKey();
    this.yawOf = yaw;
    target.addEventListener('keydown', this.onDown as EventListener);
    target.addEventListener('keyup', this.onUp as EventListener);
    this.bound = target;
  }
  unbindKey(): void {
    this.bound?.removeEventListener('keydown', this.onDown as EventListener);
    this.bound?.removeEventListener('keyup', this.onUp as EventListener);
    this.bound = null;
  }
  private yawOf: () => number = () => 0;
  private readonly onDown = (e: KeyboardEvent): void => {
    if (!['KeyM', 'Minus', 'Equal'].includes(e.code) || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target;
    if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (e.code === 'KeyM') {
      if (e.repeat || !this.enabled()) return;
      e.preventDefault();
      this.toggle(this.yawOf());
      return;
    }
    if (!this.open_) return;
    e.preventDefault();
    this.held.add(e.code);
  };
  private readonly onUp = (e: KeyboardEvent): void => { this.held.delete(e.code); };
}
