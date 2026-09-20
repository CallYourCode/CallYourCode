/* ONE-SHOT BOOT MIGRATION (2026-09-06): remove the delivered-receipt chat rows
 * the reverted agent-message-rows feature wrote.
 *
 * For a few hours (deployed ~13:22, reverted the same day) deliverToAgent
 * appended one chat row per machine delivery: `role:"user"` plus a `from`
 * field naming the sender (a governor tick, a cron fire, a CLI author). In the
 * log, and to every consumer that keys on role, a script's message was
 * recorded AS THE USER; owner's call is that machine-delivered input is a
 * session record (the transcript's prompt event), never a chat bubble. The
 * feature is reverted; these are the rows it left behind.
 *
 * THE DISCRIMINATOR IS THE `from` FIELD: no other writer has ever set it on a
 * chat message (it existed only between the feature commit and the revert),
 * so `role:"user"` plus a non-empty string `from` names exactly the rows the
 * feature wrote and nothing else. A user row without `from` (his own sends,
 * scheduled sends of the pre-#515 shape) is never touched.
 *
 * NOTHING IS LOST. Every one of these deliveries also landed in the agent's
 * transcript and is already a `prompt` session record in the same log (that
 * is what the app now shows for it); the row being removed is the redundant,
 * role-untruthful copy. The rewrite follows the store's append-only
 * discipline (chatstore.ts): the kept rows become a NEW chat file via
 * writeNew, the meta pointer flips only after that file exists whole, and the
 * old file stays on disk as history, so no crash window can lose a row.
 * Seqs are kept as they are (no renumber): the survivors' seq order is
 * untouched and the session records keep their true interleave; a page
 * spanning a removed row simply holds fewer rows, which the range-based page
 * arithmetic already serves.
 *
 * IDEMPOTENT: once migrated (or on any log that never had such rows) the scan
 * finds nothing and writes nothing, so every later boot is a no-op.
 *
 *   bun test agent-engine/src/chat/migrate-from-rows.test.ts
 */

import type { ChatStore, StoredMsg } from "./chatstore.ts";
import type { SessionRec } from "./sessionrec.ts";
import { saveAgentMeta, type AgentMeta } from "../runtime/agentmeta.ts";

/** A row the reverted feature wrote: role user carrying a sender label. */
export function isDeliveredReceiptRow(m: Record<string, unknown>): boolean {
  return m.role === "user" && typeof m.from === "string" && m.from.length > 0;
}

/** Drop the delivered-receipt rows from one agent's restored chat, rewriting
 *  the log through the store's sanctioned whole-file path when any exist.
 *  Returns the array to keep serving: the same `msgs` when the log is clean
 *  (the common case, zero cost), the filtered survivors after a rewrite. */
export async function dropDeliveredReceiptRows(
  store: ChatStore,
  meta: AgentMeta,
  msgs: StoredMsg[],
  recs: SessionRec[],
  log: (line: string) => void = (l) => console.log(l),
): Promise<StoredMsg[]> {
  let dropped = 0;
  const kept: StoredMsg[] = [];
  for (const m of msgs) {
    if (isDeliveredReceiptRow(m)) dropped++;
    else kept.push(m);
  }
  if (!dropped) return msgs;
  // The new file first, whole; the pointer flips only once it exists. A crash
  // between the two leaves the old file current and the migration re-runs.
  const cid = await store.writeNew(meta.agentId, kept, recs);
  meta.chats = [...(meta.chats ?? []), { id: cid, createdAt: Date.now() }];
  meta.chat = cid;
  await saveAgentMeta(meta);
  log(`[migrate] ${meta.agentId}: dropped ${dropped} delivered-receipt row(s) ` +
    `(role:user + from, the reverted agent-message-rows feature); kept ${kept.length} ` +
    `message(s) and ${recs.length} record(s) in new chat file ${cid}`);
  return kept;
}
