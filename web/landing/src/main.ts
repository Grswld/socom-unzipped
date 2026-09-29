import { createRoller, move, lit, type RollerState } from './roller';
import { Sfx } from './sfx';
import { GITHUB_URL } from './github';
import { keyIntent, startGamepadPolling, type Intent } from './input';
import { STATS_URL, POLL_MS, OFFLINE, parseStats, statusRows, gameRows, type Stats } from './stats';
import { GUIDE_TABS } from './guide';
import { parseVolume, levels } from './volume';
import { BUGS_URL, FIELDS, createForm, moveField, currentField, checkForm, buildPayload, replyText, type FormState } from './report';
import { TABS, STORY_URL, createAbout, moveTab, currentTab, type AboutState, type Tab } from './about';

declare const __APP_VERSION__: string;
declare const __BUILD_STAMP__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const backdrop = $<HTMLCanvasElement>('backdrop');
const boot = $('boot');
const bootText = $('boot-text');
const menu = $('menu');
const about = $('about');
const stats = $('stats');
const report = $('report');
const video = $<HTMLVideoElement>('bg');
const itemsEl = $('items');
const fade = $('fade');
const muteBtn = $<HTMLButtonElement>('mute');
const audioBox = $('audio');
const webLink = $('webui'); // the way over to the web site (index.html, the default view), shown with the speaker once the menu is up
const volumeEl = $<HTMLInputElement>('volume');

type Screen = 'boot' | 'menu' | 'about' | 'stats' | 'report';
let screen: Screen = 'boot';

// ---- stage scaling: keep the 640x480 frame centred and as large as fits ----
let stageScale = 1; // window px per stage px, for pointer travel measured on the stage
function fit(): void {
  const s = Math.min(innerWidth / 640, innerHeight / 480);
  stageScale = s;
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}
addEventListener('resize', fit);
fit();

// ---- ambient backdrop: paint the video tiny, let CSS blur it across the window ----
const bctx = backdrop.getContext('2d');
function paintBackdrop(): void {
  if (bctx && screen === 'menu' && video.readyState >= 2) bctx.drawImage(video, 0, 0, backdrop.width, backdrop.height);
  setTimeout(paintBackdrop, 100);
}

// ---- boot screen: the game's cyan typewriter, two cards in a row, advanced by the first gesture ----
// The game opens on two text-only cards (parity goldens s03-s05): "SONY COMPUTER ENTERTAINMENT AMERICA /
// PRESENTS" types in with the block cursor, holds, fades to black; then "DEVELOPED BY / ZIPPER INTERACTIVE, INC."
// does the same. Ours keep that shape and cadence with their own words (owner, 2026-09-20).
const BOOT_CARDS = [['WELCOME TO', 'PROJECT UNZIPPED'], ['AN OPEN SOURCE PROJECT']];
const CHAR_MS = 45;
const HOLD_MS = 1100;
const FADE_MS = 700; // matches the #boot-text opacity transition
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function typeCard(lines: string[]): Promise<void> {
  const cursor = '<span class="cursor"></span>';
  let out = '';
  for (let l = 0; l < lines.length; l++) {
    for (const ch of lines[l]) {
      out += ch;
      if (ch !== ' ') typeTick(); // the briefing panels' tick; silent until the browser lets the page sound
      bootText.innerHTML = out + cursor;
      await sleep(CHAR_MS);
    }
    if (l < lines.length - 1) out += '\n';
  }
  bootText.innerHTML = out + cursor;
}
async function typewriter(): Promise<void> {
  for (const lines of BOOT_CARDS) {
    await typeCard(lines);
    await sleep(HOLD_MS);
    bootText.querySelector('.cursor')?.remove(); // the cursor goes first, as on the game's fading card
    bootText.classList.add('faded');
    await sleep(FADE_MS);
    bootText.innerHTML = '';
    bootText.classList.remove('faded');
  }
}
// ---- audio + mute ----
const ASSET_V = encodeURIComponent(__BUILD_STAMP__);
const sfx = new Sfx(ASSET_V);
// Static images and sounds carry long cache headers; the build stamp busts them on each deploy.
$<HTMLImageElement>('logo').src = `/img/logo.webp?v=${ASSET_V}`;
(document.querySelector('#panel-photo img') as HTMLImageElement).src = `/img/intel.jpg?v=${ASSET_V}`;
const navSound = new URLSearchParams(location.search).get('nav') === 'slide' ? 'slide' : 'thunk';
let muted = false;
let volume = parseVolume(null);
try {
  muted = localStorage.getItem('s2u:muted') === '1';
  volume = parseVolume(localStorage.getItem('s2u:volume'));
} catch { /* private mode */ }
// Browsers keep a page silent until the visitor touches it, so the menu opens with the movie muted and the first
// key, click or pad press brings the sound in (unlockAudio). Until then the speaker shows as muted.
let audioUnlocked = false;
function applyAudio(): void {
  const l = levels(volume, muted);
  video.muted = l.video === 0 || !audioUnlocked;
  video.volume = l.video;
  sfx.level = l.sfx;
  const silent = muted || volume === 0 || !audioUnlocked;
  audioBox.classList.toggle('muted', silent);
  muteBtn.classList.toggle('muted', silent);
  muteBtn.title = !audioUnlocked ? 'Press any key or click for sound' : silent ? 'Unmute (M)' : 'Mute (M)';
  volumeEl.value = String(Math.round(volume * 100));
  volumeEl.style.setProperty('--fill', `${Math.round(volume * 100)}%`);
  try {
    localStorage.setItem('s2u:muted', muted ? '1' : '0');
    localStorage.setItem('s2u:volume', String(volume));
  } catch { /* private mode */ }
}
function toggleMute(): void {
  muted = !muted;
  if (!muted && volume === 0) volume = parseVolume(null); // unmuting a slider left at zero brings the default back
  applyAudio();
}
muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); muteBtn.blur(); });
// The bar slides out when the speaker is hovered or focused. Dragging it is never a mute: it un-mutes.
volumeEl.addEventListener('input', () => { volume = Number(volumeEl.value) / 100; muted = false; applyAudio(); });
volumeEl.addEventListener('change', () => volumeEl.blur()); // hand the arrow keys back to the menu
for (const type of ['click', 'pointerdown', 'wheel'] as const) audioBox.addEventListener(type, (e) => e.stopPropagation());
for (const type of ['click', 'pointerdown'] as const) webLink.addEventListener(type, (e) => e.stopPropagation());

