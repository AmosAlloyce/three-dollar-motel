import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHotelServer } from '../server.mjs';
import { COLORS, WORLD, SEATS, isWalkable } from '../public/world.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t, options = {}) {
  const server = createHotelServer({ env: {}, tickMs: 25, logger: { error() {} }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  t.after(async () => {
    await Promise.all(streams.map(stream => stream.close()));
    await new Promise(resolve => server.close(resolve));
  });
  async function request(route, { method = 'GET', cookie, body, headers = {} } = {}) {
    const response = await fetch(url + route, {
      method,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
      status: response.status, headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text,
    };
  }
  const post = (route, body, cookie, headers) => request(route, { method: 'POST', body, cookie, headers });
  async function events(cookie) {
    const controller = new AbortController();
    const response = await fetch(url + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', closed = false, ended = false, streamError;
    const received = [];
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) received.push({ event, data: JSON.parse(data) });
          }
        }
      } catch (error) { if (!closed) streamError = error; }
      finally { ended = true; }
    })();
    const stream = {
      received,
      get ended() { return ended; },
      async wait(event, predicate = () => true, timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const match = received.find(item => item.event === event && predicate(item.data));
          if (match) return match.data;
          if (streamError) throw streamError;
          await delay(10);
        }
        assert.fail(`Timed out waiting for SSE ${event}. Received: ${JSON.stringify(received).slice(-1200)}`);
      },
      async close() { if (closed) return; closed = true; controller.abort(); await pump; },
    };
    streams.push(stream);
    return stream;
  }
  async function join(name = 'Guest', color = COLORS[0]) {
    const result = await post('/api/join', { name, color });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.match(result.headers.get('set-cookie'), /HttpOnly/);
    assert.match(result.headers.get('set-cookie'), /SameSite=Strict/);
    return {
      cookie: result.cookie, player: result.data.player,
      action: body => post('/api/action', body, result.cookie),
      me: () => request('/api/me', { cookie: result.cookie }),
      events: () => events(result.cookie),
    };
  }
  return { server, url, request, post, join, events };
}

test('configuration exposes no secrets, validates mint, and serves only public assets', async t => {
  const app = await fixture(t, { env: { COIN_MINT: 'not-a-mint', ADMIN_KEY: 'private-host-secret' } });
  const result = await app.request('/api/config');
  assert.equal(result.status, 200);
  assert.equal(result.data.mint, null);
  assert.equal(result.data.tradeUrl, null);
  assert.equal(result.data.hostEnabled, true);
  assert.equal(JSON.stringify(result.data).includes('private-host-secret'), false);
  assert.equal((await app.request('/api/me')).data.player, null);
  assert.equal((await app.request('/healthz')).data.players, 0);
  const world = await app.request('/world.js');
  assert.equal(world.status, 200);
  assert.match(world.headers.get('content-type'), /javascript/);
  assert.match(world.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const route of ['/server.mjs', '/package.json', '/.env', '/public/../server.mjs']) {
    assert.equal((await app.request(route)).status, 404, route);
  }
});

test('a valid 32-byte mint enables only its configured coin link', async t => {
  const mint = 'So11111111111111111111111111111111111111112';
  const app = await fixture(t, { env: { COIN_MINT: mint, COIN_TICKER: 'MOTEL' } });
  const { data } = await app.request('/api/config');
  assert.equal(data.mint, mint);
  assert.equal(data.tradeUrl, `https://pump.fun/coin/${mint}`);
  assert.equal(data.ticker, 'MOTEL');
});

test('HTTPS deployment restricts browser origins and issues secure session cookies', async t => {
  const publicOrigin = 'https://motel.example';
  const app = await fixture(t, { publicOrigin });
  const join = { name: 'Secure guest', color: COLORS[0] };
  const result = await app.post('/api/join', join, undefined, { Origin: publicOrigin });
  assert.equal(result.status, 200);
  assert.match(result.headers.get('set-cookie'), /; Secure(?:;|$)/);
  for (const origin of [app.url, 'http://motel.example', 'https://motel.example.attacker.example', 'null']) {
    const denied = await app.post('/api/action', { type: 'stand' }, result.cookie, { Origin: origin });
    assert.equal(denied.status, 403, origin);
    assert.equal((await app.request('/api/events', { cookie: result.cookie, headers: { Origin: origin } })).status, 403, origin);
  }
  assert.equal((await app.post('/api/action', { type: 'stand' }, result.cookie, { Origin: publicOrigin })).status, 200);
  // Reverse-proxy deployment must use the configured browser origin, not its internal Host.
  const response = await fetch(app.url + '/api/events', { headers: { Cookie: result.cookie, Origin: publicOrigin } });
  assert.equal(response.status, 200);
  await response.body.cancel();
  for (const invalid of ['https://motel.example/', 'https://motel.example/path', 'ftp://motel.example', 'not-an-origin']) {
    assert.throws(() => createHotelServer({ env: {}, publicOrigin: invalid }), /PUBLIC_ORIGIN/);
  }
});

