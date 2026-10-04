const OPEN_HZ = 880;

const CLOSE_HZ = 587.33;

const TONE_MS = 70;

const TONE_GAIN = 0.05;

const EDGE_MS = 8;

// The tone context lives only while a tone sounds: made by the tone, closed
// TONE_IDLE_MS after the last one ends. An idle context holds the page's audio
// output, which the microphone graph shares (see webAudioClip.ts).
let ctx: AudioContext | null = null;
let sounding = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// A turn's opening and closing tones come seconds apart; this only spares the
// open/close churn of tones fired back to back.
const TONE_IDLE_MS = 1_000;
let opened = 0;
let closed = 0;

function audio(): AudioContext | null {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }

  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

function blip(from: number, to: number): boolean {
  const ac = audio();
  if (!ac) return false;
  const now = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, now);
  osc.frequency.linearRampToValueAtTime(to, now + TONE_MS / 1000);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(TONE_GAIN, now + EDGE_MS / 1000);
  gain.gain.setValueAtTime(TONE_GAIN, now + (TONE_MS - EDGE_MS) / 1000);
  gain.gain.linearRampToValueAtTime(0, now + TONE_MS / 1000);
  osc.connect(gain).connect(ac.destination);
  osc.start(now);
  osc.stop(now + TONE_MS / 1000);

  sounding++;
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {}
    sounding = Math.max(0, sounding - 1);
    if (sounding || ctx !== ac) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!sounding) void releaseToneContext();
    }, TONE_IDLE_MS);
  };
  return true;
}

// Close the tone context; the next tone makes a fresh one. The idle timer does
// this on its own; the microphone also calls it when its graph has stopped
// delivering audio. A tone is 70ms; at worst one is cut short.
export function releaseToneContext(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const ac = ctx;
  ctx = null;
  sounding = 0;
  return ac ? ac.close().catch(() => {}) : Promise.resolve();
}

export function toneContextOpen(): boolean {
  return !!ctx;
}

export function turnOpened(): void {
  if (!blip(OPEN_HZ * 0.75, OPEN_HZ)) return;
  opened++;
}

export function turnClosed(): void {
  if (!blip(CLOSE_HZ, CLOSE_HZ * 0.75)) return;
  closed++;
}
