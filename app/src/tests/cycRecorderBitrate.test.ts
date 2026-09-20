import {describe, expect, test, vi, beforeEach, afterEach} from 'vitest';

// The voice recorder must capture at 32 kbps opus so a long note stays small
// enough that no single upload window has to carry megabytes (the incident clip
// was 4 MB; at 32 kbps a 145 s note is well under 700 KB). This proves the
// MediaRecorder is constructed with that bitrate, and the arithmetic that makes
// it safe.

const built: MediaRecorderOptions[] = [];

class FakeMediaRecorder {
  state = 'inactive';
  ondataavailable: unknown = null;
  onstop: unknown = null;
  constructor(
    public stream: MediaStream,
    public opts?: MediaRecorderOptions
  ) {
    built.push(opts ?? {});
    this.state = 'recording';
  }
  start() {}
  stop() {
    this.state = 'inactive';
  }
  static isTypeSupported(m: string) {
    return m === 'audio/webm;codecs=opus';
  }
}

describe('voice recorder bitrate', () => {
  beforeEach(() => {
    built.length = 0;
    vi.useFakeTimers();
    (window as unknown as {MediaRecorder: unknown}).MediaRecorder = FakeMediaRecorder;
    (globalThis as unknown as {MediaRecorder: unknown}).MediaRecorder = FakeMediaRecorder;
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('the ring records opus at 32 kbps', async () => {
    const {RecorderRing, MIME, AUDIO_BITS_PER_SECOND} = await import('../audio/recorderRing');
    expect(AUDIO_BITS_PER_SECOND).toBe(32_000);
    // opus is picked as the container/codec.
    expect(MIME).toBe('audio/webm;codecs=opus');

    const ring = new RecorderRing();
    ring.start({} as MediaStream);
    ring.stop();

    expect(built.length).toBeGreaterThan(0);
    for (const opts of built) {
      expect(opts.audioBitsPerSecond).toBe(32_000);
      expect(opts.mimeType).toBe('audio/webm;codecs=opus');
    }
  });

  test('a 145 s note at this bitrate is under 700 KB', async () => {
    const {AUDIO_BITS_PER_SECOND} = await import('../audio/recorderRing');
    const bytes145s = (AUDIO_BITS_PER_SECOND / 8) * 145;
    expect(bytes145s).toBeLessThan(700 * 1024);
  });
});
