/// <reference types="vite/client" />
import { Matrix4, Scene, Timer, Vector3 } from 'three';
import type { MapInfo } from '@s2u/archive';
import { sortByPopularity } from './mapOrder';
import { HELD_RIFLE, materialTable, SEAL_TUNING, spawnsFor, tracerRound, type Spawns } from '@s2u/scene';
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
import { attachTouchControls, attachWalkTouch, wantsTouchControls } from './touch';
import { WalkMode } from './walk';
import { aimPoint } from './playerCamera';
import { explosionShake } from './look';
import { mergeInput, noInput, PAD_LAYOUT, PadWatch, padInput, pressedSince, type Input, type PadFlag } from './gamepad';
import type { TouchTarget } from './touch';
import { openingStand } from './stand';
import { Reticle, reticleType } from './reticle';
import { Hud, RangeFinder } from './hud';
import { actionInReach } from './mapActions';
import { TacMap } from './tacMap';
import { ScoreboardKeys } from './scoreboardKeys';
import { DEFAULT_PLAYER } from './scoreboard';
import { rankOf } from './mapOrder';
import { buildBody, type BodyView } from './bodyView';
import { Fire } from './fire';
import { Accuracy, defaultFireMode, fireInterval, FIRE_MODE_NAMES, kickStarts, kickTicks, nextFireMode, perturb, roundsPerPull } from './accuracy';
import { Zoom } from './zoom';
import { Play, playActions, StanceButton } from './play';
import { playEnabled, removePlayUi } from './features';
import { PLAY_CLIPS } from './animator';
import { TRAVERSAL_CLIPS } from './traversal';
import { TraversalPage } from './traversalPage';
import { gameAudio } from './audio';
import { Effects } from './effects';
import { WalkSounds } from './walkSounds';
import { WEAPON_CLIPS } from './weaponPose';
import { GrenadeThrower } from './grenade';
import { THROW_CLIPS, ThrowPose } from './throwPose';
import { WhiteOut } from './flash';
import type { SourceRequest, ViewerRequest, ViewerResponse } from './worker';

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

/** `materials.rdr`'s PENETRATION by material name (the built-ins and SOILS, `@s2u/scene`'s transcription): research 84. */
const SOIL_PENETRATION = new Map(materialTable().map((m) => [m.name, m.penetration]));

const canvas = document.getElementById('view') as HTMLCanvasElement | null;
if (!canvas) throw new Error('the page has no #view canvas');

/**
 * Playing as a SEAL (walk mode, the body, the rifle) is behind `?redotcom` (`./features`, the owner 2026-09-28). Without
 * it the play's markup is taken out of the page before the page is wired, and nothing below binds `G`, the pad's
 * Start, `R` or the hook's walk: the page is the fly camera alone.
 */
const PLAY = playEnabled(globalThis.location?.search ?? '');
if (!PLAY) removePlayUi();
const ui = new Ui();
const scene = new Scene();
const fly = new FlyCamera(canvas, {
  onSpeedChange: (m) => ui.setCameraHint(m, fly.isLocked()),
  onLockChange: (locked) => ui.setCameraHint(fly.multiplier(), locked),
  onFire: (down) => trigger(down),
});
const overlays = new Overlays(scene);
/**
 * Walk mode (W1.4, `./walk`): `G` and the panel's switch; the mover steps at 60 Hz and the game's third-person camera
 * follows it (W2.1, `./playerCamera`), `V` for first person.
 */
const walk = new WalkMode(fly, (on) => ui.setWalk(on));
/**
 * Web research 86 (`./traversalPage`): the ladder, the climb, the peek and the water on the walk; X, Q and E, the pad's
 * Cross and d-pad sides. The clips' callbacks sound through `Play.onEvent`; the slide's loop and landing through these.
 */
const traversal = new TraversalPage(walk, {
  play: (name, at) => { audio.play(name, at); },
  land: (speed, at) => { audio.onLand(speed, walkSounds.material(at), at); },
});
traversal.bindKeys();
/** W2.4 (`./reticle`): the game's rifle reticle, a HUD pass over the world, in walk mode only. */
const reticle = new Reticle();
/** The in-game HUD (`./hud`, research 87): the ammo box, the compass, the prompts -- a pass after the reticle's, walking only. */
const hud = new Hud();
const rangeFinder = new RangeFinder();
/** SOCOM II's tactical map (`./tacMap`, research 87 §9): `M` while walking (SELECT on the console), in the HUD pass. */
const tacMap = new TacMap(() => walk.mode() === 'walk');
tacMap.bindKey(globalThis, () => fly.pose().yaw);
tacMap.onToggle = (open) => hud.setTacMapOpen(open);
/** The multiplayer round's scoreboard (research 87 §12): SELECT held on a pad, Tab held on the keyboard, walking only. */
const scoreboardKeys = new ScoreboardKeys(() => walk.mode() === 'walk');
scoreboardKeys.bindKey();
const feetXZ = (): [number, number] | null => { const f = walk.feet(); return f ? [f[0], f[2]] : null; };
hud.setOverlay((frame, sizes) => tacMap.layout(frame, loaded?.tac ?? null, feetXZ() ?? [0, 0], fly.pose().yaw, sizes));
/**
 * W2.5 (`./fire`): the M4A1's hitscan round from the walk's eye along its aim, onto the hull the mover stands on, a
 * mark where it lands; the trigger is a left click while the mouse is captured, or the touch fire button; `R` reloads.
 */
const fire = new Fire({
  grid: () => walk.grid(), aim: () => walk.fireAim(),
  muzzle: () => play.muzzle(), reloadSeconds: () => play.reloadSeconds(),   // WEAPON: the rifle in hand (`./play`)
  look: () => (walk.mode() === 'walk' ? { pitch: (fly.pose().pitch * Math.PI) / 180, stance: walk.posture() } : null),
  kickPitch: (radians) => fly.addPitch(radians),                             // WEAPON: the kick (`./rifleKick`)
}, HELD_RIFLE);                   // the M4A1 SD the SEAL holds: its rate, its muzzle effect, its suppressed sound
scene.add(fire.object);
if (PLAY) fire.bindKey();
/**
 * The throwables (`./grenade`, web/docs/research/85): `4` the M67, `5` the HE, `1` the rifle -- the pad's L2 (the
 * game's SwapWeapon2) and R2 (its Inventory) -- and the trigger throws: held for power, let go to throw. The throw's
 * clip plays on the body (`./throwPose`), the grenade rides the right hand's held node, and leaves the posed hand.
 */