// ---- transitions ----
async function crossfade(swap: () => void): Promise<void> {
  fade.classList.add('on');
  await new Promise((r) => setTimeout(r, 360));
  swap();
  fade.classList.remove('on');
}
function show(next: Screen): void {
  screen = next;
  boot.classList.toggle('hidden', next !== 'boot');
  menu.classList.toggle('hidden', next !== 'menu');
  about.classList.toggle('hidden', next !== 'about');
  stats.classList.toggle('hidden', next !== 'stats');
  report.classList.toggle('hidden', next !== 'report');
}

// ---- menu ----
let roller: RollerState = createRoller();
let picked = false;
let started = false;

// One element per item, kept across moves so a move is a roll: every row travels one slot and the CSS
// transitions carry its position, size, stretch and glow with it (owner, 2026-09-20: the wheel should be seen
// to turn, as the console's does). Slots are offsets from the lit row; beyond the dim rows a row is parked
// off the wheel at zero opacity, so the one that wraps from top to bottom crosses unseen.
const rowEls = new Map<string, HTMLElement>();
function rowEl(text: string): HTMLElement {
  let el = rowEls.get(text);
  if (!el) {
    el = document.createElement('div');
    const word = document.createElement('span'); // the sideways stretch lives here
    word.className = 'w';
    word.textContent = text;
    el.appendChild(word);
    rowEls.set(text, el);
    itemsEl.appendChild(el);
  }
  return el;
}
function renderRoller(): void {
  const n = roller.items.length;
  roller.items.forEach((text, i) => {
    let offset = (((i - roller.index) % n) + n) % n;
    if (offset > n / 2) offset -= n;
    const el = rowEl(text);
    const cls = ['item', 'crt', offset === 0 ? 'lit' : 'dim'];
    if (offset < 0) cls.push('above');
    if (offset > 0) cls.push('below');
    if (Math.abs(offset) > 1) cls.push('far');
    el.className = cls.join(' ');
    el.dataset.offset = String(offset);
  });
}

function select(): void {
  picked = true;
  sfx.play('dink');
  const litEl = itemsEl.querySelector<HTMLElement>('.item.lit');
  const choice = lit(roller);
  // No flash on the pick (owner, 2026-09-19): the lit row keeps its steady glow; input is held for a beat so a
  // double press cannot fire twice.
  void litEl;
  setTimeout(() => { picked = false; }, 250);
  switch (choice) {
    case 'ABOUT': void openAbout('about'); break;
    case 'SETUP GUIDE': void openAbout('guide'); break;
    case 'BUG REPORT': void openReport(); break;
    case 'GITHUB': window.open(GITHUB_URL, '_blank', 'noopener'); break;
    case 'SERVER': void openStats(); break;
    case 'REDOTCOM': window.open('/redotcom/', '_blank', 'noopener'); break;
  }
}

