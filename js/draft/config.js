export const firebaseConfig = {
  apiKey: "AIzaSyALAGTVbpTqMYmqmmf3dJyes0A39483iUE",
  authDomain: "bembel-bowl.firebaseapp.com",
  projectId: "bembel-bowl",
  storageBucket: "bembel-bowl.firebasestorage.app",
  messagingSenderId: "836256439134",
  appId: "1:836256439134:web:c39ef91c216da594020dcf"
};

export const DRAFT = {
  season: 2026,
  teamCount: 20,
  roundCount: 15,
  scoring: 'ppr',
  adpTeams: 14,
  autoPickDelayMs: 60_000,
  adminLeaseMs: 20_000,
  adminLeaseRenewMs: 8_000,
  positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'],
  starterLimits: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1, FLEX: 1 },
  // Offizielle Default-Reihenfolge aus den Draft-Regeln.
  fallbackRoundPlan: ['QB','RB','WR','TE','K','DEF','RB','WR','FLEX','QB','RB','WR','TE','K','RB']
};

export const COLLECTIONS = {
  board: ['draftboard', 'current'],
  state: ['draftState', 'current'],
  users: 'users',
  teams: 'draftTeams',
  sheets: 'preDraftSheets',
  pickRequests: 'pickRequests',
  draftOrder: 'draftOrder',
  divisionOrder: 'divisionOrder'
};


export const LEAGUE_TEAMS = [
  'Amity Island Sharks','Beard','Bishop Sycamore','Bojangles P-Stars','Brady Gaga',
  'Broken Bembels ULB','E-Town Elephants','Fighting Farmers','Foxboro Forever','Frankfurt Bakers',
  'K-Town Devils','Packers Ultras',"Pep's Band",'Randy Moss Lob Jünger','Steelersnation 7',
  'The 49vengers','the Boys','Thunder Ducks','Wiesbaden Phantoms','Zeugen Ray Lewis'
];

export const NFL_TEAM_NAMES = {
  ARI: 'Arizona Cardinals', ATL: 'Atlanta Falcons', BAL: 'Baltimore Ravens', BUF: 'Buffalo Bills',
  CAR: 'Carolina Panthers', CHI: 'Chicago Bears', CIN: 'Cincinnati Bengals', CLE: 'Cleveland Browns',
  DAL: 'Dallas Cowboys', DEN: 'Denver Broncos', DET: 'Detroit Lions', GB: 'Green Bay Packers',
  HOU: 'Houston Texans', IND: 'Indianapolis Colts', JAX: 'Jacksonville Jaguars', KC: 'Kansas City Chiefs',
  LAC: 'Los Angeles Chargers', LAR: 'Los Angeles Rams', LV: 'Las Vegas Raiders', MIA: 'Miami Dolphins',
  MIN: 'Minnesota Vikings', NE: 'New England Patriots', NO: 'New Orleans Saints', NYG: 'New York Giants',
  NYJ: 'New York Jets', PHI: 'Philadelphia Eagles', PIT: 'Pittsburgh Steelers', SEA: 'Seattle Seahawks',
  SF: 'San Francisco 49ers', TB: 'Tampa Bay Buccaneers', TEN: 'Tennessee Titans', WAS: 'Washington Commanders'
};

export const POSITION_SPEECH = {
  QB: 'quarterback', RB: 'running back', WR: 'wide receiver', TE: 'tight end', K: 'kicker', DEF: 'defense'
};

// Nur für die Sprachausgabe. Hier können ungewöhnliche/deutsche Teamnamen phonetisch feinjustiert werden.
export const TEAM_SPEECH_NAMES = {
  'Broken Bembels ULB': 'Broken Bem-bells U L B',
  'Randy Moss Lob Jünger': 'Randy Moss Lohb Yoon-ger',
  'Wiesbaden Phantoms': 'Vees-bah-den Phantoms',
  'Zeugen Ray Lewis': 'Tsoy-gen Ray Lewis',
  'Bojangles P-Stars': 'Bojangles P Stars',
  'E-Town Elephants': 'E Town Elephants',
  'K-Town Devils': 'K Town Devils',
  'Pep\'s Band': 'Peps Band',
  'The 49vengers': 'The Forty Nine Vengers'
};


export const TEAM_LOGOS = {
  'Amity Island Sharks': 'images/amity_island_sharks.jpg',
  'Beard': 'images/beard.jpg',
  'Bishop Sycamore': 'images/bishop_sycamore.jpg',
  'Bojangles P-Stars': 'images/bojangles_pstars.jpg',
  'Brady Gaga': 'images/brady_gaga.jpg',
  'Broken Bembels ULB': 'images/broken_bembels.jpg',
  'E-Town Elephants': 'images/etown_elephants.jpg',
  'Fighting Farmers': 'images/fighting_farmers.jpg',
  'Foxboro Forever': 'images/foxboro_forever.jpg',
  'Frankfurt Bakers': 'images/frankfurt_bakers.jpg',
  'K-Town Devils': 'images/ktown_devils.jpg',
  'Packers Ultras': 'images/packers_ultras.jpg',
  "Pep's Band": 'images/peps_band.jpg',
  'Randy Moss Lob Jünger': 'images/randy_moss.jpg',
  'Randy Moss LoB Jünger': 'images/randy_moss.jpg',
  'Steelersnation 7': 'images/steelersnation.jpg',
  'The 49vengers': 'images/the49vengers.jpg',
  'The Boys': 'images/the_boys.jpg',
  'the Boys': 'images/the_boys.jpg',
  'Thunder Ducks': 'images/thunder_ducks.jpg',
  'Wiesbaden Phantoms': 'images/wiesbaden_phantoms.jpg',
  'Zeugen Ray Lewis': 'images/zeugen_ray_lewis.jpg',
  '12th Man Army': 'images/12th_man_army.jpg',
  'Bernem Bembels': 'images/bernem_bembels.jpg',
  'Goldkrone United': 'images/goldkrone_united.jpg',
  'Gronk Nation': 'images/gronk_nation.jpg',
  'Johnny Manziel and Friends': 'images/johnny_manziel.jpg',
  'Lynchmob': 'images/lynchmob.jpg',
  'Vikings4Ever': 'images/vikings4ever.jpg'
};

export function teamLogo(teamName) {
  return TEAM_LOGOS[teamName] || 'images/favicon.jpg';
}
