import { DRAFT } from './config.js';
import { watchBoard, watchState, timestampMs } from './service.js';
import { getNextOpenSlot, orderedPicks, teamNeeds } from './model.js';
import { loadRankings, bestAvailable } from './rankings.js';
import { loadSleeperPlayers } from './players.js';
import { unlockAudio, announcePick, announceClock, fullNflTeam, sleep } from './audio.js';

let board = { teams: [], picks: {} };
let state = {};
let players = [];
let rankingsReady = false;
let lastPickOverall = 0;
let animationQueue = Promise.resolve();
const $ = id => document.getElementById(id);
const PLAYER_FALLBACK = 'images/player-silhouette.svg';

$('season').textContent = DRAFT.season;
$('audioUnlock').onclick = () => { unlockAudio(); $('audioUnlock').textContent = '🔊 Audio bereit'; };

Promise.allSettled([loadRankings(), loadSleeperPlayers()]).then(([r, p]) => {
  rankingsReady = r.status === 'fulfilled';
  if (p.status === 'fulfilled') players = p.value;
  render();
});

watchState(s => { state = s; renderTimer(); });
watchBoard(b => {
  const before = lastPickOverall;
  board = b;
  $('sync').textContent = 'LIVE';
  render();
  const ordered = orderedPicks(b.picks || {});
  const latest = ordered.at(-1);
  if (latest && latest.overall > before) {
    lastPickOverall = latest.overall;
    animationQueue = animationQueue.then(() => showPickSequence(latest)).catch(console.error);
  } else {
    lastPickOverall = latest?.overall || 0;
  }
}, () => { $('sync').textContent = 'OFFLINE'; });

setInterval(renderTimer, 250);

function render() {
  const next = getNextOpenSlot(board.picks || {});
  if (!next) {
    $('teamName').textContent = 'DRAFT COMPLETE';
    $('pickMeta').textContent = 'Alle Picks abgeschlossen';
    $('draftProgress').textContent = 'COMPLETE';
    return;
  }
  const teamName = board.teams?.[next.position - 1] || `Position ${next.position}`;
  $('teamName').textContent = teamName;
  $('pickMeta').textContent = `Runde ${next.round} · Overall Pick #${next.overall}`;
  $('draftProgress').textContent = `PICK ${next.overall} / ${DRAFT.teamCount * DRAFT.roundCount}`;
  setLogo($('teamLogo'), teamName);

  const teamPicks = orderedPicks(board.picks || {}).filter(p => board.teams?.[p.position - 1] === teamName);
  const needs = teamNeeds(teamPicks).needs;
  const needLabels = (needs.length ? needs : [{ position: 'DEPTH' }]).map(n => {
    if (n.position === 'FLEX') return 'RB / WR / TE';
    if (n.position === 'DEPTH') return 'Bench Depth';
    return n.position;
  });
  $('needsList').innerHTML = needLabels.map(label => `<span>${label}</span>`).join('');

  const picked = new Set(Object.values(board.picks || {}).map(p => p.name));
  const avail = rankingsReady ? bestAvailable(picked, 10) : [];
  $('availableList').innerHTML = avail.map((p, i) => `<li><span class="rank">${i + 1}</span><div><div class="pname">${esc(p.name)}</div><div class="pmeta">${esc(fullNflTeam(p.team) || p.team || '')} · ${p.overallEcr != null ? `ECR ${p.overallEcr}` : `Pos ECR ${p.positionEcr ?? '—'}`}${p.bye ? ` · Bye ${p.bye}` : ''}</div></div><span class="pos">${p.position}</span></li>`).join('') || '<li>Ranking-Feed wird geladen…</li>';

  const recent = orderedPicks(board.picks || {}).slice(-10).reverse();
  $('recentList').innerHTML = recent.map(p => `<div class="recent-item"><strong>#${p.overall} ${esc(p.name)}</strong><span>${esc(board.teams?.[p.position - 1] || '')} · ${p.position} ${esc(fullNflTeam(p.nflTeam) || p.nflTeam || '')}</span></div>`).join('');
}

function renderTimer() {
  const start = timestampMs(state.clockStartedAt);
  if (start) $('pickTimer').textContent = fmt(Date.now() - start);
}

async function showPickSequence(p) {
  const teamName = board.teams?.[p.position - 1] || '';
  const player = players.find(x => x.name.toLowerCase() === String(p.name || '').toLowerCase());
  const resolvedPosition = player?.position || p.position || '';
  const resolvedTeam = player?.nflTeam || p.nflTeam || '';
  const announcedPlayer = { ...p, position: resolvedPosition, nflTeam: resolvedTeam };
  $('pickNumber').textContent = `ROUND ${p.round} · PICK #${p.overall}`;
  $('pickPlayer').textContent = p.name;
  $('pickPosition').textContent = resolvedPosition;
  $('pickNfl').textContent = fullNflTeam(resolvedTeam) || resolvedTeam || '';
  $('pickFantasyTeam').textContent = teamName;
  setPlayerPhoto(player?.headshot);

  const overlay = $('pickOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  await announcePick({ overall: p.overall, season: DRAFT.season, teamName, player: announcedPlayer });
  await sleep(1400);
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  await sleep(450);
  await showNextTeam();
}

async function showNextTeam() {
  const next = getNextOpenSlot(board.picks || {});
  if (!next) return;
  const name = board.teams?.[next.position - 1] || '';
  $('nextTeam').textContent = name;
  setLogo($('nextLogo'), name);
  const overlay = $('nextOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  const spoken = announceClock(name);
  await Promise.all([spoken, sleep(5600)]);
  await sleep(700);
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}

function setPlayerPhoto(url) {
  const el = $('pickPhoto');
  el.onerror = () => { el.onerror = null; el.src = PLAYER_FALLBACK; };
  el.src = url || PLAYER_FALLBACK;
}
function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function setLogo(el, name) {
  const slug = name.toLowerCase().replace(/ü/g, 'u').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const known = {"amity island sharks":"amity_island_sharks","beard":"beard","bishop sycamore":"bishop_sycamore","bojangles p-stars":"bojangles_pstars","brady gaga":"brady_gaga","broken bembels ulb":"broken_bembels","e-town elephants":"etown_elephants","fighting farmers":"fighting_farmers","foxboro forever":"foxboro_forever","frankfurt bakers":"frankfurt_bakers","k-town devils":"ktown_devils","packers ultras":"packers_ultras","pep's band":"peps_band","randy moss lob jünger":"randy_moss","steelersnation 7":"steelersnation","the 49vengers":"the49vengers","the boys":"the_boys","thunder ducks":"thunder_ducks","wiesbaden phantoms":"wiesbaden_phantoms","zeugen ray lewis":"zeugen_ray_lewis"};
  el.onerror = () => { el.onerror = null; el.src = 'images/favicon.jpg'; };
  el.src = `images/${known[name.toLowerCase()] || slug}.jpg`;
}
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
