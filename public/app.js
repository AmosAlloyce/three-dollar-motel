import { COLORS, SEATS } from './world.js';
import { createHotelRenderer } from './renderer.js';
import { createMysteryUI } from './mystery-ui.js';

const $ = id => document.getElementById(id);
const dialogs = [...document.querySelectorAll('dialog')];
const emoteButtons = [...document.querySelectorAll('[data-emote]')];
const colorNames = ['Terracotta', 'Sea green', 'Lavender', 'Mustard', 'Olive', 'Blue'];
let profile = {};
try { profile = JSON.parse(localStorage.getItem('motel-profile') || '{}') || {}; } catch { /* Guest entry also works without storage. */ }
let chosenColor = COLORS.includes(profile.color) ? profile.color : COLORS[0];
let me = null, isHost = false, connected = false, mutedUntil = 0;
let players = [], config = null, stream = null, pendingSeat = null, selectedGuest = null;
let guestFingerprint = '', toastTimer, recoveryCheck = 0, generation = 0, sendingChat = false;
let messages = [], mutedIds = new Set(), messageIds = new Set();
const knownColors = new Map();
const poolsidePrompts = [
  'What wildly unnecessary amenity does this motel need?',
  'Describe your week as a one-star motel review.',
  'What belongs in the motel’s lost-and-found box?',
  'You run reception for a day. What is your first house rule?',
  'What snack deserves a permanent spot beside the pool?',
  'Give the motel’s imaginary house band a name.',
  'What would you write on a postcard from this place?',
  'Pitch the world’s least convincing luxury motel upgrade.',
  'What song is playing in the lobby right now?',
  'Name the inflatable pool toy that nobody is allowed to lose.',
  'What is the most suspicious item on our breakfast menu?',
  'The motel gets a mascot. What is it?',
  'What tiny thing made your day better?',
  'Write a six-word story about a guest in room three.',
];
let promptDay = -1, pendingPrompt = false;

function refreshDailyPrompt() {
  const day = Math.floor(Date.now() / 86_400_000);
  if (day === promptDay) return;
  promptDay = day;
  $('daily-prompt').textContent = poolsidePrompts[day % poolsidePrompts.length];
}

function answerPrompt() {
  refreshDailyPrompt();
  if (!me) { pendingPrompt = true; openDialog('checkin-dialog'); return; }
  if (!connected) { toast('Wait for the motel to reconnect, then try again.'); return; }
  if (Date.now() < mutedUntil) { toast('Your chat is temporarily muted.'); return; }
  pendingPrompt = false;
  selectTab('chat');
  const input = $('chat-input');
  if (!input.value.trim()) input.value = `${$('daily-prompt').textContent} — `;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}

function openDialog(id) {
  const dialog = $(id);
  for (const other of dialogs) if (other !== dialog && other.open) other.close();
  if (!dialog.open) dialog.showModal();
}

async function api(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new Error('Could not reach reception. Check your connection and try again.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Reception could not complete that request.'), { status: response.status });
  return data;
}

