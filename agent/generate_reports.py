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
- SKIP_EXISTING ("true", vorhandene Berichte nicht neu erzeugen)
"""

import json
import math
import os
import random
import re
import statistics
import sys
import time
from collections import defaultdict
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
REGULAR_SEASON_WEEKS = int(os.environ.get("REGULAR_SEASON_WEEKS", "14"))
MIDSEASON_WEEK = int(os.environ.get("MIDSEASON_WEEK", "7"))
CHAMPIONSHIP_WEEK = int(os.environ.get("CHAMPIONSHIP_WEEK", "17"))
PLAYOFF_SIMULATIONS = int(os.environ.get("PLAYOFF_SIMULATIONS", "20000"))

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

        players.append({
            "playerId": player.get("id"),
            "position": slot_name,
            "name": player.get("fullName", "Unbekannt"),
            "points": points,
        })

    players.sort(key=lambda p: SLOT_ORDER.index(p["position"]) if p["position"] in SLOT_ORDER else 99)
    return players


def extract_team_score(team_side, week, box_score=None):
    """Liest den Team-Score robust aus den verschiedenen ESPN-Response-Varianten."""
    side = team_side or {}

    # Klassischer Matchup-Score. Bei manchen View-Kombinationen liefert ESPN
    # hier waehrend der laufenden Woche allerdings 0, obwohl im Roster bereits
    # Punkte vorhanden sind. Deshalb nur direkt verwenden, wenn > 0.
    for key in ("totalPoints", "totalPointsLive"):
        value = side.get(key)
        if value not in (None, ""):
            try:
                value = float(value)
                if value > 0:
                    return value
            except (TypeError, ValueError):
                pass

    # mMatchupScore fuehrt die Werte oft zusaetzlich wochenweise.
    by_period = side.get("pointsByScoringPeriod") or {}
    value = by_period.get(str(week), by_period.get(week))
    if value not in (None, ""):
        try:
            value = float(value)
            if value > 0:
                return value
        except (TypeError, ValueError):
            pass

    # mBoxscore kann den Teamwert im Roster selbst liefern.
    for roster_key in ("rosterForCurrentScoringPeriod", "rosterForMatchupPeriod"):
        roster = side.get(roster_key) or {}
        value = roster.get("appliedStatTotal")
        if value not in (None, ""):
            try:
                value = float(value)
                if value > 0:
                    return value
            except (TypeError, ValueError):
                pass

    # Letzter Fallback: Punkte der Starter summieren. Das ist fuer die
    # Berichterstellung besser als 0 und stimmt in normalen Wochen bis auf
    # eventuelle manuelle Commissioner-Adjustments mit dem Teamwert ueberein.
    if box_score:
        try:
            summed = round(sum(float(p.get("points") or 0) for p in box_score), 2)
            if summed > 0:
                return summed
        except (TypeError, ValueError):
            pass


    # 0 ist als legitimer Zwischenstand moeglich (z.B. vor dem ersten Kickoff).
    try:
        return float(side.get("totalPoints") or 0)
    except (TypeError, ValueError):
        return 0.0


def fetch_week_matchups(week, strict=True):
    # Team-Metadaten und Matchup/Boxscore bewusst getrennt abrufen. ESPN kann
    # bei grossen View-Kombinationen leicht unterschiedliche Response-Formen
    # liefern; diese Aufteilung ist stabiler und leichter zu validieren.
    team_data = fetch_espn([("view", "mTeam")])
    matchup_params = [
        ("view", "mMatchupScore"),
        ("view", "mBoxscore"),
        ("view", "mScoreboard"),
        ("scoringPeriodId", week),
        ("matchupPeriodId", week),
    ]
    data = fetch_espn(matchup_params)

    teams_by_id = {}
    for t in team_data.get("teams", []):
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
        home_box = parse_box_score_side(home, week)
        away_box = parse_box_score_side(away, week)
        games.append(
            {
                "matchupId": m.get("id"),
                "homeTeamId": home.get("teamId"),
                "awayTeamId": away.get("teamId"),
                "homeTeam": teams_by_id.get(home["teamId"], f"Team {home['teamId']}"),
                "awayTeam": teams_by_id.get(away["teamId"], f"Team {away['teamId']}"),
                "homeScore": extract_team_score(home, week, home_box),
                "awayScore": extract_team_score(away, week, away_box),
                "homeBoxScore": home_box,
                "awayBoxScore": away_box,
            }
        )

    validate_matchups(games, week, strict=strict)
    return games


def validate_matchups(games, week, strict=True):
    if EXPECTED_MATCHUP_COUNT and len(games) != EXPECTED_MATCHUP_COUNT:
        raise RuntimeError(
            f"ESPN lieferte fuer Woche {week} {len(games)} statt erwarteter "
            f"{EXPECTED_MATCHUP_COUNT} Match-ups. Breche ab, damit keine unvollstaendigen Berichte gespeichert werden."
        )

    if games and not any((g["homeScore"] or 0) > 0 or (g["awayScore"] or 0) > 0 for g in games):
        if strict:
            raise RuntimeError(
                f"Alle Scores fuer Woche {week} sind 0. Der Spieltag ist vermutlich noch nicht abgeschlossen "
                "oder ESPN hat fuer diese View noch keine finalen Teamwerte geliefert."
            )
        print(
            f"WARNUNG: Alle Scores fuer Woche {week} sind derzeit 0. "
            "Im SMOKE_TEST ist das erlaubt, weil die Woche noch laufen kann."
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


STYLE_MODES = [
    "Beginne mit der auffaelligsten Einzelleistung im Boxscore. Keine rhetorische Frage am Anfang.",
    "Beginne mit dem Gesamtbild beider Lineups und arbeite dann zu den entscheidenden Positionsunterschieden hin.",
    "Beginne aus Sicht des Verlierers: Wo blieb Produktion liegen? Danach erst den Sieger einordnen.",
    "Beginne trocken und knapp mit einer Beobachtung zum Punkteabstand; erst danach einzelne Spieler herausgreifen.",
    "Baue den Bericht um einen Kontrast auf: eine starke Position gegen eine schwache Positionsgruppe. Keine Dramatisierung im ersten Satz.",
    "Beginne mit einer sachlich klingenden Feststellung, die im zweiten Satz in trockenen Spott kippt.",
    "Erzaehle das Matchup ueber zwei bis drei Schluesselfiguren aus dem Boxscore, nicht ueber den Endstand.",
    "Beginne mit einem ungewoehnlichen Vergleich oder Bild, aber ohne bekannte Standardfloskel und ohne rhetorische Frage.",
    "Beginne mit dem Sieger, aber vermeide Lobeshymnen; betone stattdessen, wodurch der Vorsprung im Lineup entstand.",
    "Beginne mit einer kurzen Mini-Diagnose des Matchups in einem Satz und entwickle daraus einen frei fliessenden Kommentar.",
]

BANNED_WEEKLY_PHRASES = [
    "mein lieber herr gesangsverein",
    "wie kann man so ein matchup verlieren",
    "wie kann man dieses matchup verlieren",
    "so ein matchup kann man nicht verlieren",
    "dieses matchup kann man nicht verlieren",
    "eigentlich nicht zu verlieren",
]


def normalize_phrase(text):
    return " ".join(str(text or "").lower().split())


def first_sentence(text):
    import re
    clean = " ".join(str(text or "").strip().split())
    if not clean:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", clean, maxsplit=1)
    return parts[0][:240]


def sanitize_report_text(text, matchup):
    """Entfernt redundante Titel/Scorezeilen, falls Gemini sie trotz Prompt ausgibt."""
    import re

    raw_lines = [line.rstrip() for line in str(text or "").strip().splitlines()]
    while raw_lines and not raw_lines[0].strip():
        raw_lines.pop(0)

    if raw_lines:
        first = re.sub(r"^#{1,6}\s*", "", raw_lines[0].strip())
        low = normalize_phrase(first)
        home = normalize_phrase(matchup.get("homeTeam"))
        away = normalize_phrase(matchup.get("awayTeam"))
        looks_like_score = bool(re.search(r"\d+(?:[.,]\d+)?\s*[:\-]\s*\d+(?:[.,]\d+)?", first))
        looks_like_matchup = (home and home in low and away and away in low) or (" vs" in low and looks_like_score)

        # Nur kurze erste Zeilen entfernen; ein echter Fliesstext-Absatz soll nie
        # wegen einer zufaelligen Teamnennung abgeschnitten werden.
        if len(first) <= 180 and (looks_like_matchup or (looks_like_score and (home in low or away in low))):
            raw_lines.pop(0)
            while raw_lines and not raw_lines[0].strip():
                raw_lines.pop(0)

    return "\n".join(raw_lines).strip()


def report_has_forbidden_repetition(text, previous_reports):
    """Erkennt besonders auffaellige Wochen-Wiederholungen fuer einen Retry."""
    current = normalize_phrase(text)

    # Die bekanntesten Schablonen sollen maximal einmal in einer Woche vorkommen.
    for phrase in BANNED_WEEKLY_PHRASES:
        count_before = sum(phrase in normalize_phrase(r) for r in previous_reports)
        if phrase in current and count_before >= 1:
            return phrase

    # Nahezu gleicher Einstieg ist ebenfalls ein Wiederholungsindikator.
    opening = normalize_phrase(first_sentence(text))
    if opening:
        opening_words = opening.split()[:8]
        prefix = " ".join(opening_words)
        if len(prefix) >= 24:
            for previous in previous_reports:
                if normalize_phrase(first_sentence(previous)).startswith(prefix):
                    return f"aehnlicher Einstieg: {prefix}"
    return None


def build_prompt(style_guide, examples, matchup, report_index=1, previous_reports=None):
    previous_reports = previous_reports or []
    examples_block = "\n\n---\n\n".join(examples) if examples else "(keine Beispiele verfuegbar)"
    home, away = matchup["homeTeam"], matchup["awayTeam"]
    home_score, away_score = matchup["homeScore"], matchup["awayScore"]
    winner = home if home_score > away_score else away if away_score > home_score else "Unentschieden"
    style_mode = STYLE_MODES[(report_index - 1) % len(STYLE_MODES)]

    used_openings = [first_sentence(r) for r in previous_reports if first_sentence(r)]
    used_openings_block = "\n".join(f"- {x}" for x in used_openings[-9:]) or "- noch keine"

    return f"""Du schreibst Spielberichte fuer eine Fantasy-Football-Liga ("Bembel Bowl"),
