#!/usr/bin/env bun
/* The testbench runner (adapters-design 9.4).
 *
 *   bun testbench/run.ts --tier pr --jobs 3
 *   bun testbench/run.ts --only claude/2.1.257/tmux/01-bring-up
 *   bun testbench/run.ts --tier nightly --only '*\/*\/herdr/*'
 *   bun testbench/run.ts --build-only            # images only
 *   bun testbench/run.ts --probe-herdr           # the herdr-in-docker probe
 *   bun testbench/run.ts --host --only claude/2.1.257/herdr/01-bring-up
 *
 * Builds the images it needs, expands the tier into cells, runs N cells at a
 * time (one container each, no network), then writes summary.json,
 * summary.md and junit.xml. Never runs under `bun test`.
 *
 * A full `--tier` run is the tier record: artifacts/{summary.*,junit.xml,cells/};
 * the previous record's summary files are archived to artifacts/history/<startedAt>/
 * first. A `--only` run never touches the record: it writes to
 * artifacts/only/<stamp>/{cells,summary.*}.
 *
 * --expect <file> names the checked-in expectation map (cell -> green|red;
 * default testbench/expected/pr.json for the pr tier). The process exits 1
 * when any cell's verdict differs from its expectation, either direction, or
 * on an error; 0 when the set matches. --write-expected regenerates the map
 * from the run's summary (or, with no run, from artifacts/summary.json),
 * merging over the file's other cells.
 *
 * --host runs a cell on this machine instead of in a container, against a
 * herdr server that is ALREADY running at HERDR_SOCKET_PATH (for a real
 * herdr on a box without docker). The harness binary must already be on PATH
 * there; the runner never installs anything on a host. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandTier, loadMatrix, matchOnly, type Cell, type Matrix } from "./lib/matrix.ts";
import { ARTIFACTS_DIR, REPO_DIR, TESTBENCH_DIR, baseImage, ensureImages, harnessImage, imageDiskSize, imageExists, imageSize } from "./lib/images.ts";
import { junitXml, summarize, summaryMarkdown, type CellVerdict, type ImageSize, type Summary } from "./lib/report.ts";
import { archivePrevious, diffText, exitCode, expectedFromSummary, readExpected, runRoot, writeExpected } from "./lib/runs.ts";

type Args = {
  tier: string | null; only: string | null; jobs: number; host: boolean; build: boolean; buildOnly: boolean;
  probeHerdr: boolean; force: boolean; keep: boolean; expect: string | null; writeExpected: boolean;
};

const EXPECTED_PR = join(TESTBENCH_DIR, "expected", "pr.json");

function parseArgs(argv: string[]): Args {
  const a: Args = { tier: null, only: null, jobs: 0, host: false, build: true, buildOnly: false, probeHerdr: false, force: false, keep: false, expect: null, writeExpected: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${x} needs a value`); return v; };
    if (x === "--tier") a.tier = next();
    else if (x === "--only") a.only = next();
    else if (x === "--jobs") a.jobs = Number(next());
    else if (x === "--host") a.host = true;
    else if (x === "--no-build") a.build = false;
    else if (x === "--build-only") a.buildOnly = true;
    else if (x === "--probe-herdr") a.probeHerdr = true;
    else if (x === "--force-build") a.force = true;
    else if (x === "--keep") a.keep = true;
    else if (x === "--expect") a.expect = next();
    else if (x === "--write-expected") a.writeExpected = true;
    else if (x === "-h" || x === "--help") { console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]); process.exit(0); }
    else throw new Error(`unknown flag ${x}`);
  }
  if (!a.tier && !a.only && !a.buildOnly && !a.probeHerdr && !a.writeExpected) a.tier = "pr";
  /* the pr tier (and a --only pick from it) is judged against the checked-in map */
  if (!a.expect && (a.tier === "pr" || (!a.tier && a.only))) a.expect = EXPECTED_PR;
  return a;
}

