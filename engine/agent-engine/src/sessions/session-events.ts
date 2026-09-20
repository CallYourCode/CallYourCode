// session-events: Claude Code's session jsonl -> the overlay's event stream.
// Pure record mapping plus two readers:
// a backward tail reader for backfill (GET /session-events/:id) and an
// incremental forward parser the fs.watch tail drains. Raw records never
// leave this module; the client only ever sees compressed one-liners.

import { join, normalize } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync } from "node:fs";
import { acronymFromDisplayName, bareModelId, modelAcronym, modelDisplayName } from "./model-names.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";

/** Where an INPUT (a `kind:"prompt"` event) reached the agent from, so the
 *  overlay can show out-of-band inputs labelled by origin (his ask: "see
 *  inputs that came from other places, like agents messaging each other or
 *  manual input"). Derived from the ENGINE'S OWN delivery vocabulary, never a
 *  guess about what a person wrote:
 *   - `app`    the cyc app's own send (VOICE:/TEXT:, APP_PREFIXES). Already a
 *              chat bubble, so it is SUPPRESSED from the overlay, never doubled;
 *              this value exists for completeness and is not emitted today.
 *   - `cron`   a fired schedule (crons plugin delivers `how:"SCHEDULED"`).
 *   - `agent`  an agent-to-agent send (`cyc agent message --from <id>` /
 *              herdr `agent send`), delivered as `<sender>: <text>`; `sender`
 *              carries that id.
 *   - `manual` anything else: a line typed straight into the tmux/herdr pane,
 *              which the engine did not originate and cannot attribute further. */
export type InputSource = "app" | "manual" | "agent" | "cron";

export type SessionEvent = {
  uuid: string; // the record's own uuid: a ready-made stable event id
  ts: number; // epoch ms (records carry ISO strings; chat ts is epoch ms from the same machine)
  /* "interrupt" is the user cutting a turn short (codex turn_aborted maps to
   * it; the app folds it onto the preceding tool run). claude's own interrupts
   * still ride as prompt rows the app rewrites client-side, unchanged. */
  kind: "prompt" | "reply" | "tool" | "compact" | "interrupt";
  text: string;
  tool?: string; // kind:"tool" only; drives the label chip
  /** kind:"prompt" only: where the input came from (the overlay's source chip) */
  source?: InputSource;
  /** source:"agent" only: the sending agent's id, carried from `--from` */
  sender?: string;
  /** the byte offset of the record's line in its transcript, set by the
   *  forward readers (the tail parser, the backfill span); the ingest keeps
   *  it in the record's src for the pointer it writes */
  off?: number;
};

/** One app-sent message whose `user` record landed in the transcript: the
 *  instant it entered the agent's context (the ingest's `delivered` record). */
export type DeliveredRecord = { text: string; uuid: string; ts: number; off: number };

const TEXT_CAP = 200; // chars per tool/compact one-liners, server-side cap
export const BODY_CAP = 20000; // prompts and replies keep their body so the app's
                        // tap-to-expand shows the whole message, not a stub;
                        // 20k fits long status reports while still bounding a
                        // pathological megabyte paste from bloating the page
const CMD_CAP = 80; // Bash commands without a description

// ---------------------------------------------------------------- file path

/* Where Claude Code keeps its per-project transcripts. Overridable so a test
 * (and every harness engine) points at a throwaway directory instead of the
 * real ~/.claude/projects: continuity checks now STAT these files, and a spec
 * proving a roll needs to author transcripts without touching his own. */
/* READ PER CALL, NOT CAPTURED AT IMPORT. It used to be a `const` evaluated
 * while this module was being evaluated, which made the transcript root
 * unswappable the instant anything imported it -- and every module in the
 * engine graph imports this one transitively, so a seam test could not point
 * the projects dir at its own tmp tree without winning a module-load race it
 * has no way to win. Production reads the same env var and gets the same
 * string on every call, so nothing about a running engine changes. */
const projectsDir = (): string =>
  process.env.CYC_PROJECTS_DIR || join(homedir(), ".claude", "projects");

// Path is constructed from herdr-owned cwd + claudeSessionId; never
// client-supplied. Munging mirrors Claude Code (see shared/claude-projects.ts).
export function sessionFilePath(cwd: string, claudeSessionId: string): string | null {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(claudeSessionId)) return null;
  const PROJECTS_DIR = projectsDir();
  const munged = mungeCwd(cwd);
  const path = normalize(join(PROJECTS_DIR, munged, `${claudeSessionId}.jsonl`));
  if (!path.startsWith(PROJECTS_DIR + "/")) return null; // must stay under ~/.claude/projects/
  return path;
}

/** Newest <uuid>.jsonl in this cwd's project dir, or null. The claude reader's
 *  cwd-only locate (D10): TmuxMux used to readdir this itself. Ambiguous cwd
 *  (two claude panes) is a mux decision; this function still returns newest. */
export function latestClaudeSessionId(cwd: string): string | null {
  if (!cwd) return null;
  const PROJECTS_DIR = projectsDir(); // per call, see projectsDir()
  const dir = join(PROJECTS_DIR, mungeCwd(cwd));
  if (!normalize(dir).startsWith(PROJECTS_DIR + "/")) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { id: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) continue;
    let mtime: number;
    try {
      mtime = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtime > newest.mtime) newest = { id, mtime };
  }
  return newest?.id ?? null;
}

/* Locate a transcript by its session id alone, across EVERY project dir. The
 * backfill (chat/backfill.ts) needs this for an old conversation whose meta
 * predates the `cwd` field: its session id is known (meta.sessionId) but the
 * folder it ran in is not, so sessionFilePath cannot build the path. A scan of
 * ~/.claude/projects/<munged-cwd>/<id>.jsonl finds it; the first match wins
 * (a session id is a uuid, unique across projects). Returns the absolute path
 * or null. READ-ONLY: it only ever stats and reads project files. */
export function findTranscriptBySessionId(sid: string): string | null {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sid)) return null;
  const PROJECTS_DIR = projectsDir();
  let projects: string[];
  try {
    projects = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const proj of projects) {
    const path = normalize(join(PROJECTS_DIR, proj, `${sid}.jsonl`));
    if (!path.startsWith(PROJECTS_DIR + "/")) continue;
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // not in this project dir; keep looking
    }
  }
  return null;
}

// ---------------------------------------------------------------- extraction

// First non-empty line, leading markdown markers stripped, capped with a
// trailing ellipsis. The whole compression story for every event kind.
function firstLine(raw: string): string {
  for (const line of raw.split("\n")) {
    const t = line.replace(/^[\s#>*`-]+/, "").trim();
    if (t) return t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) + "…" : t;
  }
  return "";
}

// Whole body for prompts/replies: paragraphs kept (blank runs squeezed),
// capped generously. Collapsed pills clamp in CSS; expansion reads it all.
function fullBody(raw: string): string {
  const t = raw.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > BODY_CAP ? t.slice(0, BODY_CAP) + "…" : t;
}

function basenameOf(p: unknown): string {
  return typeof p === "string" ? p.split("/").pop() ?? "" : "";
}

/* The output MCP's speak/show, under EITHER server key. The server renamed
 * voice -> callyourcode (task 593), and the harness prefixes tool names with
 * the key -- but transcripts written before the rename carry the old names
 * forever, and a live session keeps its old MCP process (and so the old
 * names) until it reconnects. Both spellings are the same tool. */
function isOutputToolName(name: string): boolean {
  return name === "mcp__callyourcode__speak" || name === "mcp__callyourcode__show" ||
    name === "mcp__voice__speak" || name === "mcp__voice__show";
}

function toolText(name: string, input: any): string {
  if (name === "Bash") {
    const desc = typeof input?.description === "string" ? input.description.trim() : "";
    if (desc) return `Bash: ${firstLine(desc)}`;
    const cmd = String(input?.command ?? "").replace(/\s+/g, " ").trim();
    return `Bash: ${cmd.length > CMD_CAP ? cmd.slice(0, CMD_CAP) + "…" : cmd}`;
  }
  if (name === "Edit" || name === "Write" || name === "Read" || name === "NotebookEdit") {
    const base = basenameOf(input?.file_path);
    return base ? `${name}: ${base}` : name;
  }
  if (name === "Agent" || name === "Task") {
    const desc = typeof input?.description === "string" ? input.description.trim() : "";
    return desc ? `${name}: ${firstLine(desc)}` : name;
  }
  return name;
}

function fmtTokens(n: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "?";
  return v >= 1000 ? `${Math.round(v / 1000)}k` : String(v);
}

/* THE HARNESS TALKS TO CLAUDE IN THE TRANSCRIPT, and it is not a person typing.
 *
 * When a background agent finishes, or a session resumes and the harness has to
 * account for agents it can no longer find, it writes a `<task-notification>`
 * block into the conversation AS A USER TURN -- promptId and all, exactly like a
 * halt (`[Request interrupted by user]`) or a `/model` switch. Left alone it
 * comes out of the extractor as a `kind:"prompt"`, the one kind the app keeps at
 * full opacity, so a paragraph of raw XML (`<task-notification> <task-id>...`)
 * lands as a full-attention bubble in his chat. His screenshot of exactly that
 * is why this exists.
 *
 * It is a machine-to-machine note, so it belongs in the SAME quiet system line
 * the other harness turns already use -- `kind:"compact"`, the one this module
 * emits for a compaction boundary, which the app renders as a muted service pill
 * and treats specially nowhere. The scope his call set: "a very minimal agent
 * engine side regex or rewording only", no app change and no new kind. This is
 * that -- the XML is reworded to one line and the kind is one it already draws.
 */
const TASK_NOTIFICATION_TAG = "<task-notification>";

function summarizeTaskNotification(raw: string): string {
  const status = raw.match(/<status>([^<]*)<\/status>/)?.[1]?.trim().toLowerCase();
  const summary = raw.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
  // a summary, when the harness gives one, is the plainest thing to show
  if (summary && summary.trim()) return firstLine(summary);
  if (status === "completed") return "A background agent finished";
  if (status === "stopped") return "A background agent stopped";
  return "Background agent update";
}

/* A CROSS-SESSION MESSAGE, same "harness talks in the transcript" class as the
 * task-notification above. An agent-to-agent send that crosses sessions arrives
 * wrapped by the harness AS A USER TURN (his 2026-09-08 screenshots):
 *
 *   <cross-session-message from="uds:/run/user/1000/cc-socks/7478.sock"
 *       from-name="mrinmayai-e0" from-mode="bypass">
 *   ...body...
 *   </cross-session-message>
 *
 * Left alone fullBody(raw) paints the raw wrapper -- one ugly collapsed line,
 * the tags showing when expanded -- as a full-attention prompt. It is an
 * agent-source input like any `<sender>: body` send, so it gets the same chip
 * treatment cron does: source:"agent", sender = from-name, and only the clean
 * inner body as text. The from= socket path and from-mode are transport
 * details, dropped from the rendered text entirely.
 *
 * Matched by a leading tag, not `includes`, so a person who merely quotes the
 * tag mid-prose is still a prompt; only a turn the harness authored whole
 * begins with the tag. Missing closing tag: unwrap what follows the opening
 * tag anyway; never throw. */
const CROSS_SESSION_OPEN_RE = /^\s*<cross-session-message\b([^>]*)>/;

function unwrapCrossSessionMessage(raw: string): { body: string; sender?: string } | null {
  const open = CROSS_SESSION_OPEN_RE.exec(raw);
  if (!open) return null;
  const fromName = open[1].match(/\bfrom-name\s*=\s*"([^"]*)"/)?.[1]?.trim();
  const afterOpen = raw.slice(open.index + open[0].length);
  const close = afterOpen.indexOf("</cross-session-message>");
  const body = close === -1 ? afterOpen : afterOpen.slice(0, close);
  return { body, ...(fromName ? { sender: fromName } : {}) };
}

