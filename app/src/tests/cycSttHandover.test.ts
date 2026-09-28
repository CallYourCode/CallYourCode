import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {pipeline} from '../audio/pipeline';
import type {SttStream, SttStreamHandlers} from '../engine/contract';

// The bug: a take that starts right after another was released got NO live
// stream. The earlier take held the one live-stream slot until its own
// stream.finish() answered (~5s after release), so the second take logged
// capture.stream.busy and ran batch-only, showing no live words while
// recording. The fix hands the slot over the instant a take is released
// (arbitrating): the later take opens its own stream at once, and the two
// briefly-overlapping streams stay apart by id.
//
// These drive startSttStream directly on the singleton (the one place the slot
// is claimed), with an injected stream factory, so the ownership rule is proven
// without a real AudioContext or engine socket.

type FakeStream = SttStream & {
  handlers: SttStreamHandlers;
  session: string | undefined;
  pushes: number;
  settle(text: string): void;
};

const P = pipeline as unknown as {
  streamFactory: ((h: SttStreamHandlers, s?: string) => SttStream) | null;
  tapNode: unknown;
  inFlight: Map<number, unknown>;
  preRoll: Float32Array[];
  preRollSamples: number;
  startSttStream(cap: unknown): void;
};

type Cap = {
  id: number;
  cid: string;
  forSession: string | undefined;
  stream: SttStream | null;
  streamOpen: boolean;
  arbitrating: boolean;
};

function makeCap(id: number, forSession?: string): Cap {
  return {
    id,
    cid: `cid-${id}`,
    forSession,
    stream: null,
    streamOpen: false,
    arbitrating: false
  };
}

describe('stt live-stream handover between back-to-back takes', () => {
  let created: FakeStream[];
  let savedFactory: typeof P.streamFactory;
  let savedTap: unknown;
  let savedInFlight: typeof P.inFlight;
  let savedPreRoll: Float32Array[];

  beforeEach(() => {
    created = [];
    savedFactory = P.streamFactory;
    savedTap = P.tapNode;
    savedInFlight = P.inFlight;
    savedPreRoll = P.preRoll;

    P.tapNode = {};
    P.inFlight = new Map();
    P.preRoll = [];
    P.preRollSamples = 0;
    P.streamFactory = (handlers, session) => {
      let resolve!: (text: string) => void;
      const finalPromise = new Promise<string>((r) => (resolve = r));
      const s: FakeStream = {
        handlers,
        session,
        pushes: 0,
        failed: false,
        push() {
          this.pushes++;
        },
        finish: () => finalPromise,
        abort() {},
        settle: (text) => resolve(text)
      };
      created.push(s);
      return s;
    };
  });

  afterEach(() => {
    P.streamFactory = savedFactory;
    P.tapNode = savedTap;
    P.inFlight = savedInFlight;
    P.preRoll = savedPreRoll;
    P.preRollSamples = 0;
  });

  test('a take released while its final is still owed hands the slot to the next take', async () => {
    const partials: {text: string; session: string | undefined; capture: number}[] = [];
    const off = pipeline.on('partial', (text, session, _committed, capture) => {
      partials.push({text, session, capture: capture as number});
    });

    // Take N opens the live stream and records.
    const n = makeCap(1, 's1');
    P.inFlight.set(n.id, n);
    P.startSttStream(n);
    expect(n.streamOpen).toBe(true);
    expect(n.stream).not.toBeNull();
    expect(created).toHaveLength(1);

    // Take N is released: it stops producing audio but its final is still owed
    // (stream.finish() has not answered yet), exactly the ~5s window from the
    // logs. inFlight still holds it, streamOpen is still true.
    n.arbitrating = true;

    // Take N+1 starts ~1.5s later. Before the fix this logged
    // capture.stream.busy and got no stream; now it opens its own.
    const n1 = makeCap(2, 's1');
    P.inFlight.set(n1.id, n1);
    P.startSttStream(n1);
    expect(n1.streamOpen).toBe(true);
    expect(n1.stream).not.toBeNull();
    expect(created).toHaveLength(2);
    expect(n1.stream).not.toBe(n.stream);

    // No cross-talk: each stream's partials carry its own take's id and session.
    created[0].handlers.onPartial?.('n words', 3, 0.4);
    created[1].handlers.onPartial?.('n plus one words', 5, 0.6);
    expect(partials).toEqual([
      {text: 'n words', session: 's1', capture: 1},
      {text: 'n plus one words', session: 's1', capture: 2}
    ]);

    // Take N's verdict still lands on take N: its own finish() resolves with its
    // own transcript, independent of N+1's live stream.
    created[0].settle('the earlier take transcript');
    await expect(created[0].finish()).resolves.toBe('the earlier take transcript');

    off();
  });

  test('a take that is still recording (not released) keeps the slot: the next take is batch-only', () => {
    // Guard remains for the case that cannot happen through fire() but must stay
    // safe: two live, un-released streams do not run at once.
    const n = makeCap(1, 's1');
    P.inFlight.set(n.id, n);
    P.startSttStream(n);
    expect(n.streamOpen).toBe(true);

    const n1 = makeCap(2, 's1');
    P.inFlight.set(n1.id, n1);
    P.startSttStream(n1);
    expect(n1.streamOpen).toBe(false);
    expect(n1.stream).toBeNull();
    expect(created).toHaveLength(1);
  });

  test('a partial from a released take that has since closed does not emit', () => {
    // onPartial guards on cap.streamOpen: once the released take's stream is
    // finally torn down (streamOpen false), a late partial from it is dropped
    // rather than showing under the wrong bubble.
    const partials: number[] = [];
    const off = pipeline.on('partial', (_t, _s, _c, capture) => partials.push(capture as number));

    const n = makeCap(1, 's1');
    P.inFlight.set(n.id, n);
    P.startSttStream(n);
    n.streamOpen = false; // its endCapture has set the flag false after finish()

    created[0].handlers.onPartial?.('late ghost', 1, 0.1);
    expect(partials).toEqual([]);
    off();
  });
});
