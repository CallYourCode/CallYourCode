/* Per-agent transcript readers (agents.ts TranscriptSupport). Slice 1 left
 * this table unwired; this module is the wiring. Claude wraps session-events.ts
 * so its numbers stay the ones that module already computes. pi/codex/opencode
 * each read their own on-disk format and answer null where the file cannot.
 * Context FAILS OPEN (2026-09-02): tokens come off the harness's own record and
 * the window is the harness's reported one where it writes one (codex), else
 * `contextWindowFor(model)`, the 1M default. Null only when there is no usage
 * record to read at all. */

import { join, normalize } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync, type Dirent } from "node:fs";
import type { AgentSessionRef } from "../runtime/agents.ts";
import { streamLinesForward } from "../sessions/session-events.ts";
import { claudeReader, contextWindowFor } from "../readers/claude.ts";

/** What the engine can read from an agent's transcript, when it can (moved from
 *  agents.ts: the profile's transcript field becomes a reader method). */
export type TranscriptSupport = {
  locate(ref: AgentSessionRef | null, cwd: string): { sessionId: string; path: string } | null;
  turnEdge(line: string): "working" | "idle" | null;
  contextPct(path: string): Promise<number | null>;
  model(path: string): Promise<string | null>;
  messages?(path: string): Promise<Array<{ role: "user" | "claude"; text: string; ts: number }>>;
};

export type TranscriptMessage = {
  role: "user" | "claude";
  text: string;
  ts: number;
};

const TEXT_CAP = 2000;

function firstText(raw: string): string {
  const t = raw.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) + "…" : t;
}

function pctUsed(tokens: number, window: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((tokens / window) * 100)));
}

function underRoot(path: string, root: string): boolean {
  const n = normalize(path);
  const r = normalize(root);
  return n === r || n.startsWith(r + "/");
}

function parseJson(line: string): any | null {
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

async function eachLine(path: string, onLine: (line: string) => void): Promise<void> {
  const f = Bun.file(path);
  if (!(await f.exists())) return;
  await streamLinesForward(f, 0, f.size, onLine);
}

function refId(ref: AgentSessionRef | null): string | null {
  const id = (ref?.id ?? "").trim();
  return id || null;
}

function newestMatch(dir: string, test: (name: string) => boolean): string | null {
  let best: { path: string; mtime: number } | null = null;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  for (const name of entries) {
    if (!test(name)) continue;
    const path = join(dir, name);
    let mtime = 0;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

function walkFiles(dir: string, acc: string[], depth = 0): void {
  if (depth > 6) return;
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, acc, depth + 1);
    else acc.push(p);
  }
}

/* ------------------------------------------------- claude
 *
 * CLAUDE_TRANSCRIPT is the claude HarnessReader's locate/edge/model/messages
 * (readers/claude.ts), so the numbers stay the ones session-events.ts already
 * computes. */

export const CLAUDE_TRANSCRIPT: TranscriptSupport = {
  locate: claudeReader.locate,
  turnEdge: claudeReader.turnEdge,
  contextPct: claudeReader.contextPct,
  model: claudeReader.model,
  messages: claudeReader.messages,
};

/* ------------------------------------------------- pi
 *
 * ~/.pi/agent/sessions/--{cwd with / turned into -}--/{iso}_{sessionId}.jsonl
 * Grok and the other pi models write this same file. */

export function piSessionsRoot(): string {
  if (process.env.PI_SESSIONS_DIR) return process.env.PI_SESSIONS_DIR;
  const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agent, "sessions");
}

export function encodePiCwd(cwd: string): string {
  const resolved = cwd.replace(/\\/g, "/");
  return `--${resolved.replace(/^[/]/, "").replace(/[/:]/g, "-")}--`;
}

function piLocate(ref: AgentSessionRef | null, cwd: string): { sessionId: string; path: string } | null {
  const root = piSessionsRoot();
  if (ref?.kind === "path") {
    const path = normalize(ref.id);
    if (!underRoot(path, root) && !process.env.PI_SESSIONS_DIR) return null;
    const m = path.match(/_([0-9a-fA-F-]{8,64})\.jsonl$/);
    return { sessionId: m?.[1] ?? ref.id, path };
  }
  const id = refId(ref);
  const encoded = encodePiCwd(cwd);
  const dir = join(root, encoded);
  if (id) {
    const hit = newestMatch(dir, (n) => n.endsWith(`_${id}.jsonl`));
    if (hit) return { sessionId: id, path: hit };
    const all: string[] = [];
    walkFiles(root, all);
    const found = all.find((p) => p.endsWith(`_${id}.jsonl`));
    if (found) return { sessionId: id, path: found };
    return null;
  }
  const newest = newestMatch(dir, (n) => n.endsWith(".jsonl"));
  if (!newest) return null;
  const m = newest.match(/_([0-9a-fA-F-]{8,64})\.jsonl$/);
  return { sessionId: m?.[1] ?? "pi", path: newest };
}