im gleichen Grundton wie die Liga-Manager das seit Jahren selbst tun, aber NICHT als Schablone.

STIL-GUIDE:
{style_guide}

BEISPIELBERICHTE AUS VERGANGENEN JAHREN (nur Orientierung fuer Tonfall; NICHT Formulierungen kopieren):
{examples_block}

WICHTIG FUER DIESE WOCHE:
- Dies ist Bericht {report_index} von mehreren Matchups derselben Woche. Jeder Bericht muss eigenstaendig klingen.
- Keine Ueberschrift. Keine Titelzeile. Teamnamen und Endstand NICHT als erste Zeile wiederholen.
- Beginne sofort mit dem Fliesstext.
- Verwende keine wiederkehrende Standarddramaturgie nach dem Muster "dieses Matchup kann man nicht verlieren".
- Nutze rhetorische Fragen nur selten. Nicht jeder Bericht darf mit einer Frage beginnen.
- Dieselbe auffaellige Redewendung oder Catchphrase darf innerhalb einer Woche hoechstens einmal vorkommen.
- Insbesondere "Mein lieber Herr Gesangsverein" nicht verwenden, wenn es fuer die Pointe nicht absolut unverzichtbar ist.
- Variiere Satzlaenge, Einstieg, Perspektive, Schwerpunkt und Schluss. Nicht jeder Bericht soll Sieger -> Verlierer -> Fazit folgen.
- Beende den Bericht nicht automatisch mit einem Ausblick auf die kommende Woche, wenn dazu keine Daten vorliegen.
- Keine erfundenen Verletzungen, Trades, Managerentscheidungen, Rekorde oder NFL-News.
- Keine Behauptung ueber Spielverlauf/Comeback/Last-Second, wenn das nicht aus den Daten ableitbar ist.

ERZAEHLPERSPEKTIVE FUER GENAU DIESEN BERICHT:
{style_mode}

BEREITS VERWENDETE EINSTIEGE DIESER WOCHE (nicht nachbauen oder paraphrasieren):
{used_openings_block}

MATCH-UP-DATEN:
{home}: {home_score:.2f} Punkte
{away}: {away_score:.2f} Punkte
Sieger: {winner}

BOX SCORE {home}:
{format_box_score(matchup['homeBoxScore'])}

BOX SCORE {away}:
{format_box_score(matchup['awayBoxScore'])}

