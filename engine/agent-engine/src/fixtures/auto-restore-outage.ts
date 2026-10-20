import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MultiplexerAdapter } from "../adapters/mux-adapter.ts";
import { until } from "../test-utils/wait.ts";
import { sessions, type Session } from "../sessions/session-state.ts";
import { incarnation, startAutoRestore, type RunningAgent } from "../sessions/auto-restore.ts";

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
    // Expire the real 30-second startup deadline after one failed RPC. Only
    // wall-clock reads are advanced; snapshot/process checks still use I/O.
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValueOnce(now + 31_000);
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
        adapter: { onAgents: (cb: () => void) => { agentEvent = cb; } } as unknown as MultiplexerAdapter,
        log: (event) => { events.push(event); },
        notify: async (body) => { notices.push(body); unavailable(); },
      });
      // Await the unavailable notification without consulting the fake clock.
      await startupFinished;
      clock.mockRestore();
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
      clock.mockRestore();
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
