/* The launch WIRING end to end: MuxAdapter.spawn augments a pi launch with
 * `-e <ext>` + CYC_PI_EVENT_SOCK and binds a per-pane socket the extension
 * connects to, and does NEITHER for a non-pi launch. subscribePiEvents then
 * delivers the extension's frames to the consumer. Fake mux, no real pi.
 *
 *   bun test agent-engine/src/adapters/pi-spawn.test.ts
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Multiplexer, MuxAgent } from "../terminal/mux.ts";
import { piEventSockPath, PI_EVENT_SOCK_ENV, augmentPiLaunch, PI_EXTENSION_PATH } from "./pi-launch.ts";
import type { PiFrame } from "./pi-events.ts";
import { PiEventServer } from "./pi-events.ts";
import { hookBindFor, resetHookAnnounce } from "../terminal/hook-announce.ts";
import * as S from "../sessions/session-state.ts";

const { MuxAdapter } = await import("./mux-adapter.ts");

/** A fake mux that records the command newTab was handed. */
function recordingMux(handle = "w9:p1") {
  const commands: string[] = [];
  const mux = {
    onAgents(cb: (a: MuxAgent[]) => void) { cb([]); },
    start() {},
    async readPane() { return { text: "", truncated: false }; },
    async sendText() {},
    async sendKeys() {},
    async renamePane() {},
    async closePane() {},
    workspaceOf() { return null; },
    knownCwds() { return []; },
    async newTab(opts: { command: string }) { commands.push(opts.command); return handle; },
  } as unknown as Multiplexer;
  return { mux, commands };
}

let dir: string;
let prevData: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-sock-"));
  process.env.CYC_PI_EVENT_DIR = dir; // short sun_path, off the user's real tree
  // the pi identity tap records into hook-binds.json under the state dir
  // (= CYC_DATA_DIR/state); point it at this throwaway tree so no test touches
  // the user's real data, and forget any binds cached from a prior test.
  prevData = process.env.CYC_DATA_DIR;
  process.env.CYC_DATA_DIR = dir;
  resetHookAnnounce();
  S.resetForTest(); // the direct-carry tap touches the session-state singleton
});
afterEach(() => {
  delete process.env.CYC_PI_EVENT_DIR;
  if (prevData === undefined) delete process.env.CYC_DATA_DIR;
  else process.env.CYC_DATA_DIR = prevData;
  resetHookAnnounce();
  S.resetForTest();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const AID = "ag-0123456789abcdef";

test("a pi launch is augmented with -e + the socket env, and its server streams frames", async () => {
  const { mux, commands } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const { handle } = await adapter.spawn({ cwd: "/work", command: `env CYC_AGENT_ID=${AID} pi` });

  // the command herdr was told to run carries the extension flag + socket env
  expect(commands[0]).toContain("-e ");
  expect(commands[0]).toContain("cyc-output.js");
  expect(commands[0]).toContain(PI_EVENT_SOCK_ENV);

  // the per-pane server is up: the extension (a client) connects and sends
  const sockPath = piEventSockPath(dir, AID);
  const client = createConnection(sockPath);
  await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });
  client.write(`{"t":"pi.event","kind":"reply","id":"u1","text":"hi"}\n`);
  await new Promise((r) => setTimeout(r, 30));

  const got: PiFrame[] = [];
  const unsub = adapter.subscribePiEvents(handle, (f) => got.push(f)); // flushes the buffer
  expect(unsub).not.toBeNull();
  await new Promise((r) => setTimeout(r, 20));
  client.end();
  expect(got.some((f) => f.t === "pi.event" && (f as any).id === "u1")).toBe(true);

  await adapter.close(handle);
  expect(adapter.subscribePiEvents(handle, () => {})).toBeNull(); // server gone on close
});

test("the spawned pi command is byte-identical to the reader launchAugment / augmentPiLaunch output", async () => {
  // THE DE-BRANCH PROOF (Stage 2). spawn now dispatches on the pi reader's
  // eventSocket declaration and decorates through reader.launchAugment instead
  // of the old isPiLaunchCommand sniff + augmentPiLaunch call. The command
  // herdr is handed must be byte-for-byte the augmentPiLaunch output for the
  // same launch + bound socket -- nothing about the augmented string moved.
  const { mux, commands } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const launch = `env CYC_AGENT_ID=${AID} pi`;
  const { handle } = await adapter.spawn({ cwd: "/work", command: launch });

  const sockPath = piEventSockPath(dir, AID);
  const expected = augmentPiLaunch(launch, { extensionPath: PI_EXTENSION_PATH, sockPath }).command;
  expect(commands[0]).toBe(expected);

  // and a pi.session frame still direct-binds the pane through the tap
  const client = createConnection(sockPath);
  await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });
  const PI_UUID = "01a01059-2c50-729b-93ba-9e0c814a537b";
  client.write(`{"t":"pi.session","sessionId":"${PI_UUID}"}\n`);
  await new Promise((r) => setTimeout(r, 40));
  expect(hookBindFor(handle)?.sessionId).toBe(PI_UUID);

  client.end();
  await adapter.close(handle);
});

