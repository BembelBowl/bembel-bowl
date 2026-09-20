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

export function concreteTeamNeeds(teamPicks = []) {
  const { counts } = teamNeeds(teamPicks);
  const l = DRAFT.starterLimits;
  const result = [];

  for (const position of ['QB','RB','WR','TE','K','DEF']) {
    if (Number(counts[position] || 0) < Number(l[position] || 0)) result.push(position);
  }

  const baseSkillTarget = Number(l.RB || 0) + Number(l.WR || 0) + Number(l.TE || 0);
  const skillCount = Number(counts.RB || 0) + Number(counts.WR || 0) + Number(counts.TE || 0);
  const flexTarget = Number(l.FLEX || 0);
  if (flexTarget > 0 && skillCount < baseSkillTarget + flexTarget) {
    const flexNeed = ['RB','WR','TE']
      .map(position => ({ position, ratio: Number(counts[position] || 0) / Math.max(1, Number(l[position] || 1)) }))
      .sort((a,b) => a.ratio - b.ratio || ['RB','WR','TE'].indexOf(a.position) - ['RB','WR','TE'].indexOf(b.position))[0].position;
    if (!result.includes(flexNeed)) result.push(flexNeed);
  }

  return result;
}

export function primaryTeamNeed(teamPicks = []) {
  const { counts } = teamNeeds(teamPicks);
  const l = DRAFT.starterLimits;

  // First cover real starting-lineup holes. Score by proportional shortage, then
  // by lineup importance/depth so RB/WR win sensible ties early in the draft.
  const tieOrder = ['RB', 'WR', 'QB', 'TE', 'DEF', 'K'];
  const missingStarters = tieOrder
    .map(position => {
      const target = Number(l[position] || 0);
      const have = Number(counts[position] || 0);
      const missing = Math.max(0, target - have);
      const shortage = target ? missing / target : 0;
      return { position, target, have, missing, shortage };
    })
    .filter(x => x.missing > 0)
    .sort((a, b) => b.shortage - a.shortage || tieOrder.indexOf(a.position) - tieOrder.indexOf(b.position));

  if (missingStarters.length) return missingStarters[0].position;

  // If the base lineup is complete but FLEX still needs to be filled, choose an
  // actual eligible position instead of returning a generic FLEX label. Prefer
  // the thinnest RB/WR/TE room relative to its normal starter requirement.
  const flexTarget = Number(l.FLEX || 0);
  const baseSkillTarget = Number(l.RB || 0) + Number(l.WR || 0) + Number(l.TE || 0);
  const skillCount = Number(counts.RB || 0) + Number(counts.WR || 0) + Number(counts.TE || 0);
  if (flexTarget > 0 && skillCount < baseSkillTarget + flexTarget) {
    const eligible = ['RB', 'WR', 'TE']
      .map(position => {
        const base = Math.max(1, Number(l[position] || 1));
        return { position, depthRatio: Number(counts[position] || 0) / base };
      })
      .sort((a, b) => a.depthRatio - b.depthRatio || ['RB','WR','TE'].indexOf(a.position) - ['RB','WR','TE'].indexOf(b.position));
    return eligible[0].position;
  }

  // Once all starting requirements are met, recommend useful depth based on the
  // thinnest skill-position room rather than a generic DEPTH/FLEX tag.
  return ['RB', 'WR', 'TE', 'QB']
    .map(position => {
      const base = Math.max(1, Number(l[position] || 1));
      return { position, depthRatio: Number(counts[position] || 0) / base };
    })
    .sort((a, b) => a.depthRatio - b.depthRatio || ['RB','WR','TE','QB'].indexOf(a.position) - ['RB','WR','TE','QB'].indexOf(b.position))[0].position;
}

export function positionsForPlan(planPos) {
  return planPos === 'FLEX' ? ['RB','WR','TE'] : [normalizePosition(planPos)];
}
