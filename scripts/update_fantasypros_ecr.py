#!/usr/bin/env python3
import datetime
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

YEAR = int(os.environ.get('DRAFT_YEAR', datetime.datetime.now(datetime.timezone.utc).year))
API_KEY = os.environ.get('FANTASYPROS_API_KEY', '').strip().strip('"').strip("'")
API_ROOT = 'https://api.fantasypros.com/public/v2/json/nfl'
POSITIONS = ('QB', 'RB', 'WR', 'TE', 'K', 'DST')
REQUEST_DELAY_SECONDS = 1.1  # stay below FantasyPros' 1 request/second limit

if not API_KEY:
    raise SystemExit('Missing GitHub Actions secret FANTASYPROS_API_KEY')


def request_json(url, label):
    req = urllib.request.Request(
        url,
        headers={
            'x-api-key': API_KEY,
            'Accept': 'application/json',
            'User-Agent': 'BembelBowl/4.2',
        },
    )
    print(f'FantasyPros request [{label}]: {url}')
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            raw = response.read().decode('utf-8', errors='replace')
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace')
        print(f'FantasyPros HTTP {exc.code}: {exc.reason}', file=sys.stderr)
        print(f'Failed request [{label}]: {url}', file=sys.stderr)
        print('FantasyPros response body:', file=sys.stderr)
        print(body[:4000] or '<empty response body>', file=sys.stderr)
        raise SystemExit(1)
    except urllib.error.URLError as exc:
        raise SystemExit(f'FantasyPros network error [{label}]: {exc.reason}')
    except json.JSONDecodeError as exc:
        raise SystemExit(f'FantasyPros returned invalid JSON [{label}]: {exc}')


def int_or_none(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def norm_pos(value):
    value = str(value or '').upper()
    if value in ('DST', 'D/ST', 'DEF'):
        return 'DEF'
    if value == 'PK':
        return 'K'
    return value


def name_key(value):
    return re.sub(r'[^a-z0-9]', '', str(value or '').lower())


def extract_position_rank(item):
    rank = int_or_none(item.get('rank_ecr'))
    if rank is not None:
        return rank
    pos_rank = str(item.get('pos_rank') or '')
    match = re.search(r'(\d+)$', pos_rank)
    return int(match.group(1)) if match else None


print(f'API key detected: yes (length {len(API_KEY)}, last 4: {API_KEY[-4:] if len(API_KEY) >= 4 else "****"})')
print('Plan: 1 players request + 6 position ECR requests = 7 requests/run.')

# 1) Player directory supplies the cross-position PPR ECR when available.
players_url = f'{API_ROOT}/players?' + urllib.parse.urlencode({'show': 'pos_rank'})
players_payload = request_json(players_url, 'players')
raw_directory = players_payload.get('players')
if not isinstance(raw_directory, list):
    raise SystemExit('FantasyPros /nfl/players response does not contain a players array.')

by_fp_id = {}
by_name = {}
for item in raw_directory:
    fp_id = item.get('player_id')
    pos = norm_pos(item.get('position_id'))
    if pos not in {'QB', 'RB', 'WR', 'TE', 'K', 'DEF'}:
        continue
    record = {
        'fp_player_id': str(fp_id) if fp_id is not None else None,
        'name': item.get('player_name') or '',
        'position': pos,
        'team': item.get('team_id') or '',
        'bye_week': item.get('bye_week') or item.get('player_bye_week'),
        'overall_ecr': int_or_none(item.get('rank_ecr_ppr')),
        'position_ecr': None,
        'tier': None,
        'pos_rank': item.get('pos_rank'),
    }
    if record['fp_player_id']:
        by_fp_id[record['fp_player_id']] = record
    if record['name']:
        by_name[name_key(record['name'])] = record

# 2) Position endpoints fill complete positional ECRs. This avoids unsupported position=ALL.
position_meta = {}
for index, api_position in enumerate(POSITIONS):
    if index or raw_directory:
        time.sleep(REQUEST_DELAY_SECONDS)
    query = urllib.parse.urlencode({'position': api_position, 'scoring': 'PPR'})
    url = f'{API_ROOT}/{YEAR}/consensus-rankings?{query}'
    payload = request_json(url, api_position)
    raw_players = payload.get('players')
    if not isinstance(raw_players, list):
        raise SystemExit(f'FantasyPros {api_position} response does not contain a players array.')
    position_meta[api_position] = {
        'count': len(raw_players),
        'totalExperts': int_or_none(payload.get('total_experts')),
        'lastUpdated': payload.get('last_updated'),
    }

    for item in raw_players:
        fp_id_raw = item.get('player_id')
        fp_id = str(fp_id_raw) if fp_id_raw is not None else None
        name = item.get('player_name') or ''
        pos = norm_pos(item.get('player_position_id') or api_position)
        existing = by_fp_id.get(fp_id) if fp_id else None
        if existing is None and name:
            existing = by_name.get(name_key(name))
        if existing is None:
            existing = {
                'fp_player_id': fp_id,
                'name': name,
                'position': pos,
                'team': item.get('player_team_id') or '',
                'bye_week': item.get('player_bye_week'),
                'overall_ecr': None,
                'position_ecr': None,
                'tier': None,
                'pos_rank': item.get('pos_rank'),
            }
            if fp_id:
                by_fp_id[fp_id] = existing
            if name:
                by_name[name_key(name)] = existing

        existing['name'] = existing.get('name') or name
        existing['position'] = pos or existing.get('position')
        existing['team'] = item.get('player_team_id') or existing.get('team') or ''
        existing['bye_week'] = item.get('player_bye_week') or existing.get('bye_week')
        existing['position_ecr'] = extract_position_rank(item)
        existing['tier'] = int_or_none(item.get('tier')) or existing.get('tier')
        existing['pos_rank'] = item.get('pos_rank') or existing.get('pos_rank')

# Deduplicate records by FP id/name and require a positional ECR from the consensus endpoints.
unique = {}
for record in list(by_fp_id.values()) + list(by_name.values()):
    if not record.get('name') or record.get('position_ecr') is None:
        continue
    dedupe_key = record.get('fp_player_id') or f"{name_key(record['name'])}|{record.get('position')}"
    unique[dedupe_key] = record

players = list(unique.values())
players.sort(key=lambda p: (
    p.get('overall_ecr') is None,
    p.get('overall_ecr') if p.get('overall_ecr') is not None else 99999,
    p.get('position_ecr') if p.get('position_ecr') is not None else 99999,
    p.get('name') or '',
))

# Helpful diagnostics for the Actions log.
counts = {}
missing_overall = 0
for p in players:
    counts[p['position']] = counts.get(p['position'], 0) + 1
    if p.get('overall_ecr') is None:
        missing_overall += 1
print('Position counts:', json.dumps(counts, sort_keys=True))
print(f'Players without cross-position rank_ecr_ppr (kept for position filters): {missing_overall}')

output = {
    'source': 'FantasyPros Expert Consensus Rankings (ECR)',
    'format': 'PPR',
    'year': YEAR,
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'requestCount': 1 + len(POSITIONS),
    'positionMeta': position_meta,
    'players': players,
}

pathlib.Path('data').mkdir(exist_ok=True)
outfile = pathlib.Path('data/fantasypros-ecr.json')
outfile.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'wrote {len(players)} FantasyPros ECR entries to {outfile}')