function piText(content: unknown): string {
  if (typeof content === "string") return firstText(content);
  if (!Array.isArray(content)) return "";
  const bits: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") bits.push(b.text);
  }
  return firstText(bits.join("\n"));
}

export const PI_TRANSCRIPT: TranscriptSupport = {
  locate: piLocate,
  turnEdge(line) {
    const rec = parseJson(line);
    if (!rec || rec.type !== "message") return null;
    const role = rec.message?.role;
    if (role === "user") return "working";
    if (role !== "assistant") return null;
    const stop = rec.message?.stopReason;
    if (stop === "toolUse") return "working";
    if (stop === "stop" || stop === "error" || stop === "length") return "idle";
    return "working";
  },
  /* THE NEWEST ASSISTANT MESSAGE'S USAGE, read off the fixture shape
   * (fixtures/pi-session.jsonl): `message.usage` carries `input`, `cacheRead`,
   * `cacheWrite`, `output`, `reasoning`, `totalTokens`. What was IN CONTEXT for
   * that request is input + cacheRead + cacheWrite, the same three-way sum the
   * claude reader makes (output is what the model wrote, counted next turn).
   * pi writes no context window into the session file (none in the fixture, none
   * in testbench/), so the window is `contextWindowFor(model)`: the 1M default
   * since 2026-09-02 (fail open), the newest model_change/assistant model as the
   * key. No assistant turn yet answers null. */
  async contextPct(path) {
    let tokens = 0;
    let model = "";
    await eachLine(path, (line) => {
      const rec = parseJson(line);
      if (!rec) return;
      if (rec.type === "model_change" && typeof rec.modelId === "string" && rec.modelId) model = rec.modelId;
      const m = rec.message;
      if (rec.type !== "message" || m?.role !== "assistant") return;
      if (typeof m.model === "string" && m.model) model = m.model;
      const u = m.usage;
      if (!u || typeof u !== "object") return;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
      const t = n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
      if (t > 0) tokens = t;
    });
    return pctUsed(tokens, contextWindowFor(model));
  },
  async model(path) {
    let model: string | null = null;
    await eachLine(path, (line) => {
      const rec = parseJson(line);
      if (!rec) return;
      if (rec.type === "model_change" && typeof rec.modelId === "string" && rec.modelId) {
        model = rec.modelId;
      }
      const m = rec.message;
      if (rec.type === "message" && m?.role === "assistant" && typeof m.model === "string" && m.model) {
        model = m.model;
      }
    });
    return model;
  },
  async messages(path) {
    const out: TranscriptMessage[] = [];
    await eachLine(path, (line) => {
      const rec = parseJson(line);
      if (!rec || rec.type !== "message") return;
      const m = rec.message;
      if (!m || (m.role !== "user" && m.role !== "assistant")) return;
      const text = piText(m.content);
      if (!text) return;
      const ts = Date.parse(rec.timestamp ?? "") || Number(m.timestamp) || 0;
      out.push({ role: m.role === "user" ? "user" : "claude", text, ts });
    });
    return out;
  },
};

/* ------------------------------------------------- codex
 *
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-...-{sessionId}.jsonl */

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function codexLocate(ref: AgentSessionRef | null, _cwd: string): { sessionId: string; path: string } | null {
  const home = codexHome();
  const sessions = join(home, "sessions");
  if (ref?.kind === "path") {
    const path = normalize(ref.id);
    if (!underRoot(path, home) && !process.env.CODEX_HOME) return null;
    const m = path.match(/([0-9a-fA-F-]{8,64})\.jsonl$/);
    return { sessionId: m?.[1] ?? ref.id, path };
  }
  const id = refId(ref);
  if (!id) return null;
  const all: string[] = [];
  walkFiles(sessions, all);
  const found = all.find((p) => p.endsWith(".jsonl") && p.includes(id));
  return found ? { sessionId: id, path: found } : null;
}

function isCodexHarnessText(text: string): boolean {
  const t = text.trim();
  return t.startsWith("<recommended_plugins>") || t.startsWith("<environment_context>") ||
    t.startsWith("<skills_instructions>") || t.startsWith("<multi_agent_mode>");
}

