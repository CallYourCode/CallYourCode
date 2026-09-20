/* The engine's half of discovery: the announce payload, the stable ws url
 * derivation, and the one POST that carries them. The per-install id lives in
 * keys.json (sec.test.ts).
 *
 * Every port number in this file is an invented one. The suite's rule is that
 * no test writes a number from his real fleet (gates.test.ts holds the list),
 * because a test that does is one copy-paste away from announcing over his
 * live engine's url; and the assertions below care about the SHAPE of the
 * derivation, never about which number went in.
 *
 *   bun test agent-engine/src/terminal/discovery.test.ts
 */

import { test, expect } from "bun:test";
import { announceBody, announceOnce, deriveWsUrl, HEARTBEAT_DEFAULT_MS } from "./discovery.ts";

const WS = "ws://mac:51001/ws";

test("announceBody carries exactly engineId, host, user, url, rev, ts", () => {
  const at = 1234567890;
  expect(announceBody("e-a", "mac", "example", WS, "abc", at)).toEqual({
    engineId: "e-a",
    host: "mac",
    user: "example",
    url: WS,
    rev: "abc",
    ts: at,
  });
  // ts defaults to now, a number
  const d = announceBody("e-a", "mac", "example", WS, "abc");
  expect(typeof d.ts).toBe("number");
});

test("announceBody carries nothing else: the lease is the engine's url, not its secrets", () => {
  /* The announce body is the one thing the engine volunteers to a server it
   * does not control. A field quietly added here (a token, a session list, a
   * device fp) would be stored in somebody else's database on every heartbeat.
   * The key set is asserted literally so adding one has to be deliberate. */
  const body = announceBody("e-a", "mac", "example", WS, "abc", 1);
  expect(Object.keys(body).sort()).toEqual(["engineId", "host", "rev", "ts", "url", "user"]);
  /* 5 min between announces (60s was brutal); the app server's engine lease
   * is 6h (app-server/hosts.ts LEASE_DEFAULT_MS), so a missed beat or three
   * never flaps the engine offline. */
  expect(HEARTBEAT_DEFAULT_MS).toBe(5 * 60_000);
});