function updateControls() {
  const canChat = connected && me && Date.now() >= mutedUntil;
  $('chat-input').disabled = !canChat;
  $('send-button').disabled = !canChat || sendingChat;
  $('stand-button').disabled = !connected || me?.pose !== 'sit';
  for (const button of emoteButtons) button.disabled = !connected || !me;
  $('chat-hint').textContent = !me ? 'Check in to join the conversation.' : !connected ? 'Reconnecting. Your message will stay here.' : !canChat ? 'A host has temporarily muted your chat.' : 'Enter to send · Be nice to your neighbours.';
  $('connection-pill').className = `connection-pill${connected ? ' online' : me ? ' reconnecting' : ''}`;
  $('connection-label').textContent = connected ? 'Live at the motel' : me ? 'Reconnecting' : 'Not checked in';
  $('reconnect-banner').hidden = !me || connected;
  $('leave-button').hidden = !me;
  $('open-checkin').hidden = Boolean(me);
  const heroLabel = me ? 'Back to the courtyard ↗' : 'Check in for free ↗';
  if ($('hero-checkin').textContent !== heroLabel) $('hero-checkin').textContent = heroLabel;
  $('self-name').textContent = me?.name || 'Room for one more?';
  $('self-avatar').textContent = me ? [...me.name][0].toUpperCase() : '?';
  $('self-avatar').style.backgroundColor = me?.color || '#dddcc9';
  $('self-avatar').style.color = me ? '#fff8ec' : '#6f7866';
  $('self-status').textContent = !me ? 'Check in below.' : !connected ? 'Finding your room…' : isHost ? 'On duty at reception' : me.pose === 'swim' ? 'Taking a dip' : me.pose === 'sit' ? 'Making yourself at home' : 'Enjoying the courtyard';
  mystery.updateControls();
  if (canChat && pendingPrompt) answerPrompt();
}

function resetSession(reason) {
  generation++;
  stream?.close(); stream = null;
  me = null; connected = false; isHost = false; mutedUntil = 0; pendingSeat = null; selectedGuest = null; pendingPrompt = false;
  players = []; messages = []; messageIds.clear(); knownColors.clear(); mutedIds.clear();
  renderer.setState([], null); renderer.setMutedIds(mutedIds);
  mystery.reset();
  $('guest-count').textContent = '—'; $('guest-tab-count').textContent = '0';
  guestFingerprint = ''; renderGuests(); renderMessages(); updateControls();
  for (const dialog of dialogs) if (dialog.open) dialog.close();
  if (reason) { $('checkin-error').textContent = reason; openDialog('checkin-dialog'); }
}

async function act(body, { quiet = false } = {}) {
  if (!me) { openDialog('checkin-dialog'); return false; }
  if (!connected) { if (!quiet) toast('Reconnecting to the hotel. Try again in a moment.'); return false; }
  const current = generation;
  try { await api('/api/action', body); return true; }
  catch (error) {
    if (current !== generation) return false;
    if (error.status === 401) resetSession('Your room session ended. Check in again.');
    else if (!quiet || error.status !== 429) toast(error.message);
    return false;
  }
}

function walk(x, z) { pendingSeat = null; mystery.cancelTravel(); void act({ type: 'move', x, z }, { quiet: true }); }
async function takeSeat(seatId) {
  mystery.cancelTravel();
  if (!me) { openDialog('checkin-dialog'); return; }
  if (!connected) { toast('Wait for the hotel to reconnect.'); return; }
  const seat = SEATS.find(item => item.id === seatId);
  if (!seat) return;
  if (players.some(player => player.id !== me.id && player.seatId === seatId)) { toast('That seat is taken. Try another.'); return; }
  if (Math.hypot(me.x - seat.x, me.z - seat.z) <= 1.3) {
    pendingSeat = null; await act({ type: 'seat', seatId });
  } else {
    pendingSeat = seatId;
    if (!await act({ type: 'move', x: seat.x, z: seat.z })) pendingSeat = null;
  }
}

const renderer = createHotelRenderer($('hotel-canvas'), {
  onMove: walk, onSeat: takeSeat, onSelectPlayer: selectGuest,
  onReception: () => openDialog('coin-dialog'),
  onClue: id => { void mystery.visit(id); },
});
const mystery = createMysteryUI({
  api, renderer, getSession: () => ({ me, connected, generation }),
  checkIn: () => openDialog('checkin-dialog'),
  move: (x, z) => { pendingSeat = null; return act({ type: 'move', x, z }); },
  unauthorized: () => resetSession('Your room session ended. Check in again.'),
  toast,
});

