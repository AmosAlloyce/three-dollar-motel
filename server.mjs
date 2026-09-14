import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { WORLD, COLORS, SEATS, isWalkable, inPool } from './public/world.js';
import { MYSTERY_SPOTS, PARTY_DURATION_MS } from './public/mystery.js';
import { createPassportStore } from './passport.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = 'hotel_session';
const EMOTES = new Set(['wave', 'heart', 'laugh', 'splash']);
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/renderer.js', ['public/renderer.js', 'text/javascript; charset=utf-8']],
  ['/world.js', ['public/world.js', 'text/javascript; charset=utf-8']],
  ['/mystery.js', ['public/mystery.js', 'text/javascript; charset=utf-8']],
  ['/mystery-ui.js', ['public/mystery-ui.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/motel-sign.png', ['public/motel-sign.png', 'image/png']],
]);

function lineClear(a, b) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.08));
  for (let i = 0; i <= steps; i++) {
    if (!isWalkable(a.x + (b.x - a.x) * i / steps, a.z + (b.z - a.z) * i / steps)) return false;
  }
  return true;
}

// A small, fixed navigation grid keeps furniture collisions authoritative on the server.
function createNavigator() {
  const step = 0.4;
  const columns = Math.floor((WORLD.width - 0.8) / step + 0.001) + 1;
  const rows = Math.floor((WORLD.depth - 0.8) / step + 0.001) + 1;
  const nodes = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const point = { x: 0.4 + col * step, z: 0.4 + row * step };
      nodes.push({ ...point, walkable: isWalkable(point.x, point.z), neighbors: [] });
    }
  }
  for (let index = 0; index < nodes.length; index++) {
    if (!nodes[index].walkable) continue;
    const row = Math.floor(index / columns), col = index % columns;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dz) || col + dx < 0 || col + dx >= columns || row + dz < 0 || row + dz >= rows) continue;
      const next = (row + dz) * columns + col + dx;
      if (nodes[next].walkable && lineClear(nodes[index], nodes[next])) nodes[index].neighbors.push(next);
    }
  }
  function nearest(point) {
    let best = -1, distance = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!nodes[i].walkable) continue;
      const d = Math.hypot(nodes[i].x - point.x, nodes[i].z - point.z);
      if (d < distance && lineClear(point, nodes[i])) { best = i; distance = d; }
    }
    return best;
  }
  return (start, target) => {
    if (lineClear(start, target)) return [target];
    const first = nearest(start), last = nearest(target);
    if (first < 0 || last < 0) return null;
    const open = new Set([first]), visited = new Set();
    const costs = new Map([[first, 0]]), parents = new Map();
    const estimate = index => Math.hypot(nodes[index].x - target.x, nodes[index].z - target.z);
    while (open.size) {
      let current = -1, best = Infinity;
      for (const index of open) {
        const score = costs.get(index) + estimate(index);
        if (score < best) { current = index; best = score; }
      }
      if (current === last) {
        const route = [target];
        for (let index = last; index !== undefined; index = parents.get(index)) route.unshift({ x: nodes[index].x, z: nodes[index].z });
        const simplified = [];
        let previous = start;
        for (let i = 0; i < route.length;) {
          let furthest = i;
          for (let j = route.length - 1; j > i; j--) if (lineClear(previous, route[j])) { furthest = j; break; }
          simplified.push(route[furthest]); previous = route[furthest]; i = furthest + 1;
        }
        return simplified;
      }
      open.delete(current); visited.add(current);
      for (const next of nodes[current].neighbors) {
        if (visited.has(next)) continue;
        const cost = costs.get(current) + Math.hypot(nodes[next].x - nodes[current].x, nodes[next].z - nodes[current].z);
        if (cost < (costs.get(next) ?? Infinity)) { costs.set(next, cost); parents.set(next, current); open.add(next); }
      }
    }
    return null;
  };
}

