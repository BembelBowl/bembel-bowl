import { db, doc, onSnapshot, getDoc, setDoc, runTransaction, serverTimestamp, Timestamp } from './firebase.js';
import { COLLECTIONS, DRAFT } from './config.js';
import { getNextOpenSlot, orderedPicks, slotForOverall } from './model.js';

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

export async function setAttendance(teamId, attendance) {
  await setDoc(doc(db, COLLECTIONS.teams, teamId), { attendance, updatedAt: serverTimestamp() }, { merge: true });
}

export async function savePreferenceSheet(teamId, sheet) {
  await setDoc(doc(db, COLLECTIONS.sheets, teamId), { ...sheet, updatedAt: serverTimestamp() }, { merge: true });
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

    const prev = orderedPicks(board.picks || {}).at(-1);
    const now = Timestamp.now();
    const prevMs = timestampMs(prev?.pickedAt);
    const pick = {
      playerId: player.id || null,
      name: player.name,
      position: player.position,
      nflTeam: player.nflTeam || player.team || '',
      pickedAt: now,
      pickDurationSeconds: prevMs ? Math.max(0, Math.round((now.toMillis() - prevMs) / 1000)) : null,
      source,
      actorUid: actorUid || null
    };
    tx.update(boardRef, { [`picks.${next.key}`]: pick, updatedAt: serverTimestamp() });
    tx.set(stateRef, { lastPickOverall: next.overall, updatedAt: serverTimestamp() }, { merge: true });
    return { ...next, pick, teamName: currentTeamName };
  });
}

export async function reconcileDraftState(board) {
  const next = getNextOpenSlot(board.picks || {});
  const picks = orderedPicks(board.picks || {});
  const last = picks.at(-1) || null;
  const currentTeamName = next ? board.teams?.[next.position - 1] || null : null;
  await setDoc(stateRef, {
    status: next ? 'live' : 'complete',
    season: DRAFT.season,
    currentOverall: next?.overall ?? null,
    currentRound: next?.round ?? null,
    currentPosition: next?.position ?? null,
    currentTeamId: currentTeamName,
    currentTeamName,
    clockStartedAt: last?.pickedAt || serverTimestamp(),
    lastPickOverall: last?.overall ?? 0,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function acquireConductorLease(ownerId) {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.exists() ? snap.data() : {};
    const now = Date.now();
    const expires = timestampMs(state.conductorLeaseUntil);
    if (state.conductorOwner && state.conductorOwner !== ownerId && expires && expires > now) return false;
    tx.set(stateRef, { conductorOwner: ownerId, conductorLeaseUntil: Timestamp.fromMillis(now + DRAFT.conductorLeaseMs) }, { merge: true });
    return true;
  });
}

export async function renewConductorLease(ownerId) {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef);
    const state = snap.exists() ? snap.data() : {};
    if (state.conductorOwner !== ownerId) return false;
    tx.update(stateRef, { conductorLeaseUntil: Timestamp.fromMillis(Date.now() + DRAFT.conductorLeaseMs) });
    return true;
  });
}

export async function setAutoPickDue(overall, dueMs) {
  await setDoc(stateRef, { autoPickForOverall: overall, autoPickDueAt: dueMs ? Timestamp.fromMillis(dueMs) : null }, { merge: true });
}


export async function requestRemotePick({ teamId, player, actorUid, overall }) {
  const reqRef = doc(db, 'pickRequests', String(overall));
  await setDoc(reqRef, {
    teamId, player, actorUid, overall, status: 'pending', createdAt: serverTimestamp()
  });
}

export async function getPickRequest(overall) {
  const ref = doc(db, 'pickRequests', String(overall));
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