test("the pi identity tap records a pi.session uuid as the pane's announced bind; a non-uuid records nothing", async () => {
  const { mux } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const { handle } = await adapter.spawn({ cwd: "/work", command: `env CYC_AGENT_ID=${AID} pi` });

  const sockPath = piEventSockPath(dir, AID);
  const client = createConnection(sockPath);
  await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });

  // no bind until the extension names the session
  expect(hookBindFor(handle)).toBeNull();

  const PI_UUID = "01a01059-2c50-729b-93ba-9e0c814a537b";
  client.write(`{"t":"pi.session","sessionId":"${PI_UUID}"}\n`);
  await new Promise((r) => setTimeout(r, 40));
  expect(hookBindFor(handle)?.sessionId).toBe(PI_UUID);

  // a pane-shaped id is not a session id (isHarnessSessionId gate): the bind holds
  client.write(`{"t":"pi.session","sessionId":"w7:p1"}\n`);
  await new Promise((r) => setTimeout(r, 40));
  expect(hookBindFor(handle)?.sessionId, "a non-uuid must not overwrite the bind").toBe(PI_UUID);

  client.end();
  await adapter.close(handle);
});

test("a pi.session delivered LATE (well after spawn) still records the pane's bind", async () => {
  // the capture race: the identity frame can arrive long after spawn (a slow pi
  // boot, or a re-announce on a reconnect). The onSession tap stays attached for
  // the pane's life, so a late frame still records the bind.
  const { mux } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const { handle } = await adapter.spawn({ cwd: "/work", command: `env CYC_AGENT_ID=${AID} pi` });

  const sockPath = piEventSockPath(dir, AID);
  const client = createConnection(sockPath);
  await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });

  // nothing named yet, and a good while passes before the frame arrives
  await new Promise((r) => setTimeout(r, 120));
  expect(hookBindFor(handle)).toBeNull();

  const PI_UUID = "01a01059-2c50-729b-93ba-9e0c814a537b";
  client.write(`{"t":"pi.session","sessionId":"${PI_UUID}"}\n`);
  await new Promise((r) => setTimeout(r, 40));
  expect(hookBindFor(handle)?.sessionId).toBe(PI_UUID);

  client.end();
  await adapter.close(handle);
});

test("PiEventServer replays a session id that arrived BEFORE onSession was attached", async () => {
  // the spawn->attach window: a frame the server receives before the onSession
  // tap is wired must still reach the tap when it attaches. The server caches
  // the last session id and replays it on attach.
  const sockPath = join(dir, "replay.sock");
  const server = new PiEventServer(sockPath);
  await server.listen();

  const client = createConnection(sockPath);
  await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });

  const PI_UUID = "01a01059-2c50-729b-93ba-9e0c814a537b";
  client.write(`{"t":"pi.session","sessionId":"${PI_UUID}"}\n`);
  await new Promise((r) => setTimeout(r, 30));

  // attach the tap only now, AFTER the frame was received: it must replay
  const seen: string[] = [];
  server.onSession((sid) => seen.push(sid));
  expect(seen).toEqual([PI_UUID]);

  // and a later frame still calls the tap live (it stays attached)
  const PI_UUID_2 = "02b02059-2c50-729b-93ba-9e0c814a537b";
  client.write(`{"t":"pi.session","sessionId":"${PI_UUID_2}"}\n`);
  await new Promise((r) => setTimeout(r, 30));
  expect(seen).toEqual([PI_UUID, PI_UUID_2]);

  client.end();
  server.close();
});

test("the socket tap carries the pi session id DIRECTLY onto the engine's own session, with NO herdr snapshot", async () => {
  // THE FAILING DETERMINISM CASE. pi is engine-spawned: after spawn the engine
  // binds its pre-minted agent id to the handle (adoptAgentId, as /new-session
  // does) and reconcile built the row on the pane's first sight -- but herdr
  // never stamped/snapshotted the pane again, so the announced-bind lift never
  // carries the id. The engine-owned socket tap must fill it regardless.
  const { mux } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const { handle } = await adapter.spawn({ cwd: "/work", command: `env CYC_AGENT_ID=${AID} pi` });

  // the /new-session bind that follows spawn, then the engine's own null-id row
  S.adoptAgentId(handle, AID);
  const s = { id: AID, agentId: AID, agent: { id: "pi" }, cwd: "/work", chat: [], log: [],
    harnessSessionId: null, muxHandle: handle, alive: true,
    heardTs: 0, doneSeq: 0, seenDoneSeq: 0, notified: false, filedTs: 0 } as never as S.Session;
  S.sessions.set(AID, s);
  expect(S.metaFor(AID).sessionId).toBeNull();

  const sockPath = piEventSockPath(dir, AID);
  const client = createConnection(sockPath);
  await new Promise<void>((r, j) => { client.on("connect", () => r()); client.on("error", j); });

  const PI_UUID = "01a01059-2c50-729b-93ba-9e0c814a537b";
  client.write(`{"t":"pi.session","sessionId":"${PI_UUID}"}\n`);
  await new Promise((r) => setTimeout(r, 40));

  // set directly on the engine's own session -- no reconcile, no mux snapshot
  expect(s.harnessSessionId, "the live session's id is filled by the tap").toBe(PI_UUID);
  expect(S.metaFor(AID).sessionId, "and the meta reconcile reads").toBe(PI_UUID);
  // the announced-bind store is still written too (the herdr lift + announce
  // paths stay consistent; the two converge on the same id)
  expect(hookBindFor(handle)?.sessionId).toBe(PI_UUID);

  client.end();
  await adapter.close(handle);
});

test("a non-pi launch is byte-identical and has no pi-event server", async () => {
  const { mux, commands } = recordingMux();
  const adapter = new MuxAdapter(mux);
  const cmd = `env CYC_AGENT_ID=${AID} claude --resume x`;
  const { handle } = await adapter.spawn({ cwd: "/work", command: cmd });
  expect(commands[0]).toBe(cmd);
  expect(commands[0]).not.toContain("-e ");
  expect(commands[0]).not.toContain(PI_EVENT_SOCK_ENV);
  expect(adapter.subscribePiEvents(handle, () => {})).toBeNull();
});
