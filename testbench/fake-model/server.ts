/* The fake model: the only network peer a cell has (loopback).
 *
 * Speaks three provider dialects, streaming, so the real harness binaries run
 * a real turn against it:
 *   POST /v1/messages           Anthropic messages SSE     (claude)
 *   POST /v1/responses          OpenAI responses SSE       (codex)
 *   POST /v1/chat/completions   OpenAI chat completions SSE (opencode, pi)
 *   GET  /v1/models             a model list for clients that probe it
 *
 * Every request is appended to requests.jsonl (FAKE_MODEL_LOG), one line per
 * call, with the dialect, the model, and the user texts in the order they were
 * sent. Scenarios read that file as the oracle for "did the message reach the
 * model": the last user text of some request contains what the engine typed.
 *
 * Replies are scripted, keyed by scenario: FAKE_MODEL_SCRIPT names a json in
 * scripts/ (or a path). A script is { default, rules: [{match, reply, ...}] };
 * the first rule whose regex matches the last user text wins. A reply can be
 * slow (chunks spaced by slowMs) so the harness stays busy for a while; slow
 * mode can also be switched on for every reply at runtime:
 *   POST /_control {"slow": true | false | <ms per chunk>}
 *   GET  /_control/requests    the log so far, as json
 *
 * Runs under bun. No dependencies. Never proxies anywhere: an unknown route
 * is a 404 written to the log with dialect "unknown". */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Rule = {
  match: string;
  reply: string;
  /** ms between streamed chunks (0 = as fast as possible) */
  slowMs?: number;
  /** how many chunks to split the reply into (default: by word, or 20 in slow mode) */
  chunks?: number;
  /** ms before the first byte */
  delayMs?: number;
  /** a scripted tool call: the FIRST request matching the rule gets a shell
   *  tool call running `command` (the tool is picked from the ones the
   *  request declares: Bash / bash / shell / local_shell, input shaped to its
   *  schema); the follow-up request carrying the tool result gets `reply`. */
  tool?: { command: string };
};
export type Script = { default: string; rules?: Rule[]; slowMs?: number };

export type LoggedRequest = {
  ts: number;
  seq: number;
  dialect: "anthropic-messages" | "openai-responses" | "openai-chat" | "models" | "unknown";
  method: string;
  path: string;
  model?: string;
  stream?: boolean;
  /** every user-role text in order (system/instructions excluded) */
  userTexts: string[];
  /** the last user text, the thing the harness just submitted */
  lastUser: string;
  messageCount: number;
  reply?: string;
  slowMs?: number;
  status: number;
  /** the tool names the request declared */
  tools?: string[];
  /** this response was a tool call */
  toolCall?: { name: string; command: string; input?: Record<string, unknown> };
  /** this request carried a tool result (its text, trimmed) */
  toolResult?: string;
};

type Dialect = LoggedRequest["dialect"];

/** scripts/<scenario>.json when the scenario has one, else scripts/default.json
 *  (SLOW-TURN and ECHO rules every scenario can lean on), else a bare "ok" */
export function loadScript(nameOrPath: string | undefined): Script {
  const dflt = join(import.meta.dir, "scripts", "default.json");
  const p = !nameOrPath ? dflt
    : nameOrPath.endsWith(".json") ? nameOrPath
    : join(import.meta.dir, "scripts", `${nameOrPath}.json`);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as Script;
  if (existsSync(dflt)) return JSON.parse(readFileSync(dflt, "utf8")) as Script;
  return { default: "ok" };
}

