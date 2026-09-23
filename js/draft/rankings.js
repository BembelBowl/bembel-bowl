let rankings = [];
let byName = new Map();
let byTeamPos = new Map();
let meta = {};

function key(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+(?:jr|sr|ii|iii|iv|v)$/i, '')
    .replace(/[^a-z0-9]/g, '');
}
function posKey(team, position) { return `${String(team || '').toUpperCase()}|${position === 'DST' ? 'DEF' : position}`; }
function normPos(pos) { return pos === 'DST' || pos === 'D/ST' ? 'DEF' : (pos === 'PK' ? 'K' : pos); }

export async function loadRankings(url = './data/fantasypros-ecr.json') {
  const res = await fetch(`${url}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`FantasyPros ECR HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.players) || !data.players.length) throw new Error('FantasyPros ECR enthält noch keine Spieler. GitHub Action ausführen.');
  meta = {
    source: data.source || 'FantasyPros ECR',
    format: data.format || 'PPR',
    year: data.year || null,
    updatedAt: data.updatedAt || null,
    apiLastUpdated: data.apiLastUpdated || null,
    experts: data.totalExperts || null
  };
  rankings = data.players.map((p, i) => ({
    rank: Number(p.overall_ecr ?? p.ecr ?? (10000 + Number(p.position_ecr || i + 1))),
    ecr: Number.isFinite(Number(p.ecr)) ? Number(p.ecr) : null,
    overallEcr: Number.isFinite(Number(p.overall_ecr)) ? Number(p.overall_ecr) : null,
    positionEcr: Number.isFinite(Number(p.position_ecr)) ? Number(p.position_ecr) : null,
    fpPlayerId: p.fp_player_id ? String(p.fp_player_id) : null,
    name: p.name,
    position: normPos(p.position),
    team: p.team || '',
    bye: p.bye_week || null,
    tier: p.tier ?? null,
    rankSource: 'FantasyPros ECR'
  }));
  byName = new Map(rankings.map(p => [key(p.name), p]));
  byTeamPos = new Map(rankings.filter(p => p.team).map(p => [posKey(p.team, p.position), p]));
  return rankings;
}

export function rankingMeta() { return { ...meta }; }

export function rankForPlayer(playerOrName) {
  if (typeof playerOrName === 'object' && playerOrName) {
    return byName.get(key(playerOrName.name)) || byTeamPos.get(posKey(playerOrName.nflTeam || playerOrName.team, normPos(playerOrName.position))) || null;
  }
  return byName.get(key(playerOrName)) || null;
}

export function mergeRanking(player) {
  const r = rankForPlayer(player);
  const sortRank = r?.overallEcr ?? (r?.positionEcr != null ? 10000 + r.positionEcr : 99999);
  return {
    ...player,
    ecr: r?.overallEcr ?? r?.ecr ?? null,
    positionEcr: r?.positionEcr ?? null,
    bye: r?.bye ?? null,
    tier: r?.tier ?? null,
    hasRanking: !!r,
    rankSource: r ? 'FantasyPros ECR' : 'Unranked',
    sortRank
  };
}

export function bestAvailable(pickedNames = new Set(), limit = 10, positions = null) {
  const picked = new Set([...pickedNames].map(n => key(n)));
  const allowed = positions?.length ? new Set(positions.map(normPos)) : null;
  const list = rankings.filter(p => !picked.has(key(p.name)) && (!allowed || allowed.has(p.position)));
  list.sort((a, b) => {
    if (allowed) {
      const ar = a.positionEcr ?? a.overallEcr ?? 99999;
      const br = b.positionEcr ?? b.overallEcr ?? 99999;
      return ar - br || (a.overallEcr ?? 99999) - (b.overallEcr ?? 99999) || a.name.localeCompare(b.name);
    }
    return (a.overallEcr ?? 99999) - (b.overallEcr ?? 99999) || (a.positionEcr ?? 99999) - (b.positionEcr ?? 99999) || a.name.localeCompare(b.name);
  });
  return list.slice(0, limit);
}