const grenade = new GrenadeThrower({
  grid: () => walk.grid(), snapshot: () => walk.snapshot(), view: () => walk.view(),
  handPoint: (part, p) => play.partPoint(part, p), heldNode: () => play.heldNode(),
  peek: () => traversal.stats()?.peek ?? 0,           // research 86's lean: the lean tosses
});
scene.add(grenade.object);
if (PLAY) grenade.bindKey();
/** The throw's clip over the locomotion, a pose layer as the reload is. */
const throwPose = new ThrowPose(() => play.motionSource());
/** The HUD's icon for the rifle (the HUD's own default): the grenades put theirs in its place while up. */
const RIFLE_ICON = 'm4carbine_icon.tif';
grenade.on('equip', (on) => {
  fire.release(); play.setRifleStowed(on);   // a slot change lets a held trigger go; the rifle away while the grenade is up
  if (!on) throwPose.stop();
  // Out of the scope with the rifle away [reading: the game's weapon switch, FUN_005c4b10, drops only the night vision
  // to first person; what a scoped grenade does was not traced -- research 84 section 7].
  if (on && zoom.state() >= 4) setZoom(1);
});
grenade.on('throwStart', ({ anim }) => { throwPose.start(anim); });
grenade.on('place', (info) => { audio.onAnimCallback(info.fireAnim, info.pos); });   // `c4_start`: .PLACE_CHARGE
// The throw's zAnim (`frag_start`, `HE_start`: `.THROW_OBJECT`); the bank's own name carries a trailing space.
grenade.on('throw', (info) => { if (!audio.onAnimCallback(info.fireAnim, info.from)) audio.play(info.sound, info.from); });
grenade.on('bounce', (info) => { if (info.sound) audio.onAnimCallback(info.anim, info.pos); });   // grenade_hit_<material>
/** The flashbang's white-out (`./flash`): `blindplayer0<level>` by the game's rule of distance and facing (0x597c00). */
const whiteOut = new WhiteOut(canvas?.parentElement ?? null);
grenade.on('explode', (info) => {
  if (info.flash) whiteOut.start(info.flash);
  // The zAnim's sound: the effects play it with the run (`effects.play`'s sound door); without the run, the material's
  // variant, whose zAnim starts the base (`frag_grenade`: .GREN_MED) -- the audio follows the call (research 81 §6).
  if (!info.byEffects) audio.onAnimCallback(info.anim, info.pos);
  // The game's screen shake by the distance (research 83, `./look`).
  if (info.distanceToPlayer !== null) { const s = explosionShake(info.distanceToPlayer); if (s) fly.shakeScreen(s); }
});
/**
 * Research 84 (`./accuracy`, `./zoom`): the M4A1 SD's gunplay -- the SEAL's rifle (the player spec's W2.R4) -- its
 * reticle's bloom and climb, where each round goes inside it, its fire modes (`B`; L3 on the pad, the UI's lane), and
 * the view states the scope steps through (the right button; d-pad Up / Down on the pad, the UI's `zoom` lane).
 */
const accuracy = new Accuracy(HELD_RIFLE);
const zoom = new Zoom(HELD_RIFLE);
let fireMode = defaultFireMode(HELD_RIFLE);
/** The map camera's vertical FOV in degrees; the zoom divides its tangent. */
let baseFov = 49;
fire.setGun({
  trigger: () => accuracy.trigger(),
  roundsPerPull: () => roundsPerPull(fireMode),
  interval: (fireWait) => fireInterval(fireWait, fireMode),
  round: (dir) => {
    // The round goes by the cone as the frame left it (FUN_005bd100 runs before the shot), then counts.
    const out = perturb(dir, accuracy.cone(zoom.state()));
    const stance = walk.mover()?.stance ?? 'stand';
    if (accuracy.round(zoom.state(), stance).dropZoom) setZoom(1);
    return out;
  },
  // Research 84 section 8: the camera kicks only scoped, on a pull's first round, and the kick ticks only scoped.
  kickStarts: () => kickStarts(zoom.state(), accuracy.rounds()),
  kickTicks: () => kickTicks(zoom.state()),
});
/** The HUD's name for a fire mode (`./hud`: the `firemode.tif` rounds, 1 / 3 / 4 of them). */
const HUD_FIRE_MODE = { 1: 'single', 2: 'burst', 3: 'auto' } as const;
function showFireMode(): void {
  const m = HUD_FIRE_MODE[fireMode as 1 | 2 | 3];
  if (m) hud.setFireMode(m);
}
showFireMode();
/** The fire-mode switch (`FUN_005c4600`; L3, `B`): not while scoped, nor while the grenade is up (it has one mode). */
function switchFireMode(): string {
  if (!grenade.equipped()) fireMode = nextFireMode(HELD_RIFLE, fireMode, zoom.target() > 1.01);
  showFireMode();
  return FIRE_MODE_NAMES[fireMode] ?? String(fireMode);
}
/** A view state, the way the game's own changes go: the knock cleared on leaving the scope (`FUN_005b9020`). */
function setZoom(state: number): void {
  const before = zoom.state();
  zoom.set(state);
  if (before >= 4 && zoom.state() < 4) accuracy.leaveScope();
}
/**
 * The zoom's steps, walking and with the rifle up: `in` d-pad Up (`FUN_005445b0`), `out` d-pad Down (`FUN_00544400`),
 * `cycle` the right button (in, and from the last level back to third person). The knock is cleared leaving a scope.
 */
function stepZoom(how: 'in' | 'out' | 'cycle'): number {
  if (walk.mode() !== 'walk' || grenade.equipped()) return zoom.state();
  const before = zoom.state();
  if (how === 'in') zoom.zoomIn(); else if (how === 'out') zoom.zoomOut(); else zoom.cycle();
  if (before >= 4 && zoom.state() < 4) accuracy.leaveScope();
  return zoom.state();
}
if (PLAY) globalThis.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.code !== 'KeyB' || e.ctrlKey || e.metaKey || e.altKey || e.repeat || walk.mode() !== 'walk') return;
  const target = e.target;
  if (typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
  switchFireMode();
});
/** The trigger, pressed or let go: the grenade's while it is up, else the rifle's -- only while walking. */
function trigger(down: boolean): void {
  if (grenade.equipped()) {
    if (down) grenade.pull();
    else grenade.release();
    return;
  }
  if (down) fire.pull();
  else fire.release();
}
/**
 * The sound (web/docs/research/81, `./audio`): the map's own banks, played on the walk's events (`./walkSounds`) --
 * the footfalls, the jump, the landing, the rifle's rounds and reload. The first click or key press unlocks it.
 * `gameAudio` is the API the panel and the other workstreams import from `./audio` (`setVolume`, `setMuted`,
 * `onFootstep`, `onFire`, `onReload`, `onJump`, `onLand`, `onAnimCallback`).
 */