Schreibe einen dichten, unterhaltsamen Fliesstext. Antworte NUR mit dem Bericht selbst."""



def _retry_delay(response, attempt, base_seconds):
    """Retry-After von Google respektieren; sonst exponentiell warten."""
    if response is not None:
        retry_after = response.headers.get("Retry-After")
        if retry_after:
            try:
                return max(base_seconds, min(int(float(retry_after)), 180))
            except (TypeError, ValueError):
                pass
    return min(base_seconds * (2 ** (attempt - 1)), 180)


def generate_report(prompt, max_attempts=None, temperature=0.8, max_output_tokens=None):
    api_key = os.environ["GEMINI_API_KEY"]
    if max_attempts is None:
        max_attempts = int(os.environ.get("GEMINI_MAX_ATTEMPTS", "5"))
    base_backoff = int(os.environ.get("GEMINI_BASE_BACKOFF_SECONDS", "15"))

    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature},
    }
    if max_output_tokens:
        body["generationConfig"]["maxOutputTokens"] = max_output_tokens

    transient_statuses = {429, 500, 502, 503, 504}
    last_err = None

    for attempt in range(1, max_attempts + 1):
        response = None
        try:
            response = requests.post(GEMINI_URL, params={"key": api_key}, json=body, timeout=180)
            if response.status_code in transient_statuses:
                last_err = requests.HTTPError(
                    f"{response.status_code} Server/Rate-Limit Fehler fuer Gemini",
                    response=response,
                )
                if attempt < max_attempts:
                    wait = _retry_delay(response, attempt, base_backoff)
                    print(
                        f"  Gemini temporaer nicht verfuegbar (HTTP {response.status_code}), "
                        f"Versuch {attempt}/{max_attempts}; neuer Versuch in {wait}s ..."
                    )
                    time.sleep(wait)
                    continue

            response.raise_for_status()
            data = response.json()
            candidates = data.get("candidates") or []
            if not candidates:
                raise RuntimeError(f"Gemini lieferte keine Antwort: {data}")
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(part.get("text", "") for part in parts).strip()
            if not text:
                raise RuntimeError(f"Gemini-Antwort war leer: {data}")
            return text

        except Exception as exc:  # noqa: BLE001
            last_err = exc
            status = getattr(getattr(exc, "response", None), "status_code", None)
            if status in transient_statuses and attempt < max_attempts:
                wait = _retry_delay(getattr(exc, "response", None), attempt, base_backoff)
                print(f"  Gemini-Fehler HTTP {status}; neuer Versuch in {wait}s ...")
                time.sleep(wait)
                continue
            if status not in transient_statuses and attempt < max_attempts:
                wait = min(base_backoff * attempt, 60)
                print(f"  Gemini-Fehler ({exc}); neuer Versuch in {wait}s ...")
                time.sleep(wait)
                continue
            break

    raise RuntimeError(f"Gemini nach {max_attempts} Versuchen fehlgeschlagen: {last_err}")


# ---------------------------------------------------------------------------
# Saison-Sonderberichte: Datenmodell, Playoff-Simulation und Prompts
# ---------------------------------------------------------------------------
SPECIAL_REPORT_TITLES = {
    "midseason": "Mid-Season Recap",
    "regular-season": "Regular Season Recap",
    "season-awards": "Season Awards",
    "championship": "Championship Recap",
}


def _score_from_side(side):
    try:
        return float((side or {}).get("totalPoints") or 0)
    except (TypeError, ValueError):
        return 0.0


def fetch_league_snapshot(through_week):
    """Baut Tabelle, Divisionen und Restspielplan aus ESPN-Rohdaten."""
    data = fetch_espn([
        ("view", "mTeam"),
        ("view", "mStandings"),
        ("view", "mMatchupScore"),
        ("view", "mSettings"),
    ])

    division_names = {}
    settings = data.get("settings") or {}
    schedule_settings = settings.get("scheduleSettings") or {}
    for division in schedule_settings.get("divisions") or []:
        division_names[division.get("id")] = division.get("name") or f"Division {division.get('id')}"

    teams = {}
    for t in data.get("teams") or []:
        team_id = t.get("id")
        name = t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip() or f"Team {team_id}"
        teams[team_id] = {
            "id": team_id,
            "name": name,
            "divisionId": t.get("divisionId"),
            "divisionName": division_names.get(t.get("divisionId"), f"Division {t.get('divisionId')}"),
        }

    stats = {
        tid: {
            **team,
            "wins": 0,
            "losses": 0,
            "ties": 0,
            "pointsFor": 0.0,
            "pointsAgainst": 0.0,
            "scores": [],
            "games": [],
        }
        for tid, team in teams.items()
    }
    remaining = []
    completed_games = []

    for m in sorted(data.get("schedule") or [], key=lambda x: (x.get("matchupPeriodId", 999), x.get("id", 999999))):
        week = int(m.get("matchupPeriodId") or 0)
        home, away = m.get("home") or {}, m.get("away") or {}
        h_id, a_id = home.get("teamId"), away.get("teamId")
        if h_id not in stats or a_id not in stats:
            continue

        if 1 <= week <= through_week:
            hs, aas = _score_from_side(home), _score_from_side(away)
            # Ein abgeschlossener Spieltag darf nicht als 0:0 in eine Saisonanalyse eingehen.
            if hs == 0 and aas == 0:
                continue
            stats[h_id]["pointsFor"] += hs
            stats[h_id]["pointsAgainst"] += aas
            stats[a_id]["pointsFor"] += aas
            stats[a_id]["pointsAgainst"] += hs
            stats[h_id]["scores"].append(hs)
            stats[a_id]["scores"].append(aas)
            if hs > aas:
                stats[h_id]["wins"] += 1
                stats[a_id]["losses"] += 1
                winner = h_id
            elif aas > hs:
                stats[a_id]["wins"] += 1
                stats[h_id]["losses"] += 1
                winner = a_id
            else:
                stats[h_id]["ties"] += 1
                stats[a_id]["ties"] += 1
                winner = None
            game = {"week": week, "home": h_id, "away": a_id, "homeScore": hs, "awayScore": aas, "winner": winner}
            stats[h_id]["games"].append(game)
            stats[a_id]["games"].append(game)
            completed_games.append(game)
        elif through_week < week <= REGULAR_SEASON_WEEKS:
            remaining.append({"week": week, "home": h_id, "away": a_id})

    if len(stats) != 20:
        raise RuntimeError(f"Fuer Saison-Sonderberichte werden 20 Teams erwartet, ESPN lieferte {len(stats)}.")
    divisions = defaultdict(list)
    for team in stats.values():
        divisions[team["divisionId"]].append(team["id"])
    if len(divisions) != 4:
        raise RuntimeError(f"Fuer die Playoff-Berechnung werden 4 Divisionen erwartet, gefunden: {len(divisions)}.")

    return {
        "teams": teams,
        "stats": stats,
        "divisions": dict(divisions),
        "remaining": remaining,
        "completedGames": completed_games,
        "throughWeek": through_week,
    }


def standings_key(team):
    # Einziger Tiebreaker laut Bembel-Bowl-Regel: erzielte Punkte.
    return (-team["wins"], -team["ties"], -team["pointsFor"], team["name"].lower())


def classify_postseason(stats, divisions):
    division_rankings = {}
    division_winners = []
    division_runners_up = []
    for division_id, ids in divisions.items():
        ranked = sorted((stats[i] for i in ids), key=standings_key)
        division_rankings[division_id] = [t["id"] for t in ranked]
        division_winners.append(ranked[0])
        if len(ranked) > 1:
            division_runners_up.append(ranked[1])

    winners_ranked = sorted(division_winners, key=standings_key)
    wildcards = sorted(division_runners_up, key=standings_key)[:2]
    playoff_teams = winners_ranked + wildcards
    playoff_ids = {t["id"] for t in playoff_teams}

    # Seeds 1-4 sind die vier Divisionssieger; nur die besten zwei davon haben Bye.
    playoff_seeds = [t["id"] for t in winners_ranked] + [t["id"] for t in sorted(wildcards, key=standings_key)]
    overall = sorted(stats.values(), key=standings_key)
    non_playoff = [t for t in overall if t["id"] not in playoff_ids]
    consolation = non_playoff[:6]

    return {
        "divisionRankings": division_rankings,
        "divisionWinners": [t["id"] for t in winners_ranked],
        "wildcards": [t["id"] for t in wildcards],
        "playoffSeeds": playoff_seeds,
        "playoffByes": playoff_seeds[:2],
        "consolationSeeds": [t["id"] for t in consolation],
        "consolationByes": [t["id"] for t in consolation[:2]],
        "overall": [t["id"] for t in overall],
        "toiletBowl": overall[-1]["id"],
    }


def simulate_playoff_chances(snapshot, runs=PLAYOFF_SIMULATIONS):
    """Formbasierte Monte-Carlo-Simulation der restlichen Regular Season."""
    stats = snapshot["stats"]
    remaining = snapshot["remaining"]
    all_scores = [score for team in stats.values() for score in team.get("scores", [])]
    league_sigma = statistics.pstdev(all_scores) if len(all_scores) >= 2 else 18.0
    league_sigma = max(12.0, min(35.0, league_sigma))

    means = {}
    league_mean = statistics.mean(all_scores) if all_scores else 100.0
    for tid, team in stats.items():
        means[tid] = statistics.mean(team["scores"]) if team["scores"] else league_mean

    playoff_count = defaultdict(int)
    div_count = defaultdict(int)
    wildcard_count = defaultdict(int)
    bye_count = defaultdict(int)
    projected_wins = defaultdict(float)

    for _ in range(runs):
        sim = {
            tid: {
                **team,
                "wins": team["wins"],
                "losses": team["losses"],
                "ties": team["ties"],
                "pointsFor": team["pointsFor"],
            }
            for tid, team in stats.items()
        }
        for game in remaining:
            h, a = game["home"], game["away"]
            hs = max(0.0, random.gauss(means[h], league_sigma))
            aas = max(0.0, random.gauss(means[a], league_sigma))
            # Exakte Gleichstaende in einer kontinuierlichen Simulation sind praktisch ausgeschlossen.
            if hs >= aas:
                sim[h]["wins"] += 1
                sim[a]["losses"] += 1
            else:
                sim[a]["wins"] += 1
                sim[h]["losses"] += 1
            sim[h]["pointsFor"] += hs
            sim[a]["pointsFor"] += aas

        result = classify_postseason(sim, snapshot["divisions"])
        playoff_ids = set(result["playoffSeeds"])
        div_ids = set(result["divisionWinners"])
        wildcard_ids = set(result["wildcards"])
        bye_ids = set(result["playoffByes"])
        for tid in sim:
            playoff_count[tid] += int(tid in playoff_ids)
            div_count[tid] += int(tid in div_ids)
            wildcard_count[tid] += int(tid in wildcard_ids)
            bye_count[tid] += int(tid in bye_ids)
            projected_wins[tid] += sim[tid]["wins"]

    return {
        tid: {
            "playoffPct": round(100 * playoff_count[tid] / runs, 1),
            "divisionPct": round(100 * div_count[tid] / runs, 1),
            "wildcardPct": round(100 * wildcard_count[tid] / runs, 1),
            "byePct": round(100 * bye_count[tid] / runs, 1),
            "projectedWins": round(projected_wins[tid] / runs, 2),
        }
        for tid in stats
    }


def format_standings(snapshot, postseason=None, odds=None):
    stats = snapshot["stats"]
    overall = sorted(stats.values(), key=standings_key)
    lines = []
    playoff_ids = set((postseason or {}).get("playoffSeeds", []))
    consolation_ids = set((postseason or {}).get("consolationSeeds", []))
    for rank, team in enumerate(overall, start=1):
        tags = []
        if team["id"] in playoff_ids:
            tags.append("PLAYOFF")
        if team["id"] in consolation_ids:
            tags.append("CONSOLATION")
        if postseason and team["id"] == postseason.get("toiletBowl"):
            tags.append("TOILET BOWL")
        odd = odds.get(team["id"]) if odds else None
        odds_text = (
            f" | Playoffs {odd['playoffPct']:.1f}% | Division {odd['divisionPct']:.1f}% | "
            f"Wildcard {odd['wildcardPct']:.1f}% | Bye {odd['byePct']:.1f}% | proj. Siege {odd['projectedWins']:.2f}"
            if odd else ""
        )
        tag_text = f" | {'/'.join(tags)}" if tags else ""
        lines.append(
            f"{rank:02d}. {team['name']} | {team['divisionName']} | "
            f"{team['wins']}-{team['losses']}-{team['ties']} | PF {team['pointsFor']:.2f} | PA {team['pointsAgainst']:.2f}"
            f"{odds_text}{tag_text}"
        )
    return "\n".join(lines)


def load_special_examples(report_type, n=3):
    names = {
        "midseason": ["mid-season-recap.md", "midseason-recap.md"],
        "regular-season": ["regular-season-recap.md"],
        "season-awards": ["season-awards.md"],
        "championship": ["championship-week.md", "championship-recap.md"],
    }.get(report_type, [])
    matches = []
    for name in names:
        matches.extend(REFERENCE_DIR.rglob(name))
    # Neuere Beispiele bevorzugen; keine riesigen Archive komplett in einen Prompt kippen.
    matches = sorted(set(matches), reverse=True)
    chosen = matches[:n]
    result = []
    for path in chosen:
        text = path.read_text(encoding="utf-8")
        result.append(text[:14000])
    return result


def special_common_rules():
    return """BEMBEL-BOWL-REGELN, DIE DU EXAKT BEACHTEN MUSST:
