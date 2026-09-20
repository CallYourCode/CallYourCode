/* THE GATES: the rules of this suite, as a test, in the default run.
 *
 * Every rule here is a rule the suite had already broken once. A convention
 * that lives in a README is a convention the next file drifts away from; these
 * are greps over the git-tracked files, so breaking one fails the build in the
 * same second it is written rather than being discovered when a full sweep
 * OOMs a 32GB box.
 *
 *   1. Only e2e/ boots an engine. 64 files used to, ~350 startEngine() call
 *      sites, one `bun run server.ts` subprocess each.
 *   2. Nothing sleeps for real outside e2e/. lock.test.ts held a sixteen second
 *      wall-clock sleep; notify.test.ts held seventy-two.
 *   3. No fixed ports. A full sweep started thirty engines, and two of them
 *      landing on the same guessed number is expected rather than rare: the
 *      second test then talks to the first test's engine and times out
 *      somewhere far away.
 *   4. The default `test` script's globs cover every tracked test file outside
 *      e2e/, so a new subdirectory cannot quietly drop out of the default run.
 *   5. Nothing is left on the LEGACY list, and no @startsEngine annotation
 *      survives.
 *
 * THE LEGACY LIST IS THE REWRITE'S OWN PROGRESS BAR. Rules 1-3 apply to every
 * tracked test file EXCEPT the ones named below, which are the old suite's
 * files still awaiting their phase. Entries leave the list in the same commit
 * that re-homes their coverage and never come back; a stale entry (a file on
 * the list that no longer exists) fails too, so the list cannot rot. When it is
 * empty the gates apply to everything, which is the end state.
 */

import { test, expect } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_ROOT = join(ROOT, "..");

/* Old-suite files not yet rewritten. Shrinks every phase; MUST reach zero.
 * Do not add to it. */
/* EMPTY, WHICH IS THE END STATE. Every file the old suite had is either
 * rewritten under the rules below, or deleted in the commit that re-homed its
 * coverage. Gate 5 asserts it stays empty; do not add to it. */
const LEGACY: string[] = [];

const legacy = new Set(LEGACY);

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

