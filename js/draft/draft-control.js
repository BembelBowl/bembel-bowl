import { auth } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { collection, query, where, getDocs, doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { db } from './firebase.js';
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
$('logoutBtn').onclick = async () => { await signOut(auth); location.replace('login.html'); };

onAuthStateChanged(auth, async user => {
  if (!user) {
    engine?.stop(); engine = null; startedUid = null;
    location.replace('login.html');
    return;
  }
  try {
    const p = await getUserProfile(user.uid);
    if (p?.role !== 'admin') { location.replace(p?.role === 'team' ? 'team-dashboard.html' : 'login.html'); return; }
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

function renderAdminBoard() {
  const table = $('adminBoard'); if (!table) return;
  const teamsOrder = board.teams || [];
  let html = '<thead><tr><th>R</th>' + Array.from({length:DRAFT.teamCount},(_,i)=>`<th>${i+1}<small>${esc(teamsOrder[i] || '—')}</small></th>`).join('') + '</tr></thead><tbody>';
  for (let r=1;r<=DRAFT.roundCount;r++) {
    html += `<tr><th>R${r}</th>`;
    for (let p=1;p<=DRAFT.teamCount;p++) {
      const key=`${r}-${p}`, pick=board.picks?.[key];
      html += `<td><button class="admin-pick-cell ${pick ? 'filled' : ''}" data-round="${r}" data-pos="${p}" ${!state.orderSet ? 'disabled' : ''}><small>#${pickNumber(r,p)}</small>${pick ? `<b>${esc(pick.name)}</b><span>${esc(pick.position || '')} ${esc(pick.nflTeam || '')}</span>` : '<b>+</b>'}</button></td>`;
    }
    html += '</tr>';
  }
  table.innerHTML = html + '</tbody>';
}

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


// Reports admin is centralized here; public reports.html remains view-only.
const reportCollection = collection(db, 'matchReports');
$('loadReportsBtn').onclick = loadAdminReports;
$('saveReportBtn').onclick = saveAdminReport;
$('deleteReportBtn').onclick = deleteAdminReport;

async function loadAdminReports() {
  const season = Number($('reportSeason').value);
  const week = Number($('reportWeek').value);
  $('reportAdminStatus').textContent = 'Lädt…';
  try {
    const snap = await getDocs(reportCollection);
    const docs = snap.docs.map(d=>({id:d.id,...d.data()})).filter(x => { const y=Number(x.season || String(x.id).match(/^(\d{4})/)?.[1]); const w=Number(x.week || String(x.id).match(/-w(\d+)/)?.[1]); return y===season && (w===week || !!x.type); });
    $('reportList').innerHTML = docs.length ? docs.map(x=>`<button class="report-admin-item" data-report-id="${esc(x.id)}"><span><strong>${esc(x.title || x.id)}</strong><br><small>${esc(x.homeTeam || '')}${x.awayTeam ? ` vs ${esc(x.awayTeam)}` : ''}</small></span><span>Bearbeiten</span></button>`).join('') : '<p class="status-copy">Keine Reports gefunden.</p>';
    $('reportAdminStatus').textContent = `${docs.length} Einträge geladen.`;
  } catch(e) { $('reportAdminStatus').textContent = `Fehler: ${e.message}`; }
}
$('reportList').onclick = async e => {
  const id=e.target.closest('[data-report-id]')?.dataset.reportId; if(!id)return;
  try { const s=await getDoc(doc(db,'matchReports',id)); if(!s.exists()) return; fillReportEditor(id,s.data()); }
  catch(err){ $('reportAdminStatus').textContent=`Fehler: ${err.message}`; }
};
function fillReportEditor(id,d={}){
  $('reportDocId').value=id; $('reportSeason').value=d.season || Number(String(id).match(/^(\d{4})/)?.[1]) || 2026; $('reportWeek').value=d.week || Number(String(id).match(/-w(\d+)/)?.[1]) || 1;
  $('reportHome').value=d.homeTeam||''; $('reportAway').value=d.awayTeam||''; $('reportHomeScore').value=d.homeScore??''; $('reportAwayScore').value=d.awayScore??''; $('reportType').value=d.type||''; $('reportTitle').value=d.title||''; $('reportText').value=d.text||'';
  $('reportHomeBox').value=JSON.stringify(d.homeBoxScore||[],null,2); $('reportAwayBox').value=JSON.stringify(d.awayBoxScore||[],null,2);
}
async function saveAdminReport(){
  const id=$('reportDocId').value.trim(); if(!id) return $('reportAdminStatus').textContent='Dokument-ID fehlt.';
  try{
    const payload={season:Number($('reportSeason').value),week:Number($('reportWeek').value),homeTeam:$('reportHome').value.trim(),awayTeam:$('reportAway').value.trim(),homeScore:Number($('reportHomeScore').value)||0,awayScore:Number($('reportAwayScore').value)||0,text:$('reportText').value,type:$('reportType').value.trim()||null,title:$('reportTitle').value.trim()||null,homeBoxScore:JSON.parse($('reportHomeBox').value||'[]'),awayBoxScore:JSON.parse($('reportAwayBox').value||'[]'),updatedAt:serverTimestamp()};
    await setDoc(doc(db,'matchReports',id),payload,{merge:true}); $('reportAdminStatus').textContent='✓ Report gespeichert.'; await loadAdminReports();
  }catch(e){$('reportAdminStatus').textContent=`Fehler: ${e.message}`;}
}
async function deleteAdminReport(){const id=$('reportDocId').value.trim();if(!id||!confirm(`Report ${id} wirklich löschen?`))return;try{await deleteDoc(doc(db,'matchReports',id));fillReportEditor('',{});$('reportAdminStatus').textContent='Report gelöscht.';await loadAdminReports();}catch(e){$('reportAdminStatus').textContent=`Fehler: ${e.message}`;}}

function shuffle(arr){const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function formatCountdown(ms){const s=Math.max(0,Math.ceil(ms/1000));return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
