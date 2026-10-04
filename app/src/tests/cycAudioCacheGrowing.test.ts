import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {markGrowing, endGrowing, resolveAudioUrl} from '../audio/audioCache';
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
  endOfStream() {
    this.ended = true;
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
  test('no MediaSource (iOS Safari): the streamed bytes buffer into a sealed blob', async () => {
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
});
