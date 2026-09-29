// s2u-api: the bug-report inbox behind https://socomunzipped.com/api/bugs, and the play-tester list behind
// /api/testers (one file per address under $DATA_DIR/testers/, named by the address's hash: a repeat is logged and
// answered like a new signup, nothing is stored twice). Zero dependencies.
// POST /api/bugs (JSON, see bugs.mjs) -> one file per report under $DATA_DIR/bugs/ (test reports under
// bugs-test/). Nothing is ever served back: there is no GET for reports. Reports are read over SSH.
// Reached only through the s2u nginx on the compose network; never published on a host port.
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { validateReport, makeId, RateLimiter } from './bugs.mjs';
import { validateSignup, makeSignupId, signupFileName, fileSignup, bodyLimit } from './testers.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? '/data';
const MAX_STORED = Number(process.env.MAX_STORED ?? 5000);   // the inbox stops accepting when this full
const PER_HOUR = Number(process.env.PER_HOUR ?? 5);
const GLOBAL_PER_HOUR = Number(process.env.GLOBAL_PER_HOUR ?? 120);

const dirs = { real: join(DATA_DIR, 'bugs'), test: join(DATA_DIR, 'bugs-test'),
               testers: join(DATA_DIR, 'testers'), testersTest: join(DATA_DIR, 'testers-test') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const perCaller = new RateLimiter(PER_HOUR, 3600_000);
const everyone = new RateLimiter(GLOBAL_PER_HOUR, 3600_000);
const salt = randomBytes(16); // per process: the stored reporter tag links one caller's reports, not an address

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The request body, refused with 413 past `limit` bytes (bodyLimit: each endpoint's own whole-POST cap). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });
    if (path !== '/api/bugs' && path !== '/api/testers') return send(res, 404, { ok: false, error: 'not found' });
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' }, { Allow: 'POST' });
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return send(res, 415, { ok: false, error: 'Content-Type: application/json' });

    // nginx sets X-Real-IP from Cloudflare's CF-Connecting-IP; the socket address is only ever nginx.
    const caller = String(req.headers['x-real-ip'] ?? req.socket.remoteAddress ?? 'unknown').slice(0, 64);

    let raw;
    try { raw = JSON.parse(await readBody(req, bodyLimit(path))); }
    catch (e) { return send(res, e.status === 413 ? 413 : 400, { ok: false, error: e.status === 413 ? 'body: too large' : 'body: not JSON' }); }

    if (path === '/api/testers') return signup(req, res, raw, caller);

    const v = validateReport(raw);
    if (!v.ok) return v.silent ? send(res, 201, { ok: true, id: makeId() }) : send(res, 400, { ok: false, error: v.error });

    for (const limit of [perCaller.take(caller), everyone.take('*')]) {
      if (!limit.ok) return send(res, 429, { ok: false, error: 'rate limited' }, { 'Retry-After': String(limit.retryAfterSeconds) });
    }
    const dir = v.report.test ? dirs.test : dirs.real;
    if (readdirSync(dir).length >= MAX_STORED) return send(res, 503, { ok: false, error: 'the inbox is full; tell us on GitHub' });

    const now = new Date();
    const id = makeId(now);
    const record = {
      id,
      receivedUtc: now.toISOString(),
      reporter: createHash('sha256').update(salt).update(caller).digest('hex').slice(0, 12),
      userAgent: String(req.headers['user-agent'] ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 160),
      ...v.report,
    };
    const file = join(dir, `${id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n', { mode: 0o640, flag: 'wx' });
    renameSync(`${file}.tmp`, file);
    console.log(`${record.receivedUtc} stored ${id} source=${record.source} test=${record.test} bytes=${JSON.stringify(record).length}`);
    return send(res, 201, { ok: true, id });
  } catch (e) {
    console.error('unhandled', e?.message);
    try { send(res, 500, { ok: false, error: 'server error' }); } catch { /* socket gone */ }
  }
});
// The play-tester list. Validation and filing in testers.mjs; the file name is the address's hash, and a repeat is
// logged here and answered exactly like a new signup, so the reply never says whether an address is on the list.
function signup(req, res, raw, caller) {
  const v = validateSignup(raw);
  if (!v.ok) return v.silent ? send(res, 201, { ok: true, id: makeSignupId() }) : send(res, 400, { ok: false, error: v.error });
  for (const limit of [perCaller.take(caller), everyone.take('*')]) {
    if (!limit.ok) return send(res, 429, { ok: false, error: 'rate limited' }, { 'Retry-After': String(limit.retryAfterSeconds) });
  }
  const dir = v.signup.test ? dirs.testersTest : dirs.testers;
  if (readdirSync(dir).length >= MAX_STORED) return send(res, 503, { ok: false, error: 'the list is full' });
  const now = new Date();
  const id = makeSignupId(now);
  const record = {
    id,
    receivedUtc: now.toISOString(),
    signer: createHash('sha256').update(salt).update(caller).digest('hex').slice(0, 12),
    userAgent: String(req.headers['user-agent'] ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 160),
    ...v.signup,
  };
  const file = join(dir, signupFileName(v.signup.email));
  const write = (f, text) => writeFileSync(f, text, { mode: 0o640, flag: 'wx' });
  const { stored, reply } = fileSignup(write, file, JSON.stringify(record, null, 2) + '\n', id);
  console.log(`${record.receivedUtc} signup ${stored ? `stored ${id}` : 'repeat'} test=${record.test}`);
  return send(res, reply.status, reply.body);
}

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(PORT, () => console.log(`s2u-api listening on ${PORT}, data in ${DATA_DIR}`));
