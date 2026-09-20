/* THE ONLY PLACE IN THIS REPO THAT BOOTS A REAL ENGINE.
 *
 * This is notify-harness.ts, moved. It used to sit beside the source and 64
 * test files imported it, which is how a `bun test` of the engine came to spawn
 * a `bun run server.ts` subprocess three hundred and fifty times and OOM a 32GB
 * box. It now lives under e2e/ with the four happy-path specs that use it, and
 * gates.test.ts fails the build if any test file outside e2e/ imports it or
 * calls startEngine.
 *
 * A booted engine still needs the same three things, and none of them may touch
 * anything real:
 *
 *   - an engine on its own port, with its own data directory, so a test never
 *     writes to the chat log the user's app is reading;
 *   - a fake herdr, because sessions exist only as herdr panes and there has to
 *     be a chat to notify about;
 *   - a sink where the app server would be, so no device is ever pushed to.
 *
 * The fake herdr, the push sink, the builders and the guardrails are no longer
 * defined here: they are in ../test-utils/ where the seam tier uses them
 * without an engine, and re-exported below so this file's own surface is
 * unchanged. */

import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEngineE2E, unregisterEngineE2E } from "./testclient.ts";
import { BATCH_MS, HARNESS_CWD, PANE, defaultSessionIdOf, fakeHerdr, type FakeHerdr, type Hooks }
  from "../test-utils/fake-herdr.ts";
import { pushSink } from "../test-utils/push-sink.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";
import { whyNotFakeCredentials, whyNotFakeServices, whyNotLocalUpstream } from "../test-utils/guardrails.ts";
import { dataDirOf, metaForSession, readAgentMetas, readChatLog, seedAgent, seedTranscript }
  from "../test-utils/builders.ts";

/* Re-exported so the four e2e specs (and freeze-probe) import one file, as they
 * always have. The definitions live in ../test-utils/ because the seam tier
 * uses every one of them without booting anything. */
export { BATCH_MS, HARNESS_CWD, PANE, defaultSessionIdOf, fakeHerdr, pushSink, seedTranscript,
  dataDirOf, seedAgent, readAgentMetas, metaForSession, readChatLog,
  whyNotLocalUpstream, whyNotFakeCredentials, whyNotFakeServices };
export type { FakeHerdr };

/* TRUE ONLY WHEN THE E2E TRANSPORT PRELOAD IS INSTALLED.
 *
 * The sealed-client specs (openSealedClient) speak `hello` on the wire, which
 * since #579 the engine answers ONLY over a WebRTC DataChannel: a raw WS hello
 * is refused (transport-required, close 4426). testpreload.ts swaps
 * globalThis.WebSocket for the TestClient shim that dials that DataChannel, and
 * it is loaded ONLY by `bun run test:e2e` (bun test --preload), never by a bare
 * `bun test`. Without it the shim is absent, the native WebSocket is in place,
 * and a sealed spec can only time out. Specs gate on this and SKIP rather than
 * fail when it is missing; run `bun run test:e2e` to exercise them for real. */
export const hasE2ETransport = globalThis.WebSocket?.name === "TestClient";