function menuIntent(intent: Intent): void {
  if (picked) return;
  switch (intent) {
    case 'up': roller = move(roller, -1); sfx.play(navSound); renderRoller(); break;
    case 'down': roller = move(roller, 1); sfx.play(navSound); renderRoller(); break;
    case 'select': select(); break;
    case 'back': sfx.play('back'); break;
  }
}

// ---- about (MISSION BRIEFING) ----
// One screen, two briefings: ABOUT (DEPLOY opens the guide) and the SETUP GUIDE (its button opens BUG REPORT).
type Briefing = 'about' | 'guide';
const BRIEFINGS: Record<Briefing, { tabs: readonly Tab[]; title: string; sub: string; action: string }> = {
  about: { tabs: TABS, title: 'MISSION BRIEFING', sub: 'OPERATION UNZIPPED: SOCOM II ON PC', action: 'DEPLOY' },
  guide: { tabs: GUIDE_TABS, title: 'SETUP GUIDE', sub: 'FROM YOUR DISC TO THE LOBBY', action: 'BUG REPORT' },
};
let briefing: Briefing = 'about';
const briefTabs = (): readonly Tab[] => BRIEFINGS[briefing].tabs;
// Rows the lit cursor can sit on: every tab, then the buttons under them, top to bottom. The ABOUT briefing has
// DEVELOPMENT STORY above GITHUB (owner, 2026-09-20); both briefings end on the action button (DEPLOY / BUG REPORT).
const briefButtons = (): readonly string[] => (briefing === 'about' ? ['tab-story', 'tab-github', 'tab-deploy'] : ['tab-github', 'tab-deploy']);
const briefRows = (): number => briefTabs().length + briefButtons().length;
let aboutState: AboutState = createAbout();
let typingToken = 0;
const tabsEl = $('tabs');
const panelHead = $('panel-head');
const panelBody = $('panel-body');
const panelPhoto = $('panel-photo');

function renderTabs(): void {
  tabsEl.innerHTML = '';
  briefTabs().forEach((t, i) => {
    const el = document.createElement('div');
    el.className = `tab crt${i === aboutState.index ? ' lit' : ''}`;
    el.textContent = t.label;
    el.dataset.index = String(i);
    tabsEl.appendChild(el);
  });
  $('tab-story').classList.toggle('hidden', briefing !== 'about');
  briefButtons().forEach((id, k) => $(id).classList.toggle('lit', aboutState.index === briefTabs().length + k));
}

