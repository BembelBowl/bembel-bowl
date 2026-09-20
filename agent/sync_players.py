#!/usr/bin/env python3
"""Synchronisiert den zentralen Bembel-Bowl-Spielerbestand aus Sleeper nach Firestore.

Ergebnis:
  players/<canonicalPlayerId>
  playerData/current

Die Web-Seiten lesen danach ausschließlich diesen zentralen Firestore-Bestand.
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone

import firebase_admin
import requests
from firebase_admin import credentials, firestore

SLEEPER_PLAYERS_URL = "https://api.sleeper.app/v1/players/nfl"
ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
POSITIONS = {"QB", "RB", "WR", "TE", "K"}
NFL_TEAMS = {
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE",
    "DAL", "DEN", "DET", "GB", "HOU", "IND", "JAX", "KC",
    "LV", "LAC", "LAR", "MIA", "MIN", "NE", "NO", "NYG",
    "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WAS",
}
TEAM_ALIASES = {"WSH": "WAS", "JAC": "JAX"}


def canonical_team(value: str | None) -> str:
    team = (value or "").upper().strip()
    return TEAM_ALIASES.get(team, team)


def safe_doc_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-") or "unknown"


def init_firestore():
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not raw:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT fehlt")
    data = json.loads(raw)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(credentials.Certificate(data))
    return firestore.client()


def fetch_sleeper_players() -> dict:
    response = requests.get(SLEEPER_PLAYERS_URL, timeout=45)
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, dict) or not data:
        raise RuntimeError("Sleeper lieferte keine Spielerdaten")
    return data


def derive_bye_weeks(season: int) -> dict[str, int]:
    """Leitet Bye Weeks aus dem ESPN-Regular-Season-Spielplan ab.

    Falls ESPN für eine Woche keine vollständige Teamliste liefert, wird diese
    Woche ignoriert. Ein fehlender Bye-Wert blockiert den Spieler-Sync nicht.
    """
    appearances: dict[str, set[int]] = {team: set() for team in NFL_TEAMS}
    usable_weeks: set[int] = set()

    for week in range(1, 19):
        try:
            response = requests.get(
                ESPN_SCOREBOARD,
                params={"dates": str(season), "seasontype": 2, "week": week, "limit": 100},
                timeout=20,
            )
            response.raise_for_status()
            data = response.json()
            seen: set[str] = set()
            for event in data.get("events", []):
                for competition in event.get("competitions", []):
                    for competitor in competition.get("competitors", []):
                        abbr = canonical_team((competitor.get("team") or {}).get("abbreviation"))
                        if abbr in NFL_TEAMS:
                            seen.add(abbr)
            # Eine reguläre NFL-Woche enthält typischerweise mindestens 26 Teams.
            if len(seen) >= 26:
                usable_weeks.add(week)
                for team in seen:
                    appearances[team].add(week)
        except Exception as exc:  # Bye Weeks sind Zusatzdaten; Sync soll weiterlaufen.
            print(f"WARN: Bye-Week-Abfrage Woche {week} fehlgeschlagen: {exc}")

    byes: dict[str, int] = {}
    if not usable_weeks:
        return byes

    for team in NFL_TEAMS:
        missing = sorted(w for w in usable_weeks if w not in appearances[team])
        # Byes liegen in der Regular Season; genau eine fehlende nutzbare Woche ist ideal.
        if len(missing) == 1:
            byes[team] = missing[0]
    return byes


def build_players(raw_players: dict, bye_weeks: dict[str, int]) -> dict[str, dict]:
    output: dict[str, dict] = {}
    defense_teams: set[str] = set()

    for sleeper_id, item in raw_players.items():
        if not isinstance(item, dict):
            continue
        position = (item.get("position") or "").upper()
        team = canonical_team(item.get("team"))
        active = item.get("active") is True

        if position == "DEF":
            if team in NFL_TEAMS:
                defense_teams.add(team)
            continue
        if position not in POSITIONS:
            continue
        # Für den Draft relevant: aktive Spieler oder Spieler mit aktuellem NFL-Team.
        if not active and team not in NFL_TEAMS:
            continue

        name = item.get("full_name") or " ".join(
            p for p in [item.get("first_name"), item.get("last_name")] if p
        ).strip()
        if not name:
            continue

        doc_id = safe_doc_id(f"sleeper-{sleeper_id}")
        output[doc_id] = {
            "playerId": doc_id,
            "sleeperId": str(sleeper_id),
            "source": "Sleeper",
            "sourcePlayerId": str(sleeper_id),
            "name": name,
            "searchName": name.lower(),
            "firstName": item.get("first_name") or "",
            "lastName": item.get("last_name") or "",
            "position": position,
            "fantasyPositions": item.get("fantasy_positions") or [position],
            "nflTeam": team,
            "byeWeek": bye_weeks.get(team),
            "status": item.get("status") or "",
            "injuryStatus": item.get("injury_status") or "",
            "active": bool(active),
            "number": item.get("number"),
            "age": item.get("age"),
            "draftEligible": True,
        }

    # D/ST explizit einmal pro NFL-Team anlegen; dadurch sind alle 32 sicher verfügbar.
    for team in sorted(NFL_TEAMS | defense_teams):
        doc_id = f"def-{team.lower()}"
        output[doc_id] = {
            "playerId": doc_id,
            "sleeperId": None,
            "source": "Sleeper",
            "sourcePlayerId": team,
            "name": f"{team} Defense",
            "searchName": f"{team} defense".lower(),
            "firstName": team,
            "lastName": "Defense",
            "position": "DEF",
            "fantasyPositions": ["DEF"],
            "nflTeam": team,
            "byeWeek": bye_weeks.get(team),
            "status": "Active",
            "injuryStatus": "",
            "active": True,
            "number": None,
            "age": None,
            "draftEligible": True,
        }

    return output


def commit_ops(db, writes: list[tuple[str, str, dict | None]]):
    # Firestore-Batches max. 500 Operationen; etwas Puffer lassen.
    for start in range(0, len(writes), 450):
        batch = db.batch()
        for op, doc_id, payload in writes[start:start + 450]:
            ref = db.collection("players").document(doc_id)
            if op == "set":
                batch.set(ref, payload, merge=False)
            else:
                batch.delete(ref)
        batch.commit()


def main():
    season = int(os.environ.get("PLAYER_SEASON") or datetime.now(timezone.utc).year)
    print(f"Synchronisiere zentrale Spielerdaten für Saison {season} …")
    db = init_firestore()
    raw = fetch_sleeper_players()
    print(f"Sleeper Rohdatensätze: {len(raw)}")

    bye_weeks = derive_bye_weeks(season)
    print(f"Bye Weeks erkannt: {len(bye_weeks)} Teams")
    players = build_players(raw, bye_weeks)
    print(f"Draft-relevante Spieler/DST: {len(players)}")
    if len(players) < 300:
        raise RuntimeError(f"Unplausibel wenige Spieler ({len(players)}); Firestore wird nicht überschrieben")

    existing = {snap.id for snap in db.collection("players").stream()}
    current = set(players)
    writes: list[tuple[str, str, dict | None]] = []
    now = firestore.SERVER_TIMESTAMP
    for doc_id, payload in players.items():
        payload = dict(payload)
        payload["season"] = season
        payload["updatedAt"] = now
        writes.append(("set", doc_id, payload))
    for stale_id in sorted(existing - current):
        writes.append(("delete", stale_id, None))

    commit_ops(db, writes)
    db.collection("playerData").document("current").set({
        "season": season,
        "source": "Sleeper",
        "playerCount": len(players),
        "byeWeekCount": len(bye_weeks),
        "syncedAt": firestore.SERVER_TIMESTAMP,
        "schemaVersion": 1,
    })
    print(f"OK: {len(players)} Spieler synchronisiert; {len(existing - current)} veraltete Dokumente entfernt")


if __name__ == "__main__":
    main()