test("deriveWsUrl: loopback default, public https -> wss, public http -> ws", () => {
  expect(deriveWsUrl("127.0.0.1", 51001)).toBe("ws://127.0.0.1:51001/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "https://mac.tail.ts.net:51002"))
    .toBe("wss://mac.tail.ts.net:51002/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "http://mac:51002"))
    .toBe("ws://mac:51002/ws");
  // a public url that is not a url: fall back to loopback rather than crash
  expect(deriveWsUrl("127.0.0.1", 51001, "not a url"))
    .toBe("ws://127.0.0.1:51001/ws");
});

test("deriveWsUrl keeps the public url's PORT and drops nothing else", () => {
  /* The whole point of ENGINE_PUBLIC_URL is that the outside name and port are
   * not the ones the engine binds. A derivation that rebuilt the url from the
   * local port would announce a url only this machine can dial, and the app
   * would sit on a spinner. */
  expect(deriveWsUrl("127.0.0.1", 51001, "https://box.tail.ts.net")).toBe("wss://box.tail.ts.net/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "https://box.tail.ts.net:51009")).toBe(
    "wss://box.tail.ts.net:51009/ws",
  );
  // an already-ws public url keeps ws (only https is promoted to wss)
  expect(deriveWsUrl("127.0.0.1", 51001, "ws://box:51009")).toBe("ws://box:51009/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "wss://box:51009")).toBe("ws://box:51009/ws");
});

test("deriveWsUrl appends exactly one /ws, whatever the public path ends with", () => {
  /* `tailscale serve` is often configured on a sub-path. A doubled slash makes
   * a url that 404s on some proxies and works on others, which is the worst
   * kind of bug to chase from a phone. */
  expect(deriveWsUrl("127.0.0.1", 51001, "https://box.ts.net/")).toBe("wss://box.ts.net/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "https://box.ts.net///")).toBe("wss://box.ts.net/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "https://box.ts.net/engine")).toBe("wss://box.ts.net/engine/ws");
  expect(deriveWsUrl("127.0.0.1", 51001, "https://box.ts.net/engine/")).toBe("wss://box.ts.net/engine/ws");
});

test("deriveWsUrl treats an empty public url as absent, not as a url", () => {
  expect(deriveWsUrl("127.0.0.1", 51001, "")).toBe("ws://127.0.0.1:51001/ws");
  expect(deriveWsUrl("linux", 51001)).toBe("ws://linux:51001/ws");
});

/* --- the announce POST ---------------------------------------------------- */

/** A throwaway app server on an ephemeral port that records what reached it. */
function fakeAppServer(status: number) {
  const seen: Array<{ path: string; auth: string | null; body: any; method: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        method: req.method,
        auth: req.headers.get("authorization"),
        body: await req.json().catch(() => null),
      });
      return new Response(status === 200 ? "{}" : "no", { status });
    },
  });
  return { seen, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

test("announceOnce POSTs the exact body to /engines/announce, bearing the issued token", async () => {
  const app = fakeAppServer(200);
  try {
    const payload = announceBody("e-a", "mac", "example", WS, "abc", 42);
    expect(await announceOnce(app.url, payload, "tok-123")).toEqual({ ok: true, status: 200 });
    expect(app.seen.length).toBe(1);
    expect(app.seen[0].method).toBe("POST");
    expect(app.seen[0].path).toBe("/engines/announce");
    expect(app.seen[0].body).toEqual(payload);
    /* Each engine bears its OWN issued token. The shared
     * PUSH_TOKEN is gone, and a header that quietly went back to one would let
     * any engine announce as any other. */
    expect(app.seen[0].auth).toBe("Bearer tok-123");
  } finally {
    app.stop();
  }
});

test("announceOnce sends no authorization header at all when it has no token", async () => {
  /* An un-enrolled engine must send the announce WITHOUT an empty Bearer: a
   * server that reads `authorization` as present-but-blank answers 401 and the
   * engine never learns it simply needs to enroll. */
  const app = fakeAppServer(200);
  try {
    const r = await announceOnce(app.url, announceBody("e-a", "mac", "u", WS, "abc", 1));
    expect(r).toEqual({ ok: true, status: 200 });
    expect(app.seen[0].auth).toBeNull();
  } finally {
    app.stop();
  }
});

test("a 401 comes back as the status, because that is what triggers re-enrollment", async () => {
  const app = fakeAppServer(401);
  try {
    expect(await announceOnce(app.url, announceBody("e-a", "mac", "u", WS, "abc", 1), "stale"))
      .toEqual({ ok: false, status: 401 });
  } finally {
    app.stop();
  }
});

test("a 500 is a refusal the engine survives, and it is NOT reported as 0", async () => {
  /* status 0 means "there was nobody to tell". Collapsing a real HTTP refusal
   * into it would have the caller retry forever instead of logging a server
   * that is answering and saying no. */
  const app = fakeAppServer(500);
  try {
    expect(await announceOnce(app.url, announceBody("e-a", "mac", "u", WS, "abc", 1)))
      .toEqual({ ok: false, status: 500 });
  } finally {
    app.stop();
  }
});

test("no app server configured, or an unreachable one, is status 0 and never a throw", async () => {
  /* The engine has to keep running with no app server at all: that is the
   * single-machine install. An exception escaping here would take the boot
   * down over a notification path nobody asked for. */
  expect(await announceOnce("", announceBody("e-a", "mac", "u", WS, "abc", 1))).toEqual({
    ok: false,
    status: 0,
  });
  expect(await announceOnce("not-a-url", announceBody("e-a", "mac", "u", WS, "abc", 1))).toEqual({
    ok: false,
    status: 0,
  });
});
