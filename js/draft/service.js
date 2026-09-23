import { db, doc, collection, onSnapshot, getDoc, getDocs, setDoc, runTransaction, serverTimestamp, Timestamp, deleteField } from './firebase.js';
import { COLLECTIONS, DRAFT } from './config.js';
import { getNextOpenSlot, orderedPicks } from './model.js';

export const boardRef = doc(db, ...COLLECTIONS.board);
export const stateRef = doc(db, ...COLLECTIONS.state);
export const draftOrderRef = doc(db, COLLECTIONS.draftOrder, 'current');
export const divisionOrderRef = doc(db, COLLECTIONS.divisionOrder, 'current');

export function watchBoard(cb, err = console.error) { return onSnapshot(boardRef, s => cb(s.exists() ? s.data() : { teams: [], picks: {} }), err); }
export function watchState(cb, err = console.error) { return onSnapshot(stateRef, s => cb(s.exists() ? s.data() : {}), err); }
export function watchDraftOrder(cb, err = console.error) { return onSnapshot(draftOrderRef, s => cb(s.exists() ? s.data() : {}), err); }
export function watchDivisions(cb, err = console.error) { return onSnapshot(divisionOrderRef, s => cb(s.exists() ? s.data() : {}), err); }
export function watchTeam(teamId, cb, err = console.error) { return onSnapshot(doc(db, COLLECTIONS.teams, teamId), s => cb(s.exists() ? s.data() : null), err); }
export function watchSheet(teamId, cb, err = console.error) { return onSnapshot(doc(db, COLLECTIONS.sheets, teamId), s => cb(s.exists() ? s.data() : null), err); }

export async function getPreferenceSheet(teamId) {
  const snap = await getDoc(doc(db, COLLECTIONS.sheets, teamId));
  return snap.exists() ? snap.data() : null;
}

export async function getUserProfile(uid) {
  const s = await getDoc(doc(db, COLLECTIONS.users, uid));
  return s.exists() ? s.data() : null;
}

export async function ensureTeamDefaults(teamId) {
  const teamRef = doc(db, COLLECTIONS.teams, teamId);
  const sheetRef = doc(db, COLLECTIONS.sheets, teamId);
  const [teamSnap, sheetSnap] = await Promise.all([getDoc(teamRef), getDoc(sheetRef)]);
  if (!teamSnap.exists()) await setDoc(teamRef, { attendance: 'present', updatedAt: serverTimestamp() }, { merge: true });
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
  const [stateSnap, boardSnap] = await Promise.all([getDoc(stateRef), getDoc(boardRef)]);
  if (!stateSnap.exists()) {
    await setDoc(stateRef, {
      status: 'idle', season: DRAFT.season, lastCompletedSeason: DRAFT.season,
      boardCreated: false, orderSet: false, currentOverall: null, currentRound: null, currentPosition: null,
      currentTeamId: null, currentTeamName: null, lastPickOverall: 0, updatedAt: serverTimestamp()
    });
  } else if (typeof stateSnap.data().boardCreated !== 'boolean') {
    // Einmalige Migration aus der bisherigen Draft-State-Struktur.
    const oldState = stateSnap.data();
    const oldBoard = boardSnap.exists() ? boardSnap.data() : { teams: [], picks: {} };
    const hasTeams = (oldBoard.teams || []).filter(Boolean).length === DRAFT.teamCount;
    const pickCount = Object.keys(oldBoard.picks || {}).length;
    const next = getNextOpenSlot(oldBoard.picks || {});
    const year = Number(oldState.season || oldBoard.season || DRAFT.season);
    if (hasTeams && pickCount > 0 && !next) {
      await setDoc(doc(db, 'draftboard_archive', String(year)), {
        teamNames: oldBoard.teams || [], picks: oldBoard.picks || {}, teamCount: DRAFT.teamCount, roundCount: DRAFT.roundCount,
        archivedAt: serverTimestamp()
      }, { merge: true });
      await setDoc(stateRef, { status: 'complete', season: year, lastCompletedSeason: year, boardCreated: false, orderSet: false, updatedAt: serverTimestamp() }, { merge: true });
    } else {
      await setDoc(stateRef, {
        boardCreated: hasTeams || pickCount > 0, orderSet: hasTeams, status: hasTeams ? 'live' : 'idle', season: year, updatedAt: serverTimestamp()
      }, { merge: true });
    }
  }
  await setDoc(doc(db, COLLECTIONS.pickRequests, '_meta'), {
    schemaVersion: 3,
    purpose: 'Remote pick requests; numeric documents are created only when a team submits a remote pick.',
    updatedAt: serverTimestamp()
  }, { merge: true });
}



