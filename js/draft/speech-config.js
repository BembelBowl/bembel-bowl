// Public endpoint of your Cloudflare Worker. Replace once after deployment.
export const TTS_WORKER_URL = 'https://bembel-bowl-tts.arcane-decksmith-api.workers.dev/tts';

export const LOCAL_AUDIO = {
  pickIn: 'audio/pick-in-jingle.wav',
  nextTeam: 'audio/next-team-jingle.wav'
};

export const AUDIO_TIMING = {
  pickSignalMinMs: 2300,
  pickOverlayMinMs: 8200,
  afterPickSpeechMs: 550,
  nextTeamOverlayMinMs: 5200,
  overlayCrossfadeMs: 240
};


const SINGULAR_TEAMS = new Set([
  'Beard',
  'BearD',
  'Bishop Sycamore',
  'Brady Gaga',
  'Foxboro Forever',
  "Pep's Band",
  'Steelersnation 7'
]);

export function clockVerb(teamName) {
  return SINGULAR_TEAMS.has(teamName) ? 'IS' : 'ARE';
}
