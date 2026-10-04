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
 *   D1 before_enter about to press Enter, the body in the box: Enter only
 *   D1 after_enter  Enter pressed, no row (after_keys, after_logchat): the row
 *                   is written, nothing typed again (claude and pi shapes)
 *   D1 completion   a pending note's completion stopped after its Enter
 *   R1              a retry in the same process keeps main's Enter-only rule
 *   R2 / V5-A..C    a pending note's completion refused after a restart marks
 *                   its row undelivered (every device reads it) and is never
 *                   driven again; its retry is a new cid, delivered once
 *   V5-D / V6-attach a same-process retry of a voice note, or of a message
 *                   with a recording attached, reads its words again
 *   D1 SIGTERM      the drain finishes what is typing and holds the rest
 *   E1-E5           verifier round 3: a stale stage, a refusal with no socket,
 *                   another chat's stuck write, an unreadable box, a draft
 *   D2              the frame leaves the disk only after its row is there
 *   D3              a resend racing the redrive is delivered once
 *   D4 / orphans    a frame given up on, or whose session never returns, is
 *                   told to the sender as send-failed
 */

import { test, expect, afterEach } from "bun:test";

import { onUtterance, redriveTaken, drainDeliveries, failOrphanedTaken,
  GIVEN_UP_REASON, ORPHAN_REASON } from "./deliver.ts";
import { takenFor, noteTaken, noteStage, stageFor, type Stage } from "./intake.ts";
import { RESCUE_INLINE_MS, wordsToken } from "../voice/transcribe.ts";
import { QUEUE_STUCK_MS } from "./chatlog.ts";
import { dispatchClientFrame } from "../transport/frames.ts";
import { mediaRoutes } from "../routes/media.ts";
import { serveRoutes, type ServedRoutes } from "../test-utils/serve-routes.ts";
import { cacheAudio } from "./clips.ts";
import { chatStore, flushAgentSave, resolveSession } from "../sessions/session-state.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type WireCore, type WireLayer, wireId } from "../test-utils/wire-core.ts";

const PANE_SID = defaultSessionIdOf(PANE);

let core: WireCore | null = null;
let voice: FakeVoice | null = null;
let gate: Promise<void> = Promise.resolve();
let http: ServedRoutes | null = null;
const never = new Promise<void>(() => {});

let failEnter = false;
async function boot(o: { agents?: Record<string, string>; with?: WireLayer[] } = {}): Promise<WireCore> {
  voice = fakeVoice({ transcript: "the words of the note" });
  const v = voice;
  core = await wireCore({ with: ["delivery"], ...o,
    failKeys: (keys: string[]) => failEnter && keys.includes("enter"),
    voiceUrl: async () => { await gate; return v.base; } });
  await until(() => !!core!.byHandle(PANE), { what: "the pane to reconcile" });
  return core;
}

afterEach(async () => {
  gate = Promise.resolve();
  failEnter = false;
  // whatever is still settling (a row's flush, a take's file) finishes in this wiring
  await until(async () => (await takenFor()).every((t) => t.attempt === "dead"), { timeoutMs: 3000 })
    .catch(() => {});
  http?.stop();
  http = null;
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
  point: "acked" | "after_text" | "before_enter" | "after_enter", o: { redrives?: number } = {}) {
  const delivered = `TEXT: ${text}`;
  await noteTaken({ sessionId: sid(), cid, takenAt: Date.now() - 60_000, attempt: "dead",
    frame: textFrame(cid, text), ...(o.redrives ? { redrives: o.redrives } : {}) });
  const stage: Stage | null = point === "acked" ? null : point === "after_text" ? "typing" : "entering";
  if (stage) await noteStage(sid(), cid, stage);
  if (point === "after_text" || point === "before_enter") c.hooks.setInput!(PANE, delivered);
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

  expect(c.submitted.map((x) => x.text), "a message the agent already had was sent again")
    .toEqual(["TEXT: the one before", delivered]);
  expect(typed(c, delivered), "the submitted body was typed again").toBe(0);
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].text).toBe("after enter");
  expect(rowsFor(done).length).toBe(1);
});