- 20 Teams in vier Divisionen.
- Die vier Divisionssieger erreichen die Playoffs.
- Zusaetzlich qualifizieren sich die zwei Divisionszweiten mit dem besten Record.
- Bei gleichem Record sind die erzielten Punkte (Points For) der EINZIGE Tiebreaker.
- Die zwei besten Divisionssieger haben in der ersten Playoff-Woche Bye.
- Von den nicht fuer die Playoffs qualifizierten Teams gehen die sechs besten der Gesamttabelle in die Consolation Games.
- Auch dort haben die zwei besten dieser sechs in der ersten Runde Bye.
- Die Consolation Games spielen die Plaetze 7 bis 12 aus.
- Alle uebrigen Teams haben nach der Regular Season Saisonende.
- Das Team auf Gesamtrang 20 erhaelt automatisch den Toilet Bowl.
- Ein Spiel um Platz 3 wird ausgespielt.

DATENREGELN:
- Erfinde keine Scores, Records, Spielerleistungen, Verletzungen, Trades oder Wahrscheinlichkeiten.
- Prozentwerte fuer Playoff-Chancen stammen aus der Simulation und duerfen NICHT von dir veraendert werden.
- Historische Beispieltexte dienen nur dem Tonfall. Nie alte Fakten auf die aktuelle Saison uebertragen.
- Vermeide wiederkehrende Catchphrases und immer gleiche Absatzstrukturen.
- Sonderberichte duerfen deutlich ausfuehrlicher sein als Wochenberichte und muessen keiner Matchup-Struktur folgen."""


def build_midseason_prompt(style_guide, snapshot, odds):
    examples = "\n\n--- HISTORISCHES BEISPIEL ---\n\n".join(load_special_examples("midseason")) or "(keine)"
    standings = format_standings(snapshot, odds=odds)
    return f"""Du schreibst den MID-SEASON RECAP der Bembel Bowl Saison {SEASON} nach Woche {MIDSEASON_WEEK}.

