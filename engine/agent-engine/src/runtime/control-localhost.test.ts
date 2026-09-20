/* WHO MAY MUTATE THIS ENGINE, at the route.
 *
 * The old gate was "server.requestIP() is loopback". Behind `tailscale serve`
 * (the shipped deploy) EVERY tailnet peer arrives as 127.0.0.1, so that gate
 * was no gate at all: any machine on the tailnet could rename a session, change
 * its face, flip its bell, or type into a running agent. Two rounds of gating
 * left exactly two legitimate callers and nothing else:
 *
 *   1. THE ENGINE HOST ITSELF: a loopback peer AND no x-forwarded-for. A
 *      reverse proxy on this host always stamps that header, and a remote
 *      direct peer has a non-loopback address whatever headers it forges, so
 *      the pair is what separates "a script on this machine" from "a peer the
 *      proxy handed us". Missing peer data fails CLOSED.
 *   2. AN ENROLLED DEVICE reaching in over the SEALED DATACHANNEL TUNNEL (Plan
 *      C): onReq marks the request and requireOwner treats the mark as the
 *      owner. The old remote x-cyc-cap HEADER path is retired -- a tailnet peer
 *      holding a valid cap gets nothing over plain HTTP now. This file drives
 *      the real Bun.serve over the socket, so it cannot mint the in-process
 *      tunnel mark; it proves the HTTP side: a cross-host request, cap or not,
 *      is refused. The tunnel-side pass is proven in e2e/tunnel-wire.test.ts.
 *
 * WHAT THIS FILE IS FOR, and what it deliberately is not. httpx.test.ts owns
 * the unit facts about isTrustedLocal / requireOwner / requireLocal. This is
 * the ROUTE-LEVEL gate: that every mutating route in the table actually calls
 * one of them, calls it BEFORE it does anything, and that a refusal changes
 * nothing. A guard that silently starts returning null is exactly the failure
 * this exists to catch, so the refusals are tested harder than the passes.
 *
 * The old version of this file booted a real engine on 0.0.0.0 and dialled it
 * through a second NIC to get a non-loopback peer. That needed a machine with
 * one, took thirty seconds, and proved nothing the peer shim below does not:
 * server.requestIP() is the ONLY thing the gate reads for the peer address, so
 * forging it per request drives the same real code down the same branches.
 *
 *   bun test agent-engine/src/runtime/control-localhost.test.ts
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { mediaRoutes } from "../routes/media.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { healthRoutes } from "../routes/health.ts";
import type { RouteGroup } from "../routes/ctx.ts";
import { initSessionsFrame, resetForTest as resetSessionsFrame } from "../sessions/sessions-frame.ts";
import { applySessionSettings, nameOverrideOf, photoOf, sessions,
  setNameOverride, setPhotoRec, settingsOf, type Session } from "../sessions/session-state.ts";
import { claudeTitleOf } from "../sessions/context-cache.ts";
import { titleOf } from "../sessions/title.ts";
import type { Services } from "./services.ts";

const PANE = "w3:p7";
const AGENT_ID = "ag-controlgateAAAAA";

/* The two refusals. They are not interchangeable: /agent-message has NO cap
 * path at all (it types straight into a live pane), so it says something
 * different and a paired phone is refused it too. */
const REFUSAL = {
  ok: false,
  error: "content rides the sealed channel only (enrolled device) or the engine host itself",
};
const LOCAL_ONLY_REFUSAL = { ok: false, error: "agent-message is local-only (this machine)" };

/* ------------------------------------------------------------- the peer shim
 *
 * A RouteGroup is handed the Bun.Server so the gate can ask it who the peer is.
 * This wraps each real group with a server whose requestIP() answers whatever
 * the request's x-test-peer header says, so one served port can play the engine
 * host, a tailnet peer, and a socket with no peer data at all. The real groups,
 * the real httpx gate and the real Bun.serve are untouched; only the answer to
 * "who dialled" is authored. "none" means requestIP() returns null, which is
 * what a closed or unusual socket looks like and must fail closed. */