/** Every git-tracked file in agent-engine/src/, paths relative to it. */
async function tracked(): Promise<string[]> {
  const out = await sh(["git", "ls-files"]);
  return out.split("\n").map((l) => l.trim().replace(/^src\//, "")).filter(Boolean);
}

const isTest = (p: string) => p.endsWith(".test.ts");
const inE2E = (p: string) => p.startsWith("e2e/");

async function read(rel: string): Promise<string> {
  return await Bun.file(join(ROOT, rel)).text().catch(() => "");
}

async function readPackage(rel: string): Promise<string> {
  return await Bun.file(join(PACKAGE_ROOT, rel)).text().catch(() => "");
}

/* The two files whose SUBJECT is the forbidden strings themselves. This file
 * spells `startEngine(`, `Bun.sleep(` and all seven of his ports in order to
 * look for them, and guardrails.test.ts names every port to prove the guard
 * refuses it. Neither uses one; a grep cannot tell the difference, so they are
 * named here rather than the patterns being made cleverer and weaker. */
const EXEMPT = new Set(["runtime/gates.test.ts", "test-utils/guardrails.test.ts"]);

/* THE GATES READ CODE, NOT PROSE.
 *
 * These files are unusually well commented, and a good comment says the thing
 * it is about: wire-core.test.ts opens with "wireCore() is the seam tier's
 * replacement for startEngine()", which is exactly the sentence a reader needs
 * and exactly the sentence a naive grep fails on. Punishing a file for
 * explaining itself teaches people to stop explaining.
 *
 * So comments come out before the scan. `//` is left alone when a colon
 * precedes it, so a url in a string survives; nothing here depends on that
 * being a full parse, only on it never HIDING a real call, and stripping a
 * comment cannot hide code. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every tracked test file the gates apply to: outside e2e/, off the list. */
async function suiteFiles(): Promise<Array<{ path: string; text: string }>> {
  const paths = (await tracked())
    .filter((p) => isTest(p) && !inE2E(p) && !legacy.has(p) && !EXEMPT.has(p));
  return await Promise.all(paths.map(async (p) => ({ path: p, text: stripComments(await read(p)) })));
}

test("the legacy list has no stale entries", async () => {
  const files = new Set(await tracked());
  expect(LEGACY.filter((p) => !files.has(p))).toEqual([]);
});

test("gate 1: only e2e/ boots an engine", async () => {
  const offenders: string[] = [];
  for (const { path, text } of await suiteFiles()) {
    if (/\bstartEngine\s*\(/.test(text)) offenders.push(`${path}: calls startEngine()`);
    if (/from\s+["'][^"']*e2e\/harness/.test(text)) offenders.push(`${path}: imports e2e/harness`);
    if (/from\s+["'][^"']*e2e\/testclient/.test(text)) offenders.push(`${path}: imports e2e/testclient`);
    if (/from\s+["'][^"']*notify-harness/.test(text)) offenders.push(`${path}: imports notify-harness`);
  }
  expect(offenders).toEqual([]);
});

test("gate 1b: no engine SOURCE file imports the boot harness", async () => {
  const offenders: string[] = [];
  for (const p of await tracked()) {
    if (!p.endsWith(".ts") || inE2E(p) || isTest(p)) continue;
    if (/from\s+["'][^"']*e2e\/(harness|testclient|testpreload)/.test(await read(p))) offenders.push(p);
  }
  expect(offenders).toEqual([]);
});

/** A quarter of a second. Past this, a timer in a test file is a sleep. */
const REAL_SLEEP_MS = 250;

/* THE DELAY IS OFTEN A NAME, NOT A NUMBER, and this gate used to read only
 * numbers -- so `const GRACE = 30_000; setTimeout(fn, GRACE)` walked straight
 * past it, which is the shape a careful author is MORE likely to write. Every
 * `const NAME = <number>` the file declares is resolved first, including the
 * `A * B` form that every duration in this repo is written in (`60 * 60_000`).
 *
 * What is deliberately NOT resolved is a constant IMPORTED from somewhere else:
 * following imports is a different program from a grep. An identifier this file
 * does not define is reported as unreadable rather than waved through -- there
 * are none today, and the fix is one line (name the number where the timer is,
 * or use the manual clock), which is cheaper than the hole. */
function constantsOf(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(\d[\d_]*)\s*(?:\*\s*(\d[\d_]*))?\s*[;,\n)]/g)) {
    const a = Number(m[2].replace(/_/g, ""));
    const b = m[3] ? Number(m[3].replace(/_/g, "")) : 1;
    out.set(m[1], a * b);
  }
  return out;
}

test("gate 2: nothing outside e2e/ sleeps for real", async () => {
  const offenders: string[] = [];
  for (const { path, text } of await suiteFiles()) {
    if (/Bun\.sleep\s*\(/.test(text)) offenders.push(`${path}: Bun.sleep(`);
    const consts = constantsOf(text);
    /* setINTERVAL as well as setTimeout, and it was missed entirely. An
     * interval is a timer that fires FOREVER: it outlives the test that set it
     * unless something clears it, and one at a real-world cadence is a sleep
     * that repeats. There is no reason for a unit or seam test to want either.
     *
     * `(?<![.\w])` keeps this to the GLOBAL timers. `clock.setInterval(fn,
     * 1_000)` is the manual clock -- logical time, which is the whole thing
     * this gate exists to push people towards -- and flagging it would punish
     * exactly the pattern being asked for. */
    for (const m of text.matchAll(
      /(?<![.\w])set(Timeout|Interval)\s*\(([\s\S]{0,200}?),\s*([A-Za-z_$][\w$]*|\d[\d_]*)\s*\)/g)) {
      const call = `set${m[1]}`;
      const body = m[2];
      const arg = m[3];
      /* A DEADLINE GUARD IS NOT A SLEEP, and telling them apart is the whole
       * difference between a rule people follow and a rule people work around.
       *
       *   Promise.race([theThing, new Promise((_, rej) =>
       *     setTimeout(() => rej(new Error("never happened")), 8_000))])
       *
       * costs NOTHING on the happy path: the thing resolves in milliseconds and
       * the timer is never reached. Its whole job is to turn a hang into a
       * sentence, which is the same thing until() does for a polled condition
       * and is exactly what this suite wants people writing. A timer whose
       * callback only ever REJECTS or THROWS is that shape, and a timer that
       * does anything else with the wall clock is the shape being banned. */
      if (/\b(rej|reject)\s*\(|\bthrow\b/.test(body)) continue;
      const ms = /^\d/.test(arg) ? Number(arg.replace(/_/g, "")) : consts.get(arg);
      if (ms === undefined) {
        offenders.push(`${path}: ${call}(..., ${arg}) -- this gate cannot tell how long ${arg} ` +
          "is. Name the number in this file, or take the timer off the wall clock.");
      } else if (ms >= REAL_SLEEP_MS) {
        offenders.push(`${path}: ${call}(..., ${arg === String(ms) ? ms : `${arg} = ${ms}`})`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

/* THE PROCESS ANNEX: the four test files allowed to start real processes, and
 * therefore the only four allowed to reach a runnable fixture.
 *
 * A fixture under fixtures/ that ends in .ts is a PROGRAM -- a contending
 * engine, a toy service, a lease claimant -- and it sleeps, holds and yields
 * exactly as the real thing does, because that is what it is standing in for.
 * That is the escape hatch, and gate 2b's job is to keep it from becoming a
 * back door: fixtures may sleep, and only these files may reach one.
 *
 * Every entry here is a file whose SUBJECT is what two operating-system
 * processes do to each other, which is a claim no in-process test can make (see
 * each file's own header). Adding a fifth is a decision about the suite's
 * runtime, not a convenience, so it is made here in the open. */
const PROCESS_ANNEX = new Set([
  "storage/lock.test.ts",           // the schedule lock, twenty engines at one file
  "storage/lease-race.test.ts",     // the limits reading lease, eight processes racing
  "runtime/services.test.ts",       // real toy services, started and capped and revived
  "runtime/services-unit.test.ts",  // the same rig, its non-racing half
  "runtime/services-model-gate.test.ts", // the presence gate, real toy services
]);

test("gate 2b: only wait.ts sleeps in test-utils, and only the annex may reach a fixture that does",
  async () => {
    const offenders: string[] = [];
    /* test-utils/ is IMPORTED into the suite's own process, so a sleep there is
     * a sleep in every file that imports it. One exception, by name. */
    for (const p of await tracked()) {
      if (!p.startsWith("test-utils/") || p === "test-utils/wait.ts") continue;
      if (/Bun\.sleep\s*\(/.test(await read(p))) offenders.push(`${p}: Bun.sleep(`);
    }
    /* fixtures/*.ts is the opposite case: it runs in a CHILD process, so its
     * sleeping costs the suite nothing that the child was not going to cost
     * anyway. What it must not do is get spawned from an ordinary test file,
     * because then an ordinary test file is a test that starts processes. */
    const runnable = (await tracked())
      .filter((p) => p.startsWith("fixtures/") && p.endsWith(".ts"))
      .map((p) => p.slice("fixtures/".length, -".ts".length));
    for (const { path, text } of await suiteFiles()) {
      if (PROCESS_ANNEX.has(path)) continue;
      for (const name of runnable) {
        if (new RegExp(`\\b${name.replace(/-/g, "\\-")}(\\.ts)?\\b`).test(text)) {
          offenders.push(`${path}: reaches the runnable fixture ${name}.ts, but is not in the ` +
            "process annex. A test that starts processes belongs in gates.test.ts's PROCESS_ANNEX, " +
            "with a line saying which two-process claim it is making.");
        }
      }
    }
    expect(offenders).toEqual([]);
  });

test("gate 2c: every file in the process annex still exists", async () => {
  /* A stale entry is a licence nobody is using and nobody can see is unused,
   * which is how the LEGACY list would have rotted if gate 5 had not watched
   * it. Same rule, same reason. */
  const files = new Set(await tracked());
  expect([...PROCESS_ANNEX].filter((p) => !files.has(p))).toEqual([]);
});

/* His real fleet's port map (guardrails.ts holds the same list for the boot
 * harness). A test that writes one of these numbers is one copy-paste away from
 * taking his speech away or reading his real engine's answers. */
const RESERVED = [10103, 10101, 10102, 7790, 10100, 10104, 10105];

test("gate 3: no fixed ports outside e2e/", async () => {
  const offenders: string[] = [];
  for (const { path, text } of await suiteFiles()) {
    for (const port of RESERVED) {
      if (new RegExp(`\\b${port}\\b`).test(text)) offenders.push(`${path}: reserved port ${port}`);
    }
    for (const m of text.matchAll(/\bport\s*:\s*(\d+)/g)) {
      if (m[1] !== "0") offenders.push(`${path}: port: ${m[1]} (only 0 is allowed)`);
    }
  }
  expect(offenders).toEqual([]);
});

/* GATE 3b: --parallel IS LOAD-BEARING, and it is not an optimisation.
 *
 * `bun test --parallel` gives every FILE a worker process with a fresh module
 * registry, and this suite's isolation story rests on that: a module that reads
 * an env var into a const AT IMPORT is per-file only because the import is
 * per-file. Drop the flag and the whole suite runs in one registry, where the
 * first file to import a module decides what every later file gets.
 *
 * MEASURED, on this tree, with the flag removed: 2154 pass, EIGHT FAIL, and
 * 54 seconds instead of 5.4.
 *
 *   voicelog.test.ts (6)   sets CYC_VOICE_LOG_RING, CYC_GPU_SYS_DIR and
 *                          CYC_LOG_DIR and then dynamically imports voicelog.ts.
 *                          Its ring cap and its fake sysfs root are read at
 *                          module load; in one registry another file has
 *                          already loaded voicelog.ts against the real ones and
 *                          the dynamic import hands back that instance.
 *   events-history.test.ts (1)  the same shape with CYC_ATTACH_EVENT_BYTES,
 *                          which attach.ts reads into a module const.
 *   health-rev.test.ts (1) shares the sessions-frame singleton with whatever
 *                          ran before it.
 *
 * None of these is a bug in the test: each does the load-order dance correctly
 * and documents it. The fix that would make them registry-independent is to
 * move three module-level env reads to per-call reads in PRODUCTION code, which
 * is a behaviour change to shipping modules and not something a test suite gets
 * to make on its own. So the flag stays, and this gate is why: the failure mode
 * without it is eight red tests that look like flakes and a tenfold slowdown.
 */
test("gate 3b: the default test script really runs in parallel", async () => {
  const pkg = JSON.parse(await readPackage("package.json")) as { scripts: Record<string, string> };
  expect(pkg.scripts.test,
    "the default suite lost --parallel. Every file would share one module registry and eight " +
    "tests that set env before a dynamic import would fail; see this gate's note and README.md.")
    .toContain("--parallel");
});

const globsOfTestScript = async (): Promise<string[]> => {
  const pkg = JSON.parse(await readPackage("package.json")) as { scripts: Record<string, string> };
  return pkg.scripts.test.split(/\s+/)
    .filter((w) => w.endsWith("*.test.ts"))
    .map((w) => w.replace(/^src\//, ""));
};

const matches = (glob: string, path: string) => {
  const rx = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
  return rx.test(path);
};

test("gate 4: the default test script's globs cover every tracked test file", async () => {
  /* The globs are read out of the script itself rather than repeated here: the
   * point of this gate is that the script and the tree agree, and a second copy
   * of the list would let them disagree in silence. */
  const globs = await globsOfTestScript();
  expect(globs.length).toBeGreaterThan(0);
  const uncovered = (await tracked())
    .filter((p) => isTest(p) && !inE2E(p))
    .filter((p) => !globs.some((g) => matches(g, p)));
  expect(uncovered).toEqual([]);
});

test("gate 4b: every glob in the default script points somewhere real", async () => {
  /* Only once the rewrite is done. Mid-rewrite the script deliberately names
   * directories whose tests have not been written yet (plugins/, routes/,
   * readers/), and a glob that matches nothing is a filter bun ignores. At the
   * end, a glob matching nothing means a directory was renamed and a set of
   * tests silently stopped running, which is the thing worth failing on. */
  if (legacy.size > 0) return;
  const globs = await globsOfTestScript();
  const files = (await tracked()).filter(isTest);
  expect(globs.filter((g) => !files.some((f) => matches(g, f)))).toEqual([]);
});

test("gate 6: at most seven files boot an engine", async () => {
  /* Low single digits, per the doctrine. The four happy-path specs, the
   * live-transport proof that must boot a real engine + real DataChannel
   * (e2e/tunnel-wire.test.ts, the sealed req/res tunnel), the resumable
   * transfer proof that cuts a real sealed pipe mid-body
   * (e2e/transfer-chaos.test.ts), and the identity proof that has to SIGKILL
   * and reboot a real engine on one datadir to show every agent keeps its id,
   * chat and seq (e2e/identity.test.ts). Adding an eighth needs a real reason,
   * not a reflex. */
  const e2eTests = (await tracked()).filter((p) => isTest(p) && inE2E(p));
  expect(e2eTests.length).toBeLessThanOrEqual(7);
});

test("gate 7: bunfig's only [test] preload is the home guard, and it loads nothing of the engine", async () => {
  /* The preload used to be the transport swap, loaded into every process for
   * a pure unit test's benefit; that stays out (test:e2e passes its own).
   * The one preload allowed is test-utils/homeguard.ts, the fence that keeps
   * every test process off the real ~/.callyourcode (2026-09-02), and it may
   * import node builtins and bun:test only, so it costs nothing. */
  const preloads = [...(await readPackage("bunfig.toml")).matchAll(/^\s*preload\s*=\s*(.*)$/gm)].map((m) => m[1]!.trim());
  expect(preloads).toEqual(['["./src/test-utils/homeguard.ts"]']);
  const imports = [...(await read("test-utils/homeguard.ts")).matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]!);
  expect(imports.filter((i) => !i.startsWith("node:") && i !== "bun:test")).toEqual([]);
});

/* GATE 5, the one that turns the rest of this file from a ratchet into a rule.
 *
 * `@startsEngine` was the stopgap that let `bun test` grep its way around the
 * engine boots while the rewrite was in flight, and LEGACY was the list of
 * files the gates did not yet apply to. Both had to reach zero, because a
 * suppression list that never empties is just the old suite with extra steps.
 * With both empty, gates 1 to 4 apply to every tracked test file in the
 * package, which is the whole point. */
test("gate 5: the annotation is gone and the legacy list is empty", async () => {
  expect(LEGACY, "the rewrite is not finished while files are still suppressed").toEqual([]);
  const offenders: string[] = [];
  for (const p of await tracked()) {
    if (!/\.(ts|json|toml|md)$/.test(p) || p === "runtime/gates.test.ts") continue;
    if ((await read(p)).includes("@" + "startsEngine")) offenders.push(p);
  }
  expect(offenders).toEqual([]);
});

test("gate 5b: the grep-driven scripts are gone", async () => {
  const pkg = JSON.parse(await readPackage("package.json")) as { scripts: Record<string, string> };
  /* `test:integration` selected the annotated files with `grep -l` while the
   * rewrite drained; there is nothing left for it to select. And no script may
   * choose its files by grepping their contents ever again: which tests run is
   * a fact about the tree, not about what a line happens to say.
   *
   * `typecheck` joined the list deliberately. The type check used to be run by
   * hand as `bunx tsc -p agent-engine/src/tsconfig.check.json`, and `bunx` resolves
   * a compiler from the CURRENT DIRECTORY: from the repo root, where there is
   * no node_modules, it fetched TypeScript 7 and checked against different libs
   * than the pinned 5.7.3 devDependency, so the gate answered a different
   * number depending on where it was run. The script names the pinned binary,
   * which is the only way that number means anything. */
  expect(Object.keys(pkg.scripts).sort())
    .toEqual(["pair-key", "start", "test", "test:e2e", "typecheck"]);
  for (const [name, body] of Object.entries(pkg.scripts)) {
    expect(body, `${name} still selects its files by grepping them`).not.toMatch(/grep/);
  }
});