function failure(status, message) { return Object.assign(new Error(message), { status }); }
function isMint(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let decoded = 0n;
  for (const character of value) decoded = decoded * 58n + BigInt(BASE58.indexOf(character));
  const leadingZeros = /^1*/.exec(value)[0].length;
  const bytes = decoded === 0n ? 0 : Math.ceil(decoded.toString(16).length / 2);
  return leadingZeros + bytes === 32;
}
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, max);
}
function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    req.resume(); return Promise.reject(failure(415, 'Send application/json.'));
  }
  if (Number(req.headers['content-length']) > 2048) {
    req.resume(); return Promise.reject(failure(413, 'Request is too large.'));
  }
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2048) { if (!failed) reject(failure(413, 'Request is too large.')); failed = true; return; }
      if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(failure(400, 'Send a valid JSON object.')); }
    });
    req.on('error', () => reject(failure(400, 'Request interrupted.')));
    req.on('aborted', () => reject(failure(400, 'Request interrupted.')));
  });
}

/**
 * Return an unbound http.Server. Options override environment settings for tests.
 * maxPlayers, adminKey, publicOrigin, disconnectGraceMs, sessionTtlMs, tickMs,
 * movementSpeed, env, logger, dataDir and partyDurationMs are supported.
 * Live sessions stay in memory; browser passports and party spending persist.
 */
