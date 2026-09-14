# Tuesday Weekly Reports – Go-Live Checklist

## Einmalig vor Dienstag

In GitHub unter **Settings → Secrets and variables → Actions** muessen diese Repository Secrets existieren:

- `GEMINI_API_KEY`
- `FIREBASE_SERVICE_ACCOUNT` – kompletter Inhalt der Firebase-Service-Account-JSON
- `ESPN_LEAGUE_ID` – fuer Bembel Bowl normalerweise `843833275`

## Empfohlener Test vor dem ersten automatischen Lauf

GitHub → **Actions → Weekly Reports → Run workflow**

- `week`: den bereits abgeschlossenen Spieltag eintragen (z. B. `1`)
- `force_run`: `true`
- `validate_only`: `true`

Dieser Test ruft ESPN real ab und prueft:

- genau 10 Match-ups
- nicht nur 0:0-Scores
- Starter-Boxscores fuer beide Seiten
- Stil-Guide vorhanden
- historische Beispielberichte gefunden

Er ruft **Gemini nicht** auf und schreibt **nichts nach Firestore**.

## Automatischer Lauf

Dienstags um **12:17 Uhr Europe/Berlin**.

Der Workflow:
1. ermittelt den zuletzt abgeschlossenen ESPN-Scoring-Zeitraum,
2. laedt Scoreboard + Matchup + Teams + Boxscores,
3. validiert die Daten,
4. erzeugt pro Matchup einen Bericht mit `gemini-3.6-flash`,
5. schreibt die Berichte nach `matchReports` in Firestore.

Bei einem Fehler in einem oder mehreren Matchups endet der Workflow nun mit **rot/failed**, statt trotz Teilfehlern gruen zu werden.

## Kompletter Smoke-Test (empfohlen)

GitHub → **Actions → Weekly Reports → Run workflow**

- `week`: aktuellen/letzten Spieltag eintragen (z. B. `1`)
- `force_run`: `true`
- `validate_only`: `false`
- `smoke_test`: `true`

Dieser Lauf prueft ESPN, Gemini und Firebase. In `matchReports` wird kurz das Dokument
`__automation_smoke_test__` angelegt und direkt wieder geloescht. Es werden keine echten
Spielberichte gespeichert. Wenn dieser Workflow gruen endet, sind die externen Zugriffe
und Secrets fuer Dienstag funktional.
