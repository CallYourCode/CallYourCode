/* A SESSION IS ALIVE THE INSTANT IT IS BORN, AND NOTHING SAID BEFORE ITS UUID
 * ARRIVES IS EVER LOST. (#405, the no-session-id limbo.)
 *
 * WHY THIS FILE EXISTS
 *
 * A session spawned from the app exists as a herdr pane seconds before the
 * claude process inside it mints its session uuid. The engine once keyed a
 * session by its claude session id, so for those first seconds -- the limbo --
 * the only durable handle was the PANE id, and the session was keyed by it.
 * Three things went wrong there, and he hit all three in one afternoon:
 *
 *   THE ROW WENT OFFLINE. When the uuid finally arrived the old shape built a
 *   brand-new uuid-keyed row and let the pane-keyed one fall out of the snapshot
 *   and be marked dead. The row he was looking at greyed out under him even
 *   though the pane was alive the whole time.
 *
 *   THE RENAME REVERTED. He renamed the session in the limbo window; the name
 *   was keyed to the pane and the uuid row never saw it, so it snapped back.
 *
 *   THE MESSAGES VANISHED. Worst of all: messages exchanged in the limbo were
 *   logged under the pane key, and the uuid row started empty. Navigate away and
 *   back and the conversation was gone. That is data loss.
 *
 * THE FIX, and what this guards: a spawned pane is alive from birth, keyed by a
 * stable agent id minted at birth, and the moment herdr reports the uuid that
 * uuid JOINS the agent as its harness session id. The key never changes, so
 * the chat, the rename, the settings and the record are simply still there,
 * and no client is told anything but the new attribute. No first message is
 * required to force the uuid; this fires purely on herdr observing it.
 *
 * NO ENGINE PROCESS. wireCore performs server.ts's own ordered boot in-process:
 * `noSession` makes the fake herdr report a pane with a null agent_session (the
 * limbo), and `mintSession` flips it to a uuid on the same pane the way claude
 * registering does. The rename goes through the SHIPPED route over a real
 * Bun.serve on port 0, because an override that only lives in a Map inside the
 * engine has renamed nothing.
 *
 *   bun test agent-engine/src/runtime/birth.test.ts
 */

import { test, expect, afterEach } from "bun:test";

import { wireCore, type WireCore, type FakeClient } from "../test-utils/wire-core.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { readChatLog, metaForSession } from "../test-utils/builders.ts";
import { sessionOpsRoutes } from "../routes/session-ops.ts";
import { onUtterance } from "../chat/deliver.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { bindingOf } from "../sessions/session-state.ts";

// The uuid claude mints, distinct from the pane id, the way a real one always is.
const U = "7c19b0d2-3a4e-4f61-8b2c-1d9e0a5f6b73";

let core: WireCore | null = null;
let http: ServedRoutes | null = null;
afterEach(async () => {
  http?.stop();
  http = null;
  await core?.stop();
  core = null;
});

/** The shipped rename route, served over a real (port 0) Bun.serve against the
 *  real route group. requireOwner passes because the request arrives on
 *  loopback with no x-forwarded-for, which is the "on this host" branch. */
function routes(c: WireCore): ServedRoutes {
  http = serveRoutes({ groups: [sessionOpsRoutes], ctx: { adapter: c.adapter } });
  return http;
}

const rename = (r: ServedRoutes, id: string, name: string) =>
  r.post(`/session/${encodeURIComponent(id)}/rename`, { name }).then((x) => x.json() as Promise<any>);

/** Every row a client's newest sessions frame holds. */
const listOf = (client: FakeClient): any[] => (client.last("sessions")?.list as any[]) ?? [];
const rowOf = (client: FakeClient, id: string) => listOf(client).find((s) => s.id === id);

/** Navigate away and back: a FRESH page attaches and reads the attach answer's
 *  pages. The data-loss bar, because it re-reads the log rather than the open
 *  chat the client already has. */
