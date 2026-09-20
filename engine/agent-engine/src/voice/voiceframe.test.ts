/* THE VOICE FRAME CARRIES THE VOICE UNIT'S HEALTH (item 8, the engine half).
 *
 * The app hides the mic, press-and-hold and call mode when the live
 * {t:"voice"} frame says healthy:false; an ABSENT field means an old engine and
 * voice stays on. This engine always sends the field, computed from the voice
 * unit (services.units()): all members up is true, a member down is false, and
 * NO voice unit at all (a modifier that runs no voice services) is an honest
 * false. No voice means no mic, which is the truthful report rather than
 * "assume voice is on".
 *
 * These are the engine's promises, asserted on the frames a client would
 * actually receive:
 *
 *   THE FIELD IS ON THE CONNECT FRAME. Without it the app cannot tell a new
 *   engine that means false from an old one that never heard of the field.
 *
 *   NO VOICE UNIT IS false, not true. The defining defect class of this project
 *   is the app asserting what it does not know; an engine with no voice must
 *   not let the app assume a mic that records into nothing.
 *
 *   A MID-SESSION FLIP REBROADCASTS. A connect-time value goes stale the moment
 *   a member dies, so the unit's health is pushed to every client on a flip,
 *   unasked, and the app updates without a reload.
 *
 *   AND ONLY ON A FLIP. The supervisor looks at every service every minute. A
 *   frame per tick would repaint every device on every device's behalf forever;
 *   the diff gate is what makes this a change notification rather than a poll.
 *
 * WHAT IS REAL HERE: sessions-frame.ts (the burst and the frame shape) and
 * wire.ts (the broadcast, over recorded client sockets). NO ENGINE, no
 * services, no toy processes, no ports: the supervision side is a typed fake
 * whose flip semantics mirror services.ts, and the real all-or-none computation
 * over real listening ports is services.test.ts's row (the process annex).
 *
 *   bun test agent-engine/src/voice/voiceframe.test.ts
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { fakeClient, type FakeClient } from "../test-utils/wire-core.ts";
import { initSessionsFrame, sendHelloBurst, voiceFrame, type VoiceReady,
  resetForTest as resetSessionsFrame } from "../sessions/sessions-frame.ts";
import { broadcast, resetForTest as resetWire } from "../transport/wire.ts";
import { groupingFrom } from "../sessions/tabs.ts";
import type { UnitState } from "../runtime/services.ts";

const VOICE_PUBLIC_URL = "https://box.tail1234.ts.net/voice";

/* ------------------------------------------------------- the supervision fake
 *
 * A member is a service with a `unit` and a "is it listening" flag. Everything
 * about how that flag gets its value (lsof, a TCP connect, a launchd job, the
 * lease) is services.ts's business and is proven there against real processes;
 * what this file needs is the two rules that reach the wire.
 *
 * MIRRORS services.ts Services.units(): a unit is HEALTHY only when ALL of its
 * members are listening. Not degraded: DOWN. A partial voice stack does not
 * record anything, so a mix of green rows that together do not work must read
 * as a coherent "not whole".
 *
 * MIRRORS services.ts emitUnitHealthChanges(): a pass tells onUnitHealth about
 * a unit whose health FLIPPED since the last pass and about no others, and the
 * FIRST look only seeds the baseline. A flip needs a previous value to differ
 * from, and a client connecting now already has the current value on its
 * connect frame, so seeding is not a change to broadcast. */
type Member = { key: string; name: string; unit?: string; running: boolean };

function fakeSupervision(members: Member[]) {
  const listeners: Array<(unit: string, healthy: boolean) => void> = [];
  const lastHealthy = new Map<string, boolean>();

  const units = (): UnitState[] => {
    const names: string[] = [];
    for (const m of members) {
      if (m.unit !== undefined && !names.includes(m.unit)) names.push(m.unit);
    }
    return names.map((name) => {
      const mine = members.filter((m) => m.unit === name);
      const down = mine.filter((m) => !m.running);
      const healthy = down.length === 0;
      return {
        name, healthy, members: mine.map((m) => m.key),
        note: healthy
          ? `whole: all ${mine.length} members are listening`
          : `not whole: ${down.map((m) => m.name).join(", ")} ` +
            `${down.length === 1 ? "is" : "are"} not up, so the whole unit is down`,
      };
    });
  };

  return {
    units,
    onUnitHealth(cb: (unit: string, healthy: boolean) => void) { listeners.push(cb); },
    /** whether one member is listening right now (services.health() running) */
    running(key: string): boolean {
      return members.find((m) => m.key === key)?.running === true;
    },
    /** a member died or came back, without a pass having happened yet */
    setRunning(key: string, on: boolean) {
      const m = members.find((x) => x.key === key);
      if (!m) throw new Error(`no member ${key} in this fake table`);
      m.running = on;
    },
    /** ONE supervision pass. Every flip since the last pass, and nothing else. */
    pass() {
      for (const u of units()) {
        const prev = lastHealthy.get(u.name);
        lastHealthy.set(u.name, u.healthy);
        if (prev !== undefined && prev !== u.healthy) {
          for (const cb of listeners) cb(u.name, u.healthy);
        }
      }
    },
  };
}
type Supervision = ReturnType<typeof fakeSupervision>;

