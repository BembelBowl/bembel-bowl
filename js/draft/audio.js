import { NFL_TEAM_NAMES } from './config.js';
import { TTS_WORKER_URL, LOCAL_AUDIO } from './speech-config.js';

let audioUnlocked = false;
const localAudio = new Map();

export function unlockAudio() {
  audioUnlocked = true;
  preloadLocal(LOCAL_AUDIO.pickIn);
  preloadLocal(LOCAL_AUDIO.nextTeam);
}

export async function playPickInJingle(onStarted = null) {
  return playLocal(LOCAL_AUDIO.pickIn, onStarted);
}

export async function playNextTeamJingle() {
  return playLocal(LOCAL_AUDIO.nextTeam);
}

export function preparePickSpeech({ overall, season, teamName, player }) {
  return requestSpeech({
    type: 'pick', overall, season, teamName,
    playerName: player.name,
    position: player.position,
    nflTeam: player.nflTeam
  });
}

export function prepareClockSpeech(teamName) {
  return requestSpeech({ type: 'clock', teamName });
}

export async function announcePick(args) {
  return playPreparedSpeech(preparePickSpeech(args));
}

export async function announceClock(teamName) {
  return playPreparedSpeech(prepareClockSpeech(teamName));
}

export async function playPreparedSpeech(prepared) {
  const blob = await prepared;
  if (!blob) throw new Error('Azure speech audio is unavailable.');
  const url = URL.createObjectURL(blob);
  try { await playAudioUrl(url); }
  finally { URL.revokeObjectURL(url); }
}

export function fullNflTeam(abbr) { return NFL_TEAM_NAMES[abbr] || abbr || ''; }
export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function requestSpeech(payload) {
  if (!TTS_WORKER_URL || TTS_WORKER_URL.includes('YOUR-WORKER')) {
    throw new Error('TTS Worker URL is not configured in js/draft/speech-config.js');
  }
  const res = await fetch(TTS_WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { detail = await res.text(); }
    throw new Error(`TTS request failed (${res.status}): ${detail}`);
  }
  return res.blob();
}

function preloadLocal(src) {
  if (localAudio.has(src)) return localAudio.get(src);
  const a = new Audio(src);
  a.preload = 'auto';
  a.load();
  localAudio.set(src, a);
  return a;
}

async function playLocal(src, onStarted = null) {
  if (!audioUnlocked) throw new Error('Audio must be enabled once on the live screen.');
  const a = preloadLocal(src);
  a.pause();
  a.currentTime = 0;
  return playElement(a, onStarted);
}

function playAudioUrl(url) {
  if (!audioUnlocked) return Promise.reject(new Error('Audio must be enabled once on the live screen.'));
  const a = new Audio(url);
  a.preload = 'auto';
  return playElement(a);
}

function playElement(audio, onStarted = null) {
  return new Promise((resolve, reject) => {
    let started = false;
    const cleanup = () => {
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('ended', onEnd);
      audio.removeEventListener('error', onError);
    };
    const onPlaying = () => {
      if (started) return;
      started = true;
      try { onStarted?.(); } catch (err) { console.error('Audio start callback failed:', err); }
    };
    const onEnd = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Audio playback failed.')); };

    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('ended', onEnd, { once: true });
    audio.addEventListener('error', onError, { once: true });

    // Force the preloaded local file to continue loading immediately.
    if (audio.readyState < 2) audio.load();

    audio.play().then(() => {
      // Some browsers resolve play() before firing "playing"; keep "playing"
      // as the authoritative sync point for the visual.
    }).catch(err => {
      cleanup();
      reject(err);
    });
  });
}