async function archiveCompletedSetupBeforeReset() {
  const [orderSnap, divSnap] = await Promise.all([getDoc(draftOrderRef), getDoc(divisionOrderRef)]);
  const jobs = [];

  if (orderSnap.exists()) {
    const data = orderSnap.data() || {};
    const year = Number(data.season);
    const hasCompleteOrder = Array.isArray(data.order) && data.order.filter(Boolean).length === DRAFT.teamCount;
    if (Number.isInteger(year) && hasCompleteOrder) {
      jobs.push(setDoc(doc(db, 'draftOrder_archive', String(year)), {
        ...data,
        archivedAt: serverTimestamp()
      }, { merge: true }));
    }
  }

  if (divSnap.exists()) {
    const data = divSnap.data() || {};
    const year = Number(data.season);
    const divisions = data.divisions || null;
    const hasCompleteDivisions = divisions && ['A','B','C','D'].every(k => Array.isArray(divisions[k]) && divisions[k].filter(Boolean).length === 5);
    if (Number.isInteger(year) && hasCompleteDivisions) {
      jobs.push(setDoc(doc(db, 'divisionOrder_archive', String(year)), {
        ...data,
        archivedAt: serverTimestamp()
      }, { merge: true }));
    }
  }

  if (jobs.length) await Promise.all(jobs);
}

export async function listDraftOrderArchiveSeasons() {
  const snap = await getDocs(collection(db, 'draftOrder_archive'));
  return snap.docs.map(d => Number(d.id)).filter(Number.isInteger).sort((a,b) => b-a);
}

export async function listDivisionArchiveSeasons() {
  const snap = await getDocs(collection(db, 'divisionOrder_archive'));
  return snap.docs.map(d => Number(d.id)).filter(Number.isInteger).sort((a,b) => b-a);
}

export async function getDraftOrderArchive(season) {
  const snap = await getDoc(doc(db, 'draftOrder_archive', String(season)));
  return snap.exists() ? snap.data() : null;
}

export async function getDivisionArchive(season) {
  const snap = await getDoc(doc(db, 'divisionOrder_archive', String(season)));
  return snap.exists() ? snap.data() : null;
}

export async function createNewDraft(season) {
  const year = Number(season);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('Ungültiges Draft-Jahr.');
  // Vor jedem Reset abgeschlossene Draft Order / Divisionen automatisch sichern.
  await archiveCompletedSetupBeforeReset();
  await setDoc(boardRef, { teams: Array(DRAFT.teamCount).fill(null), picks: {}, season: year, updatedAt: serverTimestamp() });
  await setDoc(stateRef, {
    status: 'setup', season: year, boardCreated: true, orderSet: false,
    currentOverall: null, currentRound: null, currentPosition: null,
    currentTeamId: null, currentTeamName: null, clockStartedAt: null,
    lastPickOverall: 0, autoPickForOverall: null, autoPickDueAt: null,
    updatedAt: serverTimestamp()
  }, { merge: true });
  await Promise.all([
    setDoc(draftOrderRef, { season: year, order: [], revealSequence: [], revealedCount: 0, status: 'empty', updatedAt: serverTimestamp() }),
    setDoc(divisionOrderRef, { season: year, divisions: null, revealSequence: [], revealedCount: 0, status: 'empty', updatedAt: serverTimestamp() })
  ]);
}