async function attachedTexts(c: WireCore, id: string): Promise<string[]> {
  const page = c.client();
  await dispatchClientFrame(page.sock, { t: "attach", id, since: 0 });
  await until(() => page.last("attach-ok") !== undefined, { what: `an attach-ok for ${id}` });
  const ok = page.last("attach-ok")!;
  return ((ok.pages as any[]) ?? []).flatMap((p) => (p.messages ?? []).map((m: any) => String(m.text)));
}

test("a spawned pane is alive from birth, listed under its agent id", async () => {
  /* Instance #1, on its own: a living spawn is never offline. The old shape only
   * built a row once a uuid existed, so the seconds before that were a pane that
   * herdr could see and the app could not. */
  core = await wireCore({ noSession: [PANE], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(PANE), { what: "the spawned pane to become a session" });

  const agentId = core.byHandle(PANE)!.agentId;
  const born = rowOf(client, agentId);
  expect(born, "the spawned pane never appeared as a session").toBeDefined();
  expect(born.alive, "a freshly spawned, living pane was listed offline").toBe(true);
  // Honest about what it has: the wire says this session has no claude
  // session id yet.
  expect(born.claudeSessionId, "a limbo pane must not invent a claude session id").toBeNull();
  expect(born.harnessSessionId).toBeNull();
  // It has a stable agent id from birth, and that IS its key: identity does
  // not wait for claude.
  expect(born.sessionAgentId).toMatch(/^ag-/);
  expect(born.id).toBe(born.sessionAgentId);
  expect(core.byHandle(PANE)!.viaMux).toBe(true);
});

test("a rename and messages made in the limbo survive the uuid mint", async () => {
  core = await wireCore({ noSession: [PANE], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(PANE), { what: "the spawned pane to become a session" });
  const agentId = core.byHandle(PANE)!.agentId;

  // He RENAMES it in the limbo window (instance #2).
  const renamed = await rename(routes(core), agentId, "Terry AI");
  expect(renamed.ok, "the rename was refused").toBe(true);
  expect(rowOf(client, agentId).name, "the limbo rename did not show on the row").toBe("Terry AI");

  /* He SENDS a message in the limbo window (instance #3, the data loss). The bar
   * is that it is in the CONVERSATION before the mint, not merely typed at the
   * pane: the engine writes the bubble only once the keystrokes are confirmed,
   * and a mint that raced that write would snapshot the log one message short. */
  await onUtterance(client.sock, { id: agentId, text: "hello from the limbo" });
  await until(() => core!.byHandle(PANE)!.chat.some((m) => m.text === "hello from the limbo"),
    { what: "the limbo message to reach the conversation log" });
  expect(core.submitted.some((s) => s.pane === PANE && s.text.includes("hello from the limbo")),
    "the limbo message never actually reached the pane").toBe(true);

  // THE UUID ARRIVES: claude on this pane mints its session uuid at last.
  await core.herdr.mintSession(PANE, U);
  await until(() => !!core!.sessionOf(U), { what: "the uuid to join the agent" });

  // The uuid joined THE agent: same key, nothing re-keyed, nothing to carry.
  expect(core.sessionOf(U)!.agentId, "the minted uuid was given to a new agent").toBe(agentId);
  expect(client.of("session-id-changed"), "there is no re-key frame: the key never changed").toEqual([]);

  // ONE row, same id, now carrying the uuid, still alive, still named.
  const mine = listOf(client);
  expect(mine.map((s) => s.id), "the row did not settle to one live agent-keyed session").toEqual([agentId]);
  expect(mine[0].alive).toBe(true);
  expect(mine[0].name, "the limbo rename reverted when the uuid arrived (instance #2)").toBe("Terry AI");
  expect(mine[0].claudeSessionId).toBe(U);
  expect(mine[0].harnessSessionId).toBe(U);
  expect(mine[0].sessionAgentId, "the stable id changed when the uuid arrived").toBe(agentId);

  // NAVIGATE AWAY AND BACK: a fresh page attaches to the agent and the limbo
  // message replays. This is the data-loss bar (instance #3).
  expect(await attachedTexts(core, agentId),
    "the limbo message was lost after the uuid mint -- the data loss #405 is about")
    .toContain("hello from the limbo");
});

test("the limbo conversation lands on disk answering to the uuid, in the SAME agent record", async () => {
  /* The half a wire assertion cannot see. A join that produced the right rows
   * under a fresh agent record would look right for one session and find nothing
   * at the next boot, so this reads the files: one record, now answering to the
   * uuid, with the limbo message in its chat log. The pane it was born on is
   * NOT a session id and is never filed as one (pastSessions holds harness ids
   * only); the pane binding is where the pane lives. */
  core = await wireCore({ noSession: [PANE], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(PANE), { what: "the spawned pane" });
  const agentId = core.byHandle(PANE)!.agentId;

  await rename(routes(core), agentId, "Terry AI");
  await onUtterance(client.sock, { id: agentId, text: "written before the uuid existed" });
  await until(() => core!.byHandle(PANE)!.chat.length > 0, { what: "the limbo chat row" });

  await core.herdr.mintSession(PANE, U);
  await until(() => !!core!.sessionOf(U), { what: "the uuid to join the agent" });

  const meta = await until(async () => (await metaForSession(core!.root, U))?.agentId === agentId,
    { what: "the agent record to reach disk under the uuid" })
    .then(() => metaForSession(core!.root, U));
  expect(meta!.sessionId).toBe(U);
  expect(meta!.pastSessions, "a pane id was filed as a past session id").toBeUndefined();
  expect(meta!.name, "the rename did not stay on the record").toBe("Terry AI");
  expect(bindingOf(PANE), "the pane binding does not name the agent").toEqual(
    expect.objectContaining({ agentId, sessionId: U, alive: true }));
  expect(await readChatLog(core.root, U)).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: "written before the uuid existed" })]));
});

