# Phase 3 – Zentrale Sleeper-Spielerdatenbank

## Ziel
Big Board und Team-Draftseite verwenden denselben zentralen Spielerbestand aus Firestore. Browser laden nicht mehr jeweils eine eigene ESPN-/Sleeper-Spielerliste.

## Firestore
- `players/<playerId>` – ein Dokument je Spieler bzw. D/ST
- `playerData/current` – Metadaten des letzten Syncs

Gespeichert werden u. a.:
- stabile Player-ID
- Sleeper-ID
- Name
- Position
- NFL-Team
- Bye Week (sofern aus dem NFL-Spielplan zuverlässig ableitbar)
- Aktiv-/Injury-Status
- Sync-Saison und Zeitstempel

## Synchronisation
Workflow: `.github/workflows/sync-players.yml`

- automatisch täglich um 05:23 Uhr Europe/Berlin
- zusätzlich manuell über GitHub Actions startbar
- nutzt den bestehenden Secret `FIREBASE_SERVICE_ACCOUNT`
- Quelle für Spieler: Sleeper
- Bye Weeks: aus dem ESPN-Regular-Season-Spielplan abgeleitet

Der Workflow schreibt mit Firebase Admin SDK. Die Browser haben auf `players` und `playerData` ausschließlich Lesezugriff.

## Erster Start
Nach Deployment einmal GitHub → Actions → `Sync Player Database` → `Run workflow` ausführen.
Danach sollte Firestore `playerData/current` mit `playerCount` und `syncedAt` enthalten und die Collection `players` gefüllt sein.

## Frontend
- `draft-board.html` lädt zentral aus Firestore; bei Ausfall bleibt nur die kleine bestehende Notfallliste.
- `draft-team.html` lädt ausschließlich zentral aus Firestore. Ist der Sync nicht vorhanden, wird eine klare Fehlermeldung angezeigt.
- Bei neuen Picks werden `playerId`, Quelle und `byeWeek` mitgespeichert.

## Sicherheit
`firestore.rules` erlaubt öffentliches Lesen der zentralen Spielerbasis, aber keinerlei Browser-Schreibzugriff. Der Sync erfolgt ausschließlich über Firebase Admin SDK.
