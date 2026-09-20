/* Per-harness adapters: how each real harness is configured against the fake
 * model inside the cell, launched in a pane, told to start a new session,
 * and how its own store is read back as normalized transcripts.
 *
 * Nothing here talks to the engine. The engine sees the harness the way it
 * sees a person's: through the mux, the announce hook and the store files. */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

export type HarnessName = "claude" | "codex" | "opencode" | "pi";

export type Transcript = {
  /** the harness session id */
  id: string;
  path: string;
  cwd: string;
  mtimeMs: number;
  bytes: number;
  userTexts: string[];
  assistantTexts: string[];
  /** the same texts in the order the harness wrote them */
  turns: { role: "user" | "assistant"; text: string }[];
};

/** collect a transcript's texts, in order, into the three views */
function turnsCollector() {
  const users: string[] = [];
  const assistants: string[] = [];
  const turns: Transcript["turns"] = [];
  return {
    users, assistants, turns,
    user(text: string) { users.push(text); turns.push({ role: "user", text }); },
    assistant(text: string) { assistants.push(text); turns.push({ role: "assistant", text }); },
  };
}

export type CellPaths = { home: string; repo: string; work: string; data: string; out: string };

/** every cwd a scenario may open a pane in (scenario 5 C uses a second one);
 *  each is pre-trusted at install so no trust dialog blocks the prompt */
export const workDirs = (p: CellPaths): string[] => [p.work, `${p.work}2`];

export interface HarnessAdapter {
  readonly name: HarnessName;
  /** env for the pane's shell (homes, fake model, engine port) */
  paneEnv(p: CellPaths, fakeUrl: string, enginePort: number): Record<string, string>;
  /** env the engine needs to read this harness's store */
  engineEnv(p: CellPaths): Record<string, string>;
  /** write provider config + the cyc integration into the cell home */
  install(p: CellPaths, fakeUrl: string): Promise<void>;
  /** the shell line that starts the harness in the pane */
  launch(opts?: { resume?: string; extra?: string }): string;
  /** a headless one-shot run of the same harness (the nested child of scenario 12) */
  headless(prompt: string): string;
  /** the screen shows the prompt box */
  ready: RegExp;
  /** a slash command (typed, then Enter) that rolls the session id in place */
  newSessionCommand: string | null;
  /** keys that quit the harness from the prompt */
  quit: string[];
  transcripts(p: CellPaths, cwd: string): Promise<Transcript[]>;
  /** copy the store into the artifacts dir */
  saveStore(p: CellPaths): Promise<string[]>;
}

function readJsonl(path: string): any[] {
  const out: any[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial last line */ }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (p && typeof p.text === "string" && (p.type === "text" || p.type === "input_text" || p.type === "output_text" || !p.type)) ? p.text : "").filter(Boolean).join("\n");
  }
  return "";
}

function walk(dir: string, filter: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
}

function copyTree(from: string, to: string): string[] {
  const files = walk(from, () => true);
  for (const f of files) {
    const rel = f.slice(from.length + 1);
    mkdirSync(join(to, rel, ".."), { recursive: true });
    try { copyFileSync(f, join(to, rel)); } catch { /* live file */ }
  }
  return files;
}