/* THE OTHER HARNESS TURNS, same class as the task-notification above (#398).
 *
 * A slash command (`/model`, `/compact`, `/theme`, ...), the command's own
 * stdout, and a terminal `!` bash line all land in the transcript AS USER
 * TURNS -- promptId and all -- carrying nothing but the harness's own XML:
 *
 *   <command-name>/model</command-name>
 *   <command-message>model</command-message>
 *   <command-args>opus</command-args>
 *   <local-command-stdout>Set model to claude-opus-4-8</local-command-stdout>
 *
 * Left alone each comes out `kind:"prompt"`, the one full-opacity kind, so a
 * model switch paints its raw `<command-name>`/`<local-command-stdout>` tags as
 * a full-attention bubble -- his screenshot. Same recipe as #383: these are the
 * harness talking to itself, so they get the same quiet system line
 * (`kind:"compact"`), reworded to one XML-free line, no app change, no new kind.
 *
 * Matched by a leading tag, not `includes`, so a person who quotes one of these
 * tags mid-prompt is still a prompt; only a turn the harness authored whole
 * begins with the tag. */
const HARNESS_COMMAND_RE =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/;

/* WHERE A SURVIVING INPUT CAME FROM, read off the engine's own delivery
 * prefix -- the same kind of accounting `isFromApp` already reads for the app.
 * Called only after the app (VOICE:/TEXT:), notification and harness-command
 * turns have been peeled off, so what is left is cron, agent, or a person.
 *
 * A cron is delivered `SCHEDULED[ (note)]: body` (crons plugin, how:"SCHEDULED").
 * An agent-to-agent send is delivered `<sender>: body` (deliverToAgent,
 * how=<author> from `--from`): a single-line, space-free sender label the
 * engine wrote, so it is the engine's truth and not a text guess. Everything
 * else is a person typing straight into the pane: `manual`, the one source
 * with no engine prefix to read. The space-free sender guard keeps ordinary
 * prose ("I think: yes") from reading as a sender; a bare `word: text` a
 * person types by hand is the one shape that can still look like an agent. */
const CRON_PREFIX_RE = /^SCHEDULED(?: \([^)]*\))?:\s/;
const AGENT_PREFIX_RE = /^([^\s:][^\s:]{0,63}):\s/;

export function classifyInput(body: string): { source: InputSource; sender?: string } {
  if (CRON_PREFIX_RE.test(body)) return { source: "cron" };
  const m = AGENT_PREFIX_RE.exec(body);
  if (m) return { source: "agent", sender: m[1] };
  return { source: "manual" };
}

// terminal formatting cruft the harness leaves in its stdout ("...4-8[1m]"):
// a stray ANSI SGR sequence, ESC byte already stripped upstream
const stripAnsi = (s: string) => s.replace(/\x1b?\[[0-9;]*m\]?/g, "");

function summarizeCommand(raw: string): string {
  // stdout/stderr is already a human sentence ("Set model to ..."): show it
  const out = raw.match(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/);
  if (out) {
    const t = stripAnsi(out[1]).trim();
    return t ? firstLine(t) : "Command finished";
  }
  // a slash-command invocation: name it plainly, with its args when it has any
  const name = raw.match(/<command-name>\/?([^<]*)<\/command-name>/)?.[1]?.trim();
  if (name) {
    const args = stripAnsi(raw.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? "").trim();
    return firstLine(args ? `Ran /${name} ${args}` : `Ran /${name}`);
  }
  // a terminal `!` bash line and its output
  const bin = raw.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bin) { const t = stripAnsi(bin[1]).trim(); return t ? `! ${firstLine(t)}` : "Command output"; }
  const bout = raw.match(/<bash-(?:stdout|stderr)>([\s\S]*?)<\/bash-(?:stdout|stderr)>/);
  if (bout) { const t = stripAnsi(bout[1]).trim(); return t ? firstLine(t) : "Command finished"; }
  return "Command output";
}

// One record -> one event, or null for everything the overlay drops:
// thinking blocks, tool_results, meta/caveat notes, attachments, snapshots,
// untimestamped header records -- and, the key correctness rule, the app's
// own traffic (VOICE prompts, speak/show tool calls) which already lives in
// the chat as real bubbles.
export function eventFromRecord(rec: any): SessionEvent | null {
  if (!rec || typeof rec !== "object") return null;
  const ts = Date.parse(rec.timestamp ?? "");
  if (!Number.isFinite(ts) || typeof rec.uuid !== "string") return null;

  if (rec.type === "user") {
    const content = rec.message?.content;
    let raw = "";
    if (typeof content === "string") {
      raw = content;
    } else if (Array.isArray(content)) {
      if (content.some((b: any) => b && typeof b === "object" && "tool_use_id" in b)) return null;
      raw = content
        .map((b: any) => (b?.type === "image" ? "[image]" : String(b?.text ?? "")))
        .join("\n");
    } else {
      return null;
    }
    // A harness-injected notification is not a person typing: reword it to one
    // quiet system line rather than let its raw XML land as a full-attention
    // prompt. Ahead of the prompt guards below because these turns arrive with
    // (or without) a promptId of their own and either way are not a prompt.
    if (raw.includes(TASK_NOTIFICATION_TAG)) {
      return { uuid: rec.uuid, ts, kind: "compact", text: summarizeTaskNotification(raw) };
    }
    // a slash command, its stdout, or a terminal `!` bash line: also the
    // harness talking to itself, so also a quiet system line, never a prompt
    if (HARNESS_COMMAND_RE.test(raw)) {
      return { uuid: rec.uuid, ts, kind: "compact", text: summarizeCommand(raw) };
    }
    // real terminal prompts only: promptId, not meta, not a replayed compact
    // summary, not a tool_result (those carry promptId too)
    if (rec.isMeta || rec.isCompactSummary) return null;
    if (typeof rec.promptId !== "string") return null;
    if (isFromApp(raw)) return null; // the app's own utterance: already a user bubble
    // a cross-session agent send: unwrap to the clean body + a "from" chip
    const xs = unwrapCrossSessionMessage(raw);
    if (xs) {
      const body = fullBody(xs.body);
      if (!body) return null;
      return { uuid: rec.uuid, ts, kind: "prompt", text: `> ${body}`, source: "agent", ...(xs.sender ? { sender: xs.sender } : {}) };
    }
    const text = fullBody(raw);
    if (!text) return null;
    const { source, sender } = classifyInput(text);
    return { uuid: rec.uuid, ts, kind: "prompt", text: `> ${text}`, source, ...(sender ? { sender } : {}) };
  }

  /* A MESSAGE DELIVERED TO A BUSY PANE NEVER BECOMES A `user` RECORD.
   *
   * Measured on this repo's own session (2026-08-12): claude queues it and
   * injects it mid-turn, and the transcript gets `queue-operation` records
   * (no uuid) plus ONE `attachment` record (uuid, timestamp, the full prompt)
   * -- while a message delivered to an idle pane gets a real `user` prompt
   * record and no attachment. The two flows partition: one firing never
   * produces both, so rendering attachments cannot duplicate a prompt strip.
   * Without this branch a busy session's cron/script inputs are invisible in
   * the overlay, which is how "why doesn't the cron show up" was reported. */
  if (rec.type === "attachment") {
    const a = rec.attachment;
    if (!a || a.type !== "queued_command") return null;
    const raw = String(a.prompt ?? "");
    // same guards as the user-record prompt path above
    if (raw.includes(TASK_NOTIFICATION_TAG)) {
      return { uuid: rec.uuid, ts, kind: "compact", text: summarizeTaskNotification(raw) };
    }
    if (HARNESS_COMMAND_RE.test(raw)) {
      return { uuid: rec.uuid, ts, kind: "compact", text: summarizeCommand(raw) };
    }
    if (isFromApp(raw)) return null; // the app's own utterance: already a user bubble
    // a cross-session agent send: unwrap to the clean body + a "from" chip
    const xs = unwrapCrossSessionMessage(raw);
    if (xs) {
      const body = fullBody(xs.body);
      if (!body) return null;
      return { uuid: rec.uuid, ts, kind: "prompt", text: `> ${body}`, source: "agent", ...(xs.sender ? { sender: xs.sender } : {}) };
    }
    const text = fullBody(raw);
    if (!text) return null;
    const { source, sender } = classifyInput(text);
    return { uuid: rec.uuid, ts, kind: "prompt", text: `> ${text}`, source, ...(sender ? { sender } : {}) };
  }

  if (rec.type === "assistant") {
    const block = Array.isArray(rec.message?.content) ? rec.message.content[0] : undefined;
    if (!block || typeof block !== "object") return null;
    if (block.type === "text") {
      const text = fullBody(String(block.text ?? ""));
      if (!text) return null;
      return { uuid: rec.uuid, ts, kind: "reply", text };
    }
    if (block.type === "tool_use") {
      const name = String(block.name ?? "");
      if (!name) return null;
      // speak/show ARE the claude bubbles / file cards; echoing them back
      // would replay the whole chat into the overlay
      if (isOutputToolName(name)) return null;
      return { uuid: rec.uuid, ts, kind: "tool", text: toolText(name, block.input), tool: name };
    }
    return null; // thinking etc
  }

  if (rec.type === "system" && rec.subtype === "compact_boundary") {
    const m = rec.compactMetadata ?? {};
    return {
      uuid: rec.uuid,
      ts,
      kind: "compact",
      text: `Conversation compacted (${fmtTokens(m.preTokens)} -> ${fmtTokens(m.postTokens)} tokens)`,
    };
  }

  return null;
}