export type Engine = {
  port: number;
  url: string;
  /** http origin, and where a `page` passed to startEngine is served from */
  http: string;
  /** the throwaway root this engine runs from: its data dir is <dir>/data */
  dir: string;
  /** every stdout/stderr line, prefixed with the ms it was read */
  lines: string[];
  /** every pane call the engine made, in order: what the agent was given, and
   *  what was pressed around it */
  rpcs: { method: string; pane: string; text?: string; keys?: string[] }[];
  /** just the text typed, in order: one entry per pane.send_text */
  typed: () => string[];
  /** WHAT THE AGENT ACTUALLY RECEIVED: one entry per input that a real enter
   *  submitted. Not the same question as `typed` -- an enter into an emptied
   *  input types nothing and submits nothing, and only this can tell. */
  submitted: () => string[];
  /** empty a pane's input behind the engine's back: a person at the keyboard */
  clearPaneInput: (pane?: string) => void;
  /** serve this exact screen for the pane, for a test that wants real captured
   *  bytes rather than a screen this harness made up. null restores the fake's
   *  own rendering. */
  setPaneScreen: (screen: string | null, pane?: string) => void;
  /** the agent on that pane quits, or comes back: herdr stops (or resumes)
   *  listing it, with the lifecycle event that makes the engine resnapshot.
   *  Resolves once the engine's own `alive` for the pane has caught up, so a
   *  test never races the round trip. */
  setAgentGone: (gone: boolean, pane?: string) => Promise<void>;
  /** the same conversation restarts onto a new pane: its claude session id moves
   *  to `toPane`, the old pane stops being listed, and the engine resnapshots. */
  becomePane: (fromPane: string, toPane: string) => Promise<void>;
  /** claude on this pane mints its session uuid at last: the pane's agent_session
   *  flips from null to `uuid` and the engine resnapshots. The end of the
   *  no-session-id limbo (#405), on the same pane. */
  mintSession: (uuid: string, pane?: string) => Promise<void>;
  /** claude on this pane rolls its uuid without the process dying (#571): the
   *  same live pane reports a new agent_session, its session stays alive. */
  rollSession: (uuid: string, pane?: string) => Promise<void>;
  /** the old claude exited and a brand-new one starts in the reused pane under a
   *  new uuid. Mark the old session dead (setAgentGone) before calling this. */
  respawnSession: (uuid: string, pane?: string) => Promise<void>;
  /** lines since a moment, for asking what a single decision did */
  since: (at: number) => string[];
  /** Author a claude transcript this engine will find at ~/.claude/projects (its
   *  throwaway copy). `content` is the file body; `mtimeMs`, when given, backdates
   *  the file so a roll's continuity check sees it as quiet or active. Returns the
   *  path written. */
  writeTranscript: (uuid: string, opts?: { content?: string; mtimeMs?: number; cwd?: string }) => Promise<string>;
  sink: ReturnType<typeof pushSink>;
  /** the fake terminal: what its screens say, what was typed at it */
  herdr: FakeHerdr;
  /** a session socket that can speak and show, already registered as the
   *  named pane (PANE by default) */
  session: (handle?: string) => Promise<WebSocket>;
  /** kill the engine process (SIGKILL by default, an unclean death) and boot it
   *  again on the same port, data dir and fake herdr. Resolves once /health
   *  answers again. Sockets opened before the reboot are dead. */
  reboot: (signal?: NodeJS.Signals) => Promise<void>;
  /** the wire id (agent id) of whatever agent the pane hosts right now, read off
   *  a fresh sessions frame; throws when nothing listed reports that session */
  wireIdOf: (handle?: string) => Promise<string>;
  /** a page-shaped client: hello, attach, and a heartbeat it can be told to stop.
   *  `attach` takes an agent id or a pane handle (resolved to its agent id). */
  client: (opts?: { beatMs?: number; attach?: string }) => Promise<TestClient>;
  stop: () => Promise<void>;
};

export type TestClient = {
  ws: WebSocket;
  /** stop beating without closing the socket: what a frozen page looks like */
  freeze: () => void;
  resume: () => void;
  /** keep beating, but say invisible every time: a page he has left */
  background: () => void;
  say: (frame: unknown) => void;
  close: () => void;
};

/* THE one sealed-client helper. Dial like a real app device: the TestClient
 * shim (testpreload) takes the hello onto a DataChannel, runs sec, and sends
 * sec-ok with the key-required pair proof registered from this engine's
 * keys.json. Callers see opened application frames (sessions, attach-ok,
 * chat). Do not copy this into a spec. A raw-WS proof uses TestClient.Native. */
export async function openSealedClient(
  e: { url: string },
  ms = 15_000,
): Promise<{ ws: WebSocket; frames: Record<string, any>[] }> {
  const ws = new WebSocket(e.url);
  const frames: Record<string, any>[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no sessions frame in 15s")), ms);
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello" }));
    ws.onerror = () => reject(new Error("socket failed"));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data));
        frames.push(m);
        if (m.t === "sessions") {
          clearTimeout(timer);
          resolve();
        }
      } catch { /* not ours */ }
    };
  });
  return { ws, frames };
}

