/* One opaque string per WebSocket message. Bounds are bytes, not UTF-16 units.
 * No application queue lives here: writers drain before producing bulk frames.
 * A peer exceeding the socket budget is closed rather than buffered forever. */
export const MSG_MAX = 16 * 1024 * 1024;
export const ENVELOPE_MAX = 6 * MSG_MAX + 1024;
export const QUEUE_MAX = ENVELOPE_MAX + 1024 * 1024;
export const LOW = 256 * 1024;
export const byteLength = (s: string): number => new TextEncoder().encode(s).byteLength;

export interface Pipe {
  readonly open: boolean;
  readonly kind: 'ws';
  send(s: string): boolean;
  drain(): Promise<void>;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((s: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
}
export interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(s: string): unknown;
  close(code?: number, reason?: string): void;
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
}
export function wsPipe(ws: WsLike): Pipe {
  let closed = false;
  let polling: ReturnType<typeof setTimeout> | null = null;
  const waiters = new Set<() => void>();
  const wake = () => {
    if (polling) clearTimeout(polling);
    polling = null;
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const poll = () => {
    polling = null;
    if (!pipe.open || ws.bufferedAmount <= LOW) wake();
    else polling = setTimeout(poll, 10);
  };
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    wake();
    pipe.onclose?.(code, reason);
  };
  const pipe: Pipe = {
    kind: 'ws',
    get open() { return !closed && ws.readyState === 1; },
    onopen: null, onmessage: null, onclose: null,
    send(s) {
      if (!pipe.open) return false;
      if (byteLength(s) > MSG_MAX || ws.bufferedAmount + byteLength(s) > QUEUE_MAX) {
        pipe.close(1009, 'queue-limit');
        return false;
      }
      try { ws.send(s); return true; }
      catch { pipe.close(1011, 'write-failed'); return false; }
    },
    drain() {
      if (!pipe.open || ws.bufferedAmount <= LOW) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.add(resolve);
        if (!polling) polling = setTimeout(poll, 10);
      });
    },
    close(code = 1000, reason = '') {
      try { ws.close(code, reason); } finally { finish(code, reason); }
    },
  };
  ws.onopen = () => pipe.onopen?.();
  ws.onmessage = ({data}) => {
    if (closed) return;
    if (typeof data !== 'string') { pipe.close(1003, 'text-only'); return; }
    if (byteLength(data) > MSG_MAX) { pipe.close(1009, 'oversize'); return; }
    pipe.onmessage?.(data);
  };
  ws.onclose = (e) => finish(e.code, e.reason);
  ws.onerror = () => pipe.close(1011, 'socket-error');
  return pipe;
}

export type RelayAuth = {spki: string; sign(nonce: string): Promise<string>};
/** Authenticate before handing the still-open socket to the sealed handshake. */
export function dialRelay(url: string, auth: RelayAuth): Promise<Pipe> {
  return new Promise((resolve, reject) => {
    const pipe = wsPipe(new WebSocket(url));
    const timer = setTimeout(() => pipe.close(4401, 'auth-timeout'), 15_000);
    let challenged = false;
    pipe.onclose = (code) => { clearTimeout(timer); reject(new Error('relay closed: ' + code)); };
    pipe.onmessage = (raw) => {
      let m: any;
      try { m = JSON.parse(raw); } catch { pipe.close(1002, 'auth-protocol'); return; }
      if (m.t === 'r-challenge' && typeof m.nonce === 'string' && !challenged) {
        challenged = true;
        void auth.sign(m.nonce).then((sig) => {
          pipe.send(JSON.stringify({t: 'r-auth', spki: auth.spki, sig}));
        }).catch(() => pipe.close(4401, 'auth-failed'));
      } else if (m.t === 'r-ok' && challenged) {
        clearTimeout(timer);
        pipe.onmessage = null;
        pipe.onclose = null;
        resolve(pipe);
      } else pipe.close(4401, 'auth-protocol');
    };
  });
}
