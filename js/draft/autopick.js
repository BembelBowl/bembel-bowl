import { DRAFT } from './config.js';
import { positionsForPlan, getNextOpenSlot } from './model.js';
import { bestAvailable } from './rankings.js';
import { acquireAdminLease, renewAdminLease, setAutoPickDue, submitPick, timestampMs, getPickRequest, markPickRequest } from './service.js';

export class DraftAdminEngine {
  constructor({ ownerId, getBoard, getState, getTeam, getSheet, onCountdown }) {
    this.ownerId = ownerId;
    this.getBoard = getBoard;
    this.getState = getState;
    this.getTeam = getTeam;
    this.getSheet = getSheet;
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
    if (!board || !state) return;
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

    this.busy = true;
    try {
      const sheet = this.getSheet(teamId) || {};
      const player = chooseAutoPick({ board, round: next.round, sheet });
      if (!player) throw new Error(`Kein Autopick-Kandidat für ${teamId}`);
      await submitPick({ teamId, player, source: 'autopick', actorUid: this.ownerId });
    } finally { this.busy = false; }
  }
}

export function chooseAutoPick({ board, round, sheet }) {
  const planned = sheet.roundPlan?.[String(round)] || DRAFT.fallbackRoundPlan[round - 1] || 'FLEX';
  const positions = positionsForPlan(planned);
  const pickedNames = new Set(Object.values(board.picks || {}).map(p => p.name));
  const prefs = sheet.playerPriorities || {};

  const preferredNames = positions.flatMap(pos => (prefs[pos] || []).map((name, index) => ({ name, index, pos })));
  preferredNames.sort((a,b) => a.index - b.index);
  for (const pref of preferredNames) {
    if (![...pickedNames].some(n => n.toLowerCase() === String(pref.name).toLowerCase())) {
      const rank = bestAvailable(pickedNames, 500, [pref.pos]).find(p => p.name.toLowerCase() === String(pref.name).toLowerCase());
      if (rank) return { id: null, name: rank.name, position: rank.position, nflTeam: rank.team || '' };
    }
  }

  const fallback = bestAvailable(pickedNames, 1, positions)[0];
  return fallback ? { id: null, name: fallback.name, position: fallback.position, nflTeam: fallback.team || '' } : null;
}
