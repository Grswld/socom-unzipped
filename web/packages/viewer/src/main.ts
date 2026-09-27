/// <reference types="vite/client" />
import { Scene, Timer } from 'three';
import type { MapInfo } from '@s2u/archive';
import { sortByPopularity } from './mapOrder';
import { spawnsFor, type Spawns } from '@s2u/scene';
import { FlyCamera, type Pose } from './camera';
import type { ViewerHook } from './hook';
import type { LoadedMap, LoadStage } from './loadMap';
import { Overlays } from './overlays';
import { createRenderer, PS2_FRAME, type Backend, type Presentation } from './renderer';
import { applyFog, ELF_DEFAULT_FOGCOL, fogForExtent, type FogSettings } from './fog';
import { brightenOf, DEFAULT_LIGHTING, type Lighting } from './lighting';
import { Ui, type SliderName, type ToggleName } from './ui';
import { buildWorld, centre, type WorldView } from './world';
import { spreadAcrossFrames, type Spread } from './scheduler';
import { attachTouchControls, wantsTouchControls } from './touch';
import type { ViewerRequest, ViewerResponse } from './worker';

/** The served disc tree: `web/public/maps/`, with its own `index.json` beside it. */
// The maps directory sits beside the page: `/maps` in dev, `/map-viewer/maps` when served under a prefix.
const MAPS = `${import.meta.env.BASE_URL}maps`;
/** The map the viewer opens on, and the one the screenshot test asks for by name. */
const DEFAULT_ARCHIVE = 'MP2';
/** Where the last map picked is remembered, so a return visit opens where it left off. */
const LAST_MAP_KEY = 's2u.viewer.lastMap';
/**
 * The pixel ratio the native presentation may draw at: the device's, up to 2 on a desktop and 1.5 on a
 * phone, whose GPU is filling a screen a hand's width away. `adapt` lowers it further when frames run
 * long and raises it back when they do not.
 */
const RATIO_CAP = Math.min(globalThis.devicePixelRatio || 1, wantsTouchControls() ? 1.5 : 2);
const RATIO_FLOOR = 0.75;
/** Frame times that ask for a lower or a higher ratio, and how long to wait between changes. */
const SLOW_MS = 24, FAST_MS = 12, ADAPT_EVERY_MS = 2000;
/** The game's own projection, framebuffer-wide: `tan(hfov) / tan(vfov)` at the authored half-angles. */
const PS2_ASPECT = Math.tan(0.6109) / Math.tan(0.4276);
/** Eye height above a spawn's feet: a standing player, not a floating one. */
const EYE = 20;

const canvas = document.getElementById('view') as HTMLCanvasElement | null;
if (!canvas) throw new Error('the page has no #view canvas');

const ui = new Ui();
const scene = new Scene();
const fly = new FlyCamera(canvas, {
  onSpeedChange: (m) => ui.setCameraHint(m, fly.isLocked()),
  onLockChange: (locked) => ui.setCameraHint(fly.multiplier(), locked),
});
const overlays = new Overlays(scene);
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

let view: WorldView | null = null;
let loaded: LoadedMap | null = null;
let backend: Backend = 'webgl2';
/** The maps the index listed, so a path can be turned back into its archive for the URL. */
let mapList: MapInfo[] = [];
/** The presentation the panel asks for; `fit` puts it into effect. */
let presentation: Presentation = 'native';
/** `fit`, once `boot` has a renderer: the canvas's CSS box, or the PS2 frame, onto the camera. */
let fit: (() => void) | null = null;

/** The panel's lighting, accumulated as the sliders move and handed to the world as one set. */
const lighting: Lighting = { ...DEFAULT_LIGHTING };

/** The panel's fog. Replaced wholesale when a map states its own, then nudged by the sliders. */
const fog: FogSettings = {
  enabled: true, ...fogForExtent(1200), color: [...ELF_DEFAULT_FOGCOL], altitude: null,
};
/** The renderer's clear colour, once `boot` has one: the background follows the fog. */
let setClearColor: ((rgb: [number, number, number]) => void) | null = null;

