import {h} from '../../../components/domHelpers';

export type CycVoiceState = 'listening' | 'you-cut-in' | 'transcribing' | 'speaking';

const LABEL: Record<CycVoiceState, string> = {
  listening: 'Listening',
  'you-cut-in': 'You cut in',
  transcribing: 'Transcribing…',
  speaking: 'Speaking'
};

export type HeaderVoiceStrip = {
  el: HTMLElement;
  setState: (state: CycVoiceState | null) => void;
};

export function createHeaderVoiceStrip(): HeaderVoiceStrip {
  
  // `.cyc-voice-strip.cyc-vs-<state>` rules) ride here as finite self-variants keyed off
  // the same state classes setState() toggles. They carry `!` because the un-layered
  // `.cyc-voice-strip{color}` base beats a layered normal utility; a layered important
  // clears it. --cyc-text-muted / --cyc-accent keep the transcribing/speaking
  // arms day/night-live.
  const el = h(
    'div',
    'cyc-voice-strip [&.cyc-vs-listening]:text-[#4ec97b]! [&.cyc-vs-you-cut-in]:text-[#e0a03c]! ' +
      '[&.cyc-vs-transcribing]:text-[var(--cyc-text-muted)]! ' +
      '[&.cyc-vs-speaking]:text-[var(--cyc-accent)]!'
  );
  const dot = h(
    'span',
    'inline-block size-2 shrink-0 rounded-full bg-current me-[0.4375rem] ' +
      '[.cyc-vs-listening_&]:[animation:cyc-pulse_1.6s_infinite] ' +
      '[.cyc-vs-speaking_&]:[animation:cyc-pulse_1.6s_infinite]'
  );
  const label = h('span');
  el.append(dot, label);
  function setState(state: CycVoiceState | null) {
    for (const kind of Object.keys(LABEL) as CycVoiceState[]) {
      el.classList.toggle(`cyc-vs-${kind}`, kind === state);
    }
    el.classList.toggle('cyc-shown', state !== null);
    if (state) label.textContent = LABEL[state];
  }
  return {el, setState};
}
