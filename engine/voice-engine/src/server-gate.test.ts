/* The request gate on the wire: a REAL voice engine (server.ts) on an
 * ephemeral port, a stub sherpa backend, real sockets.
 *
 *   bun test src/server-gate.test.ts
 *
 * WHAT IS REAL HERE. The engine process is real and every request below rides
 * a real TCP connection, so what is proven is the served policy: which
 * requests each route and the /stt-stream websocket upgrade actually answer.
 * The decoder is the VOICE_SHERPA_STUB_URL stub (no native models, no real
 * speech), same as stt-deadlock.test.ts, and the live :10102 service is never
 * touched: the engine binds VOICE_PORT=0 and the test reads the ephemeral
 * port it got from the boot banner.
 *
 * The policy under test (gate.ts): loopback peer only, no x-forwarded-for,
 * loopback Host only (the DNS-rebinding shape arrives from a loopback peer
 * with no Origin; its Host still names the attacker's domain), and no Origin
 * except the engine's own (its test bench). The non-loopback peer case cannot
 * ride a real socket to a loopback-bound server; gate.test.ts pins it on the
 * pure predicate. */
import { afterAll, beforeAll, expect, test } from "bun:test";

// ----------------------------------------------------------- stub backend

let stub: import("bun").Server;
function startStub() {
  stub = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/v1/audio/transcriptions") {
        await req.arrayBuffer(); // drain
        return Response.json({ text: "gate check transcript" });
      }
      if (u.pathname === "/v1/audio/speech") {
        await req.arrayBuffer();
        return new Response(new Uint8Array(4800)); // 0.1s of s16 silence @24k
      }
      return new Response("nf", { status: 404 });
    },
  });
}

// ------------------------------------------------------------- the engine

let proc: import("bun").Subprocess | null = null;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

/** Boot the engine with VOICE_PORT=0 and read the ephemeral port it actually
 *  got from the "voice-engine  http://host:port" boot banner. */
async function startEngine(): Promise<void> {
  proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: {
      ...process.env,
      VOICE_PORT: "0", // ephemeral: never the live :10102
      VOICE_HOST: "127.0.0.1",
      VOICE_SHERPA_STUB_URL: `http://127.0.0.1:${stub.port}`,
      VOICE_SELFCHECK: "0",
      VOICE_TTS_WATCHDOG: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const deadline = Date.now() + 15_000;
  let banner = "";
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    banner += new TextDecoder().decode(value);
    const m = banner.match(/voice-engine\s+http:\/\/[^:]+:(\d+)/);
    if (m) {
      port = Number(m[1]);
      reader.cancel().catch(() => {});
      return;
    }
  }
  throw new Error("voice engine never printed its boot banner:\n" + banner +
    "\n" + (await new Response(proc.stderr as ReadableStream).text()));
}

beforeAll(async () => {
  startStub();
  await startEngine();
  // the banner prints before Bun.serve returns control, so confirm serving
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base()}/health`)).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("voice engine bound but /health never answered");
});

afterAll(() => {
  proc?.kill();
  stub?.stop(true);
});

/** A tiny decodable WAV: 0.5s of a 200 Hz tone (same shape the deadlock test
 *  posts), so POST /stt exercises the real ffmpeg+stub decode path. */
function clip(): Uint8Array {
  const n = 8000;
  const bytes = new Uint8Array(44 + n * 2);
  const dv = new DataView(bytes.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVE");
  w(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(2000 * Math.sin((2 * Math.PI * 200 * i) / 16000)), true);
  return bytes;
}
const CLIP = clip();

const ACAO = "access-control-" + "allow-origin"; // concatenated: gate.test.ts's tripwire scans this file too

async function expectRefused(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(String(body.error)).toContain("the voice engine answers this machine only");
  expect(res.headers.get(ACAO)).toBeNull();
}

// ------------------------------------------------- loopback callers pass

test("a loopback no-Origin caller passes every representative route", async () => {
  const health = await fetch(`${base()}/health`);
  expect(health.status).toBe(200);
  expect((await health.json()).ok).toBe(true);

  const stt = await fetch(`${base()}/stt`, {
    method: "POST", headers: { "content-type": "audio/wav" },
    body: CLIP as unknown as ArrayBuffer, signal: AbortSignal.timeout(20_000),
  });
  expect(stt.status).toBe(200);
  expect((await stt.json()).text).toBe("gate check transcript");

  const tts = await fetch(`${base()}/tts`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hello", pcm: true }), signal: AbortSignal.timeout(20_000),
  });
  expect(tts.status).toBe(200);
  expect((await tts.arrayBuffer()).byteLength).toBeGreaterThan(0);

  const voices = await fetch(`${base()}/voices`);
  expect(voices.status).toBe(200);
  expect(Array.isArray((await voices.json()).voices)).toBe(true);

  const bench = await fetch(`${base()}/`); // static: the test bench
  expect(bench.status).toBe(200);
  expect(await bench.text()).toContain("<");
}, 45_000);

test("the engine's own test bench origin passes (same-origin fetch)", async () => {
  const self = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base()}/health`, { headers: { origin: self } });
  expect(health.status).toBe(200);
  const stt = await fetch(`${base()}/stt`, {
    method: "POST", headers: { "content-type": "audio/wav", origin: self },
    body: CLIP as unknown as ArrayBuffer, signal: AbortSignal.timeout(20_000),
  });
  expect(stt.status).toBe(200);
  expect((await stt.json()).text).toBe("gate check transcript");
}, 30_000);

