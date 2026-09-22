import type {WebSocket as WS} from 'ws';
import {startEngine, type TestEngine, type TunnelReply} from './engine';
import type {ReqComplete} from '../../../engine/shared/tunnel';

/* The sealed rig (engine.ts) carries frames; it has no idea what a chat is.
 * This is the chat the offline acceptance tests (offline design v2, section
 * 10) talk to: a roster, paged message logs, a session log, the utterance ->
 * ack -> echo path with the same cid semantics as the real engine (one delivery
 * per cid, a repeat answered `dup:true`), and the tunnel routes the app pages
 * and mutates through. Every knob a test turns is a method on the returned
 * engine; the state it asserts on is a counter or a list on it. */

export const PAGE_SIZE = 100;

export type ChatMsg = {
  seq: number;
  role: 'claude' | 'user';
  text: string;
  ts: number;
  msgId: string;
  // The cid of the utterance that made this row (the engine keeps it on the
  // committed row, so pages and echoes carry it back to the app).
  cid?: string;
  // The engine's durable per-row id (contract mid). When present it rides the
  // wire and is what the app dedups on; absent for a legacy log, which dedups
  // by ts|role|text. Stable across a renumber, unlike seq.
  mid?: string;
};
export type ChatEvent = {
  uuid: string;
  // The session record's seq: the same axis as the messages, so it rides in
  // the page of that seq (a record sits at its conversation position).
  seq: number;
  ts: number;
  kind: 'prompt' | 'reply' | 'tool';
  text: string;
  tool?: string;
};

export type ChatSessionSeed = {
  id: string;
  name: string;
  cwd?: string;
  // The read marker: unread is the count of claude lines past it (as the
  // engine models it). Defaults to the last line (read).
  heardTs?: number;
  order?: number;
  claudeSessionId?: string | null;
  contextPct?: number;
  alive?: boolean;
  status?: string;
  messages?: ChatMsg[];
  events?: ChatEvent[];
};

// `at` is the rig's receipt time, the clock the ack-path tests run on.
export type Utterance = {cid: string; paneId: string; text: string; gen: number; at: number};

export type ChatOptions = {
  sessions: ChatSessionSeed[];
  user?: string;
  host?: string;
  port?: number;
  // A `heard` frame moves the read marker (the engine's behaviour). Off for a
  // test that pins the unread marker.
  trackHeard?: boolean;
};

export type ChatEngine = TestEngine & {
  // Every utterance frame the rig saw, dups included; `gen` is the rig's start
  // generation it arrived in (0 before the first stop()).
  utterances: Utterance[];
  // cid -> text, one entry per cid the rig took (the "delivered" set).
  delivered: Map<string, string>;
  acks: number;
  // Tunnel POSTs the app made (rename, unread, order), in arrival order.
  posts: {path: string; body: Record<string, unknown>}[];
  // Every attach frame the rig saw, with the `have` the app sent and how many
  // pages the attach-ok carried back (A3).
  attaches: {
    paneId: string;
    have: Record<string, unknown> | undefined;
    pages: number;
    gen: number;
  }[];
  gen: number;

  msgs(paneId: string): ChatMsg[];
  nameOf(paneId: string): string;
  orderOf(): string[];
  unreadOf(paneId: string): number;

  // Hold the user echo (`chat` frame) this long after the ack (A2, late echo).
  holdEcho(ms: number): void;
  // Drop the next ack once (A2, lost ack): the app re-writes at ACK_TIMEOUT.
  dropNextAck(): void;
  // Drop the next utterance once (A1): no ack, no echo, not delivered.
  dropNextUtterance(): void;
  // Ack the next utterance, then die before its echo goes out: the row is
  // committed and comes back only in a replayed page.
  dieAfterAck(): void;
  // Acks after the n-th are held until releaseAcks() (reload mid-drain).
  // With a paneId only that chat's held acks go out; the others stay held.
  holdAcksAfter(n: number): void;
  // Hold every ack for THIS pane until releaseAcks(paneId): a stuck send to one
  // session, the engine having taken the bytes and gone quiet (F1). Other
  // sessions ack and deliver as normal.
  holdAcksForPane(paneId: string): void;
  releaseAcks(paneId?: string): void;
  // Flip a session alive or dead and broadcast the roster: a live pane the app
  // is looking at going dead under it (F1 dead-pane failure).
  setAlive(paneId: string, alive: boolean): void;
  // Simulate the engine's post-restart renumber (the dup-rows cause): write a
  // resume record onto the shared seq axis and push every message PAST it, so
  // the SAME rows are re-served with new seqs (ts untouched). A reconnect after
  // this backfills the renumbered tail.
  renumberOnResume(paneId: string): void;
  // Refuse the next utterance once: an ack carrying `err`, nothing delivered.
  // The app paints the send failed; a retry tap sends the same cid again.
  nackNext(): void;
  // Tunnel requests go unanswered until releaseTunnel() (A9: no inbound).
  holdTunnel(): void;
  releaseTunnel(): void;
  broadcastSessions(): void;
};

