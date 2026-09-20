/* Docker image build for the testbench: base + one image per harness pin.
 *
 * Names (brief): cyc-testbench/<harness>:<version>, base cyc-testbench/base:<date>.
 * The build context is a staging dir under artifacts/ctx holding only the
 * engine lockfiles (for baking deps) and nothing from any home directory. */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadMatrix, type Matrix } from "./matrix.ts";

export const TESTBENCH_DIR = join(import.meta.dir, "..");
export const REPO_DIR = join(TESTBENCH_DIR, "..");
export const ARTIFACTS_DIR = join(TESTBENCH_DIR, "artifacts");
export const CTX_DIR = join(ARTIFACTS_DIR, "ctx");

export function baseImage(m: Matrix): string {
  return `${m.images.base}:${m.images.base_tag}`;
}

export function harnessImage(harness: string, version: string): string {
  return `cyc-testbench/${harness}:${version}`;
}

/** Stage the build context: engine lockfiles for baking deps. Never anything
 *  from a home directory. */
export function prepareContext(): string {
  rmSync(CTX_DIR, { recursive: true, force: true });
  mkdirSync(join(CTX_DIR, "deps", "agent-engine"), { recursive: true });
  mkdirSync(join(CTX_DIR, "deps", "mcp"), { recursive: true });
  const ae = join(REPO_DIR, "engine", "agent-engine");
  for (const f of ["package.json", "bun.lock"]) cpSync(join(ae, f), join(CTX_DIR, "deps", "agent-engine", f));
  if (existsSync(join(ae, "patches"))) cpSync(join(ae, "patches"), join(CTX_DIR, "deps", "agent-engine", "patches"), { recursive: true });
  const mcp = join(REPO_DIR, "engine", "mcp");
  for (const f of ["package.json", "bun.lock"]) if (existsSync(join(mcp, f))) cpSync(join(mcp, f), join(CTX_DIR, "deps", "mcp", f));
  writeFileSync(join(CTX_DIR, ".dockerignore"), "");
  return CTX_DIR;
}

export async function imageExists(name: string): Promise<boolean> {
  const p = Bun.spawn(["docker", "image", "inspect", name], { stdout: "ignore", stderr: "ignore" });
  return (await p.exited) === 0;
}

export async function imageSize(name: string): Promise<string> {
  const p = Bun.spawn(["docker", "image", "inspect", "--format", "{{.Size}}", name], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  const n = Number(out);
  if (!Number.isFinite(n) || !n) return "?";
  return `${(n / 1e6).toFixed(0)} MB`;
}

/** the `docker images` SIZE column: what the image takes on disk (larger
 *  than the inspect .Size, which is the compressed content under containerd) */
export async function imageDiskSize(name: string): Promise<string> {
  const p = Bun.spawn(["docker", "images", "--format", "{{.Size}}", name], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim().split("\n")[0] ?? "";
  await p.exited;
  return out || "?";
}

export type BuildResult = { image: string; ok: boolean; log: string; ms: number };

/** docker build with output captured to artifacts/build/<image>.log. */
export async function buildImage(opts: {
  image: string;
  dockerfile: string;
  buildArgs?: Record<string, string>;
  ctx?: string;
  log?: (line: string) => void;
}): Promise<BuildResult> {
  const ctx = opts.ctx ?? prepareContext();
  const logDir = join(ARTIFACTS_DIR, "build");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${opts.image.replace(/[\/:]/g, "_")}.log`);
  /* no --progress: the host may run the legacy builder without buildx */
  const args = ["docker", "build", "-t", opts.image, "-f", opts.dockerfile];
  for (const [k, v] of Object.entries(opts.buildArgs ?? {})) args.push("--build-arg", `${k}=${v}`);
  args.push(ctx);
  const t0 = Date.now();
  opts.log?.(`build ${opts.image} (log ${logPath})`);
  const p = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  writeFileSync(logPath, out + "\n" + err);
  return { image: opts.image, ok: code === 0, log: logPath, ms: Date.now() - t0 };
}

/** Build the base, then the named harness pins (skipping images that exist
 *  unless force). */
export async function ensureImages(opts: {
  matrix?: Matrix;
  harnesses: { harness: string; version: string }[];
  force?: boolean;
  log?: (line: string) => void;
}): Promise<BuildResult[]> {
  const m = opts.matrix ?? loadMatrix();
  const results: BuildResult[] = [];
  const ctx = prepareContext();
  const base = baseImage(m);
  if (opts.force || !(await imageExists(base))) {
    const r = await buildImage({ image: base, dockerfile: join(TESTBENCH_DIR, "docker", "base.Dockerfile"), ctx, log: opts.log });
    results.push(r);
    if (!r.ok) return results;
  }
  const seen = new Set<string>();
  for (const { harness, version } of opts.harnesses) {
    const image = harnessImage(harness, version);
    if (seen.has(image)) continue;
    seen.add(image);
    if (!opts.force && (await imageExists(image))) continue;
    const h = m.harnesses[harness];
    if (!h) throw new Error(`unknown harness ${harness}`);
    const r = await buildImage({
      image,
      dockerfile: join(TESTBENCH_DIR, "docker", `harness-${harness}.Dockerfile`),
      buildArgs: { BASE_IMAGE: base, HARNESS_VERSION: version, HARNESS_PACKAGE: h.package },
      ctx,
      log: opts.log,
    });
    results.push(r);
  }
  return results;
}
