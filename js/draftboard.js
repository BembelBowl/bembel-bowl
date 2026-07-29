let isAdmin = false;
let playerDatabase = [];
const currentYear = "2026";
let teamNamesArray = [];

// Geheimer Passwort-Hash für den Admin-Login
const ADMIN_PASSWORD_HASH = "d0170354e8d5c5ce86eb5f5cac4d8625b74671af14b187621a2735c151b0183e";

// HISTORISCHE DRAFTS (Hier können Excel-Daten in dieses strukturierte Format eingetragen werden)
const historicalDrafts = {
    "2025": { "1_1": { name: "C. McCaffrey", pos: "RB", team: "SF" }, "1_2": { name: "C. Lamb", pos: "WR", team: "DAL" } },
    "2024": { "1_1": { name: "J. Jefferson", pos: "WR", team: "MIN" }, "1_2": { name: "A. Ekeler", pos: "RB", team: "WAS" } }
};

// Lädt Daten aus dem Browserspeicher, falls vorhanden [index='1.3.1', index='1.3.8']
let currentDraftPicks = JSON.parse(localStorage.getItem('bembel_picks_2026')) || {};

window.onload = function() {
    loadTeamsFromHTML();
    buildBoard();
    loadPlayerSourceTable();
};

// Liest die Teamnamen direkt aus dem HTML-Gerüst aus
function loadTeamsFromHTML() {
    const source = document.querySelectorAll("#htmlTeamSource span");
    const select = document.getElementById("pickTeamSelect");
    teamNamesArray = [];
    select.innerHTML = '<option value="">-- Team wählen --</option>';

    source.forEach(span => {
        const id = span.getAttribute("data-id");
        const name = span.getAttribute("data-name");
        teamNamesArray.push(name);
        
        let opt = document.createElement("option");
        opt.value = id;
        opt.innerText = `#${id} - ${name}`;
        select.appendChild(opt);
    });
}

// Strikte Abfrage über Sleeper API (Kein Fallback-Array mehr)
function loadPlayerSourceTable() {
    fetch('https://sleeper.app')
        .then(response => response.json())
        .then(data => {
            playerDatabase = Object.values(data).map(p => ({
                name: `${p.first_name} ${p.last_name}`,
                pos: p.position,
                team: p.team || "FA"
            })).filter(p => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.pos));
            console.log("Source Table via Sleeper API einsatzbereit.");
        })
        .catch(err => console.error("API-Ladefehler: ", err));
}

// Rendert das 20x15 Raster
function buildBoard() {
    const board = document.getElementById("boardGrid");
    board.innerHTML = "";

    teamNamesArray.forEach((name, index) => {
        const headerCell = document.createElement("div");
        headerCell.className = "board-header-cell";
        headerCell.innerHTML = `<span class="team-num">#${index+1}</span><div class="team-title">${name}</div>`;
        board.appendChild(headerCell);
    });

    for (let round = 1; round <= 15; round++) {
        for (let team = 1; team <= 20; team++) {
            const cell = document.createElement("div");
            cell.id = `cell_${round}_${team}`;
            cell.className = "board-pick-cell";
            const formattedTeamNum = team < 10 ? `0${team}` : team;
            cell.innerHTML = `<span class="pick-number">${round}.${formattedTeamNum}</span><div class="player-info-container"></div>`;
            
            // Ermöglicht das Anklicken einer Zelle im Admin-Modus zum schnellen Bearbeiten
            cell.onclick = function() {
                if(isAdmin && document.getElementById("draftYearSelect").value === currentYear) {
                    document.getElementById("pickRound").value = round;
                    document.getElementById("pickTeamSelect").value = team;
                }
            };
            
            renderCellData(round, team, cell);
            board.appendChild(cell);
        }
    }
}

function renderCellData(round, team, cellElement) {
    const year = document.getElementById("draftYearSelect").value;
    let pick = (year === currentYear) ? currentDraftPicks[`${round}_${team}`] : (historicalDrafts[year] ? historicalDrafts[year][`${round}_${team}`] : null);

    const container = cellElement.querySelector(".player-info-container");
    container.innerHTML = "";
    cellElement.className = "board-pick-cell";

    if (pick) {
        cellElement.classList.add(`pos-${pick.pos.toLowerCase()}`);
        container.innerHTML = `<h4>${pick.name}</h4><p>${pick.pos} - ${pick.team}</p>`;
    }
}

