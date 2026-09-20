import {describe, expect, test} from 'vitest';
import {applyMicFix, decideMicFix, isMicLive, type MicSnapshot} from '../audio/micLive';
function snap(partial: Partial<MicSnapshot>): MicSnapshot {
  return {
    contextState: 'running',
    trackReadyState: 'live',
    trackMuted: false,
    visible: true,
    engaging: false,
    ...partial
  };
}
type World = {
  contextState: MicSnapshot['contextState'];
  trackReadyState: MicSnapshot['trackReadyState'];
  trackMuted: boolean;
  resumes: number;
  reacquires: number;
};
function world(partial: Partial<World> = {}): World {
  return {
    contextState: 'running',
    trackReadyState: 'live',
    trackMuted: false,
    resumes: 0,
    reacquires: 0,
    ...partial
  };
}
function inspectOf(w: World, flags: Pick<MicSnapshot, 'visible' | 'engaging'>): MicSnapshot {
  return snap({
    contextState: w.contextState,
    trackReadyState: w.trackReadyState,
    trackMuted: w.trackMuted,
    ...flags
  });
}
async function recover(
  w: World,
  flags: Pick<MicSnapshot, 'visible' | 'engaging'>
): Promise<boolean> {
  return applyMicFix(inspectOf(w, flags), {
    resume: () => {
      w.resumes++;
      if (w.contextState === 'suspended' || w.contextState === 'interrupted') {
        w.contextState = 'running';
      }
    },
    reacquire: () => {
      w.reacquires++;
      w.contextState = 'running';
      w.trackReadyState = 'live';
      w.trackMuted = false;
    },
    inspect: () => inspectOf(w, flags)
  });
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
    expect(decideMicFix(inspectOf(ended, {visible: true, engaging: false}))).toBe('reacquire');
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
  test('GREEN: visibility or a mic tap re-acquires an ended track', async () => {
    const w = world({trackReadyState: 'ended'});
    expect(await recover(w, {visible: true, engaging: false})).toBe(true);
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
    expect(decideMicFix(inspectOf(w, {visible: true, engaging: false}))).toBe('reacquire');
    expect(await recover(w, {visible: true, engaging: false})).toBe(true);
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
