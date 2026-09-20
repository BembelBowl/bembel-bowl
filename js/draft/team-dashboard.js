import { auth } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { DRAFT, teamLogo } from './config.js';
import { getUserProfile, watchBoard, watchState, watchTeam, watchSheet, setAttendance, savePreferenceSheet, requestRemotePick, ensureTeamDefaults } from './service.js';
import { loadSleeperPlayers } from './players.js';
import { loadRankings, mergeRanking, rankingMeta } from './rankings.js';
import { getNextOpenSlot, orderedPicks } from './model.js';

const $ = id => document.getElementById(id);
const $$ = s => [...document.querySelectorAll(s)];
let profile = null;
let team = null;
let sheet = {};
let board = { teams: [], picks: {} };
let state = {};
let players = [];
let ranked = [];
let priorityState = Object.fromEntries(DRAFT.positions.map(p => [p, []]));
let bootedUid = null;
let wasOnClock = false;
let popupTimer = null;

$('loginBtn').onclick = async () => {
  $('loginError').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value);
  } catch (e) {
    $('loginError').textContent = friendlyError(e);
  }
};
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  if (!user) {
    bootedUid = null;
    profile = null;
    $('loginCard').classList.remove('is-hidden');
    $('app').classList.add('is-hidden');
    return;
  }
  try {
    profile = await getUserProfile(user.uid);
    if (!profile?.teamId || profile?.role !== 'team') {
      $('loginError').textContent = 'Für dieses Konto ist kein gültiges Team-Profil in /users/{uid} hinterlegt.';
      await signOut(auth);
      return;
    }
    $('loginCard').classList.add('is-hidden');
    $('app').classList.remove('is-hidden');
    $('teamTitle').textContent = profile.teamId;
    $('teamLogo').src = teamLogo(profile.teamId);
    $('teamLogo').alt = `${profile.teamId} Logo`;
    $('teamLogo').onerror = () => { $('teamLogo').src = 'images/favicon.jpg'; };
    if (bootedUid !== user.uid) {
      bootedUid = user.uid;
      await ensureTeamDefaults(profile.teamId);
      await boot();
    }
  } catch (e) {
    $('loginError').textContent = `Login konnte nicht initialisiert werden: ${e.message}`;
  }
});

async function boot() {
  try {
    players = await loadSleeperPlayers();
  } catch (e) {
    console.error(e);
    $('rankingInfo').textContent = `Spielerdaten konnten nicht geladen werden: ${e.message}`;
    players = [];
  }
  try {
    await loadRankings();
    renderRankingInfo();
  } catch (e) {
    console.error(e);
    $('rankingInfo').textContent = 'FantasyPros ECR noch nicht geladen – Secret setzen und GitHub Action ausführen.';
  }
  ranked = players.map(mergeRanking).sort((a, b) => a.sortRank - b.sortRank || a.name.localeCompare(b.name));
  buildRoundPlan();
  buildPriorityColumns();
  watchBoard(b => { board = b; render(); });
  watchState(s => { state = s; render(); });
  watchTeam(profile.teamId, t => { team = t || { attendance: 'present' }; renderAttendance(); });
  watchSheet(profile.teamId, s => {
    sheet = s || {};
    hydrateSheet();
  });
}

function render() {
  if (!profile) return;
  const next = getNextOpenSlot(board.picks || {});
  const onClock = !!next && board.teams?.[next.position - 1] === profile.teamId;
  $('clockBadge').classList.toggle('is-hidden', !onClock);
  if (onClock) $('clockBadge').textContent = `ON THE CLOCK · #${next.overall}`;
  $('pickSearch').disabled = !onClock;
  $('livePickHint').classList.toggle('is-hidden', onClock);
  $('pickStatus').textContent = onClock ? `Pick #${next.overall}: Wähle deinen Spieler und bestätige den Pick.` : '';
  $('pickStatus').classList.toggle('is-hidden', !onClock);

  if (onClock && !wasOnClock) showOnClockPopup(profile.teamId);
  wasOnClock = onClock;
  renderAvailable();
  renderRoster();
}

function showOnClockPopup(teamName) {
  clearTimeout(popupTimer);
  $('onClockPopupTeam').textContent = teamName;
  $('onClockPopup').classList.remove('is-hidden');
  popupTimer = setTimeout(() => $('onClockPopup').classList.add('is-hidden'), 3600);
}
$('onClockPopup').onclick = () => $('onClockPopup').classList.add('is-hidden');

function renderAttendance() {
  $$('#attendance button').forEach(b => b.classList.toggle('active', b.dataset.v === (team?.attendance || 'present')));
}
$('attendance').onclick = async e => {
  const v = e.target.dataset.v;
  if (!v) return;
  try {
    await setAttendance(profile.teamId, v);
  } catch (err) {
    alert(`Status konnte nicht gespeichert werden: ${err.message}`);
  }
};