function submitManualPick() {
    const round = document.getElementById("pickRound").value;
    const teamNum = document.getElementById("pickTeamSelect").value;
    const name = document.getElementById("playerSearch").value;
    const pos = document.getElementById("playerSearch").dataset.selectedPos;
    const team = document.getElementById("playerSearch").dataset.selectedTeam;

    if (!round || !teamNum || !name || !pos) {
        alert("Bitte wählen Sie ein Team, eine Runde und einen Spieler aus der Suche!");
        return;
    }

    // Pick eintragen oder bestehenden Pick überschreiben
    currentDraftPicks[`${round}_${teamNum}`] = { name, pos, team };
    
    // Im lokalen Browserspeicher persistieren [index='1.3.1', index='1.3.7']
    localStorage.setItem('bembel_picks_2026', JSON.stringify(currentDraftPicks));
    
    renderCellData(round, teamNum, document.getElementById(`cell_${round}_${teamNum}`));

    document.getElementById("playerSearch").value = "";
    document.getElementById("searchResults").innerHTML = "";
}

// LÖSCHFUNKTION FÜR PICKS
function deleteSelectedPick() {
    const round = document.getElementById("pickRound").value;
    const teamNum = document.getElementById("pickTeamSelect").value;

    if (!round || !teamNum) {
        alert("Bitte wählen Sie zuerst die Runde und das Team aus, dessen Pick gelöscht werden soll!");
        return;
    }

    if(currentDraftPicks[`${round}_${teamNum}`]) {
        delete currentDraftPicks[`${round}_${teamNum}`];
        localStorage.setItem('bembel_picks_2026', JSON.stringify(currentDraftPicks)); // Speicher aktualisieren [index='1.3.1', index='1.3.7']
        renderCellData(round, teamNum, document.getElementById(`cell_${round}_${teamNum}`));
        alert(`Pick in Runde ${round} für Team ${teamNum} erfolgreich entfernt.`);
    } else {
        alert("Auf dieser Position existiert kein aktiver Pick, der gelöscht werden könnte.");
    }
}

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

function switchDraftYear() {
    buildBoard();
    const year = document.getElementById("draftYearSelect").value;
    document.getElementById("adminControlArea").style.display = (isAdmin && year === currentYear) ? "block" : "none";
}

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function toggleAdminMode() {
    if (!isAdmin) {
        const inputPassword = prompt("Bitte Admin-Passwort eingeben:");
        if (!inputPassword) return;
        const inputHash = await sha256(inputPassword);

        if (inputHash === ADMIN_PASSWORD_HASH) { 
            isAdmin = true;
            document.getElementById("adminLoginBtn").innerText = "Admin Logout";
            document.getElementById("adminLoginBtn").style.backgroundColor = "#238636";
            if(document.getElementById("draftYearSelect").value === currentYear) {
                document.getElementById("adminControlArea").style.display = "block";
            }
        } else {
            alert("Falsches Passwort!");
        }
    } else {
        isAdmin = false;
        document.getElementById("adminLoginBtn").innerText = "Admin Login";
        document.getElementById("adminLoginBtn").style.backgroundColor = "#333";
        document.getElementById("adminControlArea").style.display = "none";
    }
}

// ==========================================
// INTEGRATIONSDATENBANK PER API VERFÜGBAR MACHEN
// ==========================================
// Ermöglicht den Abruf der aktuellen Picks als JSON-Daten über die Browser-Konsole oder Skripte:
// Aufruf im Browser per: window.getBembelBowlDatabaseAPI()
window.getBembelBowlDatabaseAPI = function() {
    return {
        leagueName: "Bembel Bowl",
        season: currentYear,
        totalTeams: teamNamesArray.length,
        totalRounds: 15,
        teams: teamNamesArray,
        picks: currentDraftPicks
    };
};
