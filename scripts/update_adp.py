#!/usr/bin/env python3
import json, urllib.request, urllib.parse, datetime, pathlib, re

YEAR = datetime.datetime.now(datetime.timezone.utc).year
FFC_BASE = 'https://fantasyfootballcalculator.com/api/v1/adp/ppr'
SLEEPER = 'https://api.sleeper.app/v1/players/nfl?active=true'
POSITIONS = [('ALL', None), ('QB','QB'), ('RB','RB'), ('WR','WR'), ('TE','TE'), ('K','PK'), ('DEF','DEF')]
HEADERS = {'User-Agent': 'BembelBowl/2.0 (+GitHub Pages fantasy league)'}

def get_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)

def norm(s):
    return re.sub(r'[^a-z0-9]', '', str(s or '').lower())

def ffc_url(position=None):
    q = {'teams': 14, 'year': YEAR}
    if position: q['position'] = position
    return FFC_BASE + '?' + urllib.parse.urlencode(q)

# Sleeper is the source of truth for current/active player eligibility.
sleeper_raw = get_json(SLEEPER)
active = []
by_name = {}
by_team_pos = {}
for pid, p in sleeper_raw.items():
    pos = 'K' if p.get('position') == 'PK' else p.get('position')
    if pos not in {'QB','RB','WR','TE','K','DEF'}:
        continue
    if not (p.get('active') is True or str(p.get('status','')).lower() == 'active'):
        continue
    team = p.get('team') or ''
    name = p.get('full_name') or (f'{team} Defense' if pos == 'DEF' and team else '')
    if not name:
        continue
    obj = {
        'player_id': str(p.get('player_id') or pid), 'name': name, 'position': pos, 'team': team,
        'fallback_rank': p.get('search_rank') if isinstance(p.get('search_rank'), (int,float)) else None,
        'adp': None, 'bye_week': None, 'rank_source': None
    }
    active.append(obj)
    by_name[norm(name)] = obj
    if team: by_team_pos[(team, pos)] = obj

# Fetch overall plus every relevant position. This improves coverage for K/DEF and deeper QBs.
ffc_rows = []
errors = []
for label, api_pos in POSITIONS:
    try:
        data = get_json(ffc_url(api_pos))
        ffc_rows.extend(data.get('players', []))
    except Exception as exc:
        errors.append(f'{label}: {exc}')

seen = set()
for p in ffc_rows:
    pos = 'K' if p.get('position') == 'PK' else p.get('position')
    if pos not in {'QB','RB','WR','TE','K','DEF'}:
        continue
    team = p.get('team') or ''
    target = by_name.get(norm(p.get('name')))
    if not target and team:
        target = by_team_pos.get((team, pos))
    if not target:
        continue  # never re-introduce a player Sleeper does not mark active
    try:
        adp = float(p.get('adp'))
    except (TypeError, ValueError):
        adp = None
    if adp is not None and (target['adp'] is None or adp < target['adp']):
        target['adp'] = adp
        target['bye_week'] = p.get('bye') or p.get('bye_week')
        target['rank_source'] = 'Fantasy Football Calculator ADP'

# ADP first. Active players with no FFC ADP are retained only as a deep fallback, ordered by Sleeper search rank.
def order(x):
    if x['adp'] is not None: return (0, x['adp'], x['fallback_rank'] or 999999)
    return (1, x['fallback_rank'] or 999999, x['name'])
active.sort(key=order)
for i, p in enumerate(active, 1):
    p['rank'] = i
    if not p['rank_source']:
        p['rank_source'] = 'Sleeper active fallback'

out = {
    'source': 'Fantasy Football Calculator ADP + Sleeper active-player validation',
    'registry': 'Sleeper NFL players active=true',
    'format': 'PPR', 'year': YEAR,
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),
    'fetchWarnings': errors,
    'players': active
}
pathlib.Path('data').mkdir(exist_ok=True)
pathlib.Path('data/adp-ppr.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'wrote {len(active)} active players; {sum(1 for p in active if p["adp"] is not None)} with FFC ADP')
if errors: print('warnings:', ' | '.join(errors))
