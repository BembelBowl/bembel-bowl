import { auth } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { DRAFT, LEAGUE_TEAMS, teamLogo } from './config.js';
import {
  getUserProfile, watchBoard, watchState, watchTeam, watchSheet, watchDraftOrder, watchDivisions,
  reconcileDraftState, ensureDraftInfrastructure, setAttendance, createNewDraft, saveDraftOrder,
  prepareDraftOrderDraw, setDraftOrderRevealCount, prepareDivisionDraw, setDivisionRevealCount, saveDivisions,
  adminSetPick, adminDeletePick, finalizeDraft
} from './service.js';
import { loadRankings } from './rankings.js';
import { loadSleeperPlayers } from './players.js';
import { getNextOpenSlot, orderedPicks, pickNumber } from './model.js';
import { DraftAdminEngine } from './autopick.js';

const $ = id => document.getElementById(id);
let board = { teams: [], picks: {} };
let state = {};
let draftOrderState = {};
let divisionState = {};
let teams = new Map();
let sheets = new Map();
let players = [];
let engine = null;
let startedUid = null;
let editSlot = null;
let rankingsReady = false;

$('loginBtn').onclick = async () => {
  $('err').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch (e) { $('err').textContent = /invalid-credential/i.test(e?.code || '') ? 'E-Mail oder Passwort ist nicht korrekt.' : e.message; }
};
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  if (!user) {
    engine?.stop(); engine = null; startedUid = null;
    $('loginCard').classList.remove('is-hidden'); $('app').classList.add('is-hidden');
    return;
  }
  try {
    const p = await getUserProfile(user.uid);
    if (p?.role !== 'admin') { $('err').textContent = 'Dieses Konto ist nicht als Admin hinterlegt.'; await signOut(auth); return; }
    $('loginCard').classList.add('is-hidden'); $('app').classList.remove('is-hidden');
    if (startedUid === user.uid) return;
    startedUid = user.uid;
    await ensureDraftInfrastructure();
    $('infraStatus').textContent = 'Admin-Infrastruktur bereit.';
    try { await loadRankings(); rankingsReady = true; } catch (e) { $('infraStatus').textContent = `Admin aktiv · FantasyPros ECR nicht verfügbar: ${e.message}`; }
    try { players = await loadSleeperPlayers(); } catch (e) { console.error(e); }

    LEAGUE_TEAMS.forEach(id => {
      watchTeam(id, t => { teams.set(id, t || { attendance: 'present' }); renderTeams(); });
      watchSheet(id, s => sheets.set(id, s || {}));
    });
    watchDraftOrder(d => { draftOrderState = d; renderOrder(); });
    watchDivisions(d => { divisionState = d; renderDivisions(); });
    watchBoard(async b => { board = b; await reconcileDraftState(b).catch(console.error); render(); });
    watchState(s => { state = s; render(); });

    engine = new DraftAdminEngine({
      ownerId: user.uid,
      getBoard: () => board, getState: () => state,
      getTeam: id => teams.get(id), getSheet: id => sheets.get(id), rankingsReady: () => rankingsReady,
      onCountdown: c => { $('auto').textContent = c?.error ? c.error : (c ? `Autopick #${c.overall} in ${formatCountdown(c.ms)}` : 'Kein automatischer Pick aktiv.'); }
    });
    const ok = await engine.start();
    $('adminStatus').textContent = ok ? 'ADMIN AKTIV' : 'ADMIN STANDBY';
  } catch (e) {
    $('err').textContent = `Admin konnte nicht gestartet werden: ${e.message}`;
    $('loginCard').classList.remove('is-hidden'); $('app').classList.add('is-hidden');
  }
});

$('createDraftBtn').onclick = async () => {
  const year = Number($('seasonInput').value);
  if (!confirm(`Neues leeres Draft Board für ${year} erzeugen? Das aktuelle Live-Board wird überschrieben.`)) return;
  try { await createNewDraft(year); } catch (e) { alert(e.message); }
};

