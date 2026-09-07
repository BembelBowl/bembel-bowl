"""
Generiert automatisch Spielberichte im Stil der letzten Jahre und speichert
sie in Firebase Firestore (Collection "matchReports"), passend zur
bestehenden reports.html. Rein serverseitig (GitHub Actions) - keine
sichtbare Aenderung an der Website.

Nutzt ausschliesslich kostenlose Bausteine:
- Google Gemini API (kostenloses Kontingent, kein Budget noetig)
- Firebase Admin SDK (bestehender kostenloser Spark-Tarif)
- GitHub Actions (kostenloser Cron-Job)

Benoetigte Umgebungsvariablen (aus GitHub Secrets):
- GEMINI_API_KEY
- FIREBASE_SERVICE_ACCOUNT   (kompletter Inhalt der Service-Account-JSON)
- ESPN_LEAGUE_ID

Optionale Umgebungsvariablen (manuelles Testen/Ueberschreiben):
- SEASON        (z.B. "2026", Default: aktuelles Jahr)
- WEEK_OVERRIDE (z.B. "5", ueberschreibt die automatische Wochenerkennung)
- FORCE_RUN     ("true", ueberspringt die Zeitpruefung)
"""

import json
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
import firebase_admin
from firebase_admin import credentials, firestore

# ---------------------------------------------------------------------------
# Konfiguration
# ---------------------------------------------------------------------------
LEAGUE_ID = os.environ.get("ESPN_LEAGUE_ID", "843833275")
SEASON = int(os.environ.get("SEASON", datetime.now().year))
WEEK_OVERRIDE = os.environ.get("WEEK_OVERRIDE")

BASE_DIR = Path(__file__).parent
STYLE_GUIDE_PATH = BASE_DIR / "STYLE_GUIDE.md"
REFERENCE_DIR = BASE_DIR / "reference-reports"
NUM_EXAMPLE_REPORTS = 3

# Kostenloses Gemini-Modell. In Google AI Studio unter "Rate limits" pruefen,
# welches Modell aktuell im Free-Tier verfuegbar ist, ggf. hier anpassen.
GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    + GEMINI_MODEL + ":generateContent"
)

ESPN_URLS = [
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}",
    "https://fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}",
]

