/* A VOICE ENGINE THAT IS NOT A VOICE ENGINE.
 *
 * Every seam test that touches speech needs an upstream to talk to, and the
 * real one is a GPU process on his box on the voice port. Pointing a test at it
 * would make the suite depend on whether kokoro happens to be up, would put
 * real audio through a real model on every run, and would let a bad test file
 * type into the machine he is actually using. So: an in-process `Bun.serve` on
 * PORT 0 that speaks the four shapes the engine forwards to (/stt, /tts,
 * /voices, /health) plus the /stt-stream WebSocket, records what it received,
 * and answers whatever the test told it to answer.
 *
 * The proof a test built on this can make is "the engine forwarded X and gave
 * back what the upstream said", which is the only claim the proxy is entitled
 * to. It is deliberately NOT a speech model: nothing here decodes anything.
 *
 * FOUR MODES, because the interesting failures are not the happy path:
 *
 *   NORMAL     answers everything, immediately. The default.
 *   ERRORING   answers every route with `errorStatus` (500 by default): the
 *              upstream is up and unhappy, which the proxy must pass through
 *              rather than dress up as its own failure.
 *   HANGING    accepts the request, reads the whole body, and never answers.
 *              This is a LIVE, reachable engine that has wedged (a model load
 *              that never finishes, a queue that never drains), and it is the
 *              only thing the per-route timeouts exist for.
 *   STREAMING  /tts answers with a chunked body whose tail is held until the
 *              test releases it, so "the first chunk reached the browser before
 *              the upstream finished" is a fact and not a hope.
 *
 * Two SIBLING upstreams live here too, because they are different hosts rather
 * than different moods of one host:
 *
 *   silentVoice()    accepts TCP and never speaks HTTP at all. Distinct from
 *                    HANGING: the connection opens, so nothing fails fast, and
 *                    not one byte of a response or a websocket handshake ever
 *                    arrives. This is the shape that used to hang the proxy.
 *   deadVoiceBase()  a base nothing is listening on: connect-refused, the
 *                    502 path.
 *
 * POINTING THE ENGINE AT ONE. voice-proxy.ts reads VOICE_URL once at import,
 * which a test cannot do anything useful with (the fake's port does not exist
 * until it binds). `pointVoiceAt(base)` rewrites the module's own VOICE_URLS
 * list instead, which is the same seam voiceUrl() reads and works per test.
 * Modules that take `voiceUrl` in their deps bag (tts.ts, transcribe.ts) do not
 * need it: hand them `() => voice.base` directly.
 *
 * Ports: 0, always, read back. Nothing here binds a number.
 */

import { VOICE_URLS } from "../voice/voice-proxy.ts";

export type VoiceMode = "NORMAL" | "ERRORING" | "HANGING" | "STREAMING";

/** One completed POST /stt, as the fake actually received it. */
export type SttHit = {
  /** the ?offset the engine forwarded, or null when it forwarded none */
  offset: string | null;
  /** the content-type the engine forwarded */
  contentType: string;
  /** the body, whole, byte for byte */
  bytes: Uint8Array;
};

/** One POST /tts body, parsed, plus the raw text in case a test cares that the
 *  engine re-serialised it (routes/voice.ts parses and re-stringifies). */
export type TtsHit = {
  text?: string;
  voice?: string;
  stream?: boolean;
  raw: string;
};

export type FakeVoiceOpts = {
  mode?: VoiceMode;
  /** what /stt says the audio was */
  transcript?: string;
  /** what /voices lists */
  voices?: string[];
  /** the bytes /tts answers with in NORMAL mode */
  ttsBytes?: Uint8Array;
  /** the chunks /tts answers with in STREAMING mode, first one immediate */
  ttsChunks?: string[];
  /** the status ERRORING answers with */
  errorStatus?: number;
  /** a frame pushed at every stream socket the moment it opens, or null.
   *  It proves the upstream -> proxy -> browser direction without the browser
   *  having said anything first. */
  greet?: string | null;
  /** echo every frame the browser sends back at it (default true) */
  echo?: boolean;
};

