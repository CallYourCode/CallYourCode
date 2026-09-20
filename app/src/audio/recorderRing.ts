export const ROTATE_MS = 2000;
export const TIMESLICE_MS = 200;
// Opus voice-note bitrate. Speech is intelligible well below this; a 145 s clip
// lands under 700 KB (a recorder test asserts it), so no single upload window
// has to carry megabytes.
export const AUDIO_BITS_PER_SECOND = 32_000;

export type Slot = {
  rec: MediaRecorder | null;
  chunks: Blob[];
  t0: number;
  timer: ReturnType<typeof setInterval> | null;
  kick: ReturnType<typeof setTimeout> | null;
};

export const MIME = (() => {
  const c = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  for (const m of c) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m))
      return m;
  }
  return '';
})();

export class RecorderRing {
  private stream: MediaStream | null = null;

  private slots: Slot[] = [
    {rec: null, chunks: [], t0: 0, timer: null, kick: null},
    {rec: null, chunks: [], t0: 0, timer: null, kick: null}
  ];

  private lingering = new Set<MediaRecorder>();

  get draining(): number {
    return this.lingering.size;
  }

  private newRecorder(slot: Slot): void {
    // 32 kbps opus: a 145 s note is under ~600 KB (the incident clip was 4 MB at
    // the old default), which is plenty for speech and small enough that the
    // transfer queue moves it in a handful of chunks. mimeType still picks opus.
    const opts: MediaRecorderOptions = {audioBitsPerSecond: AUDIO_BITS_PER_SECOND};
    if (MIME) opts.mimeType = MIME;
    const rec = new MediaRecorder(this.stream!, opts);
    slot.rec = rec;
    slot.chunks = [];
    slot.t0 = performance.now();
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) slot.chunks.push(e.data);
    };
    rec.start(TIMESLICE_MS);
  }

  private killRecorder(slot: Slot): void {
    const rec = slot.rec;
    slot.rec = null;
    slot.chunks = [];
    if (rec && rec.state !== 'inactive') {
      rec.ondataavailable = null;
      try {
        rec.stop();
      } catch {}
    }
  }

  start(stream: MediaStream): void {
    this.stream = stream;
    this.stop();
    const [a, b] = this.slots;
    this.newRecorder(a);
    a.timer = setInterval(() => {
      this.killRecorder(a);
      this.newRecorder(a);
    }, ROTATE_MS);
    b.kick = setTimeout(() => {
      this.newRecorder(b);
      b.timer = setInterval(() => {
        this.killRecorder(b);
        this.newRecorder(b);
      }, ROTATE_MS);
    }, ROTATE_MS / 2);
  }

  stop(): void {
    for (const s of this.slots) {
      if (s.timer) {
        clearInterval(s.timer);
        s.timer = null;
      }
      if (s.kick) {
        clearTimeout(s.kick);
        s.kick = null;
      }
      this.killRecorder(s);
    }
  }

  freeze(): Slot | null {
    for (const s of this.slots) {
      if (s.timer) {
        clearInterval(s.timer);
        s.timer = null;
      }
      if (s.kick) {
        clearTimeout(s.kick);
        s.kick = null;
      }
    }
    const live = this.slots.filter((s) => s.rec && s.rec.state === 'recording');
    if (!live.length) return null;
    live.sort((a, b) => a.t0 - b.t0);
    const keep = live[0];
    for (const s of this.slots) if (s !== keep) this.killRecorder(s);
    return keep;
  }

  finish(slot: Slot | null, lingerMs = 0): Promise<Blob | null> {
    if (!slot || !slot.rec) return Promise.resolve(null);
    const rec = slot.rec;
    const chunks = slot.chunks;
    slot.rec = null;
    slot.chunks = [];

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    this.lingering.add(rec);
    return new Promise((resolve) => {
      const assemble = () => {
        this.lingering.delete(rec);
        resolve(chunks.length ? new Blob(chunks, {type: MIME || 'audio/webm'}) : null);
      };
      const stop = () => {
        if (rec.state === 'inactive') return assemble();
        rec.onstop = assemble;
        try {
          rec.stop();
        } catch {
          assemble();
        }
      };
      if (lingerMs > 0) setTimeout(stop, lingerMs);
      else stop();
    });
  }

  stopLingering(): void {
    for (const rec of this.lingering) {
      try {
        rec.stop();
      } catch {}
    }
    this.lingering.clear();
  }
}
