/* Boot a scratch engine against a real mux and the production relay fixture.
 * Reuse the engine E2E guardrails and pair-proof registration. */

import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, whyNotFakeCredentials, whyNotFakeServices, whyNotLocalUpstream }
  from "../../engine/agent-engine/src/e2e/harness.ts";
import { relaySink } from "../../engine/agent-engine/src/test-utils/relay-sink.ts";
import { registerEngineE2E, unregisterEngineE2E } from "../../engine/agent-engine/src/e2e/testclient.ts";

export { freePort };

export type EngineProc = {
  port: number;
  sink: ReturnType<typeof relaySink>;
  /** Engine identity URL used by the E2E client to find its scratch relay. */
  url: string;
  http: string;
  dataDir: string;
  /** stdout+stderr lines, "<ms> <line>", from every boot in this cell */
  lines: string[];
  pid: number;
  exited: Promise<number>;
  /** every line since a moment */
  since: (ms: number) => string[];
  /** SIGTERM then SIGKILL after grace */
  stop: (graceMs?: number) => Promise<void>;
  kill: () => Promise<void>;
  post: (path: string, body: unknown) => Promise<Response>;
  get: (path: string) => Promise<Response>;
};

export type BootOpts = {
  /** cell root: <root>/repo is the private engine copy, <root>/data the CYC_DATA_DIR */
  root: string;
  port: number;
  /** env for the mux + harness homes (CYC_MUX, CYC_TMUX_SOCKET, TMUX_TMPDIR,
   *  HERDR_SOCKET_PATH, CYC_PROJECTS_DIR, CODEX_HOME, ...) */
  env: Record<string, string>;
  /** where lines are also appended as they arrive (the engine log artifact) */
  logPath?: string;
  /** reuse the data dir of a previous boot (engine restart scenarios) */
  keepData?: boolean;
  /** the push sink of a previous boot, when one is kept across restarts */
  sink?: ReturnType<typeof relaySink>;
  healthMs?: number;
};

/** The private engine copy: agent-engine/src + shared + hooks + mcp + scripts,
 *  with node_modules symlinked to the deps baked into the image
 *  (/opt/engine-deps) or to the host's, in --host mode. */
export function stageEngineTree(opts: { from: string; to: string; deps?: string }): string {
  const { from, to } = opts;
  if (existsSync(to)) return to;
  mkdirSync(to, { recursive: true });
  const cp = (rel: string) => {
    const src = join(from, rel);
    if (!existsSync(src)) return;
    mkdirSync(join(to, rel, ".."), { recursive: true });
    Bun.spawnSync(["cp", "-R", src, join(to, rel)]);
  };
  cp("engine/agent-engine/src");
  cp("engine/agent-engine/package.json");
  cp("engine/agent-engine/public");
  cp("engine/shared");
  cp("engine/hooks");
  cp("engine/harness");
  cp("engine/skills");
  cp("engine/mcp/src");
  cp("engine/mcp/package.json");
  cp("scripts");
  cp("server/src");
  for (const t of ["cell", "fake-model", "lib", "scenarios", "matrix.yaml"]) cp(`testbench/${t}`);
  const deps = opts.deps ?? (existsSync("/opt/engine-deps") ? "/opt/engine-deps" : join(from, "engine"));
  const ae = join(to, "engine", "agent-engine", "node_modules");
  const mcp = join(to, "engine", "mcp", "node_modules");
  const serverDeps = join(to, "server", "node_modules");
  if (!existsSync(serverDeps)) symlinkSync(join(deps, "agent-engine", "node_modules"), serverDeps);
  rmSync(ae, { recursive: true, force: true });
  rmSync(mcp, { recursive: true, force: true });
  if (existsSync(join(deps, "agent-engine", "node_modules"))) symlinkSync(join(deps, "agent-engine", "node_modules"), ae);
  if (existsSync(join(deps, "mcp", "node_modules"))) symlinkSync(join(deps, "mcp", "node_modules"), mcp);
  return to;
}