STIL-GUIDE:\n{style_guide}

{special_common_rules()}

HISTORISCHE MID-SEASON-TEXTE (nur Stilreferenz):\n{examples}

AKTUELLER STAND + BERECHNETE MONTE-CARLO-CHANCEN ({PLAYOFF_SIMULATIONS} Simulationen):\n{standings}

AUFGABE:
- Schreibe einen eigenstaendigen langen Saisonartikel, keine Aneinanderreihung von Matchup-Recaps.
- Bewerte die bisherige Saison ALLER 20 Teams individuell und konkret anhand Record, Points For/Against, Division und Playoff-Chance.
- Ordne Divisionsrennen, Wildcard-Kampf und Bye-Chancen ein.
- Gib fuer jedes Team einen Ausblick auf die zweite Saisonhaelfte; nenne die berechnete Playoff-Chance exakt.
- Erklaere kurz, dass die Chancen aus einer formbasierten Simulation der Restspiele stammen und keine Garantie sind.
- Verwende abwechslungsreiche Zwischenueberschriften und unterschiedliche Einstiege in die Teamabschnitte.
- Keine Schulnotenpflicht. Lieber praegnante, individuelle Bewertungen.
- Zielumfang: etwa 2500 bis 4000 Woerter. Zwischenueberschriften als normale Textzeilen ohne Markdown-# schreiben.

Antworte nur mit dem fertigen Artikeltext."""


def collect_player_contributions(through_week):
    aggregate = {}
    for week in range(1, through_week + 1):
        print(f"  Lade Spielerleistungen Woche {week}/{through_week} fuer Awards ...")
        for matchup in fetch_week_matchups(week, strict=False):
            for fantasy_team, box in ((matchup["homeTeam"], matchup["homeBoxScore"]), (matchup["awayTeam"], matchup["awayBoxScore"])):
                for p in box:
                    key = p.get("playerId") or normalize_phrase(p.get("name"))
                    row = aggregate.setdefault(key, {
                        "playerId": p.get("playerId"), "name": p.get("name"), "position": p.get("position"),
                        "starterPoints": 0.0, "starts": 0, "bestWeek": 0.0, "fantasyTeams": defaultdict(int),
                    })
                    pts = float(p.get("points") or 0)
                    row["starterPoints"] += pts
                    row["starts"] += 1
                    row["bestWeek"] = max(row["bestWeek"], pts)
                    row["fantasyTeams"][fantasy_team] += 1
    for row in aggregate.values():
        row["fantasyTeam"] = max(row["fantasyTeams"], key=row["fantasyTeams"].get) if row["fantasyTeams"] else "?"
        row["fantasyTeams"] = dict(row["fantasyTeams"])
    return list(aggregate.values())


def enrich_rookies_with_sleeper(players):
    try:
        res = requests.get("https://api.sleeper.app/v1/players/nfl", timeout=35)
        res.raise_for_status()
        sleeper = res.json()
        by_name = {}
        for item in sleeper.values():
            name = normalize_phrase(item.get("full_name") or f"{item.get('first_name', '')} {item.get('last_name', '')}")
            if name:
                by_name[name] = item
        for p in players:
            item = by_name.get(normalize_phrase(p.get("name")))
            p["yearsExp"] = item.get("years_exp") if item else None
            p["isRookie"] = bool(item and item.get("years_exp") == 0)
    except Exception as exc:  # noqa: BLE001
        print(f"WARNUNG: Sleeper-Rookie-Daten nicht erreichbar ({exc}). Rookie Award bekommt keine automatische Kandidatenliste.")
        for p in players:
            p["yearsExp"] = None
            p["isRookie"] = False
    return players


def format_award_candidates(players):
    def top(filter_fn, n=8):
        rows = sorted((p for p in players if filter_fn(p)), key=lambda p: p["starterPoints"], reverse=True)[:n]
        return "\n".join(
            f"- {p['name']} ({p['position']}, {p['fantasyTeam']}): {p['starterPoints']:.2f} Starter-Punkte, "
            f"{p['starts']} Starts, beste Woche {p['bestWeek']:.2f}"
            for p in rows
        ) or "- keine belastbaren Kandidaten"

    return f"""MVP-Kandidaten (alle Positionen):
{top(lambda p: p['position'] not in {'K'})}

OPOY-Kandidaten (QB/RB/WR/TE/FLEX):
{top(lambda p: p['position'] in {'QB','RB','WR','TE','FLEX'})}

DEFENSE OF THE YEAR-Kandidaten (D/ST):
{top(lambda p: p['position'] == 'DEF')}

ROOKIE OF THE YEAR-Kandidaten (Sleeper years_exp == 0):
{top(lambda p: p.get('isRookie'))}"""


def team_fun_metrics(snapshot, postseason):
    stats = snapshot["stats"]
    overall = [stats[tid] for tid in postseason["overall"]]
    playoff_ids = set(postseason["playoffSeeds"])
    non_playoff = [t for t in overall if t["id"] not in playoff_ids]
    highest_pf = max(overall, key=lambda t: t["pointsFor"])
    lowest_pf = min(overall, key=lambda t: t["pointsFor"])
    highest_pa = max(overall, key=lambda t: t["pointsAgainst"])
    lowest_pa = min(overall, key=lambda t: t["pointsAgainst"])
    unlucky = max(non_playoff, key=lambda t: t["pointsFor"]) if non_playoff else highest_pa
    return {
        "highestPF": highest_pf["name"],
        "lowestPF": lowest_pf["name"],
        "highestPA": highest_pa["name"],
        "lowestPA": lowest_pa["name"],
        "bestPFNonPlayoff": unlucky["name"],
        "toiletBowl": stats[postseason["toiletBowl"]]["name"],
    }


def build_regular_season_prompt(style_guide, snapshot, postseason):
    examples = "\n\n--- HISTORISCHES BEISPIEL ---\n\n".join(load_special_examples("regular-season")) or "(keine)"
    standings = format_standings(snapshot, postseason=postseason)
    seed_names = [snapshot["stats"][tid]["name"] for tid in postseason["playoffSeeds"]]
    bye_names = [snapshot["stats"][tid]["name"] for tid in postseason["playoffByes"]]
    consolation_names = [snapshot["stats"][tid]["name"] for tid in postseason["consolationSeeds"]]
    consolation_byes = [snapshot["stats"][tid]["name"] for tid in postseason["consolationByes"]]
    toilet = snapshot["stats"][postseason["toiletBowl"]]["name"]
    return f"""Du schreibst den grossen REGULAR SEASON RECAP der Bembel Bowl Saison {SEASON} nach Woche {REGULAR_SEASON_WEEKS}.

