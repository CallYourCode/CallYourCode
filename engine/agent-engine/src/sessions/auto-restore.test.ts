import { expect, test } from "bun:test";
import { restoreDecision, shellProcess, type RunningAgent } from "./auto-restore.ts";

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
