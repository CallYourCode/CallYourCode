import {describe, expect, test} from 'vitest';
import {CARD_HEARTBEAT, PAGE_SHIM} from '../features/plugins/sandbox';
import * as pageSandbox from '../features/plugins/sandbox';
describe('CARD_HEARTBEAT', () => {
  test('is a substantial self-invoking ES5 payload', () => {
    expect(typeof CARD_HEARTBEAT).toBe('string');
    expect(CARD_HEARTBEAT.length).toBeGreaterThan(2000);
    expect(CARD_HEARTBEAT.startsWith('(function(){')).toBe(true);
    expect(CARD_HEARTBEAT.trimEnd().endsWith('})();')).toBe(true);
  });
  test('carries the heartbeat wire markers', () => {
    expect(CARD_HEARTBEAT).toContain('parent.postMessage({cycCardRender:1');
    expect(CARD_HEARTBEAT).toContain('e.data.cycCardPing');
    expect(CARD_HEARTBEAT).toContain('e.source !== parent');
  });
  test('carries the re-measure triggers', () => {
    expect(CARD_HEARTBEAT).toContain('DOMContentLoaded');
    expect(CARD_HEARTBEAT).toContain("addEventListener('pageshow', beat)");
    expect(CARD_HEARTBEAT).toContain('visibilitychange');
    expect(CARD_HEARTBEAT).toContain('new MutationObserver(beat)');
    expect(CARD_HEARTBEAT).toContain('new ResizeObserver(beat)');
    expect(CARD_HEARTBEAT).toContain("document.addEventListener('load', beat, true)");
    expect(CARD_HEARTBEAT).toContain('document.fonts.ready.then(beat');

    expect(CARD_HEARTBEAT).toContain('setTimeout');
    expect(CARD_HEARTBEAT).toContain('requestAnimationFrame');
  });
  test('has no timer: an idle card is never re-measured', () => {
    // The 3 s setInterval re-measured an unchanged card forever (one
    // card.render line + one log POST every 3 s per card on the phone).
    expect(CARD_HEARTBEAT).not.toContain('setInterval');
  });
  test('is the same bytes pageSandbox re-exports and cardDocument embeds', () => {
    expect(pageSandbox.CARD_HEARTBEAT).toBe(CARD_HEARTBEAT);
    const doc = pageSandbox.cardDocument('<p>x</p>', 'dark', {'--cyc-bg': '#000'});
    expect(doc).toContain('<script>' + CARD_HEARTBEAT + '</script>');
  });
});
describe('PAGE_SHIM', () => {
  test('is a substantial self-invoking ES5 payload', () => {
    expect(typeof PAGE_SHIM).toBe('string');
    expect(PAGE_SHIM.length).toBeGreaterThan(4000);
    expect(PAGE_SHIM.startsWith('(function(){')).toBe(true);
    expect(PAGE_SHIM.trimEnd().endsWith('})();')).toBe(true);

    expect(PAGE_SHIM).not.toContain('</script>');
  });
  test('declares the one global with every verb', () => {
    expect(PAGE_SHIM).toContain('window.cyc = {');
    for (const verb of ['submit:', 'close:', 'save:', 'load:', 'call:', 'goto:']) {
      expect(PAGE_SHIM).toContain(verb);
    }
  });
  test('speaks the bridge envelope', () => {
    expect(PAGE_SHIM).toContain(
      'parent.postMessage({cyc: 1, type: type, id: id, payload: payload}'
    );
    expect(PAGE_SHIM).toContain("d.type !== 'cyc:ack'");
    for (const t of [
      "'cyc:submit'",
      "'cyc:close'",
      "'cyc:save'",
      "'cyc:load'",
      "'cyc:call'",
      "'cyc:goto'"
    ]) {
      expect(PAGE_SHIM).toContain(t);
    }

    expect(PAGE_SHIM).toContain('}, 35000);');
  });
  test('carries the draft autosave and its two refusals', () => {
    expect(PAGE_SHIM).toContain('input[id],textarea[id],select[id]');

    expect(PAGE_SHIM).toContain("el.type === 'password'");

    expect(PAGE_SHIM).toContain('if(!memReady) return;');

    expect(PAGE_SHIM).toContain('{v: 1, author: null, drafts: {}}');
  });
  test('is the same bytes pageSandbox re-exports and frameDocument injects', () => {
    expect(pageSandbox.PAGE_SHIM).toBe(PAGE_SHIM);
    const doc = pageSandbox.frameDocument('<p>hi</p>', 'dark', {'--cyc-bg': '#000'});
    expect(doc).toContain(PAGE_SHIM);

    expect(doc.indexOf(PAGE_SHIM)).toBeLessThan(doc.indexOf('<p>hi</p>'));
  });
});
