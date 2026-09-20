import {
  CHUNK,
  decodeChunk,
  encodeReq,
  encodeReqAbort,
  ReqStreamEncoder,
  type ResFrame
} from '@shared/tunnel';

interface TunnelTransport {
  ready(): boolean;
  send(frame: object): boolean;

  drain?(): Promise<void>;
}

// The transfer segment PUT opts into a per-fragment drained send (see `fetch`):
// unlike a plain fetch, it awaits the pipe's drain after EACH frame so the
// bufferedAmount is observed after the bytes are actually buffered, and its
// no-response deadline is anchored at frames-sent, not at dispatch.
export type TunnelFetchInit = RequestInit & {drainEachFrame?: boolean};

const IDLE_MS = 30_000;

type Pending = {
  resolve: (r: Response) => void;
  reject: (e: Error) => void;

  timer: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type StreamRx = {
  ctrl: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function abortError(signal?: AbortSignal): Error {
  const reason = (signal as {reason?: unknown} | undefined)?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body == null) return null;
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob)
    return new Uint8Array(await body.arrayBuffer());
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return new TextEncoder().encode(body.toString());
  }

  return new TextEncoder().encode(String(body));
}

function headerRecord(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => {
      out[k] = v;
    });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[k] = v;
  } else {
    for (const [k, v] of Object.entries(h)) out[k] = String(v);
  }
  return out;
}

function resHeaders(h: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const lk = k.toLowerCase();
    if (lk === 'content-length' || lk === 'content-encoding') continue;
    out[k] = v;
  }
  return out;
}

export class TunnelClient {
  private pending = new Map<string, Pending>();
  private streams = new Map<string, StreamRx>();
  private seq = 0;

  private readyWaiters = new Set<{resolve: (v: boolean) => void; cleanup: () => void}>();

  constructor(private readonly tx: TunnelTransport) {}

  ready(): boolean {
    return this.tx.ready();
  }