/* Text extraction per dialect: what the user said, in order. Content can be a
 * string or a parts array in every one of these APIs. */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => {
        if (typeof p === "string") return p;
        if (p && typeof p.text === "string" && (p.type === "text" || p.type === "input_text" || !p.type)) return p.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function userTextsOf(dialect: Dialect, body: any): string[] {
  const out: string[] = [];
  if (dialect === "anthropic-messages" || dialect === "openai-chat") {
    for (const m of body?.messages ?? []) {
      if (m?.role !== "user") continue;
      const t = partsText(m.content);
      /* Anthropic tool_result blocks are role user too; skip pure tool results */
      if (t) out.push(t);
    }
  } else if (dialect === "openai-responses") {
    const input = body?.input;
    if (typeof input === "string") out.push(input);
    else if (Array.isArray(input)) {
      for (const m of input) {
        if (m?.role !== "user") continue;
        const t = partsText(m.content);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/* Tools, per dialect: what the request declares, and whether it ends on a
 * tool result (the harness reporting back after running our call). */
export type DeclaredTool = { name: string; type: string; commandKey: string; commandIsArray: boolean; params: string[] };
export function declaredTools(dialect: Dialect, body: any): DeclaredTool[] {
  const out: DeclaredTool[] = [];
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    const type = String(t?.type ?? "function");
    const name = String(t?.name ?? t?.function?.name ?? (type === "local_shell" ? "local_shell" : ""));
    if (!name) continue;
    const schema = t?.input_schema ?? t?.parameters ?? t?.function?.parameters ?? {};
    const props = schema?.properties ?? {};
    /* the shell command's own key: claude/opencode/pi say `command`, codex's
     * exec_command says `cmd` */
    const commandKey = ["command", "cmd", "commands", "script"].find((k) => k in props) ?? "command";
    out.push({ name, type, commandKey, commandIsArray: props[commandKey]?.type === "array", params: Object.keys(props) });
  }
  return out;
}
const SHELL_NAMES = ["Bash", "bash", "shell", "local_shell", "shell_command", "exec_command", "execute_command", "run_shell_command"];
export function shellToolOf(tools: DeclaredTool[]): DeclaredTool | null {
  for (const n of SHELL_NAMES) { const t = tools.find((x) => x.name === n); if (t) return t; }
  return tools.find((t) => /bash|shell|exec/i.test(t.name)) ?? null;
}
export function trailingToolResult(dialect: Dialect, body: any): string | null {
  const text = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map((x: any) => (typeof x === "string" ? x : x?.text ?? x?.output ?? "")).join("\n");
    if (v && typeof v === "object") return String((v as any).output ?? (v as any).text ?? JSON.stringify(v));
    return "";
  };
  if (dialect === "anthropic-messages") {
    const last = (body?.messages ?? [])[body?.messages?.length - 1];
    if (last?.role !== "user" || !Array.isArray(last.content)) return null;
    const tr = last.content.filter((p: any) => p?.type === "tool_result");
    return tr.length ? tr.map((p: any) => text(p.content)).join("\n") : null;
  }
  if (dialect === "openai-responses") {
    const input = Array.isArray(body?.input) ? body.input : [];
    const last = input[input.length - 1];
    if (last?.type === "function_call_output" || last?.type === "local_shell_call_output" || last?.type === "custom_tool_call_output") return text(last.output);
    return null;
  }
  const last = (body?.messages ?? [])[body?.messages?.length - 1];
  return last?.role === "tool" ? text(last.content) : null;
}
/** the tool call's input, shaped to the declared tool's schema */
export function shellInput(tool: DeclaredTool, command: string): Record<string, unknown> {
  if (tool.type === "local_shell") return { command: ["bash", "-lc", command] };
  const input: Record<string, unknown> = { [tool.commandKey]: tool.commandIsArray ? ["bash", "-lc", command] : command };
  if (tool.params.includes("description")) input.description = "testbench scripted tool call";
  /* a bounded call: the cyc PreToolUse hook (enforce-bash-async) refuses a
   * Bash call with no timeout and no background flag */
  if (tool.params.includes("timeout")) input.timeout = 60_000; // the cyc bash hook caps a foreground call at 60 s
  else if (tool.params.includes("timeout_ms")) input.timeout_ms = 60_000;
  return input;
}

export function pickReply(script: Script, lastUser: string): Rule {
  for (const r of script.rules ?? []) {
    let re: RegExp;
    try { re = new RegExp(r.match, "s"); } catch { continue; }
    if (re.test(lastUser)) return r;
  }
  return { match: "", reply: script.default, slowMs: script.slowMs };
}

export function splitChunks(text: string, n?: number): string[] {
  if (n && n > 0) {
    const size = Math.max(1, Math.ceil(text.length / n));
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out.length ? out : [""];
  }
  const words = text.split(/(?<=\s)/);
  return words.length ? words : [""];
}

const enc = new TextEncoder();
function sse(event: string | null, data: unknown): Uint8Array {
  const head = event ? `event: ${event}\n` : "";
  return enc.encode(`${head}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

let idSeq = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++idSeq).toString(36)}`;

/* One streaming body per dialect. `pace` yields between chunks. */
export function anthropicStream(model: string, chunks: string[], pace: () => Promise<void>): ReadableStream<Uint8Array> {
  const id = newId("msg");
  return new ReadableStream({
    async start(c) {
      c.enqueue(sse("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null,
          stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } },
      }));
      c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      c.enqueue(sse("ping", { type: "ping" }));
      let n = 0;
      for (const ch of chunks) {
        if (n++) await pace();
        c.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } }));
      }
      c.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      c.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: Math.max(1, chunks.join("").length >> 2) } }));
      c.enqueue(sse("message_stop", { type: "message_stop" }));
      c.close();
    },
  });
}