const log = (s: string) => console.log(`[run ${new Date().toISOString().slice(11, 19)}] ${s}`);
/** where this invocation writes: the tier record, or only/<stamp> */
let OUT_ROOT = ARTIFACTS_DIR;
const cellDir = (c: Cell) => join(OUT_ROOT, "cells", c.id.replace(/\//g, "_"));

/** The cells this invocation runs: a tier (filtered by --only) or, with only
 *  --only, every enabled tier's cells matching it (deduplicated). */
function selectCells(m: Matrix, a: Args): Cell[] {
  let cells: Cell[];
  if (a.tier) cells = expandTier(m, a.tier);
  else {
    const seen = new Set<string>();
    cells = [];
    for (const [name, t] of Object.entries(m.tiers)) {
      if (!t.enabled) continue;
      for (const c of expandTier(m, name)) if (!seen.has(c.id)) { seen.add(c.id); cells.push(c); }
    }
  }
  if (a.only) cells = cells.filter((c) => matchOnly(c, a.only!));
  return cells;
}

/** tmux compat pins run on the tmux-multi image, tagged per harness+tmux. */
function tmuxVersionsFor(m: Matrix, tier: string | null): string[] {
  if (!tier) return [m.muxes.tmux.primary];
  const t = m.tiers[tier];
  return t?.tmux_versions === "primary+compat" ? [m.muxes.tmux.primary, ...m.muxes.tmux.compat] : [m.muxes.tmux.primary];
}

/** Wipe a cell's artifacts dir. Earlier runs may have left root-owned files
 *  (before the entrypoint learned to chown); clear those through a container. */
async function resetDir(dir: string): Promise<void> {
  try { rmSync(dir, { recursive: true, force: true }); } catch {
    const p = Bun.spawn(["docker", "run", "--rm", "--network", "none", "-v", `${join(dir, "..")}:/x`, "busybox", "rm", "-rf", `/x/${dir.split("/").pop()}`], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
  }
  mkdirSync(dir, { recursive: true });
}

async function runDockerCell(m: Matrix, c: Cell, tmuxVersion: string | null): Promise<CellVerdict> {
  const dir = cellDir(c);
  await resetDir(dir);
  const image = harnessImage(c.harness, c.version);
  const t0 = Date.now();
  const cfg = m.cell;
  const args = [
    "timeout", "--kill-after=10", String(cfg.timeout_s),
    "docker", "run", "--rm", "--network", cfg.network, "--memory", cfg.memory, "--cpus", String(cfg.cpus), "--pids-limit", String(cfg.pids_limit),
    ...(cfg.cap_add ?? []).flatMap((c) => ["--cap-add", c]),
    "-v", `${REPO_DIR}:/engine:ro`, "-v", `${dir}:/out`,
    "-e", `CELL_ID=${c.id}`, "-e", `CELL_HARNESS=${c.harness}`, "-e", `CELL_VERSION=${c.version}`, "-e", `CELL_MUX=${c.mux}`, "-e", `CELL_SCENARIO=${c.scenario}`,
    "-e", `CELL_FAKE_PORT=${cfg.fake_model_port}`, "-e", `CELL_ENGINE_PORT=${cfg.engine_port}`, "-e", `CELL_DEADLINE_S=${Math.max(30, cfg.timeout_s - 40)}`,
    "-e", `CELL_UID=${process.getuid?.() ?? 0}`, "-e", `CELL_GID=${process.getgid?.() ?? 0}`,
  ];
  if (c.versions) args.push("-e", `CELL_VERSIONS=${c.versions.join(",")}`);
  if (tmuxVersion && tmuxVersion !== m.muxes.tmux.primary) args.push("-e", `CELL_TMUX_BIN=/opt/tmux/${tmuxVersion}/bin/tmux`);
  args.push(image, "bash", "/engine/testbench/cell/entrypoint.sh");
  writeFileSync(join(dir, "docker-cmd.txt"), args.join(" ") + "\n");
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const rc = await p.exited;
  writeFileSync(join(dir, "docker.log"), out + err);
  return readVerdict(c, dir, rc, Date.now() - t0);
}

/** --host: the scenario runner on this machine, against the running herdr at
 *  HERDR_SOCKET_PATH (or the host tmux for tmux cells). Nothing is installed. */
async function runHostCell(m: Matrix, c: Cell): Promise<CellVerdict> {
  const dir = cellDir(c);
  await resetDir(dir);
  const root = join(dir, "cell");
  mkdirSync(root, { recursive: true });
  const t0 = Date.now();
  const { freePort } = await import("../engine/agent-engine/src/e2e/harness.ts");
  const fakePort = await freePort();
  const enginePort = await freePort();
  const fake = Bun.spawn(["bun", join(TESTBENCH_DIR, "fake-model", "server.ts")], {
    env: { ...process.env, FAKE_MODEL_PORT: String(fakePort), FAKE_MODEL_LOG: join(dir, "fake-requests.jsonl"), FAKE_MODEL_SCRIPT: c.scenario },
    stdout: Bun.file(join(dir, "fake-model.log")), stderr: Bun.file(join(dir, "fake-model.log")),
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${fakePort}/_control/health`)).ok) break; } catch { } await Bun.sleep(100); }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CELL_ID: c.id, CELL_HARNESS: c.harness, CELL_VERSION: c.version, CELL_MUX: c.mux, CELL_SCENARIO: c.scenario,
    CELL_ROOT: root, CELL_ENGINE_SRC: REPO_DIR, CELL_OUT: dir, CELL_FAKE_URL: `http://127.0.0.1:${fakePort}`, CELL_ENGINE_PORT: String(enginePort),
    CELL_DEADLINE_S: String(Math.max(30, m.cell.timeout_s - 40)),
    CELL_HERDR_SOCKET: process.env.HERDR_SOCKET_PATH ?? "",
  };
  if (c.versions) env.CELL_VERSIONS = c.versions.join(",");
  const p = Bun.spawn(["timeout", "--kill-after=10", String(m.cell.timeout_s), "bun", join(TESTBENCH_DIR, "cell", "run-scenario.ts")],
    { env, cwd: root, stdout: Bun.file(join(dir, "runner.log")), stderr: Bun.file(join(dir, "runner.log")) });
  const rc = await p.exited;
  fake.kill();
  return readVerdict(c, dir, rc, Date.now() - t0);
}

function readVerdict(c: Cell, dir: string, rc: number, ms: number): CellVerdict {
  const rel = dir.replace(TESTBENCH_DIR + "/", "");
  const f = join(dir, "verdict.json");
  let v: CellVerdict;
  try {
    v = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    v = { cell: c.id, harness: c.harness, version: c.version, mux: c.mux, scenario: c.scenario, verdict: "error", reason: `no verdict.json (container rc=${rc}${rc === 124 || rc === 137 ? ", timeout" : ""})`, checks: [], artifacts: {} };
  }
  v.rc = rc; v.dir = rel; v.ms = v.ms ?? ms;
  return v;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const m = loadMatrix();
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  if (a.probeHerdr) {
    /* the herdr-in-docker probe */
    await ensureImages({ matrix: m, harnesses: [], force: a.force, log });
    const dir = join(ARTIFACTS_DIR, "herdr-probe");
    await resetDir(dir);
    const p = Bun.spawn(["docker", "run", "--rm", "--network", "none", "-v", `${REPO_DIR}:/engine:ro`, "-v", `${dir}:/out`, baseImage(m), "bun", "/engine/testbench/cell/herdr-probe.ts"], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const rc = await p.exited;
    writeFileSync(join(dir, "probe.log"), out + err);
    console.log(out + err);
    log(`herdr probe rc=${rc}; log ${join(dir, "probe.log")}`);
    process.exit(rc);
  }

  const expectPath = a.expect && existsSync(a.expect) ? a.expect : null;
  if (a.expect && !expectPath) log(`no expectation map at ${a.expect}; judging by the lane-1 rule (write one with --write-expected)`);
  const expected = expectPath ? { ...readExpected(expectPath)!, path: expectPath.replace(TESTBENCH_DIR + "/", "testbench/") } : null;

  if (a.writeExpected && !a.tier && !a.only) {
    /* no run: regenerate the map from the tier record on disk */
    const f = join(ARTIFACTS_DIR, "summary.json");
    if (!existsSync(f)) { log(`--write-expected: no ${f} to read`); process.exit(1); }
    const s: Summary = JSON.parse(readFileSync(f, "utf8"));
    const out = a.expect ?? EXPECTED_PR;
    const e = expectedFromSummary(s, readExpected(out));
    writeExpected(out, e);
    log(`wrote ${Object.keys(e.cells).length} expectation(s) from ${f} (started ${s.startedAt}) to ${out}`);
    process.exit(0);
  }

  const cells = selectCells(m, a);
  if (!cells.length) { log(`no cells match (tier ${a.tier ?? "-"}, only ${a.only ?? "-"})`); process.exit(1); }
  OUT_ROOT = runRoot(ARTIFACTS_DIR, a.only);
  if (a.only) { mkdirSync(OUT_ROOT, { recursive: true }); log(`--only run: artifacts under ${OUT_ROOT} (the tier record is untouched)`); }
  else { const h = archivePrevious(ARTIFACTS_DIR); if (h) log(`previous tier record archived to ${h}`); }
  const jobs = Math.min(3, Math.max(1, a.jobs || m.tiers[a.tier ?? "pr"]?.jobs || 3));
  const tmuxVersions = tmuxVersionsFor(m, a.tier);
  const startedAt = Date.now();

  if (!a.host && a.build) {
    const pins = cells.flatMap((c) => (c.versions ?? [c.version]).map((version) => ({ harness: c.harness, version })));
    const results = await ensureImages({ matrix: m, harnesses: pins, force: a.force, log });
    for (const r of results) log(`${r.ok ? "built" : "FAILED"} ${r.image} in ${(r.ms / 1000).toFixed(0)}s (${r.log})`);
    if (results.some((r) => !r.ok)) { log("image build failed; stopping"); process.exit(1); }
    if (tmuxVersions.length > 1) {
      /* the compat tmux builds live in tmux-multi; that image is a build stage
       * copied into the harness images when CELL_TMUX_BIN names it */
      log(`tmux compat ${tmuxVersions.slice(1).join(", ")} via docker/tmux-multi.Dockerfile`);
    }
  }
  if (a.buildOnly) { log("build only; done"); process.exit(0); }

  /* the run list: every cell, and for the nightly tmux compat pins the tmux
   * cells again on each compat tmux */
  const runs: { cell: Cell; tmux: string | null }[] = [];
  for (const c of cells) {
    if (c.mux === "tmux" || c.mux === "both") for (const t of tmuxVersions) runs.push({ cell: t === m.muxes.tmux.primary ? c : { ...c, id: `${c.id}@tmux-${t}` }, tmux: t });
    else runs.push({ cell: c, tmux: null });
  }
  if (!a.host) {
    const missing: string[] = [];
    for (const r of runs) { const img = harnessImage(r.cell.harness, r.cell.version); if (!(await imageExists(img))) missing.push(img); }
    if (missing.length) { log(`missing images (run without --no-build): ${[...new Set(missing)].join(", ")}`); process.exit(1); }
  }

  log(`${runs.length} cell(s), ${jobs} at a time${a.host ? " (host mode)" : ""}`);
  const verdicts = await pool(runs, a.host ? 1 : jobs, async (r) => {
    log(`start ${r.cell.id}`);
    const v = a.host ? await runHostCell(m, r.cell) : await runDockerCell(m, r.cell, r.tmux);
    log(`${v.verdict.toUpperCase().padEnd(5)} ${r.cell.id} (${((v.ms ?? 0) / 1000).toFixed(0)}s) ${v.reason}`);
    return v;
  });

  const images: ImageSize[] = [];
  if (!a.host) {
    const names = [baseImage(m), ...new Set(cells.map((c) => harnessImage(c.harness, c.version)))];
    for (const n of names) if (await imageExists(n)) images.push({ image: n, size: await imageSize(n), disk: await imageDiskSize(n) });
  }
  const summary = summarize(verdicts, { tier: a.tier, only: a.only, startedAt, images, expected });
  writeFileSync(join(OUT_ROOT, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT_ROOT, "summary.md"), summaryMarkdown(summary));
  writeFileSync(join(OUT_ROOT, "junit.xml"), junitXml(summary));
  console.log("\n" + summaryMarkdown(summary));
  log(`summary: ${join(OUT_ROOT, "summary.json")} (+ summary.md, junit.xml); wall ${(summary.wallMs / 1000).toFixed(0)}s`);
  if (a.writeExpected) {
    const out = a.expect ?? EXPECTED_PR;
    const e = expectedFromSummary(summary, readExpected(out));
    writeExpected(out, e);
    log(`wrote ${Object.keys(e.cells).length} expectation(s) to ${out}`);
  }
  console.log(diffText(summary.surprises, summary.expectedFrom ?? null));
  process.exit(exitCode(summary));
}

main().catch((e) => { console.error(e); process.exit(1); });