/**
 * False while the fog on screen is the map's own, true once a slider has been dragged. It stops the
 * step-snapped value in the range input from being read back over the decoded one on every map load.
 */
let fogIsMine = false;

/**
 * Puts the current fog on the scene and behind it. The brighten pass multiplies the whole frame, the
 * fog colour and the cleared background with it, so both are lifted by the same factor here.
 */
function refreshFog(): void {
  const gain = brightenOf(lighting);
  const lift = (rgb: [number, number, number]): [number, number, number] =>
    [Math.min(255, rgb[0] * gain), Math.min(255, rgb[1] * gain), Math.min(255, rgb[2] * gain)];
  applyFog(scene, { ...fog, color: lift(fog.color) });
  setClearColor?.(lift(fog.enabled ? fog.color : ELF_DEFAULT_FOGCOL));
}

/**
 * Which request the page is still waiting for, one per kind. Loads overlap -- the boot auto-load is
 * already running when the player picks a map, and a small archive can overtake a large one -- so an
 * answer whose id is no longer the wanted one is dropped rather than drawn over the newer map.
 */
let requests = 0;
let wantedIndex = -1;
let wantedMap = -1;
const ask = (request: ViewerRequest): void => worker.postMessage(request);
/** What the overlay says while each stage of a load runs. */
const STAGE_WORDS: Record<LoadStage, string> = {
  fetching: 'fetching the archive',
  archive: 'reading the archive',
  geometry: 'decoding the geometry',
  textures: 'decoding the textures',
};

/** When the current load was asked for, so the status line can report the whole wait, not a part. */
let askedAt = 0;
/** The reveal in progress. A new load cancels it: half a map is not drawn under the next one. */
let revealing: Spread | null = null;

const load = (path: string): void => {
  askedAt = performance.now();
  wantedMap = ++requests;
  rememberMap(path);
  revealing?.cancel();
  revealing = null;
  // The old map stays on screen and the camera stays live while this runs; what is taken away is the
  // picker, because a second load started over the first is how two maps end up half drawn together.
  ui.setLoading(true, 'fetching the archive', 0);
  ask({ kind: 'load', id: wantedMap, baseUrl: MAPS, path });
};

worker.addEventListener('message', (event: MessageEvent<ViewerResponse>) => {
  const message = event.data;
  if (message.kind === 'error') {
    if (message.id !== wantedIndex && message.id !== wantedMap) return;
    ui.setLoading(false);
    ui.setStatus(`failed while ${message.doing}: ${message.message}`, 'error');
    return;
  }
  if (message.kind === 'index') {
    if (message.id !== wantedIndex) return;
    showMaps(message.maps);
    return;
  }
  if (message.kind === 'progress') {
    if (message.id !== wantedMap) return;               // a stage of a load we have moved on from
    ui.setLoading(true, STAGE_WORDS[message.stage], message.total > 0 ? message.done / message.total : 0);
    return;
  }
  if (message.id !== wantedMap) return;
  show(message.map);
});

ui.onMapChange((path) => {
  if (!path) return;
  ui.setStatus(`loading ${path} ...`);
  load(path);
});
ui.onLook();                 // restores the remembered picture before the toggles are read
ui.onToggle(applyToggle);
ui.apply(applyToggle);
ui.onChromeToggle();
ui.onFullscreen();
attachTouchControls(fly);
ui.onPanelToggle();

/**
 * The map a visitor asked for: `?map=MP7` in the URL first, then the one remembered from last time,
 * then the default. Matched on the archive stem, case aside, so a hand-typed link works.
 */
function wantedArchive(): string {
  try {
    const asked = new URLSearchParams(location.search).get('map');
    if (asked) return asked.toUpperCase();
    const last = localStorage.getItem(LAST_MAP_KEY);
    if (last) return last.toUpperCase();
  } catch { /* no storage, or no URL to read */ }
  return DEFAULT_ARCHIVE;
}

