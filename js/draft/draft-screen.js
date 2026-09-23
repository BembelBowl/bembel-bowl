import { DRAFT } from './config.js';
import { watchBoard, watchState, timestampMs } from './service.js';
import { getNextOpenSlot, orderedPicks, concreteTeamNeeds, slotForOverall } from './model.js';
import { loadRankings, bestAvailable } from './rankings.js';
import { loadSleeperPlayers } from './players.js';
import { unlockAudio, preparePickSpeech, prepareClockSpeech, playPreparedSpeech, playPickInJingle, playNextTeamJingle, fullNflTeam, sleep } from './audio.js';
import { AUDIO_TIMING, clockVerb } from './speech-config.js';

let board = { teams: [], picks: {} };
let state = {};
let players = [];
let rankingsReady = false;
let lastPickOverall = 0;
let animationQueue = Promise.resolve();
let resolveStateReady;
const stateReady = new Promise(resolve => { resolveStateReady = resolve; });
let stateSnapshotReady = false;
const $ = id => document.getElementById(id);
const PLAYER_FALLBACK = 'images/player-silhouette.svg';

$('season').textContent = DRAFT.season;
$('audioUnlock').onclick = () => { unlockAudio(); $('audioUnlock').textContent = '🔊 Audio bereit'; };

Promise.allSettled([loadRankings(), loadSleeperPlayers()]).then(([r, p]) => {
  rankingsReady = r.status === 'fulfilled';
  if (p.status === 'fulfilled') players = p.value;
  render();
});

watchState(s => {
  state = s || {};
  if (!stateSnapshotReady) {
    stateSnapshotReady = true;
    resolveStateReady();
  }
  const activeSeason = Number(state.season);
  $('season').textContent = Number.isInteger(activeSeason) ? activeSeason : '—';
  renderTimer();
});
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
    return;
  }
  const teamName = board.teams?.[next.position - 1] || `Position ${next.position}`;
  $('teamName').textContent = teamName;
  $('pickMeta').textContent = `RUNDE ${next.round} · PICK #${next.overall}`;
  setLogo($('teamLogo'), teamName);

  const teamPicks = orderedPicks(board.picks || {}).filter(p => board.teams?.[p.position - 1] === teamName);
  const teamPicksForNeeds = teamPicks.map(p => ({
    ...p,
    position: rawPlayerPosition(p)
  }));
  const needs = concreteTeamNeeds(teamPicksForNeeds);
  $('needsList').innerHTML = needs.length ? needs.map(pos => `<span>${pos}</span>`).join('') : '<span>Roster komplett</span>';

  $('rosterCount').textContent = `${teamPicks.length} ${teamPicks.length === 1 ? 'PICK' : 'PICKS'}`;
  $('currentRoster').innerHTML = teamPicks.length
    ? teamPicks.map(p => `<div class="roster-chip"><span>${esc(rawPlayerPosition(p) || '')}</span><strong>${esc(livePickDisplayName(p))}</strong><small>${esc(fullNflTeam(p.nflTeam) || p.nflTeam || '')}${p.overall ? ` · #${p.overall}` : ''}</small></div>`).join('')
    : '<div class="roster-empty">Noch keine Spieler gedraftet.</div>';

  const maxPicks = DRAFT.teamCount * DRAFT.roundCount;
  if (next.overall < maxPicks) {
    const after = slotForOverall(next.overall + 1);
    const nextTeamName = board.teams?.[after.position - 1] || '—';
    $('nextMiniTeam').textContent = nextTeamName;
    setLogo($('nextMiniLogo'), nextTeamName);
  } else {
    $('nextMiniTeam').textContent = 'Draft Ende';
    $('nextMiniLogo').src = 'images/favicon.jpg';
  }

  const pickedValues = Object.values(board.picks || {});
  const pickedIds = new Set(
    pickedValues
      .map(p => String(p.playerId || p.id || p.sleeperId || '').trim())
      .filter(Boolean)
  );
  const pickedNames = new Set(
    pickedValues
      .map(p => normalizePlayerName(p.name))
      .filter(Boolean)
  );
  const pickedKeys = new Set(
    pickedValues
      .map(p => playerIdentityKey(p))
      .filter(Boolean)
  );
  const pickedDefenseTeams = new Set(
    pickedValues
      .filter(p => isDefensePosition(p.position))
      .map(p => canonicalNflTeam(p.nflTeam || p.team || p.name))
      .filter(Boolean)
  );

  const candidates = rankingsReady ? bestAvailable(new Set(), 800) : [];
  const avail = candidates.filter(p => {
    const id = String(p.id || p.playerId || p.sleeperId || '').trim();
    const name = normalizePlayerName(p.name);
    const key = playerIdentityKey(p);

    if (id && pickedIds.has(id)) return false;
    if (key && pickedKeys.has(key)) return false;
    if (name && pickedNames.has(name)) return false;

    if (isDefensePosition(p.position)) {
      const defenseTeam = canonicalNflTeam(p.team || p.nflTeam || p.name);
      if (defenseTeam && pickedDefenseTeams.has(defenseTeam)) return false;
    }

    return true;
  }).slice(0, 12);

  $('availableList').innerHTML = avail.map((p, i) => `<li><span class="rank">${i + 1}</span><div><div class="pname">${esc(p.name)}</div><div class="pmeta">${esc(fullNflTeam(p.team) || p.team || '')} · ${p.overallEcr != null ? `ECR ${p.overallEcr}` : `Pos ECR ${p.positionEcr ?? '—'}`}${p.bye ? ` · Bye ${p.bye}` : ''}</div></div><span class="pos">${p.position}</span></li>`).join('') || '<li>Ranking-Feed wird geladen…</li>';

  const recent = orderedPicks(board.picks || {}).slice(-10).reverse();
  $('recentList').innerHTML = recent.map(p => {
    const playerPos = rawPlayerPosition(p);
    const nfl = fullNflTeam(p.nflTeam) || p.nflTeam || '';
    return `<div class="recent-item">
      <div class="recent-copy">
        <strong>#${p.overall} ${esc(livePickDisplayName(p))}</strong>
        <span class="recent-meta">${esc(board.teams?.[p.position - 1] || '')}${nfl ? ` · ${esc(nfl)}` : ''}</span>
      </div>
      <span class="recent-pos">${esc(playerPos || '—')}</span>
    </div>`;
  }).join('');
}