const audio = gameAudio;
audio.unlockOn(globalThis);
audio.setFallTable(SEAL_TUNING.gravity, SEAL_TUNING.fallingDamage);
const walkSounds = new WalkSounds(audio, {
  walking: () => walk.mode() === 'walk',
  feet: () => walk.drawnFeet(),
  stance: () => walk.posture(),
  wish: () => fly.groundWish(),
  grid: () => walk.grid(),
});
/**
 * EFFECTS (web/docs/research/89, `./effects`): the game's own zAnim effect animations out of the map's `CZANIM.ZAR` --
 * a round's `FireAnimName` (the M4A1 SD's `muzzle_m4SD`: the casing, and the smoke source the retail data switches
 * off), the casings bouncing on the hull with their material's sound, the marks per surface (`Fire.setMarks`).
 * `effects.play(name, place)` is the grenades' door to their impacts and explosions.
 */
const effects = new Effects(Math.random, (name, at) => { audio.play(name, at); });
fire.setTracerRule(tracerRound);                  // EFFECTS: every fourth round of a tracer weapon; never the M4A1 SD's
scene.add(effects.object);
effects.setWorld(() => walk.grid());
// The grenades' explosions through the effects' door: the game's own zAnim (`frag_grenade_stone`, `smoke_grenade`,
// `flashcrash_grenade` ...) where the map has it; the grenade's placeholders only where it does not.
grenade.setEffectPlayer((anim, at) => effects.play(anim, { position: at.position, normal: at.normal ?? null, velocity: at.velocity ?? null }));
traversal.setEffects(effects);    // research 86: the water's ripples and a fall's splash
/**
 * The held weapon's node in the world and its `firepoint`'s place in it, for a round's effects (`FUN_005c5340` hands the
 * muzzle animation the weapon's node and `firepoint+0x30`: research 89 §4).
 */
function weaponFrame(): { matrix: Matrix4; muzzle: [number, number, number] | null } | null {
  const object = view?.weapon;
  const points = loaded?.weapon?.points ?? [];
  if (!object || !play.weaponStats().held) return null;
  object.updateWorldMatrix(true, false);
  const at = (name: string): [number, number, number] | null => {
    const p = points.find((q) => q.name === name);
    return p ? [p.at[0], p.at[1], p.at[2]] : null;
  };
  return { matrix: object.matrixWorld.clone(), muzzle: at('firepoint') ?? at('firepont') };
}
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

let view: WorldView | null = null;
let loaded: LoadedMap | null = null;
/** W2.1: the player's body, rebuilt with every map; shown by the panel's `body` switch (`./bodyView`). */
let body: BodyView | null = null;
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
  wantedMapFrom = source.kind;
  mapSource = source;
  rememberMap(path);
  revealing?.cancel();
  revealing = null;
  // The old map stays on screen and the camera stays live while this runs; what is taken away is the
  // picker, because a second load started over the first is how two maps end up half drawn together.
  ui.setLoading(true, 'fetching the archive', 0);
  ask({ kind: 'load', id: wantedMap, source, path });
};

/**
 * Where the archives come from (W1.7). The served tree is the default whenever `maps/index.json` answers;
 * the player's own disc image replaces it once opened. `source` is what the picker's paths are read from,
 * and it changes only when that source's map list arrives, so a map picked from the old list in the
 * meantime is still read from the source that listed it.
 */
const SERVED: SourceRequest = { kind: 'http', baseUrl: MAPS };
let source: SourceRequest = SERVED;
/** The source the wanted map list was asked of; it becomes `source` when that list arrives. */
let wantedIndexFrom: SourceRequest = SERVED;
/** The source the wanted map is being read from, and the one the map on screen came from, for `stats()`. */
let wantedMapFrom: SourceRequest['kind'] = 'http';
let shownFrom: SourceRequest['kind'] = 'http';
/** The source the wanted map is being read from, whole: the map's sound is asked of it too. */
let mapSource: SourceRequest = SERVED;

/** Asks `from` for its map list; the answer switches the picker, and the source, over to it. */
function askIndex(from: SourceRequest): void {
  wantedIndexFrom = from;
  wantedIndex = ++requests;
  ask({ kind: 'index', id: wantedIndex, source: from });
}

// ---- W2.2b: the play mode -- the walk with the body, the game's clips on the mover (`./play`, `./animator`) ---------
/**
 * The body and its clips: the map's body (`show`), the source's clips (`RUN/MOTION_P.ZAR` and `motion.rdr`, asked of
 * each source once its map list is in, as the seal table is), stepped once a frame after the walk. Without the pack
 * the body stands in its bind pose; the W2.1 body switch shows it in fly mode.
 */
const play = new Play();
play.addPoseLayer(throwPose.layer);   // the grenade's throw clip over the locomotion (`./throwPose`)
// WEAPON: the trigger raises the rifle (`./weaponRaise`), a reload plays its clip; `fire.subscribe` is also the
// audio's hook (`FireEvent`: every round, every reload's start and end).
play.setWeaponInput(() => ({ trigger: fire.triggerHeld(), aiming: walk.view() === 'first' }));
fire.subscribe((e) => { play.weaponEvent(e); walkSounds.fireEvent(e); });   // the pose and the sound, per round and reload
play.onEvent((e) => walkSounds.playEvent(e));   // the body's footfalls, clip callbacks and landings, heard
// The message window's lines a lone SEAL can cause (research 87 §14): a landing of the death class is the game's fall
// to death, "%s falls to their death" (0x65c440, `FUN_00547860`) -- the viewer's SEAL walks on.
play.onEvent((e) => { if (e.kind === 'land' && e.cls === 3) hud.postMessage(`${hud.state().model.name || DEFAULT_PLAYER} falls to their death`); });
// EFFECTS: the muzzle animation and the impact, per round; the `_zoom` variant in first person (the aim view).
fire.subscribe((e) => {
  if (e.type !== 'round') return;
  effects.onRound(e, weaponFrame(), walk.view() === 'first');
  // ACCURACY: every surface the round went through is struck too (FUN_003c8920 per hit), its impact without a muzzle.
  for (const t of e.through ?? []) effects.onRound({ ...e, to: t.point, normal: t.normal, material: t.material, hit: true, through: undefined }, null, false);
});
let wantedPlay = -1;
/** EFFECTS: the map's effect data, asked of the source the map came from once it is shown (`./effectData`). */
let wantedEffects = -1;
function askEffects(from: SourceRequest, path: string, archive: string): void {
  wantedEffects = ++requests;
  ask({ kind: 'effects', id: wantedEffects, source: from, path, archive });
}
/** The map's sound, asked of the source the map came from once it is shown (`./soundData`). */
let wantedSound = -1;
function askSound(from: SourceRequest, path: string, archive: string): void {
  wantedSound = ++requests;
  ask({ kind: 'sound', id: wantedSound, source: from, path, archive });
}
function askPlay(from: SourceRequest): void {
  wantedPlay = ++requests;
  ask({ kind: 'play', id: wantedPlay, source: from, clips: [...PLAY_CLIPS, ...WEAPON_CLIPS, ...TRAVERSAL_CLIPS, ...THROW_CLIPS] });
}