function asPeer(group: RouteGroup): RouteGroup {
  return (ctx, req, url, path, server) => {
    const claimed = req.headers.get("x-test-peer") ?? "127.0.0.1";
    const shim = {
      // only `address` is ever read; the rest is there to match Bun's shape
      requestIP: () => claimed === "none" ? null : { address: claimed, family: "IPv4", port: 0 },
    } as unknown as import("bun").Server;
    return group(ctx, req, url, path, shim);
  };
}

/* The four peers that matter, named so a failure says which one got through. */
const HOST = { "x-test-peer": "127.0.0.1" };                              // a script on this machine
const HOST_V6 = { "x-test-peer": "::1" };
const HOST_V4_MAPPED = { "x-test-peer": "::ffff:127.0.0.1" };
const TAILNET = { "x-test-peer": "100.64.0.55" };                         // a direct remote peer
// `tailscale serve` in front of the engine: loopback TCP peer, real client in XFF
const PROXIED = { "x-test-peer": "127.0.0.1", "x-forwarded-for": "100.64.0.55" };
const NO_PEER = { "x-test-peer": "none" };

let srv: ServedRoutes;
const OLD_DATA_DIR = process.env.CYC_DATA_DIR;

function seedSession(id: string, cwd: string): Session {
  // the row is keyed by the agent id; the pane handle is an attribute of it
  const s = {
    id, agentId: id, muxHandle: PANE, name: "pane name", cwd,
    ws: null, alive: true, busy: false, viaMux: false,
    agent: { id: "claude", name: "Claude" }, hasTranscript: false, agentSession: null,
    harnessSessionId: null, status: "idle", workspace: "w3", tab: null,
    displayAgent: null, stateChangeSeq: 0, turnSince: 0, channels: [],
    doneSeq: 0, seenDoneSeq: 0, heardTs: 0, notified: false, filedTs: 0,
    order: 0, chat: [],
  } as unknown as Session;
  sessions.set(id, s);
  return s;
}

const fakeServices = {
  health: () => [],
  units: () => [],
  restart: async () => ({ ok: true, key: "kokoro" }),
} as unknown as Services;

beforeAll(async () => {
  const dir = await tmpDir("cyc-controlgate-");
  process.env.CYC_DATA_DIR = dir;
  seedSession(AGENT_ID, dir);
  initSessionsFrame({
    engineCan: [], pluginDecls: () => [], voiceHealthy: () => true,
    voicePublicUrl: "", engineUser: "tester", engineHost: "probe",
    tabs: "off", replyLevel: () => 1, hasSessionEvents: (k) => k === "claude",
  });
  srv = serveRoutes({
    groups: [sessionOpsRoutes, mediaRoutes, healthRoutes].map(asPeer),
    ctx: { services: fakeServices },
  });
});