test("D1 before_enter: stopped between its Enter mark and the Enter, the body is entered once", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "before enter", "before_enter");
  await restart(c);
  await until(() => has(c, cid, "utterance.delivered"), { what: "the redrive to deliver" });
  expect(c.submitted.map((x) => x.text)).toEqual([delivered]);
  expect(typed(c, delivered)).toBe(0);
  expect(rowsFor(cid).length).toBe(1);
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
  await noteStage(sid(), cid, "entering");
  c.submitted.push({ pane: PANE, text: delivered });
  gate = Promise.resolve();

  await restart(c);
  await until(() => has(c, cid, "rescue.completed"), { what: "the completion" });

  expect(c.submitted.map((x) => x.text), "the completed note reached the agent twice").toEqual([delivered]);
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].transcriptPending).toBeUndefined();
  expect(rowsFor(cid)[0].text).toBe(voice!.transcript);
});

/** A quoted note shown pending, its completion stopped mid-way (`entering`),
 *  and a draft in the box at the next boot: the completion is refused (R2). */
async function refusedNote(c: WireCore, o: { plain?: boolean; box?: string; keep?: boolean } = {}) {
  const cid = crypto.randomUUID();
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, new Uint8Array(4096).fill(0x42), "audio/webm");
  gate = never;
  const client = c.client({ attach: wireId(PANE) });
  void onUtterance(client.sock, { t: "utterance", id: wireId(PANE), kind: "voice", msgId, durationS: 900,
    cid, ...(o.plain ? { text: "" } : { text: `> the agent asked\n\n${wordsToken(cid)}\n\nmy caption`, words: [cid] }) });
  await until(() => has(c, cid, "rescue.start"), { what: "the decode to start" });
  await c.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(c, cid, "utterance.shown-pending"), { what: "the note shown pending" });
  await noteStage(sid(), cid, "entering");
  c.hooks.setInput!(PANE, o.box ?? "my own half typed draft");
  gate = Promise.resolve();
  await restart(c);
  await until(() => has(c, cid, "rescue.complete-failed"), { what: "the refused completion" });
  if (!o.keep) c.hooks.setInput!(PANE, "");
  return { cid, msgId };
}
const WHOLE = (words: string) => `VOICE: > the agent asked\n\n${words}\n\nmy caption`;
const retryFrame = (cid: string, msgId: string) =>
  ({ t: "utterance", id: wireId(PANE), kind: "voice", msgId, durationS: 900, cid: `${cid}-r`, text: "" });

test("R2 / V5-B: a completion refused after a restart marks its row undelivered, on disk, and is never driven again", async () => {
  const c = await boot({ with: ["delivery", "frames"] });
  const { cid } = await refusedNote(c);
  const row = rowsFor(cid)[0];
  expect(row.transcriptPending, "the note is still owed").toBeUndefined();
  expect(row.undelivered, "the row does not say it failed").toContain("restarted");

  const drives = () => c.logs.filter((l) => l.event === "rescue.redrive" && l.fields.cid === cid).length;
  expect(drives()).toBe(1);
  await restart(c);
  await new Promise((r) => setTimeout(r, 300));
  expect(drives(), "a later boot drove the note again").toBe(1);
  expect(c.submitted.length, "the note reached the agent with no user action").toBe(0);
  // what every device reads: the row itself, after the restart, on attach
  expect(rowsFor(cid)[0].undelivered).toContain("restarted");
  const app = c.client();
  await dispatchClientFrame(app.sock, { t: "attach", id: wireId(PANE) });
  await until(() => app.of("attach-ok").length > 0, { what: "the attach answer" });
  const served = app.of("attach-ok")[0].pages.flatMap((p: { messages: { cid?: string }[] }) => p.messages)
    .find((m: { cid?: string }) => m.cid === cid);
  expect(served?.undelivered, "a fresh device is not told the note failed").toContain("restarted");
});

test("R2 retry: a new cid naming the clip delivers the note once, quote and caption around its words", async () => {
  const c = await boot();
  const { cid, msgId } = await refusedNote(c);
  const app = c.client({ attach: wireId(PANE) });
  await onUtterance(app.sock, retryFrame(cid, msgId));
  await onUtterance(app.sock, retryFrame(cid, msgId)); // a second tap, or another device
  await until(() => rowsFor(`${cid}-r`).length === 1 && !rowsFor(`${cid}-r`)[0].transcriptPending,
    { what: "the retry delivered", timeoutMs: 4000 });
  await new Promise((r) => setTimeout(r, 100));
  expect(c.submitted.map((x) => x.text)).toEqual([WHOLE(voice!.transcript)]);
  // the failed row learns it: the mark goes, its rev moves, every device is told
  expect(rowsFor(cid)[0].undelivered, "the failed row still says it was not sent").toBeUndefined();
  expect(rowsFor(cid)[0].rev).toBe(2);
  expect(app.of("chat").some((f) => f.cid === cid && !f.undelivered)).toBe(true);
});