// ---- W2.6: the aim view and the pad's lanes in play (`./play`, `./walk`) ---------------------------------------------
/**
 * The aim view: held on the pad's aim lane (L1, W2.R5), or stepped into by the zoom (research 84: the game's first zoom
 * step is the first-person view, state 1) -- the right mouse button on the canvas is the zoom's press (a `mousedown`,
 * which fires for each button, where a `pointerdown` does not while another is held). The fire button is W2.4's.
 */
canvas.addEventListener('mousedown', (e) => { if (e.button === 2) stepZoom('cycle'); });

/**
 * The merged lanes (the pad and the touch buttons, `padFrame`) in play: the jump on the press, the crouch on the release
 * (docs/PLAYTEST.md step 8), the aim while held (`playActions`), and the stance button's tap (crouch) and hold (prone;
 * `StanceButton`, one step a frame). In the fly camera the same lanes are up and down.
 */
const stanceButton = new StanceButton();
/** The hook's aim (`setAim(true)`), over the lanes until `setAim(false)` hands it back: Playwright holds no button. */
let aimForced = false;
function playLanes(before: Input, after: Input, dt: number): void {
  const act = playActions(before, after);
  const walking = walk.mode() === 'walk';
  if (walking) {
    if (act.jump) walk.jump();
    if (act.crouch) walk.crouch();
  }
  // Fed a released button off foot, so a press begun in the fly camera is not a tap when the walk begins.
  const go = stanceButton.update(walking && after.stance, dt, walk.stance());
  if (go !== null) walk.setStance(go);
  // First person while the pad's aim lane is held or the zoom is at 1 or more (research 84: its first step is that view).
  walk.setAiming(walking && (aimForced || act.aim || zoom.firstPerson()));
}

/** The map's `LensFX_NVG` colour, and whether the night vision is on. */
let nightLens: [number, number, number, number] | null = null;
let nightOn = false;
/**
 * The night vision's colour on the frame [approximation, research 84 section 14]. The game loads a colour matrix whose
 * four rows are all `(r x 0.33, g x 0.33, b x 0.33, a x 3.03)` of `LensFX_NVG` (0.2, 0.898, 0.2, 0.24) -- `0x3b78d0`
 * from `0x5c1800` -- i.e. every channel of a lit colour becomes `0.066 R + 0.296 G + 0.066 B + 0.727`: the night's
 * dark vertex lighting lifted to a flat, bright grey the textures then modulate, the green coming from the goggles
 * (`nvg_part.tif`, 17 % green inside) and the fog tinted by the lens. That is a per-vertex change the world renderer
 * would make; until it does, the viewer puts a frame filter on the canvas: the rows' weights normalised to a
 * luminance, a gain of `NIGHT_GAIN` for the lift, tinted by the lens's colour with green at 1.
 */
const NIGHT_GAIN = 3;
function setNightFilter(lens: [number, number, number, number] | null): void {
  if (!canvas) return;
  if (!lens) { canvas.style.filter = ''; return; }
  const id = 's2u-nvg';
  let svg: Element | null = document.getElementById(`${id}-svg`);
  if (!svg) {
    const made = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    made.id = `${id}-svg`;
    made.setAttribute('width', '0'); made.setAttribute('height', '0');
    made.style.position = 'absolute';
    made.innerHTML = `<filter id="${id}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values=""/></filter>`;
    document.body.appendChild(made);
    svg = made;
  }
  // The rows' weights (0.066, 0.296, 0.066 of the lens) as a luminance summing to 1, times the gain, times the tint.
  const w = [lens[0], lens[1], lens[2]].map((c) => c / (lens[0] + lens[1] + lens[2]));
  const tint = [lens[0] / lens[1], 1, lens[2] / lens[1]];
  const row = (t: number): string => w.map((x) => (x * NIGHT_GAIN * t).toFixed(4)).join(' ') + ' 0 0';
  svg.querySelector('feColorMatrix')!.setAttribute('values', `${row(tint[0]!)} ${row(tint[1]!)} ${row(tint[2]!)} 0 0 0 1 0`);
  canvas.style.filter = `url(#${id})`;
}
/** The look a frame ago, degrees (the turn and pitch rates the bloom reads), or null to start again. */
let lastLook: { yaw: number; pitch: number } | null = null;
let lastFov = -1;
/** Degrees of look in one frame past which the change is a placement, not a turn (no bloom). */
const LOOK_JUMP = 45;
/**
 * One frame of the gun (research 84): the bloom's 60 Hz ticks off the mover and the look's rates (`FUN_005c2670`), the
 * zoom's run and the FOV it sets, the look's scale for the scope. Leaving the walk drops the zoom.
 */