STIL-GUIDE:\n{style_guide}

{special_common_rules()}

HISTORISCHE REGULAR-SEASON-RECAPS (nur Stilreferenz):\n{examples}

ABSCHLUSSTABELLE:\n{standings}

PLAYOFF-SEEDS 1-6: {', '.join(seed_names)}
BYE WEEK (beste zwei Divisionssieger): {', '.join(bye_names)}
CONSOLATION-TEILNEHMER Plaetze 7-12: {', '.join(consolation_names)}
CONSOLATION-BYES: {', '.join(consolation_byes)}
TOILET BOWL (Gesamtrang 20, automatisch): {toilet}

AUFGABE:
- Schreibe einen langen, redaktionellen Rueckblick auf die komplette Regular Season, nicht 20 Mini-Matchupberichte.
- Ordne alle 20 Teams und die vier Divisionen ein. Erklaere, wer sich wie qualifiziert hat und wer trotz moeglicherweise besserem Gesamtrang wegen der Divisions-/Wildcard-Regel nicht in die Playoffs kam.
- Stelle Playoff-Teilnehmer, beide Playoff-Byes, Consolation-Teilnehmer und beide Consolation-Byes korrekt vor.
- Bewerte die Saison jedes Teams individuell anhand Record, Points For/Against, Division und Endplatzierung.
- Keine Awards in diesem Text; die Season Awards sind ein eigener Bericht.
- Zielumfang: etwa 3000 bis 4800 Woerter. Zwischenueberschriften als normale Textzeilen ohne Markdown-# schreiben.

Antworte nur mit dem fertigen Artikeltext."""


def build_season_awards_prompt(style_guide, snapshot, postseason, players):
    examples = "\n\n--- HISTORISCHES BEISPIEL ---\n\n".join(load_special_examples("season-awards")) or "(keine)"
    standings = format_standings(snapshot, postseason=postseason)
    awards = format_award_candidates(players)
    fun = team_fun_metrics(snapshot, postseason)
    return f"""Du schreibst die SEASON AWARDS der Bembel Bowl Saison {SEASON} nach Abschluss der Regular Season.

STIL-GUIDE:\n{style_guide}

{special_common_rules()}

HISTORISCHE SEASON-AWARDS (nur Stilreferenz):\n{examples}

ABSCHLUSSTABELLE:\n{standings}

SPIELER-KANDIDATEN. WICHTIG: Die Zahlen sind Starter-Punkte in Bembel-Bowl-Lineups, keine erfundenen kompletten NFL-Season-Totals:\n{awards}

ZUSAETZLICHE DATEN FUER HUMOR-KATEGORIEN:
- Meiste Points For: {fun['highestPF']}
- Wenigste Points For: {fun['lowestPF']}
- Meiste Points Against: {fun['highestPA']}
- Wenigste Points Against: {fun['lowestPA']}
- Bestes Points-For-Team ausserhalb der Playoffs: {fun['bestPFNonPlayoff']}
- Toilet Bowl (FEST, Gesamtrang 20): {fun['toiletBowl']}

AUFGABE:
- Vergib Fantasy MVP, Offensive Player of the Year, Defense of the Year, Rookie of the Year und Toilet Bowl.
- Toilet Bowl ist FEST vorgegeben und darf nicht anders vergeben werden.
- Bei MVP/OPOY/DPOY/ROY nur Kandidaten aus den gelieferten Daten verwenden und mit Zahlen begruenden.
- MVP und OPOY duerfen dieselbe Person sein, wenn die Daten das rechtfertigen; vermeide aber kuenstliche Doppelungen in der Laudatio.
- Fuege mindestens 6 weitere humorvolle, wechselnde Bembel-Bowl-Kategorien hinzu. Beispiele: Pechvogel, Glueckspilz, Bank-Verbrechen, 'Wie ist das bitte passiert?', Punkte-Maschine, Wochenend-Schreck, Draft-/Waiver-Gold. Erfinde keine konkrete Transaktion, wenn sie nicht in den Daten steht.
- Die Kategorien sollen aus den aktuellen Daten entstehen und nicht jedes Jahr identisch sein.
- Schreibe zu jedem Award eine richtige Laudatio/Begruendung statt nur einer Liste.
- Zielumfang: etwa 2500 bis 4000 Woerter. Zwischenueberschriften als normale Textzeilen ohne Markdown-# schreiben.

Antworte nur mit dem fertigen Awards-Artikeltext."""


def _winner_loser(matchup):
    if matchup["homeScore"] >= matchup["awayScore"]:
        return matchup["homeTeamId"], matchup["awayTeamId"]
    return matchup["awayTeamId"], matchup["homeTeamId"]


def identify_championship_games(snapshot):
    postseason = classify_postseason(snapshot["stats"], snapshot["divisions"])
    playoff_ids = set(postseason["playoffSeeds"])
    semi_games = [m for m in fetch_week_matchups(CHAMPIONSHIP_WEEK - 1, strict=False)
                  if m.get("homeTeamId") in playoff_ids and m.get("awayTeamId") in playoff_ids]
    if len(semi_games) < 2:
        raise RuntimeError("Konnte die beiden Playoff-Halbfinals nicht eindeutig aus ESPN bestimmen.")
    semi_winners, semi_losers = set(), set()
    for game in semi_games[:2]:
        w, l = _winner_loser(game)
        semi_winners.add(w); semi_losers.add(l)

    finals = fetch_week_matchups(CHAMPIONSHIP_WEEK, strict=False)
    championship = next((m for m in finals if {m.get("homeTeamId"), m.get("awayTeamId")} == semi_winners), None)
    third_place = next((m for m in finals if {m.get("homeTeamId"), m.get("awayTeamId")} == semi_losers), None)
    if not championship:
        raise RuntimeError("Championship-Matchup konnte aus Halbfinals und Finalwoche nicht eindeutig bestimmt werden.")
    return postseason, semi_games[:2], championship, third_place


def format_matchup_detail(m):
    return (
        f"{m['homeTeam']} {m['homeScore']:.2f} : {m['awayScore']:.2f} {m['awayTeam']}\n"
        f"{m['homeTeam']} Starter:\n{format_box_score(m['homeBoxScore'])}\n"
        f"{m['awayTeam']} Starter:\n{format_box_score(m['awayBoxScore'])}"
    )


def build_championship_prompt(style_guide, snapshot):
    examples = "\n\n--- HISTORISCHES BEISPIEL ---\n\n".join(load_special_examples("championship")) or "(keine)"
    postseason, semis, final, third = identify_championship_games(snapshot)
    champion_id, runner_up_id = _winner_loser(final)
    champion = snapshot["stats"][champion_id]["name"]
    runner_up = snapshot["stats"][runner_up_id]["name"]
    third_block = format_matchup_detail(third) if third else "Kein eindeutig identifizierbares Spiel um Platz 3 in den ESPN-Daten."
    return f"""Du schreibst den abschliessenden CHAMPIONSHIP RECAP der Bembel Bowl Saison {SEASON}.

