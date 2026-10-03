type AudioCtxState = 'running' | 'suspended' | 'closed' | 'interrupted' | null;
type TrackReadyState = 'live' | 'ended' | null;

// Whether audio actually comes out of the capture graph: the PCM tap receiving
// frames (or, with no tap, the render clock advancing). The reported states
// cannot say this. After an iPhone web app comes back from the background,
// WebKit can hand a page an AudioContext that reports 'running' on a live,
// unmuted track while the graph renders nothing: the waveform is flat and the
// live words get no audio, though the recorder (which reads the track, not the
// graph) still has every word (2026-10-03, capture.clip sttSent=0). Only the
// graph's own output proves it is live. 'unknown' is a graph too young to have
// delivered, or a read that did not wait for its first frames.
export type GraphFlow = 'flowing' | 'stalled' | 'unknown';

export type MicSnapshot = {
  contextState: AudioCtxState;
  trackReadyState: TrackReadyState;
  trackMuted: boolean;
  flow: GraphFlow;
  visible: boolean;
  engaging: boolean;
};

export type MicFix = 'none' | 'resume' | 'rebuild' | 'reacquire';

export type MicRecovery = {
  live: boolean;
  steps: MicFix[];
  after: MicSnapshot;
};

export function readContextState(state: string | null | undefined): AudioCtxState {
  if (
    state === 'running' ||
    state === 'suspended' ||
    state === 'closed' ||
    state === 'interrupted'
  ) {
    return state;
  }
  return state ? 'suspended' : null;
}

export function readTrackReadyState(state: string | null | undefined): TrackReadyState {
  if (state === 'live' || state === 'ended') return state;
  return state ? 'ended' : null;
}

export function isMicLive(
  s: Pick<MicSnapshot, 'contextState' | 'trackReadyState' | 'trackMuted' | 'flow'>
): boolean {
  return (
    s.contextState === 'running' &&
    s.trackReadyState === 'live' &&
    !s.trackMuted &&
    s.flow === 'flowing'
  );
}

// The recorder takes its audio straight from the track, so a live, unmuted
// track records a take whatever the graph is doing; the take then has no
// waveform or live words, and its words come from the clip.
export function canRecord(s: Pick<MicSnapshot, 'trackReadyState' | 'trackMuted'>): boolean {
  return s.trackReadyState === 'live' && !s.trackMuted;
}

export function decideMicFix(s: MicSnapshot): MicFix {
  const canAct = s.engaging || s.visible;
  if (!canAct) return 'none';

  const trackDead = s.trackReadyState !== 'live' || s.trackMuted;
  const contextGone = !s.contextState || s.contextState === 'closed';
  // Re-acquiring asks the OS for the mic again, and an iPhone web app shows its
  // permission prompt every time. Only a press on the mic earns that: iOS mutes
  // an idle warm track, and treating that as broken on focus/mute/context edges
  // re-prompted every few seconds (2026-09-25). An idle dead mic waits for the
  // next press, which re-acquires it once.
  if (trackDead || contextGone) return s.engaging ? 'reacquire' : 'none';
  if (s.contextState !== 'running') return 'resume';
  // Every reported state is healthy and the graph still delivers nothing. The
  // track is good (the recorder records it), so the graph is rebuilt on it: no
  // getUserMedia, no prompt. Only a press reads the graph, so only a press
  // rebuilds it.
  if (s.flow === 'stalled') return s.engaging ? 'rebuild' : 'none';
  return 'none';
}

// Apply fixes until the mic is live or nothing is left to try. Each fix runs at
// most once per recovery: a graph that a rebuild did not revive is reported as
// still dead, never rebuilt in a loop, and a track is re-acquired only when the
// track itself is dead.
export async function applyMicFix(
  snap: MicSnapshot,
  ops: {
    resume: () => Promise<void> | void;
    rebuild: () => Promise<void> | void;
    reacquire: () => Promise<void> | void;
    inspect: () => Promise<MicSnapshot> | MicSnapshot;
  }
): Promise<MicRecovery> {
  const steps: MicFix[] = [];
  let now = snap;
  for (;;) {
    if (isMicLive(now)) return {live: true, steps, after: now};
    const fix = decideMicFix({...now, engaging: snap.engaging, visible: snap.visible});
    if (fix === 'none' || steps.includes(fix)) return {live: false, steps, after: now};
    steps.push(fix);
    await ops[fix]();
    now = await ops.inspect();
  }
}
