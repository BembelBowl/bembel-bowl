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

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent
STYLE_GUIDE_PATH = BASE_DIR / "STYLE_GUIDE.md"
REFERENCE_DIR = REPO_ROOT / "reference-reports"
NUM_EXAMPLE_REPORTS = 3
EXPECTED_MATCHUP_COUNT = int(os.environ.get("EXPECTED_MATCHUP_COUNT", "10"))

# Kostenloses Gemini-Modell. In Google AI Studio unter "Rate limits" pruefen,
# welches Modell aktuell im Free-Tier verfuegbar ist, ggf. hier anpassen.
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
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

    # Fuer den Dienstag-Recap brauchen wir den zuletzt abgeschlossenen
    # Scoring-Zeitraum, nicht den bereits aktiven naechsten Matchup-Zeitraum.
    data = fetch_espn([("view", "mStatus")])
    status = data.get("status") or {}
    week = status.get("latestScoringPeriod")
    if not week:
        week = status.get("currentMatchupPeriod")
    if not week:
        raise RuntimeError(
            "Konnte den letzten abgeschlossenen Spieltag nicht automatisch ermitteln. "
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
    # ESPN erwartet mehrere gleichnamige view-Parameter. Eine Python-Dict kann
    # denselben Key nicht mehrfach enthalten, deshalb bewusst eine Tupel-Liste.
    params = [
        ("view", "mScoreboard"),
        ("view", "mMatchupScore"),
        ("view", "mTeam"),
        ("view", "mBoxscore"),
        ("scoringPeriodId", week),
        ("matchupPeriodId", week),
    ]
    data = fetch_espn(params)

    teams_by_id = {}
    for t in data.get("teams", []):
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip() or f"Team {t['id']}"
        teams_by_id[t["id"]] = name

    games = []
    schedule = sorted(data.get("schedule", []), key=lambda m: m.get("id", 0))
    for m in schedule:
        if m.get("matchupPeriodId") != week:
            continue
        home, away = m.get("home"), m.get("away")
        if not home or not away:
            continue
        games.append(
            {
                "matchupId": m.get("id"),
                "homeTeam": teams_by_id.get(home["teamId"], f"Team {home['teamId']}"),
                "awayTeam": teams_by_id.get(away["teamId"], f"Team {away['teamId']}"),
                "homeScore": home.get("totalPoints", 0) or 0,
                "awayScore": away.get("totalPoints", 0) or 0,
                "homeBoxScore": parse_box_score_side(home, week),
                "awayBoxScore": parse_box_score_side(away, week),
            }
        )

    validate_matchups(games, week)
    return games


def validate_matchups(games, week):
    if EXPECTED_MATCHUP_COUNT and len(games) != EXPECTED_MATCHUP_COUNT:
        raise RuntimeError(
            f"ESPN lieferte fuer Woche {week} {len(games)} statt erwarteter "
            f"{EXPECTED_MATCHUP_COUNT} Match-ups. Breche ab, damit keine unvollstaendigen Berichte gespeichert werden."
        )

    if games and not any((g["homeScore"] or 0) > 0 or (g["awayScore"] or 0) > 0 for g in games):
        raise RuntimeError(
            f"Alle Scores fuer Woche {week} sind 0. Der Spieltag ist vermutlich noch nicht abgeschlossen "
            "oder ESPN hat bereits auf die naechste Woche umgeschaltet."
        )

    missing_box = [
        f"{g['homeTeam']} vs. {g['awayTeam']}"
        for g in games
        if not g.get("homeBoxScore") or not g.get("awayBoxScore")
    ]
    if missing_box:
        raise RuntimeError(
            "ESPN lieferte keinen vollstaendigen Starter-Boxscore fuer: " + "; ".join(missing_box)
        )


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
    # Fuer Wochen-Recaps moeglichst aktuelle Wochenberichte als Stilbeispiele
    # verwenden; Sonderberichte/Awards unterscheiden sich strukturell stark.
    preferred = []
    for year in (2024, 2023, 2022, 2021):
        year_dir = REFERENCE_DIR / str(year)
        if year_dir.exists():
            preferred.extend(sorted(year_dir.glob("week*.md")))

    all_files = preferred or sorted(REFERENCE_DIR.rglob("week*.md"))
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
    winner = home if home_score > away_score else away if away_score > home_score else "Unentschieden"

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


def generate_report(prompt, max_attempts=4):
    api_key = os.environ["GEMINI_API_KEY"]
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.8},
    }

    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            res = requests.post(GEMINI_URL, params={"key": api_key}, json=body, timeout=90)
            if res.status_code in {429, 500, 502, 503, 504} and attempt < max_attempts:
                wait = 8 * attempt
                print(f"  Gemini temporaer nicht verfuegbar (HTTP {res.status_code}), neuer Versuch in {wait}s ...")
                time.sleep(wait)
                continue
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
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < max_attempts:
                wait = 8 * attempt
                print(f"  Gemini-Fehler ({exc}), neuer Versuch in {wait}s ...")
                time.sleep(wait)

    raise RuntimeError(f"Gemini nach {max_attempts} Versuchen fehlgeschlagen: {last_err}")


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
            "generationModel": GEMINI_MODEL,
            "season": season,
            "week": week,
            "matchupIndex": index,
            "matchupId": matchup.get("matchupId"),
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
    validate_only = os.environ.get("VALIDATE_ONLY") == "true"
    smoke_test = os.environ.get("SMOKE_TEST") == "true"

    # Der Workflow steuert den Termin. Diese Pruefung ist nur ein Schutz gegen
    # versehentliche Ausfuehrung und toleriert GitHub-Actions-Verzoegerungen.
    if not force_run and not is_scheduled_time_now(tolerance_minutes=180):
        print("Nicht im geplanten Dienstag-Zeitfenster - breche ab, ohne etwas zu tun.")
        sys.exit(0)

    if not validate_only:
        missing = [name for name in ("GEMINI_API_KEY", "FIREBASE_SERVICE_ACCOUNT") if not os.environ.get(name)]
        if missing:
            raise RuntimeError("Fehlende GitHub Secrets/Umgebungsvariablen: " + ", ".join(missing))

    week = determine_week()
    print(f"Saison {SEASON}, Spieltag {week}, League {LEAGUE_ID}")

    matchups = fetch_week_matchups(week)
    print(f"{len(matchups)} Match-ups gefunden und validiert.")
    for i, matchup in enumerate(matchups, start=1):
        print(
            f"  {i:02d}: {matchup['homeTeam']} {matchup['homeScore']:.2f} : "
            f"{matchup['awayScore']:.2f} {matchup['awayTeam']} "
            f"({len(matchup['homeBoxScore'])}+{len(matchup['awayBoxScore'])} Starter)"
        )

    style_guide = load_style_guide()
    examples = load_example_reports()
    print(f"Stil-Guide geladen; {len(examples)} historische Wochenberichte als Beispiele geladen.")

    if validate_only:
        print("VALIDATE_ONLY=true: ESPN-/Datenpruefung erfolgreich. Keine KI-Aufrufe, keine Firestore-Schreibvorgaenge.")
        return

    if smoke_test:
        print("SMOKE_TEST=true: pruefe Gemini und Firebase mit einem temporaeren Testeintrag ...")
        ai_text = generate_report("Antworte exakt mit dem Wort OK und sonst nichts.")
        if not ai_text.strip():
            raise RuntimeError("Gemini-Smoke-Test lieferte keine Antwort.")
        print(f"Gemini erreichbar ({GEMINI_MODEL}): {ai_text[:40]!r}")
        db = init_firestore()
        test_ref = db.collection("matchReports").document("__automation_smoke_test__")
        test_ref.set({
            "text": "automation smoke test",
            "generatedBy": "smoke-test",
            "updatedAt": firestore.SERVER_TIMESTAMP,
        })
        test_ref.delete()
        print("Firebase erreichbar: Testdokument erfolgreich geschrieben und wieder geloescht.")
        print("SMOKE TEST ERFOLGREICH: ESPN + Daten + Gemini + Firebase sind erreichbar.")
        return

    db = init_firestore()
    failures = []

    for index, matchup in enumerate(matchups, start=1):
        print(f"Erzeuge Bericht fuer {matchup['homeTeam']} vs. {matchup['awayTeam']} ...")
        try:
            prompt = build_prompt(style_guide, examples, matchup)
            text = generate_report(prompt)
            save_report(db, SEASON, week, index, matchup, text)
            print("  gespeichert.")
        except Exception as e:  # noqa: BLE001
            failures.append((index, matchup, str(e)))
            print(f"  FEHLER bei diesem Match-up: {e}")
        time.sleep(6)  # Rate-Limit im kostenlosen Gemini-Tier schonen

    if failures:
        summary = "; ".join(
            f"m{idx} {m['homeTeam']} vs. {m['awayTeam']}: {err}"
            for idx, m, err in failures
        )
        raise RuntimeError(f"{len(failures)} von {len(matchups)} Berichten fehlgeschlagen: {summary}")

    print(f"Fertig: {len(matchups)} von {len(matchups)} Berichten erfolgreich gespeichert.")


if __name__ == "__main__":
    main()
