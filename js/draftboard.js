// Firebase SDK Module direkt über CDN einbinden
import { initializeApp } from "https://gstatic.com";
import { getFirestore, doc, setDoc, deleteDoc, onSnapshot } from "https://gstatic.com";

// ==========================================
// 1. IHRE FIREBASE KONFIGURATION (Hier eintragen!)
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyCywC-tZbMiSEEu9DTFqV4NyXLNQl4oUpc",
  authDomain: "bembel-bowl-draftboard.firebaseapp.com",
  projectId: "bembel-bowl-draftboard",
  storageBucket: "bembel-bowl-draftboard.firebasestorage.app",
  messagingSenderId: "1087232469095",
  appId: "1:1087232469095:web:be18355f80b85d22190cc2",
  measurementId: "G-M7G9J2DXSH"
};

// Firebase initialisieren
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Globale Variablen
let isAdmin = false;
let playerDatabase = [];
const currentYear = "2026";
let teamNamesArray = [];
const ADMIN_PASSWORD_HASH = "e71a07bd24b91b97950c4a4da07e9f3b1451f5051fb87d60a169bbf6b14f8a44";

const historicalDrafts = {
    "2025": { "1_1": { name: "C. McCaffrey", pos: "RB", team: "SF" } },
    "2024": { "1_1": { name: "J. Jefferson", pos: "WR", team: "MIN" } }
};

let currentDraftPicks = {};

window.onload = function() {
    loadTeamsFromHTML();
    buildBoard();
    loadPlayerSourceTable();
    listenToLiveDraft(); // Startet die weltweite Echtzeit-Synchronisation
};

// 2. ECHTZEIT-STREAM AUS DER CLOUD
function listenToLiveDraft() {
    // Hört permanent auf Änderungen in der Cloud-Datenbank für das Jahr 2026
    onSnapshot(doc(db, "bembel_bowl_drafts", currentYear), (docSnap) => {
        if (docSnap.exists()) {
            currentDraftPicks = docSnap.data();
        } else {
            currentDraftPicks = {};
        }
        // Aktualisiert das Board für jeden Nutzer weltweit sofort auf dem Bildschirm
        if (document.getElementById("draftYearSelect").value === currentYear) {
            updateAllCells();
        }
    });
}

function updateAllCells() {
    for (let round = 1; round <= 15; round++) {
        for (let team = 1; team <= 20; team++) {
            const cell = document.getElementById(`cell_${round}_${team}`);
            if (cell) renderCellData(round, team, cell);
        }
    }
}

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

function loadPlayerSourceTable() {
    fetch('https://sleeper.app')
        .then(response => response.json())
        .then(data => {
            playerDatabase = Object.values(data).map(p => ({
                name: `${p.first_name} ${p.last_name}`,
                pos: p.position,
                team: p.team || "FA"
            })).filter(p => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(p.pos));
        })
        .catch(err => console.error("API Fehler: ", err));
}

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

// ASYNC CLOUD UPDATE BEIM PICKEN
async function submitManualPick() {
    const round = document.getElementById("pickRound").value;
    const teamNum = document.getElementById("pickTeamSelect").value;
    const name = document.getElementById("playerSearch").value;
    const pos = document.getElementById("playerSearch").dataset.selectedPos;
    const team = document.getElementById("playerSearch").dataset.selectedTeam;

    if (!round || !teamNum || !name || !pos) {
        alert("Bitte alles ausfüllen!");
        return;
    }

    // Lokal aktualisieren
    currentDraftPicks[`${round}_${teamNum}`] = { name, pos, team };
    
    // In die Cloud hochladen - Synchronisiert sofort alle eingeloggten Mitspieler weltweit
    await setDoc(doc(db, "bembel_bowl_drafts", currentYear), currentDraftPicks);

    document.getElementById("playerSearch").value = "";
    document.getElementById("searchResults").innerHTML = "";
}

// ASYNC CLOUD UPDATE BEIM LÖSCHEN
async function deleteSelectedPick() {
    const round = document.getElementById("pickRound").value;
    const teamNum = document.getElementById("pickTeamSelect").value;

    if (!round || !teamNum) return;

    if(currentDraftPicks[`${round}_${teamNum}`]) {
        delete currentDraftPicks[`${round}_${teamNum}`];
        // Aktualisierten Stand in die Cloud jagen
        await setDoc(doc(db, "bembel_bowl_drafts", currentYear), currentDraftPicks);
        alert("Pick gelöscht!");
    }
}

// Suchfunktion & Hilfen bleiben gleich...
window.searchPlayers = function() {
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

window.switchDraftYear = function() { buildBoard(); const year = document.getElementById("draftYearSelect").value; document.getElementById("adminControlArea").style.display = (isAdmin && year === currentYear) ? "block" : "none"; }
async function sha256(message) { const msgBuffer = new TextEncoder().encode(message); const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer); return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join(''); }
window.toggleAdminMode = async function() {
    if (!isAdmin) {
        const inputPassword = prompt("Bitte Admin-Passwort eingeben:");
        if (!inputPassword) return;
        const inputHash = await sha256(inputPassword);
        if (inputHash === ADMIN_PASSWORD_HASH) { 
            isAdmin = true;
            document.getElementById("adminLoginBtn").innerText = "Admin Logout";
            document.getElementById("adminLoginBtn").style.backgroundColor = "#238636";
            if(document.getElementById("draftYearSelect").value === currentYear) document.getElementById("adminControlArea").style.display = "block";
        } else { alert("Falsches Passwort!"); }
    } else {
        isAdmin = false;
        document.getElementById("adminLoginBtn").innerText = "Admin Login";
        document.getElementById("adminLoginBtn").style.backgroundColor = "#333";
        document.getElementById("adminControlArea").style.display = "none";
    }
}
