/* Runs ONE scenario inside a cell and writes /out/verdict.json.
 *
 *   bun testbench/cell/run-scenario.ts
 *
 * Env (set by cell/entrypoint.sh, or by run.ts in --host mode):
 *   CELL_ID CELL_HARNESS CELL_VERSION CELL_MUX CELL_SCENARIO
 *   CELL_ROOT (/cell) CELL_ENGINE_SRC (/engine) CELL_OUT (/out)
 *   CELL_FAKE_URL CELL_ENGINE_PORT CELL_DEADLINE_S
 *   CELL_HERDR_SOCKET (host mode) CELL_TMUX_BIN (compat tmux)
 *
 * Order: the fake model is already up (entrypoint), then mux server,
 * harness install, engine, scenario. The scenario itself decides when the
 * engine boots (some start it before the harness, some after) through the
 * Cell handles; this file only guarantees a verdict gets written. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cell, NeedFailed, type Verdict } from "./driver.ts";

const env = process.env;
const req = (k: string) => { const v = env[k]; if (!v) throw new Error(`missing ${k}`); return v; };

const out = env.CELL_OUT ?? "/out";
mkdirSync(out, { recursive: true });
const cell = new Cell({
  id: req("CELL_ID"),
  harness: req("CELL_HARNESS") as any,
  version: req("CELL_VERSION"),
  mux: req("CELL_MUX") as any,
  scenario: req("CELL_SCENARIO"),
  root: env.CELL_ROOT ?? "/cell",
  engineSrc: env.CELL_ENGINE_SRC ?? "/engine",
  out,
  fakeUrl: env.CELL_FAKE_URL ?? "http://127.0.0.1:4141",
  enginePort: Number(env.CELL_ENGINE_PORT ?? 10101),
  herdrSocket: env.CELL_HERDR_SOCKET || undefined,
  tmuxBin: env.CELL_TMUX_BIN || undefined,
});

const deadlineS = Number(env.CELL_DEADLINE_S ?? 200);
let verdict: Verdict | null = null;
const finish = async (err?: unknown) => {
  if (verdict) return;
  let artifacts: Record<string, string> = {};
  try { artifacts = await cell.collect(); } catch (e) { cell.log(`collect failed: ${e}`); }
  verdict = cell.verdict(err, artifacts);
  writeFileSync(join(out, "verdict.json"), JSON.stringify(verdict, null, 2));
  cell.log(`VERDICT ${verdict.verdict}: ${verdict.reason}`);
  await cell.teardown().catch(() => {});
};

const timer = setTimeout(() => { void finish(new Error(`scenario deadline ${deadlineS}s`)).then(() => process.exit(3)); }, deadlineS * 1000);

try {
  cell.log(`cell ${cell.id} start (harness ${cell.harnessName} ${cell.version}, mux ${cell.muxKind}, scenario ${cell.scenario})`);
  cell.need("fake model answers", await cell.fake().health(), cell.fakeUrl);
  await cell.installHarness(); // stages <root>/repo first, so the scenario loads from the private copy
  const file = join(cell.paths.repo, "testbench", "scenarios", `${cell.scenario}.ts`);
  cell.need(`scenario file ${file}`, existsSync(file));
  const mod = await import(file);
  const run: (c: Cell) => Promise<void> = mod.default;
  cell.need("scenario exports a default function", typeof run === "function");
  await cell.startMux();
  await run(cell);
  await finish();
} catch (e) {
  if (!(e instanceof NeedFailed)) cell.log(`threw: ${(e as any)?.stack ?? e}`);
  await finish(e);
}
clearTimeout(timer);
process.exit(verdict?.verdict === "error" ? 2 : 0);
