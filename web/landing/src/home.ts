// The web site (index.html, the default view); the console menu (classic.html + main.ts) is a click away; this page is a
// normal scrolling site that borrows its sounds, its stats and its bug form, and reads the story's timeline.json
// for the latest entries. Everything the server sends is written with textContent, never as markup.
import { Sfx } from './sfx';
import { STATS_URL, POLL_MS, OFFLINE, parseStats, statusRows, gameRows, type Stats } from './stats';
import { BUGS_URL, checkForm, buildPayload, replyText } from './report';
import { TESTERS_URL, checkSignup, buildSignup, replySignup } from './testers';
import { latestEntries, uptimeText, type TimelineEntry } from './home_data';
import { tileFor, emptyTile } from './home_tiles';

declare const __APP_VERSION__: string;
declare const __BUILD_STAMP__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ASSET_V = encodeURIComponent(__BUILD_STAMP__);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- assets with the build stamp, as main.ts does ----
$<HTMLImageElement>('logo').src = `/img/logo.webp?v=${ASSET_V}`;
$('foot-fine').textContent = `S2U v${__APP_VERSION__} / built ${__BUILD_STAMP__} UTC / the numbers on this page are cited on the story page`;

// ---- sound: off until asked, remembered per visitor ----
const sfx = new Sfx(ASSET_V);
const soundBtn = $<HTMLButtonElement>('sound');
let soundOn = false;
try { soundOn = localStorage.getItem('s2u:home-sound') === '1'; } catch { /* private mode */ }
let unlocked = false;
async function unlock(): Promise<void> {
  if (unlocked) return;
  unlocked = true;
  const ok = await Promise.race([sfx.unlock().then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
  if (!ok) unlocked = false;
}
function paintSound(): void {
  soundBtn.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
  soundBtn.title = soundOn ? 'Sound: on. Click to mute the menu sounds.' : 'Sound: off. Click for menu sounds.';
}
function play(name: 'dink' | 'thunk' | 'back' | 'neg'): void {
  if (!soundOn || !unlocked) return;
  sfx.play(name);
}
soundBtn.addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('s2u:home-sound', soundOn ? '1' : '0'); } catch { /* private mode */ }
  paintSound();
  void unlock().then(() => { if (soundOn) sfx.play('dink'); });
});
paintSound();
for (const type of ['keydown', 'pointerdown'] as const) addEventListener(type, () => { if (soundOn) void unlock(); }, { capture: true });
document.querySelectorAll<HTMLElement>('[data-sfx]').forEach((el) => {
  el.addEventListener('pointerenter', () => play('thunk'));
  el.addEventListener('click', () => play('dink'));
});

// ---- the hero wheel: arrow keys roll the lit item, Enter follows it (a nod to the console, not a requirement) ----
const items = Array.from(document.querySelectorAll<HTMLLIElement>('#wheel > li'));
items.forEach((el, k) => el.style.setProperty('--i', String(k)));
let litIndex = -1;
function light(i: number): void {
  litIndex = (i + items.length) % items.length;
  items.forEach((el, k) => el.classList.toggle('is-lit', k === litIndex));
  play('thunk');
}
addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (scrollY > innerHeight * 0.6) return; // the wheel is a hero thing; further down the keys are the browser's
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); light(litIndex - 1); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); light(litIndex + 1); }
  else if ((e.key === 'Enter' || e.key === 'x' || e.key === 'X') && litIndex >= 0) { e.preventDefault(); items[litIndex].querySelector('a')?.click(); }
});
// the game's bottom-right hint: SELECT follows the lit item, or lights the first one so the visitor sees what it does
$('hint-select').addEventListener('click', () => { if (litIndex >= 0) items[litIndex].querySelector('a')?.click(); else light(0); });

// ---- the video: plays when it can; a failed autoplay just leaves the shade ----
const video = $<HTMLVideoElement>('bg');
if (reduceMotion) video.remove();
else video.play().catch(() => { addEventListener('pointerdown', () => void video.play().catch(() => undefined), { once: true }); });