afterAll(() => {
  srv?.stop();
  sessions.clear();
  resetSessionsFrame();
  if (OLD_DATA_DIR === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = OLD_DATA_DIR;
});

afterEach(() => {
  setNameOverride(AGENT_ID, null);
  setPhotoRec(AGENT_ID, null);
  applySessionSettings(AGENT_ID, { muted: null, notify: null });
});

/* ---------------------------------------------------------------- the table
 *
 * Every mutating route reachable from a device, with a body that would do
 * something if it were let through. A route added here without a gate fails
 * every refusal row at once, which is the whole reason the list is data. */
type Control = {
  name: string;
  path: string;
  contentType: string;
  body: string | Uint8Array;
  refusal: Record<string, unknown>;
};

const controls: Control[] = [
  { name: "rename", path: `/session/${encodeURIComponent(AGENT_ID)}/rename`,
    contentType: "application/json", body: JSON.stringify({ name: "Remote name" }), refusal: REFUSAL },
  { name: "settings", path: `/session/${encodeURIComponent(AGENT_ID)}/settings`,
    contentType: "application/json", body: JSON.stringify({ muted: true }), refusal: REFUSAL },
  { name: "unread", path: `/session/${encodeURIComponent(AGENT_ID)}/unread`,
    contentType: "application/json", body: JSON.stringify({ read: true }), refusal: REFUSAL },
  { name: "order", path: "/sessions/order",
    contentType: "application/json", body: JSON.stringify({ order: [AGENT_ID] }), refusal: REFUSAL },
  { name: "photo", path: `/session/${encodeURIComponent(AGENT_ID)}/photo`,
    contentType: "image/png", body: new Uint8Array([9, 9, 9, 9]), refusal: REFUSAL },
  { name: "doc-state", path: `/doc/${crypto.randomUUID()}/state`,
    contentType: "application/json", body: JSON.stringify({ data: { x: 1 } }), refusal: REFUSAL },
  { name: "agent-stop", path: `/session-agents/${encodeURIComponent(AGENT_ID)}/stop`,
    contentType: "application/json", body: JSON.stringify({ agentId: "sub-1" }), refusal: REFUSAL },
  { name: "service-restart", path: "/services/kokoro/restart",
    contentType: "application/json", body: "{}", refusal: REFUSAL },
  /* No cap path, ever: this one types into a live pane, so a paired phone on
   * the tailnet is refused it exactly as a stranger is. */
  { name: "agent-message", path: `/session/${encodeURIComponent(AGENT_ID)}/agent-message`,
    contentType: "application/json",
    body: JSON.stringify({ author: "remote-script", text: "blocked test input" }),
    refusal: LOCAL_ONLY_REFUSAL },
];

const post = (c: Control, headers: Record<string, string>) =>
  srv.fetch(c.path, {
    method: "POST",
    headers: { "content-type": c.contentType, ...headers },
    body: c.body as BodyInit,
  });

/* An 8-byte PNG signature is enough: the photo route whitelists on the
 * content-type header and stores the body untouched, so nothing here decodes
 * it. (photo.test.ts owns the byte-exactness; this file owns the gate.) */
const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* State inspection, read straight from the in-process stores (the GET
 * /session/<id>/settings route was removed: settings ride the ws sessions
 * frame + cyc, no remote HTTP read). This file's job is the WRITE-route gate;
 * these reads only confirm a refused mutation changed nothing and an accepted
 * one landed. The shape mirrors what the deleted GET returned. */
const settingsView = () => {
  const s = sessions.get(AGENT_ID)!;
  return {
    name: titleOf(nameOverrideOf(AGENT_ID), claudeTitleOf(s), s.name).text,
    photo: photoOf(AGENT_ID),
    settings: settingsOf(AGENT_ID),
  };
};

/* ----------------------------------------------------------- the refusals */

test("a DIRECT remote peer is refused by every mutating route", async () => {
  for (const c of controls) {
    const res = await post(c, TAILNET);
    expect(res.status, `${c.name} let a direct remote peer through`).toBe(403);
    expect(await res.json()).toEqual(c.refusal);
  }
});

test("a PROXIED loopback claiming to be local is refused: the tailscale-serve shape", async () => {
  /* THE BUG THIS CLOSED. Behind `tailscale serve` the TCP peer really is
   * 127.0.0.1 and the proxy stamps the real tailnet client into
   * x-forwarded-for. The old requestIP-only gate saw loopback and waved every
   * tailnet machine in. Presence of the header is the whole test: its VALUE is
   * never parsed, because a value the client controls cannot be trusted to say
   * anything, and only its presence is stamped by something we do trust. */
  for (const c of controls) {
    const res = await post(c, PROXIED);
    expect(res.status, `${c.name} trusted a proxied loopback peer`).toBe(403);
    expect(await res.json()).toEqual(c.refusal);
  }
});

test("a forged x-forwarded-for closes the door rather than opening it", async () => {
  /* The header is the proxy's fingerprint, so a client that adds one of its own
   * only makes itself LESS trusted, never more. Every shape a forger might try
   * -- empty, a loopback address, a list, one naming this very host -- has to
   * refuse a request that would otherwise have been the engine host. */
  const c = controls[0];
  for (const forged of ["", "127.0.0.1", "127.0.0.1, 100.64.0.55", "localhost", "::1"]) {
    const res = await post(c, { "x-test-peer": "127.0.0.1", "x-forwarded-for": forged });
    expect(res.status, `x-forwarded-for: ${JSON.stringify(forged)} was treated as absent`).toBe(403);
  }
  expect((await settingsView()).name).not.toBe("Remote name");
});

test("a socket with no peer data fails CLOSED", async () => {
  // requestIP() answering null must never read as "local"; a gate that cannot
  // tell who is calling has exactly one safe answer
  for (const c of controls) {
    const res = await post(c, NO_PEER);
    expect(res.status, `${c.name} passed a request with no peer address at all`).toBe(403);
  }
});

test("a refusal changes NOTHING: no half-applied rename, settings or photo", async () => {
  /* The app draws a new name or face only when the sessions broadcast brings it
   * back, so a gate that refused after mutating would show every device the
   * stranger's change and then deny it happened. */
  const before = await settingsView();
  for (const peer of [TAILNET, PROXIED, NO_PEER]) {
    for (const c of controls) await post(c, peer);
  }
  const after = await settingsView();
  expect(after.name, "a refused rename landed anyway").toBe(before.name);
  expect(after.name).not.toBe("Remote name");
  expect(after.photo, "a refused photo landed anyway").toBeNull();
  expect(after.settings, "refused settings landed anyway").toEqual(before.settings);
});

test("the gate runs BEFORE the route's own 404s", async () => {
  /* Order matters for what a stranger LEARNS. /session-agents/<id>/stop 404s
   * when no stop handler is registered and when the session has no transcript;
   * if either check ran first, a refused peer could map which sessions exist on
   * this engine by reading the difference between 403 and 404. */
  const unknown = "/session/no-such-session-at-all/rename";
  const remote = await srv.fetch(unknown, {
    method: "POST", headers: { "content-type": "application/json", ...TAILNET },
    body: JSON.stringify({ name: "x" }),
  });
  expect(remote.status, "an unknown session leaked a 404 to a refused peer").toBe(403);

  const local = await srv.fetch(unknown, {
    method: "POST", headers: { "content-type": "application/json", ...HOST },
    body: JSON.stringify({ name: "x" }),
  });
  expect(local.status, "the engine host should reach the route and get its 404").toBe(404);
});

/* -------------------------------------------------------------- the passes */

test("the engine host itself passes: loopback, direct, no proxy header", async () => {
  const rename = await post(controls[0], HOST);
  expect(rename.status, "a script on this machine was refused").toBe(200);
  expect((await rename.json()).ok).toBe(true);
  expect((await settingsView()).name).toBe("Remote name");

  const settings = await post(controls[1], HOST);
  expect(settings.status).toBe(200);
  expect((await settings.json()).settings).toEqual({ muted: true });
});

test("the host reaches the routes BEHIND the gate, so the refusals mean something", async () => {
  /* A gate that answered 403 to everyone would pass every refusal test above
   * and break the product. Each of these is a route whose only interesting
   * answer in this file is the 403, so each one has to be shown working once. */
  const photo = await post({ ...controls[4], body: pngBytes() }, HOST);
  expect(photo.status, "the engine host could not set a session photo").toBe(200);
  expect((await photo.json()).photo).toBeTruthy();
  expect((await settingsView()).photo).toBeTruthy();

  const restart = await post(controls[7], HOST);
  expect(restart.status, "the engine host could not bounce a service").toBe(200);
  expect((await restart.json()).ok).toBe(true);

  const unread = await post(controls[2], HOST);
  expect(unread.status).toBe(200);
  const order = await post(controls[3], HOST);
  expect(order.status).toBe(200);
  expect((await order.json()).order).toEqual([AGENT_ID]);

  /* Past the gate, these two hit their own 404s -- an unclaimed docId and an
   * engine with no out-of-tree stop handler -- which is exactly the answer a
   * refused peer must NOT be able to tell apart from a 403. */
  expect((await post(controls[5], HOST)).status).toBe(404);
  expect((await post(controls[6], HOST)).status).toBe(404);
});

test("every loopback spelling is the engine host", async () => {
  // ::1 and ::ffff:127.0.0.1 are the same machine; an engine listening on a
  // dual-stack socket sees them, and refusing them breaks the local MCP
  for (const peer of [HOST, HOST_V6, HOST_V4_MAPPED]) {
    const res = await post(controls[1], peer);
    expect(res.status, `${peer["x-test-peer"]} was not treated as this machine`).toBe(200);
  }
});

test("agent-message is loopback-only and passes for the machine it runs on", async () => {
  /* Past the gate it reaches validateSend, which is where a 400 comes from. A
   * 400 here is the proof the gate opened: a 403 would mean it did not. */
  const res = await srv.fetch(controls[8].path, {
    method: "POST", headers: { "content-type": "application/json", ...HOST },
    body: JSON.stringify({ author: "", text: "" }),
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("author and text must both be non-empty strings");
});

/* ---------------------------------------- the enrolled device over plain HTTP */

/* A value a remote peer might stamp into x-cyc-cap: the header is DEAD (the cap
 * machinery is deleted), so every one of these opens exactly nothing. */
const CAP_ATTEMPTS = ["anything-at-all", "", "A".repeat(43), "x".repeat(200)];

test("no x-cyc-cap value opens a route over plain HTTP: the bearer is deleted", async () => {
  /* The enrolled device reaches these routes over the sealed DataChannel tunnel,
   * not over an x-cyc-cap HEADER. There is no cap at all any more, so any value
   * a plain-HTTP peer waves buys nothing: direct remote AND proxied loopback
   * (tailscale serve) are both 403. */
  for (const val of CAP_ATTEMPTS) {
    for (const peer of [TAILNET, PROXIED]) {
      const res = await post(controls[0], { ...peer, "x-cyc-cap": val });
      expect(res.status, `x-cyc-cap ${JSON.stringify(val.slice(0, 12))} opened a route`).toBe(403);
      expect(await res.json()).toEqual(REFUSAL);
    }
  }
  expect((await settingsView()).name).not.toBe("Remote name");
});

test("the gate refuses every remote caller; the host always gets in", async () => {
  /* There is no "keys loaded" window that changes a remote answer any more: a
   * cross-host HTTP request is refused, full stop. The host itself always gets
   * in, because that path never read any key state. */
  expect((await post(controls[0], { ...TAILNET, "x-cyc-cap": "whatever" })).status).toBe(403);
  expect((await post(controls[1], HOST)).status).toBe(200);
});

test("a cap header does NOT open agent-message either (it never had a cap path)", async () => {
  /* THE ONE ROUTE WITH NO OWNER PATH AT ALL (#513/#515). It feeds text into a
   * live pane, so it is never reachable over the tailnet -- not by a header, and
   * not by the sealed tunnel (requireLocal has no tunnel branch). */
  const res = await post(controls[8], { ...TAILNET, "x-cyc-cap": "whatever" });
  expect(res.status, "a device reached agent-message over the tailnet").toBe(403);
  expect(await res.json()).toEqual(LOCAL_ONLY_REFUSAL);

  const proxied = await post(controls[8], { ...PROXIED, "x-cyc-cap": "whatever" });
  expect(proxied.status).toBe(403);
  expect(await proxied.json()).toEqual(LOCAL_ONLY_REFUSAL);
});

/* ------------------------------------------------- settings is cut over HTTP too */

test("settings is refused over plain HTTP, bare peer or cap-header peer alike", async () => {
  /* /session/<id>/settings once had a localhost exemption (a later change removed it, adding
   * the cap path); the cap path is deleted too now. An un-paired tailnet peer
   * cannot flip another person's bell, and neither can a paired one over HTTP --
   * the app writes settings over the sealed tunnel now. */
  const bare = await post(controls[1], TAILNET);
  expect(bare.status, "a bare peer set settings").toBe(403);
  expect(await bare.json()).toEqual(REFUSAL);
  expect((await settingsView()).settings, "a refused settings POST was applied").toEqual({});

  const withCap = await post(controls[1], { ...TAILNET, "x-cyc-cap": "whatever" });
  expect(withCap.status, "a cap header set settings over plain HTTP").toBe(403);
  expect((await settingsView()).settings).toEqual({});
});

/* ------------------------------------------- the content sideband is cut */

/* The GET content routes the leak-audit marked MOVE: they used
 * to answer ANY tailnet peer with no gate at all (the "transport auth" that
 * `tailscale serve` made a fiction of). They now answer the host and the sealed
 * tunnel only, so a cross-host HTTP GET is refused BEFORE the route reaches for
 * a session or a file -- which is also why the served ctx here can leave those
 * members absent: a refused peer never touches them. Only session-ops + media
 * are served in this file; chat/plugin GETs are proven the same way by their
 * own suites over serveRoutes on loopback. */
const contentGets = [
  `/session-agents/${encodeURIComponent(AGENT_ID)}`,
  "/new-session/places",
  `/upload/${crypto.randomUUID()}`,
  `/audio/${crypto.randomUUID()}.mp3`,
  `/doc/${crypto.randomUUID()}`,
  `/doc/${crypto.randomUUID()}/raw`,
  `/doc/${crypto.randomUUID()}/state`,
];

test("a remote HTTP GET of a content route is refused, cap header or not", async () => {
  for (const path of contentGets) {
    for (const headers of [TAILNET, PROXIED, { ...TAILNET, "x-cyc-cap": "whatever" }]) {
      const res = await srv.get(path, { headers });
      expect(res.status, `${path} answered a remote HTTP GET`).toBe(403);
      expect(await res.json()).toEqual(REFUSAL);
    }
  }
});

/* The GET /session/<id>/settings route is GONE (settings ride the ws sessions
 * frame + cyc, no remote HTTP read), so there is no read route left to gate here.
 * The sibling settings WRITE stays gated -- proven by "settings is refused over
 * plain HTTP" above and the controls[1] row in every refusal table. */

test("GET /session-photo is now owner-gated: a remote peer gets a uniform 403", async () => {
  /* This was the last deliberately ungated content surface (the OS push-icon
   * fetch). Sealed-transport enforcement closed it: pushes stopped referencing
   * engine photo URLs, so nothing legitimate dials it from outside. A refused
   * peer gets the SAME 403 as any other content route, and BEFORE the route
   * looks for a photo file -- so "not found" (no photo set) never leaks past it. */
  for (const peer of [TAILNET, PROXIED, NO_PEER]) {
    const res = await srv.get(`/session-photo/${encodeURIComponent(AGENT_ID)}`, { headers: peer });
    expect(res.status, "the OS push-icon fetch stayed ungated").toBe(403);
    expect(await res.json()).toEqual(REFUSAL);
  }
  // the host itself still reaches the route (and gets the file's own 404 here)
  const host = await srv.get(`/session-photo/${encodeURIComponent(AGENT_ID)}`, { headers: HOST });
  expect(host.status, "the engine host could not reach its own photo route").toBe(404);
});

test("a preflight OPTIONS is not a way past the gate", async () => {
  /* An OPTIONS that fell through to the mutating branch would be a gate
   * bypass with a different verb; the route matches on POST, so it must simply
   * not be claimed. (The engine grants no CORS at all now, but OPTIONS is
   * still a verb any peer can send.) */
  for (const c of controls) {
    const res = await srv.fetch(c.path, { method: "OPTIONS", headers: TAILNET });
    expect(res.status, `${c.name} answered an OPTIONS from a remote peer`).toBe(404);
  }
});
