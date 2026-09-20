import type {CycSession} from '../../../types';
import {h} from '../../../components/domHelpers';
import {makeIcon, makeIconButton, BTN_HOVER_UTILS} from '../../../components/iconGlyphs';
import {avatarView, avatarSeed} from '../../../components/avatarView';
import {DEFAULT_AGENT_NAME} from '@/features/chat/navigation/chatRow';
import {createTypingIndicator} from '@/features/chat/navigation/typing';
import {PANE_HEADER_UTILS, PANE_BACK_UTILS} from '@/features/sessions/components/paneHeader';
import {confirmPopup, toast} from '../../../components/widgets';
import {
  currentPresentation,
  registerPresentationPainter,
  type Presentation
} from '../../../components/presentation';
import {engineToolbarActions, type CycToolbarActionId} from '@/features/settings/preferences';

import {captioned, createHeaderActions} from './actions';
import {cyclog} from '@/shared/logging';
import {createHeaderContextControl} from './contextBar';
import {createHeaderVoiceStrip, type CycVoiceState} from './voiceStrip';

export type Header = {
  setSpeed: (label: string) => void;

  setCronCount: (n: number) => void;

  setModelBadge: (acronym: string | null) => void;
  el: HTMLElement;
  update: (session: CycSession) => void;

  setVoiceState: (state: CycVoiceState | null) => void;

  actionButton: (id: CycToolbarActionId) => HTMLElement | null;

  refreshToolbarActions: () => void;
};

// Phone uses `[&.cyc-hdr-phone]:` because the width class is on this element.
const HEADER_BOX =
  'max-w-[var(--cyc-chat-width)] mx-auto z-[2] [&.cyc-hdr-phone]:z-[3] top-0 inset-x-0 ' +
  'shadow-[0px_1px_5px_-1px_rgba(0,0,0,0.21)] ' +
  '[transform:translate3d(0,calc(0px_+_0px),0)] ' +
  'min-h-[var(--cyc-chat-header-height)]! h-[var(--cyc-chat-header-height)]! bg-[var(--cyc-surface)]! ' +
  '[transition:transform_0.3s_cubic-bezier(0.32,0.72,0,1),margin-bottom_0s_0s,background-color_0.3s_cubic-bezier(0.32,0.72,0,1)]!';

