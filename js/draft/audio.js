let unlocked = false;
let ctx = null;

export function unlockAudio() {
  unlocked = true;
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
}

export function speak(text, { rate = 0.95, pitch = 1, lang = 'en-US' } = {}) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang; u.rate = rate; u.pitch = pitch;
  const voices = speechSynthesis.getVoices();
  const preferred = voices.find(v => v.lang === lang && /Google|Microsoft|Samantha|Daniel/i.test(v.name)) || voices.find(v => v.lang.startsWith('en'));
  if (preferred) u.voice = preferred;
  speechSynthesis.speak(u);
}

export function stinger() {
  if (!unlocked) return;
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  const now = ctx.currentTime;
  [220, 330, 440, 660].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = i < 2 ? 'sawtooth' : 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * .07);
    gain.gain.exponentialRampToValueAtTime(.12, now + i * .07 + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, now + i * .07 + .22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * .07); osc.stop(now + i * .07 + .25);
  });
}

export function announcePick({ overall, season, teamName, player }) {
  stinger();
  speak('The pick is in!', { rate: .9 });
  setTimeout(() => speak(`With the ${ordinal(overall)} pick of the ${season} draft, ${teamName} selects ${player.name}, ${player.position}, ${player.nflTeam}.`, { rate: .9 }), 1200);
}

export function announceClock(teamName) {
  speak(`${teamName} is on the clock.`, { rate: .92 });
}

function ordinal(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return `${n}${s[(v-20)%10] || s[v] || s[0]}`;
}
