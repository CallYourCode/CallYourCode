import * as engine from './engine/store';
import {sessionState, dataState} from './sessionState';
import {speaker} from './audio/speaker';
import {pipeline} from './audio/pipeline';
import {TOUCH_DEVICE} from './speechGate';
import {cyclog} from '@/shared/logging';

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

    // EVERY PRESENCE TRANSITION, with the page event behind it (owner report,
    // 2026-10-03: the engine said the phone was backgrounded while the owner was on the
    // chat, and neither side could say which event made it so). Logged when the
    // claim or whether it could be sent changes, not on the beat restating it;
    // `why` also rides the frame so the engine's own presence line names it.
    let lastLogged = '';
    // A presence fact goes to the engine only while the sync is live (offline
    // design v2, section 7); the live edge re-claims it.
    const report = (on: boolean, why: string) => {
      const live = engine.syncStatus() === 'live';
      if (`${on}:${live}` !== lastLogged) {
        lastLogged = `${on}:${live}`;
        cyclog('presence.report', {
          on,
          why,
          vis: document.visibilityState,
          focus: document.hasFocus(),
          sent: live
        });
      }
      if (!live) return;
      engine.setVisible(on, why);
    };

    const beatOnce = (why: string) => {
      if (document.hidden) return;
      if (watching()) {
        report(true, why);
        claimingPresence = true;
      } else if (claimingPresence) {
        report(false, 'idle');
        claimingPresence = false;
      }
    };
    deps.onTeardown(
      engine.onSyncStatus((st) => {
        if (st === 'live' && !document.hidden) beatOnce('live');
      })
    );

    const markActivity = (e: Event) => {
      lastActivityAt = Date.now();
      if (!claimingPresence && !document.hidden) beatOnce(e.type);
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
      if (!claimingPresence && speaker.isPlaying() && !document.hidden) beatOnce('speaker');
    });
    deps.onTeardown(offSpeaker);

    const reportVisible = (e?: Event) => {
      const why = e?.type ?? 'install';
      if (document.hidden) {
        report(false, why);
        claimingPresence = false;
        return;
      }
      lastActivityAt = Date.now();
      beatOnce(why);
    };
    const reportGone = () => {
      report(false, 'blur');
      claimingPresence = false;
    };
    const reportHidden = () => report(false, 'pagehide');
    document.addEventListener('visibilitychange', reportVisible);
    window.addEventListener('focus', reportVisible);
    window.addEventListener('blur', reportGone);

    const beat = window.setInterval(() => beatOnce('beat'), BEAT_MS);
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
