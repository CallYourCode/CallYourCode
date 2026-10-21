/* One device using the engine E2E client over the production sealed WS relay.
 * Keep only the bench's frame-object API and early-frame buffering here. */
import { TestClient } from "../../engine/agent-engine/src/e2e/testclient.ts";

export type SealedClient = {
  onmessage: ((frame: Record<string, any>) => void) | null;
  onclose: ((why: string) => void) | null;
  send(frame: Record<string, any>): void;
  close(): void;
  readonly open: boolean;
};

export async function dialSealed(url: string, opts: { ms?: number } = {}): Promise<SealedClient> {
  const ws = new TestClient(url);
  const inbox: Record<string, any>[] = [];
  let listener: SealedClient["onmessage"] = null;
  let ready = false;
  const client: SealedClient = {
    get onmessage() { return listener; },
    set onmessage(cb) { listener = cb; if (cb) for (const f of inbox.splice(0)) cb(f); },
    onclose: null,
    get open() { return ready && ws.readyState === TestClient.OPEN; },
    send(frame) { ws.send(JSON.stringify(frame)); },
    close() { ws.close(); },
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("sealed WS handshake timeout")); ws.close(); }, opts.ms ?? 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello" }));
    ws.onerror = (ev) => { clearTimeout(timer); reject(new Error(ev.message ?? "sealed WS failed")); ws.close(); };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      ready = false;
      client.onclose?.(ev.reason ?? "closed");
      reject(new Error("sealed WS closed before ready"));
    };
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data));
      if (listener) listener(frame); else inbox.push(frame);
      // TestClient exposes only opened application frames, after sec-done.
      ready = true;
      clearTimeout(timer);
      resolve();
    };
  });
  return client;
}
