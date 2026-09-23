// Public endpoint of your Cloudflare Worker. Replace once after deployment.
export const TTS_WORKER_URL = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/tts';

export const LOCAL_AUDIO = {
  pickIn: 'audio/pick-in-jingle.wav',
  nextTeam: 'audio/next-team-jingle.wav'
};

export const AUDIO_TIMING = {
  pickSignalMinMs: 1900,
  afterPickSpeechMs: 260,
  nextTeamOverlayMinMs: 4700,
  overlayCrossfadeMs: 180
};


const SINGULAR_TEAMS = new Set([
  'Beard',
  'Bishop Sycamore',
  'Brady Gaga',
  'Foxboro Forever',
  "Pep's Band",
  'Steelersnation 7'
]);

export function clockVerb(teamName) {
  return SINGULAR_TEAMS.has(teamName) ? 'IS' : 'ARE';
}
