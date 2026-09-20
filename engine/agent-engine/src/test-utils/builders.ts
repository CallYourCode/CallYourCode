/* BUILDERS: the shapes a test needs ALREADY ON DISK, in one place.
 *
 * Moved out of notify-harness.ts (seedTranscript, and the data-dir seed/read
 * helpers that speak the design layout) plus the chat-message shapes forty
 * test files used to each spell for themselves. `dir` here is a test's tmp root
 * from ./tmp.ts, never a real data dir.
 */

import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replayChatText } from "../chat/chatstore.ts";
import { mintAgentId, type AgentMeta } from "../runtime/agentmeta.ts";
import { HARNESS_CWD } from "./fake-herdr.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";

/* Author a claude transcript into an engine's throwaway ~/.claude/projects from
 * inside a `seed(dir)` hook -- BEFORE the engine boots, which is the only window
 * a boot-time roll (its continuity check stats these) can be set up in. `dir` is
 * the engine root seed() is handed; the projects dir is `<dir>/projects`, matching
 * startEngine's CYC_PROJECTS_DIR. */
export async function seedTranscript(dir: string, uuid: string,
    o: { content?: string; mtimeMs?: number; cwd?: string } = {}): Promise<string> {
  const path = join(dir, "projects", mungeCwd(o.cwd ?? HARNESS_CWD), `${uuid}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, o.content ?? "{}\n");
  if (o.mtimeMs != null) { const t = new Date(o.mtimeMs); await utimes(path, t, t); }
  return path;
}

/* ---------------- the data-dir seed/read helpers (design layout) ----------
 *
 * Tests used to seed and inspect `.run/chat.json`, `heard.json`, `names.json`
 * and friends directly. Those files are gone: everything per-agent lives in
 * agents/<agentId>/ (meta.json + chats/<chatId>.jsonl). These helpers speak
 * the new layout in ONE place so forty test files do not each spell it. */

/** The engine's data dir inside a harness dir. */
export const dataDirOf = (dir: string): string => join(dir, "data");

/** Seed one agent: a meta.json pointing sessionId at a fresh chat file holding
 *  `msgs` (written as one jsonl line per message). Extra meta fields (name,
 *  settings, read, seeded, lineage, photo, voice...) ride in `meta`. */
export async function seedAgent(
  dir: string,
  sessionId: string,
  msgs: Record<string, unknown>[] = [],
  meta: Partial<AgentMeta> = {},
): Promise<{ agentId: string; chatId: string }> {
  const agentId = meta.agentId ?? mintAgentId();
  const chatId = crypto.randomUUID();
  const aDir = join(dataDirOf(dir), "agents", agentId);
  await mkdir(join(aDir, "chats"), { recursive: true });
  const body = msgs.map((m) => JSON.stringify({ t: "m", ...m })).join("\n");
  await writeFile(join(aDir, "chats", `${chatId}.jsonl`), body.length ? body + "\n" : "");
  const full: AgentMeta = {
    v: 2, agentId, sessionId,
    chats: [{ id: chatId, createdAt: Date.now() }],
    chat: chatId,
    ...meta,
  } as AgentMeta;
  await writeFile(join(aDir, "meta.json"), JSON.stringify(full, null, 2));
  return { agentId, chatId };
}

/** Every agent meta in a harness dir, keyed by agentId. */
export async function readAgentMetas(dir: string): Promise<Map<string, AgentMeta>> {
  const out = new Map<string, AgentMeta>();
  const agents = join(dataDirOf(dir), "agents");
  const { readdir } = await import("node:fs/promises");
  for (const name of await readdir(agents).catch(() => [] as string[])) {
    try {
      const meta = (await Bun.file(join(agents, name, "meta.json")).json()) as AgentMeta;
      if (meta?.agentId) out.set(meta.agentId, meta);
    } catch { /* not an agent dir */ }
  }
  return out;
}

/** The meta whose sessionId (or pastSessions) names this session, or null. */
export async function metaForSession(dir: string, sessionId: string): Promise<AgentMeta | null> {
  for (const meta of (await readAgentMetas(dir)).values()) {
    if (meta.mergedInto) continue;
    if (meta.sessionId === sessionId || meta.pastSessions?.includes(sessionId)) return meta;
  }
  return null;
}

/** Replay one session's CURRENT chat log off disk (messages after patches),
 *  the way the engine's boot restore does. [] when the agent or log is absent. */
export async function readChatLog(dir: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const meta = await metaForSession(dir, sessionId);
  if (!meta?.chat) return [];
  const path = join(dataDirOf(dir), "agents", meta.agentId, "chats", `${meta.chat}.jsonl`);
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  return replayChatText(await f.text()) as Record<string, unknown>[];
}

/* ---------------- chat message shapes ---------------------------------------
 *
 * The engine's chat log is one JSON object per line (chatstore.ts). These are
 * the three roles a test ever writes, with the fields the readers actually
 * require, so a spec says WHAT it is seeding rather than which keys the format
 * happens to want this month. */

let msgSeq = 0;

/** A message from the phone: what the user sent to the agent. */
export function userMsg(text: string, o: Partial<Record<string, unknown>> = {}) {
  return { id: `u${++msgSeq}`, role: "user", text, ts: Date.now(), ...o } as Record<string, unknown>;
}

/** A message from the agent: what a reply row looks like. This is the row an
 *  unread count counts and a push notification is about. The wire has one
 *  non-user role -- `claude` (chatmsg.ts) -- and the app draws anything that is
 *  not `claude` on the user side, so an agent reply MUST seed as `claude`. */
export function agentMsg(text: string, o: Partial<Record<string, unknown>> = {}) {
  return { id: `a${++msgSeq}`, role: "claude", text, ts: Date.now(), ...o } as Record<string, unknown>;
}

/** An engine notice (a system row): never a reply, never unread. It is carried
 *  on the wire as `role: "claude"` exactly like a reply (noticeChat in
 *  chatlog.ts) -- the wire has no `notice` role -- so it seeds as `claude`. */
export function noticeMsg(text: string, o: Partial<Record<string, unknown>> = {}) {
  return { id: `n${++msgSeq}`, role: "claude", text, ts: Date.now(), ...o } as Record<string, unknown>;
}

/** One claude-transcript jsonl line, in the shape the readers parse. */
export function transcriptLine(role: "user" | "assistant", text: string,
    o: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: role === "user" ? "user" : "assistant",
    message: { role, content: [{ type: "text", text }] },
    timestamp: new Date().toISOString(),
    ...o,
  });
}

/** A whole claude transcript body from a list of turns. */
export function transcriptBody(turns: Array<{ role: "user" | "assistant"; text: string }>): string {
  return turns.map((t) => transcriptLine(t.role, t.text)).join("\n") + "\n";
}
