import { normalizePosition } from './model.js';

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nfl?active=true';
let cache = null;

export async function loadSleeperPlayers() {
  if (cache) return cache;
  const res = await fetch(SLEEPER_URL);
  if (!res.ok) throw new Error(`Sleeper HTTP ${res.status}`);
  const raw = await res.json();
  cache = Object.values(raw).map(p => ({
    id: p.player_id,
    name: p.full_name || (normalizePosition(p.position) === 'DEF' ? `${p.team || p.player_id} Defense` : ''),
    position: normalizePosition(p.position),
    nflTeam: p.team || '',
    status: p.status || '',
    active: p.active === true || String(p.status || '').toLowerCase() === 'active',
    searchRank: Number.isFinite(Number(p.search_rank)) ? Number(p.search_rank) : null,
    search: [p.full_name, p.first_name, p.last_name, p.team, p.position].filter(Boolean).join(' ').toLowerCase(),
    // Full-size Sleeper image; the UI still falls back to the local silhouette on 404.
    headshot: p.player_id && normalizePosition(p.position) !== 'DEF' ? `https://sleepercdn.com/content/nfl/players/${p.player_id}.jpg` : ''
  })).filter(p => p.active && p.name && ['QB','RB','WR','TE','K','DEF'].includes(p.position));
  return cache;
}
