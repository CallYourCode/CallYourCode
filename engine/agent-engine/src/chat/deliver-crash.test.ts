/* A TAKEN MESSAGE REACHES THE AGENT EXACTLY ONCE, WHEREVER THE ENGINE STOPS.
 *
 * The reply-words verification (round 2) killed the engine at every point of a
 * delivery. Each case here boots an engine, leaves on disk and in the pane
 * exactly what a process stopped at that point leaves (the intake frame, the
 * cid's Stage, the input box, what the agent already received), then boots
 * again through the real order (core.reset: modules reset, chat off disk,
 * reconcile picks the pane up live, the pickup drives what it is owed). The
 * fake herdr is KEPT across the restart, as a real herdr outlives the engine.
 *
 *   D1 after_text   typed, Enter not pressed: Enter only, the body not doubled
 *   D1 after_enter  Enter pressed, no row (after_keys, after_logchat): the row
 *                   is written, nothing typed again (claude and pi shapes)
 *   D1 completion   a pending note's completion stopped after its Enter
 *   D1 SIGTERM      the drain finishes what is typing and holds the rest
 *   D2              the frame leaves the disk only after its row is there
 *   D3              a resend racing the redrive is delivered once
 *   D4 / orphans    a frame given up on, or whose session never returns, is
 *                   told to the sender as send-failed
 */

import { test, expect, afterEach } from "bun:test";

import { onUtterance, redriveTaken, drainDeliveries, failOrphanedTaken,
  GIVEN_UP_REASON, ORPHAN_REASON } from "./deliver.ts";
import { takenFor, noteTaken, noteStage, stageFor, type Stage } from "./intake.ts";
import { RESCUE_INLINE_MS } from "../voice/transcribe.ts";
import { cacheAudio } from "./clips.ts";
import { chatStore, flushAgentSave, resolveSession } from "../sessions/session-state.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";

const PANE_SID = defaultSessionIdOf(PANE);

let core: WireCore | null = null;
let voice: FakeVoice | null = null;
let gate: Promise<void> = Promise.resolve();
const never = new Promise<void>(() => {});

async function boot(o: { agents?: Record<string, string> } = {}): Promise<WireCore> {
  voice = fakeVoice({ transcript: "the words of the note" });
  const v = voice;
  core = await wireCore({ with: ["delivery"], ...o,
    voiceUrl: async () => { await gate; return v.base; } });
  await until(() => !!core!.byHandle(PANE), { what: "the pane to reconcile" });
  return core;
}

afterEach(async () => {
  gate = Promise.resolve();
  // whatever is still settling (a row's flush, a take's file) finishes in this wiring
  await until(async () => (await takenFor()).every((t) => t.attempt === "dead"), { timeoutMs: 3000 })
    .catch(() => {});
  await core?.stop();
  voice?.stop();
  core = null;
  voice = null;
});

const sid = () => resolveSession(PANE_SID)!.id;
const rowsFor = (cid: string) => resolveSession(PANE_SID)!.chat.filter((m) => m.cid === cid);
const has = (c: WireCore, cid: string, ev: string) =>
  c.logs.some((l) => l.event === ev && l.fields.cid === cid);
const textFrame = (cid: string, text: string) => ({ t: "utterance", id: wireId(PANE), text, cid });
const typed = (c: WireCore, body: string) => c.herdr.rpcs.filter((r) => r.method === "pane.send_text" &&
  r.text === body).length;

/** What a process stopped at a delivery point leaves behind: its intake frame,
 *  the cid's Stage, and the pane as the keystrokes left it. */
async function stoppedAt(c: WireCore, cid: string, text: string,
  point: "acked" | "after_text" | "after_enter", o: { redrives?: number } = {}) {
  const delivered = `TEXT: ${text}`;
  await noteTaken({ sessionId: sid(), cid, takenAt: Date.now() - 60_000, attempt: "dead",
    frame: textFrame(cid, text), ...(o.redrives ? { redrives: o.redrives } : {}) });
  const stage: Stage | null = point === "acked" ? null : point === "after_text" ? "typing" : "submitted";
  if (stage) await noteStage(sid(), cid, stage);
  if (point === "after_text") c.hooks.setInput!(PANE, delivered);
  if (point === "after_enter") c.submitted.push({ pane: PANE, text: delivered });
  return delivered;
}

/** Stop and boot again in the same dir, over the same herdr. */
async function restart(c: WireCore): Promise<void> {
  await chatStore.flush();
  await flushAgentSave(sid());
  await c.reset({ keepHerdr: true });
  await until(() => !!c.byHandle(PANE), { what: "the pane to be picked up again" });
}

test("D1 after_text: the body typed and not entered is submitted with Enter only, not doubled", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "after text", "after_text");
  const typedBefore = typed(c, delivered);

  await restart(c);
  await until(() => has(c, cid, "utterance.delivered"), { what: "the redrive to deliver" });

  expect(c.submitted.map((x) => x.text), "the body reached the agent other than once, whole")
    .toEqual([delivered]);
  expect(typed(c, delivered) - typedBefore, "the body was typed again into a box that held it").toBe(0);
  expect(rowsFor(cid).length).toBe(1);
  await until(async () => (await takenFor(sid())).length === 0, { what: "the intake to go" });
  expect(await stageFor(sid(), cid)).toBeNull();
});

