import { describe, it, expect } from 'vitest';
import { parseStats, formatUptime, mapName, gameTitle, statusRows, gameRows, OFFLINE } from './stats';

const LIVE = {
  status: 'online',
  server: 'SOCOM Unzipped',
  location: 'US East (Ohio) - AWS us-east-2',
  generatedUtc: '2026-09-19T19:20:16.5163609Z',
  startedUtc: '2026-09-19T19:19:57.8664096Z',
  uptimeSeconds: 93784,
  players: { online: 3, inGame: 2, inLobby: 1, names: ['socomc', 'socome', 'craig'] },
  games: [
    {
      name: 'test$~Channel', host: 'socomc', players: 2, maxPlayers: 24, level: 2, rules: 0,
      status: 'WorldActive', hasPassword: false, createdUtc: '2026-09-19T19:30:00Z', startedUtc: null,
      playerNames: ['socomc', 'socome'],
    },
  ],
  channels: [{ name: 'US East (Ohio)', players: 1, games: 1, maxPlayers: 256 }],
  sinceStart: { gamesCreated: 4, distinctPlayers: 3, peakPlayers: 3, peakPlayersUtc: '2026-09-19T19:31:00Z' },
};

describe('parseStats', () => {
  it('reads the server snapshot', () => {
    const s = parseStats(LIVE);
    expect(s.online).toBe(true);
    expect(s.players.online).toBe(3);
    expect(s.games).toHaveLength(1);
    expect(s.games[0].maxPlayers).toBe(24);
    expect(s.channels[0].name).toBe('US East (Ohio)');
    expect(s.sinceStart.peakPlayers).toBe(3);
  });

  it('is OFFLINE for anything that is not a snapshot', () => {
    for (const junk of [null, undefined, 'nope', 42, [], {}, { status: 'starting' }, { status: 'online' }]) {
      expect(parseStats(junk)).toEqual(OFFLINE);
    }
  });

  it('survives missing and mistyped fields without throwing or lying', () => {
    const s = parseStats({ status: 'online', players: { online: '7', names: [1, 'ok', null] }, games: [{ name: 5 }, 'x'], channels: 'no' });
    expect(s.online).toBe(true);
    expect(s.players.online).toBe(0);
    expect(s.players.names).toEqual(['ok']);
    expect(s.games).toHaveLength(1);
    expect(s.games[0].name).toBe('');
    expect(s.channels).toEqual([]);
  });

  it('caps what it keeps, so a hostile or broken server cannot flood the page', () => {
    const many = { ...LIVE, players: { ...LIVE.players, names: Array.from({ length: 500 }, (_, i) => `p${i}`) }, games: Array.from({ length: 300 }, () => LIVE.games[0]) };
    const s = parseStats(many);
    expect(s.players.names.length).toBeLessThanOrEqual(64);
    expect(s.games.length).toBeLessThanOrEqual(32);
    expect(parseStats({ ...LIVE, server: 'x'.repeat(500) }).server.length).toBeLessThanOrEqual(48);
  });
});

describe('formatting', () => {
  it('formats uptime like a mission clock', () => {
    expect(formatUptime(0)).toBe('0M');
    expect(formatUptime(59)).toBe('0M');
    expect(formatUptime(3600 + 120)).toBe('1H 02M');
    expect(formatUptime(93784)).toBe('1D 02H 03M');
    expect(formatUptime(-5)).toBe('0M');
    expect(formatUptime(Number.NaN)).toBe('0M');
  });

  it('names only the maps whose ids are verified, and numbers the rest', () => {
    expect(mapName(2)).toBe('FROSTFIRE');
    expect(mapName(17)).toBe('MAP 17');
  });

  it('shows the room name a player typed, without the game\'s own suffix', () => {
    expect(gameTitle('test$~Channel')).toBe('TEST');
    expect(gameTitle('  Seals only ')).toBe('SEALS ONLY');
    expect(gameTitle('')).toBe('UNNAMED');
  });

  it('builds the status column', () => {
    const rows = statusRows(parseStats(LIVE));
    expect(rows).toEqual([
      ['STATUS', 'ONLINE'],
      ['LOCATION', 'US EAST (OHIO)'],
      ['PLAYERS ONLINE', '3'],
      ['IN GAME / LOBBY', '2 / 1'],
      ['GAMES OPEN', '1'],
      ['UPTIME', '1D 02H 03M'],
      ['PEAK PLAYERS', '3'],
      ['GAMES HOSTED', '4'],
    ]);
    expect(statusRows(OFFLINE)[0]).toEqual(['STATUS', 'OFFLINE']);
    expect(statusRows(OFFLINE)).toHaveLength(1);
  });

  it('builds one line per game', () => {
    expect(gameRows(parseStats(LIVE))).toEqual([{ title: 'TEST', map: 'FROSTFIRE', players: '2/24', state: 'IN PROGRESS', locked: false, roster: 'SOCOMC, SOCOME' }]);
  });
});
