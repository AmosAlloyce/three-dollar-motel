// Optional real-browser check. Install Playwright separately; runtime needs no packages.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';
import { createHotelServer } from '../server.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = process.env.BROWSER_ARTIFACTS || '/tmp/motel-browser/artifacts';
await mkdir(artifacts, { recursive: true });
const server = createHotelServer({ adminKey: 'browser-test-only', disconnectGraceMs: 5000 });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
const checks = [];

try {
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const watch = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  };
  let alice = await desktop.newPage(); const bob = await mobile.newPage(); watch(alice); watch(bob);
  const [artworkResponse] = await Promise.all([
    alice.waitForResponse(response => response.url() === `${base}/motel-sign.png`),
    alice.goto(`${base}/?debug=1`),
  ]);
  await alice.locator('#checkin-dialog[open]').waitFor();
  await alice.locator('#checkin-dialog .checkin-sign').evaluate(img => img.decode());
  await alice.screenshot({ path: `${artifacts}/check-in.png`, fullPage: true });
  await alice.locator('#browse-button').click();
  const artwork = alice.locator('img.neon-sign[src="/motel-sign.png"]');
  await artwork.evaluate(img => img.decode());
  assert.equal(artworkResponse.ok(), true, 'Motel artwork is served successfully');
  assert.match(artworkResponse.headers()['content-type'], /^image\/png(?:;|$)/);
  assert.equal(await artwork.isVisible(), true, 'Motel artwork is visible');
  assert.equal(await artwork.evaluate(img => img.naturalWidth > 0 && img.naturalHeight > 0), true, 'Motel artwork decodes in the browser');
  checks.push('Approved motel artwork loads and renders as a PNG');
  async function assertRoomFocus(page) {
    await page.waitForFunction(() => {
      const canvas = document.querySelector('#hotel-canvas');
      const bounds = canvas.getBoundingClientRect();
      return document.activeElement === canvas && bounds.bottom > 0 && bounds.top < window.innerHeight;
    });
    assert.equal(await page.locator('#checkin-dialog').isVisible(), false, 'Exploring the room does not open check-in');
  }
  await alice.locator('#hero-room').click();
  await assertRoomFocus(alice);
  assert.equal(await alice.evaluate(() => window.__motel.state().me), null, 'Exploring does not create a guest');
  await alice.locator('#hero-checkin').click();
  await alice.locator('#checkin-dialog[open]').waitFor();
  checks.push('Visitors can explore the room and reopen check-in from the hero');
  async function join(page, name, color) {
    await page.locator('#nickname').fill(name);
    await page.getByRole('button', { name: color, exact: true }).click();
    await page.locator('#join-button').click();
    await page.waitForFunction(() => window.__motel?.state().connected);
  }
  await join(alice, 'Maya', 'Sea green');
  const aliceIdentity = await alice.evaluate(() => window.__motel.state().me.id);
  await alice.locator('#hero-checkin').click();
  await assertRoomFocus(alice);
  assert.equal(await alice.evaluate(() => window.__motel.state().me.id), aliceIdentity, 'Returning to the room preserves the guest session');
  checks.push('Checked-in guests return to the room from the hero without joining again');
  await bob.goto(`${base}/?debug=1`); await join(bob, 'Noah', 'Blue');
  await bob.locator('#hero-room').click();
  await assertRoomFocus(bob);
  checks.push('Explore navigation focuses the room on a phone');
  await alice.waitForFunction(() => window.__motel.state().players.length === 2);
  checks.push('Two independent guests join and see each other');
  assert.equal(await alice.locator('#daily-prompt').textContent(), await bob.locator('#daily-prompt').textContent());
  await alice.locator('#answer-prompt').click();
  const answer = `${await alice.locator('#daily-prompt').textContent()} — A tiny waffle machine.`;
  assert.match(await alice.locator('#chat-input').inputValue(), / — $/);
  assert.equal(await bob.locator('.message').count(), 0, 'Prompt drafts are not sent automatically');
  await alice.locator('#chat-input').fill(answer);
  await alice.locator('#answer-prompt').click();
  assert.equal(await alice.locator('#chat-input').inputValue(), answer, 'An existing draft must be preserved');
  await alice.locator('#chat-input').press('Enter');
  await bob.getByText(answer, { exact: true }).waitFor();
  checks.push('Daily question matches across guests; answering preserves drafts and sends only on submission');
  await alice.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard blocked for test'); } } }));
  await alice.locator('#invite-friend').click();
  assert.equal(await alice.locator('#invite-link').inputValue(), `${base}/`, 'Invitation excludes debug and other URL parameters');
  await alice.locator('#invite-dialog [data-close-dialog]').click();
  checks.push('Invite link remains usable when clipboard permission is denied');
  await alice.locator('#chat-input').fill('Pool is surprisingly clean today.');
  await alice.locator('#chat-input').press('Enter');
  await bob.getByText('Pool is surprisingly clean today.', { exact: true }).waitFor();
  await bob.locator('#chat-input').fill('Saving you a seat!'); await bob.locator('#chat-input').press('Enter');
  await alice.getByText('Saving you a seat!', { exact: true }).waitFor();
  checks.push('Chat is delivered in both directions');
  async function clickWorld(page, x, z) {
    await page.locator('#hotel-canvas').scrollIntoViewIfNeeded();
    const point = await page.evaluate(({ x, z }) => {
      const point = window.__motel.scene().worldToScreen(x, z); const bounds = document.querySelector('canvas').getBoundingClientRect();
      return { x: point.x + bounds.left, y: point.y + bounds.top };
    }, { x, z });
    await page.mouse.click(point.x, point.y);
  }
  await clickWorld(alice, 10.2, 6.5);
  await alice.waitForFunction(() => window.__motel.state().me.pose === 'swim');
  await bob.waitForFunction(() => window.__motel.state().players.some(player => player.name === 'Maya' && player.pose === 'swim'));
  await alice.getByRole('button', { name: 'Splash', exact: true }).click();
  await bob.waitForFunction(() => window.__motel.state().players.some(player => player.name === 'Maya' && player.emote === 'splash'));
  checks.push('Canvas click moves a guest into the pool; swimming and reactions synchronize');
  await bob.locator('#hotel-canvas').scrollIntoViewIfNeeded();
  const touchTarget = await bob.evaluate(() => {
    const point = window.__motel.scene().worldToScreen(6.8, 7.8); const bounds = document.querySelector('canvas').getBoundingClientRect();
    return { x: point.x + bounds.left, y: point.y + bounds.top };
  });
  await bob.touchscreen.tap(touchTarget.x, touchTarget.y);
  await bob.waitForFunction(() => Math.hypot(window.__motel.state().me.x - 6.8, window.__motel.state().me.z - 7.8) < 0.1);
  checks.push('Phone touch input moves the guest to the tapped floor position');
  await bob.locator('#chat-input').blur();
  await alice.screenshot({ path: `${artifacts}/hotel-desktop.png`, fullPage: true });
  await bob.screenshot({ path: `${artifacts}/hotel-mobile.png`, fullPage: true });
  for (const page of [alice, bob]) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'Horizontal page overflow');
  }
  checks.push('Desktop and phone layouts fit the viewport');
  await alice.locator('#hotel-canvas').scrollIntoViewIfNeeded();
  const seat = await alice.evaluate(() => {
    const point = window.__motel.scene().seats.find(seat => seat.id === 'sunbed-1'); const rect = document.querySelector('canvas').getBoundingClientRect();
    return { x: point.x + rect.left, y: point.y + rect.top };
  });
  await alice.mouse.click(seat.x, seat.y);
  await alice.waitForFunction(() => window.__motel.state().me.seatId === 'sunbed-1');
  await alice.locator('#stand-button').click(); await alice.waitForFunction(() => window.__motel.state().me.pose === 'stand');
  checks.push('Clicking a distant seat walks over and sits; standing works');
  const beforeTyping = await bob.evaluate(() => ({ x: window.__motel.state().me.x, z: window.__motel.state().me.z }));
  await bob.locator('#chat-input').fill('wasd');
  await bob.locator('#chat-input').press('ArrowLeft');
  assert.deepEqual(await bob.evaluate(() => ({ x: window.__motel.state().me.x, z: window.__motel.state().me.z })), beforeTyping);
  await bob.locator('#chat-input').fill('');
  checks.push('Typing and arrow keys in chat do not move the avatar');
  await bob.locator('#guests-tab').click(); await bob.locator('.guest-row').filter({ hasText: 'Maya' }).click();
  await bob.locator('#local-mute').click(); await bob.locator('#chat-tab').click();
  assert.equal(await bob.getByText('Pool is surprisingly clean today.', { exact: true }).count(), 0);
  await bob.locator('#guests-tab').click(); await bob.locator('.guest-row').filter({ hasText: 'Maya' }).click();
  await bob.locator('#local-mute').click(); await bob.locator('#chat-tab').click();
  await bob.getByText('Pool is surprisingly clean today.', { exact: true }).waitFor();
  checks.push('Local mute hides and restores another guest’s messages');
  const malicious = '<img src=x onerror=alert(1)>';
  await bob.locator('#chat-input').fill(malicious); await bob.locator('#chat-input').press('Enter');
  await alice.getByText(malicious, { exact: true }).waitFor();
  assert.equal(await alice.locator('#chat-messages img').count(), 0);
  checks.push('Chat markup is shown as text and cannot create HTML');
  const identity = await bob.evaluate(() => window.__motel.state().me.id);
  await bob.reload(); await bob.waitForFunction(() => window.__motel?.state().connected);
  assert.equal(await bob.evaluate(() => window.__motel.state().me.id), identity);
  checks.push('Reload reconnects the existing guest without duplication');
  await mobile.setOffline(true);
  await bob.waitForFunction(() => !window.__motel.state().connected);
  await mobile.setOffline(false);
  await bob.waitForFunction(() => window.__motel.state().connected);
  assert.equal(await bob.evaluate(() => window.__motel.state().me.id), identity);
  checks.push('A short connection outage recovers the guest session');
  const replacement = await desktop.newPage(); watch(replacement);
  await replacement.goto(`${base}/?debug=1`); await replacement.waitForFunction(() => window.__motel?.state().connected);
  await alice.locator('#checkin-dialog[open]').waitFor();
  assert.equal(await alice.evaluate(() => window.__motel.state().me), null);
  alice = replacement;
  checks.push('Opening the same session in another tab stops the old stream cleanly');
  await alice.locator('#hero-mystery').click();
  assert.equal(await alice.locator('#mystery-title').evaluate(element => element === document.activeElement), true);
  assert.equal(await alice.locator('#mystery-code').isDisabled(), true, 'Door code requires the three clues');
  await alice.locator('#hotel-canvas').scrollIntoViewIfNeeded();
  const cluePin = await alice.evaluate(() => {
    const pin = window.__motel.scene().clues.find(clue => clue.id === 'reception');
    const bounds = document.querySelector('#hotel-canvas').getBoundingClientRect();
    return { x: pin.x + bounds.left, y: pin.y + bounds.top };
  });
  await alice.mouse.click(cluePin.x, cluePin.y);
  await alice.waitForFunction(() => window.__motel.state().mystery.passport.clues.length === 1);
  await alice.reload(); await alice.waitForFunction(() => window.__motel?.state().connected);
  assert.equal(await alice.evaluate(() => window.__motel.state().mystery.passport.clues.length), 1);
  assert.equal(await alice.locator('#clue-text-reception').isVisible(), true);
  for (const clue of ['lounge', 'pool']) {
    await alice.locator(`[data-clue="${clue}"]`).click();
    await alice.waitForFunction(id => window.__motel.state().mystery.passport.clues.some(clue => clue.id === id), clue);
  }
  await alice.locator('#mystery-code').fill('314');
  await alice.locator('#mystery-code').press('Enter');
  await alice.waitForFunction(() => window.__motel.state().mystery.passport.solved);
  assert.equal(await alice.locator('#passport-credits').textContent(), '3');
  assert.equal(await alice.locator('#passport-stamp.earned').count(), 1);
  checks.push('Room 003 works through a canvas pin and keyboard-accessible buttons; partial progress survives reload and solving awards a stamp');
  await bob.locator('[data-clue="reception"]').click();
  await bob.waitForFunction(() => window.__motel.state().mystery.passport.clues.length === 1);
  assert.equal(await bob.locator('#passport-credits').textContent(), '0', 'Passports are private to each browser');
  checks.push('A phone guest can inspect a clue using the travel button and has independent progress');
  await alice.locator('#party-button').click();
  await bob.waitForFunction(() => window.__motel.scene().party.active);
  await alice.waitForFunction(() => window.__motel.state().mystery.passport.credits === 0);
  await alice.waitForFunction(() => {
    const bounds = document.querySelector('#party-banner').getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom < innerHeight;
  });
  assert.equal(await bob.locator('#party-banner').isVisible(), true);
  assert.equal(await bob.locator('#party-button').isDisabled(), true);
  await alice.reload(); await alice.waitForFunction(() => window.__motel?.state().connected);
  assert.equal(await alice.evaluate(() => window.__motel.state().mystery.passport.solved), true);
  assert.equal(await alice.locator('#passport-credits').textContent(), '0');
  assert.equal(await alice.evaluate(() => window.__motel.scene().party.active), true);
  await alice.locator('#hotel-canvas').scrollIntoViewIfNeeded();
  await alice.screenshot({ path: `${artifacts}/pilot-desktop.png`, fullPage: true });
  await bob.locator('#hotel-canvas').scrollIntoViewIfNeeded();
  await bob.screenshot({ path: `${artifacts}/pilot-mobile.png`, fullPage: true });
  for (const page of [alice, bob]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  checks.push('Spending demo credits starts a shared party, and stamp, spent balance and active party survive refresh on desktop and phone');
  await alice.locator('.sidebar-bottom .host-entry').click();
  await alice.locator('#host-key').fill('browser-test-only'); await alice.locator('#host-submit').click();
  await alice.waitForFunction(() => window.__motel.state().isHost);
  async function moderate(action) {
    await alice.locator('#guests-tab').click(); await alice.locator('.guest-row').filter({ hasText: 'Noah' }).click();
    await alice.locator(`[data-moderate="${action}"]`).click();
  }
  await moderate('mute'); await bob.waitForFunction(() => document.querySelector('#chat-input').disabled);
  await moderate('unmute'); await bob.waitForFunction(() => !document.querySelector('#chat-input').disabled);
  await moderate('kick'); await bob.locator('#checkin-dialog[open]').waitFor();
  assert.match(await bob.locator('#checkin-error').textContent(), /host/i);
  await alice.waitForFunction(() => window.__motel.state().players.length === 1);
  checks.push('Host login, mute, unmute and kick work through the interface');
  await alice.locator('#coin-top').click();
  assert.equal(await alice.locator('#coin-details').isVisible(), false);
  assert.match(await alice.locator('#coin-description').textContent(), /no official token address/i);
  checks.push('No trading link appears before a token is configured');
  assert.deepEqual(errors, [], 'Browser console or page errors');
  console.log(JSON.stringify({ passed: checks.length, checks, artifacts, browserErrors: errors }, null, 2));
} catch (error) {
  if (browser) {
    for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      await page.screenshot({ path: `${artifacts}/failure-${index}.png`, fullPage: true }).catch(() => {});
    }
  }
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