function parseLine(line: string): SessionEvent | null {
  if (!line) return null;
  try {
    return eventFromRecord(JSON.parse(line));
  } catch {
    return null; // malformed or truncated line (write in progress): skip silently
  }
}

// ---------------------------------------------------------------- tail read

const BLOCK = 1 << 20; // 1 MB; lines can be 743 KB (base64 images), so carry across blocks
const decoder = new TextDecoder();

/* Cede the event loop this often while walking a large tail, so /health, timers
 * and other sockets stay responsive mid-parse. setTimeout(0) is a real macrotask
 * yield: the block-boundary `await` on file I/O is not guaranteed to hand the
 * loop back when the bytes are already in the page cache, which is exactly the
 * case a just-touched 387 MB transcript is in. This was the #413 hang. */
const YIELD_EVERY_BYTES = 4 * 1024 * 1024;
const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

// Read the file backwards in blocks, parse newest-first until `limit` events
// (older than `before`, when given) are found, or the `maxBytes` budget is
// spent. Cost is bounded by events wanted AND by bytes walked, never by file
// size. Events return in ascending ts; `more` = older bytes remain unread
// below the returned window (limit reached, or the byte budget stopped the
// walk).
//
// THE WALK IS RESUMABLE (#583, the byte cursor CONTRACT.md's #413 note asked
// for). `resumeAt` is the byte offset the walk stopped at: pass it back as
// `from` and the next call continues with strictly OLDER lines, every line
// returned exactly once across the chain -- the line a limit-stop was parsing
// is left for the next call, and a block-spanning line is resumed just past its
// own newline so it is re-read whole. resumeAt is 0 when the walk reached the
// start of the file (nothing older remains; more is false). The one bounded
// exception: a single line larger than the whole byte budget cannot be cleared
// within one call, so the cursor falls back to the block boundary and that line
// is later skipped as a partial -- progress and boundedness hold, the oversized
// record is dropped. This is what makes older-than-window overlay history
// PAGEABLE in bounded steps, where the pre-#583 reader (EOF-anchored every
// call) could only ever re-walk the newest window and drop the rest.
export async function readEventsTail(
  path: string,
  opts: { before?: number; limit: number; maxBytes?: number; from?: number },
): Promise<{ events: SessionEvent[]; more: boolean; bytesRead: number; resumeAt: number }> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { events: [], more: false, bytesRead: 0, resumeAt: 0 };
  const maxBytes = opts.maxBytes ?? Infinity;
  const startedAt = Math.max(0, Math.min(opts.from ?? file.size, file.size));
  let end = startedAt;
  let carry = new Uint8Array(0); // start-of-region bytes continuing a line that begins in unread bytes
  const events: SessionEvent[] = [];
  let more = false;
  let resumeAt = 0; // byte offset a `from` continuation resumes the walk at
  let bytesRead = 0; // total file bytes walked, for the byte budget and observability
  let sinceYield = 0;

  outer: while (end > 0) {
    const start = Math.max(0, end - BLOCK);
    const chunk = new Uint8Array(await file.slice(start, end).arrayBuffer());
    bytesRead += end - start;
    sinceYield += end - start;
    const buf = new Uint8Array(chunk.length + carry.length);
    buf.set(chunk, 0);
    buf.set(carry, chunk.length);

    // line ranges within buf; the first line may continue before `start`
    const bounds: number[] = [];
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) bounds.push(i);
    const firstNl = bounds.length ? bounds[0] : -1;
    if (start > 0 && firstNl === -1) {
      carry = buf; // one huge line spanning the whole block: keep accumulating
      end = start;
      continue;
    }
    carry = start > 0 ? buf.subarray(0, firstNl + 1) : new Uint8Array(0);

    // parse complete lines newest-first
    const lineStarts = start > 0 ? bounds.map((i) => i + 1) : [0, ...bounds.map((i) => i + 1)];
    for (let li = lineStarts.length - 1; li >= 0; li--) {
      const from = lineStarts[li];
      const to = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : buf.length;
      if (to <= from) continue;
      const ev = parseLine(decoder.decode(buf.subarray(from, to)).trim());
      if (!ev) continue;
      if (opts.before !== undefined && ev.ts >= opts.before) continue;
      if (events.length >= opts.limit) {
        more = true;
        // the line being looked at was NOT returned: resume just past its end
        // so the next call reads it first (to+1 when buf[to] is the newline,
        // buf.length for a trailing line without one)
        resumeAt = start + Math.min(to + 1, buf.length);
        break outer;
      }
      events.push(ev);
    }
    end = start;
    /* Byte budget spent with older bytes still behind us: return this window,
     * say more exists, and leave a cursor. `carry` holds the tail of a line
     * that BEGINS below `start`; resuming just past its newline (start +
     * carry.length) lets the next call read that line whole. If not one whole
     * line fit in the budget (a single line larger than the budget), fall back
     * to the block boundary so the cursor still strictly decreases; the
     * oversized line is skipped as a partial on the next call. */
    if (end > 0 && bytesRead >= maxBytes) {
      more = true;
      resumeAt = start + carry.length;
      if (resumeAt >= startedAt) resumeAt = start;
      break;
    }
    // Keep the event loop responsive during a long backward walk.
    if (end > 0 && sinceYield >= YIELD_EVERY_BYTES) {
      sinceYield = 0;
      await yieldToLoop();
    }
  }

  events.reverse();
  return { events, more, bytesRead, resumeAt };
}

/* Decode a bounded byte window into lines, WITHOUT ever calling .text() on the
 * file (the robustness ruling: no session-jsonl read may materialise the whole
 * file, and .text() on a slice is the shape that grew into whole-file reads).
 * The caller has already chosen a bounded [start, end); this just reads those
 * bytes and splits. Yields once if the window is large, so even an 8 MB slice
 * does not hold the single event loop for the whole decode. */
async function sliceLines(f: ReturnType<typeof Bun.file>, start: number, end: number): Promise<string[]> {
  const bytes = new Uint8Array(await f.slice(start, end).arrayBuffer());
  if (end - start >= YIELD_EVERY_BYTES) await yieldToLoop();
  return decoder.decode(bytes).split("\n");
}

/* Walk [from, end) FORWARD in bounded blocks, handing each COMPLETE line to
 * `onLine` in order, yielding to the event loop every few megabytes. Returns the
 * byte offset just past the last complete line (a partial trailing line is left
 * for the next call), which is exactly the `parsedTo` a warm re-parse resumes
 * from. This is the forward twin of readEventsTail: it never reads the whole span
 * into one string, so a cold parse of a large recent span cannot freeze the loop
 * (the #413 hang was this class of read done as one .text()). */
export async function streamLinesForward(
  f: ReturnType<typeof Bun.file>, from: number, end: number,
  onLine: (line: string, off: number) => void,
): Promise<number> {
  let pos = from;
  let carry = new Uint8Array(0);
  let sinceYield = 0;
  while (pos < end) {
    const stop = Math.min(end, pos + BLOCK);
    const chunk = new Uint8Array(await f.slice(pos, stop).arrayBuffer());
    sinceYield += stop - pos;
    const buf = new Uint8Array(carry.length + chunk.length);
    buf.set(carry, 0);
    buf.set(chunk, carry.length);
    const bufStart = pos - carry.length; // the file offset of buf[0]
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        onLine(decoder.decode(buf.subarray(lineStart, i)), bufStart + lineStart);
        lineStart = i + 1;
      }
    }
    carry = buf.subarray(lineStart); // the trailing partial line, if any
    pos = stop;
    if (sinceYield >= YIELD_EVERY_BYTES) { sinceYield = 0; await yieldToLoop(); }
  }
  return end - carry.length; // bytes consumed as complete lines
}

// ------------------------------------------------------------ context usage
//
// HOW FULL THIS SESSION'S CONTEXT IS, AND IT DOES NOT COME FROM THE PANE.
//
// Claude Code prints `ctx 17%` in the status line under the input box, and that
// line is already on every screen this engine reads. He ruled it out anyway
// (2026-08-04): *"no dont depend on the pane thats not a good
// solution"*. A number scraped off a terminal is a number that changes when the
// pane is narrow, when a dialog is drawn over it, or when the status line is
// reconfigured -- and it reads `ctx ?%` whenever Claude has not measured yet.
//
// The structured source is the transcript's own accounting. Every assistant
// record carries `message.usage`, and the three input fields on it ARE what was
// in the model's context for that request:
//
//   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//
// `output_tokens` is deliberately NOT added. It is what the model wrote, not
// what it read; it becomes context on the NEXT request and is counted there.
//
// MEASURED against the pane on a throwaway session, 2026-08-04, twice:
//   33,121 tokens -> 3.31% computed, `ctx 3%` on the pane
//  171,947 tokens -> 17.19% computed, `ctx 17%` on the pane
// So the denominator is the model's whole context window and the display
// floors. Both readings agree to the digit the pane shows.

/* `tokens`/`model` are the newest assistant usage record's own: the fullness
 * (tokens) and the model whose WINDOW that fullness is measured against. The
 * three `model*` overrides are set ONLY when a /model switch newer than that
 * usage record was met on the walk (see modelSwitchFromLine): they are the
 * DISPLAY answer -- what the session is on NOW -- while tokens/model stay the
 * measured turn's, so pct and the window are unchanged. Absent (undefined) means
 * no switch was seen and every reader derives the three spellings from `model`
 * exactly as before. `modelId` may be null even when present (a switch whose
 * only evidence is the stdout display name carries no raw id). */
