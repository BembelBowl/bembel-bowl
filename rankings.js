let rankings = [];
let byName = new Map();
let byId = new Map();
let meta = {};

function key(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

export async function loadRankings(url = './data/adp-ppr.json') {
  const res = await fetch(`${url}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`Rankings HTTP ${res.status}`);
  const data = await res.json();
  meta = {
    source: data.source || 'ADP',
    format: data.format || '',
    year: data.year || null,
    updatedAt: data.updatedAt || null,
    registry: data.registry || ''
  };
  rankings = (data.players || data).map((p, i) => ({
    rank: Number(p.rank || p.overall_rank || i + 1),
    adp: Number.isFinite(Number(p.adp)) ? Number(p.adp) : null,
    fallbackRank: Number.isFinite(Number(p.fallback_rank)) ? Number(p.fallback_rank) : null,
    playerId: p.player_id ? String(p.player_id) : null,
    name: p.name,
    position: p.position === 'PK' ? 'K' : p.position,
    team: p.team || '',
    bye: p.bye_week || p.bye || null,
    rankSource: p.rank_source || (p.adp ? 'FFC ADP' : 'Sleeper active rank')
  }));
  byName = new Map(rankings.map(p => [key(p.name), p]));
  byId = new Map(rankings.filter(p => p.playerId).map(p => [p.playerId, p]));
  return rankings;
}

export function rankingMeta() { return { ...meta }; }
export function rankForPlayer(playerOrName) {
  if (typeof playerOrName === 'object' && playerOrName) {
    return byId.get(String(playerOrName.id || '')) || byName.get(key(playerOrName.name)) || null;
  }
  return byName.get(key(playerOrName)) || null;
}

export function mergeRanking(player) {
  const r = rankForPlayer(player);
  const fallback = r?.fallbackRank ?? player.searchRank ?? null;
  const sortRank = r?.adp ?? fallback ?? 99999;
  return {
    ...player,
    ecr: r?.rank ?? fallback,
    adp: r?.adp ?? null,
    bye: r?.bye ?? null,
    rankSource: r?.rankSource || (fallback != null ? 'Sleeper active rank' : 'Unranked'),
    sortRank
  };
}