function applyState(data) {
  if (data.party) mystery.updateParty(data.party);
  if (!me || !Array.isArray(data.players)) return;
  players = data.players;
  const current = players.find(player => player.id === me.id);
  if (!current) return;
  me = current;
  for (const player of players) knownColors.set(player.id, COLORS.includes(player.color) ? player.color : COLORS[0]);
  while (knownColors.size > 200) knownColors.delete(knownColors.keys().next().value);
  renderer.setState(players, me.id);
  $('guest-count').textContent = String(data.count ?? players.length);
  $('guest-tab-count').textContent = String(players.length);
  $('guest-count-label').textContent = players.length === 1 ? 'guest checked in' : 'guests checked in';
  updateControls(); renderGuests();
  mystery.updatePosition();
  if (selectedGuest && !players.some(player => player.id === selectedGuest)) {
    selectedGuest = null; $('guest-dialog').close();
  }
  if (pendingSeat) {
    const seat = SEATS.find(item => item.id === pendingSeat);
    if (players.some(player => player.id !== me.id && player.seatId === pendingSeat)) {
      pendingSeat = null; toast('Someone took that seat. Try another.');
    } else if (seat && Math.hypot(me.x - seat.x, me.z - seat.z) <= 0.75) {
      pendingSeat = null; void act({ type: 'seat', seatId: seat.id });
    }
  }
}

function connectStream() {
  stream?.close();
  if (!me) return;
  const source = new EventSource('/api/events');
  stream = source; connected = false; updateControls();
  const current = generation;
  const listen = (event, handler) => source.addEventListener(event, payload => {
    if (source !== stream || current !== generation) return;
    try { handler(JSON.parse(payload.data)); } catch (error) { console.error('Invalid hotel event:', error); }
  });
  listen('ready', data => {
    if (data.id === me?.id) {
      connected = true;
      mystery.updatePassport(data.passport);
      if (data.party) mystery.updateParty(data.party);
      mystery.reconnected(); updateControls();
    }
  });
  listen('state', applyState);
  listen('passport', data => mystery.updatePassport(data));
  listen('party', data => mystery.updateParty(data));
  listen('chat', addMessage);
  listen('notice', data => {
    toast(data.message);
    void api('/api/me').then(info => {
      if (current !== generation) return;
      mutedUntil = info.mutedUntil || 0; isHost = Boolean(info.isHost); updateControls();
    }).catch(() => {});
  });
  listen('removed', data => resetSession(data.reason || 'Your room session ended. Check in again.'));
  source.onerror = () => {
    if (source !== stream || current !== generation) return;
    connected = false; updateControls();
    if (Date.now() - recoveryCheck < 2500) return;
    recoveryCheck = Date.now();
    void api('/api/me').then(info => {
      if (source !== stream || current !== generation) return;
      if (!info.player || info.player.id !== me?.id) resetSession('Your room session ended. Check in again.');
      mystery.updatePassport(info.passport); mystery.updateParty(info.party);
    }).catch(() => {});
  };
}

function makeMessage(item) {
  if (item.kind === 'system') {
    const line = document.createElement('p'); line.className = 'system-message'; line.textContent = item.text; return line;
  }
  const row = document.createElement('div'); row.className = `message${item.playerId === me?.id ? ' you' : ''}`;
  const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = [...item.name][0]?.toUpperCase() || '?'; avatar.style.backgroundColor = knownColors.get(item.playerId) || COLORS[0];
  const content = document.createElement('div'); content.className = 'message-content';
  const head = document.createElement('div'); head.className = 'message-head';
  const name = document.createElement('span'); name.className = 'message-name'; name.textContent = item.name + (item.playerId === me?.id ? ' (you)' : '');
  const time = document.createElement('time'); time.className = 'message-time';
  const date = new Date(item.time); time.dateTime = date.toISOString(); time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const text = document.createElement('p'); text.className = 'message-text'; text.textContent = item.text;
  head.append(name, time); content.append(head, text); row.append(avatar, content); return row;
}