export type ContextUsage = {
  tokens: number;
  model: string;
  modelId?: string | null;
  modelName?: string | null;
  modelAcronym?: string | null;
};

/* THE SESSION WAS COMPACTED AND HAS NOT SPOKEN SINCE, so there is no reading.
 *
 * A compaction writes no usage record (see `isCompactBoundary` below), so the
 * newest usage in the file is still the turn BEFORE the compact -- the big one
 * the compact just threw away. Answering with it is how the button kept
 * reporting a pre-compaction number at the exact moment he had compacted and
 * looked (2026-08-04: "i compacted the vector change and its at 0% now but the
 * ui still shows the old precompaction number").
 *
 * The answer is not 0% either. The engine does not know the new context size
 * until the agent's next turn writes one; a number nobody measured is the
 * defect this file exists to avoid. So it is a THIRD answer, distinct from
 * `null` ("cannot read this session"), and it says what it knows: compacted,
 * no reading yet. */
export const COMPACTED = "compacted" as const;
export type ContextReading = ContextUsage | typeof COMPACTED | null;

/* THE CONTEXT WINDOW, and it FAILS OPEN.
 *
 * POLICY (2026-09-02, owner's call): 1M is the standard now, so every model is
 * 1M unless this file knows better. A wrong-but-present bar beats a missing
 * one. The old shape was a hand list of the families this box had run, and
 * anything else answered null, which the app drew as NO context button at all.
 * That was the defect: Claude Code started writing `claude-fable-5-1` (12,135
 * records on this box, surveyed 2026-09-02), it matched nothing, and the
 * button vanished on the model he was actually using. The list would have
 * gone stale again on the next model; this does not.
 *
 * Order of the answer:
 *   1. a `[1m]` marker on the id means 1,000,000, whatever the family: the
 *      marker's whole point is that the 1M window is ON;
 *   2. the OVERRIDE table, for the one family measured smaller (haiku, 200k),
 *      keyed off the bare family so the dated pin this box writes still hits;
 *   3. DEFAULT_CONTEXT_WINDOW.
 * Never null: `contextPct` of a real reading is therefore always a number. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

const CONTEXT_WINDOW_OVERRIDES: Array<[RegExp, number]> = [
  [/^claude-haiku-4-5$/, 200_000], // Haiku's window is 200K; named so its ctx bar is right, not guessed
];

const ONE_M_MARKER = /\[1m\]$/i;

export function contextWindowFor(model: string): number {
  if (ONE_M_MARKER.test(model)) return 1_000_000;
  const base = bareModelId(model);
  for (const [re, win] of CONTEXT_WINDOW_OVERRIDES) if (re.test(base)) return win;
  return DEFAULT_CONTEXT_WINDOW;
}

/* One transcript line -> what was in context for that request, or null.
 *
 * `isSidechain` records are a SUBAGENT's turns, written into the same file. A
 * subagent has its own context and its own window, so counting one would report
 * the agent's fullness as whatever its last helper happened to be holding. */
export function usageFromLine(line: string): ContextUsage | null {
  if (!line.includes('"usage"')) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== "assistant" || rec.isSidechain) return null;
  const u = rec.message?.usage;
  if (!u || typeof u !== "object") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const tokens = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
  const model = typeof rec.message?.model === "string" ? rec.message.model : "";
  if (!tokens || !model) return null;
  return { tokens, model };
}

/* The DISPLAY answer a /model switch resolves to: the id (when one is written),
 * the long name and the short badge. `modelId` is null when the only evidence is
 * the stdout display name (no raw id to parse). */
export type ModelSwitch = { modelId: string | null; modelName: string; modelAcronym: string };

/* One transcript line -> the model a /model command switched to, or null.
 *
 * A switch is TWO `type:"user"` records the harness writes, no assistant usage
 * between them, so an idle session keeps naming its OLD model until its next
 * turn writes a usage record -- five sessions on his screenshot switched to
 * Fable 5.1 still reading Opus 4.8 (#model-chip). readContextUsage's walk meets
 * this and lets it OVERRIDE the display name off the newest usage record.
 *
 *   <command-name>/model</command-name> ... <command-args>VALUE</command-args>
 *   <local-command-stdout>Set model to `NAME` ...</local-command-stdout>
 *
 * The stdout record is written AFTER the args record, so the newest-first walk
 * meets it first; its backticked NAME is already the display name and the
 * acronym derives from it the one way model-names spells one. The args record is
 * the fallback the walk uses only when it meets it without a stdout record: an
 * exact `claude-` id resolves through the id path, an alias (fable/opus) with no
 * stdout answers the raw alias (never null, the fail-open rule), and an empty
 * VALUE (the picker opened, nothing chosen) is not a switch at all.
 *
 * The two raw substring pre-checks keep the hot path one indexOf per line: a
 * transcript line that is neither shape returns before any JSON.parse. */
export function modelSwitchFromLine(line: string): ModelSwitch | null {
  const hasStdout = line.indexOf("Set model to") >= 0;
  const hasArgs = line.indexOf("<command-name>/model") >= 0;
  if (!hasStdout && !hasArgs) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== "user") return null;
  const content = typeof rec.message?.content === "string" ? rec.message.content : "";
  if (!content) return null;

  // stdout form (primary): the resolved NAME, backticked, is all it takes.
  const out = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (out) {
    const text = stripAnsi(out[1]);
    const at = text.indexOf("Set model to");
    if (at >= 0) {
      const name = text.slice(at + "Set model to".length).match(/`([^`]+)`/)?.[1]?.trim();
      if (name) return { modelId: null, modelName: name, modelAcronym: acronymFromDisplayName(name) };
    }
  }

  // args form (fallback): only a /model invocation, and only when it named one.
  const cmd = content.match(/<command-name>\/?([^<]*)<\/command-name>/)?.[1]?.trim();
  if (cmd === "model") {
    const value = stripAnsi(content.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? "").trim();
    if (!value) return null; // picker opened, nothing chosen: not a switch
    if (/^claude-/.test(value)) {
      const id = bareModelId(value);
      return { modelId: id, modelName: modelDisplayName(id) ?? value, modelAcronym: modelAcronym(id) ?? value };
    }
    // an alias (fable/opus/...) with no stdout: the raw alias is the best name
    return { modelId: null, modelName: value, modelAcronym: value };
  }
  return null;
}

/* WHAT A COMPACTION LOOKS LIKE IN THE TRANSCRIPT, read off a real one:
 * ~/.claude/projects/-Users-example-projects-personal-vector/
 * eeb4b206-057a-47a7-bd69-93da59ca6f1d.jsonl, line 986, written by Claude Code
 * 2.1.195. It is a `system` record with `subtype: "compact_boundary"`, and its
 * `compactMetadata` carries `trigger` ("manual" or "auto"), `preTokens` and
 * `postTokens`. The line after it is the summary: a `user` record flagged
 * `isCompactSummary`.
 *
 * NEITHER OF THE TWO CARRIES A `usage` BLOCK, which is the whole bug: the
 * backwards scan used to read straight past both and answer with the turn
 * before the compact.
 *
 * `postTokens` is deliberately NOT used as the reading. It is Claude Code's own
 * count of the summary it wrote, not what the next request will send -- the
 * system prompt, the tools, the files re-read on the next turn all land on top
 * of it -- and reporting it as this session's fullness would be the same class
 * of invention as reporting 0.
 *
 * No `isSidechain` guard, unlike `usageFromLine` above: surveyed across every
 * transcript on this machine (39 Claude Code versions, 2.1.87 to 2.1.220), a
 * subagent's compaction is only ever written to its own `subagents/*.jsonl`,
 * which is not a file this engine opens. */
const isCompactBoundary = (line: string): boolean => {
  if (!line.includes('"compact_boundary"')) return false;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return false; }
  return rec?.type === "system" && rec.subtype === "compact_boundary";
};

const CONTEXT_TAIL_START = 256 * 1024; // first window; the answer is normally in it
const CONTEXT_TAIL_MAX = 8 * 1024 * 1024; // a session with no assistant turn this deep has none

/* The newest assistant record's usage, read backwards from the end, STOPPING AT
 * THE LAST COMPACTION.
 *
 * The boundary is a terminator and not a filter: usage older than the compact
 * describes a conversation that no longer exists, so hitting the boundary first
 * means the honest answer is COMPACTED rather than the stale figure behind it.
 * Scanning backwards is what makes the ordering free -- whichever of the two
 * was written last is the one this loop meets first.
 *
 * Windowed rather than block-walked because exactly ONE record is wanted and it
 * is the last one written; a session mid-turn has it within kilobytes. The
 * window grows only when a long stretch of tool results and user records pushes
 * it further back. The first line of a window that does not start at byte 0 is
 * dropped: it may have begun before the slice, and half a record parses as
 * nothing anyway -- growing the window is what recovers it. */
export async function readContextUsage(path: string): Promise<ContextReading> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const size = f.size;
  /* The newest /model switch met BEFORE any usage record (newest-first). It
   * overrides the display model of the usage record the walk finds next: an idle
   * session that switched writes the switch but no new usage, so the usage
   * record's own model is stale. tokens/pct still come from the usage record; a
   * usage record met first (a turn ran after the switch) leaves this null and
   * the reading is byte-identical to before. */
  let pendingSwitch: ModelSwitch | null = null;
  for (let back = CONTEXT_TAIL_START; ; back *= 4) {
    const start = Math.max(0, size - back);
    const lines = await sliceLines(f, start, size); // bytes -> lines, no .text()
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const u = usageFromLine(lines[i]);
      if (u) return pendingSwitch
        ? { tokens: u.tokens, model: u.model, modelId: pendingSwitch.modelId,
            modelName: pendingSwitch.modelName, modelAcronym: pendingSwitch.modelAcronym }
        : u;
      if (isCompactBoundary(lines[i])) return COMPACTED;
      if (!pendingSwitch) pendingSwitch = modelSwitchFromLine(lines[i]);
    }
    if (start === 0 || back >= CONTEXT_TAIL_MAX) return null;
    await yieldToLoop(); // cede before reading a larger window
  }
}