async function runInstaller(p: CellPaths, harness: string): Promise<void> {
  const proc = Bun.spawn(["bun", join(p.repo, "scripts", "harness-integration.ts"), harness], {
    env: { ...(process.env as Record<string, string>), CYC_HOME: p.home, HOME: p.home },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  mkdirSync(p.out, { recursive: true });
  writeFileSync(join(p.out, `install-${harness}.log`), out + err);
  if (code !== 0) throw new Error(`harness-integration ${harness} failed: ${err.slice(0, 500)}`);
}

/* The key strings below are deliberately NOT key-shaped (no "sk-" prefix):
 * the image tripwire greps for that, and these are dummies anyway. */
const DUMMY_KEY = "cyc-testbench-dummy-key";

/* ---------------- claude ---------------- */

export const claude: HarnessAdapter = {
  name: "claude",
  paneEnv(p, fakeUrl, enginePort) {
    return {
      HOME: p.home,
      CLAUDE_CONFIG_DIR: join(p.home, ".claude"),
      ANTHROPIC_BASE_URL: fakeUrl,
      ANTHROPIC_API_KEY: DUMMY_KEY,
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_SMALL_FAST_MODEL: "claude-sonnet-4-5",
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DO_NOT_TRACK: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      AGENT_PORT: String(enginePort),
      VOICE_ENGINE_URL: `ws://127.0.0.1:${enginePort}/ws`,
      CYC_DATA_DIR: p.data,
    };
  },
  engineEnv(p) { return { CYC_PROJECTS_DIR: join(p.home, ".claude", "projects") }; },
  async install(p, _fakeUrl) {
    mkdirSync(join(p.home, ".claude"), { recursive: true });
    /* first-run answers, so the TUI opens on the prompt: onboarding done,
     * this folder trusted, the dummy api key approved */
    const cfg = join(p.home, ".claude.json");
    const base = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
    Object.assign(base, {
      hasCompletedOnboarding: true,
      theme: "dark",
      numStartups: 5,
      autoUpdates: false,
      customApiKeyResponses: { approved: [DUMMY_KEY.slice(-20)], rejected: [] },
      projects: { ...(base.projects ?? {}), ...Object.fromEntries(workDirs(p).map((d) => [d, { allowedTools: [], hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])) },
    });
    writeFileSync(cfg, JSON.stringify(base, null, 2));
    /* tool calls run unprompted (scenario 12): the cell is the sandbox */
    const settings = join(p.home, ".claude", "settings.json");
    const st = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
    st.permissions = { ...(st.permissions ?? {}), allow: Array.from(new Set([...(st.permissions?.allow ?? []), "Bash"])) };
    writeFileSync(settings, JSON.stringify(st, null, 2));
    await runInstaller(p, "claude");
    /* with CLAUDE_CONFIG_DIR set, claude reads .claude.json from that dir */
    copyFileSync(cfg, join(p.home, ".claude", ".claude.json"));
  },
  launch(opts = {}) {
    return `claude${opts.resume ? ` --resume ${opts.resume}` : ""}${opts.extra ? " " + opts.extra : ""}`;
  },
  headless(prompt) { return `claude -p ${JSON.stringify(prompt)}`; },
  ready: /\? for shortcuts|Try "|^\s*[>❯]\s*$|╰/m,
  newSessionCommand: "/clear",
  quit: ["C-c", "C-c"],
  async transcripts(p, cwd) {
    const dir = join(p.home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
    const out: Transcript[] = [];
    for (const f of walk(dir, (x) => x.endsWith(".jsonl"))) {
      const rows = readJsonl(f);
      const st = statSync(f);
      const k = turnsCollector();
      let id = "";
      for (const r of rows) {
        if (r.sessionId && !id) id = r.sessionId;
        if (r.type === "user" && !r.isMeta) {
          const c = r.message?.content;
          const isToolResult = Array.isArray(c) && c.every((x: any) => x?.type === "tool_result");
          if (!isToolResult) { const t = textOf(c); if (t) k.user(t); }
        }
        if (r.type === "assistant") { const t = textOf(r.message?.content); if (t) k.assistant(t); }
      }
      out.push({ id: id || f.split("/").pop()!.replace(".jsonl", ""), path: f, cwd, mtimeMs: st.mtimeMs, bytes: st.size, userTexts: k.users, assistantTexts: k.assistants, turns: k.turns });
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },
  async saveStore(p) { return copyTree(join(p.home, ".claude", "projects"), join(p.out, "transcripts", "claude")); },
};

/* ---------------- codex ---------------- */

export const codex: HarnessAdapter = {
  name: "codex",
  paneEnv(p, _fakeUrl, enginePort) {
    return {
      HOME: p.home,
      CODEX_HOME: join(p.home, ".codex"),
      FAKE_API_KEY: DUMMY_KEY,
      AGENT_PORT: String(enginePort),
      VOICE_ENGINE_URL: `ws://127.0.0.1:${enginePort}/ws`,
      CYC_DATA_DIR: p.data,
    };
  },
  engineEnv(p) { return { CODEX_HOME: join(p.home, ".codex") }; },
  async install(p, fakeUrl) {
    const home = join(p.home, ".codex");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.toml"), [
      `model = "fake-1"`,
      `model_provider = "fake"`,
      `approval_policy = "never"`,
      `sandbox_mode = "danger-full-access"`,
      `check_for_update_on_startup = false`,
      ``,
      `[model_providers.fake]`,
      `name = "fake"`,
      `base_url = "${fakeUrl}/v1"`,
      `env_key = "FAKE_API_KEY"`,
      `wire_api = "responses"`,
      `request_max_retries = 0`,
      `stream_max_retries = 0`,
      ``,
      ...workDirs(p).flatMap((d) => [`[projects."${d}"]`, `trust_level = "trusted"`, ``]),
    ].join("\n"));
    await runInstaller(p, "codex");
  },
  launch(opts = {}) {
    /* hooks.json needs a trust hash or this flag; the cell passes the flag */
    return `codex --dangerously-bypass-hook-trust${opts.resume ? ` resume ${opts.resume}` : ""}${opts.extra ? " " + opts.extra : ""}`;
  },
  headless(prompt) { return `codex exec --dangerously-bypass-hook-trust --skip-git-repo-check ${JSON.stringify(prompt)}`; },
  ready: /Ask Codex|\? for shortcuts|to send/m,
  newSessionCommand: "/new",
  quit: ["C-c", "C-c"],
  async transcripts(p, cwd) {
    const dir = join(p.home, ".codex", "sessions");
    const out: Transcript[] = [];
    for (const f of walk(dir, (x) => /rollout-.*\.jsonl$/.test(x))) {
      const rows = readJsonl(f);
      const st = statSync(f);
      const meta = rows.find((r) => r.type === "session_meta")?.payload ?? {};
      if (meta.cwd && meta.cwd !== cwd) continue;
      const k = turnsCollector();
      /* 0.148 writes a user turn as response_item {role:"user"} (input_text),
       * older rollouts as event_msg user_message; the environment_context
       * preamble is role user too and is not something the person typed */
      for (const r of rows) {
        if (r.type === "event_msg" && r.payload?.type === "user_message" && typeof r.payload.message === "string") k.user(r.payload.message);
        else if (r.type === "response_item" && r.payload?.type === "message") {
          const t = textOf(r.payload.content);
          if (!t) continue;
          if (r.payload.role === "assistant") k.assistant(t);
          else if (r.payload.role === "user" && !/^<environment_context>/.test(t.trim())) k.user(t);
        }
      }
      out.push({ id: meta.id ?? f.replace(/.*rollout-[^-]+-/, "").replace(".jsonl", ""), path: f, cwd: meta.cwd ?? cwd, mtimeMs: st.mtimeMs, bytes: st.size, userTexts: k.users, assistantTexts: k.assistants, turns: k.turns });
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },
  async saveStore(p) { return copyTree(join(p.home, ".codex", "sessions"), join(p.out, "transcripts", "codex")); },
};

/* ---------------- opencode ---------------- */

export const opencode: HarnessAdapter = {
  name: "opencode",
  paneEnv(p, _fakeUrl, enginePort) {
    return {
      HOME: p.home,
      XDG_CONFIG_HOME: join(p.home, ".config"),
      XDG_DATA_HOME: join(p.home, ".local", "share"),
      XDG_STATE_HOME: join(p.home, ".local", "state"),
      XDG_CACHE_HOME: join(p.home, ".cache"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      AGENT_PORT: String(enginePort),
      VOICE_ENGINE_URL: `ws://127.0.0.1:${enginePort}/ws`,
      CYC_DATA_DIR: p.data,
    };
  },
  engineEnv(p) {
    return { XDG_DATA_HOME: join(p.home, ".local", "share"), OPENCODE_DB: join(p.home, ".local", "share", "opencode", "opencode.db") };
  },
  async install(p, fakeUrl) {
    const dir = join(p.home, ".config", "opencode");
    mkdirSync(dir, { recursive: true });
    const cfg = join(dir, "opencode.json");
    const base = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : {};
    Object.assign(base, {
      $schema: "https://opencode.ai/config.json",
      autoupdate: false,
      model: "fake/fake-model",
      /* tool calls run unprompted (scenario 12): the cell is the sandbox */
      permission: { ...(base.permission ?? {}), bash: "allow" },
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible", name: "fake",
          options: { baseURL: `${fakeUrl}/v1`, apiKey: DUMMY_KEY },
          models: { "fake-model": { name: "fake", limit: { context: 128000, output: 8192 } } },
        },
      },
    });
    writeFileSync(cfg, JSON.stringify(base, null, 2));
    await runInstaller(p, "opencode");
  },
  launch(opts = {}) {
    return `opencode -m fake/fake-model${opts.resume ? ` -s ${opts.resume}` : ""}${opts.extra ? " " + opts.extra : ""}`;
  },
  headless(prompt) { return `opencode run -m fake/fake-model ${JSON.stringify(prompt)}`; },
  /* the TUI's own chrome only: the typed launch line also says "opencode" */
  ready: /Ask anything|ctrl\+p commands|tab agents|Ctrl\+X/m,
  newSessionCommand: "/new",
  quit: ["C-c", "C-c"],
  async transcripts(p, cwd) {
    const db = join(p.home, ".local", "share", "opencode", "opencode.db");
    if (!existsSync(db)) return [];
    const { Database } = await import("bun:sqlite");
    const d = new Database(db, { readonly: true });
    const out: Transcript[] = [];
    try {
      const sessions = d.query("select id, directory, time_created, time_updated from session").all() as any[];
      for (const s of sessions) {
        if (s.directory && s.directory !== cwd) continue;
        const msgs = d.query("select id, data from message where session_id = ? order by time_created asc").all(s.id) as any[];
        const k = turnsCollector();
        for (const m of msgs) {
          let data: any = {};
          try { data = JSON.parse(m.data); } catch { /* raw */ }
          const parts = d.query("select data from part where message_id = ? order by time_created asc").all(m.id) as any[];
          const text = parts.map((pt) => { try { const j = JSON.parse(pt.data); return j.type === "text" ? j.text : ""; } catch { return ""; } }).filter(Boolean).join("\n");
          if (!text) continue;
          if (data.role === "user") k.user(text); else if (data.role === "assistant") k.assistant(text);
        }
        out.push({ id: s.id, path: db, cwd: s.directory ?? cwd, mtimeMs: Number(s.time_updated ?? s.time_created ?? 0), bytes: 0, userTexts: k.users, assistantTexts: k.assistants, turns: k.turns });
      }
    } finally { d.close(); }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },
  async saveStore(p) { return copyTree(join(p.home, ".local", "share", "opencode"), join(p.out, "transcripts", "opencode")); },
};

/* ---------------- pi ---------------- */

export const pi: HarnessAdapter = {
  name: "pi",
  paneEnv(p, _fakeUrl, enginePort) {
    return {
      HOME: p.home,
      PI_CODING_AGENT_DIR: join(p.home, ".pi", "agent"),
      PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_OFFLINE: "1",
      AGENT_PORT: String(enginePort),
      VOICE_ENGINE_URL: `ws://127.0.0.1:${enginePort}/ws`,
      CYC_DATA_DIR: p.data,
    };
  },
  engineEnv(p) { return { PI_CODING_AGENT_DIR: join(p.home, ".pi", "agent") }; },
  async install(p, fakeUrl) {
    const dir = join(p.home, ".pi", "agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "models.json"), JSON.stringify({
      providers: {
        fake: {
          baseUrl: `${fakeUrl}/v1`, api: "openai-completions", apiKey: DUMMY_KEY,
          models: [{ id: "fake-model", name: "fake", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }, null, 2));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-model", theme: "dark" }, null, 2));
    /* no cyc integration exists for pi today (research-harnesses 4); nothing to install */
  },
  launch(opts = {}) {
    return `pi --model fake/fake-model${opts.resume ? ` --session ${opts.resume}` : ""}${opts.extra ? " " + opts.extra : ""}`;
  },
  headless(prompt) { return `pi --model fake/fake-model -p ${JSON.stringify(prompt)}`; },
  /* the TUI's help line, not the typed launch line */
  ready: /ctrl\+o more|\/ commands · ! bash|\/ for commands/m,
  newSessionCommand: "/new",
  quit: ["C-c", "C-c"],
  async transcripts(p, cwd) {
    const dir = join(p.home, ".pi", "agent", "sessions");
    const out: Transcript[] = [];
    for (const f of walk(dir, (x) => x.endsWith(".jsonl"))) {
      const rows = readJsonl(f);
      const st = statSync(f);
      const head = rows.find((r) => r.type === "session") ?? {};
      if (head.cwd && head.cwd !== cwd) continue;
      const k = turnsCollector();
      for (const r of rows) {
        if (r.type !== "message") continue;
        const m = r.message ?? {};
        const t = textOf(m.content);
        if (!t) continue;
        if (m.role === "user") k.user(t); else if (m.role === "assistant") k.assistant(t);
      }
      out.push({ id: head.id ?? f.replace(/.*_/, "").replace(".jsonl", ""), path: f, cwd: head.cwd ?? cwd, mtimeMs: st.mtimeMs, bytes: st.size, userTexts: k.users, assistantTexts: k.assistants, turns: k.turns });
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  },
  async saveStore(p) { return copyTree(join(p.home, ".pi", "agent", "sessions"), join(p.out, "transcripts", "pi")); },
};

export const HARNESSES: Record<HarnessName, HarnessAdapter> = { claude, codex, opencode, pi };