function renderMessages() {
  const container = $('chat-messages'); const scroll = container.scrollTop;
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 65;
  const visible = messages.filter(item => !mutedIds.has(item.playerId));
  const fragment = document.createDocumentFragment();
  if (!visible.length) {
    const empty = document.createElement('p'); empty.className = 'empty-chat'; empty.textContent = 'A good conversation starts with hello.'; fragment.append(empty);
  } else for (const item of visible) fragment.append(makeMessage(item));
  // Bulk rendering is only used for join/reset and local moderation, not each live message.
  container.replaceChildren(fragment);
  container.scrollTop = atBottom ? container.scrollHeight : scroll;
}

function addMessage(item) {
  if (!item.id || messageIds.has(item.id)) return;
  messageIds.add(item.id); messages.push(item);
  if (messages.length > 200) { const old = messages.shift(); messageIds.delete(old.id); }
  if (mutedIds.has(item.playerId)) return;
  const container = $('chat-messages'); const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 65;
  container.querySelector('.empty-chat')?.remove(); container.append(makeMessage(item));
  while (container.children.length > 200) container.firstElementChild.remove();
  if (atBottom || item.playerId === me?.id) container.scrollTop = container.scrollHeight;
  if ($('chat-panel').hidden && item.kind !== 'system') document.querySelector('.unread-dot').hidden = false;
}

function renderGuests() {
  const fingerprint = JSON.stringify([players.map(player => [player.id, player.name, player.color, player.pose]), [...mutedIds], me?.id]);
  if (fingerprint === guestFingerprint) return;
  guestFingerprint = fingerprint;
  const fragment = document.createDocumentFragment();
  for (const player of [...players].sort((a, b) => (b.id === me?.id) - (a.id === me?.id))) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'guest-row'; row.dataset.playerId = player.id;
    const avatar = document.createElement('span'); avatar.className = 'guest-avatar'; avatar.style.backgroundColor = player.color; avatar.textContent = [...player.name][0]?.toUpperCase(); avatar.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div'); const name = document.createElement('strong'); name.textContent = player.name + (player.id === me?.id ? ' (you)' : '');
    const status = document.createElement('small'); status.textContent = mutedIds.has(player.id) ? 'Muted on your screen' : player.pose === 'swim' ? 'Poolside company' : player.pose === 'sit' ? 'Taking a seat' : 'In the courtyard';
    const menu = document.createElement('span'); menu.className = 'guest-menu'; menu.textContent = '···'; menu.setAttribute('aria-hidden', 'true');
    text.append(name, status); row.append(avatar, text, menu); row.addEventListener('click', () => selectGuest(player.id)); fragment.append(row);
  }
  $('guest-list').replaceChildren(fragment); $('guests-empty').hidden = Boolean(players.length);
}

function selectGuest(id) {
  if (!me) { openDialog('checkin-dialog'); return; }
  if (id === me.id) { toast('That’s you. Looking good.'); return; }
  const player = players.find(item => item.id === id); if (!player) return;
  selectedGuest = id; $('guest-title').textContent = player.name;
  $('local-mute').textContent = mutedIds.has(id) ? 'Unmute on my screen' : 'Mute on my screen';
  $('host-actions').hidden = !isHost; openDialog('guest-dialog');
}