export function createHeader(opts: {
  session: CycSession;
  onBack: () => void;
  onToggleConversation: () => void;
  onToggleMute: () => void;

  notifyOn?: (sessionId: string) => boolean;
  onToggleNotify?: () => void;
  onOpenProfile: () => void;
  onOpenSettings?: () => void;

  onInterrupt?: () => void;

  onCompact?: () => void;
  onCycleSpeed?: () => void;

  overlay?: () => {on: boolean; available: boolean};
  onToggleOverlay?: () => void;

  onOpenTerminal?: () => void;

  // Whether this chat's engine can take a frame right now: the actions that
  // run on the engine itself are grey, disabled and titled while it cannot.
  engineReachable?: (s: CycSession) => boolean;

  toolbarEngine?: (sessionId: string) => {engineKey: string | null; plugins: ReadonlySet<string>};

  onPluginAction?: (id: CycToolbarActionId) => void;
}): Header {
  // base -- the `.cyc-mast` marker is unique to the chat header, and nothing un-layered
  // sets its position, so this layered utility is the voice strip's offset parent.
  const el = h('div', 'cyc-pane-header cyc-mast relative ' + PANE_HEADER_UTILS + ' ' + HEADER_BOX);
  const container = h(
    'div',
    'cyc-mast-info-box relative z-[1] flex flex-wrap content-center h-[inherit] w-full ' +
      'cursor-pointer items-center gap-y-1 [.cyc-hdr-phone_&]:gap-y-[0.1875rem] [.cyc-hdr-phone_&]:py-[0.375rem]'
  );

  const btnBack = makeIconButton(
    'left',
    'cyc-pane-back top-[calc(var(--cyc-safe-top)+0.75rem)] bottom-auto ' +
      '[.cyc-hdr-phone_&]:top-[calc(var(--cyc-safe-top)+0.375rem)] [.cyc-hdr-phone_&]:h-[2.875rem] ' +
      '[.cyc-hdr-laptop_&]:hidden ' +
      PANE_BACK_UTILS
  );
  btnBack.addEventListener('click', opts.onBack);
  btnBack.style.position = 'absolute';

  // The header-info flex-item geometry forks by width: the 551+ leg is the base; phone
  // takes the shrinking wrapped-row leg.
  const chatInfo = h(
    'div',
    'cyc-mast-info w-px flex-[100_0_8rem] min-w-[8rem] ps-[49px] ' +
      '[.cyc-hdr-phone_&]:flex-[3_1_calc(100%-11.5rem)] [.cyc-hdr-phone_&]:min-w-0'
  );
  // (D) Desktop tightens the header-info start pad: a width painter sets it inline at
  // laptop (>=900) and clears it below so the base ps-[49px] applies; inline beats
  // chat.css's un-layered non-important 0.
  const paintInfoPad = (p: Presentation) => {
    chatInfo.style.paddingInlineStart = p.width === 'laptop' ? '0.625rem' : '';
  };
  paintInfoPad(currentPresentation());
  registerPresentationPainter(el, paintInfoPad);
  const person = h('div', 'cyc-mast-person flex h-full items-center');
  const content = h('div', 'cyc-mast-text max-w-full flex-auto overflow-hidden ps-[0.875rem]');
  const top = h('div', 'cyc-mast-line-1');
  const title = h(
    'div',
    'cyc-title-line flex max-w-[calc(100%-0.5rem)] items-center text-[1rem] leading-6 font-medium'
  );
  const bottom = h('div', 'cyc-mast-line-2 text-[0.875rem] text-[var(--cyc-text-muted)]');
  const status = h(
    'div',
    'cyc-mast-status max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[var(--cyc-line-height)]'
  );
  top.append(title);
  bottom.append(status);
  content.append(top, bottom);
  person.append(content);
  chatInfo.append(person);
  person.addEventListener('click', opts.onOpenProfile);

  let current = opts.session;

  const utils = h(
    'div',
    'cyc-mast-utils contents [&_.cyc-mast-dummy]:opacity-45 ' +
      '[&_.cyc-mast-slot.cyc-call-disabled]:opacity-45 [&_.cyc-mast-unavailable]:opacity-40'
  );

  const actions = createHeaderActions({
    el,
    utils,
    sessionId: () => current.id,
    toolbarEngine: opts.toolbarEngine,
    onPluginAction: (id) => opts.onPluginAction?.(id)
  });
  const {headerBreak, reg, refreshToolbarActions: rehomeToolbarActions, actionButton} = actions;

  const WIDTH_CLASS: Record<Presentation['width'], string> = {
    phone: 'cyc-hdr-phone',
    tablet: 'cyc-hdr-tablet',
    laptop: 'cyc-hdr-laptop'
  };
  const paintHeaderWidth = (p: Presentation) => {
    el.classList.remove('cyc-hdr-phone', 'cyc-hdr-tablet', 'cyc-hdr-laptop');
    el.classList.add(WIDTH_CLASS[p.width]);
    el.style.paddingInline = p.width === 'phone' ? '0.75rem' : '0.25rem';
    actions.remeasure();
  };
  paintHeaderWidth(currentPresentation());
  registerPresentationPainter(el, paintHeaderWidth);

  let lastCronCount = 0;
  let lastModelBadge: string | null = null;

  const refreshToolbarActions = () => {
    rehomeToolbarActions();
    setCronCount(lastCronCount);
    setModelBadge(lastModelBadge);
  };

  const speedBtn = h(
    'button',
    [
      'cyc-icon-btn cyc-speed-btn cyc-force-show',
      // Phone narrows the speed button to fill its wrapped slot over the base
      // w-[2.875rem]/max-w-full.
      'flex items-center justify-center w-[2.875rem] max-w-full h-10 px-0! overflow-hidden ' +
        '[.cyc-hdr-phone_&]:w-full [.cyc-hdr-phone_&]:max-w-[2.5rem]',

      // (display/box already supplied above). `py-2!` keeps the 0.5rem block padding while
      // `px-0!` above zeroes the inline padding; `text-(--cyc-text-muted)` is the
      // label ink; `text-[1.5rem]!` beats the un-layered reset.css `button` font reset.
      'text-center leading-none relative text-[1.5rem]! py-2! text-(--cyc-text-muted) ' +
        '[transition:color_0.15s_ease-in-out,opacity_0.15s_ease-in-out]',
      BTN_HOVER_UTILS
    ].join(' ')
  );
  const speedLabel = h('span', 'cyc-speed-label text-[1.0625rem] font-semibold tracking-[-0.03em]');
  speedLabel.textContent = '1x';
  speedBtn.append(speedLabel);
  speedBtn.addEventListener('click', () => opts.onCycleSpeed?.());

  const stopBtn = makeIconButton('hand', 'cyc-stop-btn cyc-force-show');
  stopBtn.title = 'interrupt (ctrl+c)';

  stopBtn.addEventListener('click', () => {
    confirmPopup({
      title: 'Send Ctrl-C?',
      description:
        `Interrupt ${current.name}. Whatever it is doing stops where it is, ` +
        'and that cannot be undone.',
      className: 'cyc-confirm-stop',
      buttons: [
        {text: 'Cancel'},
        {text: 'Send Ctrl-C', danger: true, callback: () => opts.onInterrupt?.()}
      ]
    });
  });

  const context = createHeaderContextControl({
    session: () => current,
    engineReachable: opts.engineReachable,
    onCompact: opts.onCompact
  });
  const ctxSlot = reg('ctx', context.slot);

  const convBtn = makeIconButton(
    'phone',
    'cyc-conv-toggle cyc-force-show ' +
      '[&.cyc-conv-on]:text-[#4ec97b]! [&.cyc-conv-on_.cyc-icon]:text-[#4ec97b]!'
  );
  convBtn.addEventListener('click', () => {
    convBtn.classList.toggle('cyc-conv-on');
    opts.onToggleConversation();
  });

  const bellBtn = makeIconButton('unmute', 'cyc-notify-toggle cyc-force-show');
  bellBtn.addEventListener('click', () => opts.onToggleNotify?.());

  const muteBtn = makeIconButton('speaker', 'cyc-mute-toggle cyc-force-show');
  muteBtn.addEventListener('click', opts.onToggleMute);

  const overlayBtn = makeIconButton('tools', 'cyc-overlay-toggle cyc-force-show');
  overlayBtn.addEventListener('click', () => {
    if (overlayBtn.hasAttribute('disabled')) {
      toast('This pane has no session log');
      return;
    }
    opts.onToggleOverlay?.();
  });

  const dummy = (
    glyph: Parameters<typeof makeIcon>[0],
    cls: string,
    label: string,
    what: string
  ) => {
    const btn = makeIconButton(glyph, `${cls} cyc-force-show cyc-mast-dummy`);
    btn.title = `${label} (not built yet)`;
    btn.setAttribute('aria-label', `${label} (not built yet)`);
    btn.addEventListener('click', () => toast(what));
    return captioned(btn, label);
  };

  const termBtn = opts.onOpenTerminal
    ? (() => {
        const btn = makeIconButton('terminal', 'cyc-term-btn cyc-force-show');
        btn.title = 'TUI';
        btn.setAttribute('aria-label', 'TUI');
        btn.addEventListener('click', () => opts.onOpenTerminal?.());
        return captioned(btn, 'TUI');
      })()
    : dummy('terminal', 'cyc-term-btn', 'TUI', 'The terminal pane is not built yet');
  reg('terminal', termBtn);

  const captionOf = (id: CycToolbarActionId): HTMLElement | null =>
    utils.querySelector<HTMLElement>(`[data-cyc-action="${id}"] .cyc-mast-caption`);
  function setCronCount(n: number) {
    lastCronCount = n;
    const cap = captionOf('crons');
    if (cap) cap.textContent = n > 0 ? `Crons ${n}` : 'Crons';
  }
  function setModelBadge(acronym: string | null) {
    lastModelBadge = acronym;
    const cap = captionOf('model-indicator');
    if (cap) cap.textContent = acronym ? acronym : 'Model';
  }

  const APP_LEVEL = [
    reg('speed', captioned(speedBtn, 'Speed')),
    reg('sound', captioned(muteBtn, 'Autoplay')),

    reg('activity', captioned(overlayBtn, 'Activity'))
  ];

  const THIS_SESSION = [
    reg('call', captioned(convBtn, 'Call')),

    reg('notify', captioned(bellBtn, 'Notify')),
    ctxSlot,
    termBtn,
    reg('stop', captioned(stopBtn, 'Stop'))
  ];

  utils.append(
    ...APP_LEVEL,

    headerBreak,
    ...THIS_SESSION
  );

  container.append(btnBack, chatInfo, utils);
  el.append(container);

  refreshToolbarActions();

  const voiceStrip = createHeaderVoiceStrip();
  el.append(voiceStrip.el);

  const typing = createTypingIndicator();

  function paint(
    btn: HTMLElement,
    glyph: Parameters<typeof makeIcon>[0],
    on: boolean,
    label: string
  ) {
    btn.querySelector('.cyc-icon')?.replaceWith(makeIcon(glyph));
    btn.classList.toggle('cyc-mast-off', !on);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  const NEEDS_ENGINE = 'needs the engine';
  function setNeedsEngine(btn: HTMLElement, on: boolean) {
    btn.classList.toggle('cyc-mast-unavailable', on);
    btn.toggleAttribute('disabled', on);
    if (on) {
      if (btn.title !== NEEDS_ENGINE) btn.dataset.cycTitle = btn.title;
      btn.title = NEEDS_ENGINE;
    } else if (btn.title === NEEDS_ENGINE) {
      btn.title = btn.dataset.cycTitle ?? '';
      delete btn.dataset.cycTitle;
    }
  }

  let lastToolbarSession = '';

  function update(s: CycSession) {
    current = s;

    if (s.id !== lastToolbarSession) {
      lastToolbarSession = s.id;
      refreshToolbarActions();
    }

    const unreachable = opts.engineReachable ? !opts.engineReachable(s) : false;
    const headerConfig = opts.toolbarEngine?.(s.id) ?? {
      engineKey: null,
      plugins: new Set<string>()
    };
    for (const a of engineToolbarActions(headerConfig.engineKey, headerConfig.plugins)) {
      if (!a.needsEngine || a.id === 'ctx') continue;
      const btn = actionButton(a.id);
      if (btn) setNeedsEngine(btn, unreachable);
    }

    title.textContent = '';
    const peerTitle = h(
      'span',
      'cyc-who max-w-full min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[var(--cyc-line-height)]'
    );
    peerTitle.textContent = s.name;
    title.append(peerTitle);

    status.textContent = '';
    const waiting = s.status === 'blocked';
    if (waiting) status.textContent = 'waiting for your answer';
    else if (s.thinking) status.append(typing.el);
    else {
      const harness = s.agentName ?? DEFAULT_AGENT_NAME;
      status.textContent = s.model ? `${harness} · ${s.model}` : harness;
    }

    const notify = opts.notifyOn ? opts.notifyOn(s.id) : true;
    paint(
      bellBtn,
      notify ? 'unmute' : 'mute',
      notify,
      notify ? 'Notifications on for this chat' : 'Notifications off for this chat'
    );
    paint(
      muteBtn,
      s.muted ? 'speakerOff' : 'speaker',
      !s.muted,
      s.muted ? 'Muted: replies do not play out loud' : 'Replies play out loud'
    );

    const overlay = opts.overlay?.();
    paint(
      overlayBtn,
      overlay?.on ? 'tools' : 'toolsOff',
      !!overlay?.on,
      !overlay?.available
        ? 'Session activity (this pane has no session log)'
        : overlay.on
          ? 'Session activity on'
          : 'Session activity off'
    );
    overlayBtn.toggleAttribute('disabled', !!overlay && !overlay.available);
    overlayBtn.classList.toggle('cyc-mast-unavailable', !!overlay && !overlay.available);

    context.update(s);

    person.querySelector('.cyc-mast-avatar')?.remove();
    person.prepend(avatarView(s.name, 42, 'cyc-mast-avatar flex-none', s.avatarUrl, avatarSeed(s)));
  }

  update(opts.session);
  const setSpeed = (label: string) => {
    speedLabel.textContent = label;
  };

  setTimeout(() => {
    if (!el.isConnected) return;
    const cy = (r: DOMRect) => Math.round(r.top + r.height / 2);
    const bar = el.getBoundingClientRect();
    const av = el.querySelector('.cyc-mast-avatar')?.getBoundingClientRect();
    const back = el.querySelector('.cyc-pane-back')?.getBoundingClientRect();
    const slot = el.querySelector('.cyc-mast-slot')?.getBoundingClientRect();
    const glyph = el
      .querySelector('.cyc-mast-slot .cyc-icon-btn, .cyc-mast-slot .cyc-speed-btn')
      ?.getBoundingClientRect();
    const cap = el.querySelector('.cyc-mast-caption')?.getBoundingClientRect();
    cyclog('header.geom', {
      w: window.innerWidth,
      barH: Math.round(bar.height),
      barCy: cy(bar),
      avCy: av ? cy(av) : null,
      backCy: back ? cy(back) : null,
      backH: back ? Math.round(back.height) : null,
      slotH: slot ? Math.round(slot.height) : null,
      slotCy: slot ? cy(slot) : null,
      glyphCy: glyph ? cy(glyph) : null,
      capBottom: cap ? Math.round(cap.bottom) : null,
      barBottom: Math.round(bar.bottom)
    });
  }, 1500);

  return {
    el,
    update,
    setVoiceState: voiceStrip.setState,
    setSpeed,
    setCronCount,
    setModelBadge,
    actionButton,
    refreshToolbarActions
  };
}
