import { auth } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { DRAFT, teamLogo } from './config.js';
import { getUserProfile, watchBoard, watchState, watchTeam, watchSheet, setAttendance, savePreferenceSheet, requestRemotePick, ensureTeamDefaults } from './service.js';
import { loadSleeperPlayers } from './players.js';
import { loadRankings, mergeRanking, rankingMeta, rankForPlayer } from './rankings.js';
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
let draftAccessOpen = false;
let draftIsLive = false;
let availablePositionFilter = '';
let resolveDraftStateReady;
const draftStateReady = new Promise(resolve => { resolveDraftStateReady = resolve; });
let draftStateSeen = false;

watchState(s => {
  state = s || {};
  draftIsLive = !!state.boardCreated && !!state.orderSet && state.status === 'live';
  // Pre-draft access starts as soon as a new board exists (status "setup").
  // The sheet is editable in setup and becomes read-only once the draft is live.
  draftAccessOpen = !!state.boardCreated && ['setup', 'live'].includes(String(state.status || ''));
  if (!draftStateSeen) {
    draftStateSeen = true;
    resolveDraftStateReady();
  }
  updateAccessVisibility();
  if (profile) render();
});

function updateAccessVisibility() {
  const closed = $('accessClosed');
  if (!draftAccessOpen) {
    closed?.classList.remove('is-hidden');
    $('loginCard').classList.add('is-hidden');
    $('app').classList.add('is-hidden');
  } else {
    closed?.classList.add('is-hidden');
    if (!auth.currentUser) $('loginCard').classList.remove('is-hidden');
  }
}

$('loginBtn').onclick = async () => {
  if (!draftAccessOpen) return;
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
    $('loginCard').classList.toggle('is-hidden', !draftAccessOpen);
    $('app').classList.add('is-hidden');
    updateAccessVisibility();
    return;
  }
  try {
    // The login page can route here faster than the first Firestore draftState
    // snapshot arrives. Wait for it so a valid team session is not signed out
    // during that short race condition.
    await draftStateReady;
    if (!draftAccessOpen) { await signOut(auth); return; }
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
  watchTeam(profile.teamId, t => { team = t || { attendance: 'present' }; renderAttendance(); });
  watchSheet(profile.teamId, s => {
    sheet = s || {};
    hydrateSheet();
  });
}


function ownDraftSheetIdentitySet() {
  const identities = new Set();
  Object.values(priorityState || {}).flat().forEach(item => {
    const name = typeof item === 'string' ? item : item?.name;
    const id = typeof item === 'object' ? String(item?.playerId || item?.id || '').trim() : '';
    const normalized = normalizeTeamPlayerName(name);
    if (id) identities.add(`id:${id}`);
    if (normalized) identities.add(`name:${normalized}`);
  });
  return identities;
}

function normalizeTeamPlayerName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}


