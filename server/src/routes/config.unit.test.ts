/* routes/config.ts as a unit: the /config assembly (announce-only leased
 * engines, voiceBases in engine order, the rtc block), HOSTED owner scoping,
 * and voiceBaseOf's url math. The voice pool points at a dead port, as the
 * whole suite does (VOICE_URL=http://127.0.0.1:1), so picks answer null fast. */

import { test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfigRoutes, voiceBaseOf, rtcBlock } from "./config";
import { EngineLeases } from "../engines/hosts";
import { VoicePool } from "../engines/voice";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

async function rig(hosted = false, sub: string | null = null) {
  const d = await mkdtemp(join(tmpdir(), "cyc-cfgroutes-unit-"));
  dirs.push(d);
  const leases = await EngineLeases.open(join(d, "leases.json"), 60_000);
  const voice = new VoicePool("http://127.0.0.1:1|http://127.0.0.1:1|dead");
  const routes = makeConfigRoutes({
    hosted, leases, voice,
    sessionSub: async () => sub,
    localStore: null, ownerCount: () => 2, distDir: "/tmp/dist",
  });
  return { leases, routes };
}

const ask = async (routes: any, path: string) => {
  const url = new URL(`http://x${path}`);
  return routes(new Request(url), url.pathname, url);
};

test("voiceBaseOf: same origin over http(s), path /voice, junk empties", () => {
  expect(voiceBaseOf("ws://host:10101/ws")).toBe("http://host:10101/voice");
  expect(voiceBaseOf("wss://host/ws?x=1#f")).toBe("https://host/voice");
  expect(voiceBaseOf("not a url")).toBe("");
});

test("rtcBlock: LOCAL is empty; HOSTED STUN for everyone, no TURN/relay unless configured", () => {
  // LOCAL: host candidates connect, so no ICE servers and no relay url ever.
  expect(rtcBlock(false, "local")).toEqual({ iceServers: [] });
  expect(rtcBlock(false, null)).toEqual({ iceServers: [] });
  const anon = rtcBlock(true, null);
  const authed = rtcBlock(true, "user_bob");
  expect((anon.iceServers as any[]).length).toBeGreaterThan(0);
  for (const s of anon.iceServers as any[]) {
    expect(s.urls[0].startsWith("stun:")).toBe(true);
    expect(s.credential).toBeUndefined();
  }
  expect((anon as any).relay).toBeUndefined();
  // no coturn configured in this environment: authed matches anon
  expect(JSON.stringify(authed)).toBe(JSON.stringify(anon));
});

test("/config LOCAL announce-only: the announced lease only, voiceBases in engine order", async () => {
  const { leases, routes } = await rig();
  await leases.announce({ engineId: "e1", owner: "h2", user: "u", url: "ws://h2:10101/ws" });
  const r = (await ask(routes, "/config"))!;
  const j = await r.json();
  expect(j.auth).toBe("none");
  expect(j.voice).toBeNull();      // the dead pool picks nobody
  // announce-only: exactly the announced engine, in object form, no seed url
  expect(j.engines).toEqual([{ url: "ws://h2:10101/ws", engineId: "e1", host: "h2", user: "u" }]);
  const urls = j.engines.map((e: any) => e.url);
  expect(urls).not.toContain("ws://127.0.0.1:10101/ws");
  // voiceBases ride in the SAME order as engines
  expect(j.voiceBases).toEqual(urls.map(voiceBaseOf));
  // LOCAL: no ICE servers (host candidates connect), no relay url.
  expect(j.rtc).toEqual({ iceServers: [] });
});

test("/config LOCAL with nothing announced: EMPTY engines, no localhost default", async () => {
  const { routes } = await rig();
  const j = await (await ask(routes, "/config"))!.json();
  expect(j.auth).toBe("none");
  expect(j.engines).toEqual([]);
  expect(j.voiceBases).toEqual([]);
});

test("/config HOSTED: no session sees NO engines, never another owner's engine", async () => {
  const { leases, routes } = await rig(true, null);
  await leases.announce({ engineId: "e1", owner: "user_bob", user: "u", url: "ws://h2:10101/ws" });
  const j = await (await ask(routes, "/config"))!.json();
  expect(j.auth).toBe("clerk");
  expect(j.engines).toEqual([]);
});

test("/config HOSTED: a session sees its own announced engines", async () => {
  const { leases, routes } = await rig(true, "user_bob");
  await leases.announce({ engineId: "e1", owner: "user_bob", user: "u", url: "ws://h2:10101/ws" });
  await leases.announce({ engineId: "e2", owner: "user_eve", user: "u", url: "ws://h3:10101/ws" });
  const j = await (await ask(routes, "/config"))!.json();
  const urls = j.engines.map((e: any) => (typeof e === "string" ? e : e.url));
  expect(urls).toContain("ws://h2:10101/ws");
  expect(urls).not.toContain("ws://h3:10101/ws");
});

test("/hosts serves the lease payload; /health names the mode and count", async () => {
  const { routes } = await rig(true, null);
  const hosts = await (await ask(routes, "/hosts"))!.json();
  expect(hosts.hosts ?? hosts).toBeDefined();
  const health = await (await ask(routes, "/health"))!.json();
  expect(health.ok).toBe(true);
  expect(health.mode).toBe("hosted");
  expect(health.devices).toBe(2);   // ownerCount when there is no local store
  expect(health.dist).toBe("/tmp/dist");
});

test("/voice answers the pick and the published engine health", async () => {
  const { routes } = await rig();
  const j = await (await ask(routes, "/voice?role=tts"))!.json();
  expect(j.role).toBe("tts");
  expect(j.url).toBeNull();
  expect(j.engines.length).toBe(1);
  expect(j.engines[0].label).toBe("dead");
});

test("unknown paths fall through as null", async () => {
  const { routes } = await rig();
  expect(await ask(routes, "/push/key")).toBeNull();
});