export type FakeVoice = {
  /** http://127.0.0.1:<port>, no trailing slash */
  base: string;
  /** ws://127.0.0.1:<port>, no trailing slash */
  wsBase: string;
  port: number;

  /** the current mode; assign to switch mid-test */
  mode: VoiceMode;

  // ---- what it was asked -------------------------------------------------
  /** completed /stt requests, in order */
  stt: SttHit[];
  /** /tts bodies, in order */
  tts: TtsHit[];
  voicesCalls: number;
  healthCalls: number;
  /** every frame the fake received on /stt-stream, in order. Text frames stay
   *  strings and binary frames stay Uint8Array: the proxy must not turn one
   *  into the other, and this is where that is visible. */
  wsReceived: (string | Uint8Array)[];

  // ---- the stream sockets ------------------------------------------------
  /** upstream sockets open RIGHT NOW. The leak check: after every browser
   *  socket has closed this must be 0. */
  readonly streams: number;
  /** upstream sockets ever opened */
  readonly streamsOpened: number;
  /** upstream sockets closed, by either end */
  readonly streamsClosed: number;
  /** refuse the ws upgrade: the engine is up, its stream endpoint is not */
  refuseStreams: boolean;

  // ---- partial progress, for the streaming proofs -----------------------
  /** bytes /stt has read SO FAR, before the request body has finished */
  readonly sttBytesSoFar: number;
  /** the STREAMING /tts pushed its first chunk */
  readonly ttsStarted: boolean;
  /** the STREAMING /tts closed its body */
  readonly ttsDone: boolean;
  /** hold the STREAMING /tts tail until the returned function is called */
  holdTts(): () => void;

  // ---- what it answers (retunable mid-test) ------------------------------
  transcript: string;
  voices: string[];
  ttsBytes: Uint8Array;
  ttsChunks: string[];
  errorStatus: number;

  // ---- driving the ws from the fake's side -------------------------------
  /** push an unprompted frame at every open stream socket */
  push(frame: string | Uint8Array): void;
  /** close every open stream socket cleanly, as a finished stream does */
  closeStreams(code?: number, reason?: string): void;
  /** kill every open stream socket abruptly: a crash, not a close */
  terminateStreams(): void;

  /** Ready-made for a deps bag: tts.ts and transcribe.ts take `voiceUrl()`
   *  rather than reading VOICE_URL, so a test that only needs THOSE modules
   *  pointed here hands them this and never touches voice-proxy at all. */
  voiceUrl(): Promise<string>;

  /** Forget everything recorded so far: the requests, the frames, the counts.
   *  For a file that keeps ONE fake across its tests and wants each one to
   *  assert about what happened during it. Does not touch the mode, the
   *  canned answers or the open sockets. */
  reset(): void;

  stop(): void;
};

/** A promise that never settles: what HANGING answers with. */
const never = <T>(): Promise<T> => new Promise<T>(() => {});