/* USED, never left, and the two collide at the extremes: 95% used is nearly out
 * of room, 95% left is nearly empty. Floored, to agree with the pane
 * digit-for-digit, and clamped because a model whose window we have wrong is
 * better reported as full than as 340%. */
export function contextPct(u: ContextReading): number | null {
  /* A FRESHLY COMPACTED SESSION READS 0, and that is his call, 2026-08-05:
   * "Don't complicate the compaction button, just show 0% and not grey out."
   *
   * It is not a measurement -- nothing knows the new size until the agent's
   * next turn writes one, and the boundary's own `postTokens` counts only the
   * summary, without the system prompt and tools that land on top. What it is
   * is the honest shape of the answer: he just threw the conversation away, the
   * button should read empty, and it fills in for real the moment the session
   * speaks. Keeping the compaction as a TERMINATOR is what still matters; that
   * is what stopped it reporting the pre-compaction figure. */
  if (u === COMPACTED) return 0;
  if (!u) return null;
  const win = contextWindowFor(u.model); // never null (fail open, 2026-09-02)
  return Math.max(0, Math.min(100, Math.floor((u.tokens / win) * 100)));
}

/* Model id -> the name a person reads and its short badge spelling, composed
 * ENGINE-SIDE so the app renders it and composes nothing (the same rule as
 * `agent`/HARNESS.name: the engine knows which model is running, the app owns
 * the English around it).
 *
 * DERIVED, NOT LISTED, since 2026-09-02 (model-names.ts holds the one copy the
 * model-indicator plugin shares): `claude-<family>-<version>` becomes
 * "<Family> <v.v>" / "<F><v.v>", after the two real suffixes are stripped:
 *   - a DATED pin: `claude-haiku-4-5-20251001` (this box writes the date form
 *     for haiku and only haiku; 2150 records, zero bare) -> "Haiku 4.5" / "H4.5";
 *   - a 1M-context MARKER: `claude-opus-4-8[1m]`, `claude-opus-5[1m]` (637
 *     records): same model, 1M window on, the NAME is unchanged -> "Opus 4.8".
 * The hand list this replaced missed `claude-fable-5-1` (12,135 records) and
 * `claude-opus-4-6` (1,996), and a session on either lost its name. An id the
 * derivation cannot spell answers the friendly table or the RAW id, never null
 * (only an empty string does): a raw id under the session name is something a
 * person can read and report; a blank is not. */
export { bareModelId, modelAcronym, modelDisplayName } from "./model-names.ts";

/* The CURRENT model's display name for a reading, or null. Reads the SAME
 * reading `contextPct` does -- one backward scan of the transcript (the newest
 * assistant record's `message.model`), not a third reader.
 *
 * COMPACTED and null carry no current model: the newest usage is behind the
 * compaction boundary, or there is no assistant turn yet. Both answer null and
 * the app shows the harness alone, until the session's next turn writes a model
 * again -- the same honest "no reading yet" the context bar takes there. */
export function modelName(u: ContextReading): string | null {
  if (!u || u === COMPACTED) return null;
  // A /model switch newer than the usage record carries the display name it
  // resolved to (modelName override); otherwise derive it from the usage model.
  return u.modelName !== undefined ? u.modelName : modelDisplayName(u.model);
}

/* The CURRENT model's short badge acronym for a reading, or null -- the same
 * override rule modelName takes: a newer /model switch spells its own acronym,
 * else it is derived from the usage record's model. */
export function modelAcronymOf(u: ContextReading): string | null {
  if (!u || u === COMPACTED) return null;
  return u.modelAcronym !== undefined ? u.modelAcronym : modelAcronym(u.model);
}

/* The CURRENT model's RAW id for a reading, or null -- the one string both the
 * long name (modelDisplayName) and the short acronym (modelAcronym) are computed
 * from. Server caches this per session so the top bar's model row and the model
 * badge derive their two spellings from ONE stored fact, not two readings that
 * could drift. COMPACTED and null carry no current model, the same honest "no
 * reading yet" the name and the context bar take there. */
export function modelIdOf(u: ContextReading): string | null {
  if (!u || u === COMPACTED) return null;
  // A /model switch overrides the raw id too (null when its only evidence was
  // the stdout display name); absent means no switch, so the usage id stands.
  return u.modelId !== undefined ? u.modelId : u.model;
}

// ------------------------------------------------------------- ai title
//
// CLAUDE CODE'S OWN NAME FOR THE SESSION.
//
// Claude Code writes a record `{type:"ai-title", aiTitle, sessionId}` and
// RE-writes it as the conversation grows. Measured across every transcript on
// this machine on 2026-08-06: 112 of 120 recent sessions carry one (the 8 that
// do not are tiny throwaways that never earned a title), a busy session
// re-emits it up to ~2,900 times, and -- the property this reader leans on --
// the NEWEST copy is always within a few hundred bytes to ~24 KB of EOF even in
// a 300 MB file, with the value constant within a session. So the current
// title is the LAST such record, and a backward windowed read (the same shape
// readContextUsage uses) meets it in the first slice.
//
// A brand-new session has none yet (the title is generated after the first
// exchange lands), so this answers null and the caller falls back to the pane
// name -- never blank.
export function aiTitleFromLine(line: string): string | null {
  if (!line.includes('"ai-title"')) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== "ai-title") return null;
  const t = typeof rec.aiTitle === "string" ? rec.aiTitle.trim() : "";
  return t || null;
}

const TITLE_TAIL_START = 256 * 1024; // first window; the newest ai-title is in it
const TITLE_TAIL_MAX = 8 * 1024 * 1024; // no ai-title this deep from EOF means none current

/* Claude Code's session title, or null. Read backwards from the end, newest
 * wins, because the newest ai-title record is the one that names the session
 * now. The first line of a window that does not start at byte 0 is dropped: it
 * may have begun before the slice, and half a record parses as nothing anyway.
 * The window grows only if the tail carries no ai-title, which for a session
 * that has one never happens; a session that genuinely has none walks to byte 0
 * and answers null. */
export async function readSessionTitle(path: string): Promise<string | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  const size = f.size;
  for (let back = TITLE_TAIL_START; ; back *= 4) {
    const start = Math.max(0, size - back);
    const lines = await sliceLines(f, start, size); // bytes -> lines, no .text()
    if (start > 0) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = aiTitleFromLine(lines[i]);
      if (t) return t;
    }
    if (start === 0 || back >= TITLE_TAIL_MAX) return null;
    await yieldToLoop(); // cede before reading a larger window
  }
}

// ---------------------------------------------------------------- tail parse

// Forward incremental parser for the fs.watch tail: parses only appended
// bytes, never advances past an incomplete trailing line (reparsed on the
// next change). `offset` always sits at a line start.
/* Claude Code logs its own input queue: a `queue-operation` record with the
 * full text, `enqueue` when a message lands in the queue and `remove` (or
 * `dequeue`, which only shows up for input typed in the terminal) when it is
 * consumed into context. Measured on a live session: our delivered messages
 * pair 19/19 enqueue->remove. That is what tells the app which of your
 * messages Claude has actually read. */

/* What the app puts in front of everything it sends.
 *
 * It was only ever "VOICE: ", and this file used that string in four places
 * to recognise the app's own messages and keep them out of the session
 * overlay as duplicate prompts. Typed messages are tagged "TEXT: " now,
 * because a transcript and something the user typed are not the same kind of
 * evidence and the agent should be able to tell. Listing the prefixes once
 * means the next one added does not silently leak into the overlay. */
const APP_PREFIXES = ["VOICE: ", "TEXT: "] as const;
const isFromApp = (s: string) => APP_PREFIXES.some((p) => s.startsWith(p));
export type QueueOp = { op: "enqueue" | "consumed"; content: string; ts: number };

/* The authoritative "claude has read it" signal is the message's own `user`
 * record landing in the log: that is the moment it enters context, whether it
 * waited in the queue first or went straight through. Measured: a message
 * sent to a busy pane logs enqueue then remove then the user record, while
 * one sent to an idle pane logs ONLY the user record, so keying on queue
 * records alone left the marker stuck forever. */
export function deliveredTextFromLine(line: string): string | null {
  return deliveredFromLine(line)?.text ?? null;
}

/** The delivered text plus the record's identity (uuid, ts), for the ingest's
 *  `delivered` record; `off` is filled by the reader that knows it. */
export function deliveredFromLine(line: string): Omit<DeliveredRecord, "off"> | null {
  if (!APP_PREFIXES.some((p) => line.includes(`"${p}`))) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== "user" || typeof rec.promptId !== "string") return null;
  const c = rec.message?.content;
  const text = typeof c === "string"
    ? c
    : Array.isArray(c) ? c.map((b: any) => String(b?.text ?? "")).join("") : "";
  if (!isFromApp(text)) return null;
  const uuid = typeof rec.uuid === "string" ? rec.uuid : "";
  return { text, uuid, ts: Date.parse(rec.timestamp ?? "") || Date.now() };
}

export function queueOpFromLine(line: string): QueueOp | null {
  if (!line.includes('"queue-operation"')) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec?.type !== "queue-operation") return null;
  const op = rec.operation;
  const kind = op === "enqueue" ? "enqueue" : (op === "remove" || op === "dequeue") ? "consumed" : null;
  if (!kind) return null;
  const content = typeof rec.content === "string" ? rec.content : "";
  if (!content) return null;
  return { op: kind, content, ts: Date.parse(rec.timestamp ?? "") || Date.now() };
}

/* HOW MUCH ONE DRAIN READS AT MOST (design A.4): the 4 MB that used to be
 * the catch-up ceiling past which a cached offset was abandoned for EOF. The
 * pointer is never abandoned now; a tail that is further behind drains in
 * 4 MB pieces, the pump re-running until it is level, so no single drain
 * holds the loop for a whole backlog. */
export const TAIL_DRAIN_MAX = 4 * 1024 * 1024;

/** The three side outputs one transcript line can carry besides an event. */
export function tailSideOf(line: string, off: number, into: {
  queueOps: QueueOp[]; consumed: string[]; delivered: DeliveredRecord[];
}): void {
  const q = queueOpFromLine(line);
  if (q) into.queueOps.push(q);
  const d = deliveredFromLine(line);
  if (d) { into.consumed.push(d.text); into.delivered.push({ ...d, off }); }
}