export async function framesFor(
  e: { url: string },
  id: string,
  since = 0,
  ms = 1500,
  limit?: number,
): Promise<Record<string, any>[]> {
  const { ws, frames: got } = await openSealedClient(e);
  ws.send(JSON.stringify({ t: "attach", id, since, ...(limit ? { limit } : {}) }));
  await Bun.sleep(ms);
  ws.close();
  return got;
}

/** Start an engine nothing else can see. Remember to await stop().
 *
 * `page` is html served at <http>/probe.html, for a test that needs a real
 * browser: the engine's own origin is one its websocket guard accepts, so
 * there is no second server to keep alive. */
/* A PORT NOBODY ELSE HAS, TAKEN BY ASKING THE OS RATHER THAN BY GUESSING.
 *
 * This used to be `7800 + random(190)`, and a full sweep starts about thirty
 * engines across thirteen files at once. Two of them landing on the same number
 * is not rare at that rate, it is expected, and the failure it produces is
 * silent and baffling: the second engine cannot bind, but the health check
 * still passes because it reaches the FIRST one. The test then talks to another
 * test's engine, polls its OWN data directory for a line that will never appear
 * there, and times out.
 *
 * That is the four rescue tests that were red in every full run and green on
 * their own, all day. Raising their patience to forty seconds changed nothing,
 * which is what ruled out slowness: the engine was not late, it was somebody
 * else's.
 *
 * Binding port 0 and reading back what the OS gave us leaves a window between
 * the close and the engine's own bind, but it is microseconds against a
 * one-in-many-thousand collision, rather than a coin flip. */
export async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port;
  s.stop(true);
  return port;
}

