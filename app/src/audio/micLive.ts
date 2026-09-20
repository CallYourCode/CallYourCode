type AudioCtxState = 'running' | 'suspended' | 'closed' | 'interrupted' | null;
type TrackReadyState = 'live' | 'ended' | null;

export type MicSnapshot = {
  contextState: AudioCtxState;
  trackReadyState: TrackReadyState;
  trackMuted: boolean;
  visible: boolean;
  engaging: boolean;
};

type MicFix = 'none' | 'resume' | 'reacquire';

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
  s: Pick<MicSnapshot, 'contextState' | 'trackReadyState' | 'trackMuted'>
): boolean {
  return s.contextState === 'running' && s.trackReadyState === 'live' && !s.trackMuted;
}

export function decideMicFix(s: MicSnapshot): MicFix {
  const canAct = s.engaging || s.visible;
  if (!canAct) return 'none';

  const trackDead = s.trackReadyState !== 'live' || s.trackMuted;
  const contextGone = !s.contextState || s.contextState === 'closed';
  if (trackDead || contextGone) return 'reacquire';
  if (s.contextState !== 'running') return 'resume';
  return 'none';
}

export async function applyMicFix(
  snap: MicSnapshot,
  ops: {
    resume: () => Promise<void> | void;
    reacquire: () => Promise<void> | void;
    inspect: () => MicSnapshot;
  }
): Promise<boolean> {
  const fix = decideMicFix(snap);
  if (fix === 'resume') await ops.resume();
  else if (fix === 'reacquire') await ops.reacquire();
  const after = ops.inspect();
  if (isMicLive(after)) return true;

  const again = decideMicFix({...after, engaging: snap.engaging, visible: snap.visible});
  if (again === 'reacquire') {
    await ops.reacquire();
    return isMicLive(ops.inspect());
  }
  return false;
}