/* ------------------------------------------------------------- server.ts glue
 *
 * Two functions boot() defines inline and nothing can import, because each
 * closes over a const boot owns. Same bodies, same names, so a change on either
 * side is a visible difference rather than a silent divergence (the convention
 * test-utils/wire-core.ts already uses for the rest of the boot glue). */

/** Mirrors server.ts voiceHealthy(): a "voice" unit reports its own health, and
 *  NO voice unit at all is false rather than true. */
const voiceHealthy = (sv: Supervision): boolean =>
  sv.units().find((u) => u.name === "voice")?.healthy ?? false;

/** Mirrors server.ts voiceReady()'s service-up half: stt is the transcriber
 *  member, tts rides kokoro, each on its own. (The model-presence half is
 *  services-model-gate.test.ts's subject; in this fake the models are simply
 *  "there".) */
const voiceReadyOf = (sv: Supervision): VoiceReady => ({
  stt: sv.running("stt"), tts: sv.running("kokoro"),
});

/** Mirrors server.ts's onUnitHealth handler (broadcastVoice): only the voice
 *  unit reaches the wire, on the same frame the connect handler sends. */
function wireVoiceFlips(sv: Supervision, ready: () => VoiceReady): void {
  sv.onUnitHealth((name) => {
    if (name !== "voice") return;
    broadcast(voiceFrame(VOICE_PUBLIC_URL, voiceHealthy(sv), ready()));
  });
}

/** The wiring server.ts performs, for one supervision table. `ready` defaults
 *  to the per-member mirror above; a spec hands its own in to ride a download
 *  hint on the frame. */
function wire(sv: Supervision, ready?: () => VoiceReady): void {
  const readyOf = ready ?? (() => voiceReadyOf(sv));
  initSessionsFrame({
    engineCan: ["words", "plugins"],
    pluginDecls: () => [],
    voiceHealthy: () => voiceHealthy(sv),
    voiceReady: readyOf,
    voicePublicUrl: VOICE_PUBLIC_URL,
    engineUser: "tester",
    engineHost: "probe",
    tabs: groupingFrom(undefined),
    replyLevel: () => 1,
    hasSessionEvents: (k) => k === "claude",
  });
  wireVoiceFlips(sv, readyOf);
}

/** A page that connects now and gets the burst, keeping every frame. */
function connect(): FakeClient {
  const c = fakeClient();
  sendHelloBurst(c.sock);
  return c;
}

const opened: FakeClient[] = [];
beforeEach(() => {
  resetWire();
  resetSessionsFrame();
});
afterEach(() => {
  for (const c of opened.splice(0)) c.close();
  resetWire();
  resetSessionsFrame();
});

/** The voice frames one client has been sent, in order. */
const voiceFrames = (c: FakeClient) => c.of("voice");

/** A whole voice unit: both members listening, which is his box on a good day. */
const wholeVoice = () => fakeSupervision([
  { key: "kokoro", name: "kokoro (tts)", unit: "voice", running: true },
  { key: "stt", name: "stt (whisper streaming + batch)", unit: "voice", running: true },
]);

/* ------------------------------------------------------------ at connect */

test("an engine with no voice unit says healthy:false, and says it out loud", () => {
  /* A modifier who runs no voice services at all. units() is empty, and the
   * honest answer is false: no voice means no mic. */
  wire(fakeSupervision([{ key: "web", name: "some other service", running: true }]));
  const c = connect();
  opened.push(c);

  const voice = voiceFrames(c).at(0);
  expect(voice, "the engine sent no voice frame at connect").toBeTruthy();
  expect("healthy" in voice!,
    "the voice frame omits the healthy field, so the app cannot tell this engine from an " +
    "old one that never heard of it").toBe(true);
  expect(voice!.healthy,
    "an engine with no voice unit reported healthy:true, which is assuming a mic that is " +
    "not there").toBe(false);
});

