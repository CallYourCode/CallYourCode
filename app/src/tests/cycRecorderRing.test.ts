import {afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(m: string): boolean {
    return m === 'audio/webm;codecs=opus';
  }
  state: 'recording' | 'inactive' = 'inactive';
  ondataavailable: ((e: {data: Blob}) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType: string;
  constructor(_stream: unknown, opts?: {mimeType?: string}) {
    this.mimeType = opts?.mimeType ?? '';
    FakeRecorder.instances.push(this);
  }
  start(_timesliceMs?: number): void {
    this.state = 'recording';
  }
  stop(): void {
    if (this.state === 'inactive') throw new DOMException('InvalidStateError');
    this.state = 'inactive';
    this.onstop?.();
  }

  feed(bytes: number): void {
    this.ondataavailable?.({data: new Blob([new Uint8Array(bytes)])});
  }
}

(window as unknown as {MediaRecorder: unknown}).MediaRecorder = FakeRecorder;
(globalThis as unknown as {MediaRecorder: unknown}).MediaRecorder = FakeRecorder;

type RingModule = typeof import('../audio/recorderRing');
let RecorderRing: RingModule['RecorderRing'];
let ROTATE_MS: RingModule['ROTATE_MS'];
let MIME: RingModule['MIME'];
beforeAll(async () => {
  ({RecorderRing, ROTATE_MS, MIME} = await import('../audio/recorderRing'));
});
const stream = {} as MediaStream;
let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  FakeRecorder.instances = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function tick(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}
function ring(): InstanceType<typeof RecorderRing> {
  const r = new RecorderRing();
  r.start(stream);
  return r;
}
describe('MIME negotiation', () => {
  test('picks the first type the recorder supports', () => {
    expect(MIME).toBe('audio/webm;codecs=opus');
  });
});
describe('the rotating pair', () => {
  test('slot A records immediately, slot B joins half a period later', () => {
    const r = ring();
    expect(FakeRecorder.instances.length).toBe(1);
    tick(ROTATE_MS / 2);
    expect(FakeRecorder.instances.length).toBe(2);
    expect(FakeRecorder.instances.every((i) => i.state === 'recording')).toBe(true);
    r.stop();
  });
  test('each slot is killed and replaced every period, out of phase', () => {
    const r = ring();
    tick(ROTATE_MS / 2);
    tick(ROTATE_MS / 2);
    expect(FakeRecorder.instances.length).toBe(3);
    expect(FakeRecorder.instances[0].state).toBe('inactive');
    tick(ROTATE_MS / 2);
    expect(FakeRecorder.instances.length).toBe(4);
    expect(FakeRecorder.instances[1].state).toBe('inactive');
    r.stop();
  });
  test('a killed recorder loses its handler first: late data goes nowhere', () => {
    const r = ring();
    const first = FakeRecorder.instances[0];
    tick(ROTATE_MS);
    expect(first.ondataavailable).toBeNull();
    r.stop();
  });
  test('recorders are started with the negotiated mime type', () => {
    const r = ring();
    expect(FakeRecorder.instances[0].mimeType).toBe(MIME);
    r.stop();
  });
  test('stop() kills both and ends the rotation', () => {
    const r = ring();
    tick(ROTATE_MS / 2);
    r.stop();
    expect(FakeRecorder.instances.every((i) => i.state === 'inactive')).toBe(true);
    const before = FakeRecorder.instances.length;
    tick(ROTATE_MS * 3);
    expect(FakeRecorder.instances.length).toBe(before);
  });
});
describe('freeze: keep the pre-roll, drop the rest', () => {
  test('keeps the OLDEST live recorder and kills the other', () => {
    const r = ring();
    const a = FakeRecorder.instances[0];
    tick(ROTATE_MS / 2);
    const b = FakeRecorder.instances[1];
    const kept = r.freeze();
    expect(kept?.rec).toBe(a);
    expect(b.state).toBe('inactive');
    expect(a.state).toBe('recording');
  });
  test('the frozen slot carries its start time (the clip pre-roll)', () => {
    const r = ring();
    tick(ROTATE_MS / 2);
    tick(ROTATE_MS / 2);
    const kept = r.freeze();
    expect(kept?.t0).toBe(ROTATE_MS / 2);
  });
  test('freezing stops the rotation: nothing replaces the kept recorder', () => {
    const r = ring();
    tick(ROTATE_MS / 2);
    r.freeze();
    const before = FakeRecorder.instances.length;
    tick(ROTATE_MS * 3);
    expect(FakeRecorder.instances.length).toBe(before);
  });
  test('with nothing live there is nothing to keep', () => {
    const r = new RecorderRing();
    expect(r.freeze()).toBeNull();
    r.start(stream);
    r.stop();
    expect(r.freeze()).toBeNull();
  });
});
describe('finish: the linger, the drain, the blob', () => {
  test('with lingerMs the recorder keeps running that long past release', async () => {
    const r = ring();
    const rec = FakeRecorder.instances[0];
    rec.feed(500);
    const slot = r.freeze()!;
    const p = r.finish(slot, 600);
    expect(rec.state).toBe('recording');
    expect(r.draining).toBe(1);
    tick(599);
    expect(rec.state).toBe('recording');
    rec.feed(300);
    tick(1);
    expect(rec.state).toBe('inactive');
    const blob = await p;
    expect(blob?.size).toBe(800);
    expect(blob?.type).toBe(MIME);
    expect(r.draining).toBe(0);
  });
  test('the detached recorder drains into ITS blob, not into the restarted ring', async () => {
    const r = ring();
    const rec = FakeRecorder.instances[0];
    rec.feed(100);
    const slot = r.freeze()!;
    const p = r.finish(slot, 600);
    expect(slot.rec).toBeNull();
    r.start(stream);
    rec.feed(50);
    tick(600);
    expect((await p)?.size).toBe(150);
  });
  test('lingerMs 0 stops at once', async () => {
    const r = ring();
    FakeRecorder.instances[0].feed(64);
    const slot = r.freeze()!;
    const p = r.finish(slot, 0);
    expect(FakeRecorder.instances[0].state).toBe('inactive');
    expect((await p)?.size).toBe(64);
  });
  test('no chunks means no blob, not an empty one', async () => {
    const r = ring();
    const slot = r.freeze()!;
    await expect(r.finish(slot, 0)).resolves.toBeNull();
  });
  test('no slot or no recorder resolves null immediately', async () => {
    const r = new RecorderRing();
    await expect(r.finish(null, 600)).resolves.toBeNull();
    r.start(stream);
    const slot = r.freeze()!;
    void r.finish(slot, 0);
    await expect(r.finish(slot, 0)).resolves.toBeNull();
  });
  test('two releases within the linger window both drain (a set, not a field)', async () => {
    const r = ring();
    const a = FakeRecorder.instances[0];
    a.feed(10);
    const slotA = r.freeze()!;
    const pa = r.finish(slotA, 600);
    r.start(stream);
    tick(300);
    const b = FakeRecorder.instances.at(-1)!;
    b.feed(20);
    const slotB = r.freeze()!;
    const pb = r.finish(slotB, 600);
    expect(r.draining).toBe(2);
    tick(300);
    expect(r.draining).toBe(1);
    tick(300);
    expect(r.draining).toBe(0);
    expect((await pa)?.size).toBe(10);
    expect((await pb)?.size).toBe(20);
  });
  test('stopLingering (dispose) stops the drain early; assembly still settles', async () => {
    const r = ring();
    const rec = FakeRecorder.instances[0];
    rec.feed(40);
    const slot = r.freeze()!;
    const p = r.finish(slot, 600);
    r.stopLingering();
    expect(rec.state).toBe('inactive');
    expect(r.draining).toBe(0);
    tick(600);
    expect((await p)?.size).toBe(40);
  });
});
