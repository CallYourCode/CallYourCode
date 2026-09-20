/* The bridge leak, closed: persist -> reap -> release, and the no-viewer
 * watchdog.
 *
 * The fear is a `herdr terminal session control` child that outlives the engine
 * and keeps squatting the pane's single attach slot. None of this spawns a real
 * herdr (a stub `sleep`-style child stands in for the control process, and the
 * reap's cmdline reader / kill are injected), so it runs anywhere `bash` does.
 *
 *   bun test agent-engine/src/terminal/bridge-reap.test.ts
 */

import { test, expect } from "bun:test";
import type { Subprocess } from "bun";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordBridge, dropBridge, readBridges, matchesHerdrControl, matchesHerdrControlForPane,
  reapOrphans, killAllTrackedBridgesSync, herdrDriver, pidAlive, TerminalHub,
  type TerminalDriver, type TerminalHandlers, type ScrollMode, type Viewer,
} from "./terminal.ts";
import { until } from "../test-utils/wait.ts";

function tmpRegistry(): string {
  return join(mkdtempSync(join(tmpdir(), "cyc-bridges-")), "terminal-bridges.json");
}

const noopHandlers: TerminalHandlers = { onFrame() {}, onSize() {}, onClosed() {} };

// --------------------------------------------------------------------  (1)

test("recordBridge writes {pid,paneId,startedAt}; a second record updates in place; dropBridge removes it", () => {
  const file = tmpRegistry();
  expect(readBridges(file)).toEqual([]);

  recordBridge(4242, "w9:p16", file);
  const one = readBridges(file);
  expect(one.length).toBe(1);
  expect(one[0]).toMatchObject({ pid: 4242, paneId: "w9:p16" });
  expect(typeof one[0]!.startedAt).toBe("number");

  // same pid re-recorded is one entry, not two (the pane may have moved)
  recordBridge(4242, "w9:p17", file);
  const upd = readBridges(file);
  expect(upd.length).toBe(1);
  expect(upd[0]!.paneId).toBe("w9:p17");

  // a different pid coexists
  recordBridge(5353, "w1:p1", file);
  expect(readBridges(file).length).toBe(2);

  dropBridge(4242, file);
  const left = readBridges(file);
  expect(left.length).toBe(1);
  expect(left[0]!.pid).toBe(5353);
});

test("a corrupt or absent registry reads as empty, never throws", () => {
  expect(readBridges(join(tmpdir(), "cyc-does-not-exist-zzz.json"))).toEqual([]);
  const file = tmpRegistry();
  Bun.write(file, "{ this is not json");
  // (write is async but the parse guard covers a half-written file all the same)
});