$('pickSearch').oninput = () => {
  const q = $('pickSearch').value.toLowerCase().trim();
  const next = getNextOpenSlot(board.picks || {});
  if (q.length < 2 || !next) { $('pickResults').innerHTML = ''; return; }
  const picked = pickedNames();
  $('pickResults').innerHTML = ranked
    .filter(p => p.search.includes(q) && !picked.has(p.name.toLowerCase()))
    .slice(0, 15)
    .map(p => `<div class="result"><span class="tag">${esc(p.position)}</span><div><b>${esc(p.name)}</b><br><small>${esc(p.nflTeam || '')}${p.ecr != null ? ` · ECR ${p.ecr}` : ''}</small></div><button data-pick-id="${esc(p.id)}">Pick</button></div>`)
    .join('');
};

$('pickResults').onclick = async e => {
  const id = e.target.dataset.pickId;
  if (!id) return;
  const p = ranked.find(x => String(x.id) === id);
  const next = getNextOpenSlot(board.picks || {});
  if (!p || !next || board.teams?.[next.position - 1] !== profile.teamId) return;
  if (!confirm(`${p.name} wirklich draften?`)) return;
  try {
    await requestRemotePick({ teamId: profile.teamId, player: { id: p.id, name: p.name, position: p.position, nflTeam: p.nflTeam }, actorUid: auth.currentUser.uid, overall: next.overall });
    $('pickStatus').textContent = 'Pick wurde an die Admin-Steuerung gesendet und wird geprüft…';
    $('pickSearch').value = '';
    $('pickResults').innerHTML = '';
  } catch (err) {
    $('pickStatus').textContent = `Pick konnte nicht gesendet werden: ${err.message}`;
  }
};

function buildRoundPlan() {
  $('roundPlan').innerHTML = Array.from({ length: DRAFT.roundCount }, (_, i) => `
    <label>Runde ${i + 1}
      <select data-round="${i + 1}">${['QB','RB','WR','TE','K','DEF','FLEX'].map(p => `<option>${p}</option>`).join('')}</select>
    </label>`).join('');
}

function buildPriorityColumns() {
  $('priorityEditors').innerHTML = DRAFT.positions.map(pos => `
    <section class="priority-column" data-priority-column="${pos}">
      <div class="priority-head"><strong>${pos}</strong><span class="priority-count" id="count-${pos}"></span></div>
      <div class="priority-list" data-priority-list="${pos}"></div>
    </section>`).join('');
  DRAFT.positions.forEach(pos => {
    const list = document.querySelector(`[data-priority-list="${pos}"]`);
    list.addEventListener('dragover', e => {
      e.preventDefault();
      const dragging = document.querySelector('.priority-player.dragging');
      if (!dragging || dragging.dataset.pos !== pos) return;
      const after = getDragAfterElement(list, e.clientY);
      if (after == null) list.appendChild(dragging); else list.insertBefore(dragging, after);
    });
    list.addEventListener('drop', () => syncPriorityFromDom(pos));
  });
}

function hydrateSheet() {
  for (let r = 1; r <= DRAFT.roundCount; r++) {
    const el = document.querySelector(`[data-round="${r}"]`);
    if (el) el.value = sheet.roundPlan?.[String(r)] || DRAFT.fallbackRoundPlan[r - 1] || 'FLEX';
  }
  DRAFT.positions.forEach(pos => { priorityState[pos] = [...(sheet.playerPriorities?.[pos] || [])]; });
  $('sheetDefaultBadge').textContent = sheet.usesDefaultPlan === false ? 'Individuelles Sheet' : 'Default-Regeln';
  renderPriorityLists();
}

$('saveSheet').onclick = async () => {
  const status = $('sheetSaveState');
  setSaveState(status, 'Speichert…');
  try {
    // Always save both parts in one atomic document write so neither can overwrite/reset the other.
    DRAFT.positions.forEach(syncPriorityFromDomSilent);
    const roundPlan = Object.fromEntries($$('[data-round]').map(e => [e.dataset.round, e.value]));
    await savePreferenceSheet(profile.teamId, { roundPlan, playerPriorities: priorityState });
    setSaveState(status, '✓ Draft Sheet vollständig gespeichert');
  } catch (e) {
    setSaveState(status, `Fehler: ${e.message}`, true);
  }
};

function renderPriorityLists() {
  DRAFT.positions.forEach(pos => {
    const arr = priorityState[pos] || [];
    const min = ['K', 'DEF'].includes(pos) ? 10 : 20;
    const count = $(`count-${pos}`);
    if (count) count.textContent = `${arr.length} / ${min}`;
    const list = document.querySelector(`[data-priority-list="${pos}"]`);
    if (!list) return;
    list.innerHTML = arr.length ? arr.map((name, index) => `
      <div class="priority-player" draggable="true" data-pos="${pos}" data-name="${esc(name)}">
        <span class="drag">⋮⋮</span><span class="priority-num">${index + 1}</span><span class="priority-name">${esc(name)}</span><span class="remove" title="Entfernen">×</span>
      </div>`).join('') : '<div class="priority-empty">Noch keine Spieler ausgewählt.</div>';
  });
  $$('.priority-player').forEach(el => {
    el.addEventListener('dragstart', () => el.classList.add('dragging'));
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); syncPriorityFromDom(el.dataset.pos); });
    el.addEventListener('click', () => removePriority(el.dataset.pos, el.dataset.name));
  });
}

