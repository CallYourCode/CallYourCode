/* THE ADVERSARIAL ANGLES ON THE LIMBO (#405), which birth.test.ts does not
 * cover: a pane that DIES mid-limbo, before its uuid is ever minted.
 *
 * The limbo is the window where a session's only handle is its PANE id, and it
 * is exactly the window where the two worst answers are available. A pane that
 * dies in it must not leak a live ghost -- a row the app draws as alive for a
 * pane herdr has stopped listing, which nobody can dismiss and which delivery
 * would happily type into. And the uuid that arrives afterwards, on some OTHER
 * pane, must not be allowed to adopt the dead one's identity or its chat: an
 * unannounced uuid joins only the LIVE agent on its own pane, and a rule that
 * matched on "some parked session" instead would hand a brand-new agent a
 * stranger's conversation.
 *
 * Both are silent when wrong, which is why the negatives are asserted from the
 * engine's own live state AND from what a client was actually sent.
 *
 * NO ENGINE PROCESS: wireCore performs server.ts's ordered boot in-process over
 * a FakeHerdr and a REAL MuxAdapter.
 *
 *   bun test agent-engine/src/runtime/birth-probe.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, type WireCore, type FakeClient } from "../test-utils/wire-core.ts";
import { until } from "../test-utils/wait.ts";
import { onUtterance } from "../chat/deliver.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { hasSessionState } from "../sessions/session-state.ts";
import { readAgentMetas } from "../test-utils/builders.ts";

const P1 = "w1:p1"; // the pane that dies in the limbo
const P2 = "w1:p2"; // the pane that survives and mints
const U = "aa11bb22-cc33-4d44-8e55-ff6677889900";

let core: WireCore | null = null;
afterEach(async () => {
  await core?.stop();
  core = null;
});

const listOf = (client: FakeClient): any[] => (client.last("sessions")?.list as any[]) ?? [];
const rowOf = (client: FakeClient, id: string) => listOf(client).find((s) => s.id === id);

/** Put a real message into a session's conversation, through the real delivery
 *  path, so there is content that must survive (or must NOT be adopted). */
async function say(c: WireCore, client: FakeClient, id: string, text: string): Promise<void> {
  await onUtterance(client.sock, { id: c.sessionOf(id)!.id, text });
  await until(() => (c.sessionOf(id)?.chat ?? []).some((m) => m.text === text),
    { what: `"${text}" to reach ${id}'s conversation log` });
}

async function attachedTexts(c: WireCore, id: string): Promise<string[]> {
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "attach", id: c.sessionOf(id)?.id ?? id, since: 0 });
  await until(() => page.last("attach-ok") !== undefined, { what: `an attach-ok for ${id}` });
  const ok = page.last("attach-ok")!;
  return ((ok.pages as any[]) ?? []).flatMap((p) => (p.messages ?? []).map((m: any) => String(m.text)));
}