test("V6-paste: the -r retry finds the refused drive's collapsed paste in the box: nothing typed onto it, refused again", async () => {
  const c = await boot();
  const { cid, msgId } = await refusedNote(c, { box: "[Pasted text #1 +5 lines]", keep: true });
  const app = c.client({ attach: wireId(PANE) });
  await onUtterance(app.sock, retryFrame(cid, msgId));
  await until(() => app.of("send-failed").some((f) => f.cid === `${cid}-r`), { what: "the refusal", timeoutMs: 4000 });
  expect(c.submitted, "the retry was submitted onto what the box held").toEqual([]);
  expect(c.herdr.rpcs.filter((r) => r.method === "pane.send_text").length, "typed onto the leftover").toBe(0);
  expect(rowsFor(cid)[0].undelivered).toContain("restarted");
});

test("R2-chain: the refused note is still in the box (a screen it cannot read plainly): the -r retry is refused again, not typed onto it", async () => {
  const c = await boot();
  const note = WHOLE(voice!.transcript);
  const { cid, msgId } = await refusedNote(c, { box: note, keep: true });
  const app = c.client({ attach: wireId(PANE) });
  await onUtterance(app.sock, retryFrame(cid, msgId));
  await until(() => app.of("send-failed").some((f) => f.cid === `${cid}-r`), { what: "the refusal", timeoutMs: 4000 });
  expect(c.submitted, "the note was submitted twice in one turn").toEqual([]);
  expect(c.herdr.rpcs.filter((r) => r.method === "pane.send_text").length).toBe(0);
});

test("the -r retry finds exactly its own body in the box: Enter only, the note once", async () => {
  const c = await boot();
  const { cid, msgId } = await refusedNote(c, { plain: true });
  const body = `VOICE: ${voice!.transcript}`;
  c.hooks.setInput!(PANE, body);
  const app = c.client({ attach: wireId(PANE) });
  await onUtterance(app.sock, retryFrame(cid, msgId));
  await until(() => rowsFor(`${cid}-r`).length === 1, { what: "the retry delivered", timeoutMs: 4000 });
  expect(c.submitted.map((x) => x.text)).toEqual([body]);
  expect(c.herdr.rpcs.filter((r) => r.method === "pane.send_text").length, "typed again").toBe(0);
});

test("V5-A: a retry acked and then stopped mid-read by a restart is delivered after it, once", async () => {
  const c = await boot();
  const { cid, msgId } = await refusedNote(c);
  gate = never;
  const app = c.client({ attach: wireId(PANE) });
  void onUtterance(app.sock, retryFrame(cid, msgId));
  await until(() => app.of("ack").some((a) => a.cid === `${cid}-r`), { what: "the retry acked" });
  gate = Promise.resolve();
  await restart(c);
  await until(() => rowsFor(`${cid}-r`).length === 1 && !rowsFor(`${cid}-r`)[0].transcriptPending,
    { what: "the retry delivered after the restart", timeoutMs: 4000 });
  expect(c.submitted.map((x) => x.text)).toEqual([WHOLE(voice!.transcript)]);
});

test("V5-C: the failed note's own cid sent again is the same message: nothing delivered, no queued mark left on it", async () => {
  const c = await boot();
  const { cid, msgId } = await refusedNote(c);
  resolveSession(PANE_SID)!.busy = true;
  const app = c.client({ attach: wireId(PANE) });
  await onUtterance(app.sock, { ...retryFrame(cid, msgId), cid });
  await until(() => app.of("ack").some((a) => a.cid === cid), { what: "the answer" });
  await c.clock.advance(QUEUE_STUCK_MS + 1000);
  await new Promise((r) => setTimeout(r, 50)); // the polls that advance fired settle before the stop
  expect(app.of("ack").find((a) => a.cid === cid)?.dup).toBe(true);
  expect(c.submitted.length, "a rewrite of the failed note's frame was delivered").toBe(0);
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].queued, "a queued mark no deadline clears").toBeUndefined();
  expect(rowsFor(cid)[0].undelivered).toContain("restarted");
});

