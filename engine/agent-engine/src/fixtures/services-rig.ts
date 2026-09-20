/* THE RIG THE SERVICES SPECS SHARE: toys on free ports, lease and log
 * directories of their own, and one cleanup that leaves nothing running.
 *
 * WHY IT IS A MODULE AND NOT COPIED INTO BOTH FILES. services.test.ts covers
 * one service being supervised (start, adopt, restart on the ceiling, the lease
 * gate, takeover); services-unit.test.ts covers the voice UNIT's all-or-none
 * rule across three or four members. They were one file until it measured 7.8
 * seconds against an 8 second budget, and the suite's rule is to split a file
 * rather than to sit on its cap. What they share is not assertions, it is the
 * rig: two copies of it would drift, and the half that drifted would be the
 * half that stops cleaning up.
 *
 * It lives beside toy-service.ts rather than in test-utils/ because it is
 * specific to this one subject, and because a fixture is not a test file: the
 * gates read *.test.ts.
 *
 * NOTHING HERE TOUCHES HIS SERVICES. Every port is one the OS handed out and
 * gave back, every lease directory is a fresh tmp one, and the afterEach kills
 * whatever is left listening on the ports the spec asked for. A supervised
 * child OUTLIVES its Services on purpose (services.ts's header explains why: an
 * engine restart may not take speech away for ten seconds), so a spec that did
 * not clean up would leave one running and the next spec on a recycled port
 * would find a service it never started.
 */

import { afterEach } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Subprocess } from "bun";
import {
  Services, listeningPid, portOpen, type ServiceSpec, type ServicesOpts,
} from "../runtime/services.ts";
import { tmpDir } from "../test-utils/tmp.ts";
import { until } from "../test-utils/wait.ts";

export const TOY = join(import.meta.dir, "toy-service.ts");
/** The directory a toy is spawned from. Anywhere real will do; it is the
 *  `cwd` a spawn spec has to carry. */
const CWD = import.meta.dir;

let running: Services[] = [];
let toys: Subprocess[] = [];
let ports: number[] = [];

/* CALLED BY EACH TEST FILE, rather than registered when this module loads.
 *
 * A plain top-level `afterEach` here would be registered ONCE, against whichever
 * file happened to import this module first. Under `bun test --parallel` that is
 * invisible (a worker per file, a fresh module registry each), but a plain
 * `bun test services.test.ts services-unit.test.ts` runs both in one process off
 * one registry -- and the second file would then have no cleanup at all, leaving
 * toy services running after the run finished with nothing saying so. Each file
 * asks for its own hook; the arrays are shared and that is harmless, because two
 * files' tests never overlap. */