function gunFrame(dt: number, walking: boolean): void {
  const snap = walking ? walk.snapshot() : null;
  if (!snap) {
    if (zoom.state() !== 0) { zoom.reset(); accuracy.leaveScope(); }
    lastLook = null;
  } else {
    const pose = fly.pose();
    let yawRate = 0, pitchRate = 0;
    if (lastLook && dt > 0) {
      const dy = ((pose.yaw - lastLook.yaw + 540) % 360) - 180, dp = pose.pitch - lastLook.pitch;
      // A jump of more than a quarter turn in one frame is a placement (the hook, a respawn), not a turn.
      if (Math.abs(dy) < LOOK_JUMP && Math.abs(dp) < LOOK_JUMP) {
        yawRate = (dy * Math.PI / 180) / dt;
        pitchRate = (dp * Math.PI / 180) / dt;
      }
    }
    lastLook = { yaw: pose.yaw, pitch: pose.pitch };
    accuracy.update(dt, {
      stance: snap.stance, velocity: [snap.vx, snap.vy, snap.vz], airborne: snap.airborne,
      yawRate, pitchRate, zoomState: zoom.state(),
    });
  }
  zoom.update(dt);
  const fov = zoom.fov(baseFov);
  if (Math.abs(fov - lastFov) > 1e-6) { fly.setFov(fov); lastFov = fov; }
  // The look's divisor (FUN_005966a0, `FUN_005be660`): the LOOK workstream's law takes the magnification and mode 4.
  fly.setZoom(1 / zoom.lookScale() / (zoom.state() === 4 ? 5 : 1), zoom.state() === 4);
  hud.setZoom(zoom.magnification());
  // The night vision (view state 3): the goggles on the reticle's layer, the lens's green colour matrix on the frame,
  // the goggles' sound in and out (DAT_0044ce30/38: .NV_GOGGLES_ON / _OFF).
  const night = zoom.view() === 'nightvision';
  reticle.setNight(night);
  if (night !== nightOn) {
    nightOn = night;
    setNightFilter(night ? nightLens : null);
    if (walking) audio.play(night ? '.NV_GOGGLES_ON' : '.NV_GOGGLES_OFF', walk.drawnFeet());
  }
}

/**
 * The player's own disc (W1.7, milestone M5): a `File` from the panel's file input or dropped on the page,
 * handed to the worker, which lists its maps by range and reads the chosen archive out of it. The image is
 * never uploaded and the page itself reads none of it.
 */
function openDisc(file: File): void {
  ui.setStatus(`reading the disc image ${file.name} ...`);
  askIndex({ kind: 'iso', file });
}
ui.onDisc(openDisc);

