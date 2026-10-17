let ctx: AudioContext | null = null;
let interval: number | null = null;

export function unlockAudio(): boolean {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === "suspended") void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

function beep(freq: number, start: number, dur: number) {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "square";
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(ctx.destination);
  o.start(start);
  o.stop(start + dur + 0.05);
}

function pattern() {
  if (!ctx) return;
  const t = ctx.currentTime;
  beep(880, t, 0.18);
  beep(660, t + 0.22, 0.18);
  beep(880, t + 0.44, 0.18);
  beep(660, t + 0.66, 0.18);
}

export function startAlarm() {
  unlockAudio();
  if (interval !== null) return;
  pattern();
  interval = window.setInterval(pattern, 1400);
}

export function stopAlarm() {
  if (interval !== null) {
    clearInterval(interval);
    interval = null;
  }
}

export function isAudioReady() {
  return !!ctx && ctx.state === "running";
}