export function useServicesRig(): void {
  afterEach(async () => {
    for (const s of running) s.stop();
    running = [];
    for (const p of toys) { try { p.kill("SIGKILL"); } catch { /* gone */ } }
    await Promise.all(toys.map((p) => p.exited.catch(() => null)));
    toys = [];
    for (const port of ports) {
      /* The pid is asked for ONLY when the port answers. `listeningPid` is an
       * `lsof` subprocess and costs about 40ms; `portOpen` is a loopback connect
       * and costs nothing, and most ports are already free by here. */
      if (!(await portOpen(port))) continue;
      const pid = await listeningPid(port);
      if (pid !== null) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
    ports = [];
  });
}

/** Have this rig kill that process when the spec ends. */
export function track(proc: Subprocess): Subprocess {
  toys.push(proc);
  return proc;
}

/** A port the OS handed out and then gave back. Never a guessed number: two
 *  files running in parallel workers landing on the same one is expected rather
 *  than rare, and the second would then supervise the first's toy. */
export async function freePort(): Promise<number> {
  const s = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = s.port;
  s.stop(true);
  return port;
}

/** A free port, registered so nothing is left listening on it. */
export async function toyPort(): Promise<number> {
  const port = await freePort();
  ports.push(port);
  return port;
}

/** A starts file: the toy appends its pid to it BEFORE binding, so a spec can
 *  count starts from OUTSIDE every supervisor. Each Services counts only what
 *  IT did, so two of them each doing one would look right from either side. */
export async function startsFile(): Promise<string> {
  const f = join(await tmpDir("cyc-starts-"), "starts");
  await writeFile(f, "");
  return f;
}

export async function startsIn(file: string): Promise<number> {
  const text = await Bun.file(file).text().catch(() => "");
  return text.trim().split("\n").filter(Boolean).length;
}

export function toySpec(port: number, starts: string, over: Partial<ServiceSpec> = {},
  delayMs = 0): ServiceSpec {
  return {
    key: "toy", name: "toy service", port, ceilingMb: 6000,
    revive: { how: "spawn", cwd: CWD, cmd: ["bun", "run", TOY, String(port), starts, String(delayMs)] },
    ...over,
  };
}

/** A spawn command for a toy on this port, for a spec building its own spec. */
export const toyCmd = (port: number, starts: string, delayMs = 0) =>
  ["bun", "run", TOY, String(port), starts, String(delayMs)];

export const toyCwd = CWD;

/* A footprint the SPEC decides, standing in for the macOS-only reader.
 *
 * The real one pulls proc_pid_rusage out of libSystem, so off a Mac it answers
 * null for every process and the ceiling branch is unreachable: three specs in
 * this suite believed they were proving the ceiling and were really watching
 * python3 fail (measured on linux -- "its footprint could not be measured"
 * every time, and the restart they waited 20s for never came). A number from
 * here reaches exactly the same decision code, and it also means "over the
 * ceiling" costs nothing instead of needing a real leak. */
export const reads = (mb: number | null) => async () => mb;

/** A Services wired to this spec's own directories and stopped afterwards. */
export async function services(specs: ServiceSpec[], opts: ServicesOpts = {}): Promise<Services> {
  const root = await tmpDir("cyc-services-");
  const s = new Services(specs, {
    leaseDir: join(root, "lease"),
    logDir: join(root, "logs"),
    // a restart the spec can watch happen rather than wait out
    restartBaseMs: 1, restartMaxMs: 10,
    ...opts,
  });
  running.push(s);
  return s;
}

/** A lease directory nothing else can reach. Made by HostLease on first use. */
export async function ownLeaseDir(): Promise<string> {
  return join(await tmpDir("cyc-lease-"), "lease");
}

export const row = (s: Services, key: string) => s.health().find((r) => r.key === key)!;
export const unitOf = (s: Services, name: string) => s.units().find((u) => u.name === name)!;

/** Start the spec's OWN toy on a port and wait for it to bind. This is what an
 *  adopted service is: a process the engine did not start. */
export async function bindToy(port: number, starts: string, delayMs = 0): Promise<Subprocess> {
  const proc = Bun.spawn(toyCmd(port, starts, delayMs),
    { cwd: CWD, stdout: "ignore", stderr: "ignore" });
  toys.push(proc);
  await untilPort(port, true);
  return proc;
}

/** Wait for a port to become bound or free. Real I/O, so it is polled: a child
 *  binding a socket is not on any logical clock.
 *
 *  ASKED BY CONNECTING, not by listing processes. `until` polls every 5ms, and
 *  `listeningPid` is an `lsof` subprocess at about 40ms a call (measured), so
 *  polling it turned every wait for a port into a stack of subprocesses and put
 *  the services file three times over its budget. `portOpen` is a loopback
 *  connect and is the truer question anyway: what a spec wants to know here is
 *  whether the port answers, and the pid is a bonus only the owning user gets. */
export async function untilPort(port: number, bound: boolean, timeoutMs = 10_000): Promise<void> {
  await until(async () => (await portOpen(port)) === bound,
    { timeoutMs, what: `:${port} to become ${bound ? "bound" : "free"}` });
}

/** The pid on a port after it has come back on a DIFFERENT process: down, then
 *  up, then one lsof. Polling for "a pid that is not the old one" asked lsof
 *  every 5ms for the whole of a restart; the port going quiet and answering
 *  again is the same event, seen with connects. */
export async function restartedPid(port: number, was: number): Promise<number> {
  await untilPort(port, false);
  await untilPort(port, true);
  const pid = await listeningPid(port);
  if (pid === null || pid === was) {
    throw new Error(`:${port} came back as ${pid}, which is not a new process`);
  }
  return pid;
}

/** A lease planted for a pid: `planted(dir, key, await deadPid())` is a holder
 *  killed outright, with no release and no shutdown hook, which is what a crash
 *  and `launchctl kickstart -k` both look like from the other engine's side. */
export async function planted(leaseDir: string, key: string, pid: number): Promise<void> {
  await Bun.write(`${leaseDir}/supervisor.${key}.lease`,
    JSON.stringify({ pid, at: Date.now(), who: "the engine that was here before" }));
}

export async function deadPid(): Promise<number> {
  const p = Bun.spawn(["true"]);
  const pid = p.pid;
  await p.exited;
  return pid;
}

/** A lease held by THIS process, planted before a Services is built.
 *
 *  The two-supervisor specs prove that exactly one engine acts; the watcher
 *  specs prove what the OTHER one does, and the only way to hold an engine in
 *  that role for a whole spec is to be its rival. The test runner is a live pid
 *  the engine cannot kill and cannot mistake for dead, which is what the `work`
 *  account's engine looks like from his: alive, unjudgeable, not going
 *  anywhere. */
export async function leaseHeldByThisProcess(key = "toy"): Promise<string> {
  const dir = await ownLeaseDir();
  await planted(dir, key, process.pid);
  return dir;
}

/* THE STALE WINDOW IS LONG IN THE WATCHER SPECS, and that is the point of them
 * rather than a detail. The planted lease is never renewed, so with a short
 * window an engine would take it over on the timeout alone and the spec would
 * be about a supervisor after all. A minute means nothing but the lease can
 * explain what these engines do and do not do. */
export const PATIENT = { leaseStaleMs: 60_000 };