worker.addEventListener('message', (event: MessageEvent<ViewerResponse>) => {
  const message = event.data;
  if (message.kind === 'error') {
    if (message.id !== wantedIndex && message.id !== wantedMap) return;
    if (message.id === wantedIndex) wantedIndexFrom = source;   // a disc that will not open changes nothing
    ui.setLoading(false);
    ui.setStatus(`failed while ${message.doing}: ${message.message}`, 'error');
    return;
  }
  if (message.kind === 'index') {
    if (message.id !== wantedIndex) return;
    source = wantedIndexFrom;
    showMaps(message.maps);
    askPlay(source);
    return;
  }
  if (message.kind === 'play') {
    if (message.id === wantedPlay) { play.setClips(message.data); traversal.setClips(message.data); }
    return;
  }
  if (message.kind === 'sound') {
    if (message.id === wantedSound) audio.setData(message.data);
    return;
  }
  if (message.kind === 'soundLoops') {
    if (message.id === wantedSound) audio.setLoops(message.loops);
    return;
  }
  if (message.kind === 'effects') {
    if (message.id !== wantedEffects) return;
    effects.setData(message.data);
    fire.setMarks(effects.marks());                 // decals.rdr's row per surface material, or the one mark
    // ACCURACY (research 84 section 13): the round goes through what the game lets it -- the material byte's name
    // (the effects' table: built-ins, then SOILS; 0 the map's DefaultMaterial) to its PENETRATION.
    fire.setPenetration((byte) => {
      const name = byte === undefined ? undefined : effects.materialName(byte);
      return name ? (SOIL_PENETRATION.get(name) ?? 0) : 0;
    });
    return;
  }
  if (message.kind === 'progress') {
    if (message.id !== wantedMap) return;               // a stage of a load we have moved on from
    ui.setLoading(true, STAGE_WORDS[message.stage], message.total > 0 ? message.done / message.total : 0);
    return;
  }
  if (message.id !== wantedMap) return;
  shownFrom = wantedMapFrom;
  show(message.map);
  askSound(mapSource, message.map.path, message.map.archive);
  askEffects(mapSource, message.map.path, message.map.archive);
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

// ---- W2.7: the controller (`./gamepad`, ruling W2.R5) ------------------------------------------------------------
/**
 * The touch stick's lane (`./touch`), held here rather than written into the camera so a pad's can be merged with it
 * each frame (`padFrame`). The up and down buttons are the same `jump` and `crouch` a pad's Square and L3 are.
 */
const touchInput: Input = noInput();
const touchLane: TouchTarget = {
  setStick: (x, y) => { touchInput.moveX = x; touchInput.moveY = y; },
  setLift: (v) => { touchInput.jump = v > 0; touchInput.crouch = v < 0; },
  setStickBoost: (on) => { touchInput.boost = on; },
};
/**
 * Walk mode's touch buttons (`attachWalkTouch`) hold the same lanes a pad's buttons do, in `touchInput`. A release is
 * kept until the frame after the press was read (`touchReleased`, cleared at the end of `padFrame`), so a tap shorter
 * than a frame is still an edge; a press again before that cancels the release.
 */
const touchReleased = new Set<PadFlag>();
function holdTouch(lane: PadFlag, down: boolean): void {
  if (down) { touchInput[lane] = true; touchReleased.delete(lane); } else touchReleased.add(lane);
}
/** The pads, from the events and the poll: a toast names each that comes, and says when one goes (W2.R5). */
const pads = new PadWatch({
  connected: (id) => {
    ui.toast(`Controller connected: ${id}`);
    ui.showPadLayout(PAD_LAYOUT);                 // the first connect shows the layout; a later one finds it there
    ui.setPadConnected(true);
  },
  disconnected: () => {
    ui.toast('Controller disconnected');
    ui.setPadConnected(pads.count() > 0);
  },
});
pads.attach(globalThis);
/** The pad's own input last frame, for its edges; and what the camera and the mover were fed, for the hook. */
let padLast: Input = noInput();
let padMerged: Input = noInput();
/**
 * One frame of the controller, before the camera's: the pad read through the layout (`padInput`), merged with the
 * touch stick (the larger push on each axis, the buttons OR-ed; `mergeInput`) and fed to the camera's lanes -- which
 * the fly camera flies by and the walk's mover steps by (`groundWish`), so one mapping drives both (W2.R5). The right
 * stick turns at the arrow keys' rate, scaled (`setLook`). Up and down are the fly camera's; on foot the jump and the
 * crouch are the mover's (W2.3a), to be read from `padMerged` there -- the game's crouch acts on the release
 * (docs/PLAYTEST.md step 8; `releasedSince`); the stance button's tap and hold are `StanceButton`'s. Start toggles walk and fly on its press, as `G` does on its keydown.
 */
function padFrame(dt: number): void {
  const pad = padInput(pads.poll(navigator));
  const input = mergeInput(touchInput, pad);
  fly.setStick(input.moveX, input.moveY);
  fly.setLift((input.jump ? 1 : 0) - (input.crouch || input.stance ? 1 : 0));
  fly.setStickBoost(input.boost);
  fly.setLook(input.lookX, input.lookY);
  if (PLAY && pressedSince(padLast, pad).includes('mode')) walk.setMode(walk.mode() === 'walk' ? 'fly' : 'walk');
  // R1 is the trigger, as the mouse button is: held it fires at the rifle's rate, let go it stops. Only the pad's own
  // edges, so a released R1 never lets go of a mouse button or the touch button still held.
  // The merged lane, so the touch fire button (`touchInput.fire`) is the trigger the same way; a released R1 still never
  // lets go of a button the other source holds.
  if (PLAY && input.fire !== padMerged.fire) trigger(input.fire);
  // Research 84: d-pad Up and Down step the zoom in and out, L3 the fire mode (walking, the rifle up). The edges are of
  // the merged lanes: a touch button and a pad's are the same press.
  const pressed = pressedSince(padMerged, input);
  if (pressed.includes('zoom')) stepZoom('in');
  if (pressed.includes('zoomOut')) stepZoom('out');
  if (pressed.includes('fireMode') && walk.mode() === 'walk') switchFireMode();
  // The kit's slots (the game's L1 SwapWeapon1, L2 SwapWeapon2 and R2 Inventory, research 85 §9), walking only.
  if (PLAY && walk.mode() === 'walk') {
    if (pressed.includes('swap1')) grenade.equip(false);
    if (pressed.includes('swap2')) grenade.swap2();
    if (pressed.includes('inventory')) grenade.cycleInventory();
  }
  playLanes(padMerged, input, dt);  // W2.6: jump, crouch, stance and aim on foot
  traversal.padLanes(padMerged, input);   // research 86: Cross the action, the d-pad's sides the peek
  padLast = pad;
  padMerged = input;
  for (const lane of touchReleased) touchInput[lane] = false;   // read this frame; let go for the next
  touchReleased.clear();
}
attachTouchControls(touchLane, () => { if (walk.mode() === 'walk') walk.cycleStance(); }, trigger);
attachWalkTouch(holdTouch, () => { if (walk.mode() === 'walk') fire.reload(); });
if (PLAY) {
  walk.bindKey();
  ui.onWalkSwitch((on) => { if (!walk.setMode(on ? 'walk' : 'fly')) ui.setWalk(false); });
}
ui.onPanelToggle();
ui.onControlsPopover();
// Round 2: the panel's Sound and Mouse look sections (each is on the page only with `?redotcom`), remembered in this browser.
ui.onSound({ volume: (v) => audio.setVolume(v), muted: (m) => audio.setMuted(m) });
ui.onLookControls((opts) => fly.setLookOptions(opts));
const revision = ui.showRevision();

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
  body?.setLighting(lighting);
}

function applyToggle(name: ToggleName, on: boolean): void {
  if (name === 'grid') overlays.setGrid(on);
  else if (name === 'collision') overlays.setCollision(on);
  else if (name === 'spawns') overlays.setSpawns(on);
  else if (name === 'wireframe') view?.setWireframe(on);
  else if (name === 'fog') { fog.enabled = on; refreshFog(); }
  else if (name === 'blendgraded') view?.setBlendGraded(on);
  else if (name === 'engineorder') view?.setEngineOrder(on);
  else if (name === 'shadows') view?.setShadows(on);
  else if (name === 'alternate') view?.setAlternate(on);
  else if (name === 'detail') view?.setDetail(on);
  else if (name === 'linestrips') view?.setLineStrips(on);
  else if (name === 'billboards') view?.setBillboards(on);
  else if (name === 'untextured') view?.setUntexturedHighlight(on);
  else if (name === 'rigeverywhere') { lighting.rigEverywhere = on; view?.setLighting(lighting); }
  else if (name === 'body') play.setFlyToggle(on);        // W2.2b: the body in fly mode; in play it is always shown
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
    padFrame(dt);                   // W2.7: the pad and the touch stick into the camera's lanes, before it steps
    fly.setBody(walk.mode() === 'walk' && walk.view() === 'first', walk.posture() === 'prone');   // the bob's (research 83)
    fly.update(dt);
    traversal.input();              // research 86: the peek held (Q / E, the pad's lean lanes)
    walk.frame(dt);                 // walk mode: the mover's 60 Hz ticks, the game's camera after each, the view placed
    const walking = walk.mode() === 'walk';
    gunFrame(dt, walking);          // research 84: the bloom, the zoom and its FOV
    for (const name of throwPose.step(dt)) audio.onAnimCallback(name, walk.drawnFeet());   // the throw clip's `throw_whoosh`
    play.frame(dt, walk, fly.camera);   // W2.2b: the body at the drawn feet in its clip; hidden in first person
    if (!walking) fire.release();  // leaving the walk lets a held trigger go
    fire.update(dt);                // W2.5: the reload, the rate, a held trigger's rounds, the tracer's one frame
    effects.setBrighten(brightenOf(lighting));
    effects.update(dt, fly.camera); // EFFECTS: the zAnim effect runs, the casings, the particles
    fly.camera.updateMatrixWorld();
    audio.setListener(fly.camera.matrixWorld.elements);   // the game's listener is the camera (0x48dd40)
    walkSounds.frame([fly.camera.position.x, fly.camera.position.y, fly.camera.position.z]);   // the reverb, the beds
    grenade.update(dt);
    whiteOut.update(dt);             // the held throw, the grenades in the air at 60 Hz, the explosions
    view?.frame(fly.camera, dt);   // the flares turn, the LODs pick, the oceans scroll -- before the draw
    render(scene, fly.camera);
    const aim = walk.aim();
    if (aim) {
      // The reticle on the aim point (FUN_00297410's, 1000 ahead along the look): the frame's centre at rest.
      fly.camera.updateMatrixWorld();
      const [nx, ny] = aimPoint(fly.camera, aim);
      const [sx, sy] = fly.screenShift();   // the shake and the bob move the world, not the HUD (research 83)
      reticle.setAimPoint(nx - sx, ny - sy);
      // Research 84: the HUD's size (halved in third person) and the knock's climb; the scope's overlay at 5 and up.
      const r = accuracy.reticle(zoom.state());
      reticle.setSize(r.size, r.offset);
      reticle.setMode(zoom.view() === 'scope' && !grenade.equipped() ? 'scope' : 'reticle');
      // The weapon's reticle set (FUN_005be300: by its ID and the view): the rifle's for the M4A1 SD, the sidearm's for a pistol.
      reticle.setSet(reticleType(HELD_RIFLE.id, zoom.state(), zoom.target()));
    }
    if (!walking) tacMap.setOpen(false);
    tacMap.frame(dt);
    const scoreboard = walking && (padMerged.scoreboard || scoreboardKeys.held());
    hud.setScoreboard(scoreboard);     // research 87 §12: SELECT (Tab) held; it hides the reticle too (L56808-56828)
    reticle.setVisible(walking && !tacMap.isOpen() && !scoreboard);
    reticle.render(created.renderer);
    hud.setVisible(walking);
    traversal.hudFrame(hud);        // research 86: the ladder slide's icon on a ladder
    traversal.effectsFrame();       // research 86: the water's ripples (FUN_005b52b0)
    hud.setWeaponIcon(grenade.icon() ?? RIFLE_ICON);   // the throwable's HUDW icon while it is up
    hud.feed({
      // With the grenade up the box counts the M67s left (the item and its count, research 85); else the rifle's magazine.
      magazine: grenade.equipped() ? { rounds: grenade.stats().left, capacity: grenade.stats().left, spare: 0, reloading: false } : fire.state().magazine,
      yaw: fly.pose().yaw, stance: walk.posture(), climb: traversal.hudClimb(),
      range: walking ? rangeFinder.measure(walk.grid(), walk.fireAim(), performance.now() / 1000) : null,
      nearby: walking && actionInReach(loaded?.actions ?? [], walk.feet(), ['DOOR']) ? 'door' : null,
      position: walking ? feetXZ() : null,
    });
    hud.render(created.renderer);

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

  const hasServed = await served();
  if (wantedIndexFrom.kind === 'iso') return;     // a disc was opened while the page came up: it wins
  if (hasServed) {
    ui.setStatus(`${backend}: indexing the archives ...`);
    askIndex(SERVED);
  } else {
    // A site with no maps of its own (W1.7): the disc is the way in, so the panel is opened on it.
    ui.offerDisc();
    ui.setStatus('no maps are served here: open your own SOCOM II disc image (.iso) -- it is read in this browser, never uploaded');
  }
}

/** The served source answers only when the disc tree has been extracted; otherwise the disc is the source. */
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
    ui.setStatus(source.kind === 'iso' ? 'the disc image holds no RUN/MP*.ZDB archives: is it SOCOM II?'
      : 'the served index lists no MP archives', 'error');
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
  reticle.setBitmaps(map.reticle);
  hud.setBitmaps(map.hud);
  hud.setNavPoints((map.tac?.points ?? []).filter((p) => p.kind === 1));
  hud.setGame(map.name, rankOf(map.name)?.mode ?? '');
  tacMap.setOpen(false);
  fire.reset();                                   // a new map: no marks, full magazines
  effects.setData(null);                          // EFFECTS: the old map's effects go; the new map's follow it
  fire.setMarks(null);
  fire.setPenetration(null);
  fire.setBitmap(map.bulletMark);                 // decals.rdr's bullet mark off EFFE_TXR, or the dark disc
  const built = buildWorld(map);
  view = built;
  grenade.setMap(built.grenades, map.grenade);
  throwPose.stop();     // the M67's model, its effect bitmaps, the map's DefaultMaterial
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
  // The measured table (`@s2u/scene`'s `spawnsFor`, keyed by the name `mission.rdr` shows) still places the
  // camera, at A's (x, z) below; the overlay draws it beside the disc's spawn slots, read in the worker from
  // `AIMAPS.MPS` (W1.5b). Which slot a player gets is game logic, so the stand is not moved to one (W1.R9).
  const spawn: Spawns | undefined = spawnsFor(map.name);
  overlays.placeSpawns(spawn ?? null, map.slots);
  // W2.1: the player's body, in its bind pose at slot A (`./body`, `./bodyView`); the switch below shows it.
  if (body) { scene.remove(body.group); body.dispose(); }
  body = map.body ? buildBody(map.body, map, lighting) : null;
  if (body) scene.add(body.group);
  play.setBody(body, map.body ?? null);            // W2.2b: the play mode's body and skeleton
  play.setWeapon(built.weapon, map.weapon?.points ?? []);   // WEAPON: the M4A1 SD in the right hand, at its grip
  // A new world starts in whatever state the panel is showing, not in the state it was built in.
  ui.apply(applyToggle);
  ui.applySliders(applySlider);   // a freshly built world starts at the panel's settings, not the defaults
  refreshFog();
  fly.setScale(map.metersPerUnit);
  // The map's own vertical field of view: `m_vfov` is a half-angle in radians, 24.5 degrees on all but
  // one map, so the picture is the 49-degree one a player saw rather than a wide-angle survey.
  if (map.camera) {
    baseFov = 2 * map.camera.vfov * 180 / Math.PI;
    accuracy.setFov({ hfov: map.camera.hfov, vfov: map.camera.vfov });
  }
  zoom.reset();
  accuracy.reset();
  // Research 84 section 14: a night map's zoom steps into the night vision (NightMission, CWorld+0x5dc), its lens colour.
  zoom.setNight(!!map.night?.mission);
  nightLens = map.night?.lens ?? null;
  fly.setFov(baseFov);
  fit?.();                                        // the PS2 presentation's aspect is the map's own

  // W1.4b: the stand the worker worked out (`LoadedMap.stand`, `./stand`): A's (x, z), `EYE` over the ground
  // probe's floor there, not over A's recorded y -- the orbit camera's on 20 maps, 25 over that floor.
  const stand = spawn ? map.stand ?? openingStand(spawn.a, undefined) : null;
  if (spawn && stand) {
    fly.lookFrom(stand.position, spawn.b);
  } else {
    // No measured spawns for this map yet: stand off its own extent and look at the middle of it.
    const [cx, cy, cz] = centre(view.box);
    const reach = Math.max(view.box.max.x - view.box.min.x, view.box.max.z - view.box.min.z) || 1000;
    fly.lookFrom([cx, cy + reach * 0.4, cz + reach * 0.6], [cx, cy, cz]);
  }
  // The walk's ground: the probe's polygons and grid. A walking mover is stood on the new map under the camera
  // just placed, or at spawn A's (x, z) on the stand's floor (A's recorded y where the probe found none).
  walk.setGround(map.ground, spawn && stand ? [spawn.a[0], stand.floor ?? spawn.a[1], spawn.a[2]] : null);

  ui.select(map.path);
  ui.setPanelTitle(`${map.name} (${map.archive})`);   // the folded cog's tooltip
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
    // The system's separator on every width: "  |  " five times over was most of what pushed the
    // line onto a second row at 360px, and the phone and the desktop should read as one line.
  ].join(' · '));

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
    say(` · ${Math.round(performance.now() - (askedAt || t0))} ms to first paint`);
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
  setCamera: (pose: Partial<Pose>) => walk.setCamera(pose),
  pose: () => fly.pose(),
  stats: () => ({
    triangles: view?.triangles ?? 0,
    backend,
    diagnostics: loaded?.diagnostics ?? [],
    loadMs: loaded?.loadMs ?? 0,
    map: loaded?.name ?? null,
    source: shownFrom,
    collisionPolys: loaded?.collision.polygons ?? 0,
    untexturedDraws: view?.untextured ?? 0,
    shadowDraws: view?.shadowDraws ?? 0,
    alternateDraws: view?.alternateDraws ?? 0,
    detailDraws: view?.detailDraws ?? 0,
    spawns: (loaded && spawnsFor(loaded.name)) ?? null,
    stand: loaded?.stand ?? null,
    slots: overlays.slotCounts(),
    body: body ? { ...body.stats, visible: body.group.visible } : null,
    anim: play.animStats(),
    view: play.viewStats(),
  }),
  toggles: () => ui.toggles(),
  chromeHidden: () => ui.chromeHidden(),
  panelCollapsed: () => ui.panelCollapsed(),
  flares: () => view?.flarePositions() ?? [],
  lines: () => view?.lineGroups() ?? [],
  sliders: () => ui.sliderValues(),
  mode: () => walk.mode(),
  setMode: (mode) => (mode === 'walk' && !PLAY ? false : walk.setMode(mode)),
  walkFor: (seconds, input) => walk.walkFor(seconds, { forward: input?.forward ?? 1, right: input?.right ?? 0, boost: false }),
  feet: () => walk.feet(),
  pad: () => ({ id: pads.id(), input: { ...padMerged } }),
  mover: () => walk.mover(),
  jump: () => walk.jump(),
  crouch: (on) => walk.crouch(on),
  setAim: (on) => { aimForced = on; walk.setAiming(walk.mode() === 'walk' && on); return walk.view(); },
  look: () => fly.lookState(),
  setLook: (opts) => { fly.setLookOptions(opts); return fly.lookOptions(); },
  setZoom: (magnification, mode4) => fly.setZoom(magnification, mode4),
  shake: (distance) => { const s = explosionShake(distance); if (s) fly.shakeScreen(s); return s !== null; },
  zoom: () => ({ state: zoom.state(), view: zoom.view(), magnification: zoom.magnification(), fov: zoom.fov(baseFov), lookScale: zoom.lookScale() }),
  zoomIn: () => stepZoom('in'),
  zoomOut: () => stepZoom('out'),
  cycleZoom: () => stepZoom('cycle'),
  fireMode: () => FIRE_MODE_NAMES[fireMode] ?? String(fireMode),
  switchFireMode: () => switchFireMode(),
  accuracy: () => ({ ...accuracy.state(), cone: accuracy.cone(zoom.state()) }),
  reticle: () => reticle.state(),
  stance: () => walk.stance(),
  setStance: (stance) => walk.setStance(stance),
  camera: () => walk.cameraState(),
  setView: (view) => walk.setView(view),
  fire: () => fire.state(),
  shoot: () => fire.shoot(),
  traversal: () => traversal.stats(),
  action: () => traversal.action(),
  setLean: (side) => { traversal.hookLean = side; },
  audio: () => audio.stats(),
  setAudio: (settings) => {
    if (settings.volume !== undefined) audio.setVolume(settings.volume);
    if (settings.muted !== undefined) audio.setMuted(settings.muted);
    return audio.stats();
  },
  weapon: () => play.weaponStats(),
  trigger: (down) => trigger(down),
  setGear: (name, on) => play.setGearVisible(name, on),
  hud: () => hud.state(),
  setHud: (patch) => { hud.patch(patch); return hud.state(); },
  grenade: () => grenade.stats(),
  throwGrenade: (holdSeconds = 1, immediate = true) => grenade.throwNow(holdSeconds, immediate),
  equipGrenade: (on) => grenade.equip(on),
  grenadeTrail: (on) => grenade.setTrail(on),
  resetGrenades: () => grenade.reset(),
  selectItem: (item) => grenade.select(item),
  throwClip: () => throwPose.stats(),
  whiteOut: () => whiteOut.state(),
  detonateCharges: () => grenade.detonateCharges(),
  effects: () => effects.stats(),
  playEffect: (name, at, kind = 'impact') => {
    // 30 units ahead of the camera unless told where; a muzzle effect with a node whose barrel runs across the view to
    // the right (the flash seen from the side), an impact at the world point facing up, the round coming down the view.
    fly.camera.updateMatrixWorld();
    const cam = fly.camera.matrixWorld;
    const ahead = new Vector3(0, 0, -30).applyMatrix4(cam);
    const where = at ? new Vector3(...at) : ahead;
    const forward = new Vector3(0, 0, -1).transformDirection(cam);
    if (kind === 'muzzle') {
      // The weapon's frame: x along the barrel (the camera's right), y up, z to the barrel's right.
      const x = new Vector3(1, 0, 0).transformDirection(cam), z = new Vector3().crossVectors(x, new Vector3(0, 1, 0)).normalize(), y = new Vector3().crossVectors(z, x);
      const node = new Matrix4().makeBasis(x, y, z).setPosition(where);
      return effects.play(name, { node, position: [0, 0, 0], velocity: forward.toArray() as [number, number, number] });
    }
    return effects.play(name, { position: where.toArray() as [number, number, number], velocity: forward.toArray() as [number, number, number], normal: [0, 1, 0] });
  },
  pauseEffects: (on) => { effects.paused = on; },
  tacMap: () => tacMap.state(),
  setTacMap: (open) => { tacMap.setOpen(open, fly.pose().yaw); return tacMap.state(); },
  revision,
} satisfies ViewerHook;