for (const kind of ["plain", "quoted"] as const) {
  test(`V5-D: a same-process retry of a ${kind} voice note reads its words again, not the placeholder`, async () => {
    const c = await boot();
    const cid = crypto.randomUUID();
    const msgId = crypto.randomUUID();
    await cacheAudio(msgId, new Uint8Array(4096).fill(0x42), "audio/webm");
    const frame = { t: "utterance", id: wireId(PANE), kind: "voice", msgId, durationS: 3, cid,
      text: kind === "plain" ? "" : `> the agent said a thing\n\n${wordsToken(cid)}`,
      ...(kind === "quoted" ? { words: [cid] } : {}) };
    const app = c.client({ attach: wireId(PANE) });
    failEnter = true;
    await onUtterance(app.sock, frame);
    await until(() => has(c, cid, "utterance.delivery-failed"), { what: "the failure" });
    failEnter = false;
    c.hooks.setInput!(PANE, ""); // the box emptied: the retry types fresh
    await onUtterance(app.sock, frame);
    await until(() => c.submitted.length === 1, { what: "the retry" });
    expect(c.submitted[0].text).toContain(voice!.transcript);
    expect(rowsFor(cid)[0].text).toContain(voice!.transcript);
  });
}

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
  const flush = chatStore.flushFile.bind(chatStore);
  const held = new Promise<void>((r) => { release = r; });
  chatStore.flushFile = async (a, c) => { await held; await flush(a, c); };
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
    chatStore.flushFile = flush;
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

/* ---- verifier round 3 (scratchpad/reply-words-verify3/REPORT.md) ---- */

const CHOOSER = ["(transcript)", "", "─".repeat(60), " Bash command", "", "   ls build", "",
  " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"].join("\n");

test("E1 (V-stale-stage) / N4: a failed attempt leaves no stage, so a same-cid retry after a restart is typed, not marked delivered", async () => {
  const c = await boot();
  const app = c.client({ attach: wireId(PANE) });
  const cid = crypto.randomUUID();
  failEnter = true; // herdr refuses the Enter, twice
  await onUtterance(app.sock, textFrame(cid, "enter failed"));
  await until(() => has(c, cid, "utterance.delivery-failed"), { what: "the failure" });
  failEnter = false;
  expect(await stageFor(sid(), cid), "a failed attempt's stage was left on disk").toBeNull();
  c.hooks.clearInput!(PANE); // the box emptied (by hand, or a fresh harness)
  await restart(c);
  const app2 = c.client({ attach: wireId(PANE) });
  await onUtterance(app2.sock, textFrame(cid, "enter failed")); // the retry tap: same cid
  await until(() => rowsFor(cid).length === 1, { what: "the retry's row" });
  expect(c.submitted.map((x) => x.text), "the retried message never reached the agent")
    .toEqual(["TEXT: enter failed"]);
});

test("R1: a retry in the same process keeps main's Enter-only rule, even with the body changed", async () => {
  const c = await boot();
  const app = c.client({ attach: wireId(PANE) });
  const cid = crypto.randomUUID();
  failEnter = true; // herdr refuses the Enter: the body stays in the box, a stage is written
  await onUtterance(app.sock, textFrame(cid, "first words"));
  await until(() => has(c, cid, "utterance.delivery-failed"), { what: "the failure" });
  failEnter = false;
  // the retry tap after the reply slider moved: same cid, another delivered string
  await onUtterance(app.sock, textFrame(cid, "first words (reply as text)"));
  await until(() => rowsFor(cid).length === 1, { what: "the retry's row" });
  expect(c.submitted.map((x) => x.text), "the stranded body was not submitted once")
    .toEqual(["TEXT: first words"]);
  expect(c.herdr.rpcs.filter((r) => r.method === "pane.send_text").length, "typed twice").toBe(1);
  expect(c.logs.some((l) => l.fields.cid === cid && String(l.fields.why ?? "").includes("engine stopped")),
    "a restart was claimed in a process that never stopped").toBe(false);
});

