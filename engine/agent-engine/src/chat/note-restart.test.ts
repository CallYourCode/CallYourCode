/* A NOTE THE ENGINE HAS TAKEN IS DELIVERED, WHATEVER HAPPENS TO THE ENGINE.
 *
 * Two holes, both found by the reply-words verification and both older than
 * that lane:
 *
 *   B1  a voice note shown with its words pending (#458) was never delivered
 *       after an engine restart: the re-drive was a 10 s boot timer over
 *       restoredChats, and reconcile hands a session's restored chat to the
 *       live row (and deletes it from that map) on the first poll, about a
 *       second into a boot. The timer found nothing.
 *   L4  the engine acked an utterance and only then delivered it, so a crash
 *       inside the inline decode window (up to RESCUE_INLINE_MS) lost a
 *       message the app had already deleted on the ack.
 *
 * Every case here restarts through the REAL boot: core.reset() tears the
 * wiring down and boots again in the same data dir, over a fresh fake herdr,
 * so the chat comes back off disk, reconcile adopts the pane, and whatever the
 * session is owed is driven at that pickup. Nothing is seeded into
 * restoredChats by hand. The "crash" is the first process's decode never
 * answering: its in-flight work is simply abandoned, as a dead process's is.
 *
 * One wireCore per test, so an abandoned process's timers die with its clock.
 */

import { test, expect, afterEach } from "bun:test";

import { cacheAudio } from "./clips.ts";
import { onUtterance } from "./deliver.ts";
import { takenFor, noteTaken } from "./intake.ts";
import { RESCUE_INLINE_MS, wordsToken } from "../voice/transcribe.ts";
import { chatStore, flushAgentSave, resolveSession } from "../sessions/session-state.ts";
import { PANE, defaultSessionIdOf } from "../test-utils/fake-herdr.ts";
import { fakeVoice, type FakeVoice } from "../test-utils/fake-voice.ts";
import { until } from "../test-utils/wait.ts";
import { wireCore, type WireCore, wireId } from "../test-utils/wire-core.ts";

const PANE_SID = defaultSessionIdOf(PANE);
const QUOTE = "> Done. Only worldwide remote roles count now.";

let core: WireCore | null = null;
let voice: FakeVoice | null = null;

/* The first process's decode: it never answers, the way a decode does not
 * answer for a process that died. The booted-again process gets `open`. */
const never = new Promise<void>(() => {});
let gate: Promise<void> = Promise.resolve();

async function boot(): Promise<{ core: WireCore; voice: FakeVoice }> {
  voice = fakeVoice({ transcript: "the words read after the restart" });
  const v = voice;
  core = await wireCore({ with: ["delivery"],
    voiceUrl: async () => { await gate; return v.base; } });
  await until(() => !!core!.byHandle(PANE), { what: "the pane to reconcile" });
  return { core, voice: v };
}

afterEach(async () => {
  gate = Promise.resolve();
  await core?.stop();
  voice?.stop();
  core = null;
  voice = null;
});

const linesFor = (c: WireCore, cid: string) => c.logs.filter((l) => l.fields.cid === cid);
const has = (c: WireCore, cid: string, event: string) => linesFor(c, cid).some((l) => l.event === event);
const rowsFor = (cid: string) => resolveSession(PANE_SID)!.chat.filter((m) => m.cid === cid);

async function park(): Promise<string> {
  const bytes = new Uint8Array(4096).fill(0x42);
  const msgId = crypto.randomUUID();
  await cacheAudio(msgId, bytes, "audio/webm");
  return msgId;
}

const frame = (msgId: string, cid: string, body = "") =>
  ({ t: "utterance", id: wireId(PANE), text: body, kind: "voice", msgId, durationS: 900, cid,
     ...(body ? { words: [cid] } : {}) });

/** Kill the running process and boot again in the same dir: the decode the
 *  first one started never answers; the second one's does. */
async function restart(c: WireCore): Promise<void> {
  /* What a running engine has long since written by the time it dies seconds
   * later: the chat lines and the agent's meta (a 150 ms debounce). */
  await chatStore.flush();
  await flushAgentSave(resolveSession(PANE_SID)!.id);
  /* The first process's decode is already waiting on `never` and stays there;
   * the booted-again process reads the gate fresh and gets an open one. */
  gate = Promise.resolve();
  await c.reset();
}

async function showPending(c: WireCore, cid: string, body: string,
  hold: Promise<void> = never): Promise<string> {
  const msgId = await park();
  gate = hold; // the decode does not answer (for a crash: ever)
  const client = c.client({ attach: wireId(PANE) });
  void onUtterance(client.sock, frame(msgId, cid, body));
  await until(() => has(c, cid, "rescue.start"), { what: "the decode to start" });
  await c.clock.advance(RESCUE_INLINE_MS);
  await until(() => has(c, cid, "utterance.shown-pending"), { what: "the note to be shown pending" });
  return msgId;
}

test("B1: a plain note shown pending is delivered ONCE after a restart, through the real boot", async () => {
  const { core: c, voice: v } = await boot();
  const cid = crypto.randomUUID();
  const msgId = await showPending(c, cid, "");
  expect(rowsFor(cid)[0].transcriptPending).toBe(true);

  await restart(c);
  await until(() => has(c, cid, "rescue.completed"), { what: "the re-driven note to complete" });

  expect(has(c, cid, "rescue.redrive"), "the restart never drove the pending note").toBe(true);
  const rows = rowsFor(cid);
  expect(rows.length, "the completion appended a second bubble").toBe(1);
  expect(rows[0].text).toBe(v.transcript);
  expect(rows[0].transcriptPending).toBeUndefined();
  expect(rows[0].msgId).toBe(msgId);
  expect(c.submitted.length, "the agent got more than one turn for one note").toBe(1);
  expect(c.submitted[0].text).toContain(v.transcript);
});