export function createHotelServer(options = {}) {
  const env = options.env ?? process.env;
  const configuredMax = Number(options.maxPlayers ?? env.MAX_PLAYERS ?? 20);
  const maxPlayers = Math.max(1, Math.min(100, Number.isFinite(configuredMax) ? Math.floor(configuredMax) : 20));
  // A reverse proxy may put every guest behind one socket IP. Leave room for
  // all guests' movement; authenticated session limits still curb individuals.
  const sharedRequestLimit = Math.max(600, maxPlayers * 150);
  const adminKey = options.adminKey ?? env.ADMIN_KEY ?? '';
  const publicOrigin = options.publicOrigin ?? env.PUBLIC_ORIGIN ?? '';
  if (publicOrigin) {
    let parsed;
    try { parsed = new URL(publicOrigin); } catch { /* Reject malformed configuration below. */ }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== publicOrigin) {
      throw new Error('PUBLIC_ORIGIN must be an http(s) origin without a trailing slash.');
    }
  }
  const graceMs = options.disconnectGraceMs ?? 15_000;
  const sessionTtlMs = options.sessionTtlMs ?? 3_600_000;
  const tickMs = Math.max(20, options.tickMs ?? 100);
  const speed = options.movementSpeed ?? WORLD.speed;
  const logger = options.logger ?? console;
  const mint = isMint(env.COIN_MINT) ? env.COIN_MINT : null;
  const config = {
    name: cleanText(env.MOTEL_NAME || 'Three Dollar Motel', 60) || 'Three Dollar Motel',
    ticker: cleanText(env.COIN_TICKER || 'TBD', 12) || 'TBD',
    mint, tradeUrl: mint ? `https://pump.fun/coin/${mint}` : null,
    maxPlayers, hostEnabled: Boolean(adminKey),
  };
  const passports = createPassportStore(options.dataDir ?? (env.MOTEL_DATA_DIR || ':memory:'));
  const partyDurationMs = options.partyDurationMs ?? PARTY_DURATION_MS;
  let party = passports.party();
  let partyWasActive = party.endsAt > Date.now();
  const partyInfo = () => ({ active: party.endsAt > Date.now(), endsAt: party.endsAt, startedBy: party.startedBy });
  const passportHash = token => createHash('sha256').update(token).digest('hex');
  function cookiePassport(req) {
    const token = /(?:^|;\s*)motel_passport=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    return token ? passportHash(token) : null;
  }
  const sessions = new Map(), bans = new Map(), limits = new Map();
  const findRoute = createNavigator();
  const started = Date.now();
  let shuttingDown = false, stateDirty = false;
  const playerCount = () => [...sessions.values()].filter(session => session.player).length;
  const publicPlayer = player => ({
    id: player.id, name: player.name, color: player.color,
    x: Math.round(player.x * 1000) / 1000, z: Math.round(player.z * 1000) / 1000,
    pose: player.pose, seatId: player.seatId,
    emote: player.emote, emoteUntil: player.emoteUntil,
    chatText: player.chatText, chatUntil: player.chatUntil,
  });
  const state = () => {
    const players = [...sessions.values()].filter(session => session.player).map(session => publicPlayer(session.player));
    return { players, count: players.length, maxPlayers, party: partyInfo() };
  };
  function send(session, event, data) {
    const stream = session.stream;
    if (!stream || stream.destroyed || stream.writableEnded) return;
    if (stream.writableLength > 64 * 1024) { stream.destroy(); return; }
    stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event, data) { for (const session of sessions.values()) send(session, event, data); }
  function system(text) {
    broadcast('chat', { id: randomUUID(), playerId: null, name: 'Reception', text, time: Date.now(), kind: 'system' });
  }
  function dropPlayer(session, reason = null) {
    if (!session.player) return;
    const name = session.player.name;
    if (reason) send(session, 'removed', { reason });
    session.player = null;
    const stream = session.stream; session.stream = null;
    if (stream) stream.end();
    session.disconnectedAt = 0; session.touched = Date.now();
    stateDirty = true;
    system(`${name} checked out.`);
  }
  function checkLimit(key, max, windowMs) {
    const now = Date.now(); let entry = limits.get(key);
    if (!entry || now >= entry.until) {
      if (!entry && limits.size >= 10_000) throw failure(503, 'Reception is busy. Try again shortly.');
      entry = { count: 0, until: now + windowMs }; limits.set(key, entry);
    }
    if (++entry.count > max) throw failure(429, 'Slow down and try again shortly.');
  }
  function getSession(req, required = false) {
    const token = /(?:^|;\s*)hotel_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = token ? sessions.get(token) : null;
    if (session) session.touched = Date.now();
    if (required && (!session?.player || session.bannedUntil > Date.now())) throw failure(401, 'Check in to the motel first.');
    return session;
  }
  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Cross-site requests are not allowed.');
    const origin = req.headers.origin;
    // Non-browser clients (including health checks and tests) may omit Origin.
    // Browsers must match the configured deployment origin or their request Host.
    if (!origin) return;
    const allowed = publicOrigin ? [publicOrigin] : [`http://${req.headers.host}`, `https://${req.headers.host}`];
    if (!allowed.includes(origin)) throw failure(403, 'This origin is not allowed.');
  }
  function sessionInfo(session, req) {
    return {
      ...(session?.player ? { player: publicPlayer(session.player), isHost: session.isHost, mutedUntil: session.mutedUntil } : { player: null }),
      passport: passports.read(session?.passportId ?? cookiePassport(req)), party: partyInfo(),
    };
  }
  function passportChanged(session, passport) {
    for (const guest of sessions.values()) if (guest.passportId === session.passportId) send(guest, 'passport', passport);
  }
  function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }

  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    const ip = req.socket.remoteAddress ?? 'unknown'; // Never trust client-supplied forwarding headers.
    try {
      if (shuttingDown) throw failure(503, 'The motel is restarting.');
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        json(res, 200, { ok: true, players: playerCount(), maxPlayers, uptime: Math.floor((Date.now() - started) / 1000) }); return;
      }
      if (req.method === 'GET' && pathname === '/api/config') { json(res, 200, config); return; }
      if (req.method === 'GET' && pathname === '/api/me') { json(res, 200, sessionInfo(getSession(req), req)); return; }
      if (req.method === 'GET' && pathname === '/api/events') {
        checkOrigin(req);
        const session = getSession(req, true);
        checkLimit(`events:${session.token}`, 20, 60_000);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        const previous = session.stream;
        if (previous) send(session, 'removed', { reason: 'Your guest session moved to another tab. Check in again to use this tab.' });
        session.stream = res; session.disconnectedAt = 0;
        if (previous) previous.end();
        send(session, 'ready', { id: session.player.id, passport: passports.read(session.passportId) });
        send(session, 'state', state());
        res.on('close', () => {
          // An old tab closing must not disconnect the replacement stream.
          if (session.stream !== res) return;
          session.stream = null; session.disconnectedAt = Date.now();
        });
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/api/')) {
        checkOrigin(req);
        checkLimit(`requests:${ip}`, sharedRequestLimit, 10_000);
        const body = await readJson(req);
        if (shuttingDown) throw failure(503, 'The motel is restarting.');
        if (pathname === '/api/join') {
          checkLimit(`join:${ip}`, 24, 60_000);
          if ((bans.get(ip) ?? 0) > Date.now()) throw failure(403, 'Check-in is temporarily unavailable from this connection.');
          let session = getSession(req);
          if (session?.bannedUntil > Date.now()) throw failure(403, 'This session is temporarily banned.');
          if (session?.player) { json(res, 200, sessionInfo(session, req)); return; }
          const name = cleanText(body.name, 20);
          if (name.length < 2) throw failure(400, 'Choose a name with 2 to 20 characters.');
          if (!COLORS.includes(body.color)) throw failure(400, 'Choose one of the available avatar colors.');
          if (playerCount() >= maxPlayers) throw failure(409, 'The motel is full. Try again in a moment.');
          if (!session && sessions.size >= 1000) throw failure(503, 'Reception is busy. Try again shortly.');
          const secure = publicOrigin.startsWith('https://') || Boolean(req.socket.encrypted);
          const cookies = [];
          let passportId = session?.passportId ?? cookiePassport(req);
          if (!passports.read(passportId)) {
            const token = randomBytes(32).toString('hex');
            passportId = passportHash(token);
            passports.create(passportId);
            cookies.push(`motel_passport=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`);
          }
          if (!session) {
            if (sessions.size >= 1000) throw failure(503, 'Reception is busy. Try again shortly.');
            const token = randomBytes(32).toString('hex');
            session = { token, ip, player: null, stream: null, touched: Date.now(), isHost: false, mutedUntil: 0, bannedUntil: 0, disconnectedAt: 0 };
            sessions.set(token, session);
          }
          session.passportId = passportId;
          const spawnIndex = playerCount() % 20, offset = spawnIndex % 5;
          session.player = {
            id: randomUUID(), name, color: body.color, x: 5.5 + offset * 0.5, z: 10.3 + Math.floor(spawnIndex / 5) * 0.25,
            pose: 'stand', seatId: null, emote: null, emoteUntil: 0, chatText: '', chatUntil: 0, route: [],
          };
          session.disconnectedAt = Date.now(); session.ip = ip; session.touched = Date.now();
          cookies.unshift(`${COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure ? '; Secure' : ''}`);
          res.setHeader('Set-Cookie', cookies);
          stateDirty = true; system(`${name} checked in.`);
          json(res, 200, sessionInfo(session, req)); return;
        }
        const session = getSession(req, true);
        if (pathname === '/api/mystery') {
          checkLimit(`mystery:${session.passportId}`, 30, 60_000);
          let passport;
          if (body.type === 'inspect') {
            const spot = MYSTERY_SPOTS.find(item => item.id === body.clueId);
            if (!spot) throw failure(400, 'Choose one of the three clues.');
            if (Math.hypot(session.player.x - spot.x, session.player.z - spot.z) > 1.35 || !lineClear(session.player, spot)) {
              throw failure(400, 'Walk closer to that clue first.');
            }
            passport = passports.inspect(session.passportId, spot.id);
          } else if (body.type === 'solve') {
            checkLimit(`solve:${session.passportId}`, 10, 60_000);
            passport = passports.solve(session.passportId, body.code);
          } else if (body.type === 'party') {
            party = passports.startParty(session.passportId, session.player.name, Date.now(), partyDurationMs);
            partyWasActive = true;
            passport = passports.read(session.passportId);
            broadcast('party', partyInfo()); stateDirty = true;
            system(`${session.player.name} started a one-minute pool party. Everyone is invited!`);
          } else throw failure(400, 'Choose a mystery action.');
          passportChanged(session, passport);
          json(res, 200, { passport, party: partyInfo() }); return;
        }
        if (pathname === '/api/leave') {
          dropPlayer(session); json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/host') {
          checkLimit(`host:${ip}`, 5, 60_000);
          if (!adminKey) throw failure(404, 'Host access is disabled.');
          const supplied = Buffer.from(typeof body.key === 'string' ? body.key : '');
          const expected = Buffer.from(adminKey);
          if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw failure(403, 'Incorrect host key.');
          session.isHost = true; json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/moderate') {
          if (!session.isHost) throw failure(403, 'Host access is required.');
          checkLimit(`moderate:${session.token}`, 30, 60_000);
          if (!['mute', 'unmute', 'kick', 'ban'].includes(body.action)) throw failure(400, 'Unknown moderation action.');
          const target = [...sessions.values()].find(value => value.player?.id === body.playerId);
          if (!target) throw failure(404, 'That guest has already left.');
          if (target === session || target.isHost) throw failure(400, 'Hosts cannot be moderated.');
          if (body.action === 'mute' || body.action === 'unmute') {
            target.mutedUntil = body.action === 'mute' ? Date.now() + 5 * 60_000 : 0;
            send(target, 'notice', { message: body.action === 'mute' ? 'A host muted your chat for 5 minutes.' : 'A host restored your chat.' });
          } else {
            // Behind a reverse proxy, ban only the session by default to avoid banning every guest.
            // An operator can enable address bans only when Node sees real, distinct client IPs.
            if (body.action === 'ban') {
              target.bannedUntil = Date.now() + 30 * 60_000;
              if (env.BAN_BY_IP === 'true') bans.set(target.ip, target.bannedUntil);
            }
            dropPlayer(target, body.action === 'ban' ? 'A host banned this session for 30 minutes.' : 'A host checked you out of the motel.');
          }
          json(res, 200, { ok: true }); return;
        }
        if (pathname === '/api/action') {
          checkLimit(`action:${session.token}`, 50, 1000);
          const player = session.player;
          if (body.type === 'move') {
            checkLimit(`move:${session.token}`, 12, 1000);
            if (typeof body.x !== 'number' || typeof body.z !== 'number' || !isWalkable(body.x, body.z)) throw failure(400, 'Choose a clear spot inside the motel.');
            const route = findRoute(player, { x: body.x, z: body.z });
            if (!route) throw failure(400, 'That spot cannot be reached.');
            player.seatId = null; player.pose = inPool(player.x, player.z) ? 'swim' : 'stand'; player.route = route; stateDirty = true;
          } else if (body.type === 'seat') {
            const seat = SEATS.find(value => value.id === body.seatId);
            if (!seat) throw failure(400, 'Choose an available seat.');
            if (Math.hypot(player.x - seat.x, player.z - seat.z) > 1.6 || !lineClear(player, seat)) throw failure(400, 'Walk closer to the seat first.');
            if ([...sessions.values()].some(value => value !== session && value.player?.seatId === seat.id)) throw failure(409, 'Someone is already sitting there.');
            Object.assign(player, { x: seat.x, z: seat.z, seatId: seat.id, pose: 'sit', route: [] }); stateDirty = true;
          } else if (body.type === 'stand') {
            player.seatId = null; player.pose = inPool(player.x, player.z) ? 'swim' : 'stand'; player.route = []; stateDirty = true;
          } else if (body.type === 'emote') {
            if (!EMOTES.has(body.emote)) throw failure(400, 'Choose one of the available reactions.');
            checkLimit(`emote:${session.token}`, 3, 3000);
            player.emote = body.emote; player.emoteUntil = Date.now() + 2800; stateDirty = true;
          } else if (body.type === 'chat') {
            if (session.mutedUntil > Date.now()) throw failure(403, 'Your chat is temporarily muted by a host.');
            checkLimit(`chat:${session.token}`, 3, 5000);
            const text = cleanText(body.text, 280);
            if (!text) throw failure(400, 'Write a message first.');
            player.chatText = text; player.chatUntil = Date.now() + 6000;
            broadcast('chat', { id: randomUUID(), playerId: player.id, name: player.name, text, time: Date.now(), kind: 'chat' }); stateDirty = true;
          } else throw failure(400, 'Unknown action.');
          json(res, 200, { ok: true }); return;
        }
        throw failure(404, 'Endpoint not found.');
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && ASSETS.has(pathname)) {
        const [filename, contentType] = ASSETS.get(pathname);
        try {
          const content = await readFile(path.join(ROOT, filename));
          res.writeHead(200, {
            'Content-Type': contentType, 'Content-Length': content.length,
            // Reuse the approved sign across visits; code and markup still refresh.
            'Cache-Control': pathname === '/motel-sign.png' ? 'public, max-age=86400' : 'no-cache',
          });
          res.end(req.method === 'HEAD' ? undefined : content); return;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      throw failure(404, 'Not found.');
    } catch (error) {
      if (!error.status) logger.error?.('Request failed:', error.message);
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 500, { error: error.status ? error.message : 'Reception had a problem. Try again.' });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = Math.max(128, maxPlayers * 8);
  let previousTick = Date.now();
  const tick = setInterval(() => {
    const now = Date.now(), elapsed = Math.min(0.2, (now - previousTick) / 1000); previousTick = now;
    if (partyWasActive && now >= party.endsAt) { partyWasActive = false; broadcast('party', partyInfo()); stateDirty = true; }
    for (const session of sessions.values()) {
      const player = session.player;
      if (!player) continue;
      if (!session.stream && session.disconnectedAt && now - session.disconnectedAt >= graceMs) { dropPlayer(session); continue; }
      let distance = speed * elapsed;
      while (player.route.length && distance > 0) {
        const target = player.route[0], gap = Math.hypot(target.x - player.x, target.z - player.z);
        if (gap <= distance) { player.x = target.x; player.z = target.z; player.route.shift(); distance -= gap; }
        else { player.x += (target.x - player.x) * distance / gap; player.z += (target.z - player.z) * distance / gap; distance = 0; }
        player.pose = inPool(player.x, player.z) ? 'swim' : 'stand'; stateDirty = true;
      }
      if (player.emote && now >= player.emoteUntil) { player.emote = null; player.emoteUntil = 0; stateDirty = true; }
      if (player.chatText && now >= player.chatUntil) { player.chatText = ''; player.chatUntil = 0; stateDirty = true; }
    }
    if (stateDirty) { stateDirty = false; broadcast('state', state()); }
  }, tickMs);
  tick.unref();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (session.stream) {
        session.touched = now;
        if (session.stream.writableLength > 64 * 1024) session.stream.destroy();
        else session.stream.write(': heartbeat\n\n');
      }
      if (!session.player && now - session.touched > sessionTtlMs && session.bannedUntil <= now) sessions.delete(key);
    }
    for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    for (const [key, until] of bans) if (until <= now) bans.delete(key);
  }, 10_000);
  cleanup.unref();
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true; clearInterval(tick); clearInterval(cleanup);
    for (const session of sessions.values()) { send(session, 'notice', { message: 'The motel is restarting. Reconnect in a moment.' }); session.stream?.end(); }
  };
  // End persistent SSE responses when tests or the process request a graceful close.
  const originalClose = server.close.bind(server);
  server.close = callback => { stop(); return originalClose(callback); };
  server.on('close', stop);
  server.once('close', () => passports.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createHotelServer({ dataDir: process.env.MOTEL_DATA_DIR || path.join(ROOT, 'data') });
  const port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => {
    console.log(`Motel listening on http://${host}:${port}`);
    if (!process.env.ADMIN_KEY) console.warn('Host controls are disabled; set ADMIN_KEY before a public event.');
    if (!process.env.PUBLIC_ORIGIN) console.warn('Set PUBLIC_ORIGIN to your HTTPS site origin before public deployment.');
    if (process.env.COIN_MINT && !isMint(process.env.COIN_MINT)) console.warn('COIN_MINT is invalid; coin purchase links are disabled.');
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 5000).unref();
  });
}
