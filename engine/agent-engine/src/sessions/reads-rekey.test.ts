/* DISPATCH READS RESOLVE THE SESSION THE WAY THE REPLY PATH DOES (2026-08-23).
 *
 * The live bug: in the app, a linked tmux-lane session showed no MODEL, no
 * CONTEXT and no ACTIVITY while chat and status edges worked. The transcript
 * had the data; the null was minted in server.ts's dispatch wiring. Its
 * sessionOf resolved only the exact wire id, while the chat/reply path also
 * resolves by pane handle and by harness session id. A caller that names the
 * session by its pane, or by a harness session id the agent has since rolled
 * away from, must get the same answer as one that names the agent id: the
 * reads go through resolveSession (agent id, any session id in the index, or
 * a live pane handle), the one resolver the reply path uses.
 *
 * These tests go through the REAL rpc entry (the plugin specs the plugins
 * layer loaded) down the real dispatch chain to the transcript on disk.
 *
 *   bun test agent-engine/src/sessions/reads-rekey.test.ts
 */

import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { wireCore, type WireCore } from "../test-utils/wire-core.ts";
import { PANE, HARNESS_CWD } from "../test-utils/fake-herdr.ts";
import { mungeCwd } from "../../../shared/claude-projects.ts";
import { until } from "../test-utils/wait.ts";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

/* A claude transcript whose newest assistant record carries model + usage,
 * the exact shape the live Mac transcript had (message.model, message.usage
 * with input/cache_read/cache_creation tokens; record keys type/uuid/
 * timestamp/sessionId/version). 240912 tokens of a 1M window -> pct 24. */
function transcriptWithUsage(uuid: string): string {
  return [
    JSON.stringify({
      type: "user", uuid: "u1", timestamp: "2026-08-23T10:00:00Z",
      sessionId: uuid, version: "2.1.241",
      message: { role: "user", content: "hi" },
    }),
    JSON.stringify({
      type: "assistant", uuid: "a1", timestamp: "2026-08-23T10:00:05Z",
      sessionId: uuid, version: "2.1.241",
      message: {
        role: "assistant", model: "claude-opus-4-8",
        usage: { input_tokens: 12, cache_read_input_tokens: 240_000,
          cache_creation_input_tokens: 900, output_tokens: 180 },
      },
    }),
  ].join("\n") + "\n";
}

async function writeTranscript(c: WireCore, uuid: string): Promise<void> {
  const dir = join(c.projects, mungeCwd(HARNESS_CWD));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${uuid}.jsonl`), transcriptWithUsage(uuid));
}

const rpcOf = (c: WireCore, pluginId: string, op: string) => {
  const fn = c.plugins.find((p) => p.id === pluginId)?.rpc?.[op];
  if (!fn) throw new Error(`no rpc ${op} on plugin ${pluginId}`);
  return fn;
};

test("a linked session resolves model and context through the dispatch chain", async () => {
  const uuid = crypto.randomUUID();
  const c = await wireCore({ with: ["plugins"], sessionIds: { [PANE]: uuid } });
  core = c;
  await until(() => !!c.sessionOf(uuid), { what: "the linked session to reconcile" });
  await writeTranscript(c, uuid);

  const model = await rpcOf(c, "model-indicator", "model")({ session: uuid, agent: null }, undefined);
  expect(model, "the model read went null for a live linked session").toEqual(
    expect.objectContaining({ name: "Opus 4.8" }));

  const pct = await rpcOf(c, "ctx", "pct")({ session: uuid, agent: null }, undefined);
  expect(pct, "the context read went null for a live linked session").toEqual({ pct: 24 });
});

test("reads addressed by the pane handle resolve the live session", async () => {
  /* The MCP knows only its pane; a caller naming the session by its handle
   * (the way the speak socket registers) must reach the live session on it.
   * The reply path resolves that by handle; the reads must too. */
  const uuid = crypto.randomUUID();
  const c = await wireCore({ with: ["plugins"], sessionIds: { [PANE]: uuid } });
  core = c;
  await until(() => !!c.sessionOf(uuid), { what: "the linked session to reconcile" });
  await writeTranscript(c, uuid);

  const model = await rpcOf(c, "model-indicator", "model")({ session: PANE, agent: null }, undefined);
  expect(model, "a handle-addressed model read went null while chat on the same id routes").toEqual(
    expect.objectContaining({ name: "Opus 4.8" }));

  const pct = await rpcOf(c, "ctx", "pct")({ session: PANE, agent: null }, undefined);
  expect(pct, "a handle-addressed context read went null").toEqual({ pct: 24 });
});

test("reads addressed by a past uuid follow the session index to the agent that rolled", async () => {
  /* A uuid roll keeps the agent's row and files the old id under its
   * pastSessions; a voice MCP or a stale caller that still names the old id
   * reaches the same agent through the index, and the reads answer off the
   * NEW transcript (the one the agent is on now). */
  const oldId = crypto.randomUUID();
  const newId = crypto.randomUUID();
  const c = await wireCore({ with: ["plugins"], sessionIds: { [PANE]: oldId } });
  core = c;
  await until(() => !!c.sessionOf(oldId), { what: "the linked session to reconcile" });
  const agentId = c.sessionOf(oldId)!.id;
  await c.herdr.rollSession(PANE, newId); // the roll: same pane, new uuid
  await until(() => c.sessionOf(agentId)?.harnessSessionId === newId, { what: "the roll to be adopted" });
  expect(c.sessionOf(oldId)?.id, "the past id no longer names the agent").toBe(agentId);
  await writeTranscript(c, newId);

  const model = await rpcOf(c, "model-indicator", "model")({ session: oldId, agent: null }, undefined);
  expect(model, "a stale-uuid model read went null across the re-key").toEqual(
    expect.objectContaining({ name: "Opus 4.8" }));

  const pct = await rpcOf(c, "ctx", "pct")({ session: oldId, agent: null }, undefined);
  expect(pct, "a stale-uuid context read went null across the re-key").toEqual({ pct: 24 });
});
