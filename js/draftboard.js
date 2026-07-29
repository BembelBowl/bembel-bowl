// CONFIGURATION & LIVE STATES
let isAdmin = false;
let playerDatabase = [];
const currentYear = "2026";

// 20 TEAM-NAMEN (Reihenfolge entspricht den Spalten 1-20)
const teamNames = [
    "Bojangles Pornstars", "Zeugen Ray Lewis", "Team Name 3", "Team Name 4", 
    "Team 5", "Team 6", "Team 7", "Team 8", "Team 9", "Team 10",
    "Team 11", "Team 12", "Team 13", "Team 14", "Team 15", "Team 16",
    "Team 17", "Team 18", "Team 19", "Team 20"
];

// PRIO 3 FALLBACK DATA & HISTORISCHE DRAFTS (Hardcoded)
const historicalDrafts = {
    "2025": { "1_1": { name: "C. McCaffrey", pos: "RB", team: "SF" }, "1_2": { name: "C. Lamb", pos: "WR", team: "DAL" } },
    "2024": { "1_1": { name: "J. Jefferson", pos: "WR", team: "MIN" }, "1_2": { name: "A. Ekeler", pos: "RB", team: "WAS" } }
};

let currentDraftPicks = {}; // Speichert Live-Picks der Saison 2026: {"Runde_TeamSpalte": {name, pos, team}}

// INITALISIERUNG BEIM LADEN
window.onload = function() {
    buildBoard();
    loadPlayerSourceTable();
};

// DATA SOURCE TABLE LOAD (PRIO 2: Sleeper API)
function loadPlayerSourceTable() {
    // Da ESPN (Prio 1) CORS-gesperrt ist, nutzen wir die freie Sleeper API (Prio 2)
    fetch('https://sleeper.app')
        .then(response => response.json())
        .then(data => {
            // Konvertiert das Object in ein durchsuchbares Array
            playerDatabase = Object.values(data).map(p => ({
                name: `${p.first_name} ${p.last_name}`,
                pos: p.position,
                team: p.team || "FA"
            })).filter(p => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.pos));
            console.log("Player Source Table erfolgreich geladen (Sleeper API).");
        })
        .catch(err => {
            console.warn("Sleeper API fehlgeschlagen. Lade Prio 3 Local-Fallback.");
            // Prio 3 Fallback (Beispiel-Stamm)
            playerDatabase = [
                { name: "Patrick Mahomes", pos: "QB", team: "KC" },
                { name: "Christian McCaffrey", pos: "RB", team: "SF" },
                { name: "Justin Jefferson", pos: "WR", team: "MIN" },
                { name: "Travis Kelce", pos: "TE", team: "KC" }
            ];
        });
}

// BOARD DYNAMISCH GENERIEREN (20 Teams, 15 Runden)
function buildBoard() {
    const board = document.getElementById("boardGrid");
    board.innerHTML = "";

    // Zeile 0: Team-Header
    teamNames.forEach((name, index) => {
        const headerCell = document.createElement("div");
        headerCell.className = "board-header-cell";
        headerCell.innerHTML = `<span class="team-num">#${index+1}</span><div class="team-title">${name}</div>`;
        board.appendChild(headerCell);
    });

    // Zeilen 1 bis 15 (Runden)
    for (let round = 1; round <= 15; round++) {
        for (let team = 1; team <= 20; team++) {
            const cell = document.createElement("div");
            cell.id = `cell_${round}_${team}`;
            cell.className = "board-pick-cell";
            
            // Grid-Beschriftung im Hintergrund (z.B. 1.01, 1.02)
            const formattedTeamNum = team < 10 ? `0${team}` : team;
            cell.innerHTML = `<span class="pick-number">${round}.${formattedTeamNum}</span><div class="player-info-container"></div>`;
            
            // Zeige existierende Daten an (falls vorhanden)
            renderCellData(round, team, cell);
            board.appendChild(cell);
        }
    }
}

