import {describe, expect, test, vi} from 'vitest';

(globalThis as {ResizeObserver?: unknown}).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import {createComposer} from '../features/composer/components/messageComposer';
import type {CycReplyTo} from '../types';

// The pill is the input box (fix-reply-focus): a press anywhere in it that is
// not a control focuses the input (quote cards included), and the decision is read off pointerdown, the true hit,
// because a touch tap's mouse events and click are retargeted by the browser to
// a nearby control (WebKit snaps a tap under the reply card onto the card). The
// real hit-testing is proven in e2e/offline/reply-focus.spec.ts; this pins the
// event logic, including that a keyboard click is never swallowed.

const REPLY = {ts: 1, role: 'claude', id: 'm:1', title: 'Agent', text: 'earlier'} as CycReplyTo;

function setup() {
  const onJumpToReply = vi.fn();
  const c = createComposer({
    onSend: () => {},
    onJumpToReply,
    onAttach: () => {},
    onStage: () => {},
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
    line: q('.cyc-composer-line'),
    panel: q('.cyc-block-reply .cyc-reply.cyc-callout-surface')
  };
}

// jsdom has no layout: give the pressed element a box and the event an offset
// inside it, the way a real press on it reads.
function pointerdown(el: HTMLElement) {
  Object.defineProperty(el, 'clientWidth', {value: 100, configurable: true});
  Object.defineProperty(el, 'clientHeight', {value: 20, configurable: true});
  const e = new MouseEvent('pointerdown', {bubbles: true, cancelable: true, button: 0});
  Object.defineProperty(e, 'isPrimary', {value: true});
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
  test('a press on the bare pill surface focuses the input', () => {
    const {c, input, line} = setup();
    expect(document.activeElement).not.toBe(input);
    pointerdown(line);
    const md = mousedown(line);
    expect(md.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
    c.el.remove();
  });

  test('a tap retargeted from the surface onto the reply card focuses, it does not jump', () => {
    const {c, input, line, panel, onJumpToReply} = setup();
    pointerdown(line);
    mousedown(panel);
    click(panel);
    expect(document.activeElement).toBe(input);
    expect(onJumpToReply).not.toHaveBeenCalled();
    c.el.remove();
  });

  test('a press on the reply card itself jumps, and the caret goes to the input', () => {
    const {c, input, panel, onJumpToReply} = setup();
    pointerdown(panel);
    const md = mousedown(panel);
    click(panel);
    expect(md.defaultPrevented).toBe(true);
    expect(onJumpToReply).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
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
});