export async function bootEngine(opts: BootOpts): Promise<EngineProc> {
  const { root, port } = opts;
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const scratch = join(root, "engine-scratch");
  if (!opts.keepData) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  /* Same made-up token shape and empty services table as startEngine, so the
   * guardrails hold and nothing real is ever read. */
  writeFileSync(join(scratch, "credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "harness-not-a-real-token" } }));
  if (!existsSync(join(scratch, "services.json"))) writeFileSync(join(scratch, "services.json"), "[]");
  const sink = opts.sink ?? relaySink();

  const engineEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AGENT_PORT: String(port),
    AGENT_HOST: "127.0.0.1",
    ENGINE_HOST: "cell",
    APP_SERVER_URL: sink.url,
    NOTIFY_DEBUG: "1",
    CYC_LIMITS_API: "http://127.0.0.1:1",
    CYC_LIMITS_SHARE_DIR: join(scratch, "limits-share"),
    CYC_LIMITS_SEEN: join(dataDir, "state", "limits-seen.json"),
    CYC_LIMITS_CREDENTIALS: join(scratch, "credentials.json"),
    CYC_SERVICES_FILE: join(scratch, "services.json"),
    CYC_SERVICES_LEASE_DIR: join(scratch, "lease"),
    CYC_SERVICES_INTERVAL_MS: "500",
    CYC_SERVICES_RESTART_MS: "200",
    CYC_DATA_DIR: dataDir,
    ...opts.env,
  };
  const why = whyNotLocalUpstream(engineEnv.CYC_LIMITS_API) ??
    whyNotFakeCredentials(engineEnv.CYC_LIMITS_CREDENTIALS, scratch) ??
    whyNotFakeServices(engineEnv.CYC_SERVICES_FILE, scratch,
      await Bun.file(engineEnv.CYC_SERVICES_FILE).text().catch(() => "[]"),
      engineEnv.CYC_SERVICES_LEASE_DIR);
  if (why) throw new Error(`[engine-boot] refusing to start an engine: ${why}`);

  const server = join(repo, "engine", "agent-engine", "src", "runtime", "server.ts");
  if (!existsSync(server)) throw new Error(`[engine-boot] no server at ${server}; stageEngineTree first`);
  const proc = Bun.spawn(["bun", "run", server], { env: engineEnv, stdout: "pipe", stderr: "pipe", cwd: join(repo, "engine", "agent-engine") });
  const lines: string[] = [];
  const bootAt = Date.now();
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
        const line = `${Date.now()} ${buf.slice(0, i)}`;
        lines.push(line);
        if (opts.logPath) appendFileSync(opts.logPath, line + "\n");
        buf = buf.slice(i + 1);
      }
    }
  };
  drain(proc.stdout);
  drain(proc.stderr);
  if (opts.logPath) appendFileSync(opts.logPath, `${bootAt} [engine-boot] spawned pid ${proc.pid} port ${port} data ${dataDir}\n`);

  const http = `http://127.0.0.1:${port}`;
  const healthMs = opts.healthMs ?? 20_000;
  let healthy = false;
  for (let i = 0; i < healthMs / 100; i++) {
    if (proc.exitCode !== null) break;
    try {
      const r = await fetch(`${http}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { healthy = true; break; }
    } catch { /* not yet */ }
    await Bun.sleep(100);
  }
  if (!healthy) {
    proc.kill("SIGKILL");
    await proc.exited;
    if (!opts.sink) sink.stop();
    throw new Error(`[engine-boot] engine did not answer /health in ${healthMs}ms; last lines:\n${lines.slice(-30).join("\n")}`);
  }
  // HTTP health can precede enrolment and the outbound relay's first retry.
  // Do not hand a browser client an engine whose data path is not ready yet.
  for (let i = 0; i < healthMs / 100 && !lines.some((line) => line.includes("relay.up")); i++) {
    if (proc.exitCode !== null) break;
    await Bun.sleep(100);
  }
  if (!lines.some((line) => line.includes("relay.up"))) {
    proc.kill("SIGKILL");
    await proc.exited;
    if (!opts.sink) sink.stop();
    throw new Error(`[engine-boot] relay did not connect; last lines:\n${lines.slice(-30).join("\n")}`);
  }
  /* The sealed-client pair proof, from this engine's own keys.json. */
  registerEngineE2E(port, join(dataDir, "keys.json"), sink.url);

  const stop = async (graceMs = 3000) => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, graceMs);
    await proc.exited;
    clearTimeout(t);
    try { unregisterEngineE2E(port); } catch { /* fine */ }
  };
  const kill = async () => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await proc.exited;
    try { unregisterEngineE2E(port); } catch { /* fine */ }
  };
  return {
    port, sink, url: `ws://127.0.0.1:${port}/ws`, http, dataDir, lines, pid: proc.pid, exited: proc.exited,
    since: (ms) => lines.filter((l) => Number(l.slice(0, l.indexOf(" "))) >= ms),
    stop, kill,
    post: (path, body) => fetch(`${http}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    get: (path) => fetch(`${http}${path}`),
  };
}
