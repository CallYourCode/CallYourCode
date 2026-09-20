/* Fake model dialect tests. Run explicitly:
 *   bun test testbench/fake-model/server.test.ts
 * (the testbench is outside every engine test glob on purpose). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialectOf, pickReply, splitChunks, startFakeModel, userTextsOf } from "./server.ts";

async function readSSE(res: Response): Promise<{ events: { event: string | null; data: string }[] }> {
  const text = await res.text();
  const events: { event: string | null; data: string }[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event: string | null = null;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data += line.slice(6);
    }
    events.push({ event, data });
  }
  return { events };
}

describe("fake model", () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-model-"));
  const log = join(dir, "requests.jsonl");
  const fm = startFakeModel({
    logPath: log,
    script: { default: "ok.", rules: [{ match: "ECHO", reply: "echo: {{last}}" }, { match: "SLOW", reply: "a b c d e f", slowMs: 20, chunks: 3 }] },
  });

  test("routes by path", () => {
    expect(dialectOf("POST", "/v1/messages")).toBe("anthropic-messages");
    expect(dialectOf("POST", "/v1/messages/count_tokens")).toBe("unknown");
    expect(dialectOf("POST", "/v1/responses")).toBe("openai-responses");
    expect(dialectOf("POST", "/responses")).toBe("openai-responses");
    expect(dialectOf("POST", "/v1/chat/completions")).toBe("openai-chat");
    expect(dialectOf("GET", "/v1/models")).toBe("models");
    expect(dialectOf("GET", "/nope")).toBe("unknown");
  });

  test("extracts user texts per dialect", () => {
    expect(userTextsOf("anthropic-messages", { messages: [
      { role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "yo" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ] })).toEqual(["hi", "second"]);
    expect(userTextsOf("openai-responses", { input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "r" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] },
    ] })).toEqual(["one", "two"]);
    expect(userTextsOf("openai-responses", { input: "plain" })).toEqual(["plain"]);
    expect(userTextsOf("openai-chat", { messages: [
      { role: "system", content: "sys" }, { role: "user", content: "q" },
    ] })).toEqual(["q"]);
  });

  test("scripted replies and chunking", () => {
    const s = { default: "d", rules: [{ match: "^ECHO", reply: "e" }] };
    expect(pickReply(s, "ECHO x").reply).toBe("e");
    expect(pickReply(s, "other").reply).toBe("d");
    expect(splitChunks("abcdef", 3)).toEqual(["ab", "cd", "ef"]);
    expect(splitChunks("a b c").join("")).toBe("a b c");
  });

  test("anthropic messages SSE", async () => {
    const res = await fetch(`${fm.url}/v1/messages`, { method: "POST",
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "ECHO hello" }] }) });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const { events } = await readSSE(res);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("message_start");
    expect(types.at(-1)).toBe("message_stop");
    const text = events.filter((e) => e.event === "content_block_delta")
      .map((e) => JSON.parse(e.data).delta.text).join("");
    expect(text).toBe("echo: ECHO hello");
    const delta = events.find((e) => e.event === "message_delta")!;
    expect(JSON.parse(delta.data).delta.stop_reason).toBe("end_turn");
  });

  test("anthropic non-stream json", async () => {
    const res = await fetch(`${fm.url}/v1/messages`, { method: "POST",
      body: JSON.stringify({ model: "m", stream: false, messages: [{ role: "user", content: "x" }] }) });
    const j: any = await res.json();
    expect(j.content[0].text).toBe("ok.");
    expect(j.stop_reason).toBe("end_turn");
  });

  test("openai responses SSE", async () => {
    const res = await fetch(`${fm.url}/v1/responses`, { method: "POST",
      body: JSON.stringify({ model: "m", stream: true, instructions: "sys",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ECHO codex" }] }] }) });
    const { events } = await readSSE(res);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe("response.created");
    expect(types.at(-1)).toBe("response.completed");
    const text = events.filter((e) => e.event === "response.output_text.delta")
      .map((e) => JSON.parse(e.data).delta).join("");
    expect(text).toBe("echo: ECHO codex");
    const done = JSON.parse(events.at(-1)!.data);
    expect(done.response.status).toBe("completed");
    expect(done.response.output[0].content[0].text).toBe("echo: ECHO codex");
    const seqs = events.map((e) => JSON.parse(e.data).sequence_number);
    expect(seqs).toEqual(seqs.map((_, i) => i));
  });

  test("openai chat completions SSE", async () => {
    const res = await fetch(`${fm.url}/v1/chat/completions`, { method: "POST",
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "SLOW" }] }) });
    const t0 = Date.now();
    const { events } = await readSSE(res);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(events.at(-1)!.data).toBe("[DONE]");
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e.data));
    const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(text).toBe("a b c d e f");
    expect(chunks.find((c) => c.choices?.[0]?.finish_reason === "stop")).toBeTruthy();
  });

  test("models list and unknown route", async () => {
    const m: any = await (await fetch(`${fm.url}/v1/models`)).json();
    expect(m.data.length).toBeGreaterThan(0);
    const r = await fetch(`${fm.url}/v1/other`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });

  test("requests.jsonl records every call with the last user text", async () => {
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const chat = lines.find((l) => l.dialect === "openai-chat");
    expect(chat.lastUser).toBe("SLOW");
    expect(chat.reply).toBe("a b c d e f");
    const resp = lines.find((l) => l.dialect === "openai-responses");
    expect(resp.userTexts).toEqual(["ECHO codex"]);
    expect(lines.find((l) => l.status === 404)).toBeTruthy();
    expect(lines.length).toBe(fm.requests.length);
  });

  test("scripted tool call: call first, text once the result is back, per dialect", async () => {
    await fetch(`${fm.url}/_control`, { method: "POST", body: JSON.stringify({ script: { default: "ok.", rules: [{ match: "RUN", tool: { command: "echo hi" }, reply: "done: {{last}}" }] } }) });
    /* anthropic: Bash tool, string command */
    const a1 = await fetch(`${fm.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", stream: true,
      tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } }],
      messages: [{ role: "user", content: "RUN it" }] }) });
    const ae = (await readSSE(a1)).events.map((e) => JSON.parse(e.data));
    const start = ae.find((e) => e.type === "content_block_start");
    expect(start.content_block.type).toBe("tool_use");
    expect(start.content_block.name).toBe("Bash");
    const json = ae.filter((e) => e.type === "content_block_delta").map((e) => e.delta.partial_json).join("");
    expect(JSON.parse(json).command).toBe("echo hi");
    expect(JSON.parse(json).timeout).toBe(60000);
    expect(ae.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
    const a2 = await fetch(`${fm.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", stream: false,
      tools: [{ name: "Bash", input_schema: {} }],
      messages: [{ role: "user", content: "RUN it" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi\n" }] }] }) });
    const aj = await a2.json();
    expect(aj.content[0].text).toBe("done: RUN it");
    /* responses: shell function tool with an array command */
    const r1 = await fetch(`${fm.url}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", stream: true,
      tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } } }],
      input: [{ role: "user", content: [{ type: "input_text", text: "RUN it" }] }] }) });
    const re = (await readSSE(r1)).events.map((e) => JSON.parse(e.data));
    const item = re.find((e) => e.type === "response.output_item.done").item;
    expect(item.type).toBe("function_call");
    expect(item.name).toBe("shell");
    expect(JSON.parse(item.arguments).command).toEqual(["bash", "-lc", "echo hi"]);
    const r2 = await fetch(`${fm.url}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", stream: false,
      tools: [{ type: "function", name: "shell", parameters: {} }],
      input: [{ role: "user", content: [{ type: "input_text", text: "RUN it" }] }, item, { type: "function_call_output", call_id: item.call_id, output: "hi" }] }) });
    expect((await r2.json()).output[0].content[0].text).toBe("done: RUN it");
    /* responses: codex 0.148's exec_command, whose command key is `cmd` */
    const r5 = await fetch(`${fm.url}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", stream: false,
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" }, yield_time_ms: { type: "number" } }, required: ["cmd"] } }],
      input: [{ role: "user", content: [{ type: "input_text", text: "RUN it" }] }] }) });
    const codexItem = (await r5.json()).output.find((o: any) => o.type === "function_call");
    expect(codexItem.name).toBe("exec_command");
    expect(JSON.parse(codexItem.arguments)).toEqual({ cmd: "echo hi" });
    /* responses: the built-in local_shell tool */
    const r3 = await fetch(`${fm.url}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "m", stream: false,
      tools: [{ type: "local_shell" }], input: [{ role: "user", content: [{ type: "input_text", text: "RUN it" }] }] }) });
    const lsh = (await r3.json()).output[0];
    expect(lsh.type).toBe("local_shell_call");
    expect(lsh.action.command).toEqual(["bash", "-lc", "echo hi"]);
    /* chat completions: function tool_calls, then role:tool */
    const c1 = await fetch(`${fm.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", stream: true,
      tools: [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }],
      messages: [{ role: "user", content: "RUN it" }] }) });
    const ce = (await readSSE(c1)).events.filter((e) => e.data !== "[DONE]").map((e) => JSON.parse(e.data));
    const args = ce.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? "").join("");
    expect(JSON.parse(args).command).toBe("echo hi");
    expect(ce.some((e) => e.choices?.[0]?.finish_reason === "tool_calls")).toBe(true);
    const c2 = await fetch(`${fm.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", stream: false,
      tools: [{ type: "function", function: { name: "bash" } }],
      messages: [{ role: "user", content: "RUN it" }, { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c1", content: "hi" }] }) });
    expect((await c2.json()).choices[0].message.content).toBe("done: RUN it");
    /* the oracle: tool calls and results are on the record */
    const lines = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.toolCall?.command === "echo hi").length).toBe(5);
    expect(lines.filter((l) => typeof l.toolResult === "string").length).toBe(3);
    expect(lines.find((l) => l.toolCall && l.dialect === "openai-responses").tools).toEqual(["shell"]);
  });

  test("slow control switch", async () => {
    await fetch(`${fm.url}/_control`, { method: "POST", body: JSON.stringify({ slow: 15 }) });
    const t0 = Date.now();
    const res = await fetch(`${fm.url}/v1/chat/completions`, { method: "POST",
      body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "twenty words here so the reply splits into a good number of chunks for pacing" }] }) });
    await res.text();
    /* default reply "ok." splits into 20 chunks, most empty-ish: at least a few paced gaps */
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
    await fetch(`${fm.url}/_control`, { method: "POST", body: JSON.stringify({ slow: false }) });
    fm.stop();
  });
});