  whenReady(graceMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.ready()) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = {resolve, cleanup: () => {}};
      const timer = setTimeout(() => {
        settle(false);
      }, graceMs);
      const onAbort = () => {
        settle(false);
      };
      const settle = (v: boolean) => {
        this.readyWaiters.delete(waiter);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      waiter.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, {once: true});
      this.readyWaiters.add(waiter);
    });
  }

  // Backpressure passthrough for the transfer worker: resolves once the pipe's
  // buffered bytes fall back under its low-water mark, wired to the real
  // `bufferedamountlow` event (dcpipe). The worker awaits this between pipelined
  // segment PUTs so it fires no faster than the tunnel drains. No-op when the
  // transport declares no drain (tests, mocks): the send stays unthrottled.
  tunnelDrain(): Promise<void> {
    return this.tx.drain?.() ?? Promise.resolve();
  }

  signalReady(): void {
    for (const w of [...this.readyWaiters]) {
      this.readyWaiters.delete(w);
      w.cleanup();
      w.resolve(true);
    }
  }

  private mintId(): string {
    return `t${++this.seq}-${Math.random().toString(36).slice(2, 10)}`;
  }

  fetch(url: string, init?: TunnelFetchInit): Promise<Response> {
    const id = this.mintId();
    const signal = init?.signal ?? undefined;
    const drainEachFrame = init?.drainEachFrame === true;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = () => this.settleReject(id, abortError(signal));
      signal?.addEventListener('abort', onAbort, {once: true});
      const armIdle = () =>
        setTimeout(() => {
          this.pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
          reject(new Error('tunnel: no response'));
        }, IDLE_MS);
      void (async () => {
        let frames;
        try {
          const u = new URL(url);
          const path = u.pathname + u.search;
          const method = (init?.method ?? 'GET').toUpperCase();
          const headers = headerRecord(init?.headers);
          const body = await bodyBytes(init?.body ?? null);
          frames = encodeReq(id, method, path, headers, body);
        } catch (e) {
          signal?.removeEventListener('abort', onAbort);
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        if (signal?.aborted) return;

        if (drainEachFrame) {
          // Transfer segment PUT: send each frame gated on the pipe's drain,
          // exactly the way `sendStream` does, so the bufferedAmount is observed
          // AFTER the bytes are actually buffered and the initial burst cannot
          // bypass backpressure. The pending entry is registered before the
          // send so an abort mid-send cuts the loop, and the no-response timer
          // is armed only once every frame is handed off post-drain, anchoring
          // the response deadline at frames-sent rather than at dispatch.
          this.pending.set(id, {resolve, reject, timer: null, signal, onAbort});
          for (const f of frames) {
            if (!this.pending.has(id)) return; // aborted / reset mid-send
            if (!this.tx.send(f)) {
              this.settleReject(id, new Error('tunnel: pipe not ready'));
              return;
            }
            await this.tx.drain?.();
          }
          const p = this.pending.get(id);
          if (p && p.timer === null) p.timer = armIdle();
          return;
        }

        const timer = armIdle();
        this.pending.set(id, {resolve, reject, timer, signal, onAbort});
        for (const f of frames) {
          if (!this.tx.send(f)) {
            this.settleReject(id, new Error('tunnel: pipe not ready'));
            return;
          }
        }
      })();
    });
  }

  sendStream(
    url: string,
    init: RequestInit | undefined,
    blob: Blob,
    onProgress?: (sentBytes: number, totalBytes: number) => void
  ): Promise<Response> {
    const id = this.mintId();
    const signal = init?.signal ?? undefined;
    const total = blob.size;
    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = () => {
        this.tx.send(encodeReqAbort(id));
        this.settleReject(id, abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, {once: true});

      this.pending.set(id, {resolve, reject, timer: null, signal, onAbort});
      void (async () => {
        try {
          const u = new URL(url);
          const path = u.pathname + u.search;
          const method = (init?.method ?? 'POST').toUpperCase();
          const headers = headerRecord(init?.headers);
          if (!headers['content-type'] && blob.type) headers['content-type'] = blob.type;
          headers['content-length'] = String(total);
          const enc = new ReqStreamEncoder(id, method, path, headers);
          let off = 0;
          while (off < total) {
            if (!this.pending.has(id)) return;
            const end = Math.min(off + CHUNK, total);
            const part = new Uint8Array(await blob.slice(off, end).arrayBuffer());
            for (const f of enc.push(part)) {
              if (!this.pending.has(id)) return;
              if (!this.tx.send(f)) throw new Error('tunnel: pipe not ready');
              await this.tx.drain?.();
            }

            onProgress?.(off, total);
            off = end;
          }
          if (!this.pending.has(id)) return;
          for (const f of enc.end()) {
            if (!this.tx.send(f)) throw new Error('tunnel: pipe not ready');
            await this.tx.drain?.();
          }
          onProgress?.(total, total);

          const p = this.pending.get(id);
          if (p && p.timer === null) {
            p.timer = setTimeout(() => {
              this.pending.delete(id);
              signal?.removeEventListener('abort', onAbort);
              reject(new Error('tunnel: no response'));
            }, IDLE_MS);
          }
        } catch (e) {
          this.settleReject(id, e instanceof Error ? e : new Error(String(e)));
        }
      })();
    });
  }

  onRes(frame: ResFrame): void {
    if (typeof frame?.id !== 'string') return;

    const st = this.streams.get(frame.id);
    if (st) {
      const bytes = decodeChunk(frame.b);
      if (bytes.length) {
        try {
          st.ctrl.enqueue(bytes);
        } catch {}
      }
      if (!frame.more) this.closeStream(frame.id, null);
      return;
    }

    const p = this.pending.get(frame.id);
    if (!p) return;

    if (frame.s === undefined && frame.h === undefined) return;
    if (p.timer) clearTimeout(p.timer);
    p.signal?.removeEventListener('abort', p.onAbort!);
    this.pending.delete(frame.id);
    const status = frame.s ?? 200;
    const headers = resHeaders(frame.h);

    if (!frame.more) {
      const body = decodeChunk(frame.b);
      p.resolve(
        new Response(body.length ? (body as unknown as BodyInit) : null, {status, headers})
      );
      return;
    }

    const id = frame.id;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        ctrl = c;
      },

      cancel: () => {
        this.abortStream(id, null);
      }
    });
    const entry: StreamRx = {ctrl, signal: p.signal};
    if (p.signal) {
      entry.onAbort = () => this.abortStream(id, abortError(p.signal));
      p.signal.addEventListener('abort', entry.onAbort, {once: true});
    }
    this.streams.set(id, entry);
    const first = decodeChunk(frame.b);
    if (first.length) ctrl.enqueue(first);

    const nullBody = status === 204 || status === 205 || status === 304;
    p.resolve(new Response(nullBody ? null : stream, {status, headers}));
  }

  reset(reason: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.signal?.removeEventListener('abort', p.onAbort!);
      p.reject(new Error(`tunnel: pipe closed (${reason})`));
    }
    this.pending.clear();
    for (const id of [...this.streams.keys()]) {
      this.closeStream(id, new Error(`tunnel: pipe closed (${reason})`));
    }
  }

  private abortStream(id: string, err: Error | null): void {
    if (!this.streams.has(id)) return;
    this.closeStream(id, err);
    this.tx.send(encodeReqAbort(id));
  }

  private closeStream(id: string, err: Error | null): void {
    const st = this.streams.get(id);
    if (!st) return;
    this.streams.delete(id);
    st.signal?.removeEventListener('abort', st.onAbort!);
    if (err) {
      try {
        st.ctrl.error(err);
      } catch {}
    } else {
      try {
        st.ctrl.close();
      } catch {}
    }
  }

  private settleReject(id: string, err: Error): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    p.signal?.removeEventListener('abort', p.onAbort!);
    this.pending.delete(id);
    p.reject(err);
  }
}
