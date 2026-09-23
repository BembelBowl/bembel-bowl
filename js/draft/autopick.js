import { DRAFT } from './config.js';
import { positionsForPlan, getNextOpenSlot } from './model.js';
import { bestAvailable } from './rankings.js';
import { acquireAdminLease, renewAdminLease, setAutoPickDue, submitPick, timestampMs, getPickRequest, markPickRequest, getPreferenceSheet } from './service.js';

export class DraftAdminEngine {
  constructor({ ownerId, getBoard, getState, getTeam, getSheet, rankingsReady = () => true, onCountdown }) {
    this.ownerId = ownerId;
    this.getBoard = getBoard;
    this.getState = getState;
    this.getTeam = getTeam;
    this.getSheet = getSheet;
    this.rankingsReady = rankingsReady;
    this.onCountdown = onCountdown || (() => {});
    this.timer = null;
    this.leaseTimer = null;
    this.busy = false;
  }

  async start() {
    const ok = await acquireAdminLease(this.ownerId);
    if (!ok) return false;
    this.leaseTimer = setInterval(() => renewAdminLease(this.ownerId).catch(console.error), DRAFT.adminLeaseRenewMs);
    this.timer = setInterval(() => this.tick().catch(console.error), 500);
    return true;
  }

  stop() { clearInterval(this.timer); clearInterval(this.leaseTimer); }

  async tick() {
    if (this.busy) return;
    const board = this.getBoard();
    const state = this.getState();
    if (!board || !state || state.status !== 'live' || !state.orderSet) return this.onCountdown(null);
    const next = getNextOpenSlot(board.picks || {});
    if (!next) return this.onCountdown(null);
    const teamId = board.teams?.[next.position - 1];

    // Remote Picks haben immer Vorrang vor einem Autopick.
    const request = await getPickRequest(next.overall);
    if (request?.status === 'pending' && request.teamId === teamId) {
      this.busy = true;
      try {
        await submitPick({ teamId, player: request.player, source: 'remote', actorUid: request.actorUid || this.ownerId });
        await markPickRequest(request.ref, 'accepted');
      } catch (e) {
        await markPickRequest(request.ref, 'rejected', e.message);
      } finally { this.busy = false; }
      return;
    }

    const team = this.getTeam(teamId);
    if (!team || team.attendance !== 'absent') {
      if (state.autoPickForOverall === next.overall && state.autoPickDueAt) await setAutoPickDue(null, null);
      return this.onCountdown(null);
    }

    // JEDES abwesende Team bekommt 60 Sekunden ab Beginn seines Picks.
    // Ein manueller Admin-Pick oder Remote-Pick innerhalb dieser Minute beendet den Timer automatisch.
    const clockStart = timestampMs(state.clockStartedAt) || Date.now();
    const calculatedDue = clockStart + DRAFT.autoPickDelayMs;

    if (state.autoPickForOverall !== next.overall || !timestampMs(state.autoPickDueAt)) {
      await setAutoPickDue(next.overall, calculatedDue);
      return;
    }

    const storedDue = timestampMs(state.autoPickDueAt);
    const left = Math.max(0, storedDue - Date.now());
    this.onCountdown({ ms: left, teamId, overall: next.overall });
    if (left > 0) return;

    if (!this.rankingsReady()) {
      this.onCountdown({ ms: 0, teamId, overall: next.overall, error: 'FantasyPros ECR fehlt – kein Autopick ausgeführt.' });
      return;
    }

    this.busy = true;
    try {
      // Always read the latest persisted Draft Sheet immediately before the
      // autopick. The live snapshot cache remains a fallback only.
      const sheet = (await getPreferenceSheet(teamId)) || this.getSheet(teamId) || {};
      const player = chooseAutoPick({ board, round: next.round, sheet });
      if (!player) throw new Error(`Kein Autopick-Kandidat für ${teamId}`);
      await submitPick({ teamId, player, source: 'autopick', actorUid: this.ownerId });
    } finally { this.busy = false; }
  }
}

export function chooseAutoPick({ board, round, sheet }) {
  const planned = sheet.roundPlan?.[String(round)]
    || DRAFT.fallbackRoundPlan[round - 1]
    || 'FLEX';

  const positions = positionsForPlan(planned);
  const pickedValues = Object.values(board.picks || {});
  const pickedNames = new Set(pickedValues.map(p => p?.name).filter(Boolean));
  const pickedNormalized = new Set([...pickedNames].map(normalizeName));

  // Support both the current sheet shape and older saved variants.
  const prefs = sheet.playerPriorities
    || sheet.priorities
    || sheet.priorityPlayers
    || {};

  // Build one lookup of every still-available ranked player. This avoids an
  // exact-string dependency such as punctuation/accents in a saved priority.
  const rankedAvailable = bestAvailable(pickedNames, 5000);
  const rankedByName = new Map(
    rankedAvailable
      .filter(p => p?.name)
      .map(p => [normalizeName(p.name), p])
  );

  // 1) THE TEAM'S OWN SHEET ALWAYS WINS.
  // For RB in Round 2: RB #1 -> RB #2 -> ... until an available priority is found.
  // FLEX interleaves the first preference from RB/WR/TE, then the second, etc.
  const preferred = [];
  for (const pos of positions) {
    const list = Array.isArray(prefs?.[pos]) ? prefs[pos] : [];
    list.forEach((item, index) => {
      const name = priorityName(item);
      if (name) preferred.push({ name, index, pos, item });
    });
  }

  preferred.sort((a, b) => a.index - b.index || positions.indexOf(a.pos) - positions.indexOf(b.pos));

  for (const pref of preferred) {
    const normalized = normalizeName(pref.name);
    if (!normalized || pickedNormalized.has(normalized)) continue;

    const ranked = rankedByName.get(normalized);

    // The player was originally added to the sheet from the rankings list, so
    // a ranking match should normally exist. If it does, keep its canonical
    // NFL team / player id. If it does not, the saved team preference still
    // wins instead of silently falling back to overall ECR.
    if (ranked) {
      return {
        id: ranked.id || ranked.playerId || null,
        name: ranked.name,
        position: normalizePositionForAutoPick(ranked.position || pref.pos),
        nflTeam: ranked.team || ranked.nflTeam || ''
      };
    }

    return {
      id: typeof pref.item === 'object' ? (pref.item.id || pref.item.playerId || null) : null,
      name: pref.name,
      position: normalizePositionForAutoPick(
        typeof pref.item === 'object' ? (pref.item.position || pref.pos) : pref.pos
      ),
      nflTeam: typeof pref.item === 'object' ? (pref.item.nflTeam || pref.item.team || '') : ''
    };
  }

  // 2) Only when the relevant priority list contains no available player:
  // take the best available ECR player for the position planned for this round.
  const fallback = bestAvailable(pickedNames, 1, positions)[0];
  return fallback ? {
    id: fallback.id || fallback.playerId || null,
    name: fallback.name,
    position: normalizePositionForAutoPick(fallback.position),
    nflTeam: fallback.team || fallback.nflTeam || ''
  } : null;
}

function priorityName(item) {
  if (typeof item === 'string') return item.trim();
  return String(item?.name || '').trim();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+(?:jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizePositionForAutoPick(value) {
  const pos = String(value || '').toUpperCase();
  if (pos === 'DST' || pos === 'D/ST' || pos === 'DEFENSE') return 'DEF';
  if (pos === 'PK') return 'K';
  return pos;
}

