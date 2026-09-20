const PHONE_MAX_WIDTH = 550;
const OVERLAY_NAV_MAX_WIDTH = 899;

type DeviceClass = 'phone' | 'tablet' | 'laptop';

type Geometry = {
  railWidth: number;
  sidePaneWidth: number;
  chatWidth: number;
  pageInset: number;
  chatInset: number;
};

const NAV_RAIL_WIDTH = 320;
const CHAT_MAX_WIDTH = 720;
const PAGE_INSET = 12;
const PHONE_CHAT_INSET = 12;

function classify(viewportWidth: number): DeviceClass {
  if (viewportWidth <= PHONE_MAX_WIDTH) return 'phone';
  if (viewportWidth <= OVERLAY_NAV_MAX_WIDTH) return 'tablet';
  return 'laptop';
}

export function deviceClass(): DeviceClass {
  return classify(window.innerWidth);
}

function geometryFor(viewportWidth: number): Geometry {
  const kind = classify(viewportWidth);
  if (kind === 'phone') {
    return {
      railWidth: viewportWidth,
      sidePaneWidth: viewportWidth,
      chatWidth: viewportWidth,
      pageInset: 0,
      chatInset: PHONE_CHAT_INSET
    };
  }

  const railWidth = Math.min(NAV_RAIL_WIDTH, viewportWidth);
  const pageInset = PAGE_INSET;
  const availableChatWidth =
    kind === 'tablet'
      ? viewportWidth - pageInset * 2
      : viewportWidth - railWidth - pageInset * 2;

  return {
    railWidth,
    sidePaneWidth: railWidth,
    chatWidth: Math.min(CHAT_MAX_WIDTH, availableChatWidth),
    pageInset,
    chatInset: pageInset
  };
}

export function installLayout(chatPane: HTMLElement): () => void {
  const update = () => {
    const geometry = geometryFor(window.innerWidth);
    const px = (value: number) => `${value}px`;
    const root = document.documentElement.style;
    root.setProperty('--cyc-rail-width', px(geometry.railWidth));
    root.setProperty('--cyc-aside-pane-width', px(geometry.sidePaneWidth));
    root.setProperty('--cyc-chat-width', px(geometry.chatWidth));
    root.setProperty('--cyc-pane-gap', px(geometry.pageInset));
    chatPane.style.setProperty('--cyc-pane-gap', px(geometry.chatInset));
  };

  let frame = 0;
  const onResize = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  };

  update();
  window.addEventListener('resize', onResize);
  return () => {
    window.removeEventListener('resize', onResize);
    if (frame) cancelAnimationFrame(frame);
  };
}
