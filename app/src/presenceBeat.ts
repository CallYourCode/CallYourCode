import * as engine from './engine/store';
import {sessionState, dataState} from './sessionState';
import {speaker} from './audio/speaker';
import {pipeline} from './audio/pipeline';
import {TOUCH_DEVICE} from './speechGate';

interface PresenceBeatDeps {
  onTeardown(d: () => void): void;

  speakUnheard(id: string): void;
}

export function installPresenceBeat(deps: PresenceBeatDeps) {
  if (dataState.mode === 'live') {
    const speechGateBeat = () => {
      if (!document.hidden) {
        speaker.gateChanged();

        if (dataState.mode === 'live' && sessionState.activeId)
          deps.speakUnheard(sessionState.activeId);
        return;
      }
      if (pipeline.handsFreeSessionId) return;

      if (!TOUCH_DEVICE) return;

      speaker.pause();
    };
    document.addEventListener('visibilitychange', speechGateBeat);
    deps.onTeardown(() => document.removeEventListener('visibilitychange', speechGateBeat));

    const presenceParams = new URLSearchParams(location.search);
    const presenceHooks = !!presenceParams.get('testhooks');

    const IDLE_MS =
      presenceHooks && presenceParams.get('idlems')
        ? Number(presenceParams.get('idlems'))
        : 30 * 60_000;
    const BEAT_MS =
      presenceHooks && presenceParams.get('beatms') ? Number(presenceParams.get('beatms')) : 10_000;
    let lastActivityAt = Date.now();
    let claimingPresence = false;
    const watching = () => Date.now() - lastActivityAt < IDLE_MS || speaker.isPlaying();

    // A presence fact goes to the engine only while the sync is live (offline
    // design v2, section 7); the live edge re-claims it.
    const report = (on: boolean) => {
      if (engine.syncStatus() !== 'live') return;
      engine.setVisible(on);
    };

    const beatOnce = () => {
      if (document.hidden) return;
      if (watching()) {
        report(true);
        claimingPresence = true;
      } else if (claimingPresence) {
        report(false);
        claimingPresence = false;
      }
    };
    deps.onTeardown(
      engine.onSyncStatus((st) => {
        if (st === 'live' && !document.hidden) beatOnce();
      })
    );

    const markActivity = () => {
      lastActivityAt = Date.now();
      if (!claimingPresence && !document.hidden) beatOnce();
    };
    const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;
    for (const ev of ACTIVITY) {
      document.addEventListener(ev, markActivity, {capture: true, passive: true});
    }
    deps.onTeardown(() => {
      for (const ev of ACTIVITY) {
        document.removeEventListener(ev, markActivity, {capture: true} as EventListenerOptions);
      }
    });

    const offSpeaker = speaker.onState(() => {
      if (!claimingPresence && speaker.isPlaying() && !document.hidden) beatOnce();
    });
    deps.onTeardown(offSpeaker);

    const reportVisible = () => {
      if (document.hidden) {
        report(false);
        claimingPresence = false;
        return;
      }
      lastActivityAt = Date.now();
      beatOnce();
    };
    const reportGone = () => {
      report(false);
      claimingPresence = false;
    };
    const reportHidden = () => report(false);
    document.addEventListener('visibilitychange', reportVisible);
    window.addEventListener('focus', reportVisible);
    window.addEventListener('blur', reportGone);

    const beat = window.setInterval(beatOnce, BEAT_MS);
    deps.onTeardown(() => clearInterval(beat));

    window.addEventListener('pagehide', reportHidden);
    reportVisible();
    deps.onTeardown(() => {
      document.removeEventListener('visibilitychange', reportVisible);
      window.removeEventListener('focus', reportVisible);
      window.removeEventListener('blur', reportGone);
      window.removeEventListener('pagehide', reportHidden);
    });
  }
}
