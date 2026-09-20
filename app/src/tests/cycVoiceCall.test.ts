import {describe, expect, test, vi} from 'vitest';
import {
  VoiceCall,
  MediaTrackSttStream,
  selectSttStream,
  verifyFp,
  type AudioSink
} from '../engine/voiceCall';
import {DcSttStream, type DcSttDeps} from '../engine/sttStream';
import type {SttStream} from '../engine/contract';
import type {AudioChannel} from '../engine/rtc';

if (typeof (globalThis as {MediaStream?: unknown}).MediaStream === 'undefined') {
  (globalThis as {MediaStream?: unknown}).MediaStream = class {
    constructor(public tracks: unknown[] = []) {}
  } as unknown;
}

function fakeChannel(over: Partial<{localFp: string | null; remoteFp: string | null}> = {}) {
  const local = over.localFp === undefined ? 'AA:BB' : over.localFp;
  const remote = over.remoteFp === undefined ? 'CC:DD' : over.remoteFp;
  const replaced: (MediaStreamTrack | null)[] = [];
  let fireInbound: ((t: MediaStreamTrack) => void) | null = null;
  const channel: AudioChannel = {
    sender: {
      replaceTrack: (t: MediaStreamTrack | null) => {
        replaced.push(t);
        return Promise.resolve();
      }
    } as unknown as RTCRtpSender,
    inboundTrack: () => null,
    onInboundTrack: (cb) => {
      fireInbound = cb;
    },
    localFp: () => local,
    remoteFp: () => remote
  };
  return {channel, replaced, fireInbound: (t: MediaStreamTrack) => fireInbound?.(t)};
}
function deps(over: Partial<Parameters<typeof makeCall>[1]> = {}) {
  const sealed: object[] = [];
  const closes: string[] = [];
  const sink: AudioSink & {played: MediaStream[]; stops: number} = {
    played: [],
    stops: 0,
    play(s) {
      this.played.push(s);
    },
    stop() {
      this.stops++;
    }
  };
  return {
    sealed,
    closes,
    sink,
    d: {
      seal: (f: object) => sealed.push(f),
      log: () => {},
      closeOnMismatch: (r: string) => closes.push(r),
      makeSink: () => sink,
      ...over
    }
  };
}
function makeCall(channel: AudioChannel, d: ConstructorParameters<typeof VoiceCall>[1]) {
  return new VoiceCall(channel, d);
}

function engineFp(appLocal: string, engineOwn: string) {
  return {t: 'fp', local: engineOwn, remote: appLocal};
}
describe('verifyFp', () => {
  test('matching fingerprints verify and the reply carries the app view', () => {
    const {channel} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const res = verifyFp(engineFp('AA', 'BB'), channel);
    expect(res.ok).toBe(true);
    expect(res.reply).toEqual({t: 'fp', local: 'AA', remote: 'BB'});
  });
  test('case-insensitive compare (SDP hex is upper, frame may differ)', () => {
    const {channel} = fakeChannel({localFp: 'AA:BB', remoteFp: 'CC:DD'});
    expect(verifyFp(engineFp('aa:bb', 'cc:dd'), channel).ok).toBe(true);
  });
  test('a mismatched engine fingerprint fails', () => {
    const {channel} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    expect(verifyFp(engineFp('AA', 'WRONG'), channel).ok).toBe(false);
  });
  test('a media transport we could not fingerprint (null) never verifies', () => {
    const {channel} = fakeChannel({localFp: null, remoteFp: 'BB'});
    expect(verifyFp(engineFp('AA', 'BB'), channel).ok).toBe(false);
  });
});
describe('VoiceCall fp gate', () => {
  test('a matching fp opens the gate and replies; audio stays held until then', () => {
    const {channel, replaced} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const {sealed, d} = deps();
    const call = makeCall(channel, d);
    const mic = {} as MediaStreamTrack;

    call.setMic(mic);
    expect(call.ready).toBe(false);
    expect(replaced).toEqual([]);
    call.bindFp(engineFp('AA', 'BB'));
    expect(sealed).toContainEqual({t: 'fp', local: 'AA', remote: 'BB'});
    expect(call.ready).toBe(true);

    expect(replaced).toEqual([mic]);
  });
  test('a mismatched fp closes the connection and does not open the gate', () => {
    const {channel} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const {closes, d} = deps();
    const call = makeCall(channel, d);
    call.bindFp(engineFp('AA', 'WRONG'));
    expect(call.ready).toBe(false);
    expect(closes).toEqual(['fp-mismatch']);
  });
  test('the downlink track plays only once the gate is open', () => {
    const {channel, fireInbound} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const {sink, d} = deps();
    const call = makeCall(channel, d);
    const track = {kind: 'audio'} as MediaStreamTrack;
    fireInbound(track);
    expect(sink.played.length).toBe(0);
    call.bindFp(engineFp('AA', 'BB'));
    expect(sink.played.length).toBe(1);
  });
});
describe('MediaTrackSttStream over voice-ctl', () => {
  function opened() {
    const {channel} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const {sealed, d} = deps();
    const call = makeCall(channel, d);
    call.bindFp(engineFp('AA', 'BB'));
    sealed.length = 0;
    const partials: string[] = [];
    const mic = {} as MediaStreamTrack;
    const stream = call.openCapture(
      'sess-1',
      {onPartial: (t) => partials.push(t)},
      mic
    ) as MediaTrackSttStream;
    return {call, sealed, partials, stream, mic};
  }
  test('opening a capture sends voice-ctl start and attaches the mic', () => {
    const {sealed} = opened();
    expect(sealed).toContainEqual({t: 'voice-ctl', op: 'start', session: 'sess-1'});
  });
  test('partials route to the handler; push is a no-op (audio is on the track)', () => {
    const {call, partials, stream} = opened();
    stream.push(new Float32Array(160));
    (call as unknown as {onSttFrame: (f: object) => void}).onSttFrame({t: 'partial', text: 'hel'});
    (call as unknown as {onSttFrame: (f: object) => void}).onSttFrame({
      t: 'partial',
      text: 'hello'
    });
    expect(partials).toEqual(['hel', 'hello']);
  });
  test('finish sends voice-ctl stop and resolves on the sealed final', async () => {
    const {call, sealed, stream} = opened();
    const done = stream.finish();
    expect(sealed).toContainEqual({t: 'voice-ctl', op: 'stop'});
    (call as unknown as {onSttFrame: (f: object) => void}).onSttFrame({
      t: 'final',
      text: 'hello world'
    });
    await expect(done).resolves.toBe('hello world');
  });
  test('a connection close before the final rejects the pending capture', async () => {
    const {call, stream} = opened();
    const done = stream.finish();
    call.close();
    await expect(done).rejects.toThrow(/closed before final/);
  });
  test('finish times out if no final ever arrives', async () => {
    vi.useFakeTimers();
    const {stream} = opened();
    const done = stream.finish();
    const settled = done.then(
      () => 'ok',
      (e) => e.message
    );
    await vi.advanceTimersByTimeAsync(15_001);
    await expect(settled).resolves.toMatch(/no final within timeout/);
    vi.useRealTimers();
  });
});