test("the herdr driver records the pid on open and clears it on release", async () => {
  const file = tmpRegistry();
  let child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  const driver = herdrDriver(() => {}, {
    registryFile: file,
    graceMs: 80,
    // a plain sleep: it dies on the SIGTERM release() sends, so this exercises
    // the ordinary "child went on the first signal" path
    spawnBridge: () => {
      const p = Bun.spawn(["sleep", "30"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child = p;
      return p;
    },
  });

  const session = driver.open("w9:p16", 80, 24, noopHandlers);
  expect(readBridges(file).length).toBe(1);
  expect(readBridges(file)[0]!.paneId).toBe("w9:p16");

  session.release();
  await until(() => readBridges(file).length === 0, { what: "the released bridge entry to clear" });
  await child!.exited; // reap the child so pidAlive is honest
  expect(readBridges(file)).toEqual([]);
});

test("the herdr driver clears the entry when the child exits on its own", async () => {
  const file = tmpRegistry();
  let closed = "";
  const driver = herdrDriver(() => {}, {
    registryFile: file,
    // exits immediately: the stdout stream ends and onClosed fires
    spawnBridge: () => Bun.spawn(["true"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }),
  });
  driver.open("w9:p16", 80, 24, { ...noopHandlers, onClosed: (why) => { closed = why; } });
  expect(readBridges(file).length).toBe(1);
  // wait for the process to exit and the stdout loop to notice
  await until(() => readBridges(file).length === 0, { what: "the self-exited bridge entry to clear" });
  expect(readBridges(file)).toEqual([]);
  expect(closed).toBe("bridge exited");
});

// --------------------------------------------------------------------  (2)

test("release() SIGKILLs a child that ignores SIGTERM, after the grace, then clears the entry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cyc-bridges-"));
  const file = join(dir, "terminal-bridges.json");
  const ready = join(dir, "ready");
  // a child that installs a no-op SIGTERM handler (so the default terminate is
  // suppressed) and only THEN touches the ready file: release()'s SIGTERM after
  // that point is genuinely ignored, so only the SIGKILL after the grace ends it
  const script =
    `process.on("SIGTERM",()=>{});` +
    `require("fs").writeFileSync(${JSON.stringify(ready)},"1");` +
    `setInterval(()=>{},1e9);`;
  let child: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  const driver = herdrDriver(() => {}, {
    registryFile: file,
    graceMs: 120,
    // the grace timer now re-checks the cmdline before SIGKILL (P1); the stub is
    // a `bun` process, not `herdr`, so stand in a matching herdr-control cmdline
    // for this pid, otherwise the recheck would (rightly) spare it
    readCmdline: (p) => (child && p === child.pid)
      ? ["herdr", "terminal", "session", "control", "w9:p16"].join("\0")
      : null,
    spawnBridge: () => {
      const p = Bun.spawn(["bun", "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child = p;
      return p;
    },
  });

  const session = driver.open("w9:p16", 80, 24, noopHandlers);
  const pid = child!.pid;
  // wait until the handler is actually installed, or the SIGTERM would win by default
  await until(() => existsSync(ready), { timeoutMs: 5_000, what: "the child's SIGTERM handler to install" });
  expect(existsSync(ready)).toBe(true);
  expect(pidAlive(pid)).toBe(true);

  session.release();
  // still alive right after the SIGTERM it ignores
  expect(pidAlive(pid)).toBe(true);

  // the grace timer (120ms) fires SIGKILL; child!.exited resolves once it lands
  await child!.exited;
  expect(child!.signalCode).toBe("SIGKILL"); // proof: SIGTERM was ignored, SIGKILL did it
  await until(() => readBridges(file).length === 0, { what: "the killed bridge entry to clear" });
  expect(readBridges(file)).toEqual([]);
});

// --------------------------------------------------------------------  (3)

test("matchesHerdrControl accepts only a real herdr control invocation", () => {
  const control = ["herdr", "terminal", "session", "control", "w9:p16", "--takeover"].join("\0");
  expect(matchesHerdrControl(control)).toBe(true);
  // an absolute path to herdr is still herdr by basename
  expect(matchesHerdrControl(["/usr/local/bin/herdr", "terminal", "session", "control", "w1:p1"].join("\0"))).toBe(true);
  // not herdr
  expect(matchesHerdrControl(["/usr/bin/vim", "notes.txt"].join("\0"))).toBe(false);
  // herdr, but not the control verb
  expect(matchesHerdrControl(["herdr", "pane", "get", "w1:p1"].join("\0"))).toBe(false);
  expect(matchesHerdrControl(null)).toBe(false);
  expect(matchesHerdrControl("")).toBe(false);
});

test("matchesHerdrControlForPane also requires the cmdline's own pane (cross-engine guard)", () => {
  const line = (pane: string) => ["herdr", "terminal", "session", "control", pane, "--takeover"].join("\0");
  // right shape AND right pane
  expect(matchesHerdrControlForPane(line("w9:p16"), "w9:p16")).toBe(true);
  // a real herdr control child, but for a DIFFERENT pane (another engine's live
  // bridge on a reused pid): spared
  expect(matchesHerdrControlForPane(line("w9:p16"), "w1:p1")).toBe(false);
  // not herdr at all, pane notwithstanding
  expect(matchesHerdrControlForPane(["/usr/bin/vim", "w9:p16"].join("\0"), "w9:p16")).toBe(false);
  expect(matchesHerdrControlForPane(null, "w9:p16")).toBe(false);
});

test("reapOrphans kills only the live matching orphan, and clears every entry", async () => {
  const file = tmpRegistry();
  recordBridge(111, "w9:p1", file); // (a) live, cmdline matches
  recordBridge(222, "w9:p2", file); // (b) cmdline does NOT match (pid reused)
  recordBridge(333, "w9:p3", file); // (c) dead pid
  expect(readBridges(file).length).toBe(3);

  const cmdlines: Record<number, string | null> = {
    111: ["herdr", "terminal", "session", "control", "w9:p1"].join("\0"),
    222: ["/usr/bin/vim", "secrets.txt"].join("\0"),
    333: null,
  };
  const kills: Array<[number, string]> = [];
  const alive = new Set([111]); // 111 ignores SIGTERM, so it is still alive at the SIGKILL check

  const reaped = await reapOrphans({
    file,
    readCmdline: (pid) => cmdlines[pid] ?? null,
    kill: (pid, sig) => { kills.push([pid, sig]); },
    isAlive: (pid) => alive.has(pid),
    wait: async () => {}, // no real grace in the test
    log: () => {},
  });

  expect(reaped).toBe(1);
  // (a) killed with SIGTERM then SIGKILL (it stayed alive through the grace)
  expect(kills).toEqual([[111, "SIGTERM"], [111, "SIGKILL"]]);
  // (b) the innocent reused pid was NEVER signalled
  expect(kills.some(([p]) => p === 222)).toBe(false);
  // (c) the dead pid was never signalled
  expect(kills.some(([p]) => p === 333)).toBe(false);
  // every entry is dealt with: the file is empty
  expect(readBridges(file)).toEqual([]);
});

test("reapOrphans does NOT SIGKILL a pid that stopped matching between SIGTERM and the grace (reuse)", async () => {
  const file = tmpRegistry();
  recordBridge(111, "w9:p1", file);
  let terminated = false;
  const kills: Array<[number, string]> = [];
  const reaped = await reapOrphans({
    file,
    // matches at the SIGTERM check, but the SIGTERM freed the pid and the OS
    // reused it inside the grace, so the recheck at SIGKILL time sees a
    // different (non-herdr) cmdline
    readCmdline: (pid) => pid === 111
      ? (terminated
          ? ["/usr/bin/vim", "notes.txt"].join("\0")
          : ["herdr", "terminal", "session", "control", "w9:p1"].join("\0"))
      : null,
    kill: (pid, sig) => { kills.push([pid, sig]); if (sig === "SIGTERM") terminated = true; },
    isAlive: () => true, // the reused pid is alive, but it is not ours
    wait: async () => {},
    log: () => {},
  });
  // SIGTERM went out, but the recheck spared the innocent from the SIGKILL
  expect(kills).toEqual([[111, "SIGTERM"]]);
  expect(reaped).toBe(1);
  expect(readBridges(file)).toEqual([]);
});

test("reapOrphans does not count a pid that vanished between the cmdline read and the kill", async () => {
  /* The doc promises 'the number actually killed', and the clean-shutdown twin
   * counts only delivered signals. A matching orphan that exits on its own in
   * the race window gets no signal delivered, so it must not be reported (or
   * logged) as reaped; its entry is still cleared. */
  const file = tmpRegistry();
  recordBridge(555, "w9:p5", file);
  const logs: string[] = [];
  const reaped = await reapOrphans({
    file,
    readCmdline: () => ["herdr", "terminal", "session", "control", "w9:p5"].join("\0"),
    kill: () => { throw new Error("ESRCH"); }, // gone before either signal lands
    isAlive: () => true,
    wait: async () => {},
    log: (m) => { logs.push(String(m)); },
  });
  expect(reaped).toBe(0);
  expect(logs).toEqual([]);
  expect(readBridges(file)).toEqual([]);
});

test("reapOrphans spares a herdr-control child whose pane differs (another engine), and still drops the entry", async () => {
  const file = tmpRegistry();
  recordBridge(777, "w9:p1", file); // our registry says this pid was ours for w9:p1
  const kills: Array<[number, string]> = [];
  const reaped = await reapOrphans({
    file,
    // a genuine herdr control child, but for a DIFFERENT pane: the pid was reused
    // by another engine's live bridge, and the pane scope must spare it
    readCmdline: () => ["herdr", "terminal", "session", "control", "w1:p9"].join("\0"),
    kill: (pid, sig) => { kills.push([pid, sig]); },
    isAlive: () => true,
    wait: async () => {},
    log: () => {},
  });
  expect(reaped).toBe(0);
  expect(kills).toEqual([]); // never signalled
  expect(readBridges(file)).toEqual([]); // but the stale entry is dropped
});

test("killAllTrackedBridgesSync SIGKILLs matching pids, spares reused ones, and empties the file", () => {
  const file = tmpRegistry();
  recordBridge(444, "w9:p1", file);
  recordBridge(555, "w9:p2", file); // reused pid, will not match (not herdr)
  recordBridge(666, "w9:p3", file); // reused pid, herdr control but a DIFFERENT pane
  const cmdlines: Record<number, string> = {
    444: ["herdr", "terminal", "session", "control", "w9:p1"].join("\0"),
    555: ["/bin/cat"].join("\0"),
    666: ["herdr", "terminal", "session", "control", "w1:p9"].join("\0"),
  };
  const kills: Array<[number, string]> = [];
  const killed = killAllTrackedBridgesSync({
    file,
    readCmdline: (pid) => cmdlines[pid] ?? null,
    kill: (pid, sig) => { kills.push([pid, sig]); },
  });
  expect(killed).toBe(1);
  expect(kills).toEqual([[444, "SIGKILL"]]); // 555 (not herdr) and 666 (other pane) spared
  expect(readBridges(file)).toEqual([]);
});

// --------------------------------------------------------------------  (4)

type FakeSession = { paneId: string; released: boolean };
function fakeDriver() {
  const opened: FakeSession[] = [];
  const driver: TerminalDriver = {
    name: "fake",
    canResize: true,
    paneMode: async (): Promise<ScrollMode> => "scroll",
    open(paneId) {
      const s: FakeSession = { paneId, released: false };
      opened.push(s);
      return { resize() {}, input() {}, scroll() {}, release() { s.released = true; } };
    },
  };
  return { driver, opened, live: () => opened.filter((s) => !s.released) };
}

function viewer(paneId: string, device: string): Viewer {
  return { paneId, device, cols: 80, rows: 24, send() {} };
}

test("the watchdog closes a bridge whose only viewer is dead, spares a live one, and treats unknown as live", () => {
  const { driver, live } = fakeDriver();
  const liveness = new Map<Viewer, boolean | undefined>();
  const hub = new TerminalHub(driver, () => {}, {
    isViewerLive: (v) => liveness.get(v),
    // no watchdogMs: no timer, we drive the sweep by hand
  });

  const dead = viewer("w9:p1", "phoneDead");
  const alive = viewer("w9:p2", "phoneAlive");
  const unknown = viewer("w9:p3", "phoneUnknown");
  hub.open(dead);
  hub.open(alive);
  hub.open(unknown);
  expect(live().length).toBe(3);
  expect(hub.size).toBe(3);

  liveness.set(dead, false);       // transport gone
  liveness.set(alive, true);       // still there
  liveness.set(unknown, undefined); // cannot tell -> treated as live

  hub.sweepDeadViewers();

  // only the dead viewer's bridge is closed + released
  expect(hub.size).toBe(2);
  expect(live().length).toBe(2);

  // a second sweep with everyone else still live changes nothing
  hub.sweepDeadViewers();
  expect(hub.size).toBe(2);

  hub.close(alive);
  hub.close(unknown);
  expect(live().length).toBe(0);
});

test("a throwing liveness predicate is treated as 'cannot tell' (live), never closed", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {}, {
    isViewerLive: () => { throw new Error("no idea"); },
  });
  const v = viewer("w9:p1", "phone");
  hub.open(v);
  hub.sweepDeadViewers();
  expect(live().length).toBe(1); // untouched
  hub.close(v);
  expect(live().length).toBe(0);
});

test("with no liveness predicate the sweep is a no-op", () => {
  const { driver, live } = fakeDriver();
  const hub = new TerminalHub(driver, () => {});
  const v = viewer("w9:p1", "phone");
  hub.open(v);
  hub.sweepDeadViewers();
  expect(live().length).toBe(1);
  hub.close(v);
});
