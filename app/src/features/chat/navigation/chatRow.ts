import type {CycAgentStatus, CycSession} from '@/types';
import {h} from '@/components/domHelpers';
import {createTypingIndicator} from './typing';
import {makeIcon} from '@/components/iconGlyphs';
import {avatarView, avatarSeed} from '@/components/avatarView';
import {BADGE_PROMINENT, BADGE_FACE, DOT_MD} from '@/components/countBadge';
import {fmtTime, turnAge} from '@/features/chat/content';
import {stillSending, isResumeControlRow} from '@/features/chat/content';
import {
  currentPresentationTheme,
  paintTheme,
  type PresentationTheme
} from '@/components/presentation';
import {
  SESSION_PRIMARY_TEXT,
  SESSION_SECONDARY_COLOR,
  SESSION_STATUS,
  SESSION_FILL,
  SESSION_SELECTED_ROW,
  SESSION_STATE_BADGE_BG
} from '@/features/sessions/sessionsPaint';

const ROW_STATE: Record<PresentationTheme, string> = {
  day: 'fine:hover:bg-[#f2f2f3]! fine:active:bg-[#f2f2f3]! [&.cyc-drag-active]:bg-[#ffffff]!',
  night: 'fine:hover:bg-[#17171a]! fine:active:bg-[#17171a]! [&.cyc-drag-active]:bg-[#17171a]!'
};

const AVATAR_CLASS =
  'cyc-session-avatar pointer-events-none col-start-1 row-span-2 self-center justify-self-center';

export type ChatRowOpts = {
  mark?: CycAgentStatus | null;
  notifyOff?: boolean;

  active?: boolean;
  dead?: boolean;
  mergedTab?: string;

  /** Harness chip text ("Claude", "Codex", ...): shown beside the host chip
   *  under the same merged-list rule; absent = no chip, never a blank one. */
  harnessChip?: string;

  /** Model chip text, the short label the header shows ("Fable 5"); absent =
   *  no chip. Long names truncate inside the chip's own max width. */
  modelChip?: string;

  now?: number;
};

export type SyncableRow = HTMLAnchorElement & {
  _cycSync?: (s: CycSession, opts: ChatRowOpts) => void;
};

export const DEFAULT_AGENT_NAME = 'Claude';

export function agentNameOf(s: {agentLabel?: string; agentName?: string}): string {
  return s.agentLabel ?? s.agentName ?? DEFAULT_AGENT_NAME;
}

// An engine-confirmed row is anything the engine produced or took: any reply,
// and any user send past the local-only 'sending'/'failed' stages. A resurrected
// send that the engine already delivered is followed by one of these; a genuine
// pending send is not.
function isEngineConfirmed(m: CycSession['messages'][number]): boolean {
  return !(m.role === 'user' && (m.status === 'sending' || m.status === 'failed'));
}

// The newest message the roster row speaks for: the last one that is not a
// control-answer row. A control answer is a terminal prompt the owner answered
// from the app, not a message he sent, so it must not become the row's preview
// text or set its clock. Scans back from the tail; undefined when every row is
// a control answer (or the session has none).
function lastShownMessage(s: CycSession): CycSession['messages'][number] | undefined {
  for (let i = s.messages.length - 1; i >= 0; i--)
    if (!isResumeControlRow(s.messages[i])) return s.messages[i];
  return undefined;
}

function hasNewerDelivered(s: CycSession, sending: CycSession['messages'][number]): boolean {
  for (const m of s.messages) {
    if (m === sending) continue;
    if (m.ts > sending.ts && isEngineConfirmed(m)) return true;
  }
  return false;
}

type SubDesc =
  | {cls: string[]; kind: 'text'; text: string}
  | {cls: string[]; kind: 'dots'; ariaBase: string; suffix: string};