function rawPickForOrdered(pick) {
  return pick?.key ? (board.picks?.[pick.key] || {}) : {};
}

function normalizePlayerPosition(value) {
  const raw = String(value || '').toUpperCase().trim();
  if (!raw || /^\d+$/.test(raw)) return '';
  if (raw === 'DST' || raw === 'D/ST' || raw === 'DEFENSE') return 'DEF';
  if (raw === 'PK') return 'K';
  return raw;
}

function rawPlayerPosition(pick) {
  const raw = rawPickForOrdered(pick);
  const rawId = String(raw.playerId || raw.id || pick?.playerId || pick?.id || '').trim();
  const sleeper = players.find(x =>
    (rawId && String(x.id || x.playerId || '') === rawId) ||
    normalizePlayerName(x.name) === normalizePlayerName(pick?.name)
  );
  return normalizePlayerPosition(
    sleeper?.position || raw.position || raw.pos || pick?.playerPosition || ''
  );
}

function livePickDisplayName(pick) {
  const pos = rawPlayerPosition(pick);
  if (isDefensePosition(pos)) {
    return fullNflTeam(pick?.nflTeam || rawPickForOrdered(pick)?.nflTeam) || pick?.name || 'Defense';
  }
  return pick?.name || '';
}

function normalizePlayerName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function playerIdentityKey(player) {
  if (!player) return '';
  if (isDefensePosition(player.position)) {
    const team = canonicalNflTeam(player.nflTeam || player.team || player.name);
    return team ? `DEF:${team}` : '';
  }
  const name = normalizePlayerName(player.name);
  const team = canonicalNflTeam(player.nflTeam || player.team || '');
  const pos = String(player.position || '').toUpperCase();
  return name ? `${name}|${pos}|${team}` : '';
}

function isDefensePosition(position) {
  return ['DEF','DST','D/ST','DEFENSE'].includes(String(position || '').toUpperCase());
}