test('two independent guests receive live chat and speed-limited movement', async t => {
  const app = await fixture(t);
  const alice = await app.join('Alice'), bob = await app.join('Bob', COLORS[1]);
  assert.notEqual(alice.cookie, bob.cookie);
  assert.notEqual(alice.player.id, bob.player.id);
  const a = await alice.events(), b = await bob.events();
  assert.equal((await a.wait('ready')).id, alice.player.id);
  assert.equal((await b.wait('state', value => value.count === 2)).players.length, 2);
  assert.equal((await alice.action({ type: 'chat', text: 'Hello, pool people!' })).status, 200);
  const message = await b.wait('chat', value => value.text === 'Hello, pool people!');
  assert.equal(message.playerId, alice.player.id);
  assert.equal(message.kind, 'chat');
  await a.wait('chat', value => value.id === message.id);
  const started = Date.now();
  assert.equal((await alice.action({ type: 'move', x: 9, z: 5 })).status, 200);
  const first = await b.wait('state', value => value.players.some(player => player.id === alice.player.id && player.x > alice.player.x));
  const moved = first.players.find(player => player.id === alice.player.id);
  const traveled = Math.hypot(moved.x - alice.player.x, moved.z - alice.player.z);
  assert.ok(traveled > 0);
  assert.ok(traveled < 1, 'Movement must not teleport to a far destination.');
  assert.ok(traveled <= WORLD.speed * (Date.now() - started) / 1000 + 0.15);
  assert.equal(moved.route, undefined, 'Internal navigation state must remain private.');
  assert.equal((await bob.me()).data.player.x, bob.player.x);
});

test('server navigation routes around furniture and changes pose inside the pool', async t => {
  const app = await fixture(t, { movementSpeed: 12 });
  const guest = await app.join('Walker'), stream = await guest.events();
  const destination = { x: 2.5, z: 4.5 };
  assert.equal((await guest.action({ type: 'move', ...destination })).status, 200);
  await stream.wait('state', state => state.players.some(player => Math.hypot(player.x - destination.x, player.z - destination.z) < 0.03));
  const positions = stream.received.filter(item => item.event === 'state').flatMap(item => item.data.players);
  assert.ok(positions.length > 3);
  for (const position of positions) assert.ok(isWalkable(position.x, position.z), `Collision at ${position.x},${position.z}`);
  assert.equal((await guest.action({ type: 'move', x: 9.5, z: 6 })).status, 200);
  await stream.wait('state', state => state.players.some(player => player.pose === 'swim'));
});

