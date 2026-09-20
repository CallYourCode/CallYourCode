/* THE MINIMAL PLUGIN HOST (blueprint section 1).
 *
 * The host provides EXACTLY three verbs to a plugin that owns data or a loop:
 *
 *   store()              engine-scoped durable storage    plugins/<id>/
 *   agentStore(agentId)  agent-scoped durable storage     agents/<aid>/plugins/<id>/
 *   deliver(agentId, m)  a message INTO an agent's pane   (deliverToAgent semantics)
 *
 * plus agentIds(), which only enumerates which agent scopes exist (a readdir,
 * not a session fact). There is deliberately NO tick hook, NO session facts, NO
 * outbound-message mutation, NO lifecycle events and NO per-plugin capability:
 * a plugin that needs a clock runs its own loop, one that needs cron math ships
 * it. A future surface is a new declared interface, never a per-plugin hole.
 *
 * Paths follow the two-axis rule in datadir.ts, which stays the single path
 * authority; this file only makes those paths an API.
 *
 *   bun test agent-engine/src/plugins/platform/host.test.ts
 */

import { join } from "node:path";
import { readdir, realpath, unlink } from "node:fs/promises";
import { pluginDir, agentPluginDir, agentsDir, safeAgentId, PLUGIN_NAME_RE } from "../../storage/datadir.ts";
import { mkdirPrivate, writeAtomicPrivate } from "../../../../shared/runfiles.ts";

/* One scope of durable plugin storage: a private dir the host creates (0700)
 * plus JSON KV helpers. `dir` is the escape hatch for a plugin owning its own
 * file format (crons keeps schedules.json + its lock). */
export interface PluginStore {
  readonly dir: string; // absolute; ensure() makes it before first use
  /** Make the dir (0700). Idempotent; every write calls it itself. */
  ensure(): Promise<void>;
  /** <dir>/<key>.json. Missing file or unreadable JSON both answer null. */
  get(key: string): Promise<unknown | null>;
  /** Atomic tmp+rename, 0600. */
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** The keys with a record on disk, no extension, sorted. */
  list(): Promise<string[]>;
}

export interface DeliveryResult {
  ok: boolean;
  why?: string;
  retriable?: boolean;
}

/** What a plugin may ask the engine to deliver. `how` prefixes the delivered
 *  line ("SCHEDULED (note): text"); it defaults to the plugin id uppercased so
 *  the agent always reads who sent it. `guardCwd` is the identity check: the
 *  delivery is refused (not retriable) when the agent's live cwd is no longer
 *  the directory the message was written for. */
export type PluginDelivery = {
  text: string;
  note?: string;
  how?: string;
  guardCwd?: string;
  /* A stable delivery id for this send, keyed on by the pane's stranded-body
   * note. A plugin that retries the SAME send (the crons ladder retrying one
   * occurrence) passes the id the first attempt used, so a retry inside the
   * stranded TTL presses enter only rather than typing the body again. Absent
   * for a one-shot send with no retry ladder; the engine mints one then. */
  deliveryId?: string;
};

export interface PluginHost {
  /** (a) engine-scoped store: <data>/plugins/<id>/ */
  store(): PluginStore;
  /** (b) agent-scoped store: <data>/agents/<aid>/plugins/<id>/ */
  agentStore(agentId: string): PluginStore;
  /** The agent scopes that exist on disk (readdir agents/), sorted. */
  agentIds(): Promise<string[]>;
  /** (c) delivery, deliverToAgent semantics (no user chat row, no reply hook):
   *    no live session for agentId       -> { ok:false, retriable:true }
   *    guardCwd set and realpath differs -> { ok:false, retriable:false }
   */
  deliver(agentId: string, msg: PluginDelivery): Promise<DeliveryResult>;
}

/* What the composition root wires the host over: the ONE live-session lookup
 * and the ONE delivery primitive the engine owns. Everything else (the guard,
 * the store paths, the refusal wording) is the host's and is testable here
 * without booting an engine. */
