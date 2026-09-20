import { DRAFT } from './config.js';

export function pickNumber(round, position, teamCount = DRAFT.teamCount) {
  return round % 2 === 1
    ? (round - 1) * teamCount + position
    : (round - 1) * teamCount + (teamCount - position + 1);
}

export function slotForOverall(overall, teamCount = DRAFT.teamCount) {
  const round = Math.floor((overall - 1) / teamCount) + 1;
  const inRound = ((overall - 1) % teamCount) + 1;
  const position = round % 2 === 1 ? inRound : teamCount - inRound + 1;
  return { round, position, key: `${round}-${position}`, overall };
}

export function getNextOpenSlot(picks = {}) {
  const max = DRAFT.teamCount * DRAFT.roundCount;
  for (let overall = 1; overall <= max; overall++) {
    const slot = slotForOverall(overall);
    if (!picks[slot.key]) return slot;
  }
  return null;
}

export function orderedPicks(picks = {}) {
  return Object.entries(picks)
    .map(([key, pick]) => {
      const [round, position] = key.split('-').map(Number);
      return { ...pick, key, round, position, overall: pickNumber(round, position) };
    })
    .sort((a, b) => a.overall - b.overall);
}

export function normalizePosition(pos) {
  const p = String(pos || '').toUpperCase();
  if (p === 'PK') return 'K';
  if (p === 'DST' || p === 'D/ST' || p === 'DEFENSE') return 'DEF';
  return p;
}

export function teamNeeds(teamPicks = []) {
  const counts = Object.fromEntries(DRAFT.positions.map(p => [p, 0]));
  teamPicks.forEach(p => { const pos = normalizePosition(p.position); if (pos in counts) counts[pos]++; });
  const l = DRAFT.starterLimits;
  const needs = [];
  for (const pos of ['QB','RB','WR','TE','K','DEF']) {
    const target = l[pos] || 0;
    if (counts[pos] < target) needs.push({ position: pos, missing: target - counts[pos], priority: 3 });
  }
  const flexEligible = counts.RB + counts.WR + counts.TE;
  const baseSkill = l.RB + l.WR + l.TE;
  if (flexEligible < baseSkill + l.FLEX) needs.push({ position: 'FLEX', missing: 1, priority: 2 });
  return { counts, needs };
}

export function positionsForPlan(planPos) {
  return planPos === 'FLEX' ? ['RB','WR','TE'] : [normalizePosition(planPos)];
}