describe('selectSttStream: honest path choice', () => {
  const dcDeps: DcSttDeps = {send: () => true, drain: () => Promise.resolve(), detach: () => {}};
  test('call mode, no mic track: the ONE DC stream paints partials, finish resolves on stt-final, the send fires', async () => {
    const opened: DcSttStream[] = [];
    const partials: string[] = [];
    const sends: string[] = [];
    const stream = selectSttStream(
      {
        callSessionId: 'sess-1',
        micTrack: null,
        hasVoiceMedia: () => false,
        openMedia: () => {
          throw new Error('media path must not be chosen');
        },
        openDc: (_s, h) => {
          const st = new DcSttStream(dcDeps, h);
          opened.push(st);
          return st;
        }
      },
      {onPartial: (t) => partials.push(t)},
      'sess-1'
    );
    expect(opened.length).toBe(1);
    opened[0].onFrame({t: 'stt-partial', text: 'send th'});

    const done = stream.finish().then((t) => {
      sends.push(t);
      return t;
    });
    opened[0].onFrame({t: 'stt-final', text: 'send the fix'});
    await expect(done).resolves.toBe('send the fix');
    expect(partials).toEqual(['send th']);
    expect(sends).toEqual(['send the fix']);
  });
  test('call mode, media claims ready but the mic track is missing: still the DC path', () => {
    let dc = 0;
    selectSttStream(
      {
        callSessionId: 'sess-1',
        micTrack: null,
        hasVoiceMedia: () => true,
        openMedia: () => {
          throw new Error('media path must not be chosen');
        },
        openDc: (_s, h) => {
          dc++;
          return new DcSttStream(dcDeps, h);
        }
      },
      {},
      'sess-1'
    );
    expect(dc).toBe(1);
  });
  test('a real track and a sender-bearing channel: the media path is chosen, unchanged', () => {
    const mic = {} as MediaStreamTrack;
    let media = 0;
    const idle: SttStream = {
      failed: false,
      push: () => {},
      finish: () => new Promise<string>(() => {}),
      abort: () => {}
    };
    selectSttStream(
      {
        callSessionId: 'sess-1',
        micTrack: mic,
        hasVoiceMedia: (s) => s === 'sess-1',
        openMedia: (s, _h, m) => {
          media++;
          expect(s).toBe('sess-1');
          expect(m).toBe(mic);
          return idle;
        },
        openDc: () => {
          throw new Error('dc path must not be chosen');
        }
      },
      {},
      'sess-1'
    );
    expect(media).toBe(1);
  });
  test('a capture outside the call session keeps the DC path even with media up', () => {
    let dc = 0;
    selectSttStream(
      {
        callSessionId: 'sess-1',
        micTrack: {} as MediaStreamTrack,
        hasVoiceMedia: () => true,
        openMedia: () => {
          throw new Error('media path must not be chosen');
        },
        openDc: (_s, h) => {
          dc++;
          return new DcSttStream(dcDeps, h);
        }
      },
      {},
      'sess-2'
    );
    expect(dc).toBe(1);
  });
});
describe('canCarryAudio: the gate alone is not a track', () => {
  test('an open fp gate WITHOUT a sender cannot carry audio (the DC-only dial)', () => {
    const {channel} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const senderless = {...channel, sender: null} as AudioChannel;
    const {d} = deps();
    const call = makeCall(senderless, d);
    call.bindFp(engineFp('AA', 'BB'));
    expect(call.ready).toBe(true);
    expect(call.canCarryAudio).toBe(false);
  });
  test('an open gate WITH a sender carries audio', () => {
    const {channel} = fakeChannel({localFp: 'AA', remoteFp: 'BB'});
    const {d} = deps();
    const call = makeCall(channel, d);
    expect(call.canCarryAudio).toBe(false);
    call.bindFp(engineFp('AA', 'BB'));
    expect(call.canCarryAudio).toBe(true);
  });
});