/** One transcript line as an event with its byte offset, or null. */
export function tailEventOf(line: string, off: number): SessionEvent | null {
  const ev = parseLine(line);
  if (ev) ev.off = off;
  return ev;
}

export class SessionTailParser {
  offset = 0;
  /** true after a drain that stopped at TAIL_DRAIN_MAX with bytes still unread */
  behind = false;

  /* `eventOf` is the harness's line -> event extraction (the reader's declared
   * sessionEvents slot, readers/types.ts). The default is claude's tailEventOf,
   * the exact function every existing caller got, so a parser built without the
   * argument is byte-identical to before (the TurnStatusParser edgeOf shape). */
  constructor(readonly path: string,
    readonly eventOf: (line: string, off: number) => SessionEvent | null = tailEventOf) {}

  // queue operations seen in the last drain (the overlay ignores these; the
  // engine uses them to mark which messages Claude has taken into context)
  queueOps: QueueOp[] = [];
  // full delivered texts whose `user` record just landed: those messages are
  // in context now
  consumed: string[] = [];
  // the same landings with their record identity, for the ingest
  delivered: DeliveredRecord[] = [];

  async drain(): Promise<SessionEvent[]> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return [];
    const size = file.size;
    if (size < this.offset) this.offset = 0; // truncated: start over
    if (size === this.offset) { this.behind = false; return []; }
    let end = Math.min(size, this.offset + TAIL_DRAIN_MAX);
    let buf = new Uint8Array(await file.slice(this.offset, end).arrayBuffer());
    // one line longer than the cap (a base64 image) is read whole: the window
    // grows until it holds a newline or the file's end
    while (end < size && !buf.includes(0x0a)) {
      end = Math.min(size, end + TAIL_DRAIN_MAX);
      buf = new Uint8Array(await file.slice(this.offset, end).arrayBuffer());
    }
    const out: SessionEvent[] = [];
    this.queueOps = [];
    this.consumed = [];
    this.delivered = [];
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      const off = this.offset + lineStart;
      const line = decoder.decode(buf.subarray(lineStart, i)).trim();
      tailSideOf(line, off, this);
      const ev = this.eventOf(line, off);
      if (ev) out.push(ev);
      lineStart = i + 1;
    }
    this.offset += lineStart;
    this.behind = this.offset < size;
    return out;
  }
}

// ------------------------------------------------------- thinking indicator
//
// TURN EDGES FOR THE `thinking` DOTS, DERIVED FROM THE TRANSCRIPT (#490).
//
// The app's thinking indicator is `status === "working"`. Its only source was
// herdr's screen-scrape detection, which on herdr 0.8.0 x the current claude
// UI never reports `working` at all: measured on the test-sink pane, three
// turns (short reply, a 60-word story, a Bash tool turn), herdr emitted not one
// `working` status_changed the whole time, so the dots never lit.
//
// The transcript does carry the edges, cleanly and fast (MEASURED, LANE-DONE-490,
// claude-code 2.1.228, ms timestamps against the prompt going in):
//
//   working: the human/app `user` record lands ~0.45s after the prompt is sent.
//   idle:    the turn closes with `{type:"system",subtype:"turn_duration"}`
//            (and the final assistant message carries stop_reason "end_turn"),
//            ~0.09s after the reply, well under the ~1s edge-latency budget.
//
// `blocked` is DELIBERATELY ABSENT here and cannot come from the transcript: a
// permission dialog is drawn in the pane and never written to the jsonl, so it
// stays herdr's alone. This helper only ever answers working or idle.
export type TurnEdge = "working" | "idle";

/* One transcript line -> the turn edge it implies, or null for the many lines
 * (tool results, thinking blocks, snapshots, attachments) that are neither.
 *
 * A tool_use turn interleaves assistant records (stop_reason "tool_use", still
 * working) with tool_result `user` records (mid-turn, neither edge). Only the
 * FINAL assistant message of a turn carries stop_reason "end_turn", so that is
 * an idle signal too -- redundant with turn_duration on purpose, since either
 * marker alone is enough and a future claude version could drop one.
 *
 * Harness-authored `user` records also carry a promptId and do not get a
 * turn_duration: an interrupt or a slash-command / its stdout is idle; a
 * <task-notification> is neither edge (the parent is not starting a turn). */
export function turnEdgeFromLine(line: string): TurnEdge | null {
  if (!line || (!line.includes('"user"') && !line.includes('"assistant"') &&
                !line.includes("turn_duration"))) return null;
  let rec: any;
  try { rec = JSON.parse(line); } catch { return null; }
  if (!rec || typeof rec !== "object") return null;

  // the definitive end-of-turn record
  if (rec.type === "system" && rec.subtype === "turn_duration") return "idle";

  if (rec.type === "assistant") {
    // a resume writes a `<synthetic>` "No response requested" assistant record;
    // it is not a real turn and must not light the dots
    if (rec.message?.model === "<synthetic>") return null;
    // the last message of the turn ends it; an intermediate tool-call message
    // (stop_reason "tool_use") means the model is still working
    return rec.message?.stop_reason === "end_turn" ? "idle" : "working";
  }

  if (rec.type === "user") {
    // a resume's synthetic "Continue from where you left off" is isMeta; a
    // replayed compaction summary is isCompactSummary -- neither is a turn
    if (rec.isMeta || rec.isCompactSummary) return null;
    if (typeof rec.promptId !== "string") return null; // header/meta records
    const c = rec.message?.content;
    // a tool_result rides in on a `user` record (with a promptId) mid-turn: the
    // model is already working, this is not a new turn opening
    if (Array.isArray(c) && c.some((b: any) => b && typeof b === "object" && "tool_use_id" in b)) {
      return null;
    }
    // Ctrl-C / Escape writes a promptId'd `user` record whose whole text is
    // "[Request interrupted by user]". It LOOKS like a fresh prompt, but it is
    // the END of a turn, and nothing (no turn_duration, no end_turn) follows it.
    // Left as "working" the dots would spin forever after an interrupt (#521);
    // it is the closing edge, so it is idle.
    const raw = typeof c === "string"
      ? c
      : Array.isArray(c) ? c.map((b: any) => String(b?.text ?? "")).join("") : "";
    if (raw.trim() === "[Request interrupted by user]") return "idle";
    // a background-agent <task-notification> is the same class of harness user
    // record as the interrupt: promptId and all, but it is not a person typing
    // and it does not start a turn. Claude writes no turn_duration after it.
    // Left as "working" the dots stay lit after a finished parent turn (#383's
    // record, missed by the #521 interrupt special-case).
    if (raw.includes(TASK_NOTIFICATION_TAG)) return null;
    // /exit, /compact, /model, their stdout, a `!` bash line: also harness
    // authored, also no turn_duration. /exit after a live turn would otherwise
    // leave the dots spinning on a pane that has already quit. These ARE the
    // end of whatever was happening, so they are idle.
    if (HARNESS_COMMAND_RE.test(raw)) return "idle";
    // a real prompt entering context -- human OR the app's own VOICE:/TEXT:
    // delivery (unlike the overlay, we WANT app messages to light the dots,
    // because the agent starts working the moment one lands)
    return "working";
  }
  return null;
}

/* Forward incremental reader over one session jsonl that answers ONLY "what is
 * the newest turn edge in the bytes appended since last drain", for the thinking
 * indicator. The twin of SessionTailParser but it builds no events and keeps no
 * per-line state: a drain returns the LAST edge seen in the new bytes (edges
 * within one drain collapse, e.g. prompt...turn_duration in one batch is idle),
 * or null when the appended bytes carried no edge. `offset` always sits at a
 * line start; a partial trailing line is left for the next drain. */
export class TurnStatusParser {
  offset = 0;
  constructor(readonly path: string, readonly edgeOf: (line: string) => TurnEdge | null = turnEdgeFromLine) {}

  async drain(): Promise<TurnEdge | null> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return null;
    const size = file.size;
    if (size < this.offset) this.offset = 0; // truncated/rotated: start over
    if (size === this.offset) return null;
    const buf = new Uint8Array(await file.slice(this.offset, size).arrayBuffer());
    let edge: TurnEdge | null = null;
    let lineStart = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0x0a) continue;
      const e = this.edgeOf(decoder.decode(buf.subarray(lineStart, i)).trim());
      if (e) edge = e;
      lineStart = i + 1;
    }
    this.offset += lineStart;
    return edge;
  }
}

// ---------------------------------------------------------------- unit run

// bun agent-engine/src/sessions/session-events.ts <file.jsonl> [limit]
// Prints kind counts + the newest events, then asserts the VOICE/speak
// dedupe: raw records with app traffic exist, extracted events carry none.
if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: bun session-events.ts <file.jsonl> [limit]");
    process.exit(1);
  }
  const limit = Number(process.argv[3] ?? 500);

  const { events, more } = await readEventsTail(path, { limit });
  const counts: Record<string, number> = {};
  for (const ev of events) counts[ev.kind] = (counts[ev.kind] ?? 0) + 1;
  console.log(`${events.length} events (more=${more}) from ${path}`);
  console.log("kind counts:", counts);
  for (const ev of events.slice(-30)) {
    console.log(`  ${new Date(ev.ts).toISOString()} [${ev.kind}] ${ev.text.slice(0, 100)}`);
  }

  // dedupe assertion against the raw file, streamed rather than read whole (the
  // robustness ruling holds even for the dev CLI: no session-jsonl read reads the
  // whole file or calls .text()).
  let rawVoice = 0;
  let rawSpeakShow = 0;
  await streamLinesForward(Bun.file(path), 0, Bun.file(path).size, (line) => {
    let rec: any;
    try { rec = JSON.parse(line); } catch { return; }
    const c = rec?.message?.content;
    if (rec?.type === "user" && typeof c === "string" && isFromApp(c)) rawVoice++;
    if (rec?.type === "assistant" && Array.isArray(c) && c[0]?.type === "tool_use" &&
      isOutputToolName(String(c[0].name ?? ""))) rawSpeakShow++;
  });
  const leakedVoice = events.filter((e) =>
    e.kind === "prompt" && APP_PREFIXES.some((p) => e.text.startsWith(`> ${p}`))).length;
  const leakedSpeak = events.filter((e) => isOutputToolName(String(e.tool ?? ""))).length;
  console.log(`raw app traffic: ${rawVoice} VOICE prompts, ${rawSpeakShow} speak/show tool calls`);
  console.log(`leaked into events: ${leakedVoice} VOICE prompts, ${leakedSpeak} speak/show tools`);
  if (leakedVoice || leakedSpeak) {
    console.error("DEDUPE ASSERTION FAILED");
    process.exit(1);
  }
  const overCap = events.filter((e) =>
    e.text.length > ((e.kind === "prompt" || e.kind === "reply") ? BODY_CAP + 3 : TEXT_CAP + 3)).length;
  console.log(overCap ? `CAP ASSERTION FAILED: ${overCap} events over ${TEXT_CAP} chars` : "dedupe + cap assertions passed");
  if (overCap) process.exit(1);
}