function addPriority(player) {
  const pos = player.position;
  if (!DRAFT.positions.includes(pos)) return;
  const existsAnywhere = DRAFT.positions.some(p => priorityState[p].some(n => n.toLowerCase() === player.name.toLowerCase()));
  if (existsAnywhere) return;
  priorityState[pos].push(player.name);
  renderPriorityLists();
  setSaveState($('sheetSaveState'), `${player.name} hinzugefügt – Draft Sheet noch speichern.`);
}
function removePriority(pos, name) {
  priorityState[pos] = (priorityState[pos] || []).filter(n => n !== name);
  renderPriorityLists();
  setSaveState($('sheetSaveState'), `${name} entfernt – Draft Sheet noch speichern.`);
}
function syncPriorityFromDom(pos) {
  const names = [...document.querySelectorAll(`[data-priority-list="${pos}"] .priority-player`)].map(x => x.dataset.name);
  if (names.length || priorityState[pos].length === 0) priorityState[pos] = names;
  renderPriorityLists();
  setSaveState($('sheetSaveState'), 'Reihenfolge geändert – Draft Sheet noch speichern.');
}
function syncPriorityFromDomSilent(pos) {
  const names = [...document.querySelectorAll(`[data-priority-list="${pos}"] .priority-player`)].map(x => x.dataset.name);
  if (names.length || priorityState[pos].length === 0) priorityState[pos] = names;
}
function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll('.priority-player:not(.dragging)')];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    return offset < 0 && offset > closest.offset ? { offset, element: child } : closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

$('posFilter').onchange = renderAvailable;
$('availableSearch').oninput = renderAvailable;
$('availableList').onclick = e => {
  const id = e.target.closest('[data-add-id]')?.dataset.addId;
  if (!id) return;
  const p = ranked.find(x => String(x.id) === id);
  if (p) addPriority(p);
};

function renderAvailable() {
  if (!ranked.length) return;
  const pos = $('posFilter').value;
  const q = $('availableSearch').value.toLowerCase();
  const picked = pickedKeys();
  const available = ranked
    .filter(p => p.hasRanking && !picked.has(`id:${p.id}`) && !picked.has(`name:${p.name.toLowerCase()}`) && (!pos || p.position === pos) && (!q || p.name.toLowerCase().includes(q)))
    .sort((a, b) => pos
      ? (a.positionEcr ?? a.ecr ?? 99999) - (b.positionEcr ?? b.ecr ?? 99999)
      : (a.ecr ?? 99999) - (b.ecr ?? 99999));
  $('availableList').innerHTML = available
    .slice(0, 140)
    .map((p, idx) => `<div class="avail-row"><b>#${idx + 1}</b><div><b>${esc(p.name)}</b><br><small>${esc(p.nflTeam || '')}${p.bye ? ` · Bye ${p.bye}` : ''}</small></div><span class="tag">${esc(p.position)}</span><small>${pos && p.positionEcr != null ? `Pos ECR ${p.positionEcr}` : `ECR ${p.ecr ?? '—'}`}</small><button class="add-priority" data-add-id="${esc(p.id)}">+ Liste</button></div>`)
    .join('') || '<p class="empty-state">Keine verfügbaren FantasyPros-ECR-Spieler für diesen Filter.</p>';
}

function renderRoster() {
  if (!profile) return;
  const roster = orderedPicks(board.picks || {}).filter(p => board.teams?.[p.position - 1] === profile.teamId);
  $('rosterCount').textContent = `${roster.length} Pick${roster.length === 1 ? '' : 's'}`;
  $('myRoster').innerHTML = roster.length ? roster.map(p => `<div class="roster-player"><span class="roster-pos">${esc(p.position)}</span><div><strong>${esc(p.name)}</strong><br><small>R${p.round} · #${p.overall} · ${esc(p.nflTeam || '')}</small></div></div>`).join('') : '<p class="empty-state">Noch keine Spieler gedraftet.</p>';
}

function renderRankingInfo() {
  const m = rankingMeta();
  const updated = m.updatedAt ? new Date(m.updatedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) : 'unbekannt';
  $('rankingInfo').textContent = `${m.source || 'Rankings'} · ${m.format || 'PPR'} · Stand ${updated}`;
}
function pickedNames() { return new Set(Object.values(board.picks || {}).map(p => String(p.name || '').toLowerCase())); }
function pickedKeys() {
  const out = new Set();
  Object.values(board.picks || {}).forEach(p => { if (p?.playerId) out.add(`id:${p.playerId}`); if (p?.name) out.add(`name:${String(p.name).toLowerCase()}`); });
  return out;
}
function setSaveState(el, text, error = false) { el.textContent = text; el.classList.toggle('error', error); }
function friendlyError(e) { return /invalid-credential|wrong-password|user-not-found/i.test(e?.code || '') ? 'E-Mail oder Passwort ist nicht korrekt.' : (e?.message || 'Anmeldung fehlgeschlagen.'); }
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