export const CODEX_TRANSCRIPT: TranscriptSupport = {
  locate: codexLocate,
  turnEdge(line) {
    const rec = parseJson(line);
    if (!rec) return null;
    if (rec.type === "event_msg") {
      const t = rec.payload?.type;
      if (t === "task_started" || t === "user_message") return "working";
      if (t === "task_complete") return "idle";
      return null;
    }
    return null;
  },
  /* Codex REPORTS its window (`model_context_window` on task_started and on
   * token_count.info), and that reported number wins. A transcript that has not
   * written one yet falls back to `contextWindowFor(model)` (the 1M default
   * since 2026-09-02, fail open) rather than answering null. */
  async contextPct(path) {
    let tokens = 0;
    let window = 0;
    let model = "";
    await eachLine(path, (line) => {
      const rec = parseJson(line);
      if (!rec) return;
      if (rec.type === "turn_context" && typeof rec.payload?.model === "string") model = rec.payload.model;
      if (rec.type !== "event_msg") return;
      const p = rec.payload;
      if (p?.type === "task_started" && typeof p.model_context_window === "number") {
        window = p.model_context_window;
      }
      if (p?.type === "token_count") {
        const n = p.info?.total_token_usage?.total_tokens ?? p.info?.last_token_usage?.total_tokens;
        const w = p.info?.model_context_window;
        if (typeof n === "number") tokens = n;
        if (typeof w === "number") window = w;
      }
    });
    return pctUsed(tokens, window > 0 ? window : contextWindowFor(model));
  },
  async model(path) {
    let model: string | null = null;
    await eachLine(path, (line) => {
      const rec = parseJson(line);
      if (rec?.type === "turn_context" && typeof rec.payload?.model === "string") {
        model = rec.payload.model;
      }
    });
    return model;
  },
  async messages(path) {
    const out: TranscriptMessage[] = [];
    await eachLine(path, (line) => {
      const rec = parseJson(line);
      if (!rec) return;
      const ts = Date.parse(rec.timestamp ?? "") || 0;
      if (rec.type === "event_msg") {
        const p = rec.payload;
        if (p?.type === "user_message" && typeof p.message === "string" && p.message.trim()) {
          out.push({ role: "user", text: firstText(p.message), ts });
        } else if (p?.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
          out.push({ role: "claude", text: firstText(p.message), ts });
        }
        return;
      }
      if (rec.type === "response_item" && rec.payload?.type === "message") {
        const p = rec.payload;
        const role = p.role === "user" ? "user" : p.role === "assistant" ? "claude" : null;
        if (!role) return;
        const bits: string[] = [];
        for (const b of p.content ?? []) {
          if (b?.type === "input_text" || b?.type === "output_text") bits.push(String(b.text ?? ""));
        }
        const text = firstText(bits.join("\n"));
        if (!text || isCodexHarnessText(text)) return;
        if (out.some((m) => m.role === role && m.text === text)) return;
        out.push({ role, text, ts });
      }
    });
    return out;
  },
};

/* ------------------------------------------------- opencode
 *
 * Live store is ~/.local/share/opencode/opencode.db (session + message + part).
 * Tests also accept a captured JSON dump of those rows. */

