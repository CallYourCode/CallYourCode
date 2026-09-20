/* The cell driver: one object a scenario drives, with the six handles the
 * design names (mux, engine, harness, fake, wire, transcript) plus the
 * given/when/then bookkeeping that turns evidence into a verdict.
 *
 *   red    a `then` failed: the engine did not do what the spec says
 *   green  every `then` held
 *   error  the bench itself could not set the scene (a `need` failed, a
 *          timeout, a crash): says nothing about the engine
 *
 * Everything a check looks at is also written under /out so a red verdict
 * points at a file, a frame or a capture, never at a log string alone. */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LoggedRequest, Script } from "../fake-model/server.ts";
import { bootEngine, stageEngineTree, type EngineProc } from "./engine-boot.ts";
import { HARNESSES, type CellPaths, type HarnessAdapter, type HarnessName, type Transcript } from "./harness.ts";
import { HerdrMux, TmuxMux, type Mux, type Pane } from "./mux.ts";
import { openWire, type Wire } from "./wire.ts";

export type Check = { name: string; ok: boolean; detail: string; ts: number; /** not judged: the scene has nothing for this check to look at */ skipped?: true };
export type Verdict = {
  cell: string; harness: string; version: string; mux: string; scenario: string;
  verdict: "green" | "red" | "error";
  reason: string;
  checks: Check[];
  /** what the cell measured, beside pass/fail: detected versions, supported flags */
  facts: Record<string, unknown>;
  artifacts: Record<string, string>;
  startedAt: string; ms: number;
};

export class NeedFailed extends Error {}

export type CellOpts = {
  id: string;
  harness: HarnessName;
  version: string;
  /** the cell's mux; `both` (scenario 10) means tmux primary plus herdr second */
  mux: "tmux" | "herdr" | "both";
  scenario: string;
  /** cell root (/cell) */
  root: string;
  /** the engine source mount (/engine), staged into <root>/repo */
  engineSrc: string;
  out: string;
  fakeUrl: string;
  enginePort: number;
  /** --host mode: an existing herdr socket, or a tmux binary override */
  herdrSocket?: string;
  tmuxBin?: string;
};

export type Agent = { id: string; dir: string; meta: any; chats: string[] };

export class Cell {
  readonly id: string;
  readonly harnessName: HarnessName;
  readonly version: string;
  readonly muxKind: "tmux" | "herdr";
  /** the matrix's mux for this cell: tmux, herdr, or both */
  get muxSpec(): "tmux" | "herdr" | "both" { return this.opts.mux; }
  readonly scenario: string;
  readonly paths: CellPaths;
  readonly fakeUrl: string;
  readonly enginePort: number;
  readonly checks: Check[] = [];
  readonly facts: Record<string, unknown> = {};
  readonly startedAt = Date.now();
  readonly logPath: string;
  private _mux: Mux | null = null;
  /** every mux started in this cell (scenario 10 runs tmux and herdr side by side) */
  readonly muxes: Mux[] = [];
  private _engine: EngineProc | null = null;
  private _wire: Wire | null = null;
  private muxN = 0;
  /** which mux owns a pane id (scenario 10 has two) */
  private paneMux = new Map<string, Mux>();
  muxOf(pane: Pane | string): Mux {
    const id = typeof pane === "string" ? pane : pane.id;
    return (typeof pane !== "string" && pane.mux) || this.paneMux.get(id) || this.mux();
  }
  private snapN = 0;
  private sink: any = null;
  readonly opts: CellOpts;

  constructor(opts: CellOpts) {
    this.opts = opts;
    this.id = opts.id;
    this.harnessName = opts.harness;
    this.version = opts.version;
    this.muxKind = opts.mux === "both" ? "tmux" : opts.mux;
    this.scenario = opts.scenario;
    this.fakeUrl = opts.fakeUrl;
    this.enginePort = opts.enginePort;
    this.paths = { home: join(opts.root, "home"), repo: join(opts.root, "repo"), work: join(opts.root, "work", "proj"), data: join(opts.root, "data"), out: opts.out };
    for (const d of [this.paths.home, this.paths.work, this.paths.out, join(opts.root, "tmux")]) mkdirSync(d, { recursive: true });
    this.logPath = join(opts.out, "scenario.log");
    writeFileSync(this.logPath, "");
  }

