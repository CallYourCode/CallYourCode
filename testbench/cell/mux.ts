/* The two real muxes a cell can run: tmux (socket -L cell) and herdr (server
 * --session cell). One interface, so a scenario reads the same for both. */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Pane = { id: string; pid: number; /** the mux that owns it (set by the driver) */ mux?: Mux };
export type PaneInfo = { id: string; pid: number; command: string; cwd: string };

export interface Mux {
  readonly kind: "tmux" | "herdr";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** kill the server and start a fresh one (panes die with the server) */
  restart(): Promise<void>;
  alive(): Promise<boolean>;
  /** a new pane running a shell in cwd with env; the harness is typed into it */
  newPane(opts: { cwd: string; env?: Record<string, string> }): Promise<Pane>;
  sendText(pane: string, text: string): Promise<void>;
  /** tmux key names: Enter, Escape, C-c, Up, Down, Tab, BSpace */
  sendKeys(pane: string, keys: string[]): Promise<void>;
  capture(pane: string): Promise<string>;
  captureAnsi(pane: string): Promise<string>;
  panes(): Promise<PaneInfo[]>;
  killPane(pane: string): Promise<void>;
  /** env the engine needs to find this mux */
  engineEnv(): Record<string, string>;
  /** the env var the pane's processes carry that names their pane */
  paneEnvVar(): string;
  log: string[];
}

async function run(args: string[], env: Record<string, string>, ms = 15_000, cwd?: string) {
  const p = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe", cwd });
  const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, ms);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { code, out, err };
}

/* ---------------- tmux ---------------- */

export class TmuxMux implements Mux {
  readonly kind = "tmux" as const;
  log: string[] = [];
  private env: Record<string, string>;
  constructor(private opts: { socket: string; tmpdir: string; cwd: string; tmuxBin?: string }) {
    mkdirSync(opts.tmpdir, { recursive: true });
    this.env = { ...(process.env as Record<string, string>), TMUX_TMPDIR: opts.tmpdir, TERM: "xterm-256color" };
    delete this.env.TMUX;
    delete this.env.TMUX_PANE;
  }
  private bin() { return this.opts.tmuxBin ?? "tmux"; }
  private async tmux(args: string[], ms?: number) {
    const r = await run([this.bin(), "-L", this.opts.socket, ...args], this.env, ms);
    this.log.push(`${Date.now()} tmux ${args.join(" ")} -> ${r.code}${r.err.trim() ? " " + r.err.trim() : ""}`);
    if (r.code !== 0) throw new Error(`tmux ${args[0]}: ${r.err.trim() || r.out.trim() || "failed"}`);
    return r.out;
  }
  async start() {
    await this.tmux(["-f", "/dev/null", "new-session", "-d", "-s", "cell", "-x", "200", "-y", "50", "-c", this.opts.cwd]);
    /* a person's tmux keeps dead panes for a moment; the engine treats a
     * vanished pane as the agent gone, so default behaviour is what we want */
    await this.tmux(["set-option", "-g", "history-limit", "5000"]);
  }
  async stop() {
    await run([this.bin(), "-L", this.opts.socket, "kill-server"], this.env, 5000);
  }
  async restart() {
    await this.stop();
    await Bun.sleep(300);
    await this.start();
  }
  async alive() {
    const r = await run([this.bin(), "-L", this.opts.socket, "list-sessions"], this.env, 5000);
    return r.code === 0;
  }
  async newPane({ cwd, env = {} }: { cwd: string; env?: Record<string, string> }) {
    const args = ["new-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-c", cwd];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    const out = await this.tmux(args);
    const [id, pid] = out.trim().split("\t");
    return { id, pid: Number(pid) };
  }
  async sendText(pane: string, text: string) { await this.tmux(["send-keys", "-t", pane, "-l", "--", text]); }
  async sendKeys(pane: string, keys: string[]) { await this.tmux(["send-keys", "-t", pane, ...keys]); }
  async capture(pane: string) { return this.tmux(["capture-pane", "-p", "-t", pane]); }
  async captureAnsi(pane: string) { return this.tmux(["capture-pane", "-p", "-e", "-t", pane]); }
  async panes() {
    const out = await this.tmux(["list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}"]).catch(() => "");
    return out.trim().split("\n").filter(Boolean).map((l) => {
      const [id, pid, command, cwd] = l.split("\t");
      return { id, pid: Number(pid), command, cwd };
    });
  }
  async killPane(pane: string) { await this.tmux(["kill-pane", "-t", pane]); }
  engineEnv() { return { CYC_MUX: "tmux", CYC_TMUX_SOCKET: this.opts.socket, TMUX_TMPDIR: this.opts.tmpdir }; }
  paneEnvVar() { return "TMUX_PANE"; }
}

/* ---------------- herdr ---------------- */

const HERDR_KEYS: Record<string, string> = {
  Enter: "enter", Escape: "escape", "C-c": "ctrl+c", "C-d": "ctrl+d", "C-x": "ctrl+x", "C-u": "ctrl+u",
  Up: "up", Down: "down", Tab: "tab", BSpace: "backspace", Space: "space",
};

