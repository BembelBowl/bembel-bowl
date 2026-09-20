#!/usr/bin/env python3
import datetime
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

YEAR = int(os.environ.get('DRAFT_YEAR', datetime.datetime.now(datetime.timezone.utc).year))
API_KEY = os.environ.get('FANTASYPROS_API_KEY', '').strip().strip('"').strip("'")
BASE = f'https://api.fantasypros.com/public/v2/json/nfl/{YEAR}/consensus-rankings'

if not API_KEY:
    raise SystemExit('Missing GitHub Actions secret FANTASYPROS_API_KEY')


def fetch_ecr():
    # FantasyPros documents position as the only required parameter.
    # One ALL request already contains player position + pos_rank, so separate
    # QB/RB/WR/TE/K/DST requests are unnecessary and consume extra quota.
    query = urllib.parse.urlencode({
        'position': 'ALL',
        'scoring': 'PPR',
    })
    url = f'{BASE}?{query}'
    req = urllib.request.Request(
        url,
        headers={
            'x-api-key': API_KEY,
            'Accept': 'application/json',
            'User-Agent': 'BembelBowl/4.1',
        },
    )

    print(f'FantasyPros request: {BASE}?position=ALL&scoring=PPR')
    print(f'API key detected: yes (length {len(API_KEY)}, last 4: {API_KEY[-4:] if len(API_KEY) >= 4 else "****"})')

    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read().decode('utf-8', errors='replace')
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        print(f'FantasyPros HTTP {exc.code}: {exc.reason}', file=sys.stderr)
        print('FantasyPros response body:', file=sys.stderr)
        print(body[:4000] or '<empty response body>', file=sys.stderr)
        print('\nChecks:', file=sys.stderr)
        print('1. GitHub secret must be named exactly FANTASYPROS_API_KEY.', file=sys.stderr)
        print('2. Paste only the key value, without quotes or "Bearer ".', file=sys.stderr)
        print(f'3. Confirm the key has access to NFL {YEAR} consensus-rankings.', file=sys.stderr)
        print('4. Confirm the FantasyPros key is activated, not only requested.', file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as exc:
        raise SystemExit(f'FantasyPros network error: {exc.reason}')


def norm_pos(value):
    value = str(value or '').upper()
    if value in ('DST', 'D/ST', 'DEF'):
        return 'DEF'
    if value == 'PK':
        return 'K'
    return value


def int_or_none(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def position_rank(player, position):
    # ALL ECR responses expose pos_rank such as RB1, QB7, DST3.
    raw = str(player.get('pos_rank') or '')
    match = re.search(r'(\d+)$', raw)
    if match:
        return int(match.group(1))

    # Fallback only for unusual API responses.
    return None


data = fetch_ecr()
players_raw = data.get('players')
if not isinstance(players_raw, list):
    print('Unexpected FantasyPros payload:', json.dumps(data, ensure_ascii=False)[:4000], file=sys.stderr)
    raise SystemExit('FantasyPros response does not contain a players array.')

players = []
for item in players_raw:
    position = norm_pos(item.get('player_position_id') or item.get('position_id'))
    if position not in {'QB', 'RB', 'WR', 'TE', 'K', 'DEF'}:
        continue

    overall = int_or_none(item.get('rank_ecr'))
    if overall is None:
        continue

    player_id = item.get('player_id')
    players.append({
        'fp_player_id': str(player_id) if player_id is not None else None,
        'name': item.get('player_name') or '',
        'position': position,
        'team': item.get('player_team_id') or '',
        'bye_week': item.get('player_bye_week'),
        'ecr': overall,
        'overall_ecr': overall,
        'position_ecr': position_rank(item, position),
        'tier': int_or_none(item.get('tier')),
        'pos_rank': item.get('pos_rank'),
    })

players = [p for p in players if p['name']]
players.sort(key=lambda p: (p['overall_ecr'], p['name']))

output = {
    'source': 'FantasyPros Expert Consensus Rankings (ECR)',
    'format': data.get('scoring') or 'PPR',
    'year': int_or_none(data.get('year')) or YEAR,
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'apiLastUpdated': data.get('last_updated'),
    'totalExperts': int_or_none(data.get('total_experts')),
    'players': players,
}

pathlib.Path('data').mkdir(exist_ok=True)
outfile = pathlib.Path('data/fantasypros-ecr.json')
outfile.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'wrote {len(players)} FantasyPros ECR entries to {outfile}')
