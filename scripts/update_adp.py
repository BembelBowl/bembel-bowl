#!/usr/bin/env python3
import json, urllib.request, datetime, pathlib
YEAR = datetime.datetime.utcnow().year
URL = f"https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=14&year={YEAR}"
req = urllib.request.Request(URL, headers={'User-Agent': 'BembelBowl/1.0 (+GitHub Pages fantasy league)'})
with urllib.request.urlopen(req, timeout=30) as r:
    data = json.load(r)
players = []
for i,p in enumerate(data.get('players', []), 1):
    players.append({
        'rank': i,
        'name': p.get('name'),
        'position': 'K' if p.get('position') == 'PK' else p.get('position'),
        'team': p.get('team') or '',
        'adp': p.get('adp') or i,
        'bye_week': p.get('bye') or p.get('bye_week')
    })
out = {'source': 'Fantasy Football Calculator ADP', 'format': 'PPR', 'year': YEAR, 'updatedAt': datetime.datetime.utcnow().isoformat()+'Z', 'players': players}
pathlib.Path('data').mkdir(exist_ok=True)
pathlib.Path('data/adp-ppr.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'wrote {len(players)} players')
