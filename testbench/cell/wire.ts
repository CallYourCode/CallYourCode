/* The app's side of the sealed wire, for a scenario's `then`: what a phone
 * would see. One client per cell; every opened frame is logged to
 * wire-frames.jsonl so a verdict can point at the exact frame.
 *
 * Built on the bench's sealed dialer (sealed-client.ts): signaling over the
 * engine's WS, then the DataChannel + sec handshake with the pair proof from
 * this engine's keys.json. Never a raw socket. */

import { appendFileSync } from "node:fs";
import { dialSealed, type SealedClient } from "./sealed-client.ts";

export type SessionRow = Record<string, any> & { id: string; name?: string; cwd?: string; alive?: boolean; thinking?: boolean; agent?: string };
export type WireFrame = Record<string, any> & { t: string; _ts: number; _seq: number };

export type Wire = {
  frames: WireFrame[];
  /** the latest sessions frame's list */
  sessions(): SessionRow[];
  /** every sessions frame's list, oldest first */
  sessionsHistory(): SessionRow[][];
  /** wait until a sessions row matches */
  waitRow(pred: (r: SessionRow) => boolean, opts?: { ms?: number; label?: string }): Promise<SessionRow | null>;
  /** attach to a session and wait for attach-ok */
  attach(id: string, since?: number): Promise<WireFrame | null>;
  /** what a person says into the app: the utterance frame */
  utter(id: string, text: string, cid?: string): void;
  /** raw frame, for the request tunnel */
  say(frame: Record<string, unknown>): void;
  /** a routed request over the tunnel: {t:"req"} -> {t:"res"} chunks */
  req(method: string, path: string, body?: unknown, ms?: number): Promise<{ status: number; body: any; raw: WireFrame[] }>;
  /** chat rows seen for a session since a frame seq */
  chatRows(id: string, sinceSeq?: number): WireFrame[];
  /** the chat history the latest attach-ok for a session carried (its pages' messages, in order) */
  history(id: string): Record<string, any>[];
  /** wait for a frame matching pred, arriving after the call */
  waitFrame(pred: (f: WireFrame) => boolean, opts?: { ms?: number; label?: string }): Promise<WireFrame | null>;
  close(): void;
  /** re-dial after an engine restart */
  reopen(): Promise<void>;
};

export async function openWire(engine: { url: string; reached?: string }, logPath?: string): Promise<Wire> {
  const frames: WireFrame[] = [];
  let seq = 0;
  let ws: SealedClient;
  const waiters = new Set<(f: WireFrame) => void>();
  const waitFrame = (pred: (f: WireFrame) => boolean, opts: { ms?: number; label?: string } = {}) =>
    new Promise<WireFrame | null>((resolve) => {
      const timer = setTimeout(() => { waiters.delete(w); resolve(null); }, opts.ms ?? 10_000);
      const w = (f: WireFrame) => { if (pred(f)) { clearTimeout(timer); waiters.delete(w); resolve(f); } };
      waiters.add(w);
    });
  const record = (m: Record<string, any>) => {
    const f: WireFrame = { ...m, t: String(m.t), _ts: Date.now(), _seq: seq++ };
    frames.push(f);
    if (logPath) appendFileSync(logPath, JSON.stringify(f) + "\n");
    for (const w of waiters) w(f);
  };
  const dial = async () => {
    ws = await dialSealed(engine.url, { reached: engine.reached });
    ws.onmessage = (m) => record(m);
    ws.onclose = (why) => record({ t: "_closed", why });
    /* the engine sends the sealed hello burst itself once sec-done is out
     * (security/sec.ts); the first frame back is the sessions list */
    if (!frames.some((f) => f.t === "sessions") && !(await waitFrame((f) => f.t === "sessions", { ms: 15_000 }))) {
      throw new Error("no sessions frame in 15s after sec-done");
    }
  };

  await dial();

  const sessionsHistory = () => frames.filter((f) => f.t === "sessions").map((f) => (f.list ?? []) as SessionRow[]);
  const sessions = () => { const h = sessionsHistory(); return h.length ? h[h.length - 1] : []; };
  let reqSeq = 0;
  return {
    frames, sessions, sessionsHistory, waitFrame,
    async waitRow(pred, opts = {}) {
      const now = sessions().find(pred);
      if (now) return now;
      const f = await waitFrame((x) => x.t === "sessions" && (x.list ?? []).some(pred), opts);
      return f ? (f.list as SessionRow[]).find(pred) ?? null : null;
    },
    async attach(id, since = 0) {
      const p = waitFrame((f) => f.t === "attach-ok" && f.id === id, { ms: 5000 });
      ws.send({ t: "attach", id, since });
      return p;
    },
    utter(id, text, cid) { ws.send({ t: "utterance", id, text, cid: cid ?? `tb-${Date.now()}-${seq}` }); },
    say(frame) { ws.send(frame); },
    async req(method, path, body, ms = 10_000) {
      /* engine/agent-engine/src/transport/tunnel.ts: {t:"req", id, m, p, h, b (base64), more}
       * answered by {t:"res", id, s, h, b, more} chunks; the last has no `more`. */
      const rid = `tb-req-${++reqSeq}`;
      const raw: WireFrame[] = [];
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(() => { waiters.delete(w); resolve(); }, ms);
        const w = (f: WireFrame) => {
          if (f.t !== "res" || f.id !== rid) return;
          raw.push(f);
          if (!f.more) { clearTimeout(timer); waiters.delete(w); resolve(); }
        };
        waiters.add(w);
      });
      const b = body === undefined ? undefined : Buffer.from(JSON.stringify(body)).toString("base64");
      ws.send({ t: "req", id: rid, m: method, p: path, h: { "content-type": "application/json" }, ...(b ? { b } : {}) });
      await done;
      const head = raw.find((f) => typeof f.s === "number");
      const text = Buffer.concat(raw.map((f) => Buffer.from(String(f.b ?? ""), "base64"))).toString("utf8");
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* text */ }
      return { status: head?.s ?? 0, body: parsed, raw };
    },
    chatRows(id, sinceSeq = 0) { return frames.filter((f) => f.t === "chat" && f.id === id && f._seq >= sinceSeq); },
    history(id) {
      const ok = [...frames].reverse().find((f) => f.t === "attach-ok" && f.id === id && Array.isArray(f.pages));
      return ok ? (ok.pages as any[]).flatMap((p) => (p.messages ?? []) as Record<string, any>[]) : [];
    },
    close() { try { ws.close(); } catch { /* gone */ } },
    async reopen() { try { ws.close(); } catch { /* gone */ } await dial(); },
  };
}