test("a whole voice unit says healthy:true at connect", () => {
  wire(wholeVoice());
  const c = connect();
  opened.push(c);
  expect(voiceFrames(c).at(0)?.healthy,
    "the voice unit is whole but the connect frame does not say healthy:true").toBe(true);
});

test("one member down makes the unit false at connect, not degraded", () => {
  const sv = wholeVoice();
  sv.setRunning("stt", false);
  wire(sv);
  const c = connect();
  opened.push(c);
  /* ALL OR NONE. Half a voice stack transcribes nothing, so a mic offered
   * against it records into the void; there is no partial state to offer. */
  expect(voiceFrames(c).at(0)?.healthy).toBe(false);
});

test("the voice frame carries the public url beside the health", () => {
  wire(wholeVoice());
  const c = connect();
  opened.push(c);
  const voice = voiceFrames(c).at(0)!;
  // the app needs BOTH: where the voice engine is, and whether to offer it
  expect(voice.url).toBe(VOICE_PUBLIC_URL);
  /* `ready` joined the frame with the background model warm-up (per-capability
   * readiness); `download` rides only while a model is actually downloading,
   * so a whole voice stack does not carry it. */
  expect(Object.keys(voice).sort()).toEqual(["healthy", "ready", "t", "url"]);
});

/* --------------------------------------------- per-capability readiness */

test("the connect frame carries per-capability readiness beside the unit health", () => {
  wire(wholeVoice());
  const c = connect();
  opened.push(c);
  expect(voiceFrames(c).at(0)?.ready).toEqual({ stt: true, tts: true });
});

test("tts can be ready while stt still warms up: the fresh-install shape", () => {
  /* kokoro's 330 MB landed and its service is up; whisper's 1.6 GB is still
   * downloading. The unit is honestly not whole (mic hidden), but tts is
   * READY: the app can offer spoken replies while transcription warms up. */
  const sv = wholeVoice();
  sv.setRunning("stt", false);
  wire(sv);
  const c = connect();
  opened.push(c);
  const voice = voiceFrames(c).at(0)!;
  expect(voice.healthy, "a half-warm unit claimed to be whole").toBe(false);
  expect(voice.ready).toEqual({ stt: false, tts: true });
});

test("a download in flight rides the frame as a hint, with its percent", () => {
  const sv = wholeVoice();
  sv.setRunning("stt", false);
  wire(sv, () => ({ stt: false, tts: true, download: { stt: 37 } }));
  const c = connect();
  opened.push(c);
  const voice = voiceFrames(c).at(0)!;
  expect(voice.download).toEqual({ stt: 37 });
  expect(voice.ready).toEqual({ stt: false, tts: true });
});

test("a wiring without voiceReady falls back to the unit health for both capabilities", () => {
  /* Older glue (and a modifier's) wires only voiceHealthy: the frame still
   * carries `ready`, derived from the whole-or-nothing view it already had. */
  const sv = wholeVoice();
  initSessionsFrame({
    engineCan: [], pluginDecls: () => [], voiceHealthy: () => voiceHealthy(sv),
    voicePublicUrl: VOICE_PUBLIC_URL, engineUser: "tester", engineHost: "probe",
    tabs: groupingFrom(undefined), replyLevel: () => 1,
    hasSessionEvents: (k) => k === "claude",
  });
  const c = connect();
  opened.push(c);
  expect(voiceFrames(c).at(0)?.ready).toEqual({ stt: true, tts: true });
});

test("a readiness flip mid-session rides the rebroadcast frame", () => {
  const sv = wholeVoice();
  wire(sv);
  const c = connect();
  opened.push(c);
  sv.pass(); // seed
  sv.setRunning("stt", false);
  sv.pass();
  const last = voiceFrames(c).at(-1)!;
  expect(voiceFrames(c).length).toBe(2);
  expect(last.ready, "the rebroadcast frame does not carry the new per-capability view")
    .toEqual({ stt: false, tts: true });
});

test("the voice frame rides the burst before host and the session list", () => {
  wire(wholeVoice());
  const c = connect();
  opened.push(c);
  /* THE ORDER IS PART OF THE CONTRACT. The app reads `can` to decide what this
   * engine supports, then paints from `voice`, `host` and `sessions`. A voice
   * frame after the session list would repaint a composer that had already
   * drawn a mic. */
  const order = c.frames.map((f) => f.t);
  expect(order.indexOf("voice")).toBeGreaterThan(order.indexOf("can"));
  expect(order.indexOf("voice")).toBeLessThan(order.indexOf("host"));
  expect(order.indexOf("voice")).toBeLessThan(order.indexOf("sessions"));
});

/* ------------------------------------------------------ the mid-session flip */