test("D1 after_enter (and after the row was made but not written): the row is written, nothing typed again", async () => {
  const c = await boot();
  // K3 shape: one message fully delivered, the next stopped after its Enter
  const before = c.client({ attach: wireId(PANE) });
  const done = crypto.randomUUID();
  await onUtterance(before.sock, textFrame(done, "the one before"));
  await until(() => rowsFor(done).length === 1, { what: "the first to land" });
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "after enter", "after_enter");

  await restart(c);
  await until(() => has(c, cid, "utterance.delivered"), { what: "the redrive to write the row" });

  expect(has(c, cid, "delivery.already-submitted")).toBe(true);
  expect(c.submitted.map((x) => x.text), "a message the agent already had was sent again")
    .toEqual(["TEXT: the one before", delivered]);
  expect(typed(c, delivered), "the submitted body was typed again").toBe(0);
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].text).toBe("after enter");
  expect(rowsFor(done).length).toBe(1);
});

test("D1 acked, nothing typed yet: delivered once after the restart", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "only acked", "acked");
  await restart(c);
  await until(() => has(c, cid, "utterance.delivered"), { what: "the redrive to deliver" });
  expect(c.submitted.map((x) => x.text)).toEqual([delivered]);
  expect(rowsFor(cid).length).toBe(1);
});

test("D1 completion: a pending note whose completion stopped after its Enter is completed, not sent again", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, new Uint8Array(4096).fill(0x42), "audio/webm");
  gate = never; // the first decode never answers
  const client = c.client({ attach: wireId(PANE) });
  void onUtterance(client.sock, { t: "utterance", id: wireId(PANE), text: "", kind: "voice",
    msgId, durationS: 900, cid });
  await until(() => has(c, cid, "rescue.start"), { what: "the decode to start" });
  await c.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(c, cid, "utterance.shown-pending"), { what: "the note shown pending" });
  // the completion typed and entered, then the process stopped before the row
  const delivered = `VOICE: ${voice!.transcript}`;
  await noteStage(sid(), cid, "submitted");
  c.submitted.push({ pane: PANE, text: delivered });
  gate = Promise.resolve();

  await restart(c);
  await until(() => has(c, cid, "rescue.completed"), { what: "the completion" });

  expect(c.submitted.map((x) => x.text), "the completed note reached the agent twice").toEqual([delivered]);
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].transcriptPending).toBeUndefined();
  expect(rowsFor(cid)[0].text).toBe(voice!.transcript);
});

test("D1 pi (direct input): the stage is written around the send, and a submitted message is not sent again", async () => {
  const c = await boot({ agents: { [PANE]: "pi" } });
  const sent: { text: string; stage: Stage | null }[] = [];
  const s = c.byHandle(PANE)!;
  c.adapter.registerDirectInput(s.muxHandle, {
    send: async (text) => { sent.push({ text, stage: await stageFor(s.id, cidA) }); },
  });
  const client = c.client({ attach: wireId(PANE) });
  // a plain delivery: `typing` is on disk while pi takes it, nothing after
  const cidA = crypto.randomUUID();
  await onUtterance(client.sock, textFrame(cidA, "to pi"));
  await until(() => rowsFor(cidA).length === 1, { what: "the pi delivery" });
  expect(sent).toEqual([{ text: "TEXT: to pi", stage: "typing" }]);
  expect(await stageFor(s.id, cidA)).toBeNull();
  // a resend of a message a stopped process had already handed to pi
  const cidB = crypto.randomUUID();
  await noteStage(s.id, cidB, "submitted");
  await onUtterance(client.sock, textFrame(cidB, "pi had it"));
  await until(() => rowsFor(cidB).length === 1, { what: "the row" });
  expect(sent.length, "pi was handed the same message twice").toBe(1);
});

test("D1 SIGTERM: the drain finishes the delivery that is typing, holds the queued one, takes no new frame", async () => {
  const c = await boot();
  const client = c.client({ attach: wireId(PANE) });
  c.herdr.slow.ms = 150; // a delivery takes about a second
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  void onUtterance(client.sock, textFrame(a, "typing when the signal comes"));
  void onUtterance(client.sock, textFrame(b, "queued behind it"));
  await until(() => c.herdr.rpcs.some((r) => r.method === "pane.send_text"), { what: "typing to start" });

  const left = drainDeliveries(10_000);
  const late = crypto.randomUUID();
  await onUtterance(client.sock, textFrame(late, "after the signal"));
  expect(await left, "a delivery was still typing when the drain gave up").toBe(0);

  expect(rowsFor(a).length).toBe(1);
  expect(c.submitted.map((x) => x.text)).toEqual(["TEXT: typing when the signal comes"]);
  expect(client.of("ack").some((f) => f.cid === late), "a frame was taken while stopping").toBe(false);
  // the queued one never started typing and is still owed on disk
  expect((await takenFor(sid())).map((t) => t.cid)).toEqual([b]);

  c.herdr.slow.ms = 0;
  await restart(c);
  await until(() => rowsFor(b).length === 1, { what: "the held one after the restart" });
  expect(c.submitted.map((x) => x.text))
    .toEqual(["TEXT: typing when the signal comes", "TEXT: queued behind it"]);
});