STIL-GUIDE:\n{style_guide}

{special_common_rules()}

HISTORISCHE CHAMPIONSHIP-TEXTE (nur Stilreferenz):\n{examples}

CHAMPION: {champion}
RUNNER-UP: {runner_up}

HALBFINALS:\n{format_matchup_detail(semis[0])}\n\n{format_matchup_detail(semis[1])}

FINALE:\n{format_matchup_detail(final)}

SPIEL UM PLATZ 3:\n{third_block}

REGULAR-SEASON-KONTEXT:\n{format_standings(snapshot, postseason=postseason)}

AUFGABE:
- Schreibe einen grossen Saisonabschluss mit klarem Schwerpunkt auf dem Finale.
- Erzaehle den Weg beider Finalisten ueber Halbfinale und Finale anhand der gelieferten Daten.
- Analysiere die entscheidenden Starter-Leistungen des Finals konkret.
- Wuerdige Champion und Runner-up, ohne in generische Siegesfloskeln zu verfallen.
- Nimm das Spiel um Platz 3 auf, falls Daten vorhanden sind, aber deutlich kuerzer als das Finale.
- Schlage am Ende den Bogen zur gesamten Saison.
- Keine erfundenen Play-by-play-Momente oder NFL-Ereignisse.
- Zielumfang: etwa 2000 bis 3200 Woerter. Zwischenueberschriften als normale Textzeilen ohne Markdown-# schreiben.

