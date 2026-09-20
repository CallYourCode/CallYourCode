import {h} from '../components/domHelpers';
import {BTN_HOVER_UTILS, makeIcon} from '../components/iconGlyphs';
import {beatKey, logSkip, readBeat, sameBeat} from './cardBeat';
import {cyclog} from '@/shared/logging';
import {
  CARD_SANDBOX,
  cardDocument,
  themeVars,
  cardFontReady,
  loadSandboxDocument
} from '@/features/plugins/sandbox';

const CARD_MIN_H = 40;
const CARD_MAX_H = 480;
const CARD_DEFAULT_H = 150;
const CARD_VERIFY_MS = 2000;
const REVEAL_VERIFY_MS = 500;
const VERIFY_RETRIES = 2;
const REJECT_BACKOFF_MS = 3000;
const REFRESH_SPIN_MIN_MS = 400;

type PluginCardUpdate = {
  html: string | null;
  hosts?: string[];
  loading?: boolean;
  error?: string;
  height?: number;
  when?: string;
  aging?: boolean;
  errorLine?: string;
};

export type PluginCard = {
  el: HTMLElement;
  update(u: PluginCardUpdate): void;

  park(): void;
  reveal(): void;

  poke(): void;
  flash(): void;
  destroy(): void;
};

type FrameState = {
  el: HTMLIFrameElement;
  html: string;
  doc: string;
  theme: string;
  height: number;
  attempt: number;
  timer: number;
  assignedAt: number;
  generation: number;
  dispose: () => void;
  // The last accepted heartbeat's compare key and how many identical beats
  // followed it (see cardBeat.ts).
  beat: string | null;
  skips: number;
};