$('finalizeDraftBtn').onclick = async () => {
  const next = getNextOpenSlot(board.picks || {});
  if (next) return alert(`Der Draft ist noch nicht vollständig. Nächster offener Pick: #${next.overall}.`);
  if (!confirm(`Draft ${state.season || ''} abschließen und dauerhaft archivieren?`)) return;
  try { const year = await finalizeDraft(); alert(`Draft ${year} wurde archiviert.`); }
  catch (e) { alert(`Abschluss fehlgeschlagen: ${e.message}`); }
};

$('prepareOrderDrawBtn').onclick = async () => {
  if (!state.boardCreated) return alert('Zuerst ein neues Draft Board erzeugen.');
  if (!confirm('Neue Draft-Reihenfolge auslosen?')) return;
  const shuffled = shuffle(LEAGUE_TEAMS);
  const seq = shuffled.map((team, i) => ({ place: LEAGUE_TEAMS.length - i, team }));
  try { await prepareDraftOrderDraw(seq, state.season); } catch (e) { alert(e.message); }
};

$('revealOrderBtn').onclick = async () => {
  const seq = draftOrderState.revealSequence || [];
  if (!seq.length) return alert('Zuerst eine Auslosung vorbereiten.');
  const count = Math.min(seq.length, Number(draftOrderState.revealedCount || 0) + 1);
  await setDraftOrderRevealCount(count);
  if (count === seq.length) {
    const order = [...seq].sort((a,b) => a.place - b.place).map(x => x.team);
    await saveDraftOrder(order, state.season);
  }
};

$('saveOrderBtn').onclick = async () => {
  const order = [...document.querySelectorAll('[data-order-slot]')].map(el => el.value);
  try { await saveDraftOrder(order, state.season); }
  catch (e) { alert(`Reihenfolge konnte nicht gespeichert werden: ${e.message}`); }
};

$('prepareDivisionDrawBtn').onclick = async () => {
  if (!state.boardCreated) return alert('Zuerst ein neues Draft Board erzeugen.');
  if (!confirm('Neue Divisionen auslosen?')) return;
  const shuffled = shuffle(LEAGUE_TEAMS);
  const letters = ['A','B','C','D'];
  const seq = shuffled.map((team, i) => ({ division: letters[i % 4], slot: Math.floor(i / 4) + 1, team }));
  try { await prepareDivisionDraw(seq, state.season); } catch (e) { alert(e.message); }
};

$('revealDivisionBtn').onclick = async () => {
  const seq = divisionState.revealSequence || [];
  if (!seq.length) return alert('Zuerst eine Auslosung vorbereiten.');
  const count = Math.min(seq.length, Number(divisionState.revealedCount || 0) + 1);
  await setDivisionRevealCount(count);
  if (count === seq.length) {
    const divisions = { A:[], B:[], C:[], D:[] };
    seq.forEach(x => { divisions[x.division][x.slot - 1] = x.team; });
    await saveDivisions(divisions, state.season);
  }
};

function render() {
  const created = !!state.boardCreated;
  const live = created && state.orderSet && state.status === 'live';
  const next = getNextOpenSlot(board.picks || {});
  const pickCount = Object.keys(board.picks || {}).length;
  $('lifecycleBadge').textContent = !created ? 'KEIN AKTIVER DRAFT' : state.status === 'setup' ? 'SETUP' : state.status === 'live' ? 'LIVE' : 'ABGESCHLOSSEN';
  $('lifecycleInfo').textContent = created
    ? `Saison ${state.season} · ${state.orderSet ? 'Reihenfolge festgelegt' : 'Reihenfolge noch offen'} · ${pickCount}/${DRAFT.teamCount * DRAFT.roundCount} Picks`
    : `Letzter abgeschlossener Draft: ${state.lastCompletedSeason || DRAFT.season}`;
  $('seasonInput').value = created ? (state.season || DRAFT.season) : ((state.lastCompletedSeason || DRAFT.season) + 1);
  $('finalizeDraftBtn').disabled = !created || !!next || pickCount === 0;
  $('current').textContent = live && next ? `${board.teams?.[next.position - 1] || '—'} · R${next.round} · #${next.overall}` : state.status === 'complete' ? 'Draft vollständig' : 'Noch nicht live';
  renderOrder(); renderDivisions(); renderAdminBoard(); renderTeams();
}