function render() {
  if (!profile) return;
  applyDraftMode();
  const next = getNextOpenSlot(board.picks || {});
  const onClock = draftIsLive && !!next && board.teams?.[next.position - 1] === profile.teamId;
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


function applyDraftMode() {
  const editable = !draftIsLive;

  $('sheetLockHint')?.classList.toggle('is-hidden', editable);
  $('sheetDefaultBadge').textContent = draftIsLive
    ? 'Schreibgeschützt'
    : (sheet.usesDefaultPlan === false ? 'Individuelles Sheet' : 'Default-Regeln');

  $('availableModeBadge').textContent = draftIsLive ? 'LIVE' : 'PRE-DRAFT';
  $('availableModeBadge').classList.toggle('live', draftIsLive);
  document.querySelector('.available-panel')?.classList.toggle('live-mode', draftIsLive);
  document.querySelector('.sheet-panel')?.classList.toggle('sheet-locked', draftIsLive);
  document.querySelector('.priorities-panel')?.classList.toggle('sheet-locked', draftIsLive);

  $$('[data-round]').forEach(el => { el.disabled = !editable; });
  if ($('saveSheet')) $('saveSheet').disabled = !editable;

  document.querySelectorAll('.priority-player').forEach(el => {
    el.draggable = editable;
    el.classList.toggle('locked', !editable);
  });

  const liveHint = draftIsLive
    ? 'Live-Modus: synchron zum Live Screen. Bereits gedraftete Spieler sind ausgeblendet.'
    : 'Pre-Draft: vollständige ECR-Liste. Nur Spieler aus deinem eigenen Draft Sheet werden ausgeblendet.';
  document.querySelector('.available-panel .mode-hint')?.remove();
  const controls = document.querySelector('.team-available-controls');
  if (controls) {
    const hint = document.createElement('p');
    hint.className = 'hint mode-hint';
    hint.textContent = liveHint;
    controls.insertAdjacentElement('afterend', hint);
  }
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
  applyDraftMode();
  renderAvailable();
}

$('saveSheet').onclick = async () => {
  const status = $('sheetSaveState');
  if (draftIsLive) {
    setSaveState(status, 'Draft läuft – das Draft Sheet ist schreibgeschützt.', true);
    return;
  }
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
      <div class="priority-player" draggable="${draftIsLive ? 'false' : 'true'}" data-pos="${pos}" data-name="${esc(name)}">
        <span class="drag">⋮⋮</span><span class="priority-num">${index + 1}</span><span class="priority-name">${esc(name)}</span><span class="remove" title="Entfernen">×</span>
      </div>`).join('') : '<div class="priority-empty">Noch keine Spieler ausgewählt.</div>';
  });
  $$('.priority-player').forEach(el => {
    el.classList.toggle('locked', draftIsLive);
    el.addEventListener('dragstart', e => {
      if (draftIsLive) { e.preventDefault(); return; }
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      if (!draftIsLive) syncPriorityFromDom(el.dataset.pos);
    });
    el.addEventListener('click', () => {
      if (!draftIsLive) removePriority(el.dataset.pos, el.dataset.name);
    });
  });
}

function addPriority(player) {
  if (draftIsLive) return;
  const pos = player.position;
  if (!DRAFT.positions.includes(pos)) return;
  const existsAnywhere = DRAFT.positions.some(p => priorityState[p].some(n => n.toLowerCase() === player.name.toLowerCase()));
  if (existsAnywhere) return;
  priorityState[pos].push(player.name);
  renderPriorityLists();
  renderAvailable();
  setSaveState($('sheetSaveState'), `${player.name} hinzugefügt – Draft Sheet noch speichern.`);
}
function removePriority(pos, name) {
  if (draftIsLive) return;
  priorityState[pos] = (priorityState[pos] || []).filter(n => n !== name);
  renderPriorityLists();
  renderAvailable();
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

$('posTabs').onclick = e => {
  const btn = e.target.closest('[data-pos]');
  if (!btn) return;
  availablePositionFilter = String(btn.dataset.pos || '').toUpperCase();
  $$('#posTabs [data-pos]').forEach(b => b.classList.toggle('active', b === btn));
  renderAvailable();
};
$('availableSearch').oninput = renderAvailable;
$('availableList').onclick = e => {
  if (draftIsLive) return;
  const id = e.target.closest('[data-add-id]')?.dataset.addId;
  if (!id) return;
  const p = ranked.find(x => String(x.id) === id);
  if (p) addPriority(p);
};


function isDefensePosition(position) {
  return ['DEF','DST','D/ST','DEFENSE'].includes(String(position || '').toUpperCase());
}

function canonicalNflTeam(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  const aliases = {
    ARI:'ARI','ARIZONA CARDINALS':'ARI',ATL:'ATL','ATLANTA FALCONS':'ATL',
    BAL:'BAL','BALTIMORE RAVENS':'BAL',BUF:'BUF','BUFFALO BILLS':'BUF',
    CAR:'CAR','CAROLINA PANTHERS':'CAR',CHI:'CHI','CHICAGO BEARS':'CHI',
    CIN:'CIN','CINCINNATI BENGALS':'CIN',CLE:'CLE','CLEVELAND BROWNS':'CLE',
    DAL:'DAL','DALLAS COWBOYS':'DAL',DEN:'DEN','DENVER BRONCOS':'DEN',
    DET:'DET','DETROIT LIONS':'DET',GB:'GB','GREEN BAY PACKERS':'GB',
    HOU:'HOU','HOUSTON TEXANS':'HOU','HOUSTON TEXANS DEFENSE':'HOU','HOU DEFENSE':'HOU',
    IND:'IND','INDIANAPOLIS COLTS':'IND',JAX:'JAX',JAC:'JAX','JACKSONVILLE JAGUARS':'JAX',
    KC:'KC','KANSAS CITY CHIEFS':'KC',LAC:'LAC','LOS ANGELES CHARGERS':'LAC',
    LAR:'LAR','LOS ANGELES RAMS':'LAR',LV:'LV','LAS VEGAS RAIDERS':'LV',
    MIA:'MIA','MIAMI DOLPHINS':'MIA',MIN:'MIN','MINNESOTA VIKINGS':'MIN',
    NE:'NE','NEW ENGLAND PATRIOTS':'NE',NO:'NO','NEW ORLEANS SAINTS':'NO',
    NYG:'NYG','NEW YORK GIANTS':'NYG',NYJ:'NYJ','NEW YORK JETS':'NYJ',
    PHI:'PHI','PHILADELPHIA EAGLES':'PHI',PIT:'PIT','PITTSBURGH STEELERS':'PIT',
    SEA:'SEA','SEATTLE SEAHAWKS':'SEA',SF:'SF','SAN FRANCISCO 49ERS':'SF','SAN FRANCISCO FORTY NINERS':'SF',
    TB:'TB','TAMPA BAY BUCCANEERS':'TB',TEN:'TEN','TENNESSEE TITANS':'TEN',
    WAS:'WAS',WSH:'WAS','WASHINGTON COMMANDERS':'WAS'
  };
  const cleaned = upper
    .replace(/\s+D\/ST$/,'')
    .replace(/\s+DST$/,'')
    .replace(/\s+DEFENSE$/,'')
    .replace(/\s+DEF$/,'')
    .trim();
  return aliases[upper] || aliases[cleaned] || cleaned;
}

function teamPlayerIdentityKey(player) {
  if (!player) return '';
  if (isDefensePosition(player.position)) {
    const teamCode = canonicalNflTeam(player.nflTeam || player.team || player.name);
    return teamCode ? `DEF:${teamCode}` : '';
  }
  const name = normalizeTeamPlayerName(player.name);
  const pos = String(player.position || '').toUpperCase();
  const teamCode = canonicalNflTeam(player.nflTeam || player.team || '');
  return name ? `${name}|${pos}|${teamCode}` : '';
}

function livePickedSets() {
  const picks = Object.values(board.picks || {});
  return {
    ids: new Set(picks.map(p => String(p.playerId || p.id || p.sleeperId || '').trim()).filter(Boolean)),
    names: new Set(picks.map(p => normalizeTeamPlayerName(p.name)).filter(Boolean)),
    keys: new Set(picks.map(p => teamPlayerIdentityKey(p)).filter(Boolean)),
    defenses: new Set(
      picks
        .filter(p => isDefensePosition(p.position))
        .map(p => canonicalNflTeam(p.nflTeam || p.team || p.name))
        .filter(Boolean)
    )
  };
}

function isAlreadyDraftedLive(player, picked) {
  const id = String(player.id || player.playerId || player.sleeperId || '').trim();
  const name = normalizeTeamPlayerName(player.name);
  const key = teamPlayerIdentityKey(player);

  if (id && picked.ids.has(id)) return true;
  if (name && picked.names.has(name)) return true;
  if (key && picked.keys.has(key)) return true;

  if (isDefensePosition(player.position)) {
    const defenseTeam = canonicalNflTeam(player.team || player.nflTeam || player.name);
    if (defenseTeam && picked.defenses.has(defenseTeam)) return true;
  }
  return false;
}

function renderAvailable() {
  if (!ranked.length) return;

  const pos = availablePositionFilter;
  const q = $('availableSearch').value.toLowerCase().trim();
  const ownSheet = ownDraftSheetIdentitySet();
  const picked = livePickedSets();

  const available = ranked
    .filter(p => {
      const playerPos = isDefensePosition(p.position) ? 'DEF' : String(p.position || '').toUpperCase();
      if (!DRAFT.positions.includes(playerPos)) return false;
      if (!p.hasRanking) return false;
      if (pos && playerPos !== pos) return false;
      if (q && !String(p.name || '').toLowerCase().includes(q)) return false;

      if (draftIsLive) {
        // Live mode mirrors the Live Screen: only drafted players are removed.
        return !isAlreadyDraftedLive(p, picked);
      }

      // Pre-draft mode: nobody is removed because of the global board.
      // Only this team's own Draft Sheet/priorities are hidden.
      const playerId = String(p.id || p.playerId || '').trim();
      const normalizedName = normalizeTeamPlayerName(p.name);
      if (playerId && ownSheet.has(`id:${playerId}`)) return false;
      if (normalizedName && ownSheet.has(`name:${normalizedName}`)) return false;
      return true;
    })
    // Keep the same overall ECR order as the Live Screen. Position tabs only filter that order.
    .sort((a, b) =>
      (a.overallEcr ?? a.ecr ?? a.sortRank ?? 999999) -
      (b.overallEcr ?? b.ecr ?? b.sortRank ?? 999999)
    );

  $('availableList').innerHTML = available
    .map((p, idx) => {
      const playerPos = isDefensePosition(p.position) ? 'DEF' : p.position;
      const addButton = draftIsLive
        ? ''
        : `<button class="add-priority" data-add-id="${esc(p.id)}">+ Liste</button>`;
      return `<div class="avail-row ${draftIsLive ? 'live-row' : ''}">
        <b>#${idx + 1}</b>
        <div><b>${esc(p.name)}</b><br><small>${esc(p.nflTeam || p.team || '')}${p.bye ? ` · Bye ${p.bye}` : ''}</small></div>
        <span class="tag">${esc(playerPos)}</span>
        <small>ECR ${p.overallEcr ?? p.ecr ?? '—'}</small>
        ${addButton}
      </div>`;
    })
    .join('') || '<p class="empty-state">Keine Spieler für diesen Filter verfügbar.</p>';
}

function rosterRawPick(pick) {
  return pick?.key ? (board.picks?.[pick.key] || {}) : {};
}

function rosterPlayerPosition(pick) {
  const raw = rosterRawPick(pick);
  const rawId = String(raw.playerId || raw.id || pick?.playerId || pick?.id || '').trim();
  const sleeper = players.find(x =>
    (rawId && String(x.id || x.playerId || '') === rawId) ||
    normalizeTeamPlayerName(x.name) === normalizeTeamPlayerName(pick?.name)
  );
  const ranking = rankForPlayer({
    name: pick?.name,
    nflTeam: raw.nflTeam || pick?.nflTeam,
    position: raw.position || raw.pos
  });
  let pos = String(sleeper?.position || ranking?.position || raw.position || raw.pos || '').toUpperCase().trim();
  if (/^\d+$/.test(pos)) pos = '';
  if (pos === 'DST' || pos === 'D/ST' || pos === 'DEFENSE') pos = 'DEF';
  if (pos === 'PK') pos = 'K';
  return pos;
}

function renderRoster() {
  if (!profile) return;
  const roster = orderedPicks(board.picks || {}).filter(p => board.teams?.[p.position - 1] === profile.teamId);
  $('rosterCount').textContent = `${roster.length} Pick${roster.length === 1 ? '' : 's'}`;

  if (!roster.length) {
    $('myRoster').classList.remove('roster-grouped');
    $('myRoster').innerHTML = '<p class="empty-state">Noch keine Spieler gedraftet.</p>';
    return;
  }

  const groups = { QB:[], RB:[], WR:[], TE:[], K:[], DEF:[] };
  roster.forEach(p => {
    const playerPosRaw = rosterPlayerPosition(p);
    const playerPos = ['DST','D/ST','DEFENSE'].includes(playerPosRaw) ? 'DEF' : playerPosRaw;
    if (!groups[playerPos]) groups[playerPos] = [];
    groups[playerPos].push(p);
  });

  const positionOrder = ['QB','RB','WR','TE','K','DEF'];
  const otherPositions = Object.keys(groups).filter(pos => !positionOrder.includes(pos) && groups[pos].length);
  const orderedPositions = [...positionOrder, ...otherPositions];

  $('myRoster').classList.add('roster-grouped');
  $('myRoster').innerHTML = orderedPositions
    .filter(pos => groups[pos]?.length)
    .map(pos => {
      const cards = groups[pos].map(p => {
        const raw = rosterRawPick(p);
        const playerPosition = rosterPlayerPosition(p);
        const ranking = rankForPlayer({
          name: p.name,
          nflTeam: p.nflTeam || raw.nflTeam,
          position: playerPosition
        });
        const rankedPlayer = ranked.find(x =>
          (p.playerId && String(x.id) === String(p.playerId)) ||
          x.name?.toLowerCase() === String(p.name || '').toLowerCase()
        );
        const bye = raw.bye ?? p.bye ?? ranking?.bye ?? rankedPlayer?.bye ?? '';
        return `<div class="roster-player">
          <span class="roster-pos">${esc(playerPosition || pos || '—')}</span>
          <div class="roster-player-copy">
            <strong>${esc(p.name)}</strong>
            <small>R${p.round} · #${p.overall} · ${esc(p.nflTeam || raw.nflTeam || '')} · Bye ${esc(bye || '—')}</small>
          </div>
        </div>`;
      }).join('');

      return `<section class="roster-position-group">
        <div class="roster-position-heading"><strong>${esc(pos)}</strong><span>${groups[pos].length}</span></div>
        <div class="roster-position-players">${cards}</div>
      </section>`;
    }).join('');
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