export type HostWiring = {
  /** The live session for an agent, or null when the engine has none. */
  sessionFor(agentId: string): { cwd?: string } | null;
  /** deliverToAgent over that live session (server.ts owns the pane typing). */
  deliverText(
    agentId: string,
    msg: { how: string; note?: string; text: string; deliveryId?: string },
  ): Promise<{ ok: boolean; why?: string; retriable?: boolean }>;
  /** One spelling of a directory (realpath, self on failure). Injected so the
   *  guard is testable with a fake resolver. */
  realPathOf?(p: string): Promise<string>;
};

const KEY_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function checkedKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes("..") || key.startsWith("."))
    throw new Error(`not a store key: ${JSON.stringify(key)}`);
  return key;
}

async function defaultRealPathOf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p; // unreachable resolves to itself, which fails the guard closed
  }
}

/** One store over one directory. Exported for the host and for tests. */
export function makePluginStore(dir: string): PluginStore {
  const fileOf = (key: string) => join(dir, `${checkedKey(key)}.json`);
  return {
    dir,
    async ensure() {
      await mkdirPrivate(dir);
    },
    async get(key) {
      const f = Bun.file(fileOf(key));
      if (!(await f.exists())) return null;
      try {
        return await f.json();
      } catch {
        return null; // unreadable is a fact to survive, not a crash
      }
    },
    async put(key, value) {
      await mkdirPrivate(dir);
      /* Atomic (0600): the record is whole on disk or the old one still is.
       * writeAtomicPrivate's temp name carries pid + randomness, so two
       * concurrent puts cannot collide. */
      await writeAtomicPrivate(fileOf(key), JSON.stringify(value));
    },
    async del(key) {
      await unlink(fileOf(key)).catch(() => {});
    },
    async list() {
      const names = await readdir(dir).catch(() => [] as string[]);
      return names
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -".json".length))
        .filter((n) => KEY_RE.test(n))
        .sort();
    },
  };
}

/** The host for ONE plugin id. The stores are cached per scope so `dir` is a
 *  stable identity a plugin may hand around. */
export function makePluginHost(pluginId: string, wiring: HostWiring): PluginHost {
  if (!PLUGIN_NAME_RE.test(pluginId)) throw new Error(`not a plugin id: ${JSON.stringify(pluginId)}`);
  const realOf = wiring.realPathOf ?? defaultRealPathOf;
  let engineStore: PluginStore | null = null;
  const agentStores = new Map<string, PluginStore>();
  return {
    store() {
      return (engineStore ??= makePluginStore(pluginDir(pluginId)));
    },
    agentStore(agentId) {
      let st = agentStores.get(agentId);
      if (!st) {
        st = makePluginStore(agentPluginDir(agentId, pluginId));
        agentStores.set(agentId, st);
      }
      return st;
    },
    async agentIds() {
      const names = await readdir(agentsDir()).catch(() => [] as string[]);
      return names.filter(safeAgentId).sort();
    },
    async deliver(agentId, msg) {
      const s = wiring.sessionFor(agentId);
      /* An agent this engine has no live session for. Not the same as a dead
       * one: it may simply not have been snapshotted yet (a fire in the first
       * seconds after a restart looks like this), so it is retriable. */
      if (!s) {
        return { ok: false, retriable: true,
          why: "this engine has no live session for that agent right now" };
      }
      /* IS THIS STILL THE SAME CONVERSATION? Resolved on both sides, because
       * this is a string comparison and two spellings of one directory are not
       * equal as strings. Not retriable: waiting will not turn the pane back
       * into the conversation it was. */
      if (msg.guardCwd && s.cwd && (await realOf(msg.guardCwd)) !== (await realOf(s.cwd))) {
        return { ok: false,
          why: `agent ${agentId} is a different conversation now (${s.cwd}, not ${msg.guardCwd}), ` +
            "so nothing was delivered" };
      }
      const how = msg.how ?? pluginId.toUpperCase();
      const res = await wiring.deliverText(agentId,
        { how, note: msg.note, text: msg.text, deliveryId: msg.deliveryId });
      return { ok: res.ok, why: res.why, retriable: res.retriable };
    },
  };
}