export function anthropicToolStream(model: string, tool: DeclaredTool, input: Record<string, unknown>, pace: () => Promise<void>): ReadableStream<Uint8Array> {
  const id = newId("msg");
  const toolId = newId("toolu");
  const json = JSON.stringify(input);
  return new ReadableStream({
    async start(c) {
      c.enqueue(sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } }));
      c.enqueue(sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name: tool.name, input: {} } }));
      const half = Math.ceil(json.length / 2);
      c.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, half) } }));
      await pace();
      c.enqueue(sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(half) } }));
      c.enqueue(sse("content_block_stop", { type: "content_block_stop", index: 0 }));
      c.enqueue(sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }));
      c.enqueue(sse("message_stop", { type: "message_stop" }));
      c.close();
    },
  });
}
export function anthropicToolJson(model: string, tool: DeclaredTool, input: Record<string, unknown>) {
  return { id: newId("msg"), type: "message", role: "assistant", model, content: [{ type: "tool_use", id: newId("toolu"), name: tool.name, input }],
    stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 25, output_tokens: 20 } };
}

export function anthropicJson(model: string, text: string) {
  return { id: newId("msg"), type: "message", role: "assistant", model,
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 25, output_tokens: Math.max(1, text.length >> 2) } };
}

export function responsesStream(model: string, chunks: string[], pace: () => Promise<void>): ReadableStream<Uint8Array> {
  const rid = newId("resp");
  const mid = newId("msg");
  const text = chunks.join("");
  const base = (status: string, output: unknown[]) => ({
    id: rid, object: "response", created_at: Math.floor(Date.now() / 1000), status, model, output,
    usage: { input_tokens: 25, output_tokens: Math.max(1, text.length >> 2), total_tokens: 25 + Math.max(1, text.length >> 2) },
  });
  let seq = 0;
  const ev = (type: string, extra: Record<string, unknown>) => sse(type, { type, sequence_number: seq++, ...extra });
  return new ReadableStream({
    async start(c) {
      c.enqueue(ev("response.created", { response: base("in_progress", []) }));
      c.enqueue(ev("response.in_progress", { response: base("in_progress", []) }));
      const item = { id: mid, type: "message", status: "in_progress", role: "assistant", content: [] as unknown[] };
      c.enqueue(ev("response.output_item.added", { output_index: 0, item }));
      c.enqueue(ev("response.content_part.added", { item_id: mid, output_index: 0, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] } }));
      let n = 0;
      for (const ch of chunks) {
        if (n++) await pace();
        c.enqueue(ev("response.output_text.delta", { item_id: mid, output_index: 0, content_index: 0, delta: ch, logprobs: [] }));
      }
      c.enqueue(ev("response.output_text.done", { item_id: mid, output_index: 0, content_index: 0, text, logprobs: [] }));
      const part = { type: "output_text", text, annotations: [], logprobs: [] };
      c.enqueue(ev("response.content_part.done", { item_id: mid, output_index: 0, content_index: 0, part }));
      const done = { ...item, status: "completed", content: [part] };
      c.enqueue(ev("response.output_item.done", { output_index: 0, item: done }));
      c.enqueue(ev("response.completed", { response: base("completed", [done]) }));
      c.close();
    },
  });
}