# ESPN Lineup-Slot- und Positions-Mapping (Standard-IDs, plattformweit gleich)
LINEUP_SLOT_MAP = {0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K", 23: "FLEX"}
BENCH_SLOTS = {20, 21}  # Bench, IR - im Bericht nicht relevant
DEFAULT_POSITION_MAP = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF"}
SLOT_ORDER = ["QB", "RB", "WR", "TE", "FLEX", "DEF", "K"]


# ---------------------------------------------------------------------------
# ESPN: Spieltag, Scoreboard UND Box Score laden
# ---------------------------------------------------------------------------
def fetch_espn(params):
    last_err = None
    for url_tpl in ESPN_URLS:
        url = url_tpl.format(season=SEASON, league_id=LEAGUE_ID)
        try:
            res = requests.get(url, params=params, timeout=20, headers={"Accept": "application/json"})
            res.raise_for_status()
            return res.json()
        except Exception as e:  # noqa: BLE001
            last_err = e
    raise RuntimeError(f"ESPN nicht erreichbar: {last_err}")


def determine_week():
    if WEEK_OVERRIDE:
        return int(WEEK_OVERRIDE)
    data = fetch_espn({"view": "mStatus"})
    week = (data.get("status") or {}).get("currentMatchupPeriod")
    if not week:
        raise RuntimeError(
            "Konnte den aktuellen Spieltag nicht automatisch ermitteln. "
            "Bitte WEEK_OVERRIDE beim manuellen Workflow-Trigger setzen."
        )
    return int(week)


def parse_box_score_side(team_side, week):
    """Extrahiert die Starter-Riege (Position, Name, Punkte) eines Teams."""
    roster = (team_side or {}).get("rosterForCurrentScoringPeriod") or (team_side or {}).get("rosterForMatchupPeriod")
    entries = (roster or {}).get("entries") or []

    players = []
    for entry in entries:
        if entry.get("lineupSlotId") in BENCH_SLOTS:
            continue
        player = (entry.get("playerPoolEntry") or {}).get("player")
        if not player:
            continue

        slot_name = LINEUP_SLOT_MAP.get(entry.get("lineupSlotId")) or DEFAULT_POSITION_MAP.get(
            player.get("defaultPositionId")
        ) or "?"

        points = 0
        for stat in player.get("stats", []) or []:
            if stat.get("scoringPeriodId") == week and stat.get("statSourceId") == 0:
                points = stat.get("appliedTotal") or 0
                break
        if not points:
            points = (entry.get("playerPoolEntry") or {}).get("appliedStatTotal") or 0

        players.append({"position": slot_name, "name": player.get("fullName", "Unbekannt"), "points": points})

    players.sort(key=lambda p: SLOT_ORDER.index(p["position"]) if p["position"] in SLOT_ORDER else 99)
    return players


def fetch_week_matchups(week):
    data = fetch_espn({"view": "mScoreboard", "view": "mMatchupScore", "view": "mTeam", "scoringPeriodId": week})

    teams_by_id = {}
    for t in data.get("teams", []):
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip() or f"Team {t['id']}"
        teams_by_id[t["id"]] = name

    games = []
    for m in data.get("schedule", []):
        if m.get("matchupPeriodId") != week:
            continue
        home, away = m.get("home"), m.get("away")
        if not home or not away:
            continue
        games.append(
            {
                "homeTeam": teams_by_id.get(home["teamId"], f"Team {home['teamId']}"),
                "awayTeam": teams_by_id.get(away["teamId"], f"Team {away['teamId']}"),
                "homeScore": home.get("totalPoints", 0) or 0,
                "awayScore": away.get("totalPoints", 0) or 0,
                "homeBoxScore": parse_box_score_side(home, week),
                "awayBoxScore": parse_box_score_side(away, week),
            }
        )
    return games


# ---------------------------------------------------------------------------
# Stil-Guide + Beispielberichte laden
# ---------------------------------------------------------------------------
def load_style_guide():
    if not STYLE_GUIDE_PATH.exists():
        raise RuntimeError(
            f"{STYLE_GUIDE_PATH} nicht gefunden. Bitte zuerst den Stil-Guide aus den "
            "alten Berichten erstellen (siehe Anleitung, Schritt 3)."
        )
    return STYLE_GUIDE_PATH.read_text(encoding="utf-8")


def load_example_reports(n=NUM_EXAMPLE_REPORTS):
    all_files = list(REFERENCE_DIR.rglob("*.md")) + list(REFERENCE_DIR.rglob("*.txt"))
    if not all_files:
        return []
    sample = random.sample(all_files, min(n, len(all_files)))
    return [f.read_text(encoding="utf-8") for f in sample]


# ---------------------------------------------------------------------------
# Gemini (kostenlos): Bericht schreiben lassen
# ---------------------------------------------------------------------------
def format_box_score(players):
    if not players:
        return "(kein Box Score verfuegbar)"
    return "\n".join(f"  {p['position']}: {p['name']} - {p['points']:.1f} Pkt." for p in players)


def build_prompt(style_guide, examples, matchup):
    examples_block = "\n\n---\n\n".join(examples) if examples else "(keine Beispiele verfuegbar)"
    home, away = matchup["homeTeam"], matchup["awayTeam"]
    home_score, away_score = matchup["homeScore"], matchup["awayScore"]
    winner = home if home_score > away_score else away

    return f"""Du schreibst Spielberichte fuer eine Fantasy-Football-Liga ("Bembel Bowl"),
im exakt gleichen Stil wie die Liga-Manager das seit Jahren selbst tun.

STIL-GUIDE:
{style_guide}

BEISPIELBERICHTE AUS VERGANGENEN JAHREN (Orientierung fuer Tonfall, Laenge, Aufbau):
{examples_block}

Schreibe jetzt einen neuen Spielbericht fuer folgendes Match-up, in genau diesem Stil.
Nutze NUR die unten gegebenen Fakten, erfinde keine zusaetzlichen Ereignisse oder Statistiken.

MATCH-UP: {home} ({home_score:.2f} Punkte) vs. {away} ({away_score:.2f} Punkte)
Sieger: {winner}

BOX SCORE {home}:
{format_box_score(matchup['homeBoxScore'])}

BOX SCORE {away}:
{format_box_score(matchup['awayBoxScore'])}

Antworte NUR mit dem fertigen Bericht, ohne Einleitung oder Meta-Kommentar."""


def generate_report(prompt):
    api_key = os.environ["GEMINI_API_KEY"]
    body = {"contents": [{"parts": [{"text": prompt}]}]}
    res = requests.post(GEMINI_URL, params={"key": api_key}, json=body, timeout=60)
    res.raise_for_status()
    data = res.json()
    candidates = data.get("candidates") or []
    if not candidates:
        raise RuntimeError(f"Gemini lieferte keine Antwort: {data}")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = "".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError(f"Gemini-Antwort war leer: {data}")
    return text


# ---------------------------------------------------------------------------
# Firebase
# ---------------------------------------------------------------------------
def init_firestore():
    service_account_json = os.environ["FIREBASE_SERVICE_ACCOUNT"]
    cred = credentials.Certificate(json.loads(service_account_json))
    firebase_admin.initialize_app(cred)
    return firestore.client()


def save_report(db, season, week, index, matchup, text):
    # WICHTIG: 1-basierter Index (m1, m2, ...), passend zu reports.html.
    doc_id = f"{season}-w{week}-m{index}"
    db.collection("matchReports").document(doc_id).set(
        {
            "text": text,
            "homeTeam": matchup["homeTeam"],
            "awayTeam": matchup["awayTeam"],
            "homeScore": matchup["homeScore"],
            "awayScore": matchup["awayScore"],
            "homeBoxScore": matchup["homeBoxScore"],
            "awayBoxScore": matchup["awayBoxScore"],
            "generatedBy": "ai-agent",
            "updatedAt": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


# ---------------------------------------------------------------------------
# Zeitpruefung (Dienstag ~12:00 Uhr Berliner Zeit, DST-sicher)
# ---------------------------------------------------------------------------
def is_scheduled_time_now(tolerance_minutes=20):
    now_berlin = datetime.now(ZoneInfo("Europe/Berlin"))
    if now_berlin.weekday() != 1:  # 0=Montag, 1=Dienstag
        return False
    now_minutes = now_berlin.hour * 60 + now_berlin.minute
    return abs(now_minutes - 12 * 60) <= tolerance_minutes


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    force_run = os.environ.get("FORCE_RUN") == "true"
    if not force_run and not is_scheduled_time_now():
        print("Nicht der geplante Zeitpunkt (Dienstag ~12:00 Uhr Berliner Zeit) - breche ab, ohne etwas zu tun.")
        sys.exit(0)

    week = determine_week()
    print(f"Saison {SEASON}, Spieltag {week}")

    matchups = fetch_week_matchups(week)
    if not matchups:
        print("Keine Match-ups fuer diesen Spieltag gefunden.")
        sys.exit(0)
    print(f"{len(matchups)} Match-ups gefunden.")

    style_guide = load_style_guide()
    examples = load_example_reports()

    db = init_firestore()

    for index, matchup in enumerate(matchups, start=1):
        print(f"Erzeuge Bericht fuer {matchup['homeTeam']} vs. {matchup['awayTeam']} ...")
        try:
            prompt = build_prompt(style_guide, examples, matchup)
            text = generate_report(prompt)
            save_report(db, SEASON, week, index, matchup, text)
            print("  gespeichert.")
        except Exception as e:  # noqa: BLE001
            print(f"  FEHLER bei diesem Match-up: {e}")
        time.sleep(2)  # kleine Pause, um das kostenlose Rate-Limit zu schonen

    print("Fertig.")


if __name__ == "__main__":
    main()