async function renderPanel(): Promise<void> {
  const tab = currentTab(aboutState, briefTabs());
  const token = ++typingToken;
  panelHead.textContent = tab.head;
  panelPhoto.classList.toggle('hidden', !tab.photo);
  panelBody.classList.toggle('tall', !tab.photo);
  panelBody.classList.toggle('dense', briefing === 'guide');
  const cursor = '<span class="cursor"></span>';
  let out = '';
  for (const ch of tab.body) {
    if (token !== typingToken) return;
    out += ch;
    if (ch !== ' ' && ch !== '\n') typeTick();
    panelBody.innerHTML = escapeHtml(out) + cursor;
    await new Promise((r) => setTimeout(r, ch === '\n' ? 60 : 12));
  }
}
// The typewriter tick (HUDUI sound 7): the game plays this 62 ms tick once per character as the pre-mission
// text types in; here it runs under the boot cards and the briefing panels. The page types faster than the
// console did, so ticks are held to one per video frame pair.
// The bank's own level is -25 dBFS under the menu music. 1.6 lifted it to read on laptop speakers; the owner
// found that quite loud and asked for about half (2026-09-20).
const TYPE_LEVEL = 0.8;
let lastTypeSound = 0;
function typeTick(): void {
  const now = performance.now();
  if (now - lastTypeSound < 33) return;
  lastTypeSound = now;
  sfx.play('type', TYPE_LEVEL);
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function openAbout(kind: Briefing): Promise<void> {
  typingToken++;
  await crossfade(() => {
    briefing = kind;
    aboutState = createAbout(0, briefTabs().length);
    $('brief-title').textContent = BRIEFINGS[kind].title;
    $('brief-sub').textContent = BRIEFINGS[kind].sub;
    $('tab-deploy').textContent = BRIEFINGS[kind].action;
    show('about');
    renderTabs();
    void renderPanel();
  });
}
function briefingAction(): void {
  sfx.play('dink');
  if (briefing === 'about') void openAbout('guide');
  else void openReport();
}
async function closeAbout(): Promise<void> {
  sfx.play('back');
  typingToken++;
  await crossfade(() => show('menu'));
}

function aboutIntent(intent: Intent): void {
  switch (intent) {
    case 'up': case 'down': {
      const next = moveTab(aboutState, intent === 'up' ? -1 : 1, briefRows());
      if (next.index === aboutState.index) { sfx.play('neg'); return; }
      aboutState = next;
      sfx.play(navSound);
      renderTabs();
      if (next.index < briefTabs().length) void renderPanel(); // on a button the last tab's text stays up
      break;
    }
    case 'select': {
      const button = briefButtons()[aboutState.index - briefTabs().length];
      if (button === 'tab-story') openStory();
      else if (button === 'tab-github') openGithub();
      else briefingAction(); // on a tab, as in the game, SELECT is the action button
      break;
    }
    case 'back': void closeAbout(); break;
  }
}
tabsEl.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tab');
  if (!el) return;
  const i = Number(el.dataset.index);
  if (i === aboutState.index) return;
  aboutState = createAbout(i, briefTabs().length);
  sfx.play(navSound);
  renderTabs();
  void renderPanel();
});
$('hint-back').addEventListener('click', (e) => { e.stopPropagation(); if (screen === 'about') void closeAbout(); });
$('hint-select').addEventListener('click', (e) => { e.stopPropagation(); if (screen === 'about') aboutIntent('select'); });
function openGithub(): void {
  sfx.play('dink');
  window.open(GITHUB_URL, '_blank', 'noopener');
}
function openStory(): void { sfx.play('dink'); window.open(STORY_URL, '_blank', 'noopener'); }
$('tab-github').addEventListener('click', () => { if (screen === 'about') openGithub(); });
$('tab-story').addEventListener('click', () => { if (screen === 'about') openStory(); });
$('tab-deploy').addEventListener('click', () => { if (screen === 'about' && !fade.classList.contains('on')) briefingAction(); });

// ---- server stats: the hosted server's live snapshot, polled while the screen is up ----
const statsStatus = $('stats-status');
const statsGames = $('stats-games');
const statsGamesHead = $('stats-games-head');
const statsPlayers = $('stats-players');
const statsUpdated = $('stats-updated');
let statsTimer = 0;
let statsToken = 0;

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text; // textContent only: nothing from the server is ever markup
  return e;
}

function renderStats(s: Stats, note: string): void {
  statsStatus.replaceChildren(...statusRows(s).map(([k, v], i) => {
    const row = el('div', `stat-row crt${i === 0 ? (s.online ? ' up' : ' down') : ''}`);
    row.append(el('span', 'k', k), el('span', 'v', v));
    return row;
  }));
  const games = gameRows(s);
  statsGamesHead.textContent = s.online ? `GAMES (${games.length})` : 'GAMES';
  if (!s.online) statsGames.replaceChildren(el('div', 'stats-empty', 'NO SIGNAL FROM THE SERVER. RETRYING...'));
  else if (games.length === 0) statsGames.replaceChildren(el('div', 'stats-empty', 'NO GAMES OPEN. HOST ONE FROM THE LAUNCHER.'));
  else statsGames.replaceChildren(...games.flatMap((g) => {
    const row = el('div', 'game-row');
    row.append(el('span', 't', `${g.locked ? '[LOCKED] ' : ''}${g.title}`), el('span', 'm', g.map), el('span', 'p', g.players));
    return [row, el('div', 'game-sub', `${g.state}${g.roster ? ': ' + g.roster : ''}`)];
  }));
  const online = s.players.names.map((n) => n.toUpperCase()).join(' · ');
  statsPlayers.replaceChildren(el('div', online ? '' : 'stats-empty', online || (s.online ? 'NOBODY ONLINE RIGHT NOW.' : '')));
  statsUpdated.textContent = note;
}