/** Writes the map into the URL and into storage, both best-effort: a viewer that cannot is still a viewer. */
function rememberMap(path: string): void {
  const archive = mapList.find((m) => m.path === path)?.archive;
  if (!archive) return;
  try {
    const url = new URL(location.href);
    url.searchParams.set('map', archive);
    history.replaceState(null, '', url);
  } catch { /* a page without a history, such as a file: URL */ }
  try { localStorage.setItem(LAST_MAP_KEY, archive); } catch { /* the default next time */ }
}
ui.onSlider((name, value) => {
  if (name === 'fognear' || name === 'fogfar') fogIsMine = true;
  applySlider(name, value);
});
ui.applySliders(applySlider);

/** The sliders: the brighten is a uniform on every material, so moving it rewrites no vertex. */
function applySlider(name: SliderName, value: number): void {
  if (name === 'brighten') { lighting.brighten = value; refreshFog(); }
  // A slider only owns the fog once the player has moved it: `applySliders` is also called on every
  // map load, and the range input has snapped the decoded value to its step by then.
  else if (name === 'fognear') { if (fogIsMine) { fog.near = value; refreshFog(); } return; }
  else if (name === 'fogfar') { if (fogIsMine) { fog.far = value; refreshFog(); } return; }
  view?.setLighting(lighting);
}

function applyToggle(name: ToggleName, on: boolean): void {
  if (name === 'grid') overlays.setGrid(on);
  else if (name === 'collision') overlays.setCollision(on);
  else if (name === 'spawns') overlays.setSpawns(on);
  else if (name === 'wireframe') view?.setWireframe(on);
  else if (name === 'fog') { fog.enabled = on; refreshFog(); }
  else if (name === 'blendgraded') view?.setBlendGraded(on);
  else if (name === 'discorder') view?.setDiscOrder(on);
  else if (name === 'shadows') view?.setShadows(on);
  else if (name === 'alternate') view?.setAlternate(on);
  else if (name === 'linestrips') view?.setLineStrips(on);
  else if (name === 'billboards') view?.setBillboards(on);
  else if (name === 'untextured') view?.setUntexturedHighlight(on);
  else if (name === 'rigeverywhere') { lighting.rigEverywhere = on; view?.setLighting(lighting); }
  else if (name === 'ps2look') {
    presentation = on ? 'ps2' : 'native';
    document.body.classList.toggle('ps2-look', on);
    fit?.();
  }
}

boot().catch((e: unknown) => {
  // No WebGPU and no WebGL2: the page has nothing to draw with, and should say so rather than sit on
  // "booting" for ever.
  ui.setStatus(`this browser offers neither WebGPU nor WebGL2, so there is nothing to draw with: ${e instanceof Error ? e.message : String(e)}`, 'error');
});