test('input, origin, authentication, and message quotas are enforced', async t => {
  const app = await fixture(t);
  assert.equal((await app.post('/api/action', { type: 'stand' })).status, 401);
  assert.equal((await app.post('/api/join', { name: 'Guest', color: COLORS[0] }, undefined, { Origin: 'https://another-site.example' })).status, 403);
  assert.equal((await app.post('/api/join', { name: 'Guest', color: COLORS[0] }, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await app.post('/api/join', { name: ' ', color: COLORS[0] })).status, 400);
  assert.equal((await app.post('/api/join', { name: 'Guest', color: 'red' })).status, 400);
  const guest = await app.join('  Long\u0000 guest name that will be trimmed  ');
  assert.equal(guest.player.name.length, 20);
  assert.equal(guest.player.name.includes('\u0000'), false);
  for (const body of [{ type: 'move', x: '4', z: 5 }, { type: 'move', x: 100, z: 5 }, { type: 'move', x: 3.5, z: 6 }, { type: 'emote', emote: '<script>' }, { type: 'seat', seatId: 'fake' }, { type: 'unknown' }]) {
    assert.equal((await guest.action(body)).status, 400, JSON.stringify(body));
  }
  const malformed = await fetch(app.url + '/api/action', { method: 'POST', headers: { Cookie: guest.cookie, 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(malformed.status, 400); await malformed.text();
  const tooLarge = await app.post('/api/action', { type: 'chat', text: 'a'.repeat(3000) }, guest.cookie);
  assert.equal(tooLarge.status, 413);
  const wrongType = await fetch(app.url + '/api/action', { method: 'POST', headers: { Cookie: guest.cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(wrongType.status, 415); await wrongType.text();
  const stream = await guest.events();
  assert.equal((await guest.action({ type: 'chat', text: 'x'.repeat(400) })).status, 200);
  assert.equal((await stream.wait('chat', message => message.kind === 'chat')).text.length, 280);
  assert.equal((await guest.action({ type: 'chat', text: 'Second' })).status, 200);
  assert.equal((await guest.action({ type: 'chat', text: 'Third' })).status, 200);
  assert.equal((await guest.action({ type: 'chat', text: 'Fourth' })).status, 429);
});

test('capacity is reserved during reconnect grace and an old stream cannot disconnect its replacement', async t => {
  const app = await fixture(t, { maxPlayers: 1, disconnectGraceMs: 160 });
  const guest = await app.join('Returning');
  const first = await guest.events();
  await first.wait('ready');
  const second = await guest.events();
  await second.wait('ready');
  await first.wait('removed', value => value.reason.includes('another tab'));
  await first.close();
  await delay(220);
  assert.equal((await guest.me()).data.player.id, guest.player.id);
  assert.equal((await app.post('/api/join', { name: 'Full', color: COLORS[1] })).status, 409);
  await second.close();
  assert.equal((await app.post('/api/join', { name: 'Still full', color: COLORS[1] })).status, 409);
  await delay(70);
  const reconnected = await guest.events();
  assert.equal((await reconnected.wait('ready')).id, guest.player.id);
  await reconnected.close();
  await delay(230);
  assert.equal((await guest.me()).data.player, null);
  assert.equal((await app.request('/healthz')).data.players, 0);
  await app.join('Next guest');
});

test('a check-in that never connects an event stream releases its reserved place', async t => {
  const app = await fixture(t, { maxPlayers: 1, disconnectGraceMs: 80 });
  const guest = await app.join('Disconnected');
  assert.equal((await app.request('/healthz')).data.players, 1);
  await delay(150);
  assert.equal((await guest.me()).data.player, null);
  assert.equal((await app.request('/healthz')).data.players, 0);
  const rejoin = await app.post('/api/join', { name: 'Returning', color: COLORS[0] }, guest.cookie);
  assert.equal(rejoin.status, 200);
  assert.notEqual(rejoin.data.player.id, guest.player.id);
  assert.equal(rejoin.cookie, guest.cookie, 'An expired guest should be able to reuse their unexpired session.');
});

test('seat occupancy is atomic, requires proximity, and is released when moving', async t => {
  const app = await fixture(t, { movementSpeed: 16 });
  const a = await app.join('Seat A'), b = await app.join('Seat B');
  const seat = SEATS.find(value => value.id === 'chair-2');
  assert.equal((await a.action({ type: 'seat', seatId: seat.id })).status, 400);
  const stream = await a.events(); await b.events();
  await Promise.all([a.action({ type: 'move', x: seat.x, z: seat.z }), b.action({ type: 'move', x: seat.x, z: seat.z })]);
  await stream.wait('state', state => state.players.length === 2 && state.players.every(player => Math.hypot(player.x - seat.x, player.z - seat.z) < 0.05));
  const results = await Promise.all([a.action({ type: 'seat', seatId: seat.id }), b.action({ type: 'seat', seatId: seat.id })]);
  assert.deepEqual(results.map(value => value.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? a : b, loser = winner === a ? b : a;
  assert.equal((await winner.me()).data.player.pose, 'sit');
  assert.equal((await winner.action({ type: 'move', x: 6, z: 7 })).status, 200);
  assert.equal((await loser.action({ type: 'seat', seatId: seat.id })).status, 200);
  assert.equal((await loser.action({ type: 'stand' })).status, 200);
  assert.equal((await loser.me()).data.player.seatId, null);
});

test('only authenticated hosts can mute, restore chat, kick, and ban sessions', async t => {
  const app = await fixture(t, { adminKey: 'only-the-host-knows-this' });
  const host = await app.join('Host'), guest = await app.join('Guest');
  await host.events(); const stream = await guest.events();
  const moderate = action => app.post('/api/moderate', { action, playerId: guest.player.id }, host.cookie);
  assert.equal((await moderate('mute')).status, 403);
  assert.equal((await app.post('/api/host', { key: 'wrong' }, host.cookie)).status, 403);
  assert.equal((await app.post('/api/host', { key: 'only-the-host-knows-this' }, host.cookie)).status, 200);
  assert.equal((await host.me()).data.isHost, true);
  assert.equal((await moderate('mute')).status, 200);
  await stream.wait('notice', value => value.message.includes('muted'));
  assert.equal((await guest.action({ type: 'chat', text: 'Muted message' })).status, 403);
  const muteRemaining = (await guest.me()).data.mutedUntil - Date.now();
  assert.ok(muteRemaining > 290_000 && muteRemaining <= 300_000);
  assert.equal((await moderate('unmute')).status, 200);
  assert.equal((await guest.action({ type: 'chat', text: 'Restored message' })).status, 200);
  assert.equal((await moderate('kick')).status, 200);
  await stream.wait('removed', value => value.reason.includes('checked you out'));
  assert.equal((await guest.action({ type: 'stand' })).status, 401);
  const rejoin = await app.post('/api/join', { name: 'Guest again', color: COLORS[0] }, guest.cookie);
  assert.equal(rejoin.status, 200);
  assert.equal((await app.post('/api/moderate', { action: 'ban', playerId: rejoin.data.player.id }, host.cookie)).status, 200);
  assert.equal((await app.post('/api/join', { name: 'Banned', color: COLORS[0] }, guest.cookie)).status, 403);
  assert.equal((await host.me()).data.player.id, host.player.id, 'Session bans must not ban everyone sharing an IP.');
});

test('20 real sessions receive shared chat and simultaneous movement, and enforce capacity', async t => {
  const app = await fixture(t);
  const guests = [];
  for (let i = 0; i < 20; i++) guests.push(await app.join(`Guest ${i + 1}`, COLORS[i % COLORS.length]));
  const streams = await Promise.all(guests.map(guest => guest.events()));
  await Promise.all(streams.map(stream => stream.wait('state', state => state.count === 20)));
  assert.equal((await app.request('/healthz')).data.players, 20);
  assert.equal((await app.post('/api/join', { name: 'Overflow', color: COLORS[0] })).status, 409);
  assert.equal((await guests[0].action({ type: 'chat', text: 'Opening party roll call' })).status, 200);
  const messages = await Promise.all(streams.map(stream => stream.wait('chat', message => message.text === 'Opening party roll call')));
  assert.equal(new Set(messages.map(message => message.id)).size, 1);
  const destinations = guests.map((guest, index) => ({ x: 8.6 + index % 5 * 0.5, z: 5 + Math.floor(index / 5) * 0.7 }));
  const movements = await Promise.all(guests.map((guest, index) => guest.action({ type: 'move', ...destinations[index] })));
  assert.ok(movements.every(result => result.status === 200));
  await Promise.all(streams.map(stream => stream.wait('state', state => state.count === 20 && state.players.every(player => {
    const index = guests.findIndex(guest => guest.player.id === player.id);
    return index >= 0 && player.pose === 'swim' && Math.hypot(player.x - destinations[index].x, player.z - destinations[index].z) < 0.03;
  }), 5000)));
  assert.equal((await app.post('/api/leave', {}, guests[0].cookie)).status, 200);
  await streams[1].wait('state', state => state.count === 19);
  assert.equal((await app.request('/healthz')).data.players, 19);
});

test('20 guests sharing a proxy IP can send valid bursts without exhausting the aggregate quota', async t => {
  const app = await fixture(t);
  const guests = [];
  for (let i = 0; i < 20; i++) guests.push(await app.join(`Shared IP ${i + 1}`));
  // 620 requests including check-ins exceeds the former shared 600-request cap.
  // Each guest remains within the 12 movement and 50 action per-second caps.
  // Stand commands exercise the aggregate budget without waiting for movement
  // windows or introducing a clock override into the production server.
  await Promise.all(guests.map(async guest => {
    for (let i = 0; i < 30; i++) {
      const body = i < 10 ? { type: 'move', x: 7, z: 10 } : { type: 'stand' };
      const result = await guest.action(body);
      assert.equal(result.status, 200, `${guest.player.name}, action ${i + 1}: ${JSON.stringify(result.data)}`);
    }
  }));
});

test('one guest cannot use the shared proxy allowance to exceed its movement quota', async t => {
  const app = await fixture(t);
  const guest = await app.join('Fast guest');
  const results = await Promise.all(Array.from({ length: 13 }, () => guest.action({ type: 'move', x: 7, z: 10 })));
  assert.equal(results.filter(result => result.status === 200).length, 12);
  assert.equal(results.filter(result => result.status === 429).length, 1);
});