export function opencodeDbPath(): string {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

/** Split the opencode locate's one non-file path shape, `db#sessionId`.
 *  Exported for the opencode reader's activity poll (readers/opencode.ts). */
export function splitOpenCodePath(path: string): { db: string; sessionId: string | null } {
  const hash = path.lastIndexOf("#");
  if (hash > 0) return { db: path.slice(0, hash), sessionId: path.slice(hash + 1) };
  return { db: path, sessionId: null };
}

function opencodeLocate(ref: AgentSessionRef | null, _cwd: string): { sessionId: string; path: string } | null {
  const id = refId(ref);
  if (ref?.kind === "path") {
    const raw = normalize(ref.id);
    const { db, sessionId } = splitOpenCodePath(raw);
    return { sessionId: sessionId ?? id ?? "opencode", path: sessionId ? raw : db };
  }
  if (!id) return null;
  const db = opencodeDbPath();
  return { sessionId: id, path: `${db}#${id}` };
}

type OpenCodeDump = {
  session?: { id?: string; model?: { id?: string } | string; tokens_input?: number; tokens_cache_read?: number };
  messages?: Array<{ id: string; time_created: number; data: any }>;
  parts?: Array<{ message_id: string; time_created: number; data: any }>;
};

async function loadOpenCode(path: string): Promise<{ dump: OpenCodeDump; sessionId: string | null } | null> {
  const { db, sessionId } = splitOpenCodePath(path);
  const f = Bun.file(db);
  if (!(await f.exists())) return null;
  if (db.endsWith(".json")) {
    try { return { dump: JSON.parse(await f.text()) as OpenCodeDump, sessionId }; }
    catch { return null; }
  }
  try {
    const { Database } = await import("bun:sqlite");
    const sqlite = new Database(db, { readonly: true });
    try {
      const sid = sessionId;
      if (!sid) return { dump: {}, sessionId: null };
      const session = sqlite.query("select id, model, tokens_input, tokens_cache_read from session where id = ?").get(sid) as
        | { id: string; model: string; tokens_input: number; tokens_cache_read: number } | null;
      const messages = sqlite.query(
        "select id, time_created, data from message where session_id = ? order by time_created",
      ).all(sid) as Array<{ id: string; time_created: number; data: string }>;
      const parts = sqlite.query(
        "select message_id, time_created, data from part where session_id = ? order by time_created",
      ).all(sid) as Array<{ message_id: string; time_created: number; data: string }>;
      const parsedModel = (() => {
        try { return session?.model ? JSON.parse(session.model) : undefined; }
        catch { return session?.model; }
      })();
      return {
        sessionId: sid,
        dump: {
          session: session
            ? { id: session.id, model: parsedModel, tokens_input: session.tokens_input,
                tokens_cache_read: session.tokens_cache_read }
            : undefined,
          messages: messages.map((m) => ({ id: m.id, time_created: m.time_created, data: JSON.parse(m.data) })),
          parts: parts.map((p) => ({ message_id: p.message_id, time_created: p.time_created, data: JSON.parse(p.data) })),
        },
      };
    } finally {
      sqlite.close();
    }
  } catch {
    return null;
  }
}

/* The session's model id: the session row's `model` ({id, providerID, variant}
 * or a bare string), else the newest assistant message's `modelID`. Shared by
 * model() and contextPct() so one load of the dump answers both. */
function opencodeModel(dump: OpenCodeDump): string | null {
  const m = dump.session?.model;
  if (m && typeof m === "object" && typeof m.id === "string") return m.id;
  if (typeof m === "string" && m) return m;
  const asst = [...(dump.messages ?? [])].reverse().find((x) => x.data?.role === "assistant");
  const id = asst?.data?.modelID;
  return typeof id === "string" ? id : null;
}

export const OPENCODE_TRANSCRIPT: TranscriptSupport = {
  locate: opencodeLocate,
  turnEdge(line) {
    const rec = parseJson(line);
    if (!rec) return null;
    const role = rec.role ?? rec.data?.role;
    const finish = rec.finish ?? rec.data?.finish ?? rec.data?.reason;
    const type = rec.type ?? rec.data?.type;
    if (role === "user") return "working";
    if (type === "step-start") return "working";
    if (finish === "stop" || type === "step-finish") return "idle";
    return null;
  },
  /* TOKENS off the record shape in fixtures/opencode-session.json: the newest
   * assistant message's `data.tokens` ({total, input, output, reasoning,
   * cache:{read, write}}), context = input + cache.read + cache.write; when no
   * assistant message carries tokens, the session row's `tokens_input` (+
   * `tokens_cache_read`, present in the fixture). opencode writes no context
   * window into the session or message rows (the fixture's `session.model` is
   * {id, providerID, variant} only; testbench/ has a window only in a provider
   * config, not in a session record), so the window is `contextWindowFor(model)`:
   * the 1M default since 2026-09-02 (fail open). */
  async contextPct(path) {
    const loaded = await loadOpenCode(path);
    if (!loaded) return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    let tokens = 0;
    const asst = [...(loaded.dump.messages ?? [])].reverse()
      .find((x) => x.data?.role === "assistant" && x.data?.tokens && typeof x.data.tokens === "object");
    if (asst) {
      const t = asst.data.tokens;
      tokens = n(t.input) + n(t.cache?.read) + n(t.cache?.write);
    }
    if (tokens <= 0) {
      const s = loaded.dump.session;
      tokens = n(s?.tokens_input) + n(s?.tokens_cache_read);
    }
    return pctUsed(tokens, contextWindowFor(opencodeModel(loaded.dump) ?? ""));
  },
  async model(path) {
    const loaded = await loadOpenCode(path);
    if (!loaded) return null;
    return opencodeModel(loaded.dump);
  },
  async messages(path) {
    const loaded = await loadOpenCode(path);
    if (!loaded) return [];
    const partsByMsg = new Map<string, typeof loaded.dump.parts>();
    for (const p of loaded.dump.parts ?? []) {
      const list = partsByMsg.get(p.message_id) ?? [];
      list.push(p);
      partsByMsg.set(p.message_id, list);
    }
    const out: TranscriptMessage[] = [];
    for (const msg of loaded.dump.messages ?? []) {
      const role = msg.data?.role === "user" ? "user" : msg.data?.role === "assistant" ? "claude" : null;
      if (!role) continue;
      const texts = (partsByMsg.get(msg.id) ?? [])
        .filter((p) => p.data?.type === "text" && typeof p.data.text === "string")
        .map((p) => String(p.data.text));
      const text = firstText(texts.join("\n"));
      if (!text) continue;
      out.push({ role, text, ts: msg.time_created || 0 });
    }
    return out;
  },
};