export async function startEngine(
  opts: {
    env?: Record<string, string>;
    page?: string;
    seed?: (dir: string) => Promise<void>;
    /** herdr's agent_status for the one pane. "working" is the only state in
     *  which a message actually waits in claude's input queue. */
    agentStatus?: string;
    /** the panes herdr reports, in herdr's own order. One by default. */
    panes?: string[];
    /** panes herdr has seen but whose claude has NOT minted a session uuid yet:
     *  they report a null agent_session, so the engine keys them by pane id.
     *  This is how a spec sets up the no-session-id limbo before mintSession. */
    noSession?: string[];
    /** claude session id (herdr agent_session) per pane. Unset panes report their
     *  own pane id, so the engine's stable public id equals the pane. Set one to
     *  make them differ, which is what a real uuid does and what a restart-onto-a-
     *  new-pane test needs. */
    sessionIds?: Record<string, string>;
    /** which agent each pane runs, herdr's per-pane stamp; claude for any pane not
     *  named here. A mixed fleet (claude + codex + opencode) is how a spec proves
     *  the engine lists every stamped pane whatever the agent (invariant L1). */
    agents?: Record<string, string>;
    /** the user's global defaults, as the app server would answer /settings.
     *  Applied BEFORE the engine boots, because the engine reads them once at
     *  boot and then on a TTL: flipping them mid-test would not be seen. */
    settings?: Partial<ReturnType<typeof pushSink>["settings"]>;
    /** make herdr refuse a keystroke: given every send_keys in order, true
     *  means answer with an error. The failure that strands a typed body. */
    failKeys?: (keys: string[]) => boolean;
  } = {},
): Promise<Engine> {
  const { env = {}, page, seed, agentStatus } = opts;
  const dir = await mkdtemp(join(tmpdir(), "cyc-notify-"));
  const port = await freePort();
  const sink = pushSink();
  if (opts.settings) Object.assign(sink.settings, opts.settings);
  await Bun.$`mkdir -p ${dir}/data ${dir}/home`.quiet(); // the engine's own CYC_DATA_DIR and HOME
  /* This engine's own ~/.claude/projects, so nothing it stats or reads reaches
   * the real one. A spec authors claude transcripts here; the engine's roll
   * continuity check, context reader and lineage prober all resolve to it. */
  const projectsDir = join(dir, "projects");
  await mkdir(projectsDir, { recursive: true });
  const transcriptPath = (uuid: string, cwd = HARNESS_CWD) =>
    join(projectsDir, mungeCwd(cwd), `${uuid}.jsonl`);
  /* The engine source, <repo>/engine/agent-engine/src (this file's PARENT now
   * that the harness lives under src/e2e/). Copied whole so the spawned engine
   * runs from the test's own throwaway tree and nothing it writes lands in the
   * working copy, at the same depth (agent-engine/src) so every relative import
   * resolves. node_modules is a symlink back to the real one (57 MB, read-only
   * to the engine) rather than a copy.
   *
   * And <repo>/engine/shared at the same relative position, because the engine
   * imports it as "../../../shared/...". Copying agent-engine alone left every
   * one of those imports pointing outside the throwaway tree, and the spawned
   * engine died at load with "Cannot find module '../shared/logbook.ts'". */
  const pkgDir = join(import.meta.dir, "..", "..");
  await mkdir(join(dir, "agent-engine"), { recursive: true });
  await Bun.$`cp -R ${join(pkgDir, "src")} ${dir}/agent-engine/src`.quiet();
  await Bun.$`ln -s ${join(pkgDir, "node_modules")} ${dir}/agent-engine/node_modules`.quiet();
  await Bun.$`cp -R ${join(pkgDir, "..", "shared")} ${dir}/shared`.quiet();
  /* A made-up token, in the shape limits.ts reads, so the engine never has a
   * reason to look at the keychain. It is not a valid credential anywhere and
   * the upstream it would be sent to is a port that refuses. */
  await writeFile(join(dir, "credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "harness-not-a-real-token" } }));
  /* Nothing supervised unless the spec asks for it, and never anything of his.
   * Written BEFORE seed() so a spec that wants a service of its own overwrites
   * this file with its own table (services.test.ts). */
  await writeFile(join(dir, "services.json"), "[]");
  // Anything the engine has to find ALREADY THERE when it boots: a chat log to
  // restore, a store that is already over its cap. Runs after .run exists and
  // before the process starts, which is the only window a boot-time decision
  // can be set up in.
  if (seed) await seed(dir);
  if (page) await Bun.write(join(dir, "agent-engine", "public", "probe.html"), page);
  const rpcs: Engine["rpcs"] = [];
  const submits: { pane: string; text: string }[] = [];
  const hooks: Hooks = {};
  // shared with the fake: mint/roll/respawn/becomePane keep it current, so the
  // harness can always say which harness session id a pane reports right now
  const sessionIds = new Map(Object.entries(opts.sessionIds ?? {}));
  const herdr = fakeHerdr(join(dir, "herdr.sock"), agentStatus, opts.panes, rpcs,
    opts.failKeys, submits, hooks, sessionIds,
    new Set(opts.noSession ?? []), new Map(Object.entries(opts.agents ?? {})));

  const engineEnv = {
    ...process.env,
    AGENT_PORT: String(port),
    AGENT_HOST: "127.0.0.1",
    ENGINE_HOST: "probe",
    HERDR_SOCKET_PATH: join(dir, "herdr.sock"),
    APP_SERVER_URL: sink.url,
    NOTIFY_DEBUG: "1",
    /* The batch window, from the one place it is written down. Before `...env`,
     * so a spec that is specifically about the ten second window can still ask
     * for one. */
    NOTIFY_BATCH_MS: String(BATCH_MS),
    /* Port 1 answers nothing, so the limits poll fails at connect and the
     * engine boots showing its last-seen numbers, which is a state worth
     * booting in anyway. whyNotLocalUpstream above says why this is here and
     * why it is checked rather than trusted. The share and seen paths are in
     * this engine's own temp directory for the same reason: nothing a test
     * starts may touch the machine's real ones. */
    CYC_LIMITS_API: "http://127.0.0.1:1",
    CYC_LIMITS_SHARE_DIR: join(dir, "limits-share"),
    CYC_LIMITS_SEEN: join(dir, "data", "state", "limits-seen.json"),
    CYC_LIMITS_CREDENTIALS: join(dir, "credentials.json"),
    CYC_SERVICES_FILE: join(dir, "services.json"),
    /* Its own by default, so no spec can take the lease his real engines use.
     * A spec that wants two engines to argue over one host passes a shared
     * directory it made itself. */
    CYC_SERVICES_LEASE_DIR: join(dir, "lease"),
    /* A test cannot wait a minute for the watch loop, and a service that dies
     * has to be seen coming back inside the spec that killed it. */
    CYC_SERVICES_INTERVAL_MS: "500",
    CYC_SERVICES_RESTART_MS: "200",
    // This engine's throwaway ~/.claude/projects (see projectsDir above).
    CYC_PROJECTS_DIR: projectsDir,
    /* The engine's whole data dir (the design) lives inside this test's
     * throwaway directory, so nothing it writes can reach a real
     * ~/.callyourcode. */
    CYC_DATA_DIR: join(dir, "data"),
    /* And its HOME: the default of dataDir() and anything else that reads
     * ~ (claude's projects dir, XDG paths) resolve inside this test's
     * directory too, whatever the engine does with CYC_DATA_DIR. The test
     * process itself already runs under the preload's fake home
     * (test-utils/homeguard.ts); this is the same fence for the child. */
    HOME: join(dir, "home"),
    /* The fake herdr reports every pane's agent_session the way the real one
     * does: as its guess (the newest transcript in the cwd), never as an
     * announce. Reconcile holds a guess for the announce grace (10 s) before
     * it may name the session, which is right for a person's pane and wrong
     * for a rig whose hook never speaks: every spec would wait ten seconds
     * for a row. Zero here, the same default the seam rig (wire-core) uses; a
     * spec about the grace itself passes its own value through `env`. */
    CYC_ANNOUNCE_GRACE_MS: "0",
    ...env,
  };

  /* CHECKED ON THE VALUES THAT WILL ACTUALLY BE USED, after `...env`, which is
   * the only version of these checks worth having. Reading the defaults a few
   * lines up would pass whether or not the defaults are still there. */
  const why = whyNotLocalUpstream(engineEnv.CYC_LIMITS_API) ??
    whyNotFakeCredentials(engineEnv.CYC_LIMITS_CREDENTIALS, dir) ??
    whyNotFakeServices(engineEnv.CYC_SERVICES_FILE, dir,
      await Bun.file(engineEnv.CYC_SERVICES_FILE).text().catch(() => "[]"),
      engineEnv.CYC_SERVICES_LEASE_DIR);
  if (why) {
    herdr.stop(true);
    sink.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`[harness] refusing to start an engine: ${why}`);
  }

  const lines: string[] = [];
  const drain = async (stream: ReadableStream) => {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(`${Date.now()} ${buf.slice(0, i)}`);
        buf = buf.slice(i + 1);
      }
    }
  };

  const url = `ws://127.0.0.1:${port}/ws`;
  /* ONE BOOT, reusable: the same command, env, port and data dir, so a spec
   * that kills the engine can bring it back on the state the first one left
   * behind, exactly as a crash and a relaunch would. */
  const boot = async () => {
    const p = Bun.spawn(["bun", "run", join(dir, "agent-engine", "src", "runtime", "server.ts")], {
      env: engineEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    void drain(p.stdout as ReadableStream);
    void drain(p.stderr as ReadableStream);
    for (let i = 0; i < 80; i++) {
      // a process that has already exited cannot be the thing answering /health,
      // so say so with its own output rather than letting the test talk to a
      // stranger's engine and fail somewhere far away
      if (p.exitCode !== null) {
        throw new Error(`engine exited ${p.exitCode} on port ${port}:\n` + lines.join("\n"));
      }
      if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) break;
      await Bun.sleep(100);
      if (i === 79) throw new Error("engine did not start:\n" + lines.join("\n"));
    }
    return p;
  };
  /* A BOOT THAT NEVER CAME UP still leaves a fake herdr, a push sink and a
   * throwaway tree behind. It used to leak all three (only the guardrail refusal
   * above cleaned up), which a test that WANTS a refusing engine (the live-socket
   * probe) would turn into a leaked unix socket per run. Tear the scaffolding
   * down and rethrow the boot's own error. The .catch keeps `proc` inferred from
   * boot()'s own return type. */
  let proc = await boot().catch(async (e) => {
    herdr.stop(true);
    sink.stop();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  });
  /* The engine's keys live at <CYC_DATA_DIR>/keys.json. The sealed client
   * reads a live content generation from that file to mint sec-ok.pair. */
  registerEngineE2E(port, join(dir, "data", "keys.json"));

  const open = async () => {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed"));
    });
    return ws;
  };

  const sockets: WebSocket[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];

  return {
    port,
    url,
    http: `http://127.0.0.1:${port}`,
    dir,
    lines,
    rpcs,
    typed: () => rpcs.filter((r) => r.method === "pane.send_text").map((r) => r.text ?? ""),
    submitted: () => submits.map((s) => s.text),
    clearPaneInput: (pane = PANE) => hooks.clearInput?.(pane),
    setPaneScreen: (screen: string | null, pane = PANE) => hooks.setScreen?.(pane, screen),
    setAgentGone: (isGone: boolean, pane = PANE) => herdr.setAgentGone(pane, isGone),
    becomePane: (fromPane, toPane) => herdr.becomePane(fromPane, toPane),
    mintSession: (uuid, pane = PANE) => herdr.mintSession(pane, uuid),
    rollSession: (uuid, pane = PANE) => herdr.rollSession(pane, uuid),
    respawnSession: (uuid, pane = PANE) => herdr.respawnSession(pane, uuid),
    sink,
    herdr,
    since: (at: number) => lines.filter((l) => Number(l.split(" ")[0]) >= at - 50),
    async writeTranscript(uuid, o = {}) {
      const path = transcriptPath(uuid, o.cwd);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, o.content ?? "{}\n");
      if (o.mtimeMs != null) { const t = new Date(o.mtimeMs); await utimes(path, t, t); }
      return path;
    },
    async session(handle = PANE) {
      const ws = await open();
      sockets.push(ws);
      ws.send(JSON.stringify({ t: "register", id: handle, name: "probe", channels: ["speak", "chat", "show"] }));
      await Bun.sleep(200);
      return ws;
    },
    async reboot(signal = "SIGKILL") {
      proc.kill(signal);
      await proc.exited;
      // the fake herdr and the data dir are untouched: what survives a crash
      proc = await boot();
    },
    async wireIdOf(handle = PANE) {
      const sid = sessionIds.get(handle) ?? defaultSessionIdOf(handle);
      const { ws, frames } = await openSealedClient({ url });
      ws.close();
      const rows = [...frames].reverse().find((f) => f.t === "sessions")?.list ?? [];
      const row = rows.find((s: Record<string, any>) => s.harnessSessionId === sid);
      if (!row) throw new Error(`no listed agent reports session ${sid} (pane ${handle})`);
      return String(row.id);
    },
    async client(opts = {}) {
      const beatMs = opts.beatMs ?? 1_500;
      const { ws, frames } = await openSealedClient({ url });
      sockets.push(ws);
      // the wire addresses an AGENT id; a pane handle is looked up on the
      // sessions frame this very socket was just handed
      let id = opts.attach ?? PANE;
      if (!/^ag-/.test(id)) {
        const sid = sessionIds.get(id) ?? defaultSessionIdOf(id);
        const rows = [...frames].reverse().find((f) => f.t === "sessions")?.list ?? [];
        id = String(rows.find((s: Record<string, any>) => s.harnessSessionId === sid)?.id ?? id);
      }
      ws.send(JSON.stringify({ t: "attach", id, since: 0 }));
      ws.send(JSON.stringify({ t: "visible", on: true }));
      let beating = true;
      /* WHAT THE HEARTBEAT SAYS, and it has to be a variable rather than a
       * literal `true`. The real app repeats its visibility on every beat, so a
       * test that flips a page to backgrounded with one `say` had that flip
       * silently undone by the next beat 1.5s later. Every "backgrounded page"
       * test was really testing a visible one. */
      let visible = true;
      const timer = setInterval(() => {
        if (beating && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "visible", on: visible }));
      }, beatMs);
      timers.push(timer);
      // three beats: the engine learns this page's cadence from its own traffic
      await Bun.sleep(beatMs * 3 + 200);
      return {
        ws,
        freeze: () => { beating = false; },
        resume: () => { beating = true; },
        /** background this page, the way the app does when you leave it */
        background: () => { visible = false; ws.send(JSON.stringify({ t: "visible", on: false })); },
        say: (frame: unknown) => ws.send(JSON.stringify(frame)),
        close: () => ws.close(),
      };
    },
    async stop() {
      unregisterEngineE2E(port);
      for (const t of timers) clearInterval(t);
      for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }
      proc.kill();
      herdr.stop(true);
      sink.stop();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
