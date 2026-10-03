import {describe, expect, test} from 'vitest';
import {
  applyMicFix,
  canRecord,
  decideMicFix,
  isMicLive,
  type MicRecovery,
  type MicSnapshot
} from '../audio/micLive';
function snap(partial: Partial<MicSnapshot>): MicSnapshot {
  return {
    contextState: 'running',
    trackReadyState: 'live',
    trackMuted: false,
    flow: 'flowing',
    visible: true,
    engaging: false,
    listening: false,
    ...partial
  };
}
type World = {
  contextState: MicSnapshot['contextState'];
  trackReadyState: MicSnapshot['trackReadyState'];
  trackMuted: boolean;
  flow: MicSnapshot['flow'];
  // The page's audio output itself is dead: no graph built on it delivers.
  deadOutput: boolean;
  resumes: number;
  rebuilds: number;
  reacquires: number;
};
function world(partial: Partial<World> = {}): World {
  return {
    contextState: 'running',
    trackReadyState: 'live',
    trackMuted: false,
    flow: 'flowing',
    deadOutput: false,
    resumes: 0,
    rebuilds: 0,
    reacquires: 0,
    ...partial
  };
}
type Flags = Pick<MicSnapshot, 'visible' | 'engaging'> & Partial<Pick<MicSnapshot, 'listening'>>;
function inspectOf(w: World, flags: Flags): MicSnapshot {
  return snap({
    contextState: w.contextState,
    trackReadyState: w.trackReadyState,
    trackMuted: w.trackMuted,
    flow: w.flow,
    ...flags
  });
}
async function recoverWith(w: World, flags: Flags): Promise<MicRecovery> {
  return applyMicFix(inspectOf(w, flags), {
    resume: () => {
      w.resumes++;
      if (w.contextState === 'suspended' || w.contextState === 'interrupted') {
        w.contextState = 'running';
      }
    },
    rebuild: () => {
      w.rebuilds++;
      w.contextState = 'running';
      w.flow = w.deadOutput ? 'stalled' : 'flowing';
    },
    reacquire: () => {
      w.reacquires++;
      w.contextState = 'running';
      w.trackReadyState = 'live';
      w.trackMuted = false;
      w.flow = w.deadOutput ? 'stalled' : 'flowing';
    },
    inspect: () => inspectOf(w, flags)
  });
}
async function recover(
  w: World,
  flags: Pick<MicSnapshot, 'visible' | 'engaging'>
): Promise<boolean> {
  return (await recoverWith(w, flags)).live;
}
describe('mic live state machine', () => {
  test('RED: a held stream that has died still looks ready to the old guard', () => {
    const suspended = snap({contextState: 'suspended'});
    const ended = snap({trackReadyState: 'ended'});
    const muted = snap({trackMuted: true});
    expect(isMicLive(suspended)).toBe(false);
    expect(isMicLive(ended)).toBe(false);
    expect(isMicLive(muted)).toBe(false);

    const stuck = world({contextState: 'suspended', trackReadyState: 'ended'});
    expect(isMicLive(stuck)).toBe(false);
    expect(stuck.resumes).toBe(0);
    expect(stuck.reacquires).toBe(0);
  });
  test('RED: without applyMicFix a suspended context stays silent', () => {
    const w = world({contextState: 'suspended'});
    expect(isMicLive(w)).toBe(false);
    expect(decideMicFix(inspectOf(w, {visible: true, engaging: true}))).toBe('resume');
    expect(w.contextState).toBe('suspended');
  });
  test('RED: without applyMicFix an ended or muted track stays dead', () => {
    const ended = world({trackReadyState: 'ended'});
    const muted = world({trackMuted: true});
    expect(decideMicFix(inspectOf(ended, {visible: true, engaging: true}))).toBe('reacquire');
    expect(decideMicFix(inspectOf(muted, {visible: false, engaging: true}))).toBe('reacquire');
    expect(isMicLive(ended)).toBe(false);
    expect(isMicLive(muted)).toBe(false);
  });
  test('hidden and not engaging does not fight the OS', () => {
    expect(
      decideMicFix(
        snap({
          contextState: 'suspended',
          visible: false,
          engaging: false
        })
      )
    ).toBe('none');
    expect(
      decideMicFix(
        snap({
          trackReadyState: 'ended',
          visible: false,
          engaging: false
        })
      )
    ).toBe('none');
  });
  test('GREEN: visibility or a mic tap resumes a suspended context', async () => {
    const byVisible = world({contextState: 'suspended'});
    expect(await recover(byVisible, {visible: true, engaging: false})).toBe(true);
    expect(byVisible.resumes).toBe(1);
    expect(byVisible.reacquires).toBe(0);
    expect(byVisible.contextState).toBe('running');
    const byTap = world({contextState: 'interrupted'});
    expect(await recover(byTap, {visible: false, engaging: true})).toBe(true);
    expect(byTap.resumes).toBe(1);
    expect(byTap.reacquires).toBe(0);
  });
  test('GREEN: a mic tap re-acquires an ended track', async () => {
    const w = world({trackReadyState: 'ended'});
    expect(await recover(w, {visible: true, engaging: true})).toBe(true);
    expect(w.reacquires).toBe(1);
    expect(w.resumes).toBe(0);
    expect(w.trackReadyState).toBe('live');
  });
  test('GREEN: a muted track is re-acquired so capture is live again', async () => {
    const w = world({trackMuted: true});
    expect(await recover(w, {visible: false, engaging: true})).toBe(true);
    expect(w.reacquires).toBe(1);
    expect(w.trackMuted).toBe(false);
    expect(isMicLive(w)).toBe(true);
  });
  test('GREEN: a closed context is re-acquired, not merely resumed', async () => {
    const w = world({contextState: 'closed'});
    expect(decideMicFix(inspectOf(w, {visible: true, engaging: true}))).toBe('reacquire');
    expect(await recover(w, {visible: true, engaging: true})).toBe(true);
    expect(w.reacquires).toBe(1);
    expect(w.contextState).toBe('running');
  });
  test('GREEN: resume that leaves a dead track then re-acquires', async () => {
    const w = world({contextState: 'suspended', trackReadyState: 'ended'});
    expect(await recover(w, {visible: true, engaging: true})).toBe(true);

    expect(w.reacquires).toBe(1);
    expect(isMicLive(w)).toBe(true);
  });
  test('a live running pipeline asks for no fix', () => {
    expect(decideMicFix(snap({visible: true, engaging: true}))).toBe('none');
    expect(isMicLive(snap({}))).toBe(true);
  });
});

