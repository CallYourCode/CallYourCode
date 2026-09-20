import { test, expect, beforeEach, afterEach } from "bun:test";
import { wireCore, sessionsFrame, type WireCore, type WireCoreOpts,
  type FakeClient, wireId } from "../test-utils/wire-core.ts";
import { PANE } from "../test-utils/fake-herdr.ts";
import { until } from "../test-utils/wait.ts";
import { onChat, onHeard } from "./reply.ts";
import { onUtterance } from "./deliver.ts";
import { onAttach, onProgress } from "./attach.ts";
import { noticeChat } from "./chatlog.ts";
import { markUnread } from "../sessions/readstate.ts";
import type { Sock } from "../transport/sock.ts";

let core: WireCore;
const HOUR = 60 * 60_000;
/* No notify layer: nothing here is about pushing. The marker is a fact of the
 * session, and asking it through the push path would be asking it twice. */
const BASE: WireCoreOpts = { with: ["delivery", "frames"], askPollMs: HOUR, contextPollMs: HOUR };

beforeEach(async () => {
  core = await wireCore(BASE);
  await until(() => core.sessions.size === 1, { what: "the pane to reconcile" });
});
afterEach(async () => { await core.stop(); });

const session = () => core.byHandle(PANE)!;

/** The sessions-list row, so the engine-owned unread can be read the way any
 *  device reads it rather than off the Session object. */
const row = () =>
  (sessionsFrame().list as Array<Record<string, any>>).find((s) => s.id === wireId(PANE))!;

function sessionSock(): Sock {
  return {
    data: {
      role: "session", sessionId: PANE, attached: null, visible: false, visibleAt: 0,
      beatMs: 0, gaps: [], lastFrame: 0, pongAt: 0, probeAt: 0, probeSeq: 0, cid: 0,
      openedAt: 0, tailing: null, terms: new Map(), remoteAddr: "127.0.0.1",
    },
    readyState: 1,
    send() {}, close() {}, remoteAddr: "127.0.0.1",
  } as unknown as Sock;
}

/** The agent replies. Returns the wire msgId a device would later name in a
 *  `heard` frame. */
async function reply(text: string): Promise<string> {
  const msgId = crypto.randomUUID();
  await onChat(sessionSock(), { text, msgId });
  return msgId;
}

/** HE SPEAKS OR TYPES into the session: the composer's frame, through the real
 *  delivery path, actually typed and SUBMITTED at the fake pane and logged as one
 *  of his messages. That last part is the whole point -- the marker moves inside
 *  injectUserMessage, which is the ONE way a user message enters a session. */
async function utter(c: FakeClient, text: string): Promise<void> {
  const before = core.submitted.length;
  await onUtterance(c.sock, { id: wireId(PANE), text });
  await until(() => core.submitted.length > before, { what: "the pane to take his message" });
}

/* WHAT A SECOND DEVICE SEES when it attaches: the pointer (where autoplay
 * begins) and the total. pointer === total means the divider does not draw and
 * there is nothing before the end to speak (pages.ts pointerSeq). */
function attachOf(): Record<string, any> {
  const c = core.client({ attach: null });
  onAttach(c.sock, { id: wireId(PANE) });
  const ok = c.last("attach-ok")!;
  c.close();
  return ok;
}

test("a reply advances the pointer to the tail; a second device has nothing to speak", async () => {
  /* THE WHOLE OF THE FIX: his reply on one device is why his other device stays
   * quiet. Two replies while he was away, then his answer. */
  await reply("first thing");
  await reply("second thing");
  expect(row().unread).toBe(2);

  const phone = core.client({ attach: wireId(PANE) });
  await utter(phone, "got it, thanks");

  // the marker is at the tail: the row is clear...
  expect(row().unread).toBe(0);
  // ...and a fresh device attaching sees the pointer past the last message
  const ok = attachOf();
  expect(ok.known).toBe(true);
  expect(ok.total).toBe(3); // two replies + his utterance
  expect(ok.pointer).toBe(ok.total); // nothing before the end to speak
});