function selectTab(which, focus = false) {
  for (const name of ['chat', 'guests']) {
    const active = which === name; const button = $(`${name}-tab`);
    button.classList.toggle('selected', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    $(`${name}-panel`).hidden = !active;
    if (active && focus) button.focus();
  }
  if (which === 'chat') document.querySelector('.unread-dot').hidden = true;
}

for (const [index, color] of COLORS.entries()) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'color-option'; button.style.backgroundColor = color;
  button.setAttribute('aria-label', colorNames[index]); button.setAttribute('aria-pressed', String(color === chosenColor)); button.classList.toggle('selected', color === chosenColor);
  button.addEventListener('click', () => {
    chosenColor = color;
    for (const sibling of $('color-picker').children) { const active = sibling === button; sibling.classList.toggle('selected', active); sibling.setAttribute('aria-pressed', String(active)); }
  });
  $('color-picker').append(button);
}
if (typeof profile.name === 'string') $('nickname').value = profile.name.slice(0, 20);
$('checkin-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('join-button').disabled) return;
  $('join-button').disabled = true; $('join-button').textContent = 'Finding you a room…'; $('checkin-error').textContent = '';
  try {
    const info = await api('/api/join', { name: $('nickname').value.trim(), color: chosenColor });
    generation++; me = info.player; isHost = Boolean(info.isHost); mutedUntil = info.mutedUntil || 0;
    mystery.updatePassport(info.passport); mystery.updateParty(info.party);
    try { localStorage.setItem('motel-profile', JSON.stringify({ name: me.name, color: me.color })); } catch { /* Optional. */ }
    $('checkin-dialog').close(); connectStream(); renderer.focusSelf();
  } catch (error) { $('checkin-error').textContent = error.message; }
  finally { $('join-button').disabled = false; $('join-button').textContent = 'Check in ↗'; }
});
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); const text = $('chat-input').value.trim(); if (!text || sendingChat || !connected) return;
  sendingChat = true; updateControls();
  const original = $('chat-input').value;
  if (await act({ type: 'chat', text }) && $('chat-input').value === original) $('chat-input').value = '';
  sendingChat = false; updateControls(); $('chat-input').focus();
});
$('leave-button').addEventListener('click', async () => {
  $('leave-button').disabled = true;
  try { await api('/api/leave', {}); resetSession(); toast('Thanks for stopping by. Come back soon.'); }
  catch (error) { toast(error.message); }
  finally { $('leave-button').disabled = false; }
});
$('stand-button').addEventListener('click', () => { pendingSeat = null; mystery.cancelTravel(); void act({ type: 'stand' }); renderer.focusSelf(); });
for (const button of emoteButtons) button.addEventListener('click', () => {
  if (button.dataset.emote === 'splash' && me?.pose !== 'swim') { toast('Take a dip in the pool to make a splash.'); return; }
  void act({ type: 'emote', emote: button.dataset.emote });
});
for (const id of ['coin-nav', 'coin-top', 'reception-button']) $(id).addEventListener('click', () => openDialog('coin-dialog'));
for (const id of ['help-nav', 'mobile-help']) $(id).addEventListener('click', () => openDialog('help-dialog'));
function exploreCourtyard() {
  $('hotel-canvas').scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  renderer.focusSelf();
}
$('courtyard-nav').addEventListener('click', exploreCourtyard);
$('hero-room').addEventListener('click', exploreCourtyard);
$('hero-checkin').addEventListener('click', () => { if (me) exploreCourtyard(); else openDialog('checkin-dialog'); });
$('open-checkin').addEventListener('click', () => openDialog('checkin-dialog'));
$('browse-button').addEventListener('click', () => $('checkin-dialog').close());
for (const button of document.querySelectorAll('[data-close-dialog]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of dialogs) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
for (const which of ['chat', 'guests']) {
  $(`${which}-tab`).addEventListener('click', () => selectTab(which));
  $(`${which}-tab`).addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); selectTab(event.key === 'Home' ? 'chat' : event.key === 'End' ? 'guests' : which === 'chat' ? 'guests' : 'chat', true); }
  });
}
$('local-mute').addEventListener('click', () => {
  if (!selectedGuest) return;
  if (mutedIds.has(selectedGuest)) mutedIds.delete(selectedGuest); else mutedIds.add(selectedGuest);
  renderer.setMutedIds(mutedIds); renderGuests(); renderMessages(); $('guest-dialog').close();
});
for (const button of document.querySelectorAll('.host-entry')) button.addEventListener('click', () => {
  if (!me) { toast('Check in as a guest before opening reception.'); openDialog('checkin-dialog'); return; }
  if (!config?.hostEnabled) { toast('Host access has not been enabled for this hotel yet.'); return; }
  if (isHost) { selectTab('guests'); $('guests-tab').scrollIntoView({ block: 'center' }); toast('Choose a guest to manage their stay.'); return; }
  $('host-error').textContent = ''; openDialog('host-dialog');
});
$('host-form').addEventListener('submit', async event => {
  event.preventDefault(); $('host-submit').disabled = true; $('host-error').textContent = '';
  try { await api('/api/host', { key: $('host-key').value }); isHost = true; $('host-key').value = ''; $('host-dialog').close(); updateControls(); toast('You’re on duty. Select a guest to open host controls.'); }
  catch (error) { $('host-error').textContent = error.message; }
  finally { $('host-submit').disabled = false; }
});
for (const button of document.querySelectorAll('[data-moderate]')) button.addEventListener('click', async () => {
  if (!selectedGuest) return; button.disabled = true;
  try { await api('/api/moderate', { playerId: selectedGuest, action: button.dataset.moderate }); $('guest-dialog').close(); toast('Guest settings updated.'); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('copy-address').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(config.mint); toast('Official token address copied.'); }
  catch { $('coin-address').focus(); toast('Select the address above to copy it.'); }
});
$('answer-prompt').addEventListener('click', answerPrompt);
$('checkin-dialog').addEventListener('close', () => { if (!me) { pendingPrompt = false; mystery.cancelTravel(); } });
$('invite-friend').addEventListener('click', async () => {
  const link = `${location.origin}/`;
  try { await navigator.clipboard.writeText(link); toast('Motel link copied. Send it to a friend and pick a time to meet.'); }
  catch { $('invite-link').value = link; openDialog('invite-dialog'); $('invite-link').focus(); $('invite-link').select(); }
});