// ------------------------------------------------------------- agent runs
//
// The pinned-bar feature: which subagents/workflows this session has running
// and what recently finished. Parsed from the same jsonl, forward over the
// tail window so tool_use launches pair with their results/notifications.
// Background agents: the immediate tool_result only says "launched" and
// carries an agentId; the real completion is a later user record containing
// <task-notification> with the matching <task-id> (and token usage).

export type AgentRun = {
  toolUseId: string;
  agentId: string | null; // background agents: harness id from the launch result
  ts: number;             // launch time
  desc: string;
  endedTs: number | null;
  tokens: string | null;  // "217k", from the completion notification
  // PERSONAL ADAPTER (agent-engine/src/adapters/piagent.ts): set only for pi-lanes.
  // Vanilla Claude subagents leave both undefined and render exactly as before.
  source?: "pi";
  model?: string;         // model badge, e.g. "grok-4.6"
  // PERSONAL ADAPTER: the pi-lane's launch command, kept so the stop route can
  // find the live pi-run process by the unique task text it was launched with.
  // pi-run writes no pidfile, so the command is the only handle on the process.
  command?: string;
};

/* RUN ENRICHER (adapter inversion). An OUT-OF-TREE personal
 * adapter (piagent) may recognize its own background launches as runs and fill
 * their model labels, but core must NOT import it. Instead the composition root
 * registers an enricher behind the CYC_PIAGENT_ADAPTER gate; with none
 * registered (the vanilla default) both call sites below behave exactly as they
 * did with the flag unset: no extra run recognized, no post-parse enrichment.
 *
 *   fromToolUse: turn a matching tool_use block into an AgentRun, or null.
 *   enrichRuns:  best-effort, silent post-parse pass over the finished run list.
 */
export type RunEnricher = {
  fromToolUse(b: any, ts: number): AgentRun | null;
  enrichRuns(runs: AgentRun[]): Promise<void>;
};

let runEnricher: RunEnricher | null = null;

/** Register (or, with null, clear) the run enricher. Called only by the
 *  composition root behind the CYC_PIAGENT_ADAPTER gate. */
export function registerRunEnricher(e: RunEnricher | null): void {
  runEnricher = e;
}

const RUN_STALE_MS = 4 * 60 * 60 * 1000; // open runs older than this are phantoms

/* THERE IS NO BYTE WINDOW, and its absence is the fix.
 *
 * This read a fixed 8 MB tail. He reported the consequence on 2026-08-03: the
 * terminal said one agent was running, the app said none. Measured at that
 * moment -- session jsonl 77.1 MB, the launch record 11.3 MB from the end, the
 * window 8 MB. The launch was 3.3 MB outside it. The agent was running and the
 * app could not see that it had ever STARTED.
 *
 * It failed in exactly the case it exists for. The longer an agent runs, and
 * the busier the conversation while it runs, the further its launch scrolls
 * back, so a long run is the most certain to disappear. That one was 1h45m old.
 *
 * The same window produced the OPPOSITE complaint a day earlier ("the count is
 * higher than the number of agents running"): a fixed tail can lose a launch, or
 * keep a run whose completion also fell out. One mechanism, two contradictory
 * symptoms, which is what a wrong unit looks like.
 *
 * So the unit is now time, which is the unit the question is actually asked in:
 *
 *   COLD: walk BACKWARDS from the end until a record older than RUN_STALE_MS,
 *   then parse forward from there. Nothing before that point can matter -- the
 *   phantom guard closes anything that old regardless -- and nothing after it
 *   can be missed. Reading less loses launches; reading more is wasted work.
 *
 *   WARM: parse only the bytes that arrived since last time, continuing the
 *   same maps. The steady state is the poll interval's worth of new transcript,
 *   which is kilobytes, not the 12ms-per-call 8 MB re-scan this replaces.
 *
 * A poll that finds no growth still costs nothing: size is the cache key. */
const COLD_STEP_BYTES = 4 * 1024 * 1024; // how far back each cold probe reaches

type RunsState = {
  size: number;      // file size when we last parsed
  parsedTo: number;  // byte offset just past the last COMPLETE line consumed
  runs: Map<string, AgentRun>;
  byAgentId: Map<string, AgentRun>;
  pending: Map<string, { to: string; ts: number; summary: string }>;
  out: AgentRun[];
};
const runsCache = new Map<string, RunsState>();
const RUNS_CACHE_MAX = 64; // paths = session files; evict oldest-inserted past this

/* ONE NOTIFICATION CLOSES EVERY RUN IT NAMES, and the plural is the fix.
 *
 * Both readers below used a NON-GLOBAL `.match` for <task-id>, so a record
 * naming two agents closed the first and left the second open for ever. That
 * record is not hypothetical and not rare: when a session restarts, the sweep
 * for background agents it can no longer account for writes ONE notification
 * listing all of them. From his own transcript, verbatim:
 *
 *   <task-notification>
 *   <task-id>a81544f5025291cc9</task-id>
 *   <task-id>a7a5f93844dd51b33</task-id>
 *   <status>stopped</status>
 *   <summary>No completion record was found for 2 background agents ...
 *
 * He saw the second half of that on 2026-08-05: "1 agent running / The profile
 * pane, 2h 36m", with nothing running and the timer climbing, because the bar
 * ticks now - run.ts for as long as endedTs is null. Only the four-hour phantom
 * guard would ever have closed it.
 *
 * Per BLOCK rather than per record, because a record can carry several
 * notifications (an attachment record repeats them), and tokens belong to the
 * block that reported them: a stopped sweep carries no <subagent_tokens> at
 * all, so nothing is attributed to runs it did not measure. */
function closeNotified(text: string, ts: number, byAgentId: Map<string, AgentRun>): void {
  for (const chunk of text.split("<task-notification>").slice(1)) {
    const end = chunk.indexOf("</task-notification>");
    const block = end >= 0 ? chunk.slice(0, end) : chunk;
    const tk = block.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/);
    for (const m of block.matchAll(/<task-id>([a-z0-9]+)<\/task-id>/g)) {
      const run = byAgentId.get(m[1]);
      if (!run) continue;
      run.endedTs = ts;
      if (tk) run.tokens = fmtTokens(Number(tk[1]));
    }
  }
}

function phantomGuard(runs: AgentRun[]): AgentRun[] {
  // an open run with no completion for hours is a dead agent
  const now = Date.now();
  return runs.map((r) =>
    r.endedTs === null && now - r.ts > RUN_STALE_MS ? { ...r, endedTs: r.ts } : r);
}

/* Where to start a cold parse: the first complete line at or before the point
 * where the transcript is older than the phantom cutoff. Steps back a chunk at
 * a time and reads ONE timestamp per step, so the cost of finding the offset is
 * a few slices rather than a parse of the file. */
async function coldStart(f: ReturnType<typeof Bun.file>, size: number): Promise<number> {
  const cutoff = Date.now() - RUN_STALE_MS;
  let back = COLD_STEP_BYTES;
  while (back < size) {
    const at = size - back;
    const head = decoder.decode(await f.slice(at, Math.min(size, at + 256 * 1024)).arrayBuffer());
    const nl = head.indexOf("\n");
    if (nl >= 0) {
      const line = head.slice(nl + 1, head.indexOf("\n", nl + 1) + 1 || undefined);
      const m = line.match(/"timestamp":"([^"]+)"/);
      const ts = m ? Date.parse(m[1]) : NaN;
      // this far back is already older than anything the guard would keep open
      if (Number.isFinite(ts) && ts < cutoff) return at + nl + 1;
    }
    back *= 2;
  }
  return 0; // the whole file is inside the window
}

