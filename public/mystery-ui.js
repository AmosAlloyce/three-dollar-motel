import { MYSTERY_SPOTS, PARTY_COST, PARTY_DURATION_MS } from './mystery.js';

const $ = id => document.getElementById(id);
const emptyPassport = () => ({ clues: [], solved: false, stamp: null, credits: 0 });

export function createMysteryUI({ api, getSession, checkIn, move, renderer, unauthorized, toast }) {
  let passport = emptyPassport();
  let party = { active: false, endsAt: 0, startedBy: null };
  let pendingClue = null, walkingTo = null, request = null, requestSerial = 0;
  let status = '', passportFingerprint = '', partyFingerprint = '';
  const clueElements = new Map();

  for (const [index, spot] of MYSTERY_SPOTS.entries()) {
    const item = document.createElement('li'); item.className = 'mystery-clue';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'clue-button'; button.dataset.clue = spot.id;
    const number = document.createElement('span'); number.className = 'clue-number'; number.textContent = String(index + 1).padStart(2, '0'); number.setAttribute('aria-hidden', 'true');
    const title = document.createElement('strong'); title.textContent = spot.title;
    const action = document.createElement('span'); action.className = 'clue-action'; action.textContent = 'Walk over & inspect ↗';
    const text = document.createElement('p'); text.id = `clue-text-${spot.id}`; text.className = 'clue-text'; text.hidden = true; text.tabIndex = -1;
    button.setAttribute('aria-describedby', text.id);
    button.append(number, title, action); item.append(button, text); $('mystery-clues').append(item);
    button.addEventListener('click', () => { void visit(spot.id); });
    clueElements.set(spot.id, { item, button, action, text });
  }

  function setStatus(message) {
    status = message;
    if ($('mystery-status').textContent !== message) $('mystery-status').textContent = message;
  }

  function updatePassport(value) {
    if (!value || !Array.isArray(value.clues)) return;
    passport = value;
    renderer.setClues(passport.clues.map(clue => clue.id));
    const fingerprint = JSON.stringify(passport);
    if (fingerprint !== passportFingerprint) {
      passportFingerprint = fingerprint;
      for (const spot of MYSTERY_SPOTS) {
        const clue = passport.clues.find(item => item.id === spot.id);
        const element = clueElements.get(spot.id);
        element.item.classList.toggle('collected', Boolean(clue));
        element.text.hidden = !clue;
        element.text.textContent = clue?.text || '';
      }
      $('mystery-progress').textContent = `${passport.clues.length} / ${MYSTERY_SPOTS.length} clues found`;
      $('passport-credits').textContent = String(passport.credits);
      $('passport-stamp').classList.toggle('earned', Boolean(passport.stamp));
      $('passport-stamp-title').textContent = passport.stamp ? 'Founding sleuth' : 'Your first passport stamp';
      $('passport-stamp-copy').textContent = passport.stamp ? 'Room 003 · Mystery solved' : 'Solve Room 003 to make your mark.';
      $('passport-stamp-icon').textContent = passport.stamp ? '✓' : '003';
      $('mystery-solve-form').hidden = passport.solved;
      $('mystery-complete').hidden = !passport.solved;
      if (pendingClue && passport.clues.some(clue => clue.id === pendingClue)) pendingClue = walkingTo = null;
    }
    updateControls();
  }

  function updateParty(value) {
    if (!value || typeof value.active !== 'boolean') return;
    party = value;
    renderer.setParty(party);
    updateControls();
  }

  function updateControls() {
    const { me, connected } = getSession();
    const ready = Boolean(me && connected);
    const liveParty = party.active && party.endsAt > Date.now();
    for (const spot of MYSTERY_SPOTS) {
      const element = clueElements.get(spot.id);
      const found = passport.clues.some(clue => clue.id === spot.id);
      const label = found ? 'Clue found · Read again' : pendingClue === spot.id ? request?.type === 'inspect' ? 'Inspecting…' : !me ? 'Check in to investigate' : !connected ? 'Waiting to reconnect…' : 'Walking over…' : 'Walk over & inspect ↗';
      if (element.action.textContent !== label) element.action.textContent = label;
      element.button.disabled = Boolean(request || pendingClue) && !found;
      element.button.setAttribute('aria-busy', String(pendingClue === spot.id));
    }
    const allClues = passport.clues.length === MYSTERY_SPOTS.length;
    $('mystery-code').disabled = !ready || !allClues || Boolean(request);
    $('mystery-solve').disabled = !ready || !allClues || Boolean(request);
    const solveLabel = request?.type === 'solve' ? 'Trying the key…' : 'Unlock Room 003 ↗';
    if ($('mystery-solve').textContent !== solveLabel) $('mystery-solve').textContent = solveLabel;
    const solveHint = passport.solved ? '' : !me ? 'Check in for free to start the mystery.' : !connected ? 'Your clues are saved. Waiting to reconnect…' : !allClues ? 'Collect all three clues, then enter the three-digit door code.' : 'Put the three clues together. What is the door code?';
    if ($('mystery-code-hint').textContent !== solveHint) $('mystery-code-hint').textContent = solveHint;
    $('party-button').disabled = Boolean(request) || liveParty || Boolean(me && (!connected || passport.credits < PARTY_COST));
    const partyLabel = request?.type === 'party' ? 'Turning on the lights…' : liveParty ? 'Pool party in progress' : `Start pool party · ${PARTY_COST} demo credits`;
    if ($('party-button').textContent !== partyLabel) $('party-button').textContent = partyLabel;
    const seconds = Math.max(0, Math.ceil((party.endsAt - Date.now()) / 1000));
    $('party-banner').hidden = !liveParty;
    const fingerprint = JSON.stringify([liveParty, seconds, party.startedBy, passport.solved, passport.credits]);
    if (fingerprint !== partyFingerprint) {
      partyFingerprint = fingerprint;
      $('party-countdown').textContent = `${seconds}s`;
      $('party-host').textContent = party.startedBy ? `${party.startedBy} turned on the pool lights.` : 'The pool lights are on.';
      $('party-note').textContent = liveParty ? `Everyone gets the party. ${seconds} seconds left.` : !passport.solved ? `Solve the mystery to earn ${PARTY_COST} demo credits. Spend them on a ${Math.round(PARTY_DURATION_MS / 1000)}-second pool party for everyone.` : passport.credits >= PARTY_COST ? 'Your stamp stays yours. Treat everyone here to a minute under the pool lights.' : 'You treated the motel. Your passport stamp is saved for your next visit.';
    }
  }

  async function mutate(body) {
    const session = getSession();
    if (!session.me) { checkIn(); return false; }
    if (!session.connected || request) return false;
    const token = { id: ++requestSerial, generation: session.generation, type: body.type };
    request = token; updateControls();
    try {
      const info = await api('/api/mystery', body);
      if (token !== request || token.generation !== getSession().generation) return false;
      updatePassport(info.passport); updateParty(info.party);
      if (body.type === 'inspect') setStatus(`${MYSTERY_SPOTS.find(spot => spot.id === body.clueId)?.title || 'Clue'} found. Read it below.`);
      else if (body.type === 'solve') { setStatus('Room 003 is open! Your stamp and demo credits are saved.'); toast('Mystery solved. Your founding sleuth stamp is yours.'); }
      else {
        setStatus('Pool party started! Everyone in the courtyard can see it.');
        $('party-banner').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        renderer.focusSelf();
      }
      return true;
    } catch (error) {
      if (token !== request || token.generation !== getSession().generation) return false;
      if (error.status === 401) unauthorized();
      else {
        setStatus(error.message);
        // A timed-out response may already have saved the reward. Refresh the
        // authoritative passport; retrying is also safe on the server.
        try {
          const info = await api('/api/me');
          if (token === request && token.generation === getSession().generation) { updatePassport(info.passport); updateParty(info.party); }
        } catch { /* Preserve the draft and let the guest retry. */ }
      }
      return false;
    } finally {
      if (token === request) { request = null; updateControls(); }
    }
  }

  async function visit(id) {
    const spot = MYSTERY_SPOTS.find(item => item.id === id);
    if (!spot || request) return;
    if (passport.clues.some(clue => clue.id === id)) { clueElements.get(id).text.focus(); return; }
    if (pendingClue) return;
    pendingClue = id; walkingTo = null; setStatus('');
    const { me, connected } = getSession();
    if (!me) { updateControls(); checkIn(); return; }
    if (!connected) { setStatus('Waiting to reconnect. Your clues are saved.'); updateControls(); return; }
    await continueVisit();
  }

  async function continueVisit() {
    const { me, connected, generation } = getSession();
    if (!me || !connected || !pendingClue || request) return;
    const spot = MYSTERY_SPOTS.find(item => item.id === pendingClue);
    if (!spot) return;
    if (Math.hypot(me.x - spot.x, me.z - spot.z) <= 0.65) {
      pendingClue = walkingTo = null;
      await mutate({ type: 'inspect', clueId: spot.id });
      updateControls();
    } else if (walkingTo !== spot.id) {
      walkingTo = spot.id; updateControls();
      const moved = await move(spot.x, spot.z);
      if (generation !== getSession().generation || pendingClue !== spot.id) return;
      if (!moved) { pendingClue = walkingTo = null; setStatus('Could not reach that clue. Try its button again.'); updateControls(); }
    }
  }

  function cancelTravel() {
    pendingClue = walkingTo = null; updateControls();
  }

  function reset() {
    request = null; pendingClue = walkingTo = null; setStatus('');
    // The passport belongs to the browser, and remains visible after checkout.
    updateControls();
  }

  $('mystery-solve-form').addEventListener('submit', event => {
    event.preventDefault(); cancelTravel();
    if (!$('mystery-solve').disabled) void mutate({ type: 'solve', code: $('mystery-code').value.trim() });
  });
  $('party-button').addEventListener('click', () => {
    if (!getSession().me) { checkIn(); return; }
    cancelTravel(); void mutate({ type: 'party' });
  });
  $('hero-mystery').addEventListener('click', () => {
    $('mystery-title').scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    $('mystery-title').focus({ preventScroll: true });
  });

  updatePassport(passport);
  return {
    visit, cancelTravel, reset, updatePassport, updateParty, updateControls,
    updatePosition: () => { void continueVisit(); },
    reconnected: () => { walkingTo = null; updateControls(); void continueVisit(); },
    getState: () => ({ passport: structuredClone(passport), party: { ...party }, pendingClue, status, busy: Boolean(request) }),
  };
}