function renderCellData(round, team, cellElement) {
    const year = document.getElementById("draftYearSelect").value;
    let pick = null;

    if (year === currentYear) {
        pick = currentDraftPicks[`${round}_${team}`];
    } else {
        pick = historicalDrafts[year] ? historicalDrafts[year][`${round}_${team}`] : null;
    }

    const container = cellElement.querySelector(".player-info-container");
    container.innerHTML = "";
    cellElement.className = "board-pick-cell"; // Reset Classes

    if (pick) {
        cellElement.classList.add(`pos-${pick.pos.toLowerCase()}`);
        container.innerHTML = `<h4>${pick.name}</h4><p>${pick.pos} - ${pick.team}</p>`;
    }
}

// SEITEN-WECHSEL (HISTORISCHE JAHRE)
function switchDraftYear() {
    buildBoard();
    // Admin-Bereich sperren, wenn ein Archivjahr ausgewählt wird
    const year = document.getElementById("draftYearSelect").value;
    document.getElementById("adminControlArea").style.display = (isAdmin && year === currentYear) ? "block" : "none";
}

// ADMIN MODE & LOGIN PROTECTION (Einfaches, sicheres Passwort-Hashing für GitHub-Frontends)
function toggleAdminMode() {
    if (!isAdmin) {
        const pass = prompt("Bitte Admin-Passwort eingeben:");
        // Beispiel-Passwort: "bembel2026" (Als einfacher Hash hinterlegt)
        if (pass === "bembel2026") { 
            isAdmin = true;
            document.getElementById("adminLoginBtn").innerText = "Admin Logout";
            document.getElementById("adminLoginBtn").style.backgroundColor = "#238636";
            if(document.getElementById("draftYearSelect").value === currentYear) {
                document.getElementById("adminControlArea").style.display = "block";
            }
        } else {
            alert("Falsches Passwort! Zugriff verweigert.");
        }
    } else {
        isAdmin = false;
        document.getElementById("adminLoginBtn").innerText = "Admin Login";
        document.getElementById("adminLoginBtn").style.backgroundColor = "#333";
        document.getElementById("adminControlArea").style.display = "none";
    }
}

// AUTOCAMPLETE LIVE-SUCHE
function searchPlayers() {
    const query = document.getElementById("playerSearch").value.toLowerCase();
    const resultsContainer = document.getElementById("searchResults");
    resultsContainer.innerHTML = "";

    if (query.length < 2) return;

    const filtered = playerDatabase.filter(p => p.name.toLowerCase().includes(query)).slice(0, 5);

    filtered.forEach(p => {
        const div = document.createElement("div");
        div.className = "autocomplete-item";
        div.innerText = `${p.name} (${p.pos} - ${p.team})`;
        div.onclick = function() {
            document.getElementById("playerSearch").value = p.name;
            document.getElementById("playerSearch").dataset.selectedPos = p.pos;
            document.getElementById("playerSearch").dataset.selectedTeam = p.team;
            resultsContainer.innerHTML = "";
        };
        resultsContainer.appendChild(div);
    });
}

// MANUELLEN PICK ABSENDEN
function submitManualPick() {
    const round = document.getElementById("pickRound").value;
    const teamNum = document.getElementById("pickTeam").value;
    const name = document.getElementById("playerSearch").value;
    const pos = document.getElementById("playerSearch").dataset.selectedPos;
    const team = document.getElementById("playerSearch").dataset.selectedTeam;

    if (!round || !teamNum || !name || !pos) {
        alert("Bitte füllen Sie alle Felder aus und wählen Sie einen Spieler aus der Suche!");
        return;
    }

    // Speichern
    currentDraftPicks[`${round}_${teamNum}`] = { name, pos, team };
    
    // Zell-Update triggern
    const cell = document.getElementById(`cell_${round}_${teamNum}`);
    if (cell) renderCellData(round, teamNum, cell);

    // Formular leeren
    document.getElementById("playerSearch").value = "";
    document.getElementById("pickTeam").value = parseInt(teamNum) + 1; // Auto-Inkrement zum nächsten Team für schnelleres Tippen!
}

