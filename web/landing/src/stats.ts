// SERVER STATS: the hosted Horizon server's live snapshot (GET /api/stats, proxied by nginx to the
// Medius process's stats endpoint on the game box), parsed defensively and shaped for the screen.
// Pure: no DOM, no fetch. Everything the page shows passes through parseStats, which trusts nothing --
// wrong types become zero or empty, long strings and long lists are cut.

export interface GameStat {
  readonly name: string;
  readonly host: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly level: number;
  readonly status: string;
  readonly hasPassword: boolean;
  readonly playerNames: readonly string[];
}
export interface ChannelStat { readonly name: string; readonly players: number; readonly games: number; }
export interface Stats {
  readonly online: boolean;
  readonly server: string;
  readonly location: string;
  readonly uptimeSeconds: number;
  readonly players: { readonly online: number; readonly inGame: number; readonly inLobby: number; readonly names: readonly string[] };
  readonly games: readonly GameStat[];
  readonly channels: readonly ChannelStat[];
  readonly sinceStart: { readonly gamesCreated: number; readonly distinctPlayers: number; readonly peakPlayers: number };
}

export const STATS_URL = '/api/stats';
export const POLL_MS = 5000;

const MAX_TEXT = 48;
const MAX_NAMES = 64;
const MAX_GAMES = 32;
const MAX_CHANNELS = 8;

export const OFFLINE: Stats = {
  online: false,
  server: '',
  location: '',
  uptimeSeconds: 0,
  players: { online: 0, inGame: 0, inLobby: 0, names: [] },
  games: [],
  channels: [],
  sinceStart: { gamesCreated: 0, distinctPlayers: 0, peakPlayers: 0 },
};

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const names = (v: unknown): string[] => list(v).filter((n): n is string => typeof n === 'string' && n.length > 0).slice(0, MAX_NAMES).map(text);

export function parseStats(raw: unknown): Stats {
  const r = rec(raw);
  const players = r && rec(r.players);
  if (!r || r.status !== 'online' || !players) return OFFLINE;
  const since = rec(r.sinceStart) ?? {};
  return {
    online: true,
    server: text(r.server),
    location: text(r.location),
    uptimeSeconds: num(r.uptimeSeconds),
    players: { online: num(players.online), inGame: num(players.inGame), inLobby: num(players.inLobby), names: names(players.names) },
    games: list(r.games).map(rec).filter((g): g is Rec => g !== null).slice(0, MAX_GAMES).map((g) => ({
      name: text(g.name),
      host: text(g.host),
      players: num(g.players),
      maxPlayers: num(g.maxPlayers),
      level: num(g.level),
      status: text(g.status),
      hasPassword: g.hasPassword === true,
      playerNames: names(g.playerNames),
    })),
    channels: list(r.channels).map(rec).filter((c): c is Rec => c !== null).slice(0, MAX_CHANNELS).map((c) => ({
      name: text(c.name), players: num(c.players), games: num(c.games),
    })),
    sinceStart: { gamesCreated: num(since.gamesCreated), distinctPlayers: num(since.distinctPlayers), peakPlayers: num(since.peakPlayers) },
  };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function formatUptime(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}D ${pad2(h)}H ${pad2(m)}M`;
  if (h > 0) return `${h}H ${pad2(m)}M`;
  return `${m}M`;
}

// Medius GameLevel -> map. Only ids seen in a real round on the hosted server are named
// (2 = Frostfire, the harness's map, 2026-09-19); the rest show their number until verified.
const MAPS: Readonly<Record<number, string>> = { 2: 'FROSTFIRE' };
export function mapName(level: number): string {
  return MAPS[level] ?? `MAP ${level}`;
}

/** The room name as typed: SOCOM II appends its own "$~..." suffix to the Medius game name. */
export function gameTitle(name: string): string {
  const cut = name.split('$~')[0].trim().toUpperCase();
  return cut || 'UNNAMED';
}

function gameState(status: string): string {
  switch (status) {
    case 'WorldActive': return 'IN PROGRESS';
    case 'WorldStaging': return 'STAGING';
    case 'WorldPendingCreation': return 'OPENING';
    default: return status.replace(/^World/, '').toUpperCase() || 'UNKNOWN';
  }
}

/** "US East (Ohio) - AWS us-east-2" -> "US EAST (OHIO)": the part a player cares about. */
function shortLocation(location: string): string {
  return location.split(' - ')[0].trim().toUpperCase();
}

export function statusRows(s: Stats): Array<[string, string]> {
  if (!s.online) return [['STATUS', 'OFFLINE']];
  return [
    ['STATUS', 'ONLINE'],
    ['LOCATION', shortLocation(s.location)],
    ['PLAYERS ONLINE', String(s.players.online)],
    ['IN GAME / LOBBY', `${s.players.inGame} / ${s.players.inLobby}`],
    ['GAMES OPEN', String(s.games.length)],
    ['UPTIME', formatUptime(s.uptimeSeconds)],
    ['PEAK PLAYERS', String(s.sinceStart.peakPlayers)],
    ['GAMES HOSTED', String(s.sinceStart.gamesCreated)],
  ];
}

export interface GameRow { readonly title: string; readonly map: string; readonly players: string; readonly state: string; readonly locked: boolean; readonly roster: string; }
export function gameRows(s: Stats): GameRow[] {
  return s.games.map((g) => ({
    title: gameTitle(g.name),
    map: mapName(g.level),
    players: `${g.players}/${g.maxPlayers}`,
    state: gameState(g.status),
    locked: g.hasPassword,
    roster: g.playerNames.map((n) => n.toUpperCase()).join(', '),
  }));
}