test("an utterance at the tail does not rewind, and mark-unread afterwards still moves it back", async () => {
  await reply("the one reply");
  expect(row().unread).toBe(1);

  // he reads it through, then answers: read stays read, and his own message did
  // not rewind the marker under itself
  const phone = core.client({ attach: wireId(PANE) });
  onAttach(phone.sock, { id: wireId(PANE) });
  onProgress({ id: wireId(PANE), seq: 1e9 });
  expect(row().unread).toBe(0);
  const heardAfterRead = session().heardTs;

  await utter(phone, "answered");
  expect(row().unread, "his own reply rewound the marker").toBe(0);
  expect(session().heardTs).toBeGreaterThanOrEqual(heardAfterRead);
  const atTail = attachOf();
  expect(atTail.pointer).toBe(atTail.total); // still past the end

  // the ONE deliberate backward write still works: the count returns and the
  // pointer parks before the last agent message
  expect(markUnread(session())).toBe(true);
  expect(row().unread).toBe(1);
  const back = attachOf();
  expect(back.pointer, "mark-unread did not move the pointer back").toBeLessThan(back.total);
});

test("a second utterance cannot rewind below the first: forward only", async () => {
  /* markRead is the single forward-only gate every path to "read" goes through,
   * and an utterance is just another caller of it. Two messages he sends in a
   * row cannot leave the marker behind the first of them, however the stamps
   * happen to fall. */
  await reply("something to answer");
  const phone = core.client({ attach: wireId(PANE) });
  await utter(phone, "one");
  const afterFirst = session().heardTs;
  await utter(phone, "two");
  expect(session().heardTs).toBeGreaterThanOrEqual(afterFirst);
  expect(row().unread).toBe(0);
});

test("a claude reply does not advance the marker", async () => {
  /* If a reply advanced the marker the way an utterance does, it would land
   * already-read and he would never be told about it. */
  await reply("one");
  const phone = core.client({ attach: wireId(PANE) });
  onAttach(phone.sock, { id: wireId(PANE) });
  onProgress({ id: wireId(PANE), seq: 1e9 });
  expect(row().unread).toBe(0);

  await reply("two");
  expect(row().unread, "a claude reply advanced the marker over itself").toBe(1);
  const ok = attachOf();
  expect(ok.pointer).toBeLessThan(ok.total); // the new reply is where speech starts
});

test("an engine notice does not advance the marker either", async () => {
  /* Engine notices share the reply path (noticeChat logs role:"claude"), so
   * neither ever moves the pointer: only HIS messages, through
   * injectUserMessage, do. A notice that advanced it would silently mark a real
   * reply beneath it as read. */
  await reply("the reply he has not seen");
  expect(row().unread).toBe(1);

  noticeChat(session(), "the pane was restarted");
  expect(row().unread, "an engine notice moved the read marker").toBe(2);
  const ok = attachOf();
  expect(ok.pointer).toBeLessThan(ok.total);
});

test("a heard ack for an OLD clip cannot rewind a newer read", async () => {
  /* The frame still NAMES a message, because that is what the device knows: it
   * finished playing this clip. The marker it moves is a timestamp, and markRead
   * is the forward-only gate, so a device catching up on an old clip cannot
   * rewind a newer read made on another device. */
  const first = await reply("older");
  await reply("newer");
  const phone = core.client({ attach: wireId(PANE) });
  onAttach(phone.sock, { id: wireId(PANE) });
  onProgress({ id: wireId(PANE), seq: 1e9 });
  expect(row().unread).toBe(0);

  onHeard({ id: wireId(PANE), msgId: first });
  expect(row().unread).toBe(0);
  // and a heard for a msgId this engine has never seen is ignored, not guessed
  onHeard({ id: wireId(PANE), msgId: crypto.randomUUID() });
  expect(row().unread).toBe(0);
});

test("his message in a chat he had never read still leaves nothing behind", async () => {
  /* The first-utterance case: the marker starts level and his message is the
   * newest thing in the log, so everything above it -- which is everything -- is
   * read. No pointer to park, no divider to draw. */
  await reply("a");
  await reply("b");
  await reply("c");
  expect(row().unread).toBe(3);

  const phone = core.client({ attach: wireId(PANE) });
  await utter(phone, "answering all three at once");
  expect(row().unread).toBe(0);
  const ok = attachOf();
  expect(ok.total).toBe(4);
  expect(ok.pointer).toBe(ok.total);
});