test("E2 (V-refused-redrive): a redrive refused before any app connects is told to the app that connects later", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  await stoppedAt(c, cid, "held", "acked");
  c.hooks.setScreen!(PANE, CHOOSER);
  await restart(c);
  await until(() => has(c, cid, "utterance.dropped"), { what: "the refusal" });
  await until(async () => (await takenFor(sid())).length === 0, { what: "the frame to go" });
  const app = c.client({ attach: wireId(PANE) });
  c.hello(app);
  expect(rowsFor(cid).length).toBe(0);
  expect(app.of("send-failed").some((f) => f.cid === cid), "the sender was never told").toBe(true);
  c.hooks.setScreen!(PANE, null);
});

test("E3: another chat's write that never lands holds neither this session's deliveries nor the drain", async () => {
  const c = await boot();
  const app = c.client({ attach: wireId(PANE) });
  const chains = (chatStore as unknown as { chains: Map<string, Promise<void>> }).chains;
  const stuck = "/nowhere/ag-other/chats/other.jsonl";
  chains.set(stuck, new Promise<void>(() => {}));
  try {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    void onUtterance(app.sock, textFrame(a, "first"));
    void onUtterance(app.sock, textFrame(b, "second"));
    await until(() => rowsFor(b).length === 1, { what: "both rows", timeoutMs: 4000 });
    expect(c.submitted.map((x) => x.text)).toEqual(["TEXT: first", "TEXT: second"]);
    const t0 = Date.now();
    expect(await drainDeliveries(1000)).toBe(0);
    expect(Date.now() - t0, "the drain waited on another chat's write").toBeLessThan(900);
  } finally {
    chains.delete(stuck);
  }
});

test("E4 (V-unknown): `entering`, a screen the parser cannot read as a box: nothing pressed, no row, the sender told", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  await stoppedAt(c, cid, "still in the box", "before_enter");
  c.hooks.setScreen!(PANE, "user@host:~/proj$ claude --resume\n\nResuming conversation...\n");
  await restart(c);
  await until(() => has(c, cid, "utterance.dropped"), { what: "the visible failure" });
  c.hooks.setScreen!(PANE, null);
  const app = c.client({ attach: wireId(PANE) });
  c.hello(app);
  expect(rowsFor(cid).length, "a row (tick) was written for a message never submitted").toBe(0);
  expect(c.submitted.length).toBe(0);
  expect(app.of("send-failed").some((f) => f.cid === cid)).toBe(true);
  expect(await stageFor(sid(), cid)).toBeNull();
});

test("E5 (V-draft): `entering`, someone else's draft in the box: the draft is not submitted, the sender told", async () => {
  const c = await boot();
  const cid = crypto.randomUUID();
  const delivered = await stoppedAt(c, cid, "already submitted", "after_enter");
  c.hooks.setInput!(PANE, "my own half typed draft");
  await restart(c);
  await until(() => has(c, cid, "utterance.dropped"), { what: "the visible failure" });
  const app = c.client({ attach: wireId(PANE) });
  c.hello(app);
  expect(c.submitted.map((x) => x.text), "Enter was pressed on someone else's draft").toEqual([delivered]);
  expect(c.herdr.keys.length, "a key was pressed at the draft").toBe(0);
  expect(app.of("send-failed").some((f) => f.cid === cid)).toBe(true);
});

test("V6-attach: a same-process retry of a message with a recording attached reads its words again", async () => {
  const c = await boot({ with: ["delivery", "plugins"] });
  http = serveRoutes({ groups: [mediaRoutes], ctx: { uploads: c.uploads! } });
  const bytes = new Uint8Array(4096).map((_, i) => (i * 17 + 3) & 0xff);
  const up = await (await http.fetch("/upload", { method: "POST", headers: { "content-type": "audio/webm",
    "x-filename": "v.webm", "x-duration-s": "7" }, body: bytes as unknown as BodyInit })).json();
  const cid = crypto.randomUUID();
  const frame = { t: "utterance", id: wireId(PANE), cid, uploads: [up], words: [up.uploadId],
    text: `look\n\n${wordsToken(up.uploadId)}` };
  const app = c.client({ attach: wireId(PANE) });
  failEnter = true;
  await onUtterance(app.sock, frame);
  await until(() => has(c, cid, "utterance.delivery-failed"), { what: "the failure" });
  failEnter = false;
  c.hooks.setInput!(PANE, ""); // the box emptied: the retry types fresh
  await onUtterance(app.sock, frame);
  await until(() => c.submitted.length === 1, { what: "the retry" });
  expect(c.submitted[0].text).toContain(voice!.transcript);
  expect(rowsFor(cid)[0].wordsFailed).toBeUndefined();
});
