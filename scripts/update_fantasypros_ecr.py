#!/usr/bin/env python3
import os, json, urllib.request, urllib.parse, datetime, pathlib

YEAR = int(os.environ.get('DRAFT_YEAR', datetime.datetime.now(datetime.timezone.utc).year))
API_KEY = os.environ.get('FANTASYPROS_API_KEY', '').strip()
BASE = f'https://api.fantasypros.com/public/v2/json/nfl/{YEAR}/consensus-rankings'
POSITIONS = ['ALL','QB','RB','WR','TE','K','DST']

if not API_KEY:
    raise SystemExit('Missing GitHub Actions secret FANTASYPROS_API_KEY')

def fetch(position):
    q = urllib.parse.urlencode({'position': position, 'scoring': 'PPR'})
    req = urllib.request.Request(f'{BASE}?{q}', headers={'x-api-key': API_KEY, 'User-Agent': 'BembelBowl/4.0'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)

def norm_pos(p):
    return 'DEF' if p in ('DST','D/ST') else ('K' if p == 'PK' else p)

rows = {}
api_updated = []
expert_counts = []
for position in POSITIONS:
    data = fetch(position)
    if data.get('last_updated'): api_updated.append(str(data['last_updated']))
    if data.get('total_experts') is not None:
        try: expert_counts.append(int(data['total_experts']))
        except: pass
    for x in data.get('players', []):
        pid = str(x.get('player_id') or '')
        if not pid: continue
        pos = norm_pos(x.get('player_position_id') or x.get('position_id') or position)
        if pos not in {'QB','RB','WR','TE','K','DEF'}: continue
        r = rows.setdefault(pid, {
            'fp_player_id': pid,
            'name': x.get('player_name') or '',
            'position': pos,
            'team': x.get('player_team_id') or '',
            'bye_week': x.get('player_bye_week'),
            'ecr': None,
            'overall_ecr': None,
            'position_ecr': None,
            'tier': x.get('tier')
        })
        try: rank = int(float(x.get('rank_ecr')))
        except (TypeError, ValueError): rank = None
        if position == 'ALL':
            r['overall_ecr'] = rank
            r['ecr'] = rank
        else:
            r['position_ecr'] = rank
            if r['ecr'] is None: r['ecr'] = rank
        if not r['name']: r['name'] = x.get('player_name') or ''
        if not r['team']: r['team'] = x.get('player_team_id') or ''
        if not r['bye_week']: r['bye_week'] = x.get('player_bye_week')
        if r['tier'] is None: r['tier'] = x.get('tier')

players = [p for p in rows.values() if p['name']]
players.sort(key=lambda p: (p['overall_ecr'] is None, p['overall_ecr'] or 99999, p['position_ecr'] or 99999, p['name']))
out = {
    'source': 'FantasyPros Expert Consensus Rankings (ECR)',
    'format': 'PPR',
    'year': YEAR,
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
    'apiLastUpdated': max(api_updated) if api_updated else None,
    'totalExperts': max(expert_counts) if expert_counts else None,
    'players': players
}
pathlib.Path('data').mkdir(exist_ok=True)
pathlib.Path('data/fantasypros-ecr.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'wrote {len(players)} FantasyPros ECR entries')
