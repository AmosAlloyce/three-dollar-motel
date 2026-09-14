import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHotelServer } from '../server.mjs';
import { COLORS } from '../public/world.js';
import { MYSTERY_SPOTS } from '../public/mystery.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const cookieValue = (cookie, name) => cookie?.split('; ').find(value => value.startsWith(`${name}=`));

async function fixture(t, options = {}) {
  const server = createHotelServer({ env: {}, dataDir: ':memory:', movementSpeed: 100, tickMs: 20,
    disconnectGraceMs: 10_000, logger: { error() {} }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const streams = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all(streams.map(stream => stream.close()));
    await new Promise(resolve => server.close(resolve));
  }
  t.after(close);
  async function request(route, { cookie, body, headers = {} } = {}) {
    const response = await fetch(url + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, data: await response.json(),
      cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  async function events(cookie) {
    const controller = new AbortController();
    const response = await fetch(url + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    const received = [];
    let buffer = '', stopped = false, failure;
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
      } catch (error) { if (!stopped) failure = error; }
    })();
    const stream = {
      received,
      async wait(event, predicate = () => true, timeout = 3000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const found = received.find(item => item.event === event && predicate(item.data));
          if (found) return found.data;
          if (failure) throw failure;
          await delay(10);
        }
        assert.fail(`Timed out waiting for ${event}: ${JSON.stringify(received).slice(-1000)}`);
      },
      async close() { if (stopped) return; stopped = true; controller.abort(); await pump; },
    };
    streams.push(stream);
    return stream;
  }
  async function join(name = 'Sleuth', cookie) {
    const result = await request('/api/join', { body: { name, color: COLORS[0] }, cookie });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const cookies = new Map((cookie ?? '').split('; ').filter(Boolean).map(value => value.split('=')));
    for (const value of result.cookie.split('; ').filter(Boolean)) {
      const [key, token] = value.split('='); cookies.set(key, token);
    }
    const savedCookie = [...cookies].map(([key, token]) => `${key}=${token}`).join('; ');
    const stream = await events(savedCookie);
    const ready = await stream.wait('ready');
    const guest = {
      cookie: savedCookie, result, ready, stream, player: result.data.player,
      me: () => request('/api/me', { cookie: savedCookie }),
      mystery: body => request('/api/mystery', { cookie: savedCookie, body }),
      async move(spot) {
        const moved = await request('/api/action', { cookie: savedCookie, body: { type: 'move', x: spot.x, z: spot.z } });
        assert.equal(moved.status, 200, JSON.stringify(moved.data));
        await stream.wait('state', state => state.players.some(player => player.id === guest.player.id && Math.hypot(player.x - spot.x, player.z - spot.z) < 0.03));
      },
      async inspect(spot) {
        await guest.move(spot);
        const inspected = await guest.mystery({ type: 'inspect', clueId: spot.id });
        assert.equal(inspected.status, 200, JSON.stringify(inspected.data));
        return inspected.data;
      },
      async solve() {
        for (const spot of MYSTERY_SPOTS) await guest.inspect(spot);
        const solved = await guest.mystery({ type: 'solve', code: '314' });
        assert.equal(solved.status, 200, JSON.stringify(solved.data));
        return solved.data;
      },
    };
    return guest;
  }
  return { request, join, close, events };
}