test("delivery still finds the pane after the mint, and the message is addressed by the new id",
  async () => {
    /* The mint changes an attribute and nothing about where the keystrokes
     * go. A mint that lost the mux handle would leave a session the app can see
     * and cannot talk to, which is the same class of silent failure as losing
     * the chat. A caller naming the row by the uuid reaches the same pane. */
    core = await wireCore({ noSession: [PANE], agentStatus: "idle", with: ["delivery", "frames"] });
    const client = core.client();
    await until(() => !!core!.byHandle(PANE), { what: "the spawned pane" });

    await core.herdr.mintSession(PANE, U);
    await until(() => !!core!.sessionOf(U), { what: "the uuid to join the agent" });
    expect(core.sessionOf(U)!.muxHandle, "the mint forgot which pane the session is on")
      .toBe(PANE);

    await onUtterance(client.sock, { id: core.sessionOf(U)!.id, text: "after the mint" });
    await until(() => core!.submitted.some((s) => s.text.includes("after the mint")),
      { what: "the message to be submitted at the pane" });
    expect(core.submitted.at(-1)!.pane).toBe(PANE);
    expect(core.sessionOf(U)!.chat.some((m) => m.text === "after the mint")).toBe(true);
  });

test("clearing the limbo rename after the mint falls back to the pane name", async () => {
  /* The override is keyed by the agent id, the one key the conversation ever
   * has: clearing it after the mint has to clear the thing the row is actually
   * reading. */
  core = await wireCore({ noSession: [PANE], agentStatus: "idle", with: ["delivery", "frames"] });
  const client = core.client();
  await until(() => !!core!.byHandle(PANE), { what: "the spawned pane" });
  const agentId = core.byHandle(PANE)!.agentId;
  const paneName = rowOf(client, agentId).name;

  const r = routes(core);
  await rename(r, agentId, "Terry AI");
  await core.herdr.mintSession(PANE, U);
  await until(() => !!core!.sessionOf(U), { what: "the uuid to join the agent" });
  expect(rowOf(client, agentId).name).toBe("Terry AI");

  const cleared = await rename(r, agentId, "");
  expect(cleared.ok).toBe(true);
  expect(rowOf(client, agentId).name, "clearing the override did not fall back to the pane name")
    .toBe(paneName);
});