  /* ---------- bookkeeping ---------- */

  log(msg: string) {
    const line = `${new Date().toISOString()} ${msg}`;
    appendFileSync(this.logPath, line + "\n");
    console.log(line);
  }
  /** a `then`: the engine's behaviour against the spec */
  expect(name: string, ok: boolean, detail = ""): boolean {
    this.checks.push({ name, ok, detail, ts: Date.now() });
    this.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ": " + detail.slice(0, 600) : ""}`);
    return ok;
  }
  /** a `then` with nothing to look at in this cell (a process that this mux
   *  never spawns): recorded as skipped, never as a pass */
  skip(name: string, reason: string): void {
    this.checks.push({ name, ok: true, skipped: true, detail: `skipped: ${reason}`, ts: Date.now() });
    this.log(`[SKIP] ${name}: ${reason}`);
  }
  /** a measured fact for the verdict (no pass/fail) */
  fact(name: string, value: unknown): void {
    this.facts[name] = value;
    this.log(`[fact] ${name} = ${JSON.stringify(value)}`);
  }
  /** a `given`: the bench could set the scene; a failure is an error, not a red */
  need(name: string, ok: boolean, detail = ""): void {
    this.log(`[${ok ? "need-ok" : "NEED-FAILED"}] ${name}${detail ? ": " + detail.slice(0, 600) : ""}`);
    if (!ok) throw new NeedFailed(`${name}: ${detail.slice(0, 600)}`);
  }
  async waitFor<T>(pred: () => Promise<T | null | undefined | false> | T | null | undefined | false, opts: { ms?: number; every?: number; label?: string } = {}): Promise<T | null> {
    const deadline = Date.now() + (opts.ms ?? 15_000);
    for (;;) {
      const v = await pred();
      if (v) return v as T;
      if (Date.now() > deadline) { if (opts.label) this.log(`waitFor timed out: ${opts.label}`); return null; }
      await Bun.sleep(opts.every ?? 250);
    }
  }
  /** a pane capture written as an artifact; returns the text */
  async snap(label: string, pane?: string): Promise<string> {
    if (!this._mux) return "";
    const panes: [Mux, string][] = [];
    if (pane) panes.push([this.muxOf(pane), pane]);
    else for (const m of this.muxes) for (const p of await m.panes().catch(() => [])) panes.push([m, p.id]);
    let all = "";
    for (const [m, p] of panes) {
      const text = await m.capture(p).catch((e) => `capture failed: ${e}`);
      const ansi = await m.captureAnsi(p).catch(() => "");
      const n = String(++this.snapN).padStart(2, "0");
      const safe = p.replace(/[^a-zA-Z0-9]/g, "_");
      writeFileSync(join(this.paths.out, `pane-${n}-${label}-${safe}.txt`), text);
      if (ansi) writeFileSync(join(this.paths.out, `pane-${n}-${label}-${safe}.ansi`), ansi);
      all += text;
    }
    return all;
  }

  /* ---------- the six handles ---------- */

  mux(): Mux {
    if (!this._mux) throw new Error("mux not started; call startMux()");
    return this._mux;
  }
  engine(): EngineProc {
    if (!this._engine) throw new Error("engine not started; call startEngine()");
    return this._engine;
  }
  harness(): HarnessAdapter { return HARNESSES[this.harnessName]; }
  fake() {
    const url = this.fakeUrl;
    const logPath = join(this.paths.out, "fake-requests.jsonl");
    const requests = (): LoggedRequest[] => {
      if (!existsSync(logPath)) return [];
      return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    };
    return {
      url,
      requests,
      /** any request whose conversation carries this text (enforce-voice-reply
       *  makes a second request per delivered message, so never "the last one") */
      requestsWith: (text: string) => requests().filter((r) => r.userTexts.some((u) => u.includes(text))),
      waitRequest: (pred: (r: LoggedRequest) => boolean, ms = 20_000) => this.waitFor(() => requests().find(pred) ?? null, { ms, label: "fake request" }),
      setSlow: (slow: boolean | number) => fetch(`${url}/_control`, { method: "POST", body: JSON.stringify({ slow }) }).then((r) => r.ok),
      /** swap the script: a name under fake-model/scripts/, or an inline Script */
      setScript: (script: string | Script) => fetch(`${url}/_control`, { method: "POST", body: JSON.stringify({ script }) }).then((r) => r.ok),
      health: () => fetch(`${url}/_control/health`).then((r) => r.ok).catch(() => false),
    };
  }
  async wire(): Promise<Wire> {
    if (!this._wire) this._wire = await openWire(this.engine(), join(this.paths.out, "wire-frames.jsonl"));
    return this._wire;
  }
  transcript(cwd = this.paths.work): Promise<Transcript[]> { return this.harness().transcripts(this.paths, cwd); }

  /* ---------- the scene ---------- */

  /** start the cell's mux (or, with `kind`, an extra one of the other kind);
   *  the first one started is the primary the engine is pointed at */
  async startMux(kind: "tmux" | "herdr" = this.muxKind): Promise<Mux> {
    const n = ++this.muxN;
    let m: Mux;
    if (kind === "tmux") {
      m = new TmuxMux({ socket: n === 1 ? "cell" : `cell${n}`, tmpdir: join(this.opts.root, "tmux"), cwd: this.paths.work, tmuxBin: this.opts.tmuxBin });
    } else {
      m = new HerdrMux({ home: this.paths.home, session: n === 1 ? "cell" : `cell${n}`, cwd: this.paths.work, socketPath: this.opts.herdrSocket });
    }
    await m.start();
    if (!this._mux) this._mux = m;
    this.muxes.push(m);
    this.log(`mux ${kind} started (${n})`);
    return m;
  }
  async stopMux() {
    for (const m of this.muxes.splice(0)) await m.stop().catch(() => {});
    if (this._mux) { this._mux = null; this.log("mux stopped"); }
  }
  /** SIGKILL the harness process(es) under a pane's shell; the pane stays */
  async killHarnessProcess(pane: Pane | string): Promise<number[]> {
    const id = typeof pane === "string" ? pane : pane.id;
    const info = (await this.muxOf(pane).panes()).find((p) => p.id === id);
    if (!info) throw new Error(`no pane ${id}`);
    const kids = this.procs().filter((p) => p.ppid === info.pid).map((p) => p.pid);
    for (const k of kids) { try { process.kill(k, "SIGKILL"); } catch { /* gone */ } }
    this.log(`pane ${id}: killed harness pid(s) ${kids.join(",") || "none"} under shell ${info.pid}`);
    return kids;
  }
  /** the cell's process table: pid, ppid, args */
  procs(): { pid: number; ppid: number; args: string }[] {
    const out = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,args=", "--width", "300"]).stdout.toString();
    return out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: Number(m![1]), ppid: Number(m![2]), args: m![3] }));
  }

  /** install the harness's config + cyc integration into the cell home */
  async installHarness() {
    stageEngineTree({ from: this.opts.engineSrc, to: this.paths.repo });
    await this.harness().install(this.paths, this.fakeUrl);
    this.log(`harness ${this.harnessName} ${this.version} installed into ${this.paths.home}`);
  }

  /** every started mux's env (sockets, tmpdirs), the primary's CYC_MUX winning */
  engineEnv(extra: Record<string, string> = {}): Record<string, string> {
    let env: Record<string, string> = {};
    for (const m of [...this.muxes].reverse()) env = { ...env, ...m.engineEnv() };
    return { ...env, ...this.harness().engineEnv(this.paths), CYC_HARNESS: this.harnessName, ...extra };
  }
  async startEngine(opts: { keepData?: boolean; env?: Record<string, string> } = {}): Promise<EngineProc> {
    if (this._wire) { this._wire.close(); this._wire = null; }
    const e = await bootEngine({
      root: this.opts.root, port: this.enginePort, env: this.engineEnv(opts.env), keepData: opts.keepData,
      logPath: join(this.paths.out, "engine.log"), sink: this.sink ?? undefined,
    });
    this._engine = e;
    this.log(`engine started pid ${e.pid} port ${e.port} data ${e.dataDir}`);
    return e;
  }
  async stopEngine(graceMs?: number) { if (this._engine) { await this._engine.stop(graceMs); this.log("engine stopped"); } if (this._wire) { this._wire.close(); this._wire = null; } }
  async killEngine() { if (this._engine) { await this._engine.kill(); this.log("engine killed"); } if (this._wire) { this._wire.close(); this._wire = null; } }

  /** a pane with the harness's env, in the work dir (or another cwd) */
  async openPane(opts: { cwd?: string; env?: Record<string, string>; mux?: Mux } = {}): Promise<Pane> {
    const cwd = opts.cwd ?? this.paths.work;
    mkdirSync(cwd, { recursive: true });
    const env = { ...this.harness().paneEnv(this.paths, this.fakeUrl, this.enginePort), ...(opts.env ?? {}) };
    const m = opts.mux ?? this.mux();
    const pane: Pane = { ...(await m.newPane({ cwd, env })), mux: m };
    this.paneMux.set(pane.id, m);
    this.log(`pane ${pane.id} (pid ${pane.pid}) opened in ${cwd}`);
    return pane;
  }
  /** type the harness's launch line and wait for its prompt */
  async launch(pane: Pane | string, opts: { resume?: string; extra?: string; readyMs?: number } = {}): Promise<string> {
    const id = typeof pane === "string" ? pane : pane.id;
    const cmd = this.harness().launch(opts);
    await this.muxOf(pane).sendText(id, cmd);
    await this.muxOf(pane).sendKeys(id, ["Enter"]);
    this.log(`pane ${id}: $ ${cmd}`);
    const ready = await this.waitReady(id, opts.readyMs);
    this.need(`${this.harnessName} shows its prompt in ${id}`, ready !== null, ready === null ? (await this.snap("not-ready", id)).slice(-1500) : "");
    return ready!;
  }
  async waitReady(pane: string, ms = 45_000): Promise<string | null> {
    const re = this.harness().ready;
    const m = this.muxOf(pane);
    return this.waitFor(async () => { const t = await m.capture(pane).catch(() => ""); return re.test(t) ? t : null; }, { ms, every: 500, label: "harness ready" });
  }
  /** what the person types at the harness: text, a beat, Enter */
  async type(pane: Pane | string, text: string) {
    const id = typeof pane === "string" ? pane : pane.id;
    await this.muxOf(pane).sendText(id, text);
    await Bun.sleep(300);
    await this.muxOf(pane).sendKeys(id, ["Enter"]);
    this.log(`pane ${id}: typed ${JSON.stringify(text)}`);
  }
  /** wait until the pane shows text matching re */
  async waitScreen(pane: string, re: RegExp, ms = 30_000): Promise<string | null> {
    const m = this.muxOf(pane);
    return this.waitFor(async () => { const t = await m.capture(pane).catch(() => ""); return re.test(t) ? t : null; }, { ms, every: 400, label: `screen ${re}` });
  }
  /** quit the harness in a pane the way a person would */
  async quitHarness(pane: string) {
    for (const k of this.harness().quit) { await this.muxOf(pane).sendKeys(pane, [k]); await Bun.sleep(400); }
  }

  /* ---------- evidence readers ---------- */

  agents(): Agent[] {
    const dir = join(this.paths.data, "agents");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((d) => existsSync(join(dir, d, "meta.json"))).map((d) => {
      let meta: any = null;
      try { meta = JSON.parse(readFileSync(join(dir, d, "meta.json"), "utf8")); } catch { /* partial */ }
      const chats = existsSync(join(dir, d, "chats")) ? readdirSync(join(dir, d, "chats")) : [];
      return { id: d, dir: join(dir, d), meta, chats };
    });
  }
  state(name: string): any {
    const f = join(this.paths.data, "state", `${name}.json`);
    if (!existsSync(f)) return null;
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  }
  chatLog(agentId: string): any[] {
    const a = this.agents().find((x) => x.id === agentId);
    if (!a) return [];
    const rows: any[] = [];
    for (const c of a.chats) for (const l of readFileSync(join(a.dir, "chats", c), "utf8").split("\n")) { if (l.trim()) { try { rows.push(JSON.parse(l)); } catch { /* partial */ } } }
    return rows;
  }
  engineLog(): string[] { return this._engine?.lines ?? []; }

  /* ---------- the end ---------- */

  async collect(): Promise<Record<string, string>> {
    const out = this.paths.out;
    const art: Record<string, string> = {};
    const put = (k: string, rel: string) => { if (existsSync(join(out, rel))) art[k] = rel; };
    await this.snap("final").catch(() => {});
    try { await this.harness().saveStore(this.paths); } catch (e) { this.log(`saveStore: ${e}`); }
    try {
      const dst = join(out, "data");
      rmSync(dst, { recursive: true, force: true });
      if (existsSync(this.paths.data)) Bun.spawnSync(["cp", "-R", this.paths.data, dst]);
    } catch { /* fine */ }
    this.muxes.forEach((m, i) => writeFileSync(join(out, `${m.kind}${i ? i + 1 : ""}.log`), m.log.join("\n") + "\n"));
    for (const f of ["install-claude.log", "install-codex.log", "install-opencode.log"]) { try { if (existsSync(join(this.paths.out, f))) copyFileSync(join(this.paths.out, f), join(out, f)); } catch { /* same file */ } }
    put("engine_log", "engine.log"); put("wire_frames", "wire-frames.jsonl"); put("fake_requests", "fake-requests.jsonl");
    put("scenario_log", "scenario.log"); put("transcripts", "transcripts"); put("data", "data"); put("mux_log", `${this.muxKind}.log`);
    const panes = readdirSync(out).filter((f) => f.startsWith("pane-") && f.endsWith(".txt"));
    if (panes.length) art.pane_captures = panes.join(",");
    return art;
  }
  verdict(err?: unknown, artifacts: Record<string, string> = {}): Verdict {
    const failed = this.checks.filter((c) => !c.ok);
    let verdict: Verdict["verdict"];
    let reason: string;
    if (err instanceof NeedFailed) { verdict = "error"; reason = `bench could not set the scene: ${err.message}`; }
    else if (err) { verdict = "error"; reason = `scenario threw: ${String((err as any)?.stack ?? err).slice(0, 800)}`; }
    else if (failed.length) { verdict = "red"; reason = `${failed[0].name}${failed[0].detail ? ": " + failed[0].detail.slice(0, 300) : ""}`; }
    else if (!this.checks.some((c) => !c.skipped)) { verdict = "error"; reason = this.checks.length ? "every check was skipped" : "scenario recorded no checks"; }
    else {
      const skipped = this.checks.filter((c) => c.skipped).length;
      verdict = "green"; reason = `${this.checks.length - skipped} checks held${skipped ? `, ${skipped} skipped` : ""}`;
    }
    return {
      cell: this.id, harness: this.harnessName, version: this.version, mux: this.opts.mux, scenario: this.scenario,
      verdict, reason, checks: this.checks, facts: this.facts, artifacts, startedAt: new Date(this.startedAt).toISOString(), ms: Date.now() - this.startedAt,
    };
  }
  async teardown() {
    if (this._wire) { this._wire.close(); this._wire = null; }
    if (this._engine) await this._engine.kill().catch(() => {});
    await this.stopMux();
  }
}