function canonicalNflTeam(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const upper = raw.toUpperCase();
  const aliases = {
    ARI:'ARI', 'ARIZONA CARDINALS':'ARI',
    ATL:'ATL', 'ATLANTA FALCONS':'ATL',
    BAL:'BAL', 'BALTIMORE RAVENS':'BAL',
    BUF:'BUF', 'BUFFALO BILLS':'BUF',
    CAR:'CAR', 'CAROLINA PANTHERS':'CAR',
    CHI:'CHI', 'CHICAGO BEARS':'CHI',
    CIN:'CIN', 'CINCINNATI BENGALS':'CIN',
    CLE:'CLE', 'CLEVELAND BROWNS':'CLE',
    DAL:'DAL', 'DALLAS COWBOYS':'DAL',
    DEN:'DEN', 'DENVER BRONCOS':'DEN',
    DET:'DET', 'DETROIT LIONS':'DET',
    GB:'GB', 'GREEN BAY PACKERS':'GB',
    HOU:'HOU', 'HOUSTON TEXANS':'HOU', 'HOUSTON TEXANS DEFENSE':'HOU', 'HOU DEFENSE':'HOU',
    IND:'IND', 'INDIANAPOLIS COLTS':'IND',
    JAX:'JAX', JAC:'JAX', 'JACKSONVILLE JAGUARS':'JAX',
    KC:'KC', 'KANSAS CITY CHIEFS':'KC',
    LAC:'LAC', 'LOS ANGELES CHARGERS':'LAC',
    LAR:'LAR', 'LOS ANGELES RAMS':'LAR',
    LV:'LV', 'LAS VEGAS RAIDERS':'LV',
    MIA:'MIA', 'MIAMI DOLPHINS':'MIA',
    MIN:'MIN', 'MINNESOTA VIKINGS':'MIN',
    NE:'NE', 'NEW ENGLAND PATRIOTS':'NE',
    NO:'NO', 'NEW ORLEANS SAINTS':'NO',
    NYG:'NYG', 'NEW YORK GIANTS':'NYG',
    NYJ:'NYJ', 'NEW YORK JETS':'NYJ',
    PHI:'PHI', 'PHILADELPHIA EAGLES':'PHI',
    PIT:'PIT', 'PITTSBURGH STEELERS':'PIT',
    SEA:'SEA', 'SEATTLE SEAHAWKS':'SEA',
    SF:'SF', 'SAN FRANCISCO 49ERS':'SF', 'SAN FRANCISCO FORTY NINERS':'SF',
    TB:'TB', 'TAMPA BAY BUCCANEERS':'TB',
    TEN:'TEN', 'TENNESSEE TITANS':'TEN',
    WAS:'WAS', WSH:'WAS', 'WASHINGTON COMMANDERS':'WAS'
  };

  const cleaned = upper
    .replace(/\s+D\/ST$/,'')
    .replace(/\s+DST$/,'')
    .replace(/\s+DEFENSE$/,'')
    .replace(/\s+DEF$/,'')
    .trim();

  return aliases[upper] || aliases[cleaned] || cleaned;
}

function renderTimer() {
  const start = timestampMs(state.clockStartedAt);
  if (start) $('pickTimer').textContent = fmt(Date.now() - start);
}

