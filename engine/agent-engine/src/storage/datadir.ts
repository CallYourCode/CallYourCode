/* THE DATA DIR: ~/.callyourcode, spelled once.
 *
 * The engine used to keep everything in a repo-local `.run/` next to its own
 * source. It now keeps it in a per-user data dir laid out the way Claude Code
 * lays out ~/.claude (see the design):
 *
 *   settings.json               engine-level settings
 *   keys.json                   engine identity + E2E content generations (0600)
 *   agents/<agentId>/           everything that belongs to one agent
 *     meta.json                 harness mapping + per-agent settings + read state
 *     chats/<chatId>.jsonl      append-only chat logs
 *     uploads/ audio/ docs/ docstate/ photos/
 *     plugins/<name>/           agent-scoped plugin data
 *   plugins/<name>/             engine-scoped plugin data
 *   staging/{uploads,audio}     blobs posted before a session is known
 *   state/                      engine runtime state (pane bindings, hook state, ...)
 *   logs/                       structured log mirror (+ logs/services/)
 *
 * ONE env var overrides the base: CYC_DATA_DIR. Tests and multiple engines on
 * one host each point it at their own dir; the default is $HOME/.callyourcode.
 * Every helper reads the env lazily so a test can set it before boot without
 * fighting module-load order.
 *
 * The two-axis plugin rule lives here so it is spelled once: install scope
 * (engine vs agent) and data scope (engine vs agent) are independent, and
 * agent-scoped plugin DATA always lives under that agent's directory
 * (pluginDataDir below picks the axis from whether an agentId is given).
 *
 *   bun test agent-engine/src/storage/datadir.test.ts
 */

import { join } from "node:path";
import { mkdirPrivate, mkdirPrivateSync } from "../../../shared/runfiles.ts";

/* The ROOT and the LOG dir moved to ../shared/cycdir.ts: shared/logbook.ts
 * needs them and this module is the engine's, not the app server's. They are
 * re-exported so this file stays the one place engine code asks for a path. */
import { dataDir, logsDir } from "../../../shared/cycdir.ts";
export { dataDir, logsDir };

/* The ids that become path segments. Both are ENGINE-MINTED, but the agents/
 * scan at boot reads directory names off disk and a plugin name arrives from a
 * spec, so both are held to a strict charset before they touch a path: nothing
 * with a slash or a dot can pass, so no id can escape its directory. */
export const AGENT_ID_RE = /^ag-[A-Za-z0-9_-]{1,64}$/;
export const PLUGIN_NAME_RE = /^[a-z0-9-]{1,64}$/;

export function safeAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

function checkedAgentId(agentId: string): string {
  if (!safeAgentId(agentId)) throw new Error(`not an agent id: ${JSON.stringify(agentId)}`);
  return agentId;
}

function checkedPluginName(name: string): string {
  if (!PLUGIN_NAME_RE.test(name)) throw new Error(`not a plugin name: ${JSON.stringify(name)}`);
  return name;
}

// ---- engine-level files -----------------------------------------------------

export const settingsFile = (): string => join(dataDir(), "settings.json");
export const keysFile = (): string => join(dataDir(), "keys.json");

// ---- agents -----------------------------------------------------------------

export const agentsDir = (): string => join(dataDir(), "agents");
export const agentDir = (agentId: string): string => join(agentsDir(), checkedAgentId(agentId));
export const agentMetaFile = (agentId: string): string => join(agentDir(agentId), "meta.json");
export const agentChatsDir = (agentId: string): string => join(agentDir(agentId), "chats");
export const agentChatFile = (agentId: string, chatId: string): string => {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(chatId)) throw new Error(`not a chat id: ${JSON.stringify(chatId)}`);
  return join(agentChatsDir(agentId), `${chatId}.jsonl`);
};
export const agentUploadsDir = (agentId: string): string => join(agentDir(agentId), "uploads");
export const agentAudioDir = (agentId: string): string => join(agentDir(agentId), "audio");
export const agentDocsDir = (agentId: string): string => join(agentDir(agentId), "docs");
export const agentDocStateDir = (agentId: string): string => join(agentDir(agentId), "docstate");
export const agentPhotosDir = (agentId: string): string => join(agentDir(agentId), "photos");
export const agentThumbsDir = (agentId: string): string => join(agentPhotosDir(agentId), "thumbs");

// ---- plugin data, both axes -------------------------------------------------

/** Engine-scoped plugin data dir. */
export const pluginDir = (name: string): string => join(dataDir(), "plugins", checkedPluginName(name));

/** Agent-scoped plugin data dir. */
export const agentPluginDir = (agentId: string, name: string): string =>
  join(agentDir(agentId), "plugins", checkedPluginName(name));

/** The one resolution rule: agent-scoped data lives under the agent, engine-
 *  scoped data under the engine, whatever the plugin's install scope is. */
export const pluginDataDir = (name: string, agentId?: string | null): string =>
  agentId ? agentPluginDir(agentId, name) : pluginDir(name);

// ---- staging, state, logs ---------------------------------------------------

export const stagingUploadsDir = (): string => join(dataDir(), "staging", "uploads");
export const stagingAudioDir = (): string => join(dataDir(), "staging", "audio");
/** Spool dir for tunnel-streamed request bodies (tunnel-glue): a chunked
 * upload lands here file-by-file and is deleted the moment
 * its route has answered (or the stream aborts). Exclusively tunnel-glue's;
 * it sweeps leftovers at boot. */
export const tunnelTmpDir = (): string => join(dataDir(), "tmp", "tunnel");
/** Resumable-transfer chunk store (routes/transfer.ts, Lane A). Each in-flight
 *  transfer is one directory <transfersDir>/<id>/ holding a meta.json and one
 *  file per chunk index; finish assembles + verifies, hands the bytes to the
 *  route it fronts, and removes the dir. A 7 day sweeper clears abandoned ones
 *  at boot and daily. Owned by that module. */
export const transfersDir = (): string => join(dataDir(), "transfers");
export const stateDir = (): string => join(dataDir(), "state");
export const stateFile = (name: string): string => join(stateDir(), name);
export const servicesLogDir = (): string => join(logsDir(), "services");

/** Make the base tree (0700 throughout). Agent dirs are made on demand. */
export async function ensureBaseTree(): Promise<void> {
  for (const d of [dataDir(), agentsDir(), join(dataDir(), "plugins"),
    stagingUploadsDir(), stagingAudioDir(), stateDir(), logsDir()]) {
    await mkdirPrivate(d);
  }
}

/** Make one agent's tree (meta dir + chats; blob dirs are made where written). */
export async function ensureAgentTree(agentId: string): Promise<void> {
  await mkdirPrivate(agentChatsDir(agentId));
}

export function ensureDirSync(path: string): void {
  mkdirPrivateSync(path);
}
