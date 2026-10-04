import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {markGrowing, endGrowing, resolveAudioUrl, streamAudioUrl} from '../audio/audioCache';
import {setEngineTunnel, clearEngineTunnel, type EngineTunnel} from '../engine/contract';
const BASE = 'http://engine-a.test:7788';
const clipUrl = (id: string) => `${BASE}/audio/${id}.mp3`;

class FakeSourceBuffer {
  updating = false;
  appended: Uint8Array[] = [];
  private listeners = new Set<() => void>();
  addEventListener(_ev: string, fn: () => void) {
    this.listeners.add(fn);
  }
  appendBuffer(b: BufferSource) {
    this.appended.push(new Uint8Array(b as ArrayBuffer | Uint8Array as Uint8Array));
  }
}
class FakeMediaSource {
  static last: FakeMediaSource | null = null;
  static isTypeSupported(t: string) {
    return t === 'audio/mpeg';
  }
  readyState: 'closed' | 'open' | 'ended' = 'closed';
  sb: FakeSourceBuffer | null = null;
  ended = false;
  endedWith: string | undefined;
  private onOpen: (() => void) | null = null;
  constructor() {
    FakeMediaSource.last = this;
  }
  addEventListener(ev: string, fn: () => void) {
    if (ev === 'sourceopen') this.onOpen = fn;
  }
  addSourceBuffer(mime: string) {
    expect(mime).toBe('audio/mpeg');
    this.sb = new FakeSourceBuffer();
    return this.sb as unknown as SourceBuffer;
  }
  endOfStream(err?: string) {
    this.ended = true;
    this.endedWith = err;
    this.readyState = 'ended';
  }

