import { NFL_TEAM_NAMES, POSITION_SPEECH, TEAM_SPEECH_NAMES } from './config.js';

let unlocked = false;
let ctx = null;

export function unlockAudio() {
  unlocked = true;
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  // Ein kurzer stummer Utterance hilft einigen Browsern, die Speech Engine nach User-Geste zu initialisieren.
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
}

export function stopSpeech() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

export function speak(text, { rate = 0.84, pitch = 0.82, lang = 'en-US', volume = 1 } = {}) {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = rate;
    u.pitch = pitch;
    u.volume = volume;
    const voices = speechSynthesis.getVoices();
    const preferredPatterns = /Guy|David|Mark|Daniel|Aaron|Alex|Google US English|Microsoft.*English/i;
    const preferred = voices.find(v => v.lang?.toLowerCase().startsWith('en') && preferredPatterns.test(v.name))
      || voices.find(v => v.lang === lang)
      || voices.find(v => v.lang?.toLowerCase().startsWith('en'));
    if (preferred) u.voice = preferred;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

export function stinger() {
  if (!unlocked) return;
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  [146.8, 220, 293.7, 440, 587.3].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = i < 2 ? 'sawtooth' : 'triangle';
    osc.frequency.value = freq;
    const t = now + i * .08;
    gain.gain.setValueAtTime(.0001, t);
    gain.gain.exponentialRampToValueAtTime(i === 4 ? .15 : .095, t + .025);
    gain.gain.exponentialRampToValueAtTime(.0001, t + .38);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t); osc.stop(t + .4);
  });
}

export async function announcePick({ overall, season, teamName, player }) {
  stopSpeech();
  stinger();
  await sleep(350);
  await speak('The pick is in!', { rate: .78, pitch: .78 });
  await sleep(700);
  const spokenTeam = TEAM_SPEECH_NAMES[teamName] || teamName;
  const position = POSITION_SPEECH[player.position] || player.position;
  const nfl = NFL_TEAM_NAMES[player.nflTeam] || player.nflTeam || '';
  const sentence = `With the ${ordinal(overall)} pick of the ${season} draft, ${spokenTeam} selects ${player.name}. ${position}, ${nfl}.`;
  await speak(sentence, { rate: .81, pitch: .78 });
}

export async function announceClock(teamName) {
  const spokenTeam = TEAM_SPEECH_NAMES[teamName] || teamName;
  await speak(`${spokenTeam} are on the clock.`, { rate: .84, pitch: .8 });
}

export function fullNflTeam(abbr) { return NFL_TEAM_NAMES[abbr] || abbr || ''; }
export function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
