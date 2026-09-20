import { db, doc, onSnapshot, getDoc, setDoc, runTransaction, serverTimestamp, Timestamp } from './firebase.js';
import { COLLECTIONS, DRAFT } from './config.js';
import { getNextOpenSlot, orderedPicks } from './model.js';

export const boardRef = doc(db, ...COLLECTIONS.board);
export const stateRef = doc(db, ...COLLECTIONS.state);

export function watchBoard(cb, err = console.error) { return onSnapshot(boardRef, s => cb(s.exists() ? s.data() : { teams: [], picks: {} }), err); }
export function watchState(cb, err = console.error) { return onSnapshot(stateRef, s => cb(s.exists() ? s.data() : {}), err); }
export function watchTeam(teamId, cb, err = console.error) { return onSnapshot(doc(db, COLLECTIONS.teams, teamId), s => cb(s.exists() ? s.data() : null), err); }
export function watchSheet(teamId, cb, err = console.error) { return onSnapshot(doc(db, COLLECTIONS.sheets, teamId), s => cb(s.exists() ? s.data() : null), err); }

export async function getUserProfile(uid) {
  const s = await getDoc(doc(db, COLLECTIONS.users, uid));
  return s.exists() ? s.data() : null;
}

export async function ensureTeamDefaults(teamId) {
  const teamRef = doc(db, COLLECTIONS.teams, teamId);
  const sheetRef = doc(db, COLLECTIONS.sheets, teamId);
  const [teamSnap, sheetSnap] = await Promise.all([getDoc(teamRef), getDoc(sheetRef)]);
  if (!teamSnap.exists()) {
    await setDoc(teamRef, { attendance: 'present', updatedAt: serverTimestamp() }, { merge: true });
  }
  if (!sheetSnap.exists()) {
    await setDoc(sheetRef, {
      roundPlan: Object.fromEntries(DRAFT.fallbackRoundPlan.map((p, i) => [String(i + 1), p])),
      playerPriorities: Object.fromEntries(DRAFT.positions.map(p => [p, []])),
      usesDefaultPlan: true,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
}

export async function ensureDraftInfrastructure() {
  const boardSnap = await getDoc(boardRef);
  const board = boardSnap.exists() ? boardSnap.data() : { teams: [], picks: {} };
  await reconcileDraftState(board);
  await setDoc(doc(db, COLLECTIONS.pickRequests, '_meta'), {
    schemaVersion: 2,
    purpose: 'Remote pick requests; numeric documents are created only when a team submits a remote pick.',
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function setAttendance(teamId, attendance) {
  if (!['present', 'remote', 'absent'].includes(attendance)) throw new Error('Ungültiger Anwesenheitsstatus.');
  await setDoc(doc(db, COLLECTIONS.teams, teamId), { attendance, updatedAt: serverTimestamp() }, { merge: true });
}

export async function savePreferenceSheet(teamId, sheet) {
  await setDoc(doc(db, COLLECTIONS.sheets, teamId), {
    ...sheet,
    usesDefaultPlan: false,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function submitPick({ teamId, player, source = 'remote', actorUid }) {
  return runTransaction(db, async tx => {
    const [boardSnap, stateSnap] = await Promise.all([tx.get(boardRef), tx.get(stateRef)]);
    const board = boardSnap.exists() ? boardSnap.data() : { teams: [], picks: {} };
    const state = stateSnap.exists() ? stateSnap.data() : {};
    const next = getNextOpenSlot(board.picks || {});
    if (!next) throw new Error('Draft ist bereits beendet.');
    const currentTeamName = board.teams?.[next.position - 1];
    const configuredTeamId = state.currentTeamId || currentTeamName;
    if (teamId !== configuredTeamId && teamId !== currentTeamName) throw new Error('Dieses Team ist nicht on the clock.');
    const duplicate = Object.values(board.picks || {}).some(p => p?.name?.toLowerCase() === player.name.toLowerCase());
    if (duplicate) throw new Error(`${player.name} wurde bereits gedraftet.`);

    const now = Timestamp.now();
    const startMs = timestampMs(state.clockStartedAt);
    const prev = orderedPicks(board.picks || {}).at(-1);
    const fallbackStart = timestampMs(prev?.pickedAt);
    const started = startMs || fallbackStart;
    const pick = {
      playerId: player.id || null,
      name: player.name,
      position: player.position,
      nflTeam: player.nflTeam || player.team || '',
      pickedAt: now,
      pickDurationSeconds: started ? Math.max(0, Math.round((now.toMillis() - started) / 1000)) : null,
      source,
      actorUid: actorUid || null
    };
    tx.update(boardRef, { [`picks.${next.key}`]: pick, updatedAt: serverTimestamp() });
    tx.set(stateRef, {
      lastPickOverall: next.overall,
      autoPickForOverall: null,
      autoPickDueAt: null,
      updatedAt: serverTimestamp()
    }, { merge: true });
    return { ...next, pick, teamName: currentTeamName };
  });
}

export async function reconcileDraftState(board) {
  const next = getNextOpenSlot(board.picks || {});
  const picks = orderedPicks(board.picks || {});
  const last = picks.at(-1) || null;
  const currentTeamName = next ? board.teams?.[next.position - 1] || null : null;
  const existing = await getDoc(stateRef);
  const state = existing.exists() ? existing.data() : {};
  const changedPick = state.currentOverall !== (next?.overall ?? null);
  const clockStartedAt = changedPick ? (last?.pickedAt || Timestamp.now()) : (state.clockStartedAt || last?.pickedAt || Timestamp.now());

  await setDoc(stateRef, {
    status: next ? 'live' : 'complete',
    season: DRAFT.season,
    currentOverall: next?.overall ?? null,
    currentRound: next?.round ?? null,
    currentPosition: next?.position ?? null,
    currentTeamId: currentTeamName,
    currentTeamName,
    clockStartedAt,
    lastPickOverall: last?.overall ?? 0,
    ...(changedPick ? { autoPickForOverall: null, autoPickDueAt: null } : {}),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function acquireAdminLease(ownerId) {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.exists() ? snap.data() : {};
    const now = Date.now();
    const expires = timestampMs(state.adminLeaseUntil);
    if (state.adminOwner && state.adminOwner !== ownerId && expires && expires > now) return false;
    tx.set(stateRef, { adminOwner: ownerId, adminLeaseUntil: Timestamp.fromMillis(now + DRAFT.adminLeaseMs) }, { merge: true });
    return true;
  });
}

export async function renewAdminLease(ownerId) {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.exists() ? snap.data() : {};
    if (state.adminOwner !== ownerId) return false;
    tx.update(stateRef, { adminLeaseUntil: Timestamp.fromMillis(Date.now() + DRAFT.adminLeaseMs) });
    return true;
  });
}

export async function setAutoPickDue(overall, dueMs) {
  await setDoc(stateRef, { autoPickForOverall: overall, autoPickDueAt: dueMs ? Timestamp.fromMillis(dueMs) : null }, { merge: true });
}

export async function requestRemotePick({ teamId, player, actorUid, overall }) {
  const reqRef = doc(db, COLLECTIONS.pickRequests, String(overall));
  await setDoc(reqRef, { teamId, player, actorUid, overall, status: 'pending', createdAt: serverTimestamp() });
}

export async function getPickRequest(overall) {
  const ref = doc(db, COLLECTIONS.pickRequests, String(overall));
  const s = await getDoc(ref);
  return s.exists() ? { ref, ...s.data() } : null;
}

export async function markPickRequest(ref, status, error = null) {
  await setDoc(ref, { status, error, processedAt: serverTimestamp() }, { merge: true });
}

export function timestampMs(ts) {
  if (!ts) return null;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  return null;
}
