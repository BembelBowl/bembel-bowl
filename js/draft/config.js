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
  pickRequests: 'pickRequests'
};

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
