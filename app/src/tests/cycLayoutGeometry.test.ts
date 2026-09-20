import {afterEach, describe, expect, test} from 'vitest';

// Viewport layout geometry coverage.
import {deviceClass, installLayout} from '../features/sessions/layout';

const setWidth = (px: number) =>
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: px});
const ORIGINAL_WIDTH = window.innerWidth;

const root = () => document.documentElement.style;
const at = (px: number, chatPane: HTMLElement) => {
  setWidth(px);
  return installLayout(chatPane);
};

afterEach(() => {
  setWidth(ORIGINAL_WIDTH);
  document.documentElement.removeAttribute('style');
});

describe('layout.ts geometry table: exact computed per-bucket results', () => {
  const cases: Array<{
    label: string;
    vw: number;
    cls: ReturnType<typeof deviceClass>;
    nav: string;
    aside: string;
    chat: string;
    rootGap: string;
    chatGap: string;
  }> = [
    {
      label: 'deep phone',
      vw: 400,
      cls: 'phone',
      nav: '400px',
      aside: '400px',
      chat: '400px',
      rootGap: '0px',
      chatGap: '12px'
    },
    {
      label: 'phone boundary',
      vw: 550,
      cls: 'phone',
      nav: '550px',
      aside: '550px',
      chat: '550px',
      rootGap: '0px',
      chatGap: '12px'
    },
    {
      label: 'tablet start',
      vw: 551,
      cls: 'tablet',
      nav: '320px',
      aside: '320px',
      chat: '527px',
      rootGap: '12px',
      chatGap: '12px'
    },
    {
      label: 'tablet end',
      vw: 899,
      cls: 'tablet',
      nav: '320px',
      aside: '320px',
      chat: '720px',
      rootGap: '12px',
      chatGap: '12px'
    },
    {
      label: 'laptop start',
      vw: 900,
      cls: 'laptop',
      nav: '320px',
      aside: '320px',
      chat: '556px',
      rootGap: '12px',
      chatGap: '12px'
    },
    {
      label: 'wide laptop',
      vw: 1400,
      cls: 'laptop',
      nav: '320px',
      aside: '320px',
      chat: '720px',
      rootGap: '12px',
      chatGap: '12px'
    }
  ];

  for (const c of cases) {
    test(`${c.label} (vw=${c.vw})`, () => {
      const pane = document.createElement('div');
      const teardown = at(c.vw, pane);
      const r = root();
      expect(deviceClass()).toBe(c.cls);
      expect(r.getPropertyValue('--cyc-rail-width')).toBe(c.nav);
      expect(r.getPropertyValue('--cyc-aside-pane-width')).toBe(c.aside);
      expect(r.getPropertyValue('--cyc-chat-width')).toBe(c.chat);
      expect(r.getPropertyValue('--cyc-pane-gap')).toBe(c.rootGap);
      expect(pane.style.getPropertyValue('--cyc-pane-gap')).toBe(c.chatGap);
      teardown();
    });
  }
});