async function pollStats(): Promise<void> {
  const token = statsToken;
  let s: Stats = OFFLINE;
  try {
    const res = await fetch(STATS_URL, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (res.ok) s = parseStats(await res.json());
  } catch { /* offline is a state, not an error */ }
  if (token !== statsToken || screen !== 'stats') return;
  renderStats(s, `UPDATED ${new Date().toLocaleTimeString([], { hour12: false })} / EVERY ${POLL_MS / 1000}S`);
  statsTimer = window.setTimeout(() => void pollStats(), POLL_MS);
}

async function openStats(): Promise<void> {
  statsToken++;
  await crossfade(() => {
    show('stats');
    statsStatus.replaceChildren();
    statsPlayers.replaceChildren();
    statsGamesHead.textContent = 'GAMES';
    statsGames.replaceChildren(el('div', 'stats-empty', 'CONTACTING SERVER...'));
    statsUpdated.textContent = '';
  });
  void pollStats();
}
async function closeStats(): Promise<void> {
  sfx.play('back');
  statsToken++;
  clearTimeout(statsTimer);
  await crossfade(() => show('menu'));
}
function statsIntent(intent: Intent): void {
  if (intent === 'back') void closeStats();
  else if (intent === 'select') sfx.play('dink');
}
$('stats-back').addEventListener('click', (e) => { e.stopPropagation(); if (screen === 'stats') void closeStats(); });

// ---- report a bug: a plain form; nothing leaves the page until SEND ----
const reportEls = {
  title: $<HTMLInputElement>('report-title'),
  description: $<HTMLTextAreaElement>('report-description'),
  contact: $<HTMLInputElement>('report-contact'),
  send: $<HTMLButtonElement>('report-send'),
};
const reportNote = $('report-note');
const REPORT_HINT = 'PLAIN TEXT ONLY. NO ACCOUNT NEEDED. DO NOT INCLUDE PASSWORDS.';
let formState: FormState = createForm();
let sending = false;

function renderForm(): void {
  FIELDS.forEach((f, i) => reportEls[f.id].classList.toggle('lit', i === formState.index));
}
function note(text: string, cls: '' | 'ok' | 'bad' = ''): void {
  reportNote.textContent = text;
  reportNote.className = `report-note${cls ? ' ' + cls : ''}`;
}

async function sendReport(): Promise<void> {
  if (sending) return;
  const values = { title: reportEls.title.value, description: reportEls.description.value, contact: reportEls.contact.value };
  const problem = checkForm(values);
  if (problem) { sfx.play('neg'); note(problem, 'bad'); return; }
  sending = true;
  reportEls.send.disabled = true;
  note('SENDING...');
  const payload = buildPayload(values, {
    version: `S2U v${__APP_VERSION__} ${__BUILD_STAMP__}`,
    userAgent: navigator.userAgent,
    language: navigator.language ?? '',
    screen: `${window.screen.width}x${window.screen.height}`,
  });
  payload.website = $<HTMLInputElement>('report-website').value;
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(BUGS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* status stays 0: the service did not answer */ }
  const reply = replyText(status, body);
  sfx.play(reply.ok ? 'dink' : 'neg');
  note(reply.text, reply.ok ? 'ok' : 'bad');
  if (reply.ok) { reportEls.title.value = ''; reportEls.description.value = ''; }
  sending = false;
  reportEls.send.disabled = false;
}

async function openReport(): Promise<void> {
  typingToken++;
  await crossfade(() => { formState = createForm(); show('report'); renderForm(); note(REPORT_HINT); });
}
async function closeReport(): Promise<void> {
  sfx.play('back');
  (document.activeElement as HTMLElement | null)?.blur();
  await crossfade(() => show('menu'));
}
function reportIntent(intent: Intent): void {
  switch (intent) {
    case 'up': case 'down': {
      const next = moveField(formState, intent === 'up' ? -1 : 1);
      if (next.index === formState.index) { sfx.play('neg'); return; }
      formState = next;
      sfx.play(navSound);
      renderForm();
      break;
    }
    case 'select': {
      const f = currentField(formState);
      if (f.id === 'send') void sendReport();
      else { sfx.play('dink'); reportEls[f.id].focus(); }
      break;
    }
    case 'back': void closeReport(); break;
  }
}
FIELDS.forEach((f, i) => reportEls[f.id].addEventListener('focus', () => { formState = createForm(i); renderForm(); }));
$('report-form').addEventListener('submit', (e) => { e.preventDefault(); void sendReport(); });
$('report-back').addEventListener('click', (e) => { e.stopPropagation(); if (screen === 'report') void closeReport(); });

// ---- start ----
async function unlockAudio(): Promise<void> {
  if (audioUnlocked) return;
  audioUnlocked = true;
  // A pad press is not always a gesture the browser honours: the context then never resumes and never says so.
  // Give it a moment, and if it has not come up, let the next key or click try again.
  const ok = await Promise.race([sfx.unlock().then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
  if (!ok) { audioUnlocked = false; return; }
  applyAudio();
  if (started && video.paused) { try { await video.play(); } catch { /* stays paused until the next gesture */ } }
}
for (const type of ['keydown', 'pointerdown'] as const) addEventListener(type, () => void unlockAudio(), { capture: true });

// The boot cards run, and the menu follows on its own (owner, 2026-09-19). A key, click or pad press during them skips
// ahead. Audio is asked for up front: a browser that already trusts the site (a return visit in Chrome, say)
// lets it run without a gesture and the cards tick as they type; elsewhere the request quietly lapses and the
// first key, click or pad press brings the sound in as before.
void unlockAudio();
void typewriter().then(() => start());

async function start(): Promise<void> {
  if (started) return;
  started = true;
  applyAudio();
  renderRoller();
  await crossfade(() => show('menu'));
  audioBox.classList.add('shown');
  webLink.classList.add('shown');
  try { await video.play(); } catch { /* a second gesture will start it */ }
  backdrop.classList.add('on');
  paintBackdrop();
}

function onIntent(intent: Intent): void {
  void unlockAudio(); // a pad press counts as the visitor's gesture where the browser allows it
  if (!started) { void start(); return; }
  if (fade.classList.contains('on')) return;
  if (screen === 'menu') menuIntent(intent);
  else if (screen === 'about') aboutIntent(intent);
  else if (screen === 'stats') statsIntent(intent);
  else if (screen === 'report') reportIntent(intent);
}

addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
    if (e.key === 'Escape') target.blur(); // the first Escape leaves the field; the next one is BACK
    return;
  }
  if (e.key === 'm' || e.key === 'M') { if (started) toggleMute(); return; }
  const intent = keyIntent(e.key);
  if (!intent) return;
  e.preventDefault();
  onIntent(intent);
});
addEventListener('wheel', (e) => { if (started && screen !== 'report') onIntent(e.deltaY > 0 ? 'down' : 'up'); }, { passive: true });
stage.addEventListener('click', (e) => {
  if (!started) { onIntent('select'); return; }
  if (screen !== 'menu') return;
  if (dragged) { dragged = false; return; } // the tap that ends a swipe is not a pick
  const target = e.target as HTMLElement;
  const arrow = target.closest<HTMLElement>('.arrow');
  if (arrow) { onIntent(arrow.classList.contains('up') ? 'up' : 'down'); return; }
  const item = target.closest<HTMLElement>('.item');
  if (!item) return;
  const offset = Number(item.dataset.offset ?? 0);
  if (offset === 0) onIntent('select');
  else onIntent(offset < 0 ? 'up' : 'down');
});
// Swiping the wheel (a finger, or a held mouse) rolls it one row per DRAG_STEP px of travel on the stage, the
// rows following the finger's direction: pull down and the row above comes into the light. A tap is the click
// above. The move and release are watched on the window, so a swipe that leaves the wheel keeps rolling it;
// pointer capture would do that too but it retargets the click to the wheel and a mouse could no longer pick a
// row (owner, 2026-09-20).
const DRAG_STEP = 28; // stage px, a little under the dim-to-lit pitch
const rollerEl = $('roller');
let dragFromY: number | null = null;
let dragged = false;
rollerEl.addEventListener('pointerdown', (e) => {
  if (!started || screen !== 'menu') return;
  dragFromY = e.clientY;
  dragged = false;
});
addEventListener('pointermove', (e) => {
  if (dragFromY === null) return;
  const dy = (e.clientY - dragFromY) / stageScale;
  if (Math.abs(dy) < DRAG_STEP) return;
  dragFromY = e.clientY;
  dragged = true;
  onIntent(dy > 0 ? 'up' : 'down');
});
// The click that ends a swipe fires right after the release, before any timer; a swipe that ends off its row
// fires none, and the flag must not then eat the next real click.
for (const type of ['pointerup', 'pointercancel'] as const) addEventListener(type, () => { dragFromY = null; setTimeout(() => { dragged = false; }, 0); });
// Right stick: scroll whatever long panel is on screen (the guide's text, the games list, the roster).
function padScroll(speed: number): void {
  const targets = screen === 'about' ? [panelBody] : screen === 'stats' ? [statsGames, statsPlayers] : [];
  for (const t of targets) t.scrollTop += speed * 9;
}
startGamepadPolling(onIntent, padScroll);