function deriveSubtitle(s: CycSession, opts: ChatRowOpts): SubDesc {
  if (opts.dead) return {cls: [], kind: 'text', text: 'offline'};
  const last = lastShownMessage(s);
  const mirror = s.title !== undefined;
  if (mirror) {
    const label = s.turnSince ? turnAge(s.turnSince, opts.now) : agentNameOf(s);
    if (s.ask) return {cls: ['cyc-list-row-asking'], kind: 'text', text: s.ask.question};
    if (s.askUnknown)
      return {
        cls: ['cyc-list-row-asking'],
        kind: 'text',
        text: 'Waiting for an answer in the terminal'
      };

    // "Sending…" only for a send that is actually the session's newest word. A
    // resurrected send from days ago (an intent the engine already took but the
    // app never settled) sits behind rows the engine has since delivered, and
    // must not stamp the whole row as sending over a chat that has moved on.
    if (stillSending(last) && !hasNewerDelivered(s, last))
      return {cls: ['cyc-list-row-working'], kind: 'text', text: 'Sending…'};
    if (s.thinking)
      return {
        cls: ['cyc-list-row-working'],
        kind: 'dots',
        ariaBase: 'thinking',
        suffix: s.turnSince ? label : ''
      };
    if (s.status === 'working')
      return {cls: ['cyc-list-row-working'], kind: 'dots', ariaBase: 'working', suffix: label};
    return {cls: [], kind: 'text', text: label};
  }
  if (s.thinking)
    return {cls: ['cyc-list-row-working'], kind: 'dots', ariaBase: 'thinking', suffix: ''};
  if (last) {
    const who = last.role === 'user' ? 'You: ' : '';
    const body = last.kind === 'voice' ? '🎤 ' + last.text : last.text;
    const attached = last.file
      ? last.file.fileKind === 'image'
        ? '🖼 ' + (body || 'Photo')
        : '📄 ' + (body || last.file.name)
      : last.upload
        ? last.upload.image
          ? '🖼 ' + (body || 'Photo')
          : '📄 ' + (body || last.upload.name)
        : body;
    return {cls: [], kind: 'text', text: who + attached};
  }
  return {cls: [], kind: 'text', text: s.cwd};
}

type BadgeDesc = {dot: string | null; unread: number};

function deriveBadges(s: CycSession, opts: ChatRowOpts): BadgeDesc {
  const st = opts.mark ?? undefined;
  const dot =
    st === 'blocked' || ((st === 'done' || st === 'unknown') && s.unread === 0)
      ? (st as string)
      : null;
  return {dot, unread: s.unread > 0 ? s.unread : 0};
}

// One chip face for the host, harness and model chips on a session row (the
// same face pluginCard.ts paints for its host chips).
const ROW_CHIP_UTILS =
  'flex-[0_1_auto] ms-1.5 px-1.5 rounded-md bg-[var(--cyc-text-muted-tint)] text-[var(--cyc-text-muted)] text-xs font-normal leading-[1.35] whitespace-nowrap overflow-hidden text-ellipsis';

const SUBTITLE_CLASS =
  'cyc-list-row-subtitle relative pointer-events-none overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-auto text-[color:var(--cyc-text-muted)]';
const MUTE_ICON_UTILS = 'flex-none ms-0.5 text-[1.125rem] text-[var(--cyc-session-quiet-color)]';
const SESSION_BADGE_UTILS = 'block! ms-2 flex-none relative [transition:none]! rounded-[6px]!';