// --------------------------------------------------------- outsiders 403

test("an Origin-bearing request is refused on every route", async () => {
  const origin = "https://evil.example";
  await expectRefused(await fetch(`${base()}/health`, { headers: { origin } }));
  await expectRefused(await fetch(`${base()}/voices`, { headers: { origin } }));
  await expectRefused(await fetch(`${base()}/`, { headers: { origin } }));
  await expectRefused(await fetch(`${base()}/stt`, {
    method: "POST", headers: { "content-type": "audio/wav", origin },
    body: CLIP as unknown as ArrayBuffer,
  }));
  await expectRefused(await fetch(`${base()}/tts`, {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ text: "hello", pcm: true }),
  }));
  // another loopback port is another page, not this engine's bench
  await expectRefused(await fetch(`${base()}/health`, {
    headers: { origin: "http://127.0.0.1:10101" },
  }));
});

test("a proxied peer (x-forwarded-for) is refused on every route", async () => {
  const xff = { "x-forwarded-for": "100.64.0.7" };
  await expectRefused(await fetch(`${base()}/health`, { headers: xff }));
  await expectRefused(await fetch(`${base()}/`, { headers: xff }));
  await expectRefused(await fetch(`${base()}/stt`, {
    method: "POST", headers: { "content-type": "audio/wav", ...xff },
    body: CLIP as unknown as ArrayBuffer,
  }));
});

test("a DNS-rebinding Host is refused on every route (loopback peer, no Origin)", async () => {
  // The rebound page's exact shape: a true loopback peer, no x-forwarded-for,
  // NO Origin (top-level navigation / same-origin GET), attacker Host. Bun's
  // fetch honors an explicit host header (probed empirically), so this rides
  // the real socket with exactly the attack's bytes.
  for (const host of ["evil.com", "evil.com:10102"]) {
    await expectRefused(await fetch(`${base()}/health`, { headers: { host } }));
    await expectRefused(await fetch(`${base()}/voices`, { headers: { host } }));
    await expectRefused(await fetch(`${base()}/`, { headers: { host } }));
    await expectRefused(await fetch(`${base()}/stt`, {
      method: "POST", headers: { "content-type": "audio/wav", host },
      body: CLIP as unknown as ArrayBuffer,
    }));
    await expectRefused(await fetch(`${base()}/tts`, {
      method: "POST", headers: { "content-type": "application/json", host },
      body: JSON.stringify({ text: "hello", pcm: true }),
    }));
  }
  // any non-loopback name, not just the demo domain
  await expectRefused(await fetch(`${base()}/health`, { headers: { host: "192.168.1.20:10102" } }));
  await expectRefused(await fetch(`${base()}/health`, { headers: { host: `machine.tail1234.ts.net:${port}` } }));
});

test("a loopback Host with no Origin still passes (the agent engine's dial shape)", async () => {
  // fetch stamps Host from the dial by default; here it is set EXPLICITLY so
  // this test keeps meaning "the allow-set includes the loopback names" even
  // if the runtime's default stamping changes.
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const health = await fetch(`${base()}/health`, { headers: { host } });
    expect(health.status).toBe(200);
    expect((await health.json()).ok).toBe(true);
  }
});