Antworte nur mit dem fertigen Artikeltext."""


def special_report_exists(db, report_type):
    snap = db.collection("matchReports").document(f"{SEASON}-special-{report_type}").get()
    return snap.exists and bool(str((snap.to_dict() or {}).get("content") or "").strip())


def save_special_report(db, report_type, through_week, content, metadata=None):
    db.collection("matchReports").document(f"{SEASON}-special-{report_type}").set({
        "season": SEASON,
        "type": report_type,
        "title": f"{SPECIAL_REPORT_TITLES[report_type]} {SEASON}",
        "throughWeek": through_week,
        "content": content,
        "generatedBy": "ai-agent",
        "generationModel": GEMINI_MODEL,
        "metadata": metadata or {},
        "updatedAt": firestore.SERVER_TIMESTAMP,
    }, merge=True)


def maybe_generate_special_reports(db, week, style_guide):
    regenerate = os.environ.get("REGENERATE_SPECIAL") == "true"
    if week == MIDSEASON_WEEK:
        report_types = ["midseason"]
    elif week == REGULAR_SEASON_WEEKS:
        report_types = ["regular-season", "season-awards"]
    elif week == CHAMPIONSHIP_WEEK:
        report_types = ["championship"]
    else:
        return

    regular_snapshot = None
    postseason = None
    player_contributions = None

    for report_type in report_types:
        if not regenerate and special_report_exists(db, report_type):
            print(f"Sonderbericht {report_type} ist bereits vorhanden - ueberspringe.")
            continue

        print(f"Erzeuge Saison-Sonderbericht: {report_type} ...")
        if report_type == "midseason":
            snapshot = fetch_league_snapshot(MIDSEASON_WEEK)
            odds = simulate_playoff_chances(snapshot)
            prompt = build_midseason_prompt(style_guide, snapshot, odds)
            content = generate_report(prompt, max_attempts=4, temperature=0.78, max_output_tokens=8192)
            save_special_report(db, report_type, MIDSEASON_WEEK, content, {
                "simulationRuns": PLAYOFF_SIMULATIONS,
                "method": "Monte Carlo; team scoring mean from completed games; league score standard deviation; remaining regular-season schedule",
                "playoffOdds": {str(k): v for k, v in odds.items()},
            })

        elif report_type in {"regular-season", "season-awards"}:
            if regular_snapshot is None:
                regular_snapshot = fetch_league_snapshot(REGULAR_SEASON_WEEKS)
                postseason = classify_postseason(regular_snapshot["stats"], regular_snapshot["divisions"])

            if report_type == "regular-season":
                prompt = build_regular_season_prompt(style_guide, regular_snapshot, postseason)
                content = generate_report(prompt, max_attempts=4, temperature=0.78, max_output_tokens=8192)
                save_special_report(db, report_type, REGULAR_SEASON_WEEKS, content, {
                    "playoffSeeds": postseason["playoffSeeds"],
                    "playoffByes": postseason["playoffByes"],
                    "consolationSeeds": postseason["consolationSeeds"],
                    "consolationByes": postseason["consolationByes"],
                    "toiletBowlTeamId": postseason["toiletBowl"],
                })
            else:
                if player_contributions is None:
                    player_contributions = enrich_rookies_with_sleeper(
                        collect_player_contributions(REGULAR_SEASON_WEEKS)
                    )
                prompt = build_season_awards_prompt(style_guide, regular_snapshot, postseason, player_contributions)
                content = generate_report(prompt, max_attempts=4, temperature=0.82, max_output_tokens=8192)
                save_special_report(db, report_type, REGULAR_SEASON_WEEKS, content, {
                    "toiletBowlTeamId": postseason["toiletBowl"],
                    "awardDataBasis": "Bembel-Bowl starter contributions; Sleeper years_exp for rookie candidates",
                })

        else:
            if regular_snapshot is None:
                regular_snapshot = fetch_league_snapshot(REGULAR_SEASON_WEEKS)
            prompt = build_championship_prompt(style_guide, regular_snapshot)
            content = generate_report(prompt, max_attempts=4, temperature=0.78, max_output_tokens=8192)
            save_special_report(db, report_type, CHAMPIONSHIP_WEEK, content, {})

        print(f"Sonderbericht {report_type} gespeichert.")


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


def report_exists(db, season, week, index):
    """True, wenn fuer dieses Matchup bereits ein nichtleerer Bericht existiert."""
    doc_id = f"{season}-w{week}-m{index}"
    snap = db.collection("matchReports").document(doc_id).get()
    if not snap.exists:
        return False
    data = snap.to_dict() or {}
    return bool(str(data.get("text") or "").strip())


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
    skip_existing = os.environ.get("SKIP_EXISTING") == "true"
    matchup_delay = int(os.environ.get("MATCHUP_DELAY_SECONDS", "15"))
    max_consecutive_gemini_failures = int(os.environ.get("MAX_CONSECUTIVE_GEMINI_FAILURES", "2"))

    # Bei GitHub-Schedule setzt der Workflow FORCE_RUN=true. Dadurch kann eine
    # von GitHub verspaetet gestartete Ausfuehrung niemals an dieser lokalen
    # Uhrzeitpruefung scheitern. Die Pruefung bleibt nur als Schutz fuer andere
    # direkte/manuelle Aufrufe des Python-Skripts bestehen.
    if not force_run and not is_scheduled_time_now(tolerance_minutes=180):
        print("Nicht im geplanten Dienstag-Zeitfenster - breche ab, ohne etwas zu tun.")
        sys.exit(0)

    if not validate_only:
        missing = [name for name in ("GEMINI_API_KEY", "FIREBASE_SERVICE_ACCOUNT") if not os.environ.get(name)]
        if missing:
            raise RuntimeError("Fehlende GitHub Secrets/Umgebungsvariablen: " + ", ".join(missing))

    week = determine_week()
    print(f"Saison {SEASON}, Spieltag {week}, League {LEAGUE_ID}")

    matchups = fetch_week_matchups(week, strict=not smoke_test)
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
        test_ref = db.collection("matchReports").document("automation-smoke-test")
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

    generated_count = 0
    skipped_count = 0
    generated_reports_this_run = []
    consecutive_gemini_failures = 0

    for index, matchup in enumerate(matchups, start=1):
        if skip_existing and report_exists(db, SEASON, week, index):
            skipped_count += 1
            print(
                f"Ueberspringe m{index}: Bericht fuer "
                f"{matchup['homeTeam']} vs. {matchup['awayTeam']} ist bereits vorhanden."
            )
            continue

        print(f"Erzeuge Bericht fuer {matchup['homeTeam']} vs. {matchup['awayTeam']} ...")
        try:
            # Bis zu drei Stilversuche: Wenn eine bereits in dieser Woche stark
            # benutzte Catchphrase/Einleitung erneut auftaucht, bekommt Gemini
            # gezieltes Feedback und schreibt nur diesen Bericht neu.
            text = None
            retry_note = ""
            for style_attempt in range(1, 4):
                prompt = build_prompt(
                    style_guide,
                    examples,
                    matchup,
                    report_index=index,
                    previous_reports=generated_reports_this_run,
                )
                if retry_note:
                    prompt += (
                        "\n\nZUSAETZLICHE KORREKTUR FUER DIESEN NEUVERSUCH:\n"
                        + retry_note
                        + "\nFormuliere den Bericht deutlich anders als beim vorherigen Versuch."
                    )

                candidate = sanitize_report_text(generate_report(prompt), matchup)
                repetition = report_has_forbidden_repetition(candidate, generated_reports_this_run)
                if not repetition:
                    text = candidate
                    break

                print(f"  Stilwiederholung erkannt ({repetition}); neuer Versuch ...")
                retry_note = (
                    f"Die Formulierung/Struktur '{repetition}' wurde in dieser Woche bereits verwendet. "
                    "Verwende einen anderen Einstieg, eine andere Dramaturgie und andere Redewendungen."
                )
                time.sleep(3)

            if not text:
                # Letzten Kandidaten nicht verwerfen, falls nur der Stil-Check
                # nach mehreren Versuchen weiterhin anschlaegt.
                text = candidate

            if not text.strip():
                raise RuntimeError("Der bereinigte Gemini-Bericht ist leer.")

            save_report(db, SEASON, week, index, matchup, text)
            generated_reports_this_run.append(text)
            generated_count += 1
            consecutive_gemini_failures = 0
            print("  gespeichert.")
        except Exception as e:  # noqa: BLE001
            err_text = str(e)
            failures.append((index, matchup, err_text))
            print(f"  FEHLER bei diesem Match-up: {e}")

            # Bei einer globalen Gemini-Stoerung/Rate-Limit nicht alle zehn
            # Matchups weiter bombardieren. Der naechste geplante Workflow
            # versucht dank SKIP_EXISTING nur die fehlenden Berichte erneut.
            if "Gemini" in err_text:
                consecutive_gemini_failures += 1
                if consecutive_gemini_failures >= max_consecutive_gemini_failures:
                    print(
                        f"  Abbruch nach {consecutive_gemini_failures} aufeinanderfolgenden "
                        "Gemini-Fehlern. Bereits gespeicherte Berichte bleiben erhalten; "
                        "der naechste Automatiklauf setzt bei den fehlenden Matchups fort."
                    )
                    break

        time.sleep(matchup_delay)  # API-Last zwischen Matchups reduzieren

    # Nach dem Lauf den tatsaechlichen Gesamtstand in Firestore pruefen.
    # Ein einzelner Gemini-Ausfall soll einen ansonsten erfolgreichen Spieltag
    # nicht mehr als komplett fehlgeschlagen markieren.
    existing_after_run = []
    missing_after_run = []
    for index in range(1, len(matchups) + 1):
        if report_exists(db, SEASON, week, index):
            existing_after_run.append(index)
        else:
            missing_after_run.append(index)

    if failures:
        summary = "; ".join(
            f"m{idx} {m['homeTeam']} vs. {m['awayTeam']}: {err}"
            for idx, m, err in failures
        )

        # GitHub Actions versteht ::warning:: als sichtbare Warnung, ohne den
        # gesamten Workflow rot zu markieren. Der naechste Lauf versucht dank
        # SKIP_EXISTING nur die noch fehlenden Matchups erneut.
        print(
            "::warning::"
            f"Teilweise erfolgreich: {len(existing_after_run)}/{len(matchups)} Berichte "
            f"sind vorhanden. Noch fehlend: {', '.join('m'+str(i) for i in missing_after_run) or 'keine'}. "
            f"Fehler dieses Laufs: {summary}"
        )

    # Nur wenn wirklich kein einziger Bericht vorhanden ist, gilt der Lauf als
    # vollstaendig gescheitert und soll in GitHub Actions rot werden.
    if not existing_after_run:
        raise RuntimeError(
            f"Kein Bericht fuer Saison {SEASON}, Spieltag {week} konnte erzeugt werden."
        )

    # Sonderberichte erst erzeugen, wenn alle Wochenberichte vollstaendig sind.
    if not missing_after_run:
        maybe_generate_special_reports(db, week, style_guide)
    else:
        print(
            f"Sonderberichte werden noch nicht erzeugt: {len(missing_after_run)} "
            "Wochenbericht(e) fehlen noch."
        )

    print(
        f"Fertig: {generated_count} neu erzeugt, {skipped_count} bereits vorhanden, "
        f"{len(existing_after_run)}/{len(matchups)} insgesamt vorhanden, "
        f"{len(missing_after_run)} noch fehlend."
    )


if __name__ == "__main__":
    main()
