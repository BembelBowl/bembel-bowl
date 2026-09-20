import { auth } from './firebase.js';
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import { getUserProfile, watchBoard, watchState, watchTeam, watchSheet, reconcileDraftState, ensureDraftInfrastructure, setAttendance } from './service.js';
import { loadRankings } from './rankings.js';
import { getNextOpenSlot } from './model.js';
import { DraftAdminEngine } from './autopick.js';

const $ = id => document.getElementById(id);
let board = { teams: [], picks: {} };
let state = {};
let teams = new Map();
let sheets = new Map();
let engine = null;
let bound = new Set();
let startedUid = null;

$('loginBtn').onclick = async () => {
  $('err').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch (e) { $('err').textContent = /invalid-credential/i.test(e?.code || '') ? 'E-Mail oder Passwort ist nicht korrekt.' : e.message; }
};
$('password').addEventListener('keydown', e => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = () => signOut(auth);

onAuthStateChanged(auth, async user => {
  if (!user) {
    engine?.stop();
    engine = null;
    startedUid = null;
    $('loginCard').classList.remove('is-hidden');
    $('app').classList.add('is-hidden');
    return;
  }
  try {
    const p = await getUserProfile(user.uid);
    if (p?.role !== 'admin') {
      $('err').textContent = 'Dieses Konto ist nicht als Admin hinterlegt.';
      await signOut(auth);
      return;
    }
    $('loginCard').classList.add('is-hidden');
    $('app').classList.remove('is-hidden');
    if (startedUid === user.uid) return;
    startedUid = user.uid;

    $('infraStatus').textContent = 'Initialisiere Draft-Infrastruktur…';
    await ensureDraftInfrastructure();
    $('infraStatus').textContent = '✓ draftState/current und pickRequests/_meta sind bereit.';
    let rankingsReady = false;
    try {
      await loadRankings();
      rankingsReady = true;
    } catch (rankingError) {
      console.error(rankingError);
      $('infraStatus').textContent = `Admin aktiv. FantasyPros ECR noch nicht verfügbar: ${rankingError.message}`;
      $('infraStatus').classList.add('error');
    }

    watchBoard(async b => {
      board = b;
      await reconcileDraftState(b).catch(console.error);
      bindTeams();
      render();
    });
    watchState(s => { state = s; render(); });

    engine = new DraftAdminEngine({
      ownerId: user.uid,
      getBoard: () => board,
      getState: () => state,
      getTeam: id => teams.get(id),
      getSheet: id => sheets.get(id),
      rankingsReady: () => rankingsReady,
      onCountdown: c => {
        $('auto').textContent = c?.error ? c.error : (c ? `Abwesendes Team: automatischer Pick #${c.overall} in ${formatCountdown(c.ms)}` : 'Kein automatischer Pick aktiv.');
      }
    });
    const ok = await engine.start();
    $('adminStatus').textContent = ok ? 'ADMIN AKTIV' : 'ADMIN STANDBY';
    if (!ok) $('infraStatus').textContent = 'Ein anderer Admin-Tab verarbeitet die Draft-Automatik bereits. Dieser Tab bleibt als Anzeige geöffnet.';
  } catch (e) {
    $('err').textContent = `Admin konnte nicht gestartet werden: ${e.message}`;
    $('loginCard').classList.remove('is-hidden');
    $('app').classList.add('is-hidden');
  }
});

function bindTeams() {
  for (const id of board.teams || []) {
    if (!id || bound.has(id)) continue;
    bound.add(id);
    watchTeam(id, t => { teams.set(id, t || { attendance: 'present' }); renderTeams(); });
    watchSheet(id, s => sheets.set(id, s || {}));
  }
  renderTeams();
}

function render() {
  const n = getNextOpenSlot(board.picks || {});
  $('current').textContent = n ? `${board.teams?.[n.position - 1] || '—'} · Runde ${n.round} · Pick #${n.overall}` : 'Draft beendet';
}

function renderTeams() {
  $('teams').innerHTML = (board.teams || []).filter(Boolean).map(id => `
    <div class="admin-team-row">
      <strong>${esc(id)}</strong>
      <select data-team-status="${esc(id)}">
        <option value="present" ${(teams.get(id)?.attendance || 'present') === 'present' ? 'selected' : ''}>Vor Ort</option>
        <option value="remote" ${teams.get(id)?.attendance === 'remote' ? 'selected' : ''}>Video / Remote</option>
        <option value="absent" ${teams.get(id)?.attendance === 'absent' ? 'selected' : ''}>Abwesend</option>
      </select>
    </div>`).join('') || '<p class="empty-state">Noch keine Team-Reihenfolge im Draft Board hinterlegt.</p>';
}

$('teams').addEventListener('change', async e => {
  const teamId = e.target.dataset.teamStatus;
  if (!teamId) return;
  e.target.disabled = true;
  try { await setAttendance(teamId, e.target.value); }
  catch (err) { alert(`Status konnte nicht geändert werden: ${err.message}`); }
  finally { e.target.disabled = false; }
});

function formatCountdown(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