async function showPickSequence(p) {
  const teamName = board.teams?.[p.position - 1] || '';
  const rawPick = rawPickForOrdered(p);
  const rawPlayerId = String(rawPick.playerId || rawPick.id || p.playerId || p.id || '').trim();
  const player = players.find(x =>
    (rawPlayerId && String(x.id || x.playerId || '') === rawPlayerId) ||
    normalizePlayerName(x.name) === normalizePlayerName(p.name)
  );
  const resolvedPosition = normalizePlayerPosition(
    player?.position || rawPick.position || rawPick.pos || p.playerPosition || ''
  );
  const resolvedTeam = player?.nflTeam || rawPick.nflTeam || p.nflTeam || '';
  const announcedPlayer = { ...p, position: resolvedPosition, nflTeam: resolvedTeam };

  const isDefense = ['DEF','DST','D/ST','DEFENSE'].includes(String(resolvedPosition || '').toUpperCase());
  const nflFull = fullNflTeam(resolvedTeam) || resolvedTeam || '';
  const visiblePickName = isDefense && nflFull ? `${nflFull} Defense` : p.name;

  $('pickNumber').textContent = `ROUND ${p.round} · PICK #${p.overall}`;
  $('pickPlayer').textContent = visiblePickName;
  $('pickPosition').textContent = resolvedPosition;
  $('pickNfl').textContent = isDefense ? '' : nflFull;
  $('pickFantasyTeam').textContent = teamName;
  setPlayerPhoto(player?.headshot, { isDefense, nflTeam: resolvedTeam });

  // Never fall back to the static config year for speech. A newly created draft
  // can already be 2027 while config.js still contains the previous default year.
  // Wait for draftState/current so Azure always receives the actual active season.
  await stateReady;
  const speechSeason = Number(state.season);
  if (!Number.isInteger(speechSeason) || speechSeason < 2020 || speechSeason > 2100) {
    throw new Error('Aktive Draft-Saison fehlt in draftState/current – Azure-Ansage wurde gestoppt, damit kein falsches Jahr gesprochen wird.');
  }
  const pickSpeech = preparePickSpeech({ overall: p.overall, season: speechSeason, teamName, player: announcedPlayer });
  const next = getNextOpenSlot(board.picks || {});
  const nextName = next ? (board.teams?.[next.position - 1] || '') : '';
  const clockSpeech = nextName ? prepareClockSpeech(nextName) : null;

  const signal = $('pickSignalOverlay');

  // Synchronize the visual with the real audio start. Previously the overlay
  // appeared before the browser had actually begun playing the local jingle,
  // which could make the sound feel late on a cold/cache-miss start.
  let resolveSignalStarted;
  const signalStarted = new Promise(resolve => { resolveSignalStarted = resolve; });
  let signalShown = false;
  const showSignalWithAudio = () => {
    if (signalShown) return;
    signalShown = true;
    signal.classList.add('show');
    signal.setAttribute('aria-hidden', 'false');
    resolveSignalStarted();
  };

  const pickJingle = playPickInJingle(showSignalWithAudio).catch(err => {
    console.error('Pick jingle failed:', err);
    // Never block the draft animation if audio playback fails.
    showSignalWithAudio();
  });

  await signalStarted;
  await Promise.all([pickJingle, sleep(AUDIO_TIMING.pickSignalMinMs)]);

  const pickOverlay = $('pickOverlay');
  pickOverlay.classList.add('show');
  pickOverlay.setAttribute('aria-hidden', 'false');
  await sleep(AUDIO_TIMING.overlayCrossfadeMs);
  signal.classList.remove('show');
  signal.setAttribute('aria-hidden', 'true');

  const minimumPlayerDisplay = sleep(AUDIO_TIMING.pickOverlayMinMs || 8200);
  try {
    await Promise.all([playPreparedSpeech(pickSpeech), minimumPlayerDisplay]);
  } catch (err) {
    console.error('Azure pick speech failed:', err);
    await minimumPlayerDisplay;
  }

  await sleep(AUDIO_TIMING.afterPickSpeechMs);

  // Keep the broadcast background on screen, but remove the selected player
  // before the transition stinger starts. This prevents the live screen from
  // flashing briefly between the two overlays.
  pickOverlay.classList.add('transitioning');
  await sleep(AUDIO_TIMING.overlayCrossfadeMs);
  await playNextTeamJingle().catch(err => console.error('Next-team jingle failed:', err));
  await showNextTeam(pickOverlay, next, nextName, clockSpeech);
  pickOverlay.classList.remove('transitioning');
}

async function showNextTeam(previousOverlay = null, next = null, name = '', preparedSpeech = null) {
  next ||= getNextOpenSlot(board.picks || {});
  if (!next) {
    if (previousOverlay) {
      previousOverlay.classList.remove('show');
      previousOverlay.setAttribute('aria-hidden', 'true');
    }
    return;
  }
  name ||= board.teams?.[next.position - 1] || '';
  $('nextTeam').textContent = name;
  $('nextVerb').textContent = clockVerb(name);
  setLogo($('nextLogo'), name);
  const overlay = $('nextOverlay');
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  await sleep(AUDIO_TIMING.overlayCrossfadeMs);
  if (previousOverlay) {
    previousOverlay.classList.remove('show');
    previousOverlay.setAttribute('aria-hidden', 'true');
  }

  const minDisplay = sleep(AUDIO_TIMING.nextTeamOverlayMinMs);
  try {
    await Promise.all([playPreparedSpeech(preparedSpeech || prepareClockSpeech(name)), minDisplay]);
  } catch (err) {
    console.error('Azure clock speech failed:', err);
    await minDisplay;
  }

  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}

function nflTeamLogo(team) {
  const raw = String(team || '').trim().toUpperCase();
  const codeMap = { WAS:'wsh', WSH:'wsh', JAC:'jax' };
  const code = codeMap[raw] || raw.toLowerCase();
  return code ? `https://a.espncdn.com/i/teamlogos/nfl/500/${code}.png` : '';
}
function setPlayerPhoto(url, { isDefense = false, nflTeam = '' } = {}) {
  const el = $('pickPhoto');
  el.classList.toggle('defense-logo', isDefense);
  el.onerror = () => {
    el.onerror = null;
    el.classList.remove('defense-logo');
    el.src = PLAYER_FALLBACK;
  };
  el.src = isDefense ? (nflTeamLogo(nflTeam) || PLAYER_FALLBACK) : (url || PLAYER_FALLBACK);
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