// 2026-10-03, iPhone web app: after a background, every take had a flat
// waveform and sttSent=0 while the context said 'running' and the track said
// live and unmuted. No mic.* line was logged: the old model read only those
// reported states, so it judged the mic live. The graph's own output is the
// only evidence that it is.
describe('liveness is judged by audio flowing through the graph', () => {
  test('RED: running, live and unmuted with nothing flowing is not live', () => {
    const field = snap({flow: 'stalled', engaging: true});
    expect(isMicLive(field)).toBe(false);
    expect(isMicLive(snap({flow: 'unknown'}))).toBe(false);
    expect(decideMicFix(field)).toBe('rebuild');
  });
  test('a press rebuilds a stalled graph on the same track, with no getUserMedia', async () => {
    const w = world({flow: 'stalled'});
    const r = await recoverWith(w, {visible: true, engaging: true});
    expect(r.live).toBe(true);
    expect(r.steps).toEqual(['rebuild']);
    expect(w.rebuilds).toBe(1);
    expect(w.reacquires).toBe(0);
  });
  test('a stalled graph with no press is left alone: nothing reads it', async () => {
    const w = world({flow: 'stalled'});
    expect(decideMicFix(inspectOf(w, {visible: true, engaging: false}))).toBe('none');
    const r = await recoverWith(w, {visible: true, engaging: false});
    expect(r.live).toBe(false);
    expect(r.steps).toEqual([]);
    expect(w.rebuilds).toBe(0);
  });
  test('a graph a rebuild did not revive is reported once, never rebuilt in a loop or re-acquired', async () => {
    const w = world({flow: 'stalled', deadOutput: true});
    const r = await recoverWith(w, {visible: true, engaging: true});
    expect(r.live).toBe(false);
    expect(r.steps).toEqual(['rebuild']);
    expect(w.rebuilds).toBe(1);
    expect(w.reacquires).toBe(0);
    expect(r.after.flow).toBe('stalled');
    // The recorder reads the track, not the graph: the press still records.
    expect(canRecord(r.after)).toBe(true);
  });
  test('a resume that leaves the graph stalled goes on to rebuild it', async () => {
    const w = world({contextState: 'interrupted', flow: 'stalled'});
    const r = await recoverWith(w, {visible: true, engaging: true});
    expect(r.live).toBe(true);
    expect(r.steps).toEqual(['resume', 'rebuild']);
    expect(w.reacquires).toBe(0);
  });
  test('a dead track is re-acquired, not rebuilt, even when nothing flows', async () => {
    const w = world({trackMuted: true, flow: 'stalled'});
    expect(decideMicFix(inspectOf(w, {visible: true, engaging: true}))).toBe('reacquire');
    const r = await recoverWith(w, {visible: true, engaging: true});
    expect(r.live).toBe(true);
    expect(r.steps).toEqual(['reacquire']);
    expect(w.rebuilds).toBe(0);
  });
  test('a re-acquired track on a dead output goes on to one rebuild, then stops', async () => {
    const w = world({trackReadyState: 'ended', flow: 'stalled', deadOutput: true});
    const r = await recoverWith(w, {visible: true, engaging: true});
    expect(r.live).toBe(false);
    expect(r.steps).toEqual(['reacquire', 'rebuild']);
    expect(w.reacquires).toBe(1);
    expect(w.rebuilds).toBe(1);
  });
  test('only a dead track stops a press from recording', () => {
    expect(canRecord(snap({flow: 'stalled'}))).toBe(true);
    expect(canRecord(snap({contextState: 'suspended', flow: 'unknown'}))).toBe(true);
    expect(canRecord(snap({trackMuted: true}))).toBe(false);
    expect(canRecord(snap({trackReadyState: 'ended'}))).toBe(false);
    expect(canRecord(snap({trackReadyState: null}))).toBe(false);
  });
});

