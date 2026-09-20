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
  adpTeams: 14, // FFC API currently supports max 14; used only as ranking proxy.
  autoPickGapMs: 60_000,
  conductorLeaseMs: 20_000,
  conductorRenewMs: 8_000,
  positions: ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'],
  starterLimits: { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DEF: 1, FLEX: 1 },
  fallbackRoundPlan: ['QB','RB','WR','TE','K','DEF','RB','WR','FLEX','QB','RB','WR','TE','K','RB']
};

export const COLLECTIONS = {
  board: ['draftboard', 'current'],
  state: ['draftState', 'current'],
  users: 'users',
  teams: 'draftTeams',
  sheets: 'preDraftSheets'
};