// ---- scroll: progress bar, solid top bar, section spy ----
const bar = $('bar');
const prog = document.getElementById('progress')!;
const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.s2u-bar__nav a'));
const sections = navLinks.map((a) => document.querySelector<HTMLElement>(a.getAttribute('href') ?? '')).filter((s): s is HTMLElement => !!s);
function onScroll(): void {
  const h = document.documentElement;
  const max = h.scrollHeight - h.clientHeight;
  const ratio = max > 0 ? h.scrollTop / max : 0;
  prog.style.setProperty('--s2u-progress', String(ratio));
  bar.classList.toggle('is-solid', scrollY > 40); // kept for the script's contract; the bar is always opaque now
  const y = scrollY + 120;
  let on: string | null = null;
  for (const s of sections) if (s.offsetTop <= y) on = s.id;
  navLinks.forEach((a) => a.classList.toggle('is-on', a.getAttribute('href') === `#${on}`));
}
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ---- server stats: the hero lamp always; the full panel while the section is on screen ----
const statsStatus = $('stats-status');
const statsGames = $('stats-games');
const statsGamesHead = $('stats-games-head');
const statsPlayers = $('stats-players');
const statsUpdated = $('stats-updated');
const heroLamp = $('hero-lamp');
const heroText = $('hero-status-text');
const barLamp = $('bar-lamp'); // the bezelled LED in the top bar, as the SOCOM II ONLINE header has
function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function renderStats(s: Stats, note: string): void {
  heroLamp.className = `s2u-lamp s2u-lamp--small ${s.online ? 'is-up' : 'is-down'}`;
  heroLamp.setAttribute('aria-label', s.online ? 'Server: up' : 'Server: down');
  barLamp.className = `s2u-lamp s2u-lamp--small ${s.online ? 'is-up' : 'is-down'}`;
  barLamp.setAttribute('aria-label', s.online ? 'Server: up' : 'Server: down');
  barLamp.title = s.online ? `Server online: ${s.players.online} online, ${s.games.length} games` : 'Server: no signal';
  heroText.textContent = s.online
    ? `SERVER ONLINE / ${s.players.online} ${s.players.online === 1 ? 'OPERATIVE' : 'OPERATIVES'} / ${s.games.length} ${s.games.length === 1 ? 'GAME' : 'GAMES'} / UP ${uptimeText(s.uptimeSeconds)}`
    : 'SERVER: NO SIGNAL';
  statsStatus.replaceChildren(...statusRows(s).map(([k, v], i) => {
    const row = el('li', `s2u-stat${i === 0 ? (s.online ? ' is-up' : ' is-down') : ''}`);
    row.append(el('b', 's2u-stat__v', v), el('span', 's2u-stat__k', k));
    return row;
  }));
  const games = gameRows(s);
  statsGamesHead.textContent = s.online ? `GAMES (${games.length})` : 'GAMES';
  if (!s.online) statsGames.replaceChildren(el('div', 's2u-status', 'NO SIGNAL FROM THE SERVER. RETRYING.'));
  else if (games.length === 0) statsGames.replaceChildren(el('div', 's2u-status', 'NO GAMES OPEN. HOST ONE FROM THE LAUNCHER.'));
  else statsGames.replaceChildren(...games.flatMap((g) => {
    const row = el('div', 'game-row');
    row.append(el('span', 't', `${g.locked ? '[LOCKED] ' : ''}${g.title}`), el('span', 'm', g.map), el('span', 'p', g.players));
    return [row, el('div', 'game-sub', `${g.state}${g.roster ? ': ' + g.roster : ''}`)];
  }));
  const online = s.players.names.map((n) => n.toUpperCase()).join(' / ');
  statsPlayers.replaceChildren(el('div', online ? '' : 's2u-status', online || (s.online ? 'NOBODY ONLINE RIGHT NOW.' : '')));
  statsUpdated.textContent = note;
}
let statsTimer = 0;
async function pollStats(): Promise<void> {
  let s: Stats = OFFLINE;
  try {
    const res = await fetch(STATS_URL, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (res.ok) s = parseStats(await res.json());
  } catch { /* offline is a state, not an error */ }
  renderStats(s, `UPDATED ${new Date().toLocaleTimeString([], { hour12: false })} / EVERY ${POLL_MS / 1000}S WHILE THIS SECTION IS ON SCREEN`);
  settleHash();
  clearTimeout(statsTimer);
  const visible = document.visibilityState === 'visible';
  statsTimer = window.setTimeout(() => void pollStats(), visible ? POLL_MS : POLL_MS * 6);
}
void pollStats();

// ---- a page opened at a section (#credits from the story page) settles on it after the late content loads ----
// The browser jumps to the fragment before the story strip and the server stats above it have arrived; when
// they do, the section moves down and its heading is left at the foot of the window (owner, 2026-09-20). For
// the first seconds after opening, every late render re-settles on the fragment; after that the visitor owns
// the scroll and the stats' 5 s refresh must not tug it.
const settleUntil = performance.now() + 4000;
function settleHash(): void {
  if (!location.hash || performance.now() > settleUntil) return;
  let target: Element | null;
  try { target = document.querySelector(location.hash); } catch { return; }
  target?.scrollIntoView({ block: 'start', behavior: 'auto' });
}
addEventListener('load', settleHash);

// ---- the latest story entries, from the copy of timeline.json the site deploys with ----
const latestEl = $('story-latest');
async function loadLatest(): Promise<void> {
  let entries: TimelineEntry[] = [];
  try {
    const res = await fetch(`/story/timeline.json?v=${ASSET_V}`, { cache: 'no-cache', signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const data: unknown = await res.json();
      entries = latestEntries(data, 4);
    }
  } catch { /* the page still stands without it */ }
  if (entries.length === 0) {
    latestEl.replaceChildren(emptyTile(document));
    settleHash();
    return;
  }
  latestEl.replaceChildren(...entries.map((e, i) => tileFor(document, e, () => play('dink'), i === 0)));
  settleHash();
}
void loadLatest();

// ---- report a bug: same fields, same checks, same payload as classic and the launcher ----
const reportEls = {
  title: $<HTMLInputElement>('report-title'),
  description: $<HTMLTextAreaElement>('report-description'),
  contact: $<HTMLInputElement>('report-contact'),
  send: $<HTMLButtonElement>('report-send'),
};
const reportNote = $('report-note');
let sending = false;
function note(text: string, cls: '' | 'ok' | 'bad' = ''): void {
  reportNote.textContent = text;
  reportNote.className = `s2u-status${cls ? ' is-' + cls : ''}`;
}
async function sendReport(): Promise<void> {
  if (sending) return;
  const values = { title: reportEls.title.value, description: reportEls.description.value, contact: reportEls.contact.value };
  const problem = checkForm(values);
  if (problem) { play('neg'); note(problem, 'bad'); return; }
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
  play(reply.ok ? 'dink' : 'neg');
  note(reply.text, reply.ok ? 'ok' : 'bad');
  if (reply.ok) { reportEls.title.value = ''; reportEls.description.value = ''; }
  sending = false;
  reportEls.send.disabled = false;
}
$('report-form').addEventListener('submit', (e) => { e.preventDefault(); void sendReport(); });

// ---- the notify list: a panel under the setup title opens the form; one address, one line back ----
const testerOpen = $<HTMLButtonElement>('tester-open');
const testerPanel = $<HTMLFormElement>('tester-panel');
const testerEls = {
  email: $<HTMLInputElement>('tester-email'),
  note: $<HTMLTextAreaElement>('tester-note'),
  send: $<HTMLButtonElement>('tester-send'),
  cancel: $<HTMLButtonElement>('tester-cancel'),
};
const testerLine = $('tester-note-line');
const TESTER_HINT = 'ONE EMAIL PER PERSON. USED ONLY TO SAY A BUILD IS READY. NOT PASSED ON.';
let signing = false;
function testerNote(text: string, cls: '' | 'ok' | 'already' | 'bad' = ''): void {
  testerLine.textContent = text;
  testerLine.className = `s2u-status${cls ? ' is-' + (cls === 'already' ? 'ok' : cls) : ''}`;
}
function openTester(open: boolean): void {
  testerPanel.hidden = !open;
  testerOpen.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) testerEls.email.focus();
  else testerOpen.focus();
}
testerOpen.addEventListener('click', () => openTester(testerPanel.hidden));
testerEls.cancel.addEventListener('click', () => { openTester(false); play('back'); });
async function sendSignup(): Promise<void> {
  if (signing) return;
  const values = { email: testerEls.email.value, note: testerEls.note.value };
  const problem = checkSignup(values);
  if (problem) { play('neg'); testerNote(problem, 'bad'); testerEls.email.focus(); return; }
  signing = true;
  testerEls.send.disabled = true;
  testerNote('SENDING...');
  const payload = buildSignup(values, `S2U v${__APP_VERSION__} ${__BUILD_STAMP__}`);
  payload.website = $<HTMLInputElement>('tester-website').value;
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(TESTERS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000) });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* status stays 0: the service did not answer */ }
  const reply = replySignup(status, body);
  play(reply.state === 'bad' ? 'neg' : 'dink');
  testerNote(reply.text, reply.state === 'new' ? 'ok' : reply.state);
  if (reply.state !== 'bad') { testerPanel.classList.add('is-done'); testerEls.note.value = ''; }
  signing = false;
  testerEls.send.disabled = false;
}
testerPanel.addEventListener('submit', (e) => { e.preventDefault(); void sendSignup(); });
testerEls.email.addEventListener('input', () => { if (testerPanel.classList.contains('is-done')) { testerPanel.classList.remove('is-done'); testerNote(TESTER_HINT); } });

// Every "leave an email" link on the page opens the form under SETUP and puts the cursor in the email field.
document.querySelectorAll<HTMLAnchorElement>('[data-signup]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('setup')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    openTester(true);
  });
});