/** a responses-API tool call: a function_call item (or local_shell_call for the built-in shell tool) */
export function responsesToolItem(tool: DeclaredTool, input: Record<string, unknown>) {
  const callId = newId("call");
  if (tool.type === "local_shell") {
    return { id: newId("lsh"), type: "local_shell_call", call_id: callId, status: "completed", action: { type: "exec", command: input.command } };
  }
  return { id: newId("fc"), type: "function_call", call_id: callId, name: tool.name, arguments: JSON.stringify(input), status: "completed" };
}
export function responsesToolStream(model: string, tool: DeclaredTool, input: Record<string, unknown>, pace: () => Promise<void>): ReadableStream<Uint8Array> {
  const rid = newId("resp");
  const item = responsesToolItem(tool, input);
  const base = (status: string, output: unknown[]) => ({
    id: rid, object: "response", created_at: Math.floor(Date.now() / 1000), status, model, output,
    usage: { input_tokens: 25, output_tokens: 20, total_tokens: 45 },
  });
  let seq = 0;
  const ev = (type: string, extra: Record<string, unknown>) => sse(type, { type, sequence_number: seq++, ...extra });
  return new ReadableStream({
    async start(c) {
      c.enqueue(ev("response.created", { response: base("in_progress", []) }));
      c.enqueue(ev("response.in_progress", { response: base("in_progress", []) }));
      if (item.type === "function_call") {
        const args = String((item as any).arguments);
        c.enqueue(ev("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } }));
        const half = Math.ceil(args.length / 2);
        c.enqueue(ev("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args.slice(0, half) }));
        await pace();
        c.enqueue(ev("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args.slice(half) }));
        c.enqueue(ev("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: args }));
      } else {
        c.enqueue(ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress" } }));
        await pace();
      }
      c.enqueue(ev("response.output_item.done", { output_index: 0, item }));
      c.enqueue(ev("response.completed", { response: base("completed", [item]) }));
      c.close();
    },
  });
}
export function responsesToolJson(model: string, tool: DeclaredTool, input: Record<string, unknown>) {
  return { id: newId("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model,
    output: [responsesToolItem(tool, input)], usage: { input_tokens: 25, output_tokens: 20, total_tokens: 45 } };
}

export function responsesJson(model: string, text: string) {
  const part = { type: "output_text", text, annotations: [] };
  return { id: newId("resp"), object: "response", created_at: Math.floor(Date.now() / 1000), status: "completed", model,
    output: [{ id: newId("msg"), type: "message", status: "completed", role: "assistant", content: [part] }],
    usage: { input_tokens: 25, output_tokens: Math.max(1, text.length >> 2), total_tokens: 25 + Math.max(1, text.length >> 2) } };
}

export function chatStream(model: string, chunks: string[], pace: () => Promise<void>): ReadableStream<Uint8Array> {
  const id = newId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    sse(null, { id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
  return new ReadableStream({
    async start(c) {
      c.enqueue(chunk({ role: "assistant", content: "" }, null));
      let n = 0;
      for (const ch of chunks) {
        if (n++) await pace();
        c.enqueue(chunk({ content: ch }, null));
      }
      c.enqueue(chunk({}, "stop"));
      c.enqueue(sse(null, { id, object: "chat.completion.chunk", created, model, choices: [],
        usage: { prompt_tokens: 25, completion_tokens: Math.max(1, chunks.join("").length >> 2),
          total_tokens: 25 + Math.max(1, chunks.join("").length >> 2) } }));
      c.enqueue(sse(null, "[DONE]"));
      c.close();
    },
  });
}

export function chatToolStream(model: string, tool: DeclaredTool, input: Record<string, unknown>, pace: () => Promise<void>): ReadableStream<Uint8Array> {
  const id = newId("chatcmpl");
  const callId = newId("call");
  const created = Math.floor(Date.now() / 1000);
  const args = JSON.stringify(input);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    sse(null, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }] });
  return new ReadableStream({
    async start(c) {
      c.enqueue(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: callId, type: "function", function: { name: tool.name, arguments: "" } }] }, null));
      const half = Math.ceil(args.length / 2);
      c.enqueue(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }, null));
      await pace();
      c.enqueue(chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, null));
      c.enqueue(chunk({}, "tool_calls"));
      c.enqueue(sse(null, { id, object: "chat.completion.chunk", created, model, choices: [], usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 } }));
      c.enqueue(sse(null, "[DONE]"));
      c.close();
    },
  });
}
export function chatToolJson(model: string, tool: DeclaredTool, input: Record<string, unknown>) {
  return { id: newId("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: newId("call"), type: "function", function: { name: tool.name, arguments: JSON.stringify(input) } }] }, finish_reason: "tool_calls", logprobs: null }],
    usage: { prompt_tokens: 25, completion_tokens: 20, total_tokens: 45 } };
}

export function chatJson(model: string, text: string) {
  return { id: newId("chatcmpl"), object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 25, completion_tokens: Math.max(1, text.length >> 2), total_tokens: 25 + Math.max(1, text.length >> 2) } };
}

export function dialectOf(method: string, path: string): Dialect {
  const p = path.replace(/\/+$/, "");
  if (method === "POST" && /\/messages$/.test(p) && !/count_tokens/.test(p)) return "anthropic-messages";
  if (method === "POST" && /\/responses$/.test(p)) return "openai-responses";
  if (method === "POST" && /\/chat\/completions$/.test(p)) return "openai-chat";
  if (method === "GET" && /\/models$/.test(p)) return "models";
  return "unknown";
}

export type FakeModel = {
  port: number;
  url: string;
  requests: LoggedRequest[];
  setSlow: (v: boolean | number) => void;
  setScript: (s: Script) => void;
  stop: () => void;
};

export function startFakeModel(opts: {
  port?: number;
  script?: Script;
  logPath?: string;
  slowMs?: number;
} = {}): FakeModel {
  let script = opts.script ?? { default: "ok" };
  let slowMs: number = opts.slowMs ?? 0;
  const requests: LoggedRequest[] = [];
  const logPath = opts.logPath;
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  let seq = 0;

  const record = (r: LoggedRequest) => {
    requests.push(r);
    if (logPath) appendFileSync(logPath, JSON.stringify(r) + "\n");
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (path === "/_control" && method === "POST") {
        const body: any = await req.json().catch(() => ({}));
        if (body.slow !== undefined) slowMs = body.slow === true ? 400 : body.slow === false ? 0 : Number(body.slow) || 0;
        if (body.script) script = typeof body.script === "string" ? loadScript(body.script) : body.script;
        return Response.json({ ok: true, slowMs });
      }
      if (path === "/_control/requests") return Response.json(requests);
      if (path === "/_control/health") return Response.json({ ok: true, requests: requests.length });

      const dialect = dialectOf(method, path);
      if (dialect === "models") {
        record({ ts: Date.now(), seq: ++seq, dialect, method, path, userTexts: [], lastUser: "", messageCount: 0, status: 200 });
        return Response.json({ object: "list", data: [
          { id: "fake-1", object: "model", created: 0, owned_by: "cyc-testbench" },
          { id: "claude-sonnet-4-5", object: "model", created: 0, owned_by: "cyc-testbench" },
        ] });
      }
      if (/count_tokens$/.test(path)) {
        return Response.json({ input_tokens: 25 });
      }
      if (dialect === "unknown") {
        record({ ts: Date.now(), seq: ++seq, dialect, method, path, userTexts: [], lastUser: "", messageCount: 0, status: 404 });
        return new Response("not found", { status: 404 });
      }

      const body: any = await req.json().catch(() => ({}));
      const userTexts = userTextsOf(dialect, body);
      const lastUser = userTexts[userTexts.length - 1] ?? "";
      const picked = pickReply(script, lastUser);
      /* {{last}} in a reply echoes the last user text back, so a transcript's
       * assistant line can be tied to the exact message that produced it. */
      const rule = { ...picked, reply: picked.reply.replaceAll("{{last}}", lastUser.slice(0, 200)) };
      const model = String(body?.model ?? "fake-1");
      const stream = body?.stream !== false && (dialect !== "openai-responses" || body?.stream === true);
      const perChunk = rule.slowMs ?? slowMs;
      const chunks = splitChunks(rule.reply, rule.chunks ?? (perChunk > 0 ? 20 : undefined));
      const tools = declaredTools(dialect, body);
      const toolResult = trailingToolResult(dialect, body);
      /* a tool rule: call the tool first; answer with text once the result is back */
      const shell = rule.tool && toolResult === null ? shellToolOf(tools) : null;
      const toolCall = shell && rule.tool ? { name: shell.name, command: rule.tool.command, input: shellInput(shell, rule.tool.command) } : undefined;
      record({ ts: Date.now(), seq: ++seq, dialect, method, path, model, stream, userTexts, lastUser,
        messageCount: userTexts.length, reply: toolCall ? undefined : rule.reply, slowMs: perChunk, status: 200,
        tools: tools.map((t) => t.name), ...(toolCall ? { toolCall } : {}), ...(toolResult !== null ? { toolResult: toolResult.slice(0, 2000) } : {}) });
      if (rule.delayMs) await Bun.sleep(rule.delayMs);
      const pace = () => (perChunk > 0 ? Bun.sleep(perChunk) : Promise.resolve());
      const headers = { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" };
      if (shell && rule.tool) {
        const input = shellInput(shell, rule.tool.command);
        if (dialect === "anthropic-messages") return stream ? new Response(anthropicToolStream(model, shell, input, pace), { headers }) : Response.json(anthropicToolJson(model, shell, input));
        if (dialect === "openai-responses") return stream ? new Response(responsesToolStream(model, shell, input, pace), { headers }) : Response.json(responsesToolJson(model, shell, input));
        return stream ? new Response(chatToolStream(model, shell, input, pace), { headers }) : Response.json(chatToolJson(model, shell, input));
      }
      if (dialect === "anthropic-messages") {
        return stream
          ? new Response(anthropicStream(model, chunks, pace), { headers })
          : Response.json(anthropicJson(model, rule.reply));
      }
      if (dialect === "openai-responses") {
        return stream
          ? new Response(responsesStream(model, chunks, pace), { headers })
          : Response.json(responsesJson(model, rule.reply));
      }
      return stream
        ? new Response(chatStream(model, chunks, pace), { headers })
        : Response.json(chatJson(model, rule.reply));
    },
  });

  return {
    port: server.port!,
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setSlow: (v) => { slowMs = v === true ? 400 : v === false ? 0 : Number(v) || 0; },
    setScript: (s) => { script = s; },
    stop: () => server.stop(true),
  };
}

if (import.meta.main) {
  const port = Number(process.env.FAKE_MODEL_PORT ?? 4141);
  const fm = startFakeModel({
    port,
    script: loadScript(process.env.FAKE_MODEL_SCRIPT),
    logPath: process.env.FAKE_MODEL_LOG,
    slowMs: Number(process.env.FAKE_MODEL_SLOW_MS ?? 0),
  });
  console.log(`fake-model listening ${fm.url} script=${process.env.FAKE_MODEL_SCRIPT ?? "(default)"} log=${process.env.FAKE_MODEL_LOG ?? "(none)"}`);
}