export async function setAttendance(teamId, attendance) {
  if (!['present', 'remote', 'absent'].includes(attendance)) throw new Error('Ungültiger Anwesenheitsstatus.');
  await setDoc(doc(db, COLLECTIONS.teams, teamId), { attendance, updatedAt: serverTimestamp() }, { merge: true });
}

export async function savePreferenceSheet(teamId, sheet) {
  await setDoc(doc(db, COLLECTIONS.sheets, teamId), { ...sheet, usesDefaultPlan: false, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveDraftOrder(order, season = null) {
  const clean = (order || []).filter(Boolean);
  if (clean.length !== DRAFT.teamCount || new Set(clean).size !== DRAFT.teamCount) throw new Error('Die Draft-Reihenfolge muss aus 20 eindeutigen Teams bestehen.');
  const stateSnap = await getDoc(stateRef);
  const state = stateSnap.exists() ? stateSnap.data() : {};
  if (!state.boardCreated) throw new Error('Zuerst ein neues Draft Board erzeugen.');
  const year = Number(season || state.season || DRAFT.season);
  await runTransaction(db, async tx => {
    tx.set(boardRef, { teams: clean, season: year, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(draftOrderRef, { season: year, order: clean, status: 'complete', revealedCount: DRAFT.teamCount, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(stateRef, {
      season: year, orderSet: true, status: 'live', currentOverall: 1, currentRound: 1, currentPosition: 1,
      currentTeamId: clean[0], currentTeamName: clean[0], clockStartedAt: Timestamp.now(), updatedAt: serverTimestamp()
    }, { merge: true });
  });
}

export async function prepareDraftOrderDraw(revealSequence, season) {
  await setDoc(draftOrderRef, { season, revealSequence, revealedCount: 0, order: [], status: 'drawing', updatedAt: serverTimestamp() });
}

export async function setDraftOrderRevealCount(count) {
  await setDoc(draftOrderRef, { revealedCount: count, updatedAt: serverTimestamp() }, { merge: true });
}

export async function prepareDivisionDraw(revealSequence, season) {
  await setDoc(divisionOrderRef, { season, revealSequence, revealedCount: 0, divisions: null, status: 'drawing', updatedAt: serverTimestamp() });
}

export async function setDivisionRevealCount(count) {
  await setDoc(divisionOrderRef, { revealedCount: count, updatedAt: serverTimestamp() }, { merge: true });
}

export async function saveDivisions(divisions, season) {
  await setDoc(divisionOrderRef, { season, divisions, status: 'complete', revealedCount: DRAFT.teamCount, drawnAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
}

export async function adminSetPick({ round, position, player, actorUid }) {
  const key = `${round}-${position}`;
  return runTransaction(db, async tx => {
    const [boardSnap, stateSnap] = await Promise.all([tx.get(boardRef), tx.get(stateRef)]);
    const board = boardSnap.exists() ? boardSnap.data() : { teams: [], picks: {} };
    const state = stateSnap.exists() ? stateSnap.data() : {};
    if (!state.boardCreated || !state.orderSet) throw new Error('Kein aktiver Draft mit festgelegter Reihenfolge.');
    const duplicateKey = Object.entries(board.picks || {}).find(([k,p]) => k !== key && p?.name?.toLowerCase() === player.name.toLowerCase());
    if (duplicateKey) throw new Error(`${player.name} wurde bereits gedraftet.`);

    const existingPick = board.picks?.[key];
    const next = getNextOpenSlot(board.picks || {});
    // Bestehende Picks dürfen korrigiert werden. Neue Picks müssen strikt der Reihe nach erfolgen.
    if (!existingPick && next?.key !== key) {
      throw new Error(`Pick #${next?.overall || 1} muss zuerst eingetragen werden.`);
    }

    const now = Timestamp.now();
    const isCurrent = next?.key === key;
    const started = isCurrent ? timestampMs(state.clockStartedAt) : null;

    // A correction of an already completed pick must not destroy its timing data.
    const pickedAt = existingPick?.pickedAt || now;
    const pickDurationSeconds = existingPick
      ? (existingPick.pickDurationSeconds ?? null)
      : (started ? Math.max(0, Math.round((now.toMillis() - started) / 1000)) : null);

    const pick = {
      playerId: player.id || null, name: player.name, position: player.position,
      nflTeam: player.nflTeam || player.team || '', pickedAt,
      pickDurationSeconds,
      source: 'admin', actorUid: actorUid || null
    };
    tx.update(boardRef, { [`picks.${key}`]: pick, updatedAt: serverTimestamp() });
    return pick;
  });
}

export async function adminDeletePick(round, position) {
  const key = `${round}-${position}`;
  await runTransaction(db, async tx => {
    const snap = await tx.get(boardRef);
    if (!snap.exists()) return;
    tx.update(boardRef, { [`picks.${key}`]: deleteField(), updatedAt: serverTimestamp() });
  });
}

export async function finalizeDraft() {
  const [boardSnap, stateSnap, orderSnap, divSnap] = await Promise.all([getDoc(boardRef), getDoc(stateRef), getDoc(draftOrderRef), getDoc(divisionOrderRef)]);
  if (!boardSnap.exists() || !stateSnap.exists()) throw new Error('Draftdaten fehlen.');
  const board = boardSnap.data();
  const state = stateSnap.data();
  const year = Number(state.season || board.season || DRAFT.season);
  if (!state.boardCreated) throw new Error('Kein aktives Draft Board vorhanden.');
  await setDoc(doc(db, 'draftboard_archive', String(year)), {
    teamNames: board.teams || [], picks: board.picks || {}, teamCount: DRAFT.teamCount, roundCount: DRAFT.roundCount,
    archivedAt: serverTimestamp()
  });
  if (orderSnap.exists()) await setDoc(doc(db, 'draftOrder_archive', String(year)), { ...orderSnap.data(), archivedAt: serverTimestamp() });
  if (divSnap.exists() && divSnap.data()?.divisions) await setDoc(doc(db, 'divisionOrder_archive', String(year)), { ...divSnap.data(), archivedAt: serverTimestamp() });
  await setDoc(stateRef, {
    status: 'complete', boardCreated: false, orderSet: false, lastCompletedSeason: year,
    currentOverall: null, currentRound: null, currentPosition: null, currentTeamId: null, currentTeamName: null,
    autoPickForOverall: null, autoPickDueAt: null, updatedAt: serverTimestamp()
  }, { merge: true });
  return year;
}

export async function submitPick({ teamId, player, source = 'remote', actorUid }) {
  return runTransaction(db, async tx => {
    const [boardSnap, stateSnap] = await Promise.all([tx.get(boardRef), tx.get(stateRef)]);
    const board = boardSnap.exists() ? boardSnap.data() : { teams: [], picks: {} };
    const state = stateSnap.exists() ? stateSnap.data() : {};
    if (!state.boardCreated || !state.orderSet || state.status !== 'live') throw new Error('Der Draft ist aktuell nicht für Picks freigegeben.');
    const next = getNextOpenSlot(board.picks || {});
    if (!next) throw new Error('Draft ist bereits beendet.');
    const currentTeamName = board.teams?.[next.position - 1];
    if (teamId !== currentTeamName) throw new Error('Dieses Team ist nicht on the clock.');
    const duplicate = Object.values(board.picks || {}).some(p => p?.name?.toLowerCase() === player.name.toLowerCase());
    if (duplicate) throw new Error(`${player.name} wurde bereits gedraftet.`);
    const now = Timestamp.now();
    const started = timestampMs(state.clockStartedAt);
    const pick = {
      playerId: player.id || null, name: player.name, position: player.position,
      nflTeam: player.nflTeam || player.team || '', pickedAt: now,
      pickDurationSeconds: started ? Math.max(0, Math.round((now.toMillis() - started) / 1000)) : null,
      source, actorUid: actorUid || null
    };
    const newPicks = { ...(board.picks || {}), [next.key]: pick };
    tx.set(boardRef, { picks: newPicks, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(stateRef, { lastPickOverall: next.overall, autoPickForOverall: null, autoPickDueAt: null, updatedAt: serverTimestamp() }, { merge: true });
    return { ...next, pick, teamName: currentTeamName };
  });
}

export async function reconcileDraftState(board) {
  const existing = await getDoc(stateRef);
  const state = existing.exists() ? existing.data() : {};
  if (!state.boardCreated) return;
  if (!state.orderSet) {
    await setDoc(stateRef, { status: 'setup', currentOverall: null, currentRound: null, currentPosition: null, currentTeamId: null, currentTeamName: null, updatedAt: serverTimestamp() }, { merge: true });
    return;
  }
  const next = getNextOpenSlot(board.picks || {});
  const picks = orderedPicks(board.picks || {});
  const last = picks.at(-1) || null;
  const currentTeamName = next ? board.teams?.[next.position - 1] || null : null;
  const changedPick = state.currentOverall !== (next?.overall ?? null);
  const clockStartedAt = next ? (changedPick ? (last?.pickedAt || Timestamp.now()) : (state.clockStartedAt || last?.pickedAt || Timestamp.now())) : null;
  await setDoc(stateRef, {
    status: next ? 'live' : 'complete',
    currentOverall: next?.overall ?? null, currentRound: next?.round ?? null, currentPosition: next?.position ?? null,
    currentTeamId: currentTeamName, currentTeamName, clockStartedAt,
    lastPickOverall: last?.overall ?? 0,
    ...(changedPick ? { autoPickForOverall: null, autoPickDueAt: null } : {}),
    updatedAt: serverTimestamp()
  }, { merge: true });
}

export async function acquireAdminLease(ownerId) {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef); const state = snap.exists() ? snap.data() : {};
    const now = Date.now(); const expires = timestampMs(state.adminLeaseUntil);
    if (state.adminOwner && state.adminOwner !== ownerId && expires && expires > now) return false;
    tx.set(stateRef, { adminOwner: ownerId, adminLeaseUntil: Timestamp.fromMillis(now + DRAFT.adminLeaseMs) }, { merge: true });
    return true;
  });
}
export async function renewAdminLease(ownerId) {
  return runTransaction(db, async tx => {
    const snap = await tx.get(stateRef); const state = snap.exists() ? snap.data() : {};
    if (state.adminOwner !== ownerId) return false;
    tx.set(stateRef, { adminLeaseUntil: Timestamp.fromMillis(Date.now() + DRAFT.adminLeaseMs) }, { merge: true });
    return true;
  });
}
export async function setAutoPickDue(overall, dueMs) { await setDoc(stateRef, { autoPickForOverall: overall, autoPickDueAt: dueMs ? Timestamp.fromMillis(dueMs) : null }, { merge: true }); }
export async function requestRemotePick({ teamId, player, actorUid, overall }) { await setDoc(doc(db, COLLECTIONS.pickRequests, String(overall)), { teamId, player, actorUid, overall, status: 'pending', createdAt: serverTimestamp() }); }
export async function getPickRequest(overall) { const ref = doc(db, COLLECTIONS.pickRequests, String(overall)); const s = await getDoc(ref); return s.exists() ? { ref, ...s.data() } : null; }
export async function markPickRequest(ref, status, error = null) { await setDoc(ref, { status, error, processedAt: serverTimestamp() }, { merge: true }); }
export function timestampMs(ts) { if (!ts) return null; if (typeof ts === 'number') return ts; if (typeof ts.toMillis === 'function') return ts.toMillis(); if (typeof ts.seconds === 'number') return ts.seconds * 1000; return null; }