  attach() {
    this.readyState = 'open';
    this.onOpen?.();
  }
}
function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    }
  });
}
describe('growing clip playback is sealed', () => {
  let tunnelCalls: string[];
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let minted: unknown[];
  let revoked: string[];
  let respond: (url: string) => Response;
  const g = globalThis as {MediaSource?: unknown};
  const savedMS = g.MediaSource;
  const tunnel: EngineTunnel = {
    ready: () => true,
    whenReady: () => Promise.resolve(true),
    fetch: (url) => {
      tunnelCalls.push(url);
      return Promise.resolve(respond(url));
    }
  };
  beforeEach(() => {
    tunnelCalls = [];
    minted = [];
    revoked = [];
    setEngineTunnel(BASE, tunnel);

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('plaintext fetch: the growing clip must ride the tunnel');
    });

    URL.createObjectURL = vi.fn((o: Blob | MediaSource) => {
      minted.push(o);
      return `blob:cyc/${minted.length}`;
    });
    URL.revokeObjectURL = vi.fn((u: string) => {
      revoked.push(u);
    });
    g.MediaSource = FakeMediaSource;
    FakeMediaSource.last = null;
  });
  afterEach(() => {
    clearEngineTunnel(BASE);
    g.MediaSource = savedMS;
    vi.restoreAllMocks();
  });
  test('requests through the tunnel client, never global fetch, and hands back a local URL', async () => {
    markGrowing('g1');
    respond = () => new Response(bodyOf([new Uint8Array([1])]));
    const url = await resolveAudioUrl('g1', clipUrl('g1'));
    expect(tunnelCalls).toEqual([clipUrl('g1')]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(url.startsWith('blob:')).toBe(true);
    expect(minted[0]).toBeInstanceOf(FakeMediaSource);
    endGrowing('g1');
  });
  test('chunks append in order and endOfStream lands when the tunnel body completes', async () => {
    markGrowing('g2');
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5]);
    respond = () => new Response(bodyOf([a, b]));
    const url = await resolveAudioUrl('g2', clipUrl('g2'));
    const ms = FakeMediaSource.last!;
    expect(ms.ended).toBe(false);
    ms.attach();
    await vi.waitFor(() => expect(ms.ended).toBe(true));
    expect(ms.sb!.appended.map((c) => [...c])).toEqual([
      [1, 2, 3],
      [4, 5]
    ]);

    expect(revoked).toEqual([url]);
    endGrowing('g2');
  });
  test('no MediaSource of any kind: the streamed bytes buffer into a sealed blob', async () => {
    delete g.MediaSource;
    markGrowing('g3');
    respond = () => new Response(bodyOf([new Uint8Array([7, 8]), new Uint8Array([9])]));
    const url = await resolveAudioUrl('g3', clipUrl('g3'));
    expect(tunnelCalls).toEqual([clipUrl('g3')]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(url.startsWith('blob:')).toBe(true);

    const blob = minted[0] as Blob;
    expect(blob.size).toBe(3);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 8, 9]);
    endGrowing('g3');
  });
  test('a finished clip still fetches through the tunnel and caches its blob', async () => {
    respond = () => new Response(new Uint8Array([1, 2]));
    const url = await resolveAudioUrl('f1', clipUrl('f1'));
    expect(tunnelCalls).toEqual([clipUrl('f1')]);
    expect(url.startsWith('blob:')).toBe(true);
    const again = await resolveAudioUrl('f1', clipUrl('f1'));
    expect(again).toBe(url);
    expect(tunnelCalls).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // A body the test feeds frame by frame, the way the tunnel delivers a clip
  // longer than one CHUNK.
  function heldBody() {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({start: (c) => void (ctrl = c)});
    return {body, ctrl};
  }
  const mp3 = (len: number) => ({'content-type': 'audio/mpeg', 'content-length': String(len)});
  const BIG = 262144 * 3;
  // A full tunnel frame: every frame of a body but the last is exactly CHUNK.
  const frame = (fill: number) => new Uint8Array(262144).fill(fill);
  const sizes = (ms: FakeMediaSource) => ms.sb!.appended.map((c) => [c.length, c[0]]);

  test('a finished clip longer than one tunnel frame plays from its first frame', async () => {
    const {body, ctrl} = heldBody();
    respond = () => new Response(body, {headers: mp3(BIG)});
    ctrl.enqueue(frame(1));
    const url = await streamAudioUrl('long1', clipUrl('long1'));
    // handed over before the body has finished
    expect(url.startsWith('blob:')).toBe(true);
    const ms = FakeMediaSource.last!;
    expect(minted[0]).toBe(ms);
    ms.attach();
    await vi.waitFor(() => expect(sizes(ms)).toEqual([[262144, 1]]));
    expect(ms.ended).toBe(false);
    ctrl.enqueue(new Uint8Array([3]));
    ctrl.close();
    await vi.waitFor(() => expect(ms.ended).toBe(true));
    expect(ms.endedWith).toBeUndefined();
    expect(sizes(ms)).toEqual([
      [262144, 1],
      [1, 3]
    ]);
    // the whole clip is cached: a replay or the waveform reads it, no refetch
    const again = await resolveAudioUrl('long1', clipUrl('long1'));
    expect(minted[1]).toMatchObject({size: 262145, type: 'audio/mpeg'});
    expect(again).toBe('blob:cyc/2');
    expect(tunnelCalls).toHaveLength(1);
  });

  test('a concurrent fetch of a clip being streamed waits for its bytes, it does not refetch', async () => {
    const {body, ctrl} = heldBody();
    respond = () => new Response(body, {headers: mp3(BIG)});
    ctrl.enqueue(frame(9));
    await streamAudioUrl('long2', clipUrl('long2'));
    const waveform = resolveAudioUrl('long2', clipUrl('long2'));
    ctrl.enqueue(new Uint8Array([9]));
    ctrl.close();
    expect(await waveform).toBe('blob:cyc/2');
    expect(tunnelCalls).toHaveLength(1);
  });

  test('a press while the waveform is already fetching the clip streams from that same transfer', async () => {
    const {body, ctrl} = heldBody();
    respond = () => new Response(body, {headers: mp3(BIG)});
    // waveformHydrate: every visible voice card's clip, fetched whole, on open
    const waveform = resolveAudioUrl('long5', clipUrl('long5'));
    ctrl.enqueue(frame(1));
    // the press
    const url = await streamAudioUrl('long5', clipUrl('long5'));
    const ms = FakeMediaSource.last!;
    expect(minted[0]).toBe(ms);
    ms.attach();
    await vi.waitFor(() => expect(sizes(ms)).toEqual([[262144, 1]]));
    ctrl.enqueue(new Uint8Array([2]));
    ctrl.close();
    await vi.waitFor(() => expect(ms.ended).toBe(true));
    expect(sizes(ms)).toEqual([
      [262144, 1],
      [1, 2]
    ]);
    expect(await waveform).toBe('blob:cyc/2');
    expect(url).toBe('blob:cyc/1');
    expect(tunnelCalls).toHaveLength(1);
  });

  test('a body that breaks mid-clip ends the stream with an error, not a silent truncation', async () => {
    const {body, ctrl} = heldBody();
    respond = () => new Response(body, {headers: mp3(BIG)});
    ctrl.enqueue(frame(1));
    await streamAudioUrl('long3', clipUrl('long3'));
    const ms = FakeMediaSource.last!;
    ms.attach();
    await vi.waitFor(() => expect(ms.sb!.appended).toHaveLength(1));
    ctrl.error(new Error('tunnel: pipe closed'));
    await vi.waitFor(() => expect(ms.ended).toBe(true));
    expect(ms.endedWith).toBe('network');
  });

  test('a clip that fits one frame, or is not mp3, is a cached blob', async () => {
    respond = () => new Response(new Uint8Array([1, 2]), {headers: mp3(2)});
    const small = await streamAudioUrl('short1', clipUrl('short1'));
    expect(minted[0]).toMatchObject({size: 2});
    const note = heldBody();
    respond = () =>
      new Response(note.body, {
        headers: {'content-type': 'audio/webm', 'content-length': String(BIG)}
      });
    note.ctrl.enqueue(frame(4));
    const noteUrl = streamAudioUrl('note1', clipUrl('note1'));
    note.ctrl.enqueue(new Uint8Array([4]));
    note.ctrl.close();
    await noteUrl;
    expect(minted[1]).toMatchObject({size: 262145});
    expect(FakeMediaSource.last).toBeNull();
    expect(await streamAudioUrl('short1', clipUrl('short1'))).toBe(small);
  });

  test('ManagedMediaSource only (iPhone Safari): a growing reply still streams', async () => {
    delete g.MediaSource;
    (globalThis as {ManagedMediaSource?: unknown}).ManagedMediaSource = FakeMediaSource;
    try {
      markGrowing('g4');
      respond = () => new Response(bodyOf([new Uint8Array([5])]));
      await streamAudioUrl('g4', clipUrl('g4'));
      const ms = FakeMediaSource.last!;
      expect(minted[0]).toBe(ms);
      ms.attach();
      await vi.waitFor(() => expect(ms.ended).toBe(true));
      expect(ms.sb!.appended.map((c) => [...c])).toEqual([[5]]);
      endGrowing('g4');
    } finally {
      delete (globalThis as {ManagedMediaSource?: unknown}).ManagedMediaSource;
    }
  });
});