export function chatRow(s: CycSession, opts: ChatRowOpts = {}): HTMLAnchorElement {
  const a = h(
    'a',
    [
      'cyc-session-entry',
      // Column 1 is exactly the 48px avatar; gap-x-3.5 is the 14px the avatar keeps
      // from the title/subtitle. Column 2 still ends at the row's px-2, so the
      // time/badge edge does not move.
      'relative grid min-h-[4.25rem] grid-cols-[3rem_minmax(0,1fr)] gap-x-3.5 grid-rows-2 items-center px-2 py-1.5',
      'cursor-pointer overflow-hidden whitespace-nowrap rounded-xl transition-[background-color,opacity] duration-150',
      '[-webkit-user-drag:none]',
      '[&.cyc-dead]:opacity-[0.55]'
    ].join(' '),
    {
      'data-session-id': s.id
    }
  );

  const subtitleRow = h(
    'div',
    'cyc-session-sub col-start-2 row-start-2 flex min-w-0 items-center justify-between self-start'
  );
  const subtitle = h('div', SUBTITLE_CLASS);
  // One size in every state (idle "19m", busy "thinking · 3m"): 0.875rem is 14px at
  // the 16px base, a step under the 1rem title. line-height stays 1.375rem so the
  // row height is unchanged. Inline !important so no stylesheet rule can split it.
  subtitle.style.setProperty('font-size', '0.875rem', 'important');
  subtitle.style.setProperty('line-height', '1.375rem', 'important');
  subtitle.style.setProperty('margin-top', '0', 'important');
  subtitleRow.append(subtitle);
  const titleRow = h(
    'div',
    'cyc-session-title col-start-2 row-start-1 flex min-w-0 items-center justify-between self-end pointer-events-none'
  );
  const title = h(
    'div',
    [
      'cyc-list-row-title cyc-title-line',
      'relative pointer-events-none overflow-hidden text-ellipsis whitespace-nowrap min-w-0 flex-auto',
      '[word-break:break-word] text-[length:1rem] leading-[var(--cyc-line-height)] text-[var(--cyc-text)]',
      '[display:flex]! items-center leading-[1.375rem]!'
    ].join(' ')
  );

  const details = h(
    'div',
    [
      'cyc-list-row-title cyc-list-row-right cyc-list-row-right-muted cyc-session-details',
      'relative pointer-events-none flex-none ms-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap',
      'pt-px text-[0.75rem] leading-[var(--cyc-line-height)] [word-break:break-word] text-[var(--cyc-text-muted)]',
      'flex items-center h-5 [margin-top:-0.4375rem] text-[0.75rem]! leading-[16px]!'
    ].join(' ')
  );
  const time = h('span', 'cyc-list-row-time');
  details.append(time);
  titleRow.append(title, details);
  let avatarEl = avatarView(s.name, 48, AVATAR_CLASS, s.avatarUrl, avatarSeed(s));
  a.append(avatarEl, titleRow, subtitleRow);

  const fillSubtitle = (d: SubDesc) => {
    subtitle.className = SUBTITLE_CLASS + (d.cls.length ? ' ' + d.cls.join(' ') : '');
    if (d.kind === 'dots') {
      subtitle.replaceChildren(createTypingIndicator(d.ariaBase, d.suffix).el);
    } else {
      subtitle.textContent = d.text;
    }
  };

  const fillBadges = (b: BadgeDesc) => {
    subtitleRow.querySelectorAll('.cyc-session-badge').forEach((n) => n.remove());
    if (b.dot) {
      subtitleRow.append(
        h(
          'div',
          'cyc-session-badge cyc-state-badge ' + DOT_MD + ' ' + SESSION_BADGE_UTILS + ' z-[1]'
        )
      );
    }
    if (b.unread > 0) {
      const badge = h(
        'div',
        'cyc-session-badge cyc-session-badge-unread ' +
          BADGE_PROMINENT +
          ' ' +
          BADGE_FACE +
          ' ' +
          SESSION_BADGE_UTILS +
          ' order-3 z-[1]'
      );
      badge.textContent = String(b.unread);
      subtitleRow.append(badge);
    }
  };

  const fillTitle = (ss: CycSession, o: ChatRowOpts) => {
    const kids: Node[] = [];
    if (ss.title !== undefined) {
      const primary = h('span', 'cyc-who font-medium overflow-hidden text-ellipsis');
      primary.textContent = ss.title.text;
      kids.push(primary);
      if (ss.title.detail) {
        const sep = h('span', 'cyc-list-row-sep');
        sep.textContent = ' · ';
        const detail = h('span', 'cyc-list-row-detail');
        detail.textContent = ss.title.detail;
        kids.push(sep, detail);
      }
    } else {
      const peerTitle = h('span', 'cyc-who font-medium overflow-hidden text-ellipsis');
      peerTitle.textContent = ss.name;
      kids.push(peerTitle);
    }
    if (o.mergedTab) {
      const chip = h('span', 'cyc-list-row-tab ' + ROW_CHIP_UTILS);
      chip.textContent = o.mergedTab;
      kids.push(chip);
    }
    if (o.harnessChip) {
      const chip = h('span', 'cyc-list-row-harness ' + ROW_CHIP_UTILS);
      chip.textContent = o.harnessChip;
      kids.push(chip);
    }
    if (o.modelChip) {
      // max-w keeps a long model name from squeezing the title off the row;
      // the chip's own overflow-hidden text-ellipsis truncates it.
      const chip = h('span', 'cyc-list-row-model max-w-[7rem] ' + ROW_CHIP_UTILS);
      chip.textContent = o.modelChip;
      kids.push(chip);
    }
    if (ss.muted) kids.push(makeIcon('speakerMuted', 'cyc-session-mute-icon ' + MUTE_ICON_UTILS));
    if (o.notifyOff) {
      const bell = makeIcon(
        'mute',
        'cyc-session-mute-icon cyc-list-row-quiet-icon ' + MUTE_ICON_UTILS
      );
      bell.setAttribute('title', 'Notifications off for this chat');
      bell.setAttribute('aria-label', 'Notifications off for this chat');
      kids.push(bell);
    }
    title.replaceChildren(...kids);
  };

  const timeOf = (ss: CycSession) => {
    const last = lastShownMessage(ss);
    const clockTs = last?.ts ?? ss.lastActivity;
    return clockTs ? fmtTime(clockTs) : '';
  };
  const titleSig = (ss: CycSession, o: ChatRowOpts) =>
    (ss.title !== undefined
      ? '1|' + ss.title.text + '|' + (ss.title.detail ?? '')
      : '0|' + ss.name) +
    '|' +
    (o.mergedTab ?? '') +
    '|' +
    (o.harnessChip ?? '') +
    '|' +
    (o.modelChip ?? '') +
    '|' +
    (ss.muted ? 1 : 0) +
    '|' +
    (o.notifyOff ? 1 : 0);
  const avatarSig = (ss: CycSession) => ss.name + '|' + (ss.avatarUrl ?? '');

  let stateTokens: string[] = [];
  const paintRowState = (theme: PresentationTheme) => {
    a.classList.remove(...stateTokens);
    stateTokens = ROW_STATE[theme].split(' ');
    a.classList.add(...stateTokens);

    const active = a.classList.contains('active');
    const muted = a.classList.contains('cyc-muted');

    if (active) a.style.setProperty('background-color', SESSION_SELECTED_ROW[theme], 'important');
    else a.style.removeProperty('background-color');

    const unread = a.querySelector<HTMLElement>('.cyc-session-badge-unread');
    if (unread)
      unread.style.backgroundColor = active
        ? SESSION_FILL[theme]
        : muted
          ? SESSION_SECONDARY_COLOR[theme]
          : SESSION_STATUS[theme];

    a.querySelectorAll<HTMLElement>('.cyc-state-badge').forEach((d) => {
      d.style.backgroundColor = SESSION_STATE_BADGE_BG[theme];
    });

    a.querySelectorAll<HTMLElement>('.cyc-session-mute-icon').forEach((m) => {
      m.style.color = active ? SESSION_PRIMARY_TEXT[theme] : '';
    });
  };

  let lastSub = '',
    lastBadge = '',
    lastTitle = '',
    lastAvatar = '';
  const applyAll = (ss: CycSession, o: ChatRowOpts) => {
    const sub = deriveSubtitle(ss, o);
    const subKey = JSON.stringify(sub);
    if (subKey !== lastSub) {
      fillSubtitle(sub);
      lastSub = subKey;
    }
    const bad = deriveBadges(ss, o);
    const badKey = JSON.stringify(bad);
    if (badKey !== lastBadge) {
      fillBadges(bad);
      lastBadge = badKey;
    }
    const titleKey = titleSig(ss, o);
    if (titleKey !== lastTitle) {
      fillTitle(ss, o);
      lastTitle = titleKey;
    }
    const avKey = avatarSig(ss);
    if (avKey !== lastAvatar) {
      const next = avatarView(ss.name, 48, AVATAR_CLASS, ss.avatarUrl, avatarSeed(ss));
      avatarEl.replaceWith(next);
      avatarEl = next;
      lastAvatar = avKey;
    }
    const t = timeOf(ss);
    if (time.textContent !== t) time.textContent = t;
    a.classList.toggle('cyc-muted', !!ss.muted);
    a.classList.toggle('cyc-list-row-quiet', !!o.notifyOff);
    a.classList.toggle('active', !!o.active);
    a.classList.toggle('cyc-dead', !!o.dead);
    avatarEl.style.filter = o.dead ? 'grayscale(1)' : '';
    paintRowState(currentPresentationTheme());
  };
  applyAll(s, opts);
  paintTheme(a, paintRowState);
  (a as SyncableRow)._cycSync = applyAll;
  return a;
}
