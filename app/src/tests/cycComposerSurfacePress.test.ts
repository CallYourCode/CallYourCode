import {describe, expect, test, vi} from 'vitest';

(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import {createComposer} from '../features/composer/components/messageComposer';
import {createAskPanel} from '../components/askPanel';
import type {CycReplyTo} from '../types';

// The pill is the input box (fix-box-focus-min): a press on the composer's own
// surface (the pill itself, the blocks row, the text line) that is not on a
// control focuses the input, and the decision is read off pointerdown, the true
// hit, because a touch tap's mouse events and click are retargeted by the
// browser to a nearby control (WebKit snaps a tap under the reply card onto the
// card). The real hit-testing is proven in e2e/offline/reply-focus.spec.ts;
// this pins the event logic, including that a keyboard click is never swallowed
// and that the panels docked into the pill keep their presses.

const REPLY = {ts: 1, role: 'claude', id: 'm:1', title: 'Agent', text: 'earlier'} as CycReplyTo;

function setup() {
  const onJumpToReply = vi.fn();
  const c = createComposer({
    onSend: () => {},
    onJumpToReply,
    onAttach: () => {},
    onStage: () => Promise.resolve(),
    onVoiceStart: () => {},
    onVoiceEnd: () => {},
    onLiveSend: () => {},
    onVoiceCancel: () => {}
  } as never);
  document.body.append(c.el);
  c.setReplyTo(REPLY);
  const q = <T extends HTMLElement>(sel: string) => c.el.querySelector(sel) as T;
  return {
    c,
    onJumpToReply,
    input: q('.cyc-composer-input'),
    pill: q('.cyc-composer-rows'),
    blocks: q('.cyc-blocks'),
    line: q('.cyc-composer-line'),
    panel: q('.cyc-block-reply .cyc-reply.cyc-callout-surface')
  };
}

// jsdom has no layout: give the pressed element a box and the event an offset
// inside it, the way a real press on it reads.
function pointerdown(el: HTMLElement, pointerType = 'mouse') {
  Object.defineProperty(el, 'clientWidth', {value: 100, configurable: true});
  Object.defineProperty(el, 'clientHeight', {value: 20, configurable: true});
  const e = new MouseEvent('pointerdown', {bubbles: true, cancelable: true, button: 0});
  Object.defineProperty(e, 'isPrimary', {value: true});
  Object.defineProperty(e, 'pointerType', {value: pointerType});
  Object.defineProperty(e, 'offsetX', {value: 10});
  Object.defineProperty(e, 'offsetY', {value: 5});
  el.dispatchEvent(e);
}
const mousedown = (el: HTMLElement) => {
  const e = new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0});
  el.dispatchEvent(e);
  return e;
};
const click = (el: HTMLElement, detail = 1) =>
  el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, detail}));

describe('composer surface press', () => {
  for (const where of ['pill', 'blocks', 'line'] as const) {
    test(`a press on the bare surface (${where}) focuses the input`, () => {
      const s = setup();
      expect(document.activeElement).not.toBe(s.input);
      pointerdown(s[where]);
      const md = mousedown(s[where]);
      expect(md.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(s.input);
      s.c.el.remove();
    });
  }

  test('a tap retargeted from the surface onto the reply card focuses, it does not jump', () => {
    const {c, input, line, panel, onJumpToReply} = setup();
    pointerdown(line);
    mousedown(panel);
    click(panel);
    expect(document.activeElement).toBe(input);
    expect(onJumpToReply).not.toHaveBeenCalled();
    c.el.remove();
  });

  test('a press on the reply card itself is left to the card: it jumps', () => {
    const {c, panel, onJumpToReply} = setup();
    pointerdown(panel);
    const md = mousedown(panel);
    click(panel);
    expect(md.defaultPrevented).toBe(false);
    expect(onJumpToReply).toHaveBeenCalledTimes(1);
    c.el.remove();
  });

  test('a press on a quote card focuses the input', () => {
    const {c, input} = setup();
    c.addQuote('quoted words', 'Agent', REPLY);
    const text = c.el.querySelector('.cyc-block-quote-text') as HTMLElement;
    pointerdown(text);
    const md = mousedown(text);
    expect(md.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    c.el.remove();
  });

  test('a press on a control (the quote remove button) is left to the control', () => {
    const {c, input} = setup();
    c.addQuote('quoted words', 'Agent', REPLY);
    const x = c.el.querySelector('.cyc-block-quote button') as HTMLElement;
    pointerdown(x);
    const md = mousedown(x);
    expect(md.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
    c.el.remove();
  });

  test('a keyboard click after a surface press is never swallowed', () => {
    const {c, line, panel, onJumpToReply} = setup();
    pointerdown(line);
    click(panel, 0);
    expect(onJumpToReply).toHaveBeenCalledTimes(1);
    c.el.remove();
  });

  test('a disabled composer takes no surface press', () => {
    const {c, input, line} = setup();
    c.setDisabled(true);
    pointerdown(line);
    const md = mousedown(line);
    expect(md.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
    c.el.remove();
  });

  // The real docked panels: the ask panel (main.ts mounts it with mountAsk) and
  // a plugin dial (setPluginWidgets docks its panel in the pill). They sit in
  // the pill but outside the surface; their presses are theirs.
  for (const sel of [
    '.cyc-ask-question',
    '.cyc-ask-context',
    '.cyc-replylevel-title',
    '.cyc-replylevel-label',
    '.cyc-steprange-track',
    '.cyc-steprange-track > span',
    'fieldset'
  ]) {
    for (const pointerType of ['mouse', 'touch']) {
      test(`a ${pointerType} press on a docked panel (${sel}) is the panel's, not the input's`, () => {
        const {c, input, pill} = setup();
        const ask = createAskPanel({onAnswer: () => {}} as never);
        c.mountAsk(ask.el);
        ask.update(
          {question: 'Which db?', context: ['psql -h db'], choices: [{n: 1, label: 'Postgres'}], fingerprint: 'f'} as never,
          false,
          's1'
        );
        c.setPluginWidgets([
          {
            widget: {
              type: 'slider',
              icon: 'x',
              label: 'Complexity',
              key: 'complexity',
              value: 1,
              steps: [
                {n: 1, name: 'low'},
                {n: 2, name: 'mid'},
                {n: 3, name: 'high'}
              ]
            }
          }
        ] as never);
        const el = c.el.querySelector(sel) as HTMLElement;
        expect(el, sel).not.toBeNull();
        expect(pill.contains(el), `${sel} is docked in the pill`).toBe(true);
        pointerdown(el, pointerType);
        const md = mousedown(el);
        expect(md.defaultPrevented).toBe(false);
        expect(document.activeElement).not.toBe(input);
        c.el.remove();
      });
    }
  }
});