// Hands-free has no press: its voice detector reads the analyser, and on a
// dead graph it reads zeros and never opens a turn. Listening is a reader, so
// a stall while listening is rebuilt on the same track; it never re-acquires
// (no press, so no iPhone prompt) and never acts while hidden.
describe('hands-free listening reads the graph like a press', () => {
  test('RED: a stalled graph while listening is not left alone', () => {
    expect(decideMicFix(snap({flow: 'stalled', listening: true}))).toBe('rebuild');
  });
  test('listening rebuilds a stalled graph once, with no getUserMedia', async () => {
    const w = world({flow: 'stalled'});
    const r = await recoverWith(w, {visible: true, engaging: false, listening: true});
    expect(r.live).toBe(true);
    expect(r.steps).toEqual(['rebuild']);
    expect(w.reacquires).toBe(0);
  });
  test('listening on a dead output rebuilds once and stops', async () => {
    const w = world({flow: 'stalled', deadOutput: true});
    const r = await recoverWith(w, {visible: true, engaging: false, listening: true});
    expect(r.live).toBe(false);
    expect(r.steps).toEqual(['rebuild']);
  });
  test('listening never re-acquires a dead track: that would prompt with no press', async () => {
    const w = world({trackMuted: true, flow: 'stalled'});
    expect(decideMicFix(inspectOf(w, {visible: true, engaging: false, listening: true}))).toBe(
      'none'
    );
    const r = await recoverWith(w, {visible: true, engaging: false, listening: true});
    expect(r.steps).toEqual([]);
    expect(w.reacquires).toBe(0);
  });
  test('a hidden page is not rebuilt for listening', () => {
    expect(decideMicFix(snap({flow: 'stalled', listening: true, visible: false}))).toBe('none');
  });
});

describe('an idle mic never re-prompts (iPhone web apps prompt on every re-acquire)', () => {
  test('focus, mute or a context edge with no press leaves a muted, ended or closed mic alone', async () => {
    for (const dead of [
      {trackMuted: true},
      {trackReadyState: 'ended' as const},
      {contextState: 'closed' as const}
    ]) {
      const w = world(dead);
      expect(decideMicFix(inspectOf(w, {visible: true, engaging: false}))).toBe('none');
      expect(await recover(w, {visible: true, engaging: false})).toBe(false);
      expect(w.reacquires).toBe(0);
    }
  });
  test('the next press re-acquires it once', async () => {
    const w = world({trackMuted: true});
    expect(await recover(w, {visible: true, engaging: true})).toBe(true);
    expect(w.reacquires).toBe(1);
  });
  test('a suspended context still resumes on focus: no prompt involved', async () => {
    const w = world({contextState: 'suspended'});
    expect(await recover(w, {visible: true, engaging: false})).toBe(true);
    expect(w.reacquires).toBe(0);
  });
});
