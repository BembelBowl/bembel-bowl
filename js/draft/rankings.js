let rankings = [];
let byName = new Map();
let meta = {};

function key(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function loadRankings(url = './data/adp-ppr.json') {
  const res = await fetch(`${url}?v=${Date.now()}`);
  if (!res.ok) throw new Error(`Rankings HTTP ${res.status}`);
  const data = await res.json();
  meta = {
    source: data.source || 'ADP',
    format: data.format || '',
    year: data.year || null,
    updatedAt: data.updatedAt || null
  };
  rankings = (data.players || data).map((p, i) => ({
    rank: Number(p.rank || p.overall_rank || i + 1),
    adp: Number(p.adp || p.rank || i + 1),
    name: p.name,
    position: p.position === 'PK' ? 'K' : p.position,
    team: p.team || '',
    bye: p.bye_week || p.bye || null
  }));
  byName = new Map(rankings.map(p => [key(p.name), p]));
  return rankings;
}

export function rankingMeta() { return { ...meta }; }
export function rankForPlayer(name) { return byName.get(key(name)) || null; }

export function bestAvailable(pickedNames, count = 10, positions = null) {
  const picked = new Set([...pickedNames].map(key));
  const allowed = positions ? new Set(positions) : null;
  return rankings.filter(p => !picked.has(key(p.name)) && (!allowed || allowed.has(p.position))).slice(0, count);
}

export function mergeRanking(player) {
  const r = rankForPlayer(player.name);
  return { ...player, ecr: r?.rank ?? null, adp: r?.adp ?? null, bye: r?.bye ?? null };
}