export function fakeVoice(o: FakeVoiceOpts = {}): FakeVoice {
  type S = import("bun").ServerWebSocket<null>;
  const sockets = new Set<S>();

  const st = {
    mode: o.mode ?? ("NORMAL" as VoiceMode),
    transcript: o.transcript ?? "hello from fake",
    voices: o.voices ?? ["af_heart", "am_onyx"],
    ttsBytes: o.ttsBytes ?? new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
    ttsChunks: o.ttsChunks ?? ["FAKE", "-TTS"],
    errorStatus: o.errorStatus ?? 500,
    greet: o.greet === undefined ? JSON.stringify({ t: "ready", from: "fake" }) : o.greet,
    echo: o.echo ?? true,
    refuseStreams: false,
    voicesCalls: 0,
    healthCalls: 0,
    opened: 0,
    closed: 0,
    sttBytesSoFar: 0,
    ttsStarted: false,
    ttsDone: false,
    /* The gate the STREAMING tail waits on. Resolved by default so a test that
     * does not care about the split never blocks; holdTts() re-arms it. */
    ttsGate: Promise.resolve() as Promise<void>,
  };

  const stt: SttHit[] = [];
  const tts: TtsHit[] = [];
  const wsReceived: (string | Uint8Array)[] = [];

  /** A copy that outlives Bun's frame buffer. A recorded Uint8Array that still
   *  points into the socket's read buffer reads as whatever arrived NEXT, which
   *  is exactly the bug an order-under-burst assertion would hide. */
  const copyOf = (raw: string | Buffer | Uint8Array): string | Uint8Array =>
    typeof raw === "string"
      ? raw
      : new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

  const server = Bun.serve<null>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);

      /* THE STREAM UPGRADE comes first, before the mode is consulted: an
       * ERRORING engine that still accepts the socket is a real shape (the
       * batch decoder is down, the streamer is not), and a test that wants the
       * upgrade refused says so with refuseStreams. */
      if (url.pathname === "/stt-stream") {
        if (st.refuseStreams) return new Response("no stream here", { status: 503 });
        const ok = srv.upgrade(req);
        return ok
          ? (undefined as unknown as Response)
          : new Response("expected websocket", { status: 400 });
      }

      if (st.mode === "HANGING") {
        /* Read the body first. The point of HANGING is a LIVE engine that took
         * the whole request and then wedged: if the body were left unread the
         * client could stall on backpressure instead of on the missing answer,
         * and the test would be measuring the wrong wedge. */
        if (req.body) await req.arrayBuffer().catch(() => new ArrayBuffer(0));
        return never<Response>();
      }

      if (st.mode === "ERRORING" && url.pathname !== "/health") {
        if (req.body) await req.arrayBuffer().catch(() => new ArrayBuffer(0));
        return new Response(JSON.stringify({ error: "the fake voice engine is unhappy" }), {
          status: st.errorStatus,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.pathname === "/health") {
        st.healthCalls++;
        if (st.mode === "ERRORING") return new Response("down", { status: 503 });
        return Response.json({
          ok: true,
          capabilities: {
            stream: { up: true },
            batch: { up: true, engine: "fake", rtf: 1, measured_n: 1 },
            tts: { up: true, engine: "fake", rtf: 1, measured_n: 1 },
          },
          load: { active_streams: sockets.size },
        });
      }

      if (url.pathname === "/stt" && req.method === "POST") {
        /* READ INCREMENTALLY. The proxy is supposed to stream the clip through
         * rather than buffer it, and the only way to see the difference is to
         * watch the first bytes land here while the client is still sending.
         * sttBytesSoFar is that observation. */
        const reader = req.body?.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        st.sttBytesSoFar = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) { chunks.push(value); n += value.byteLength; st.sttBytesSoFar = n; }
          }
        }
        const all = new Uint8Array(n);
        let at = 0;
        for (const c of chunks) { all.set(c, at); at += c.byteLength; }
        stt.push({
          offset: url.searchParams.get("offset"),
          contentType: req.headers.get("content-type") ?? "",
          bytes: all,
        });
        return Response.json({
          text: st.transcript, corrections: [], dropped: [],
          timing: { queueMs: 1, decodeMs: 2, audioS: 0.1, rtf: 0.2 },
        });
      }

      if (url.pathname === "/tts" && req.method === "POST") {
        const raw = await req.text();
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* recorded raw */ }
        tts.push({
          text: body.text as string | undefined,
          voice: body.voice as string | undefined,
          stream: body.stream as boolean | undefined,
          raw,
        });
        if (st.mode === "STREAMING" || body.stream === true) {
          const enc = new TextEncoder();
          const chunks = [...st.ttsChunks];
          st.ttsStarted = false;
          st.ttsDone = false;
          const stream = new ReadableStream<Uint8Array>({
            async start(ctrl) {
              ctrl.enqueue(enc.encode(chunks[0] ?? ""));
              st.ttsStarted = true;
              // held until the test has SEEN the first chunk come out the other end
              await st.ttsGate;
              for (const c of chunks.slice(1)) ctrl.enqueue(enc.encode(c));
              ctrl.close();
              st.ttsDone = true;
            },
          });
          return new Response(stream, { headers: { "content-type": "audio/mpeg" } });
        }
        return new Response(st.ttsBytes, {
          headers: {
            "content-type": "audio/mpeg",
            "content-length": String(st.ttsBytes.byteLength),
          },
        });
      }

      if (url.pathname === "/voices" && req.method === "GET") {
        st.voicesCalls++;
        return Response.json({ voices: st.voices, current: st.voices[0] ?? "" });
      }

      return new Response("not found", { status: 404 });
    },

    websocket: {
      open(ws) {
        sockets.add(ws);
        st.opened++;
        if (st.greet !== null) ws.send(st.greet);
      },
      message(ws, raw) {
        wsReceived.push(copyOf(raw));
        if (st.echo) ws.send(raw as string | Uint8Array);
      },
      close(ws) {
        sockets.delete(ws);
        st.closed++;
      },
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    wsBase: `ws://127.0.0.1:${server.port}`,
    port: server.port,

    get mode() { return st.mode; },
    set mode(m: VoiceMode) { st.mode = m; },

    stt, tts, wsReceived,
    get voicesCalls() { return st.voicesCalls; },
    get healthCalls() { return st.healthCalls; },

    get streams() { return sockets.size; },
    get streamsOpened() { return st.opened; },
    get streamsClosed() { return st.closed; },
    get refuseStreams() { return st.refuseStreams; },
    set refuseStreams(v: boolean) { st.refuseStreams = v; },

    get sttBytesSoFar() { return st.sttBytesSoFar; },
    get ttsStarted() { return st.ttsStarted; },
    get ttsDone() { return st.ttsDone; },
    holdTts() {
      let release!: () => void;
      st.ttsGate = new Promise<void>((r) => { release = r; });
      return () => release();
    },

    get transcript() { return st.transcript; },
    set transcript(v: string) { st.transcript = v; },
    get voices() { return st.voices; },
    set voices(v: string[]) { st.voices = v; },
    get ttsBytes() { return st.ttsBytes; },
    set ttsBytes(v: Uint8Array) { st.ttsBytes = v; },
    get ttsChunks() { return st.ttsChunks; },
    set ttsChunks(v: string[]) { st.ttsChunks = v; },
    get errorStatus() { return st.errorStatus; },
    set errorStatus(v: number) { st.errorStatus = v; },

    push(frame) {
      for (const s of [...sockets]) { try { s.send(frame); } catch { /* gone */ } }
    },
    closeStreams(code = 1000, reason) {
      for (const s of [...sockets]) { try { s.close(code, reason); } catch { /* gone */ } }
    },
    terminateStreams() {
      for (const s of [...sockets]) { try { s.terminate(); } catch { /* gone */ } }
    },
    async voiceUrl() { return base; },
    reset() {
      stt.length = 0;
      tts.length = 0;
      wsReceived.length = 0;
      st.voicesCalls = 0;
      st.healthCalls = 0;
      st.opened = 0;
      st.closed = 0;
      st.sttBytesSoFar = 0;
      st.ttsStarted = false;
      st.ttsDone = false;
    },
    stop() {
      for (const s of [...sockets]) { try { s.close(); } catch { /* gone */ } }
      sockets.clear();
      // closeActiveConnections: a HANGING request is still parked in here, and
      // a stop that waited for it would never return.
      server.stop(true);
    },
  };
}

