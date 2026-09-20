import {h} from '@/components/domHelpers';
import {makeIcon} from '@/components/iconGlyphs';
import {paintActionControlSize} from '@/components/circleButtonSize';
import {BADGE_PROMINENT, BADGE_FACE, BADGE_MOTION, setBadgeCount} from '@/components/countBadge';
import {smoothScrollToBottom} from '@/shared/smoothScroll';

// Corner buttons hide until the chat sets data-cyc-godown / data-cyc-audiojump.
const CORNER_FADE = '[transition:opacity_0.2s_ease]!';

interface ChatChromeOptions {
  chat: HTMLElement;
  scroll: HTMLElement;
  nearBottomPx: number;
  closeSettleGrace(reconcile: boolean): void;
}

export function createChatChrome(options: ChatChromeOptions) {
  const {chat, scroll, nearBottomPx, closeSettleGrace} = options;
  const goDownBadge = h(
    'span',
    'cyc-jump-latest-badge absolute -top-1 -end-1 max-tab:-top-3 ' +
      'bg-[var(--cyc-accent)]! ' +
      BADGE_PROMINENT +
      ' ' +
      BADGE_FACE +
      ' ' +
      BADGE_MOTION
  );
  goDownBadge.hidden = true;
  const unreadBanner = h(
    'button',
    'cyc-unread-banner cyc-off absolute left-[50%] right-0 [transform:translateX(-50%)] ' +
      'top-[calc(var(--cyc-chat-header-height)+var(--cyc-overlay-stack-height,0rem)+0.5rem)] z-[3] rounded-[1rem] ' +
      'bg-[rgba(0,0,0,0.35)]! text-white! text-[0.875rem]! font-medium leading-[1.35] whitespace-nowrap ' +
      'cursor-pointer px-[0.875rem]! py-[0.3125rem]! border-0'
  );
  chat.append(unreadBanner);
  let newBelow = 0;

  const setNewBelow = (count: number) => {
    newBelow = count;
    setBadgeCount(goDownBadge, count);
  };
  const distanceToEnd = () => scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  const updateGoDown = () => {
    chat.toggleAttribute('data-cyc-godown', distanceToEnd() > 300);
    if (distanceToEnd() <= nearBottomPx && newBelow) setNewBelow(0);
  };
  scroll.addEventListener('scroll', updateGoDown, {passive: true});

  const hideUnreadBanner = () => unreadBanner.classList.add('cyc-off');
  const showUnreadBanner = (count: number) => {
    if (count <= 0) return;
    unreadBanner.textContent = `${count} unread message${count === 1 ? '' : 's'}`;
    unreadBanner.classList.remove('cyc-off');
  };
  unreadBanner.addEventListener('click', hideUnreadBanner);

  // Neither corner button recolors on hover (owner asked to drop the hover
  // recolor); a real click still flashes the pressed color for feedback.
  const CORNER_HOVER_UTILS = 'fine:active:bg-(--cyc-accent-pressed)!';

  // Both corner buttons float 1rem above the composer box's top edge
  // (`bottom: calc(100% + 1rem)` of the box they live in), so they rise with
  // the composer as it grows (chip row, multi-line text, the phone floor) and
  // never sit under the pill. Squarish with a fixed 14px radius: the
  // `.cyc-corner-btn` rule in utilities.css (placed after the 6px
  // `.cyc-action-float` rule) wins the cascade; `rounded-[14px]!` backs it up.
  const CORNER_FLOAT_BASE = 'absolute z-[1] bottom-[calc(100%+1rem)]! rounded-[14px]!';
  // Both chips share the same 0.75rem trailing inset so their right edges line
  // up on one vertical axis (the audio-jump chip is translated up above the
  // scroll-down button).
  const CORNER_FLOAT = CORNER_FLOAT_BASE + ' end-3';
  const GO_DOWN_FLOAT = CORNER_FLOAT_BASE + ' end-3';

  const mount = (composerBox: HTMLElement, openPlayingMessage: () => void) => {
    const goDownButton = h(
      'button',
      'cyc-ctl-round cyc-action-float cyc-elevation-low cyc-corner-btn cyc-thread-secondary-btn cyc-jump-latest flex items-center justify-center text-center w-[var(--cyc-circle-size)] h-[var(--cyc-circle-size)] leading-[var(--cyc-circle-size)] bg-[var(--cyc-surface)]! text-[1.5rem]! text-[var(--cyc-text)]! [&_.cyc-icon]:text-[var(--cyc-text)]! ' +
        GO_DOWN_FLOAT +
        ' overflow-visible opacity-0 invisible cursor-default! ' +
        CORNER_FADE +
        ' [.cyc-thread[data-cyc-godown]_&]:opacity-100 [.cyc-thread[data-cyc-godown]_&]:visible [.cyc-thread[data-cyc-godown]_&]:cursor-pointer! ' +
        CORNER_HOVER_UTILS
    );
    paintActionControlSize(goDownButton);
    goDownButton.tabIndex = -1;
    goDownButton.append(makeIcon('arrowDown'), goDownBadge);
    // Scrolls ONLY the message scroller, to its true end. Not scrollIntoView:
    // that scrolls every scrollable ancestor too (overflow:hidden boxes
    // included), which shoved #cyc-columns by its pane-gap overflow at phone
    // widths and stranded a background band under the composer (see
    // smoothScrollToBottom).
    goDownButton.addEventListener('click', () => {
      closeSettleGrace(false);
      smoothScrollToBottom(scroll);
    });
    composerBox.append(goDownButton);

    const audioJumpChip = h(
      'button',
      'cyc-ctl-round cyc-action-float cyc-elevation-low cyc-corner-btn cyc-thread-secondary-btn cyc-clip-jump ' +
        CORNER_FLOAT +
        ' flex items-center justify-center text-center w-[var(--cyc-circle-size)] h-[var(--cyc-circle-size)] leading-[var(--cyc-circle-size)] text-[1.5rem]! text-[var(--cyc-text)]! [&_.cyc-icon]:text-[var(--cyc-text)]! bg-[var(--cyc-surface)]! [transform:translateY(calc(-100%-0.5rem))]! ' +
        CORNER_FADE +
        ' opacity-0 invisible cursor-default! [.cyc-thread[data-cyc-audiojump]_&]:opacity-100 [.cyc-thread[data-cyc-audiojump]_&]:visible [.cyc-thread[data-cyc-audiojump]_&]:cursor-pointer! ' +
        CORNER_HOVER_UTILS
    );
    paintActionControlSize(audioJumpChip);
    audioJumpChip.tabIndex = -1;
    audioJumpChip.append(makeIcon('speaker'));
    const direction = h(
      'span',
      'cyc-clip-jump-dir absolute -top-1 -end-1 w-5 h-5 flex items-center justify-center rounded-full ' +
        'bg-[var(--cyc-accent)] [&_.cyc-icon]:text-[0.875rem]! [&_.cyc-icon]:text-white!'
    );
    direction.append(
      makeIcon('up', 'cyc-clip-jump-up hidden! [.cyc-clip-jump.is-up_&]:flex!'),
      makeIcon('down', 'cyc-clip-jump-down hidden! [.cyc-clip-jump.is-down_&]:flex!')
    );
    audioJumpChip.append(direction);
    audioJumpChip.addEventListener('click', openPlayingMessage);
    composerBox.append(audioJumpChip);
    return {audioJumpChip};
  };

  return {
    setNewBelow,
    updateGoDown,
    hideUnreadBanner,
    showUnreadBanner,
    newBelowCount: () => newBelow,
    mount
  };
}