test("a member dying mid-session rebroadcasts the voice frame with the new health", () => {
  const sv = wholeVoice();
  wire(sv);
  const c = connect();
  opened.push(c);
  expect(voiceFrames(c).at(0)?.healthy, "the unit was not whole at connect").toBe(true);

  // the first pass only seeds the baseline: nothing changed, nobody is told
  sv.pass();
  expect(voiceFrames(c).length).toBe(1);

  // a member dies with the page open
  sv.setRunning("stt", false);
  sv.pass();

  const last = voiceFrames(c).at(-1);
  expect(voiceFrames(c).length,
    "the engine did not rebroadcast, so the app keeps showing a mic that records into " +
    "nothing until the page is reloaded").toBe(2);
  expect(last?.healthy).toBe(false);
  expect(last?.url).toBe(VOICE_PUBLIC_URL);
});

test("a member coming back rebroadcasts true, so the mic returns without a reload", () => {
  const sv = wholeVoice();
  sv.setRunning("kokoro", false);
  wire(sv);
  const c = connect();
  opened.push(c);
  expect(voiceFrames(c).at(0)?.healthy).toBe(false);

  sv.pass();                       // seeds false
  sv.setRunning("kokoro", true);   // the supervisor's restart warmed up
  sv.pass();

  expect(voiceFrames(c).length).toBe(2);
  expect(voiceFrames(c).at(-1)?.healthy).toBe(true);
});

test("the flip reaches EVERY connected device, not just the one that noticed", () => {
  const sv = wholeVoice();
  wire(sv);
  const laptop = connect();
  const phone = connect();
  opened.push(laptop, phone);

  sv.pass();
  sv.setRunning("stt", false);
  sv.pass();

  for (const c of [laptop, phone]) {
    expect(voiceFrames(c).length, "a connected device was not told about the flip").toBe(2);
    expect(voiceFrames(c).at(-1)?.healthy).toBe(false);
  }
});

test("a device that connects AFTER the flip gets the new value at connect, not the old one", () => {
  const sv = wholeVoice();
  wire(sv);
  sv.pass();
  sv.setRunning("stt", false);
  sv.pass();

  const late = connect();
  opened.push(late);
  /* The connect frame is computed, not remembered: a cached true would hand a
   * freshly opened tab a mic the engine has already said is gone. */
  expect(voiceFrames(late).length).toBe(1);
  expect(voiceFrames(late).at(0)?.healthy).toBe(false);
});

/* ------------------------------------------------------------- and only on a flip */

test("passes that change nothing broadcast nothing", () => {
  const sv = wholeVoice();
  wire(sv);
  const c = connect();
  opened.push(c);

  /* THE SUPERVISOR LOOKS EVERY MINUTE. A frame per look would be a poll dressed
   * as a push: every device repainting its composer forever, and the one real
   * flip lost in the noise. */
  for (let i = 0; i < 20; i++) sv.pass();
  expect(voiceFrames(c).length,
    "the voice frame is being sent per supervision tick rather than per change").toBe(1);
});

test("the same value twice in a row is told once", () => {
  const sv = wholeVoice();
  wire(sv);
  const c = connect();
  opened.push(c);

  sv.pass();
  sv.setRunning("stt", false);
  sv.pass();   // the flip
  sv.pass();   // still down: not news
  sv.pass();
  expect(voiceFrames(c).length).toBe(2);
});

test("a member that flaps back inside one pass is not a flip at all", () => {
  const sv = wholeVoice();
  wire(sv);
  const c = connect();
  opened.push(c);

  sv.pass();
  sv.setRunning("stt", false);
  sv.setRunning("stt", true); // came back before anyone looked
  sv.pass();
  /* The gate is on the OBSERVED value, so a service that died and recovered
   * between two looks never happened as far as the wire is concerned. That is
   * the right answer: nothing the app could have done about it. */
  expect(voiceFrames(c).length).toBe(1);
});

test("a unit that is not the voice unit never reaches the wire", () => {
  const sv = fakeSupervision([
    { key: "kokoro", name: "kokoro (tts)", unit: "voice", running: true },
    { key: "db", name: "some other unit's member", unit: "storage", running: true },
  ]);
  wire(sv);
  const c = connect();
  opened.push(c);

  sv.pass();
  sv.setRunning("db", false);
  sv.pass();

  /* The engine supervises more than speech. Only the voice unit has a frame on
   * this wire, and a storage flip broadcasting a voice frame would tell every
   * device the mic died because a database did. */
  expect(voiceFrames(c).length).toBe(1);
  expect(voiceFrames(c).at(0)?.healthy).toBe(true);
});