/* ------------------------------------------------------------- the siblings */

export type SilentVoice = { base: string; wsBase: string; port: number; stop(): void };

/** A voice engine that ACCEPTS TCP and then never says a word: no HTTP status,
 *  no websocket handshake, nothing. Reachable, so no fast connect-refused
 *  rescues the caller, and silent, so only a timeout ends the wait. This is the
 *  shape a wedged upstream really has on the wire, and the one that used to
 *  leave a browser's mic socket open forever. */
export function silentVoice(): SilentVoice {
  const server = Bun.listen({
    port: 0,
    hostname: "127.0.0.1",
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    wsBase: `ws://127.0.0.1:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}

/** A base URL nothing is listening on: every connect is refused immediately.
 *  Bound and released so the number really was free a moment ago, which is the
 *  closest a test can get to "a port nobody has" without picking one. */
export function deadVoiceBase(): string {
  const probe = Bun.listen({
    port: 0, hostname: "127.0.0.1",
    socket: { open() {}, data() {}, close() {}, error() {} },
  });
  const { port } = probe;
  probe.stop(true);
  return `http://127.0.0.1:${port}`;
}

/* ------------------------------------------------- pointing the engine at it */

/** VOICE_URLS as voice-proxy.ts loaded it, so a test can put it back. */
const ORIGINAL_VOICE_URLS = [...VOICE_URLS];

/** Point THIS worker's voice proxy at `base`.
 *
 *  voice-proxy.ts reads VOICE_URL from the environment once, at import, and a
 *  port-0 fake does not have a port until after that has happened. So the seam
 *  a test uses is the module's own list: one entry, which is the case
 *  voiceUrl() short-circuits on, so there is no health probe and no 30s sticky
 *  pick in the way. Call restoreVoiceUrls() in afterAll. */
export function pointVoiceAt(base: string): void {
  VOICE_URLS.length = 0;
  VOICE_URLS.push(base.replace(/\/$/, ""));
}

/** Put the list back the way the module loaded it. */
export function restoreVoiceUrls(): void {
  VOICE_URLS.length = 0;
  VOICE_URLS.push(...ORIGINAL_VOICE_URLS);
}