const td = new TextDecoder();

export function seedMessages(
  paneId: string,
  n: number,
  base: number,
  role: (i: number) => 'claude' | 'user' = () => 'claude'
): ChatMsg[] {
  return Array.from({length: n}, (_, i) => ({
    seq: i,
    role: role(i),
    text: `${paneId}-${String(i).padStart(4, '0')}`,
    ts: base + i * 1000,
    msgId: `${paneId}-m${i}`
  }));
}

export function seedEvents(paneId: string, n: number, base: number): ChatEvent[] {
  return Array.from({length: n}, (_, i) => ({
    uuid: `${paneId}-ev${i}`,
    seq: i,
    ts: base + i * 1000 + 500,
    kind: i % 2 ? 'reply' : 'prompt',
    text: `${paneId}-event-${i}`
  }));
}

type Sess = {
  id: string;
  name: string;
  cwd: string;
  heardTs: number;
  order: number;
  claudeSessionId: string | null;
  contextPct: number | undefined;
  alive: boolean;
  status: string;
  messages: ChatMsg[];
  events: ChatEvent[];
};

export async function startChatEngine(o: ChatOptions): Promise<ChatEngine> {
  const by = new Map<string, Sess>();
  o.sessions.forEach((seed, i) => {
    const messages = seed.messages ?? [];
    const lastClaude = [...messages].reverse().find((m) => m.role === 'claude');
    by.set(seed.id, {
      id: seed.id,
      name: seed.name,
      cwd: seed.cwd ?? '/tmp/' + seed.id,
      heardTs: seed.heardTs ?? lastClaude?.ts ?? 0,
      order: seed.order ?? i,
      claudeSessionId: seed.claudeSessionId === undefined ? 'cs-' + seed.id : seed.claudeSessionId,
      contextPct: seed.contextPct,
      alive: seed.alive ?? true,
      status: seed.status ?? 'idle',
      messages,
      events: seed.events ?? []
    });
  });
  const trackHeard = o.trackHeard ?? true;

  const sockets = new Set<WS>();
  const utterances: Utterance[] = [];
  const delivered = new Map<string, string>();
  const posts: {path: string; body: Record<string, unknown>}[] = [];
  const attaches: {
    paneId: string;
    have: Record<string, unknown> | undefined;
    pages: number;
    gen: number;
  }[] = [];
  let acks = 0;
  let gen = 0;
  let echoHoldMs = 0;
  let dropAck = false;
  let dropUtterance = false;
  let dieAfterAck = false;
  let ackHoldAfter = Infinity;
  let heldAcks: {paneId: string; fire: () => void}[] = [];
  let nackNext = false;
  const holdPanes = new Set<string>();
  let tunnelHeld: Promise<void> | null = null;
  let releaseTunnelFn: (() => void) | null = null;

  const unreadOf = (s: Sess) =>
    s.messages.filter((m) => m.role === 'claude' && m.ts > s.heardTs).length;
  const lastSeq = (s: Sess) => (s.messages.length ? s.messages[s.messages.length - 1].seq : -1);
  const tailPage = (s: Sess) => Math.max(0, Math.floor(lastSeq(s) / PAGE_SIZE));
  const lastActivity = (s: Sess) => (s.messages.length ? s.messages[s.messages.length - 1].ts : 0);

  const sessionsFrame = () => ({
    t: 'sessions',
    list: [...by.values()].map((s) => ({
      id: s.id,
      name: s.name,
      cwd: s.cwd,
      unread: unreadOf(s),
      heardTs: s.heardTs,
      muted: false,
      alive: s.alive,
      status: s.status,
      order: s.order,
      claudeSessionId: s.claudeSessionId,
      lastActivity: lastActivity(s),
      ...(s.contextPct !== undefined ? {contextPct: s.contextPct} : {}),
      title: {text: s.name, detail: null}
    }))
  });

  const wireMsg = (paneId: string, m: ChatMsg) => ({
    t: 'chat',
    id: paneId,
    role: m.role,
    seq: m.seq,
    text: m.text,
    ts: m.ts,
    msgId: m.msgId,
    ...(m.cid ? {cid: m.cid} : {}),
    ...(m.mid ? {mid: m.mid} : {})
  });

  // One session record as it rides in a page: the `t: "s"` row shape the real
  // engine ships, so the decoder splits it from the messages by that tag.
  const wireEvent = (ev: ChatEvent) => ({
    t: 's',
    seq: ev.seq,
    ts: ev.ts,
    id: ev.uuid,
    kind: ev.kind,
    text: ev.text,
    ...(ev.tool ? {tool: {name: ev.tool}} : {})
  });

  const pageOf = (s: Sess, n: number) => {
    const messages = s.messages.filter((m) => Math.floor(m.seq / PAGE_SIZE) === n);
    const events = s.events.filter((ev) => Math.floor(ev.seq / PAGE_SIZE) === n);
    const top = messages.length ? messages[messages.length - 1].seq + 1 : n * PAGE_SIZE;
    // Messages and records interleaved by seq, records tagged t:"s"; the app
    // splits them and paints from the one page (the whole L3 win).
    const rows = [
      ...messages.map((m) => ({seq: m.seq, row: wireMsg(s.id, m)})),
      ...events.map((ev) => ({seq: ev.seq, row: wireEvent(ev)}))
    ]
      .sort((a, b) => a.seq - b.seq)
      .map((r) => r.row);
    return {
      page: n,
      version: top,
      sealed: n < tailPage(s),
      messages: rows
    };
  };

  const attachOk = (s: Sess, have: {tailPage?: number; tailVersion?: number} | undefined) => {
    const tail = tailPage(s);
    const version = lastSeq(s) + 1;
    const match = !!have && have.tailPage === tail && have.tailVersion === version;
    return {
      t: 'attach-ok',
      id: s.id,
      known: true,
      pointer: version,
      pointerPage: tail,
      tailPage: tail,
      pageSize: PAGE_SIZE,
      total: s.messages.length,
      pages: match ? [] : [pageOf(s, tail)]
    };
  };

  const send = (ws: WS, frame: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
  };
  const broadcast = (frame: unknown) => {
    for (const ws of sockets) send(ws, frame);
  };
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function onAttach(ws: WS, s: Sess, have: Record<string, unknown> | undefined) {
    // ONE frame: the attach-ok's pages carry the messages and the session
    // records together. There is no second read path for the activity.
    const ok = attachOk(s, have as {tailPage?: number; tailVersion?: number} | undefined);
    attaches.push({paneId: s.id, have, pages: ok.pages.length, gen});
    send(ws, ok);
  }

  // Ack first, then the delivery's echo (the engine's order). A dropped ack
  // still leaves the delivery and its echo (the engine delivered it; only the
  // frame back was lost). A held ack is a frozen engine: the frame sits
  // unread (not in the transcript, so a history read does not show it) and is
  // taken, acked and echoed on release. A known cid is acked `dup:true` and
  // delivers nothing.
  function onUtterance(ws: WS, s: Sess, cid: string, text: string) {
    utterances.push({cid, paneId: s.id, text, gen, at: Date.now()});
    if (dropUtterance) {
      dropUtterance = false;
      return;
    }
    // An offline session (a dead pane) takes nothing: the send is failed on its
    // cid, no ack and no delivery, the way the real engine answers it (F1). The
    // app marks the row failed with the reason and keeps it for the retry tap.
    if (!s.alive) {
      send(ws, {t: 'send-failed', id: s.id, cid, reason: 'the session is offline; message not delivered'});
      return;
    }
    if (nackNext) {
      nackNext = false;
      acks++;
      send(ws, {t: 'ack', id: s.id, cid, dup: false, err: 'unknown-session'});
      return;
    }
    const take = () => {
      const known = delivered.has(cid);
      let msg: ChatMsg | undefined;
      if (!known) {
        delivered.set(cid, text);
        const seq = lastSeq(s) + 1;
        msg = {seq, role: 'user', text, ts: Date.now(), msgId: `${s.id}-u${seq}`, cid};
        s.messages.push(msg);
      } else {
        msg = s.messages.find((m) => m.role === 'user' && m.text === delivered.get(cid));
      }
      const ack = () => {
        if (dropAck) {
          dropAck = false;
          return;
        }
        acks++;
        send(ws, {
          t: 'ack',
          id: s.id,
          cid,
          ...(msg ? {msgId: msg.msgId} : {}),
          ...(known ? {dup: true} : {})
        });
      };
      // The committed row goes to every socket (the engine's broadcast), so a
      // second tab sees the send land live.
      const echo = () => {
        if (known || !msg) return;
        const frame = wireMsg(s.id, msg);
        if (echoHoldMs > 0) void wait(echoHoldMs).then(() => broadcast(frame));
        else broadcast(frame);
        broadcast(sessionsFrame());
      };
      ack();
      if (dieAfterAck) {
        dieAfterAck = false;
        void engine.stop();
        return;
      }
      echo();
    };
    if (acks >= ackHoldAfter || holdPanes.has(s.id)) heldAcks.push({paneId: s.id, fire: take});
    else take();
  }

  const json = (body: unknown, status = 200): TunnelReply => ({
    status,
    headers: {'content-type': 'application/json', 'access-control-allow-origin': '*'},
    body: JSON.stringify(body)
  });

  async function route(req: ReqComplete): Promise<TunnelReply | undefined> {
    if (tunnelHeld) await tunnelHeld;
    const url = new URL(req.path, 'http://rig');
    const path = url.pathname;
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/session\/([^/]+)\/page\/(\d+)$/)) && req.method === 'GET') {
      const s = by.get(decodeURIComponent(m[1]));
      if (!s) return json({}, 404);
      const n = Number(m[2]);
      if (n < 0 || n > tailPage(s)) return json({}, 404);
      return json(pageOf(s, n));
    }
    if ((m = path.match(/^\/session-agents\/([^/]+)$/)) && req.method === 'GET') {
      return by.has(decodeURIComponent(m[1])) ? json({runs: []}) : json({}, 404);
    }
    if (req.method === 'POST') {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(td.decode(req.body) || '{}');
      } catch {
        return json({ok: false}, 400);
      }
      posts.push({path, body});
      if (path === '/sessions/order') {
        const order = Array.isArray(body.order) ? (body.order as string[]) : [];
        order.forEach((paneId, i) => {
          const s = by.get(paneId);
          if (s) s.order = i;
        });
        broadcast(sessionsFrame());
        return json({ok: true});
      }
      if ((m = path.match(/^\/session\/([^/]+)\/rename$/))) {
        const s = by.get(decodeURIComponent(m[1]));
        if (!s) return json({ok: false}, 404);
        if (typeof body.name === 'string' && body.name.trim()) s.name = body.name.trim();
        broadcast(sessionsFrame());
        return json({ok: true});
      }
      if ((m = path.match(/^\/session\/([^/]+)\/unread$/))) {
        const s = by.get(decodeURIComponent(m[1]));
        if (!s) return json({ok: false}, 404);
        const last = [...s.messages].reverse().find((x) => x.role === 'claude');
        if (body.read === true) s.heardTs = last?.ts ?? s.heardTs;
        else if (last) s.heardTs = last.ts - 1;
        broadcast(sessionsFrame());
        return json({ok: true, unread: unreadOf(s)});
      }
    }
    return undefined;
  }

  const base = await startEngine({
    user: o.user ?? 'chat',
    host: o.host ?? 'chatbox',
    port: o.port,
    onConnect: (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      send(ws, {t: 'host', user: o.user ?? 'chat', host: o.host ?? 'chatbox'});
      send(ws, sessionsFrame());
    },
    onMessage: (ws, inner) => {
      const s = typeof inner.id === 'string' ? by.get(inner.id) : undefined;
      if (!s) return;
      if (inner.t === 'attach') {
        onAttach(ws, s, inner.have as Record<string, unknown> | undefined);
      } else if (inner.t === 'utterance') {
        if (typeof inner.cid === 'string' && inner.cid)
          onUtterance(ws, s, inner.cid, String(inner.text ?? ''));
      } else if (inner.t === 'heard' && trackHeard) {
        const m = s.messages.find((x) => x.msgId === inner.msgId);
        if (m && m.ts > s.heardTs) {
          s.heardTs = m.ts;
          broadcast(sessionsFrame());
        }
      }
    },
    onReq: route
  });

  const baseStop = base.stop.bind(base);
  const baseStart = base.start.bind(base);

  const engine = base as ChatEngine;
  Object.defineProperties(engine, {
    acks: {get: () => acks},
    gen: {get: () => gen}
  });
  Object.assign(engine, {
    utterances,
    delivered,
    posts,
    attaches,
    msgs: (paneId: string) => by.get(paneId)?.messages ?? [],
    nameOf: (paneId: string) => by.get(paneId)?.name ?? '',
    orderOf: () => [...by.values()].sort((a, b) => a.order - b.order).map((s) => s.id),
    unreadOf: (paneId: string) => {
      const s = by.get(paneId);
      return s ? unreadOf(s) : 0;
    },
    holdEcho: (ms: number) => {
      echoHoldMs = ms;
    },
    dropNextAck: () => {
      dropAck = true;
    },
    dropNextUtterance: () => {
      dropUtterance = true;
    },
    dieAfterAck: () => {
      dieAfterAck = true;
    },
    holdAcksAfter: (n: number) => {
      ackHoldAfter = n;
    },
    holdAcksForPane: (paneId: string) => {
      holdPanes.add(paneId);
    },
    releaseAcks: (paneId?: string) => {
      const going = paneId === undefined ? heldAcks : heldAcks.filter((h) => h.paneId === paneId);
      heldAcks = paneId === undefined ? [] : heldAcks.filter((h) => h.paneId !== paneId);
      if (paneId === undefined) {
        ackHoldAfter = Infinity;
        holdPanes.clear();
      } else holdPanes.delete(paneId);
      for (const ack of going) ack.fire();
    },
    nackNext: () => {
      nackNext = true;
    },
    holdTunnel: () => {
      if (tunnelHeld) return;
      tunnelHeld = new Promise<void>((r) => {
        releaseTunnelFn = r;
      });
    },
    releaseTunnel: () => {
      releaseTunnelFn?.();
      releaseTunnelFn = null;
      tunnelHeld = null;
    },
    broadcastSessions: () => broadcast(sessionsFrame()),
    setAlive: (paneId: string, alive: boolean) => {
      const s = by.get(paneId);
      if (!s) return;
      s.alive = alive;
      broadcast(sessionsFrame());
    },
    renumberOnResume: (paneId: string) => {
      const s = by.get(paneId);
      if (!s) return;
      // The resume/attach record lands at the current tail of the shared axis.
      const recSeq = lastSeq(s) + 1;
      s.events.push({
        uuid: `${paneId}-resume`,
        seq: recSeq,
        ts: Date.now(),
        kind: 'prompt',
        text: `${paneId} resumed`
      });
      // ensureSeqs then renumbers every message PAST that record: the same
      // logical rows, new seqs, unchanged ts.
      let next = recSeq + 1;
      for (const m of s.messages) m.seq = next++;
    },
    stop: async () => {
      // Acks held for a socket that is going away are gone with it, and a
      // dead rig drops everything: the one-shot drop is spent.
      heldAcks = [];
      holdPanes.clear();
      dropUtterance = false;
      dieAfterAck = false;
      nackNext = false;
      await baseStop();
      sockets.clear();
    },
    start: async () => {
      gen++;
      await baseStart();
    }
  });
  return engine;
}
