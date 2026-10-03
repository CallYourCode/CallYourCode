const OPEN_HZ = 880;

const CLOSE_HZ = 587.33;

const TONE_MS = 70;

const TONE_GAIN = 0.05;

const EDGE_MS = 8;

let ctx: AudioContext | null = null;
let opened = 0;
let closed = 0;

function audio(): AudioContext | null {
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

  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {}
  };
  return true;
}

// Close the tone context; the next tone makes a fresh one. It shares the page's
// audio output with the microphone graph (see releasePlaybackContext), so the
// microphone releases it with its own graph. A tone is 70ms; at worst one is
// cut short.
export function releaseToneContext(): Promise<void> {
  const ac = ctx;
  ctx = null;
  return ac ? ac.close().catch(() => {}) : Promise.resolve();
}

export function turnOpened(): void {
  if (!blip(OPEN_HZ * 0.75, OPEN_HZ)) return;
  opened++;
}

export function turnClosed(): void {
  if (!blip(CLOSE_HZ, CLOSE_HZ * 0.75)) return;
  closed++;
}