function renderOrder() {
  if (!$('orderEditor')) return;
  const currentOrder = (board.teams || []).filter(Boolean).length === DRAFT.teamCount ? board.teams : (draftOrderState.order || []);
  $('orderEditor').innerHTML = Array.from({ length: DRAFT.teamCount }, (_, i) => {
    const selected = currentOrder[i] || '';
    return `<label><span>${i + 1}.</span><select data-order-slot="${i + 1}"><option value="">Team wählen</option>${LEAGUE_TEAMS.map(t => `<option value="${esc(t)}" ${t === selected ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
  }).join('');
  const seq = draftOrderState.revealSequence || [];
  const count = Number(draftOrderState.revealedCount || 0);
  const last = count ? seq[count - 1] : null;
  $('orderDrawStatus').textContent = seq.length ? `${count}/${seq.length} aufgedeckt${last ? ` · zuletzt: Platz ${last.place} – ${last.team}` : ''}` : 'Keine laufende Auslosung.';
  $('revealOrderBtn').disabled = !seq.length || count >= seq.length;
}

function renderDivisions() {
  if (!$('divisionPreview')) return;
  const complete = divisionState.divisions;
  const seq = divisionState.revealSequence || [];
  const count = Number(divisionState.revealedCount || 0);
  const preview = { A:[], B:[], C:[], D:[] };
  if (complete) Object.assign(preview, complete);
  else seq.slice(0, count).forEach(x => { preview[x.division][x.slot - 1] = x.team; });
  $('divisionPreview').innerHTML = ['A','B','C','D'].map(l => `<div><strong>Division ${l}</strong>${Array.from({length:5},(_,i)=>`<span>${esc(preview[l]?.[i] || '—')}</span>`).join('')}</div>`).join('');
  const last = count ? seq[count - 1] : null;
  $('divisionDrawStatus').textContent = seq.length ? `${count}/${seq.length} aufgedeckt${last ? ` · zuletzt: ${last.division}${last.slot} – ${last.team}` : ''}` : (complete ? 'Divisionen gespeichert.' : 'Keine laufende Auslosung.');
  $('revealDivisionBtn').disabled = !seq.length || count >= seq.length;
}

let adminSelectedRound = 1;

function renderAdminBoard() {
  const list = $('adminBoard');
  const tabs = $('adminRoundTabs');
  if (!list || !tabs) return;

  adminSelectedRound = Math.max(1, Math.min(DRAFT.roundCount, Number(adminSelectedRound || 1)));
  const teamsOrder = board.teams || [];

  tabs.innerHTML = Array.from({ length:DRAFT.roundCount }, (_, i) => {
    const round = i + 1;
    const hasPicks = Array.from({length:DRAFT.teamCount}, (_, p) => board.picks?.[`${round}-${p+1}`]).some(Boolean);
    return `<button type="button" class="admin-round-tab ${round === adminSelectedRound ? 'active' : ''} ${hasPicks ? 'has-picks' : ''}" data-admin-round-tab="${round}">R${round}</button>`;
  }).join('');

  list.innerHTML = Array.from({ length:DRAFT.teamCount }, (_, idx) => {
    const position = idx + 1;
    const round = adminSelectedRound;
    const key = `${round}-${position}`;
    const pick = board.picks?.[key];
    const team = teamsOrder[position - 1] || '—';
    const overall = pickNumber(round, position);
    const duration = pick ? formatPickDuration(pick.pickDurationSeconds ?? pick.durationSeconds ?? null) : '';
    const playerHtml = pick
      ? `<div class="admin-round-player"><strong>${esc(pick.name)}</strong><span>Spieler</span></div><div class="admin-round-meta">${esc(pick.position || '')}${pick.nflTeam ? ` · ${esc(pick.nflTeam)}` : ''}${duration ? ` · Dauer ${duration}` : ' · Dauer —'}</div>`
      : `<div class="admin-round-player"><strong class="admin-round-empty">+ Spieler eintragen</strong><span>Noch kein Pick</span></div><div class="admin-round-meta"></div>`;

    return `<button type="button" class="admin-round-pick ${pick ? 'filled' : ''}" data-round="${round}" data-pos="${position}" ${!state.orderSet ? 'disabled' : ''}>
      <div class="admin-round-pick-number">#${overall}</div>
      <div class="admin-round-team"><strong>${esc(team)}</strong><span>Draft Position ${position}</span></div>
      ${playerHtml}
    </button>`;
  }).join('');
}

$('adminRoundTabs')?.addEventListener('click', e => {
  const btn = e.target.closest('[data-admin-round-tab]');
  if (!btn) return;
  adminSelectedRound = Number(btn.dataset.adminRoundTab) || 1;
  renderAdminBoard();
});

$('adminBoard').onclick = e => {
  const btn = e.target.closest('[data-round][data-pos]'); if (!btn) return;
  editSlot = { round:Number(btn.dataset.round), position:Number(btn.dataset.pos) };
  const pick = board.picks?.[`${editSlot.round}-${editSlot.position}`];
  $('pickModalTitle').textContent = `Runde ${editSlot.round} · Pick #${pickNumber(editSlot.round, editSlot.position)}`;
  $('pickModalCurrent').textContent = pick ? `Aktuell: ${pick.name} · ${pick.position} ${pick.nflTeam || ''}` : 'Noch kein Spieler eingetragen.';
  $('deleteAdminPickBtn').style.display = pick ? 'inline-flex' : 'none';
  $('adminPlayerSearch').value=''; $('adminPlayerResults').innerHTML='';
  $('adminPickModal').classList.remove('is-hidden'); setTimeout(()=>$('adminPlayerSearch').focus(),50);
};
$('pickModalClose').onclick = () => $('adminPickModal').classList.add('is-hidden');
$('adminPickModal').onclick = e => { if (e.target === $('adminPickModal')) $('adminPickModal').classList.add('is-hidden'); };
$('adminPlayerSearch').oninput = () => {
  const q=$('adminPlayerSearch').value.trim().toLowerCase();
  if (q.length<2) return $('adminPlayerResults').innerHTML='';
  const pickedNames=new Set(Object.values(board.picks||{}).map(p=>String(p.name||'').toLowerCase()));
  $('adminPlayerResults').innerHTML = players.filter(p=>p.search?.includes(q) || p.name.toLowerCase().includes(q)).slice(0,20).map(p=>`<div class="result"><span class="tag">${esc(p.position)}</span><div><b>${esc(p.name)}</b><br><small>${esc(p.nflTeam||'')}</small></div><button data-admin-player="${esc(p.id)}" ${pickedNames.has(p.name.toLowerCase()) ? 'disabled' : ''}>Eintragen</button></div>`).join('');
};
$('adminPlayerResults').onclick = async e => {
  const id=e.target.dataset.adminPlayer; if(!id||!editSlot) return;
  const p=players.find(x=>String(x.id)===id); if(!p) return;
  try { await adminSetPick({ ...editSlot, player:{id:p.id,name:p.name,position:p.position,nflTeam:p.nflTeam}, actorUid:auth.currentUser.uid }); $('adminPickModal').classList.add('is-hidden'); }
  catch(err){ alert(err.message); }
};
$('deleteAdminPickBtn').onclick = async () => {
  if(!editSlot||!confirm('Diesen Pick wirklich löschen?')) return;
  try { await adminDeletePick(editSlot.round, editSlot.position); $('adminPickModal').classList.add('is-hidden'); }
  catch(e){ alert(e.message); }
};

function renderTeams() {
  if (!$('teams')) return;
  $('teams').innerHTML = LEAGUE_TEAMS.map(id => `<div class="admin-team-row"><span class="admin-team-name"><img src="${teamLogo(id)}" alt=""><strong>${esc(id)}</strong></span><select data-team-status="${esc(id)}"><option value="present" ${(teams.get(id)?.attendance||'present')==='present'?'selected':''}>Vor Ort</option><option value="remote" ${teams.get(id)?.attendance==='remote'?'selected':''}>Video / Remote</option><option value="absent" ${teams.get(id)?.attendance==='absent'?'selected':''}>Abwesend</option></select></div>`).join('');
}
$('teams').addEventListener('change', async e => { const id=e.target.dataset.teamStatus;if(!id)return;e.target.disabled=true;try{await setAttendance(id,e.target.value);}catch(err){alert(err.message);}finally{e.target.disabled=false;} });

function shuffle(arr){const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function formatCountdown(ms){const s=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
function formatPickDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '';
  const total = Math.round(value);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