test("a pane that dies mid-limbo leaves no live ghost, and no id-changed frame fires", async () => {
  core = await wireCore({ noSession: [P1], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(P1), { what: "the limbo spawn to be listed" });
  const id = core.byHandle(P1)!.agentId;
  expect(rowOf(client, id).alive, "the limbo spawn was not present-and-alive").toBe(true);

  // The pane dies BEFORE any uuid is minted (the window closed during limbo).
  await core.herdr.setAgentGone(P1, true);
  await until(() => rowOf(client, id) === undefined || rowOf(client, id).alive === false,
    { what: "the dead pane to stop being listed alive" });

  /* It said nothing, so it is not a conversation and is swept entirely rather
   * than kept as a permanent grey row nobody can dismiss. What it must NEVER be
   * is a living row for a pane that is gone. */
  expect(!!core.byHandle(P1), "a dead-in-limbo pane stayed listed ALIVE (a live ghost)").toBe(false);
  expect(core.sessionOf(id), "the swept row is still in the session map").toBeUndefined();
  expect(rowOf(client, id), "the swept row was still on the wire").toBeUndefined();
  // ...and the per-id state went with it, so nothing is left to be resurrected.
  expect(hasSessionState(id), "the swept pane left per-id state behind").toBe(false);
  // ...and no record was ever written for it: no session id, no chat, no name.
  expect((await readAgentMetas(core.root)).size, "a nameless record was written for the limbo pane").toBe(0);
  /* NAMED, because bun's default is 5,000ms and this test was reaching it about
   * one full run in ten -- never on its own, only under --parallel on a loaded
   * box, where a wireCore boot and two FakeHerdr round trips are competing with
   * a worker per core. The bound is about how long the MACHINE may take, not
   * about the behaviour: every assertion above is unchanged and the polls inside
   * still carry their own bounds, so a real hang still fails, with the sentence
   * saying which condition never came true. */
}, 20_000);

test("a limbo pane that dies HAVING said something keeps its conversation, offline", async () => {
  /* The other side of the sweep rule, and the reason the sweep is conditional: a
   * limbo pane that held a real exchange is a conversation, so it stays listed
   * (offline) with its chat intact. Deleting it would be the #405 data loss
   * arriving by a different door. */
  core = await wireCore({ noSession: [P1], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(P1), { what: "the limbo spawn" });
  await say(core, client, P1, "said in the limbo, then the pane died");
  const id = core.byHandle(P1)!.agentId;

  await core.herdr.setAgentGone(P1, true);
  await until(() => core!.sessionOf(id)?.alive === false,
    { what: "the pane's exit to be reconciled" });

  const row = rowOf(client, id);
  expect(row, "a limbo conversation was deleted when its pane died").toBeDefined();
  expect(row.alive, "a pane herdr no longer lists was still drawn as alive").toBe(false);
  expect(await attachedTexts(core, id)).toContain("said in the limbo, then the pane died");
});

test("a DIFFERENT pane minting its uuid never adopts a dead limbo pane's identity", async () => {
  /* The adversarial shape. Two panes spawn in limbo, both say something, one
   * dies; the survivor then mints. The join must key on THE PANE: the uuid
   * belongs to P2's agent and to nothing else, so P1's conversation and P1's
   * stable id stay where they are. A rule that matched on "a parked session"
   * would hand P2's brand-new claude a stranger's chat, silently. */
  core = await wireCore({
    panes: [P1, P2], noSession: [P1, P2], agentStatus: "idle", with: ["delivery", "frames"],
  });
  const client = core.client();
  await until(() => !!core!.byHandle(P1) && !!core!.byHandle(P2),
    { what: "both limbo panes to be listed" });
  await say(core, client, P1, "this belongs to the pane that died");
  await say(core, client, P2, "this belongs to the pane that minted");
  const idOfP1 = core.byHandle(P1)!.agentId;
  const idOfP2 = core.byHandle(P2)!.agentId;
  expect(idOfP1, "two live sessions shared one stable agent id").not.toBe(idOfP2);

  // P1 dies in the limbo; P2 mints its uuid afterwards.
  await core.herdr.setAgentGone(P1, true);
  await until(() => core!.sessionOf(idOfP1)?.alive === false, { what: "P1's exit" });
  await core.herdr.mintSession(P2, U);
  await until(() => !!core!.sessionOf(U), { what: "P2's uuid to join its agent" });

  // The uuid row is P2's alone: its pane, its stable id, its message only.
  const u = core.sessionOf(U)!;
  expect(u.muxHandle).toBe(P2);
  expect(u.agentId, "the minting pane inherited the dead pane's stable identity").toBe(idOfP2);
  expect(await attachedTexts(core, U)).toEqual(["this belongs to the pane that minted"]);
  expect(core.sessions.size, "the mint left a ghost row").toBe(2);

  // And the dead limbo pane still owns its own conversation, under its own key.
  expect(core.sessionOf(idOfP1)!.alive).toBe(false);
  expect(await attachedTexts(core, idOfP1)).toEqual(["this belongs to the pane that died"]);
});

test("a limbo pane that exits and comes back with a uuid is a NEW agent; the limbo chat stays its own", async () => {
  /* THE ASYMMETRY THAT USED TO BE HERE, reversed on purpose (adapters lane 2).
   *
   * The old rule was "a parked mint always carries": a pane that left the
   * snapshot and came back reporting a uuid inherited the limbo conversation
   * whether or not it was the same claude, because the pane id was the only
   * lineage there was. The cost was that a genuinely NEW claude on a reused
   * pane id inherited a stranger's chat.
   *
   * Identity is decided on session ids now, and an unannounced uuid joins only
   * the agent whose binding on that pane is ALIVE. A pane that exits marks its
   * binding dead, so what comes back is a stranger until an announce says
   * otherwise: it gets its own agent id and an empty chat, and the limbo
   * conversation stays listed, dead, under its own id. (A real claude that
   * merely blinked out of one scraper snapshot announces its id through the
   * hook; a --resume of the limbo pane's id would find it in the index.) */
  core = await wireCore({ noSession: [P1], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(P1), { what: "the limbo spawn" });
  await say(core, client, P1, "said before the pane blinked");
  const parked = core.byHandle(P1)!.agentId;

  await core.herdr.setAgentGone(P1, true);
  await until(() => core!.sessionOf(parked)?.alive === false, { what: "P1 leaving the snapshot" });

  // It comes back on the same pane, now reporting a uuid.
  await core.herdr.respawnSession(P1, U);
  await until(() => !!core!.sessionOf(U), { what: "the pane to come back under its uuid" });

  expect(core.sessionOf(U)!.agentId, "a dead binding handed its agent to the newcomer").not.toBe(parked);
  expect(core.sessionOf(U)!.alive).toBe(true);
  expect(await attachedTexts(core, U), "the newcomer inherited the limbo conversation").toEqual([]);
  expect(core.sessionOf(parked)!.alive, "the limbo conversation is its own dead row").toBe(false);
  expect(await attachedTexts(core, parked)).toContain("said before the pane blinked");
});