async function initialize() {
  const [configuration, session] = await Promise.allSettled([api('/api/config'), api('/api/me')]);
  if (configuration.status === 'fulfilled') {
    config = configuration.value;
    document.title = `${config.name} — The courtyard`;
    if (config.mint && config.tradeUrl === `https://pump.fun/coin/${config.mint}` && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.mint)) {
      $('coin-nav-tag').textContent = config.ticker; $('coin-details').hidden = false; $('coin-address').textContent = config.mint;
      $('trade-link').href = config.tradeUrl;
      $('coin-description').textContent = `${config.ticker} is the motel’s community coin. Use the official address below to find it.`;
      $('coin-disclaimer').textContent = 'Trading is optional. A meme coin can lose all its value. The hotel remains open to guests.';
      $('notice-title').textContent = `Meet ${config.ticker}, the motel’s community coin.`;
      $('notice-copy').textContent = 'Visit reception for the official token address. Guest entry stays free.';
    }
  } else $('checkin-error').textContent = configuration.reason.message;
  if (session.status === 'fulfilled') {
    mystery.updatePassport(session.value.passport); mystery.updateParty(session.value.party);
  }
  if (session.status === 'fulfilled' && session.value.player) {
    me = session.value.player; isHost = Boolean(session.value.isHost); mutedUntil = session.value.mutedUntil || 0; connectStream();
  } else openDialog('checkin-dialog');
  updateControls();
}
window.addEventListener('online', () => { if (me && !connected) connectStream(); });
window.addEventListener('offline', () => { if (me) { connected = false; updateControls(); } });
window.addEventListener('pagehide', () => { stream?.close(); stream = null; connected = false; });
window.addEventListener('pageshow', event => { if (event.persisted && me) connectStream(); });
setInterval(() => { refreshDailyPrompt(); mystery.updateControls(); if (me && mutedUntil && Date.now() >= mutedUntil) { mutedUntil = 0; updateControls(); } }, 1000);
if (['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('debug')) {
  window.__motel = { scene: () => renderer.getDebugState(), state: () => ({ players: structuredClone(players), me: me && { ...me }, connected, isHost, mystery: mystery.getState() }) };
}
refreshDailyPrompt();
void initialize();