export function createPluginCard(title: string, onRefresh: () => void | Promise<void>): PluginCard {
  const el = h(
    'div',
    [
      'cyc-plugincard cyc-off relative flex-none [&.cyc-plugincard-loading]:opacity-60',
      'mx-2 mt-1.5 mb-[0.3125rem] px-2 pt-1.5 pb-[0.4375rem]',
      'text-xs leading-[1.35]',
      'bg-[color-mix(in_srgb,var(--cyc-text-muted)_16%,var(--cyc-surface))]'
    ].join(' ')
  );
  const hostsRow = h('div', 'cyc-plugincard-hosts cyc-off flex flex-wrap gap-1 mt-[0.1875rem]');
  // Absolute top-end corner box, small 1.375rem glyph, secondary ink -- was the
  // un-layered `.cyc-plugincard-refresh` rule. This raw producer bypasses makeIconButton(), so
  
  // !justify-center` centre the glyph and `!p-2` keeps the 0.5rem padding (font-size,
  // ink and position are overridden below).
  const refresh = h(
    'button',
    [
      'cyc-plugincard-refresh cyc-icon-btn',
      BTN_HOVER_UTILS,
      '!absolute !top-1.5 !end-2 !z-[1] !flex !flex-none !items-center !justify-center !p-2',
      '!w-[1.375rem] !h-[1.375rem] !text-[0.9375rem] !text-[var(--cyc-text-muted)]'
    ].join(' ')
  );
  refresh.append(makeIcon('refresh'));
  refresh.title = 'Check now';
  refresh.setAttribute('aria-label', 'Check now');
  refresh.addEventListener('click', async (e) => {
    e.stopPropagation();
    cyclog('card.refresh', {});
    const started = Date.now();
    refresh.classList.add('cyc-plugincard-refreshing');
    try {
      await onRefresh();
    } finally {
      const left = REFRESH_SPIN_MIN_MS - (Date.now() - started);
      if (left > 0) await new Promise<void>((resolve) => setTimeout(resolve, left));
      refresh.classList.remove('cyc-plugincard-refreshing');
    }
  });

  // THE STATUS OVERLAY IS AN OPAQUE PLATE CHIP (#usagehead). This span floats
  // OVER the engine frame at end-8 (right:2rem), next to the refresh button, and
  // holds the freshness status. The common status is the SHORT "Nm ago" / "Nh
  // ago"; the engine frame reserves a right zone sized to just that short form
  // (.uc-head padding-right:5.5rem in
  // engine/agent-engine/src/plugins/usage-card/index.ts), so in the normal fresh
  // state the email shows nearly full and only clips a hair.
  //
  // The RARE long status ("59m ago (check throttled)", ~9.1rem in Inter / ~10.4rem
  // in the system-ui fallback) extends LEFT past that short reservation, over the
  // email tail. To keep that from being a transparent overprint, the chip carries
  // an OPAQUE background in the card's own plate colour -- color-mix(... --cyc-text-muted
  // 16% ... --cyc-surface), the exact mix both the card element and the frame body
  // (sandbox.ts cardBaseStyle plate) paint -- plus px-1 inset, so the long form
  // sits on a chip that CLEANLY COVERS the email underneath rather than bleeding
  // through it. max-w-[12rem] bounds it (fits the longest status + the px-1 pad,
  // with headroom over the 10.4rem fallback) so an extreme status still
  // ellipsizes. pointer-events-none keeps the refresh button clickable above it.
  const whenEl = h(
    'span',
    [
      'cyc-plugincard-when cyc-off absolute top-1.5 end-8 z-[1] max-w-[12rem] px-1 rounded-[3px]',
      'bg-[color-mix(in_srgb,var(--cyc-text-muted)_16%,var(--cyc-surface))]',
      'overflow-hidden text-ellipsis whitespace-nowrap pointer-events-none',
      'text-xs leading-[1.375rem] text-[var(--cyc-text-muted)]'
    ].join(' ')
  );
  const body = h('div', 'cyc-plugincard-body relative mt-0');
  el.append(refresh, whenEl, hostsRow, body);

  let active: FrameState | null = null;
  let candidate: FrameState | null = null;
  let placeholder: HTMLElement | null = null;
  let errEl: HTMLElement | null = null;
  let lastHosts = '';
  let lastWhen = '';
  let lastErrLine = '';
  let lastU: PluginCardUpdate | null = null;
  let revealTimer = 0;
  let flashTimer = 0;
  let destroyed = false;
  let parked = false;
  let generation = 0;
  let rejected: {html: string; theme: string; at: number} | null = null;

  const clampedHeight = (height?: number) =>
    Math.min(CARD_MAX_H, Math.max(CARD_MIN_H, height ?? CARD_DEFAULT_H));

  const setWhen = (text: string) => {
    if (text !== lastWhen) {
      lastWhen = text;
      whenEl.textContent = text;
    }
    whenEl.classList.toggle('cyc-off', !text);
  };

  const setPlaceholder = (text: string | null) => {
    if (!text) {
      placeholder?.remove();
      placeholder = null;
      return;
    }
    if (!placeholder) {
      placeholder = h('div', 'cyc-plugincard-placeholder');
      body.prepend(placeholder);
    }
    placeholder.textContent = text;
  };

  const setErrorLine = (text: string | null) => {
    if (!text) {
      errEl?.remove();
      errEl = null;
      lastErrLine = '';
      return;
    }
    if (!errEl) {
      errEl = h('div', 'cyc-plugincard-error py-1 mt-0.5 text-[var(--cyc-text-muted)]');
      body.append(errEl);
    }
    errEl.classList.remove('cyc-plugincard-placeholder');
    if (text !== lastErrLine) {
      lastErrLine = text;
      errEl.textContent = text;
    }
  };

  const paintHosts = (hosts?: string[]) => {
    const list = (hosts ?? []).filter(Boolean);
    const stamp = list.join('\n');
    if (stamp === lastHosts) return;
    lastHosts = stamp;
    hostsRow.replaceChildren();
    hostsRow.classList.toggle('cyc-off', !list.length);
    for (const name of list) {
      const chip = h(
        'span',
        'cyc-list-row-tab flex-[0_1_auto] px-1.5 rounded-md bg-[var(--cyc-text-muted-tint)] text-[var(--cyc-text-muted)] text-xs font-normal leading-[1.35] whitespace-nowrap overflow-hidden text-ellipsis'
      );
      chip.textContent = name;
      hostsRow.append(chip);
    }
  };

  const removeState = (state: FrameState | null) => {
    if (!state) return;
    clearTimeout(state.timer);
    state.dispose();
    state.el.src = 'about:blank';
    state.el.remove();
  };

  const frameFor = (source: MessageEventSource | null): FrameState | null => {
    if (candidate && source === candidate.el.contentWindow) return candidate;
    if (active && source === active.el.contentWindow) return active;
    return null;
  };

  const rejectCandidate = (state: FrameState, why: string) => {
    if (candidate !== state) return;
    candidate = null;
    removeState(state);
    cyclog('card.frame', {
      state: 'rejected',
      why,
      attempt: state.attempt + 1,
      bytes: state.doc.length,
      keptLastGood: !!active
    });
    if (!active) setPlaceholder('Card content unavailable');
    if (state.attempt < VERIFY_RETRIES && !destroyed) {
      window.setTimeout(() => {
        const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        if (
          !candidate &&
          generation === state.generation &&
          lastU?.html === state.html &&
          theme === state.theme
        ) {
          stage(state.html, state.height, state.attempt + 1, state.generation);
        }
      }, 0);
    } else {
      rejected = {html: state.html, theme: state.theme, at: Date.now()};
    }
  };

  const promote = (state: FrameState, beat: {height: number; nodes: number}) => {
    if (candidate !== state) return;
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    if (lastU?.html !== state.html || theme !== state.theme) {
      candidate = null;
      removeState(state);
      return;
    }
    clearTimeout(state.timer);
    candidate = null;
    const prior = active;
    active = state;
    rejected = null;
    state.el.classList.remove('cyc-plugincard-frame-candidate');
    state.el.removeAttribute('aria-hidden');
    state.el.dataset.cardNonempty = '1';
    state.el.dataset.cardHeight = String(beat.height);
    setPlaceholder(null);
    if (prior && prior !== state) removeState(prior);
    cyclog('card.frame', {
      state: 'verified',
      ms: Date.now() - state.assignedAt,
      bytes: state.doc.length,
      height: beat.height,
      nodes: beat.nodes
    });
  };

  const onHeartbeat = (e: MessageEvent) => {
    if (parked) return;
    const state = frameFor(e.source);
    if (!state) return;
    const beat = readBeat(e.data);
    if (!beat) return;
    const {nonEmpty, height, nodes} = beat;

    // The active frame re-reporting the paint it already reported: nothing to
    // render. The beat still answers a reveal ping, so the restore timer is
    // cleared; the log gets a skip line instead of a render line.
    if (state === active && sameBeat(state.beat, beat)) {
      state.skips++;
      state.el.dataset.cardSkips = String(state.skips);
      clearTimeout(revealTimer);
      if (logSkip(state.skips)) cyclog('render.skipped', {surface: 'card', skipped: state.skips});
      return;
    }

    state.beat = beatKey(beat);
    state.el.dataset.cardNonempty = nonEmpty ? '1' : '0';
    state.el.dataset.cardHeight = String(height);
    cyclog('card.render', {
      nonEmpty,
      height,
      nodes,
      phase: state === candidate ? 'candidate' : 'active'
    });

    if (state === candidate) {
      if (nonEmpty) promote(state, {height, nodes});
      else rejectCandidate(state, 'empty');
      return;
    }

    clearTimeout(revealTimer);
    if (nonEmpty) {
      setPlaceholder(null);
      return;
    }

    cyclog('card.BLANK', {why: 'heartbeat-empty', bytes: state.doc.length});
    console.warn('card.BLANK why=heartbeat-empty bytes=' + state.doc.length);
    setPlaceholder('Restoring card…');
    if (!candidate) stage(state.html, state.height);
  };
  window.addEventListener('message', onHeartbeat);

  const makeFrame = (height: number): HTMLIFrameElement => {
    const frame = document.createElement('iframe');
    // Double-buffer + aging paint on the frame the producer owns: the candidate
    // self-state variant hides/absolute-stacks the staged frame until it verifies,
    // and the aging parent-state variant dims the frame when its data goes stale.
    frame.className =
      'cyc-plugincard-frame cyc-plugincard-frame-candidate block w-full border-0 bg-transparent [color-scheme:normal] ' +
      '[&.cyc-plugincard-frame-candidate]:absolute [&.cyc-plugincard-frame-candidate]:inset-0 ' +
      '[&.cyc-plugincard-frame-candidate]:invisible [&.cyc-plugincard-frame-candidate]:pointer-events-none ' +
      '[.cyc-plugincard-aging_&]:opacity-[0.72]';
    frame.setAttribute('sandbox', CARD_SANDBOX);
    frame.setAttribute('allow', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('aria-hidden', 'true');
    frame.name = 'cyc-card-' + Math.random().toString(36).slice(2, 10);
    frame.title = title;
    frame.style.height = `${height}px`;
    return frame;
  };

  const stage = (html: string, height: number, attempt = 0, retryGeneration?: number) => {
    if (destroyed || parked) return;
    const thisGeneration = retryGeneration ?? ++generation;
    if (retryGeneration != null && retryGeneration !== generation) return;
    removeState(candidate);
    candidate = null;
    const {theme, vars} = themeVars();
    if (attempt === 0 && (rejected?.html !== html || rejected.theme !== theme)) rejected = null;
    const doc = cardDocument(html, theme, vars);
    const frame = makeFrame(height);
    const state: FrameState = {
      el: frame,
      html,
      doc,
      theme,
      height,
      attempt,
      timer: 0,
      assignedAt: Date.now(),
      generation: thisGeneration,
      dispose: () => {},
      beat: null,
      skips: 0
    };
    candidate = state;

    body.insertBefore(frame, errEl);
    state.dispose = loadSandboxDocument(frame, doc).dispose;
    state.timer = window.setTimeout(() => rejectCandidate(state, 'silent'), CARD_VERIFY_MS);
  };

  const update = (u: PluginCardUpdate) => {
    parked = false;
    lastU = u;
    const height = clampedHeight(u.height);
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    paintHosts(u.hosts);
    setWhen(u.when ?? '');
    setErrorLine(u.errorLine ?? null);
    el.classList.toggle('cyc-plugincard-aging', !!u.aging);

    if (!u.html) {
      if (active) {
        el.classList.remove('cyc-off');
        el.classList.remove('cyc-plugincard-loading');
        if (u.error && !u.errorLine) setErrorLine(u.error);
        return;
      }
      removeState(candidate);
      candidate = null;
      const text = u.loading ? 'Checking…' : u.error || '';
      el.classList.toggle('cyc-off', !text);
      el.classList.toggle('cyc-plugincard-loading', !!u.loading);
      if (u.loading) {
        setPlaceholder(text);
        setErrorLine(null);
      } else {
        setPlaceholder(null);
        setErrorLine(text || null);
        errEl?.classList.add('cyc-plugincard-placeholder');
      }
      return;
    }

    el.classList.remove('cyc-off');
    el.classList.remove('cyc-plugincard-loading');
    if (candidate && (candidate.html !== u.html || candidate.theme !== theme)) {
      removeState(candidate);
      candidate = null;
      generation++;
    }
    if (active?.html === u.html && active.theme === theme) {
      active.height = height;
      active.el.style.height = `${height}px`;
      return;
    }
    if (candidate?.html === u.html && candidate.theme === theme) {
      candidate.height = height;
      candidate.el.style.height = `${height}px`;
      return;
    }
    if (
      rejected?.html === u.html &&
      rejected.theme === theme &&
      Date.now() - rejected.at < REJECT_BACKOFF_MS
    )
      return;
    if (!active) setPlaceholder('Rendering card…');
    stage(u.html, height);
  };

  void cardFontReady.then(() => {
    if (destroyed || parked || !lastU?.html || candidate) return;
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const blocked =
      rejected?.html === lastU.html &&
      rejected.theme === theme &&
      Date.now() - rejected.at < REJECT_BACKOFF_MS;
    if (blocked || (active && active.html !== lastU.html)) return;
    stage(lastU.html, clampedHeight(lastU.height));
  });

  const reveal = () => {
    if (parked) return;
    if (!active) {
      if (lastU?.html && !candidate) stage(lastU.html, clampedHeight(lastU.height));
      return;
    }
    try {
      active.el.contentWindow?.postMessage({cycCardPing: 1}, '*');
    } catch {}
    clearTimeout(revealTimer);
    const state = active;
    revealTimer = window.setTimeout(() => {
      if (active !== state || candidate) return;
      cyclog('card.BLANK', {why: 'heartbeat-silent', bytes: state.doc.length});
      setPlaceholder('Restoring card…');
      stage(state.html, state.height);
    }, REVEAL_VERIFY_MS);
  };
  const onReveal = () => {
    if (!document.hidden) reveal();
  };
  document.addEventListener('visibilitychange', onReveal);

  const poke = () => {
    if (parked) return;
    if (!active) {
      if (lastU?.html && !candidate) stage(lastU.html, clampedHeight(lastU.height));
      return;
    }
    try {
      active.el.contentWindow?.postMessage({cycCardPing: 1}, '*');
    } catch {}
  };

  return {
    el,
    update,
    park() {
      if (destroyed || parked) return;
      parked = true;
      clearTimeout(revealTimer);

      removeState(candidate);
      candidate = null;
      el.classList.add('cyc-off');
    },
    reveal,
    poke,
    flash() {
      if (el.classList.contains('cyc-off')) return;
      el.classList.remove('cyc-plugincard-flash');
      void el.offsetWidth;
      el.classList.add('cyc-plugincard-flash');
      el.scrollIntoView({block: 'nearest', behavior: 'smooth'});
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => el.classList.remove('cyc-plugincard-flash'), 4000);
    },
    destroy() {
      destroyed = true;
      clearTimeout(flashTimer);
      clearTimeout(revealTimer);
      document.removeEventListener('visibilitychange', onReveal);
      window.removeEventListener('message', onHeartbeat);
      removeState(candidate);
      removeState(active);
      candidate = null;
      active = null;
    }
  };
}