/** Brings the renderer up, starts the frame loop, then asks the worker for the map list. */
async function boot(): Promise<void> {
  const created = await createRenderer(canvas!);
  const { render, resize, backend: chosen } = created;
  setClearColor = created.setClearColor;
  ui.onFogColour((rgb) => { fog.color = rgb; refreshFog(); });
  refreshFog();
  backend = chosen;

  fit = (): void => {
    created.setPresentation(presentation);
    if (presentation === 'ps2') {
      // The console's frame: 640 by 448 pixels, and a projection built in those pixels from the map's
      // own half-angles, which the page then stretches onto 4:3 exactly as the television did.
      resize(PS2_FRAME.width, PS2_FRAME.height);
      fly.setAspect(loaded?.camera ? Math.tan(loaded.camera.hfov) / Math.tan(loaded.camera.vfov) : PS2_ASPECT);
      return;
    }
    const width = Math.max(1, canvas!.clientWidth);
    const height = Math.max(1, canvas!.clientHeight);
    resize(width, height);
    fly.setAspect(width / height);
  };
  fit();
  globalThis.addEventListener('resize', fit);
  // A phone's browser bar comes and goes without a window resize; the visual viewport says when.
  globalThis.visualViewport?.addEventListener('resize', fit);
  globalThis.addEventListener('orientationchange', fit);

  const timer = new Timer();
  // A frame time smoothed over about half a second: the raw number flickers too much to read, and the
  // point of the counter is to notice a map that costs 30 ms, not to watch it jitter.
  let smoothedMs = 16.7;
  let lastShown = 0;
  let lastAdapted = 0;
  /**
   * Trades pixels for frames. A phone that cannot hold Crossroads at 1.5x drops to 1.25x, then 1x,
   * and climbs back when it can; a desktop that never runs long never moves. Not while a map is
   * arriving, whose frames are long on purpose, and never in the PS2 presentation, whose size is the
   * point.
   */
  const adapt = (now: number): void => {
    if (presentation === 'ps2' || revealing || now - lastAdapted < ADAPT_EVERY_MS) return;
    const ratio = created.pixelRatio();
    if (smoothedMs > SLOW_MS && ratio > RATIO_FLOOR) created.setPixelRatio(Math.max(RATIO_FLOOR, ratio - 0.25));
    else if (smoothedMs < FAST_MS && ratio < RATIO_CAP) created.setPixelRatio(Math.min(RATIO_CAP, ratio + 0.25));
    else return;
    lastAdapted = now;
  };
  created.setPixelRatio(RATIO_CAP);
  const frame = (): void => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);     // a backgrounded tab must not teleport the camera
    fly.update(dt);
    view?.frame(fly.camera, dt);   // the flares turn, the LODs pick, the oceans scroll -- before the draw
    render(scene, fly.camera);

    if (dt > 0) {
      smoothedMs += (dt * 1000 - smoothedMs) * 0.08;
      const now = performance.now();
      if (now - lastShown > 200) {                  // redrawing text every frame is itself a cost
        lastShown = now;
        ui.setFps(1000 / smoothedMs, smoothedMs);
        adapt(now);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (await served()) {
    ui.setStatus(`${backend}: indexing the archives ...`);
    wantedIndex = ++requests;
    ask({ kind: 'index', id: wantedIndex, baseUrl: MAPS });
  } else {
    ui.setStatus(`no maps served at ${MAPS}/index.json -- run the extractor, or open an ISO (milestone M5)`, 'error');
  }
}

/** The served source answers only when the disc tree has been extracted; the ISO source is M5. */
async function served(): Promise<boolean> {
  try {
    return (await fetch(`${MAPS}/index.json`)).ok;
  } catch {
    return false;
  }
}

function showMaps(maps: MapInfo[]): void {
  const ordered = sortByPopularity(maps); // the owner's popularity ranking, most played first
  mapList = ordered;
  const wanted = wantedArchive();
  const first = ordered.find((m) => m.archive.toUpperCase() === wanted)
    ?? ordered.find((m) => m.archive === DEFAULT_ARCHIVE) ?? ordered[0];
  ui.setMaps(ordered, first?.path ?? null);
  if (!first) {
    ui.setStatus('the served index lists no MP archives', 'error');
    return;
  }
  ui.setStatus(`loading ${first.name} ...`);
  load(first.path);
}

/**
 * Puts a decoded map on the screen without freezing the page doing it.
 *
 * The measured shape of the old stall: the fetch was 31-51 ms warm, the worker's decode 44-94 ms, the
 * handoff 1-27 ms and `buildWorld` 14-20 ms -- and then **one frame of 690 to 1,703 ms**, because that
 * frame is where three uploaded every texture and geometry and compiled every program. So the build is
 * still done here in one go, and what is spread out is the *showing*: `buildWorld` hands back its
 * objects in two queues (`./world`) and `./scheduler` adds them a budget's worth per frame.
 *
 * The old map is taken down when the world's own meshes are in, not before -- so the swap happens
 * between two drawn maps rather than through a blank one -- and the props stream in behind it.
 */
function show(map: LoadedMap): void {
  const t0 = performance.now();
  let previous = view;
  loaded = map;
  // The lighting is the map's own, read from its `GlobalLighting` record: three directional lights and
  // an ambient. The two sliders are trims on top of it and stay where the panel has them.
  lighting.rig = map.lightRig;
  // The map's own fog, before the world is built: `cameras/camera` in its `MP*.ZED` carries the
  // colour, the range and the enable bit the level was authored with. Two of the twenty-two ship
  // with it off, so the bit is honoured rather than the range being used as a proxy for it.
  if (map.camera) {
    fog.enabled = map.camera.fogEnabled;
    fog.near = map.camera.fogNear;
    fog.far = map.camera.fogFar;
    fog.color = [...map.camera.fogColor];
    // The altitude band, on the six maps that enable it: below its bottom everything is fog colour.
    fog.altitude = map.camera.fogAltitude ? { top: map.camera.fogTop, bottom: map.camera.fogBottom } : null;
    fogIsMine = false;                          // the new map's own fog, until a slider says otherwise
    ui.setFog(fog.near, fog.far, fog.color);
    ui.setFogEnabled(fog.enabled);
  }
  const built = buildWorld(map);
  view = built;
  scene.add(built.group);
  // Spend the depth buffer on this map: the near plane the game itself uses, and a far that just
  // covers the map's diagonal rather than the 40,000 the camera used to open with.
  fly.setClipPlanes(map.camera?.nearPlane ?? 4, Math.max(2000, view.box.min.distanceTo(view.box.max) * 1.6));
  // A map with no `cameras/camera` key takes a range off its own size rather than the last map's.
  if (!map.camera) {
    Object.assign(fog, fogForExtent(view.box.min.distanceTo(view.box.max)));
    fog.altitude = null;
    fogIsMine = false;                          // the fallback is the map's too, until a slider moves
    ui.setFog(fog.near, fog.far, fog.color);
  }
  overlays.place(built.box);
  // Held rather than built: the hull is tens of thousands of segments on the larger maps and the
  // checkbox is off by default, so `overlays` makes the object the first time it is switched on.
  overlays.placeCollision(map.collision);
  // 36 section 6: spawns are not on the disc. `@s2u/scene` holds the measured table, keyed by the name
  // `mission.rdr` shows, which is the name this map was just loaded under.
  const spawn: Spawns | undefined = spawnsFor(map.name);
  overlays.placeSpawns(spawn ?? null);
  // A new world starts in whatever state the panel is showing, not in the state it was built in.
  ui.apply(applyToggle);
  ui.applySliders(applySlider);   // a freshly built world starts at the panel's settings, not the defaults
  refreshFog();
  fly.setScale(map.metersPerUnit);
  // The map's own vertical field of view: `m_vfov` is a half-angle in radians, 24.5 degrees on all but
  // one map, so the picture is the 49-degree one a player saw rather than a wide-angle survey.
  if (map.camera) fly.setFov(2 * map.camera.vfov * 180 / Math.PI);
  fit?.();                                        // the PS2 presentation's aspect is the map's own

  if (spawn) {
    fly.lookFrom([spawn.a[0], spawn.a[1] + EYE, spawn.a[2]], spawn.b);
  } else {
    // No measured spawns for this map yet: stand off its own extent and look at the middle of it.
    const [cx, cy, cz] = centre(view.box);
    const reach = Math.max(view.box.max.x - view.box.min.x, view.box.max.z - view.box.min.z) || 1000;
    fly.lookFrom([cx, cy + reach * 0.4, cz + reach * 0.6], [cx, cy, cz]);
  }

  ui.select(map.path);
  ui.setPanelTitle(`${map.name} (${map.archive})`);   // what the collapsed bar reads
  ui.setDiagnostics(map.diagnostics);

  // The status line is written **when the world is on screen**, not when the map is decoded. Everything
  // that waits for a map -- the e2e, the screenshot tools -- waits on this line, and a line that
  // appeared while the scene was still filling in would hand them a half-drawn map to photograph.
  const draws = built.revealWorld.length + built.revealProps.length;
  const say = (suffix: string): void => ui.setStatus([
    `${map.name} (${map.archive})`,
    backend,
    // Abbreviated on a phone for the same reason two of the parts are dropped there: the line has to
    // fit on one row inside a 360px strip, and "tris" says as much as "triangles" does.
    `${built.triangles.toLocaleString('en-GB')} ${ui.isNarrow() ? 'tris' : 'triangles'}`,
    // One draw per queued object: a world mesh per texture, and an `InstancedMesh` (or a plain one, for
    // a prop placed once) per prop model-node. `map.world.length` counted only the world's.
    // These two go first on a narrow screen: they are the diagnosing eye's numbers, not the visitor's,
    // and on a phone the line has to fit in the top strip beside everything else.
    ...(ui.isNarrow() ? [] : [
      `${draws} draws`,
      `${map.collision.polygons.toLocaleString('en-GB')} collision polys`,
    ]),
    ui.isNarrow() ? `${map.loadMs} ms` : `${map.loadMs} ms load${suffix}`,
    // A thinner separator on a phone as well as fewer parts: "  |  " five times over is most of what
    // pushes the line onto a second row at 360px.
  ].join(ui.isNarrow() ? ' · ' : '  |  '));

  // The world first.
  //
  // The previous map stays in the scene until the new one's first meshes land, so the swap happens
  // between two drawn things rather than through a blank frame -- and no longer than that, because the
  // two maps share a coordinate range and leaving both up for the whole reveal draws one through the
  // other. Disposing it only then also means nothing is freed while it is still being drawn.
  const built0 = built;
  const retire = (): void => {
    if (!previous) return;
    scene.remove(previous.group);
    previous.dispose();
    previous = null;
  };
  revealing = spreadAcrossFrames(built.revealWorld, {
    onProgress: (done, total) => {
      retire();
      ui.setLoading(true, 'building the scene', total > 0 ? done / total : 1);
    },
  });
  void revealing.done.then(() => {
    if (view !== built0) return;                  // another map was picked while this one was revealing
    retire();
    ui.setLoading(false);
    say(`  |  ${Math.round(performance.now() - (askedAt || t0))} ms to first paint`);
    // The props follow, over further frames. The map is already drawn and flyable while they arrive,
    // and the flares among them are turned by the render loop on the frame after they land.
    revealing = spreadAcrossFrames(built0.revealProps);
  });
}

/**
 * The debug hook Playwright drives. `./hook` declares its shape and widens `Window` to hold it, so this is
 * a checked assignment to a real property rather than a cast of the global object.
 */
window.__viewer = {
  setCamera: (pose: Partial<Pose>) => fly.setPose(pose),
  pose: () => fly.pose(),
  stats: () => ({
    triangles: view?.triangles ?? 0,
    backend,
    diagnostics: loaded?.diagnostics ?? [],
    loadMs: loaded?.loadMs ?? 0,
    map: loaded?.name ?? null,
    collisionPolys: loaded?.collision.polygons ?? 0,
    untexturedDraws: view?.untextured ?? 0,
    shadowDraws: view?.shadowDraws ?? 0,
    alternateDraws: view?.alternateDraws ?? 0,
    spawns: (loaded && spawnsFor(loaded.name)) ?? null,
  }),
  toggles: () => ui.toggles(),
  chromeHidden: () => ui.chromeHidden(),
  panelCollapsed: () => ui.panelCollapsed(),
  flares: () => view?.flarePositions() ?? [],
  lines: () => view?.lineGroups() ?? [],
  sliders: () => ui.sliderValues(),
} satisfies ViewerHook;