test("D2 (P3): the frame leaves the disk only after the pending row is on disk", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, new Uint8Array(4096).fill(0x42), "audio/webm");
  gate = never;
  let release = () => {};
  const flush = chatStore.flush.bind(chatStore);
  const held = new Promise<void>((r) => { release = r; });
  chatStore.flush = async () => { await held; await flush(); };
  try {
    const client = c.client({ attach: wireId(PANE) });
    const taken = onUtterance(client.sock, { t: "utterance", id: wireId(PANE), text: "", kind: "voice",
      msgId, durationS: 900, cid });
    await until(() => has(c, cid, "rescue.start"), { what: "the decode to start" });
    await c.clock.advance(RESCUE_INLINE_MS);
    await until(() => has(c, cid, "utterance.shown-pending"), { what: "the pending row" });
    await new Promise((r) => setTimeout(r, 30));
    expect((await takenFor(sid())).map((t) => t.cid),
      "the frame went from disk before its pending row was written").toEqual([cid]);
    release();
    await taken;
    expect((await takenFor(sid())).length).toBe(0);
  } finally {
    chatStore.flush = flush;
    release();
  }
});

test("D3 (X4): a resend landing while the redrive writes its take is a dup, delivered once", async () => {
  const c = await boot();
  const s = c.byHandle(PANE)!;
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "raced", "acked");
  const app = c.client({ attach: wireId(PANE) });
  /* The app resends the moment the redrive says it is driving the frame:
   * before the redrive's own disk write, the window the claim must close. */
  const push = c.logs.push.bind(c.logs);
  c.logs.push = (...items) => {
    for (const it of items) {
      if (it.event === "intake.redrive" && it.fields.cid === cid) void onUtterance(app.sock, textFrame(cid, "raced"));
    }
    return push(...items);
  };
  await redriveTaken(s);
  await until(() => rowsFor(cid).length > 0, { what: "the message" });
  await until(async () => (await takenFor(sid())).length === 0, { what: "the intake to settle" });
  await new Promise((r) => setTimeout(r, 50));
  expect(app.of("ack").find((f) => f.cid === cid)?.dup, "the resend was taken as a second message").toBe(true);
  expect(c.submitted.filter((x) => x.text === delivered).length, "delivered twice").toBe(1);
  expect(rowsFor(cid).length, "two rows for one cid").toBe(1);
});

test("N2: a resend taken before the redrive keeps its own file on disk while it delivers", async () => {
  const c = await boot();
  const s = c.byHandle(PANE)!;
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "resent first", "acked");
  const app = c.client({ attach: wireId(PANE) });
  c.herdr.slow.ms = 100;
  void onUtterance(app.sock, textFrame(cid, "resent first"));
  await until(() => app.of("ack").some((f) => f.cid === cid), { what: "the fresh take" });
  await redriveTaken(s); // finds it in flight: only the old take goes
  expect((await takenFor(sid())).map((t) => t.attempt).filter((a) => a !== "dead").length,
    "the fresh take's file was removed under it").toBe(1);
  c.herdr.slow.ms = 0;
  await until(() => rowsFor(cid).length === 1, { what: "the message" });
  expect(c.submitted.filter((x) => x.text === delivered).length).toBe(1);
});

test("D4 (G4): a frame given up on after three boots is told to the sender as send-failed", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  await stoppedAt(c, cid, "poison", "acked", { redrives: 3 });
  await restart(c);
  await until(() => has(c, cid, "intake.given-up"), { what: "the give-up" });
  const app = c.client({ attach: wireId(PANE) });
  c.hello(app);
  expect(app.of("send-failed").find((f) => f.cid === cid)).toMatchObject({ id: sid(), reason: GIVEN_UP_REASON });
  expect((await takenFor(sid())).length).toBe(0);
  expect(c.submitted.length).toBe(0);
  // the retry tap takes it fresh and delivers it
  await onUtterance(app.sock, textFrame(cid, "poison"));
  await until(() => rowsFor(cid).length === 1, { what: "the retry" });
  expect(c.submitted.length).toBe(1);
});

test("a frame whose session never comes back is failed visibly, and the file goes", async () => {
  const c = await boot();
  const app = c.client({ attach: wireId(PANE) });
  await noteTaken({ sessionId: "ag-gone-for-good", cid: "c-orphan", takenAt: Date.now() - 60_000,
    attempt: "dead", frame: { t: "utterance", id: "ag-gone-for-good", text: "x", cid: "c-orphan" } });
  expect(await failOrphanedTaken()).toBe(1);
  expect(app.of("send-failed").find((f) => f.cid === "c-orphan"))
    .toMatchObject({ id: "ag-gone-for-good", reason: ORPHAN_REASON });
  expect((await takenFor()).length).toBe(0);
});