test("the CORS preflight is gone: OPTIONS grants nothing", async () => {
  // a cross-origin preflight is refused at the gate like any Origin-bearer
  const pre = await fetch(`${base()}/stt`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  expect(pre.status).toBe(403);
  expect(pre.headers.get(ACAO)).toBeNull();
  // and no handler answers 204-with-grants even without an Origin
  const bare = await fetch(`${base()}/stt`, { method: "OPTIONS" });
  expect(bare.headers.get(ACAO)).toBeNull();
  expect(bare.status).not.toBe(204);
});

test("no response carries a CORS grant header", async () => {
  for (const res of [
    await fetch(`${base()}/health`),
    await fetch(`${base()}/voices`),
    await fetch(`${base()}/`),
  ]) {
    expect(res.headers.get(ACAO)).toBeNull();
    expect(res.headers.get("access-control-" + "allow-methods")).toBeNull();
    expect(res.headers.get("access-control-" + "allow-headers")).toBeNull();
  }
});

// ------------------------------------------------- the /stt-stream upgrade

type WsOutcome = { opened: boolean; frames: any[] };

/** Dial /stt-stream with the given extra headers; if it opens, run one whole
 *  stream (start, 1s of PCM, stop) and collect frames until close. */
function dialStream(headers: Record<string, string>, speak: boolean): Promise<WsOutcome> {
  return new Promise((resolve) => {
    const out: WsOutcome = { opened: false, frames: [] };
    // Bun's client WebSocket takes extra headers (non-standard, server-side only);
    // an EMPTY headers object is exactly the dial voice-proxy.ts makes.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stt-stream`, { headers } as any);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(out); }, 15_000);
    ws.onopen = () => {
      out.opened = true;
      if (!speak) { clearTimeout(timer); try { ws.close(); } catch {} resolve(out); return; }
      ws.send(JSON.stringify({ t: "start", sampleRate: 16000 }));
      const pcm = new Float32Array(16000); // 1s
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.05 * Math.sin((2 * Math.PI * 200 * i) / 16000);
      ws.send(pcm.buffer);
      ws.send(JSON.stringify({ t: "stop" }));
    };
    ws.onmessage = (ev) => {
      try { out.frames.push(JSON.parse(String(ev.data))); } catch {}
    };
    ws.onclose = () => { clearTimeout(timer); resolve(out); };
    ws.onerror = () => {}; // close always follows
  });
}

test("the ws upgrade accepts the agent engine's dial (loopback, no Origin) and streams", async () => {
  const r = await dialStream({}, true);
  expect(r.opened).toBe(true);
  const final = r.frames.find((f) => f.t === "final");
  expect(final).toBeDefined();
  expect(final.text).toBe("gate check transcript");
}, 30_000);

test("the ws upgrade accepts the test bench's own origin", async () => {
  const r = await dialStream({ origin: `http://127.0.0.1:${port}` }, false);
  expect(r.opened).toBe(true);
});

test("the ws upgrade refuses any other Origin", async () => {
  const r = await dialStream({ origin: "https://evil.example" }, false);
  expect(r.opened).toBe(false);
  expect(r.frames).toEqual([]);
});

test("the ws upgrade refuses a proxied peer (x-forwarded-for)", async () => {
  const r = await dialStream({ "x-forwarded-for": "100.64.0.7" }, false);
  expect(r.opened).toBe(false);
  expect(r.frames).toEqual([]);
});

test("the ws upgrade refuses a DNS-rebinding Host (loopback peer, no Origin)", async () => {
  // Bun's ws client honors an explicit host header too (probed empirically),
  // so this is the rebound page opening streaming STT: refused at the gate.
  for (const host of ["evil.com", "evil.com:10102", "192.168.1.20:10102"]) {
    const r = await dialStream({ host }, false);
    expect(r.opened).toBe(false);
    expect(r.frames).toEqual([]);
  }
});

test("the ws upgrade still accepts an explicit loopback Host", async () => {
  const r = await dialStream({ host: `localhost:${port}` }, false);
  expect(r.opened).toBe(true);
});
