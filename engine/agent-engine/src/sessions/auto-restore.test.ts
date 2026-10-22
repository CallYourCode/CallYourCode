import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiplexerAdapter } from "../adapters/mux-adapter.ts";
import { until } from "../test-utils/wait.ts";
import { sessions, type Session } from "./session-state.ts";
import { incarnation, restoreDecision, shellProcess, startAutoRestore, type RunningAgent } from "./auto-restore.ts";
import { recordHookBind, resetHookAnnounce } from "../terminal/hook-announce.ts";

const record: RunningAgent = {
  agentId: "ag-0123456789abcdef", running: true, paneId: "w1:p1", workspace: "w1",
  cwd: "/tmp/a", harness: "pi", sessionId: "11111111-1111-4111-8111-111111111111",
  bootId: "old", herdrInstance: "old-server",
};
const current = { bootId: "new", herdrInstance: "new-server" };
const shell = { paneId: "w1:p1", cwd: "/tmp/a", shell: true, busy: false };
test("process-info must positively identify the sole foreground process as the pane shell", () => {
  expect(shellProcess({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh" }] })).toBe(true);
  expect(shellProcess({ shell_pid: 1, foreground_processes: [{ pid: 2, name: "vim" }] })).toBe(false);
  expect(shellProcess({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh" }, { pid: 2, name: "pi" }] })).toBe(false);
  expect(shellProcess({})).toBe(false);
});
test("plain engine restart never restores", () => {
  expect(restoreDecision(record, record, shell, false)).toEqual({ action: "skip", reason: "same-instance" });
});
test("boot change restores in place", () => {
  expect(restoreDecision(record, { ...record, bootId: "new" }, shell, false).action).toBe("pane");
});
test("herdr restart restores in place", () => {
  expect(restoreDecision(record, { ...record, herdrInstance: "new" }, shell, false).action).toBe("pane");
});
test("stopped agents stay stopped", () => {
  expect(restoreDecision({ ...record, running: false }, current, shell, false).reason).toBe("stopped");
});
test("missing pane falls back to reopen", () => {
  expect(restoreDecision(record, current, null, false).action).toBe("reopen");
});
test("changed cwd falls back without touching the old pane", () => {
  expect(restoreDecision(record, current, { ...shell, cwd: "/other" }, false).action).toBe("reopen");
});
test("busy pane is never touched, even with a changed cwd", () => {
  expect(restoreDecision(record, current, { ...shell, cwd: "/other", busy: true }, false).reason).toBe("busy");
});
test("unknown foreground process is not a shell", () => {
  expect(restoreDecision(record, current, { ...shell, shell: false }, false).reason).toBe("busy");
});
test("duplicate agent or session skips", () => {
  expect(restoreDecision(record, current, shell, true).reason).toBe("duplicate");
});
test("one attempt per recovery epoch survives another engine restart", () => {
  expect(restoreDecision({ ...record, attempted: current }, current, shell, false).reason).toBe("already-attempted");
});

for (const seeded of [false, true]) {
  test(`startup outage does not disable recording (${seeded ? "existing" : "empty"} state)`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cyc-restore-outage-"));
    const env = { CYC_DATA_DIR: process.env.CYC_DATA_DIR, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
    const priorSessions = new Map(sessions);
    const path = join(dir, "state", "running-agents.json");
    const row = {
      agentId: "ag-0123456789abcdef", running: true, paneId: "w1:p1", workspace: "w1",
      cwd: dir, harness: "pi", sessionId: "11111111-1111-4111-8111-111111111111",
    };
    let available = false, alive = true, agentEvent: (() => void) | undefined;
    const events: string[] = [], notices: string[] = [], methods: string[] = [];
    let unavailable!: () => void;
    const startupFinished = new Promise<void>((resolve) => { unavailable = resolve; });
    process.env.CYC_DATA_DIR = dir;
    process.env.HERDR_SOCKET_PATH = join(dir, "herdr.sock");
    const server = Bun.listen({
      unix: process.env.HERDR_SOCKET_PATH,
      socket: {
        data(sock, chunk) {
          for (const line of chunk.toString().trim().split("\n")) {
            const msg = JSON.parse(line);
            methods.push(msg.method);
            const pane = { pane_id: row.paneId, workspace_id: row.workspace, cwd: dir, ...(alive ? { agent: "pi" } : {}) };
            const result = msg.method === "session.snapshot"
              ? { snapshot: { panes: [pane], agents: alive ? [pane] : [] } }
              : { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: "zsh", cwd: dir }] } };
            sock.write(JSON.stringify({ id: msg.id, ...(available ? { result } : { error: { message: "starting" } }) }) + "\n");
          }
        },
      },
    });
    const interval = spyOn(globalThis, "setInterval");
    // Expire the startup deadline after one failed RPC without changing global
    // time. Snapshot/process checks and the periodic observer still use I/O.
    let clockReads = 0;
    const readRows = (): RunningAgent[] => JSON.parse(readFileSync(path, "utf8")).agents;
    try {
      sessions.clear();
      if (seeded) {
        mkdirSync(join(dir, "state"));
        writeFileSync(path, JSON.stringify({ version: 1, agents: [{
          ...row, sessionId: "22222222-2222-4222-8222-222222222222", ...incarnation(),
        }] }));
      }
      startAutoRestore({
        now: () => clockReads++ === 0 ? 0 : 31_000,
        adapter: { onAgents: (cb: () => void) => { agentEvent = cb; } } as unknown as MultiplexerAdapter,
        log: (event) => { events.push(event); },
        notify: async (body) => { notices.push(body); unavailable(); },
      });
      await startupFinished;
      expect(clockReads).toBe(2);
      expect(events).toContain("restore.unavailable");
      expect(agentEvent).toBeDefined();
      available = true;
      sessions.set(row.agentId, {
        agentId: row.agentId, muxHandle: row.paneId, alive: true, viaMux: true,
        cwd: dir, agent: { id: "pi" }, harnessSessionId: row.sessionId,
      } as Session);
      agentEvent!();
      await until(() => events.includes("restore.running"), { what: "running intent after herdr recovers" });
      expect(existsSync(path)).toBe(true);
      expect(readRows()).toHaveLength(1);
      expect(readRows()[0]).toMatchObject({ ...row, ...incarnation() });
      alive = false;
      sessions.get(row.agentId)!.alive = false;
      // No adapter event: the installed periodic observer must record /quit.
      await until(() => events.includes("restore.stopped"), { timeoutMs: 3_000, what: "stopped intent after outage" });
      expect(readRows()[0]!.running).toBe(false);
      expect(notices).toHaveLength(1);
      expect(events).not.toContain("restore.launch");
      expect(methods.every((m) => m === "session.snapshot" || m === "pane.process_info")).toBe(true);
    } finally {
      for (const result of interval.mock.results) if (result.type === "return") clearInterval(result.value);
      interval.mockRestore();
      server.stop(true);
      sessions.clear();
      for (const [id, s] of priorSessions) sessions.set(id, s);
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const recoveryIds = ["ag-nktLTW7CPaG6SriW", "ag-giIV9kN7thgwlFdt", "ag-bzoutreachP1n01", "ag-L8tdr9Dn02ev24jK"];
const invalidRecords = [
  { value: { ...record, agentId: "ag-bad;id" }, field: "agentId" },
  { value: { ...record, running: "true" }, field: "running" },
  { value: { ...record, cwd: 42 }, field: "cwd" },
  { value: { ...record, sessionId: "w1:p1" }, field: "sessionId" },
  { value: { ...record, attempted: { bootId: "old" } }, field: "attempted.herdrInstance" },
  { value: null, field: "record" },
];
const loadCases = [
  { name: "four existing ids restore and remain observed", invalid: undefined, corrupt: undefined },
  ...invalidRecords.map((invalid) => ({ name: `bad ${invalid.field} skips only its record`, invalid, corrupt: undefined })),
  ...["{broken", JSON.stringify({ version: 2, agents: [] }), "null", JSON.stringify({ version: 1, agents: {} })]
    .map((corrupt) => ({ name: `invalid state ${corrupt} is moved aside without disabling recording`, invalid: undefined, corrupt })),
];
for (const scenario of loadCases) {
  test(scenario.name, async () => {
    const dir = mkdtempSync(join(tmpdir(), "cyc-restore-load-"));
    const env = { CYC_DATA_DIR: process.env.CYC_DATA_DIR, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
    const priorSessions = new Map(sessions);
    const path = join(dir, "state", "running-agents.json");
    const badPath = `${path}.bad-123456789`;
    const rows = recoveryIds.map((agentId, i) => ({ ...record, agentId, paneId: `w1:p${i + 1}`,
      cwd: join(dir, String(i)), sessionId: `${i + 1}1111111-1111-4111-8111-111111111111` }));
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const notices: string[] = [], commands: string[] = [];
    let agentEvent: (() => void) | undefined;
    let live = true;
    process.env.CYC_DATA_DIR = dir;
    process.env.HERDR_SOCKET_PATH = join(dir, "herdr.sock");
    const server = Bun.listen({
      unix: process.env.HERDR_SOCKET_PATH,
      socket: {
        data(sock, chunk) {
          for (const line of chunk.toString().trim().split("\n")) {
            const msg = JSON.parse(line);
            const panes = live ? [...sessions.values()].map((s) => ({ pane_id: s.muxHandle, workspace_id: "w1",
              cwd: s.cwd, agent: "pi", agent_session: { value: s.harnessSessionId } })) : [];
            sock.write(JSON.stringify({ id: msg.id, result: { snapshot: { panes, agents: panes } } }) + "\n");
          }
        },
      },
    });
    const interval = spyOn(globalThis, "setInterval");
    const readRows = (): RunningAgent[] => JSON.parse(readFileSync(path, "utf8")).agents;
    try {
      sessions.clear();
      resetHookAnnounce();
      mkdirSync(join(dir, "state"));
      const text = scenario.corrupt ?? JSON.stringify({ version: 1, agents: [...rows, ...(scenario.invalid ? [scenario.invalid.value] : [])] });
      writeFileSync(path, text);
      startAutoRestore({
        now: () => 123456789,
        adapter: {
          onAgents: (cb: () => void) => { agentEvent = cb; },
          resumeCommand: (_harness: string, sid: string) => `pi --resume ${sid}`,
          async spawn(opts: { command: string; cwd: string }) {
            const r = rows.find((r) => r.cwd === opts.cwd)!;
            commands.push(opts.command);
            sessions.set(r.agentId, { agentId: r.agentId, muxHandle: r.paneId, alive: true, viaMux: true,
              cwd: r.cwd, agent: { id: "pi" }, harnessSessionId: r.sessionId } as Session);
            recordHookBind(r.paneId, r.sessionId!, 1);
            return { handle: r.paneId };
          },
        } as unknown as MultiplexerAdapter,
        log: (event, fields) => { events.push({ event, fields }); },
        notify: async (body) => { notices.push(body); },
      });
      // A bad record/file must still reach startup completion, not restore.disabled.
      await until(() => events.some(({ event }) => event === "restore.summary" || event === "restore.disabled"), { what: "recovery completion" });
      expect(events.map(({ event }) => event)).not.toContain("restore.disabled");
      expect(agentEvent).toBeDefined();
      if (scenario.corrupt !== undefined) {
        expect(events.map(({ event }) => event)).toContain("restore.state.invalid");
        expect(readFileSync(badPath, "utf8")).toBe(text);
        expect(existsSync(path)).toBe(false);
        expect(notices).toHaveLength(1);
        expect(commands).toHaveLength(0);
        const r = rows[2]!;
        sessions.set(r.agentId, { agentId: r.agentId, muxHandle: r.paneId, alive: true, viaMux: true,
          cwd: r.cwd, agent: { id: "pi" }, harnessSessionId: r.sessionId } as Session);
        await until(() => {
          if (existsSync(path)) return true;
          agentEvent!();
          return false;
        }, { what: "recording after invalid state" });
        expect(readRows()).toEqual([{ ...r, ...incarnation() }]);
      } else {
        expect(commands).toEqual(rows.map((r) => `env CYC_AGENT_ID=${r.agentId} pi --resume ${r.sessionId}`));
        expect(readRows().map((r) => r.agentId)).toEqual(recoveryIds);
        expect(events.filter(({ event }) => event === "restore.detected")).toHaveLength(4);
        const invalid = events.filter(({ event }) => event === "restore.record.invalid");
        if (scenario.invalid) {
          expect(invalid).toHaveLength(1);
          expect(invalid[0]!.fields.field).toBe(scenario.invalid.field);
          if (scenario.invalid.value) expect(invalid[0]!.fields.agentId).toBe(scenario.invalid.value.agentId);
        } else expect(invalid).toHaveLength(0);
        expect(existsSync(badPath)).toBe(false);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("Restored 4 agents.");
        // Subsequent observations must still record deliberate stops for all ids.
        live = false;
        for (const s of sessions.values()) s.alive = false;
        await until(() => {
          if (readRows().every((r) => !r.running)) return true;
          agentEvent!();
          return false;
        }, { what: "stops for all restored ids" });
        expect(events.filter(({ event }) => event === "restore.stopped")).toHaveLength(4);
      }
    } finally {
      for (const result of interval.mock.results) if (result.type === "return") clearInterval(result.value);
      interval.mockRestore();
      server.stop(true);
      sessions.clear();
      for (const [id, s] of priorSessions) sessions.set(id, s);
      resetHookAnnounce();
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