test("B1: a quoted note shows its quote while pending and completes with quote + words after a restart", async () => {
  const { core: c, voice: v } = await boot();
  const cid = crypto.randomUUID();
  await showPending(c, cid, `${QUOTE}\n\n${wordsToken(cid)}\n\nand a caption`);
  // L2: what the pending row shows is the quote and the caption, never the marker
  expect(rowsFor(cid)[0].text).toBe(`${QUOTE}\n\nand a caption`);

  await restart(c);
  await until(() => has(c, cid, "rescue.completed"), { what: "the re-driven note to complete" });

  const rows = rowsFor(cid);
  expect(rows.length).toBe(1);
  expect(rows[0].text).toBe(`${QUOTE}\n\n${v.transcript}\n\nand a caption`);
  expect(rows[0].wordsInto).toBeUndefined();
  expect(c.submitted.length).toBe(1);
  expect(c.submitted[0].text).toContain(`${QUOTE}\n\n${v.transcript}\n\nand a caption`);
  expect(c.submitted[0].text).not.toContain("{{cyc-words:");
});

test("B1: a pending note its session would not take is driven again when the pane comes back", async () => {
  const { core: c, voice: v } = await boot();
  const cid = crypto.randomUUID();
  let open = () => {};
  await showPending(c, cid, "", new Promise<void>((r) => { open = r; }));
  // the pane goes away, then the decode lands: nobody to deliver to
  await c.herdr.setAgentGone(PANE, true);
  gate = Promise.resolve();
  open();
  await until(() => has(c, cid, "rescue.complete-undelivered"),
    { what: "the completion to find the session gone" });
  expect(rowsFor(cid)[0].transcriptPending).toBe(true);
  expect(c.submitted.length).toBe(0);

  // the same process, the pane back: the pickup drives it again, once
  await c.herdr.setAgentGone(PANE, false);
  await until(() => has(c, cid, "rescue.completed"), { what: "the note to complete on the pickup" });
  expect(rowsFor(cid).length).toBe(1);
  expect(rowsFor(cid)[0].text).toBe(v.transcript);
  expect(c.submitted.length).toBe(1);
});

test("L4: a crash inside the inline decode window: the acked note is on disk and delivered once after the restart", async () => {
  const { core: c, voice: v } = await boot();
  const cid = crypto.randomUUID();
  const msgId = await park();
  gate = never;
  const client = c.client({ attach: wireId(PANE) });
  void onUtterance(client.sock, frame(msgId, cid, `${QUOTE}\n\n${wordsToken(cid)}`));
  await until(() => client.of("ack").some((f) => f.cid === cid), { what: "the ack" });
  /* ACKED MEANS ON DISK: the app deletes its copy on this ack. */
  const sid = resolveSession(PANE_SID)!.id;
  expect((await takenFor(sid)).map((t) => t.cid), "the ack went out before the frame was on disk")
    .toContain(cid);
  await until(() => has(c, cid, "rescue.start"), { what: "the decode to start" });
  // the crash: well inside RESCUE_INLINE_MS, nothing shown, nothing delivered
  expect(rowsFor(cid).length).toBe(0);

  await restart(c);
  await until(() => has(c, cid, "utterance.delivered"), { what: "the taken note to be delivered" });

  expect(has(c, cid, "intake.redrive"), "the restart never drove the taken frame").toBe(true);
  const rows = rowsFor(cid);
  expect(rows.length, "one note, more than one row").toBe(1);
  expect(rows[0].text).toBe(`${QUOTE}\n\n${v.transcript}`);
  expect(c.submitted.length, "one note, more than one turn").toBe(1);
  await until(async () => (await takenFor(sid)).length === 0, { what: "the intake file to go" });

  // the app rewrites the frame after a lost ack: the same message, not a second
  const again = c.client({ attach: wireId(PANE) });
  await onUtterance(again.sock, frame(msgId, cid, `${QUOTE}\n\n${wordsToken(cid)}`));
  expect(again.of("ack").find((f) => f.cid === cid)?.dup).toBe(true);
  expect(c.submitted.length).toBe(1);
});

test("L4: a frame left on disk for a message that DID land is not delivered again", async () => {
  const { core: c } = await boot();
  const cid = crypto.randomUUID();
  const client = c.client({ attach: wireId(PANE) });
  const f = { t: "utterance", id: wireId(PANE), text: "already here", cid };
  await onUtterance(client.sock, f);
  await until(() => c.submitted.length === 1, { what: "the message to land" });
  // the crash between the commit and the file going
  const sid = resolveSession(PANE_SID)!.id;
  await noteTaken({ sessionId: sid, cid, takenAt: Date.now(), attempt: "dead", frame: f });

  await restart(c);
  await until(() => has(c, cid, "intake.finished"), { what: "the boot to look at the left frame" });
  expect(c.submitted.length, "a landed message was delivered again").toBe(0);
  expect(rowsFor(cid).length).toBe(1);
  expect((await takenFor(sid)).length).toBe(0);
});