test('passport cookies are private, persistent, and secure for HTTPS; mystery actions require check-in', async t => {
  const app = await fixture(t, { publicOrigin: 'https://motel.example' });
  const anonymous = await app.request('/api/me');
  assert.equal(anonymous.data.player, null);
  assert.equal(anonymous.data.passport, null);
  assert.equal(anonymous.data.party.active, false);
  for (const body of [{ type: 'inspect', clueId: 'reception' }, { type: 'solve', code: '314' }, { type: 'party' }]) {
    assert.equal((await app.request('/api/mystery', { body })).status, 401);
  }
  const guest = await app.join();
  const cookies = guest.result.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  for (const name of ['hotel_session', 'motel_passport']) {
    const cookie = cookies.find(value => value.startsWith(`${name}=`));
    assert.match(cookie, new RegExp(`^${name}=[a-f0-9]{64};`));
    assert.match(cookie, /; HttpOnly(?:;|$)/);
    assert.match(cookie, /; SameSite=Strict(?:;|$)/);
    assert.match(cookie, /; Secure(?:;|$)/);
  }
  assert.ok(Number(/Max-Age=(\d+)/.exec(cookies.find(value => value.startsWith('motel_passport=')))?.[1]) > 86_400);
  assert.deepEqual(guest.ready.passport, guest.result.data.passport);
  assert.equal(guest.result.data.passport.credits, 0);
  assert.equal((await guest.mystery({ type: 'party' })).status, 400);
  assert.equal((await app.request('/api/mystery', { cookie: guest.cookie, body: { type: 'solve', code: '314' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  const passportOnly = cookieValue(guest.cookie, 'motel_passport');
  assert.equal((await app.request('/api/mystery', { cookie: passportOnly, body: { type: 'solve', code: '314' } })).status, 401);
  assert.deepEqual((await app.request('/api/me', { cookie: passportOnly })).data.passport, guest.result.data.passport);
  assert.equal((await app.request('/api/me', { cookie: 'motel_passport=malformed' })).data.passport, null);
});

test('the mystery requires visits to all three places and the correct code', async t => {
  const app = await fixture(t);
  const guest = await app.join();
  assert.equal((await guest.mystery({ type: 'inspect', clueId: 'missing' })).status, 400);
  assert.equal((await guest.mystery({ type: 'solve', code: '314' })).status, 400);
  assert.equal((await guest.mystery({ type: 'unknown' })).status, 400);
  await guest.move(MYSTERY_SPOTS.find(spot => spot.id === 'reception'));
  assert.equal((await guest.mystery({ type: 'inspect', clueId: 'pool' })).status, 400);
  assert.equal((await guest.me()).data.passport.clues.length, 0);
  for (const [index, spot] of MYSTERY_SPOTS.entries()) {
    const info = await guest.inspect(spot);
    assert.equal(info.passport.clues.length, index + 1);
    const clue = info.passport.clues.find(value => value.id === spot.id);
    assert.equal(typeof clue.title, 'string');
    assert.ok(clue.text.length > 0);
    assert.equal(info.passport.solved, false);
    assert.equal(info.passport.stamp, null);
    assert.equal(info.passport.credits, 0);
  }
  assert.equal((await guest.mystery({ type: 'solve', code: '000' })).status, 400);
  assert.equal((await guest.me()).data.passport.credits, 0);
  const solved = await guest.mystery({ type: 'solve', code: '314' });
  assert.equal(solved.status, 200);
  assert.equal(solved.data.passport.solved, true);
  assert.equal(solved.data.passport.credits, 3);
  assert.equal(solved.data.passport.stamp.id, 'room-003');
  assert.equal(solved.data.passport.stamp.title, 'Room 003 · Founding sleuth');
  assert.ok(solved.data.passport.stamp.earnedAt > 0);
});

test('simultaneous solutions and replayed clues award one stamp and three credits only once', async t => {
  const app = await fixture(t);
  const guest = await app.join();
  for (const spot of MYSTERY_SPOTS) await guest.inspect(spot);
  const solved = await Promise.all(Array.from({ length: 3 }, () => guest.mystery({ type: 'solve', code: '314' })));
  assert.deepEqual(solved.map(result => result.status), [200, 200, 200]);
  for (const result of solved) assert.equal(result.data.passport.credits, 3);
  assert.equal(new Set(solved.map(result => result.data.passport.stamp.earnedAt)).size, 1);
  const replayed = await guest.mystery({ type: 'inspect', clueId: MYSTERY_SPOTS.at(-1).id });
  assert.equal(replayed.status, 200);
  assert.equal(replayed.data.passport.clues.length, 3);
  assert.deepEqual(replayed.data.passport, solved[0].data.passport);
});

test('a shared party charges only its successful starter and broadcasts its start and end', async t => {
  const app = await fixture(t, { partyDurationMs: 500 });
  const alice = await app.join('Alice'), bob = await app.join('Bob');
  await alice.solve(); await bob.solve();
  const attempted = await Promise.all([alice.mystery({ type: 'party' }), bob.mystery({ type: 'party' })]);
  assert.deepEqual(attempted.map(result => result.status).sort(), [200, 409]);
  const winner = attempted[0].status === 200 ? alice : bob;
  const other = winner === alice ? bob : alice;
  assert.equal((await winner.me()).data.passport.credits, 0);
  assert.equal((await other.me()).data.passport.credits, 3);
  const party = await other.stream.wait('party', value => value.active);
  assert.equal(party.startedBy, winner.player.name);
  assert.ok(party.endsAt > Date.now());
  assert.deepEqual(await winner.stream.wait('party', value => value.active), party);
  assert.deepEqual((await app.request('/api/me')).data.party, party);
  assert.equal((await other.mystery({ type: 'party' })).status, 409);
  assert.equal((await other.me()).data.passport.credits, 3);
  await other.stream.wait('party', value => !value.active);
  assert.equal((await app.request('/api/me')).data.party.active, false);
  assert.equal((await winner.mystery({ type: 'party' })).status, 400);
  assert.equal((await winner.mystery({ type: 'solve', code: '314' })).data.passport.credits, 0);
});

test('passport updates reach sessions sharing that passport but never unrelated guests', async t => {
  const app = await fixture(t);
  const first = await app.join('First tab');
  const second = await app.join('Second tab', cookieValue(first.cookie, 'motel_passport'));
  const stranger = await app.join('Stranger');
  assert.notEqual(first.player.id, second.player.id);
  assert.equal(cookieValue(first.cookie, 'motel_passport'), cookieValue(second.cookie, 'motel_passport'));
  const info = await first.inspect(MYSTERY_SPOTS[0]);
  const update = await second.stream.wait('passport', value => value.clues?.length === 1);
  assert.deepEqual(update, info.passport);
  assert.deepEqual((await second.me()).data.passport, info.passport);
  assert.equal((await stranger.me()).data.passport.clues.length, 0);
  await delay(50);
  assert.equal(stranger.stream.received.some(item => item.event === 'passport'), false);
  const sharedState = await stranger.stream.wait('state', value => value.count === 3);
  for (const player of sharedState.players) {
    assert.equal(player.passport, undefined);
    assert.equal(player.clues, undefined);
    assert.equal(player.credits, undefined);
  }
  assert.equal(JSON.stringify(sharedState).includes(cookieValue(first.cookie, 'motel_passport').split('=')[1]), false);
});

test('partial progress, the solved stamp, spent credits, and an active party survive server restarts', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'motel-mystery-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const firstApp = await fixture(t, { dataDir });
  const first = await firstApp.join('Returning sleuth');
  const partial = await first.inspect(MYSTERY_SPOTS[0]);
  await firstApp.close();

  const secondApp = await fixture(t, { dataDir });
  const restored = await secondApp.request('/api/me', { cookie: first.cookie });
  assert.equal(restored.data.player, null, 'Live guest sessions are not durable.');
  assert.deepEqual(restored.data.passport, partial.passport);
  const second = await secondApp.join('Returning sleuth', first.cookie);
  assert.equal(cookieValue(second.cookie, 'motel_passport'), cookieValue(first.cookie, 'motel_passport'));
  assert.notEqual(second.player.id, first.player.id);
  assert.deepEqual(second.ready.passport, partial.passport);
  for (const spot of MYSTERY_SPOTS.slice(1)) await second.inspect(spot);
  const solved = await second.mystery({ type: 'solve', code: '314' });
  assert.equal(solved.status, 200);
  assert.equal((await second.mystery({ type: 'party' })).status, 200);
  const beforeRestart = (await second.me()).data;
  await secondApp.close();

  const thirdApp = await fixture(t, { dataDir });
  const afterRestart = (await thirdApp.request('/api/me', { cookie: second.cookie })).data;
  assert.equal(afterRestart.passport.solved, true);
  assert.equal(afterRestart.passport.credits, 0);
  assert.deepEqual(afterRestart.passport, beforeRestart.passport);
  assert.deepEqual(afterRestart.party, beforeRestart.party);
  const third = await thirdApp.join('Returning sleuth', second.cookie);
  const replay = await third.mystery({ type: 'solve', code: '314' });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.passport.credits, 0, 'Restarting must not let the completion reward be claimed twice.');
  await thirdApp.close();
});