export async function readAgentRuns(path: string): Promise<AgentRun[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) return [];
  const size = f.size;
  const cached = runsCache.get(path);
  if (cached && cached.size === size) return phantomGuard(cached.out);

  /* Continue the previous parse when the file has only GROWN. A shrink means
   * this is a different file wearing the same name (rotated, or a session
   * replaced), and continuing would carry runs that no longer exist. */
  const warm = cached && size > cached.size ? cached : null;
  const runs = warm ? warm.runs : new Map<string, AgentRun>();
  const byAgentId = warm ? warm.byAgentId : new Map<string, AgentRun>();
  const from = warm ? warm.parsedTo : await coldStart(f, size);
  /* Resume requests waiting on their answer, CARRIED between polls. A request
   * and its result are adjacent records but a poll can still land between them,
   * and a per-parse map would drop the intent and leave a genuinely resumed
   * agent invisible. Waiting costs nothing: an entry does nothing at all until
   * its own result arrives, and it is swept with the finished runs below. */
  const pendingResume = warm ? warm.pending
    : new Map<string, { to: string; ts: number; summary: string }>();

  /* Stream [from, size) FORWARD in bounded blocks that yield to the loop, rather
   * than reading the whole span into one string. A cold parse can span the last
   * four hours of a busy transcript (hundreds of MB in the worst case), and a
   * single .text() of that was the freeze the robustness ruling forbids. Only
   * whole lines are consumed; the trailing partial (a poll landing mid-write) is
   * left for the next call, which resumes at parsedTo.
   *
   * Each line is folded into the run maps INSIDE the stream callback, so nothing
   * larger than one line and the (tiny, bounded) run/pending state is ever
   * resident. Buffering the whole span into an array first grew RSS ~3x the file
   * size on a large cold parse (a defect from the pointer verdict); a 1 GB
   * session on a memory-limited host could OOM-kill the engine on its first
   * agents poll. Only the loop yielded, not the memory; now neither is a
   * function of file size. `handleLine` returns early (never `continue`, there is
   * no outer loop) to skip a line that carries nothing we keep. */
  const handleLine = (line: string): void => {
    if (!line) return;
    let rec: any;
    try { rec = JSON.parse(line); } catch { return; }
    const ts = Date.parse(rec?.timestamp ?? "") || 0;
    const content = rec?.message?.content;

    /* A COMPLETION IS A COMPLETION WHATEVER RECORD IT ARRIVES IN.
     *
     * This used to insist on `rec.type === "user"` with a plain-string body,
     * which is one of the shapes a task-notification takes and not the only
     * one. The others (observed: "attachment", "queue-operation") were skipped
     * entirely, so those runs never got an endedTs and sat "running" until the
     * four-hour phantom guard swept them.
     *
     * He saw the consequence three times in one evening: the app's banner
     * claiming four agents running, naming one that had finished half an hour
     * earlier, while the terminal was idle. Measured on the live engine at the
     * time: four open runs, all finished, the oldest 161 minutes; every one of
     * their completion records was inside the parse window and being ignored.
     *
     * So the test is now the only thing that actually matters: does this line
     * carry a task-notification with an id we are following. The line is
     * already in hand as a string, so this costs one substring check on lines
     * that overwhelmingly do not contain it. */
    if (line.includes("<task-notification>")) {
      closeNotified(line, ts, byAgentId);
      // A notification record carries nothing else we want, EXCEPT when it is
      // an array-shaped user record that also holds tool_results; those fall
      // through below rather than being dropped here.
      if (!Array.isArray(content)) return;
    }
    if (!Array.isArray(content)) return;
    if (rec.type === "assistant") {
      for (const b of content) {
        if (b?.type !== "tool_use") continue;

        /* RESUMING AN AGENT IS A RUN TOO.
         *
         * SendMessage puts an already-finished background agent back to work,
         * and that work is exactly as long and as interesting as the original
         * launch. It has no launch record of its own, so a bar that only knows
         * Agent/Task/Workflow shows nothing for the whole resumed run.
         *
         * Seen in the ten-ring-keyboard session: one Agent launch and three
         * SendMessage resumes to the same agent. The bar was empty for three of
         * the four runs.
         *
         * The completion side already works: a resume finishes with the same
         * <task-notification> carrying the same task-id, which the handler
         * above matches through byAgentId. All that is missing is the reopen. */
        /* ASKING TO RESUME IS NOT RESUMING, and the difference is a bug he
         * reported: "the agents list now shows 'Keep line numbers when wrapped'
         * as running but I know it isn't, it had landed."
         *
         * Traced in his own transcript. That agent launched, finished, and was
         * correctly closed by its notification. Then a SendMessage to it was
         * answered with:
         *
         *   {"success":false,"message":"Agent \"aa05...\" could not be resumed:
         *    No transcript found for agent ID: aa05..."}
         *
         * The resume never happened. The reopen did, because it fired on the
         * tool_use -- on the REQUEST -- and nothing afterwards could close a run
         * that had never restarted. It sat there until the four hour phantom
         * guard, showing an agent that had finished.
         *
         * So the request only records intent. The result below decides. */
        if (b.name === "SendMessage") {
          const to = typeof b.input?.to === "string" ? b.input.to : "";
          if (!to) continue;
          pendingResume.set(String(b.id), { to, ts,
            summary: typeof b.input?.summary === "string" && b.input.summary.trim()
              ? b.input.summary.trim() : "" });
          continue;
        }

        /* PERSONAL ADAPTER, gated. A background pi-run/pi-workflow Bash launch
         * becomes a pi-tagged run; the result/notification handling below then
         * closes it like any background agent. With the flag unset this whole
         * branch is skipped and a Bash tool_use falls through as before. */
        if (runEnricher) {
          const pi = runEnricher.fromToolUse(b, ts);
          if (pi) { runs.set(pi.toolUseId, pi); continue; }
        }

        if (b.name !== "Agent" && b.name !== "Task" && b.name !== "Workflow") continue;
        const desc = typeof b.input?.description === "string" && b.input.description.trim()
          ? b.input.description.trim()
          : (b.name === "Workflow" ? "workflow" : String(b.input?.subagent_type ?? b.name));
        runs.set(String(b.id), {
          toolUseId: String(b.id), agentId: null, ts, desc,
          endedTs: null, tokens: null,
        });
      }
      return;
    }
    if (rec.type !== "user") return;
    // array-shaped user records: a completion can also arrive as a text block
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string" && b.text.includes("<task-notification>")) {
        closeNotified(b.text, ts, byAgentId);
      }
    }
    for (const b of content) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      const key = String(b.tool_use_id);
      const text = typeof b.content === "string"
        ? b.content
        : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join(" ") : "";

      /* The answer to a resume request. Only a success reopens the run; a
       * refusal leaves whatever was there alone, which for a finished agent
       * means it stays finished. A request whose result never arrives (the poll
       * landed mid-write) also stays closed, which is the safe direction: the
       * bar under-claims for one poll rather than showing a phantom for hours. */
      const want = pendingResume.get(key);
      if (want) {
        pendingResume.delete(key);
        if (/"success"\s*:\s*false/.test(text)) continue;
        /* A CROSS-SESSION send is NOT this session's agent. It targets another
         * Claude session (a `uds:` socket, or a peer named in the send-tool's
         * "another Claude session ... Remote Control" phrasing), always
         * succeeds, and NOTHING in THIS transcript ever closes it: the peer's
         * replies arrive as <cross-session-message> records the tracker rightly
         * ignores, so a run recorded here would sit "running" until the 4h
         * phantom guard (his idle "1 agent running", #cross-session). Record no
         * run; an in-process send below is unchanged. */
        if (want.to.startsWith("uds:")) continue;
        if (text.includes("another Claude session") || text.includes("Remote Control")) continue;
        const known = byAgentId.get(want.to);
        if (known) {
          known.endedTs = null;
          known.ts = want.ts;  // restart the clock, so the phantom guard
          known.tokens = null; // measures this run and not the first one
          // the resume's summary is what it is doing NOW; the launch
          // description is what it was doing an hour ago
          if (want.summary) known.desc = want.summary;
          continue;
        }
        // launched before the parse window: the resume is all we have, so it
        // becomes the run. Keyed off the agent id rather than the tool_use id,
        // so this same result cannot also read as a synchronous completion.
        const run: AgentRun = {
          toolUseId: `send:${want.to}`, agentId: want.to, ts: want.ts,
          desc: want.summary || want.to, endedTs: null, tokens: null,
        };
        runs.set(run.toolUseId, run);
        byAgentId.set(want.to, run);
        continue;
      }

      if (!runs.has(key)) continue;
      const run = runs.get(key)!;
      /* A BACKGROUND WORKFLOW ANNOUNCES ITSELF IN ITS OWN WORDS, and 2.1.228 is
       * the version that made a background Workflow common. An Agent launch
       * result opens with "Async agent launched successfully" and carries
       * "agentId: <id>"; a Workflow launch result instead opens with "Workflow
       * launched in background. Task ID: <id>". Neither of the two old phrases
       * appears in it, so `launched` read false and the run was stamped ended at
       * its own launch -- an agent that ran for an hour showed as finished the
       * instant it started, which is his report: many workflows running, the bar
       * shows none. The id was missed too ("Task ID:" is not "agentId:"), so its
       * <task-notification> could not have closed it either.
       *
       * "launched in background" is the general form ("<Something> launched in
       * background. Task ID: ..."); the id is captured from either label so the
       * completion side, which keys off byAgentId by <task-id>, still matches. */
      /* A Bash background launch (the pi adapter runs pi via Bash background)
       * reports "Command running in background with ID: <id>" -- no "the", and
       * the id is behind "ID:" not "agentId:"/"Task ID:", so both the old
       * `launched` test and the old id capture missed it and the run was stamped
       * ended at its own launch. Accept that phrase and a bare "ID:" id. General
       * fix, not pi-gated; harmless in vanilla, where no Bash tool_use ever
       * becomes a tracked run (only the pi adapter creates Bash-backed runs). */
      const launched = /Async agent launched|launched in background|running in the background|running in background/i.test(text);
      const idm = text.match(/agentId:\s*([a-z0-9]+)/i) || text.match(/Task ID:\s*([a-z0-9]+)/) || text.match(/\bID:\s*([a-z0-9]+)/i);
      if (idm) { run.agentId = idm[1]; byAgentId.set(idm[1], run); }
      if (!launched) run.endedTs = ts; // synchronous agent: result IS completion
    }
  };
  const parsedTo = await streamLinesForward(f, from, size, handleLine);
  /* Runs that ended long ago are dropped from the carried state, or a session
   * open for days would accumulate every agent it ever ran. The cutoff is the
   * phantom guard's, so nothing droppable could still be shown. */
  const floor = Date.now() - RUN_STALE_MS;
  for (const [k, r] of runs) {
    if (r.endedTs !== null && r.endedTs < floor) {
      runs.delete(k);
      if (r.agentId) byAgentId.delete(r.agentId);
    }
  }
  const out = [...runs.values()].sort((a, b) => a.ts - b.ts);
  // PERSONAL ADAPTER, gated: fill each pi-lane's resolved model from history.
  // Best-effort and silent; never throws, never blocks the feed. Only runs when
  // an enricher is registered (composition root, behind CYC_PIAGENT_ADAPTER).
  if (runEnricher) await runEnricher.enrichRuns(out);
  runsCache.delete(path); // re-insert so eviction order tracks recency of use
  for (const [k, w] of pendingResume) if (w.ts < floor) pendingResume.delete(k);
  runsCache.set(path, { size, parsedTo, runs, byAgentId, pending: pendingResume, out });
  if (runsCache.size > RUNS_CACHE_MAX) {
    const oldest = runsCache.keys().next().value;
    if (oldest !== undefined) runsCache.delete(oldest);
  }
  return phantomGuard(out);
}