export class HerdrMux implements Mux {
  readonly kind = "herdr" as const;
  log: string[] = [];
  private env: Record<string, string>;
  private server: ReturnType<typeof Bun.spawn> | null = null;
  readonly sock: string;
  constructor(private opts: { home: string; session: string; cwd: string; socketPath?: string }) {
    this.env = { ...(process.env as Record<string, string>), HOME: opts.home, XDG_CONFIG_HOME: join(opts.home, ".config"), SHELL: "/bin/bash", TERM: "xterm-256color" };
    delete this.env.HERDR_PANE_ID; delete this.env.HERDR_TAB_ID; delete this.env.HERDR_WORKSPACE_ID; delete this.env.HERDR_ENV;
    delete this.env.TMUX; delete this.env.TMUX_PANE;
    this.sock = opts.socketPath ?? join(opts.home, ".config", "herdr", "sessions", opts.session, "herdr.sock");
  }
  private async herdr(args: string[], ms?: number) {
    const r = await run(["herdr", "--session", this.opts.session, ...args], this.env, ms);
    this.log.push(`${Date.now()} herdr ${args.join(" ")} -> ${r.code}${r.err.trim() ? " " + r.err.trim().slice(0, 300) : ""}`);
    if (r.code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${r.err.trim() || r.out.trim() || "failed"}`);
    return r.out;
  }
  private json(out: string): any {
    try { const j = JSON.parse(out); return j.result ?? j; } catch { return null; }
  }
  async start() {
    if (this.opts.socketPath && existsSync(this.opts.socketPath)) return; // --host mode: an external server
    mkdirSync(this.opts.cwd, { recursive: true });
    /* no updater in the cell: herdr 0.8.2 otherwise forks a curl at
     * https://herdr.dev/latest on boot (the netns has no route, but the
     * process shows up in the cell's process table) */
    const cfgDir = join(this.opts.home, ".config", "herdr");
    mkdirSync(cfgDir, { recursive: true });
    if (!existsSync(join(cfgDir, "config.toml"))) writeFileSync(join(cfgDir, "config.toml"), "[update]\nversion_check = false\nmanifest_check = false\nauto_update = false\n");
    this.server = Bun.spawn(["herdr", "server", "--session", this.opts.session], { env: this.env, cwd: this.opts.cwd, stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100; i++) { if (existsSync(this.sock)) break; await Bun.sleep(100); }
    if (!existsSync(this.sock)) throw new Error("herdr server socket did not appear in 10s");
    /* the server answers before it lists anything; one status round-trip settles it */
    for (let i = 0; i < 30; i++) {
      const r = await run(["herdr", "--session", this.opts.session, "status"], this.env, 5000);
      if (r.code === 0) break;
      await Bun.sleep(200);
    }
  }
  async stop() {
    if (this.opts.socketPath && !this.server) return;
    await run(["herdr", "--session", this.opts.session, "server", "stop"], this.env, 5000).catch(() => {});
    if (this.server) { try { this.server.kill("SIGTERM"); } catch { /* gone */ } await this.server.exited.catch(() => {}); this.server = null; }
    for (let i = 0; i < 20 && existsSync(this.sock); i++) await Bun.sleep(100);
  }
  async restart() { await this.stop(); await Bun.sleep(300); await this.start(); }
  async alive() { return (await run(["herdr", "--session", this.opts.session, "status"], this.env, 5000)).code === 0; }
  async newPane({ cwd, env = {} }: { cwd: string; env?: Record<string, string> }) {
    const args = ["workspace", "create", "--cwd", cwd, "--no-focus"];
    for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
    const j = this.json(await this.herdr(args));
    const id: string = j?.root_pane?.pane_id;
    if (!id) throw new Error(`herdr workspace create: no root pane in ${JSON.stringify(j).slice(0, 300)}`);
    let pid = 0;
    for (let i = 0; i < 20 && !pid; i++) {
      const pi = this.json(await this.herdr(["pane", "process-info", "--pane", id]).catch(() => ""));
      pid = Number(pi?.process_info?.shell_pid ?? 0);
      if (!pid) await Bun.sleep(200);
    }
    return { id, pid };
  }
  async sendText(pane: string, text: string) { await this.herdr(["pane", "send-text", pane, text]); }
  async sendKeys(pane: string, keys: string[]) {
    for (const k of keys) await this.herdr(["pane", "send-keys", pane, HERDR_KEYS[k] ?? k.toLowerCase()]);
  }
  async capture(pane: string) { return this.herdr(["pane", "read", pane, "--source", "visible", "--format", "text"]); }
  async captureAnsi(pane: string) { return this.herdr(["pane", "read", pane, "--source", "visible", "--format", "ansi"]); }
  async panes() {
    const j = this.json(await this.herdr(["pane", "list"]).catch(() => ""));
    const list: any[] = Array.isArray(j) ? j : j?.panes ?? [];
    const out: PaneInfo[] = [];
    for (const p of list) {
      const pi = this.json(await this.herdr(["pane", "process-info", "--pane", p.pane_id]).catch(() => ""));
      const fg = pi?.process_info?.foreground_processes?.[0];
      out.push({ id: p.pane_id, pid: Number(pi?.process_info?.shell_pid ?? 0), command: fg?.name ?? "", cwd: p.foreground_cwd ?? p.cwd ?? "" });
    }
    return out;
  }
  async killPane(pane: string) { await this.herdr(["pane", "close", pane]); }
  engineEnv() { return { CYC_MUX: "herdr", HERDR_SOCKET_PATH: this.sock }; }
  paneEnvVar() { return "HERDR_PANE_ID"; }
}
