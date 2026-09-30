import { FsAssetSource } from '@s2u/archive/node';
import { offeredRules, parseRules } from '../../viewer/src/sim';
import { MatchServer } from './server';

/**
 * `npm start -w @s2u/server`: the match server from the environment (web sprint 3, M3/M10).
 *
 *   SOCOM_DISC     the disc directory holding `RUN/` (the owner's private copy; never served)   required
 *   PORT           the HTTP/WebSocket port                                                     8787
 *   HOST           the address to bind                                                         0.0.0.0
 *   MAPS           the map stems a client may join, comma-separated (MP2,MP6); empty: all 22
 *   IDLE_KICK_MS   W3.R13's idle kick, held to 180000-300000                                   240000
 *   ROUND_SECONDS  W3.R11's round (the create-game default 360)                                360
 *   MAX_ROUNDS     mp_max_rounds: classic's match (first to (n + 1) >> 1) and the banner's count      11
 *   RULES          the rules of a hello that names none: classic (respawn off, 11 rounds). respawn      classic
 *                  is accepted but served as classic while the respawn ruleset is off (owner ruling
 *                  2026-09-29; `RESPAWN_RULES_ENABLED` in ../../viewer/src/net/protocol.ts)
 *   TRUST_PROXY    1: behind a proxy that appends X-Forwarded-For (Caddy, cloudflared); the client's
 *                  address (the vote ban's key) is its last entry. Unset: the header is never read   unset
 */

const env = process.env;
const disc = env['SOCOM_DISC'];
if (!disc) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'SOCOM_DISC is not set: the directory that holds RUN/' }));
  process.exit(2);
}
const num = (key: string, fallback: number): number => {
  const v = Number(env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const server = new MatchServer({
  source: new FsAssetSource(disc),
  port: env['PORT'] === '0' ? 0 : num('PORT', 8787),            // 0: any free port (the tests read it from the log)
  host: env['HOST'] ?? '0.0.0.0',
  maps: (env['MAPS'] ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  room: { idleKickMs: num('IDLE_KICK_MS', 240_000), roundSeconds: num('ROUND_SECONDS', 360), maxRounds: num('MAX_ROUNDS', 11) },
  rules: offeredRules(parseRules(env['RULES']) ?? 'classic'),
  trustProxy: env['TRUST_PROXY'] === '1',
  log: (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry })),
});

setInterval(() => server.resetRates(), 1000).unref();
await server.start();

const shutdown = (signal: string): void => {
  console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: 'stopping', signal }));
  void server.stop().then(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
